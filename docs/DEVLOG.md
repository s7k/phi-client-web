# DEVLOG — BE/FE 並行開発 調整メモ

BE(バックエンド)・FE(フロントエンド)を並行スレッドで開発する際の**整合・調整の単一情報源**。各スレッドは着手前に本ファイルを読み、進捗・疑問・決定を追記。統合役(リード)がラウンドごとに同期・コミット。

## 0. 運用ルール

> ⛔ **絶対禁止(他者迷惑回避)**: 実サーバへの **priv送信・大声(server-wide発言)・パーティ発言・通常チャット** をテスト/検証で**送らない**。他プレイヤーに迷惑。これらの送信仕様検証は**ユーザーが別途実施**。実サーバ送信は `#`プロトコル行と移動/観察コマンドのみ(`test_connect.py` にガード `_reject_disruptive` 実装済)。chat/priv/loud は**合成フィクスチャによるオフライン単体テストのみ**で検証する。



- **役割**: リード(統合・コミット・方針決定) / BEスレッド(`backend/` 専従) / FEスレッド(`frontend/` 専従)。
- **ディレクトリ占有**: BEは `backend/` のみ、FEは `frontend/` のみ編集。`docs/`・ルート設定はリードが編集。衝突回避。
- **契約(コントラクト)**: WSプロトコル [07](07-ws-protocol.md) が BE↔FE の正。逸脱はここに疑問として記し、リードが裁定。
- **TDD**: テスト先行(red→green→refactor)。[11](11-test-design.md) 準拠。
- **コミット**: リードがラウンド毎に実施。**秘匿値(IP/Port/uid/実名)をコード・コミットに残さない**。録画は `backend/tests/fixtures/recorded/`(gitignore)。
- **実サーバ**: 不明点は接続検証可。接続情報は `backend/.env`(gitignore)から読む。**ハードコード禁止**。
- **エージェントはgit操作しない**(コミットはリード)。

## 1. ゴール / 全体方針

- ブラウザ(UTF-8) ⇔ BE(Python/FastAPI ゲートウェイ) ⇔ レガシーSJISサーバ。設計 [02][07]。
- 移植元: `~/workspace/phi-client`(Python, 動作実績) のプロトコル/エンジン/描画ロジック。
- スタック: BE=Python/FastAPI、FE=React/TS/Vite。

## 2. 作業分解（[13]§5 推奨順）

### BE
- [ ] scaffold(pyproject, app/, tests/conftest, モックTCP)
- [ ] B1 LineBuffer (TDD) — phi-client `line_buffer.py`
- [ ] B2 CodeConverter (TDD) — 行種別分岐 [02]§3.3
- [ ] B3 ProtocolParser (TDD, フィクスチャ) — phi-client `parser.py`/`map_data.py`
- [ ] B4 CommandSerializer (TDD) — [07]§7
- [ ] B5 LegacySocket (モックTCP) — phi-client `connection.py`
- [ ] B6 SessionManager (snapshot/reattach) — [07]§4
- [ ] B7 WsServer (エンベロープ) — [07]
- [ ] B8 Store/SQLite — [02]§6 [08]§4 [12]§1.4
- [ ] B9 gfx共有module / B11 fallback
- [ ] B10 REST chara / B12 認証 / B13 世界移動 / B14 レート / B15 登録

### FE
- [ ] scaffold(Vite+TS+Vitest, 構造)
- [ ] F1 WSクライアント(エンベロープ/再接続/snapshot) [07][12]§6
- [ ] F2 stores(Zustand 分割) [12]§5
- [ ] F3 ログイン+キャラ選択 / F6 ステータス表示
- [ ] F4 マップ描画(Canvas) — phi-client `map_widget.py`
- [ ] F5 グラ解決(fallback/manifest) [09]
- [ ] F7 チャット/markup / F8 キーハンドラ / F9 リスト/編集/priv/タブ
- [ ] F10 設定UI / F11 通知/SS/画像 / F12 登録フォーム

## 3. 統合契約サマリ（要点。詳細は [07]）

