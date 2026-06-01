"""B7 WsServer テスト。

FastAPI TestClient は httpx 依存で本環境に未導入のため、WS を duck-typed な
FakeWebSocket に差し替え、`WsConnection.run()` のエンベロープ解析・auth(stub)・
session.open 応答(A-10)・C→S intent ディスパッチ・S→C ストリームを検証。
"""
from __future__ import annotations

import asyncio

import pytest

from app.session import SessionManager
from app.ws_server import WsConnection


class FakeWebSocket:
    """Starlette WebSocket 互換の最小偽物。

    `accept`/`send_json`/`receive_json` を持つ。`feed` でクライアント送信を積む。
    送信は `sent` に記録。受信キューが尽きたら WebSocketDisconnect 相当で抜ける。
    """

    def __init__(self) -> None:
        self.accepted = False
        self.sent: list[dict] = []
        self._inbox: asyncio.Queue = asyncio.Queue()

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def receive_json(self) -> dict:
        item = await self._inbox.get()
        if item is _DISCONNECT:
            from app.ws_server import WsDisconnect
            raise WsDisconnect()
        return item

    def feed(self, msg: dict) -> None:
        self._inbox.put_nowait(msg)

    def disconnect(self) -> None:
        self._inbox.put_nowait(_DISCONNECT)


_DISCONNECT = object()


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self._q: asyncio.Queue = asyncio.Queue()
        self.connected = False

    async def connect(self, host, port, timeout=10.0):
        self.connected = True

    async def close(self):
        self.connected = False
        await self._q.put(None)

    async def send_line(self, text: str):
        self.sent.append(text.encode("cp932", errors="replace") + b"\n")

    async def send_bytes(self, data: bytes):
        self.sent.append(data)

    async def read_line(self):
        return await self._q.get()

    def inject(self, *lines: bytes):
        for ln in lines:
            self._q.put_nowait(ln)


@pytest.fixture
def fake_sock():
    return FakeSocket()


@pytest.fixture
async def server(fake_sock):
    mgr = SessionManager(socket_factory=lambda: fake_sock)
    yield mgr
    await mgr.close_all()


async def _run_conn(ws, mgr):
    """WsConnection.run をバックグラウンドで起動しタスクを返す。"""
    conn = WsConnection(ws, mgr)
    task = asyncio.create_task(conn.run())
    return conn, task


async def _wait(pred, timeout=2.0):
    async def w():
        while not pred():
            await asyncio.sleep(0.005)
    await asyncio.wait_for(w(), timeout)


async def test_hello_sent_on_connect(server):
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    await _wait(lambda: any(m["type"] == "hello" for m in ws.sent))
    hello = next(m for m in ws.sent if m["type"] == "hello")
    assert hello["protocolVersion"] == 1
    ws.disconnect()
    await task


async def test_auth_stub_returns_characters(server):
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    ws.feed({"type": "auth", "reqId": "r1", "id": "user1", "password": "x"})
    await _wait(lambda: any(m["type"] == "auth" and m.get("reqId") == "r1"
                            for m in ws.sent))
    auth = next(m for m in ws.sent if m["type"] == "auth" and m.get("reqId") == "r1")
    assert auth["ok"] is True
    assert isinstance(auth["characters"], list)
    ws.disconnect()
    await task


async def test_session_open_response_a10(server, fake_sock):
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    ws.feed({"type": "session.open", "reqId": "r2", "charId": "char1"})
    await _wait(lambda: any(m["type"] == "session.open" and m.get("reqId") == "r2"
                            for m in ws.sent))
    resp = next(m for m in ws.sent
                if m["type"] == "session.open" and m.get("reqId") == "r2")
    assert resp["ok"] is True
    sid = resp["session"]
    assert isinstance(sid, str) and sid
    # 続いて connection + snapshot
    await _wait(lambda: any(m["type"] == "snapshot" for m in ws.sent))
    assert any(m["type"] == "connection" and m.get("session") == sid
               for m in ws.sent)
    ws.disconnect()
    await task


async def test_intent_dispatched_to_legacy(server, fake_sock):
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    ws.feed({"type": "session.open", "reqId": "r2", "charId": "char1"})
    await _wait(lambda: any(m["type"] == "session.open" for m in ws.sent))
    sid = next(m for m in ws.sent if m["type"] == "session.open")["session"]
    fake_sock.sent.clear()
    ws.feed({"type": "chat", "session": sid, "mode": "loud", "text": "hi"})
    await _wait(lambda: b"*hi\n" in b"".join(fake_sock.sent))
    ws.disconnect()
    await task


async def test_session_omitted_resolves_to_active(server, fake_sock):
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    ws.feed({"type": "session.open", "reqId": "r2", "charId": "char1"})
    await _wait(lambda: any(m["type"] == "session.open" for m in ws.sent))
    fake_sock.sent.clear()
    # session 省略 → アクティブ(単一)へ解決(A-03)
    ws.feed({"type": "command", "name": "hit"})
    await _wait(lambda: b"hit\n" in b"".join(fake_sock.sent))
    ws.disconnect()
    await task


async def test_stream_event_forwarded_to_ws(server, fake_sock):
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    ws.feed({"type": "session.open", "reqId": "r2", "charId": "char1"})
    await _wait(lambda: any(m["type"] == "snapshot" for m in ws.sent))
    fake_sock.inject(b"#status Hero:1:1:1:1:1:1:1:1:1:1")
    await _wait(lambda: any(m["type"] == "status" for m in ws.sent))
    st = next(m for m in ws.sent if m["type"] == "status")
    assert st["name"] == "Hero"
    assert "session" in st
    ws.disconnect()
    await task


