# 不足機能の責務分担設計（バックエンド / フロントエンド）

[04-feature-gap-analysis.md](04-feature-gap-analysis.md) で洗い出した不足機能のうち、**全自動攻撃・全自動詠唱・BGM を除く全機能**について、バックエンド(BE)とフロントエンド(FE)の責務を分離して設計。

前提アーキテクチャは [02-architecture-design.md](02-architecture-design.md)。BEはレガシーサーバへのSJISソケットを常時保持するゲートウェイ、FEはブラウザ。両者はWebSocket(UTF-8 JSON)で通信。

## 0. 責務分担の原則

| 層 | 担当 |
|----|------|
| **BE** | レガシープロトコルの全責任。SJIS⇔UTF-8変換、行の組立/分解、`#`コマンド整形、プロトコル状態機械(s-edit/list/more等)、ラグ応答、キープアライブ、世界移動ハンドシェイク、SQLite永続化。**FEへはゲーム意味論のJSONのみ**を渡す |
| **FE** | 表示・入力・UI状態。プロトコル文字列を一切組み立てない。意図(intent)をJSONでBEへ送る。発言種別UI・キー割当・通知・スクリーンショット等のクライアント体験 |

**鉄則**: FEはレガシー文字列(`*`プレフィックス、`#priv N\n本文`、`cast\n...`等)を知らない。意図だけ送り、BEが文字列化する。これによりプロトコル変更の影響をBEに閉じ込める。

---

## 1. チャット送信（種別制御）

レガシー: 入力文字列へのプレフィックス付与で種別制御（大声=`*`、大声無効=`/**/`、パーティー=Ctrl+Enter、`#priv`）。**この整形は全てBEが担う**。

### FE責務
- 発言種別UIの提供: 通常 / 大声(loud) / パーティー(party) / プライベート(priv:宛先選択) / 全タブ(all)。
- 大声選択時の確認ダイアログ表示（誤爆防止。レガシー同等）。
- プライベート宛先は `#user` 由来のユーザ一覧から選択（表示名で。番号はFEに見せない）。
- 入力テキストはUTF-8生文字列のまま送信。

### BE責務
- intentに応じレガシー文字列へ整形:
  - `normal` → テキストそのまま
  - `loud` → 先頭に `*` 付与
  - `party` → パーティー発言形式（レガシー`PartyTalkByCtrl`相当の整形）
  - `priv` → `#priv <ユーザ番号>\n<本文>`（番号はBE保持の`#user`マップで解決）
  - `all` → 全接続キャラへ同報（複数セッション運用時。§9参照）
- 先頭が`*`の通常発言は`/**/`付与で大声化を防ぐ（レガシー`LoudlyByAsterisk`相当）。
- UTF-8→SJIS変換し送信。

### WS API
```jsonc
// FE → BE
{ "type": "chat", "mode": "normal|loud|party|all", "text": "こんにちは" }
{ "type": "chat", "mode": "priv", "to": "<userKey>", "text": "やあ" }  // userKeyはuserListイベントのkey
```
ユーザ一覧はBEが配信:
```jsonc
// BE → FE  (#user 受信を集約)
{ "type": "userList", "users": [ { "key": "u1", "name": "ExampleChar" }, ... ] }
```

---

## 2. 支払い pay

レガシー: Pキーで金額入力ダイアログ→`pay <金額>`。@キーで`pay 0`（払う相手なし表明）。

### FE責務
- 金額入力ダイアログ（数値バリデーション）。
- `pay 0` 用のショートカット(@相当)。

### BE責務
- `pay <金額>` / `pay 0` を生成・送信。

### WS API
```jsonc
{ "type": "command", "name": "pay", "amount": 100 }
{ "type": "command", "name": "pay", "amount": 0 }
```

---

## 3. more送信（多数行コマンド連続送信）

レガシー: `9`キー等で次の`#end-more`まで複数行コマンドを連続送出。BEのプロトコル状態機械で扱う。

### FE責務
- more対象操作（移動連打等）のキー/UI。意図のみ送信。
- BEからの`more`状態通知に応じUI表示（任意）。

### BE責務
- `#more`/`#end-more`受信を状態として保持。
- more中はFEからの該当intentを複数行コマンドへ束ねて送信。
- 状態をFEへ通知。

### WS API
```jsonc
// BE → FE
{ "type": "mode", "more": true|false }
```
moreは主にBE内部処理。FEは状態表示のみで、特別な送信形式は不要。

---

## 4. 1行入力 s-edit / 複数行入力 m-edit

