# phi-web frontend

phi-web のフロントエンド。React 18 + TypeScript + Vite。状態管理 Zustand、テスト Vitest + React Testing Library。

BE↔FE の通信契約は `docs/07-ws-protocol.md`。FE側の型実体は `src/types/protocol.ts`。

## セットアップ

```sh
npm install
```

## 起動(開発)

```sh
npm run dev
```

`http://localhost:5173`。`/api` `/ws` は `localhost:8000`(BE)へプロキシ(`vite.config.ts`)。BEホストは将来環境変数化。

## テスト

```sh
npm test          # vitest run(1回)
npm run test:watch
npm run typecheck # tsc --noEmit
```

## ビルド

```sh
npm run build     # tsc -b + vite build
npm run preview
```

## 構成

```
src/
  types/protocol.ts   # BE↔FE WSプロトコル型(契約 [07])
  ws/client.ts        # F1 WSクライアント(エンベロープ/型dispatch/再接続/snapshot)
  stores/             # F2 Zustand stores([12]§5)
    connectionStore.ts  # WS/session接続状態
    sessionStore.ts     # キャラ一覧・アクティブsession・タブ
    mapStore.ts         # session別 map(全置換)
    statusStore.ts      # session別 status/cond(全置換)
    chatStore.ts        # session別 ログ(リングバッファ)・未読
    applySnapshot.ts    # snapshot 一括適用([07]§4.2)
  main.tsx, App.tsx   # エントリ(R0は最小)
tests/                # Vitest(ws-client / stores)
```

## 方針(抜粋)

- UIは近代的に新規実装。レガシースキン画像は不使用([02]§4)。
- WS切断中のFE送信はキューせず破棄(open前のみフラッシュ)([12]§6)。
- 再接続: 指数バックオフ `min(30s, 1s*2^n) + jitter`([12]§6)。
