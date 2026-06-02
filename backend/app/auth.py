"""B12 認証(ID-only 再設計)・ID 暗号・Web セッション([12]§1)。

ID-only 認証([12]§1.1/§1.2)
------------------------------------------------------------------
PHI プレイヤーは **ID のみで識別**され、`#open <uid>` の uid 自体に6字
パスワードが埋め込まれた**資格情報**(レガシー .phirc 相当)。よって別 Web
パスワードは二重で不要 → 廃止。ID=資格情報として扱い、SQLite には**暗号保存**。

- 保存IDテーブル `saved_ids`: id_key=sha256(id) を PK、id_enc=暗号文を保存。
  管理者は saved_ids.is_admin で判定。
- Web セッション: 入力 ID で cookie `phi_session` token を発行。
  sessions_web に token/id_key/id_enc(セッション内 #open 用)/expires を保持。
- ID 暗号: `cryptography` Fernet(AES128-CBC + HMAC, AEAD相当)。鍵は env
  `PHI_SECRET_KEY`(Fernet.generate_key() 形式)。SQLite には暗号文のみ。

重要: **IDは資格情報。ログ/エラーに出さない**。id_key/token のみ扱う。

CSRF/cookie 属性([12]§1.3: httpOnly/Secure/SameSite=Strict)は REST 層で付与。
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet, InvalidToken

from app.store import Store
from app.store.db import id_key_of

# ----------------------------------------------------------------------
# 期限既定([12]§1.3)
# ----------------------------------------------------------------------
IDLE_TIMEOUT_SEC = 30 * 60        # idle 30分
ABSOLUTE_TIMEOUT_SEC = 24 * 3600  # absolute 24h

_TOKEN_BYTES = 32    # 256bit 不透明 token


# ======================================================================
# ID 暗号(Fernet)
# ======================================================================

def _load_key() -> bytes:
    """env `PHI_SECRET_KEY`(Fernet 鍵)を取得。未設定なら例外。"""
    key = os.environ.get("PHI_SECRET_KEY")
    if not key:
        raise RuntimeError(
            "PHI_SECRET_KEY 未設定(ID 暗号鍵)。Fernet.generate_key() で生成し env 設定"
        )
    return key.encode("utf-8") if isinstance(key, str) else key


class UidCipher:
    """PHI ID(資格情報)の AEAD 暗号化/復号([12]§1.2)。

    平文 ID を at-rest 暗号化し、復号して #open / セッション確立に使う。
    """

    def __init__(self, key: bytes | None = None) -> None:
        self._fernet = Fernet(key or _load_key())

    @staticmethod
    def generate_key() -> bytes:
        """新規鍵生成(urlsafe-base64 32B)。env 設定用。"""
        return Fernet.generate_key()

    def encrypt(self, plain_id: str) -> bytes:
        """平文ID → 暗号文 BLOB。"""
        return self._fernet.encrypt(plain_id.encode("utf-8"))

    def decrypt(self, token: bytes) -> str:
        """暗号文 BLOB → 平文ID。改ざん/不正鍵は ValueError。"""
        try:
            return self._fernet.decrypt(token).decode("utf-8")
        except InvalidToken as exc:
            raise ValueError("ID 復号失敗(鍵不一致/改ざん)") from exc


# ======================================================================
# Web セッション管理(sessions_web)
# ======================================================================

def _parse_iso(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _fmt_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class SessionIdentity:
    """検証済みセッションの ID 情報(生ID非保持)。

    plain_id は **その場で復号した #open 用**。保持・ログ禁止。
    """
    id_key: str
    id_enc: bytes

    @property
    def is_anonymous(self) -> bool:
        return False


class AuthService:
    """ID-only 認証・セッション発行/検証([12]§1.3)。

    Store と UidCipher を束ね、establish_session/logout/validate を提供。
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

    # ---- 保存ID(saved_ids)操作 ----

    def remember_id(
        self, plain_id: str, *, label: str | None = None,
        is_admin: bool | None = None,
        host: str | None = None, port: int | None = None,
    ) -> str:
        """平文IDを saved_ids へ暗号 upsert し id_key を返す。

        既存の is_admin/label/host/port は引数 None なら維持(A-32)。
        """
        key = id_key_of(plain_id)
        enc = self.cipher.encrypt(plain_id)
        self.store.upsert_saved_id(
            key, enc, label=label, is_admin=is_admin, host=host, port=port
        )
        return key

    # ---- セッション確立(ID のみ) ----

    def establish_session(
        self, plain_id: str, *, remember: bool = False,
        label: str | None = None, now: datetime | None = None,
    ) -> str:
        """入力 ID でセッション token を発行(sessions_web)。

        - id_key=sha256(id)、id_enc=暗号文(#open 用)を保持。
        - remember=True で saved_ids へ upsert(任意のラベル付き)。
        - 既存 saved_ids があれば last_used_at を更新する。
        Returns 不透明 token(cookie 値)。
        """
        key = id_key_of(plain_id)
        enc = self.cipher.encrypt(plain_id)
        now = now or datetime.now(timezone.utc)
        created = _fmt_iso(now)
        expires = _fmt_iso(now + timedelta(seconds=self.absolute_sec))
        token = secrets.token_urlsafe(_TOKEN_BYTES)
        self.store.create_web_session(token, key, enc, created, created, expires)
        if remember:
            self.store.upsert_saved_id(key, enc, label=label)
        if self.store.get_saved_id(key) is not None:
            self.store.touch_saved_id(key, created)
        return token

    def logout(self, token: str) -> None:
        """セッション失効(削除)。"""
        self.store.delete_web_session(token)

    def is_admin(self, id_key: str) -> bool:
        """id_key が管理者か(saved_ids.is_admin)。未登録は False。"""
        return self.store.is_saved_admin(id_key)

    def validate(
        self, token: str, *, now: datetime | None = None
    ) -> SessionIdentity | None:
        """セッション検証。有効なら SessionIdentity を返し idle を延長。

        - absolute 期限超過 / idle 超過 → 失効(削除)して None。
        - 有効 → last_seen を now に更新し SessionIdentity(id_key, id_enc)。
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
        return SessionIdentity(id_key=row["id_key"], id_enc=row["id_enc"])

    def validate_id_key(
        self, token: str, *, now: datetime | None = None
    ) -> str | None:
        """検証して id_key のみ返す(admin 判定/設定所有者キー用)。"""
        ident = self.validate(token, now=now)
        return ident.id_key if ident is not None else None

    def open_id_for(self, ident: SessionIdentity) -> str:
        """セッションの id_enc を復号し #open 用平文 ID を返す(その場限り)。"""
        return self.cipher.decrypt(ident.id_enc)