レガシー: `#s-edit`で入力を1行モード化、`#m-edit`→`#.`で複数行（看板等）。Pythonはm-edit実装済、s-editは受信のみ。

### FE責務
- `edit`通知を受け、`single`なら1行入力ボックス、`multi`なら複数行エディタを表示。
- 確定で本文送信、キャンセル送信。

### BE責務
- `#s-edit`/`#m-edit`/`#.`受信→`edit`イベント化。
- FEからの確定/キャンセルをレガシー形式へ:
  - m-edit確定: 行ごと送信＋終端`.`、キャンセルは`.!`（Python実装に準拠）。
  - s-edit確定: 1行送信。
- UTF-8→SJIS変換。

### WS API
```jsonc
// BE → FE
{ "type": "edit", "mode": "single|multi" }
{ "type": "edit", "mode": "end" }   // #. でクローズ
// FE → BE
{ "type": "editSubmit", "mode": "single|multi", "lines": ["..."] }
{ "type": "editCancel" }
```

---

## 5. リストモード list

レガシー/Python実装済。Webでも踏襲。BEが`#list`/`#end-list`/`#ex-list-mode-end`を状態管理、FEは選択UI。

### FE責務
- リスト表示、番号(1-9)・複数選択・全選択(+)・キャンセル(. / Esc)のUI。
- 選択intentを送信。

### BE責務
- リスト状態の保持・FEへの`list`イベント配信。
- 選択を `<番号>` / `-`(全選択) / `.`(終了) のレガシー入力へ整形・送信。

### WS API
```jsonc
// BE → FE
{ "type": "list", "lines": ["..."], "active": true }
{ "type": "list", "active": false }
// FE → BE
{ "type": "listSelect", "value": 3 }      // 番号
{ "type": "listSelect", "value": "all" }  // 全選択(-)
{ "type": "listSelect", "value": "cancel" } // 終了(.)
```

---

## 6. キーバインド / ショートカット設定

レガシー: F1-F7に魔法割当(`MagicF01-07`)、F8-F12ショートカット、AltG語、移動レイアウト。

### FE責務
- 設定画面: キー→アクション割当の編集UI。
- 入力時、押下キーを割当表でアクション(intent)へ解決し送信。
- 割当はFEで保持しつつ、サーバ横断同期のためBE経由でSQLiteへ保存。

### BE責務
- 設定の永続化(SQLite `settings`)。読み書きAPI提供。
- **キー→文字列の最終整形はBE**（例: F1=魔法"heal" → `cast\nheal`）。FEは「F1が押された／アクションid=castMagic, arg=heal」を送るだけ。

### 責務分界点
- **キーと意味の対応(どのキーで何をするか)= FE設定**。
- **意味とレガシー文字列の対応(castMagicとは`cast\n<名>`)= BE**。

### WS API
```jsonc
// 設定読み書き
{ "type": "settings.get", "scope": "keybind" }
{ "type": "settings.set", "scope": "keybind", "value": { /* 割当表 */ } }
// アクション実行（キー解決後）
{ "type": "command", "name": "castMagic", "spell": "heal" }
{ "type": "command", "name": "raw", "text": "spells" }  // 単純コマンド
```

---

## 7. 魔法・コマンドショートカット（召喚・ショップ含む）

レガシー: Alt系魔法(15種)、召喚`appear/disappear`、ショップ`buy/sell/shop`等。Pythonは主要Alt魔法実装済、召喚・ショップ未。

### FE責務
- ショートカットキー/ボタン → アクションintent送信。
- 召喚獣名・売買対象等のパラメータ入力UI（必要時）。

### BE責務
- intent→レガシー文字列化。例:
  - 召喚: `cast\nappear\n<creature>` / `cast\ndisappear\n<creature>`
  - ショップ: `buy` / `sell` / `shop`（多くはその後list/s-editへ遷移→§4,5で処理）
  - 既存Alt魔法: `cast\n<spell>`

### WS API
```jsonc
{ "type": "command", "name": "summon",  "action": "appear|disappear", "creature": "wyvern" }
{ "type": "command", "name": "shop",    "action": "buy|sell|shop" }
```
パラメータを伴う対話(数量・対象)は後続のlist/editイベントで継続。

---

## 8. 世界移動（#ch-srv）の永続化・タイムアウト

ハンドシェイク本体はBEに移植（Python `_handle_ch_srv`）。レガシー比の欠落を補う。

