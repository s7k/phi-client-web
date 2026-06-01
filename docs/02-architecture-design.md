# Webクライアント アーキテクチャ設計

`legacy/` のSJISソケットゲームを、ブラウザからUTF-8で操作可能にするWebクライアントの設計。調査結果は [01-legacy-investigation.md](01-legacy-investigation.md) 参照。

## 1. ゴール / 要件

- バックエンドがレガシーサーバへ **SJISソケット接続を常時保持**（タイムアウトあり）。
- ブラウザ（フロント）はバックエンドへ接続し、API経由で **UTF-8** で送受信。
- IDファイル等は **SQLite** 管理。
- ゴール: ブラウザからゲーム操作完結。

## 2. 全体構成図

```
[ブラウザ/フロント]              [バックエンド(Gateway)]            [レガシーゲームサーバ]
   React/TS等                       Node.js or Python                  C / BSD socket
   UTF-8 JSON          WebSocket        ┌──────────────┐    TCP/SJIS生バイト
   ◀──────────────────────────▶  │ セッション管理 │ ◀──────────────────────▶
   描画(Canvas)        (UTF-8 JSON)     │ SJIS⇔UTF-8    │   行(#cmd \n)
   キー入力                            │ プロトコル変換 │
                                       │ SQLite        │
                                       └──────────────┘
```

### 役割分担
- **バックエンド常時接続**: ユーザーがブラウザを閉じても一定時間（タイムアウト）はレガシーサーバとの接続を維持。`#lag`/`#end-lag`・キープアライブ(`#code-sjis`定期送信)をバックエンドが代行。再接続時はセッション復帰。
- **フロント**: 描画・入力のみ。プロトコルの泥臭い部分（行分割・コード変換・ラグ応答）は一切持たない。

## 3. バックエンド設計

### 3.1 技術選定（推奨）
- **言語/ランタイム**: Node.js + TypeScript（WebSocket・バイナリ/文字コード扱い・エコシステムが容易）。代替: Python (asyncio)。
- **SJIS変換**: Node `iconv-lite`（`Shift_JIS`）。Python は `codecs`（`cp932`推奨, Windows由来SJIS互換）。
- **WebSocket**: `ws`（Node）。
- **SQLite**: `better-sqlite3`（同期・高速）。

> CLAUDE.md方針: AIアプリではないため Claude API は不要。純粋なゲートウェイ実装。

### 3.2 内部モジュール

| モジュール | 責務 |
|------------|------|
| `LegacySocket` | レガシーサーバへのTCP接続1本。生バイトバッファ → `\n`行分割。再接続・タイムアウト・切断検知（`tcp.c`の挙動を参考）|
| `CodeConverter` | SJIS(cp932)⇔UTF-8。**`#`コマンド名はASCII固定**なので、行を `#cmd` と `引数` に分けて引数部のみ変換。地形/グラ名等の生バイト保持領域は変換除外（要マッピング） |
| `ProtocolParser` | レガシー行 → 構造化イベント（map/status/cond/list/message…）。逆に フロント操作 → レガシー行 |
| `SessionManager` | ブラウザセッション ⇔ LegacySocket の対応。ブラウザ切断後もタイムアウトまで接続保持。再接続でアタッチ |
| `WsServer` | ブラウザとのWebSocket。UTF-8 JSON メッセージ送受信 |
| `Store(SQLite)` | ID/認証情報・キャラID・設定の永続化 |

### 3.3 文字コード変換の注意（最重要）
- レガシーは行全体SJIS。ただし `#map`/`#m57` の地形50文字・アイテム50文字・グラ名はSJIS文字ではなく**符号化された生バイト/識別子**の可能性大。
- 方針: 行種別ごとに変換戦略を分岐。
  - チャット・名前・看板・メッセージ → SJIS⇔UTF-8 変換。
  - マップ地形/グラ識別子 → 生バイトのまま base64 等でJSON格納、変換しない。
- 切り分けは調査の「未確認事項」（地形コード体系）解明後に確定。初期はチャット系のみ変換し、マップは生データ通過で段階実装。
- 受信は部分バイト境界に注意（マルチバイト途中で分割されうる）。`\n`で行確定してから変換。

### 3.4 接続ライフサイクル
1. フロント接続 → 認証（SQLiteのID照合）。
2. SessionManager がLegacySocket確保（既存なら再アタッチ、無ければ新規TCP接続 + `#open <ID>`）。
3. LoginCommand相当（`#map-iv` `#status-iv` 等）送信。
4. 双方向リレー開始。
5. フロント切断 → セッションを「detached」化、タイムアウトカウント開始。レガシー接続は維持しキープアライブ継続。
6. タイムアウト到達 → `#x` 送信し切断・セッション破棄。
7. 上記内にフロント再接続 → 同セッションへアタッチ、現在のmap/statusを再送。

## 4. フロント設計

### 4.1 技術選定
- React + TypeScript + Vite。描画は Canvas（マップ・キャラ）。
- 状態管理: 軽量（Zustand等）。WebSocketクライアント。

