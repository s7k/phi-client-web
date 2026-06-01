/**
 * F3: ログイン + キャラ選択。
 *
 * フロー(実フロー, controller 経由):
 *   1. id/password 入力 → auth(reqIdエコー待ち)
 *   2. 成功でキャラ一覧表示(sessionStore.characters)
 *   3. キャラ選択 → session.open → BE が connection/snapshot 送出 → store反映
 *   4. session 確立で activeTab を切替(App が描画分岐)
 */
import { useState } from 'react';
import { useWs } from '../ws/WsContext';
import { useSessionStore } from '../stores/sessionStore';
import { useUiStore } from '../stores/uiStore';
import './Login.css';

export function Login() {
  const ws = useWs();
  const characters = useSessionStore((s) => s.characters);
  const setActiveTab = useUiStore((s) => s.setActiveTab);

  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<'login' | 'select'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await ws.auth(id, password);
      setPhase('select');
    } catch (err) {
      setError(err instanceof Error ? err.message : '認証失敗');
    } finally {
      setBusy(false);
    }
  }

  async function handleSelect(charId: string) {
    setError(null);
    setBusy(true);
    try {
      const session = await ws.openSession(charId);
      setActiveTab(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'セッション開始失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <h1 className="login__title">phi-web</h1>

        {phase === 'login' && (
          <form className="login__form" onSubmit={handleLogin}>
            <label className="login__field">
              <span>ID</span>
              <input
                type="text"
                value={id}
                autoComplete="username"
                onChange={(e) => setId(e.target.value)}
                required
              />
            </label>
            <label className="login__field">
              <span>パスワード</span>
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="login__submit" type="submit" disabled={busy}>
              {busy ? '認証中…' : 'ログイン'}
            </button>
          </form>
        )}

        {phase === 'select' && (
          <div className="login__chars">
            <h2 className="login__subtitle">キャラクター選択</h2>
            {characters.length === 0 && (
              <p className="login__empty">キャラクターがありません</p>
            )}
            <ul className="login__charlist">
              {characters.map((c) => (
                <li key={c.charId}>
                  <button
                    className="login__char"
                    disabled={busy}
                    onClick={() => handleSelect(c.charId)}
                  >
                    <span className="login__char-name">{c.name}</span>
                    {c.lastServer && (
                      <span className="login__char-server">{c.lastServer}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="login__error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
