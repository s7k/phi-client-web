"""B12 認証・レガシー uid 暗号・Web セッション([12]§1)。

2層の認証([12]§1.2)
------------------------------------------------------------------
- Web認証:   ブラウザ→BE。`accounts.password_hash` で検証。
- レガシー資格: BE→レガシーサーバ `#open`。`characters.legacy_uid_enc`(暗号化保存)。

実装方針
------------------------------------------------------------------
- パスワードハッシュ:
    argon2id 推奨([12]§1.4)だが当環境に `argon2-cffi` 未導入。
    TODO(B12+): argon2-cffi 導入後に argon2id へ差し替え。
    暫定: hashlib PBKDF2-HMAC-SHA256 + ランダム salt(`pbkdf2$...`)。
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

from cryptography.fernet import Fernet, InvalidToken

from app.store import Store
from app.store.db import utc_now

# ----------------------------------------------------------------------
# 期限既定([12]§1.3)
# ----------------------------------------------------------------------
IDLE_TIMEOUT_SEC = 30 * 60        # idle 30分
ABSOLUTE_TIMEOUT_SEC = 24 * 3600  # absolute 24h

_PBKDF2_ROUNDS = 600_000  # OWASP 2023 推奨(PBKDF2-HMAC-SHA256)
_SESSION_ID_BYTES = 32    # 256bit 不透明 ID


# ======================================================================
# パスワードハッシュ
# ======================================================================

def hash_password(password: str) -> str:
    """パスワード → 保存用ハッシュ文字列 `pbkdf2$<rounds>$<salt_hex>$<dk_hex>`。

    TODO(B12+): argon2id へ移行(argon2-cffi 導入後)。
    """
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2${_PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """平文パスワードと保存ハッシュを定数時間比較で検証。"""
    try:
        scheme, rounds_s, salt_hex, dk_hex = stored.split("$")
    except ValueError:
        return False
    if scheme != "pbkdf2":
        return False  # TODO(B12+): argon2id 等の他方式
    rounds = int(rounds_s)
    salt = bytes.fromhex(salt_hex)
    expected = bytes.fromhex(dk_hex)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return hmac.compare_digest(dk, expected)


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
        """id+password を accounts と照合。"""
        row = self.store.get_account(account_id)
        if row is None:
            return False
        return verify_password(password, row["password_hash"])

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
