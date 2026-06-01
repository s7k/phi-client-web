#!/usr/bin/env python3
"""
レガシーBMPグラフィック → 透過PNG 変換ツール

レガシーphiクライアントは透過方式が画像種別ごとに異なる(ダサい設計)。
本ツールは3方式を統一的に透過PNG化する。

方式一覧 (--mode):

  colorkey : カラーキー方式
      指定色(既定 clTeal=RGB(0,128,128))のピクセルを透明化。
      対象: キャラ(chara, 96×160, clTeal)、一部スキン画像
            (Direction.bmp=clWhite, HpMpPanel/Status=clTeal 等)。
      参照: ImageStore.cpp LoadImage(…,TransparentColor), GraCache.cpp。

  chip : 埋め込みマスク・左右分割方式 (マップチップ専用)
      1024×96 を4象限に分割:
        左上(0..511, 0..47 )=チップ0..15画像 / 右上(512.., 0..47)=同マスク
        左下(0..511,48..95)=チップ16..31画像 / 右下(512..,48..95)=同マスク
      チップ寸法 32×48、16個/半幅行。マスク規約 白→不透明/それ以外→透明。
      出力は画像半分(512×96)にマスクαを適用したRGBA。
      参照: phi-client map_widget.py _apply_chip_mask, GraCache.cpp。

  mask-v : 埋め込みマスク・上下分割方式
      上半分=画像 / 下半分=マスク(白→不透明/黒→透明)。
      対象: Items.bmp(960×64)、BitBltList系シート。
      参照: BitBltList.cpp LoadFromFile(透過色なし版), AllBitmap高さ=FHeight×2。

  mask-h : 埋め込みマスク・左右分割方式 (汎用)
      左半分=画像 / 右半分=マスク。chipのチップ意味論なし版。

  auto   : パス名・寸法から上記を自動判定(既定)。

依存: Pillow (pip install Pillow)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("Pillow 未インストール。`pip install Pillow` を実行。\n")
    sys.exit(1)


# Borland VCL 標準色
CL_TEAL = (0, 128, 128)
CL_WHITE = (255, 255, 255)

CHIP_W, CHIP_H = 32, 48          # マップチップ寸法
ITEM_W, ITEM_H = 32, 32          # アイテムスプライト寸法
MASK_WHITE_THRESHOLD = 200       # マスク白判定(R,G,B>これ→不透明)


# ---------------------------------------------------------------------------
# 共通: 埋め込みマスク適用 (画像 + マスク → RGBA)
# ---------------------------------------------------------------------------
def _apply_mask(image_half: Image.Image, mask_half: Image.Image) -> Image.Image:
    """画像半分にマスク半分のα(白→不透明/それ以外→透明)を適用。"""
    img = image_half.convert("RGB")
    msk = mask_half.convert("RGB")
    w, h = img.size
    ip, mp = img.load(), msk.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()
    t = MASK_WHITE_THRESHOLD
    for y in range(h):
        for x in range(w):
            mr, mg, mb = mp[x, y][:3]
            if mr > t and mg > t and mb > t:
                r, g, b = ip[x, y][:3]
                op[x, y] = (r, g, b, 255)
    return out


def convert_mask_h(src: Image.Image) -> Image.Image:
    """左右分割(左=画像/右=マスク)。"""
    img = src.convert("RGB")
    w, h = img.size
    if w % 2:
        raise ValueError(f"幅が偶数でない(左右分割不可): {w}")
    half = w // 2
    return _apply_mask(img.crop((0, 0, half, h)), img.crop((half, 0, w, h)))


def convert_mask_v(src: Image.Image) -> Image.Image:
    """上下分割(上=画像/下=マスク)。"""
    img = src.convert("RGB")
    w, h = img.size
    if h % 2:
        raise ValueError(f"高さが偶数でない(上下分割不可): {h}")
    half = h // 2
    return _apply_mask(img.crop((0, 0, w, half)), img.crop((0, half, w, h)))


def convert_chip(src: Image.Image) -> Image.Image:
    """マップチップ(左右分割)。チップ意味論はmask_hと同一の左右分割。"""
    return convert_mask_h(src)


# ---------------------------------------------------------------------------
# カラーキー
# ---------------------------------------------------------------------------
def convert_colorkey(src: Image.Image, key: tuple[int, int, int]) -> Image.Image:
    """指定色keyに厳密一致するピクセルを透明化したRGBAを返す。"""
    img = src.convert("RGBA")
    px = img.load()
    w, h = img.size
    kr, kg, kb = key
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            if r == kr and g == kg and b == kb:
                px[x, y] = (0, 0, 0, 0)
    return img


# ---------------------------------------------------------------------------
# スプライト分割
# ---------------------------------------------------------------------------
def split_sheet(img: Image.Image, cw: int, ch: int) -> list[Image.Image]:
    """RGBAシートを cw×ch のスプライトへ分割 (行優先: index=row*cols+col)。"""
    w, h = img.size
    out: list[Image.Image] = []
    for row in range(h // ch):
        for col in range(w // cw):
            x, y = col * cw, row * ch
            out.append(img.crop((x, y, x + cw, y + ch)))
    return out


# ---------------------------------------------------------------------------
# モード判定
# ---------------------------------------------------------------------------
def detect_mode(path: Path, img: Image.Image) -> str:
    parts = {p.lower() for p in path.parts}
    name = path.name.lower()
    w, h = img.size
    if "chip" in parts or (w == 1024 and h == 96):
        return "chip"
    if name == "items.bmp":
        return "mask-v"
    if "chara" in parts or (w == 96 and h == 160):
        return "colorkey"
    if name == "direction.bmp":
        return "colorkey"  # clWhite (--key white 指定推奨)
    return "colorkey"


# ---------------------------------------------------------------------------
# 1ファイル変換
# ---------------------------------------------------------------------------
def convert_file(
    src_path: Path, dst_path: Path, mode: str,
    key: tuple[int, int, int], split: bool,
) -> str:
    img = Image.open(src_path)
    actual = mode if mode != "auto" else detect_mode(src_path, img)
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    if actual == "chip":
        rgba = convert_chip(img)
        cw, ch = CHIP_W, CHIP_H
    elif actual == "mask-h":
        rgba = convert_mask_h(img)
        cw, ch = CHIP_W, CHIP_H
    elif actual == "mask-v":
        rgba = convert_mask_v(img)
        cw, ch = ITEM_W, ITEM_H
    else:  # colorkey
        rgba = convert_colorkey(img, key)
        cw = ch = 0

    rgba.save(dst_path)
    label = actual if actual != "colorkey" else f"colorkey{key}"

    if split and cw:
        sprites = split_sheet(rgba, cw, ch)
        sdir = dst_path.with_suffix("")
        sdir.mkdir(parents=True, exist_ok=True)
        for i, sp in enumerate(sprites):
            sp.save(sdir / f"{i:02d}.png")
        label += f"(+split {len(sprites)})"
    return label


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_key(s: str) -> tuple[int, int, int]:
    if s.lower() == "teal":
        return CL_TEAL
    if s.lower() == "white":
        return CL_WHITE
    parts = s.split(",")
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("色は 'R,G,B' / 'teal' / 'white'")
    return tuple(int(p) for p in parts)  # type: ignore[return-value]


def main() -> int:
    ap = argparse.ArgumentParser(description="レガシーBMP → 透過PNG 変換")
    ap.add_argument("input", type=Path, help="入力BMPファイル or ディレクトリ")
    ap.add_argument("output", type=Path, help="出力先ディレクトリ")
    ap.add_argument("--mode", default="auto",
                    choices=["auto", "colorkey", "chip", "mask-v", "mask-h"],
                    help="変換方式 (既定 auto)")
    ap.add_argument("--key", type=parse_key, default=CL_TEAL,
                    help="カラーキー色 'R,G,B'/'teal'/'white' (既定 teal)")
    ap.add_argument("--split", action="store_true",
                    help="chip/mask系でスプライト個別PNGも出力")
    args = ap.parse_args()

    if args.input.is_file():
        files, base = [args.input], args.input.parent
    elif args.input.is_dir():
        files = sorted(p for p in args.input.rglob("*") if p.suffix.lower() == ".bmp")
        base = args.input
    else:
        sys.stderr.write(f"入力が存在しない: {args.input}\n")
        return 1
    if not files:
        sys.stderr.write("BMPが見つからない。\n")
        return 1

    ok = ng = 0
    for src in files:
        rel = src.relative_to(base) if src != base else Path(src.name)
        dst = args.output / rel.with_suffix(".png")
        try:
            kind = convert_file(src, dst, args.mode, args.key, args.split)
            print(f"[OK] {rel} ({kind})")
            ok += 1
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"[NG] {rel}: {exc}\n")
            ng += 1
    print(f"\n完了: 成功 {ok} / 失敗 {ng} / 合計 {len(files)}")
    return 0 if ng == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
