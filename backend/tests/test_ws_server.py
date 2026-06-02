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

    `accept`/`send_json`/`receive_json`/`cookies` を持つ。`feed` でクライアント
    送信を積む。送信は `sent` に記録。受信キューが尽きたら WebSocketDisconnect。
    """

    def __init__(self, cookies: dict | None = None) -> None:
        self.accepted = False
        self.sent: list[dict] = []
        self.cookies = cookies or {}
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
        # A-32: 接続先検証用に connect 引数を記録。
        self.connect_args: tuple | None = None

    async def connect(self, host, port, timeout=10.0):
        self.connected = True
        self.connect_args = (host, port)

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


async def test_hello_reports_unauthenticated_on_connect(server):
    # A-33: 接続直後は常に未認証(hello.authenticated=False)。
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    await _wait(lambda: any(m["type"] == "hello" for m in ws.sent))
    hello = next(m for m in ws.sent if m["type"] == "hello")
    assert hello["authenticated"] is False
    assert hello["isAdmin"] is False
    ws.disconnect()
    await task


async def test_ws_auth_message_sets_authenticated_and_admin(server):
    """A-33/A-34: WS `{type:auth, token}` 検証で `{auth, ok:true, isAdmin}` 応答。"""
    from app.auth import AuthService, UidCipher
    from app.store import Store

    store = Store.open(":memory:")
    auth = AuthService(store, UidCipher(UidCipher.generate_key()))
    auth.register("adm", "password1", is_admin=True)
    tok = auth.login("adm", "password1")

    ws = FakeWebSocket()
    conn = WsConnection(ws, server, auth=auth)
    task = asyncio.create_task(conn.run())
    await _wait(lambda: any(m["type"] == "hello" for m in ws.sent))
    ws.feed({"type": "auth", "reqId": "a1", "token": tok})
    await _wait(lambda: any(m["type"] == "auth" for m in ws.sent))
    resp = next(m for m in ws.sent if m["type"] == "auth")
    assert resp["ok"] is True
    assert resp["isAdmin"] is True
    assert resp["reqId"] == "a1"
    # token は応答に含めない(資格情報)。
    assert "token" not in resp
    assert conn._account_id == "adm"
    ws.disconnect()
    await task
    store.close()


async def test_ws_auth_invalid_token_returns_not_ok(server):
    """A-33: 無効 token は `{type:auth, ok:false}`。未認証のまま。"""
    from app.auth import AuthService, UidCipher
    from app.store import Store

    store = Store.open(":memory:")
    auth = AuthService(store, UidCipher(UidCipher.generate_key()))

    ws = FakeWebSocket()
    conn = WsConnection(ws, server, auth=auth)
    task = asyncio.create_task(conn.run())
    await _wait(lambda: any(m["type"] == "hello" for m in ws.sent))
    ws.feed({"type": "auth", "reqId": "a2", "token": "bogus-token"})
    await _wait(lambda: any(m["type"] == "auth" for m in ws.sent))
    resp = next(m for m in ws.sent if m["type"] == "auth")
    assert resp["ok"] is False
    assert conn._account_id is None
    ws.disconnect()
    await task
    store.close()


async def test_session_open_charid_decrypts_and_opens(fake_sock):
    """A-34: session.open {charId} → 所有 char の phi_uid 復号で #open。"""
    from app.auth import AuthService, UidCipher
    from app.store import Store

    store = Store.open(":memory:")
    auth = AuthService(store, UidCipher(UidCipher.generate_key()))
    auth.register("wilt", "password1")
    store.create_character("ch1", "wilt", label="Ransaia Wilt",
                           phi_uid_enc=auth.cipher.encrypt("uid_secret"),
                           host="game1", port=5000)
    tok = auth.login("wilt", "password1")

    mgr = SessionManager(socket_factory=lambda: fake_sock)
    ws = FakeWebSocket()
    conn = WsConnection(ws, mgr, auth=auth)
    task = asyncio.create_task(conn.run())
    await _wait(lambda: any(m["type"] == "hello" for m in ws.sent))
    ws.feed({"type": "auth", "token": tok})
    await _wait(lambda: any(m["type"] == "auth" and m.get("ok") for m in ws.sent))
    ws.feed({"type": "session.open", "reqId": "o", "charId": "ch1"})
    await _wait(lambda: any(m["type"] == "session.open" and m.get("ok")
                            for m in ws.sent))
    resp = next(m for m in ws.sent if m["type"] == "session.open")
    assert resp["ok"] is True
    assert resp["label"] == "Ransaia Wilt"
    # 復号 uid で #open、保存 host/port で接続。
    assert any("#open uid_secret" in s.decode("cp932") for s in fake_sock.sent)
    assert fake_sock.connect_args == ("game1", 5000)
    ws.disconnect()
    await task
    store.close()
    await mgr.close_all()


