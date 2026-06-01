/**
 * chatStore — session別 ログ(リングバッファ)・未読([12]§5)。
 * 更新元: message / snapshot。
 * snapshot 時は **追記**(全置換しない)。
 * 重複抑止: 連番(seq)優先。seq無し時は (ts,channel,from,text) の直近一致で抑止。
 *   - 再接続で snapshot がログ末尾を再送しても二重表示しない狙い。
 */
import { create } from 'zustand';
import type { MessageEvent } from '../types/protocol';

/** 表示用ログエントリ。連番(seq, 任意)は MessageEvent 由来で重複抑止に使用。 */
export type ChatEntry = Omit<MessageEvent, 'type' | 'reqId'>;

/** リングバッファ上限(session毎)。 */
const DEFAULT_CAPACITY = 1000;

interface ChatStoreState {
  capacity: number;
  bySession: Record<string, ChatEntry[]>;
  /** session別 未読数。 */
  unread: Record<string, number>;
  addMessage: (session: string, msg: MessageEvent) => void;
  markRead: (session: string) => void;
  reset: () => void;
}

function toEntry(msg: MessageEvent): ChatEntry {
  const { session, ts, channel, from, text, markup, seq } = msg;
  return { session, ts, channel, from, text, markup, seq };
}

/** entry が既存ログ末尾と重複か判定。 */
function isDuplicate(log: ChatEntry[], entry: ChatEntry): boolean {
  if (log.length === 0) return false;
  // 連番が両方あれば seq で厳密判定(既存に同一 seq があれば重複)。
  if (entry.seq !== undefined) {
    return log.some((e) => e.seq !== undefined && e.seq === entry.seq);
  }
  // seq無し: 直前エントリと内容一致なら重複とみなす。
  const last = log[log.length - 1];
  return (
    last.ts === entry.ts &&
    last.channel === entry.channel &&
    last.from === entry.from &&
    last.text === entry.text
  );
}

export const useChatStore = create<ChatStoreState>((set) => ({
  capacity: DEFAULT_CAPACITY,
  bySession: {},
  unread: {},
  addMessage: (session, msg) =>
    set((s) => {
      const prev = s.bySession[session] ?? [];
      const entry = toEntry(msg);
      if (isDuplicate(prev, entry)) return s; // 重複は無視
      const next = [...prev, entry];
      // リングバッファ: 上限超過分を先頭から破棄
      if (next.length > s.capacity) {
        next.splice(0, next.length - s.capacity);
      }
      return {
        bySession: { ...s.bySession, [session]: next },
        unread: { ...s.unread, [session]: (s.unread[session] ?? 0) + 1 },
      };
    }),
  markRead: (session) =>
    set((s) => ({ unread: { ...s.unread, [session]: 0 } })),
  reset: () => set({ bySession: {}, unread: {} }),
}));
