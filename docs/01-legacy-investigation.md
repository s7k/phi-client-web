# レガシーコード調査資料

`legacy/` 配下の旧オンラインゲーム（"phi" / Phantasmal Island）クライアント・サーバ調査結果。Webクライアント実装の前提資料。

## 1. 全体構成

| 区分 | 言語/環境 | 場所 | 役割 |
|------|-----------|------|------|
| サーバ | C (BSD socket, Unix) | `legacy/server/` | ゲームロジック（DM=Dungeon Master系モジュール群）。`tcp.c` がソケット層 |
| クライアント | C++Builder (VCL, Winsock, Windows) | `legacy/client/Philly/` | GUIクライアント本体 |
| 付属ツール | C++Builder | `legacy/client/` 各サブDir | アップデータ・新規キャラ作成・DB保守等 |

文字コード: **Shift_JIS (SJIS)**。ソース・ドキュメント・ディレクトリ名すべてSJIS。ターミナル上は文字化け表示。閲覧は `iconv -f SHIFT_JIS -t UTF-8`。

注意: `legacy/server/` はDM/魔法/攻撃/敵処理等のロジックモジュール中心。`main()`・接続受付ループ・`#open`等のプロトコルディスパッチ本体は同梱されず（別配布想定）。プロトコル仕様は下記ドキュメント＋クライアント側実装から復元。

## 2. 通信プロトコル

### 2.1 基本形式
- **トランスポート**: TCP ソケット常時接続。
- **メッセージ単位**: 改行 `\n` 終端の1行テキスト。終端 `\n` はバッファ格納時に除去（`tcp.h` `read_line` 仕様）。
- **文字コード**: SJIS（生バイト）。
- **2種類の行**:
  - `#` 始まり = プロトコル制御コマンド（`#command 引数`）。
  - `#` 無し = ゲーム入力（チャット発言・操作コマンド文字列。例 `hi` `y` `n` `.` `equip` `unequip`）。

### 2.2 接続フロー（クライアント視点）
`legacy/client/Philly/PersonalThread.cpp` より復元:

1. TCP接続 `Connection->Open(IP, Port)`
2. `#open <ID>` 送信 … キャラクターID指定ログイン要求
3. `LoginCommand()` で設定コマンド送信（`#map-iv <秒>` `#status-iv <秒>` `#ex-map size=57` `#ex-map style=turn|solid` `#ex-switch ex-disp-magic=true` 等）
4. 受信ループ開始 → `#`コマンド解析（`AnalysisCommand()`, PersonalThread.cpp:1024〜）
5. 無通信検知用に一定間隔で `#code-sjis` 送信（キープアライブ兼用）
6. `#lag` 受信時 `#end-lag` 即応答（ラグ計測）

### 2.3 文字コードネゴシエーション（重要）
プロトコルに **エンコーディング選択機構が存在**。Web化(UTF-8)の鍵。
- `#code-sjis` / `#code-euc` / `#code-utf` … クライアント→サーバ 送信文字コード要求
- `#code-sjis-ok` / `#code-euc-ok` / `#code-utf-ok` … サーバ承認（後に廃止表記あり）
- `#code-euc-no` / `#code-utf-no` … サーバ拒否
- 現行クライアントは実質 `#code-sjis` のみ使用。UTF対応はサーバ実装依存（不明、要検証）。
- → **方針**: UTF折衝は信頼せず、バックエンドでSJIS⇔UTF-8変換する前提（後述設計）。

### 2.4 主要コマンド一覧

サーバ→クライアント（抜粋。全体は `legacy/server/doc/ProtocolText.txt`）:

| コマンド | 意味 |
|----------|------|
| `#name *` | 名前通知 |
| `#lag` | ラグ計測（`#end-lag`で応答必須） |
| `#map *` / `#map .` | マップデータ(5x5)。`M`方角/地形/アイテム、`C`キャラ、`B`看板、`.`終端 |
| `#m57 *` / `#m57 .` | 7x7マップ（拡張） |
| `#status *` | ステータス `(名前):(HP):(MaxHP):(MP):(MaxMP):(Exp):(Money):(FLV):(WLV):(MLV):(CLV)` |
| `#cond *` | 状態異常 毒/麻痺/パニック/混乱/バーサーク/沈黙/盲目（`*`喰=有, `-`=無） |
| `#s-edit` / `#m-edit` / `#.` | 1行入力 / 複数行入力開始 / 終了 |
| `#more` / `#end-more` | 多数行送信 開始/終了 |
| `#attack` / `#end-at` | 攻撃準備中/完了 |
| `#magic` / `#end-mg` | 呪文詠唱中/終了 |
| `#list` / `#end-list` | リスト表示 開始/終了 |
| `#user ? *` / `#priv ? *` | ユーザ通知 / プライベートメッセージ |
| `#x` / `#close` | 切断通知（ソケットフル・キャラ無し・2重ログイン等） |
| `#remap` | マップ再要求（`#map`応答必須） |
| `#mapset *` `#mapset-define n *` `#bgm *` | マップパーツセット/BGM名通知 |
| `#ex-notice key=value` | 世界/エリア名等の情報通知 |
| `#ex-map *` `#ex-switch *` `#ex-eagleeye *` | モード変更通知/応答 |
| `#ch-srv *` `#rsv-ok` `#trs-ok/no` | 世界（サーバ）間キャラ転送 |

