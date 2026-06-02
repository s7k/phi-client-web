"""CSRF 対策([12]§1.3 / §7.3)。

cookie セッション方式のため REST 変更系(POST/PUT/DELETE)に CSRF 対策を必須化。
方式: **Origin/Referer ヘッダ検査**(SameSite=Strict cookie と併用)。

- 状態変更リクエストの `Origin`(無ければ `Referer`)の origin 部が
  許可 origin 群に一致しなければ拒否(403)。
- 許可 origin は env `PHI_ALLOWED_ORIGINS`(カンマ区切り)。未設定時は
  検査スキップ(開発/同一オリジン運用。本番は必ず設定)。
- GET/HEAD/OPTIONS は安全メソッドとして検査対象外。

double-submit トークン方式も選択肢だが([12]§1.3)、本実装は cookie が
SameSite=Strict + httpOnly のため Origin 検査で十分([12]§7.3 Origin検査)。
"""
from __future__ import annotations

import os
from urllib.parse import urlsplit

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})


def _origin_of(url: str) -> str | None:
    """URL → `scheme://host[:port]`(origin)。解析不能は None。"""
    if not url:
        return None
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}"


def load_allowed_origins() -> set[str] | None:
    """env `PHI_ALLOWED_ORIGINS`(カンマ区切り)→ set。未設定は None(検査無効)。"""
    raw = os.environ.get("PHI_ALLOWED_ORIGINS")
    if not raw:
        return None
    return {o.strip() for o in raw.split(",") if o.strip()}


def is_origin_allowed(
    method: str,
    origin_header: str | None,
    referer_header: str | None,
    allowed: set[str] | None,
    *,
    fail_closed: bool = False,
) -> bool:
    """CSRF 判定。許可 → True / 拒否 → False。

    - 安全メソッド → 常に許可。
    - allowed=None(未設定):
        - fail_closed=False(開発)→ 検査スキップで許可(従来挙動)。
        - fail_closed=True(本番, CR-8)→ 変更系を全拒否(fail-closed)。
    - Origin(無ければ Referer)の origin が allowed に含まれれば許可。
    - どちらも無い変更系 → 拒否。

    本番では起動時に `Config.from_env` が未設定を `ConfigError` で弾くため
    通常 allowed=None には到達しないが、多層防御として本フラグでも拒否する。
    """
    if method.upper() in SAFE_METHODS:
        return True
    if allowed is None:
        return not fail_closed
    src = origin_header or referer_header
    origin = _origin_of(src) if src else None
    if origin is None:
        return False
    return origin in allowed


class CsrfOriginMiddleware:
    """CSRF Origin 検査の**純 ASGI ミドルウェア**。

    重要: Starlette の `BaseHTTPMiddleware`(`@app.middleware("http")`)は
    **WebSocket を壊す**(ハンドシェイクが 403 で拒否される既知問題)。
    本ミドルウェアは `scope["type"] == "http"` のみ検査し、websocket /
    lifespan は素通しするため WS が正常に確立できる。
    """

    def __init__(self, app, allowed: set[str] | None, *, production: bool = False):
        self.app = app
        self.allowed = allowed
        self.production = production

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            # websocket / lifespan はそのまま通す(WS認証は接続後にcookieで実施)。
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1")
                   for k, v in scope.get("headers", [])}
        method = scope.get("method", "GET")
        if not is_origin_allowed(
            method, headers.get("origin"), headers.get("referer"),
            self.allowed, fail_closed=self.production,
        ):
            from starlette.responses import PlainTextResponse
            await PlainTextResponse("CSRF: origin 不許可", status_code=403)(
                scope, receive, send
            )
            return
        await self.app(scope, receive, send)
