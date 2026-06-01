"""B3 ProtocolParser: レガシー行(bytes) → [07]§6 形状のイベント dict。

設計方針([07]§7 対応表, DEVLOG A1/A3/A-05 準拠)
------------------------------------------------------------------
- 入力は LineBuffer が確定した 1 行(bytes, 末尾 \\n/\\r 除去済)。
- A1: 構造化は本 Parser の責務。CodeConverter はエンコード専任。
- A3: `#m57 O`(ワイド) は raw[7:74]/[75:142] の 2 スロット対応。
- A-05: 出力で `map.dir`=数値0-7、`chars[].dir`=文字 "B|R|F|L" に正規化。
- A-02/03: Parser は session 非依存。呼出側(SessionManager)が session を付与する。

map は複数行(M=地形 / O=キャラ / . =確定)に跨るため Parser がフレームを蓄積し、
`#m57 .` / `#map .` で確定した時点で完成 `map` イベントを emit する。

phi-client phi/engine/parser.py + map_data.py を移植・統合(GameState 非依存に再構成)。
"""
from __future__ import annotations

from app.protocol.code_converter import CodeConverter

# --- 定数 ----------------------------------------------------------------

MAP_X_COUNT = 7
MAP_Y_COUNT = 7
MAP_CHIP_BYTE = MAP_X_COUNT * MAP_Y_COUNT * 2  # 98
MAP_X_COUNT_5x5 = 5
MAP_Y_COUNT_5x5 = 5

M57_DIRECTION_OFFSET = 7
M57_CHIP_OFFSET = 18

# 自キャラ方角(#m57 M raw[7])の文字 → 数値0-7(時計回り N=0 起点, 45度刻み)。
# 観測値は N/E/S/W のみ(45度斜めは未観測)だが将来拡張のため 8 方向定義。
_DIR_CHAR_TO_NUM = {
    "N": 0, "E": 2, "S": 4, "W": 6,
    "NE": 1, "SE": 3, "SW": 5, "NW": 7,
}

# #cond 7 フラグのキー順(classStatus::SetCondition 準拠)
_COND_KEYS = ["poison", "palsy", "panic", "confuse", "berserk", "silence", "blind"]

# #status 11 項目のキー順(name 以外)
_STATUS_KEYS = ["hp", "maxHp", "mp", "maxMp", "exp", "gp", "f", "w", "m", "c"]

# EagleEye(#ex-eagleeye)グリッド上限(EagleEye.cpp MAX_EAGLE_EYE_COUNT)。
MAX_EAGLE_EYE_COUNT = 15


class _EagleEyeAccum:
    """`#ex-eagleeye` 増分行を集約し契約形 eagleEye payload を構築。

    移植元: phi-client phi/engine/eagle_eye.py。
    ワイヤ形式(EagleEye.cpp::SetOneLine / phi_m57.c::eagleeye_m57):
      - `#ex-eagleeye start`        → バッファ初期化
      - `#ex-eagleeye M <sx> <y> <chip,attr...>` → 1 行(chip,attr ペア, raw[21]起点)
      - `#ex-eagleeye pos <x> <y>`  → 自キャラ位置
      - `#ex-eagleeye end`          → 確定(呼出側が build() で payload 取得)
    """

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        # grid[y][x] = {"chip","attr"}。MAX×MAX を 0 初期化。
        self.grid: list[list[dict]] = [
            [{"chip": 0, "attr": 0} for _ in range(MAX_EAGLE_EYE_COUNT)]
            for _ in range(MAX_EAGLE_EYE_COUNT)
        ]
        self.size_x = 0
        self.size_y = 0
        self.pos_x = 0
        self.pos_y = 0

    def feed_line(self, raw: bytes) -> None:
        """`#ex-eagleeye …`(start/M/pos)の 1 行を統合。end は呼出側判定。"""
        if len(raw) < 14:
            return
        # offset 13(0-based) = C++ Text[14](1-based)
        marker = raw[13:14]
        if raw[13:18].startswith(b"start"):
            self.reset()
        elif marker == b"M":
            self._parse_row(raw)
        elif raw[13:16].startswith(b"pos"):
            self._parse_pos(raw)

    def _parse_row(self, raw: bytes) -> None:
        # ヘッダ `#ex-eagleeye M %2.2d %2.2d ` は raw[:21]。binary は raw[21]起点。
        try:
            header = raw[:21].decode("ascii", errors="strict")
        except UnicodeDecodeError:
            return
        parts = header.split()
        if len(parts) < 4:
            return
        try:
            tmp_size = int(parts[2])
            tmp_y = int(parts[3])
        except ValueError:
            return
        if tmp_y < 0 or tmp_y >= MAX_EAGLE_EYE_COUNT:
            return
        self.size_y = max(self.size_y, tmp_y + 1)
        self.size_x = min(tmp_size + 1, MAX_EAGLE_EYE_COUNT)
        data_start = 21
        for x in range(self.size_x):
            i = data_start + x * 2
            if i + 1 >= len(raw):
                break
            self.grid[tmp_y][x]["chip"] = raw[i]
            self.grid[tmp_y][x]["attr"] = raw[i + 1]

    def _parse_pos(self, raw: bytes) -> None:
        try:
            text = raw.decode("ascii", errors="strict")
        except UnicodeDecodeError:
            return
        parts = text.split()
        if len(parts) < 4:
            return
        try:
            self.pos_x = int(parts[2])
            self.pos_y = int(parts[3])
        except ValueError:
            return

    def build(self) -> dict:
        """確定 payload([07]§6.11)を返す。cells は width*height 行優先。"""
        w = self.size_x
        h = self.size_y
        cells: list[dict] = []
        for y in range(h):
            for x in range(w):
                c = self.grid[y][x]
                cells.append({"chip": c["chip"], "attr": c["attr"]})
        return {
            "type": "eagleEye",
            "width": w,
            "height": h,
            "self": {"x": self.pos_x, "y": self.pos_y},
            "cells": cells,
        }


