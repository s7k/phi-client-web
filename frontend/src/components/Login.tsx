/**
 * F3: ログイン(ID-only 再設計)。
 *
 * 背景: PHI は ID のみで識別、ID 自体が資格情報。Web 側の別パスワードは廃止。
 *
 * フロー(controller 経由):
 *   1. PHI ID 入力(+「保存する」任意) もしくは 保存済みラベルから選択(ref)。
 *   2. establishSession(id) で REST セッション確立(cookie 発行)。
 *      保存選択(ref)時は establishSession を経ず session.open(ref) のみ
 *      (cookie/ref が BE 側資格を担保)。
 *   3. openSession({id|ref}) → BE が connection/snapshot 送出 → store 反映。
 *   4. session 確立で activeTab を切替(App が描画分岐)。
 *
 * 注: PHI ID は資格情報。input は type=password で画面マスク(任意配慮)。ログ出力しない。
 */
import { useEffect, useState } from 'react';
import { useWs } from '../ws/WsContext';
import { useSessionStore } from '../stores/sessionStore';
import { useUiStore } from '../stores/uiStore';
import { Register } from './Register';
import './Login.css';

export function Login() {
  const ws = useWs();
  const saved = useSessionStore((s) => s.saved);
  const setActiveTab = useUiStore((s) => s.setActiveTab);

  const [id, setId] = useState('');
  const [remember, setRemember] = useState(false);
  const [phase, setPhase] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 保存済みID一覧を取得(ラベル選択用 picker)。失敗は致命でないため握りつぶす。
  useEffect(() => {
    if (phase !== 'login') return;
    void ws.fetchSavedList().catch(() => {
      /* 一覧取得失敗時は手動入力のみで続行 */
    });
  }, [ws, phase]);

  /** 新規入力 ID でログイン(REST 確立 → session.open(id))。 */
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await ws.establishSession(id, { remember });
      const session = await ws.openSession({ id });
      setActiveTab(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : '認証失敗');
    } finally {
      setBusy(false);
    }
  }

  /** 保存済みラベル選択でログイン(ref で session.open)。生IDは扱わない。 */
  async function handleSelectSaved(ref: string, label: string) {
    setError(null);
    setBusy(true);
    try {
      const session = await ws.openSession({ ref }, label);
      setActiveTab(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログイン失敗');
    } finally {
      setBusy(false);
    }
  }

  // 登録画面は専用コンポーネントへ委譲。成功でログインへ戻し、案内を表示。
  if (phase === 'register') {
    return (
      <Register
        onRegistered={(name) => {
          setPhase('login');
          setNotice(`「${name}」を登録しました。PHI ID でログインしてください。`);
        }}
        onCancel={() => setPhase('login')}
      />
    );
  }

  return (
    <div className="login">
      <div className="login__card">
        <h1 className="login__title">phi-web</h1>

        {notice && (
          <p className="login__notice" role="status">
            {notice}
          </p>
        )}

        {saved.length > 0 && (
          <div className="login__chars">
            <h2 className="login__subtitle">保存済みID</h2>
            <ul className="login__charlist">
              {saved.map((item) => (
                <li key={item.ref}>
                  <button
                    className="login__char"
                    type="button"
                    disabled={busy}
                    onClick={() => handleSelectSaved(item.ref, item.label)}
                  >
                    <span className="login__char-name">{item.label}</span>
                    {item.isAdmin && (
                      <span className="login__char-server">管理者</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <form className="login__form" onSubmit={handleLogin}>
          <label className="login__field">
            <span>PHI ID</span>
            <input
              type="password"
              value={id}
              autoComplete="off"
              onChange={(e) => setId(e.target.value)}
              required
            />
          </label>
          <label className="login__remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>このIDを保存する</span>
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
              setPhase('register');
            }}
          >
            新規キャラクター作成
          </button>
        </form>

        {error && <p className="login__error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
