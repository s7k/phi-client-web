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

import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def utc_now() -> str:
    """ISO8601(UTC, 秒精度, 末尾 'Z')。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ------------------------------------------------------------------
    # accounts
    # ------------------------------------------------------------------

    def create_account(self, account_id: str, password_hash: str) -> None:
        self.conn.execute(
            "INSERT INTO accounts (id, password_hash, created_at) VALUES (?, ?, ?)",
            (account_id, password_hash, utc_now()),
        )
        self.conn.commit()

    def get_account(self, account_id: str) -> sqlite3.Row | None:
        cur = self.conn.execute(
            "SELECT id, password_hash, created_at FROM accounts WHERE id = ?",
            (account_id,),
        )
        return cur.fetchone()

    def update_password_hash(self, account_id: str, password_hash: str) -> None:
        self.conn.execute(
            "UPDATE accounts SET password_hash = ? WHERE id = ?",
            (password_hash, account_id),
        )
        self.conn.commit()

    # ------------------------------------------------------------------
    # characters
    # ------------------------------------------------------------------

    def upsert_character(
        self,
        char_id: str,
        account_id: str,
        *,
        display_name: str | None = None,
        last_server: str | None = None,
        legacy_uid_enc: bytes | None = None,
        legacy_host: str | None = None,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO characters
              (char_id, account_id, display_name, last_server,
               legacy_uid_enc, legacy_host, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(char_id) DO UPDATE SET
              account_id     = excluded.account_id,
              display_name   = excluded.display_name,
              last_server    = excluded.last_server,
              legacy_uid_enc = excluded.legacy_uid_enc,
              legacy_host    = excluded.legacy_host,
              updated_at     = excluded.updated_at
            """,
            (char_id, account_id, display_name, last_server,
             legacy_uid_enc, legacy_host, utc_now()),
        )
        self.conn.commit()

    def get_character(self, char_id: str) -> sqlite3.Row | None:
        cur = self.conn.execute(
            "SELECT * FROM characters WHERE char_id = ?", (char_id,)
        )
        return cur.fetchone()

    def list_characters(self, account_id: str) -> list[sqlite3.Row]:
        cur = self.conn.execute(
            "SELECT * FROM characters WHERE account_id = ? ORDER BY char_id",
            (account_id,),
        )
        return cur.fetchall()

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
        session_id: str,
        account_id: str,
        created_at: str,
        last_seen_at: str,
        expires_at: str,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO sessions_web
              (session_id, account_id, created_at, last_seen_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (session_id, account_id, created_at, last_seen_at, expires_at),
        )
        self.conn.commit()

    def get_web_session(self, session_id: str) -> sqlite3.Row | None:
        cur = self.conn.execute(
            "SELECT * FROM sessions_web WHERE session_id = ?", (session_id,)
        )
        return cur.fetchone()

    def touch_web_session(self, session_id: str, last_seen_at: str) -> None:
        self.conn.execute(
            "UPDATE sessions_web SET last_seen_at = ? WHERE session_id = ?",
            (last_seen_at, session_id),
        )
        self.conn.commit()

    def delete_web_session(self, session_id: str) -> None:
        self.conn.execute(
            "DELETE FROM sessions_web WHERE session_id = ?", (session_id,)
        )
        self.conn.commit()

    # ------------------------------------------------------------------
    # settings(char_id, key) upsert
    # ------------------------------------------------------------------

    def set_setting(self, char_id: str, key: str, value: str | None) -> None:
        self.conn.execute(
            """
            INSERT INTO settings (char_id, key, value) VALUES (?, ?, ?)
            ON CONFLICT(char_id, key) DO UPDATE SET value = excluded.value
            """,
            (char_id, key, value),
        )
        self.conn.commit()

    def get_setting(self, char_id: str, key: str) -> str | None:
        cur = self.conn.execute(
            "SELECT value FROM settings WHERE char_id = ? AND key = ?",
            (char_id, key),
        )
        row = cur.fetchone()
        return row["value"] if row else None

    def get_settings(self, char_id: str) -> dict[str, str | None]:
        cur = self.conn.execute(
            "SELECT key, value FROM settings WHERE char_id = ?", (char_id,)
        )
        return {r["key"]: r["value"] for r in cur.fetchall()}

    # ---- アカウント単位の設定(CR-1, [07]§5.7/§6.13) ----
    # settings テーブルの所有キー(char_id 列)に account id を流用し、
    # WS settings.get/set を scope 単位(keybind/notify/display/intervals)で
    # 永続化する。値は JSON 文字列(任意構造)を value 列へ格納。

    def set_account_setting(
        self, account_id: str, scope: str, value: str | None
    ) -> None:
        """アカウント+scope の設定値(JSON 文字列)を upsert。"""
        self.set_setting(account_id, scope, value)

    def get_account_setting(self, account_id: str, scope: str) -> str | None:
        """アカウント+scope の設定値(JSON 文字列 or None)を取得。"""
        return self.get_setting(account_id, scope)

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
    ) -> ChAraGraphic:
        """グラを登録/更新。

        冪等([08]§4): 同一 orig_sha256 が既存なら**再生成せず既存を返す**。
        gra_key は lower(gra_name) で PRIMARY KEY、case-insensitive 一意。
        """
        existing = self.get_graphic_by_sha(orig_sha256)
        if existing is not None:
            return existing

        key = gra_key_of(gra_name)
        now = utc_now()
        self.conn.execute(
            """
            INSERT INTO chara_graphics
              (gra_name, gra_key, stored_name, png_path, width, height,
               color_key, orig_sha256, uploaded_by, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(gra_key) DO UPDATE SET
              gra_name    = excluded.gra_name,
              stored_name = excluded.stored_name,
              png_path    = excluded.png_path,
              width       = excluded.width,
              height      = excluded.height,
              color_key   = excluded.color_key,
              orig_sha256 = excluded.orig_sha256,
              uploaded_by = excluded.uploaded_by,
              uploaded_at = excluded.uploaded_at
            """,
            (gra_name, key, stored_name, png_path, width, height,
             color_key, orig_sha256, uploaded_by, now),
        )
        self.conn.commit()
        return self.get_graphic(gra_name)  # type: ignore[return-value]

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
    )


def _row_to_index(row: sqlite3.Row) -> IndexEntry:
    return IndexEntry(
        key=row["key"],
        gra_name=row["gra_name"],
        updated_by=row["updated_by"],
        updated_at=row["updated_at"],
    )
