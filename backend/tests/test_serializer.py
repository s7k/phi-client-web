"""B4 CommandSerializer テスト ([11]§5.4, [07]§7)。

intent dict → レガシー bytes(cp932)。UTF-8→cp932 変換は送信直前。
"""
from __future__ import annotations

import pytest

from app.protocol.serializer import CommandSerializer


@pytest.fixture
def ser() -> CommandSerializer:
    return CommandSerializer()


def _txt(ser, intent):
    return ser.to_legacy_text(intent)


# --- chat -----------------------------------------------------------------

def test_chat_normal(ser):
    assert _txt(ser, {"type": "chat", "mode": "normal", "text": "hello"}) == "hello"


def test_chat_loud(ser):
    assert _txt(ser, {"type": "chat", "mode": "loud", "text": "集合"}) == "*集合"


def test_chat_normal_starting_asterisk_escaped(ser):
    # 先頭 '*' の通常発言 → loud 誤認回避で /**/ 付与
    assert _txt(ser, {"type": "chat", "mode": "normal", "text": "*星*"}) == "/**/*星*"


def test_chat_priv_resolution(ser):
    ser.user_map = {"u12": 12}
    out = _txt(ser, {"type": "chat", "mode": "priv", "to": "u12", "text": "やあ"})
    assert out == "priv 12 やあ"


def test_chat_priv_resolution_via_key_format(ser):
    # user_map 未登録でも "u<番号>" 形式キーから番号抽出
    out = _txt(ser, {"type": "chat", "mode": "priv", "to": "u7", "text": "hi"})
    assert out == "priv 7 hi"


def test_chat_priv_callback(ser):
    s = CommandSerializer(resolve_user=lambda k: {"alice": 99}.get(k))
    out = s.to_legacy_text({"type": "chat", "mode": "priv", "to": "alice", "text": "x"})
    assert out == "priv 99 x"


def test_chat_priv_unknown_raises(ser):
    with pytest.raises(ValueError):
        _txt(ser, {"type": "chat", "mode": "priv", "to": "nobody", "text": "x"})


# --- move -----------------------------------------------------------------

def test_move_north_fix_absolute(ser):
    # A-17 北固定(solid): step + 絶対方角 N/E/S/W → go N 等
    assert _txt(ser, {"type": "move", "mode": "step", "dir": "N"}) == "go N"
    assert _txt(ser, {"type": "move", "mode": "step", "dir": "E"}) == "go E"
    assert _txt(ser, {"type": "move", "mode": "step", "dir": "S"}) == "go S"
    assert _txt(ser, {"type": "move", "mode": "step", "dir": "W"}) == "go W"


def test_move_turn_step_relative(ser):
    # A-17 turn(相対): step + F/B → go / go b
    assert _txt(ser, {"type": "move", "mode": "step", "dir": "F"}) == "go"
    assert _txt(ser, {"type": "move", "mode": "step", "dir": "B"}) == "go b"


def test_move_strafe(ser):
    # A-17 turn(相対): strafe + L/R → go l / go r
    assert _txt(ser, {"type": "move", "mode": "strafe", "dir": "L"}) == "go l"
    assert _txt(ser, {"type": "move", "mode": "strafe", "dir": "R"}) == "go r"


def test_move_turn_rotate(ser):
    # A-17 共通: turn + l/r/b → turn l/r/b
    assert _txt(ser, {"type": "move", "mode": "turn", "dir": "l"}) == "turn l"
    assert _txt(ser, {"type": "move", "mode": "turn", "dir": "r"}) == "turn r"
    assert _txt(ser, {"type": "move", "mode": "turn", "dir": "b"}) == "turn b"


def test_move_invalid_step_raises(ser):
    with pytest.raises(ValueError):
        _txt(ser, {"type": "move", "mode": "step", "dir": "Z"})


def test_move_invalid_strafe_raises(ser):
    with pytest.raises(ValueError):
        _txt(ser, {"type": "move", "mode": "strafe", "dir": "X"})


def test_move_invalid_turn_raises(ser):
    with pytest.raises(ValueError):
        _txt(ser, {"type": "move", "mode": "turn", "dir": "x"})


# --- command --------------------------------------------------------------

def test_command_hit(ser):
    assert _txt(ser, {"type": "command", "name": "hit"}) == "hit"


def test_command_pay(ser):
    assert _txt(ser, {"type": "command", "name": "pay", "amount": 100}) == "pay 100"
    assert _txt(ser, {"type": "command", "name": "pay", "amount": 0}) == "pay 0"


def test_command_cast_magic(ser):
    assert _txt(ser, {"type": "command", "name": "castMagic", "spell": "heal"}) == "cast\nheal"


def test_command_summon(ser):
    out = _txt(ser, {"type": "command", "name": "summon",
                     "action": "appear", "creature": "golem"})
    assert out == "cast\nappear\ngolem"


def test_command_raw_passthrough(ser):
    assert _txt(ser, {"type": "command", "name": "raw", "text": "#debug foo"}) == "#debug foo"


def test_command_simple_names(ser):
    for name in ("equip", "get", "use", "read"):
        assert _txt(ser, {"type": "command", "name": name}) == name


def test_command_unknown_raises(ser):
    with pytest.raises(ValueError):
        _txt(ser, {"type": "command", "name": "fly"})


# --- list.select ----------------------------------------------------------

def test_list_select_number(ser):
    assert _txt(ser, {"type": "list.select", "value": 3}) == "3"


def test_list_select_all_cancel(ser):
    assert _txt(ser, {"type": "list.select", "value": "all"}) == "-"
    assert _txt(ser, {"type": "list.select", "value": "cancel"}) == "."


# --- edit -----------------------------------------------------------------

def test_edit_submit_multi(ser):
    out = _txt(ser, {"type": "edit.submit", "mode": "multi",
                     "lines": ["1行目", "2行目"]})
    assert out == "1行目\n2行目\n."


def test_edit_submit_single(ser):
    out = _txt(ser, {"type": "edit.submit", "mode": "single", "lines": ["名前"]})
    assert out == "名前"


def test_edit_cancel_multi(ser):
    assert _txt(ser, {"type": "edit.cancel", "mode": "multi"}) == ".!"


# --- view.set -------------------------------------------------------------

def test_view_set_size_style(ser):
    out = _txt(ser, {"type": "view.set", "mapSize": 57, "mapStyle": "solid"})
    assert "#ex-map size=57" in out
    assert "#ex-map style=solid" in out
    assert ser.map_size == 57 and ser.map_style_turn is False


def test_view_set_eagle_eye(ser):
    assert _txt(ser, {"type": "view.set", "eagleEye": True}) == "#ex-switch eagleeye=form"
    assert _txt(ser, {"type": "view.set", "eagleEye": False}) == "#ex-switch eagleeye=off"


# --- 送信直前 cp932 変換 --------------------------------------------------

def test_serialize_encodes_cp932(ser):
    raw = ser.serialize({"type": "chat", "mode": "normal", "text": "海"})
    assert isinstance(raw, bytes)
    assert raw == "海".encode("cp932")


def test_serialize_priv_cp932(ser):
    ser.user_map = {"u5": 5}
    raw = ser.serialize({"type": "chat", "mode": "priv", "to": "u5", "text": "漢字"})
    assert raw == "priv 5 漢字".encode("cp932")


def test_unknown_intent_raises(ser):
    with pytest.raises(ValueError):
        ser.serialize({"type": "bogus"})
