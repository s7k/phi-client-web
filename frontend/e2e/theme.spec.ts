import { test, expect } from '@playwright/test';
import { gotoCharacterSelect, gotoGame, mockWsServer } from './helpers';

/**
 * E2E テーマ(dark/light)検証。
 * useTheme が display.theme を documentElement へ適用(data-theme/color-scheme)し、
 * App.css の `:root[data-theme="light"]` で CSS 変数が切替わることを実ブラウザで確認。
 */
test.describe('テーマ', () => {
  test('初期はダークテーマ(data-theme=dark / color-scheme=dark)', async ({ page }) => {
    await mockWsServer(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const colorScheme = await page.evaluate(() => document.documentElement.style.colorScheme);
    expect(colorScheme).toBe('dark');
  });

  test('設定でライトに切替 → data-theme=light + 背景色が変化', async ({ page }) => {
    await gotoGame(page, { width: 1280, height: 800 });

    // 切替前(ダーク)の body 背景色。
    const darkBg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );

    // 設定を開く(デスクトップ幅: アクション群はインライン表示)。
    await page.getByRole('button', { name: '設定' }).click();
    await page.getByLabel('テーマ').selectOption('light');

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const lightScheme = await page.evaluate(() => document.documentElement.style.colorScheme);
    expect(lightScheme).toBe('light');

    // 背景色がダーク時と異なる(CSS変数 --bg が light に切替)。
    const lightBg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(lightBg).not.toBe(darkBg);
  });

  test('ライト→ダークへ戻せる', async ({ page }) => {
    await gotoGame(page, { width: 1280, height: 800 });
    await page.getByRole('button', { name: '設定' }).click();
    await page.getByLabel('テーマ').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByLabel('テーマ').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
