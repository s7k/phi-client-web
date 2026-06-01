# テスト設計（TDD）

TDD(red→green→refactor)で進めるためのテスト戦略・ツール・テストケース設計。コンポーネントは [10 網羅性](10-component-completeness.md) に対応。

## 1. 方針

- **テストファースト**: 各モジュールは実装前にテストを書く。リーフ(下層)から積み上げ。
- **実データ駆動**: レガシーサーバ実応答([03]で取得済)を**ゴールデンフィクスチャ**化。バイト列(SJIS)と期待JSONを対で保持。
- **phi-client テスト資産の移植**: `~/workspace/phi-client/tests/`(test_parser, test_line_buffer, test_map_data, test_eagle_eye, test_medit, test_ulist, test_color_markup 等)を移植・拡張。実装の正しさが既に検証済の参照。
- **外部依存の隔離**: レガシーサーバはモックTCPサーバ(フィクスチャ再生)に置換。ネットワーク・実サーバに依存しない。

## 2. テストピラミッド

```
        ┌───────────────┐
        │ E2E (少)       │  Playwright: ブラウザ→BE→モックレガシー 全経路
        ├───────────────┤
        │ Integration(中)│  WS往復・SessionManager・REST・LegacySocket(モックTCP)
        ├───────────────┤
        │ Unit (多)      │  LineBuffer/CodeConverter/Parser/Serializer/gfx/fallback/Store
        └───────────────┘
```

## 3. ツール

| 層 | BE(Python) | FE(TS) |
|----|-----------|--------|
| Unit | pytest, pytest-asyncio, coverage | Vitest |
| Component | pytest(FastAPI `TestClient`/`httpx`) | React Testing Library |
| Integration | pytest + asyncio モックTCP/WS | Vitest + mock WS |
| E2E | — | Playwright(headless) |
| 画像 | Pillow + 既知PNGの画素アサート | — |

CI: GitHub Actions。`pytest --cov`(BE) / `vitest run --coverage`(FE) / `playwright test`。カバレッジ目標: コアロジック(parser/converter/serializer/fallback) **90%+**、全体80%+。

## 4. フィクスチャ

**2階層に分離**(実データ録画はコミットしない):

### 4.1 録画フィクスチャ(実データ・**gitignore**)
`backend/tests/fixtures/recorded/`(**.gitignore対象**):
- `legacy_stream/*.bin` — 実サーバ受信バイト列(SJIS生)。`backend/test_connect.py --record` で録画。
- **実名/実IP/uid を含むため絶対にコミットしない**。各開発者がローカルで録画。
- このディレクトリと `*.rec.bin` は `.gitignore` 済。

### 4.2 合成フィクスチャ(サニタイズ済・**コミット**)
`backend/tests/fixtures/`(直下、コミット可):
- `synthetic/*.bin` — 録画から**実名/実IP/uidをマスク**(ExampleChar/`<SERVER_IP>`等)した、または手書きの合成バイト列。CI用の主フィクスチャ。
- `expected/*.json` — 合成binをParserに通した期待イベント列(ゴールデン)。
- `m57_O_lines.txt` — `#m57 O` 各種(plain/giant/object/特殊文字グラ名)。合成。
- `chip/`, `chara/`, `items/` — 変換前BMP少数 + 期待透過PNG(画素チェック用)。**legacy由来BMPは `.gitignore`(`*.bmp`/`/assets/`)に該当するため、合成/サイズ縮小した検証用のみ別途用意**。

### 4.3 録画→合成の手順
1. `test_connect.py --record <name>` でローカル録画 → `fixtures/recorded/`(gitignore)。
2. サニタイズスクリプトで実名/IP/uid をプレースホルダ置換 → `fixtures/synthetic/` へ出力(コミット対象)。
3. CI・通常テストは `synthetic/` のみ使用(実サーバ・実データ不要)。
4. binは gitattributes で binary 指定。

## 5. BE ユニットテスト設計

### 5.1 LineBuffer ([10] LegacySocket)
- `\n`で行分割、末尾不完全行を保持。
- **SJIS 2バイト境界がバッファ末尾で割れる**ケース(リード文字単独で残る)→次feedで結合。
- `\r\n` 混在の `\r` 除去。空行の扱い。
- 連続feedで分割受信を再現(1バイトずつ投入しても正しく行復元)。

### 5.2 CodeConverter ([10])
- SJIS↔UTF-8 ラウンドトリップ(日本語・記号)。
- **行種別分岐**: `#m57 M`(バイナリ)は変換せず生バイト保持。`#m57 O`は name/gra のオフセット部のみcp932デコード。一般行は全体変換。
- 不正バイト(errors=replace)で例外を出さない。
- マップ地形バイト(0x00-0xFF)が変換で破壊されない。

