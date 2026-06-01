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
