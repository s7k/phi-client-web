"""B12 認証・レガシー uid 暗号・Web セッション([12]§1)。

2層の認証([12]§1.2)
------------------------------------------------------------------
- Web認証:   ブラウザ→BE。`accounts.password_hash` で検証。
- レガシー資格: BE→レガシーサーバ `#open`。`characters.legacy_uid_enc`(暗号化保存)。

実装方針
------------------------------------------------------------------
- パスワードハッシュ([12]§1.4 argon2id):
    新規ハッシュは `argon2-cffi`(argon2id)。`$argon2id$...` 形式。
    旧 PBKDF2-HMAC-SHA256(`pbkdf2$...`)も verify 可(scheme 分岐, 移行互換)。
- uid 暗号: `cryptography` Fernet(AES128-CBC + HMAC, AEAD相当・タイムスタンプ内蔵)。
    鍵は env `PHI_SECRET_KEY`(urlsafe-base64 32B、Fernet.generate_key() 形式)。
    SQLite には暗号文(BLOB)のみ保存([12]§1.2)。
- Web セッション: 不透明乱数 ID(256bit)。idle 30分 / absolute 24h([12]§1.3)。
    sessions_web へ永続化。検証時に期限判定し、idle 内なら last_seen 更新。

CSRF/cookie 属性([12]§1.3: httpOnly/Secure/SameSite=Strict)は REST 層で付与。
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken

from app.store import Store
from app.store.db import utc_now

# ----------------------------------------------------------------------
# 期限既定([12]§1.3)
# ----------------------------------------------------------------------
IDLE_TIMEOUT_SEC = 30 * 60        # idle 30分
ABSOLUTE_TIMEOUT_SEC = 24 * 3600  # absolute 24h

_PBKDF2_ROUNDS = 600_000  # OWASP 2023 推奨(PBKDF2-HMAC-SHA256, 旧方式 verify 用)
_SESSION_ID_BYTES = 32    # 256bit 不透明 ID

# argon2id ハッシャ(既定パラメータ; argon2-cffi 推奨値)。
_PH = PasswordHasher()


# ======================================================================
# パスワードハッシュ
# ======================================================================

def hash_password(password: str) -> str:
    """パスワード → 保存用ハッシュ文字列(argon2id, `$argon2id$...`)。"""
    return _PH.hash(password)


def _verify_pbkdf2(password: str, stored: str) -> bool:
    """旧 PBKDF2 ハッシュ(`pbkdf2$<rounds>$<salt_hex>$<dk_hex>`)の検証。"""
    try:
        scheme, rounds_s, salt_hex, dk_hex = stored.split("$")
    except ValueError:
        return False
    if scheme != "pbkdf2":
        return False
    rounds = int(rounds_s)
    salt = bytes.fromhex(salt_hex)
    expected = bytes.fromhex(dk_hex)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return hmac.compare_digest(dk, expected)


def verify_password(password: str, stored: str) -> bool:
    """平文パスワードと保存ハッシュを検証。argon2id / 旧 pbkdf2 両対応。"""
    if stored.startswith("$argon2"):
        try:
            return _PH.verify(stored, password)
        except (VerifyMismatchError, InvalidHashError):
            return False
    # 旧 PBKDF2 ハッシュ(移行互換)。
    return _verify_pbkdf2(password, stored)


def needs_rehash(stored: str) -> bool:
    """保存ハッシュが旧方式/旧パラメータで再ハッシュ推奨か判定。"""
    if not stored.startswith("$argon2"):
        return True  # 旧 pbkdf2 → argon2id へ移行推奨
    try:
        return _PH.check_needs_rehash(stored)
    except InvalidHashError:
        return True


# ======================================================================
# レガシー uid 暗号(Fernet)
# ======================================================================

def _load_key() -> bytes:
    """env `PHI_SECRET_KEY`(Fernet 鍵)を取得。未設定なら例外。"""
    key = os.environ.get("PHI_SECRET_KEY")
    if not key:
        raise RuntimeError(
            "PHI_SECRET_KEY 未設定(uid 暗号鍵)。Fernet.generate_key() で生成し env 設定"
        )
    return key.encode("utf-8") if isinstance(key, str) else key


class UidCipher:
    """legacy_uid の AEAD 暗号化/復号([12]§1.2)。"""

    def __init__(self, key: bytes | None = None) -> None:
        self._fernet = Fernet(key or _load_key())

    @staticmethod
    def generate_key() -> bytes:
        """新規鍵生成(urlsafe-base64 32B)。env 設定用。"""
        return Fernet.generate_key()

    def encrypt(self, uid: str) -> bytes:
        """uid(平文) → 暗号文 BLOB。"""
        return self._fernet.encrypt(uid.encode("utf-8"))

    def decrypt(self, token: bytes) -> str:
        """暗号文 BLOB → uid(平文)。改ざん/不正鍵は ValueError。"""
        try:
            return self._fernet.decrypt(token).decode("utf-8")
        except InvalidToken as exc:
            raise ValueError("legacy_uid 復号失敗(鍵不一致/改ざん)") from exc


# ======================================================================
# Web セッション管理(sessions_web)
# ======================================================================

def _parse_iso(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _fmt_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class AuthService:
    """Web 認証・セッション発行/検証([12]§1.3)。

    Store と UidCipher を束ね、login/logout/validate を提供。
    時刻は `now()` で注入可能(テスト容易性)。
    """

    def __init__(
        self,
        store: Store,
        cipher: UidCipher | None = None,
        *,
        idle_sec: int = IDLE_TIMEOUT_SEC,
        absolute_sec: int = ABSOLUTE_TIMEOUT_SEC,
    ) -> None:
        self.store = store
        self._cipher = cipher
        self.idle_sec = idle_sec
        self.absolute_sec = absolute_sec

    @property
    def cipher(self) -> UidCipher:
        if self._cipher is None:
            self._cipher = UidCipher()
        return self._cipher

    # ---- account 登録(便宜) ----

    def register_account(self, account_id: str, password: str) -> None:
        self.store.create_account(account_id, hash_password(password))

    # ---- login ----

    def authenticate(self, account_id: str, password: str) -> bool:
        """id+password を accounts と照合。

        成功時、保存ハッシュが旧方式/旧パラメータなら argon2id へ再ハッシュ更新
        (透過的アップグレード)。
        """
        row = self.store.get_account(account_id)
        if row is None:
            return False
        stored = row["password_hash"]
        if not verify_password(password, stored):
            return False
        if needs_rehash(stored):
            try:
                self.store.update_password_hash(account_id, hash_password(password))
            except Exception:  # noqa: BLE001 - 再ハッシュ失敗で認証自体は成功扱い
                pass
        return True

    def login(
        self, account_id: str, password: str, *, now: datetime | None = None
    ) -> str | None:
        """認証成功時、sessions_web に発行し不透明 session_id を返す。失敗は None。"""
        if not self.authenticate(account_id, password):
            return None
        now = now or datetime.now(timezone.utc)
        sid = secrets.token_urlsafe(_SESSION_ID_BYTES)
        created = _fmt_iso(now)
        expires = _fmt_iso(now + timedelta(seconds=self.absolute_sec))
        self.store.create_web_session(sid, account_id, created, created, expires)
        return sid

    def logout(self, session_id: str) -> None:
        """セッション失効(削除)。"""
        self.store.delete_web_session(session_id)

    def validate(
        self, session_id: str, *, now: datetime | None = None
    ) -> str | None:
        """セッション検証。有効なら account_id 返し idle を延長。

        - absolute 期限超過 / idle 超過 → 失効(削除)して None。
        - 有効 → last_seen を now に更新し account_id を返す。
        """
        row = self.store.get_web_session(session_id)
        if row is None:
            return None
        now = now or datetime.now(timezone.utc)
        expires_at = _parse_iso(row["expires_at"])
        last_seen = _parse_iso(row["last_seen_at"])
        # absolute 期限
        if now >= expires_at:
            self.store.delete_web_session(session_id)
            return None
        # idle 期限
        if now - last_seen > timedelta(seconds=self.idle_sec):
            self.store.delete_web_session(session_id)
            return None
        self.store.touch_web_session(session_id, _fmt_iso(now))
        return row["account_id"]
