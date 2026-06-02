# バックエンド ⇔ フロントエンド 通信プロトコル仕様

phi-web の BE(ゲートウェイ) と FE(ブラウザ) 間の通信プロトコル。[02 設計](02-architecture-design.md)・[05 責務分担](05-feature-responsibility-design.md) で断片定義したWS APIを統合した正式仕様。

関連: BEはレガシーサーバへSJISソケットを常時保持。本プロトコルはBE⇔FE間のみを規定。レガシー側プロトコルは [01](01-legacy-investigation.md)。

---

## 1. 基本方針

- **トランスポート**: WebSocket。テキストフレーム、**UTF-8 JSON**。1フレーム=1メッセージ。
- **方向**: C→S(FE→BE)=意図(intent)/要求。S→C(BE→FE)=イベント/応答。
- **鉄則**([05]): FEはレガシー文字列を組み立てない。意図のみ送り、BEがレガシー整形・SJIS変換。レガシーのバイナリ(マップチップ等)はBEが構造化JSONへ変換してFEへ渡す。
- **マルチキャラ**: 1接続(WS)で複数キャラ(セッション)を多重化。各メッセージに `session` を付与。

## 2. メッセージ封筒(エンベロープ)

全メッセージ共通の予約キー＋ペイロードはフラット展開。

```jsonc
{
  "type":    "<string>",   // 必須. メッセージ種別 (例 "chat", "map")
  "session": "<string>",   // 任意. キャラセッションID. 単一キャラ時は省略可
  "reqId":   "<string>",   // 任意. 要求/応答の相関ID (要求側が採番)
  "ts":      1730000000,   // 任意. 送信側UNIX時刻(ms). ログ/遅延計測用
  // --- 以降, type固有のペイロードフィールドをフラットに展開 ---
}
```

- 予約キー: `type` `session` `reqId` `ts` `ok` `error`。ペイロードはこれらと衝突させない。
- **応答**(`reqId`を伴う要求への返信)は `ok`(bool) を持ち、失敗時 `error` を含む(§9)。
- **session付与規約**(DEVLOG A-03): **S→C(BE→FE)は常に `session` を付与**(単一キャラでも)。C→S(FE→BE)は単一セッション時のみ省略可で、BEがアクティブsessionに解決。
- **reqId**(A-02): 要求側(FE)がUUID等で採番、BEは応答に**同`reqId`をエコー**。
- バージョン: 初回 `hello`(§4) で `protocolVersion` を交換。本仕様 = **v1**。

## 3. 命名・型規約

- `type` はドット階層なしの小文字+必要に応じ`.`区切り(例 `list.select`)。
- フィールドは camelCase。
- 座標 `x`/`y` は 0始まりのマップセル。方角(DEVLOG A-05でBE正規化): **`map.dir`=数値0-7**(自キャラ方角)、**`map.chars[].dir`=文字`"B"|"R"|"F"|"L"`**(キャラ向き, Back/Right/Front/Left)。移動intentの`dir`は`"N"|"E"|"S"|"W"`(絶対)。
- 列挙は文字列。バイト値(chip/attribute)は 0-255 の整数。

---

## 4. 接続ライフサイクル

**アカウント認証(DEVLOG A-34 / A-33)**: Webアカウント(`accountId`+パスワード)でログインし token を発行(A-33)。1アカウントに複数キャラ(`label`+PHI uid+host+port)を登録(A-34)。PHI uid(6字パス埋込の資格情報)は BE が Fernet 暗号で `characters.phi_uid_enc` に保管し FE へ出さない。
旧 ID-only 認証(A-31)・`saved_ids`・`saved.list`・cookie は A-33/A-34 で**廃止**。

```
FE                                   BE
│ ── POST /api/auth/register {accountId,password} ─▶ │  (任意)新規登録。argon2id
│ ── POST /api/auth/login {accountId,password} ────▶ │  REST. token発行(A-33)
│ ◀─ {ok, token, isAdmin} ─────────────────────────  │
│ ── GET /api/characters (Bearer) ─────────────────▶ │  キャラ一覧(phi_uid非公開)
│ ◀─ [{charId,label,host,port}] ───────────────────  │
│ ── WS接続 ───────────────────────────────────────▶ │
│ ── auth {token} ─────────────────────────────────▶ │  first message。token検証(A-33)
│ ◀─ auth {ok, isAdmin?} ──────────────────────────  │
│ ◀─ hello (protocolVersion, serverTime) │
│ ── session.open {charId} ────────────────────────▶ │  BE: charId→phi_uid復号→#open
│ ◀─ session.open {ok, session, isAdmin} │
│ ◀─ connection (connected) │
│ ◀─ snapshot (map,status,cond,…) │
│ ── chat / move / command … ──────────────────────▶ │
```