### BE責務（FEはほぼ関与なし）
- ハンドシェイク実行（reserve→rsv-ok→trans→trs-ok→ch-srv-ok→接続スワップ→再ログイン）。
- **待機タイムアウト300秒**（レガシー`TimeoutMs=300000`に合わせる。Python既定30秒を是正）。
- **移動先を永続化**: SQLite `characters.last_server` を新IP:Portで更新（レガシー`ChangeServer`=IDファイル書換に相当）。次回接続時の初期接続先に使用。
- 移動の進行・成否をFEへ通知。旧世界情報クリア。

### FE責務
- 移動中インジケータ表示。完了で新世界のmap/status再描画（通常の受信フローに乗る）。

### WS API
```jsonc
// BE → FE
{ "type": "worldTransfer", "state": "start|success|fail", "server": "ip:port" }
```

---

## 9. 複数キャラ（タブ） / 全タブ発言

レガシー: タブで複数キャラ同時接続。BEは1キャラ=1レガシー接続を複数保持。

### FE責務
- タブUI、アクティブキャラ切替。各タブのintentに`session`識別子を付与。

### BE責務
- セッション(キャラ)ごとにLegacySocketを管理（[02] SessionManager拡張）。
- `all`発言は全アクティブセッションへ同報。
- 各セッションの受信を該当タブへルーティング。

### WS API
```jsonc
// 全メッセージに session を付与（単一キャラ時は省略可）
{ "type": "chat", "session": "char1", "mode": "normal", "text": "..." }
// BE → FE も session 付き
{ "type": "map", "session": "char1", ... }
```

---

## 10. 通知（タスクバーフラッシュの代替）

レガシー: priv限定/大声/正規表現でタスクバー点滅。

### FE責務（主担当）
- ブラウザ通知API(Notification) / タブタイトル点滅 / 通知音。
- 通知条件設定UI（priv限定・大声含む・正規表現フィルタ）。
- 受信イベントに条件マッチで発火。

### BE責務
- 通知判定に必要なメタ（種別: priv/loud/normal, 発言者）を受信イベントへ付加。
- 通知条件設定の永続化(SQLite `settings`)。

### WS API
```jsonc
// BE → FE  (message に分類メタを付与)
{ "type": "message", "channel": "priv|loud|log", "from": "ExampleChar", "text": "..." }
```

---

## 11. ログ（自動保存・タグ整形・コピー）

### FE責務
- ログ表示・スクロール・コピー。コピー時のタグ削除/時刻削除/名前削除（FEで整形可能。表示済データを加工）。
- 表示整形設定UI。

### BE責務
- ログ永続化(任意。サーバ側保存が必要ならSQLiteまたはファイル)。
- FEはセッション内ログを保持するため、基本はFE主担当。長期保存要件があればBEへ。

> 方針: ログ自動保存は要件次第。最小実装ではFEのみ（ダウンロード機能で代替）。

---

## 12. スクリーンショット

### FE責務（全責任）
- Canvas(マップ/EagleEye)を`canvas.toBlob()`で画像化しダウンロード。
- BE関与不要。

---

## 13. 画像表示（img= タグ）

レガシー: ログ内に画像URL埋め込み。

### FE責務
- カラーマークアップ拡張として`img=`タグをパースし`<img>`描画。
- 外部URL読み込みのセキュリティ考慮(CSP, サニタイズ)。

### BE責務
- 該当行をテキストとしてそのまま渡す（変換時にタグ破壊しないこと）。

---

## 14. 新規キャラクター作成

レガシー: 別アプリ`NewCharacter.exe`（世界選択・SHA1パスワード）。Web版は新規実装。

### FE責務
- 作成フォーム(キャラ名・世界選択・必要項目)。

### BE責務
- レガシーサーバへの新規登録プロトコル実行（要追加調査: 登録時のコマンド列）。
- SQLite `accounts`/`characters` へ登録。パスワードは`password_hash`保存。

> 注: 新規登録のレガシープロトコルは未調査。フェーズ別途調査要。

---

## 15. 実装優先度（提案）

| 優先 | 機能 | 節 |
|------|------|----|
| 高 | チャット種別(大声/パーティー/priv/全タブ) | §1,9 |
| 高 | s-edit/m-edit/list入力UI | §4,5 |
| 高 | 世界移動の永続化・300秒化 | §8 |
| 高 | pay | §2 |
| 中 | キーバインド設定 | §6 |
| 中 | 召喚・ショップ等コマンド | §7 |
| 中 | 通知 | §10 |
| 低 | ログ保存・SS・画像表示 | §11,12,13 |
| 別途 | 新規キャラ作成(プロトコル要調査) | §14 |

## 16. 除外（ユーザー方針）
- 全自動攻撃 / 全自動詠唱（戦闘自動化）
- BGM再生
- 描画(マップ/EagleEye/キャラ) — Python同等で進行