### 5.3 ProtocolParser ([10])
- 各 `#` コマンド→イベント: `#name`/`#status`/`#cond`/`#map`/`#m57 M/O/.`/`#list`/`#more`/`#s-edit`/`#m-edit`/`#.`/`#user`/`#priv`/`#ex-notice`/`#ex-eagleeye`/`#ch-srv`/`#x`/`#close`。
- `#status` の `:`区切り11項目を正しく分解(HP..C)。
- `#cond` 7フラグ(`*`/`-`)。
- `#m57 O` フィールド(id/x/y/dir/name/status/gra/gigant/**default(type)**)。特殊文字グラ名(バッククォート/日本語/空白)。
- `#m57 M` 7x7=98バイト、`#map M` 5x5。境界(短い/`-`/不正長)。
- color markup(`/*color=*/`,`/*.*/`,`/*cl=*/`)はテキストとして透過(破壊しない)。
- 未知コマンドは無視(前方互換)。

### 5.4 CommandSerializer ([10],[07]§7)
- `chat` mode: normal=素通し / loud=先頭`*` / 先頭`*`の通常発言→`/**/` / priv→`#priv <番号>\n本文`(番号解決)。
- `move` dir/mode → `go N`/`turn l`/`go fl`(5x5/7x7差)。
- `command`: pay→`pay N`(0含む)、castMagic→`cast\n<spell>`、summon→`cast\n<action>\n<creature>`、raw→素通し。
- `list.select`: 数値/`-`/`.`。
- `edit.submit`: multi=各行+`.`、cancel=`.!`。
- UTF-8→cp932変換が送信直前に行われる。

### 5.5 gfx 透過変換 ([06],[08])
- colorkey: clTeal(0,128,128)が透明化、teal以外保持。
- chip(mask-h): 1024×96→512×96、マスク白→不透明/他→透明。チップindex→セル位置。
- mask-v: Items 上=画像/下=マスク、透明数アサート。
- `--lowercase`: 出力名小文字化(`t_Man.bmp`→`t_man.png`)。
- 既知BMP→既知画素(角・特定座標のRGBA)アサート。

### 5.6 フォールバック解決 ([09])
- typeコード→key→chara_index→グラ。
- 未一致code→`intelligent`(0x01)既定。
- case-insensitive(`t_Man`→`t_man`照合)。
- specific gra優先、無ければカテゴリ既定、無ければplaceholder。

### 5.7 Store/SQLite ([02]§6,[08]§4)
- accounts/characters/sessions/settings CRUD。
- chara_graphics: gra_key(=lower)一意、sha256冪等(重複アップロード)。
- chara_index upsert、Index.txt 取込(cp932・`//`無視・`=`分解)/生成ラウンドトリップ。
- last_server 更新(世界移動)。

## 6. BE 統合テスト設計

### 6.1 LegacySocket × モックTCP
- フィクスチャbinを流すモックTCPサーバを立て、接続→ログインシーケンス送信→受信行が期待通り。
- 切断(EOF)・タイムアウト・再接続。
- 部分送信(チャンク分割)でも行復元。

### 6.2 SessionManager ([07]§4)
- ログイン→セッション確立→`snapshot`生成。
- FE切断→detached→タイムアウト前の再接続で**同セッション再アタッチ＋snapshot再送**。
- タイムアウト到達→`#x`送信・破棄。
- 複数キャラ(session多重)・`all`発言が全セッションへ。
- 2重ログイン(`#x`)時の挙動。

### 6.3 WS往復 (intent→レガシー→event)
- `chat`(各mode)送信→モックレガシーが受信した生バイトを検証。
- レガシー`#status`受信→FEへ`status`イベント(JSON)配信。
- `#lag`→自動`#end-lag`(FEに出さない)。
- エラー: 不正intent→`error`(BAD_REQUEST)、レガシー切断→`error`(LEGACY_DISCONNECTED)。

### 6.4 REST chara ([08]§7)
- BMPアップロード→透過PNG保存→メタ返却、`graphics/{graName}/png`配信(ETag)。
- 特殊文字graName(URLエンコード)の保存/解決。
- Index取込→`chara_index`反映→`index.txt`生成ラウンドトリップ。
- manifest取得。
- 認証なし→401、サイズ超過→4xx。

## 7. FE テスト設計

### 7.1 ユニット/コンポーネント(Vitest+RTL)
- color markup パーサ→装飾要素(色/`img=`)。
- キーハンドラ: キー→intent(move/list/action)。レイアウト差。
- マップ描画: chip/chara/items 配置(Canvasモック or スナップショット)。グラ解決フォールバック。
- ステータス/cond 表示、リストUI、編集ダイアログ、privウィンドウ、タブ。
- WSクライアント: エンベロープ送受信、`snapshot`適用で各storeが復元、再接続バックオフ。

### 7.2 E2E(Playwright)
- モックBE(WS/REST)に対し: ログイン→キャラ選択→`snapshot`描画→移動intent送信→`map`更新反映。
- チャット送信(loud確認ダイアログ)→送信。
- リストモード選択→`list.select`。
- 切断→再接続→画面復元。

## 8. TDD 実装順序(フェーズ対応 [02]§8)

各ステップは「テスト→実装→リファクタ」。

1. **LineBuffer**(unit) → **CodeConverter**(unit) — 文字コード基盤。
2. **ProtocolParser**(unit, フィクスチャ) — phi-client tests 移植から。
3. **CommandSerializer**(unit)。
4. **LegacySocket**(integration, モックTCP)。
5. **SessionManager**(integration) — detach/reattach/snapshot。
6. **WsServer/往復**(integration)。
7. **Store**(unit) → **gfx/fallback**(unit) → **REST chara**(integration)。
8. **FE**: WSクライアント→各UIコンポーネント→E2E。

## 9. 未確定の前提(テストで仮固定)

- 認証トークン方式([10]§4)が未確定 → テストは抽象IF(`authenticate(token)->session`)でモック。確定後に具体化。
- 設定スキーマ未確定 → 最小JSONで仮置き、確定後にスキーマ検証テスト追加。
- 新規キャラ作成プロトコル未調査 → 当面テスト対象外。調査後に追加。

## 10. 成果物(テスト基盤)

- `backend/tests/`(pytest, conftest でモックTCP/WS・フィクスチャローダ)
- `backend/tests/fixtures/`(録画bin + 期待JSON + 画像)
- `frontend/tests/`(Vitest unit + Playwright e2e)
- CI: `.github/workflows/test.yml`(BE/FE 並列、カバレッジ閾値ゲート)
- 録画ツール: `backend/test_connect.py --record`(フィクスチャ生成)
