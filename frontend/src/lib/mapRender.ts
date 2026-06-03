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

import type { MapCell } from '../types/protocol';

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

/** 有効チップindexか(0..CHIP_COUNT-1)。範囲外は描画スキップ対象。 */
export function chipIndexValid(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < CHIP_COUNT;
}

/**
 * 透過PNGチップシート上の index → 矩形(sx,sy,sw,sh)。
 * 範囲外indexは null(移植元 `_ChipRenderer.draw` の `idx >= len(chips)` スキップ準拠)。
 */
export function chipSrcRect(index: number): {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
} | null {
  if (!chipIndexValid(index)) return null;
  const col = index % CHIPS_PER_ROW;
  const row = Math.floor(index / CHIPS_PER_ROW);
  return {
    sx: col * CHIP_SIZE,
    sy: row * CHIP_HEIGHT,
    sw: CHIP_SIZE,
    sh: CHIP_HEIGHT,
  };
}

// ── チップ合成クラス(拡大表示 scale=2 用) ────────────────────
// 64pxセルを32px原画から合成する際の埋め方。引き伸ばし一辺倒を避ける。
//   tile   : 床/水/草など平面 → 本体32×32を2×2にタイル敷き(くっきり)
//   center : 箱/小物など → 32×32を本体中央へ1枚
//   stretch: 壁/木/扉など段差あり(オーバーハング)→ 2x拡大(高さ保持)
export type ChipClass = 'tile' | 'stretch' | 'center';

/** index→クラス(既定 stretch)。実画面で目視調整する前提の初期分類。 */
export const CHIP_CLASS: Readonly<Record<number, ChipClass>> = {
  // 平面(床/水/草系)
  0: 'tile',
  1: 'tile',
  2: 'tile',
  4: 'tile',
  5: 'tile',
  // 壁/木/扉/構造物は段差を保つため stretch(既定なので明示不要だが意図を残す)
  6: 'stretch',
  7: 'stretch',
  8: 'stretch',
};

