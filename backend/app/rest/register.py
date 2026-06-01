"""B15 REST 登録 API([12]§2.3)。

`/api/register/*` ルータ。

| メソッド | パス | 説明 |
|----------|------|------|
| `GET`  | `/api/register/graphics` | 初期グラ一覧(`#ex-get REGINFO IMG`, キャッシュ) |
| `POST` | `/api/register`          | `{name, pass(6), imageIndex, mail?}` → 代行 → characters 登録 |

- 代行は `LegacyRegistrar`(一時レガシー接続)。⛔ モックTCPのみ検証([タスク])。
- 成功で uid 組立/捕捉 → `UidCipher` 暗号化 → `Store.upsert_character`。
- レート制限: `POST /api/register` 5/h/IP(`RateLimiter`)→ 超過 429。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request

from app.register import (
    LegacyRegistrar,
    RegisterReject,
    RegisterTransport,
    validate_register_input,
)
from app.store.db import Store


def _client_ip(request: Request) -> str:
    """クライアント IP(プロキシ前提で X-Forwarded-For 先頭 → fallback peer)。"""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


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

        # 事前ローカル検証([12]§2.1)。
        bad = validate_register_input(name, password, image_index)
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
        char_id = uuid.uuid4().hex[:12]
        # uid 捕捉時のみ暗号化保存(Q-R5-1: 無通知時 None)。
        uid_enc = cipher.encrypt(result.uid) if result.uid else None
        try:
            store.upsert_character(
                char_id,
                account_id or "",
                display_name=result.name,
                legacy_uid_enc=uid_enc,
            )
        except Exception as exc:  # noqa: BLE001 - FK 等
            raise HTTPException(500, f"キャラ登録の永続化失敗: {exc}") from exc

        return {"charId": char_id, "name": result.name}

    return router
