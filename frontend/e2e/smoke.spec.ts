import { test, expect } from '@playwright/test';

/**
 * E2E スモーク([11] Playwright)。
 *
 * 目的: アプリが起動しログイン画面が描画される最小確認(A-34, アカウント+複数キャラ)。
 * BE 不要 — WS はルート傍受でモック(接続を握り、何も返さない)。
 * これで再接続ループや実 BE 依存を避けつつ、初期 UI の表示を検証。
 */
test.describe('phi-client-web スモーク', () => {
  test('起動でログイン画面が表示される', async ({ page }) => {
    // WS をモック傍受。接続は確立させ、サーバ送信はしない(初期 UI に不要)。
    await page.routeWebSocket(/\/ws$/, () => {
      // 何もしない = open のみ。token 無し → ログイン画面表示。
    });

    await page.goto('/');

    // タイトル(アプリ識別)
    await expect(page).toHaveTitle(/phi-client-web/);
    await expect(page.getByRole('heading', { name: 'phi-client-web' })).toBeVisible();

    // ログインフォーム(A-34): アカウントID + パスワード + ログインボタン。
    await expect(page.getByLabel('アカウントID')).toBeVisible();
    await expect(page.getByLabel('パスワード')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'ログイン' }),
    ).toBeVisible();

    // 新規登録への導線
    await expect(
      page.getByRole('button', { name: '新規登録' }),
    ).toBeVisible();
  });

  test('新規登録へ遷移できる', async ({ page }) => {
    await page.routeWebSocket(/\/ws$/, () => {});
    await page.goto('/');

    await page.getByRole('button', { name: '新規登録' }).click();

    // 登録フォームへ遷移(見出し + パスワード確認 + 戻る導線)
    await expect(
      page.getByRole('heading', { name: 'アカウント登録' }),
    ).toBeVisible();
    await expect(page.getByLabel('パスワード(確認)')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'ログインへ戻る' }),
    ).toBeVisible();
  });
});
