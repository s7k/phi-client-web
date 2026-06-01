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
 */
export function drawMap(
  ctx: CanvasRenderingContext2D,
  input: DrawMapInput,
  imgs: ImageRefs,
  animFrame = 0,
): void {
  const dim = gridDim(input.size);
  const cs = CHIP_SIZE;
  // チップは高48px、セル32px。上16px透過分を上にずらして配置。
  const chipYOffset = CHIP_HEIGHT - cs; // 16

  ctx.clearRect(0, 0, dim * cs, dim * cs);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, dim * cs, dim * cs);

  const chipImg = imgs.chip;
  const half = cs / 2; // 16
  // 水有無グリッド(水縁エフェクト用)。チップ画像があれば1回構築。
  const water = chipImg ? buildWaterGrid(input.cells, dim) : null;

  // 行ごとに チップ → 水縁 → 看板 → アイテム → キャラ の順で重ね描画。
  for (let row = 0; row < dim; row++) {
    // 1. ベースチップ
    if (chipImg) {
      for (let col = 0; col < dim; col++) {
        const cell = input.cells[cellIndex(col, row, dim)];
        if (!cell) continue;
        const dstX = col * cs;
        const dstY = row * cs - chipYOffset;
        for (const idx of chipIndices(cell.chip)) {
          const r = chipSrcRect(idx);
          if (!r) continue; // 未知index → 描画スキップ(index0誤描画を避ける)
          ctx.drawImage(chipImg, r.sx, r.sy, r.sw, r.sh, dstX, dstY, cs, CHIP_HEIGHT);
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

    // 2. 看板overlay(attribute bit 0x08)
    if (chipImg) {
      for (let col = 0; col < dim; col++) {
        const cell = input.cells[cellIndex(col, row, dim)];
        if (!cell || !hasBoard(cell.attr)) continue;
        const r = chipSrcRect(boardChipIndex(cell.chip));
        if (!r) continue;
        ctx.drawImage(
          chipImg,
          r.sx, r.sy, r.sw, r.sh,
          col * cs, row * cs - chipYOffset, cs, CHIP_HEIGHT,
        );
      }
    }

    // 3. アイテムoverlay(attribute bits 0x70)
    if (imgs.items) {
      for (let col = 0; col < dim; col++) {
        const cell = input.cells[cellIndex(col, row, dim)];
        if (!cell || !hasItem(cell.attr)) continue;
        // 防御円('x'/'%')上は上11pxクリップで円内に収める(itemDrawRect)。
        const r = itemDrawRect(itemNo(cell.attr), cell.chip, col * cs, row * cs);
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
      drawChara(ctx, ch, cs, imgs, animFrame);
    }
  }

  // 5. キャラ名ラベル(中心=自キャラは除外)。
  drawCharaNames(ctx, input.chars, cs, dim);

  // 6. 中心セル(自キャラ位置)ハイライト(移植元: QColor(255,255,255,40))。
  const cx = Math.floor(dim / 2);
  const cy = Math.floor(dim / 2);
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fillRect(cx * cs + 1, cy * cs + 1, cs - 2, cs - 2);
  ctx.restore();
}

/** 1キャラを描画(スプライト or placeholder)。 */
function drawChara(
  ctx: CanvasRenderingContext2D,
  ch: MapChar,
  cs: number,
  imgs: ImageRefs,
  animFrame: number,
): void {
  const resolved = resolveCharaGra(ch.gra, ch.default, ch.name, (g) => {
    // imgs.chara が画像を返せる(ロード済 or 試行中)URLを「存在」とみなす。
    const img = imgs.chara(`/assets/chara/${g}.png`);
    return img !== null; // null=ロード失敗。undefined(未ロード)は存在候補として許可。
  });

  if (resolved.kind === 'placeholder' || !resolved.url) {
    ctx.save();
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 14px monospace';
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
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(nameInitial(ch.name), ch.x * cs + cs / 2, ch.y * cs + cs / 2);
    ctx.restore();
    return;
  }

  const r = charaSrcRect(ch.dir, ch.gigant, animFrame);
  const baseX = ch.x * cs + Math.floor((cs - r.sw) / 2);
  const baseY = ch.y * cs + Math.floor((cs - CHARA_H) / 2);

  // 巨大キャラ magnify(#ex-obj): 描画原点補正 + 拡大サイズ。
  if (ch.magnify) {
    const d = magnifiedDst(baseX, baseY, ch.magnify);
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
  ctx.font = 'bold 9px monospace';
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
