# 詳細設計（実装着手前の詰め）

[10 網羅性](10-component-completeness.md) で 🔶(要詳細化)・❌(未設計) とした項目を実装可能レベルまで詰める。前提: BE=Python/FastAPI、FE=React/TS([02])。

## 1. 認証・トークン・レガシー資格情報 ★

### 1.1 重要前提: レガシー `#open <uid>` の uid はパスワード埋め込み
レガシー登録(`new_proto.c` `ex_adduser_v52`)で uid は `<addw><5桁 s_id><6字 pass>` 形式。**接続ID(=uid)自体に6文字パスワードが埋め込まれている**(調査[本doc §2])。
→ uid は**資格情報**。SQLiteに平文保存禁止。**保存時暗号化(at-rest)**必須。

### 1.2 2層の認証
| 層 | 用途 | 資格 |
|----|------|------|
| **Web認証** | ブラウザ→BE のログイン | `accounts.password_hash`(argon2/bcrypt) |
| **レガシー資格** | BE→レガシーサーバ `#open` | `characters.legacy_uid_enc`(暗号化保存) |

- Web認証成功後、当該アカウントのキャラ一覧を返す。`session.open` でBEが復号した `legacy_uid` を使い `#open` 送信。
- uid 復号鍵はBE環境変数(`PHI_SECRET_KEY`)。SQLiteには暗号文のみ。

### 1.3 トークン方式（確定。**A-33でcookie→Bearer/localStorageへ変更**）
- **方式**: 不透明トークン(サーバ保持 `sessions_web`) + **Bearer ヘッダ + localStorage 保持**。JWTは不採用(失効容易性優先)。
  - 当初は httpOnly+Secure+SameSite cookie 案だったが、LAN/非HTTPS 環境で Secure cookie が拒否される問題のため A-33 で Bearer token + localStorage に変更。
- フロー:
  1. `POST /api/auth/login` (accountId, password) → 検証 → `sessions_web` にトークン発行、**レスポンス body** で返却(`{ok, token, isAdmin}`)。
  2. REST 変更系: `Authorization: Bearer <token>`。WS: 接続後 first message `auth {token}` で検証。
  3. `POST /api/auth/logout` (Bearer) → トークン失効。
- 有効期限: idle 30分 / absolute 24h(設定可)。WS切断中もゲームセッション([07]§4.2)は別タイムアウトで保持。
- CSRF: cookie 廃止により CSRF/Origin 検査とも**不要**(A-33)。token は JS が明示付与し、ブラウザが自動送信するアンビエント資格(cookie)が無いため CSRF が原理的に発生しない。token はログ非出力。

### 1.4 スキーマ追補（[02]§6 / [08]§4 に追加）
```sql
ALTER TABLE characters ADD COLUMN legacy_uid_enc BLOB;  -- 暗号化uid(#open用)
ALTER TABLE characters ADD COLUMN legacy_host TEXT;     -- 接続先(last_serverと統合可)
CREATE TABLE sessions_web (        -- Webログインセッション(WSとは別)
  session_id  TEXT PRIMARY KEY,    -- 不透明乱数(128bit+)
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
```
- `accounts.password_hash` は argon2id 推奨。
- `legacy_uid_enc` は AEAD(例 `cryptography` Fernet / AES-GCM)。

## 2. 新規キャラクター作成（レガシー登録プロトコル）★ 調査完了

`#ex-register` で実装可能(❌→解決)。出典: `legacy/server/new_proto.c` `ex_register`/`ex_adduser_v52`/`ex_adduser_v52_finish`、`ex_get`。

### 2.1 レガシー登録フロー
1. `#ex-register start` … 登録モード開始(サーバ timeout 600s)。
2. (任意) `#ex-get REGINFO IMG` … 初期グラ一覧要求 → `#ex-put REGINFO IMG` + 各グラ名 + `#ex-put .`。
3. `#ex-register name=<名前> pass=<6字> image=<索引> mail=<メール>` … プロパティ送信(key=value)。
   - name: 2字以上(先頭大文字化される)
   - pass: **正確に6文字**
   - image: `init_graphic[]` の索引(0〜init_graph_n-1)。`#ex-get REGINFO IMG` で得た一覧の順
   - mail: 任意(空可。@無しは末尾補完)
