/**
 * noticeStore — session別 環境通知(世界/エリア/名前/mapset)([07]§6.12)。
 * 更新元: notice / snapshot(notice)。
 * 部分更新(届いたフィールドのみ上書き。未指定は既存温存)。
 */
import { create } from 'zustand';
import type { NoticeEvent } from '../types/protocol';

/** session に保持する notice 状態(エンベロープ予約キー除外)。 */
export interface NoticeState {
  world?: string;
  area?: string;
  name?: string;
  mapset?: string;
}

interface NoticeStoreState {
  bySession: Record<string, NoticeState>;
  /** 届いたフィールドのみ上書き(部分更新)。 */
  setNotice: (session: string, ev: NoticeEvent | NoticeState) => void;
  reset: () => void;
}

/** undefined フィールドを既存へ反映しないようマージ。 */
function merge(prev: NoticeState, ev: NoticeEvent | NoticeState): NoticeState {
  const next: NoticeState = { ...prev };
  if (ev.world !== undefined) next.world = ev.world;
  if (ev.area !== undefined) next.area = ev.area;
  if (ev.name !== undefined) next.name = ev.name;
  if (ev.mapset !== undefined) next.mapset = ev.mapset;
  return next;
}

export const useNoticeStore = create<NoticeStoreState>((set) => ({
  bySession: {},
  setNotice: (session, ev) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [session]: merge(s.bySession[session] ?? {}, ev),
      },
    })),
  reset: () => set({ bySession: {} }),
}));