class ProtocolParser:
    """ステートフルな行パーサ。`feed(raw)` がイベント dict のリストを返す。

    1 行が複数イベントを生む / 0 イベントのこともあるためリストで返す。
    map は M/O/. に跨るので内部にフレームを蓄積し、. で確定 emit。
    """

    def __init__(self, code_converter: CodeConverter | None = None) -> None:
        self._cc = code_converter or CodeConverter()

        # モードフラグ(差分検知用に保持)
        self._mode = {"attack": False, "magic": False, "list": False, "more": False}

        # ブロック状態
        self._in_more = False
        self._in_list = False
        self._list_lines: list[str] = []

        # マップフレーム蓄積
        self._reset_map_frame()
        self._chara_clear_pending = False

        # #ex-obj S 巨大グラ拡大テーブル: キャラ名 → {"w","h","z"}
        # (classMakeMap::GraMagnifyRatioAdd 相当)。map.chars[].magnify に転写。
        # キーは #m57 O の name 欄(実データ/phi-client準拠。DEVLOG A-29)。
        self._name_magnify: dict[str, dict[str, int]] = {}

        # #user 表(name → 番号)。priv 宛先解決用に保持・公開。
        self.ulist: dict[str, int] = {}

        # EagleEye 増分集約(start..end をバッファし end で確定 emit)。
        self._eagle = _EagleEyeAccum()
        # 直近 mapset(eagleEye payload の任意 mapset 付与用, A-19)。
        self._mapset: str | None = None

    # ------------------------------------------------------------------
    # マップフレーム
    # ------------------------------------------------------------------

    def _reset_map_frame(self) -> None:
        self._map_size = 7
        self._map_dir = 0
        self._map_cells: list[dict] | None = None
        self._map_chars: list[dict] = []

    # ------------------------------------------------------------------
    # 公開エントリポイント
    # ------------------------------------------------------------------

    def feed(self, raw: bytes) -> list[dict]:
        """サーバからの 1 行(生バイト)を処理しイベント dict のリストを返す。"""
        if not raw:
            return []

        # コマンド行判定: 先頭 '#' かつ 2 バイト目が '#'/' ' 以外
        is_command = (
            raw[0:1] == b"#"
            and len(raw) > 1
            and raw[1:2] not in (b"#", b" ")
        )

        if is_command:
            # バイナリ地形行は decode せず生バイトで処理
            if raw.startswith(b"#m57 M"):
                self._parse_m57_M(raw)
                return []
            if raw.startswith(b"#map M"):
                self._parse_map_M(raw)
                return []
            text = self._cc.decode(raw)
            return self._dispatch_command(text, raw)

        # #more ブロック: コマンド解析せずログへ
        if self._in_more:
            if raw.startswith(b"#end-more"):
                self._in_more = False
                return self._set_mode(more=False)
            return [self._message("log", self._cc.decode(raw))]

        # #list ブロック内の行
        if self._in_list:
            self._list_lines.append(self._cc.decode(raw))
            return []

        # 一般行 → message
        text = self._cc.decode(raw)

        # priv 検出: "[Sender] > ..."
        if raw[0:1] == b"[":
            bracket_end = text.find("]")
            if bracket_end > 0:
                sender = text[1:bracket_end]
                after = text[bracket_end + 1:].lstrip()
                if after.startswith(">"):
                    return [self._message("priv", text, frm=sender)]

        return [self._message("log", text)]

    # ------------------------------------------------------------------
    # コマンドディスパッチ
    # ------------------------------------------------------------------

    def _dispatch_command(self, text: str, raw: bytes) -> list[dict]:
        def starts(p: str) -> bool:
            return text.startswith(p)

        # --- 通知系 ----------------------------------------------------
        if starts("#name "):
            return [{"type": "notice", "name": text[6:]}]

        if starts("#status ") or text == "#status":
            return [self._parse_status(text)]

        if starts("#cond "):
            return [self._parse_cond(text)]

        if text in ("#close", "#x"):
            return [{"type": "connection", "state": "closed"}]

        if text == "#lag":
            # 内部処理。呼出側が #end-lag 応答。FE 非露出。
            return [{"type": "_internal", "action": "lag"}]

        if text == "#remap":
            return [{"type": "_internal", "action": "remap"}]

        # --- モードフラグ ---------------------------------------------
        if text == "#more":
            self._in_more = True
            evs = self._set_mode(more=True)
            evs.append(self._message("log", text))
            return evs
        if text == "#end-more":
            self._in_more = False
            return self._set_mode(more=False)

        if text == "#list":
            self._in_list = True
            self._list_lines = []
            evs = self._set_mode(list=True)
            evs.append({"type": "list", "active": True, "lines": []})
            return evs
        if starts("#end-list"):
            self._in_list = False
            lines = self._list_lines
            self._list_lines = []
            evs = [
                {"type": "list", "active": True, "lines": lines},
                {"type": "list", "active": False},
            ]
            evs.extend(self._set_mode(list=False))
            return evs

        if text == "#attack":
            return self._set_mode(attack=True)
        if text == "#end-at":
            return self._set_mode(attack=False)
        if text == "#magic":
            return self._set_mode(magic=True)
        if text == "#end-mg":
            return self._set_mode(magic=False)

        # --- マップ確定 ------------------------------------------------
        if text == "#m57 .":
            self._map_size = 7
            return self._finish_map()
        if text == "#map .":
            self._map_size = 5
            return self._finish_map()

        # --- マップ キャラ/オブジェクト -------------------------------
        if raw.startswith(b"#m57 O "):
            self._parse_m57_O(raw)
            return []
        if raw.startswith(b"#m57 W "):
            # A3: ワイド(2 スロット): raw[7:74] / raw[75:142]
            if len(raw) >= 74:
                self._parse_m57_O(b"#m57 O " + raw[7:74])
            if len(raw) >= 142:
                self._parse_m57_O(b"#m57 O " + raw[75:142])
            return []

        # --- EagleEye(#ex-eagleeye start/M/pos/end を集約し構造化, CR-2) ---
        if text == "#ex-eagleeye end":
            payload = self._eagle.build()
            # A-19: 別チップセット時のため任意 mapset を付与(あれば)。
            if self._mapset:
                payload["mapset"] = self._mapset
            return [payload]
        if starts("#ex-eagleeye "):
            # 増分(start/M/pos)を蓄積。end で確定 emit するため非露出。
            self._eagle.feed_line(raw)
            return []

        # --- #ex-obj S: 巨大グラ拡大登録(イベント非露出) -------------
        if starts("#ex-obj S "):
            self._parse_ex_obj(text)
            return []

        # --- 入力(edit) -----------------------------------------------
        if text == "#m-edit":
            return [{"type": "edit", "mode": "multi"}]
        if text == "#s-edit":
            return [{"type": "edit", "mode": "single"}]
        if text == "#.":
            return [{"type": "edit", "mode": "end"}]

        # --- ユーザ一覧 ------------------------------------------------
        if starts("#user "):
            ev = self._parse_user(raw)
            return [ev] if ev else []

        # --- BGM(無視) ------------------------------------------------
        if starts("#bgm "):
            return []

        # --- 環境通知 --------------------------------------------------
        if starts("#mapset "):
            self._mapset = text[8:].strip()
            return [{"type": "notice", "mapset": self._mapset}]
        if starts("#ex-notice land="):
            return [{"type": "notice", "world": text[16:]}]
        if starts("#ex-notice area="):
            return [{"type": "notice", "area": text[16:]}]

        # --- 表示モード(エコー。内部状態更新用。FE は view.set で要求) ---
        if text in ("#ex-map size=57", "#ex-map size=40",
                    "#ex-map style=turn", "#ex-map style=solid"):
            return []

        # --- 世界移動 --------------------------------------------------
        if starts("#ch-srv "):
            parts = text.split()
            if len(parts) >= 3:
                try:
                    return [{
                        "type": "worldTransfer",
                        "state": "start",
                        "server": f"{parts[1]}:{int(parts[2])}",
                    }]
                except (ValueError, IndexError):
                    return []
            return []

        # その他既知/未知コマンドは無視(前方互換 [07]§11)
        return []

    # ------------------------------------------------------------------
    # モード差分 emit
    # ------------------------------------------------------------------

    def _set_mode(self, **changes) -> list[dict]:
        """モードフラグを更新。変化があれば全量 mode イベントを返す。"""
        changed = False
        for k, v in changes.items():
            if self._mode.get(k) != v:
                self._mode[k] = v
                changed = True
        if not changed:
            return []
        return [{"type": "mode", **self._mode}]

    # ------------------------------------------------------------------
    # status / cond
    # ------------------------------------------------------------------

    def _parse_status(self, text: str) -> dict:
        """#status Name : HP : MaxHP : MP : MaxMP : Exp : Gp : F : W : M : C"""
        body = text[len("#status"):].lstrip()
        parts = body.split(":")
        ev: dict = {"type": "status"}
        if parts and parts[0].strip():
            ev["name"] = parts[0].strip()
        for i, key in enumerate(_STATUS_KEYS, start=1):
            if i < len(parts):
                try:
                    ev[key] = int(parts[i].strip())
                except ValueError:
                    pass
        return ev

    def _parse_cond(self, text: str) -> dict:
        """#cond の位置 6-12(0-based) の 7 文字。* =有効 / それ以外=無効。"""
        ev: dict = {"type": "cond"}
        flags = text[6:13]
        for i, key in enumerate(_COND_KEYS):
            ev[key] = (i < len(flags) and flags[i] == "*")
        return ev

    # ------------------------------------------------------------------
    # #user
    # ------------------------------------------------------------------

    def _parse_user(self, raw: bytes) -> dict | None:
        """#user: raw[6:10]=4桁番号, raw[11:42]=31バイト cp932 名前。"""
        if len(raw) < 42:
            return None
        try:
            no = int(raw[6:10].decode("ascii"))
        except (UnicodeDecodeError, ValueError):
            return None
        name = raw[11:42].decode("cp932", errors="replace").rstrip()
        if not name:
            return None
        self.ulist[name] = no
        # key は番号を隠蔽([07]§6.6)。"u<番号>" を採番。
        users = [{"key": f"u{n}", "name": nm} for nm, n in self.ulist.items()]
        return {"type": "userList", "users": users}

    # ------------------------------------------------------------------
    # #ex-obj S: 巨大グラ拡大
    # ------------------------------------------------------------------

    def _parse_ex_obj(self, text: str) -> None:
        """#ex-obj S <w> <h> <z> <name> → キャラ名→{w,h,z} を登録。

        (classPersonalThread::SharpExObj → classMakeMap::GraMagnifyRatioAdd)。
        末尾は #m57 O の name 欄に一致する表示名(実データ確認: 例
        "Remains guardian dragon"/"野ネズミ"。gra名ではない。DEVLOG A-29)。
        名前はスペースを含み得るため maxsplit で末尾を一括取得。
        不正(引数不足/非数値)は無視。
        """
        parts = text.split(None, 5)
        if len(parts) != 6:
            return
        try:
            w = int(parts[2])
            h = int(parts[3])
            z = int(parts[4])
        except ValueError:
            return
        name = parts[5].strip()
        if not name:
            return
        self._name_magnify[name] = {"w": w, "h": h, "z": z}

    # ------------------------------------------------------------------
    # マップ: 地形(M)
    # ------------------------------------------------------------------

    def _parse_m57_M(self, raw: bytes) -> None:
        """#m57 M: 7x7。raw[18:116]=98バイト(chip,attr)×49。dir=raw[7]。"""
        self._map_size = 7
        if len(raw) > M57_DIRECTION_OFFSET:
            self._map_dir = _DIR_CHAR_TO_NUM.get(chr(raw[M57_DIRECTION_OFFSET]), 0)
        if len(raw) < M57_CHIP_OFFSET + MAP_CHIP_BYTE:
            self._map_cells = None
            return
        chip_bytes = raw[M57_CHIP_OFFSET:M57_CHIP_OFFSET + MAP_CHIP_BYTE]
        cells = []
        for i in range(MAP_X_COUNT * MAP_Y_COUNT):
            cells.append({"chip": chip_bytes[i * 2], "attr": chip_bytes[i * 2 + 1]})
        self._map_cells = cells

    def _parse_map_M(self, raw: bytes) -> None:
        """#map M: 5x5。'-' は前フレーム再利用(更新なし)。"""
        self._map_size = 5
        body = raw[7:].rstrip(b"\r\n")
        if body == b"-":
            return  # 更新なし。前フレーム維持。
        if len(raw) > M57_DIRECTION_OFFSET:
            self._map_dir = _DIR_CHAR_TO_NUM.get(chr(raw[M57_DIRECTION_OFFSET]), 0)
        CHIP_BASE = 18
        ITEM_OFFSET = 50
        SIGN_OFFSET = 51
        cells: list[dict] = []
        for i in range(MAP_X_COUNT_5x5 * MAP_Y_COUNT_5x5):
            chip_idx = CHIP_BASE + i * 2
            if chip_idx >= len(raw):
                cells.append({"chip": 0, "attr": 0})
                continue
            chip = raw[chip_idx]
            attr = 0
            item_idx = chip_idx + ITEM_OFFSET
            sign_idx = chip_idx + SIGN_OFFSET
            if item_idx < len(raw) and raw[item_idx] == ord("."):
                attr |= 0x60
            if sign_idx < len(raw) and raw[sign_idx] == ord("-"):
                attr |= 0x08
            cells.append({"chip": chip, "attr": attr})
        self._map_cells = cells

    # ------------------------------------------------------------------
    # マップ: キャラ/オブジェクト(O)
    # ------------------------------------------------------------------

    def _parse_m57_O(self, raw: bytes) -> None:
        """#m57 O フィールド抽出(map_data.parse_m57_O 準拠)。

        [7]Layer / [8:12]ID(hex) / [13]X / [15]Y / [17]Dir(B/R/F/L) /
        [19:50]Name(cp932,31B) / [51:53]Status(hex) / [54:69]Gra(cp932,15B) /
        [70]Gigant / [72:74]Default(hex, typeコード)。
        """
        if len(raw) < 74:
            return
        try:
            layer = int(chr(raw[7]), 16)
            char_id = int(raw[8:12].decode("ascii"), 16)
            x = int(chr(raw[13]))
            y = int(chr(raw[15]))
            direction = chr(raw[17])  # A-05: chars[].dir は文字のまま
            name = raw[19:50].decode("cp932", errors="replace").rstrip()
            status = int(raw[51:53].decode("ascii"), 16)
            gra = raw[54:69].decode("cp932", errors="replace").rstrip()
            gigant = chr(raw[70])
            default = int(raw[72:74].decode("ascii"), 16)
        except (ValueError, IndexError):
            return

        if self._chara_clear_pending:
            self._map_chars = []
            self._chara_clear_pending = False

        chara: dict = {
            "id": char_id, "x": x, "y": y, "dir": direction,
            "name": name, "gra": gra, "status": status,
            "gigant": gigant, "layer": layer, "default": default,
        }
        # #ex-obj S 登録済みキャラ名なら巨大拡大 magnify を付与(FE 描画用)。
        magnify = self._name_magnify.get(name)
        if magnify is not None:
            chara["magnify"] = dict(magnify)
        self._map_chars.append(chara)

    def _finish_map(self) -> list[dict]:
        """#m57 . / #map . でフレーム確定 → map イベント emit。

        次フレーム用に chara クリアを予約(C++ ClearCharaGraData 相当)。
        """
        ev: dict = {
            "type": "map",
            "size": self._map_size,
            "dir": self._map_dir,
            "cells": self._map_cells if self._map_cells is not None else [],
            "chars": list(self._map_chars),
        }
        # フレーム送出後、次フレームの最初の O 行で chara をクリアする予約
        # (C++ SetCharaGraDataClearFlag 相当)。chars 自体は次 O 行まで保持。
        self._chara_clear_pending = True
        return [ev]

    # ------------------------------------------------------------------
    # message ヘルパ
    # ------------------------------------------------------------------

    def _message(self, channel: str, text: str, frm: str | None = None) -> dict:
        ev: dict = {"type": "message", "channel": channel, "text": text}
        if frm is not None:
            ev["from"] = frm
        ev["markup"] = "/*" in text
        return ev
