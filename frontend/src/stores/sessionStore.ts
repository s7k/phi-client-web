/**
 * sessionStore — アクティブ session・保存済みID一覧・タブ([12]§5)。
 * 更新元: saved.list(items) / session.open。
 *
 * ID-only ログインへ再設計: アカウント+キャラ一覧概念を廃止。
 * PHI ID 自体が資格情報。保存済みは ref+label で識別(生ID非保持)。
 */
import { create } from 'zustand';
import type { SavedListItem } from '../types/protocol';

/** session.open に渡した識別子(再アタッチ用)。id か ref のどちらか。 */
export interface SessionOpener {
  id?: string;
  ref?: string;
}

/** 開いている session(キャラタブ)の情報。 */
export interface SessionInfo {
  session: string;
  /** タブ表示用ラベル。 */
  label: string;
  /** 再接続時の再 open に使う識別子。 */
  opener: SessionOpener;
  /** 管理者セッションか(管理UI出し分け)。 */
  isAdmin?: boolean;
}

interface SessionStoreState {
  /** saved.list で得た保存済みID一覧(ラベル選択用)。生IDは含まない。 */
  saved: SavedListItem[];
  /** session別 タブ情報。 */
  sessions: Record<string, SessionInfo>;
  /** フォーカス中の session。 */
  active: string | null;

  setSaved: (items: SavedListItem[]) => void;
  addSession: (info: SessionInfo) => void;
  removeSession: (session: string) => void;
  setActive: (session: string | null) => void;
  reset: () => void;
}

const initial = {
  saved: [] as SavedListItem[],
  sessions: {} as Record<string, SessionInfo>,
  active: null as string | null,
};

export const useSessionStore = create<SessionStoreState>((set) => ({
  ...initial,
  setSaved: (saved) => set({ saved }),
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
  reset: () => set({ ...initial, saved: [], sessions: {} }),
}));
