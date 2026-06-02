"""A-34 REST キャラ CRUD API([12]§1)。

`/api/characters` ルータ。アカウント配下の複数キャラ(label + PHI uid + host/port)を
登録/一覧/更新/削除する。すべて要認証(Bearer)で、所有検証を行う。

契約
------------------------------------------------------------------
| メソッド | パス | body | 応答 |
|----------|------|------|------|
| GET    | /api/characters            | —                          | {characters:[{charId,label,host,port}]} |
| POST   | /api/characters            | {label,phiId,host,port}    | {charId,label,host,port} |
| PUT    | /api/characters/{charId}   | {label?,phiId?,host?,port?}| {charId,label,host,port} |
| DELETE | /api/characters/{charId}   | —                          | {ok:true} |

- PHI uid(phiId)は資格情報。応答に含めず、phi_uid_enc として暗号保存する。
- port は 1-65535 を検証(範囲外/非数値は 400)。
- 所有検証: token の account 以外の char へのアクセスは 404(存在秘匿)。

ファクトリ `build_characters_router(store, cipher, require_account)` を提供。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.store.db import Store


def _coerce_port(value) -> int | None:
    """port を int 検証。None/空 → None。範囲外/非数値 → ValueError。"""
    if value is None or value == "":
        return None
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("port が不正(整数で指定)") from exc
    if not (1 <= port <= 65535):
        raise ValueError("port が範囲外(1-65535)")
    return port


def _coerce_host(value) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _char_public(row) -> dict:
    """キャラ行 → 公開 dict(uid 非公開)。"""
    return {
        "charId": row["char_id"],
        "label": row["label"],
        "host": row["host"],
        "port": row["port"],
    }


def build_characters_router(store: Store, cipher, require_account) -> APIRouter:
    """`/api/characters` ルータを構築。

    cipher: UidCipher(phiId 暗号化)。
    require_account: 認証依存(成功で account_id)。未認証は 401。
    """
    router = APIRouter(prefix="/api/characters")

    def _owned_or_404(char_id: str, account_id: str):
        row = store.get_character(char_id)
        if row is None or row["account_id"] != account_id:
            raise HTTPException(404, "キャラが見つかりません")
        return row

    @router.get("")
    async def list_chars(account_id: str = Depends(require_account)) -> dict:
        rows = store.list_characters(account_id)
        return {"characters": [_char_public(r) for r in rows]}

    @router.post("")
    async def create_char(
        body: dict, account_id: str = Depends(require_account)
    ) -> dict:
        label = body.get("label")
        phi_id = str(body.get("phiId", "") or "")
        if not phi_id:
            raise HTTPException(400, "phiId が必要")
        try:
            host = _coerce_host(body.get("host"))
            port = _coerce_port(body.get("port"))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

        char_id = uuid.uuid4().hex
        store.create_character(
            char_id, account_id,
            label=label, phi_uid_enc=cipher.encrypt(phi_id),
            host=host, port=port,
        )
        return _char_public(store.get_character(char_id))

    @router.put("/{char_id}")
    async def update_char(
        char_id: str, body: dict,
        account_id: str = Depends(require_account),
    ) -> dict:
        _owned_or_404(char_id, account_id)
        try:
            host = _coerce_host(body.get("host")) if "host" in body else None
            port = _coerce_port(body.get("port")) if "port" in body else None
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        phi_id = body.get("phiId")
        enc = cipher.encrypt(str(phi_id)) if phi_id else None
        store.update_character(
            char_id,
            label=body.get("label"), phi_uid_enc=enc,
            host=host, port=port,
        )
        return _char_public(store.get_character(char_id))

    @router.delete("/{char_id}")
    async def delete_char(
        char_id: str, account_id: str = Depends(require_account)
    ) -> dict:
        _owned_or_404(char_id, account_id)
        store.delete_character(char_id)
        return {"ok": True}

    return router
