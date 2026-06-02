/**
 * sessionStore — アクティブ session・開いているキャラタブ([12]§5)。
 * 更新元: session.open。
 *
 * A-34: アカウント+複数キャラ構造へ再設計。
 * キャラは charId で参照(PHI uid は FE 非保持)。保存済みID一覧概念は撤去。
 */
import { create } from 'zustand';

/** session.open に渡した識別子(再アタッチ用)。charId で参照。 */
export interface SessionOpener {
  charId: string;
}

/** 開いている session(キャラタブ)の情報。 */
export interface SessionInfo {
  session: string;
  /** タブ表示用ラベル。 */
  label: string;
  /** 再接続時の再 open に使う識別子(charId)。 */
  opener: SessionOpener;
  /** 管理者セッションか(管理UI出し分け)。 */
  isAdmin?: boolean;
}

interface SessionStoreState {
  /** session別 タブ情報。 */
  sessions: Record<string, SessionInfo>;
  /** フォーカス中の session。 */
  active: string | null;

  addSession: (info: SessionInfo) => void;
  removeSession: (session: string) => void;
  setActive: (session: string | null) => void;
  reset: () => void;
}

const initial = {
  sessions: {} as Record<string, SessionInfo>,
  active: null as string | null,
};

export const useSessionStore = create<SessionStoreState>((set) => ({
  ...initial,
  addSession: (info) =>
    set((s) => ({ sessions: { ...s.sessions, [info.session]: info } })),
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
  reset: () => set({ ...initial, sessions: {} }),
}));
