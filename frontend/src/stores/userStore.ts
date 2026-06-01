/**
 * userStore — session別 userList(priv宛先候補)([12]§5)。
 * 更新元: userList / snapshot。全置換([07]§8)。
 * priv宛先選択はここの key を使う(番号はBEが隠蔽)。
 */
import { create } from 'zustand';
import type { UserListEntry, UserListEvent } from '../types/protocol';

export type UserListPayload = Omit<
  UserListEvent,
  'type' | 'session' | 'reqId' | 'ts'
>;

interface UserStoreState {
  bySession: Record<string, UserListEntry[]>;
  setUsers: (session: string, payload: UserListPayload) => void;
  reset: () => void;
}

export const useUserStore = create<UserStoreState>((set) => ({
  bySession: {},
  setUsers: (session, payload) =>
    set((s) => ({
      bySession: { ...s.bySession, [session]: payload.users ?? [] },
    })),
  reset: () => set({ bySession: {} }),
}));
