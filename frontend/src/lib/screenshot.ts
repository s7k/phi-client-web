/**
 * F11 スクリーンショット([05]§12)。
 * Canvas(マップ/EagleEye)を canvas.toBlob() で画像化しダウンロード。BE関与なし。
 */

/** ファイル名生成(phi-map-YYYYMMDD-HHMMSS.png)。 */
export function screenshotFilename(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const d =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `phi-map-${d}.png`;
}

/** ブラウザでの Blob ダウンロード(a要素クリック)。 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 解放は次イベントループへ(クリック反映後)。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface ScreenshotDeps {
  /** Blob ダウンロード手段(テストで差替)。 */
  download?: (blob: Blob, filename: string) => void;
  /** ファイル名生成(テストで固定化)。 */
  filename?: () => string;
}

/**
 * Canvas を PNG Blob 化してダウンロード。
 * @returns 成功で true(toBlob が null を返したら false)。
 */
export function captureCanvas(
  canvas: HTMLCanvasElement,
  deps: ScreenshotDeps = {},
): Promise<boolean> {
  const download = deps.download ?? triggerDownload;
  const filename = (deps.filename ?? screenshotFilename)();
  return new Promise<boolean>((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(false);
        return;
      }
      download(blob, filename);
      resolve(true);
    }, 'image/png');
  });
}
