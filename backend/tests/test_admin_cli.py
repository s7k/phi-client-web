"""アカウント管理 CLI(app.admin_cli)テスト(A-34)。

ファイル DB で create-account→argon2 保存、grant→is_admin True、revoke→False、
list 出力、アカウント不在/既存で終了コード 1 を検証。
"""
from __future__ import annotations

from app.admin_cli import main
from app.store import Store


def test_create_account_stores_hash(tmp_path):
    db = str(tmp_path / "x.db")
    rc = main(["--db", db, "create-account", "wilt", "password1"])
    assert rc == 0
    s = Store.open(db)
    row = s.get_account("wilt")
    assert row is not None
    # パスワード平文は保存しない(argon2 ハッシュ)。
    assert row["password_hash"] != "password1"
    assert row["password_hash"].startswith("$argon2")
    assert row["is_admin"] == 0
    s.close()


def test_create_account_with_admin_flag(tmp_path):
    db = str(tmp_path / "x.db")
    assert main(["--db", db, "create-account", "wilt", "password1", "--admin"]) == 0
    s = Store.open(db)
    assert s.is_account_admin("wilt") is True
    s.close()


def test_create_account_short_password_fails(tmp_path):
    db = str(tmp_path / "x.db")
    assert main(["--db", db, "create-account", "wilt", "short"]) == 1


def test_create_account_duplicate_fails(tmp_path):
    db = str(tmp_path / "x.db")
    assert main(["--db", db, "create-account", "wilt", "password1"]) == 0
    assert main(["--db", db, "create-account", "wilt", "password2"]) == 1


def test_grant_sets_is_admin(tmp_path):
    db = str(tmp_path / "x.db")
    main(["--db", db, "create-account", "wilt", "password1"])
    rc = main(["--db", db, "grant", "wilt"])
    assert rc == 0
    s = Store.open(db)
    assert s.is_account_admin("wilt") is True
    s.close()


def test_revoke_clears_is_admin(tmp_path):
    db = str(tmp_path / "x.db")
    main(["--db", db, "create-account", "wilt", "password1"])
    assert main(["--db", db, "grant", "wilt"]) == 0
    assert main(["--db", db, "revoke", "wilt"]) == 0
    s = Store.open(db)
    assert s.is_account_admin("wilt") is False
    s.close()


def test_grant_missing_account_returns_1(tmp_path):
    db = str(tmp_path / "x.db")
    Store.open(db).close()  # 空 DB
    rc = main(["--db", db, "grant", "wilt"])
    assert rc == 1


def test_list_outputs_accounts_without_hash(tmp_path, capsys):
    db = str(tmp_path / "x.db")
    main(["--db", db, "create-account", "wilt", "password1"])
    main(["--db", db, "create-account", "alice", "password2"])
    main(["--db", db, "grant", "wilt"])
    capsys.readouterr()  # 既存出力を捨てる
    rc = main(["--db", db, "list"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "wilt" in out
    assert "alice" in out
    assert "admin" in out
    # パスワードハッシュは出さない。
    assert "$argon2" not in out


def test_db_path_from_env(tmp_path, monkeypatch):
    """--db 省略時は env PHI_DB_PATH を使う。"""
    db = str(tmp_path / "env.db")
    main(["--db", db, "create-account", "wilt", "password1"])
    monkeypatch.setenv("PHI_DB_PATH", db)
    rc = main(["grant", "wilt"])
    assert rc == 0
    s = Store.open(db)
    assert s.is_account_admin("wilt") is True
    s.close()