### 4.1 認証・キャラ管理(A-34 / A-33)
- 認証 = **Webアカウント**(`accountId`+パスワード)。`POST /api/auth/login` で token 発行。パスワードは argon2id でハッシュ保管(`accounts.password_hash`)。
- token は localStorage 保持。REST は `Authorization: Bearer <token>`、WS は接続後 first message の `auth {token}` で検証(cookie 廃止, A-33)。
- キャラは `characters`(`charId`(uuid), `account_id`(FK), `label`, `phi_uid_enc`, `host`, `port`)。PHI uid(=資格情報)は Fernet 暗号で保管し、ログ/応答に平文露出しない。
- `session.open {charId}` で BE が所有検証→`phi_uid` 復号→`#open` を `host:port` のキャラへ送出。
- 管理者 = `accounts.is_admin`。`isAdmin` を auth / session.open 応答で返しFEが管理UI出し分け。
- 管理 API(全て Bearer): `POST /api/auth/register`, `GET /api/characters`, `POST /api/characters`, `DELETE /api/characters/{charId}`。

### 4.2 常時接続・再アタッチ・スナップショット
- BEはFE切断後もタイムアウトまでレガシー接続を保持([02])。
- FE再接続時: WS再接続で token により自動再`auth`(A-33)→各開いている session を `session.open {charId}` で**既存セッションへ再アタッチ**。BEは現在の map/status/cond/userList/モード状態を `snapshot` で一括再送 → FEが画面復元。
- スナップショットにより、FEは差分を気にせず常に最新へ追従。

### 4.3 ハートビート
- レガシーの `#lag`/`#end-lag`・キープアライブ(`#code-sjis`) は **BEが内部処理**。FEへ露出しない。
- WSレベルはping/pongフレームで生存監視。アプリ層 `ping`/`pong`(§8) は任意(遅延表示用)。

---

## 5. C→S メッセージ(FE→BE: 意図・要求)

各 `type` と、BEが行うレガシー変換を併記。

### 5.1 接続・セッション
| type | フィールド | 説明 / レガシー変換 |
|------|-----------|---------------------|
| `auth` | `token` | WS認証(A-33)。接続後 first message。token を検証 |
| `session.open` | `charId` | キャラ接続。BE: charId→phi_uid復号→`#open`+LoginCommand([03]) or 再アタッチ。**応答**: `{type:"session.open", reqId, ok:true, session:"<id>"}`(割当session返却, A-10)→続けて `connection`+`snapshot` |
| `session.close` | — | 当該セッション切断。BE: `#x`送信・接続終了 |

### 5.2 移動
| type | フィールド | レガシー変換 |
|------|-----------|--------------|
| `move` | `mode`+`dir`(下記, A-17), `repeat?`(bool) | BE serializerが整形 |

move契約(DEVLOG A-17):
- 北固定(solid): `{mode:"step", dir:"N"\|"E"\|"S"\|"W"}` → `go N` 等。
- turn(相対): `{mode:"step", dir:"F"\|"B"}` → `go`/`go b`、`{mode:"strafe", dir:"L"\|"R"}` → `go l`/`go r`。
- 共通: `{mode:"turn", dir:"l"\|"r"\|"b"}` → `turn l/r/b`。

### 5.3 チャット([05] §1)
| type | フィールド | レガシー変換 |
|------|-----------|--------------|
| `chat` | `mode`("normal"\|"loud"\|"party"\|"all"), `text` | normal=そのまま / loud=先頭`*` / 先頭`*`の通常発言は`/**/`付与 / party=Ctrl発言整形 / all=全セッション同報 |
| `chat` (priv) | `mode`:"priv", `to`(userKey), `text` | **`priv <番号> <本文>`(1行, `#`なし)**(実機検証 DEVLOG A-13)。番号はBE保持の`#user`表で解決。受信は `[<送信者>] > <本文>` |

