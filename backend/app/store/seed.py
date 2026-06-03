"""リポジトリ同梱アセットの seed 登録([08]§4 / 管理画面)。

`assets/chara/*.png` と `assets/chip/*.png`(透過PNG化済の同梱ファイル)を
起動時に DB へ `protected=1` で登録する。管理画面はこの DB を一覧の単一情報源と
し、`protected=1`(= リポジトリ同梱 seed)は削除不可とする。

設計
------------------------------------------------------------------
- 物理名 = ファイル名 stem(小文字)。`/assets/chara/<stem>.png` 配信規約と一致。
- 冪等: 既に DB に同名(gra_key / mapset_key)があればスキップ(再登録しない)。
  → アップロードで上書きされた seed は protected のまま維持される。
- orig_sha256 は配信PNGの sha(元BMP不在のため代用。重複検出用途のみ)。
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from app.store.db import Store

logger = logging.getLogger("app.store.seed")


def seed_assets(store: Store, assets_dir: str | Path) -> dict[str, int]:
    """assets/chara・assets/chip の同梱PNGを protected=1 で登録(冪等)。

    新規登録した件数を `{"chara": n, "chip": m}` で返す。
    """
    base = Path(assets_dir)
    chara_n = _seed_dir(
        base / "chara",
        exists=lambda name: store.get_graphic(name) is not None,
        register=lambda name, png_path, w, h, sha: store.upsert_graphic(
            name, name.lower(), png_path, w, h, sha, protected=True
        ),
    )
    chip_n = _seed_dir(
        base / "chip",
        exists=lambda name: store.get_chip(name) is not None,
        register=lambda name, png_path, w, h, sha: store.upsert_chip(
            name, name.lower(), png_path, w, h, sha, protected=True
        ),
    )
    if chara_n or chip_n:
        logger.info("seed 登録: chara=%d chip=%d", chara_n, chip_n)
    return {"chara": chara_n, "chip": chip_n}


def _seed_dir(directory: Path, *, exists, register) -> int:
    """1ディレクトリ配下の *.png を走査し未登録のみ register。登録件数を返す。"""
    if not directory.is_dir():
        return 0
    count = 0
    for path in sorted(directory.glob("*.png")):
        name = path.stem  # 表示名は stem(配信は lower(stem))
        if exists(name):
            continue
        try:
            raw = path.read_bytes()
            with Image.open(path) as im:
                w, h = im.size
        except (UnidentifiedImageError, OSError) as exc:  # pragma: no cover
            logger.warning("seed スキップ(画像読込失敗) %s: %s", path, exc)
            continue
        sha = hashlib.sha256(raw).hexdigest()
        register(name, str(path), w, h, sha)
        count += 1
    return count
