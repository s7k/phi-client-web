import { describe, it, expect } from 'vitest';
import {
  CHIP_BYTE_TO_INDEX,
  chipIndices,
  chipSrcRect,
  CHIP_SIZE,
  CHIP_HEIGHT,
  dirToRow,
  isGiant,
  charaSrcRect,
  CHARA_W_NORMAL,
  CHARA_W_GIANT,
  CHARA_H,
  hasBoard,
  boardChipIndex,
  BOARD_CHIP_HARD,
  BOARD_CHIP_SOFT,
  hasItem,
  itemNo,
  itemSrcRect,
  itemDrawRect,
  isCircleChip,
  ITEM_CLIP_H,
  chipIndexValid,
  gridDim,
  cellIndex,
  magnifiedDst,
  Q_TABLE,
  WATER_CHIP_BASE,
  WATER_BYTE,
  waterQuarterPatterns,
  waterQuarterChip,
  chipQuarterSrcRect,
  buildWaterGrid,
} from '../src/lib/mapRender';
import type { MapCell } from '../src/types/protocol';

describe('チップindex変換(CHIP_BYTE_TO_INDEX)', () => {
  it('基本byte→index', () => {
    expect(chipIndices(' '.charCodeAt(0))).toEqual([0]);
    expect(chipIndices('@'.charCodeAt(0))).toEqual([6]);
    expect(chipIndices('#'.charCodeAt(0))).toEqual([7]);
    expect(chipIndices('?'.charCodeAt(0))).toEqual([31]);
    expect(chipIndices('s'.charCodeAt(0))).toEqual([0]);
  });

  it("'T'(木)は合成 [1,3]", () => {
    expect(chipIndices('T'.charCodeAt(0))).toEqual([1, 3]);
    // 元定義も合成
    expect(CHIP_BYTE_TO_INDEX['T'.charCodeAt(0)]).toEqual([1, 3]);
  });

  it('未知byteは0(ground)へ', () => {
    expect(chipIndices(0)).toEqual([0]);
    expect(chipIndices(255)).toEqual([0]);
  });
});

describe('chipSrcRect(透過PNG 16列×2行)', () => {
  it('index 0 → (0,0)', () => {
    expect(chipSrcRect(0)).toEqual({ sx: 0, sy: 0, sw: CHIP_SIZE, sh: CHIP_HEIGHT });
  });
  it('index 15 → 最終列1行目', () => {
    expect(chipSrcRect(15)).toEqual({ sx: 15 * 32, sy: 0, sw: 32, sh: 48 });
  });
  it('index 16 → 2行目先頭(下16-31)', () => {
    expect(chipSrcRect(16)).toEqual({ sx: 0, sy: 48, sw: 32, sh: 48 });
  });
  it('index 31 → 2行目最終', () => {
    expect(chipSrcRect(31)).toEqual({ sx: 15 * 32, sy: 48, sw: 32, sh: 48 });
  });
  it('範囲外indexはnull(CR-17c: index0誤描画でなくスキップ)', () => {
    expect(chipSrcRect(99)).toBeNull();
    expect(chipSrcRect(32)).toBeNull();
    expect(chipSrcRect(-1)).toBeNull();
    expect(chipSrcRect(1.5)).toBeNull();
  });
});

describe('dir行選択', () => {
  it('文字 B/R/F/L → 行0-3', () => {
    expect(dirToRow('B')).toBe(0);
    expect(dirToRow('R')).toBe(1);
    expect(dirToRow('F')).toBe(2);
    expect(dirToRow('L')).toBe(3);
  });
  it('未知文字は正面F(2)', () => {
    expect(dirToRow('X')).toBe(2);
  });
  it('数値(A-06: N=0..NW=7)を4方向へ丸め', () => {
    expect(dirToRow(0)).toBe(0); // N→B
    expect(dirToRow(2)).toBe(1); // E→R
    expect(dirToRow(4)).toBe(2); // S→F
    expect(dirToRow(6)).toBe(3); // W→L
    // 斜めは最寄りへ
    expect(dirToRow(1)).toBe(0); // NE→N(B)
    expect(dirToRow(7)).toBe(0); // NW→N(B)
  });
});

