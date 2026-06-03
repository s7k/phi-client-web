"""管理者ユーザ管理 REST API([08]§10 / 管理画面)。

`/api/admin/*` ルータ。アカウント一覧・管理者権限の付与/剥奪・パスワード強制変更・
削除を提供する。全エンドポイントは管理者限定(require_admin)。

安全弁(ロックアウト防止)
------------------------------------------------------------------
- 自分自身の管理者剥奪/削除は拒否(400)。
- 最後の管理者の剥奪/削除は拒否(400)。

ファクトリ `build_admin_router(store, auth, require_admin)`。
- auth: AuthService(hash_password / PASSWORD_MIN_LEN 利用)。
- require_admin: 認証依存(成功で acting admin の account_id)。未認証401・非管理者403。

注: password / password_hash は応答・ログに出さない(資格情報)。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.auth import PASSWORD_MIN_LEN, AuthService
from app.store.db import Store


def _account_public(row, store: Store) -> dict:
    """アカウント行 → 公開 dict(password_hash 非公開)。"""
    account_id = row["account_id"]
    char_count = len(store.list_characters(account_id))
    return {
        "accountId": account_id,
        "isAdmin": bool(row["is_admin"]),
        "createdAt": row["created_at"],
        "charCount": char_count,
    }


def build_admin_router(store: Store, auth: AuthService, require_admin) -> APIRouter:
    """`/api/admin` ルータを構築。"""
    router = APIRouter(prefix="/api/admin")

    def _require_existing(account_id: str):
        row = store.get_account(account_id)
        if row is None:
            raise HTTPException(404, "アカウントが見つかりません")
        return row

    @router.get("/accounts")
    async def list_accounts(_admin: str = Depends(require_admin)) -> dict:
        rows = store.list_accounts()
        return {"accounts": [_account_public(r, store) for r in rows]}

    @router.post("/accounts/{account_id}/admin")
    async def set_admin(
        account_id: str, body: dict,
        acting: str = Depends(require_admin),
    ) -> dict:
        """管理者権限の付与/剥奪。body `{value: bool}`。"""
        row = _require_existing(account_id)
        value = bool(body.get("value"))
        # 剥奪時の安全弁: 自分自身 / 最後の管理者を保護。
        if not value and bool(row["is_admin"]):
            if account_id == acting:
                raise HTTPException(400, "自分自身の管理者権限は剥奪できません")
            if store.count_admins() <= 1:
                raise HTTPException(400, "最後の管理者の権限は剥奪できません")
        store.set_account_admin(account_id, value)
        # 剥奪時は対象セッションを失効(以後の管理操作を即遮断)。
        if not value:
            store.delete_web_sessions_for(account_id)
        return {"accountId": account_id, "isAdmin": value}

    @router.put("/accounts/{account_id}/password")
    async def force_password(
        account_id: str, body: dict,
        _admin: str = Depends(require_admin),
    ) -> dict:
        """パスワード強制変更。body `{password}`。対象の既存セッションは全失効。"""
        _require_existing(account_id)
        password = str(body.get("password", "") or "")
        if len(password) < PASSWORD_MIN_LEN:
            raise HTTPException(400, f"パスワードは{PASSWORD_MIN_LEN}文字以上")
        store.update_password_hash(account_id, auth.hash_password(password))
        store.delete_web_sessions_for(account_id)
        return {"ok": True, "accountId": account_id}

    @router.delete("/accounts/{account_id}")
    async def delete_account(
        account_id: str,
        acting: str = Depends(require_admin),
    ) -> dict:
        """アカウント削除(characters は FK CASCADE)。安全弁あり。"""
        row = _require_existing(account_id)
        if account_id == acting:
            raise HTTPException(400, "自分自身のアカウントは削除できません")
        if bool(row["is_admin"]) and store.count_admins() <= 1:
            raise HTTPException(400, "最後の管理者は削除できません")
        store.delete_web_sessions_for(account_id)
        store.delete_account(account_id)
        return {"ok": True, "deleted": account_id}

    return router
