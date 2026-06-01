"""管理者付与 CLI(app.admin_cli)テスト。

ファイル DB で grant→is_admin True、revoke→False、list 出力、
account 不在で終了コード 1 を検証。
"""
from __future__ import annotations

from app.admin_cli import main
from app.store import Store


def _seed(db_path: str, *account_ids: str) -> None:
    s = Store.open(db_path)
    for a in account_ids:
        s.create_account(a, "h")
    s.close()


def test_grant_sets_is_admin(tmp_path):
    db = str(tmp_path / "x.db")
    _seed(db, "alice")
    rc = main(["--db", db, "grant", "alice"])
    assert rc == 0
    s = Store.open(db)
    assert s.is_account_admin("alice") is True
    s.close()


def test_revoke_clears_is_admin(tmp_path):
    db = str(tmp_path / "x.db")
    _seed(db, "alice")
    assert main(["--db", db, "grant", "alice"]) == 0
    assert main(["--db", db, "revoke", "alice"]) == 0
    s = Store.open(db)
    assert s.is_account_admin("alice") is False
    s.close()


def test_grant_missing_account_returns_1(tmp_path):
    db = str(tmp_path / "x.db")
    _seed(db)  # account 無し
    rc = main(["--db", db, "grant", "nobody"])
    assert rc == 1


def test_list_outputs_admins(tmp_path, capsys):
    db = str(tmp_path / "x.db")
    _seed(db, "alice", "bob")
    main(["--db", db, "grant", "alice"])
    capsys.readouterr()  # grant 出力を捨てる
    rc = main(["--db", db, "list"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "alice" in out
    assert "bob" not in out


def test_db_path_from_env(tmp_path, monkeypatch):
    """--db 省略時は env PHI_DB_PATH を使う。"""
    db = str(tmp_path / "env.db")
    _seed(db, "alice")
    monkeypatch.setenv("PHI_DB_PATH", db)
    rc = main(["grant", "alice"])
    assert rc == 0
    s = Store.open(db)
    assert s.is_account_admin("alice") is True
    s.close()
