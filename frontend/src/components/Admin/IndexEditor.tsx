/**
 * キャラ名 ↔ グラ名 紐付け編集(chara_index)。登録/編集/削除。
 *
 * key(キャラ名/カテゴリ)→ graName(解決先グラ名)を upsert。
 * グラ名はアセット一覧から候補補完(datalist)。変更系は BE で管理者限定。
 */
import { useEffect, useState } from 'react';
import { useUiStore } from '../../stores/uiStore';
import {
  listIndex,
  listGraphics,
  putIndex,
  deleteIndex,
  type IndexEntry,
} from '../../api/assets';

export function IndexEditor() {
  const openConfirm = useUiStore((s) => s.openConfirm);
  const [entries, setEntries] = useState<IndexEntry[]>([]);
  const [graNames, setGraNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [key, setKey] = useState('');
  const [graName, setGraName] = useState('');

  async function reload() {
    setBusy(true);
    try {
      const [idx, gras] = await Promise.all([listIndex(), listGraphics()]);
      setEntries(idx);
      setGraNames(gras.map((g) => g.graName));
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

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (key.trim() === '' || graName.trim() === '') {
      setError('キャラ名とグラ名は必須');
      return;
    }
    setBusy(true);
    try {
      await putIndex(key.trim(), graName.trim());
      setKey('');
      setGraName('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  function handleEdit(en: IndexEntry) {
    setKey(en.key);
    setGraName(en.graName);
  }

  function handleDelete(en: IndexEntry) {
    openConfirm({
      message: `紐付け「${en.key} → ${en.graName}」を削除しますか?`,
      onConfirm: () => {
        setBusy(true);
        void deleteIndex(en.key)
          .then(() => reload())
          .catch((err) =>
            setError(err instanceof Error ? err.message : '削除に失敗しました'),
          )
          .finally(() => setBusy(false));
      },
    });
  }

  return (
    <div className="idx">
      <form className="idx__form" onSubmit={handleSave}>
        <label className="asset__field">
          <span>キャラ名 / カテゴリ</span>
          <input
            type="text"
            value={key}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            placeholder="戦士"
          />
        </label>
        <label className="asset__field">
          <span>グラ名</span>
          <input
            type="text"
            list="idx-granames"
            value={graName}
            autoComplete="off"
            onChange={(e) => setGraName(e.target.value)}
            placeholder="t_elf"
          />
          <datalist id="idx-granames">
            {graNames.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <button type="submit" className="asset__upload" disabled={busy}>
          登録 / 更新
        </button>
      </form>

      {error && <p className="asset__error" role="alert">{error}</p>}

      <table className="idx__table">
        <thead>
          <tr>
            <th>キャラ名</th>
            <th>グラ名</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((en) => (
            <tr key={en.key}>
              <td>{en.key}</td>
              <td>{en.graName}</td>
              <td className="idx__actions">
                <button type="button" disabled={busy} onClick={() => handleEdit(en)}>
                  編集
                </button>
                <button type="button" disabled={busy} onClick={() => handleDelete(en)}>
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {entries.length === 0 && !busy && <p className="asset__hint">紐付けなし。</p>}
    </div>
  );
}
