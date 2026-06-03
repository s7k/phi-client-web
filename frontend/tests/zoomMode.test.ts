/**
 * 拡大表示モード(cellSize=64 / scale=2)のレンダリング検証。
 * - drawMap: tile(床) / stretch(壁) のチップ合成、キャラ大フレーム等倍。
 * - mapRender: charaSrcRect(large) / chipClass。
 */
import { describe, it, expect, vi } from 'vitest';
import { drawMap, type ImageRefs } from '../src/lib/drawMap';
import { charaSrcRect, chipClass, CHIP_SIZE } from '../src/lib/mapRender';
import type { MapCell, MapChar } from '../src/types/protocol';

function makeCtx() {
  const drawImage = vi.fn();
  const ctx = {
    clearRect: vi.fn(), fillRect: vi.fn(), drawImage, fillText: vi.fn(),
    save: vi.fn(), restore: vi.fn(),
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
  } as unknown as CanvasRenderingContext2D;
  return { ctx, drawImage };
}
const dummyImg = {} as HTMLImageElement;
function cells(dim: number, fill: Partial<MapCell> = {}): MapCell[] {
  const arr: MapCell[] = [];
  for (let i = 0; i < dim * dim; i++) arr.push({ chip: 0x20, attr: 0, ...fill });
  return arr;
}

describe('charaSrcRect large(右側32×32フレーム)', () => {
  it('large=true で通常キャラも32幅フレーム(sx=32)', () => {
    const r = charaSrcRect('F', undefined, 0, true);
    expect([r.sx, r.sw, r.sh]).toEqual([32, 32, 32]);
  });
  it('large=false は従来16幅フレーム', () => {
    const r = charaSrcRect('F', undefined, 0, false);
    expect([r.sx, r.sw]).toEqual([0, 16]);
  });
});

describe('chipClass 既定分類', () => {
  it('床系(index0,1)=tile / 既定=stretch', () => {
    expect(chipClass(0)).toBe('tile');
    expect(chipClass(1)).toBe('tile');
    expect(chipClass(7)).toBe('stretch'); // 壁
    expect(chipClass(99)).toBe('stretch'); // 未登録
  });
});

describe('drawMap scale=2(cellSize=64)', () => {
  it('tile床(index0)は1セル2×2=4回drawImage(等倍32タイル)', () => {
    const { ctx, drawImage } = makeCtx();
    const imgs: ImageRefs = { chip: dummyImg, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [] }, imgs, 0, 64);
    // 5x5=25セル × 4タイル = 100。
    expect(drawImage).toHaveBeenCalledTimes(100);
    // 先頭タイル: src body(0,16,32,32) → dst(0,0,32,32)。
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = drawImage.mock.calls[0];
    expect([sx, sy, sw, sh]).toEqual([0, 16, 32, 32]);
    expect([dx, dy, dw, dh]).toEqual([0, 0, 32, 32]);
  });

  it('stretch壁(#)は64×96 dst・上32pxはみ出し', () => {
    const { ctx, drawImage } = makeCtx();
    const c = cells(5);
    c[0] = { chip: '#'.charCodeAt(0), attr: 0 }; // index7=stretch
    const imgs: ImageRefs = { chip: dummyImg, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: c, chars: [] }, imgs, 0, 64);
    // セル0は壁(stretch=1回)、残り24セルは床(tile=4回) → 1 + 96 = 97。
    expect(drawImage).toHaveBeenCalledTimes(97);
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = drawImage.mock.calls[0];
    expect([sx, sy, sw, sh]).toEqual([7 * 32, 0, 32, 48]); // index7 src
    expect([dx, dy, dw, dh]).toEqual([0, -32, 64, 96]);    // 上32はみ出し・64×96
  });

  it('キャラは大フレーム(32幅)を等倍で64セル中央に描画', () => {
    const { ctx, drawImage } = makeCtx();
    const ch: MapChar = {
      id: 1, x: 1, y: 1, dir: 'F', name: 'Mob', gra: 'mob',
      status: 0, gigant: '#', layer: 0, default: 1,
    };
    const imgs: ImageRefs = {
      chip: null, items: null,
      chara: (url) => (url === '/assets/chara/mob.png' ? dummyImg : null),
    };
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [ch] }, imgs, 0, 64);
    const call = drawImage.mock.calls[0];
    const [, sx, , sw, , dx, dy, dw, dh] = call;
    expect(sx).toBe(32);     // 大フレーム
    expect(sw).toBe(32);
    // baseX = 1*64 + (64-32)/2 = 80、baseY = 1*64 + (64-32)/2 = 80。
    expect([dx, dy, dw, dh]).toEqual([80, 80, 32, 32]);
  });
});

describe('CHIP_SIZE 不変', () => {
  it('基準セルは32px', () => {
    expect(CHIP_SIZE).toBe(32);
  });
});
