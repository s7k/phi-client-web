import type { Page } from '@playwright/test';

/**
 * E2E 共通ヘルパ。BE 無しで game 画面まで到達させる。
 *
 * 仕組み:
 * - localStorage に token を仕込み(addInitScript)→ App restore() でログイン状態。
 * - `GET /api/characters` を page.route でモック(キャラ1件)。
 * - WS を routeWebSocket で疑似サーバ化:
 *   - hello を初送。
 *   - `auth {token}` → `auth {ok:true}`。
 *   - `session.open {charId,reqId}` → `session.open {reqId,ok,session}` + connection + snapshot。
 * - キャラ選択画面のカードをクリック → game 画面へ。
 */

/** game 画面を充実させる snapshot(map/status/cond/notice)。 */
const SNAPSHOT = {
  // 7x7 マップ。MapView が data-testid="map-canvas" を描画(map 未取得時は map-empty)。
  // チップ画像(/assets)は E2E に無いため pixel は黒だが、Canvas のマウント/サイズは検証可。
  map: {
    size: 7,
    dir: 0,
    style: 'solid',
    mapset: 'town',
    cells: Array.from({ length: 49 }, () => ({ chip: 1, attr: 0 })),
    chars: [
      { id: 1, x: 3, y: 3, dir: 'B', name: 'Wilt', gra: 't_man',
        status: 0, gigant: '#', layer: 0, default: 0 },
    ],
    signs: [],
  },
  status: {
    name: 't_Lord', hp: 80, maxHp: 100, mp: 30, maxMp: 50,
    exp: 1234, gp: 567, f: 1, w: 2, m: 3, c: 4,
  },
  cond: {
    poison: false, palsy: false, panic: false, confuse: false,
    berserk: false, silence: false, blind: false,
  },
  notice: { world: 'Ransaia', area: '港町', name: 'Wilt' },
};

/** WS 疑似サーバ(auth/session.open に応答, snapshot 送出)。 */
export async function mockWsServer(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.onMessage((raw) => {
      let msg: { type?: string; reqId?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth', ok: true, isAdmin: false }));
      } else if (msg.type === 'session.open') {
        ws.send(JSON.stringify({
          type: 'session.open', reqId: msg.reqId, ok: true,
          session: 's1', isAdmin: false,
        }));
        ws.send(JSON.stringify({ type: 'connection', session: 's1', state: 'connected' }));
        ws.send(JSON.stringify({ type: 'snapshot', session: 's1', ...SNAPSHOT }));
      }
    });
    // 接続直後に hello を送る(protocolVersion)。
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, serverTime: 0 }));
  });
}

/** token を仕込み characters をモックして '/' を開く(ログイン済=キャラ選択画面)。 */
export async function gotoCharacterSelect(
  page: Page,
  viewport?: { width: number; height: number },
): Promise<void> {
  if (viewport) await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    window.localStorage.setItem('phi_token', 'e2e-token');
  });
  await page.route('**/api/characters', async (route) => {
    await route.fulfill({
      json: { characters: [{ charId: 'c1', label: 'TestChar', host: '127.0.0.1', port: 20000 }] },
    });
  });
  await mockWsServer(page);
  await page.goto('/');
}

/** キャラ選択 → カードクリックで game 画面へ到達。 */
export async function gotoGame(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  await gotoCharacterSelect(page, viewport);
  // 選択カード(削除ボタンと区別するため .charsel__char を指定)。
  await page.locator('.charsel__char').click();
  // game 画面のステータス(snapshot 反映)が出るまで待つ。
  await page.locator('.game__status').waitFor({ state: 'visible' });
}
