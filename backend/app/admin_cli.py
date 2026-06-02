"""保存ID管理 CLI(ID-only 認証, [12]§1)。

PHI ID は資格情報。SQLite には id_key=sha256(id) と暗号化 id_enc を保存する
(`saved_ids`)。キャラグラ変更系は `saved_ids.is_admin` で管理者限定([08]§10)。
Web 経由では初期管理者を作れないため、運用者が CLI で保存IDを登録/管理する。

ID 暗号鍵は env `PHI_SECRET_KEY`(Fernet 鍵)。`add`/`grant`(新規)で必須。

使用例
------------------------------------------------------------------
    # ID を保存(暗号化)。ラベル任意。
    PHI_SECRET_KEY=... PHI_DB_PATH=/var/lib/phi/web.db \
        python -m app.admin_cli add "<PHI_ID>" "メインID"

    # 既存保存IDを管理者化 / 剥奪(ID を引数, 内部で id_key 算出)
    python -m app.admin_cli grant "<PHI_ID>"
    python -m app.admin_cli revoke "<PHI_ID>"

    # 一覧(id_key/label/admin。生IDは表示しない)
    python -m app.admin_cli list

注意: ID は標準出力/エラーに出さない(資格情報)。引数で渡した ID も
コマンド履歴に残らないよう運用側で配慮する。

終了コード: 0 成功 / 1 保存ID不在等の失敗。
"""
from __future__ import annotations

import argparse
import os
import sys

from app.auth import UidCipher
from app.store import Store
from app.store.db import id_key_of


def _resolve_db_path(arg_db: str | None) -> str | None:
    """DB パス解決。引数 > env PHI_DB_PATH の優先順。"""
    return arg_db or os.environ.get("PHI_DB_PATH")


def main(argv: list[str] | None = None) -> int:
    """CLI エントリ。終了コードを返す(0=成功 / 1=失敗)。"""
    parser = argparse.ArgumentParser(
        prog="python -m app.admin_cli",
        description="保存ID(saved_ids)の登録/管理者付与/剥奪/一覧。",
    )
    parser.add_argument(
        "--db", default=None,
        help="SQLite DB パス(省略時は env PHI_DB_PATH)。",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="ID を暗号保存(saved_ids へ upsert)")
    p_add.add_argument("phi_id")
    p_add.add_argument("label", nargs="?", default=None)
    p_add.add_argument(
        "--admin", action="store_true", help="同時に管理者化する"
    )
    p_add.add_argument(
        "--host", default=None, help="接続先ホスト(A-32, 省略時サーバ既定)"
    )
    p_add.add_argument(
        "--port", type=int, default=None, help="接続先ポート(A-32, 省略時サーバ既定)"
    )

    p_grant = sub.add_parser("grant", help="保存IDを管理者化(無ければ要 add)")
    p_grant.add_argument("phi_id")

    p_revoke = sub.add_parser("revoke", help="保存IDの管理者を剥奪")
    p_revoke.add_argument("phi_id")

    sub.add_parser("list", help="保存ID一覧(id_key/label/admin)を表示")

    args = parser.parse_args(argv)
    db_path = _resolve_db_path(args.db)

    store = Store.open(db_path)
    try:
        return _run(store, args)
    finally:
        store.close()


def _run(store: Store, args: argparse.Namespace) -> int:
    if args.command == "list":
        rows = store.list_saved_ids()
        if rows:
            for r in rows:
                flag = "admin" if r["is_admin"] else "-"
                label = r["label"] or ""
                # 生IDは出さない。id_key(短縮)/label/フラグのみ。
                print(f"{r['id_key'][:16]}…  {flag}  {label}")
        else:
            print("(保存IDなし)")
        return 0

    if args.command == "add":
        cipher = UidCipher()  # PHI_SECRET_KEY 必須
        key = id_key_of(args.phi_id)
        enc = cipher.encrypt(args.phi_id)
        store.upsert_saved_id(
            key, enc, label=args.label,
            is_admin=True if args.admin else None,
            host=args.host, port=args.port,
        )
        suffix = " (admin)" if args.admin else ""
        print(f"add: 保存ID登録 id_key={key[:16]}…{suffix}")
        return 0

    # grant / revoke は既存保存ID(id_key)を対象。
    key = id_key_of(args.phi_id)
    if store.get_saved_id(key) is None:
        print("エラー: 保存ID不在(先に add で登録)", file=sys.stderr)
        return 1

    if args.command == "grant":
        store.set_saved_admin(key, True)
        print(f"grant: id_key={key[:16]}… を管理者化")
        return 0

    if args.command == "revoke":
        store.set_saved_admin(key, False)
        print(f"revoke: id_key={key[:16]}… の管理者を剥奪")
        return 0

    return 1  # pragma: no cover - argparse required により到達しない


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
