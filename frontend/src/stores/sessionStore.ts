/**
 * sessionStore — アクティブ session・キャラ一覧・タブ([12]§5)。
 * 更新元: auth(characters) / session.open。
 */
import { create } from 'zustand';
import type { CharacterSummary } from '../types/protocol';

/** 開いている session(キャラタブ)の情報。 */
export interface SessionInfo {
  session: string;
  charId: string;
}

interface SessionStoreState {
  /** 認証で得たアカウントのキャラ一覧。 */
  characters: CharacterSummary[];
  /** session別 タブ情報。 */
  sessions: Record<string, SessionInfo>;
  /** フォーカス中の session。 */
  active: string | null;

  setCharacters: (chars: CharacterSummary[]) => void;
  addSession: (session: string, charId: string) => void;
  removeSession: (session: string) => void;
  setActive: (session: string | null) => void;
  reset: () => void;
}

const initial = {
  characters: [] as CharacterSummary[],
  sessions: {} as Record<string, SessionInfo>,
  active: null as string | null,
};

export const useSessionStore = create<SessionStoreState>((set) => ({
  ...initial,
  setCharacters: (characters) => set({ characters }),
  addSession: (session, charId) =>
    set((s) => ({ sessions: { ...s.sessions, [session]: { session, charId } } })),
  removeSession: (session) =>
    set((s) => {
      const next = { ...s.sessions };
      delete next[session];
      return {
        sessions: next,
        active: s.active === session ? null : s.active,
      };
    }),
  setActive: (active) => set({ active }),
  reset: () => set({ ...initial, characters: [], sessions: {} }),
}));
