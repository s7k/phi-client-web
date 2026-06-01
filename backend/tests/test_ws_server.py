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
    assert auth["isAdmin"] is False  # stub は常に非管理者
    ws.disconnect()
    await task


async def test_auth_with_service_returns_is_admin(server):
    """AuthService 連携時、auth 応答に DB の is_admin を反映。"""
    from app.auth import AuthService, UidCipher
    from app.store import Store

    store = Store.open(":memory:")
    auth = AuthService(store, UidCipher(UidCipher.generate_key()))
    auth.register_account("adm", "pw")
    store.set_admin("adm", True)
    auth.register_account("usr", "pw")

    # 管理者 adm。
    ws = FakeWebSocket()
    conn = WsConnection(ws, server, auth=auth)
    task = asyncio.create_task(conn.run())
    ws.feed({"type": "auth", "reqId": "a", "id": "adm", "password": "pw"})
    await _wait(lambda: any(m.get("reqId") == "a" for m in ws.sent))
    resp = next(m for m in ws.sent if m.get("reqId") == "a")
    assert resp["ok"] is True and resp["isAdmin"] is True
    ws.disconnect()
    await task

    # 非管理者 usr。
    ws2 = FakeWebSocket()
    conn2 = WsConnection(ws2, server, auth=auth)
    task2 = asyncio.create_task(conn2.run())
    ws2.feed({"type": "auth", "reqId": "b", "id": "usr", "password": "pw"})
    await _wait(lambda: any(m.get("reqId") == "b" for m in ws2.sent))
    resp2 = next(m for m in ws2.sent if m.get("reqId") == "b")
    assert resp2["ok"] is True and resp2["isAdmin"] is False
    ws2.disconnect()
    await task2
    store.close()


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


async def test_command_raw_audit_logged(server, fake_sock, caplog):
    # command.raw 送信時に session/text を構造化監査ログ出力([07]§10)。
    import logging
    ws = FakeWebSocket()
    _, task, sid = await _open_session(ws, server)
    fake_sock.sent.clear()
    with caplog.at_level(logging.INFO, logger="phi.audit"):
        ws.feed({"type": "command", "session": sid, "name": "raw", "text": "look"})
        await _wait(lambda: b"look\n" in b"".join(fake_sock.sent))
    recs = [r for r in caplog.records if r.name == "phi.audit"]
    assert recs, "監査ログが出力されていない"
    rec = recs[-1]
    assert getattr(rec, "event", None) == "command.raw"
    assert rec.session == sid
    assert rec.text == "look"
    ws.disconnect()
    await task


async def test_command_raw_audit_no_secret_leak(server, fake_sock, caplog):
    # 監査ログにアカウント情報(uid/password 系キー)を含めない。
    import logging
    ws = FakeWebSocket()
    _, task, sid = await _open_session(ws, server)
    with caplog.at_level(logging.INFO, logger="phi.audit"):
        ws.feed({"type": "command", "session": sid, "name": "raw", "text": "hi"})
        await _wait(lambda: any(
            r.name == "phi.audit" for r in caplog.records))
    rec = next(r for r in caplog.records if r.name == "phi.audit")
    for forbidden in ("uid", "password", "passwd", "pass"):
        assert not hasattr(rec, forbidden)
    ws.disconnect()
    await task


async def test_non_raw_command_not_audited(server, fake_sock, caplog):
    # raw 以外の command は監査ログ対象外。
    import logging
    ws = FakeWebSocket()
    _, task, sid = await _open_session(ws, server)
    with caplog.at_level(logging.INFO, logger="phi.audit"):
        ws.feed({"type": "command", "session": sid, "name": "hit"})
        await _wait(lambda: b"hit\n" in b"".join(fake_sock.sent))
    assert not [r for r in caplog.records if r.name == "phi.audit"]
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


# ======================================================================
# 是正ラウンド F1: CR-1 settings / CR-4 堅牢性 / CR-20 map.request
# ======================================================================


class FakeStore:
    """settings の account-scoped CRUD のみを持つ最小 Store。"""

    def __init__(self) -> None:
        self.data: dict[tuple[str, str], str | None] = {}

    def set_account_setting(self, account_id, scope, value):
        self.data[(account_id, scope)] = value

    def get_account_setting(self, account_id, scope):
        return self.data.get((account_id, scope))


async def _auth_stub(ws, mgr, **kw):
    """stub auth で account を確立した conn を起動。"""
    conn = WsConnection(ws, mgr, **kw)
    task = asyncio.create_task(conn.run())
    ws.feed({"type": "auth", "id": "acc1"})
    await _wait(lambda: any(m["type"] == "auth" and m.get("ok") for m in ws.sent))
    return conn, task


