# phi-web

レガシーSJISソケットゲーム(Phantasmal Island系)を、ブラウザからUTF-8で操作可能にするWebクライアント。
**バックエンド(Python/FastAPI)** がレガシーサーバへSJIS TCP接続を常時保持するゲートウェイとなり、**フロントエンド(React/TS)** とは WebSocket(UTF-8 JSON) で通信する。

```
[ブラウザ React/TS] ⇄ wss/JSON ⇄ [FastAPI ゲートウェイ] ⇄ TCP/SJIS ⇄ [レガシーサーバ]
                                    SQLite / 透過PNGアセット
```

## 構成

| ディレクトリ | 内容 |
|--------------|------|
| `docs/` | 設計・調査資料一式([docs/README.md](docs/README.md)が索引)。`DEVLOG.md` が並行開発の調整メモ |
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
uv run pytest          # テスト(238件)
```
主なenv: `PHI_SECRET_KEY`(uid暗号鍵・本番必須), `PHI_DB_PATH`, `PHI_ALLOWED_ORIGINS`(本番必須), `PHI_ASSETS_DIR`, `PHI_HOST`/`PHI_PORT`(既定接続先)。詳細は `backend/README.md`。

### フロントエンド
```bash
cd frontend
npm install
npm run dev            # Vite(:5173, /api・/ws・/assets を :8000 へproxy)
npx vitest run         # ユニット(217件)
npm run test:e2e       # Playwright E2E(要 npx playwright install chromium)
```

## テスト方針(TDD)
- 全コンポーネントをテスト先行で実装。BE=pytest、FE=Vitest+RTL、E2E=Playwright。
- レガシー応答は合成フィクスチャ(`backend/tests/fixtures/synthetic/`)で検証。実サーバ録画は `recorded/`(gitignore)。
- 設計: [docs/11-test-design.md](docs/11-test-design.md)。

## セキュリティ / 運用上の注意
- **実キャラID・接続先IP/ポートは秘匿**。コード/コミットに残さない(`backend/.env`=gitignore で供給)。
- レガシー `#open` の uid はパスワード埋め込みのため、SQLiteには**暗号化保存**(`PHI_SECRET_KEY`)。
- ⛔ **実サーバへの priv送信・大声・パーティ発言・通常チャットはテストで行わない**(他者迷惑)。`test_connect.py` にガードあり。これらの仕様検証は運用者が別途実施。
- 本番は wss(TLS)・`PHI_SECRET_KEY`/`PHI_ALLOWED_ORIGINS` 設定必須。

## ドキュメント
設計・調査の全体は [docs/README.md](docs/README.md) を参照。実装の進行・決定事項は [docs/DEVLOG.md](docs/DEVLOG.md)。
