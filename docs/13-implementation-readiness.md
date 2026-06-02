# 実装着手可能性チェックリスト

各コンポーネントが「テスト→実装」を開始できる状態か判定。判定: ✅着手可 / ⚠️条件付き / ⛔要解決。
根拠: 設計([02]〜[12])・移植元(phi-client)・テスト設計([11])。

## 1. バックエンド

| # | コンポーネント | 判定 | 移植元/根拠 | 着手前提 |
|---|----------------|------|-------------|----------|
| B1 | LineBuffer | ✅ | phi-client `line_buffer.py` | テスト([11]§5.1)→実装。即着手可 |
| B2 | CodeConverter | ✅ | [02]§3.3, phi-client | 行種別分岐ルール確定。即着手可 |
| B3 | ProtocolParser | ✅ | phi-client `parser.py`/`map_data.py`, [07]§7 | フィクスチャ([11]§4)準備後。即着手可 |
| B4 | CommandSerializer | ✅ | [07]§5,§7 | intent→文字列表確定。即着手可 |
| B5 | LegacySocket | ✅ | phi-client `connection.py`, [12]§7 | モックTCP([11]§6.1)。実接続は環境変数 |
| B6 | SessionManager | ✅ | [07]§4, [12]§6 | snapshot/reattach確定。即着手可 |
| B7 | WsServer/エンベロープ | ✅ | [07] | v1仕様確定。即着手可 |
| B8 | Store/SQLite | ✅ | [02]§6,[08]§4,[12]§1.4 | スキーマ確定(legacy_uid_enc含む)。即着手可 |
| B9 | gfx透過変換(共有module) | ✅ | [06], tools/gfx_convert | 実装済ロジックをmodule化するだけ |
| B10 | REST chara(graphics/index/manifest) | ✅ | [08]§7 | 即着手可 |
| B11 | フォールバック解決 | ✅ | [09], chara_type_fallback.json | 即着手可 |
| B12 | 認証/トークン/uid暗号 | ✅ | [12]§1 | 実装済(A-33: Bearer token/localStorage, uid Fernet AEAD) |
| B13 | 世界移動(#ch-srv) | ✅ | [05]§8, phi-client `_handle_ch_srv` | 300s/last_server確定 |
| B14 | レート制限 | ✅ | [12]§4 | 閾値確定。即着手可 |
| B15 | 新規キャラ登録(#ex-register) | ⚠️ | [12]§2 | プロトコル判明。**uid の addw/s_id 供給元のみ実機確認要**([12]§2.4)。登録以外は着手可、登録は確認後 |

## 2. フロントエンド

| # | コンポーネント | 判定 | 根拠 | 着手前提 |
|---|----------------|------|------|----------|
| F1 | WSクライアント(エンベロープ/再接続/snapshot) | ✅ | [07],[12]§6 | 即着手可 |
| F2 | 状態管理stores | ✅ | [12]§5 | store分割確定。即着手可 |
| F3 | ログイン+キャラ選択 | ✅ | [07]§4.1,[12]§1 | 即着手可 |
| F4 | マップ描画(Canvas) | ✅ | phi-client `map_widget.py`,[06] | 透過PNGアセット準備後 |
| F5 | キャラグラ解決(fallback/manifest) | ✅ | [08]§9,[09] | 即着手可 |
| F6 | ステータス/cond表示 | ✅ | [02]§4.0(新規UI) | 即着手可 |
| F7 | チャット/ログ(送信種別/markup) | ✅ | [05]§1, phi-client `color_markup.py` | 即着手可 |
| F8 | 入力/キーハンドラ | ✅ | phi-client `key_handler.py`,[12]§3.1 | keybind schema確定 |
| F9 | リスト/編集/priv/タブ UI | ✅ | [07]§5-6 | 即着手可 |
| F10 | 設定UI | ✅ | [12]§3 | schema確定。即着手可 |
| F11 | 通知/SS/画像表示 | ✅ | [05]§10-13 | 即着手可 |
| F12 | 新規キャラ作成フォーム | ⚠️ | [12]§2.3 | REST `/api/register` 依存(B15と同条件) |

## 3. テスト基盤（[11]）

| # | 項目 | 判定 | 備考 |
|---|------|------|------|
| T1 | pytest + fixtures(録画→合成/期待JSON) | ⚠️ | **録画＋サニタイズが未実施**。録画は `fixtures/recorded/`(**gitignore**)、CI用はサニタイズ済 `fixtures/synthetic/`([11]§4)。録画後✅ |
| T2 | モックTCP/WS サーバ | ✅ | フィクスチャ再生。実装可 |
| T3 | Vitest + RTL | ✅ | 即構築可 |
| T4 | Playwright E2E | ✅ | モックBE前提 |
| T5 | CI(GitHub Actions, カバレッジ閾値) | ✅ | 即構築可 |
| T6 | phi-client テスト移植 | ✅ | tests/ 多数を移植([11]§1) |

## 4. 横断・前提

| 項目 | 状態 | 備考 |
|------|------|------|
| BEスタック(Python/FastAPI) | ✅確定 | [02]§3.1 |
| FEスタック(React/TS/Vite) | ✅確定 | [02]§4.1 |
| WSプロトコル v1 | ✅確定 | [07] |
| SQLiteスキーマ | ✅確定 | [02]§6,[08]§4,[12]§1.4 |
| 透過アセット生成 | ✅ | tools/gfx_convert で変換した透過PNGを `assets/`(chara/chip/items)に初期同梱。フォールバック6種([09])含む |
| 接続先設定 | ✅ | 環境変数で供給。CI/開発はモック |
| ディレクトリscaffold | ⛔未作成 | `backend/`(app/tests/pyproject) `frontend/` の雛形が未生成 |

## 5. 着手可否の結論

**大半(B1-B14, F1-F11, T2-T6)は即着手可**。コア(接続/変換/プロトコル/セッション/マップ/チャット/認証)は設計充足、phi-client移植で実装できる。

### 着手前に片付ける軽作業(ブロッカー小)
1. **scaffold生成**: `backend/`(pyproject, app/, tests/, conftest) と `frontend/`(Vite+TS+Vitest) の雛形。
2. **フィクスチャ録画(T1)**: `test_connect.py --record` 実装 → 録画は `backend/tests/fixtures/recorded/`(**.gitignore済**, 実名/IP/uid含む・非コミット)。サニタイズ→ `fixtures/synthetic/`(コミット, CI用)([11]§4)。
3. **透過アセット バッチ変換**: tools/gfx_convert で chip/chara/items + フォールバック6種を `assets/` へ。

### 確認後に着手(⚠️)
4. **新規登録(B15/F12)**: uid の addw/s_id 供給元を実機確認([12]§2.4)。それ以外は並行着手可。

### 推奨着手順([11]§8準拠)
B1→B2→B3(要T1)→B4→B5(要T2)→B6→B7→B8→B9/B11→B10→B12→B13 / 並行でFE F1→F2→各UI→E2E。

## 6. 残リスク
- 録画フィクスチャは `fixtures/recorded/` を gitignore、CI用は `synthetic/`(合成)のみコミット([11]§4)。
- 単一プロセス制約([12]§7.1)→ 同時接続多数時のスケールは将来課題。
- 登録 uid 規則の実機差異([12]§2.4)。
