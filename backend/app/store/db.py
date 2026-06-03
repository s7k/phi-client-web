"""B8 Store: SQLite ストア実装([02]§6 / [08]§4 / [12]§1.4)。

設計方針
------------------------------------------------------------------
- `schema.sql`(冪等 CREATE IF NOT EXISTS)を `migrate()` で適用。
- 接続はファイルパス or `:memory:`。`PHI_DB_PATH` 環境変数を既定に使用可。
- 日付はISO8601(UTC `YYYY-MM-DDTHH:MM:SSZ`)で統一([08]§4)。
- グラ解決は case-insensitive: `gra_key = lower(gra_name)` で照合([08]§3)。
- 同一 `orig_sha256` は冪等([08]§4): 既存があれば再生成せず既存を返す。
- 認証/Webセッションの発行・検証ロジックは `app.auth` 側。本モジュールは
  純粋な CRUD(行の永続化)に限定する。
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def utc_now() -> str:
    """ISO8601(UTC, 秒精度, 末尾 'Z')。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def id_key_of(plain_id: str) -> str:
    """平文文字列 → sha256(16進)。汎用ハッシュ(後方互換, 一部内部キー用)。"""
    return hashlib.sha256(plain_id.encode("utf-8")).hexdigest()


def gra_key_of(gra_name: str) -> str:
    """グラ名 → 正規化キー(小文字)。case-insensitive 照合用([08]§3)。"""
    return gra_name.lower()


# ----------------------------------------------------------------------
# 行 dataclass(読み出し結果)
# ----------------------------------------------------------------------

@dataclass
class ChAraGraphic:
    gra_name: str
    gra_key: str
    stored_name: str
    png_path: str
    width: int
    height: int
    color_key: str
    orig_sha256: str
    uploaded_by: str | None
    uploaded_at: str
    protected: bool = False


@dataclass
class ChipGraphic:
    mapset_name: str
    mapset_key: str
    stored_name: str
    png_path: str
    width: int
    height: int
    orig_sha256: str
    uploaded_by: str | None
    uploaded_at: str
    protected: bool = False


@dataclass
class IndexEntry:
    key: str
    gra_name: str
    updated_by: str | None
    updated_at: str


def connect(db_path: str | None = None) -> sqlite3.Connection:
    """SQLite 接続を生成しスキーマ適用。

    db_path 省略時は env `PHI_DB_PATH`、それも無ければ `:memory:`。
    """
    path = db_path or os.environ.get("PHI_DB_PATH") or ":memory:"
    # check_same_thread=False: REST(TestClient/uvicorn は別スレッドで
    # ハンドラ実行)から同一接続を共有するため([08]§7 REST)。
    # 書込は短時間・commit 即時で直列化される運用前提。
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # CR-19: WAL モード([12]§7)。読み書きの並行性向上+書込時の読取ブロック軽減。
    # synchronous=NORMAL は WAL 併用で耐障害性とスループットのバランスが良い。
    # :memory: は WAL 非対応(memory のまま)だが PRAGMA は無害(エラーにしない)。
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
    except sqlite3.Error:  # pragma: no cover - 環境依存(:memory: 等)
        pass
    return conn


