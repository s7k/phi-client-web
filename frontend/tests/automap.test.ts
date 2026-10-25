import { describe, it, expect, beforeEach } from 'vitest';
import { useAutomapStore } from '../src/stores/automapStore';
import { automapWindow, AUTOMAP_SPAN } from '../src/components/AutomapView';
import type { MapCell } from '../src/types/protocol';

const Q = '?'.charCodeAt(0);
/** chip を行優先の番号(0..48)にした 7x7。 */
function frame(fill: (i: number) => number): MapCell[] {
  return Array.from({ length: 49 }, (_, i) => ({ chip: fill(i), attr: 0 }));
}

beforeEach(() => {
  useAutomapStore.getState().reset();
  localStorage.clear();
});

describe('automapStore', () => {
  it('7x7 北固定の行 r・列 c を (x+c-3, y-3+r) に置く', () => {
    useAutomapStore.getState().absorb('SYUREN', {
      size: 7, style: 'solid', pos: { x: 100, y: 50 }, cells: frame((i) => i),
    });
    const t = useAutomapStore.getState().byWorld.SYUREN;
    expect(t['97,47'].chip).toBe(0); // 左上
    expect(t['100,50'].chip).toBe(24); // 中央=自キャラ
    expect(t['103,53'].chip).toBe(48); // 右下
  });

  it('視界外(?)は既に見た地形を上書きしない', () => {
    const { absorb } = useAutomapStore.getState();
    absorb('SYUREN', { size: 7, style: 'solid', pos: { x: 10, y: 10 }, cells: frame(() => 65) });
    absorb('SYUREN', { size: 7, style: 'solid', pos: { x: 10, y: 10 }, cells: frame(() => Q) });
    expect(useAutomapStore.getState().byWorld.SYUREN['10,10'].chip).toBe(65);
  });

  it('pos が無い世界・回転マップでは貯めない', () => {
    const { absorb } = useAutomapStore.getState();
    absorb('OTHER', { size: 7, style: 'solid', cells: frame(() => 65) });
    absorb('SYUREN', { size: 7, style: 'turn', pos: { x: 1, y: 1 }, cells: frame(() => 65) });
    expect(useAutomapStore.getState().byWorld).toEqual({});
  });

  it('localStorage に保存し、読み直せる', () => {
    useAutomapStore.getState().absorb('SYUREN', {
      size: 7, style: 'solid', pos: { x: 5, y: 5 }, cells: frame(() => 65),
    });
    useAutomapStore.getState().reset();
    // 新しく見たセルが無くても、保存済みの地図を読み込む
    useAutomapStore.getState().absorb('SYUREN', {
      size: 7, style: 'solid', pos: { x: 5, y: 5 }, cells: frame(() => Q),
    });
    expect(useAutomapStore.getState().byWorld.SYUREN['2,2'].chip).toBe(65);
  });
});

describe('automapWindow', () => {
  it('自キャラを中心に切り出す', () => {
    const cells = automapWindow({ '0,0': { chip: 1, attr: 0 }, '-1,0': { chip: 2, attr: 0 } }, 0, 0);
    const half = (AUTOMAP_SPAN - 1) / 2;
    expect(cells[half * AUTOMAP_SPAN + half].chip).toBe(1);
    expect(cells[half * AUTOMAP_SPAN + half - 1].chip).toBe(2);
    expect(cells[0]).toBeUndefined();
  });
});