async def test_session_open_foreign_char_forbidden(fake_sock):
    """A-34: 他人の char を session.open → FORBIDDEN(uid 復号も接続も起きない)。"""
    from app.auth import AuthService, UidCipher
    from app.store import Store

    store = Store.open(":memory:")
    auth = AuthService(store, UidCipher(UidCipher.generate_key()))
    auth.register("wilt", "password1")
    auth.register("other", "password1")
    store.create_character("ch_other", "other",
                           phi_uid_enc=auth.cipher.encrypt("uid_x"))
    tok = auth.login("wilt", "password1")

    mgr = SessionManager(socket_factory=lambda: fake_sock)
    ws = FakeWebSocket()
    conn = WsConnection(ws, mgr, auth=auth)
    task = asyncio.create_task(conn.run())
    await _wait(lambda: any(m["type"] == "hello" for m in ws.sent))
    ws.feed({"type": "auth", "token": tok})
    await _wait(lambda: any(m["type"] == "auth" and m.get("ok") for m in ws.sent))
    ws.feed({"type": "session.open", "reqId": "o", "charId": "ch_other"})
    await _wait(lambda: any(m["type"] == "session.open" and not m.get("ok")
                            for m in ws.sent))
    resp = next(m for m in ws.sent
                if m["type"] == "session.open" and not m.get("ok"))
    assert resp["error"]["code"] == "FORBIDDEN"
    assert fake_sock.connect_args is None  # 接続していない
    ws.disconnect()
    await task
    store.close()
    await mgr.close_all()


async def test_session_open_response_a10(server, fake_sock):
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    ws.feed({"type": "session.open", "reqId": "r2", "id": "char1"})
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


async def test_session_open_with_explicit_host_port(fake_sock):
    """A-32: session.open に host/port 明示 → その接続先で connect される。"""
    mgr = SessionManager(host="default.example", port=1111,
                         socket_factory=lambda: fake_sock)
    ws = FakeWebSocket()
    conn = WsConnection(ws, mgr)
    task = asyncio.create_task(conn.run())
    ws.feed({"type": "session.open", "reqId": "r", "id": "char1",
             "host": "1.2.3.4", "port": 5000})
    await _wait(lambda: any(m["type"] == "session.open" for m in ws.sent))
    assert fake_sock.connect_args == ("1.2.3.4", 5000)
    ws.disconnect()
    await task
    await mgr.close_all()


async def test_session_open_defaults_to_server_host_port(fake_sock):
    """A-32: host/port 省略 → サーバ既定(config PHI_HOST/PHI_PORT)へ接続。"""
    mgr = SessionManager(host="default.example", port=1111,
                         socket_factory=lambda: fake_sock)
    ws = FakeWebSocket()
    conn = WsConnection(ws, mgr)
    task = asyncio.create_task(conn.run())
    ws.feed({"type": "session.open", "reqId": "r", "id": "char1"})
    await _wait(lambda: any(m["type"] == "session.open" for m in ws.sent))
    assert fake_sock.connect_args == ("default.example", 1111)
    ws.disconnect()
    await task
    await mgr.close_all()


async def test_session_open_invalid_port_bad_request(server):
    """A-32: port 不正(非数値)→ BAD_REQUEST。接続要求は起きない。"""
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    ws.feed({"type": "session.open", "reqId": "r", "id": "char1",
             "host": "h", "port": "abc"})
    await _wait(lambda: any(m["type"] == "error" for m in ws.sent))
    err = next(m for m in ws.sent if m["type"] == "error")
    assert err["error"]["code"] == "BAD_REQUEST"
    # session.open 成功応答は来ない。
    assert not any(m["type"] == "session.open" and m.get("ok") for m in ws.sent)
    ws.disconnect()
    await task


async def test_session_open_port_out_of_range_bad_request(server):
    """A-32: port 範囲外(0/65536)→ BAD_REQUEST。"""
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    ws.feed({"type": "session.open", "reqId": "r", "id": "char1", "port": 99999})
    await _wait(lambda: any(m["type"] == "error" for m in ws.sent))
    err = next(m for m in ws.sent if m["type"] == "error")
    assert err["error"]["code"] == "BAD_REQUEST"
    ws.disconnect()
    await task


