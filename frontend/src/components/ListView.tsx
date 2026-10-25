/**
 * F9: リストモードUI([05]§5, [07]§6.7)。
 * - modeStore.list が active かつ listStore に項目があるとき表示。
 * - 項目を番号付きで表示。クリック/番号で list.select(数値)。
 * - 全選択(+)・キャンセル(. / Esc)ボタン。
 * - 数字キー・Esc は useKeyHandler 側でも解決(本UIはクリック操作用)。
 * - cast 中(mode.magic)は呪文の手書き欄を出す。サーバは次の1行を番号か呪文として読む為、
 *   一覧に無い呪文やコマンド魔法(appear↵golem 等の複数行)を command raw で送る。
 */
import { useState } from 'react';
import { useWs } from '../ws/WsContext';
import { useListStore } from '../stores/listStore';
import { useModeStore } from '../stores/modeStore';
import './ListView.css';

/** 行頭の "<n>:" や "<n>." を剥がして表示名のみにする(番号はUIが付与)。 */
function stripLeadingNumber(line: string): { num: number | null; label: string } {
  const m = /^\s*(\d+)\s*[:.)]\s*(.*)$/.exec(line);
  if (m) return { num: Number(m[1]), label: m[2] };
  return { num: null, label: line };
}

export function ListView({ session }: { session: string }) {
  const ws = useWs();
  const list = useListStore((s) => s.bySession[session]);
  const magic = useModeStore((s) => s.bySession[session]?.magic ?? false);
  const [spell, setSpell] = useState('');

  if (!list?.active) return null;

  function castSpell() {
    const text = spell.replace(/\n+$/, '');
    if (!text.trim()) return;
    ws.sendCommand(session, { name: 'raw', text });
    setSpell('');
  }

  const lines = list.lines ?? [];

  return (
    <div className="listview" role="listbox" aria-label="選択リスト">
      <ul className="listview__items">
        {lines.map((line, i) => {
          const { num, label } = stripLeadingNumber(line);
          const value = num ?? i + 1;
          return (
            <li key={`${i}:${line}`}>
              <button
                type="button"
                className="listview__item"
                role="option"
                aria-selected={false}
                onClick={() => ws.sendListSelect(session, value)}
              >
                <span className="listview__num">{value}</span>
                <span className="listview__label">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {magic && (
        <div className="listview__spell">
          <textarea
            className="listview__spell-input"
            aria-label="呪文"
            placeholder="呪文を手書き (Enterで詠唱 / Shift+Enterで改行)"
            rows={2}
            autoFocus
            value={spell}
            onChange={(e) => setSpell(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                castSpell();
              }
            }}
          />
          <button
            type="button"
            className="listview__spell-cast"
            disabled={!spell.trim()}
            onClick={castSpell}
          >
            詠唱
          </button>
        </div>
      )}
      <div className="listview__actions">
        <button
          type="button"
          className="listview__all"
          onClick={() => ws.sendListSelect(session, 'all')}
        >
          全選択 (+)
        </button>
        <button
          type="button"
          className="listview__cancel"
          onClick={() => ws.sendListSelect(session, 'cancel')}
        >
          キャンセル (Esc)
        </button>
      </div>
    </div>
  );
}