### 5.4 汎用コマンド([05] §2,6,7)
| type | フィールド | レガシー変換 |
|------|-----------|--------------|
| `command` | `name`, 付随パラメータ | nameごとに整形 |

`command.name` の主な値:
- `hit` → `hit`
- `pay` (`amount`) → `pay <amount>` (amount=0でpay 0)
- `equip`/`unequip`/`get`/`put`/`use`/`sort`/`read`/`write`/`board` → 同名コマンド
- `castMagic` (`spell`) → `cast\n<spell>`
- `summon` (`action`:"appear"|"disappear", `creature`) → `cast\n<action>\n<creature>`
- `shop` (`action`:"buy"|"sell"|"shop") → 同名(後続はlist/editへ遷移)
- `raw` (`text`) → `text` をそのまま送信(エスケープハッチ)

### 5.5 リスト選択([05] §5)
| type | フィールド | レガシー変換 |
|------|-----------|--------------|
| `list.select` | `value`(数値\|"all"\|"cancel") | 数値→`<n>` / all→`-` / cancel→`.` |

### 5.6 入力(s-edit/m-edit)([05] §4)
| type | フィールド | レガシー変換 |
|------|-----------|--------------|
| `edit.submit` | `mode`("single"\|"multi"), `lines`[] | single=1行送信 / multi=各行送信+終端`.` |
| `edit.cancel` | — | multi=`.!` / single=空送信等 |

### 5.7 設定([05] §6,10)
| type | フィールド | 説明 |
|------|-----------|------|
| `settings.get` | `scope`("keybind"\|"notify"\|…) | reqIdで応答(SQLite `settings`) |
| `settings.set` | `scope`, `value` | scope別に value 構造を検証(未知キー許容/サイズ上限)→ 永続化。不正は BAD_REQUEST |

### 5.8 表示モード要求
| type | フィールド | レガシー変換 |
|------|-----------|--------------|
| `view.set` | `mapSize`(40\|57), `mapStyle`("turn"\|"solid"), `eagleEye`(bool) | `#ex-map size=` / `#ex-map style=` / `#ex-switch eagleeye=` |
| `map.request` | — | `#map` / `#remap`応答 |

### 5.9 ハートビート(任意)
| type | フィールド |
|------|-----------|
| `ping` | `nonce` |

---

## 6. S→C メッセージ(BE→FE: イベント・応答)

### 6.1 ハンドシェイク・接続
| type | フィールド | 由来 |
|------|-----------|------|
| `hello` | `protocolVersion`, `serverTime` | 接続直後 |
| `auth` (応答) | `ok`, `isAdmin?`, `error?` | token検証結果(A-33)。キャラ一覧は含まず(GET /api/characters で別取得) |
| `connection` | `state`("connecting"\|"connected"\|"detached"\|"closed"), `reason?` | レガシー接続状態. `#x`/`#close`→closed |
| `snapshot` | `map?`, `status?`, `cond?`, `userList?`, `mode?`, `notice?`, `list?`, `edit?` | 再アタッチ時の一括状態(§4.2)。`list?`/`edit?` はアクティブな対話状態がある場合のみ(DEVLOG A-04) |

### 6.2 マップ(`#map`/`#m57`)
BEがバイナリを構造化。グリッドは小さい(最大7×7=49セル)ため整数配列で送る(base64不要)。

```jsonc
{
  "type": "map",
  "session": "char1",
  "size": 7,                 // 7(=m57,7x7) | 5(=5x5)
  "dir": 2,                  // 自キャラ方角=数値0-7(BE正規化, DEVLOG A-05). turnモード時の上方向
  "style": "solid",          // "turn" | "solid"
  "mapset": "mansion",       // チップセット名(#mapset)
  "cells": [                 // size*size 要素, 行優先(index=y*size+x)
    { "chip": 104, "attr": 0 }, …
  ],
  "chars": [                 // #m57 O / #map C のキャラ・オブジェクト
    { "id": 1, "x": 3, "y": 3, "dir": "B", "name": "ExampleChar",
      "gra": "t_Lord", "status": 64, "gigant": "#", "layer": 0,
      "default": 64 }        // typeコード(#m57 O末尾). グラ フォールバックに使用([09])
  ],
  "signs": [ { "x": 1, "y": 0, "title": "居ぬ子" } ]  // 看板(#…B)
}
```
- `chip`/`attr` は 0-255。FEは phi-client同様 `CHIP_BYTE_TO_INDEX` 等で描画。
- `gigant`: `"#"`=通常 / `"*"`=巨大。`gra`=グラ名(拡張子なし、Index.txtで解決)。