async def test_session_open_char_uses_saved_host_port(fake_sock):
    """A-34: charId open はキャラ保存の host/port を採用し接続。"""
    from app.auth import AuthService, UidCipher
    from app.store import Store

    store = Store.open(":memory:")
    auth = AuthService(store, UidCipher(UidCipher.generate_key()))
    auth.register("wilt", "password1")
    store.create_character("chR", "wilt", label="R",
                           phi_uid_enc=auth.cipher.encrypt("uid_r"),
                           host="saved.example", port=7777)
    tok = auth.login("wilt", "password1")

    mgr = SessionManager(host="default.example", port=1111,
                         socket_factory=lambda: fake_sock)
    ws = FakeWebSocket()
    conn = WsConnection(ws, mgr, auth=auth)
    task = asyncio.create_task(conn.run())
    await _wait(lambda: any(m["type"] == "hello" for m in ws.sent))
    ws.feed({"type": "auth", "token": tok})
    await _wait(lambda: any(m["type"] == "auth" and m.get("ok") for m in ws.sent))
    ws.feed({"type": "session.open", "reqId": "r", "charId": "chR"})
    await _wait(lambda: any(m["type"] == "session.open" and m.get("ok")
                            for m in ws.sent))
    assert fake_sock.connect_args == ("saved.example", 7777)
    ws.disconnect()
    await task
    store.close()
    await mgr.close_all()


async def test_intent_dispatched_to_legacy(server, fake_sock):
    ws = FakeWebSocket()
    _, task = await _run_conn(ws, server)
    ws.feed({"type": "session.open", "reqId": "r2", "id": "char1"})
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
    ws.feed({"type": "session.open", "reqId": "r2", "id": "char1"})
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
    ws.feed({"type": "session.open", "reqId": "r2", "id": "char1"})
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
    ws.feed({"type": "session.open", "reqId": "r2", "id": "char1"})
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
    ws.feed({"type": "session.open", "reqId": "r", "id": "char1"})
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


def _make_auth(*account_ids):
    """テスト用 AuthService(アカウントを登録済)を返す。"""
    from app.auth import AuthService, UidCipher
    from app.store import Store
    store = Store.open(":memory:")
    auth = AuthService(store, UidCipher(UidCipher.generate_key()))
    for a in account_ids:
        auth.register(a, "password1")
    return auth


async def _ws_auth(ws, tok):
    """WS auth メッセージを送り `{type:auth}` 応答を待って返す。"""
    ws.feed({"type": "auth", "token": tok})
    await _wait(lambda: any(m["type"] == "auth" for m in ws.sent))
    return next(m for m in reversed(ws.sent) if m["type"] == "auth")


async def test_ws_conn_limit_rejects_authenticated(server):
    # A-33: WS auth 時、同時接続上限超過で auth ok:false。
    cl = ConcurrencyLimiter(limit=2)
    auth = _make_auth("acc")
    tok = auth.login("acc", "password1")  # 同一 account で複数接続
    conns = []
    for i in range(2):
        ws = FakeWebSocket()
        conn = WsConnection(ws, server, auth=auth, conn_limiter=cl)
        t = asyncio.create_task(conn.run())
        await _wait(lambda w=ws: any(m["type"] == "hello" for m in w.sent))
        resp = await _ws_auth(ws, tok)
        assert resp["ok"] is True
        conns.append((ws, t))
    # 3本目(limit=2): 同時接続確保できず auth ok:false。
    ws3 = FakeWebSocket()
    conn3 = WsConnection(ws3, server, auth=auth, conn_limiter=cl)
    t3 = asyncio.create_task(conn3.run())
    await _wait(lambda: any(m["type"] == "hello" for m in ws3.sent))
    resp3 = await _ws_auth(ws3, tok)
    assert resp3["ok"] is False
    ws3.disconnect()
    await t3
    # 1本切断 → 解放され新規接続が認証可。
    ws0, t0 = conns[0]
    ws0.disconnect()
    await t0
    await _wait(lambda: cl.count("acc") == 1)
    ws4 = FakeWebSocket()
    conn4 = WsConnection(ws4, server, auth=auth, conn_limiter=cl)
    t4 = asyncio.create_task(conn4.run())
    await _wait(lambda: any(m["type"] == "hello" for m in ws4.sent))
    resp4 = await _ws_auth(ws4, tok)
    assert resp4["ok"] is True
    for ws, t in [conns[1], (ws4, t4)]:
        ws.disconnect()
        await t
    auth.store.close()


