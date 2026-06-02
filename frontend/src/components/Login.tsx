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
import type { SavedListItem } from '../types/protocol';
import { useWs } from '../ws/WsContext';
import { useSessionStore } from '../stores/sessionStore';
import { useUiStore } from '../stores/uiStore';
import { Register } from './Register';
import './Login.css';

export function Login() {
  const ws = useWs();
  const saved = useSessionStore((s) => s.saved);
  const setActiveTab = useUiStore((s) => s.setActiveTab);

  // ログインフォームの前回値を localStorage に記憶し再入力を省く(ユーザー要望)。
  // ID は資格情報だが token 同様 localStorage 保持(同一信頼モデル)。
  const FORM_KEY = 'phi_login_form';
  const savedForm = (() => {
    try {
      return JSON.parse(localStorage.getItem(FORM_KEY) || '{}') as {
        id?: string; host?: string; port?: string;
      };
    } catch {
      return {};
    }
  })();

  const [id, setId] = useState(savedForm.id ?? '');
  const [host, setHost] = useState(savedForm.host ?? '');
  const [port, setPort] = useState(savedForm.port ?? '');
  const [remember, setRemember] = useState(false);

  /** 入力中の ID/IP/ポートを localStorage に保存(次回プリフィル用)。 */
  function rememberForm(idV: string, hostV: string, portV: string) {
    try {
      localStorage.setItem(
        FORM_KEY, JSON.stringify({ id: idV, host: hostV, port: portV }),
      );
    } catch {
      /* localStorage 不可環境は無視 */
    }
  }
  const [phase, setPhase] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 接続先既定値(プレースホルダ表示用)。
  const HOST_PLACEHOLDER = '127.0.0.1';
  const PORT_PLACEHOLDER = '20000';

  /**
   * port 文字列を検証し数値化。
   * 空文字 → undefined(BE既定使用)。1-65535 の整数のみ許可、範囲外/非数値は null。
   */
  function parsePort(raw: string): number | undefined | null {
    const t = raw.trim();
    if (t === '') return undefined;
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
  }

  // 保存済みID一覧を取得(ラベル選択用 picker)。失敗は致命でないため握りつぶす。
  useEffect(() => {
    if (phase !== 'login') return;
    void ws.fetchSavedList().catch(() => {
      /* 一覧取得失敗時は手動入力のみで続行 */
    });
  }, [ws, phase]);

  /** 新規入力 ID でログイン(REST 確立 → session.open(id, host, port))。 */
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const h = host.trim();
    if (h === '') {
      setError('サーバIP(host)は必須');
      return;
    }
    const p = parsePort(port);
    if (p === null) {
      setError('ポートは1-65535の数値');
      return;
    }
    setBusy(true);
    try {
      await ws.establishSession(id, { remember });
      // establishSession 成功で token 保存済。WS auth ゲートが有効化され、
      // 以後の session.open は auth ok 後に送信される(A-33)。
      const session = await ws.openSession({
        id,
        host: h,
        port: p,
        remember,
      });
      rememberForm(id, h, port.trim());  // 次回プリフィル用に記憶
      setActiveTab(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : '認証失敗');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 保存済みラベル選択でログイン(ref で session.open)。生IDは扱わない。
   * 接続先(host/port)は入力欄の現在値を優先し、空ならピッカー項目の保存値を使う。
   */
  async function handleSelectSaved(item: SavedListItem) {
    setError(null);
    const h = host.trim() !== '' ? host.trim() : item.host;
    const p =
      port.trim() !== '' ? parsePort(port) : item.port;
    if (p === null) {
      setError('ポートは1-65535の数値');
      return;
    }
    setBusy(true);
    try {
      const session = await ws.openSession(
        { ref: item.ref, host: h, port: p },
        item.label,
      );
      rememberForm(id, h ?? '', String(p ?? port.trim()));  // 接続先を記憶
      setActiveTab(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログイン失敗');
    } finally {
      setBusy(false);
    }
  }

  /** ピッカー項目クリック: host/port を入力欄へ初期化し、そのまま接続。 */
  function selectSaved(item: SavedListItem) {
    if (item.host !== undefined) setHost(item.host);
    if (item.port !== undefined) setPort(String(item.port));
    void handleSelectSaved(item);
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
                    onClick={() => selectSaved(item)}
                  >
                    <span className="login__char-name">{item.label}</span>
                    {(item.host !== undefined || item.port !== undefined) && (
                      <span className="login__char-server">
                        {item.host ?? HOST_PLACEHOLDER}
                        {item.port !== undefined ? `:${item.port}` : ''}
                      </span>
                    )}
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
          <label className="login__field">
            <span>サーバIP</span>
            <input
              type="text"
              value={host}
              placeholder={HOST_PLACEHOLDER}
              autoComplete="off"
              onChange={(e) => setHost(e.target.value)}
            />
          </label>
          <label className="login__field">
            <span>ポート</span>
            <input
              type="text"
              inputMode="numeric"
              value={port}
              placeholder={PORT_PLACEHOLDER}
              autoComplete="off"
              onChange={(e) => setPort(e.target.value)}
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
