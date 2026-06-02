"""契約往復カバレッジ([07], 是正ラウンド F1 項目9)。

片側未配線(CR-1/2/3/20 のような BE emit↔FE consume の欠落)の再発防止。

- C→S: [07]§5 の全 intent 型を **valid 入力**で投入し、BAD_REQUEST/INTERNAL/
  未処理例外が発生しないことを機械的に検証(serializer 側で受理されるか、
  ws_server 側で専用処理されるか、もしくは前方互換で無視されるか)。
- S→C: [07]§6 の全 event 型が emit 可能(parser/serializer/manager/ws_server
  のいずれかから到達可能)であることを検証。

実サーバ非依存。FakeWebSocket/FakeSocket/FakeStore のみ。
"""
from __future__ import annotations

import asyncio

import pytest

from app.protocol.parser import ProtocolParser
from app.session import SessionManager
from app.ws_server import WsConnection

from tests.test_ws_server import (
    FakeSocket,
    FakeStore,
    FakeWebSocket,
    _auth_conn,
    _wait,
)


# ----------------------------------------------------------------------
# C→S: 全 intent 型 × valid 入力 → BAD_REQUEST/INTERNAL を出さない
# ----------------------------------------------------------------------

# [07]§5 の C→S type と、有効な最小ペイロード。
# session は open 後に解決(明示付与)。auth/session.* は別フローのため除外。
_VALID_INTENTS: dict[str, dict] = {
    "move": {"type": "move", "mode": "step", "dir": "N"},
    "chat": {"type": "chat", "mode": "normal", "text": "hi"},
    "command": {"type": "command", "name": "hit"},
    "list.select": {"type": "list.select", "value": 1},
    "edit.submit": {"type": "edit.submit", "mode": "single", "lines": ["x"]},
    "edit.cancel": {"type": "edit.cancel", "mode": "multi"},
    "view.set": {"type": "view.set", "mapSize": 57},
    "settings.get": {"type": "settings.get", "scope": "keybind"},
    "settings.set": {"type": "settings.set", "scope": "keybind", "value": {}},
    "map.request": {"type": "map.request"},
    "ping": {"type": "ping", "nonce": "n1"},
}


@pytest.fixture
async def wired():
    """cookie 認証済 + session.open 済の conn を返す(store/socket 配線済)。"""
    sock = FakeSocket()
    mgr = SessionManager(socket_factory=lambda: sock)
    store = FakeStore()
    ws = FakeWebSocket()
    _, task = await _auth_conn(ws, mgr, store=store)
    ws.feed({"type": "session.open", "reqId": "o", "id": "char1"})
    await _wait(lambda: any(m["type"] == "session.open" for m in ws.sent))
    sid = next(m for m in ws.sent if m["type"] == "session.open")["session"]
    yield ws, sid, task
    ws.disconnect()
    await task
    await mgr.close_all()


@pytest.mark.parametrize("name", list(_VALID_INTENTS))
async def test_intent_valid_input_no_bad_request(wired, name):
    ws, sid, _task = wired
    before = len(ws.sent)
    intent = dict(_VALID_INTENTS[name], session=sid)
    ws.feed(intent)
    # 少し回す(処理 or 応答が積まれる)。
    await asyncio.sleep(0.05)
    new = ws.sent[before:]
    bad = [m for m in new if m.get("type") == "error"
           and m.get("error", {}).get("code") in ("BAD_REQUEST", "INTERNAL")]
    assert not bad, f"{name} で {bad} が発生"


# ----------------------------------------------------------------------
# S→C: 全 event 型が emit 可能であることを到達性で検証
# ----------------------------------------------------------------------

def _ee_row(size, y, cells):
    hdr = b"#ex-eagleeye M %02d %02d " % (size, y)
    return hdr + b"".join(bytes([c, a]) for c, a in cells)


def _parser_emittable_types() -> set[str]:
    """ProtocolParser が emit し得る event type を実際に駆動して収集。"""
    p = ProtocolParser()
    lines: list[bytes] = [
        b"#name Hero",
        b"#status Hero:1:1:1:1:1:1:1:1:1:1",
        b"#cond *------",
        b"#user 0007 " + "Friend".encode("cp932").ljust(31),
        b"#list", b"1: a", b"#end-list",
        b"#s-edit",
        b"#attack",
        b"#more", b"#end-more",
        b"#m57 .",                       # map(空フレーム確定)
        b"#ch-srv 1.2.3.4 100",          # worldTransfer start
        b"#mapset mansion",              # notice
        b"#ex-notice area=town",
        b"#ex-eagleeye start", _ee_row(0, 0, [(1, 0)]),
        b"#ex-eagleeye pos 0 0", b"#ex-eagleeye end",  # eagleEye
        b"#x",                           # connection closed
        b"hello plain line",             # message
    ]
    seen: set[str] = set()
    for ln in lines:
        for ev in p.feed(ln):
            t = ev.get("type")
            if t and t != "_internal":
                seen.add(t)
    return seen


def test_all_sc_event_types_reachable():
    # [07]§6 の S→C event 型。hello/saved/connection/snapshot/settings/pong は
    # ws_server が、それ以外は parser が emit する。
    from_parser = _parser_emittable_types()
    # parser 由来で到達すべき型
    expected_parser = {
        "notice", "status", "cond", "message", "userList", "list",
        "edit", "mode", "worldTransfer", "eagleEye", "map", "connection",
    }
    missing = expected_parser - from_parser
    assert not missing, f"parser から到達不能な S→C 型: {missing}"

    # ws_server 由来(ハンドシェイク/応答/ハートビート)。コードに分岐が
    # 存在することをソース走査で担保(片側配線の検出)。
    import inspect

    import app.ws_server as wsmod
    src = inspect.getsource(wsmod)
    for t in ("hello", "saved", "settings", "pong", "error"):
        assert f'"{t}"' in src or f"'{t}'" in src, f"ws_server に {t} emit が無い"
    # snapshot は session.build_snapshot 由来
    import app.session as smod
    assert '"snapshot"' in inspect.getsource(smod)