/** チップindexの合成クラス。未登録は 'stretch'。 */
export function chipClass(index: number): ChipClass {
  return CHIP_CLASS[index] ?? 'stretch';
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

/** 防御円チップbyte('x'=14, '%'=15)。円内に収めるためアイテム上端をクリップ。 */
const CIRCLE_CHIPS: ReadonlySet<number> = new Set(
  ['x', '%'].map((c) => c.charCodeAt(0)),
);

/** 防御円チップか('x'/'%')。 */
export function isCircleChip(chipByte: number): boolean {
  return CIRCLE_CHIPS.has(chipByte);
}

/** アイテムクリップ高(円内に収める可視高 = 32-11)。 */
export const ITEM_CLIP_H = ITEM_SPRITE_SIZE - 11; // 21

/**
 * アイテム描画の src/dst 矩形を算出(map_widget.py `_ItemRenderer.draw` 移植)。
 *
 * - 通常セル: 32×32 を (col*cs, row*cs+8) に等倍描画。
 * - 防御円('x'/'%')上: 上11pxをクリップし高21pxのみ描画(円内に収める)。
 *   item_no 5/6 はスプライト先頭が空きのため src_y を +5 して内容をずらす。
 *
 * @param no       item_no(0-7)。
 * @param chipByte 下地チップbyte(防御円判定)。
 * @param dstX     セル左上X(col*cs)。
 * @param dstY     セル左上Y(row*cs)。
 * @param scale    描画倍率(1=等倍 / 2=拡大)。dst サイズ・オフセットに乗じる(src は不変)。
 */
export function itemDrawRect(
  no: number,
  chipByte: number,
  dstX: number,
  dstY: number,
  scale = 1,
): {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
} {
  const s = ITEM_SPRITE_SIZE;
  const srcX = no * s;
  // アイテムはチップ上端から8px下げ(C++ YPos+8)。拡大時は ×scale。
  const drawY = dstY + 8 * scale;

  if (isCircleChip(chipByte)) {
    // DrawPart: 上11pxクリップで可視21pxのみ。item 5/6 は内容を src_y+5。
    const srcYOffset = no === 5 || no === 6 ? 5 : 0;
    return {
      sx: srcX,
      sy: srcYOffset,
      sw: s,
      sh: ITEM_CLIP_H,
      dx: dstX,
      dy: drawY,
      dw: s * scale,
      dh: ITEM_CLIP_H * scale,
    };
  }
  return { sx: srcX, sy: 0, sw: s, sh: s, dx: dstX, dy: drawY, dw: s * scale, dh: s * scale };
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
 * @param large 拡大表示モード等で、通常キャラでも右側32×32フレームを使う。
 *   巨大('*')は元々大フレーム。large=true で通常キャラも大フレームへ。
 */
export function charaSrcRect(
  dir: string | number,
  gigant: string | undefined,
  animFrame = 0,
  large = false,
): { sx: number; sy: number; sw: number; sh: number } {
  const row = dirToRow(dir);
  const frame = animFrame & 1;
  const sy = row * CHARA_H;

  if (large || isGiant(gigant)) {
    // 大フレームは通常2枚の後ろ: x=32(frame0) / 64(frame1)
    const sx = CHARA_W_NORMAL * 2 + frame * CHARA_W_GIANT;
    return { sx, sy, sw: CHARA_W_GIANT, sh: CHARA_H };
  }
  // 通常フレーム: x=0(frame0) / 16(frame1)
  const sx = frame * CHARA_W_NORMAL;
  return { sx, sy, sw: CHARA_W_NORMAL, sh: CHARA_H };
}

// ── 巨大キャラ magnify(#ex-obj) ────────────────────────────

/** magnify パラメータ。w/h=拡大描画サイズ(px)、z=垂直オフセット(px)。 */
export interface Magnify {
  w: number;
  h: number;
  z: number;
}

/** magnify 適用後の描画矩形(dst)。 */
export interface MagnifiedDst {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * 巨大キャラ拡大描画の描画先矩形を計算。
 * map_widget.py `_CharaRenderer.draw` の magnify 補正を移植。
 *
 *   base_x -= (w - CHARA_H) / 2          ; 水平センタリング
 *   base_y -= (h - CHARA_H) * 5 / 6 + z  ; 足元基準の垂直補正
 *   draw_w = w ; draw_h = h
 *
 * @param baseX magnify非適用時の描画原点X(セル中央寄せ済)。
 * @param baseY magnify非適用時の描画原点Y(セル中央寄せ済)。
 * @param m     magnify パラメータ。
 * @returns 拡大後の dst 矩形。
 *
 * 床除算(Python `//`)に合わせ Math.floor を使用。
 */
export function magnifiedDst(baseX: number, baseY: number, m: Magnify): MagnifiedDst {
  const dx = baseX - Math.floor((m.w - CHARA_H) / 2);
  const dy = baseY - (Math.floor(((m.h - CHARA_H) * 5) / 6) + m.z);
  return { dx, dy, dw: m.w, dh: m.h };
}

// ── 水縁エフェクト(DrawWaterEffect / _Q_TABLE) ───────────────

/** 水縁チップのベースindex(frame0固定、水アニメ無し)。 */
export const WATER_CHIP_BASE = 23;
/** 水チップのbyte('_')。 */
export const WATER_BYTE = '_'.charCodeAt(0);

/**
 * 水縁 quarter 描画テーブル。
 * map_widget.py `_Q_TABLE` 移植(classMakeMap::DrawWaterEffect)。
 *
 * 添字 = quarter(0=TL,1=TR,2=BL,3=BR)。
 * 各 quarter で 3bit パターン → [chip_offset, src_quarter]。
 * パターン 0x07(全隣接=水) → entry無し(overlay不要)。
 */
export const Q_TABLE: ReadonlyArray<Readonly<Record<number, readonly [number, number]>>> = [
  // Quarter 0 (TL): bit0=TL対角, bit1=上, bit2=左
  { 0x00: [1, 0], 0x01: [1, 0], 0x02: [0, 0], 0x03: [0, 0], 0x04: [0, 2], 0x05: [0, 2], 0x06: [2, 3] },
  // Quarter 1 (TR): bit0=TR対角, bit1=上, bit2=右
  { 0x00: [1, 1], 0x01: [1, 1], 0x02: [0, 1], 0x03: [0, 1], 0x04: [0, 2], 0x05: [0, 2], 0x06: [2, 2] },
  // Quarter 2 (BL): bit0=BL対角, bit1=下, bit2=左
  { 0x00: [1, 2], 0x01: [1, 2], 0x02: [0, 0], 0x03: [0, 0], 0x04: [0, 3], 0x05: [0, 3], 0x06: [2, 1] },
  // Quarter 3 (BR): bit0=BR対角, bit1=下, bit2=右
  { 0x00: [1, 3], 0x01: [1, 3], 0x02: [0, 1], 0x03: [0, 1], 0x04: [0, 3], 0x05: [0, 3], 0x06: [2, 0] },
];

/**
 * 水セルの上下左右+斜めの水有無から各quarterの3bitパターンを計算。
 * map_widget.py `_render_visible` の patterns 計算移植。
 *
 * water[r][c]=1(水) の (rows+2)×(cols+2) 配列を前提(枠=0)。
 * 引数 wy,wx は water配列上の対象セル左上(=grid座標 row,col)。
 *
 * @returns [Q0,Q1,Q2,Q3] の3bitパターン。
 */
export function waterQuarterPatterns(
  water: ReadonlyArray<ReadonlyArray<number>>,
  wy: number,
  wx: number,
): [number, number, number, number] {
  return [
    water[wy][wx] | (water[wy][wx + 1] << 1) | (water[wy + 1][wx] << 2), // Q0 TL
    water[wy][wx + 2] | (water[wy][wx + 1] << 1) | (water[wy + 1][wx + 2] << 2), // Q1 TR
    water[wy + 2][wx] | (water[wy + 2][wx + 1] << 1) | (water[wy + 1][wx] << 2), // Q2 BL
    water[wy + 2][wx + 2] | (water[wy + 2][wx + 1] << 1) | (water[wy + 1][wx + 2] << 2), // Q3 BR
  ];
}

/**
 * quarter のパターンから描画する水縁チップ overlay を解決。
 * @returns null=overlay不要(0x07等)、else={chipIndex, srcQuarter}。
 */
export function waterQuarterChip(
  qIdx: number,
  pattern: number,
): { chipIndex: number; srcQuarter: number } | null {
  const entry = Q_TABLE[qIdx]?.[pattern];
  if (!entry) return null;
  return { chipIndex: WATER_CHIP_BASE + entry[0], srcQuarter: entry[1] };
}

/**
 * チップindex + quarter(0=TL,1=TR,2=BL,3=BR) → チップシート上の16×16矩形。
 * チップ内容領域は y=16 から始まる(上16px透過)。
 * map_widget.py `_ChipRenderer.draw_quarter` 移植。
 */
export function chipQuarterSrcRect(
  chipIndex: number,
  quarter: number,
): { sx: number; sy: number; sw: number; sh: number } | null {
  const base = chipSrcRect(chipIndex);
  if (!base) return null;
  const half = CHIP_SIZE / 2; // 16
  const sx = base.sx + (quarter & 1) * half;
  // 内容はチップ先頭から16px下。上16px透過 + quarter下段でさらに+16。
  const sy = base.sy + (CHIP_HEIGHT - CHIP_SIZE) + ((quarter >> 1) & 1) * half;
  return { sx, sy, sw: half, sh: half };
}

/**
 * cells配列から水有無の (dim+2)×(dim+2) 配列を構築(枠=0)。
 * water[r+1][c+1] = (cells[idx].chip == '_') ? 1 : 0。
 */
export function buildWaterGrid(cells: ReadonlyArray<MapCell>, dim: number): number[][] {
  const w: number[][] = [];
  for (let r = 0; r < dim + 2; r++) w.push(new Array(dim + 2).fill(0));
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      const cell = cells[cellIndex(c, r, dim)];
      if (cell && cell.chip === WATER_BYTE) w[r + 1][c + 1] = 1;
    }
  }
  return w;
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