async def test_settings_set_then_get_roundtrip(server):
    store = FakeStore()
    ws = FakeWebSocket()
    _, task = await _auth_stub(ws, server, store=store)
    ws.feed({"type": "settings.set", "reqId": "s1", "scope": "keybind",
             "value": {"up": "w"}})
    await _wait(lambda: any(m["type"] == "settings" and m.get("reqId") == "s1"
                            for m in ws.sent))
    setresp = next(m for m in ws.sent if m.get("reqId") == "s1")
    assert setresp["ok"] is True and setresp["scope"] == "keybind"
    # get で同じ値が返る
    ws.feed({"type": "settings.get", "reqId": "s2", "scope": "keybind"})
    await _wait(lambda: any(m.get("reqId") == "s2" for m in ws.sent))
    getresp = next(m for m in ws.sent if m.get("reqId") == "s2")
    assert getresp["type"] == "settings" and getresp["ok"] is True
    assert getresp["scope"] == "keybind"
    assert getresp["value"] == {"up": "w"}
    ws.disconnect()
    await task


async def test_settings_get_missing_returns_null(server):
    store = FakeStore()
    ws = FakeWebSocket()
    _, task = await _auth_stub(ws, server, store=store)
    ws.feed({"type": "settings.get", "reqId": "g", "scope": "notify"})
    await _wait(lambda: any(m.get("reqId") == "g" for m in ws.sent))
    resp = next(m for m in ws.sent if m.get("reqId") == "g")
    assert resp["ok"] is True and resp["value"] is None
    ws.disconnect()
    await task


async def test_settings_invalid_scope_bad_request(server):
    store = FakeStore()
    ws = FakeWebSocket()
    _, task = await _auth_stub(ws, server, store=store)
    ws.feed({"type": "settings.get", "reqId": "g", "scope": "bogus"})
    await _wait(lambda: any(m["type"] == "error" for m in ws.sent))
    err = next(m for m in ws.sent if m["type"] == "error")
    assert err["error"]["code"] == "BAD_REQUEST"
    ws.disconnect()
    await task


async def test_settings_account_scoped(server):
    # 別アカウントの設定は混ざらない(所有キー=account id)。
    store = FakeStore()
    ws1 = FakeWebSocket()
    conn1 = WsConnection(ws1, server, store=store)
    t1 = asyncio.create_task(conn1.run())
    ws1.feed({"type": "auth", "id": "accA"})
    await _wait(lambda: any(m["type"] == "auth" and m.get("ok") for m in ws1.sent))
    ws1.feed({"type": "settings.set", "reqId": "x", "scope": "display",
              "value": {"theme": "dark"}})
    await _wait(lambda: any(m.get("reqId") == "x" for m in ws1.sent))

    ws2 = FakeWebSocket()
    conn2 = WsConnection(ws2, server, store=store)
    t2 = asyncio.create_task(conn2.run())
    ws2.feed({"type": "auth", "id": "accB"})
    await _wait(lambda: any(m["type"] == "auth" and m.get("ok") for m in ws2.sent))
    ws2.feed({"type": "settings.get", "reqId": "y", "scope": "display"})
    await _wait(lambda: any(m.get("reqId") == "y" for m in ws2.sent))
    resp = next(m for m in ws2.sent if m.get("reqId") == "y")
    assert resp["value"] is None  # accB は未設定
    for ws, t in [(ws1, t1), (ws2, t2)]:
        ws.disconnect()
        await t


async def test_list_select_missing_value_bad_request_not_crash(server, fake_sock):
    # CR-4: list.select の value 欠落 → int(None) TypeError → BAD_REQUEST。
    # 接続はクラッシュせず維持され、後続 intent も処理可能。
    ws = FakeWebSocket()
    _, task, sid = await _open_session(ws, server)
    ws.feed({"type": "list.select", "session": sid})  # value 欠落
    await _wait(lambda: any(
        m["type"] == "error" and m["error"]["code"] == "BAD_REQUEST"
        for m in ws.sent))
    # 接続維持の確認: 後続 hit が処理される
    fake_sock.sent.clear()
    ws.feed({"type": "command", "session": sid, "name": "hit"})
    await _wait(lambda: b"hit\n" in b"".join(fake_sock.sent))
    ws.disconnect()
    await task


async def test_internal_error_returns_internal_keeps_conn(server, fake_sock):
    # CR-4: 想定外例外(RuntimeError)で INTERNAL を返し接続維持。
    ws = FakeWebSocket()
    _, task, sid = await _open_session(ws, server)

    async def boom(session_id, intent):
        raise RuntimeError("unexpected")
    server.handle_intent = boom  # type: ignore[assignment]
    ws.feed({"type": "command", "session": sid, "name": "hit"})
    await _wait(lambda: any(
        m["type"] == "error" and m["error"]["code"] == "INTERNAL"
        for m in ws.sent))
    ws.disconnect()
    await task


async def test_map_request_sends_hash_map(server, fake_sock):
    # CR-20: map.request → レガシーへ #map 送出。
    ws = FakeWebSocket()
    _, task, sid = await _open_session(ws, server)
    fake_sock.sent.clear()
    ws.feed({"type": "map.request", "session": sid})
    await _wait(lambda: b"#map\n" in b"".join(fake_sock.sent))
    ws.disconnect()
    await task
