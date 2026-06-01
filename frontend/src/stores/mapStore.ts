/**
 * mapStore — session別 map(cells/chars/signs/size/style/mapset)([12]§5)。
 * 更新元: map / snapshot。全量で上書き(全置換, [07]§8)。
 */
import { create } from 'zustand';
import type { MapEvent } from '../types/protocol';

/** session に保持する map 状態(エンベロープ予約キーを除いたペイロード)。 */
export type MapState = Omit<MapEvent, 'type' | 'session' | 'reqId' | 'ts'>;

interface MapStoreState {
  bySession: Record<string, MapState>;
  /** map を全置換([07]§8: map は全量上書き)。 */
  setMap: (session: string, map: MapEvent | MapState) => void;
  reset: () => void;
}

function toState(map: MapEvent | MapState): MapState {
  const { size, dir, style, mapset, cells, chars, signs } = map as MapEvent;
  return { size, dir, style, mapset, cells, chars, signs };
}

export const useMapStore = create<MapStoreState>((set) => ({
  bySession: {},
  setMap: (session, map) =>
    set((s) => ({ bySession: { ...s.bySession, [session]: toState(map) } })),
  reset: () => set({ bySession: {} }),
}));
