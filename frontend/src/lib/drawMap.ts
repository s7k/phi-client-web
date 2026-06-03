/**
 * Canvas 2D へのマップ描画(map_widget.py paintEvent 移植の中核)。
 * MapView から CanvasRenderingContext2D と画像群を受け取り描画。
 *
 * 画像参照は ImageRefs で抽象化(テストでは ctx をモック)。
 */
import type { MapCell, MapChar, MapSign } from '../types/protocol';
import {
  CHARA_H,
  CHIP_HEIGHT,
  CHIP_SIZE,
  boardChipIndex,
  charaSrcRect,
  chipClass,
  chipIndices,
  chipSrcRect,
  cellIndex,
  gridDim,
  hasBoard,
  hasItem,
  itemNo,
  itemDrawRect,
  buildWaterGrid,
  waterQuarterPatterns,
  waterQuarterChip,
  chipQuarterSrcRect,
  magnifiedDst,
  WATER_BYTE,
} from './mapRender';
import { resolveCharaGra } from './charaGra';

/** drawMap が参照する画像群。null/undefined は未ロード扱いで描画スキップ。 */
export interface ImageRefs {
  /** mapsetチップシート(透過PNG)。 */
  chip?: HTMLImageElement | null;
  /** items.png。 */
  items?: HTMLImageElement | null;
  /** グラURL → 画像。 */
  chara: (url: string) => HTMLImageElement | null | undefined;
}

export interface DrawMapInput {
  size: number;
  mapset: string;
  cells: MapCell[];
  chars: MapChar[];
  signs?: MapSign[];
  cells0Based?: boolean;
}

/** マークアップ除去後の名前頭文字(placeholder用)。 */
function nameInitial(name: string): string {
  const s = name.replace(/\/\*.*?\*\//g, '').trim();
  return s.slice(0, 1) || '?';
}

/**
 * マップ全体を描画。
 *
 * @param ctx   2Dコンテキスト。
 * @param input map状態。
 * @param imgs  画像参照。
 * @param animFrame アニメフレーム(0/1)。
 * @param cellSize セル1辺px(既定32)。拡大表示は64。scale=cellSize/32(1 or 2)。
 */
export function drawMap(
  ctx: CanvasRenderingContext2D,
  input: DrawMapInput,
  imgs: ImageRefs,
  animFrame = 0,
  cellSize: number = CHIP_SIZE,
): void {
  const dim = gridDim(input.size);
  const cs = cellSize;
  const scale = cs / CHIP_SIZE; // 1 or 2

  ctx.clearRect(0, 0, dim * cs, dim * cs);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, dim * cs, dim * cs);

  const chipImg = imgs.chip;
  const half = cs / 2; // 16(等倍) / 32(拡大)
  // 水有無グリッド(水縁エフェクト用)。チップ画像があれば1回構築。
  const water = chipImg ? buildWaterGrid(input.cells, dim) : null;

  // 行ごとに チップ → 水縁 → 看板 → アイテム → キャラ の順で重ね描画。
  for (let row = 0; row < dim; row++) {
    // 1. ベースチップ
    if (chipImg) {
      for (let col = 0; col < dim; col++) {
        const cell = input.cells[cellIndex(col, row, dim)];
        if (!cell) continue;
        for (const idx of chipIndices(cell.chip)) {
          drawChip(ctx, chipImg, idx, col, row, cs, scale);
        }
      }
    }

    // 1.5 水縁overlay(隣接チップに応じた四分割境界描画)
    if (chipImg && water) {
      for (let col = 0; col < dim; col++) {
        const cell = input.cells[cellIndex(col, row, dim)];
        if (!cell || cell.chip !== WATER_BYTE) continue;
        // water配列はgrid座標(row,col)を左上に [row..row+2][col..col+2] 参照。
        const patterns = waterQuarterPatterns(water, row, col);
        const cellX = col * cs;
        const cellY = row * cs;
        for (let q = 0; q < 4; q++) {
          const hit = waterQuarterChip(q, patterns[q]);
          if (!hit) continue;
          const sr = chipQuarterSrcRect(hit.chipIndex, hit.srcQuarter);
          if (!sr) continue;
          const dstX = cellX + (q & 1) * half;
          const dstY = cellY + ((q >> 1) & 1) * half;
          ctx.drawImage(chipImg, sr.sx, sr.sy, sr.sw, sr.sh, dstX, dstY, half, half);
        }
      }
    }

    // 2. 看板overlay(attribute bit 0x08)。看板チップは段差ありのため stretch 描画。
    if (chipImg) {
      for (let col = 0; col < dim; col++) {
        const cell = input.cells[cellIndex(col, row, dim)];
        if (!cell || !hasBoard(cell.attr)) continue;
        drawChip(ctx, chipImg, boardChipIndex(cell.chip), col, row, cs, scale, 'stretch');
      }
    }

    // 3. アイテムoverlay(attribute bits 0x70)
    if (imgs.items) {
      for (let col = 0; col < dim; col++) {
        const cell = input.cells[cellIndex(col, row, dim)];
        if (!cell || !hasItem(cell.attr)) continue;
        // 防御円('x'/'%')上は上11pxクリップで円内に収める(itemDrawRect)。scale で拡大。
        const r = itemDrawRect(itemNo(cell.attr), cell.chip, col * cs, row * cs, scale);
        ctx.drawImage(
          imgs.items,
          r.sx, r.sy, r.sw, r.sh,
          r.dx, r.dy, r.dw, r.dh,
        );
      }
    }

    // 4. キャラ(この行)。移植元準拠で (x, layer) 昇順に描画(C++同順)。
    const rowChars = input.chars
      .filter((c) => c.y === row && c.x >= 0 && c.x < dim)
      .sort((a, b) => (a.x - b.x) || (a.layer - b.layer));
    for (const ch of rowChars) {
      drawChara(ctx, ch, cs, scale, imgs, animFrame);
    }
  }

  // 5. キャラ名ラベル(中心=自キャラは除外)。
  drawCharaNames(ctx, input.chars, cs, scale, dim);

  // 6. 中心セル(自キャラ位置)ハイライト(移植元: QColor(255,255,255,40))。
  const cx = Math.floor(dim / 2);
  const cy = Math.floor(dim / 2);
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fillRect(cx * cs + 1, cy * cs + 1, cs - 2, cs - 2);
  ctx.restore();
}

