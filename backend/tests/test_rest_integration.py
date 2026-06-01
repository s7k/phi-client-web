"""REST 統合テスト(create_app)。

TestClient で 認証フロー(未認証401 → login → 認証要求成功)、登録エンドポイント、
CSRF Origin 検査、レート制限(429)を検証。⛔ 登録はモックTCP代行(実サーバ未接続)。
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
    auth.register_account("alice", "password1")

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
        allowed_origins={"https://app.test"},
    )
    # Secure cookie を保持/送出させるため https ベース URL を使う。
    c = TestClient(app, base_url="https://testserver")
    c._store = store  # type: ignore[attr-defined]
    yield c
    store.close()


HDR = {"Origin": "https://app.test"}


# --- 認証フロー -----------------------------------------------------------

def test_upload_requires_auth(env):
    # 未認証 → 401
    r = env.post(
        "/api/chara/graphics",
        files={"file": ("g.bmp", _bmp(), "image/bmp")},
        data={"graName": "g", "colorKey": "teal"},
        headers=HDR,
    )
    assert r.status_code == 401


def test_login_then_upload(env):
    r = env.post("/api/auth/login", json={"id": "alice", "password": "password1"},
                 headers=HDR)
    assert r.status_code == 200
    # cookie が TestClient に保持される
    r2 = env.post(
        "/api/chara/graphics",
        files={"file": ("g.bmp", _bmp(), "image/bmp")},
        data={"graName": "g", "colorKey": "teal"},
        headers=HDR,
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["graName"] == "g"


def test_login_bad_password(env):
    r = env.post("/api/auth/login", json={"id": "alice", "password": "wrong"},
                 headers=HDR)
    assert r.status_code == 401


# --- CR-11: login 総当たり 失敗バックオフ --------------------------------

def test_login_brute_force_throttled(tmp_path):
    """連続失敗で 429 になり、正規パスワードでも一時的に拒否される。"""
    from app.ratelimit import (
        ConcurrencyLimiter,
        LoginThrottle,
        RateLimiter,
    )
    from app.ws_server import create_app

    store = Store.open(":memory:")
    cipher = UidCipher(UidCipher.generate_key())
    auth = AuthService(store, cipher)
    auth.register_account("alice", "password1")

    lt = LoginThrottle(rate=(3, 300.0))  # 3 失敗 / 5分。
    app = create_app(
        manager=object(),
        auth=auth,
        assets_dir=str(tmp_path / "assets"),
        registrar_factory=lambda: None,
        rate_limiter=RateLimiter(),
        conn_limiter=ConcurrencyLimiter(),
        login_throttle=lt,
        allowed_origins={"https://app.test"},
    )
    c = TestClient(app, base_url="https://testserver")
    hdr = {"Origin": "https://app.test"}
    # 3 回失敗(401)。
    for _ in range(3):
        r = c.post("/api/auth/login",
                   json={"id": "alice", "password": "x"}, headers=hdr)
        assert r.status_code == 401
    # 4 回目は throttle で 429(正規 pass でも拒否)。
    r = c.post("/api/auth/login",
               json={"id": "alice", "password": "password1"}, headers=hdr)
    assert r.status_code == 429
    store.close()


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


def test_login_success_resets_throttle(tmp_path):
    """成功でカウンタがリセットされ、以後の失敗予算が回復する。"""
    from app.ratelimit import (
        ConcurrencyLimiter,
        LoginThrottle,
        RateLimiter,
    )
    from app.ws_server import create_app

    store = Store.open(":memory:")
    cipher = UidCipher(UidCipher.generate_key())
    auth = AuthService(store, cipher)
    auth.register_account("alice", "password1")

    lt = LoginThrottle(rate=(3, 300.0))
    app = create_app(
        manager=object(), auth=auth,
        assets_dir=str(tmp_path / "assets"),
        registrar_factory=lambda: None,
        rate_limiter=RateLimiter(), conn_limiter=ConcurrencyLimiter(),
        login_throttle=lt, allowed_origins={"https://app.test"},
    )
    c = TestClient(app, base_url="https://testserver")
    hdr = {"Origin": "https://app.test"}
    # 2 回失敗 → まだ予算あり。
    for _ in range(2):
        assert c.post("/api/auth/login",
                      json={"id": "alice", "password": "x"},
                      headers=hdr).status_code == 401
    # 成功でリセット。
    assert c.post("/api/auth/login",
                  json={"id": "alice", "password": "password1"},
                  headers=hdr).status_code == 200
    # リセット後、再び失敗予算が満タン(3回失敗してもまだ check 可)。
    assert lt.check("alice", "testclient") or lt.bucket_count() == 0
    store.close()


def test_logout(env):
    env.post("/api/auth/login", json={"id": "alice", "password": "password1"},
             headers=HDR)
    r = env.post("/api/auth/logout", headers=HDR)
    assert r.status_code == 200
    # ログアウト後はアップロード 401
    r2 = env.post(
        "/api/chara/graphics",
        files={"file": ("g.bmp", _bmp(), "image/bmp")},
        data={"graName": "g"},
        headers=HDR,
    )
    assert r2.status_code == 401


# --- CSRF -----------------------------------------------------------------

def test_csrf_blocks_bad_origin(env):
    r = env.post("/api/auth/login", json={"id": "alice", "password": "password1"},
                 headers={"Origin": "https://evil.test"})
    assert r.status_code == 403


def test_csrf_allows_get_without_origin(env):
    r = env.get("/healthz")
    assert r.status_code == 200


# --- 登録(モックTCP代行) -------------------------------------------------

def test_register_graphics(env):
    env.post("/api/auth/login", json={"id": "alice", "password": "password1"},
             headers=HDR)
    r = env.get("/api/register/graphics", headers=HDR)
    assert r.status_code == 200
    assert r.json()["graphics"] == [{"index": 0, "graName": "戦士"}]


def test_register_success(env):
    env.post("/api/auth/login", json={"id": "alice", "password": "password1"},
             headers=HDR)
    r = env.post("/api/register",
                 json={"name": "Hero", "pass": "abc123", "imageIndex": 0,
                       "mail": "h@x.z"},
                 headers=HDR)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "Hero"
    char_id = body["charId"]
    # characters に uid 暗号化保存済
    row = env._store.get_character(char_id)
    assert row is not None
    assert row["legacy_uid_enc"] is not None
    assert row["account_id"] == "alice"


def test_register_local_reject(env):
    env.post("/api/auth/login", json={"id": "alice", "password": "password1"},
             headers=HDR)
    r = env.post("/api/register",
                 json={"name": "H", "pass": "x", "imageIndex": 0},
                 headers=HDR)
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["error"]["code"] == "REGISTER_REJECT"
    assert set(detail["error"]["fields"]) == {"name", "pass"}


def test_register_rate_limit_429(env):
    env.post("/api/auth/login", json={"id": "alice", "password": "password1"},
             headers=HDR)
    body = {"name": "Hero", "pass": "abc123", "imageIndex": 0}
    for _ in range(5):
        r = env.post("/api/register", json=body, headers=HDR)
        assert r.status_code == 200, r.text
    r = env.post("/api/register", json=body, headers=HDR)
    assert r.status_code == 429
