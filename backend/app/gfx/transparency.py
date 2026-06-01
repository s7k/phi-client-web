"""B9 透過変換共有モジュール([06] / [08]§5)。

レガシー phi クライアントは透過方式が画像種別ごとに異なる(3方式)。
本モジュールは `tools/gfx_convert/convert.py` の変換ロジックを移植し、BE/CLI
双方から利用可能にする(重複排除)。出力はすべて Pillow RGBA Image。

方式([06]):
  colorkey : 指定色(既定 clTeal=RGB(0,128,128))のピクセルを透明化。
             キャラ(96×160, clTeal)等。
  chip     : マップチップ専用の左右分割(左=画像/右=マスク)。チップ意味論あり
             だが透過処理自体は mask-h と同一。
  mask-v   : 上下分割(上=画像/下=マスク)。Items.bmp 等。
  mask-h   : 左右分割(左=画像/右=マスク)。汎用。

マスク規約: 白(R,G,B>閾値)→不透明 / それ以外→透明。
"""
from __future__ import annotations

from PIL import Image

# Borland VCL 標準色。
CL_TEAL: tuple[int, int, int] = (0, 128, 128)
CL_WHITE: tuple[int, int, int] = (255, 255, 255)

# マスク白判定閾値(R,G,B がこれを超えれば不透明)。
MASK_WHITE_THRESHOLD = 200


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
    """左右分割(左=画像/右=マスク)→ RGBA。"""
    img = src.convert("RGB")
    w, h = img.size
    if w % 2:
        raise ValueError(f"幅が偶数でない(左右分割不可): {w}")
    half = w // 2
    return _apply_mask(img.crop((0, 0, half, h)), img.crop((half, 0, w, h)))


def convert_mask_v(src: Image.Image) -> Image.Image:
    """上下分割(上=画像/下=マスク)→ RGBA。"""
    img = src.convert("RGB")
    w, h = img.size
    if h % 2:
        raise ValueError(f"高さが偶数でない(上下分割不可): {h}")
    half = h // 2
    return _apply_mask(img.crop((0, 0, w, half)), img.crop((0, half, w, h)))


def convert_chip(src: Image.Image) -> Image.Image:
    """マップチップ(左右分割)。透過処理は mask-h と同一の左右分割。"""
    return convert_mask_h(src)


# ---------------------------------------------------------------------------
# カラーキー
# ---------------------------------------------------------------------------
def convert_colorkey(
    src: Image.Image, key: tuple[int, int, int] = CL_TEAL
) -> Image.Image:
    """指定色 key に厳密一致するピクセルを透明化した RGBA を返す。"""
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
# カラーキー文字列パース('teal'/'white'/'R,G,B')
# ---------------------------------------------------------------------------
def parse_color_key(s: str) -> tuple[int, int, int]:
    """カラーキー指定文字列 → RGB タプル。

    'teal' / 'white' / 'R,G,B' を受理。不正は ValueError。
    """
    low = s.strip().lower()
    if low == "teal":
        return CL_TEAL
    if low == "white":
        return CL_WHITE
    parts = low.split(",")
    if len(parts) != 3:
        raise ValueError("色は 'R,G,B' / 'teal' / 'white'")
    try:
        r, g, b = (int(p) for p in parts)
    except ValueError as exc:
        raise ValueError("色成分は整数") from exc
    for v in (r, g, b):
        if not 0 <= v <= 255:
            raise ValueError("色成分は 0..255")
    return (r, g, b)
