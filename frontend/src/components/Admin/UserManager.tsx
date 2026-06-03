/**
 * ユーザ管理(管理者限定)。一覧 + 管理者付与/剥奪 + パスワード強制変更 + 削除。
 *
 * 安全弁(自己/最後の管理者保護)は BE が 400 で返す → エラー表示する。
 * 強制PW変更/削除/管理者剥奪は対象ユーザのセッションを失効させる(BE)。
 */
import { useEffect, useState } from 'react';
import { useUiStore } from '../../stores/uiStore';
import {
  listAccounts,
  setAdmin,
  forcePassword,
  deleteAccount,
  type AdminAccount,
} from '../../api/admin';

export function UserManager() {
  const openConfirm = useUiStore((s) => s.openConfirm);
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    setBusy(true);
    try {
      setAccounts(await listAccounts());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '一覧取得に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function run(p: Promise<unknown>, okMsg?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    void p
      .then(() => {
        if (okMsg) setNotice(okMsg);
        return reload();
      })
      .catch((err) => setError(err instanceof Error ? err.message : '操作に失敗しました'))
      .finally(() => setBusy(false));
  }

  function handleToggleAdmin(a: AdminAccount) {
    run(setAdmin(a.accountId, !a.isAdmin));
  }

  function handleForcePassword(a: AdminAccount) {
    // prompt は最小実装(資格情報なので保持しない)。
    const pw = window.prompt(`「${a.accountId}」の新しいパスワード(8文字以上)`);
    if (pw == null) return;
    run(forcePassword(a.accountId, pw), `${a.accountId} のパスワードを変更しました`);
  }

  function handleDelete(a: AdminAccount) {
    openConfirm({
      message: `アカウント「${a.accountId}」を削除しますか?(キャラも全削除)`,
      onConfirm: () => run(deleteAccount(a.accountId), `${a.accountId} を削除しました`),
    });
  }

  return (
    <div className="users">
      {error && <p className="asset__error" role="alert">{error}</p>}
      {notice && <p className="users__notice">{notice}</p>}

      <table className="users__table">
        <thead>
          <tr>
            <th>アカウント</th>
            <th>権限</th>
            <th>キャラ数</th>
            <th>作成日時</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.accountId}>
              <td>{a.accountId}</td>
              <td>{a.isAdmin ? '管理者' : '一般'}</td>
              <td>{a.charCount}</td>
              <td className="users__date">{a.createdAt}</td>
              <td className="users__actions">
                <button type="button" disabled={busy} onClick={() => handleToggleAdmin(a)}>
                  {a.isAdmin ? '管理者剥奪' : '管理者付与'}
                </button>
                <button type="button" disabled={busy} onClick={() => handleForcePassword(a)}>
                  PW変更
                </button>
                <button type="button" disabled={busy} onClick={() => handleDelete(a)}>
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {accounts.length === 0 && !busy && <p className="asset__hint">アカウントなし。</p>}
    </div>
  );
}
