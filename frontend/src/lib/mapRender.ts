/**
 * マップ描画ロジック(map_widget.py 移植)。Canvas非依存の純粋関数群。
 *
 * - チップ: chip byte → index(CHIP_BYTE_TO_INDEX)。チップシートから矩形抽出。
 * - キャラ: dir(B/R/F/L=行0-3)・通常(16px)/巨大('*',32px)フレーム。
 * - アイテム: attribute bit 0x70 由来の item_no。
 * - 看板: attribute bit 0x08。
 *
 * 寸法(GraCache.cpp / map_widget.py):
 *   チップセル on-screen: 32px。チップシート: 1024×96(画像512 + マスク512、上下48分割)。
 *   既に透過PNG化済(512×96, 32×48セル/16列×2行)を配信前提([06])。
 */

// ── チップ ────────────────────────────────────────────────

/** チップ画面セルサイズ(px)。 */
export const CHIP_SIZE = 32;
/** チップシート1セルの高さ(px)。上16px透過。 */
export const CHIP_HEIGHT = 48;
/** チップ総数。 */
export const CHIP_COUNT = 32;
/** 透過PNGチップシート1行あたりの列数(16)。 */
export const CHIPS_PER_ROW = 16;

/**
 * chip byte → チップindex(複数なら合成、描画順)。
 * map_widget.py CHIP_BYTE_TO_INDEX 移植。
 */
export const CHIP_BYTE_TO_INDEX: Readonly<Record<number, number | number[]>> = {
  [' '.charCodeAt(0)]: 0,
  [':'.charCodeAt(0)]: 1,
  ['+'.charCodeAt(0)]: 2,
  ['T'.charCodeAt(0)]: [1, 3], // ground + tree overlay
  ['_'.charCodeAt(0)]: 4, // water
  ['o'.charCodeAt(0)]: 5,
  ['@'.charCodeAt(0)]: 6,
  ['#'.charCodeAt(0)]: 7,
  ['H'.charCodeAt(0)]: 8,
  ['I'.charCodeAt(0)]: 9,
  ['='.charCodeAt(0)]: 10,
  ['['.charCodeAt(0)]: 11,
  ['{'.charCodeAt(0)]: 12,
  ['|'.charCodeAt(0)]: 13,
  ['x'.charCodeAt(0)]: 14,
  ['%'.charCodeAt(0)]: 15,
  ['/'.charCodeAt(0)]: 16,
  ['>'.charCodeAt(0)]: 17,
  ['?'.charCodeAt(0)]: 31, // unknown area
  ['s'.charCodeAt(0)]: 0,
};

/** chip byte → 描画するチップindex配列(常に配列化、default=0)。 */
export function chipIndices(chipByte: number): number[] {
  const v = CHIP_BYTE_TO_INDEX[chipByte] ?? 0;
  return Array.isArray(v) ? v : [v];
}

/** 透過PNGチップシート上の index → 矩形(sx,sy,sw,sh)。 */
export function chipSrcRect(index: number): {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
} {
  const i = index >= 0 && index < CHIP_COUNT ? index : 0;
  const col = i % CHIPS_PER_ROW;
  const row = Math.floor(i / CHIPS_PER_ROW);
  return {
    sx: col * CHIP_SIZE,
    sy: row * CHIP_HEIGHT,
    sw: CHIP_SIZE,
    sh: CHIP_HEIGHT,
  };
}

// ── 看板 ────────────────────────────────────────────────

/** 看板overlay用 硬質面チップbyte(壁/扉等)。 */
const HARD_BOARD_CHIPS: ReadonlySet<number> = new Set(
  ['@', '#', 'H', '=', '[', '{', '|', '%'].map((c) => c.charCodeAt(0)),
);
/** 看板overlay: 軟質床/水上。 */
export const BOARD_CHIP_SOFT = 18;
/** 看板overlay: 壁/扉等。 */
export const BOARD_CHIP_HARD = 20;

/** attribute bit 0x08(看板)が立っているか。 */
export function hasBoard(attr: number): boolean {
  return (attr & 0x08) !== 0;
}

/** 看板overlayに使うチップindex(下地が硬質面か否かで分岐)。 */
export function boardChipIndex(chipByte: number): number {
  return HARD_BOARD_CHIPS.has(chipByte) ? BOARD_CHIP_HARD : BOARD_CHIP_SOFT;
}

