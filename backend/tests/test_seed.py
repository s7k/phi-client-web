"""seed_assets テスト(リポジトリ同梱アセットの protected 登録, 冪等)。"""
from __future__ import annotations

from PIL import Image

from app.store.db import Store
from app.store.seed import seed_assets


def _write_png(path, size):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGBA", size, (0, 0, 0, 0)).save(path, format="PNG")


def test_seed_registers_protected(tmp_path):
    _write_png(tmp_path / "chara" / "Hero.png", (96, 160))
    _write_png(tmp_path / "chip" / "Town.png", (512, 96))
    store = Store.open(":memory:")
    n = seed_assets(store, tmp_path)
    assert n == {"chara": 1, "chip": 1}
    g = store.get_graphic("Hero")
    assert g is not None and g.protected and g.stored_name == "hero"
    assert g.width == 96 and g.height == 160
    c = store.get_chip("Town")
    assert c is not None and c.protected and c.stored_name == "town"


def test_seed_idempotent(tmp_path):
    _write_png(tmp_path / "chara" / "Hero.png", (96, 160))
    store = Store.open(":memory:")
    assert seed_assets(store, tmp_path) == {"chara": 1, "chip": 0}
    # 2回目は新規 0(既存スキップ)。
    assert seed_assets(store, tmp_path) == {"chara": 0, "chip": 0}


def test_seed_missing_dir_noop(tmp_path):
    store = Store.open(":memory:")
    assert seed_assets(store, tmp_path / "nonexistent") == {"chara": 0, "chip": 0}