### 6.3 ステータス(`#status`)
```jsonc
{ "type": "status", "session": "char1",
  "name": "t_Lord",
  "hp": 4775, "maxHp": 4775, "mp": 3344, "maxMp": 3344,
  "exp": 24063, "gp": 2161,
  "f": 7269, "w": 3712, "m": 5290, "c": 2540 }
```
(`#status` の `:`区切り11項目に対応: name:HP:MaxHP:MP:MaxMP:Exp:Gp:F:W:M:C)

### 6.4 状態異常(`#cond`)
```jsonc
{ "type": "cond", "session": "char1",
  "poison": false, "palsy": false, "panic": false, "confuse": false,
  "berserk": false, "silence": false, "blind": false }
```
(`#cond` の7フラグ。`*`=有効/`-`=無効)

### 6.5 メッセージ・ログ(チャット/DM/priv)
```jsonc
{ "type": "message", "session": "char1",
  "channel": "log",          // "log" | "priv" | "loud" | "system"
  "seq": 42,                 // session毎の単調増加連番(重複抑止用, A-11)
  "from": "ExampleChar",            // 発言者(なければ省略)
  "text": "こんにちは",       // UTF-8(SJISから変換済). マークアップ含む生テキスト
  "markup": true             // /*color=*/ 等のマークアップを含むか
}
```
- マークアップ(`/*color=red*/…/*.*/`, `/*cl=*/`, `img=`)はFEが解釈([05] §10,13)。BEは破壊せず透過。
- 通知判定メタ(channel/from)をFEへ提供([05] §10)。

### 6.6 ユーザ一覧(`#user`)
```jsonc
{ "type": "userList", "session": "char1",
  "users": [ { "key": "u1", "name": "ExampleChar" }, … ] }
```
priv宛先に使う `key` はBE採番(`#user`番号を隠蔽)。

### 6.7 リスト(`#list`)
```jsonc
{ "type": "list", "session": "char1", "active": true,
  "lines": ["1: 短剣", "2: 鉄の剣", …] }
// 終了
{ "type": "list", "session": "char1", "active": false }
```

### 6.8 入力要求(`#s-edit`/`#m-edit`/`#.`)
```jsonc
{ "type": "edit", "session": "char1", "mode": "single" }  // "single"|"multi"
{ "type": "edit", "session": "char1", "mode": "end" }     // #. でクローズ
```

### 6.9 モードフラグ(`#attack`/`#magic`/`#list`/`#more`)
```jsonc
{ "type": "mode", "session": "char1",
  "attack": false, "magic": false, "list": false, "more": false }
```
変化時に差分または全量で送信。

### 6.10 世界移動(`#ch-srv`)([05] §8)
```jsonc
{ "type": "worldTransfer", "session": "char1",
  "state": "start",          // "start" | "success" | "fail"
  "server": "<SERVER_IP>:<PORT>" }
```
- ハンドシェイク・**300秒タイムアウト・SQLite `last_server`更新**はBE責務。FEは進行表示のみ。

### 6.11 EagleEye(`#ex-eagleeye`)
```jsonc
{ "type": "eagleEye", "session": "char1",
  "width": 15, "height": 15,
  "mapset": "mansion",       // 任意(A-19). 無ければFEは現マップのmapset流用
  "self": { "x": 7, "y": 7 },
  "cells": [ { "chip": 12, "attr": 8 }, … ]  // width*height, 行優先
}
```

### 6.12 環境通知(`#ex-notice`/`#mapset`/`#name`)
```jsonc
{ "type": "notice", "session": "char1",
  "world": "Fantasy Island Country", "area": "港町の酒場",
  "name": "ExampleChar", "mapset": "mansion" }
```
(`#bgm` はBGM不要方針のため送信しない/無視。[04])

### 6.13 設定応答
```jsonc
{ "type": "settings", "reqId": "...", "ok": true,
  "scope": "keybind", "value": { … } }
```

### 6.14 ハートビート応答(任意)
```jsonc
{ "type": "pong", "nonce": "...", "serverTime": 1730000000 }
```

---

## 7. レガシー ⇔ WS 対応表(BE実装の指針)

