# 現行Webクライアントの不足機能（2026-10-25 時点）

[04](04-feature-gap-analysis.md) はレガシーClientとPython版の差分で、Web版の実装前に作った。
本書は実装済みのWeb版を、次の3つと突き合わせた結果をまとめる。

- 旧Windowsクライアント Philly のソース（PhillySrc。リポジトリ外）
- 本番（朱蓮）が使う v5y サーバのソース（`s7k/upd-phi-server-v5y`）
- v6 プロトコルを持つ fix-phidm サーバのソース

凡例: BE=バックエンド(`backend/`)、FE=フロントエンド(`frontend/src/`)。
Philly の根拠は PhillySrc の `Philly/` からの相対パス。

## 1. Philly にあって Web版に無かった機能

2026-10-25 に、ブラウザで使えるか・使う価値があるかで仕分け、使えるものを実装した。

### 1.1 実装したもの

| 機能 | Web版の操作 | Philly の動作 | 実装 |
|------|-------------|---------------|------|
| パーティー発言 | パーティーボタン、またはチャット欄で Ctrl+Enter。先頭に `+` を付けて送る | Ctrl+Enter で先頭に `+`（`MainForm.cpp:1075`）。v5y も `+` をパーティー発言と読む（`phi_dm.c:4306`） | `serializer.py`、`Chat.tsx` |
| 通常発言の誤変換防止 | 先頭が `*`（大声）・`+`（パーティー）・`&`（エリア）の通常発言に `/**/` を前置 | `LoudlyByAsterisk` で `*` だけ前置（`MainForm.cpp:1066-1074`） | `serializer.py` |
| 入力履歴 | チャット欄で ↑↓（50件） | 送った行が入力欄に残り、↑↓で戻って再送（`MainForm.cpp:970-981`） | `Chat.tsx` |
| pay（支払い） | P キーで金額を入力 | P キーで金額ダイアログ（`Command.cpp:1154`） | `keyHandler.ts`、`PromptDialog.tsx` |
| マップのマウス操作 | クリックした方向へ1歩、右クリックで攻撃 | 左クリックで移動、右クリックで `hit`（`MapForm.cpp:491-633`） | `MapView.tsx` |
| リストの複数選択 | 行のチェックで選び、「選んだ N 件を送る」で番号を空白区切りで送る | チェックした番号を空白区切りで送る（`MainForm.cpp:653-764`） | `ListView.tsx` |
| ログ保存 | 上部バーのボタンで表示中のログをテキスト保存（マークアップは除く） | バッファの HTML 保存（`CharacterCommon.cpp:668`） | `lib/logExport.ts` |
| 裏タブの緊急表示 | 裏のタブで HP か MP が減るとタブが赤く点滅し、開くと消える | 緊急アイコンとフラッシュ（`CharacterCommon.cpp:370`） | `controller.ts`、`TabBar.tsx` |
| `#ex-chr-conflict` | 「3重状態で消えています。移動してください」を表示 | 同じ文言をログとステータスバーに出す（`PersonalThread.cpp:1353`） | `parser.py` |

`#more` 送信は元から不足していなかった。
Philly はリストの9番目を「more」として番号 `9` を送るだけで、Web版もリスト中の `9` キーで同じ `9` を送る。

### 1.2 見送ったもの

| 機能 | Philly の動作 | 見送った理由 |
|------|---------------|--------------|
| Alt 系の魔法ショートカット | Alt+英字で `cast\n<魔法名>`（`Command.cpp:614-655`） | Alt+英字はブラウザのメニューと衝突する。Shift+数字の枠へ `cast\n<魔法名>` を割り当てれば同じ事が出来る |
| Call / Return の確認 | 唱える前に確認（`Command.cpp:1243, 1259`） | Alt 系の魔法を見送った為、確認を出す操作が無い |
| Ctrl+Tab のタブ切替 | 次/前のタブへ（`Command.cpp:592`） | ブラウザがタブ切替に使い、ページ側で取り消せない |
| 全自動攻撃・全自動詠唱 | 押し続けると自動で再送（`PersonalThread.cpp:1216-1254`） | Philly でも署名付きの隠しコマンドで、一般の利用者には開放していない |
| BGM | MIDI を再生（`PersonalThread.cpp:1327`） | MIDI を変換して配信する仕組みが別途要る |
| コピー時のタグ処理 | コピー時にタグを除く（`Command.cpp:1590-1615`） | Web版は描画済みの文字をコピーするので、元からタグが付かない |
| 三者以上の Priv、追加発言、タグメニュー | `PrivForm.cpp`、`Command.cpp:1693`、`TagMenu.xml` | 利用場面が限られる |
| Home / End、Eagle eye text、リスト書き出し、超魔法メニュー | `Command.cpp:522, 1098`、`CharacterCommon.cpp:3312`、`MainForm.cpp:436` | 利用場面が限られる。超魔法はマスターだけが使う |
| ログ削除の正規表現、別窓画像 `img_wnd=` | `PersonalThread.cpp:948`、`TagToHtml.cpp:65` | 利用場面が限られる |
| `#enter-win` / `#leave-win` | アクティブ化で送る（`Character.cpp:267`） | 受け取る側の Philly も処理せず捨てていた（`PersonalThread.cpp:1047-1073`） |

