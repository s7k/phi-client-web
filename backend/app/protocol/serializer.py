"""B4 CommandSerializer: intent(dict) → レガシー bytes([07]§7)。

設計方針
------------------------------------------------------------------
- 入力は FE からの意図 dict(UTF-8 文字列)。出力はレガシーサーバ向け cp932 bytes。
- UTF-8 → cp932 変換は **送信直前**(本クラス serialize の最終段)で行う([11]§5.4)。
- priv のユーザ番号は外部(SessionManager の #user 表)から注入可能にする
  (`resolve_user` コールバック or `user_map`)。
- move のレガシー整形は map 仕様(5x5/7x7, turn/solid スタイル)で分岐
  (phi-client key_handler 準拠の簡約版)。

phi-client phi/gui/key_handler.py の整形ルールを intent ベースに再構成。
"""
from __future__ import annotations

from typing import Callable

from app.protocol.code_converter import CodeConverter

# A-17 move intent 契約(DEVLOG A-17 確定)。FE は抽象 intent、BE が整形。
#
# - 北固定(solid): move{mode:"step", dir:"N|E|S|W"} → "go N" 等(絶対方角)。
# - turn(相対): move{mode:"step", dir:"F|B"} → "go"/"go b"
#               move{mode:"strafe", dir:"L|R"} → "go l"/"go r"
# - 共通(回転): move{mode:"turn", dir:"l|r|b"} → "turn l/r/b"
#
# step は map スタイルで意味が変わる: 北固定では絶対方角(N/E/S/W)、
# turn スタイルでは相対(F/B = 前進/後退)。strafe は turn スタイル専用(横移動)。

# turn(相対)スタイルの前進・後退。
_TURN_STEP = {"F": "go", "B": "go b"}
# strafe(横移動)。turn スタイルでの左右ストレイフ。
_TURN_STRAFE = {"L": "go l", "R": "go r"}
# 回転(共通)。
_TURN_ROTATE = {"l": "turn l", "r": "turn r", "b": "turn b"}

# north-fix(絶対)モード: 絶対方角をそのまま大文字 go へ。
_NF_GO = {"N": "go N", "S": "go S", "E": "go E", "W": "go W"}


