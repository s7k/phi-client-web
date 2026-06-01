"""B-final アプリ設定の一元化([12]§7)。

env から起動時設定を読み出し `Config` dataclass に集約する。
個別モジュール側の env 参照(`PHI_DB_PATH`/`PHI_SECRET_KEY` 等)は後方互換で残すが、
本番起動(`app.main`)はここを単一の入口とする。

env 一覧
------------------------------------------------------------------
- `PHI_DB_PATH`         : SQLite パス。未設定なら `:memory:`(揮発)。
- `PHI_SECRET_KEY`      : uid 暗号鍵(Fernet, urlsafe-base64 32B)。未設定時は
                          開発用に一時鍵を生成し警告(再起動で復号不能)。
- `PHI_ALLOWED_ORIGINS` : CSRF 許可 origin(カンマ区切り)。未設定は検査無効(開発用)。
- `PHI_ASSETS_DIR`      : キャラグラ保存/配信ディレクトリ。既定 `./assets`。
- `PHI_HOST`/`PHI_PORT` : レガシー既定接続先(session.open/register の既定)。
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

logger = logging.getLogger("app.config")

DEFAULT_ASSETS_DIR = "./assets"


@dataclass(frozen=True)
class Config:
    """起動時設定(env スナップショット)。"""

    db_path: str | None
    secret_key: bytes
    allowed_origins: set[str] | None
    assets_dir: str
    legacy_host: str
    legacy_port: int
    # secret_key が env 未設定で一時生成されたか(本番では False 必須)。
    secret_key_ephemeral: bool

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        """env(既定 `os.environ`)から Config を構築。"""
        env = os.environ if env is None else env

        secret_raw = env.get("PHI_SECRET_KEY")
        if secret_raw:
            secret_key = secret_raw.encode("utf-8")
            ephemeral = False
        else:
            # 開発用フォールバック: 一時鍵生成(永続化されない)。
            from app.auth import UidCipher
            secret_key = UidCipher.generate_key()
            ephemeral = True
            logger.warning(
                "PHI_SECRET_KEY 未設定 → 開発用一時鍵生成。"
                "再起動で legacy_uid 復号不能。本番では必ず設定すること。"
            )

        allowed_raw = env.get("PHI_ALLOWED_ORIGINS")
        if allowed_raw:
            allowed = {o.strip() for o in allowed_raw.split(",") if o.strip()}
        else:
            allowed = None

        return cls(
            db_path=env.get("PHI_DB_PATH") or None,
            secret_key=secret_key,
            allowed_origins=allowed,
            assets_dir=env.get("PHI_ASSETS_DIR") or DEFAULT_ASSETS_DIR,
            legacy_host=env.get("PHI_HOST", ""),
            legacy_port=int(env.get("PHI_PORT", "0") or 0),
            secret_key_ephemeral=ephemeral,
        )
