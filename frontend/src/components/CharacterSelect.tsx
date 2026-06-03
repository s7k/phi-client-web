/**
 * キャラ選択画面(A-34, ログイン後)。
 *
 * - GET /api/characters でアカウント配下のキャラ一覧を取得し、ラベル+host:port でカード表示。
 * - カードクリックで session.open {charId} → ゲーム画面(activeTab)へ。
 * - 「キャラを追加」フォーム: ラベル + PHI ID + サーバIP + ポート → POST /api/characters → 一覧更新。
 * - 各キャラに削除ボタン(DELETE /api/characters/{charId})。
 * - ログアウトボタン。
 *
 * 注: PHI uid は一覧に含まれず charId で参照。入力した phiId は送信のみ(FE 保持しない)。
 */
import { useEffect, useState } from 'react';
import { useWs } from '../ws/WsContext';
import { useUiStore } from '../stores/uiStore';
import { useAccountStore } from '../stores/accountStore';
import type { Character } from '../api/characters';
import './CharacterSelect.css';

export function CharacterSelect({ onLoggedOut }: { onLoggedOut: () => void }) {
  const ws = useWs();
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const setAdminOpen = useUiStore((s) => s.setAdminOpen);
  const isAdmin = useAccountStore((s) => s.isAdmin);

  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 追加フォーム
  const [label, setLabel] = useState('');
  const [phiId, setPhiId] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  /** 一覧取得(再利用)。 */
  async function reload() {
    setLoading(true);
    try {
      const list = await ws.fetchCharacters();
      setCharacters(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'キャラ一覧の取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // ws は安定参照(Context 経由)。初回のみ取得。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * port 文字列を検証し数値化。1-65535 の整数のみ許可、範囲外/非数値は null。
   */
  function parsePort(raw: string): number | null {
    const t = raw.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
  }

  /** キャラ選択 → session.open(charId) → ゲーム画面へ。 */
  async function handleSelect(c: Character) {
    setError(null);
    setBusy(true);
    try {
      const session = await ws.openSession(c.charId, c.label);
      setActiveTab(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : '接続に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  /** キャラ追加 → 一覧更新。 */
  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (label.trim() === '') {
      setFormError('ラベルは必須');
      return;
    }
    if (phiId.trim() === '') {
      setFormError('PHI IDは必須');
      return;
    }
    if (host.trim() === '') {
      setFormError('サーバIPは必須');
      return;
    }
    const p = parsePort(port);
    if (p === null) {
      setFormError('ポートは1-65535の数値');
      return;
    }
    setBusy(true);
    try {
      await ws.addCharacter({
        label: label.trim(),
        phiId: phiId.trim(),
        host: host.trim(),
        port: p,
      });
      // 入力クリア(phiId は資格情報のため保持しない)。
      setLabel('');
      setPhiId('');
      setHost('');
      setPort('');
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'キャラの追加に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  /** キャラ削除 → 一覧更新。 */
  async function handleDelete(c: Character) {
    setError(null);
    setBusy(true);
    try {
      await ws.removeCharacter(c.charId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'キャラの削除に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  /** ログアウト → ログイン画面へ。 */
  async function handleLogout() {
    setBusy(true);
    try {
      await ws.logout();
    } finally {
      setBusy(false);
      onLoggedOut();
    }
  }

  return (
    <div className="charsel">
      <div className="charsel__card">
        <header className="charsel__header">
          <h1 className="charsel__title">キャラクター選択</h1>
          <div className="charsel__header-actions">
            {isAdmin && (
              <button
                className="charsel__admin"
                type="button"
                onClick={() => setAdminOpen(true)}
                disabled={busy}
              >
                管理画面
              </button>
            )}
            <button
              className="charsel__logout"
              type="button"
              onClick={() => void handleLogout()}
              disabled={busy}
            >
              ログアウト
            </button>
          </div>
        </header>

        {loading && <p className="charsel__hint">読み込み中…</p>}
        {error && <p className="charsel__error" role="alert">{error}</p>}

        {!loading && characters.length === 0 && (
          <p className="charsel__hint">
            登録済みキャラがありません。下のフォームから追加してください。
          </p>
        )}

        {characters.length > 0 && (
          <ul className="charsel__list">
            {characters.map((c) => (
              <li key={c.charId} className="charsel__item">
                <button
                  className="charsel__char"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSelect(c)}
                >
                  <span className="charsel__char-name">{c.label}</span>
                  <span className="charsel__char-server">
                    {c.host}:{c.port}
                  </span>
                </button>
                <button
                  className="charsel__delete"
                  type="button"
                  aria-label={`${c.label} を削除`}
                  disabled={busy}
                  onClick={() => void handleDelete(c)}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}

        <form className="charsel__form" onSubmit={handleAdd}>
          <h2 className="charsel__subtitle">キャラを追加</h2>
          <label className="charsel__field">
            <span>ラベル</span>
            <input
              type="text"
              value={label}
              autoComplete="off"
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="charsel__field">
            <span>PHI ID</span>
            <input
              type="password"
              value={phiId}
              autoComplete="off"
              onChange={(e) => setPhiId(e.target.value)}
            />
          </label>
          <label className="charsel__field">
            <span>サーバIP</span>
            <input
              type="text"
              value={host}
              placeholder="127.0.0.1"
              autoComplete="off"
              onChange={(e) => setHost(e.target.value)}
            />
          </label>
          <label className="charsel__field">
            <span>ポート</span>
            <input
              type="text"
              inputMode="numeric"
              value={port}
              placeholder="20000"
              autoComplete="off"
              onChange={(e) => setPort(e.target.value)}
            />
          </label>
          <button className="charsel__add" type="submit" disabled={busy}>
            追加
          </button>
          {formError && (
            <p className="charsel__error" role="alert">
              {formError}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