/**
 * 1チップを1セルへ描画。scale=2(拡大)時は合成クラスで埋め方を分岐。
 *   stretch: src 32×48 → cs × (CHIP_HEIGHT*scale)、上(16*scale)px はみ出し(段差)。
 *   tile   : 本体 32×32 を 2×2 タイル敷き(等倍くっきり)。
 *   center : 本体 32×32 を本体中央へ1枚。
 * scale=1 は常に stretch(=現行の等倍描画)で挙動不変。
 * @param klassOverride 看板等で明示クラス指定する場合に使う。
 */
function drawChip(
  ctx: CanvasRenderingContext2D,
  chipImg: HTMLImageElement,
  index: number,
  col: number,
  row: number,
  cs: number,
  scale: number,
  klassOverride?: 'tile' | 'stretch' | 'center',
): void {
  const r = chipSrcRect(index);
  if (!r) return; // 未知index → 描画スキップ(index0誤描画を避ける)
  const klass = scale === 2 ? (klassOverride ?? chipClass(index)) : 'stretch';
  const cellX = col * cs;
  const cellTop = row * cs;

  if (klass === 'stretch') {
    const overhang = (CHIP_HEIGHT - CHIP_SIZE) * scale; // 16*scale
    ctx.drawImage(chipImg, r.sx, r.sy, r.sw, r.sh, cellX, cellTop - overhang, cs, CHIP_HEIGHT * scale);
    return;
  }

  // tile / center: 本体 32×32 = src の下32px(上16px=オーバーハングを除く)。
  const bodySx = r.sx;
  const bodySy = r.sy + (CHIP_HEIGHT - CHIP_SIZE); // +16
  const body = CHIP_SIZE; // 32

  if (klass === 'tile') {
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        ctx.drawImage(
          chipImg, bodySx, bodySy, body, body,
          cellX + tx * half32(cs), cellTop + ty * half32(cs), half32(cs), half32(cs),
        );
      }
    }
    return;
  }
  // center
  const off = (cs - CHIP_SIZE) / 2;
  ctx.drawImage(chipImg, bodySx, bodySy, body, body, cellX + off, cellTop + off, CHIP_SIZE, CHIP_SIZE);
}

