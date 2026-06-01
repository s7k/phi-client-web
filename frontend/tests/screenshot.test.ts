import { describe, it, expect, vi } from 'vitest';
import { captureCanvas, screenshotFilename } from '../src/lib/screenshot';

describe('screenshotFilename', () => {
  it('phi-map-YYYYMMDD-HHMMSS.png 形式', () => {
    const d = new Date(2026, 5, 2, 3, 4, 5); // 2026-06-02 03:04:05(月は0始まり)
    expect(screenshotFilename(d)).toBe('phi-map-20260602-030405.png');
  });
});

describe('captureCanvas', () => {
  function makeCanvas(blob: Blob | null): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.toBlob = vi.fn((cb: BlobCallback, type?: string) => {
      expect(type).toBe('image/png');
      cb(blob);
    }) as HTMLCanvasElement['toBlob'];
    return canvas;
  }

  it('toBlob を image/png で呼び Blob をダウンロード', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const canvas = makeCanvas(blob);
    const download = vi.fn();
    const ok = await captureCanvas(canvas, { download, filename: () => 'shot.png' });
    expect(ok).toBe(true);
    expect(canvas.toBlob).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(blob, 'shot.png');
  });

  it('toBlob が null を返すと false(ダウンロードしない)', async () => {
    const canvas = makeCanvas(null);
    const download = vi.fn();
    const ok = await captureCanvas(canvas, { download });
    expect(ok).toBe(false);
    expect(download).not.toHaveBeenCalled();
  });
});
