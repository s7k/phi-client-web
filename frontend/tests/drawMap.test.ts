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

  it('CR-17b: 通常チップ上アイテムは32×32等倍 +8px', () => {
    const { ctx, drawImage } = makeCtx();
    const c = cells(5);
    c[0] = { chip: 0x20, attr: 0x10 }; // item_no=1, 通常床
    const imgs: ImageRefs = { chip: null, items: dummyImg, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: c, chars: [] }, imgs, 0);
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = drawImage.mock.calls[0];
    expect([sx, sy, sw, sh]).toEqual([32, 0, 32, 32]);
    expect([dx, dy, dw, dh]).toEqual([0, 8, 32, 32]);
  });

  it("CR-17b: 防御円('x')上アイテムは上11pxクリップ(高21px)", () => {
    const { ctx, drawImage } = makeCtx();
    const c = cells(5);
    c[0] = { chip: 'x'.charCodeAt(0), attr: 0x10 }; // item_no=1, 円
    const imgs: ImageRefs = { chip: null, items: dummyImg, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: c, chars: [] }, imgs, 0);
    const [, , sy, , sh, , dy, , dh] = drawImage.mock.calls[0];
    expect(sy).toBe(0);
    expect(sh).toBe(21);
    expect(dy).toBe(8);
    expect(dh).toBe(21);
  });
});

describe('drawMap CR-17c 未知chip index スキップ', () => {
  it('CHIP_BYTE_TO_INDEX 未マップbyteは index0(ground)へフォールバック描画', () => {
    const { ctx, drawImage } = makeCtx();
    const c = cells(5);
    c[0] = { chip: 0xff, attr: 0 }; // 未マップbyte → chipIndices=[0]
    const imgs: ImageRefs = { chip: dummyImg, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: c, chars: [] }, imgs, 0);
    // index0は有効 → 25回(全セル描画)。
    expect(drawImage).toHaveBeenCalledTimes(25);
  });
});

describe('drawMap CR-17d 中心セルハイライト', () => {
  it('中心セルに半透明白枠を fillRect(rgba 0.16)', () => {
    const fillRect = vi.fn();
    const ctx = {
      clearRect: vi.fn(), fillRect, drawImage: vi.fn(), fillText: vi.fn(),
      save: vi.fn(), restore: vi.fn(),
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
    } as unknown as CanvasRenderingContext2D;
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [] }, { chip: null, items: null, chara: () => null }, 0);
    // 5x5中心=(2,2), cs=32 → (65,65,30,30)。
    const calls = (fillRect as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toContainEqual([2 * 32 + 1, 2 * 32 + 1, 30, 30]);
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

  it('CR-17a: 同セルは layer 昇順で描画(x同値→layer)', () => {
    const { ctx, fillText } = makeCtx();
    // 同セル(1,1)に2体。placeholder頭文字で描画順を観測。
    // スプライト描画は名前ラベルより先に行われるため、先頭2件で順序を判定。
    const top: MapChar = { ...baseChar, name: 'Top', gra: 'x', layer: 5 };
    const bottom: MapChar = { ...baseChar, name: 'Bot', gra: 'x', layer: 1 };
    const imgs: ImageRefs = { chip: null, items: null, chara: () => null };
    // 入力順は top→bottom(逆順)。layer昇順なら描画は B(ottom)→T(op)。
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [top, bottom] }, imgs, 0);
    const sprites = fillText.mock.calls.slice(0, 2).map((c) => c[0]);
    expect(sprites).toEqual(['B', 'T']);
  });

  it('CR-17a: x昇順が layer より優先', () => {
    const { ctx, fillText } = makeCtx();
    const a: MapChar = { ...baseChar, x: 3, name: 'A', gra: 'x', layer: 9 };
    const b: MapChar = { ...baseChar, x: 0, name: 'B', gra: 'x', layer: 0 };
    const imgs: ImageRefs = { chip: null, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [a, b] }, imgs, 0);
    const sprites = fillText.mock.calls.slice(0, 2).map((c) => c[0]);
    expect(sprites).toEqual(['B', 'A']);
  });

  it('magnify指定時は拡大サイズ+補正位置でdrawImage', () => {
    const { ctx, drawImage } = makeCtx();
    // 巨大キャラ(*) + magnify。x=1,y=1, gigant='*' → src幅32。
    const giant: MapChar = {
      ...baseChar, gigant: '*', magnify: { w: 64, h: 64, z: 4 },
    };
    const imgs: ImageRefs = {
      chip: null, items: null,
      chara: () => dummyImg,
    };
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [giant] }, imgs, 0);
    expect(drawImage).toHaveBeenCalledTimes(1);
    const call = drawImage.mock.calls[0];
    // 末尾4引数 = dst(dx,dy,dw,dh)。
    const [, , , , , dx, dy, dw, dh] = call;
    // baseX = 1*32 + floor((32-32)/2)=32, baseY同=32。
    // magnify: dx=32-floor((64-32)/2)=32-16=16, dy=32-(floor(160/6)+4)=32-30=2
    expect(dx).toBe(16);
    expect(dy).toBe(2);
    expect(dw).toBe(64);
    expect(dh).toBe(64);
  });
});

describe('drawMap 水縁エフェクト', () => {
  it('孤立水セル: ベース + 4 quarter overlay(全角=chip_base+1)', () => {
    const { ctx, drawImage } = makeCtx();
    const c = cells(5); // 全てground
    c[2 * 5 + 2] = { chip: '_'.charCodeAt(0), attr: 0 }; // grid(2,2)
    const imgs: ImageRefs = { chip: dummyImg, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: c, chars: [] }, imgs, 0);
    // ベース25 + 孤立水の4 quarter overlay = 29。
    expect(drawImage).toHaveBeenCalledTimes(29);
  });

  it('水セル無し: overlay無し(ベースのみ)', () => {
    const { ctx, drawImage } = makeCtx();
    const imgs: ImageRefs = { chip: dummyImg, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: cells(5), chars: [] }, imgs, 0);
    expect(drawImage).toHaveBeenCalledTimes(25);
  });

  it('chip未ロード時は水縁overlayもスキップ', () => {
    const { ctx, drawImage } = makeCtx();
    const c = cells(5);
    c[2 * 5 + 2] = { chip: '_'.charCodeAt(0), attr: 0 }; // grid(2,2)
    const imgs: ImageRefs = { chip: null, items: null, chara: () => null };
    drawMap(ctx, { size: 5, mapset: 'def', cells: c, chars: [] }, imgs, 0);
    expect(drawImage).not.toHaveBeenCalled();
  });
});
