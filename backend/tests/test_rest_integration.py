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