### 4.2 機能
- ログイン画面（ID/キャラ選択）。
- マップ描画（5x5 / 7x7。サーバから来るmapイベントを描画）。
- ステータス/状態異常表示。
- チャット/ログ表示・発言入力（UTF-8）。
- キー入力 → 移動/アクション。リスト選択モード(`#list`/`#s-edit`/`#m-edit`)対応。
- 画像資源（chara/skin）はWeb用アセットとして配信（`legacy/client/Philly/chara` 等を変換・ホスティング）。

## 5. WebSocket API（フロント⇔バックエンド, UTF-8 JSON）

### 5.1 フロント → バックエンド
```jsonc
{ "type": "login",   "id": "...", "password": "..." }
{ "type": "command", "raw": "hi" }            // ゲーム操作コマンド（#無し）
{ "type": "move",    "dir": "up" }            // 方向 → バックエンドでレガシー方向コードへ
{ "type": "chat",    "text": "こんにちは" }    // UTF-8発言 → SJIS変換し送信
{ "type": "list",    "select": 3 }            // リスト選択
{ "type": "proto",   "cmd": "#map" }          // 明示プロトコル要求（必要時）
```

### 5.2 バックエンド → フロント
```jsonc
{ "type": "map",    "size": 5, "dir": 2, "tiles": [...], "chars": [...], "signs": [...] }
{ "type": "status", "name":"...", "hp":..., "maxHp":..., "mp":..., "maxMp":..., "exp":..., "money":..., "flv":..., "wlv":..., "mlv":..., "clv":... }
{ "type": "cond",   "poison":true, "paralysis":false, ... }
{ "type": "message","channel":"log","text":"..." }   // UTF-8変換済
{ "type": "list",   "lines":[...] }
{ "type": "edit",   "mode":"single|multi" }          // #s-edit/#m-edit
{ "type": "system", "event":"attack|magic|disconnect|...", "detail":"..." }
{ "type": "connection", "state":"connected|detached|closed" }
```

`#lag`/`#end-lag`・キープアライブはバックエンド内部処理でフロントへ出さない。

## 6. SQLite スキーマ（初版案）

```sql
CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,      -- ログインID
  password_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE characters (
  char_id      TEXT PRIMARY KEY,      -- #open に渡すキャラクターID
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  display_name TEXT,
  last_server  TEXT,                  -- 世界移動対応(将来)
  updated_at   TEXT NOT NULL
);
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  char_id      TEXT NOT NULL REFERENCES characters(char_id),
  state        TEXT NOT NULL,         -- attached/detached/closed
  connected_at TEXT, detached_at TEXT
);
CREATE TABLE settings (             -- map-iv/status-iv 等のクライアント設定
  char_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  PRIMARY KEY (char_id, key)
);
```

レガシーのキャラデータ本体（`phi.cd` 等）はサーバ側管理。SQLiteは**Web側の認証/セッション/設定/IDマッピング**に限定。

## 7. ディレクトリ構成（提案）

```
phi-web/
├── docs/                  # 本資料群
├── legacy/                # 既存（変更しない）
├── backend/               # Node.js ゲートウェイ
│   ├── src/
│   │   ├── legacySocket.ts
│   │   ├── codeConverter.ts
│   │   ├── protocol/      # parser, serializer, command table
│   │   ├── session.ts
│   │   ├── wsServer.ts
│   │   └── store/         # SQLite
│   └── package.json
├── frontend/              # React + Vite
│   ├── src/
│   └── package.json
└── assets/                # legacy画像をWeb用に変換した資源
```

## 8. 実装フェーズ計画

1. **フェーズ0 — 検証**: 小スクリプトで実レガシーサーバへTCP接続、`#open`→`#map`受信、SJIS変換往復を確認。未確認事項（認証・地形コード・UTF対応）を解明。
2. **フェーズ1 — バックエンド最小**: LegacySocket + CodeConverter + ProtocolParser + WS。チャット送受信のみUTF-8で疎通。
3. **フェーズ2 — マップ/ステータス**: map/status/cond をJSON化、フロントで描画。
4. **フェーズ3 — 入力系**: 移動・アクション・リスト選択・1行/複数行入力。
5. **フェーズ4 — セッション永続化**: 常時接続+タイムアウト+再アタッチ、SQLite認証。
6. **フェーズ5 — 資源/仕上げ**: 画像・BGM配信、UI整備。世界移動(`#ch-srv`)は最後（任意）。

## 9. リスク / 留意点
- 文字コード変換の境界（地形/グラ名の生バイト）— フェーズ0で必ず実データ確認。
- マルチバイト分割受信 — 行確定後に変換。
- レガシーサーバの2重ログイン検知(`#x`)— セッション再アタッチ設計で衝突回避。
- サーバ`main()`非同梱 — 実サーバへの接続情報（IP/Port）入手が前提。無い場合はレガシーserver再ビルドが必要。