class Store:
    """SQLite ストア。1 接続を保持し CRUD を提供。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    @classmethod
    def open(cls, db_path: str | None = None) -> "Store":
        store = cls(connect(db_path))
        store.migrate()
        return store

    def migrate(self) -> None:
        """schema.sql を適用(冪等)。"""
        sql = _SCHEMA_PATH.read_text(encoding="utf-8")
        self.conn.executescript(sql)
        # 既存DBへの後付けカラム追加(SQLite は ADD COLUMN IF NOT EXISTS 不可のため
        # PRAGMA で存在確認してから ALTER)。新規DBは schema.sql で既に列があり no-op。
        self._add_column_if_missing("chara_graphics", "protected", "INTEGER NOT NULL DEFAULT 0")
        self.conn.commit()

    def _add_column_if_missing(self, table: str, column: str, decl: str) -> None:
        """table に column が無ければ ALTER TABLE ADD COLUMN(冪等マイグレーション)。"""
        cur = self.conn.execute(f"PRAGMA table_info({table})")
        cols = {row["name"] for row in cur.fetchall()}
        if column not in cols:
            self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")

    def close(self) -> None:
        self.conn.close()

    # ------------------------------------------------------------------
    # accounts(Web 認証, A-34, [12]§1.2)
    # ------------------------------------------------------------------
    # ログインID + argon2id パスワードハッシュ。is_admin で管理者限定([08]§10)。
    # password_hash は呼出側(auth)で算出済のものを受け取る。
    # password 平文/PHI uid はログ/エラーへ出さない。

    def create_account(
        self, account_id: str, password_hash: str, *, is_admin: bool = False
    ) -> None:
        """アカウント新規作成。既存(account_id 衝突)は IntegrityError。"""
        self.conn.execute(
            "INSERT INTO accounts (account_id, password_hash, is_admin, created_at) "
            "VALUES (?, ?, ?, ?)",
            (account_id, password_hash, 1 if is_admin else 0, utc_now()),
        )
        self.conn.commit()

    def get_account(self, account_id: str) -> sqlite3.Row | None:
        cur = self.conn.execute(
            "SELECT account_id, password_hash, is_admin, created_at "
            "FROM accounts WHERE account_id = ?",
            (account_id,),
        )
        return cur.fetchone()

    def update_password_hash(self, account_id: str, password_hash: str) -> None:
        """パスワードハッシュ更新(argon2 rehash 等)。"""
        self.conn.execute(
            "UPDATE accounts SET password_hash = ? WHERE account_id = ?",
            (password_hash, account_id),
        )
        self.conn.commit()

    def is_account_admin(self, account_id: str) -> bool:
        """アカウントが管理者か。未登録は False。"""
        cur = self.conn.execute(
            "SELECT is_admin FROM accounts WHERE account_id = ?", (account_id,)
        )
        row = cur.fetchone()
        return bool(row["is_admin"]) if row is not None else False

    def set_account_admin(self, account_id: str, value: bool) -> None:
        """アカウントの is_admin を設定(grant/revoke 共用)。"""
        self.conn.execute(
            "UPDATE accounts SET is_admin = ? WHERE account_id = ?",
            (1 if value else 0, account_id),
        )
        self.conn.commit()

    def list_accounts(self) -> list[sqlite3.Row]:
        """アカウント一覧(account_id 昇順)。password_hash は含むが CLI 側で非表示。"""
        cur = self.conn.execute(
            "SELECT account_id, password_hash, is_admin, created_at "
            "FROM accounts ORDER BY account_id"
        )
        return cur.fetchall()

    def count_accounts(self) -> int:
        """アカウント総数。初回登録(=0)時の自動管理者化判定に使う。"""
        cur = self.conn.execute("SELECT COUNT(*) AS n FROM accounts")
        return int(cur.fetchone()["n"])

    def count_admins(self) -> int:
        """管理者アカウント数(最後の管理者保護の判定に使う)。"""
        cur = self.conn.execute(
            "SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1"
        )
        return int(cur.fetchone()["n"])

    def delete_account(self, account_id: str) -> bool:
        """アカウント削除。characters は FK CASCADE で連鎖削除。削除行があれば True。

        sessions_web は account_id への FK を張っていないため別途
        `delete_web_sessions_for` で失効させること。
        """
        cur = self.conn.execute(
            "DELETE FROM accounts WHERE account_id = ?", (account_id,)
        )
        self.conn.commit()
        return cur.rowcount > 0

    # ------------------------------------------------------------------
    # characters(アカウント配下の複数キャラ, A-34)
    # ------------------------------------------------------------------
    # 各キャラ = label + phi_uid_enc(暗号化 PHI uid, #open 用) + host/port。
    # phi_uid_enc は呼出側(auth/rest)で暗号化済のものを受け取る。生 uid 非保持。

    def create_character(
        self,
        char_id: str,
        account_id: str,
        *,
        label: str | None = None,
        phi_uid_enc: bytes | None = None,
        host: str | None = None,
        port: int | None = None,
    ) -> None:
        """キャラ新規作成。"""
        now = utc_now()
        self.conn.execute(
            "INSERT INTO characters "
            "(char_id, account_id, label, phi_uid_enc, host, port, "
            " created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (char_id, account_id, label, phi_uid_enc, host, port, now, now),
        )
        self.conn.commit()

    def update_character(
        self,
        char_id: str,
        *,
        label: str | None = None,
        phi_uid_enc: bytes | None = None,
        host: str | None = None,
        port: int | None = None,
    ) -> None:
        """キャラ更新。None 指定の項目は既存値を維持(host/port は明示更新のみ)。

        host/port を None のまま据え置きたい一方で「明示的に既定へ戻す」ニーズは
        現契約に無いため、None=維持とする(REST 層で必要項目のみ渡す)。
        """
        existing = self.get_character(char_id)
        if existing is None:
            return
        new_label = existing["label"] if label is None else label
        new_enc = existing["phi_uid_enc"] if phi_uid_enc is None else phi_uid_enc
        new_host = existing["host"] if host is None else host
        new_port = existing["port"] if port is None else port
        self.conn.execute(
            "UPDATE characters SET label = ?, phi_uid_enc = ?, host = ?, "
            "port = ?, updated_at = ? WHERE char_id = ?",
            (new_label, new_enc, new_host, new_port, utc_now(), char_id),
        )
        self.conn.commit()

    def get_character(self, char_id: str) -> sqlite3.Row | None:
        cur = self.conn.execute(
            "SELECT * FROM characters WHERE char_id = ?", (char_id,)
        )
        return cur.fetchone()

    def list_characters(self, account_id: str) -> list[sqlite3.Row]:
        """アカウント配下のキャラ一覧(created_at 昇順)。"""
        cur = self.conn.execute(
            "SELECT * FROM characters WHERE account_id = ? "
            "ORDER BY created_at, char_id",
            (account_id,),
        )
        return cur.fetchall()

    def delete_character(self, char_id: str) -> bool:
        """キャラ削除。削除行があれば True。"""
        cur = self.conn.execute(
            "DELETE FROM characters WHERE char_id = ?", (char_id,)
        )
        self.conn.commit()
        return cur.rowcount > 0

    # ------------------------------------------------------------------
    # sessions(ゲーム)
    # ------------------------------------------------------------------
    # CR-18 補足: ライブのゲームセッション状態(socket/snapshot/seq)は設計上
    # **インメモリ**(SessionManager 保持)で、本テーブルへは永続化していない。
    # プロセス再起動でライブ状態は揮発する([07]§4.2 / [02]§6)。graceful
    # shutdown(SessionManager.shutdown)で全セッションへ #x を送り後始末する。
    # 本テーブル+以下 CRUD は将来の永続化/監査用に予約(現状ライブ未配線)。
    # スキーマからは削除せず、用途を本コメントで明示(設計乖離の解消)。

    def create_session(
        self, session_id: str, char_id: str, state: str = "attached"
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO sessions (session_id, char_id, state, connected_at)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, char_id, state, utc_now()),
        )
        self.conn.commit()

    def set_session_state(self, session_id: str, state: str) -> None:
        detached = utc_now() if state == "detached" else None
        self.conn.execute(
            "UPDATE sessions SET state = ?, detached_at = ? WHERE session_id = ?",
            (state, detached, session_id),
        )
        self.conn.commit()

    def get_session(self, session_id: str) -> sqlite3.Row | None:
        cur = self.conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        )
        return cur.fetchone()

    # ------------------------------------------------------------------
    # sessions_web([12]§1.4)
    # ------------------------------------------------------------------

    def create_web_session(
        self,
        token: str,
        account_id: str,
        created_at: str,
        last_seen_at: str,
        expires_at: str,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO sessions_web
              (token, account_id, created_at, last_seen_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (token, account_id, created_at, last_seen_at, expires_at),
        )
        self.conn.commit()

    def get_web_session(self, token: str) -> sqlite3.Row | None:
        cur = self.conn.execute(
            "SELECT * FROM sessions_web WHERE token = ?", (token,)
        )
        return cur.fetchone()

    def touch_web_session(self, token: str, last_seen_at: str) -> None:
        self.conn.execute(
            "UPDATE sessions_web SET last_seen_at = ? WHERE token = ?",
            (last_seen_at, token),
        )
        self.conn.commit()

    def delete_web_session(self, token: str) -> None:
        self.conn.execute(
            "DELETE FROM sessions_web WHERE token = ?", (token,)
        )
        self.conn.commit()

    def delete_web_sessions_for(self, account_id: str) -> int:
        """account の Web セッションを全失効(強制PW変更/削除/admin剥奪時)。削除件数を返す。"""
        cur = self.conn.execute(
            "DELETE FROM sessions_web WHERE account_id = ?", (account_id,)
        )
        self.conn.commit()
        return cur.rowcount

    # ------------------------------------------------------------------
    # settings(char_id, key) upsert
    # ------------------------------------------------------------------

    def set_setting(self, owner: str, key: str, value: str | None) -> None:
        self.conn.execute(
            """
            INSERT INTO settings (owner, key, value) VALUES (?, ?, ?)
            ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value
            """,
            (owner, key, value),
        )
        self.conn.commit()

    def get_setting(self, owner: str, key: str) -> str | None:
        cur = self.conn.execute(
            "SELECT value FROM settings WHERE owner = ? AND key = ?",
            (owner, key),
        )
        row = cur.fetchone()
        return row["value"] if row else None

    def get_settings(self, owner: str) -> dict[str, str | None]:
        cur = self.conn.execute(
            "SELECT key, value FROM settings WHERE owner = ?", (owner,)
        )
        return {r["key"]: r["value"] for r in cur.fetchall()}

    # ---- ID 単位の設定(CR-1, [07]§5.7/§6.13) ----
    # settings の所有キー(owner 列)に id_key を流用し、WS settings.get/set を
    # scope 単位(keybind/notify/display/intervals)で永続化する。
    # 値は JSON 文字列(任意構造)を value 列へ格納。

    def set_account_setting(
        self, owner: str, scope: str, value: str | None
    ) -> None:
        """所有者(id_key)+scope の設定値(JSON 文字列)を upsert。"""
        self.set_setting(owner, scope, value)

    def get_account_setting(self, owner: str, scope: str) -> str | None:
        """所有者(id_key)+scope の設定値(JSON 文字列 or None)を取得。"""
        return self.get_setting(owner, scope)

    # ------------------------------------------------------------------
    # chara_graphics([08]§4)
    # ------------------------------------------------------------------

    def get_graphic_by_sha(self, orig_sha256: str) -> ChAraGraphic | None:
        cur = self.conn.execute(
            "SELECT * FROM chara_graphics WHERE orig_sha256 = ? LIMIT 1",
            (orig_sha256,),
        )
        row = cur.fetchone()
        return _row_to_graphic(row) if row else None

    def get_graphic(self, gra_name: str) -> ChAraGraphic | None:
        """case-insensitive 解決([08]§3)。gra_key = lower(gra_name)。"""
        cur = self.conn.execute(
            "SELECT * FROM chara_graphics WHERE gra_key = ?",
            (gra_key_of(gra_name),),
        )
        row = cur.fetchone()
        return _row_to_graphic(row) if row else None

    def upsert_graphic(
        self,
        gra_name: str,
        stored_name: str,
        png_path: str,
        width: int,
        height: int,
        orig_sha256: str,
        *,
        color_key: str = "teal",
        uploaded_by: str | None = None,
        protected: bool = False,
    ) -> ChAraGraphic:
        """グラを登録/更新。

        gra_key = lower(gra_name) を PRIMARY KEY とし case-insensitive 一意。
        同名(gra_key 衝突)は上書き更新。同名拒否は REST 層で事前判定する
        ([08] アップロードは物理名 = stored_name = lower(gra_name) で配信解決)。
        """
        key = gra_key_of(gra_name)
        now = utc_now()
        self.conn.execute(
            """
            INSERT INTO chara_graphics
              (gra_name, gra_key, stored_name, png_path, width, height,
               color_key, orig_sha256, protected, uploaded_by, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(gra_key) DO UPDATE SET
              gra_name    = excluded.gra_name,
              stored_name = excluded.stored_name,
              png_path    = excluded.png_path,
              width       = excluded.width,
              height      = excluded.height,
              color_key   = excluded.color_key,
              orig_sha256 = excluded.orig_sha256,
              protected   = excluded.protected,
              uploaded_by = excluded.uploaded_by,
              uploaded_at = excluded.uploaded_at
            """,
            (gra_name, key, stored_name, png_path, width, height,
             color_key, orig_sha256, 1 if protected else 0, uploaded_by, now),
        )
        self.conn.commit()
        return self.get_graphic(gra_name)  # type: ignore[return-value]

    def delete_graphic(self, gra_name: str) -> bool:
        """グラ削除(DB行のみ。物理PNGは呼出側で削除)。削除行があれば True。"""
        cur = self.conn.execute(
            "DELETE FROM chara_graphics WHERE gra_key = ?",
            (gra_key_of(gra_name),),
        )
        self.conn.commit()
        return cur.rowcount > 0

    # ------------------------------------------------------------------
    # chip_graphics(マップチップシート, [06]/[08]§5)
    # ------------------------------------------------------------------

    def get_chip_by_sha(self, orig_sha256: str) -> ChipGraphic | None:
        cur = self.conn.execute(
            "SELECT * FROM chip_graphics WHERE orig_sha256 = ? LIMIT 1",
            (orig_sha256,),
        )
        row = cur.fetchone()
        return _row_to_chip(row) if row else None

    def get_chip(self, mapset_name: str) -> ChipGraphic | None:
        """case-insensitive 解決。mapset_key = lower(mapset_name)。"""
        cur = self.conn.execute(
            "SELECT * FROM chip_graphics WHERE mapset_key = ?",
            (mapset_name.lower(),),
        )
        row = cur.fetchone()
        return _row_to_chip(row) if row else None

    def list_chips(self) -> list[ChipGraphic]:
        cur = self.conn.execute("SELECT * FROM chip_graphics ORDER BY mapset_key")
        return [_row_to_chip(r) for r in cur.fetchall()]

    def upsert_chip(
        self,
        mapset_name: str,
        stored_name: str,
        png_path: str,
        width: int,
        height: int,
        orig_sha256: str,
        *,
        uploaded_by: str | None = None,
        protected: bool = False,
    ) -> ChipGraphic:
        """チップシートを登録/更新(mapset_key 一意)。同名拒否は REST 層で事前判定。"""
        key = mapset_name.lower()
        now = utc_now()
        self.conn.execute(
            """
            INSERT INTO chip_graphics
              (mapset_name, mapset_key, stored_name, png_path, width, height,
               orig_sha256, protected, uploaded_by, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mapset_key) DO UPDATE SET
              mapset_name = excluded.mapset_name,
              stored_name = excluded.stored_name,
              png_path    = excluded.png_path,
              width       = excluded.width,
              height      = excluded.height,
              orig_sha256 = excluded.orig_sha256,
              protected   = excluded.protected,
              uploaded_by = excluded.uploaded_by,
              uploaded_at = excluded.uploaded_at
            """,
            (mapset_name, key, stored_name, png_path, width, height,
             orig_sha256, 1 if protected else 0, uploaded_by, now),
        )
        self.conn.commit()
        return self.get_chip(mapset_name)  # type: ignore[return-value]

    def delete_chip(self, mapset_name: str) -> bool:
        """チップ削除(DB行のみ)。削除行があれば True。"""
        cur = self.conn.execute(
            "DELETE FROM chip_graphics WHERE mapset_key = ?",
            (mapset_name.lower(),),
        )
        self.conn.commit()
        return cur.rowcount > 0

    # ------------------------------------------------------------------
    # chara_index([08]§4 / §6 Index.txt 取込/生成)
    # ------------------------------------------------------------------

    def upsert_index(
        self, key: str, gra_name: str, *, updated_by: str | None = None
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO chara_index (key, gra_name, updated_by, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              gra_name   = excluded.gra_name,
              updated_by = excluded.updated_by,
              updated_at = excluded.updated_at
            """,
            (key, gra_name, updated_by, utc_now()),
        )
        self.conn.commit()

    def get_index(self, key: str) -> IndexEntry | None:
        cur = self.conn.execute(
            "SELECT * FROM chara_index WHERE key = ?", (key,)
        )
        row = cur.fetchone()
        return _row_to_index(row) if row else None

    def list_index(self) -> list[IndexEntry]:
        cur = self.conn.execute("SELECT * FROM chara_index ORDER BY key")
        return [_row_to_index(r) for r in cur.fetchall()]

    # ---- Index.txt 取込/生成([08]§6) ----

    def import_index_text(
        self, text: str, *, updated_by: str | None = None
    ) -> int:
        """Index.txt 取込: `key = value`(value の .bmp 拡張子除去)。

        `//`行・空行は無視。upsert 行数を返す([08]§6 import)。
        """
        count = 0
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("//"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if value.lower().endswith(".bmp"):
                value = value[:-4]
            if not key:
                continue
            self.upsert_index(key, value, updated_by=updated_by)
            count += 1
        return count

    def export_index_text(self) -> str:
        """Index.txt 生成: `key = <gra_name>.bmp`([08]§6 export)。"""
        lines = [f"{e.key} = {e.gra_name}.bmp" for e in self.list_index()]
        return "\n".join(lines) + ("\n" if lines else "")


def _row_to_graphic(row: sqlite3.Row) -> ChAraGraphic:
    return ChAraGraphic(
        gra_name=row["gra_name"],
        gra_key=row["gra_key"],
        stored_name=row["stored_name"],
        png_path=row["png_path"],
        width=row["width"],
        height=row["height"],
        color_key=row["color_key"],
        orig_sha256=row["orig_sha256"],
        uploaded_by=row["uploaded_by"],
        uploaded_at=row["uploaded_at"],
        protected=bool(row["protected"]),
    )


def _row_to_chip(row: sqlite3.Row) -> ChipGraphic:
    return ChipGraphic(
        mapset_name=row["mapset_name"],
        mapset_key=row["mapset_key"],
        stored_name=row["stored_name"],
        png_path=row["png_path"],
        width=row["width"],
        height=row["height"],
        orig_sha256=row["orig_sha256"],
        uploaded_by=row["uploaded_by"],
        uploaded_at=row["uploaded_at"],
        protected=bool(row["protected"]),
    )


def _row_to_index(row: sqlite3.Row) -> IndexEntry:
    return IndexEntry(
        key=row["key"],
        gra_name=row["gra_name"],
        updated_by=row["updated_by"],
        updated_at=row["updated_at"],
    )
