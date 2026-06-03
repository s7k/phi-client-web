"""REST chip API(マップチップシート, [06]/[08]§5)。

`/api/chip/*` ルータ。マップチップシートのアップロード(左右分割→透過PNG変換)、
一覧/メタ/PNG配信/削除を提供する。

設計
------------------------------------------------------------------
- 入力は左右分割(左=画像 / 右=マスク)の 1024x96。`convert_chip`(= mask-h)で
  512x96 の透過PNG へ変換して保存([06])。入力寸法は 1024x96 固定検査(不一致 400)。
- 物理名 = mapset 名(stored_name = lower(mapset))。`/assets/chip/<stored_name>.png`
  配信規約と一致(フロントの chipUrl が lower(mapset) で参照するため)。
- 同名(mapset_key 衝突)は 409 で拒否(seed/既存の上書き事故防止)。
- protected=1(リポジトリ同梱 seed)は削除不可(403)。
- 変更系(upload/delete)は管理者限定(require_admin)。GET 系は閲覧可(レート制限のみ)。

ファクトリ `build_chip_router(store, assets_dir, require_admin=None, rate_limiter=None)`。
"""
from __future__ import annotations

import hashlib
import io
import urllib.parse
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from PIL import Image, UnidentifiedImageError

from app.gfx import convert_chip
from app.store.db import Store

# チップ入力標準寸法(左右分割: 左512=画像 / 右512=マスク, 高さ96)。
CHIP_IN_W, CHIP_IN_H = 1024, 96
# 変換後(透過PNG)の標準寸法。
CHIP_OUT_W, CHIP_OUT_H = 512, 96
# アップロード最大サイズ(bytes)。
MAX_UPLOAD_BYTES = 2 * 1024 * 1024
# decompression bomb 対策。入力標準に余裕を持たせた上限。
MAX_IMAGE_W = 2048
MAX_IMAGE_H = 256
MAX_IMAGE_PIXELS = MAX_IMAGE_W * MAX_IMAGE_H


class ChipStorage:
    """変換済 PNG の物理保管(assets/chip/<stored_name>.png)。"""

    def __init__(self, assets_dir: str | Path) -> None:
        self.base = Path(assets_dir)
        self.chip_dir = self.base / "chip"
        self.chip_dir.mkdir(parents=True, exist_ok=True)

    def png_path(self, stored_name: str) -> Path:
        return self.chip_dir / f"{stored_name}.png"

    def save_png(self, stored_name: str, img: Image.Image) -> Path:
        p = self.png_path(stored_name)
        img.save(p, format="PNG")
        return p

    def delete(self, stored_name: str) -> None:
        p = self.png_path(stored_name)
        if p.exists():
            p.unlink()


def _chip_meta(c) -> dict:
    """ChipGraphic → REST メタ dict。"""
    quoted = urllib.parse.quote(c.mapset_name, safe="")
    return {
        "mapset": c.mapset_name,
        "url": f"/api/chip/graphics/{quoted}/png",
        "width": c.width,
        "height": c.height,
        "protected": c.protected,
        "uploadedAt": c.uploaded_at,
    }


