# REST API リファレンス(as-built)

BE↔FE の REST エンドポイント一覧。別クライアント実装者向けの契約書。
WebSocket(ゲーム本体の通信)は対象外 → [07-ws-protocol.md](07-ws-protocol.md) 参照。

> **ライブ参照**: BE 起動中は FastAPI 自動生成の Swagger UI が `GET /docs`、スキーマが
> `GET /openapi.json`、ReDoc が `GET /redoc` で参照可能。本書は運用上の契約(認可・
> エラー・副作用)を散文で補足する位置づけ。

## 共通事項

- **文字コード**: リクエスト/レスポンスとも UTF-8 JSON(アップロードは multipart/form-data)。
- **認証(A-33/A-34)**: 保護エンドポイントは `Authorization: Bearer <token>`。token は
  `POST /api/auth/login` で取得し、クライアントが保持(本実装は localStorage)。Cookie は不使用。
- **認可レベル**:
  - *公開*: 認証不要。
  - *要認証*: 有効な Bearer token。無効/欠落は `401`。
  - *管理者*: token + `accounts.is_admin`。未認証 `401` / 非管理者 `403`。
- **エラー形式**: 原則 FastAPI 標準 `{"detail": "<メッセージ>"}`。一部(register の
  フィールド検証等)は `{"detail": {"error": {"code": ..., "fields": ...}}}`。クライアントは
  両形を許容し、まず `detail.error.message`/`detail` の順で拾うと安全。
- **資格情報**: PHI uid・パスワード・token はレスポンス/ログに出さない。

---

## 1. 認証 `/api/auth`

| メソッド | パス | 認可 | body | 応答 |
|----|----|----|----|----|
| POST | `/api/auth/register` | 公開 | `{accountId, password}` | `{ok:true, isAdmin}` |
| POST | `/api/auth/login` | 公開 | `{accountId, password}` | `{ok:true, token, isAdmin}` |
| POST | `/api/auth/logout` | 要認証 | — | `{ok:true}` |

- register: パスワードは8文字以上(未満 `400`)、既存 accountId は `409`。
  **アカウント0件の状態での初回登録は自動的に管理者化**(`isAdmin:true`)。
- login: 失敗 `401`、総当たり抑止で `429`(account+IP レート)。
- token 期限: idle 30分 / absolute 24h(超過で失効、`401`)。

## 2. キャラクター `/api/characters`(要認証・所有検証)

| メソッド | パス | body | 応答 |
|----|----|----|----|
| GET | `/api/characters` | — | `{characters:[{charId,label,host,port}]}` |
| POST | `/api/characters` | `{label, phiId, host, port}` | `{charId,label,host,port}` |
| PUT | `/api/characters/{charId}` | `{label?, phiId?, host?, port?}` | 同上 |
| DELETE | `/api/characters/{charId}` | — | `{ok:true}` |

- `phiId`(PHI uid)は資格情報。応答に含めず暗号化保存。`port` は 1–65535(範囲外 `400`)。
- 他人/不在の `charId` は `404`(存在秘匿)。

## 3. 新規キャラ登録代行 `/api/register`

| メソッド | パス | 認可 | body | 応答 |
|----|----|----|----|----|
| GET | `/api/register/graphics` | 要認証 | — | `{graphics:[{index, graName}]}` |
| POST | `/api/register` | 要認証 | `{name, pass, imageIndex, mail?}` | `{charId, name}` |

- レガシーサーバへ `#ex-register` を代行送出。レート 5/時/IP(超過 `429`)。
- 入力検証失敗/サーバ拒否は `400`(`{detail:{error:{code:"REGISTER_REJECT", fields}}}`)。
  レガシー通信失敗は `502`。

## 4. キャラグラフィック `/api/chara`

詳細設計は [08-chara-graphics-storage.md](08-chara-graphics-storage.md)。変更系は*管理者*、GET 系は*公開*(レート制限のみ)。

