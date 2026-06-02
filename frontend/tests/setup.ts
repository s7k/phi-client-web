// Vitest 共通セットアップ。RTL の matcher を有効化。
import '@testing-library/jest-dom/vitest';

// jsdom は opaque origin(about:blank)では localStorage を無効化するため、
// A-33 の token 保存テスト用に最小のメモリ実装を polyfill する。
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
}

// jsdom は HTMLCanvasElement.getContext 未実装(not-implemented 警告を吐く)。
// MapView は実描画を drawMap ユニットテストで担保するため、ここでは null を返す
// 最小スタブで警告を抑止。
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext =
    (() => null) as unknown as HTMLCanvasElement['getContext'];
}
