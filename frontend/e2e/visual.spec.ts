import { test, expect } from '@playwright/test';
import { gotoGame } from './helpers';

/**
 * E2E ビジュアル回帰 + マップ描画検証。
 *
 * - toHaveScreenshot で game 画面の見た目(dark/light/mobile)を基準画像と比較。
 *   **@visual タグ**で分離: CI(`test:e2e`)からは除外し、手動 `npm run test:e2e:visual` で実行。
 *   理由: 日本語フォント等の環境差で pixel が揺れ、CI ランナーでは不安定になりやすい。
 *   基準更新は `npm run test:e2e:visual -- --update-snapshots`(基準は linux/Noto CJK 前提)。
 *   フォント差等の微小揺れを maxDiffPixelRatio で許容、アニメは無効化。
 * - マップ描画: snapshot に map を含めると MapView が canvas(map-canvas)を
 *   描画する(未取得時は map-empty)。Canvas のマウントとサイズを検証。
 *   ※ チップ画像(/assets)は E2E に無いため pixel 内容までは検証しない。
 */

const SNAP_OPTS = { animations: 'disabled' as const, maxDiffPixelRatio: 0.02 };

test.describe('ビジュアル回帰 @visual', () => {
  test('デスクトップ game(ダーク)', async ({ page }) => {
    await gotoGame(page, { width: 1280, height: 800 });
    await expect(page.locator('.game')).toHaveScreenshot('game-desktop-dark.png', SNAP_OPTS);
  });

  test('デスクトップ game(ライト)', async ({ page }) => {
    await gotoGame(page, { width: 1280, height: 800 });
    await page.getByRole('button', { name: '設定' }).click();
    await page.getByLabel('テーマ').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // 設定パネルを閉じてから撮影。
    await page.getByRole('button', { name: '閉じる' }).click();
    await expect(page.locator('.game')).toHaveScreenshot('game-desktop-light.png', SNAP_OPTS);
  });

  test('モバイル game(チャット主体)', async ({ page }) => {
    await gotoGame(page, { width: 390, height: 844 });
    await expect(page.locator('.game')).toHaveScreenshot('game-mobile-dark.png', SNAP_OPTS);
  });
});

test.describe('マップ描画', () => {
  test('map snapshot 受信で Canvas が描画される(サイズ確定)', async ({ page }) => {
    await gotoGame(page, { width: 1280, height: 800 });
    const canvas = page.getByTestId('map-canvas');
    await expect(canvas).toBeVisible();
    // map 未取得時の map-empty ではなく canvas が出ていること。
    await expect(page.getByTestId('map-empty')).toHaveCount(0);
    // Canvas の描画解像度(width/height 属性)が正の値(size*chip)。
    const dims = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return { w: c.width, h: c.height };
    });
    expect(dims.w).toBeGreaterThan(0);
    expect(dims.h).toBeGreaterThan(0);
    // 7x7 グリッド → 正方形。
    expect(dims.w).toBe(dims.h);
  });
});