async def test_bad_request_on_unknown_intent(server, fake_sock):
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    ws.feed({"type": "session.open", "reqId": "r2", "charId": "char1"})
    await _wait(lambda: any(m["type"] == "session.open" for m in ws.sent))
    sid = next(m for m in ws.sent if m["type"] == "session.open")["session"]
    ws.feed({"type": "bogus", "session": sid})
    await _wait(lambda: any(m["type"] == "error" for m in ws.sent))
    err = next(m for m in ws.sent if m["type"] == "error")
    assert err["error"]["code"] == "BAD_REQUEST"
    ws.disconnect()
    await task


# ======================================================================
# B14 レート制限 / WS同時接続 / view.set(R5)
# ======================================================================

from app.ratelimit import ConcurrencyLimiter, RateLimiter  # noqa: E402


async def _open_session(ws, mgr, **kw):
    """conn を limiters 付きで起動し char1 セッションを開いて sid を返す。"""
    conn = WsConnection(ws, mgr, **kw)
    task = asyncio.create_task(conn.run())
    ws.feed({"type": "session.open", "reqId": "r", "charId": "char1"})
    await _wait(lambda: any(m["type"] == "session.open" for m in ws.sent))
    sid = next(m for m in ws.sent if m["type"] == "session.open")["session"]
    return conn, task, sid


async def test_view_set_sent_to_legacy(server, fake_sock):
    ws = FakeWebSocket()
    _, task, sid = await _open_session(ws, server)
    fake_sock.sent.clear()
    ws.feed({"type": "view.set", "session": sid,
             "mapSize": 40, "mapStyle": "turn", "eagleEye": True})
    await _wait(lambda: b"#ex-map size=40" in b"".join(fake_sock.sent))
    blob = b"".join(fake_sock.sent)
    assert b"#ex-map style=turn" in blob
    assert b"#ex-switch eagleeye=form" in blob
    ws.disconnect()
    await task


async def test_chat_rate_limited(server, fake_sock):
    rl = RateLimiter()
    ws = FakeWebSocket()
    _, task, sid = await _open_session(ws, server, rate_limiter=rl)
    # chat 上限 20 → 21本目で RATE_LIMITED
    for i in range(20):
        ws.feed({"type": "chat", "session": sid, "mode": "normal", "text": f"m{i}"})
    ws.feed({"type": "chat", "session": sid, "mode": "normal", "text": "over"})
    await _wait(lambda: any(
        m["type"] == "error" and m["error"]["code"] == "RATE_LIMITED"
        for m in ws.sent))
    ws.disconnect()
    await task


async def test_command_raw_rate_limited(server, fake_sock):
    rl = RateLimiter()
    ws = FakeWebSocket()
    _, task, sid = await _open_session(ws, server, rate_limiter=rl)
    for i in range(10):
        ws.feed({"type": "command", "session": sid, "name": "raw", "text": f"x{i}"})
    ws.feed({"type": "command", "session": sid, "name": "raw", "text": "over"})
    await _wait(lambda: any(
        m["type"] == "error" and m["error"]["code"] == "RATE_LIMITED"
        for m in ws.sent))
    ws.disconnect()
    await task


async def test_non_raw_command_not_limited(server, fake_sock):
    rl = RateLimiter()
    ws = FakeWebSocket()
    _, task, sid = await _open_session(ws, server, rate_limiter=rl)
    fake_sock.sent.clear()
    # hit を大量送信してもレート対象外
    for _ in range(30):
        ws.feed({"type": "command", "session": sid, "name": "hit"})
    await _wait(lambda: b"".join(fake_sock.sent).count(b"hit\n") >= 30)
    assert not any(m["type"] == "error" for m in ws.sent)
    ws.disconnect()
    await task


async def test_ws_conn_limit_rejects_6th(server):
    cl = ConcurrencyLimiter(limit=2)
    conns = []
    for i in range(2):
        ws = FakeWebSocket()
        conn = WsConnection(ws, server, conn_limiter=cl)
        t = asyncio.create_task(conn.run())
        ws.feed({"type": "auth", "id": "acc"})
        await _wait(lambda w=ws: any(
            m["type"] == "auth" and m.get("ok") for m in w.sent))
        conns.append((ws, t))
    # 3本目(limit=2)は RATE_LIMITED
    ws3 = FakeWebSocket()
    conn3 = WsConnection(ws3, server, conn_limiter=cl)
    t3 = asyncio.create_task(conn3.run())
    ws3.feed({"type": "auth", "id": "acc"})
    await _wait(lambda: any(
        m["type"] == "auth" and m.get("error", {}).get("code") == "RATE_LIMITED"
        for m in ws3.sent))
    ws3.disconnect()
    await t3
    # 1本切断 → 解放され新規接続可
    ws0, t0 = conns[0]
    ws0.disconnect()
    await t0
    await _wait(lambda: cl.count("acc") == 1)
    ws4 = FakeWebSocket()
    conn4 = WsConnection(ws4, server, conn_limiter=cl)
    t4 = asyncio.create_task(conn4.run())
    ws4.feed({"type": "auth", "id": "acc"})
    await _wait(lambda: any(m["type"] == "auth" and m.get("ok") for m in ws4.sent))
    for ws, t in [conns[1], (ws4, t4)]:
        ws.disconnect()
        await t
