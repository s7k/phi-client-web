# キャラクターグラフィック アップロード・保管 設計

新機能2点の設計。実装は別途。

1. キャラクターBMPファイルをサーバへアップロードし、**透過PNG**として保管。
2. **Index.txt**(キャラ名/カテゴリ → グラフィックファイル名のエイリアス) をサーバサイド(SQLite)で保管。

前提: バックエンド = **Python (FastAPI)**、保管メタ = **SQLite**。透過変換は既存 `tools/gfx_convert/convert.py` のカラーキー方式(キャラ=clTeal)を再利用。関連: [02 アーキ](02-architecture-design.md)・[06 透過](06-graphics-transparency.md)・[07 WSプロトコル](07-ws-protocol.md)。

---

## 1. 位置づけ

- これらは**アセット管理機能**。ゲーム操作(WS)とは別系統の **HTTP REST** で提供(ファイルアップロード・静的配信に適する)。
- フロントの描画([06]・phi-client同等)は、サーバ保管の透過PNGを取得して使用。
- 認証は既存 `accounts`([02]) を再利用。アップロード・index編集は認証必須(将来 admin ロール検討)。

## 2. グラ名とファイルパスの分離(重要)

レガシーの `gra_name`(`#m57 O` の[54:69], 15バイト cp932) には**特殊文字・日本語**が含まれる:
`野ネズミ` `ベリー` `Egg_monster\`Dragon\`` `海賊船「本船」` 等(実データ[03]確認済)。

→ グラ名をそのままファイル名にすると、バッククォート・空白・括弧・マルチバイトでFS/URL上の事故リスク。

**方針**: DBが「グラ名 → 安全なファイルパス」を仲介。
- 物理PNGは**安全なスラッグ/ハッシュ名**で保存(例 `sha1(gra_name)` or サニタイズ名)。
- グラ名(原文UTF-8)はDBカラムで保持。FEは**グラ名で要求**し、APIがDB経由でファイル解決。
- これによりFS名の制約とグラ名(任意文字)を切り離す。

### 大文字小文字の扱い（case-insensitive 解決）
- サーバ送出の `gra_name` は混在ケース(`t_Lord`/`Hachiue01`等)。Linux FSは大小区別するため取り違え事故が起きやすい(例 `t_man` vs `t_Man`)。
- **方針**: グラ解決は **case-insensitive**。`gra_name` を**小文字正規化したキー**で照合する。
  - `chara_graphics` に正規化キー列 `gra_key`(=lower(gra_name)) を持たせUNIQUE/INDEX。原文 `gra_name` は表示用に保持。
  - 変換ツールは `--lowercase` で出力PNG名を小文字化([06] tools/gfx_convert)。物理名・URLも小文字で統一。
- これによりアップロード/解決/フォールバック全経路で大小揺れを排除。

## 3. 保管レイアウト

```
assets/
  chara/
    <storedName>.png      # 変換済透過PNG(storedName=安全名。グラ名直結しない)
  chara_orig/             # 任意: 元BMP保持(再変換用。不要なら省略)
    <storedName>.bmp
```
DB(SQLite)が `gra_name → storedName/png_path` を管理。

## 4. SQLite スキーマ

[02] のスキーマに追加。

```sql
-- アップロードされたキャラグラフィック
CREATE TABLE chara_graphics (
  gra_name      TEXT NOT NULL,       -- グラ名(原文UTF-8, 表示用). #m57 O の gra_name と一致
  gra_key       TEXT PRIMARY KEY,    -- 正規化キー = lower(gra_name). 解決はこれで照合(case-insensitive)
  stored_name   TEXT NOT NULL UNIQUE,-- 物理ファイル名(安全名: 小文字/ハッシュ/スラッグ)
  png_path      TEXT NOT NULL,       -- assets/chara/<stored_name>.png
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  color_key     TEXT NOT NULL DEFAULT 'teal',  -- 適用カラーキー(teal/white/R,G,B)
  orig_sha256   TEXT NOT NULL,       -- 元BMPハッシュ(重複検出/冪等)
  uploaded_by   TEXT REFERENCES accounts(id),
  uploaded_at   TEXT NOT NULL
);
CREATE INDEX idx_chara_graphics_sha ON chara_graphics(orig_sha256);

-- Index.txt 相当 + フォールバックカテゴリ: キャラ名/カテゴリ → グラ名 のエイリアス
CREATE TABLE chara_index (
  key           TEXT PRIMARY KEY,    -- キャラ名・カテゴリ(UTF-8). 例「知的生物」, または
                                     -- フォールバックWeb key(human/beast/berserk/eraser等[09])
  gra_name      TEXT NOT NULL,       -- 解決先グラ名(通常 chara_graphics.gra_name)
  updated_by    TEXT REFERENCES accounts(id),
  updated_at    TEXT NOT NULL
);
```
- `chara_index.gra_name` は `chara_graphics` を指す想定だが、外部キー強制はしない(未アップロードのグラ名を先に登録するケースを許容)。
- 日付はISO8601文字列(UTCの`YYYY-MM-DDTHH:MM:SSZ`)。

