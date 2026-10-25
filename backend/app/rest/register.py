"""B15 REST 登録 API([12]§2.3)。

`/api/register/*` ルータ。

| メソッド | パス | 説明 |
|----------|------|------|
| `GET`  | `/api/register/graphics?host=&port=` | 初期グラ一覧(`#ex-get REGINFO IMG`) |
| `POST` | `/api/register` | `{host, port, name, pass?(6), imageIndex, mail?}` → 代行 → characters 登録 |

- 代行は `LegacyRegistrar`(登録先 host:port への一時レガシー接続)。
- どちらも要認証。host:port は利用者が選ぶ為、未認証で任意の宛先へ接続させない。
- 成功で uid 組立/捕捉 → `UidCipher` 暗号化 → `Store.create_character`
  (A-34: account_id 配下のキャラとして phi_uid_enc 保存)。
- レート制限: `POST /api/register` 5/h/IP(`RateLimiter`)→ 超過 429。
"""
from __future__ import annotations

import logging
import os
import secrets
import string
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request

from app.register import (
    PASS_LEN,
    LegacyRegistrar,
    RegisterReject,
    RegisterTransport,
    validate_register_input,
)
from app.rest.characters import _coerce_host, _coerce_port
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


def _random_pass() -> str:
    """6字の英数字。uid に埋まるので空白・記号は使わない。"""
    chars = string.ascii_letters + string.digits
    return "".join(secrets.choice(chars) for _ in range(PASS_LEN))


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

    registrar_factory: (host, port) -> LegacyRegistrar(テストはモック socket 注入済を返す)。
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

    def _target(host, port) -> tuple[str, int]:
        try:
            h, p = _coerce_host(host), _coerce_port(port)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if h is None or p is None:
            raise HTTPException(400, "host と port は必須")
        return h, p

    @router.get("/graphics")
    async def get_graphics(
        host: str = "",
        port: str = "",
        _account_id: str | None = Depends(account_dep),
    ) -> dict:
        registrar: LegacyRegistrar = registrar_factory(*_target(host, port))
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

        host, port = _target(body.get("host"), body.get("port"))
        name = str(body.get("name", ""))
        # 省略時は BE が決める。uid は暗号化して保存するので利用者は覚えなくてよい。
        password = str(body.get("pass", "") or "") or _random_pass()
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

        registrar: LegacyRegistrar = registrar_factory(host, port)
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
        if not result.uid:
            raise HTTPException(502, "登録代行失敗: uid を受け取れなかった")
        uid_enc = cipher.encrypt(result.uid)
        try:
            store.create_character(
                char_id,
                account_id or "",
                label=result.name,
                phi_uid_enc=uid_enc,
                host=host,
                port=port,
            )
        except Exception as exc:  # noqa: BLE001 - FK 等
            # L-4: 内部例外文字列はレスポンスに載せず、詳細はサーバログのみ。
            logger.exception("キャラ登録の永続化失敗 char_id=%s", char_id)
            raise HTTPException(500, "内部エラー") from exc

        return {"charId": char_id, "name": result.name}

    return router
