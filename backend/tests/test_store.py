"""B8 Store テスト([02]§6 / [08]§4 / [12]§1.4)。

メモリ DB で CRUD・gra_key 一意・sha256 冪等・settings upsert・
Index.txt 取込/生成ラウンドトリップを検証。
"""
import pytest

from app.store import Store


@pytest.fixture
def store():
    s = Store.open(":memory:")
    yield s
    s.close()


# ----------------------------------------------------------------------
# migration
# ----------------------------------------------------------------------

def test_migrate_idempotent(store):
    # 二重適用しても落ちない(IF NOT EXISTS)。
    store.migrate()
    store.migrate()


# ----------------------------------------------------------------------
# CR-19: SQLite WAL / synchronous
# ----------------------------------------------------------------------

def test_wal_mode_on_file_db(tmp_path):
    """ファイル DB で journal_mode=WAL / synchronous=NORMAL(=1)が反映。"""
    from app.store.db import connect
    conn = connect(str(tmp_path / "wal.db"))
    try:
        jm = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert jm.lower() == "wal"
        sync = conn.execute("PRAGMA synchronous").fetchone()[0]
        assert sync == 1  # NORMAL
    finally:
        conn.close()


def test_memory_db_pragma_no_error():
    """:memory: でも WAL PRAGMA でエラーにならず接続できる。"""
    from app.store.db import connect
    conn = connect(":memory:")
    try:
        # :memory: は WAL 非対応(memory のまま)だが接続自体は成功する。
        assert conn.execute("SELECT 1").fetchone()[0] == 1
    finally:
        conn.close()


def test_tables_present(store):
    rows = store.conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    names = {r["name"] for r in rows}
    for t in ("accounts", "characters", "sessions", "sessions_web",
              "settings", "chara_graphics", "chara_index"):
        assert t in names


# ----------------------------------------------------------------------
# accounts / characters
# ----------------------------------------------------------------------

def test_account_crud(store):
    store.create_account("alice", "hash1")
    row = store.get_account("alice")
    assert row["id"] == "alice"
    assert row["password_hash"] == "hash1"
    assert row["created_at"].endswith("Z")

    store.update_password_hash("alice", "hash2")
    assert store.get_account("alice")["password_hash"] == "hash2"
    assert store.get_account("missing") is None


# ----------------------------------------------------------------------
# is_admin(管理者フラグ)
# ----------------------------------------------------------------------

def test_account_default_not_admin(store):
    store.create_account("alice", "h")
    assert store.get_account("alice")["is_admin"] == 0
    assert store.is_account_admin("alice") is False
    assert store.list_admins() == []


def test_set_admin_grant_and_revoke(store):
    store.create_account("alice", "h")
    store.set_admin("alice", True)
    assert store.is_account_admin("alice") is True
    assert store.get_account("alice")["is_admin"] == 1
    assert store.list_admins() == ["alice"]
    store.set_admin("alice", False)
    assert store.is_account_admin("alice") is False
    assert store.list_admins() == []


def test_is_account_admin_missing_is_false(store):
    assert store.is_account_admin("nobody") is False


def test_list_admins_sorted(store):
    for a in ("carol", "alice", "bob"):
        store.create_account(a, "h")
        store.set_admin(a, True)
    store.create_account("dave", "h")  # 非管理者は除外
    assert store.list_admins() == ["alice", "bob", "carol"]


def test_migrate_adds_is_admin_to_legacy_db(tmp_path):
    """既存DB(is_admin 列なし)に migrate() で冪等に列追加。"""
    import sqlite3

    db = str(tmp_path / "legacy.db")
    conn = sqlite3.connect(db)
    # 旧スキーマ(is_admin 列なし)で accounts を作成。
    conn.execute(
        "CREATE TABLE accounts (id TEXT PRIMARY KEY, "
        "password_hash TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    conn.execute(
        "INSERT INTO accounts (id, password_hash, created_at) "
        "VALUES ('old', 'h', '2020-01-01T00:00:00Z')"
    )
    conn.commit()
    conn.close()

    # Store.open は migrate() を走らせ ALTER TABLE で列追加。
    s = Store.open(db)
    cols = {r["name"] for r in s.conn.execute("PRAGMA table_info(accounts)")}
    assert "is_admin" in cols
    assert s.is_account_admin("old") is False  # 既定 0
    # 冪等: 再 migrate しても落ちない。
    s.migrate()
    assert s.is_account_admin("old") is False
    s.close()


def test_character_upsert_and_list(store):
    store.create_account("alice", "h")
    store.upsert_character("c1", "alice", display_name="Hero",
                           legacy_uid_enc=b"\x01\x02", legacy_host="game1")
    row = store.get_character("c1")
    assert row["display_name"] == "Hero"
    assert row["legacy_uid_enc"] == b"\x01\x02"
    assert row["legacy_host"] == "game1"

    # upsert で更新
    store.upsert_character("c1", "alice", display_name="Hero2")
    assert store.get_character("c1")["display_name"] == "Hero2"

    store.upsert_character("c2", "alice")
    chars = store.list_characters("alice")
    assert [c["char_id"] for c in chars] == ["c1", "c2"]


