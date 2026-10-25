/**
 * 操作ボタン群。
 * - CommandBar(上部バー): 接続/切断トグル、ログ保存、キー操作ヘルプ。
 * - GameCommands(チャット入力欄の上): 頻繁に使う特殊コマンド(cast/spells/wizeye/wizlist/check)を
 *   command raw で送る。cast はサーバが #list(習得呪文)を返し、ListView の手書き欄で唱える。
 */
import { useWs } from '../ws/WsContext';
import { useConnectionStore } from '../stores/connectionStore';
import { useUiStore } from '../stores/uiStore';
import { useChatStore } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { saveLog } from '../lib/logExport';
import './CommandBar.css';

const COMMANDS: { text: string; icon: string; label: string }[] = [
  { text: 'cast', icon: 'bi-magic', label: '魔法を唱える (cast)' },
  { text: 'spells', icon: 'bi-book', label: '呪文一覧 (spells)' },
  { text: 'wizeye', icon: 'bi-eye', label: 'ウィザードアイ (wizeye)' },
  { text: 'wizlist', icon: 'bi-people', label: 'ウィザード一覧 (wizlist)' },
  { text: 'check', icon: 'bi-search', label: '調べる (check)' },
];

/** 特殊コマンドのボタン列。チャット入力欄の上に置く。 */
export function GameCommands({ session }: { session: string }) {
  const ws = useWs();
  const closed = useConnectionStore((s) => (s.sessions[session] ?? 'connecting') === 'closed');
  return (
    <div className="cmdbar" role="toolbar" aria-label="ゲームコマンド">
      {COMMANDS.map((c) => (
        <button
          key={c.text}
          type="button"
          className="cmdbar__btn"
          title={c.label}
          aria-label={c.label}
          disabled={closed}
          onClick={() => ws.sendCommand(session, { name: 'raw', text: c.text })}
        >
          <i className={`bi ${c.icon}`} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

export function CommandBar({ session }: { session: string }) {
  const ws = useWs();
  const state = useConnectionStore((s) => s.sessions[session] ?? 'connecting');
  const closed = state === 'closed';

  return (
    <div className="cmdbar" role="toolbar" aria-label="コマンド">
      <button
        type="button"
        className={`cmdbar__btn cmdbar__conn${closed ? '' : ' cmdbar__conn--on'}`}
        title={closed ? '接続' : '切断'}
        aria-label={closed ? '接続' : '切断'}
        aria-pressed={!closed}
        onClick={() =>
          closed ? void ws.reopenSession(session) : ws.closeSession(session)
        }
      >
        <i className={`bi ${closed ? 'bi-plug' : 'bi-plug-fill'}`} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="cmdbar__btn"
        title="ログを保存"
        aria-label="ログを保存"
        onClick={() =>
          saveLog(
            useChatStore.getState().bySession[session] ?? [],
            useSessionStore.getState().sessions[session]?.label ?? session,
          )
        }
      >
        <i className="bi bi-download" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="cmdbar__btn"
        title="キー操作 (?)"
        aria-label="キー操作"
        onClick={() => useUiStore.getState().setHelpOpen(true)}
      >
        <i className="bi bi-question-circle" aria-hidden="true" />
      </button>
    </div>
  );
}
