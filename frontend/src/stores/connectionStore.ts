/**
 * connectionStore — WS接続状態 + 各 session の レガシー接続 state([12]§5)。
 * 更新元: hello / connection イベント。
 */
import { create } from 'zustand';
import type { ConnectionState } from '../types/protocol';

/** WSソケット自体の状態(再接続UI用)。 */
export type SocketState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

interface ConnectionStoreState {
  /** WSソケット状態。 */
  socketState: SocketState;
  /** protocolVersion(hello 由来)。 */
  protocolVersion: number | null;
  /** session別 レガシー接続 state。 */
  sessions: Record<string, ConnectionState>;

  setSocketState: (s: SocketState) => void;
  setProtocolVersion: (v: number) => void;
  setSessionConnection: (session: string, state: ConnectionState) => void;
  reset: () => void;
}

const initial = {
  socketState: 'idle' as SocketState,
  protocolVersion: null as number | null,
  sessions: {} as Record<string, ConnectionState>,
};

export const useConnectionStore = create<ConnectionStoreState>((set) => ({
  ...initial,
  setSocketState: (socketState) => set({ socketState }),
  setProtocolVersion: (protocolVersion) => set({ protocolVersion }),
  setSessionConnection: (session, state) =>
    set((s) => ({ sessions: { ...s.sessions, [session]: state } })),
  reset: () => set({ ...initial, sessions: {} }),
}));
