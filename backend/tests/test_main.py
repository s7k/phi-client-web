"""B-final app.main 起動エントリ検証([12]§7)。

- `import app.main` が通る(実サーバ非接続)。
- Config.from_env が env を正しく解釈。
- TestClient: GET /healthz 200、未認証で保護 REST 401。
- 一時鍵フォールバック / allowed_origins。
"""
from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from app.config import Config, ConfigError, is_production
from app.main import build_app


def test_import_main():
    """`import app.main`(= uvicorn ターゲット)が成功する。"""
    mod = importlib.import_module("app.main")
    assert hasattr(mod, "app")  # ASGI app が公開されている


# ----------------------------------------------------------------------
# Config.from_env
# ----------------------------------------------------------------------

def test_config_from_env_full():
    from app.auth import UidCipher
    env = {
        "PHI_DB_PATH": "/tmp/x.db",
        "PHI_SECRET_KEY": UidCipher.generate_key().decode(),
        "PHI_ALLOWED_ORIGINS": "https://a.example, https://b.example",
        "PHI_ASSETS_DIR": "/tmp/assets",
        "PHI_HOST": "legacy.example",
        "PHI_PORT": "1234",
    }
    cfg = Config.from_env(env)
    assert cfg.db_path == "/tmp/x.db"
    assert cfg.secret_key_ephemeral is False
    assert cfg.allowed_origins == {"https://a.example", "https://b.example"}
    assert cfg.assets_dir == "/tmp/assets"
    assert cfg.legacy_host == "legacy.example"
    assert cfg.legacy_port == 1234


def test_config_defaults_and_ephemeral_key():
    """env 最小: db_path None / origins None / 一時鍵生成。"""
    cfg = Config.from_env({})
    assert cfg.db_path is None
    assert cfg.allowed_origins is None
    assert cfg.assets_dir.endswith("assets")
    assert cfg.legacy_host == ""
    assert cfg.legacy_port == 0
    assert cfg.secret_key_ephemeral is True
    assert len(cfg.secret_key) > 0  # Fernet 鍵
    assert cfg.production is False


# ----------------------------------------------------------------------
# CR-8/CR-9: 本番 fail-closed(未設定で起動失敗)
# ----------------------------------------------------------------------

def test_is_production_flag():
    assert is_production({"PHI_ENV": "production"})
    assert is_production({"PHI_ENV": "Production"})
    assert not is_production({"PHI_ENV": "development"})
    assert not is_production({})


def test_prod_missing_secret_key_fails():
    """CR-9: 本番で PHI_SECRET_KEY 未設定 → ConfigError(揮発鍵禁止)。"""
    env = {
        "PHI_ENV": "production",
        "PHI_ALLOWED_ORIGINS": "https://phi.example",
    }
    with pytest.raises(ConfigError):
        Config.from_env(env)


def test_prod_missing_allowed_origins_ok():
    """A-33: cookie 廃止で CSRF 撤去 → 本番でも PHI_ALLOWED_ORIGINS 未設定で起動可。"""
    from app.auth import UidCipher
    env = {
        "PHI_ENV": "production",
        "PHI_SECRET_KEY": UidCipher.generate_key().decode(),
    }
    cfg = Config.from_env(env)
    assert cfg.production is True
    assert cfg.allowed_origins is None


def test_prod_full_config_ok():
    """本番でも両方設定済なら起動可・production=True。"""
    from app.auth import UidCipher
    env = {
        "PHI_ENV": "production",
        "PHI_SECRET_KEY": UidCipher.generate_key().decode(),
        "PHI_ALLOWED_ORIGINS": "https://phi.example",
    }
    cfg = Config.from_env(env)
    assert cfg.production is True
    assert cfg.secret_key_ephemeral is False
    assert cfg.allowed_origins == {"https://phi.example"}


# ----------------------------------------------------------------------
# TestClient(実サーバ非接続: session.open しない)
# ----------------------------------------------------------------------

@pytest.fixture()
def client(tmp_path):
    from app.auth import UidCipher
    cfg = Config(
        db_path=":memory:",
        secret_key=UidCipher.generate_key(),
        allowed_origins=None,
        assets_dir=str(tmp_path / "assets"),  # 無し → /assets マウントスキップ
        legacy_host="",
        legacy_port=0,
        secret_key_ephemeral=False,
    )
    app = build_app(cfg)
    return TestClient(app)


def test_healthz_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["sessions"] == 0  # レガシー非接続


def test_protected_rest_requires_auth(client):
    """未認証(cookie 無し)で保護 REST は 401。"""
    # chara index 更新(要認証 + 変更系)。
    r = client.put("/api/chara/index/foo", json={"graName": "bar"})
    assert r.status_code == 401


def test_login_invalid_credentials(client):
    # A-34: 未登録アカウントの login は 401。
    r = client.post("/api/auth/login",
                    json={"accountId": "nobody", "password": "password1"})
    assert r.status_code == 401


def test_assets_mount_when_dir_exists(tmp_path):
    """assets ディレクトリありなら /assets が配信される。"""
    from app.auth import UidCipher
    adir = tmp_path / "assets"
    adir.mkdir()
    (adir / "hello.txt").write_text("hi", encoding="utf-8")
    cfg = Config(
        db_path=":memory:",
        secret_key=UidCipher.generate_key(),
        allowed_origins=None,
        assets_dir=str(adir),
        legacy_host="",
        legacy_port=0,
        secret_key_ephemeral=False,
    )
    client = TestClient(build_app(cfg))
    r = client.get("/assets/hello.txt")
    assert r.status_code == 200
    assert r.text == "hi"


def test_ws_route_handshake_real_asgi():
    """回帰: 実ASGI WebSocketルートでハンドシェイクが成立し hello を受信。

    `from __future__ import annotations` 下で `websocket: WebSocket` 注釈が
    モジュールレベル未importだと FastAPI がクエリ扱いし 1008 で全WSを拒否する
    (Fake ws のユニットテストでは迂回され検出できなかった)。本テストは実ルート
    経由(TestClient.websocket_connect)で接続を検証し再発を防ぐ。
    """
    import os
    os.environ["PHI_ENV"] = "development"
    from starlette.testclient import TestClient
    from app.main import build_app

    with TestClient(build_app()).websocket_connect("/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        assert hello["protocolVersion"] == 1
