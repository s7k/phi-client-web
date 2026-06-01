/**
 * listStore — session別 リストモード状態・項目([12]§5)。
 * 更新元: list / snapshot。active切替で項目を全置換([07]§8)。
 */
import { create } from 'zustand';
import type { ListEvent } from '../types/protocol';

export interface ListState {
  active: boolean;
  lines: string[];
}

/** list ペイロード(エンベロープ除く)。snapshot.list と list イベント双方を受ける。 */
export type ListPayload = Omit<ListEvent, 'type' | 'session' | 'reqId' | 'ts'>;

interface ListStoreState {
  bySession: Record<string, ListState>;
  setList: (session: string, list: ListPayload) => void;
  reset: () => void;
}

function toState(list: ListPayload): ListState {
  return { active: list.active, lines: list.active ? (list.lines ?? []) : [] };
}

export const useListStore = create<ListStoreState>((set) => ({
  bySession: {},
  setList: (session, list) =>
    set((s) => ({ bySession: { ...s.bySession, [session]: toState(list) } })),
  reset: () => set({ bySession: {} }),
}));