describe('巨大判定 + キャラスプライト矩形', () => {
  it('isGiant', () => {
    expect(isGiant('*')).toBe(true);
    expect(isGiant('#')).toBe(false);
    expect(isGiant(undefined)).toBe(false);
  });

  it('通常キャラ frame0: x=0 w=16', () => {
    const r = charaSrcRect('F', '#', 0);
    expect(r).toEqual({ sx: 0, sy: 2 * CHARA_H, sw: CHARA_W_NORMAL, sh: CHARA_H });
  });
  it('通常キャラ frame1: x=16', () => {
    expect(charaSrcRect('B', '#', 1).sx).toBe(16);
  });
  it('巨大キャラ frame0: x=32 w=32', () => {
    const r = charaSrcRect('R', '*', 0);
    expect(r).toEqual({ sx: 32, sy: 1 * CHARA_H, sw: CHARA_W_GIANT, sh: CHARA_H });
  });
  it('巨大キャラ frame1: x=64', () => {
    expect(charaSrcRect('R', '*', 1).sx).toBe(64);
  });
  it('animFrameは&1で正規化', () => {
    expect(charaSrcRect('F', '#', 2).sx).toBe(charaSrcRect('F', '#', 0).sx);
    expect(charaSrcRect('F', '#', 3).sx).toBe(charaSrcRect('F', '#', 1).sx);
  });
  it('dirで行(sy)が変わる', () => {
    expect(charaSrcRect('B', '#').sy).toBe(0);
    expect(charaSrcRect('L', '#').sy).toBe(3 * CHARA_H);
  });
});

describe('看板overlay', () => {
  it('attribute bit 0x08 判定', () => {
    expect(hasBoard(0x08)).toBe(true);
    expect(hasBoard(0x00)).toBe(false);
    expect(hasBoard(0x09)).toBe(true);
  });
  it('硬質面(壁等)はHARD(20)、それ以外SOFT(18)', () => {
    expect(boardChipIndex('@'.charCodeAt(0))).toBe(BOARD_CHIP_HARD);
    expect(boardChipIndex('#'.charCodeAt(0))).toBe(BOARD_CHIP_HARD);
    expect(boardChipIndex(' '.charCodeAt(0))).toBe(BOARD_CHIP_SOFT);
    expect(boardChipIndex('_'.charCodeAt(0))).toBe(BOARD_CHIP_SOFT);
  });
});

describe('アイテムoverlay', () => {
  it('attribute bits 0x70 判定 + item_no抽出', () => {
    expect(hasItem(0x00)).toBe(false);
    expect(hasItem(0x10)).toBe(true);
    expect(itemNo(0x10)).toBe(1);
    expect(itemNo(0x70)).toBe(7);
    expect(itemNo(0x30)).toBe(3);
  });
  it('itemSrcRect 横一列32px', () => {
    expect(itemSrcRect(0)).toEqual({ sx: 0, sy: 0, sw: 32, sh: 32 });
    expect(itemSrcRect(5)).toEqual({ sx: 160, sy: 0, sw: 32, sh: 32 });
  });
});

describe('CR-17c: chipIndexValid', () => {
  it('0..31 のみ有効、範囲外/非整数は無効', () => {
    expect(chipIndexValid(0)).toBe(true);
    expect(chipIndexValid(31)).toBe(true);
    expect(chipIndexValid(32)).toBe(false);
    expect(chipIndexValid(-1)).toBe(false);
    expect(chipIndexValid(1.5)).toBe(false);
  });
});

