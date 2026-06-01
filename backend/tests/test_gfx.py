"""B9 gfx 透過変換テスト([06]/[08]§5)。

小さい合成画像で既知画素をアサート。convert_colorkey/chip/mask_v を検証。
"""
from __future__ import annotations

import pytest
from PIL import Image

from app.gfx import (
    CL_TEAL,
    CL_WHITE,
    convert_chip,
    convert_colorkey,
    convert_mask_h,
    convert_mask_v,
    parse_color_key,
)


# --- colorkey -------------------------------------------------------------

def test_colorkey_teal_transparent():
    # 2x2: 左上=teal(透明化), 残り=赤(不透明)
    img = Image.new("RGB", (2, 2), (255, 0, 0))
    img.putpixel((0, 0), CL_TEAL)
    out = convert_colorkey(img, CL_TEAL)
    assert out.mode == "RGBA"
    assert out.getpixel((0, 0)) == (0, 0, 0, 0)        # teal → 透明
    assert out.getpixel((1, 0)) == (255, 0, 0, 255)    # 赤 → 不透明


def test_colorkey_default_is_teal():
    img = Image.new("RGB", (1, 1), CL_TEAL)
    out = convert_colorkey(img)  # key 省略 → teal 既定
    assert out.getpixel((0, 0)) == (0, 0, 0, 0)


def test_colorkey_white():
    img = Image.new("RGB", (2, 1), (10, 20, 30))
    img.putpixel((0, 0), CL_WHITE)
    out = convert_colorkey(img, CL_WHITE)
    assert out.getpixel((0, 0)) == (0, 0, 0, 0)
    assert out.getpixel((1, 0)) == (10, 20, 30, 255)


def test_colorkey_no_match_keeps_opaque():
    img = Image.new("RGB", (1, 1), (1, 2, 3))
    out = convert_colorkey(img, CL_TEAL)
    assert out.getpixel((0, 0)) == (1, 2, 3, 255)


# --- mask-h (左右分割) ----------------------------------------------------

def test_mask_h():
    # 幅4: 左2=画像(青/緑), 右2=マスク(白=不透明/黒=透明)
    img = Image.new("RGB", (4, 1), (0, 0, 0))
    img.putpixel((0, 0), (0, 0, 255))   # 画像[0]=青
    img.putpixel((1, 0), (0, 255, 0))   # 画像[1]=緑
    img.putpixel((2, 0), CL_WHITE)      # マスク[0]=白 → 不透明
    img.putpixel((3, 0), (0, 0, 0))     # マスク[1]=黒 → 透明
    out = convert_mask_h(img)
    assert out.size == (2, 1)
    assert out.getpixel((0, 0)) == (0, 0, 255, 255)  # 青・不透明
    assert out.getpixel((1, 0)) == (0, 0, 0, 0)      # 透明


def test_mask_h_odd_width_raises():
    img = Image.new("RGB", (3, 1))
    with pytest.raises(ValueError):
        convert_mask_h(img)


# --- chip (= mask-h と同一の透過処理) ------------------------------------

def test_chip_same_as_mask_h():
    img = Image.new("RGB", (4, 1), (0, 0, 0))
    img.putpixel((0, 0), (123, 45, 67))
    img.putpixel((2, 0), CL_WHITE)  # マスク白 → 不透明
    out = convert_chip(img)
    assert out.getpixel((0, 0)) == (123, 45, 67, 255)
    assert out.getpixel((1, 0)) == (0, 0, 0, 0)  # マスク黒 → 透明


# --- mask-v (上下分割) ----------------------------------------------------

def test_mask_v():
    # 高さ4: 上2=画像, 下2=マスク
    img = Image.new("RGB", (1, 4), (0, 0, 0))
    img.putpixel((0, 0), (200, 100, 50))  # 画像[0]
    img.putpixel((0, 1), (50, 100, 200))  # 画像[1]
    img.putpixel((0, 2), CL_WHITE)        # マスク[0]=白 → 不透明
    img.putpixel((0, 3), (0, 0, 0))       # マスク[1]=黒 → 透明
    out = convert_mask_v(img)
    assert out.size == (1, 2)
    assert out.getpixel((0, 0)) == (200, 100, 50, 255)
    assert out.getpixel((0, 1)) == (0, 0, 0, 0)


def test_mask_v_odd_height_raises():
    img = Image.new("RGB", (1, 3))
    with pytest.raises(ValueError):
        convert_mask_v(img)


# --- parse_color_key ------------------------------------------------------

def test_parse_color_key():
    assert parse_color_key("teal") == CL_TEAL
    assert parse_color_key("WHITE") == CL_WHITE
    assert parse_color_key("10,20,30") == (10, 20, 30)


def test_parse_color_key_invalid():
    with pytest.raises(ValueError):
        parse_color_key("1,2")
    with pytest.raises(ValueError):
        parse_color_key("300,0,0")
