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
- **A-24 [FE] view.set連動**: display.mapSize/mapStyle変更時に `view.set` 送信([07]§5.8)未配線→R5で追加。

## 5. ステータスボード

| ラウンド | BE | FE | コミット |
|----------|----|----|----------|
| R0 | ✅ scaffold + B1 LineBuffer + B2 CodeConverter (40 tests, cov100%) | ✅ scaffold + 型 + F1 WSクライアント + F2 stores骨格 (23 tests) | R0コミット済 |
| R1 | ✅ B3 Parser + B4 Serializer + 合成フィクスチャ (101 tests) | ✅ 残stores+配線 + F3ログイン + F6ステータス + F7チャット(markup) (54 tests) | R1コミット済 |
| R2 | ✅ B5 LegacySocket + B6 SessionManager + B7 WsServer + 実機録画検証(121 tests) | ✅ F4マップ描画(Canvas) + F5グラ解決(110 tests) | R2コミット済 |
| R3 | ✅ B8 Store/SQLite + B12 認証(uid暗号/PBKDF2暫定) + priv修正(149 tests) | ✅ F8 キーハンドラ + F9 リスト/編集/タブUI(160 tests) | R3コミット済 |
| R4 | ✅ B9 gfx + B10 REST chara + B11 fallback + B13 世界移動 + move整合(185 tests) | ✅ F10 設定UI + F11 通知/SS/画像 + EagleEye(191 tests) | R4コミット済 |
| R5 | B14 レート制限 + B15 登録(#ex-register) + auth硬化(argon2/CSRF) + REST統合 + view.set | F12 登録フォーム + view.set連動 + 統合磨き | — |

## 6. コミットログ（リード記入）

- R0: BE/FE scaffold + 最初のTDDコンポーネント。契約決定(A-01〜A-05, A1〜A3)を[07]反映。
