/**
 * ログイン画面(A-34, アカウント+複数キャラ構造)。
 *
 * アカウントID + パスワードでログイン。成功で token を localStorage 保存(controller 経由)し、
 * onLoggedIn を呼んでキャラ選択画面へ遷移する。
 * 「新規登録」リンクでアカウント登録フォーム(ID+パスワード+確認入力)へ切替。
 *
 * 注: パスワードは保存しない(フォーム記憶はアカウントID のみ, ユーザー要望)。
 *     password は資格情報のためログ出力しない。
 */
import { useState } from 'react';
import { useWs } from '../ws/WsContext';
import './Login.css';

/** アカウントID を記憶する localStorage キー(パスワードは保存しない)。 */
const ACCOUNT_KEY = 'phi_login_account';

function loadAccountId(): string {
  try {
    return localStorage.getItem(ACCOUNT_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveAccountId(accountId: string): void {
  try {
    localStorage.setItem(ACCOUNT_KEY, accountId);
  } catch {
    /* localStorage 不可環境は無視 */
  }
}

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const ws = useWs();
  const [phase, setPhase] = useState<'login' | 'register'>('login');

  const [accountId, setAccountId] = useState(loadAccountId);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** ログイン送信。成功で onLoggedIn(キャラ選択へ)。 */
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (accountId.trim() === '') {
      setError('アカウントIDは必須');
      return;
    }
    if (password === '') {
      setError('パスワードは必須');
      return;
    }
    setBusy(true);
    try {
      await ws.login(accountId.trim(), password);
      saveAccountId(accountId.trim());
      setPassword('');
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログインに失敗しました');
    } finally {
      setBusy(false);
    }
  }

  /** 新規登録送信。成功でログイン画面へ戻し案内表示。 */
  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (accountId.trim() === '') {
      setError('アカウントIDは必須');
      return;
    }
    if (password === '') {
      setError('パスワードは必須');
      return;
    }
    if (password !== passwordConfirm) {
      setError('パスワードが一致しません');
      return;
    }
    setBusy(true);
    try {
      await ws.register(accountId.trim(), password);
      saveAccountId(accountId.trim());
      setPassword('');
      setPasswordConfirm('');
      setPhase('login');
      setNotice('アカウントを登録しました。ログインしてください。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'register') {
    return (
      <div className="login">
        <div className="login__card">
          <h1 className="login__title">アカウント登録</h1>
          <form className="login__form" onSubmit={handleRegister}>
            <label className="login__field">
              <span>アカウントID</span>
              <input
                type="text"
                value={accountId}
                autoComplete="username"
                onChange={(e) => setAccountId(e.target.value)}
              />
            </label>
            <label className="login__field">
              <span>パスワード</span>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="login__field">
              <span>パスワード(確認)</span>
              <input
                type="password"
                aria-label="パスワード(確認)"
                value={passwordConfirm}
                autoComplete="new-password"
                onChange={(e) => setPasswordConfirm(e.target.value)}
              />
            </label>
            <button className="login__submit" type="submit" disabled={busy}>
              {busy ? '登録中…' : '登録'}
            </button>
            <button
              className="login__link"
              type="button"
              onClick={() => {
                setError(null);
                setNotice(null);
                setPasswordConfirm('');
                setPhase('login');
              }}
            >
              ログインへ戻る
            </button>
          </form>
          {error && <p className="login__error" role="alert">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <div className="login__card">
        <h1 className="login__title">phi-client-web</h1>

        {notice && (
          <p className="login__notice" role="status">
            {notice}
          </p>
        )}

        <form className="login__form" onSubmit={handleLogin}>
          <label className="login__field">
            <span>アカウントID</span>
            <input
              type="text"
              value={accountId}
              autoComplete="username"
              onChange={(e) => setAccountId(e.target.value)}
            />
          </label>
          <label className="login__field">
            <span>パスワード</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className="login__submit" type="submit" disabled={busy}>
            {busy ? '認証中…' : 'ログイン'}
          </button>
          <button
            className="login__link"
            type="button"
            onClick={() => {
              setError(null);
              setNotice(null);
              setPassword('');
              setPasswordConfirm('');
              setPhase('register');
            }}
          >
            新規登録
          </button>
        </form>

        {error && <p className="login__error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
