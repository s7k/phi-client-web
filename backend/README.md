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

## テスト

```bash
# backend/ 直下
pytest                       # 全テスト
pytest --cov=app --cov-report=term-missing   # カバレッジ付き
```

TDD(red→green→refactor)で進行。テスト設計は [docs/11-test-design.md](../docs/11-test-design.md) §5。

## 環境変数

実サーバ接続情報は `.env`(gitignore)に置く。テンプレート: `.env.example`。
秘匿値(IP/Port/ID)はコードにハードコードしない。

| 変数 | 説明 |
|------|------|
| `PHI_HOST` | レガシーサーバ ホスト |
| `PHI_PORT` | ポート |
| `PHI_CHARACTER_ID` | キャラID(`#open` に渡す) |
| `PHI_VERSION_STRING` | `#version-cli` 値 |

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
