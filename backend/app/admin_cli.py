"""アカウント管理 CLI(アカウント+複数キャラ, A-34, [12]§1)。

Web 経由では初期管理者を作れないため、運用者が CLI でアカウントを作成/管理する。
パスワードは argon2id でハッシュ化して `accounts` に保存。キャラグラ変更系は
`accounts.is_admin` で管理者限定([08]§10)。

使用例
------------------------------------------------------------------
    # 初期管理者アカウント作成(--admin で管理者化)
    PHI_DB_PATH=/var/lib/phi/web.db \
        python -m app.admin_cli create-account wilt 's3cretpw' --admin

    # 既存アカウントを管理者化 / 剥奪
    python -m app.admin_cli grant wilt
    python -m app.admin_cli revoke wilt

    # 一覧(account_id/admin。password_hash は表示しない)
    python -m app.admin_cli list

注意: パスワードは標準出力/エラーに出さない(資格情報)。引数で渡した
パスワードもコマンド履歴に残らないよう運用側で配慮する。

終了コード: 0 成功 / 1 アカウント不在/既存等の失敗。
"""
from __future__ import annotations

import argparse
import os
import sys

from app.auth import AuthService
from app.store import Store


def _resolve_db_path(arg_db: str | None) -> str | None:
    """DB パス解決。引数 > env PHI_DB_PATH の優先順。"""
    return arg_db or os.environ.get("PHI_DB_PATH")


def main(argv: list[str] | None = None) -> int:
    """CLI エントリ。終了コードを返す(0=成功 / 1=失敗)。"""
    parser = argparse.ArgumentParser(
        prog="python -m app.admin_cli",
        description="アカウント(accounts)の作成/管理者付与/剥奪/一覧。",
    )
    parser.add_argument(
        "--db", default=None,
        help="SQLite DB パス(省略時は env PHI_DB_PATH)。",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser(
        "create-account", help="アカウント作成(argon2 ハッシュ保存)"
    )
    p_create.add_argument("account_id")
    p_create.add_argument("password")
    p_create.add_argument(
        "--admin", action="store_true", help="同時に管理者化する"
    )

    p_grant = sub.add_parser("grant", help="アカウントを管理者化(無ければ要 create)")
    p_grant.add_argument("account_id")

    p_revoke = sub.add_parser("revoke", help="アカウントの管理者を剥奪")
    p_revoke.add_argument("account_id")

    sub.add_parser("list", help="アカウント一覧(account_id/admin)を表示")

    args = parser.parse_args(argv)
    db_path = _resolve_db_path(args.db)

    store = Store.open(db_path)
    try:
        return _run(store, args)
    finally:
        store.close()


def _run(store: Store, args: argparse.Namespace) -> int:
    if args.command == "list":
        rows = store.list_accounts()
        if rows:
            for r in rows:
                flag = "admin" if r["is_admin"] else "-"
                # password_hash は出さない。account_id / フラグのみ。
                print(f"{r['account_id']}  {flag}")
        else:
            print("(アカウントなし)")
        return 0

    if args.command == "create-account":
        auth = AuthService(store)  # cipher は未使用(create-account では不要)
        try:
            auth.register(args.account_id, args.password, is_admin=args.admin)
        except ValueError as exc:
            if str(exc) == "account exists":
                print("エラー: アカウントは既に存在", file=sys.stderr)
            else:
                print(f"エラー: {exc}", file=sys.stderr)
            return 1
        suffix = " (admin)" if args.admin else ""
        print(f"create-account: {args.account_id} を作成{suffix}")
        return 0

    # grant / revoke は既存アカウントを対象。
    if store.get_account(args.account_id) is None:
        print("エラー: アカウント不在(先に create-account で作成)", file=sys.stderr)
        return 1

    if args.command == "grant":
        store.set_account_admin(args.account_id, True)
        print(f"grant: {args.account_id} を管理者化")
        return 0

    if args.command == "revoke":
        store.set_account_admin(args.account_id, False)
        print(f"revoke: {args.account_id} の管理者を剥奪")
        return 0

    return 1  # pragma: no cover - argparse required により到達しない


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
