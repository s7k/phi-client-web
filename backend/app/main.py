"""B-final アプリ起動エントリ([12]§7)。

env(`app.config.Config`)から設定を読み、依存(Store/AuthService/
SessionManager)を構築して `create_app(...)` で ASGI app を組み立てる。

起動
------------------------------------------------------------------
    uvicorn app.main:app

本番では `PHI_SECRET_KEY` を必ず設定し、TLS 終端(wss/https)経由で公開する
(詳細 README)。A-33: cookie 廃止で CSRF 撤去 → `PHI_ALLOWED_ORIGINS` は不要。

注意: SessionManager は遅延接続(session.open 時のみレガシーへ TCP)。
import 時/起動時に実サーバへは接続しない(DEVLOG §0)。
"""
from __future__ import annotations

import logging
import os

from app.auth import AuthService, UidCipher
from app.config import Config
from app.register import LegacyRegistrar
from app.session import SessionManager
from app.store import Store
from app.ws_server import create_app

logger = logging.getLogger("app.main")


def build_app(config: Config | None = None):
    """Config から ASGI app を構築。

    config 省略時は `Config.from_env()`。テストは個別 Config を渡せる。
    """
    cfg = config or Config.from_env()

    # Store: migrate 実行済(Store.open 内で適用)。
    store = Store.open(cfg.db_path)

    # 認証/uid 暗号: 鍵は config 経由(env 未設定なら一時鍵)。
    cipher = UidCipher(cfg.secret_key)
    auth = AuthService(store, cipher)

    # SessionManager: 遅延接続。既定レガシー接続先のみ保持。
    manager = SessionManager(
        host=cfg.legacy_host,
        port=cfg.legacy_port,
        store=store,
    )

    def registrar_factory():
        return LegacyRegistrar(cfg.legacy_host, cfg.legacy_port)

    app = create_app(
        manager=manager,
        auth=auth,
        assets_dir=cfg.assets_dir,
        registrar_factory=registrar_factory,
        allowed_origins=cfg.allowed_origins,
        production=cfg.production,
    )
    app.state.config = cfg

    _mount_assets(app, cfg.assets_dir)

    # A-33: cookie 廃止で CSRF(Origin 検査)撤去 → allowed_origins 警告は不要。
    return app


def _mount_assets(app, assets_dir: str) -> None:
    """`/assets` を StaticFiles で配信(ディレクトリ無ければ握り潰し)。"""
    if not os.path.isdir(assets_dir):
        logger.warning("assets ディレクトリ無し(%s) → /assets 配信スキップ", assets_dir)
        return
    from fastapi.staticfiles import StaticFiles
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


# uvicorn ターゲット(`uvicorn app.main:app`)。
app = build_app()
