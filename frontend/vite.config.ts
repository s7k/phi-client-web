/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開発プロキシ先 BE。env で差し替え可(VITE_BE_HOST 既定 localhost:8000)。
const BE_HOST = process.env.VITE_BE_HOST ?? 'localhost:8000';
const BE_HTTP = `http://${BE_HOST}`;
const BE_WS = `ws://${BE_HOST}`;

// Vite + Vitest 設定（vitest設定を内包）
export default defineConfig({
  plugins: [react()],
  // FE ビルド資産は /app/ 配下に出力。/assets は BE のグラ静的資源専用([02]§7)で衝突回避。
  build: {
    assetsDir: 'app',
  },
  server: {
    port: 5173,
    // 開発時 BE(FastAPI) へのプロキシ([02]§7 リバースプロキシ: /api→FastAPI, /ws→WS, /assets→静的)。
    proxy: {
      '/api': { target: BE_HTTP, changeOrigin: true },
      '/ws': { target: BE_WS, ws: true, changeOrigin: true },
      // グラ等の静的アセットは BE 配信。
      '/assets': { target: BE_HTTP, changeOrigin: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
    },
  },
});
