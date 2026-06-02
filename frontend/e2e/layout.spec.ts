import { test, expect } from '@playwright/test';
import { gotoGame } from './helpers';

/**
 * E2E レイアウト検証(desktop / mobile)。
 * game 画面の map/chat/status 3領域の配置を bounding box で検証する。
 * - desktop: 左(map+status) / 右(chat) のサイドバイサイド。
 * - mobile : チャット上 → マップ → ステータス下 の縦積み。
 *            ステータスが viewport 内に収まる(縦切れが無い)ことを確認。
 */

async function boxes(page: import('@playwright/test').Page) {
  const map = await page.locator('.game__map').boundingBox();
  const chat = await page.locator('.game__chat').boundingBox();
  const status = await page.locator('.game__status').boundingBox();
  if (!map || !chat || !status) throw new Error('レイアウト領域が取得できない');
  return { map, chat, status };
}

test.describe('レイアウト: デスクトップ', () => {
  test('map/status が左、chat が右(サイドバイサイド)', async ({ page }) => {
    await gotoGame(page, { width: 1280, height: 800 });
    const { map, chat, status } = await boxes(page);
    // chat は map より右(左カラム=map/status, 右カラム=chat)。
    expect(chat.x).toBeGreaterThan(map.x + map.width / 2);
    // status は map の下(左カラム内で縦積み)。
    expect(status.y).toBeGreaterThanOrEqual(map.y);
    // 全領域が viewport 内。
    expect(status.y + status.height).toBeLessThanOrEqual(800 + 1);
  });

  test('操作パッドはデスクトップでは非表示(キーボード操作)', async ({ page }) => {
    await gotoGame(page, { width: 1280, height: 800 });
    await expect(page.getByRole('group', { name: '操作パッド' })).toBeHidden();
  });
});

test.describe('レイアウト: モバイル', () => {
  const MOBILE = { width: 390, height: 844 };

  test('チャット上→マップ→ステータス下 の縦積み', async ({ page }) => {
    await gotoGame(page, MOBILE);
    const { map, chat, status } = await boxes(page);
    // 縦積み(chat が最上、その下に map、さらに下に status)。
    expect(map.y).toBeGreaterThan(chat.y);
    expect(status.y).toBeGreaterThan(map.y);
    // 横は全幅(左右に並ばない)。
    expect(Math.abs(chat.x - map.x)).toBeLessThan(2);
  });

  test('チャット主体: チャットがマップ/ステータスより高い', async ({ page }) => {
    await gotoGame(page, MOBILE);
    const { map, chat, status } = await boxes(page);
    // スマホはチャット主役 → 最大の縦領域を占有。
    expect(chat.height).toBeGreaterThan(map.height);
    expect(chat.height).toBeGreaterThan(status.height);
    // チャットが viewport の 1/3 超(読める高さ)。
    expect(chat.height).toBeGreaterThan(MOBILE.height / 3);
  });

  test('操作パッド(タッチカーソル)が表示される', async ({ page }) => {
    await gotoGame(page, MOBILE);
    await expect(page.getByRole('group', { name: '操作パッド' })).toBeVisible();
    await expect(page.getByRole('button', { name: '前進' })).toBeVisible();
    await expect(page.getByRole('button', { name: '攻撃' })).toBeVisible();
  });

  test('利き手切替: 既定は右(パッド右・マップ左)、左手でパッド左・マップ右', async ({ page }) => {
    await gotoGame(page, MOBILE);
    const pad = page.getByRole('group', { name: '操作パッド' });
    const map = page.locator('.game__map');
    const vw = MOBILE.width;

    // 既定(右手): パッドは右寄り。
    let padBox = await pad.boundingBox();
    expect(padBox!.x + padBox!.width / 2).toBeGreaterThan(vw / 2);
    await expect(map).toHaveClass(/game__map--pad-right/);

    // 設定で左手へ(モバイルはハンバーガー内に設定)。
    await page.getByRole('button', { name: 'メニュー' }).click();
    await page.getByRole('button', { name: '設定' }).click();
    await page.getByLabel('タッチ操作の利き手').selectOption('left');
    await page.getByRole('button', { name: '閉じる' }).click();

    // 左手: パッドは左寄り、マップは右寄せクラス。
    padBox = await pad.boundingBox();
    expect(padBox!.x + padBox!.width / 2).toBeLessThan(vw / 2);
    await expect(map).toHaveClass(/game__map--pad-left/);
  });

  test('ステータスが画面内に収まる(縦切れが無い)', async ({ page }) => {
    await gotoGame(page, MOBILE);
    const { status } = await boxes(page);
    // status 下端が viewport 高さ以内(±1px 許容)。
    expect(status.y + status.height).toBeLessThanOrEqual(MOBILE.height + 1);
    // status が実際に表示領域内に存在(高さを持つ)。
    expect(status.height).toBeGreaterThan(0);
  });
});
