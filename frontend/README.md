# phi-web frontend

phi-web のフロントエンド。React 18 + TypeScript + Vite。状態管理 Zustand、テスト Vitest + React Testing Library。

BE↔FE の通信契約は `docs/07-ws-protocol.md`。FE側の型実体は `src/types/protocol.ts`。

## セットアップ

```sh
npm install
```

## 起動(開発)

BE(FastAPI)を別ターミナルで並行起動した上で:

```sh
# 1. BE 起動(別ターミナル, backend/ にて)
#    既定 http://localhost:8000 で待受

# 2. FE dev サーバ
npm run dev
```

`http://localhost:5173`。dev proxy(`vite.config.ts`)で以下を BE へ転送([02]§7 リバースプロキシ):

- `/api`  → `http://localhost:8000`(REST: 認証/キャラ/登録)
- `/ws`   → `ws://localhost:8000`(WebSocket, `ws:true`)
- `/assets` → `http://localhost:8000`(グラ等の静的資源)

プロキシ先 BE ホストは env `VITE_BE_HOST`(既定 `localhost:8000`)で差し替え可:

```sh
VITE_BE_HOST=192.0.2.10:8000 npm run dev
```

### WS 接続先(env)

FE の WS 接続先は既定で相対 `/ws`(同一オリジン → 上記 proxy / 本番リバースプロキシ経由)。
env `VITE_WS_URL` で上書き可(`src/ws/wsUrl.ts`):

- 未指定/相対(`/ws`): 現オリジンの protocol/host で絶対化(http→ws, https→wss)
- 絶対(`ws://be:8000/ws`, `wss://...`): そのまま使用

## テスト

```sh
npm test          # vitest run(単体, 1回)
npm run test:watch
npm run typecheck # tsc --noEmit
npm run test:e2e  # Playwright E2E スモーク(BE 不要, WS はモック傍受)
```

E2E は初回のみブラウザ DL が必要:

```sh
npx playwright install chromium
```

`test:e2e` は内部で `npm run build && npm run preview`(ポート 4173)を webServer として起動し、
ビルド済資産に対してスモーク(ログイン画面表示・登録遷移)を実行する。Vitest(単体)とは分離。

## ビルド

```sh
npm run build     # tsc -b + vite build
npm run preview
```

FE のビルド資産は `dist/app/` に出力(`build.assetsDir: 'app'`)。
`/assets` は BE のグラ静的資源用に予約([02]§7)で、FE 資産と衝突しない。

## 構成

```
src/
  types/protocol.ts   # BE↔FE WSプロトコル型(契約 [07])
  ws/client.ts        # F1 WSクライアント(エンベロープ/型dispatch/再接続/snapshot)
  ws/wsUrl.ts         # WS接続先URL解決(env VITE_WS_URL / 相対→絶対)
  stores/             # F2 Zustand stores([12]§5)
    connectionStore.ts  # WS/session接続状態
    sessionStore.ts     # キャラ一覧・アクティブsession・タブ
    mapStore.ts         # session別 map(全置換)
    statusStore.ts      # session別 status/cond(全置換)
    chatStore.ts        # session別 ログ(リングバッファ)・未読
    applySnapshot.ts    # snapshot 一括適用([07]§4.2)
  main.tsx, App.tsx   # エントリ
tests/                # Vitest(単体: ws-client / stores / components 等)
e2e/                  # Playwright E2E スモーク(smoke.spec.ts)
playwright.config.ts  # E2E 設定(webServer=vite preview)
```

## 方針(抜粋)

- UIは近代的に新規実装。レガシースキン画像は不使用([02]§4)。
- WS切断中のFE送信はキューせず破棄(open前のみフラッシュ)([12]§6)。
- 再接続: 指数バックオフ `min(30s, 1s*2^n) + jitter`([12]§6)。