describe('CR-17b: アイテム円クリップ(itemDrawRect)', () => {
  it('防御円判定 isCircleChip', () => {
    expect(isCircleChip('x'.charCodeAt(0))).toBe(true);
    expect(isCircleChip('%'.charCodeAt(0))).toBe(true);
    expect(isCircleChip(' '.charCodeAt(0))).toBe(false);
  });

  it('通常チップ: 32×32 等倍、dst は +8px 下げ', () => {
    const r = itemDrawRect(2, ' '.charCodeAt(0), 64, 96);
    expect(r).toEqual({
      sx: 2 * 32, sy: 0, sw: 32, sh: 32,
      dx: 64, dy: 96 + 8, dw: 32, dh: 32,
    });
  });

  it("防御円('x')上: 上11pxクリップで高21px(item 0)", () => {
    const r = itemDrawRect(0, 'x'.charCodeAt(0), 0, 0);
    expect(ITEM_CLIP_H).toBe(21);
    expect(r).toEqual({
      sx: 0, sy: 0, sw: 32, sh: 21,
      dx: 0, dy: 8, dw: 32, dh: 21,
    });
  });

  it("防御円('%')上の item 5/6 は src_y を +5", () => {
    expect(itemDrawRect(5, '%'.charCodeAt(0), 0, 0).sy).toBe(5);
    expect(itemDrawRect(6, '%'.charCodeAt(0), 0, 0).sy).toBe(5);
    // item 5/6 以外は src_y=0
    expect(itemDrawRect(4, '%'.charCodeAt(0), 0, 0).sy).toBe(0);
  });
});

describe('グリッドヘルパ', () => {
  it('gridDim 5/7', () => {
    expect(gridDim(5)).toBe(5);
    expect(gridDim(7)).toBe(7);
    expect(gridDim(40)).toBe(7); // 既定7
  });
  it('cellIndex 行優先', () => {
    expect(cellIndex(0, 0, 7)).toBe(0);
    expect(cellIndex(3, 0, 7)).toBe(3);
    expect(cellIndex(0, 1, 7)).toBe(7);
    expect(cellIndex(2, 1, 5)).toBe(7);
  });
});

describe('巨大キャラ magnify 描画矩形(magnifiedDst)', () => {
  it('w=h=32(等倍相当)はオフセット0', () => {
    // (w-32)/2=0, (h-32)*5/6=0, z=0 → base位置のまま、サイズ32×32。
    expect(magnifiedDst(10, 20, { w: 32, h: 32, z: 0 })).toEqual({
      dx: 10, dy: 20, dw: 32, dh: 32,
    });
  });

  it('水平センタリング: dx -= (w-32)/2(床除算)', () => {
    // w=64 → (64-32)/2=16 → dx=100-16=84
    const d = magnifiedDst(100, 0, { w: 64, h: 32, z: 0 });
    expect(d.dx).toBe(84);
    expect(d.dw).toBe(64);
  });

  it('垂直補正: dy -= (h-32)*5/6 + z(床除算)', () => {
    // h=64 → (64-32)*5/6=160/6=26.67→floor 26, z=0 → dy=100-26=74
    expect(magnifiedDst(0, 100, { w: 32, h: 64, z: 0 }).dy).toBe(74);
    // z=8 加算 → dy=100-(26+8)=66
    expect(magnifiedDst(0, 100, { w: 32, h: 64, z: 8 }).dy).toBe(66);
  });

  it('w/h がそのまま draw幅高に', () => {
    const d = magnifiedDst(0, 0, { w: 80, h: 96, z: 0 });
    expect(d.dw).toBe(80);
    expect(d.dh).toBe(96);
  });

  it('総合: w=64,h=64,z=4', () => {
    // dx=10-16=-6, dy=10-(26+4)=-20
    expect(magnifiedDst(10, 10, { w: 64, h: 64, z: 4 })).toEqual({
      dx: -6, dy: -20, dw: 64, dh: 64,
    });
  });
});

