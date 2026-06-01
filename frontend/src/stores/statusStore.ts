/**
 * statusStore — session別 status / cond([12]§5)。
 * 更新元: status / cond / snapshot。全量上書き([07]§8)。
 */
import { create } from 'zustand';
import type { CondEvent, StatusEvent } from '../types/protocol';

export type StatusState = Omit<StatusEvent, 'type' | 'session' | 'reqId' | 'ts'>;
export type CondState = Omit<CondEvent, 'type' | 'session' | 'reqId' | 'ts'>;

interface SessionStatus {
  status?: StatusState;
  cond?: CondState;
}

interface StatusStoreState {
  bySession: Record<string, SessionStatus>;
  setStatus: (session: string, status: StatusEvent | StatusState) => void;
  setCond: (session: string, cond: CondEvent | CondState) => void;
  reset: () => void;
}

function statusToState(s: StatusEvent | StatusState): StatusState {
  const { name, hp, maxHp, mp, maxMp, exp, gp, f, w, m, c } = s as StatusEvent;
  return { name, hp, maxHp, mp, maxMp, exp, gp, f, w, m, c };
}

function condToState(c: CondEvent | CondState): CondState {
  const { poison, palsy, panic, confuse, berserk, silence, blind } =
    c as CondEvent;
  return { poison, palsy, panic, confuse, berserk, silence, blind };
}

export const useStatusStore = create<StatusStoreState>((set) => ({
  bySession: {},
  setStatus: (session, status) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [session]: { ...s.bySession[session], status: statusToState(status) },
      },
    })),
  setCond: (session, cond) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [session]: { ...s.bySession[session], cond: condToState(cond) },
      },
    })),
  reset: () => set({ bySession: {} }),
}));