### 1.3 プロトコル・周辺

| 機能 | 現状 | 対応案 |
|------|------|--------|
| 新規キャラ作成（`#ex-register`） | `components/Register.tsx` と `api/register.ts` はあるが、どの画面からも開けない（[DEVLOG](DEVLOG.md) §6.14 で温存扱い） | キャラ選択画面から開けるようにし、作成したキャラを characters へ登録する |
| v6 プロトコル（`#hello phi/6`） | fix-phidm は `#hello phi/6` を送った接続だけ v6 で応答する。本番の v5y とは非互換 | 本番が v6 へ移るまで対応しない |

## 2. 効果の無い送信

`backend/app/session.py` はログイン時に `#ex-switch ex-move-recv=true`、`ex-list-mode-end=true`、`ex-disp-magic=true` を送る。
v5y にも fix-phidm にも、この3つの実装が無い（`rg 'move-recv|list-mode|disp-magic'` で0件）。
Philly が対応していた raphi 系サーバの拡張と推測している。
parser の `end_list()` は `#ex-list-mode-end` が届かない前提で既に書いてある。

## 3. マッピング（朱蓮だけ）

旧 Python 版 phi-client の拡張マップは、サーバから現在地が届かない前提で、地形の照合から位置を推定していた。
推定がずれると誤った位置のタイルを保存し、誤りが固定された。
今回は v5y サーバに絶対座標を送る拡張を足し、推定をやめた。

- サーバ: `phi.td` の `:U` 行に `ZA` がある世界だけ、`#ex-switch ex-abspos=true` に `=true` を返し、7x7 マップごとに `#m57 .` の直前で `#ex-pos x y` を送る（upd-phi-server-v5y `feat/ex-abspos`）。x は東、y は南へ増える。
- 朱蓮: syuren-world の `phi.td` に `ZA` を足した（`feat/ex-abspos`）。他の世界は `=false` を返し、座標を送らない。
- BE: parser が `#ex-pos` を次のフレームの map イベントに `pos` として載せる。ログイン時に `#ex-switch ex-abspos=true` を送る。
- FE: `stores/automapStore.ts` が世界名ごとにタイルを貯め、localStorage（`phi_automap:<世界名>`）へ保存する。7x7 北固定の行 r・列 c は `(x+c-3, y-3+r)`。視界外（`?`）と盲目中のフレームは貯めない。`components/MapView.tsx` は中央に通常マップの 7×7、外周4マスに記録地図を置いた 15×15 を1枚に描き、外周を暗くする。モバイル幅では外周を付けない。

座標は従来マスター専用の Dumapic でしか分からなかった為、`ZA` の有無で世界ごとに選べるようにした。

## 4. 実装済みと確認した項目

[04] で不足としていた項目のうち、以下は Web版で実装済み。

- 発言種別（通常/大声/パーティー/全タブ/プライベート）: `components/Chat.tsx`
- 通知（priv限定・大声・正規表現フィルタ・タイトル点滅・音）: `lib/notify.ts`
- スクリーンショット（マップ/EagleEye）: `lib/screenshot.ts`
- ログ内画像（`img=`）: `lib/colorMarkup.ts`、`components/MarkupText.tsx`
- 魔法・ショートカット（Shift+1〜0。F キーから変更、DEVLOG A-35）、Shift+G（altG）: `lib/keyHandler.ts`
- 世界移動（`#ch-srv`、`last_server` 永続化）
- s-edit / m-edit 入力UI: `components/EditDialog.tsx`

プライベート発言は、サーバの `#priv NNNN 本文` プロトコルを使わず、ゲームコマンド `priv <番号> <本文>` で送る（A-13、実機検証済み）。
Philly も同じ形で送っている（`PrivForm.cpp:344-417`）。
