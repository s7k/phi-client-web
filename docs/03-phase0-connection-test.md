# フェーズ0 疎通検証レポート

実レガシーサーバへの接続検証結果。設計（[02-architecture-design.md](02-architecture-design.md)）の主要仮説を実データで検証。

## 1. 検証条件
- サーバ: `<SERVER_IP>:<PORT>`（実値は非公開。Ranzaia / Fantasy Island Country, JET-5-2-6p）
- キャラID: `<CHARACTER_ID>`（実値は非公開。職業 `t_Lord`, エリア「港町の酒場」）
- スクリプト: `backend/test_connect.py`（PySide6非依存。`~/workspace/phi-client` の接続層を移植）
- 参考実装: `~/workspace/phi-client/phi/protocol/connection.py`, `phi/network/network_thread.py`

## 2. 結果: 接続・ログイン成功 ✅
220行受信。ログインシーケンス（`phi-client` と同一）が有効と確認:

```
#open <ID>
#version-cli 05107100
#map-iv 10
#status-iv 10
#ex-switch eagleeye=form
#ex-map size=57
#ex-map style=solid
#ex-switch ex-move-recv=true
#ex-switch ex-list-mode-end=true
#ex-switch ex-disp-magic=true
```

サーバ応答例:
```
#name <CHAR>
#ex-notice land=Fantasy Island Country
#ex-notice area=港町の酒場
#mapset mansion / #bgm Seiju
#version-srv 05110000 / #version-dm JET:011:0002:24
#m57 M S <hex>:<98バイト地形>  (7x7マップ)
#m57 O C0001:3 3 B <CHAR> ... t_Lord
#status t_Lord : 4775: 4775: 3344: 3344: 24063: 2161: 7269: 3712: 5290: 2540
#cond -------
```

## 3. 未確認事項の解明

| 旧未確認事項 | 検証結果 |
|--------------|----------|
| 認証・パスワード機構 | **`#open <ID>` のみでログイン成立。パスワード不要**。IDがそのまま認証情報 |
| UTF-8送信対応可否 | 検証不要に。**cp932(SJIS)で送受信し変換すれば日本語完全表示**。UTF折衝(`#code-utf`)に依存しない方針で確定 |
| マップ地形コード体系 | **`#m57 M` の地形は生バイト（98バイト = 7×7セル × 2バイト/セル: chip + attribute）。cp932変換厳禁**。設計の「行種別で変換分岐」が正当と実証 |
| サーバ接続先 | 取得済（上記）。実サーバ稼働中、`main()`非同梱でも接続可能 |

## 4. 設計への確定的フィードバック

### 4.1 文字コード変換戦略（確定）
`phi-client/phi/engine/parser.py` の実装で確証:
- **生バイトで処理（変換禁止）**: `#m57 M` `#map M`（地形チップ）。
- **オフセット指定で部分cp932デコード**: `#m57 O`（キャラ/オブジェクトのname=raw[19:50], gra_name=raw[54:69]）, `#user`（name=raw[11:42]）。
- **行全体cp932デコード**: チャット・ログ・`#ex-notice`・`#status`・その他。

→ バックエンド `CodeConverter` は **行頭コマンドで分岐**し、バイナリ行はbase64等でJSON透過、テキスト行はUTF-8変換。`parser.py` をほぼそのまま移植可能。

### 4.2 マップ構造（確定）
- `#m57 M S <hex>:<bytes>`: 7×7。チップデータ `raw[18:116]`（98B）、各セル2バイト（chip, attribute）。
- `#map M`: 5×5（旧仕様）。チップ50B + アイテム/看板インジケータ。
- `#m57 O <type><id>:<x> <y> <dir> <name31> <status> <graname15> <flag>`: キャラ/オブジェクト オーバーレイ。
- `#m57 .`: マップ終端。

### 4.3 カラーマークアップ（新規発見・要対応）
ログ/チャットに独自マークアップ埋め込み:
```
/*color=red*/text/*.*/      色指定
/*cl=red*/text/*.*/         色指定（短縮形）
```
`phi-client/phi/gui/color_markup.py` に処理あり。フロント描画でパースしHTML/Canvas装飾へ変換要。

### 4.4 ログインシーケンス（確定）
バックエンドの `LoginCommand` は §2 のシーケンスをそのまま採用。`#version-cli 05107100` 必須。

## 5. phi-client の再利用方針
`~/workspace/phi-client`（Python/PySide6, 動作実績あり）はWeb化の一級の参考実装。バックエンドへ移植すべき資産:
- `phi/protocol/connection.py` … TCP送受信・cp932・部分書き込みリトライ
- `phi/protocol/line_buffer.py` … `\n`行分割（SJIS先頭バイト境界考慮）
- `phi/network/network_thread.py` … ログイン・受信ループ・キープアライブ・`#ch-srv`世界転送ハンドシェイク
- `phi/engine/parser.py`, `phi/engine/map_data.py` … プロトコル解析・マップ復元（変換分岐の参照実装）
- `phi/gui/color_markup.py` … カラーマークアップ

→ バックエンドをPython(asyncio)で実装すれば移植コスト最小。Node.js採用時もロジックを忠実移植可能。

## 6. 次アクション
1. 設計 §3.1 の言語選定を再考: **phi-client資産流用を最大化するならPython(FastAPI + websockets/asyncio)**。Node.jsの優位性（WebSocket生態系）と移植コストを比較し確定。
2. フェーズ1着手: バックエンド最小（接続保持 + cp932変換 + WS + チャット疎通）。
3. `#m57`/`#status`/`#cond` のJSON化 → フロント描画（フェーズ2）。
