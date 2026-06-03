"""管理者ユーザ管理 REST テスト([08]§10 / 管理画面)。

一覧/admin付与・剥奪/PW強制変更/削除 + 安全弁(自己/最後の管理者保護)。
require_admin は acting account を返すスタブ。
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.auth import AuthService
from app.rest.admin import build_admin_router
from app.store.db import Store


@pytest.fixture
def env():
    """admin1/admin2(管理者) + user1(一般)を作成したアプリ。

    require_admin は X-Acting ヘッダの account を acting admin として返す
    (実認証は別テスト [test_rest_integration] で検証済)。
    """
    store = Store.open(":memory:")
    auth = AuthService(store)
    auth.register("admin1", "password1", is_admin=True)
    auth.register("admin2", "password1", is_admin=True)
    auth.register("user1", "password1")

    async def require_admin(request: Request) -> str:
        acc = request.headers.get("X-Acting")
        if not acc:
            raise HTTPException(401, "未認証")
        return acc

    app = FastAPI()
    app.include_router(build_admin_router(store, auth, require_admin))
    c = TestClient(app)
    c._store = store  # type: ignore[attr-defined]
    c._authsvc = auth  # type: ignore[attr-defined]
    yield c
    store.close()


HDR = {"X-Acting": "admin1"}


def test_list_accounts(env):
    r = env.get("/api/admin/accounts", headers=HDR)
    assert r.status_code == 200
    accs = {a["accountId"]: a for a in r.json()["accounts"]}
    assert accs["admin1"]["isAdmin"] is True
    assert accs["user1"]["isAdmin"] is False
    # password_hash は応答に含めない
    assert "passwordHash" not in accs["user1"]
    assert "password_hash" not in accs["user1"]


def test_list_requires_admin(env):
    assert env.get("/api/admin/accounts").status_code == 401


def test_grant_and_revoke(env):
    # user1 を管理者化
    r = env.post("/api/admin/accounts/user1/admin", json={"value": True}, headers=HDR)
    assert r.status_code == 200 and r.json()["isAdmin"] is True
    assert env._store.is_account_admin("user1") is True
    # 剥奪
    r = env.post("/api/admin/accounts/user1/admin", json={"value": False}, headers=HDR)
    assert r.status_code == 200 and r.json()["isAdmin"] is False
    assert env._store.is_account_admin("user1") is False


def test_cannot_revoke_self(env):
    r = env.post("/api/admin/accounts/admin1/admin", json={"value": False}, headers=HDR)
    assert r.status_code == 400


def test_cannot_revoke_last_admin(env):
    # admin2 を剥奪 → 残り admin1 のみ。さらに admin2 視点で admin1 を剥奪不可。
    env.post("/api/admin/accounts/admin2/admin", json={"value": False}, headers=HDR)
    r = env.post(
        "/api/admin/accounts/admin1/admin",
        json={"value": False}, headers={"X-Acting": "admin2"},
    )
    assert r.status_code == 400


def test_force_password_change(env):
    r = env.put(
        "/api/admin/accounts/user1/password",
        json={"password": "newpassw0rd"}, headers=HDR,
    )
    assert r.status_code == 200, r.text
    assert env._authsvc.verify_password("user1", "newpassw0rd") is True
    assert env._authsvc.verify_password("user1", "password1") is False


def test_force_password_too_short(env):
    r = env.put(
        "/api/admin/accounts/user1/password",
        json={"password": "short"}, headers=HDR,
    )
    assert r.status_code == 400


def test_force_password_revokes_sessions(env):
    # user1 の Web セッションを作り、強制変更で失効することを確認。
    token = env._authsvc.login("user1", "password1")
    assert token is not None
    env.put(
        "/api/admin/accounts/user1/password",
        json={"password": "newpassw0rd"}, headers=HDR,
    )
    assert env._authsvc.validate(token) is None


def test_delete_account(env):
    r = env.delete("/api/admin/accounts/user1", headers=HDR)
    assert r.status_code == 200
    assert env._store.get_account("user1") is None


def test_cannot_delete_self(env):
    r = env.delete("/api/admin/accounts/admin1", headers=HDR)
    assert r.status_code == 400


def test_cannot_delete_last_admin(env):
    env.post("/api/admin/accounts/admin2/admin", json={"value": False}, headers=HDR)
    # admin2 視点で最後の管理者 admin1 を削除不可。
    r = env.delete("/api/admin/accounts/admin1", headers={"X-Acting": "admin2"})
    assert r.status_code == 400


def test_delete_404(env):
    assert env.delete("/api/admin/accounts/nope", headers=HDR).status_code == 404
