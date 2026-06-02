"""保存ID管理 CLI(app.admin_cli)テスト(ID-only)。

ファイル DB で add→暗号保存、grant→is_admin True、revoke→False、list 出力、
保存ID不在で終了コード 1 を検証。ID 暗号鍵は PHI_SECRET_KEY。
"""
from __future__ import annotations

import pytest

from app.admin_cli import main
from app.auth import UidCipher
from app.store import Store
from app.store.db import id_key_of


@pytest.fixture(autouse=True)
def _secret_key(monkeypatch):
    monkeypatch.setenv("PHI_SECRET_KEY", UidCipher.generate_key().decode())


def test_add_stores_encrypted(tmp_path):
    db = str(tmp_path / "x.db")
    rc = main(["--db", db, "add", "PHI_ID_1", "メイン"])
    assert rc == 0
    s = Store.open(db)
    row = s.get_saved_id(id_key_of("PHI_ID_1"))
    assert row is not None
    assert row["label"] == "メイン"
    assert row["id_enc"] != b"PHI_ID_1"  # 暗号保存(生ID非保持)
    assert row["is_admin"] == 0
    s.close()


def test_add_with_host_port(tmp_path):
    """A-32: add --host/--port で接続先も保存。"""
    db = str(tmp_path / "x.db")
    rc = main(["--db", db, "add", "PHI_ID_1", "メイン",
               "--host", "h.example", "--port", "9100"])
    assert rc == 0
    s = Store.open(db)
    row = s.get_saved_id(id_key_of("PHI_ID_1"))
    assert row["host"] == "h.example"
    assert row["port"] == 9100
    s.close()


def test_add_with_admin_flag(tmp_path):
    db = str(tmp_path / "x.db")
    assert main(["--db", db, "add", "PHI_ID_1", "--admin"]) == 0
    s = Store.open(db)
    assert s.is_saved_admin(id_key_of("PHI_ID_1")) is True
    s.close()


def test_grant_sets_is_admin(tmp_path):
    db = str(tmp_path / "x.db")
    main(["--db", db, "add", "PHI_ID_1"])
    rc = main(["--db", db, "grant", "PHI_ID_1"])
    assert rc == 0
    s = Store.open(db)
    assert s.is_saved_admin(id_key_of("PHI_ID_1")) is True
    s.close()


def test_revoke_clears_is_admin(tmp_path):
    db = str(tmp_path / "x.db")
    main(["--db", db, "add", "PHI_ID_1"])
    assert main(["--db", db, "grant", "PHI_ID_1"]) == 0
    assert main(["--db", db, "revoke", "PHI_ID_1"]) == 0
    s = Store.open(db)
    assert s.is_saved_admin(id_key_of("PHI_ID_1")) is False
    s.close()


def test_grant_missing_saved_id_returns_1(tmp_path):
    db = str(tmp_path / "x.db")
    Store.open(db).close()  # 空 DB
    rc = main(["--db", db, "grant", "PHI_ID_1"])
    assert rc == 1


def test_list_outputs_admins_without_raw_id(tmp_path, capsys):
    db = str(tmp_path / "x.db")
    main(["--db", db, "add", "PHI_ID_1", "alice"])
    main(["--db", db, "add", "PHI_ID_2", "bob"])
    main(["--db", db, "grant", "PHI_ID_1"])
    capsys.readouterr()  # 既存出力を捨てる
    rc = main(["--db", db, "list"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "alice" in out  # ラベルは表示
    assert "admin" in out
    # 生IDは出さない(資格情報)。
    assert "PHI_ID_1" not in out
    assert "PHI_ID_2" not in out


def test_db_path_from_env(tmp_path, monkeypatch):
    """--db 省略時は env PHI_DB_PATH を使う。"""
    db = str(tmp_path / "env.db")
    main(["--db", db, "add", "PHI_ID_1"])
    monkeypatch.setenv("PHI_DB_PATH", db)
    rc = main(["grant", "PHI_ID_1"])
    assert rc == 0
    s = Store.open(db)
    assert s.is_saved_admin(id_key_of("PHI_ID_1")) is True
    s.close()
