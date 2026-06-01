/**
 * EagleEye(俯瞰)描画ロジック([07]§6.11)。Canvas非依存の純粋関数。
 *
 * width×height のグリッド(典型 15×15)を縮小タイルで描画。
 * チップは map と同じシートを流用(chipSrcRect)。セルは EE_CELL px 角。
 * self(自キャラ位置)はマーカーで強調。
 */
import type { MapCell } from '../types/protocol';
import { CHIP_HEIGHT, CHIP_SIZE, chipIndices, chipSrcRect } from './mapRender';

/** EagleEye 1セルの描画サイズ(px)。map の 32px より小さい俯瞰用。 */
export const EE_CELL = 16;

export interface EagleEyeInput {
  width: number;
  height: number;
  self: { x: number; y: number };
  cells: MapCell[];
}

export interface EagleEyeImageRefs {
  /** mapset チップシート(透過PNG)。 */
  chip?: HTMLImageElement | null;
}

/** (x,y) → cells index(行優先)。 */
export function eeCellIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

/**
 * EagleEye グリッドを描画。
 * @param ctx  2Dコンテキスト。
 * @param input EagleEye 状態。
 * @param imgs チップ画像参照。
 */
export function drawEagleEye(
  ctx: CanvasRenderingContext2D,
  input: EagleEyeInput,
  imgs: EagleEyeImageRefs,
): void {
  const { width, height } = input;
  const cs = EE_CELL;

  ctx.clearRect(0, 0, width * cs, height * cs);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width * cs, height * cs);

  const chipImg = imgs.chip;
  if (chipImg) {
    // 移植元(eagle_eye_widget.py)は map_widget の _ChipRenderer.draw を流用し
    // 48px高チップ全体を cs幅×CHIP_HEIGHT高で等倍描画(上16px透過分はセル外上方へ)。
    // ここでは map(32px) を cs(16px) へ縮める縮尺で同じ配置を再現する。
    //   scale = cs / CHIP_SIZE      ; 本体32px → cs(=16px)
    //   描画高 = CHIP_HEIGHT * scale ; 48 → 24px
    //   上オフセット = (CHIP_HEIGHT - CHIP_SIZE) * scale ; 透過16px → 8px 上シフト
    // これにより本体(下32px相当)が正しく cs 角へ収まり、上16px透過分が潰されない。
    const scale = cs / CHIP_SIZE;
    const dstH = CHIP_HEIGHT * scale; // 24
    const yOffset = (CHIP_HEIGHT - CHIP_SIZE) * scale; // 8
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = input.cells[eeCellIndex(x, y, width)];
        if (!cell) continue;
        for (const idx of chipIndices(cell.chip)) {
          const r = chipSrcRect(idx);
          if (!r) continue; // 未知index → スキップ
          ctx.drawImage(
            chipImg,
            r.sx, r.sy, r.sw, r.sh,
            x * cs, y * cs - yOffset, cs, dstH,
          );
        }
      }
    }
  }

  // 自キャラマーカー(中抜き赤枠)。
  const { x: sx, y: sy } = input.self;
  if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
    ctx.save();
    ctx.strokeStyle = '#ff3030';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx * cs + 1, sy * cs + 1, cs - 2, cs - 2);
    ctx.restore();
  }
}
