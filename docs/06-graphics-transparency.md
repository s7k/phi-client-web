# グラフィック透過方式と変換

レガシーphiクライアントのBMPグラフィックは、画像種別ごとに透過方式が異なる。Web化に向け全て透過PNGへ変換する。変換ツール: `tools/gfx_convert/`（[README](../tools/gfx_convert/README.md)）。

## 透過方式（実データ＋レガシーコードで確定）

3方式。「キャラ＝カラーキー」「マップ＝埋め込みマスク」が基本、Itemsは上下マスク。

| 種別 | 寸法例 | 方式 | 詳細 | 根拠 |
|------|--------|------|------|------|
| **キャラ** chara | 96×160 | カラーキー | clTeal(0,128,128)を透明化 | ImageStore.cpp / map_widget.py `_CharaRenderer` |
| **マップチップ** chip | 1024×96 | 埋め込みマスク・左右分割 | 左=画像/右=マスク。さらに上下で chip0-15 / 16-31。チップ32×48、白→不透明/他→透明 | map_widget.py `_apply_chip_mask` / GraCache.cpp |
| **アイテム** Items.bmp | 960×64 | 埋め込みマスク・上下分割 | 上=画像/下=マスク。32×32スプライト×30。白→不透明/黒→透明 | BitBltList.cpp `LoadFromFile`(透過色なし) |
| (スキン) Direction.bmp | — | カラーキー | clWhite | ImageStore.cpp |
| (スキン) HpMpPanel/Status等 | — | カラーキー | clTeal | ImageStore.cpp |

### レガシー実装の要点
- `ImageStore::LoadImage` に2系統:
  - 透過色あり → `BitBltList::LoadFromFile(file, MaskColor)`: カラーキーからマスク自動生成。
  - 透過色なし → `BitBltList::LoadFromFile(file)`: ファイルが既に画像+マスクを内包（`AllBitmap`高さ=`FHeight×2`、上=画像/下=マスク）。Items.bmpはこれ。
- マップチップは専用の `classMapChipBitBltList`（1024×96の4象限、左右に画像/マスク）。

## 検証結果
- 実データ確認: chip=1024×96, chara=96×160(537件), Items=960×64。
- Items.bmp: 上半分=画像(白背景・赤等の色付スプライト)、下半分=マスク(黒/白2値) → 上下マスク方式と確定（teal背景ではない。Python実装のItems=clTealは誤りの可能性）。
- 変換ツールで chip(+split32) / chara537件 / Items(+split) を全て透過PNG化成功（失敗0）。チェッカーボード背景合成で透過を目視確認済。

## Web化への反映
- フロントは変換後の透過PNGを使用（[02 設計](02-architecture-design.md) `assets/`）。描画ロジックはPython同等（ユーザー方針）。
- `chara/Index.txt`（グラ名→ファイル名, cp932）は画像でないが、キャラグラ解決に必須 → UTF-8化してフロントへ同梱。
- チップ index→セル対応、キャラの向き/フレーム配置、アイテム item_no は [README](../tools/gfx_convert/README.md) 出力仕様参照。
- 変換は事前バッチ（ビルド時）。実行時変換は不要。

## 未対応・任意
- スキン画像(Direction/Panel/Bar/Tab等)の一括変換は `--mode colorkey --key {teal|white}` を種別ごとに指定。必要時に実施。
- HpMpBar 等の特殊レイアウト(`LoadHpMpBar`)は別処理だが、Web版UIは独自実装で代替可能（優先度低）。