describe('水縁エフェクト: パターン計算(waterQuarterPatterns)', () => {
  // 5x5の中央(2,2)を水とする最小ケース用 water配列(7×7, 枠込)を直接構築。
  function gridWith(setOnes: Array<[number, number]>): number[][] {
    const w: number[][] = [];
    for (let r = 0; r < 7; r++) w.push(new Array(7).fill(0));
    for (const [r, c] of setOnes) w[r][c] = 1;
    return w;
  }

  it('孤立水セル(周囲全て陸): 全quarter pattern=0', () => {
    // water配列で対象セルだけ1。wy=wx=対象のgrid座標。
    // grid(row,col)=(2,2) → 配列上 [2][2]..[4][4] を参照。中心=[3][3]。
    const w = gridWith([[3, 3]]);
    const p = waterQuarterPatterns(w, 2, 2);
    expect(p).toEqual([0, 0, 0, 0]);
  });

  it('全周水(対象+8近傍すべて水): 全quarter pattern=0x07', () => {
    const ones: Array<[number, number]> = [];
    for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) ones.push([r, c]);
    const w = gridWith(ones);
    expect(waterQuarterPatterns(w, 2, 2)).toEqual([7, 7, 7, 7]);
  });

  it('上辺のみ水(top隣接): Q0/Q1 で top bit(bit1=0x02)が立つ', () => {
    // 中心[3][3] + 上[2][3]。
    const w = gridWith([[3, 3], [2, 3]]);
    const p = waterQuarterPatterns(w, 2, 2);
    // Q0 TL: water[2][2]|water[2][3]<<1|water[3][2]<<2 = 0|1<<1|0 = 0x02
    expect(p[0]).toBe(0x02);
    // Q1 TR: water[2][4]|water[2][3]<<1|water[3][4]<<2 = 0|1<<1|0 = 0x02
    expect(p[1]).toBe(0x02);
    // 下側Q2/Q3 は top非隣接 → 0
    expect(p[2]).toBe(0);
    expect(p[3]).toBe(0);
  });
});

describe('水縁エフェクト: quarterチップ解決(waterQuarterChip)', () => {
  it('Q_TABLE は4 quarter定義', () => {
    expect(Q_TABLE).toHaveLength(4);
  });

  it('pattern 0x07 は overlay無し(null)', () => {
    for (let q = 0; q < 4; q++) {
      expect(waterQuarterChip(q, 0x07)).toBeNull();
    }
  });

  it('pattern 0x00(孤立角): chip_base+1 を src_quarter=自分の角で描画', () => {
    // _Q_TABLE Q0 0x00 → (1, 0)
    expect(waterQuarterChip(0, 0x00)).toEqual({
      chipIndex: WATER_CHIP_BASE + 1, srcQuarter: 0,
    });
    // Q3 0x00 → (1, 3)
    expect(waterQuarterChip(3, 0x00)).toEqual({
      chipIndex: WATER_CHIP_BASE + 1, srcQuarter: 3,
    });
  });

  it('pattern 0x06(直交2辺=凹角): chip_base+2', () => {
    // Q0 0x06 → (2, 3)
    expect(waterQuarterChip(0, 0x06)).toEqual({
      chipIndex: WATER_CHIP_BASE + 2, srcQuarter: 3,
    });
  });

  it('pattern 0x02(辺隣接=直線縁): chip_base+0', () => {
    // Q0 0x02 → (0, 0)
    expect(waterQuarterChip(0, 0x02)).toEqual({
      chipIndex: WATER_CHIP_BASE + 0, srcQuarter: 0,
    });
  });
});

describe('水縁: quarter矩形(chipQuarterSrcRect)', () => {
  it('TL(quarter0): 内容領域先頭(y=base.sy+16)から16×16', () => {
    // chipIndex=23 → col=23%16=7, row=1 → base sx=7*32=224, sy=48
    // TL: sx=224, sy=48+16=64, 16×16
    expect(chipQuarterSrcRect(23, 0)).toEqual({ sx: 224, sy: 64, sw: 16, sh: 16 });
  });
  it('BR(quarter3): +16,+16', () => {
    // sx=224+16=240, sy=48+16+16=80
    expect(chipQuarterSrcRect(23, 3)).toEqual({ sx: 240, sy: 80, sw: 16, sh: 16 });
  });
});

describe('水有無グリッド構築(buildWaterGrid)', () => {
  function cells(dim: number, water: Array<[number, number]>): MapCell[] {
    const arr: MapCell[] = [];
    for (let i = 0; i < dim * dim; i++) arr.push({ chip: 0x20, attr: 0 });
    for (const [x, y] of water) arr[cellIndex(x, y, dim)] = { chip: WATER_BYTE, attr: 0 };
    return arr;
  }

  it('枠+1オフセットで水セルを1にする', () => {
    const w = buildWaterGrid(cells(5, [[2, 2]]), 5);
    expect(w).toHaveLength(7); // dim+2
    expect(w[0]).toHaveLength(7);
    // grid(2,2) → 配列[3][3]=1
    expect(w[3][3]).toBe(1);
    // 枠は0
    expect(w[0][0]).toBe(0);
    expect(w[6][6]).toBe(0);
  });
});
