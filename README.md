# phi-web

レガシーSJISソケットゲーム(Phantasmal Island系)を、ブラウザからUTF-8で操作可能にするWebクライアント。
**バックエンド(Python/FastAPI)** がレガシーサーバへSJIS TCP接続を常時保持するゲートウェイとなり、**フロントエンド(React/TS)** とは WebSocket(UTF-8 JSON) で通信する。

```
[ブラウザ React/TS] ⇄ wss/JSON ⇄ [FastAPI ゲートウェイ] ⇄ TCP/SJIS ⇄ [レガシーサーバ]
                                    SQLite / 透過PNGアセット
```

## 主な機能

- **認証(A-34/A-33)**: Webアカウント(ID+パスワード, argon2id)でログイン → Bearer token(localStorage)。1アカウントに複数キャラ(ラベル+PHI ID+IP+ポート)を登録し、タブで同時接続。
- **マップ**: Canvas 描画(チップ/キャラ/アイテム/看板)。EagleEye 俯瞰表示。スマホは領域に自動縮小。
- **チャット**: カラーマークアップ対応。通常/大声/パーティ/個人(priv)/全タブ同報。ログは自動スクロール。
- **操作**: キーボード(WASD / PHIテンキー 789uiojklm、F1-F7魔法・F8-F12ショートカット・Shift+G)。移動/攻撃/回転。北固定・視点固定の両モード。
- **ステータス**: HP/MP/EXP/GP・属性(火水風地)・状態異常。世界移動の進行表示。
- **表示/通知**: ダーク/ライトテーマ・フォント倍率(起動時から適用)。ブラウザ通知/通知音。未読バッジと通知は**チャット種別(プレイヤー発言/個人宛)のみ**(NPC会話・DM進行案内は除外)。
- **スマホ最適化**: チャット主体の縦レイアウト、マップ上のタッチ方向パッド(前後左右+回転+攻撃、**右手/左手**切替でマップを逆側に配置)。
- **設定**: キーバインド/通知/表示/更新間隔をBEに永続化。マップのスクリーンショット(SS)。

## 構成

| ディレクトリ | 内容 |
|--------------|------|
| `docs/` | 設計・調査資料一式([docs/README.md](docs/README.md)が索引)。`DEVLOG.md` が並行開発の調整メモ・決定履歴(A-NN) |
| `backend/` | Python/FastAPI ゲートウェイ(プロトコル変換・セッション・WS・REST・SQLite) |
| `frontend/` | React/TypeScript/Vite クライアント(マップ描画・チャット・操作UI) |
| `tools/gfx_convert/` | レガシーBMP→透過PNG変換ツール |
| `assets/` | 変換済透過PNG(gitignore・実行時生成) |
| `legacy/` | レガシー原典(gitignore・ライセンス都合で非コミット) |

## 開発・起動

### バックエンド
```bash
cd backend
uv venv .venv && uv pip install -e ".[dev]"
cp .env.example .env   # 実サーバ接続情報を設定(任意・実値はコミットしない)
uv run uvicorn app.main:app --reload --port 8000
uv run pytest          # テスト(354件)
```
主なenv: `PHI_SECRET_KEY`(uid暗号鍵・本番必須), `PHI_DB_PATH`, `PHI_ASSETS_DIR`, `PHI_HOST`/`PHI_PORT`(既定接続先)。詳細は `backend/README.md`。

### フロントエンド
```bash
cd frontend
npm install
npm run dev              # Vite(:5173, /api・/ws・/assets を :8000 へproxy)
npx vitest run           # ユニット(354件)
npm run test:e2e         # Playwright E2E 構造系(要 npx playwright install chromium)
npm run test:e2e:visual  # ビジュアル回帰(スクショ比較。日本語フォント等の環境差で
                         #   CI不安定のため分離。基準更新は -- --update-snapshots)
```

## Docker

```bash
cp .env.docker.example .env       # PHI_SECRET_KEY 等を設定(.env はgitignore)
# 透過PNGを ./assets に配置(tools/gfx_convert で生成。レガシーBMP別途)
docker compose up --build         # web=:8080(エッジ), backend=:8000(内部)
```
- `web`(nginx): FE静的配信 + `/api`・`/ws`・`/assets` を backend へプロキシ。
- `backend`(uvicorn): SQLiteは名前付きボリューム`db`(/data)に永続化、`./assets`をroマウント。非root実行。
- `PHI_SECRET_KEY` 未設定は compose が起動拒否(uid暗号鍵)。本番は前段でTLS終端(Caddy/LB等, wss)。

## テスト方針(TDD)
- 全コンポーネントをテスト先行で実装。BE=pytest、FE=Vitest+RTL、E2E=Playwright。
- E2E は構造系(レイアウト/テーマ/操作/マップ描画)を `test:e2e` でCI実行。pixel比較の
  ビジュアル回帰は `@visual` タグで分離し `test:e2e:visual` で手動実行。
- レガシー応答は合成フィクスチャ(`backend/tests/fixtures/synthetic/`)で検証。実サーバ録画は `recorded/`(gitignore)。
- 設計: [docs/11-test-design.md](docs/11-test-design.md)。

## セキュリティ / 運用上の注意
- **実キャラID・接続先IP/ポートは秘匿**。コード/コミットに残さない(`backend/.env`=gitignore で供給)。
- レガシー `#open` の uid はパスワード埋め込みのため、SQLiteには**暗号化保存**(Fernet, `PHI_SECRET_KEY`)。Webパスワードは argon2id ハッシュ。
- 認証は Bearer token(A-33)。cookie/CSRF は廃止(token は JS 明示付与でアンビエント資格が無い)。本番は `PHI_SECRET_KEY` 必須・wss(TLS)推奨。
- ⛔ **実サーバへの priv送信・大声・パーティ発言・通常チャットはテストで行わない**(他者迷惑)。`test_connect.py` にガードあり。これらの仕様検証は運用者が別途実施。

## ライセンス / グラフィックス

- ゲームのグラフィックス(キャラクター/オブジェクト/マップパーツ/アイコン等)は
  **PCGL(Phi Charactor Graphics License, Copyright (C) 2000 Athena Developer-ML)** 下にある。
- phi-web は PCGL が想定する「新クライアント/Webページ」に該当する。これらの
  グラフィックスを使用・配布する場合、**PCGL に従い「使用グラフィックスが PCGL 下にある」
  旨を明記する義務**がある(本節がその明記)。PCGL 文書は自由にコピー・頒布可・改変不可。
- 全文: [`licenses/PCGL.utf8.txt`](licenses/PCGL.utf8.txt)(UTF-8 閲覧用) / [`licenses/PCGL.sjis.txt`](licenses/PCGL.sjis.txt)(SJIS 原本)。詳細は [`licenses/README.md`](licenses/README.md)。
  グラフィックスを同梱配布する際は PCGL 全文を成果物へ添付すること。
- **コード(backend/frontend/tools)は MIT License**([`LICENSE`](LICENSE))。グラフィックス資産(PCGL)とは別ライセンス。MIT は permissive(コピーレフトなし)で、改変・商用利用ともに著作権表示と許諾文の保持のみが条件。

## ドキュメント
設計・調査の全体は [docs/README.md](docs/README.md) を参照。実装の進行・決定事項(A-01〜)は [docs/DEVLOG.md](docs/DEVLOG.md)。
