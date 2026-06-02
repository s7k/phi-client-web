"""B12 認証(ID-only)・ID暗号・Webセッション テスト([12]§1)。

Web パスワードは廃止。入力 ID でセッション確立し、saved_ids へ暗号保存する。
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.auth import AuthService, SessionIdentity, UidCipher
from app.store import Store
from app.store.db import id_key_of


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
# ID 暗号往復
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


def test_id_key_is_sha256_hex():
    import hashlib
    assert id_key_of("ABC") == hashlib.sha256(b"ABC").hexdigest()


# ----------------------------------------------------------------------
# saved_ids(暗号保存 / 管理者フラグ)
# ----------------------------------------------------------------------

def test_remember_id_stores_encrypted(auth, store, cipher):
    key = auth.remember_id("PHI_ID_1", label="メイン")
    assert key == id_key_of("PHI_ID_1")
    row = store.get_saved_id(key)
    assert row is not None
    assert row["label"] == "メイン"
    # 生ID非保持: id_enc は暗号文、復号で復元できる。
    assert row["id_enc"] != b"PHI_ID_1"
    assert cipher.decrypt(row["id_enc"]) == "PHI_ID_1"


def test_is_admin_reflects_saved_flag(auth, store):
    key = auth.remember_id("PHI_ID_1")
    assert auth.is_admin(key) is False
    store.set_saved_admin(key, True)
    assert auth.is_admin(key) is True
    assert store.list_admin_keys() == [key]


def test_upsert_saved_id_preserves_admin(store, cipher):
    key = id_key_of("X")
    store.upsert_saved_id(key, cipher.encrypt("X"), is_admin=True)
    # is_admin=None で再 upsert しても管理者フラグ維持。
    store.upsert_saved_id(key, cipher.encrypt("X"), label="lbl")
    assert store.is_saved_admin(key) is True
    assert store.get_saved_id(key)["label"] == "lbl"


# ----------------------------------------------------------------------
# セッション確立(ID のみ)/失効/期限
# ----------------------------------------------------------------------

def test_establish_and_validate(auth):
    token = auth.establish_session("PHI_ID_1")
    ident = auth.validate(token)
    assert isinstance(ident, SessionIdentity)
    assert ident.id_key == id_key_of("PHI_ID_1")
    # id_enc を復号すると #open 用平文 ID が得られる。
    assert auth.open_id_for(ident) == "PHI_ID_1"


def test_validate_id_key_helper(auth):
    token = auth.establish_session("PHI_ID_1")
    assert auth.validate_id_key(token) == id_key_of("PHI_ID_1")


def test_establish_remember_upserts(auth, store):
    auth.establish_session("PHI_ID_1", remember=True, label="L")
    row = store.get_saved_id(id_key_of("PHI_ID_1"))
    assert row is not None and row["label"] == "L"


def test_establish_no_remember_not_saved(auth, store):
    auth.establish_session("PHI_ID_1")
    assert store.get_saved_id(id_key_of("PHI_ID_1")) is None


def test_logout_revokes(auth):
    token = auth.establish_session("PHI_ID_1")
    auth.logout(token)
    assert auth.validate(token) is None


def test_validate_unknown(auth):
    assert auth.validate("no-such-token") is None
    assert auth.validate_id_key("no-such-token") is None


def test_idle_expiry(auth):
    t0 = datetime(2026, 6, 1, tzinfo=timezone.utc)
    token = auth.establish_session("PHI_ID_1", now=t0)
    t1 = t0 + timedelta(minutes=29)
    assert auth.validate(token, now=t1) is not None
    t2 = t1 + timedelta(minutes=31)
    assert auth.validate(token, now=t2) is None


def test_idle_sliding_window(auth):
    t0 = datetime(2026, 6, 1, tzinfo=timezone.utc)
    token = auth.establish_session("PHI_ID_1", now=t0)
    for i in range(1, 6):
        t = t0 + timedelta(minutes=25 * i)
        assert auth.validate(token, now=t) is not None


def test_absolute_expiry(auth):
    t0 = datetime(2026, 6, 1, tzinfo=timezone.utc)
    token = auth.establish_session("PHI_ID_1", now=t0)
    for i in range(1, 72):  # 20分 x 71 = 23h40m < 24h
        t = t0 + timedelta(minutes=20 * i)
        assert auth.validate(token, now=t) is not None
    t_over = t0 + timedelta(hours=24, minutes=1)
    assert auth.validate(token, now=t_over) is None


def test_uid_storage_via_character(store, cipher):
    # 暗号文を characters.legacy_uid_enc に保存し復号往復(register/world-transfer 用)。
    enc = cipher.encrypt("addw|sid|pass")
    store.upsert_character("c1", "ownerkey", legacy_uid_enc=enc, legacy_host="game1")
    row = store.get_character("c1")
    assert cipher.decrypt(row["legacy_uid_enc"]) == "addw|sid|pass"
