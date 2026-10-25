/**
 * キー操作のヘルプ。上部バーの ? ボタンか ? キーで開き、Esc か背景クリックで閉じる。
 * 一覧は keyHandler の対応表から作る(describeKeys)為、割当を変えると追従する。
 */
import { useEffect } from 'react';
import { describeKeys } from '../lib/keyHandler';
import { keyContextBase, type KeybindSettings } from '../lib/useKeyHandler';
import { useMapStore } from '../stores/mapStore';
import { useSettingsStore, type DisplaySettings } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import './HelpDialog.css';

/** 入力欄・ダイアログでのキー。keyHandler の外で処理している。 */
const INPUT_KEYS = [
  { keys: 'Enter', action: 'チャット欄: 発言する' },
  { keys: 'Ctrl+Enter', action: 'チャット欄: パーティーに発言する' },
  { keys: '↑ / ↓', action: 'チャット欄: 送った発言を呼び戻す' },
  { keys: 'Enter / Shift+Enter', action: '呪文の手書き欄: 唱える / 改行' },
  { keys: 'Enter', action: '1行入力: 送る' },
  { keys: 'Ctrl+Enter', action: '複数行入力(看板など): 送る' },
  { keys: 'Esc', action: '入力ダイアログ: 閉じる' },
  { keys: '?', action: 'このヘルプを開く' },
];

/** マップ上のマウス操作(MapView)。 */
const MOUSE = [
  { keys: 'クリック', action: 'マップ: クリックした方向へ1歩' },
  { keys: '右クリック', action: 'マップ: 攻撃 (hit)' },
  { keys: 'チェック', action: 'リスト: 複数選んでまとめて送る' },
];

export function HelpDialog({ session }: { session: string }) {
  const open = useUiStore((s) => s.helpOpen);
  const setOpen = useUiStore((s) => s.setHelpOpen);
  const keybind = useSettingsStore((s) => s.byScope['keybind'] as KeybindSettings | undefined);
  const display = useSettingsStore((s) => s.byScope['display'] as DisplaySettings | undefined);
  const mapStyle = useMapStore((s) => s.bySession[session]?.style);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const groups = [
    ...describeKeys(keyContextBase(keybind, display, mapStyle)),
    { title: 'マウス', rows: MOUSE },
    { title: '入力欄・ダイアログ', rows: INPUT_KEYS },
  ];

  return (
    <div className="help-overlay" role="dialog" aria-modal="true" aria-label="キー操作" onClick={() => setOpen(false)}>
      <div className="help-box" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <h2>キー操作</h2>
          <button type="button" className="help-close" aria-label="閉じる" onClick={() => setOpen(false)}>
            <i className="bi bi-x-lg" aria-hidden="true" />
          </button>
        </div>
        <p className="help-note">入力欄にカーソルがある間は、移動・行動のキーは効かない。</p>
        <div className="help-groups">
          {groups.map((g) => (
            <section key={g.title} className="help-group">
              <h3>{g.title}</h3>
              <table>
                <tbody>
                  {g.rows.map((r, i) => (
                    <tr key={`${r.keys}-${i}`}>
                      <th><kbd>{r.keys}</kbd></th>
                      <td>{r.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
