# 現行Webクライアントの不足機能（2026-10-25 時点）

[04](04-feature-gap-analysis.md) はレガシーClientとPython版の差分で、Web版の実装前に作った。
本書は実装済みのWeb版を、次の3つと突き合わせた結果をまとめる。

- 旧Windowsクライアント Philly のソース（PhillySrc。リポジトリ外）
- 本番（朱蓮）が使う v5y サーバのソース（`s7k/upd-phi-server-v5y`）
- v6 プロトコルを持つ fix-phidm サーバのソース

凡例: BE=バックエンド(`backend/`)、FE=フロントエンド(`frontend/src/`)。
Philly の根拠は PhillySrc の `Philly/` からの相対パス。

## 1. 不足機能

### 1.1 発言・入力

| 機能 | 現状 | Philly の動作 |
|------|------|---------------|
| パーティー発言 | `serializer.py` の party は通常発言と同じ整形で送っている（A-14 の TODO） | Ctrl+Enter で先頭に `+` を付ける（`MainForm.cpp:1075`） |
| 入力履歴 | 無い | 入力欄は複数行で送った行が残り、↑↓で戻って Enter で再送（既定50行、`MainForm.cpp:970-981`） |
| 追加発言 | 無い | キャラごとの接頭語を新しい行へ自動で入れる（`Command.cpp:1693`） |
| 三者以上の Priv | 宛先は1人だけ | 宛先をチェックリストで複数選び、`/*to=A*//*to=B*/本文` を宛先ごとに送る（`PrivForm.cpp:344-417`） |
| タグメニュー | 無い | 入力欄の右クリックで色・サイズ・スタイルのタグを挿入（`TagMenu.xml`） |

### 1.2 ゲーム操作

| 機能 | 現状 | Philly の動作 |
|------|------|---------------|
| pay（支払い） | BE の `serializer.py` は `pay` intent を整形出来る。FE に発行するキー割当とUIが無い | P キーで金額ダイアログ → `pay <n>`。隠しコマンドで `@` キーが `pay 0`（`Command.cpp:1154, 1013`） |
| Alt 系の魔法ショートカット | F1-F7 の魔法割当（keybind.magic）だけある | Alt+W/E/I/S/L/U/D/C/A/F/B/R/P と Shift+Alt+W/L/D/C/A/U で `cast\n<魔法名>`。Search と Appear/Disappear は語を入力させる（`Command.cpp:614-655`） |
| Call / Return の確認 | 該当操作が無い | 唱える前に確認ダイアログ（`Command.cpp:1243, 1259`） |
| 全自動攻撃・全自動詠唱 | `lib/keyHandler.ts` の Space は単発の `hit` を送るだけ | 隠しコマンド。`#end-at` 受信時に Space を押していれば `hit`、`#end-mg` 受信時に F1-F7 を押していれば再詠唱（`PersonalThread.cpp:1216-1254`） |
| マップのマウス操作 | 無い（スマホ用の TouchControls だけ） | 左クリックでカーソル方向へ移動、右クリックで `hit`、中クリックでスクリーンショット（`MapForm.cpp:491-633`） |
| Home / End | 無い | `equip\nsort` / `unequip\n1`（`Command.cpp:522-523`） |
| Eagle eye text | 無い | Shift+Alt+E でテキスト版の Eagle eye を唱える（`Command.cpp:1098`） |
| リストの複数選択 | 1つ選ぶとすぐ送る | Space でチェックを付け、Enter でチェックした番号をまとめて送る（`Command.cpp:741-743`） |
| リスト書き出し | 無い | 表示中のリストをテキストに保存（`CharacterCommon.cpp:3312`） |
| 超魔法メニュー | 無い（入力欄から手で送る） | Exp が 99999999 のキャラにマスター魔法のメニューを出す（`MainForm.cpp:436-546`） |

`#more` 送信は不足ではない。
Philly はリストの9番目を「more」として番号 `9` を送るだけで、Web版もリスト中の `9` キーで同じ `9` を送る。

### 1.3 ログ・通知

| 機能 | 現状 | Philly の動作 |
|------|------|---------------|
| ログ保存 | `stores/chatStore.ts` は1000件のリングバッファで、古いログは消える。保存手段が無い | 日付ごとのファイルへ自動保存、バッファの HTML 保存（`CharacterCommon.cpp:525-589, 668`） |
| コピー時のタグ処理 | 無い | コピー時に時刻・キャラ名・タグを除く（`Command.cpp:1590-1615`） |
| ログ削除の正規表現 | 無い | 一致した行をログに出さない（`PersonalThread.cpp:948-957`） |
| 裏タブの緊急表示 | 未読数のバッジだけ | 裏のタブで HP か MP が減るとタブを緊急表示にする（`CharacterCommon.cpp:370`） |
| Ctrl+Tab | 無い | 次/前のタブへ。設定で未読・緊急のタブを優先（`Command.cpp:592, 603`） |
| 別窓画像 `img_wnd=` | 無い（`img=` は対応済み） | 画像窓に表示（`TagToHtml.cpp:65`） |
| `#ex-chr-conflict` | parser が捨てている | 「3重状態で消えています。移動してください」を出す（`PersonalThread.cpp:1353`） |
| BGM | `protocol/parser.py` が `#bgm` を捨てている | `sound\bgm\` の MIDI を再生。`#ex-bgm-speed` で速度変更、タブ切替で一時停止（`PersonalThread.cpp:1327, 1511`） |

### 1.4 プロトコル・周辺

| 機能 | 現状 | 対応案 |
|------|------|--------|
| 新規キャラ作成（`#ex-register`） | `components/Register.tsx` と `api/register.ts` はあるが、どの画面からも開けない（[DEVLOG](DEVLOG.md) §6.14 で温存扱い） | キャラ選択画面から開けるようにし、作成したキャラを characters へ登録する |
| `#enter-win` / `#leave-win` | 送っていない。Philly はタブとアプリのアクティブ化で送る（`Character.cpp:267, 318`）。サーバは同じ場の相手へ `#enter-win <名前>` を通知する | FE の `visibilitychange` を WS 経由で BE へ伝え、BE が送信 |
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

- 発言種別（通常/大声/全タブ/プライベート）: `components/Chat.tsx`。パーティーは §1.1 のとおり整形が未確定
- 通知（priv限定・大声・正規表現フィルタ・タイトル点滅・音）: `lib/notify.ts`
- スクリーンショット（マップ/EagleEye）: `lib/screenshot.ts`
- ログ内画像（`img=`）: `lib/colorMarkup.ts`、`components/MarkupText.tsx`
- F8-F12 ショートカット、Shift+G（altG）: `lib/keyHandler.ts`
- 世界移動（`#ch-srv`、`last_server` 永続化）
- s-edit / m-edit 入力UI: `components/EditDialog.tsx`

プライベート発言は、サーバの `#priv NNNN 本文` プロトコルを使わず、ゲームコマンド `priv <番号> <本文>` で送る（A-13、実機検証済み）。
Philly も同じ形で送っている（`PrivForm.cpp:344-417`）。