| メソッド | パス | 認可 | 内容 |
|----|----|----|----|
| POST | `/api/chara/graphics` | 管理者 | multipart `file`,`graName`,`colorKey`(既定teal)→ 透過変換・保存 |
| GET | `/api/chara/graphics` | 公開 | 一覧(メタ配列) |
| GET | `/api/chara/graphics/{graName}` | 公開 | メタ |
| GET | `/api/chara/graphics/{graName}/png` | 公開 | 透過PNG(`image/png`, ETag) |
| DELETE | `/api/chara/graphics/{graName}` | 管理者 | 削除 |
| GET | `/api/chara/index` | 公開 | エイリアス一覧 `[{key, graName}]` |
| PUT | `/api/chara/index/{key}` | 管理者 | body `{graName}` 登録/更新 |
| DELETE | `/api/chara/index/{key}` | 管理者 | 削除 |
| POST | `/api/chara/index/import` | 管理者 | Index.txt(cp932/UTF-8)一括取込 |
| GET | `/api/chara/index.txt` | 公開 | Index.txt 形式を生成・配信(`?charset=cp932` 可) |
| GET | `/api/chara/manifest` | 公開 | `{graphics:{graName:url}, index:{key:graName}}` |

**グラフィック メタ**:
```json
{ "graName": "野ネズミ", "url": "/api/chara/graphics/.../png",
  "width": 96, "height": 160, "colorKey": "teal",
  "protected": false, "uploadedAt": "2026-06-03T00:00:00Z" }
```

アップロード規約(as-built):
- **寸法は 96×160 固定**。不一致は `400`(旧仕様の警告ではなく拒否)。
- 物理ファイル名 = `lower(graName)`。`/assets/chara/<lower(graName)>.png` で静的配信され、
  ゲーム内のグラ解決(specific→fallback→placeholder, [09])と一致する。
- `graName` に `/ \ .`・制御文字を含むと `400`(path traversal 対策)。
- **同名(gra_key 衝突)は `409`**。差し替えは削除 → 再アップロード。
- `protected:true`(リポジトリ同梱 seed)は削除不可(`403`)。

## 5. マップチップ `/api/chip`

| メソッド | パス | 認可 | 内容 |
|----|----|----|----|
| POST | `/api/chip/graphics` | 管理者 | multipart `file`,`mapset` → 左右分割を透過変換・保存 |
| GET | `/api/chip/graphics` | 公開 | 一覧 |
| GET | `/api/chip/graphics/{mapset}` | 公開 | メタ |
| GET | `/api/chip/graphics/{mapset}/png` | 公開 | 透過PNG(`image/png`, ETag) |
| DELETE | `/api/chip/graphics/{mapset}` | 管理者 | 削除 |

**チップ メタ**:
```json
{ "mapset": "town", "url": "/api/chip/graphics/town/png",
  "width": 512, "height": 96, "protected": false,
  "uploadedAt": "2026-06-03T00:00:00Z" }
```

アップロード規約:
- **入力は 1024×96 の左右分割**(左=画像 / 右=マスク)。`convert_chip`(mask-h)で
  **512×96 の透過PNG** へ変換して保存。入力寸法不一致は `400`。
- 物理名 = `lower(mapset)`。`/assets/chip/<lower(mapset)>.png` で配信(マップの mapset に対応)。
- 同名 `409`、`protected` 削除 `403`、`mapset` の `/ \ .` `400`。

## 6. 管理者ユーザ管理 `/api/admin`(管理者限定)

| メソッド | パス | body | 応答 |
|----|----|----|----|
| GET | `/api/admin/accounts` | — | `{accounts:[{accountId, isAdmin, createdAt, charCount}]}` |
| POST | `/api/admin/accounts/{id}/admin` | `{value:bool}` | `{accountId, isAdmin}` |
| PUT | `/api/admin/accounts/{id}/password` | `{password}` | `{ok:true, accountId}` |
| DELETE | `/api/admin/accounts/{id}` | — | `{ok:true, deleted}` |

- password_hash は応答に出さない。PW は8文字以上(未満 `400`)。不在 `id` は `404`。
- **安全弁**(`400`): 自分自身の管理者剥奪/削除、最後の管理者の剥奪/削除を拒否。
- **副作用**: 管理者剥奪・PW強制変更・削除は対象アカウントの Web セッションを全失効
  (対象ユーザは再ログインが必要)。アカウント削除は配下キャラを FK CASCADE で連鎖削除。

## 7. その他

| メソッド | パス | 認可 | 内容 |
|----|----|----|----|
| GET | `/healthz` | 公開 | `{ok:true, sessions}` |
| GET | `/assets/*` | 公開 | 透過PNG 静的配信(chara/chip/items) |
| WS | `/ws` | 接続後 auth | ゲーム通信([07-ws-protocol.md](07-ws-protocol.md)) |