クライアント→サーバ（抜粋）:

| コマンド | 意味 |
|----------|------|
| `#open *` | キャラクターID指定接続 |
| `#end-lag` | `#lag`応答 |
| `#map` / `#status` | 情報要求 |
| `#map-iv *` / `#status-iv *` | 自動送信間隔(秒)設定 |
| `#enter-win` / `#leave-win` | フォーカス通知 |
| `#ulist` | ユーザ一覧要求 |
| `#priv ? *` | プライベート送信 |
| `#ex-switch *` / `#ex-map *` | モード変更要求 |
| `#code-sjis` 等 | 文字コード要求（キープアライブ兼用） |
| `#x` | 強制切断 |

ゲーム操作（`#`無し、`legacy/client/Philly/Command.cpp`）:
- 移動: テンキー/カーソルキー → `Move()` 経由でサーバへ方向送信。
- アクション: `hi` `n` `y` `.`（キャンセル/決定）、`equip` `unequip` `sort` 等のコマンド文字列。
- チャット: 入力文字列をそのまま行送信。
- リスト選択: 数字 `1`〜`9`、`.`でキャンセル。

### 2.5 サーバ転送（世界移動）
`#ch-srv` → 別サーバへ接続し `#reserve` → `#rsv-ok` → 元サーバへ `#trans <IP> <Port>` → `#trs-ok` → 新サーバへ `#ch-srv-ok`。`PersonalThread.cpp` `classTransportCharacter`。Web化初期は単一サーバ接続に限定可（転送は後回し可能）。

## 3. ソケット層 (`legacy/server/tcp.c`, `tcp.h`)
- `MAX_CLIENT 64`、ノンブロッキング寄りのバッファ管理。
- `read_line` / `peek_protocol`（`#`行優先読み）/ `write_line`（タイムアウト付きバッファ書き込み）。
- エラー: `CONNECT_EXCEPT(-1)` `CONNECT_DETECT_EOF(-2)` `CONNECT_TIMEOUT(-3)` `CONNECT_BUFFULL(-4)`。
- → バックエンド実装時、行分割・部分受信・タイムアウト・切断検知ロジックの参考。

## 4. データ・ID管理
- `cdcnv.c`: キャラクターデータ変換（`phi.cd` `phi.sav` ⇔ 分割 `phi_cdi/cd.N`）。バイナリ/独自形式。
- クライアント側: `legacy/client/Database/`（CSVベースのキャラDB保守ツール）、`legacy/client/Philly/Config*`（INI/JS設定）。
- 認証: `#open <ID>` のIDがキャラ識別子。パスワード/アカウント機構の詳細は本Dir内に明示なし（要追加調査）。

## 5. Web化に向けた重要ポイント
1. プロトコルはテキスト行ベースで素直 → パース容易。
2. **SJIS⇔UTF-8変換**がバックエンドの中核責務。マップ地形コード等のバイナリ的文字は変換時に注意（生バイト保持が必要な箇所の切り分け要）。
3. マップ(`#map`/`#m57`)・ステータス・状態異常は構造化してJSON化しフロントへ。
4. `#lag`/`#end-lag`・キープアライブはバックエンドが代行（フロントに見せない）。
5. グラフィック資源（`legacy/client/Philly/chara` `Skins` 等の画像）はWeb用に別途配信。
6. IDファイル等は要件通り SQLite 管理に置換。

## 6. 要確認事項（フェーズ0で一部解明）
[03-phase0-connection-test.md](03-phase0-connection-test.md) の実接続検証で解明済を反映。

解明済 ✅:
- **認証**: `#open <ID>` のみでログイン成立。パスワード不要。
- **UTF-8送信**: 折衝不要。cp932送受信＋変換で日本語完全表示。
- **マップ地形コード**: `#m57 M` は生バイト（98B=7×7×2: chip+attribute）。変換禁止。`#m57 O`等の名前部はオフセット指定でcp932デコード。
- **接続先**: 実サーバ稼働確認（`<SERVER_IP>:<PORT>`、実値は非公開）。`main()`非同梱でも接続可。

残課題:
- サーバ `main()`・接続受付・`#open`処理本体ソースの所在（再ビルド要時）。
- BGM/画像資源のフォーマットと配置（Web配信用変換）。
- 新規発見: カラーマークアップ `/*color=red*/.../*.*/` のフロント描画対応。
