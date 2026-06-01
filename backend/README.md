# phi-web backend (Gateway)

レガシーSJISソケットゲーム ⇔ ブラウザ(UTF-8 JSON) を仲介するPython/FastAPIゲートウェイ。
設計: [docs/02-architecture-design.md](../docs/02-architecture-design.md) / 契約: [docs/07-ws-protocol.md](../docs/07-ws-protocol.md)

## 必要環境

- Python 3.12
- [uv](https://docs.astral.sh/uv/) (パッケージ管理)

## セットアップ

```bash
# backend/ 直下で実行
uv venv .venv
source .venv/bin/activate
uv pip install -e '.[dev]'
```

uv パス例(mise管理): `$HOME/.local/share/mise/installs/uv/<ver>/uv-x86_64-unknown-linux-musl/uv`

## 起動

```bash
# backend/ 直下(.venv 有効化済み)
uvicorn app.main:app                 # 開発(localhost:8000)
uvicorn app.main:app --host 0.0.0.0 --port 8000   # 本番(TLS終端は前段)
```

ASGI ターゲットは `app.main:app`(`app/main.py`)。起動時に env(下表)を `app.config.Config`
へ集約し、Store(migrate)/AuthService/SessionManager を構築 → `create_app(...)`。レガシー
サーバへは **session.open 時のみ**接続(import/起動では非接続)。`/assets` は
`PHI_ASSETS_DIR` を StaticFiles 配信(ディレクトリ無ければスキップ)。

## テスト

```bash
# backend/ 直下
pytest                       # 全テスト
pytest --cov=app --cov-report=term-missing   # カバレッジ付き
```

uv 実行例: `<uv> run pytest`(uv パスは上記 mise 形式)。
TDD(red→green→refactor)で進行。テスト設計は [docs/11-test-design.md](../docs/11-test-design.md) §5。

## 環境変数

実サーバ接続情報は `.env`(gitignore)に置く。テンプレート: `.env.example`。
秘匿値(IP/Port/ID)はコードにハードコードしない。

起動設定([12]§7, `app/config.py` で集約):

| 変数 | 説明 | 既定 |
|------|------|------|
| `PHI_DB_PATH` | SQLite パス | `:memory:`(揮発) |
| `PHI_SECRET_KEY` | uid 暗号鍵(Fernet, `Fernet.generate_key()` 形式 / urlsafe-base64 32B) | 一時鍵生成(警告) |
| `PHI_ALLOWED_ORIGINS` | CSRF 許可 origin(カンマ区切り) | 未設定=検査無効(開発用) |
| `PHI_ASSETS_DIR` | キャラグラ保存/配信ディレクトリ | `./assets` |
| `PHI_HOST` | レガシーサーバ ホスト(既定接続先) | `""` |
| `PHI_PORT` | ポート | `0` |

レガシー個別接続(`test_connect.py` 等)向け:

| 変数 | 説明 |
|------|------|
| `PHI_CHARACTER_ID` | キャラID(`#open` に渡す) |
| `PHI_VERSION_STRING` | `#version-cli` 値 |

### 本番注意

- `PHI_SECRET_KEY` **必須**: 未設定だと一時鍵を生成し、再起動で `legacy_uid` 復号不能。
- `PHI_ALLOWED_ORIGINS` **必須**: 未設定だと CSRF origin 検査が無効(変更系を素通し)。
  本番 origin を必ず列挙。
- 公開は TLS 終端(前段リバースプロキシ)経由で **wss/https**。cookie は httpOnly/Secure/SameSite=Strict。
- `PHI_DB_PATH` を永続パスに(`:memory:` は揮発)。

## 構成

```
backend/
├── app/
│   └── protocol/
│       ├── line_buffer.py     # \n行分割・SJIS境界考慮 (B1)
│       └── code_converter.py  # SJIS(cp932)⇔UTF-8 行種別分岐 (B2)
├── tests/
│   ├── conftest.py
│   └── fixtures/
│       ├── synthetic/         # サニタイズ済(コミット可)
│       └── recorded/          # 実データ録画(gitignore)
└── pyproject.toml
```

## フィクスチャ方針

- `fixtures/recorded/`: 実サーバ録画。実名/実IP/uid を含むため**コミット禁止**(gitignore)。
- `fixtures/synthetic/`: サニタイズ/手書きの合成データ。CI用主フィクスチャ(コミット対象)。
