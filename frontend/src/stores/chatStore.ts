/**
 * chatStore — session別 ログ(リングバッファ)・未読([12]§5)。
 * 更新元: message / snapshot。
 * snapshot 時は **追記**(全置換しない)。重複抑止は ts/連番で(後続ラウンド)。
 */
import { create } from 'zustand';
import type { MessageEvent } from '../types/protocol';

/** 表示用ログエントリ。 */
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
  const { session, ts, channel, from, text, markup } = msg;
  return { session, ts, channel, from, text, markup };
}

export const useChatStore = create<ChatStoreState>((set) => ({
  capacity: DEFAULT_CAPACITY,
  bySession: {},
  unread: {},
  addMessage: (session, msg) =>
    set((s) => {
      const prev = s.bySession[session] ?? [];
      const next = [...prev, toEntry(msg)];
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
