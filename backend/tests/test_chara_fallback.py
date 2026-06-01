"""B11 キャラタイプ フォールバック解決テスト([09])。"""
from __future__ import annotations

import pytest

from app.chara_fallback import DEFAULT_KEY, CharaFallback


@pytest.fixture
def fb() -> CharaFallback:
    return CharaFallback.load()


def test_load_from_default_data(fb):
    # data/chara_type_fallback.json が読める
    assert fb.entry_for_code(1) is not None


def test_code_to_key_known(fb):
    assert fb.key_for_code(0) == "human"
    assert fb.key_for_code(1) == "intelligent"
    assert fb.key_for_code(2) == "beast"
    assert fb.key_for_code(5) == "undead"
    assert fb.key_for_code(7) == "eraser"
    assert fb.key_for_code(64) == "setcg"
    assert fb.key_for_code(128) == "creature"


def test_code_to_key_unknown_defaults_intelligent(fb):
    # 未一致コード → intelligent([09]§3)
    assert fb.key_for_code(999) == DEFAULT_KEY == "intelligent"
    assert fb.key_for_code(None) == "intelligent"


def test_fallback_gra_known(fb):
    assert fb.fallback_gra(0) == "t_Man"
    assert fb.fallback_gra(1) == "t_elf"
    assert fb.fallback_gra(2) == "t_dog"
    assert fb.fallback_gra(5) == "t_ghost1"


def test_fallback_gra_null_assignment(fb):
    # webFallbackGra が null のコード(magical=4)は None
    assert fb.fallback_gra(4) is None


def test_fallback_gra_unknown_uses_intelligent(fb):
    # 未一致 → intelligent の webFallbackGra(t_elf)
    assert fb.fallback_gra(999) == "t_elf"
    assert fb.fallback_gra(None) == "t_elf"


def test_fallback_gra_for_key_case_insensitive(fb):
    assert fb.fallback_gra_for_key("BEAST") == "t_dog"
    assert fb.fallback_gra_for_key("Undead") == "t_ghost1"


def test_fallback_gra_for_key_unknown(fb):
    assert fb.fallback_gra_for_key("nonexistent") is None


def test_construct_from_explicit_types():
    fb = CharaFallback([
        {"code": 10, "key": "Custom", "webFallbackGra": "x_gra"},
    ])
    assert fb.key_for_code(10) == "Custom"
    assert fb.fallback_gra_for_key("custom") == "x_gra"
