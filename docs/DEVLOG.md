# DEVLOG — BE/FE 並行開発 調整メモ

BE(バックエンド)・FE(フロントエンド)を並行スレッドで開発する際の**整合・調整の単一情報源**。各スレッドは着手前に本ファイルを読み、進捗・疑問・決定を追記。統合役(リード)がラウンドごとに同期・コミット。

## 0. 運用ルール

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

## 5. ステータスボード

| ラウンド | BE | FE | コミット |
|----------|----|----|----------|
| R0 | ✅ scaffold + B1 LineBuffer + B2 CodeConverter (40 tests, cov100%) | ✅ scaffold + 型 + F1 WSクライアント + F2 stores骨格 (23 tests) | R0コミット済 |
| R1 | B3 ProtocolParser + B4 CommandSerializer + 合成フィクスチャ | 残stores配線 + F3ログイン + F6ステータス + F7チャット(markup) | — |

## 6. コミットログ（リード記入）

- R0: BE/FE scaffold + 最初のTDDコンポーネント。契約決定(A-01〜A-05, A1〜A3)を[07]反映。
