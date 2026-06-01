# gfx_convert — レガシーBMP → 透過PNG 変換ツール

レガシーphiクライアントのBMPグラフィックを、Web配信用の透過PNGへ変換する。
画像種別ごとに透過方式が異なる(下記)ため、種別を自動判定して統一的にRGBA化する。

## 透過方式（3種）

| mode | 方式 | 対象 | 規約 |
|------|------|------|------|
| `colorkey` | カラーキー | キャラ(chara, clTeal) / 一部スキン(Direction=clWhite, Panel=clTeal) | 指定色を透明化 |
| `chip` | 埋め込みマスク・左右分割 | マップチップ(1024×96) | 左=画像/右=マスク。チップ32×48。白→不透明/他→透明 |
| `mask-v` | 埋め込みマスク・上下分割 | Items.bmp(960×64) / BitBltList系 | 上=画像/下=マスク。白→不透明/黒→透明 |
| `mask-h` | 埋め込みマスク・左右分割(汎用) | 上記chipのチップ意味論なし版 | 左=画像/右=マスク |
| `auto` | 自動判定(既定) | パス名(`chip`/`chara`/`Items.bmp`)・寸法から推定 | — |

clTeal = RGB(0,128,128)、clWhite = RGB(255,255,255)（Borland VCL標準色）。

根拠コード:
- `legacy/client/Philly/ImageStore.cpp` — LoadImage(透過色あり/なし2系統)
- `legacy/client/SrcLink/BitBltList/BitBltList.cpp` — 埋め込みマスク(AllBitmap高さ=FHeight×2)
- `phi-client/phi/gui/map_widget.py` — `_apply_chip_mask`(chip), `_CharaRenderer`(colorkey)

## セットアップ

```bash
# uv 利用例
uv venv venv
uv pip install --python venv/bin/python -r requirements.txt
```

依存: Pillow のみ。

## 使い方

```bash
PY=venv/bin/python

# 自動判定でディレクトリ一括変換（再帰。出力にディレクトリ構造を保持）
$PY convert.py <入力dir> <出力dir>

# マップチップ（個別チップPNGも分割出力 → 出力/default/00.png..31.png）
$PY convert.py /path/to/chip/default.bmp out/ --split

# キャラ一括（既定 colorkey teal）
$PY convert.py /path/to/chara out/chara

# 透過色を明示（Direction.bmp は白キー）
$PY convert.py Direction.bmp out/ --mode colorkey --key white

# Items（上下マスク。スプライト分割も）
$PY convert.py Items.bmp out/ --split
```

### オプション
- `--mode {auto,colorkey,chip,mask-v,mask-h}` — 変換方式（既定 auto）
- `--key {R,G,B|teal|white}` — colorkeyの透過色（既定 teal）
- `--split` — chip/mask系でスプライト個別PNGを `<出力>/<名>/NN.png` へ出力
- `--lowercase` — 出力PNGファイル名(stem)を小文字化（`t_Man.bmp`→`t_man.png`）。大文字小文字の取り違え防止。**解決側はcase-insensitive(lowercase正規化)前提**（[docs/08],[docs/09]）

## 出力仕様
- 全てRGBA PNG。レイアウト・寸法は入力を踏襲（chip/mask系は画像半分の寸法）。
- chip: 512×96（チップ index→ col=i%16,row=i//16, 各32×48）。
- chara: 96×160（向きB/R/F/L=行0-3、通常フレームx=0/16・巨大x=32/64）。
- Items: 960×32（32×32スプライト×30。使用は item_no 0-7）。

## 注意
- `chara/Index.txt`（グラ名→BMPファイル名の対応表, cp932）は画像でないため変換対象外。フロントのキャラグラ解決に必要なのでそのまま配備する。
- カラーキーはパレット(8/4bpp)BMPも一旦RGB化し厳密一致で判定。アンチエイリアスで境界に半端色が残る場合は元画像が原因（レガシー描画も同様）。
