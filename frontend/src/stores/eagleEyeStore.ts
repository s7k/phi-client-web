/**
 * eagleEyeStore — session別 EagleEye(俯瞰)状態([07]§6.11)。
 * 更新元: eagleEye。全量で上書き(全置換)。
 */
import { create } from 'zustand';
import type { EagleEyeEvent } from '../types/protocol';

/** session に保持する eagleEye 状態(エンベロープ予約キーを除いたペイロード)。 */
export type EagleEyeState = Omit<EagleEyeEvent, 'type' | 'session' | 'reqId' | 'ts'>;

interface EagleEyeStoreState {
  bySession: Record<string, EagleEyeState>;
  setEagleEye: (session: string, ev: EagleEyeEvent | EagleEyeState) => void;
  reset: () => void;
}

function toState(ev: EagleEyeEvent | EagleEyeState): EagleEyeState {
  const { width, height, self, cells } = ev as EagleEyeEvent;
  return { width, height, self, cells };
}

export const useEagleEyeStore = create<EagleEyeStoreState>((set) => ({
  bySession: {},
  setEagleEye: (session, ev) =>
    set((s) => ({ bySession: { ...s.bySession, [session]: toState(ev) } })),
  reset: () => set({ bySession: {} }),
}));
