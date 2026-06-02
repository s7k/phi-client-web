"""B15 REST 登録 API([12]§2.3)。

`/api/register/*` ルータ。

| メソッド | パス | 説明 |
|----------|------|------|
| `GET`  | `/api/register/graphics` | 初期グラ一覧(`#ex-get REGINFO IMG`, キャッシュ) |
| `POST` | `/api/register`          | `{name, pass(6), imageIndex, mail?}` → 代行 → characters 登録 |

- 代行は `LegacyRegistrar`(一時レガシー接続)。⛔ モックTCPのみ検証([タスク])。
- 成功で uid 組立/捕捉 → `UidCipher` 暗号化 → `Store.create_character`
  (A-34: account_id 配下のキャラとして phi_uid_enc 保存)。
- レート制限: `POST /api/register` 5/h/IP(`RateLimiter`)→ 超過 429。
"""
from __future__ import annotations

import logging
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request

from app.register import (
    LegacyRegistrar,
    RegisterReject,
    RegisterTransport,
    validate_register_input,
)
from app.store.db import Store

logger = logging.getLogger("app.rest.register")


def _trusted_proxy_hops() -> int:
    """信頼するリバースプロキシ段数(env `PHI_TRUSTED_PROXY_HOPS`, 既定 0)。

    0 = XFF を一切信用せず peer IP(`request.client.host`)のみ使用。
    N = XFF の **右から N+1 番目**(=信頼プロキシ群の手前=実クライアント)を採用。
    """
    try:
        return max(0, int(os.environ.get("PHI_TRUSTED_PROXY_HOPS", "0") or 0))
    except ValueError:
        return 0


def client_ip(request: Request, *, trusted_hops: int | None = None) -> str:
    """レート制限キー用のクライアント IP(CR-10: XFF 詐称耐性)。

    `trusted_hops=0`(既定)では XFF を無視し peer IP のみ使う。逆プロキシ配下で
    運用する場合のみ `PHI_TRUSTED_PROXY_HOPS` に段数を設定し、XFF の右から
    信頼段数分を剥がした先頭(=実クライアント)を採用する。これにより攻撃者が
    付与した左側の偽 XFF をキーに混ぜられない。
    """
    hops = _trusted_proxy_hops() if trusted_hops is None else trusted_hops
    peer = request.client.host if request.client else "unknown"
    if hops <= 0:
        return peer
    xff = request.headers.get("x-forwarded-for")
    if not xff:
        return peer
    parts = [p.strip() for p in xff.split(",") if p.strip()]
    if not parts:
        return peer
    # 右から hops 段(信頼プロキシ)を剥がした手前を実クライアントとする。
    idx = len(parts) - hops - 1
    if idx < 0:
        # 段数が XFF 長を超える(想定外)→ 最左を採用。
        idx = 0
    return parts[idx]


# 後方互換エイリアス。
_client_ip = client_ip


def build_register_router(
    store: Store,
    registrar_factory,
    cipher,
    *,
    require_account=None,
    rate_limiter=None,
) -> APIRouter:
    """`/api/register` ルータを構築。

    registrar_factory: () -> LegacyRegistrar(テストはモック socket 注入済を返す)。
    cipher: UidCipher(uid 暗号化)。
    require_account: 認証依存(成功で account_id)。None なら未認証許可(account_id=None)。
    rate_limiter: RateLimiter(register 5/h/IP)。None なら無制限。
    """
    router = APIRouter(prefix="/api/register")

    if require_account is None:
        async def _acct() -> str | None:
            return None
        account_dep = _acct
    else:
        account_dep = require_account

    @router.get("/graphics")
    async def get_graphics() -> dict:
        registrar: LegacyRegistrar = registrar_factory()
        try:
            graphics = await registrar.fetch_graphics()
        except RegisterTransport as exc:
            raise HTTPException(502, f"初期グラ取得失敗: {exc}") from exc
        # 索引付きで返す(image= に渡す索引と対応)。
        return {"graphics": [{"index": i, "graName": g}
                             for i, g in enumerate(graphics)]}

    @router.post("")
    async def register(
        request: Request,
        body: dict,
        account_id: str | None = Depends(account_dep),
    ) -> dict:
        # レート制限(5/h/IP)。
        if rate_limiter is not None:
            ip = _client_ip(request)
            if not rate_limiter.allow("register", ip):
                raise HTTPException(429, "登録レート超過(5/時/IP)")

        name = str(body.get("name", ""))
        password = str(body.get("pass", ""))
        mail = str(body.get("mail", "") or "")
        try:
            image_index = int(body.get("imageIndex"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "imageIndex が不正") from exc

        # 事前ローカル検証([12]§2.1, CR-13: mail も改行/制御文字検査)。
        bad = validate_register_input(name, password, image_index, mail)
        if bad:
            raise HTTPException(
                400,
                detail={"error": {"code": "REGISTER_REJECT", "fields": bad}},
            )

        registrar: LegacyRegistrar = registrar_factory()
        try:
            result = await registrar.register(name, password, image_index, mail)
        except RegisterReject as exc:
            raise HTTPException(
                400,
                detail={"error": {"code": "REGISTER_REJECT", "fields": exc.fields}},
            ) from exc
        except RegisterTransport as exc:
            raise HTTPException(502, f"登録代行失敗: {exc}") from exc

        # 内部 charId(レガシー char_id とは別の内部識別子)。
        char_id = uuid.uuid4().hex
        # uid 捕捉時のみ暗号化保存(Q-R5-1: 無通知時 None)。
        uid_enc = cipher.encrypt(result.uid) if result.uid else None
        try:
            store.create_character(
                char_id,
                account_id or "",
                label=result.name,
                phi_uid_enc=uid_enc,
            )
        except Exception as exc:  # noqa: BLE001 - FK 等
            # L-4: 内部例外文字列はレスポンスに載せず、詳細はサーバログのみ。
            logger.exception("キャラ登録の永続化失敗 char_id=%s", char_id)
            raise HTTPException(500, "内部エラー") from exc

        return {"charId": char_id, "name": result.name}

    return router
