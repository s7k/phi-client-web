"""REST 統合テスト(create_app)。

TestClient で 認証フロー(未認証401 → session 確立 → Bearer 認証成功)、登録
エンドポイント、レート制限(429)を検証(ID-only, A-33 token/Bearer)。
A-33: cookie 廃止で CSRF Origin 検査も撤去 → 任意 Origin で通る。
⛔ 登録はモックTCP代行(実サーバ未接続)。
"""
from __future__ import annotations

import io
from collections import deque

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.auth import AuthService, UidCipher
from app.gfx import CL_TEAL
from app.ratelimit import ConcurrencyLimiter, RateLimiter
from app.store import Store
from app.store.db import id_key_of
from app.ws_server import create_app


def _b(s: str) -> bytes:
    return s.encode("cp932")


class ScriptedSocket:
    def __init__(self, on_send=None, preload=None) -> None:
        self.connected = False
        self.sent: list[str] = []
        self._inbox: deque[bytes | None] = deque(preload or [])
        self._on_send = on_send

    async def connect(self, host, port, timeout=10.0):
        self.connected = True

    async def close(self):
        self.connected = False

    async def send_line(self, text: str):
        self.sent.append(text)
        if self._on_send is not None:
            for r in self._on_send(text):
                self._inbox.append(r)

    async def send_bytes(self, data: bytes):
        self.sent.append(data.decode("cp932", errors="replace"))

    async def read_line(self):
        return self._inbox.popleft() if self._inbox else None


def _bmp() -> bytes:
    img = Image.new("RGB", (96, 160), (255, 0, 0))
    img.putpixel((0, 0), CL_TEAL)
    buf = io.BytesIO()
    img.save(buf, format="BMP")
    return buf.getvalue()


@pytest.fixture
def env(tmp_path, monkeypatch):
    store = Store.open(":memory:")
    cipher = UidCipher(UidCipher.generate_key())
    auth = AuthService(store, cipher)
    # alice を保存ID登録し管理者化(キャラグラ変更系は管理者限定 [08]§10)。
    auth.remember_id("alice", is_admin=True)

    def on_send(text):
        if text == "#ex-get REGINFO IMG":
            return [_b("#ex-put REGINFO IMG"), _b("戦士"), _b("#ex-put .")]
        if text == "#ex-register end":
            return [_b("#ex-put UID AAA00001abcdef")]
        return []

    socket = ScriptedSocket(on_send=on_send)

    from app.register import LegacyRegistrar
    rl = RateLimiter()

    def registrar_factory():
        # 各呼び出しで状態リセットした新規スクリプトソケット。
        return LegacyRegistrar(
            "h", 0, socket_factory=lambda: ScriptedSocket(on_send=on_send)
        )

    app = create_app(
        manager=object(),  # WS 未使用(REST のみ)
        auth=auth,
        assets_dir=str(tmp_path / "assets"),
        registrar_factory=registrar_factory,
        rate_limiter=rl,
        conn_limiter=ConcurrencyLimiter(),
        production=True,  # A-33: CSRF 撤去後も production で通ることを検証
    )
    c = TestClient(app)
    c._store = store  # type: ignore[attr-defined]
    yield c
    store.close()


# A-33: cookie 廃止で CSRF Origin 検査も撤去。任意 Origin(LAN-IP 等)で通る。
HDR = {"Origin": "http://192.168.1.28:8080"}


def _session(env, plain_id, **body):
    """`/api/auth/session` でセッション確立し token を取得。"""
    return env.post("/api/auth/session",
                    json={"id": plain_id, **body}, headers=HDR)


def _login(env, plain_id, **body):
    """セッション確立し `Authorization: Bearer <token>` ヘッダ dict を返す。"""
    r = _session(env, plain_id, **body)
    assert r.status_code == 200, r.text
    return {**HDR, "Authorization": f"Bearer {r.json()['token']}"}


# --- 認証フロー(ID-only セッション確立) ---------------------------------

def test_upload_requires_auth(env):
    # 未認証 → 401
    r = env.post(
        "/api/chara/graphics",
        files={"file": ("g.bmp", _bmp(), "image/bmp")},
        data={"graName": "g", "colorKey": "teal"},
        headers=HDR,
    )
    assert r.status_code == 401


def test_session_returns_is_admin_and_token(env):
    # 管理者 alice → isAdmin True、token を JSON body で返す(Set-Cookie しない)。
    r = _session(env, "alice")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["isAdmin"] is True
    assert isinstance(body["token"], str) and body["token"]
    # A-33: cookie は発行しない。
    assert "set-cookie" not in {k.lower() for k in r.headers}


def test_session_no_id_400(env):
    r = env.post("/api/auth/session", json={}, headers=HDR)
    assert r.status_code == 400


