# phi-client-web ドキュメント

レガシーSJISソケットゲームのWebクライアント化プロジェクト資料。

> 番号(NN)は作成順の**安定ID**。本文・コードコメントの `[NN]§…` 参照が依存するため
> 振り直さない。本索引はカテゴリ別に並べ替えて提示する(ファイル名は不変)。

### 調査・背景
プロジェクト発足時の調査と検証。

| 資料 | 内容 |
|------|------|
| [01-legacy-investigation.md](01-legacy-investigation.md) | `legacy/` 調査資料。プロトコル仕様・構成・文字コード |
| [03-phase0-connection-test.md](03-phase0-connection-test.md) | 実サーバ疎通検証レポート。設計仮説の実証・未確認事項の解明 |
| [04-feature-gap-analysis.md](04-feature-gap-analysis.md) | レガシーClient vs Pythonクライアントの機能ギャップ。不足機能洗い出し |

### 設計
アーキテクチャ・責務分担・各サブシステム設計。

| 資料 | 内容 |
|------|------|
| [02-architecture-design.md](02-architecture-design.md) | Webクライアント設計。バックエンド常時接続ゲートウェイ + UTF-8フロント |
| [05-feature-responsibility-design.md](05-feature-responsibility-design.md) | 不足機能のBE/FE責務分担設計。WS API契約 |
| [06-graphics-transparency.md](06-graphics-transparency.md) | グラフィック透過方式(3種)と透過PNG変換ツール |
| [09-chara-fallback-mapping.md](09-chara-fallback-mapping.md) | キャラグラ フォールバック(タイプコード human/beast/berserk/eraser等)。正規マッピング |
| [12-detailed-design.md](12-detailed-design.md) | 詳細設計。認証/トークン・新規登録(#ex-register)・設定スキーマ・レート制限・FE状態・再接続・デプロイ |

### プロトコル・API リファレンス
BE↔FE の通信契約(別クライアント実装の起点)。

| 資料 | 内容 |
|------|------|
| [07-ws-protocol.md](07-ws-protocol.md) | BE⇔FE WebSocket通信プロトコル仕様(v1)。メッセージ catalog・レガシー対応表 |
| [08-chara-graphics-storage.md](08-chara-graphics-storage.md) | キャラBMPアップロード→透過PNG保管・Index.txt(SQLite)保管 設計。REST API |
| [15-rest-api.md](15-rest-api.md) | REST API リファレンス(as-built)。全エンドポイントの認可/契約。WSは07参照 |

### 実装・検証
網羅性・テスト・着手判定・レビュー。

| 資料 | 内容 |
|------|------|
| [10-component-completeness.md](10-component-completeness.md) | BE/FEコンポーネント網羅性チェック。不足・未確定の洗い出し |
| [11-test-design.md](11-test-design.md) | TDDテスト設計。テストピラミッド・ケース・実装順序 |
| [13-implementation-readiness.md](13-implementation-readiness.md) | 実装着手可能性チェックリスト。コンポーネント別判定 |
| [14-code-review.md](14-code-review.md) | 全体コードレビュー結果(CR-1〜21)。片側未配線・fail-open等の指摘 |

### 運用・記録
運用マニュアルと開発記録。

| 資料 | 内容 |
|------|------|
| [admin-manual.md](admin-manual.md) | 管理者マニュアル。アセットアップロード/キャラ紐付け/ユーザ管理の手順・禁止画像 |
| [DEVLOG.md](DEVLOG.md) | BE/FE 並行開発の調整メモ・決定履歴(A-NN) |

マッピング: `backend/data/chara_type_fallback.json`（キャラタイプコード正規対応）。

変換ツール: `tools/gfx_convert/`（レガシーBMP → 透過PNG）。

検証スクリプト: `backend/test_connect.py`（実サーバ接続テスト）。
参考実装: `~/workspace/phi-client`（Python/PySide6, 動作実績ありのクライアント）。

## 概要
- バックエンドがレガシーサーバへSJ​IS TCP接続を常時保持（タイムアウトあり）。
- ブラウザはバックエンドへWebSocket接続し、UTF-8 JSONで操作。
- ID/認証/セッションはSQLite管理。
