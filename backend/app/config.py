"""B-final アプリ設定の一元化([12]§7)。

env から起動時設定を読み出し `Config` dataclass に集約する。
個別モジュール側の env 参照(`PHI_DB_PATH`/`PHI_SECRET_KEY` 等)は後方互換で残すが、
本番起動(`app.main`)はここを単一の入口とする。

env 一覧
------------------------------------------------------------------
- `PHI_ENV`             : `production` で本番モード。未設定/`development` は開発。
- `PHI_DB_PATH`         : SQLite パス。未設定なら `:memory:`(揮発)。
- `PHI_SECRET_KEY`      : uid 暗号鍵(Fernet, urlsafe-base64 32B)。未設定時は
                          開発用に一時鍵を生成し警告(再起動で復号不能)。
                          **本番(CR-9)では未設定=起動失敗**(揮発鍵禁止)。
- `PHI_ALLOWED_ORIGINS` : CSRF 許可 origin(カンマ区切り)。未設定は開発のみ
                          検査無効+警告。**本番(CR-8)では未設定=起動失敗**。
- `PHI_ASSETS_DIR`      : キャラグラ保存/配信ディレクトリ。既定 `./assets`。
- `PHI_HOST`/`PHI_PORT` : レガシー既定接続先(session.open/register の既定)。

本番判定(CR-8/CR-9)
------------------------------------------------------------------
`PHI_ENV=production` を本番の明示フラグとする。本番では fail-open を禁止し、
秘密鍵/CSRF 許可 origin の未設定を起動失敗(`ConfigError`)で弾く。
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

logger = logging.getLogger("app.config")

DEFAULT_ASSETS_DIR = "./assets"


class ConfigError(RuntimeError):
    """本番設定不備で起動を拒否する例外(CR-8/CR-9 fail-closed)。"""


def is_production(env: dict[str, str]) -> bool:
    """本番モード判定。`PHI_ENV=production`(大小無視)を本番とする。"""
    return env.get("PHI_ENV", "").strip().lower() == "production"


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
    # 本番モード(CR-8/CR-9: fail-closed の判定に使用)。
    production: bool = False

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        """env(既定 `os.environ`)から Config を構築。

        本番(`PHI_ENV=production`)では fail-open を禁止(CR-8/CR-9):
        - `PHI_SECRET_KEY` 未設定 → `ConfigError`(揮発鍵は開発のみ)。
        - `PHI_ALLOWED_ORIGINS` 未設定 → `ConfigError`(CSRF 検査必須)。
        """
        env = os.environ if env is None else env
        production = is_production(env)

        secret_raw = env.get("PHI_SECRET_KEY")
        if secret_raw:
            secret_key = secret_raw.encode("utf-8")
            ephemeral = False
        elif production:
            # CR-9: 本番で揮発鍵フォールバック禁止 → 起動失敗。
            raise ConfigError(
                "PHI_SECRET_KEY 未設定(本番)。揮発鍵は再起動で legacy_uid "
                "復号不能のため本番では禁止。Fernet.generate_key() で生成し設定すること。"
            )
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
        elif production:
            # CR-8: 本番で CSRF 許可 origin 未設定 = fail-open 禁止 → 起動失敗。
            raise ConfigError(
                "PHI_ALLOWED_ORIGINS 未設定(本番)。CSRF origin 検査が無効化され "
                "fail-open になるため本番では禁止。許可 origin をカンマ区切りで設定すること。"
            )
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
            production=production,
        )
