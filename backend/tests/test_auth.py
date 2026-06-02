"""B12 認証(アカウント+複数キャラ, A-34)・uid 暗号・Web セッション テスト。

1アカウント(ログインID + パスワード)の下に複数キャラ。Web 認証は argon2id、
レガシー資格(PHI uid)はキャラ単位で暗号保存する。
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.auth import PASSWORD_MIN_LEN, AuthService, SessionIdentity, UidCipher
from app.store import Store


@pytest.fixture
def store():
    s = Store.open(":memory:")
    yield s
    s.close()


@pytest.fixture
def cipher():
    return UidCipher(UidCipher.generate_key())


@pytest.fixture
def auth(store, cipher):
    return AuthService(store, cipher)


# ----------------------------------------------------------------------
# uid 暗号往復
# ----------------------------------------------------------------------

def test_uid_roundtrip(cipher):
    token = cipher.encrypt("ABC123secret")
    assert isinstance(token, bytes)
    assert token != b"ABC123secret"
    assert cipher.decrypt(token) == "ABC123secret"


def test_uid_wrong_key_fails(cipher):
    token = cipher.encrypt("uid")
    other = UidCipher(UidCipher.generate_key())
    with pytest.raises(ValueError):
        other.decrypt(token)


def test_uid_tamper_fails(cipher):
    token = bytearray(cipher.encrypt("uid"))
    token[-1] ^= 0x01
    with pytest.raises(ValueError):
        cipher.decrypt(bytes(token))


# ----------------------------------------------------------------------
# アカウント登録 / パスワード検証
# ----------------------------------------------------------------------

def test_register_creates_account_with_hash(auth, store):
    auth.register("wilt", "password1")
    row = store.get_account("wilt")
    assert row is not None
    # パスワードは平文保存しない(argon2id ハッシュ)。
    assert row["password_hash"] != "password1"
    assert row["password_hash"].startswith("$argon2")


def test_register_rejects_short_password(auth):
    with pytest.raises(ValueError):
        auth.register("wilt", "short")  # PASSWORD_MIN_LEN 未満


def test_register_rejects_empty_account(auth):
    with pytest.raises(ValueError):
        auth.register("", "password1")


def test_register_duplicate_raises(auth):
    auth.register("wilt", "password1")
    with pytest.raises(ValueError) as ei:
        auth.register("wilt", "password2")
    assert str(ei.value) == "account exists"


def test_verify_password(auth):
    auth.register("wilt", "password1")
    assert auth.verify_password("wilt", "password1") is True
    assert auth.verify_password("wilt", "wrong") is False
    assert auth.verify_password("nobody", "password1") is False


def test_password_min_len_is_8():
    assert PASSWORD_MIN_LEN == 8


def test_is_admin_reflects_account_flag(auth, store):
    auth.register("wilt", "password1")
    assert auth.is_admin("wilt") is False
    store.set_account_admin("wilt", True)
    assert auth.is_admin("wilt") is True


# ----------------------------------------------------------------------
# ログイン(token 発行)/失効/期限
# ----------------------------------------------------------------------

def test_login_and_validate(auth):
    auth.register("wilt", "password1")
    token = auth.login("wilt", "password1")
    assert isinstance(token, str) and token
    ident = auth.validate(token)
    assert isinstance(ident, SessionIdentity)
    assert ident.account_id == "wilt"


def test_login_wrong_password_returns_none(auth):
    auth.register("wilt", "password1")
    assert auth.login("wilt", "wrong") is None
    assert auth.login("nobody", "password1") is None


def test_validate_account_helper(auth):
    auth.register("wilt", "password1")
    token = auth.login("wilt", "password1")
    assert auth.validate_account(token) == "wilt"


def test_logout_revokes(auth):
    auth.register("wilt", "password1")
    token = auth.login("wilt", "password1")
    auth.logout(token)
    assert auth.validate(token) is None


def test_validate_unknown(auth):
    assert auth.validate("no-such-token") is None
    assert auth.validate_account("no-such-token") is None


def _token(auth, now=None):
    auth.register("wilt", "password1")
    return auth.login("wilt", "password1", now=now)


def test_idle_expiry(auth):
    t0 = datetime(2026, 6, 1, tzinfo=timezone.utc)
    token = _token(auth, now=t0)
    t1 = t0 + timedelta(minutes=29)
    assert auth.validate(token, now=t1) is not None
    t2 = t1 + timedelta(minutes=31)
    assert auth.validate(token, now=t2) is None


def test_idle_sliding_window(auth):
    t0 = datetime(2026, 6, 1, tzinfo=timezone.utc)
    token = _token(auth, now=t0)
    for i in range(1, 6):
        t = t0 + timedelta(minutes=25 * i)
        assert auth.validate(token, now=t) is not None


def test_absolute_expiry(auth):
    t0 = datetime(2026, 6, 1, tzinfo=timezone.utc)
    token = _token(auth, now=t0)
    for i in range(1, 72):  # 20分 x 71 = 23h40m < 24h
        t = t0 + timedelta(minutes=20 * i)
        assert auth.validate(token, now=t) is not None
    t_over = t0 + timedelta(hours=24, minutes=1)
    assert auth.validate(token, now=t_over) is None


# ----------------------------------------------------------------------
# レガシー資格(PHI uid)はキャラ単位で暗号保存
# ----------------------------------------------------------------------

def test_uid_storage_via_character(store, cipher):
    store.create_account("owner", "h")
    enc = cipher.encrypt("addw|sid|pass")
    store.create_character("c1", "owner", phi_uid_enc=enc, host="game1", port=1)
    row = store.get_character("c1")
    assert cipher.decrypt(row["phi_uid_enc"]) == "addw|sid|pass"
