# phi-web ドキュメント

レガシーSJISソケットゲームのWebクライアント化プロジェクト資料。

| 資料 | 内容 |
|------|------|
| [01-legacy-investigation.md](01-legacy-investigation.md) | `legacy/` 調査資料。プロトコル仕様・構成・文字コード |
| [02-architecture-design.md](02-architecture-design.md) | Webクライアント設計。バックエンド常時接続ゲートウェイ + UTF-8フロント |
| [03-phase0-connection-test.md](03-phase0-connection-test.md) | 実サーバ疎通検証レポート。設計仮説の実証・未確認事項の解明 |
| [04-feature-gap-analysis.md](04-feature-gap-analysis.md) | レガシーClient vs Pythonクライアントの機能ギャップ。不足機能洗い出し |
| [05-feature-responsibility-design.md](05-feature-responsibility-design.md) | 不足機能のBE/FE責務分担設計。WS API契約 |
| [06-graphics-transparency.md](06-graphics-transparency.md) | グラフィック透過方式(3種)と透過PNG変換ツール |
| [07-ws-protocol.md](07-ws-protocol.md) | BE⇔FE WebSocket通信プロトコル仕様(v1)。メッセージ catalog・レガシー対応表 |

変換ツール: `tools/gfx_convert/`（レガシーBMP → 透過PNG）。

検証スクリプト: `backend/test_connect.py`（実サーバ接続テスト）。
参考実装: `~/workspace/phi-client`（Python/PySide6, 動作実績ありのクライアント）。

## 概要
- バックエンドがレガシーサーバへSJ​IS TCP接続を常時保持（タイムアウトあり）。
- ブラウザはバックエンドへWebSocket接続し、UTF-8 JSONで操作。
- ID/認証/セッションはSQLite管理。
