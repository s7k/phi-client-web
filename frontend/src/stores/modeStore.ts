/**
 * modeStore — session別 attack/magic/list/more フラグ([12]§5)。
 * 更新元: mode / snapshot。
 * mode イベントは部分更新(Partial)。受信フィールドのみ上書き、未指定は温存。
 * snapshot は全フラグ揃って来る前提で全置換。
 */
import { create } from 'zustand';
import type { ModeEvent } from '../types/protocol';

export interface ModeState {
  attack: boolean;
  magic: boolean;
  list: boolean;
  more: boolean;
}

const DEFAULT_MODE: ModeState = {
  attack: false,
  magic: false,
  list: false,
  more: false,
};

/** mode ペイロード(エンベロープ除く、各フィールド任意)。 */
export type ModePayload = Partial<
  Omit<ModeEvent, 'type' | 'session' | 'reqId' | 'ts'>
>;

interface ModeStoreState {
  bySession: Record<string, ModeState>;
  /** 受信フィールドのみ上書き(部分更新)。 */
  setMode: (session: string, mode: ModePayload) => void;
  reset: () => void;
}

export const useModeStore = create<ModeStoreState>((set) => ({
  bySession: {},
  setMode: (session, mode) =>
    set((s) => {
      const prev = s.bySession[session] ?? DEFAULT_MODE;
      const next: ModeState = {
        attack: mode.attack ?? prev.attack,
        magic: mode.magic ?? prev.magic,
        list: mode.list ?? prev.list,
        more: mode.more ?? prev.more,
      };
      return { bySession: { ...s.bySession, [session]: next } };
    }),
  reset: () => set({ bySession: {} }),
}));