// ── アイテム ────────────────────────────────────────────────

/** アイテムスプライト1枚サイズ(px)。 */
export const ITEM_SPRITE_SIZE = 32;

/** attribute bit 0x70(アイテム)が立っているか。 */
export function hasItem(attr: number): boolean {
  return (attr & 0x70) !== 0;
}

/** attribute → item_no(0-7)。(attr & 0x70) >> 4。 */
export function itemNo(attr: number): number {
  return (attr & 0x70) >> 4;
}

/** items.png 上の item_no → 矩形。 */
export function itemSrcRect(no: number): {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
} {
  return {
    sx: no * ITEM_SPRITE_SIZE,
    sy: 0,
    sw: ITEM_SPRITE_SIZE,
    sh: ITEM_SPRITE_SIZE,
  };
}

// ── キャラ ────────────────────────────────────────────────

/** dir文字 → チップシート行(0-3)。 */
const DIR_TO_ROW: Readonly<Record<string, number>> = {
  B: 0, // Back / North
  R: 1, // Right / East
  F: 2, // Front / South
  L: 3, // Left / West
};

/**
 * map.dir 数値(A-06: N=0,NE=1,E=2,SE=3,S=4,SW=5,W=6,NW=7) → 相対dir文字。
 * キャラ向きは B/R/F/L で送られる前提(A-05)だが、数値が来た場合のため変換も用意。
 * 8方向を最寄りの B(N)/R(E)/F(S)/L(W) 4方向へ丸める。
 */
const DIR_NUM_TO_CHAR: Readonly<Record<number, 'B' | 'R' | 'F' | 'L'>> = {
  0: 'B', // N
  1: 'B', // NE → N
  2: 'R', // E
  3: 'F', // SE → S
  4: 'F', // S
  5: 'F', // SW → S
  6: 'L', // W
  7: 'B', // NW → N
};

/** キャラdir(文字/数値) → チップシート行(0-3)。既定は F(2, 正面)。 */
export function dirToRow(dir: string | number): number {
  if (typeof dir === 'number') {
    const c = DIR_NUM_TO_CHAR[dir & 7] ?? 'F';
    return DIR_TO_ROW[c];
  }
  return DIR_TO_ROW[dir] ?? DIR_TO_ROW.F;
}

/** gigant フラグが巨大('*')か。 */
export function isGiant(gigant: string | undefined): boolean {
  return gigant === '*';
}

/** キャラ通常フレーム幅(px)。 */
export const CHARA_W_NORMAL = 16;
/** キャラ巨大フレーム幅(px)。 */
export const CHARA_W_GIANT = 32;
/** キャラ1フレーム高(px)。 */
export const CHARA_H = 32;

/**
 * キャラスプライトのソース矩形を計算。
 * 96px幅レイアウト: [小frame0=16][小frame1=16][大frame0=32][大frame1=32]
 * 行 = dir(B/R/F/L)。frame = anim(0/1)。
 *
 * @param dir   キャラ向き(文字 or 数値)。
 * @param gigant '*'=巨大 / それ以外=通常。
 * @param animFrame アニメフレーム(0/1, 内部で &1)。
 */
export function charaSrcRect(
  dir: string | number,
  gigant: string | undefined,
  animFrame = 0,
): { sx: number; sy: number; sw: number; sh: number } {
  const row = dirToRow(dir);
  const frame = animFrame & 1;
  const sy = row * CHARA_H;

  if (isGiant(gigant)) {
    // 巨大フレームは通常2枚の後ろ: x=32(frame0) / 64(frame1)
    const sx = CHARA_W_NORMAL * 2 + frame * CHARA_W_GIANT;
    return { sx, sy, sw: CHARA_W_GIANT, sh: CHARA_H };
  }
  // 通常フレーム: x=0(frame0) / 16(frame1)
  const sx = frame * CHARA_W_NORMAL;
  return { sx, sy, sw: CHARA_W_NORMAL, sh: CHARA_H };
}

// ── グリッド ────────────────────────────────────────────────

/** map.size(7|5) → グリッド辺長(セル数)。 */
export function gridDim(size: number): number {
  return size === 5 ? 5 : 7;
}

/** (x,y) → cells配列index(行優先, index=y*size+x)。 */
export function cellIndex(x: number, y: number, size: number): number {
  return y * size + x;
}
