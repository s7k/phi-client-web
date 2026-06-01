"""管理者付与 CLI(初期管理者の chicken-and-egg 解消)。

キャラグラ変更系は `accounts.is_admin` で管理者限定([08]§10)。Web 経由では
初期管理者を作れないため、運用者が DB を直接更新する手段を提供する。

使用例
------------------------------------------------------------------
    # 既定 DB(env PHI_DB_PATH)で alice を管理者化
    PHI_DB_PATH=/var/lib/phi/web.db python -m app.admin_cli grant alice

    # 引数で DB パスを明示(env より優先)
    python -m app.admin_cli --db /var/lib/phi/web.db grant alice

    # 管理者剥奪 / 一覧
    python -m app.admin_cli revoke alice
    python -m app.admin_cli list

終了コード: 0 成功 / 1 アカウント不在等の失敗。
"""
from __future__ import annotations

import argparse
import os
import sys

from app.store import Store


def _resolve_db_path(arg_db: str | None) -> str | None:
    """DB パス解決。引数 > env PHI_DB_PATH の優先順。"""
    return arg_db or os.environ.get("PHI_DB_PATH")


def main(argv: list[str] | None = None) -> int:
    """CLI エントリ。終了コードを返す(0=成功 / 1=失敗)。"""
    parser = argparse.ArgumentParser(
        prog="python -m app.admin_cli",
        description="管理者フラグ(accounts.is_admin)の付与/剥奪/一覧。",
    )
    parser.add_argument(
        "--db", default=None,
        help="SQLite DB パス(省略時は env PHI_DB_PATH)。",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_grant = sub.add_parser("grant", help="account を管理者化")
    p_grant.add_argument("account_id")

    p_revoke = sub.add_parser("revoke", help="account の管理者を剥奪")
    p_revoke.add_argument("account_id")

    sub.add_parser("list", help="管理者一覧を表示")

    args = parser.parse_args(argv)
    db_path = _resolve_db_path(args.db)

    store = Store.open(db_path)
    try:
        return _run(store, args)
    finally:
        store.close()


def _run(store: Store, args: argparse.Namespace) -> int:
    if args.command == "list":
        admins = store.list_admins()
        if admins:
            for a in admins:
                print(a)
        else:
            print("(管理者なし)")
        return 0

    account_id = args.account_id
    if store.get_account(account_id) is None:
        print(f"エラー: account 不在: {account_id}", file=sys.stderr)
        return 1

    if args.command == "grant":
        store.set_admin(account_id, True)
        print(f"grant: {account_id} を管理者化")
        return 0

    if args.command == "revoke":
        store.set_admin(account_id, False)
        print(f"revoke: {account_id} の管理者を剥奪")
        return 0

    return 1  # pragma: no cover - argparse required により到達しない


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