def test_session_non_admin_is_admin_false_and_upload_403(env):
    # 未登録 ID bob でセッション確立 → isAdmin False、upload(Bearer)は 403。
    hdr = _login(env, "bob")
    assert env.post("/api/auth/session", json={"id": "bob"},
                    headers=HDR).json()["isAdmin"] is False
    r2 = env.post(
        "/api/chara/graphics",
        files={"file": ("g.bmp", _bmp(), "image/bmp")},
        data={"graName": "g"},
        headers=hdr,
    )
    assert r2.status_code == 403


def test_session_then_upload(env):
    # A-33: Bearer token で認証して upload。
    hdr = _login(env, "alice")
    r2 = env.post(
        "/api/chara/graphics",
        files={"file": ("g.bmp", _bmp(), "image/bmp")},
        data={"graName": "g", "colorKey": "teal"},
        headers=hdr,
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["graName"] == "g"


def test_session_remember_persists_label(env):
    # remember=True で saved_ids に upsert され label が返る。
    r = _session(env, "carol", remember=True, label="サブ")
    assert r.status_code == 200
    assert r.json().get("label") == "サブ"
    row = env._store.get_saved_id(id_key_of("carol"))
    assert row is not None and row["label"] == "サブ"


def test_lifespan_shutdown_invokes_manager(tmp_path):
    """CR-18: app の lifespan 終了で SessionManager.shutdown が呼ばれる。"""
    store = Store.open(":memory:")
    auth = AuthService(store, UidCipher(UidCipher.generate_key()))

    class RecMgr:
        def __init__(self):
            self.shut = False

        async def shutdown(self):
            self.shut = True

    mgr = RecMgr()
    app = create_app(
        manager=mgr, auth=auth,
        assets_dir=str(tmp_path / "assets"),
        registrar_factory=lambda: None,
        rate_limiter=RateLimiter(), conn_limiter=ConcurrencyLimiter(),
        allowed_origins={"https://app.test"},
    )
    # with でコンテキスト管理すると lifespan(startup/shutdown)が走る。
    with TestClient(app) as c:
        assert c.get("/healthz").status_code == 200
    assert mgr.shut is True
    store.close()


def test_logout(env):
    # A-33: Bearer token を logout で失効 → 同 token で 401。
    hdr = _login(env, "alice")
    r = env.post("/api/auth/logout", headers=hdr)
    assert r.status_code == 200
    r2 = env.post(
        "/api/chara/graphics",
        files={"file": ("g.bmp", _bmp(), "image/bmp")},
        data={"graName": "g"},
        headers=hdr,
    )
    assert r2.status_code == 401


# --- CSRF 撤去(A-33): cookie 廃止で任意 Origin 不問 ----------------------

def test_any_origin_allowed_after_csrf_removed(env):
    # LAN-IP 等の任意 Origin でも session 確立が通る(CSRF 403 が出ない)。
    r = env.post("/api/auth/session", json={"id": "alice"},
                 headers={"Origin": "http://192.168.1.28:8080"})
    assert r.status_code == 200
    # 別 Origin でも 403 にならない(CSRF 検査撤去)。
    r2 = env.post("/api/auth/session", json={"id": "alice"},
                  headers={"Origin": "https://other.test"})
    assert r2.status_code == 200


def test_get_without_origin_ok(env):
    r = env.get("/healthz")
    assert r.status_code == 200


# --- 登録(モックTCP代行) -------------------------------------------------

def test_register_graphics(env):
    hdr = _login(env, "alice")
    r = env.get("/api/register/graphics", headers=hdr)
    assert r.status_code == 200
    assert r.json()["graphics"] == [{"index": 0, "graName": "戦士"}]


def test_register_success(env):
    hdr = _login(env, "alice")
    r = env.post("/api/register",
                 json={"name": "Hero", "pass": "abc123", "imageIndex": 0,
                       "mail": "h@x.z"},
                 headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "Hero"
    char_id = body["charId"]
    # characters に uid 暗号化保存済(account_id=id_key, 生ID非保持)
    row = env._store.get_character(char_id)
    assert row is not None
    assert row["legacy_uid_enc"] is not None
    assert row["account_id"] == id_key_of("alice")


def test_register_local_reject(env):
    hdr = _login(env, "alice")
    r = env.post("/api/register",
                 json={"name": "H", "pass": "x", "imageIndex": 0},
                 headers=hdr)
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["error"]["code"] == "REGISTER_REJECT"
    assert set(detail["error"]["fields"]) == {"name", "pass"}


def test_register_rate_limit_429(env):
    hdr = _login(env, "alice")
    body = {"name": "Hero", "pass": "abc123", "imageIndex": 0}
    for _ in range(5):
        r = env.post("/api/register", json=body, headers=hdr)
        assert r.status_code == 200, r.text
    r = env.post("/api/register", json=body, headers=hdr)
    assert r.status_code == 429
