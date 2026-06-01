import { describe, it, expect, vi } from 'vitest';
import { drawMap, type ImageRefs } from '../src/lib/drawMap';
import type { MapCell, MapChar } from '../src/types/protocol';

/** drawImage 呼び出しを記録する ctx モック。 */
function makeCtx() {
  const drawImage = vi.fn();
  const fillText = vi.fn();
  const ctx = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage,
    fillText,
    save: vi.fn(),
    restore: vi.fn(),
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  } as unknown as CanvasRenderingContext2D;
  return { ctx, drawImage, fillText };
}

/** ダミー画像。 */
const dummyImg = {} as HTMLImageElement;

function cells(dim: number, fill: Partial<MapCell> = {}): MapCell[] {
  const arr: MapCell[] = [];
  for (let i = 0; i < dim * dim; i++) arr.push({ chip: 0x20, attr: 0, ...fill });
  return arr;
}

describe('drawMap チップ描画', () => {
  it('7x7全セルのベースチップを描画(49回 + 各overlay無し)', () => {
    const { ctx, drawImage } = makeCtx();
    const imgs: ImageRefs = { chip: dummyImg, items: null, chara: () => null };
    drawMap(ctx, { size: 7, mapset: 'def', cells: cells(7), chars: [] }, imgs, 0);
    // ground(byte 0x20→index0)は単一チップ。7*7=49回。
    expect(drawImage).toHaveBeenCalledTimes(49);
  });

  it("'T'(合成[1,3])は1セルで2回drawImage", () => {
    const { ctx, drawImage } = makeCtx();
    const c = cells(5);
    c[0] = { chip: 'T'.charCodeAt(0), attr: 0 };
    const imgs: ImageRefs = { chip: dummyImg, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: c, chars: [] }, imgs, 0);
    // 5x5=25セル、うち1セルが2チップ → 26回。
    expect(drawImage).toHaveBeenCalledTimes(26);
  });

  it('chip画像未ロード時はチップ描画スキップ', () => {
    const { ctx, drawImage } = makeCtx();
    const imgs: ImageRefs = { chip: null, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [] }, imgs, 0);
    expect(drawImage).not.toHaveBeenCalled();
  });
});

describe('drawMap 看板/アイテムoverlay', () => {
  it('看板bit(0x08)で追加drawImage', () => {
    const { ctx, drawImage } = makeCtx();
    const c = cells(5);
    c[0] = { chip: 0x20, attr: 0x08 };
    const imgs: ImageRefs = { chip: dummyImg, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: c, chars: [] }, imgs, 0);
    // 25ベース + 1看板overlay = 26。
    expect(drawImage).toHaveBeenCalledTimes(26);
  });

  it('アイテムbit(0x70)でitems画像描画', () => {
    const { ctx, drawImage } = makeCtx();
    const c = cells(5);
    c[0] = { chip: 0x20, attr: 0x10 };
    const imgs: ImageRefs = { chip: null, items: dummyImg, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: c, chars: [] }, imgs, 0);
    // chip=null なのでベースなし、items 1回のみ。
    expect(drawImage).toHaveBeenCalledTimes(1);
  });
});

describe('drawMap キャラ描画', () => {
  const baseChar: MapChar = {
    id: 1, x: 1, y: 1, dir: 'F', name: 'Mob', gra: 'mob',
    status: 0, gigant: '#', layer: 0, default: 1,
  };

  it('グラ画像ロード済→スプライト描画(drawImage)', () => {
    const { ctx, drawImage, fillText } = makeCtx();
    const imgs: ImageRefs = {
      chip: null, items: null,
      chara: (url) => (url === '/assets/chara/mob.png' ? dummyImg : null),
    };
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [baseChar] }, imgs, 0);
    expect(drawImage).toHaveBeenCalledTimes(1);
    // 名前ラベルも fillText で描画される(中心以外)。
    expect(fillText).toHaveBeenCalled();
  });

  it('グラ未ロード/失敗→placeholder頭文字(fillText)', () => {
    const { ctx, drawImage, fillText } = makeCtx();
    const imgs: ImageRefs = { chip: null, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [baseChar] }, imgs, 0);
    expect(drawImage).not.toHaveBeenCalled();
    // placeholder "M" を含む fillText 呼び出し。
    const texts = fillText.mock.calls.map((c) => c[0]);
    expect(texts).toContain('M');
  });

  it('中心セル(自キャラ)の名前ラベルは描画されない', () => {
    const { ctx, fillText } = makeCtx();
    const self: MapChar = { ...baseChar, x: 2, y: 2, name: 'Me', gra: 'me' };
    const imgs: ImageRefs = {
      chip: null, items: null,
      chara: () => dummyImg,
    };
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [self] }, imgs, 0);
    // 5x5中心=(2,2)。名前ラベルfillTextは呼ばれない(スプライトはdrawImage)。
    const texts = fillText.mock.calls.map((c) => c[0]);
    expect(texts).not.toContain('Me');
  });
});
