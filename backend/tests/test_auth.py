"""B12 認証・uid暗号・Webセッション テスト([12]§1)。"""
from datetime import datetime, timedelta, timezone

import pytest

from app.auth import (
    AuthService,
    UidCipher,
    hash_password,
    verify_password,
)
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
# パスワードハッシュ
# ----------------------------------------------------------------------

def test_hash_verify():
    h = hash_password("s3cret")
    assert h.startswith("$argon2id$")  # argon2id 形式
    assert verify_password("s3cret", h)
    assert not verify_password("wrong", h)


def test_hash_salt_unique():
    # salt ランダム → 同一パスワードでも別ハッシュ
    assert hash_password("x") != hash_password("x")


def test_verify_malformed():
    assert not verify_password("x", "garbage")
    assert not verify_password("x", "bcrypt$1$a$b")  # 未対応方式


def test_verify_legacy_pbkdf2():
    """旧 PBKDF2 ハッシュも verify 可(移行互換)。"""
    import hashlib
    salt = bytes.fromhex("00112233445566778899aabbccddeeff")
    rounds = 600_000
    dk = hashlib.pbkdf2_hmac("sha256", b"legacy", salt, rounds)
    stored = f"pbkdf2${rounds}${salt.hex()}${dk.hex()}"
    assert verify_password("legacy", stored)
    assert not verify_password("wrong", stored)


def test_needs_rehash():
    from app.auth import needs_rehash
    assert needs_rehash("pbkdf2$1$aa$bb") is True   # 旧方式
    assert needs_rehash("garbage") is True
    assert needs_rehash(hash_password("x")) is False  # 最新 argon2id


def test_authenticate_rehashes_legacy(store):
    """旧 pbkdf2 ハッシュで login 成功時 argon2id へ透過アップグレード。"""
    import hashlib
    salt = bytes.fromhex("0102030405060708090a0b0c0d0e0f00")
    rounds = 600_000
    dk = hashlib.pbkdf2_hmac("sha256", b"pw", salt, rounds)
    legacy = f"pbkdf2${rounds}${salt.hex()}${dk.hex()}"
    store.create_account("acc", legacy)
    auth = AuthService(store)
    assert auth.authenticate("acc", "pw")
    # 再ハッシュ済(argon2id)
    assert store.get_account("acc")["password_hash"].startswith("$argon2id$")
    # 新ハッシュでも引き続き検証可
    assert auth.authenticate("acc", "pw")


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
# セッション発行/失効/期限
# ----------------------------------------------------------------------

def test_login_success_and_validate(auth):
    auth.register_account("alice", "pw")
    sid = auth.login("alice", "pw")
    assert sid
    assert auth.validate(sid) == "alice"


def test_login_wrong_password(auth):
    auth.register_account("alice", "pw")
    assert auth.login("alice", "bad") is None
    assert auth.login("nobody", "pw") is None


def test_logout_revokes(auth):
    auth.register_account("alice", "pw")
    sid = auth.login("alice", "pw")
    auth.logout(sid)
    assert auth.validate(sid) is None


def test_validate_unknown(auth):
    assert auth.validate("no-such-session") is None


def test_is_admin_reflects_db_flag(auth):
    auth.register_account("alice", "pw")
    assert auth.is_admin("alice") is False
    auth.store.set_admin("alice", True)
    assert auth.is_admin("alice") is True


def test_idle_expiry(auth):
    auth.register_account("alice", "pw")
    t0 = datetime(2026, 6, 1, tzinfo=timezone.utc)
    sid = auth.login("alice", "pw", now=t0)
    # idle 内
    t1 = t0 + timedelta(minutes=29)
    assert auth.validate(sid, now=t1) == "alice"
    # 直前の validate で last_seen=t1。そこから idle 超過
    t2 = t1 + timedelta(minutes=31)
    assert auth.validate(sid, now=t2) is None


def test_idle_sliding_window(auth):
    auth.register_account("alice", "pw")
    t0 = datetime(2026, 6, 1, tzinfo=timezone.utc)
    sid = auth.login("alice", "pw", now=t0)
    # 25分ごとにアクセス → idle 30分を超えず維持
    for i in range(1, 6):
        t = t0 + timedelta(minutes=25 * i)
        assert auth.validate(sid, now=t) == "alice"


def test_absolute_expiry(auth):
    auth.register_account("alice", "pw")
    t0 = datetime(2026, 6, 1, tzinfo=timezone.utc)
    sid = auth.login("alice", "pw", now=t0)
    # idle 内で 20分ごとアクセスし last_seen を更新し続けても
    # absolute 24h で失効する(idle では切れない経路を作る)。
    for i in range(1, 72):  # 20分 x 71 = 23h40m < 24h
        t = t0 + timedelta(minutes=20 * i)
        assert auth.validate(sid, now=t) == "alice"
    # 直近アクセス(23h40m)から idle 内だが absolute 超過
    t_over = t0 + timedelta(hours=24, minutes=1)
    assert auth.validate(sid, now=t_over) is None


def test_uid_storage_via_character(store, cipher):
    # 暗号文を characters.legacy_uid_enc に保存し復号往復
    auth = AuthService(store, cipher)
    auth.register_account("alice", "pw")
    enc = cipher.encrypt("addw|sid|pass")
    store.upsert_character("c1", "alice", legacy_uid_enc=enc, legacy_host="game1")
    row = store.get_character("c1")
    assert cipher.decrypt(row["legacy_uid_enc"]) == "addw|sid|pass"