## 5. 透過変換の共有化

`tools/gfx_convert/convert.py` のカラーキー処理を**共有モジュール化**してBEから利用。

```
backend/
  gfx/
    __init__.py
    transparency.py   # convert_colorkey(img, key)->RGBA, convert_chip/mask_v 等を移設
```
- キャラは `convert_colorkey(img, (0,128,128))`(clTeal)既定。`color_key` をパラメタ化(white等)。
- `tools/gfx_convert/convert.py` はこの共有モジュールを呼ぶ薄いCLIに再編(重複排除)。

## 6. バリデーション

- 受理形式: `.bmp`(主)。`.png`直接受理も任意で許可(変換スキップ)。
- 最大サイズ: 例 2MB(設定可)。
- 画像妥当性: Pillowで開けること。
- 寸法: キャラ標準 **96×160** を推奨。不一致は警告(レスポンスに`dimensionWarning`)し保存は許可(拡張グラ対応)。
- `gra_name`: 未指定ならアップロード元ファイル名(拡張子除去)を使用。原文保持(UTF-8)。長さ・制御文字を検査。
- 重複: `orig_sha256` 一致は冪等(既存を返す/上書きはポリシーで選択)。

## 7. REST API

ベース: `/api/chara`。認証必須(セッション/トークン)。レスポンスはUTF-8 JSON。

### 7.1 グラフィック
| メソッド | パス | 説明 |
|----------|------|------|
| `POST` | `/api/chara/graphics` | multipart: `file`(bmp), 任意 `graName`, `colorKey`(既定teal)。変換→保存→メタ返却 |
| `GET` | `/api/chara/graphics` | 一覧(メタ配列) |
| `GET` | `/api/chara/graphics/{graName}` | 該当グラ名のメタ取得 |
| `GET` | `/api/chara/graphics/{graName}/png` | 透過PNGバイナリ配信(`image/png`, ETag=sha) |
| `DELETE` | `/api/chara/graphics/{graName}` | 削除(ファイル+メタ) |

- `{graName}` はURLエンコード必須(特殊文字対応)。サーバはデコード後DB照合。
- 配信は静的配信(リバースプロキシ/`StaticFiles`)でも可。その場合パスは `stored_name` ベースのURLをメタに含める。

POST レスポンス例:
```jsonc
{ "graName": "野ネズミ", "url": "/api/chara/graphics/%E9%87%8E%E3%83%8D%E3%82%BA%E3%83%9F/png",
  "width": 96, "height": 160, "colorKey": "teal",
  "dimensionWarning": null, "uploadedAt": "2026-06-01T14:00:00Z" }
```

### 7.2 Index(エイリアス)
| メソッド | パス | 説明 |
|----------|------|------|
| `GET` | `/api/chara/index` | 全エイリアス(JSON配列 `{key, graName}`) |
| `PUT` | `/api/chara/index/{key}` | body `{graName}`。登録/更新 |
| `DELETE` | `/api/chara/index/{key}` | 削除 |
| `POST` | `/api/chara/index/import` | Index.txt(cp932/UTF-8)アップロード→一括取込(§8) |
| `GET` | `/api/chara/index.txt` | DBから Index.txt 形式を生成・配信(レガシー互換/エクスポート) |

### 7.3 マニフェスト(FE初期化用)
| メソッド | パス | 説明 |
|----------|------|------|
| `GET` | `/api/chara/manifest` | `{ graphics: {graName: url,…}, index: {key: graName,…} }`。FEが起動時に取得しグラ解決に使用 |

## 8. Index.txt 取込・生成

