# BE/FE コンポーネント網羅性チェック

実装着手前に、設計済み([02]〜[09])のコンポーネントを棚卸しし、**不足・未確定**を洗い出す。凡例: ✅設計済 / 🔶部分(要詳細化) / ❌未設計。

## 1. バックエンド(Python/FastAPI)

| コンポーネント | 状態 | 参照 | 補足/不足 |
|----------------|------|------|-----------|
| LegacySocket(TCP・行分割・再接続・タイムアウト) | ✅ | [02]§3.2,[03]§5 | phi-client `connection.py`/`line_buffer.py` 移植 |
| CodeConverter(SJIS⇔UTF-8・行種別分岐) | ✅ | [02]§3.3,[03]§4.1 | バイナリ行(map chip)除外ルール確定済 |
| ProtocolParser(レガシー行→イベント) | ✅ | [07]§7,[03]§5 | phi-client `parser.py`/`map_data.py` 移植 |
| CommandSerializer(intent→レガシー行) | ✅ | [07]§5,§7 | chat種別(`*`/`/**/`/priv)・move・pay・cast・list・edit |
| SessionManager(多重化・detach/reattach・snapshot) | ✅ | [07]§4 | キャラ=1ソケット、複数セッション |
| WsServer(エンベロープ・UTF-8 JSON) | ✅ | [07] | v1仕様確定 |
| Keepalive/lag(`#lag`→`#end-lag`・`#code-sjis`) | ✅ | [07]§4.3 | BE内部処理・FE非露出 |
| 世界移動(`#ch-srv` 300s・last_server永続化) | ✅ | [05]§8,[09] | phi-client `_handle_ch_srv` ベース＋永続化追加 |
| Store/SQLite(accounts/characters/sessions/settings/chara_*) | ✅ | [02]§6,[08]§4 | スキーマ確定 |
| 透過変換gfx(colorkey/chip/mask-v) | ✅ | [06],[08]§5 | tools/gfx_convert と共有モジュール化 |
| REST: chara graphics/index/manifest | ✅ | [08]§7 | アップロード・配信・Index取込/生成 |
| キャラグラ フォールバック解決(type→key→グラ) | ✅ | [09] | chara_type_fallback.json |
| 認証・セッショントークン機構 | ✅ | [07]§4.1,[12]§1 | A-33確定・実装済: Bearer token(localStorage)、WS first message `auth{token}`で再接続継続。argon2id |
| **レート制限(`command.raw`等)** | 🔶 | [07]§10 | コードはあるが**閾値・単位・超過時挙動が未定義** |
| **設定(settings)スコープ定義** | 🔶 | [05]§6,[07]§5.7 | keybind/notify等の**値スキーマ未確定** |
| **新規キャラ作成プロトコル** | ❌ | [05]§14,[08]§14 | **レガシー登録プロトコル未調査**(要フェーズ調査) |
| **デプロイ/運用(TLS終端・静的配信・プロセスモデル・ログ)** | ❌ | — | 未設計。wss前提だが構成未定 |
| **ヘルスチェック/監視/メトリクス** | ❌ | — | 未設計(優先度低) |

## 2. フロントエンド(React/TS/Vite)

| コンポーネント | 状態 | 参照 | 補足/不足 |
|----------------|------|------|-----------|
| WSクライアント(エンベロープ・再接続・snapshot適用) | 🔶 | [07]§2,§4 | プロトコルは確定。**再接続バックオフ・snapshot適用順序の詳細未定** |
| ログイン+キャラ選択UI | ✅ | [02]§4.2,[07]§4.1 | |
| マップ描画(Canvas: chip/chara/items, 5x5/7x7) | ✅ | [02]§4,[06] | phi-client `map_widget.py` 同等 |
| キャラグラ解決(type→manifest→fallback→placeholder) | ✅ | [08]§9,[09]§3 | case-insensitive |
| ステータス/状態異常表示(近代UI新規) | ✅ | [02]§4.0 | スキン不使用・CSS実装 |
| チャット/ログ(送信種別UI・color markup描画) | ✅ | [05]§1,[07]§5.3 | `color_markup.py` 移植 |
| 入力/キーハンドラ(移動・アクション・リスト選択) | ✅ | [05]§2,[07]§5 | phi-client `key_handler.py` 参考 |
| リストモードUI | ✅ | [07]§5.5,§6.7 | |
| 編集ダイアログ(single/multi: s-edit/m-edit) | ✅ | [07]§5.6,§6.8 | |
| ユーザ一覧/privウィンドウ | ✅ | [07]§6.6,§5.3 | |
| タブ(複数キャラ session) | ✅ | [07]§9 | |
| 設定UI(keybind/notify) | 🔶 | [05]§6,[07]§5.7 | **設定スキーマ確定待ち(BEと共通)** |
| 通知(ブラウザNotification・タイトル点滅) | ✅ | [05]§10 | FE主担当 |
| スクリーンショット | ✅ | [05]§12 | canvas.toBlob |
| 画像表示(`img=`タグ) | ✅ | [05]§13 | サニタイズ要 |
| 世界移動インジケータ | ✅ | [07]§6.10 | |
| **状態管理設計(stores構成)** | 🔶 | [02]§4.1 | Zustand採用だが**store分割(session/map/chat/status)の設計未定** |
| **アセット プリロード/キャッシュ戦略** | 🔶 | [08]§7.3 | manifest取得は設計済、**プリロード方針未定** |

## 3. プロトコル/データ整合の小不足

- [07]§6.2 `map.chars[]` に **`default`(typeコード)フィールド追記漏れ** → [09]で追加した。[07]本体を更新要(下記で対応)。
- `#ex-disp-magic`(魔法表示)のFE描画範囲が不明([04] 要確認のまま)。
- m-edit/s-edit の文字コード(UTF-8入力→cp932送信)境界はBE責務で確定済だが、**入力中の文字数制限(レガシー上限)**未確認。

## 4. 横断的な未確定(要決定)

| 項目 | 影響 | 推奨アクション |
|------|------|----------------|
| 認証トークン方式 | BE/FE両方 | ✅解決(A-33): Bearer token(サーバ保持 `sessions_web`)+localStorage。WS first message `auth{token}` |
| 設定(settings)値スキーマ | BE/FE両方 | ✅解決: `app/settings_schema.py` で scope別 value 検証(既知キー型/未知キー許容/サイズ上限) |
| 新規キャラ作成プロトコル | BE | レガシー`#ex-register`等を実サーバ/ソースで追加調査([08]§14) |
| デプロイ構成 | 運用 | リバースプロキシ(TLS/wss・静的assets)・プロセス管理を別途設計 |
| FE状態管理store構成 | FE | session/map/status/chat/list/ui の分割を定義 |

## 5. 結論

- **コア(接続・変換・プロトコル・セッション・マップ・チャット・グラ・世界移動)は設計充足**。phi-client移植で実装可能。
- **要詳細化(🔶)**: 認証トークン、設定スキーマ、レート制限、FE状態管理、再接続詳細。
- **未設計(❌)**: 新規キャラ作成プロトコル(要調査)、デプロイ/運用、監視。
- これらをTDDの対象範囲([11])に織り込み、🔶は実装前に最小限の詳細化を行う。
