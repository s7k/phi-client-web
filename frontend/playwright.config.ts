import { defineConfig, devices } from '@playwright/test';

/**
 * E2E スモーク設定。Vitest(単体)とは分離(`npm run test:e2e`)。
 *
 * webServer で vite preview(ビルド済 dist)を起動し、その URL に対してテスト。
 * BE は不要(WS はテスト内で `page.routeWebSocket` によりモック/傍受)。
 *
 * CI 等でブラウザ未導入の環境では `npx playwright install chromium` が前提。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // ビルド済資産を preview(本番相当)。dev でも可だが preview の方が安定。
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
