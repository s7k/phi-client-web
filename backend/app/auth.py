"""B12 認証(アカウント+複数キャラ 再設計, A-34)・PHI uid 暗号・Web セッション。

認証構造(A-34, [12]§1.2)
------------------------------------------------------------------
1アカウント(ログインID + Web パスワード)の下に複数キャラを保持する2層構造。

| 層 | 用途 | 資格 |
|----|------|------|
| **Web認証** | ブラウザ→BE のログイン | `accounts.password_hash`(argon2id) |
| **レガシー資格** | BE→レガシーサーバ `#open` | `characters.phi_uid_enc`(暗号化保存) |

- `POST /api/auth/login` でアカウント検証→不透明 token を発行(A-33: cookie 廃止、
  token は REST=Bearer / WS=auth メッセージで送る。FE が localStorage 保持)。
  sessions_web に token/account_id/expires を保持。
- 各キャラの PHI uid は `#open <uid>` の uid 自体に6字パスワードが埋め込まれた
  **資格情報**。SQLite には平文保存禁止 → PHI_SECRET_KEY で AEAD 暗号化(at-rest)。
  `session.open {charId}` で BE が復号し `#open <uid>` を送る。
- uid 暗号: `cryptography` Fernet(AES128-CBC + HMAC, AEAD相当)。鍵は env
  `PHI_SECRET_KEY`(Fernet.generate_key() 形式)。SQLite には暗号文のみ。

重要: **PHI uid / Web パスワードは資格情報。ログ/エラーに出さない**。
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken

from app.store import Store

# ----------------------------------------------------------------------
# 期限既定([12]§1.3)
# ----------------------------------------------------------------------
IDLE_TIMEOUT_SEC = 30 * 60        # idle 30分
ABSOLUTE_TIMEOUT_SEC = 24 * 3600  # absolute 24h

_TOKEN_BYTES = 32    # 256bit 不透明 token

# パスワード最小長(A-34: register で検証)。
PASSWORD_MIN_LEN = 8


# ======================================================================
# PHI uid 暗号(Fernet)
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
    """PHI uid(資格情報)の AEAD 暗号化/復号([12]§1.2)。

    平文 uid を at-rest 暗号化し、復号して #open / セッション確立に使う。
    """

    def __init__(self, key: bytes | None = None) -> None:
        self._fernet = Fernet(key or _load_key())

    @staticmethod
    def generate_key() -> bytes:
        """新規鍵生成(urlsafe-base64 32B)。env 設定用。"""
        return Fernet.generate_key()

    def encrypt(self, plain_uid: str) -> bytes:
        """平文 uid → 暗号文 BLOB。"""
        return self._fernet.encrypt(plain_uid.encode("utf-8"))

    def decrypt(self, token: bytes) -> str:
        """暗号文 BLOB → 平文 uid。改ざん/不正鍵は ValueError。"""
        try:
            return self._fernet.decrypt(token).decode("utf-8")
        except InvalidToken as exc:
            raise ValueError("uid 復号失敗(鍵不一致/改ざん)") from exc


# ======================================================================
# Web セッション管理(sessions_web)
# ======================================================================

def _parse_iso(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _fmt_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class SessionIdentity:
    """検証済みセッションの ID 情報。

    account_id のみ保持(PHI uid はキャラ単位で session.open 時に復号)。
    """
    account_id: str


class AuthService:
    """アカウント認証・セッション発行/検証(A-34, [12]§1.3)。

    Store と UidCipher を束ね、register/login/logout/validate を提供。
    時刻は `now()` で注入可能(テスト容易性)。パスワード照合は argon2id。
    """

    def __init__(
        self,
        store: Store,
        cipher: UidCipher | None = None,
        *,
        idle_sec: int = IDLE_TIMEOUT_SEC,
        absolute_sec: int = ABSOLUTE_TIMEOUT_SEC,
        password_hasher: PasswordHasher | None = None,
    ) -> None:
        self.store = store
        self._cipher = cipher
        self.idle_sec = idle_sec
        self.absolute_sec = absolute_sec
        self._ph = password_hasher or PasswordHasher()

    @property
    def cipher(self) -> UidCipher:
        if self._cipher is None:
            self._cipher = UidCipher()
        return self._cipher

    # ---- アカウント(accounts)操作 ----

    def hash_password(self, password: str) -> str:
        """argon2id でハッシュ化。"""
        return self._ph.hash(password)

    def register(
        self, account_id: str, password: str, *, is_admin: bool = False
    ) -> None:
        """新規アカウント作成([12]§1)。

        - account_id 空 → ValueError。
        - password 最小長未満 → ValueError。
        - 既存 account_id → ValueError("account exists")(REST 層で 409 化)。
        password はログ/エラーへ出さない(資格情報)。
        """
        account_id = (account_id or "").strip()
        if not account_id:
            raise ValueError("accountId が必要")
        if len(password or "") < PASSWORD_MIN_LEN:
            raise ValueError(f"パスワードは{PASSWORD_MIN_LEN}文字以上")
        if self.store.get_account(account_id) is not None:
            raise ValueError("account exists")
        self.store.create_account(
            account_id, self.hash_password(password), is_admin=is_admin
        )

    def verify_password(self, account_id: str, password: str) -> bool:
        """アカウント+パスワードを照合。一致 True。

        argon2 のパラメータ更新時は rehash して保存し直す。失敗は False。
        password はログ/エラーへ出さない。
        """
        row = self.store.get_account(account_id)
        if row is None:
            return False
        try:
            self._ph.verify(row["password_hash"], password)
        except (VerifyMismatchError, InvalidHashError):
            return False
        if self._ph.check_needs_rehash(row["password_hash"]):
            self.store.update_password_hash(
                account_id, self.hash_password(password)
            )
        return True

    # ---- セッション確立(login) ----

    def login(
        self, account_id: str, password: str, *, now: datetime | None = None
    ) -> str | None:
        """アカウント検証→セッション token を発行(sessions_web)。

        - 検証失敗(未登録/パスワード不一致)→ None(REST 層で 401)。
        - 成功 → 不透明 token を返す(A-33: REST=Bearer / WS=auth で送る)。
        """
        if not self.verify_password(account_id, password):
            return None
        return self._issue_token(account_id, now=now)

    def _issue_token(
        self, account_id: str, *, now: datetime | None = None
    ) -> str:
        now = now or datetime.now(timezone.utc)
        created = _fmt_iso(now)
        expires = _fmt_iso(now + timedelta(seconds=self.absolute_sec))
        token = secrets.token_urlsafe(_TOKEN_BYTES)
        self.store.create_web_session(token, account_id, created, created, expires)
        return token

    def logout(self, token: str) -> None:
        """セッション失効(削除)。"""
        self.store.delete_web_session(token)

    def is_admin(self, account_id: str) -> bool:
        """アカウントが管理者か(accounts.is_admin)。未登録は False。"""
        return self.store.is_account_admin(account_id)

    def validate(
        self, token: str, *, now: datetime | None = None
    ) -> SessionIdentity | None:
        """セッション検証。有効なら SessionIdentity を返し idle を延長。

        - absolute 期限超過 / idle 超過 → 失効(削除)して None。
        - 有効 → last_seen を now に更新し SessionIdentity(account_id)。
        """
        row = self.store.get_web_session(token)
        if row is None:
            return None
        now = now or datetime.now(timezone.utc)
        expires_at = _parse_iso(row["expires_at"])
        last_seen = _parse_iso(row["last_seen_at"])
        if now >= expires_at:
            self.store.delete_web_session(token)
            return None
        if now - last_seen > timedelta(seconds=self.idle_sec):
            self.store.delete_web_session(token)
            return None
        self.store.touch_web_session(token, _fmt_iso(now))
        return SessionIdentity(account_id=row["account_id"])

    def validate_account(
        self, token: str, *, now: datetime | None = None
    ) -> str | None:
        """検証して account_id のみ返す(admin 判定/設定所有者キー用)。"""
        ident = self.validate(token, now=now)
        return ident.account_id if ident is not None else None
