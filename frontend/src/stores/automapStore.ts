/**
 * automapStore — 世界ごとに、歩いて見た地形を貯める(マッピング)。
 *
 * 絶対座標 map.pos は v5y サーバの :U ZA 拡張(#ex-pos)で、朱蓮だけが送る。
 * pos の無い世界では何もしない。
 * 7x7 北固定の行 r・列 c は絶対座標 (x+c-3, y-3+r)。視界外('?')は上書きしない。
 * localStorage(`phi_automap:<世界名>`)へ保存し、ログアウトしても消さない。
 */
import { create } from 'zustand';
import type { MapCell, MapEvent } from '../types/protocol';

const UNKNOWN = '?'.charCodeAt(0);
const storageKey = (world: string) => `phi_automap:${world}`;

/** "x,y" → セル。 */
export type AutomapTiles = Record<string, MapCell>;

export type AutomapFrame = Pick<MapEvent, 'size' | 'style' | 'cells' | 'pos'>;

function load(world: string): AutomapTiles {
  try {
    const s = localStorage.getItem(storageKey(world));
    return s ? (JSON.parse(s) as AutomapTiles) : {};
  } catch {
    return {};
  }
}

function save(world: string, tiles: AutomapTiles): void {
  try {
    localStorage.setItem(storageKey(world), JSON.stringify(tiles));
  } catch {
    // 容量超過・保存禁止の環境では、メモリ上の地図だけで続ける
  }
}

interface AutomapState {
  byWorld: Record<string, AutomapTiles>;
  /** 1フレーム分を貯める。回転マップ(turn)は向きで座標がずれる為、北固定だけ扱う。 */
  absorb: (world: string, map: AutomapFrame) => void;
  reset: () => void;
}

export const useAutomapStore = create<AutomapState>((set, get) => ({
  byWorld: {},
  absorb: (world, map) => {
    const { pos } = map;
    if (!pos || map.size !== 7 || map.style !== 'solid' || map.cells.length !== 49) return;
    const loaded = get().byWorld[world];
    const prev = loaded ?? load(world);
    let next: AutomapTiles | null = null;
    map.cells.forEach((cell, i) => {
      if (cell.chip === UNKNOWN) return;
      const k = `${pos.x + (i % 7) - 3},${pos.y + Math.floor(i / 7) - 3}`;
      const old = prev[k];
      if (old && old.chip === cell.chip && old.attr === cell.attr) return;
      next ??= { ...prev };
      next[k] = { chip: cell.chip, attr: cell.attr };
    });
    if (next) save(world, next);
    else if (loaded) return;
    const tiles = next ?? prev;
    set((s) => ({ byWorld: { ...s.byWorld, [world]: tiles } }));
  },
  reset: () => set({ byWorld: {} }),
}));
