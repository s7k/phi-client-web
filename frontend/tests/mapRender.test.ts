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
  gridDim,
  cellIndex,
} from '../src/lib/mapRender';

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
  it('範囲外は0扱い', () => {
    expect(chipSrcRect(99)).toEqual(chipSrcRect(0));
    expect(chipSrcRect(-1)).toEqual(chipSrcRect(0));
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