| レガシー(S→C) | WSイベント |
|----------------|-----------|
| `#name` | `notice`(name) |
| `#map`/`#m57`(M/O/B/.) | `map` |
| `#status` | `status` |
| `#cond` | `cond` |
| `#user` | `userList` |
| `#priv` | `message`(channel=priv) |
| 一般ログ行 | `message`(channel=log) |
| `#list`/`#end-list` | `list`(active切替) |
| `#s-edit`/`#m-edit`/`#.` | `edit` |
| `#attack`/`#end-at`/`#magic`/`#end-mg`/`#more`/`#end-more` | `mode` |
| `#ex-notice`/`#mapset` | `notice` |
| `#ex-eagleeye …` | `eagleEye` |
| `#ch-srv` | `worldTransfer` + 内部ハンドシェイク |
| `#lag` | (内部 `#end-lag`応答, FE非露出) |
| `#x`/`#close` | `connection`(state=closed) |
| `#bgm`/`#ex-bgm-speed` | (無視) |

| WS(C→S) | レガシー(C→S) |
|---------|----------------|
| `move` | `go …`/`turn …` |
| `chat` | テキスト(`*`/`/**/`/party整形)/`#priv` |
| `command` | `hit`/`pay …`/`cast\n…` 等 |
| `list.select` | `<n>`/`-`/`.` |
| `edit.submit`/`edit.cancel` | 行送信/`.`/`.!` |
| `view.set` | `#ex-map …`/`#ex-switch …` |
| `map.request` | `#map` |

---

## 8. 並行性・順序保証

- WSはTCP上で順序保証。BEは1セッションのレガシー送信を順序維持。
- C→S の操作はBEで受理順にレガシーへ流す。`reqId`付き要求のみ応答を相関。
- S→C のストリームイベント(map/status等)は順次配信。FEは最新値で上書き(map/status/cond/userListは全量、modeは差分可)。

## 9. エラーハンドリング

応答型(reqId付き)の失敗、およびサーバ起因エラー:
```jsonc
{ "type": "<reqType>", "reqId": "...", "ok": false,
  "error": { "code": "AUTH_FAILED", "message": "ID またはパスワードが不正" } }
// または非相関の汎用エラー
{ "type": "error", "session": "char1",
  "error": { "code": "LEGACY_DISCONNECTED", "message": "DM との接続が切断" } }
```
コード例: `AUTH_FAILED` `SESSION_NOT_FOUND` `LEGACY_DISCONNECTED` `TRANSFER_FAILED` `RATE_LIMITED` `BAD_REQUEST` `INTERNAL`。

## 10. セキュリティ・運用

- 認証トークン/セッションはWS確立後の `auth` で確立。WSはTLS(wss)前提。
- `command.raw` は任意文字列送信のためレート制限・監査ログ対象。
- マークアップ `img=` の外部URLはFEでサニタイズ/CSP([05] §13)。
- レート制限超過は `error`(RATE_LIMITED)。

## 11. バージョニング・拡張

- `hello.protocolVersion` で互換判定。FEは非対応時に警告。
- 未知 `type` は受信側で無視(前方互換)。新フィールド追加は後方互換とする。
- レガシー拡張(`#ex-*`新種)はBE側で吸収し、必要に応じ新WSイベント追加。

---

## 付録A: 最小セッション例

```jsonc
// FE→BE
{"type":"auth","reqId":"r1","id":"<CHARACTER_ID>","password":"…"}
// BE→FE
{"type":"hello","protocolVersion":1,"serverTime":1730000000}
{"type":"auth","reqId":"r1","ok":true,"characters":[{"charId":"<CHARACTER_ID>","name":"ExampleChar","lastServer":"<SERVER_IP>:<PORT>"}]}
// FE→BE
{"type":"session.open","reqId":"r2","charId":"<CHARACTER_ID>"}
// BE→FE
{"type":"connection","session":"s1","state":"connected"}
{"type":"snapshot","session":"s1","status":{…},"cond":{…},"map":{…},"notice":{"world":"Fantasy Island Country","area":"港町の酒場"}}
// 以降ストリーム＋操作
{"type":"move","session":"s1","dir":"N","mode":"step"}
{"type":"map","session":"s1","size":7,"cells":[…],"chars":[…]}
{"type":"chat","session":"s1","mode":"loud","text":"集合！"}
```