# ======================================================================
# 是正ラウンド F1: CR-1 settings / CR-4 堅牢性 / CR-20 map.request
# ======================================================================


class FakeStore:
    """settings の owner-scoped CRUD のみを持つ最小 Store。"""

    def __init__(self) -> None:
        self.data: dict[tuple[str, str], str | None] = {}

    def set_account_setting(self, owner, scope, value):
        self.data[(owner, scope)] = value

    def get_account_setting(self, owner, scope):
        return self.data.get((owner, scope))


async def _auth_conn(ws, mgr, *, plain_id="acc1", auth=None, **kw):
    """WS auth 済みの conn を起動(settings 等の要認証フロー用, A-33)。

    plain_id は account_id として扱う(A-34)。
    """
    auth = auth or _make_auth(plain_id)
    tok = auth.login(plain_id, "password1")
    conn = WsConnection(ws, mgr, auth=auth, **kw)
    task = asyncio.create_task(conn.run())
    await _wait(lambda: any(m["type"] == "hello" for m in ws.sent))
    ws.feed({"type": "auth", "token": tok})
    await _wait(lambda: any(
        m["type"] == "auth" and m.get("ok") for m in ws.sent))
    return conn, task


async def test_settings_set_then_get_roundtrip(server):
    store = FakeStore()
    ws = FakeWebSocket()
    _, task = await _auth_conn(ws, server, store=store)
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
    _, task = await _auth_conn(ws, server, store=store)
    ws.feed({"type": "settings.get", "reqId": "g", "scope": "notify"})
    await _wait(lambda: any(m.get("reqId") == "g" for m in ws.sent))
    resp = next(m for m in ws.sent if m.get("reqId") == "g")
    assert resp["ok"] is True and resp["value"] is None
    ws.disconnect()
    await task


async def test_settings_invalid_scope_bad_request(server):
    store = FakeStore()
    ws = FakeWebSocket()
    _, task = await _auth_conn(ws, server, store=store)
    ws.feed({"type": "settings.get", "reqId": "g", "scope": "bogus"})
    await _wait(lambda: any(m["type"] == "error" for m in ws.sent))
    err = next(m for m in ws.sent if m["type"] == "error")
    assert err["error"]["code"] == "BAD_REQUEST"
    ws.disconnect()
    await task


async def test_settings_set_invalid_value_bad_request(server):
    # 高2: 不正な value(既知キー型不一致)は検証で BAD_REQUEST、保存されない。
    store = FakeStore()
    ws = FakeWebSocket()
    _, task = await _auth_conn(ws, server, store=store)
    ws.feed({"type": "settings.set", "reqId": "bad", "scope": "display",
             "value": {"mapStyle": "iso"}})  # 不正値
    await _wait(lambda: any(m["type"] == "error" and m.get("reqId") == "bad"
                            for m in ws.sent))
    err = next(m for m in ws.sent if m.get("reqId") == "bad")
    assert err["type"] == "error" and err["error"]["code"] == "BAD_REQUEST"
    # 保存されていない(get で None)
    ws.feed({"type": "settings.get", "reqId": "chk", "scope": "display"})
    await _wait(lambda: any(m.get("reqId") == "chk" for m in ws.sent))
    resp = next(m for m in ws.sent if m.get("reqId") == "chk")
    assert resp["value"] is None
    ws.disconnect()
    await task


async def test_settings_set_non_dict_bad_request(server):
    # value が dict でない場合も拒否。
    store = FakeStore()
    ws = FakeWebSocket()
    _, task = await _auth_conn(ws, server, store=store)
    ws.feed({"type": "settings.set", "reqId": "nd", "scope": "notify",
             "value": "not-an-object"})
    await _wait(lambda: any(m["type"] == "error" and m.get("reqId") == "nd"
                            for m in ws.sent))
    err = next(m for m in ws.sent if m.get("reqId") == "nd")
    assert err["error"]["code"] == "BAD_REQUEST"
    ws.disconnect()
    await task


async def test_settings_account_scoped(server):
    # 別IDの設定は混ざらない(所有キー=id_key)。
    store = FakeStore()
    ws1 = FakeWebSocket()
    _, t1 = await _auth_conn(ws1, server, plain_id="accA", store=store)
    ws1.feed({"type": "settings.set", "reqId": "x", "scope": "display",
              "value": {"theme": "dark"}})
    await _wait(lambda: any(m.get("reqId") == "x" for m in ws1.sent))

    ws2 = FakeWebSocket()
    _, t2 = await _auth_conn(ws2, server, plain_id="accB", store=store)
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