レガシー `Index.txt` 形式(cp932):
```
// コメント行(// 始まり)は無視
グラ名orカテゴリ = ファイル名.bmp
知的生物         = LANU_Oyaji.bmp
```
- **取込**(`import`): cp932(必要ならUTF-8自動判定)でデコード。`//`行・空行を無視。`key = value` を分解(両端trim)。`value` の `.bmp` 拡張子を除去し `gra_name` として `chara_index` へ upsert。
- **生成**(`index.txt`): `chara_index` 全行を `key = <gra_name>.bmp` 形式で出力。文字コードは `?charset=cp932|utf-8`(既定 utf-8)。レガシー互換が要る場合 cp932。

## 9. FE 連携(グラ解決フロー)

フォールバックはキャラタイプコード(`#m57 O`末尾)に基づく。詳細・正規マッピングは [09 フォールバック](09-chara-fallback-mapping.md)・[`chara_type_fallback.json`](../backend/data/chara_type_fallback.json)。

1. WSの `map` イベント([07] §6.2)で各キャラの `gra`(=gra_name)と `default`(typeコード)を受信。
2. FE: `manifest.graphics[gra]` があればそのURLのPNGを使用。
3. 無ければ typeコード → Web key → `chara_index[key]`(カテゴリ既定グラ) を解決。
4. typeコード未一致は `intelligent`(0x01) を既定([09] §3)。
5. それも無ければプレースホルダ(名前頭文字等)。

→ フォールバックカテゴリ(human/beast/berserk/eraser 等14種[09])は `chara_index` に事前シードし、各カテゴリの既定グラをアップロード済PNGに割当て。

→ グラPNGの取得はHTTP(キャッシュ可, ETag)。WSはgra_name(文字列)のみ運ぶ([07]通り)。

## 10. 運用・セキュリティ

- **アップロード等の変更系は管理者のみ**(キャラグラは全プレイヤー共通=グローバルに反映されるため)。
  - 管理者判定 = **DBフラグ `accounts.is_admin`**(`require_admin` 依存。未認証401/非管理者403)。
  - 管理者限定: `POST/DELETE /api/chara/graphics`, `PUT/DELETE /api/chara/index`, index `import`。
  - GET系(list/meta/png/manifest/index.txt)は閲覧可(レート制限のみ)。`/api/register`(新規キャラ作成)は対象外。
  - 初期管理者付与CLI: `PHI_DB_PATH=... python -m app.admin_cli grant <account_id>`(revoke/list も)。
  - ログイン応答に `isAdmin` を含め、FEは管理UIを出し分け(サーバ側は多層防御で403)。
  - 反映範囲: **このWebバックエンドのクライアント全員**。レガシーサーバ/他クライアントには影響しない(gra_nameのみ送受信、PNGはクライアント描画アセット)。
- ファイル名はサーバ側生成(`stored_name`)でパストラバーサル不可。`graName`はDB値としてのみ扱いFSパスに直結しない。
- 上限サイズ・拡張子・MIME・画像妥当性を検査。変換失敗は 4xx。
- 同一 `orig_sha256` は冪等化(再アップロードで重複生成しない)。
- 監査: `uploaded_by`/`updated_by` を記録。

## 11. 実装タスク(設計時の想定。実装は別途)
1. `backend/gfx/transparency.py` へ透過変換を共有化(CLIから分離)。
2. SQLite マイグレーション(`chara_graphics`/`chara_index`)。
3. FastAPI ルータ `/api/chara/*`(graphics, index, manifest)。
4. ストレージ層(ファイル保存 + メタCRUD)。
5. Index.txt パーサ/ジェネレータ(cp932対応)。
6. 認証ミドルウェア連携。
7. FEマニフェスト取得・グラ解決(描画はPython同等)。

## 12. 対象範囲・未確定

### 対象範囲
- 本機能の対象は **ゲーム内コンテンツのスプライト**(キャラグラ chara、必要に応じマップチップ chip・アイテム Items)に限定。
- **スキン画像(UIテーマ: Title/Direction/HpMpPanel/Status/Tab/CSS/カーソル等[06])は対象外**。Web版UIは近代的な形で**完全に新規実装**するため、レガシースキンの移植・変換・アップロードは行わない。HP/MPゲージ・ステータス・方角表示・タブ等はCSS/コンポーネントで作り直す。

### 未確定・要検討
- 元BMP(`chara_orig/`)を保持するか(再変換・色キー変更のため保持推奨だが容量増)。
- 上書きポリシー(同一gra_name再アップロード時: 上書き/版管理)。