class CommandSerializer:
    """intent dict → レガシー bytes。map 状態を保持し move 整形に使用。"""

    def __init__(
        self,
        code_converter: CodeConverter | None = None,
        resolve_user: Callable[[str], int | None] | None = None,
    ) -> None:
        self._cc = code_converter or CodeConverter()
        # priv 宛先(userKey)→番号 解決。未設定時は user_map から引く。
        self._resolve_user = resolve_user
        self.user_map: dict[str, int] = {}

        # map 仕様(view.set / map イベントで更新)。
        # north_fix = (size==57 and style!="turn")  ← 絶対方角モード
        self.map_size = 57           # 57 | 40(=5x5)
        self.map_style_turn = False  # True=turn(相対) / False=solid(north-fix)

    # ------------------------------------------------------------------
    # 公開: intent → bytes
    # ------------------------------------------------------------------

    def serialize(self, intent: dict) -> bytes:
        """intent dict → cp932 bytes。未知 type は BAD_REQUEST 相当の例外。"""
        text = self.to_legacy_text(intent)
        return self._cc.encode(text)

    def to_legacy_text(self, intent: dict) -> str:
        """intent → レガシー文字列(UTF-8。cp932 変換前)。テスト容易性のため分離。"""
        t = intent.get("type")
        if t == "chat":
            return self._chat(intent)
        if t == "move":
            return self._move(intent)
        if t == "command":
            return self._command(intent)
        if t == "list.select":
            return self._list_select(intent)
        if t == "edit.submit":
            return self._edit_submit(intent)
        if t == "edit.cancel":
            return self._edit_cancel(intent)
        if t == "view.set":
            return self._view_set(intent)
        raise ValueError(f"unknown intent type: {t!r}")

    # ------------------------------------------------------------------
    # chat
    # ------------------------------------------------------------------

    def _chat(self, intent: dict) -> str:
        mode = intent.get("mode", "normal")
        text = intent.get("text", "")

        if mode == "priv":
            no = self._lookup_user(intent.get("to"))
            if no is None:
                raise ValueError(f"unknown priv recipient: {intent.get('to')!r}")
            # A-13: priv は `priv <番号> <本文>`(1行, `#`なし)。実機検証準拠。
            return f"priv {no} {text}"

        if mode == "loud":
            # loud は先頭 '*'。本文が既に '*' でも二重付与しない方針ではなく
            # 仕様通り先頭 '*' を必ず付与(C++ も loud='*'+text)。
            return "*" + text

        if mode == "party":
            # party(Ctrl 発言): 先頭 '%' 整形(phi-client 準拠)。
            return "%" + text

        if mode == "all":
            # 全セッション同報は上位(SessionManager)が各 session へ展開。
            # ここでは単一の normal 整形を返す。
            return self._normal_chat(text)

        # normal
        return self._normal_chat(text)

    @staticmethod
    def _normal_chat(text: str) -> str:
        """通常発言。先頭が '*' の通常発言は loud 誤認回避で /**/ を付与。"""
        if text.startswith("*"):
            return "/**/" + text
        return text

    # ------------------------------------------------------------------
    # move
    # ------------------------------------------------------------------

    def _move(self, intent: dict) -> str:
        mode = intent.get("mode", "step")
        dir_ = intent.get("dir", "")

        # 回転(turn l/r/b): dir に "l"/"r"/"b"、mode="turn"(map スタイル非依存)。
        if mode == "turn":
            if dir_ in _TURN_ROTATE:
                return _TURN_ROTATE[dir_]
            raise ValueError(f"invalid turn dir: {dir_!r}")

        # strafe(横移動 L/R): turn スタイル相対の横移動。
        if mode == "strafe":
            if dir_ in _TURN_STRAFE:
                return _TURN_STRAFE[dir_]
            raise ValueError(f"invalid strafe dir: {dir_!r}")

        # step: 北固定(絶対 N/E/S/W) or turn 相対(F/B)。
        if mode == "step":
            if dir_ in _NF_GO:
                return _NF_GO[dir_]      # 北固定: go N/E/S/W
            if dir_ in _TURN_STEP:
                return _TURN_STEP[dir_]  # turn 相対: F=go / B=go b
            raise ValueError(f"invalid step dir: {dir_!r}")

        raise ValueError(f"invalid move mode: {mode!r}")

    # ------------------------------------------------------------------
    # command
    # ------------------------------------------------------------------

    def _command(self, intent: dict) -> str:
        name = intent.get("name")
        if name == "hit":
            return "hit"
        if name == "pay":
            amount = intent.get("amount", 0)
            return f"pay {int(amount)}"
        if name == "castMagic":
            spell = intent.get("spell", "")
            return f"cast\n{spell}"
        if name == "summon":
            action = intent.get("action", "appear")
            creature = intent.get("creature", "")
            return f"cast\n{action}\n{creature}"
        if name == "shop":
            return intent.get("action", "shop")
        if name == "raw":
            return intent.get("text", "")
        # 同名そのまま送るコマンド群
        if name in ("equip", "unequip", "get", "put", "use",
                    "sort", "read", "write", "board"):
            return name
        raise ValueError(f"unknown command name: {name!r}")

    # ------------------------------------------------------------------
    # list.select
    # ------------------------------------------------------------------

    def _list_select(self, intent: dict) -> str:
        value = intent.get("value")
        if value == "all":
            return "-"
        if value == "cancel":
            return "."
        return str(int(value))  # 数値選択

    # ------------------------------------------------------------------
    # edit
    # ------------------------------------------------------------------

    def _edit_submit(self, intent: dict) -> str:
        mode = intent.get("mode", "single")
        lines = intent.get("lines", [])
        if mode == "multi":
            # 各行 + 終端 '.'
            return "\n".join([*lines, "."])
        # single: 1 行のみ
        return lines[0] if lines else ""

    def _edit_cancel(self, intent: dict) -> str:
        mode = intent.get("mode", "multi")
        if mode == "multi":
            return ".!"
        return ""  # single は空送信

    # ------------------------------------------------------------------
    # view.set
    # ------------------------------------------------------------------

    def _view_set(self, intent: dict) -> str:
        """複数指定時は改行区切りで複数コマンド。内部 map 状態も更新。"""
        cmds: list[str] = []
        if "mapSize" in intent:
            size = intent["mapSize"]
            self.map_size = size
            cmds.append(f"#ex-map size={size}")
        if "mapStyle" in intent:
            style = intent["mapStyle"]
            self.map_style_turn = (style == "turn")
            cmds.append(f"#ex-map style={style}")
        if "eagleEye" in intent:
            val = "form" if intent["eagleEye"] else "off"
            cmds.append(f"#ex-switch eagleeye={val}")
        if not cmds:
            raise ValueError("view.set: no recognized field")
        return "\n".join(cmds)

    # ------------------------------------------------------------------
    # priv ユーザ解決
    # ------------------------------------------------------------------

    def _lookup_user(self, key) -> int | None:
        if key is None:
            return None
        if self._resolve_user is not None:
            no = self._resolve_user(key)
            if no is not None:
                return no
        # user_map は { userKey: 番号 } または { name: 番号 }。
        if key in self.user_map:
            return self.user_map[key]
        # "u<番号>" 形式キーから番号抽出([07]§6.6 採番規則)。
        if isinstance(key, str) and key.startswith("u"):
            try:
                return int(key[1:])
            except ValueError:
                return None
        return None
