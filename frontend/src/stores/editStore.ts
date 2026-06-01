/**
 * editStore — session別 s-edit/m-edit 状態([12]§5)。
 * 更新元: edit / snapshot。mode="end" でクローズ(非アクティブ化)。
 */
import { create } from 'zustand';
import type { EditEvent } from '../types/protocol';

/** 入力要求の種別。end は対話クローズ。 */
export type EditMode = EditEvent['mode'];

export interface EditState {
  active: boolean;
  /** active=true の時の入力種別。 */
  mode: 'single' | 'multi' | null;
}

export type EditPayload = Omit<EditEvent, 'type' | 'session' | 'reqId' | 'ts'>;

interface EditStoreState {
  bySession: Record<string, EditState>;
  setEdit: (session: string, edit: EditPayload) => void;
  reset: () => void;
}

function toState(edit: EditPayload): EditState {
  if (edit.mode === 'end') return { active: false, mode: null };
  return { active: true, mode: edit.mode };
}

export const useEditStore = create<EditStoreState>((set) => ({
  bySession: {},
  setEdit: (session, edit) =>
    set((s) => ({ bySession: { ...s.bySession, [session]: toState(edit) } })),
  reset: () => set({ bySession: {} }),
}));
