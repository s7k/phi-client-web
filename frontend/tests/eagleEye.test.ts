import { describe, it, expect, beforeEach, vi } from 'vitest';
import { drawEagleEye, eeCellIndex, EE_CELL } from '../src/lib/drawEagleEye';
import { useEagleEyeStore } from '../src/stores/eagleEyeStore';
import type { EagleEyeInput } from '../src/lib/drawEagleEye';
import type { MapCell } from '../src/types/protocol';

/** size×size の同一チップグリッド生成。 */
function grid(size: number, chip = ' '.charCodeAt(0)): MapCell[] {
  return Array.from({ length: size * size }, () => ({ chip, attr: 0 }));
}

/** drawImage 呼出を記録する最小 ctx モック。 */
function mockCtx() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
  } as unknown as CanvasRenderingContext2D & {
    drawImage: ReturnType<typeof vi.fn>;
    strokeRect: ReturnType<typeof vi.fn>;
  };
}

describe('eeCellIndex', () => {
  it('行優先 index', () => {
    expect(eeCellIndex(0, 0, 15)).toBe(0);
    expect(eeCellIndex(2, 1, 15)).toBe(17);
  });
});

describe('drawEagleEye', () => {
  const chipImg = {} as HTMLImageElement;

  it('15×15 グリッドを全セル描画 + 自キャラ枠', () => {
    const ctx = mockCtx();
    const input: EagleEyeInput = {
      width: 15,
      height: 15,
      self: { x: 7, y: 7 },
      cells: grid(15),
    };
    drawEagleEye(ctx, input, { chip: chipImg });
    // 空白チップ(index 0)→ 各セル1回 drawImage。
    expect(ctx.drawImage).toHaveBeenCalledTimes(15 * 15);
    // 自キャラマーカー枠。
    expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
    expect(ctx.strokeRect).toHaveBeenCalledWith(
      7 * EE_CELL + 1,
      7 * EE_CELL + 1,
      EE_CELL - 2,
      EE_CELL - 2,
    );
  });

  it('chip 未ロード時はタイル描画スキップ(枠は出す)', () => {
    const ctx = mockCtx();
    const input: EagleEyeInput = {
      width: 3,
      height: 3,
      self: { x: 1, y: 1 },
      cells: grid(3),
    };
    drawEagleEye(ctx, input, { chip: null });
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
  });
});

describe('useEagleEyeStore', () => {
  beforeEach(() => useEagleEyeStore.getState().reset());

  it('setEagleEye で session別保持・clear で削除', () => {
    useEagleEyeStore.getState().setEagleEye('s1', {
      type: 'eagleEye',
      session: 's1',
      width: 15,
      height: 15,
      self: { x: 7, y: 7 },
      cells: grid(15),
    });
    expect(useEagleEyeStore.getState().bySession['s1'].width).toBe(15);
    useEagleEyeStore.getState().clear('s1');
    expect(useEagleEyeStore.getState().bySession['s1']).toBeUndefined();
  });
});
