# コードレビュー結果（全体）

4観点の並行レビュー(BE論理/BEセキュリティ/FE/設計整合)を統合。重大度順。テストは全緑(BE246/FE237)だが、**契約[07]の各メッセージにBE emit↔FE consumeの往復テストが無い**ため、片側未配線が緑をすり抜けている(本レビュー最大の発見)。

## 最優先(動作不能・誇張是正)

- **CR-1 settings.get/set がBE未実装 → 設定機能が全断** [High]
  FEはSettings起動時に`getSettings`を送るが、BE `_dispatch`(`ws_server.py`)に`settings.*`分岐なし→serializerが`ValueError`→FEで例外。SQLite `settings`テーブルはあるがWS未配線。scope↔key対応も未設計。
- **CR-2 eagleEye がBE未配線(実質デッド)** [High]
  parserは`#ex-eagleeye`増分を`_internal`で捨てる(session.py)。契約形`{width,height,self,cells}`の構造化が未実装→FE `EagleEyeView`へデータが来ない。DEVLOG「EagleEye✅」は誇張。
- **CR-3 notice/worldTransfer/非相関error がFE未配線** [High]
  BEはemitするがcontrollerに`on('notice'/'worldTransfer'/'error')`なし。世界名/エリア表示先なし、世界移動の進行表示なし、レガシー切断エラーがUIに出ない。`applySnapshot`も`notice`未適用(再アタッチで世界名復元不可)。

## バックエンド 堅牢性

- **CR-4 不正intentでWS接続全体がクラッシュ** [High] `ws_server.py`/`serializer.py`
  `_handle_intent`は`ValueError/KeyError`のみcatch。`list.select`の`value`欠落で`int(None)`→`TypeError`が`run()`まで伝播し**多重化した全セッションごと切断**。要: `TypeError`+最終`Exception`捕捉(INTERNAL返却)。
- **CR-5 recvループが例外を握らずセッション無言死** [High] `session.py`
  `#lag`応答等の`send_line`が切断時に例外→recv_task未回収例外で死亡、`connection:closed`をFEへ出さない。要: `_recv_loop`をtry/exceptで包みclosed emit。
- **CR-6 detachタイムアウト未実装 → 接続/タスクリーク** [High] `session.py`
  `DETACH_TIMEOUT_SEC=300`定義・契約明記だが、`detach()`は`on_event=None`にするだけでタイマ無し。離脱セッションのsocket/recv/keepaliveが無期限残存。
- **CR-7 close_sessionがキャンセルタスクをawaitしない** [Med] / **connection state="detached"を一度もemitしない** [Med]

## セキュリティ(fail-open/バイパス)

- **CR-8 CSRF: PHI_ALLOWED_ORIGINS未設定で全変更系素通り(fail-open)** [High] `csrf.py`/`main.py`
  未設定→`allowed=None`→無条件許可。本番設定忘れで防御無効。要: 本番は未設定を起動失敗 or fail-closed。
- **CR-9 一時鍵フォールバックでuid暗号が静かに無効化** [High] `config.py`
  `PHI_SECRET_KEY`未設定で揮発鍵生成・起動成功→再起動で全uid復号不能。要: 本番で一時鍵禁止・起動失敗。
- **CR-10 registerレート制限キーがXFF詐称でバイパス可+メモリ無制限増殖** [High] `rest/register.py`/`ratelimit.py`
  `X-Forwarded-For`先頭を無条件信用→ヘッダ詐称で5/h/IP回避。バケットにTTL/上限なし→IP変えるだけでメモリ枯渇(DoS)。要: 信頼プロキシ前提の固定段数 or peer IP、バケットGC。
- **CR-11 login(総当たり)にレート制限なし** [High] `ws_server.py`
  argon2は遅いがオンライン総当たり抑止なし。要: account+IPで失敗スロットル。
- **CR-12 chara GET系(manifest/list/png)が無認証・無レート + 巨大画像でCPU/メモリDoS** [Med]
  `get_graphic_png`は毎回フル`read_bytes`。gfx変換は純Python全画素ループ+`Image.MAX_IMAGE_PIXELS`/寸法上限なし(decompression bomb)。
- **CR-13 register: name/passの改行・制御文字未検査(プロトコル行注入)** [Med] `register.py`

## フロントエンド 堅牢性

- **CR-14 request()がタイムアウト/切断で永久pending** [High] `ws/client.ts`
  応答なし/切断時にreject無し→`auth`等のPromiseが永久未解決、Login busy固着。要: timeout + onclose全reject。
- **CR-15 再接続中UIが皆無** [High] `connectionStore`/`App.tsx`
  `socketState`を読むUIなし、`reconnectNow`未使用。[12]§6再接続UX未達。
- **CR-16 message.seq が型欠落で重複抑止が型上dead** [Med] `types/protocol.ts`
  契約はseq必須相当だが`MessageEvent`にseqなし→交差型で継ぎ足し、`isDuplicate`のseq分岐が実質dead。要: `seq?:number`正式追加。
- **CR-17 描画忠実度差** [Low群]: layer無視(x順のみ)、アイテム円クリップ未移植、未知chip index→0誤描画、`gigant='*'`単独で拡大しない、center-cellハイライト省略。

## アーキ/運用

- **CR-18 状態揮発性: プロセス再起動でゲームセッション全消失** [Med] 
  session/socket/snapshotが全てメモリ。`sessions`テーブルは定義のみで死蔵(実装と乖離)。要: graceful shutdownで全`#x`+detach、または`sessions`を使うか削除。
- **CR-19 SQLite WAL未設定(docs記載と乖離)** [Med] `store/db.py` — `PRAGMA journal_mode=WAL`追加(1行)。
- **CR-20 map.request/ping/pong が両側未配線(設計倒れ)** [Med] — 不要なら契約から削除。
- **CR-21 party送信: 実装(`%`付与)とDEVLOG A-14決定(normal整形)が矛盾** [Low] — 実装か決定を揃える。

## 良い点
- SQL全面パラメタ化(注入なし)、stored_name=sha256でパストラバーサル回避、uid Fernet暗号+改ざん検知、argon2id+PBKDF2透過移行、256bitセッション+idle/absolute期限+httponly/secure/strict cookie、監査ログのuid/password除外。
- FE: 層分離+純関数でテスタブル、discriminated union型安全dispatch、再接続バックオフ正確、img=サニタイズ+非dangerouslySetInnerHTML、入力フォーカス時キー無効化。
- 移植忠実度(LineBuffer簡約の正当性、map frame確定、水縁/magnify数値一致)が高い。

## 是正方針(推奨順)
1. **契約往復テストを追加**(各メッセージのBE emit↔FE consume) → 片側未配線(CR-1/2/3/20)を機械的に検出。
2. CR-1 settings配線(BE `_dispatch`+scope/key設計)。CR-2 eagleEye構造化。CR-3 FE notice/worldTransfer/error配線。
3. BE堅牢性 CR-4/5/6(クラッシュ/無言死/リーク)。
4. セキュリティ CR-8〜11(fail-open/総当たり/XFF)。
5. FE CR-14/15/16。アーキ CR-18/19。
6. DEVLOG総括の完成度記述を是正(周辺機能は片側未配線=未完と明記)。
