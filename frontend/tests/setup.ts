// Vitest 共通セットアップ。RTL の matcher を有効化。
import '@testing-library/jest-dom/vitest';

// jsdom は HTMLCanvasElement.getContext 未実装(not-implemented 警告を吐く)。
// MapView は実描画を drawMap ユニットテストで担保するため、ここでは null を返す
// 最小スタブで警告を抑止。
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext =
    (() => null) as unknown as HTMLCanvasElement['getContext'];
}
