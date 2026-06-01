/**
 * F9: リストモードUI([05]§5, [07]§6.7)。
 * - modeStore.list が active かつ listStore に項目があるとき表示。
 * - 項目を番号付きで表示。クリック/番号で list.select(数値)。
 * - 全選択(+)・キャンセル(. / Esc)ボタン。
 * - 数字キー・Esc は useKeyHandler 側でも解決(本UIはクリック操作用)。
 */
import { useWs } from '../ws/WsContext';
import { useListStore } from '../stores/listStore';
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

  if (!list?.active) return null;

  const lines = list.lines ?? [];

  return (
    <div className="listview" role="listbox" aria-label="選択リスト">
      <ul className="listview__items">
        {lines.map((line, i) => {
          const { num, label } = stripLeadingNumber(line);
          const value = num ?? i + 1;
          return (
            <li key={i}>
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
