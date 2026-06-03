/**
 * アセット管理(キャラグラ / マップチップ)。一覧プレビュー + アップロード + 削除。
 *
 * - キャラグラ: 96x160。マップチップ: 入力 1024x96(左右分割)→ 512x96。
 * - 不正寸法/同名は BE が 400/409 を返す → エラー表示。
 * - protected(リポジトリ同梱 seed)は削除ボタンを無効化(BE でも 403)。
 */
import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../stores/uiStore';
import {
  listGraphics,
  listChips,
  uploadGraphic,
  uploadChip,
  deleteGraphic,
  deleteChip,
  type GraphicMeta,
  type ChipMeta,
} from '../../api/assets';

type Kind = 'chara' | 'chip';

export function AssetManager() {
  const openConfirm = useUiStore((s) => s.openConfirm);
  const [kind, setKind] = useState<Kind>('chara');
  const [charas, setCharas] = useState<GraphicMeta[]>([]);
  const [chips, setChips] = useState<ChipMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // アップロードフォーム
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function reload() {
    setBusy(true);
    try {
      if (kind === 'chara') setCharas(await listGraphics());
      else setChips(await listChips());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '一覧取得に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reload();
    // kind 切替で再取得。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('ファイルを選択してください');
      return;
    }
    const n = name.trim();
    if (n === '') {
      setError(kind === 'chara' ? 'グラ名は必須' : 'mapset名は必須');
      return;
    }
    setBusy(true);
    try {
      if (kind === 'chara') await uploadGraphic(file, n);
      else await uploadChip(file, n);
      setName('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'アップロードに失敗しました');
    } finally {
      setBusy(false);
    }
  }

  function handleDelete(displayName: string) {
    openConfirm({
      message: `「${displayName}」を削除しますか?`,
      onConfirm: () => {
        setBusy(true);
        const p = kind === 'chara' ? deleteGraphic(displayName) : deleteChip(displayName);
        void p
          .then(() => reload())
          .catch((err) =>
            setError(err instanceof Error ? err.message : '削除に失敗しました'),
          )
          .finally(() => setBusy(false));
      },
    });
  }

  const items: { name: string; url: string; w: number; h: number; protected: boolean }[] =
    kind === 'chara'
      ? charas.map((g) => ({ name: g.graName, url: g.url, w: g.width, h: g.height, protected: g.protected }))
      : chips.map((c) => ({ name: c.mapset, url: c.url, w: c.width, h: c.height, protected: c.protected }));

  return (
    <div className="asset">
      <div className="asset__kindtabs">
        <button
          type="button"
          className={`asset__kind${kind === 'chara' ? ' asset__kind--active' : ''}`}
          onClick={() => setKind('chara')}
        >
          キャラグラ
        </button>
        <button
          type="button"
          className={`asset__kind${kind === 'chip' ? ' asset__kind--active' : ''}`}
          onClick={() => setKind('chip')}
        >
          マップチップ
        </button>
      </div>

      <form className="asset__form" onSubmit={handleUpload}>
        <label className="asset__field">
          <span>{kind === 'chara' ? 'グラ名' : 'mapset名'}</span>
          <input
            type="text"
            value={name}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === 'chara' ? 't_elf' : 'town'}
          />
        </label>
        <label className="asset__field">
          <span>ファイル</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <p className="asset__hint">
          {kind === 'chara'
            ? '96×160 の透過色(teal)付き画像。'
            : '1024×96 の左右分割(左=画像/右=マスク)画像 → 512×96 へ変換。'}
        </p>
        <button type="submit" className="asset__upload" disabled={busy}>
          アップロード
        </button>
      </form>

      {error && <p className="asset__error" role="alert">{error}</p>}

      <ul className="asset__grid">
        {items.map((it) => (
          <li key={it.name} className="asset__item">
            <img className="asset__preview" src={it.url} alt={it.name} loading="lazy" />
            <span className="asset__name" title={it.name}>{it.name}</span>
            <span className="asset__dim">{it.w}×{it.h}</span>
            {it.protected && <span className="asset__badge">同梱</span>}
            <button
              type="button"
              className="asset__delete"
              disabled={busy || it.protected}
              title={it.protected ? '初期同梱は削除できません' : '削除'}
              onClick={() => handleDelete(it.name)}
            >
              削除
            </button>
          </li>
        ))}
      </ul>
      {items.length === 0 && !busy && <p className="asset__hint">登録なし。</p>}
    </div>
  );
}
