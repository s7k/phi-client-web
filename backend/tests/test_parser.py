"""B3 ProtocolParser テスト ([11]§5.3)。

合成フィクスチャ(tests/fixtures/synthetic/)+ 期待 JSON で検証。
各 # コマンド → [07]§6 形状イベント。境界(短い/不正長/再利用)も確認。
"""
from __future__ import annotations

import json

import pytest

from app.protocol.parser import ProtocolParser
from tests.conftest import SYNTHETIC_DIR, load_synthetic


@pytest.fixture
def parser() -> ProtocolParser:
    return ProtocolParser()


# --- フィクスチャ駆動: 期待 JSON 突合 -------------------------------------

@pytest.fixture(scope="module")
def expected() -> dict:
    return json.loads((SYNTHETIC_DIR / "expected.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", [
    "status.bin", "cond.bin", "cond_none.bin",
    "log_plain.bin", "log_markup.bin", "priv.bin", "user.bin",
])
def test_single_line_fixtures(parser, expected, name):
    assert parser.feed(load_synthetic(name)) == expected[name]


# --- status ---------------------------------------------------------------

def test_status_full(parser):
    ev = parser.feed(b"#status Hero : 100: 200: 30: 40: 5: 6: 7: 8: 9: 10")[0]
    assert ev == {
        "type": "status", "name": "Hero", "hp": 100, "maxHp": 200,
        "mp": 30, "maxMp": 40, "exp": 5, "gp": 6, "f": 7, "w": 8, "m": 9, "c": 10,
    }


def test_status_malformed_partial(parser):
    # 項目欠落でも例外を出さず取得できた分だけ
    ev = parser.feed(b"#status Hero : 100: 200")[0]
    assert ev["type"] == "status"
    assert ev["hp"] == 100 and ev["maxHp"] == 200
    assert "mp" not in ev


# --- cond -----------------------------------------------------------------

def test_cond_all_flags(parser):
    ev = parser.feed(b"#cond *******")[0]
    assert all(ev[k] for k in
               ["poison", "palsy", "panic", "confuse", "berserk", "silence", "blind"])


def test_cond_short_line(parser):
    # 短い行でも欠落フラグは False
    ev = parser.feed(b"#cond **")[0]
    assert ev["poison"] is True and ev["palsy"] is True
    assert ev["blind"] is False


# --- map: #m57 M / O / . --------------------------------------------------

def _feed_map_seq(parser, files):
    last = []
    for f in files:
        evs = parser.feed(load_synthetic(f))
        if evs:
            last = evs
    return last


def test_map_full_frame(parser):
    evs = _feed_map_seq(parser, [
        "m57_M.bin", "m57_O_char.bin", "m57_O_jp.bin",
        "m57_O_special.bin", "m57_dot.bin",
    ])
    assert len(evs) == 1
    m = evs[0]
    assert m["type"] == "map"
    assert m["size"] == 7
    assert m["dir"] == 0  # 'N' → 数値 0 (A-05)
    assert len(m["cells"]) == 49
    assert m["cells"][0] == {"chip": 0, "attr": 0}
    assert len(m["chars"]) == 3


def test_map_chars_normalized(parser):
    m = _feed_map_seq(parser, [
        "m57_M.bin", "m57_O_char.bin", "m57_dot.bin",
    ])[0]
    c = m["chars"][0]
    assert c == {
        "id": 1, "x": 3, "y": 3, "dir": "B", "name": "ExampleChar",
        "gra": "t_Lord", "status": 64, "gigant": "#", "layer": 0, "default": 64,
    }
    # A-05: chars[].dir は文字
    assert isinstance(c["dir"], str)


def test_map_char_japanese_and_special_gra(parser):
    m = _feed_map_seq(parser, [
        "m57_M.bin", "m57_O_jp.bin", "m57_O_special.bin", "m57_dot.bin",
    ])[0]
    names = {c["name"]: c for c in m["chars"]}
    assert names["勇者タロウ"]["gra"] == "侍"
    assert names["勇者タロウ"]["gigant"] == "*"
    assert names["Guard A"]["gra"] == "`obj weird`"


def test_m57_M_only_no_emit_until_dot(parser):
    # M / O 単独では map は emit されない(確定は '.')
    assert parser.feed(load_synthetic("m57_M.bin")) == []
    assert parser.feed(load_synthetic("m57_O_char.bin")) == []
    evs = parser.feed(load_synthetic("m57_dot.bin"))
    assert evs and evs[0]["type"] == "map"


def test_map_chars_cleared_on_new_frame(parser):
    # 1 フレーム目
    _feed_map_seq(parser, ["m57_M.bin", "m57_O_char.bin", "m57_dot.bin"])
    # 2 フレーム目: 新 O は前フレーム chara をクリアして始まる
    m2 = _feed_map_seq(parser, ["m57_M.bin", "m57_O_jp.bin", "m57_dot.bin"])[0]
    assert len(m2["chars"]) == 1
    assert m2["chars"][0]["name"] == "勇者タロウ"


# --- #ex-obj 巨大グラ拡大 (magnify, R7) -----------------------------------

def test_ex_obj_magnify_returns_no_event(parser):
    # #ex-obj S 行は登録のみ。直接のイベントは emit しない。
    assert parser.feed(b"#ex-obj S 32 48 4 ExampleChar") == []


def test_map_char_magnify_applied_when_registered(parser):
    # キャラ名 ExampleChar を ex-obj 登録 → 後続 map の該当 chara に magnify 付与。
    # (キーは name 欄。実データ/phi-client準拠。DEVLOG A-29)
    parser.feed(b"#ex-obj S 32 48 4 ExampleChar")
    m = _feed_map_seq(parser, ["m57_M.bin", "m57_O_char.bin", "m57_dot.bin"])[0]
    c = m["chars"][0]
    assert c["name"] == "ExampleChar"
    assert c["magnify"] == {"w": 32, "h": 48, "z": 4}


def test_map_char_no_magnify_when_unregistered(parser):
    # 未登録の名前には magnify キーを付与しない。
    m = _feed_map_seq(parser, ["m57_M.bin", "m57_O_char.bin", "m57_dot.bin"])[0]
    assert "magnify" not in m["chars"][0]


def test_ex_obj_magnify_not_applied_by_gra(parser):
    # gra名(t_Lord)で登録しても name 不一致なら付与されない(キーは name)。
    parser.feed(b"#ex-obj S 32 48 4 t_Lord")
    m = _feed_map_seq(parser, ["m57_M.bin", "m57_O_char.bin", "m57_dot.bin"])[0]
    assert "magnify" not in m["chars"][0]


def test_ex_obj_malformed_ignored(parser):
    # 引数不足/非数値は無視(例外なし)。後続 map に magnify は付かない。
    assert parser.feed(b"#ex-obj S 32 48 ExampleChar") == []   # z 欠落
    assert parser.feed(b"#ex-obj S a b c ExampleChar") == []   # 非数値
    m = _feed_map_seq(parser, ["m57_M.bin", "m57_O_char.bin", "m57_dot.bin"])[0]
    assert "magnify" not in m["chars"][0]


def test_m57_M_short_line_safe(parser):
    # 不正長(98 バイト未満)でも例外なし。cells 空。
    parser.feed(b"#m57 M N 00000000:")  # ヘッダのみ
    m = parser.feed(b"#m57 .")[0]
    assert m["cells"] == []


# --- #m57 W (ワイド 2 スロット, A3) --------------------------------------

def test_m57_W_two_slots(parser):
    from tests.fixtures.synthetic._build_fixtures import build_m57_O
    o1 = build_m57_O(0, 1, 1, 1, "B", "Alpha", 0x10, "g_a", "#", 0x10)
    o2 = build_m57_O(0, 2, 2, 2, "F", "Beta", 0x20, "g_b", "*", 0x20)
    # W 行: "#m57 W " + slot1(raw[7:74]) + " " + slot2(raw[75:142])
    # build_m57_O は "#m57 O " 7バイト + 67バイト本体 = 74バイト。
    body1 = o1[7:74]
    body2 = o2[7:74]
    wide = b"#m57 W " + body1 + b" " + body2
    parser.feed(load_synthetic("m57_M.bin"))
    parser.feed(wide)
    m = parser.feed(b"#m57 .")[0]
    assert len(m["chars"]) == 2
    assert {c["name"] for c in m["chars"]} == {"Alpha", "Beta"}


# --- 5x5 #map M -----------------------------------------------------------

def test_map_M_5x5(parser):
    # 18 バイトヘッダ + 50 チップ + 50 item + ... 簡易構築
    raw = bytearray(b"#map M N 00000000:")  # 18 バイト
    payload = bytearray(100)
    for i in range(25):
        payload[i * 2] = (i + 1) % 256       # chip
        payload[i * 2 + 1] = 0
    raw += payload
    parser.feed(bytes(raw))
    m = parser.feed(b"#map .")[0]
    assert m["size"] == 5
    assert len(m["cells"]) == 25
    assert m["cells"][0]["chip"] == 1


def test_map_M_reuse_dash(parser):
    # '#map M -' は更新なし → 前フレーム維持
    parser.feed(b"#map M -")
    m = parser.feed(b"#map .")[0]
    assert m["size"] == 5
    # cells は前フレームなし → 空(初期)
    assert m["cells"] == []


# --- list ブロック --------------------------------------------------------

def test_list_block(parser):
    evs_start = parser.feed(b"#list")
    assert any(e["type"] == "list" and e["active"] for e in evs_start)
    assert parser.feed("1: 短剣".encode("cp932")) == []
    assert parser.feed("2: 鉄の剣".encode("cp932")) == []
    # #end-list は選択肢を表示したまま active=True を維持(従来は即closeで消えていた)
    evs_end = parser.feed(b"#end-list")
    list_evs = [e for e in evs_end if e["type"] == "list"]
    assert list_evs[-1]["lines"] == ["1: 短剣", "2: 鉄の剣"]
    assert list_evs[-1]["active"] is True


def test_list_closes_on_ex_list_mode_end(parser):
    # 真のリスト終了は #ex-list-mode-end(ログインで有効化)。これで非表示化。
    parser.feed(b"#list")
    parser.feed("1: a".encode("cp932"))
    parser.feed(b"#end-list")
    evs = parser.feed(b"#ex-list-mode-end")
    list_evs = [e for e in evs if e["type"] == "list"]
    assert list_evs and list_evs[-1]["active"] is False


# --- more ブロック --------------------------------------------------------

def test_more_block(parser):
    evs = parser.feed(b"#more")
    assert any(e["type"] == "mode" and e["more"] for e in evs)
    # ブロック内はログ
    inner = parser.feed("続きの行".encode("cp932"))
    assert inner[0]["channel"] == "log"
    end = parser.feed(b"#end-more")
    assert any(e["type"] == "mode" and not e["more"] for e in end)


# --- mode フラグ (attack/magic) ------------------------------------------

def test_mode_attack_magic(parser):
    a = parser.feed(b"#attack")[0]
    assert a == {"type": "mode", "attack": True, "magic": False,
                 "list": False, "more": False}
    # 変化なし再送は空
    assert parser.feed(b"#attack") == []
    m = parser.feed(b"#magic")[0]
    assert m["magic"] is True and m["attack"] is True
    parser.feed(b"#end-at")
    parser.feed(b"#end-mg")


# --- edit -----------------------------------------------------------------

def test_edit_single_multi_end(parser):
    assert parser.feed(b"#s-edit")[0] == {"type": "edit", "mode": "single"}
    assert parser.feed(b"#m-edit")[0] == {"type": "edit", "mode": "multi"}
    assert parser.feed(b"#.")[0] == {"type": "edit", "mode": "end"}


# --- notice ---------------------------------------------------------------

def test_notice_variants(parser):
    assert parser.feed(b"#name ExampleChar")[0] == {"type": "notice", "name": "ExampleChar"}
    assert parser.feed("#ex-notice land=Fantasy Island".encode("cp932"))[0] == \
        {"type": "notice", "world": "Fantasy Island"}
    assert parser.feed("#ex-notice area=港町の酒場".encode("cp932"))[0] == \
        {"type": "notice", "area": "港町の酒場"}
    assert parser.feed(b"#mapset mansion")[0] == {"type": "notice", "mapset": "mansion"}


# --- connection / 内部 ----------------------------------------------------

def test_connection_close(parser):
    assert parser.feed(b"#close")[0] == {"type": "connection", "state": "closed"}
    assert parser.feed(b"#x")[0] == {"type": "connection", "state": "closed"}


def test_lag_internal(parser):
    ev = parser.feed(b"#lag")[0]
    assert ev["type"] == "_internal" and ev["action"] == "lag"


def test_ch_srv_world_transfer(parser):
    ev = parser.feed(b"#ch-srv 10.0.0.1 20017")[0]
    assert ev["type"] == "worldTransfer"
    assert ev["state"] == "start"
    assert ev["server"] == "10.0.0.1:20017"


def test_bgm_ignored(parser):
    assert parser.feed(b"#bgm Seiju") == []


def test_unknown_command_ignored(parser):
    assert parser.feed(b"#version-srv 05110000") == []
    assert parser.feed(b"#totally-unknown foo") == []


def test_empty_line(parser):
    assert parser.feed(b"") == []


# --- user 番号保持 (priv 解決用) ------------------------------------------

def test_user_table_populated(parser):
    parser.feed(load_synthetic("user.bin"))
    assert parser.ulist == {"ExampleChar": 12}


# --- EagleEye (#ex-eagleeye 集約 構造化, CR-2) ----------------------------

def _ee_row(size: int, y: int, cells: list[tuple[int, int]]) -> bytes:
    """`#ex-eagleeye M %2.2d %2.2d ` ヘッダ(raw[:21]) + chip/attr バイナリ。"""
    hdr = b"#ex-eagleeye M %02d %02d " % (size, y)
    assert len(hdr) == 21
    return hdr + b"".join(bytes([c, a]) for c, a in cells)


def test_eagleeye_aggregated_to_contract(parser):
    # start..M..pos..end を集約し契約形 eagleEye を emit。
    assert parser.feed(b"#ex-eagleeye start") == []
    assert parser.feed(_ee_row(1, 0, [(10, 0), (11, 1)])) == []
    assert parser.feed(_ee_row(1, 1, [(20, 2), (21, 3)])) == []
    assert parser.feed(b"#ex-eagleeye pos 1 0") == []
    evs = parser.feed(b"#ex-eagleeye end")
    assert len(evs) == 1
    ev = evs[0]
    assert ev["type"] == "eagleEye"
    assert ev["width"] == 2 and ev["height"] == 2
    assert ev["self"] == {"x": 1, "y": 0}
    assert ev["cells"] == [
        {"chip": 10, "attr": 0}, {"chip": 11, "attr": 1},
        {"chip": 20, "attr": 2}, {"chip": 21, "attr": 3},
    ]


def test_eagleeye_includes_mapset_when_seen(parser):
    # 直近 #mapset を payload に A-19 任意 mapset として付与。
    parser.feed(b"#mapset mansion")
    parser.feed(b"#ex-eagleeye start")
    parser.feed(_ee_row(0, 0, [(5, 0)]))
    parser.feed(b"#ex-eagleeye pos 0 0")
    ev = parser.feed(b"#ex-eagleeye end")[0]
    assert ev["mapset"] == "mansion"


def test_eagleeye_no_internal_leak(parser):
    # 旧実装の _internal は emit されない(増分は非露出)。
    out = []
    out += parser.feed(b"#ex-eagleeye start")
    out += parser.feed(_ee_row(0, 0, [(1, 0)]))
    assert all(e.get("type") != "_internal" for e in out)


def test_eagleeye_reset_on_new_start(parser):
    # 新 start で前スナップショットをリセット。
    parser.feed(b"#ex-eagleeye start")
    parser.feed(_ee_row(2, 0, [(1, 0), (2, 0), (3, 0)]))
    parser.feed(b"#ex-eagleeye end")
    parser.feed(b"#ex-eagleeye start")
    parser.feed(_ee_row(0, 0, [(9, 0)]))
    parser.feed(b"#ex-eagleeye pos 0 0")
    ev = parser.feed(b"#ex-eagleeye end")[0]
    assert ev["width"] == 1 and ev["height"] == 1
    assert ev["cells"] == [{"chip": 9, "attr": 0}]