# ----------------------------------------------------------------------
# sessions / sessions_web
# ----------------------------------------------------------------------

def test_game_session(store):
    store.create_account("a", "h")
    store.upsert_character("c1", "a")
    store.create_session("s1", "c1")
    assert store.get_session("s1")["state"] == "attached"
    store.set_session_state("s1", "detached")
    row = store.get_session("s1")
    assert row["state"] == "detached"
    assert row["detached_at"].endswith("Z")


def test_web_session(store):
    store.create_account("a", "h")
    store.create_web_session("ws1", "a", "2026-06-01T00:00:00Z",
                             "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z")
    row = store.get_web_session("ws1")
    assert row["account_id"] == "a"
    store.touch_web_session("ws1", "2026-06-01T00:10:00Z")
    assert store.get_web_session("ws1")["last_seen_at"] == "2026-06-01T00:10:00Z"
    store.delete_web_session("ws1")
    assert store.get_web_session("ws1") is None


# ----------------------------------------------------------------------
# settings upsert
# ----------------------------------------------------------------------

def test_settings_upsert(store):
    store.set_setting("c1", "map-iv", "1")
    assert store.get_setting("c1", "map-iv") == "1"
    # 同一キー upsert(重複行を作らず更新)
    store.set_setting("c1", "map-iv", "2")
    assert store.get_setting("c1", "map-iv") == "2"
    store.set_setting("c1", "status-iv", "5")
    assert store.get_settings("c1") == {"map-iv": "2", "status-iv": "5"}
    assert store.get_setting("c1", "missing") is None


# ----------------------------------------------------------------------
# chara_graphics: gra_key 一意 / sha256 冪等
# ----------------------------------------------------------------------

def test_graphic_gra_key_case_insensitive(store):
    store.upsert_graphic("t_Man", "stored_a", "assets/chara/stored_a.png",
                         48, 64, "sha_a")
    # 大小違いで同一キー解決
    g = store.get_graphic("T_MAN")
    assert g is not None
    assert g.gra_key == "t_man"
    assert g.gra_name == "t_Man"
    assert g.color_key == "teal"


def test_graphic_gra_key_unique(store):
    store.upsert_graphic("t_Man", "stored_a", "p1", 48, 64, "sha_a")
    # 同一 gra_key(大小違い) の別 sha → upsert で同一行更新(別行を作らない)
    store.upsert_graphic("T_Man", "stored_b", "p2", 10, 10, "sha_b")
    rows = store.conn.execute("SELECT COUNT(*) c FROM chara_graphics").fetchone()
    assert rows["c"] == 1
    g = store.get_graphic("t_man")
    assert g.stored_name == "stored_b"
    assert g.orig_sha256 == "sha_b"


def test_graphic_sha256_idempotent(store):
    first = store.upsert_graphic("GraA", "stored_a", "p1", 48, 64, "sha_x")
    # 同一 sha を別名でアップロード → 既存を返し再生成しない([08]§4 冪等)
    again = store.upsert_graphic("GraB", "stored_b", "p2", 1, 1, "sha_x")
    assert again.stored_name == first.stored_name
    assert again.gra_name == "GraA"
    rows = store.conn.execute("SELECT COUNT(*) c FROM chara_graphics").fetchone()
    assert rows["c"] == 1


def test_graphic_by_sha(store):
    store.upsert_graphic("G", "s", "p", 1, 1, "sha_q")
    assert store.get_graphic_by_sha("sha_q").gra_name == "G"
    assert store.get_graphic_by_sha("nope") is None


# ----------------------------------------------------------------------
# chara_index: 取込/生成ラウンドトリップ
# ----------------------------------------------------------------------

def test_index_upsert(store):
    store.upsert_index("知的生物", "t_Man")
    e = store.get_index("知的生物")
    assert e.gra_name == "t_Man"
    store.upsert_index("知的生物", "t_Woman")
    assert store.get_index("知的生物").gra_name == "t_Woman"


def test_index_import_text(store):
    text = (
        "// コメント行\n"
        "\n"
        "知的生物 = t_Man.bmp\n"
        "human = Hachiue01.BMP\n"
        "beast=t_Lord\n"  # 拡張子なし
    )
    n = store.import_index_text(text)
    assert n == 3
    assert store.get_index("知的生物").gra_name == "t_Man"
    assert store.get_index("human").gra_name == "Hachiue01"  # 大文字.BMP除去
    assert store.get_index("beast").gra_name == "t_Lord"


def test_index_export_roundtrip(store):
    store.upsert_index("知的生物", "t_Man")
    store.upsert_index("beast", "t_Lord")
    out = store.export_index_text()
    # 生成 → 取込 で同値復元
    s2 = Store.open(":memory:")
    s2.import_index_text(out)
    assert s2.get_index("知的生物").gra_name == "t_Man"
    assert s2.get_index("beast").gra_name == "t_Lord"
    assert s2.export_index_text() == out
    s2.close()
