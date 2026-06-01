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

- (まだなし)

## 5. ステータスボード

| ラウンド | BE | FE | コミット |
|----------|----|----|----------|
| R0 | scaffold + B1/B2 着手 | scaffold + F1/F2 着手 | — |

## 6. コミットログ（リード記入）

- (これから)
