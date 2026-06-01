"""pytest 共通設定・フィクスチャローダ。"""
from __future__ import annotations

from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"
SYNTHETIC_DIR = FIXTURES_DIR / "synthetic"
RECORDED_DIR = FIXTURES_DIR / "recorded"  # gitignore. 実データ録画


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES_DIR


@pytest.fixture
def synthetic_dir() -> Path:
    return SYNTHETIC_DIR


def load_synthetic(name: str) -> bytes:
    """synthetic フィクスチャ(コミット対象)を生バイトで読む。"""
    return (SYNTHETIC_DIR / name).read_bytes()