- エンベロープ: `{type, session?, reqId?, ts?, ...payload}`。予約キー: type/session/reqId/ts/ok/error。
- C→S: `auth` `session.open` `move` `chat` `command` `list.select` `edit.submit` `edit.cancel` `view.set` `settings.get/set` `ping`。
- S→C: `hello` `auth` `connection` `snapshot` `map` `status` `cond` `message` `userList` `list` `edit` `mode` `worldTransfer` `eagleEye` `notice` `settings` `pong` `error`。
- `map.chars[].default` = typeコード(グラfallback [09])。
- エラー: `{ok:false, error:{code,message}}`。コード [07]§9。

## 4. 整合・疑問 ↔ 決定（ディスカッション領域）

> 形式: `Q-NN [BE/FE/共通] 疑問` → `A-NN [決定/リード] 回答`。未解決は `OPEN`。

### R0 由来

- **Q1 [BE]** CodeConverterと Parserの責務境界(#m57 O 構造化)。
  → **A1**: CodeConverterは**エンコード専任**(バイナリ/テキスト判定・name/gra部分decode)。`#m57 O`の全フィールド構造化・複数スロット(raw[7:74]/[75:142])は**ProtocolParser(B3)**。エージェント方針で正。
- **Q2 [BE]** gra 15バイト枠でのマルチバイト切れ懸念。
  → **A2**: 15バイトオフセット採用・rstrip・errors=replace。日本語gra切れは実データ録画(B3/R1)で確認。未知graは fallback([09])で吸収するため致命でない。
- **Q3 [BE]** #m57 O 二重オブジェクト行。
  → **A3**: Parser(B3)で raw[7:74]/[75:142] 2スロット対応。
- **Q-02 [共通]** reqId採番。
  → **A-02**: FEがUUID採番、**BEは応答に同reqIdをエコー**([07]§2)。確定。
- **Q-03 [共通]** session省略時の扱い。
  → **A-03**: **S→C(BE→FE)は常に`session`を付与**(単一キャラでも)。C→S(FE→BE)は単一時のみ省略可→BEがアクティブsessionに解決。FEは常にsessionIdキーでStore管理。[07]§2に追記。
- **Q-04 [共通]** snapshotにlist/edit状態を含むか。
  → **A-04**: snapshotに任意フィールド `list?`/`edit?` を**追加**(再アタッチ時にアクティブなら含める)。[07]§6.1更新。
- **Q-05 [共通]** dir型(数値 vs 文字)。
  → **A-05**: **BEで正規化**。`map.dir`=数値0-7(自キャラ方角)、`map.chars[].dir`=文字`"B|R|F|L"`(キャラ向き)。FEはこの前提。[07]§6.2明確化。
- **Q-01 [FE]** snapshotのmode/userList store未配線 → R1で配線。問題なし。

### R1 由来（リード裁定。BE/FEの同番号は再採番）

- **A-06 [共通] map.dir 数値マッピング**: 時計回り45度刻み **N=0, NE=1, E=2, SE=3, S=4, SW=5, W=6, NW=7**。BE正規化・FEは描画(F4)で使用。確定。
- **A-07 [共通] move整形**: step移動は `dir` 絶対(N/E/S/W) → BEが自キャラ向き(直近map.dir)で必要なら相対化。回転は `mode:"turn"` + `dir:"l|r|b"` で `turn l/r/b`。turnスタイル時の簡約(N=前/S=後/E=右/W=左)はBE暫定。**F8(キーハンドラ)実装時に最終確定+実機検証(R2録画)**。
- **A-08 [共通] chat party/all**: party=`%`プレフィクス(暫定, 実機要検証)。all=SessionManagerが全session同報(serializerはnormal整形)。**R2録画で検証**。
- **A-09 [BE] `#m57 W`(2スロット)区切り**: raw[7:74]/[75:142]踏襲。スロット間区切り未確認→**R2録画で検証**。OPEN。
- **A-10 [共通] session.open応答**: BEは `{type:"session.open", reqId, ok:true, session:"<id>"}` を返し(reqIdエコー+割当session)、続いて `connection`→`snapshot`。FEはreqId応答の`session`でsessionId確定。[07]更新。
- **A-11 [共通] message.seq**: BEが**session毎の単調増加`seq`**を`message`に付与。FEはseqで重複抑止(無ければ内容一致fallback)。[07]更新。
- **A-12 [共通] mode は常に全フラグ送出**: BEが attack/magic/list/more 全量を毎回送る。FEは全置換。確定。

### R2 由来（実機録画で判明・リード裁定）

- **A-13 [共通] priv送信整形(契約修正)**: 実機+phi-client両方 **`priv <番号> <本文>`(1行, `#`なし)** が正(旧契約`#priv\n`は誤り)。受信=`[<送信者>] > <本文>`。[07]§5.3・[05]§1修正済。**serializerをR3で修正+テスト更新**(Q-13対応)。
- **A-14 [共通] party送信**: `%`プレフィクスは実機で否定。**party/大声の送信仕様検証はユーザーが別途実施(§0禁止事項)**。当面 partyはnormal整形+TODO。我々は実サーバで再検証しない。OPEN(ユーザー側)。
- **A-15 [BE] `#m57 W`(2スロット)**: ログイン〜通常マップでは出現せず未検証。eagleeye/特定状況で再録画し確定。OPEN。
- **A-16 [確認] dir/自キャラ**: 自キャラ=`#m57 O C`行(layer 0xC=12)、他=`B`(11)。`map.dir`数値化(S=4)・`chars[].dir`文字 を実機確認。A-05/06正。
- **FE-Q13 [確認] チップシート512×96**: gfx_convert出力(画像半分512×96, 32×48セル)で正。FE実装前提と一致。確定。
- **FE-Q15 [FE] 水縁/巨大magnify(#ex-obj)**: 後続R(R4頃)で移植。OPEN(低優先)。

### R3 由来（リード裁定）

- **A-17 [共通] move intent契約(確定)**: FEは抽象intent、BE serializerが整形。
  - 北固定(solid): `move{mode:"step", dir:"N|E|S|W"}` → `go N` 等。
  - turn(相対): `move{mode:"step", dir:"F|B"}` → `go`/`go b`、`move{mode:"strafe", dir:"L|R"}` → `go l`/`go r`。
  - 共通: `move{mode:"turn", dir:"l|r|b"}` → `turn l/r/b`。
  → **R4でBE serializerをこの契約に整合**(R1簡約版を置換)。[07]§5.2更新。
- **A-18 [共通] shortcut/magic送信**: F1-F7=`command{name:"castMagic", spell:<名>}`→`cast\n<名>`。F8-F12=`command{name:"raw", text:<語>}`→そのまま(rate-limited)。確定。
- **TODO(軽微, R4/R5)**: argon2-cffi導入(暫定PBKDF2 Q-14)、`pyproject` package-data に schema.sql(Q-15)、CSRFトークン/Origin検査(Q-16)。

### R4 由来（リード裁定）

- **A-19 [共通] eagleEyeのmapset**: `eagleEye` payloadに任意 `mapset?` を追加(別チップセット時)。無ければFEは現マップのmapset流用。[07]§6.11更新。
- **A-20 [BE] tools/gfx_convert ↔ app.gfx 重複(Q-R4-1)**: 当面 `app/gfx/transparency.py` を正とし `tools/convert.py` は別コピー継続(編集範囲外)。将来 tools を `app.gfx` 委譲へ。低優先OPEN。
- **A-21 [BE] SQLite並行(Q-R4-2)**: `check_same_thread=False`+短時間commitで単一プロセス想定は可。高並行はライター直列化/プール検討。[12]§7.1スケール課題に含む。
- **A-22 [FE] 通知の対象session(Q-R4-02)**: 当面全sessionで発火。非アクティブ抑止は仕様化保留。
- **A-23 [共通] `img=`タグ実形(Q-R4-03)**: `/*img=URL*/`想定で実装。**受信ログの観察(passive)で実形確認可**(送信なし=迷惑なし)。低優先OPEN。
- **A-24 [FE] view.set連動**: display.mapSize/mapStyle変更時に `view.set` 送信([07]§5.8)未配線→R5で追加。**完了**。

### R5 由来（リード裁定）

- **A-25 [共通] 登録uid供給元(Q-R5-1, [12]§2.4継続)**: 登録成功時サーバ`#ex-put UID <uid>`通知を捕捉する実装。通知なし時 uid=None→要手当。**実機での確認はユーザーが登録実施時に行う**(自動登録は迷惑/クラッタのため我々は実行しない)。OPEN(ユーザー側)。
- **A-26 [共通] 登録グラ一覧レスポンス形**: `{graphics: string[]}`(順序=image索引)。FEは配列直返しもフォールバック許容。確定。
- **A-27 [BE] reject fields語彙**: `["name","pass","image","mail"]`。FE表示マップ整合。確定。
- **TODO(残)**: command.raw監査ログ未実装(レート判定のみ)。本番CSRFは`PHI_ALLOWED_ORIGINS`設定必須。登録後自動ログインは任意(現状手動再ログイン案内)。

### R7 由来（リード裁定）

- **A-28 [共通] assets衝突回避**: Viteビルド資産は `dist/app/` に分離(`assetsDir:'app'`)。`/assets` はBE透過PNG専用([02]§7)。確定。
- **A-29 [BE] #ex-obj magnify キー = キャラ名(確定・修正済)**: 録画実データ `#ex-obj S 48 48 0 Remains guardian dragon`(末尾=表示名, gra名でない)+phi-client(`gra_magnify.get(chara.name)`)より、**magnifyは`#m57 O`の name 欄キー**が正。R7初版のgra名キーをリードが name キーへ修正(parser+test)。FEは `chars[].magnify` をそのまま使うため影響なし。command.raw監査ログ(A-30)実装済。

## 5. ステータスボード

| ラウンド | BE | FE | コミット |
|----------|----|----|----------|
| R0 | ✅ scaffold + B1 LineBuffer + B2 CodeConverter (40 tests, cov100%) | ✅ scaffold + 型 + F1 WSクライアント + F2 stores骨格 (23 tests) | R0コミット済 |
| R1 | ✅ B3 Parser + B4 Serializer + 合成フィクスチャ (101 tests) | ✅ 残stores+配線 + F3ログイン + F6ステータス + F7チャット(markup) (54 tests) | R1コミット済 |
| R2 | ✅ B5 LegacySocket + B6 SessionManager + B7 WsServer + 実機録画検証(121 tests) | ✅ F4マップ描画(Canvas) + F5グラ解決(110 tests) | R2コミット済 |
| R3 | ✅ B8 Store/SQLite + B12 認証(uid暗号/PBKDF2暫定) + priv修正(149 tests) | ✅ F8 キーハンドラ + F9 リスト/編集/タブUI(160 tests) | R3コミット済 |
| R4 | ✅ B9 gfx + B10 REST chara + B11 fallback + B13 世界移動 + move整合(185 tests) | ✅ F10 設定UI + F11 通知/SS/画像 + EagleEye(191 tests) | R4コミット済 |
| R5 | ✅ B14 レート制限 + B15 登録 + auth硬化(argon2/CSRF) + REST統合 + view.set(231 tests) | ✅ F12 登録フォーム + view.set連動 + 統合(210 tests) | R5コミット済 |
| R6 | ✅ app.main起動エントリ+config+REST統合(238 tests) | ✅ devプロキシ+wsUrl+Playwright E2E(217 tests+e2e 2) | R6コミット済 |
| R7 | ✅ #ex-obj magnify(name キー A-29)+command.raw監査ログ(246 tests) | ✅ 巨大magnify描画+水縁エフェクト(237 tests) | R7コミット済 |

## 6. コミットログ（リード記入）

- R0: BE/FE scaffold + 最初のTDDコンポーネント。契約決定(A-01〜A-05, A1〜A3)を[07]反映。
- R1: BE Parser/Serializer+合成フィクスチャ / FE 残stores+ログイン+ステータス+チャット。決定A-06〜A-12。
- R2: BE 接続/セッション/WS+実機録画検証 / FE マップ描画+グラ解決。priv契約修正(A-13)。
- R3: BE Store/認証+priv修正 / FE キーハンドラ+リスト/編集/タブ。A-17/18。
- R4: BE gfx/REST chara/世界移動/move整合 / FE 設定/通知/SS/画像/EagleEye。**他者迷惑送信ガード追加(§0)**。A-19〜A-24。
- R5: BE レート制限/登録/auth硬化/REST統合 / FE 登録フォーム/view.set。A-25〜A-27。登録は実サーバ未実行。
- R6: BE app.main起動エントリ+config / FE devプロキシ+Playwright E2E。ルートREADME+CI追加。A-28(assets衝突回避: FEビルドは`dist/app/`)。

## 6.5 コードレビュー是正(docs/14, CR-NN)

- **F1(済)**: 契約片側未配線・堅牢性を是正。
  - BE(279 tests): CR-1 settings.get/set配線(アカウント単位), CR-2 eagleEye構造化emit, CR-4 不正intentでクラッシュ回避(TypeError/Exception捕捉), CR-5 recv例外でclosed emit, CR-6 detachタイムアウト(300s), CR-7 task gather+detached emit, CR-20 map.request/ping-pong配線, CR-21 party=normal整形(A-14), 契約往復カバレッジテスト。
  - FE(262 tests): CR-3 notice/worldTransfer/非相関error配線+noticeStore+表示, CR-14 request timeout/全pending reject, CR-15 再接続UI(帯+手動再接続), CR-16 message.seq型, 再接続時の自動再auth+reattach, 契約往復カバレッジテスト。
  - **要確認(F2)**: 再アタッチ時BEが同一session id払出すか(FE前提)。CR-8〜13 security, CR-17 描画忠実度, CR-18 graceful shutdown, CR-19 WAL は F2。

## 6.6 コードレビュー是正 F2(セキュリティ+アーキ+描画忠実度)

- BE(310 tests): CR-8 CSRF fail-closed(本番), CR-9 一時鍵は開発のみ(本番起動失敗), CR-10 XFF信頼段数(PHI_TRUSTED_PROXY_HOPS)+レートバケットLRU/TTL GC, CR-11 login総当たりスロットル, CR-12 画像bomb寸法上限+chara GETレート, CR-13 register制御文字拒否, CR-18 graceful shutdownで全#x, CR-19 SQLite WAL, L-4 内部エラー非露出。新env: PHI_ENV/PHI_TRUSTED_PROXY_HOPS。
- FE(278 tests): CR-17a layer順ソート, CR-17b アイテム円クリップ, CR-17c 未知chip→スキップ, CR-17d center-cellハイライト, L2 EagleEye縮尺補正, L4 自己通知抑止。
- Docker: 本番モード既定(PHI_ENV=production)+XFF1段、`docker compose up`で起動・疎通200を実機確認。
- 残: WS経路のXFF信頼段数(現状peer host)、chara GETは認証でなくレートで対応(将来認証)。

## 6.7 認証モデル再設計: ID-only(A-31)

- **背景**: PHIはIDのみで識別、uid自体が資格情報(パス埋込)。別Webパスワードは二重で不要(ユーザー指摘)。
- **A-31 [確定] ID-only認証**: Webパスワード全廃。ログイン=PHI IDのみ。ID(=資格情報)は `saved_ids`(id_key=sha256/id_enc/label/is_admin)にPHI_SECRET_KEYで**暗号保存**(.phirc相当, 元要件「IDをsqlite保管」充足)。
  - REST `POST /api/auth/session {id}` → cookie発行+`{ok,isAdmin,label?}`。WS接続時cookie検証。
  - WS `saved.list`→`{items:[{ref,label,isAdmin}]}`(生ID非公開)。`session.open {id|ref}`→平文ID解決→**`#open <平文ID>`**(従来 `#open <char_id>` を修正)。
  - 管理者=`saved_ids.is_admin`(admin_cli grant/add)。chara変更系require_adminは新方式。
  - **重要修正**: `open_session` が `legacy_uid_enc` を使わず char_id 平文送出していた件を、平文ID(入力or ref復号)で `#open` するよう是正。
- 実装: BE(332 tests)/FE(290 tests)。docker実機で `POST /api/auth/session` 200+cookie確認。
- 残: `characters`(register/world-transfer)は別サブシステムとして存続(将来 saved_ids統合検討)。login_throttleはパス廃止で不要化(IPレート将来用に残置)。

## 6.8 接続先IP/ポート指定(A-32)

- ログインがIDのみで host/port を入れられなかった件を修正。
- **A-32 [確定] session.open に host/port**: `session.open {id?|ref?, host?, port?, remember?, label?}`。解決順: 明示→ref保存値→config既定(PHI_HOST/PORT)。port int検証(1-65535)。
- `saved_ids` に host/port 列追加(冪等ALTER)。`saved.list` items に host/port(ピッカー初期値)。`admin_cli add --host --port`。
- FE Login に **サーバIP/ポート入力欄**追加。新規=id+host+port、保存選択=ref+保存host/port初期化。
- BE 341 / FE 292 tests緑。実接続検証はユーザー(§0)。

## 6.9 重大バグ修正: WS接続が常に失敗(「応答せず」)

- **症状**: ログインしても応答せず。WSハンドシェイクが拒否(uvicorn 403 / close 1008)。
- **根本原因**: `ws_server.py` の WS ルート `async def ws_endpoint(websocket: WebSocket)` で、`from __future__ import annotations` により注釈が文字列化。`WebSocket` が**関数ローカルimport**でモジュール未公開のため FastAPI の `get_type_hints` が解決できず、`websocket` を**クエリパラメータ扱い**→必須欠落で全WSを 1008 クローズ。Request/Response は F2 で module-level 化済みだが **WebSocket だけ漏れていた**。
- **検出漏れ理由**: ユニットテスト(341)は Fake ws で `WsConnection.run` を直接呼び、**実ASGIルートのDI解決を迂回**していた(契約往復の盲点)。
- **修正**: `WebSocket` を module-level import に。回帰テスト `test_ws_route_handshake_real_asgi`(TestClient.websocket_connect で hello 受信)追加。
- **検証**: 実サーバ経由フルパス成功 → session.open→connection→snapshot→notice→message(74)→map(2)→status→cond。CSRFミドルウェアも BaseHTTPMiddleware→純ASGIに置換(WS素通し)。
- 342 tests緑。

## 7. 総括サマリ（起床時用）

**到達状態(R0→R6)**: BE/FEのコア機能をTDDで実装・全緑(**BE 238 / FE 217 / E2E 2**)。`uvicorn app.main:app`+`npm run dev`で起動可能な構成。設計[02-13]・契約[07]に整合。

**実装済み**:
- BE: LineBuffer/CodeConverter/ProtocolParser/CommandSerializer、LegacySocket、SessionManager(snapshot/reattach/seq/keepalive)、WsServer(エンベロープ/認証/レート制限)、Store/SQLite(全スキーマ+Index)、認証(argon2id+uid暗号+webセッション+CSRF)、世界移動(#ch-srv 300s+last_server)、gfx透過変換、REST(chara graphics/index/manifest, register, auth, healthz)、view.set、app.main+config。
- FE: 型(契約)、WSクライアント(再接続/snapshot)、stores(11分割)、ログイン/キャラ選択、ステータス/cond、マップ描画(Canvas,chip/chara/items)、グラ解決(fallback)、チャット(カラーマークアップ/送信種別)、キーハンドラ、リスト/編集/タブUI、設定UI、通知/SS/画像、EagleEye、登録フォーム、devプロキシ、Playwright。

**残TODO / 要ユーザー確認(迷惑回避で我々が実機検証しない)**:
- A-14 大声/パーティ送信仕様、A-25 登録uid供給元(#ex-put UID?)、A-23 `img=`実形 → **ユーザーが実機(登録/発言)で確認**。
- A-15 `#m57 W`(2スロット)実形未検証(出現せず)。
- 低優先: 水縁/巨大magnify描画(FE-Q15)、command.raw監査ログ、tools/convert.pyのapp.gfx委譲(A-20)、本番デプロイ(reverse proxy/systemd)。

**契約の単一情報源**: [07](07-ws-protocol.md) + 本DEVLOG §4(A-NN決定)。