4. `#ex-register end` … 確定。検証NG → `#ex-register reject [name] [pass] [image] [mail]`(欠陥項目列挙)。OK → `new_user` でキャラ生成。
5. `#ex-register cancel` … 中止。

### 2.2 Web側設計
- BEは登録専用に**一時レガシー接続**を張り、上記を代行。
- 生成後、`#open` 用 uid(= `<addw><s_id><pass>`)を組み立て or サーバ通知から取得 → **暗号化して `characters.legacy_uid_enc` に保存**。
- Webアカウントと紐付け(`characters.account_id`)。

### 2.3 REST API（[08] と同系統）
| メソッド | パス | 説明 |
|----------|------|------|
| `GET` | `/api/register/graphics` | 初期グラ一覧(BEが`#ex-get REGINFO IMG`で取得しキャッシュ) |
| `POST` | `/api/register` | body `{name, pass(6), imageIndex, mail?}` → BEが`#ex-register`代行 → 成功で characters 登録 |

レスポンス: 成功 `{charId(内部), name}` / 失敗 `{error:{code:"REGISTER_REJECT", fields:["name","pass",...]}}`。

### 2.4 要確認（残）
- uid の `addw`/`s_id` の供給元(サーバ設定/通知)。登録成功時にサーバが uid を返すか、クライアントが既知の規則で組むか実機確認。
- 初期グラ一覧の取得が `ST_USERREGISTER` 中限定か(start後に`#ex-get`要否)。

## 3. 設定（settings）スキーマ ★

`settings` は `scope` 別のJSON。BE/FE共通のJSON Schemaで検証。SQLite `settings(char_id, key, value)` の `key`=scope, `value`=JSON文字列。

### 3.1 scope: `keybind`（[05]§6）
```jsonc
{
  "layout": "wasd",            // "wasd" | "numpad"
  "magic":  { "F1": "heal", "F2": "wizard eye", "F3": null, ... },  // F1-F7 → 呪文名
  "shortcuts": { "F8": "spells", "F9": null, ... },                // F8-F12 → コマンド
  "altG": "<語>"               // Shift+G ショートカット語
}
```
- FE: キー→アクションid解決。BE: アクションid→レガシー文字列([07]§7)。

### 3.2 scope: `notify`（[05]§10）
```jsonc
{ "enabled": true, "privOnly": false, "loud": true,
  "regexInclude": null, "regexExclude": "^DM >",
  "sound": true, "titleFlash": true }
```

### 3.3 scope: `display`
```jsonc
{ "mapSize": 57, "mapStyle": "solid", "eagleEye": false,
  "cellScale": 1, "fontScale": 1.0, "theme": "dark" }
```
- `mapSize`/`mapStyle` は `view.set`[07]§5.8 と連動しレガシーへ反映。
- `cellScale`(1=標準32px / 2=拡大64px)は**FE描画専用**(レガシー非連動)。拡大時は
  7×7をセル64pxで描画し、キャラは右側32×32フレーム・チップは種別合成(床=タイル/壁木=2x/小物=中央)。

### 3.4 scope: `intervals`
```jsonc
{ "mapUpdate": 10, "statusUpdate": 10 }  // #map-iv / #status-iv
```

各scopeに JSON Schema を `backend/app/schemas/` に置き、`settings.set` で検証。

## 4. レート制限 ★

| 対象 | 制限 | 超過時 |
|------|------|--------|
| `command.raw`(エスケープハッチ) | 10 msg / 10s / session | `error`(RATE_LIMITED)・破棄 |
| `chat`(全mode) | 20 msg / 10s / session | 同上 |
| `move` | 制限なし(レガシー側がリピート制御) | — |
| REST アップロード | 30 req / 分 / account | 429 |
| `POST /api/register` | 5 req / 時 / IP | 429 |
| WS接続 | 5 接続 / account 同時 | 拒否 |

- 実装: token bucket(session単位, BEメモリ)。`command.raw`は監査ログ([07]§10)。
- レガシーサーバ保護も兼ねる(過剰送信でDM側 BUFFULL 回避)。

## 5. FE 状態管理（stores）★

Zustand。store分割:

