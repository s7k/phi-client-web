/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite + Vitest 設定（vitest設定を内包）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 開発時 BE(FastAPI) への WS/REST プロキシ。BEホストは環境変数で差し替え可。
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8000', ws: true },
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