/** タイル1枚の1辺(セルの半分)。 */
function half32(cs: number): number {
  return cs / 2;
}

/** 1キャラを描画(スプライト or placeholder)。 */
function drawChara(
  ctx: CanvasRenderingContext2D,
  ch: MapChar,
  cs: number,
  scale: number,
  imgs: ImageRefs,
  animFrame: number,
): void {
  const resolved = resolveCharaGra(ch.gra, ch.default, ch.name, (g) => {
    // imgs.chara が画像を返せる(ロード済 or 試行中)URLを「存在」とみなす。
    const img = imgs.chara(`/assets/chara/${g}.png`);
    return img !== null; // null=ロード失敗。undefined(未ロード)は存在候補として許可。
  });

  const phFont = `bold ${14 * scale}px monospace`;
  if (resolved.kind === 'placeholder' || !resolved.url) {
    ctx.save();
    ctx.fillStyle = '#ff0';
    ctx.font = phFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(resolved.initial ?? nameInitial(ch.name), ch.x * cs + cs / 2, ch.y * cs + cs / 2);
    ctx.restore();
    return;
  }

  const img = imgs.chara(resolved.url);
  if (!img) {
    // 未ロード: placeholder頭文字を暫定描画。
    ctx.save();
    ctx.fillStyle = '#ff0';
    ctx.font = phFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(nameInitial(ch.name), ch.x * cs + cs / 2, ch.y * cs + cs / 2);
    ctx.restore();
    return;
  }

  // 拡大表示(scale=2)は通常キャラも右側32×32フレームを使い等倍中央配置。
  const r = charaSrcRect(ch.dir, ch.gigant, animFrame, scale === 2);
  const baseX = ch.x * cs + Math.floor((cs - r.sw) / 2);
  const baseY = ch.y * cs + Math.floor((cs - CHARA_H) / 2);

  // 巨大キャラ magnify(#ex-obj): 描画原点補正 + 拡大サイズ。scale で拡大。
  if (ch.magnify) {
    const m = scale === 1
      ? ch.magnify
      : { w: ch.magnify.w * scale, h: ch.magnify.h * scale, z: ch.magnify.z * scale };
    const d = magnifiedDst(baseX, baseY, m);
    ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, d.dx, d.dy, d.dw, d.dh);
    return;
  }

  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, baseX, baseY, r.sw, r.sh);
}

/** キャラ名ラベル描画(自キャラ=中心セル除外、(x,y)重複は後勝ち)。 */
function drawCharaNames(
  ctx: CanvasRenderingContext2D,
  chars: MapChar[],
  cs: number,
  scale: number,
  dim: number,
): void {
  const cx = Math.floor(dim / 2);
  const cy = Math.floor(dim / 2);
  const perCell = new Map<string, { x: number; y: number; name: string }>();
  for (const c of chars) {
    if (c.x < 0 || c.x >= dim || c.y < 0 || c.y >= dim) continue;
    if (c.x === cx && c.y === cy) continue;
    const name = c.name.replace(/\/\*.*?\*\//g, '').trim();
    if (!name) continue;
    perCell.set(`${c.x},${c.y}`, { x: c.x, y: c.y, name });
  }
  if (perCell.size === 0) return;

  ctx.save();
  ctx.font = `bold ${9 * scale}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const { x, y, name } of perCell.values()) {
    const tx = x * cs + cs / 2;
    const ty = y * cs + cs * 0.6;
    ctx.fillStyle = '#000';
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      ctx.fillText(name, tx + dx, ty + dy);
    }
    ctx.fillStyle = '#fff';
    ctx.fillText(name, tx, ty);
  }
  ctx.restore();
}