| store | 状態 | 更新元イベント |
|-------|------|----------------|
| `connectionStore` | WS接続状態・各sessionの connection state | `connection`/`hello` |
| `sessionStore` | アクティブsession・キャラ一覧・タブ | `auth`/`session.open` |
| `mapStore` | session別 map(cells/chars/signs/size/style/mapset) | `map`/`snapshot` |
| `statusStore` | session別 status/cond | `status`/`cond`/`snapshot` |
| `chatStore` | session別 ログ(リングバッファ)・未読 | `message`/`snapshot` |
| `listStore` | リストモード状態・項目 | `list` |
| `editStore` | s-edit/m-edit 状態 | `edit` |
| `userStore` | session別 userList(priv宛先) | `userList`/`snapshot` |
| `modeStore` | attack/magic/list/more フラグ | `mode` |
| `uiStore` | フォーカスtab・ダイアログ・設定UI | ローカル |
| `settingsStore` | keybind/notify/display(SQLite同期) | `settings` |

- **snapshot適用**: 再接続時([07]§4.2) `snapshot` で map/status/cond/userList/mode を**全置換**。chatは追記(重複は ts/連番で抑止)。
- session別状態は `Map<sessionId, State>` で保持。

## 6. 再接続詳細 ★

- **検知**: WS `close`/`error` → connectionStore=disconnected。
- **バックオフ**: 指数 `min(30s, 1s * 2^n)` + jitter。手動再接続ボタンも提供。
- **復帰**: 再接続成功 → token で `auth` 自動(A-33)→ 各アクティブsession `session.open`(reattach) → BEが `snapshot` 送出 → store全置換で画面復元。
- **ゲームセッション保持**: BE側はWS切断後もタイムアウト([07]§4.2)までレガシー接続維持。再接続が間に合えば無切断。間に合わねば `connection:closed` を表示し再ログイン誘導。
- **送信中メッセージ**: WS切断中のFE送信はキューせず破棄(ゲーム操作は最新状態前提)。重要操作(register等)はREST(再送可)で。

## 7. デプロイ / 運用 ❌→設計

### 7.1 構成
```
[ブラウザ] --wss/https--> [リバースプロキシ(Caddy/Nginx, TLS終端)]
                              ├─ /            → FE静的(Vite build, CDN/静的配信)
                              ├─ /api/*       → FastAPI(REST)
                              ├─ /ws          → FastAPI(WebSocket)
                              └─ /assets/*    → 透過PNG静的配信([06][08])
[FastAPI] --TCP(SJIS)--> [レガシーサーバ群]
[FastAPI] -- SQLite(ファイル, WALモード) / 暗号鍵は環境変数]
```
- TLS推奨(wss)。token は localStorage 保持(A-33, cookie廃止)。LAN/非HTTPSでも動作。
- プロセス: `uvicorn`(asyncio単一プロセス) + プロセスマネージャ(systemd/supervisor)。**状態(セッション/ソケット)がプロセス内のため当面単一プロセス**。水平スケールは将来課題(セッション外部化要)。
- SQLite: WALモード。バックアップ(定期コピー)。
- 環境変数: `PHI_SECRET_KEY`(uid暗号), `PHI_DB_PATH`, `PHI_ASSETS_DIR`, `PHI_HOST`/`PHI_PORT`。

### 7.2 ログ / 監視（最小）
- 構造化ログ(JSON): 接続/切断/認証/世界移動/エラー/レート超過。**実uid・パスワードはログ禁止**(マスク)。
- ヘルスチェック: `GET /healthz`(プロセス生存)、レガシー接続数。
- メトリクス(任意): アクティブセッション数・WS数・レガシー再接続回数。

### 7.3 セキュリティ要点（再掲・集約）
- legacy uid 暗号化保存・ログ非出力。
- Web認証 argon2id、Bearer token(localStorage 保持, A-33。cookie廃止)。token はログ非出力。
- CSP(FE: `img=`外部URL対策[05]§13)。CSRF/Origin 検査は cookie 廃止(A-33, Bearer token)により不要。
- レート制限(§4)。
- 接続先などの設定値は環境変数で供給(`app/config.py`)。

## 8. 既存ドキュメントへの反映
- [05]§14 の「登録プロトコル未調査」→ **本doc §2で解決**(参照追記)。
- [10] の 🔶/❌ → 本docで詳細化(認証§1, 設定§3, レート§4, FE状態§5, 再接続§6, デプロイ§7, 登録§2)。
- 残課題: 登録 uid の addw/s_id 供給元(§2.4, 実機確認), 水平スケール(§7.1, 将来)。