def build_chip_router(
    store: Store,
    assets_dir: str | Path,
    *,
    require_admin=None,
    rate_limiter=None,
) -> APIRouter:
    """`/api/chip` ルータを構築(chara router と同方針)。"""
    storage = ChipStorage(assets_dir)
    router = APIRouter(prefix="/api/chip")

    if require_admin is None:
        async def _admin() -> str | None:
            return None
        admin_dep = _admin
    else:
        admin_dep = require_admin

    def _enforce_get_rate(request: Request) -> None:
        if rate_limiter is None:
            return
        from app.rest.register import client_ip
        ip = client_ip(request)
        if not rate_limiter.allow("chip_get", ip):
            raise HTTPException(429, "リクエストが多すぎます(chip GET)")

    @router.post("/graphics")
    async def upload_chip(
        file: UploadFile = File(...),
        mapset: str | None = Form(None),
        account_id: str | None = Depends(admin_dep),
    ) -> dict:
        if rate_limiter is not None:
            if not rate_limiter.allow("upload", account_id or "anon"):
                raise HTTPException(429, "アップロードレート超過(30/分/account)")
        raw = await file.read()
        if not raw:
            raise HTTPException(400, "空ファイル")
        if len(raw) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "ファイルが大きすぎる")

        name = mapset
        if not name:
            stem = Path(file.filename or "").stem
            if not stem:
                raise HTTPException(400, "mapset 不明")
            name = stem
        if any(ord(c) < 0x20 for c in name) or len(name) > 255:
            raise HTTPException(400, "mapset が不正(制御文字/長すぎ)")
        if any(sep in name for sep in ("/", "\\")) or name in (".", ".."):
            raise HTTPException(400, "mapset に使用できない文字(/ \\ .)が含まれます")

        # decompression bomb 対策(chara と同方針): ヘッダ寸法検査 → load。
        try:
            img = Image.open(io.BytesIO(raw))
        except (UnidentifiedImageError, OSError) as exc:
            raise HTTPException(400, "画像として開けない") from exc

        w0, h0 = img.size
        if w0 <= 0 or h0 <= 0:
            raise HTTPException(400, "画像寸法が不正")
        if w0 > MAX_IMAGE_W or h0 > MAX_IMAGE_H or w0 * h0 > MAX_IMAGE_PIXELS:
            raise HTTPException(
                413, f"画像が大きすぎます(最大 {MAX_IMAGE_W}x{MAX_IMAGE_H})"
            )

        prev_limit = Image.MAX_IMAGE_PIXELS
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        try:
            img.load()
        except Image.DecompressionBombError as exc:
            raise HTTPException(413, "画像が大きすぎます(bomb 検知)") from exc
        except (UnidentifiedImageError, OSError) as exc:
            raise HTTPException(400, "画像として開けない") from exc
        finally:
            Image.MAX_IMAGE_PIXELS = prev_limit

        # 入力寸法は 1024x96 固定(左右分割)。不一致は拒否。
        if (w0, h0) != (CHIP_IN_W, CHIP_IN_H):
            raise HTTPException(
                400,
                f"チップ標準 {CHIP_IN_W}x{CHIP_IN_H}(左右分割)と不一致: {w0}x{h0}",
            )

        # 同名拒否(差し替えは削除→再アップロード運用)。
        if store.get_chip(name) is not None:
            raise HTTPException(409, f"同名チップが既に存在します: {name}")

        # 左右分割→透過PNG(512x96)。
        rgba = convert_chip(img)
        w, h = rgba.size

        orig_sha = hashlib.sha256(raw).hexdigest()
        stored_name = name.lower()
        png_path = storage.save_png(stored_name, rgba)
        c = store.upsert_chip(
            name, stored_name, str(png_path), w, h, orig_sha,
            uploaded_by=account_id,
        )
        return _chip_meta(c)

    @router.get("/graphics")
    async def list_chips(request: Request) -> list[dict]:
        _enforce_get_rate(request)
        return [_chip_meta(c) for c in store.list_chips()]

    @router.get("/graphics/{mapset}")
    async def get_chip_meta(mapset: str, request: Request) -> dict:
        _enforce_get_rate(request)
        c = store.get_chip(urllib.parse.unquote(mapset))
        if c is None:
            raise HTTPException(404, "チップ未登録")
        return _chip_meta(c)

    @router.get("/graphics/{mapset}/png")
    async def get_chip_png(mapset: str, request: Request) -> Response:
        _enforce_get_rate(request)
        c = store.get_chip(urllib.parse.unquote(mapset))
        if c is None:
            raise HTTPException(404, "チップ未登録")
        p = Path(c.png_path)
        if not p.exists():
            p = storage.png_path(c.stored_name)
        if not p.exists():
            raise HTTPException(404, "PNG ファイル不在")
        return Response(
            content=p.read_bytes(),
            media_type="image/png",
            headers={"ETag": f'"{c.orig_sha256}"'},
        )

    @router.delete("/graphics/{mapset}")
    async def delete_chip(
        mapset: str,
        account_id: str | None = Depends(admin_dep),
    ) -> dict:
        c = store.get_chip(urllib.parse.unquote(mapset))
        if c is None:
            raise HTTPException(404, "チップ未登録")
        if c.protected:
            raise HTTPException(403, "初期同梱チップは削除できません")
        storage.delete(c.stored_name)
        store.delete_chip(c.mapset_name)
        return {"deleted": c.mapset_name}

    return router
