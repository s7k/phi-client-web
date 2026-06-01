/**
 * F9: キャラタブUI([12]§5)。
 * - 複数 session(キャラ)を切替。sessionStore.sessions を列挙。
 * - 各タブに接続マーク(connectionStore.sessions[session] の state)。
 * - クリックで activeTab/active を切替(uiStore + sessionStore)。
 * - 未読バッジ(chatStore.unread)。
 */
import { useSessionStore } from '../stores/sessionStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import type { ConnectionState } from '../types/protocol';
import './TabBar.css';

/** 接続 state → マーク記号・ラベル。 */
const STATE_MARK: Record<ConnectionState, { mark: string; label: string }> = {
  connecting: { mark: '◌', label: '接続中' },
  connected: { mark: '●', label: '接続' },
  detached: { mark: '○', label: '一時切断' },
  closed: { mark: '×', label: '切断' },
};

export function TabBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const characters = useSessionStore((s) => s.characters);
  const setActive = useSessionStore((s) => s.setActive);
  const conn = useConnectionStore((s) => s.sessions);
  const unread = useChatStore((s) => s.unread);
  const activeTab = useUiStore((s) => s.activeTab);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const markRead = useChatStore((s) => s.markRead);

  const entries = Object.values(sessions);
  if (entries.length === 0) return null;

  /** charId → 表示名(auth のキャラ一覧から)。 */
  const nameOf = (charId: string) =>
    characters.find((c) => c.charId === charId)?.name ?? charId;

  function select(session: string) {
    setActive(session);
    setActiveTab(session);
    markRead(session);
  }

  return (
    <nav className="tabbar" aria-label="キャラタブ">
      {entries.map((info) => {
        const state = conn[info.session] ?? 'connecting';
        const m = STATE_MARK[state];
        const u = unread[info.session] ?? 0;
        const active = activeTab === info.session;
        return (
          <button
            key={info.session}
            type="button"
            className={'tabbar__tab' + (active ? ' tabbar__tab--active' : '')}
            aria-current={active ? 'true' : undefined}
            onClick={() => select(info.session)}
          >
            <span
              className={`tabbar__mark tabbar__mark--${state}`}
              title={m.label}
              aria-label={m.label}
            >
              {m.mark}
            </span>
            <span className="tabbar__name">{nameOf(info.charId)}</span>
            {u > 0 && <span className="tabbar__unread">{u}</span>}
          </button>
        );
      })}
    </nav>
  );
}
