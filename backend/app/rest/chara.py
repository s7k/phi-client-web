"""B10 REST chara API([08]§7)。

`/api/chara/*` ルータ。キャラグラフィックのアップロード(BMP→透過PNG変換)、
一覧/メタ/PNG配信/削除、Index(エイリアス)の CRUD・取込/生成、マニフェストを提供。

設計
------------------------------------------------------------------
- FastAPI ルータ。Store(B8)と gfx 共有モジュール(B9)を活用。
- アセット保存先は `CharaStorage`(assets/chara/<stored_name>.png)。
- gra_name 解決は case-insensitive(Store.gra_key_of)。stored_name は
  orig_sha256 由来の安全名(小文字16進)で衝突回避・グラ名非直結([08]§3)。
- 冪等: 同一 orig_sha256 は Store 側で既存を返す([08]§4)。
- 認証は依存性注入(`require_account`)で差し替え可能。既定は no-op(テスト容易性)。
  本番は WsServer 側で AuthService 連携の依存に差し替える。

ファクトリ `build_chara_router(store, assets_dir, fallback=None, require_account=None)`
を提供し、アプリ組み込み時に注入する。
"""
from __future__ import annotations

import hashlib
import io
import urllib.parse
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from PIL import Image, UnidentifiedImageError

from app.gfx import convert_colorkey, parse_color_key
from app.store.db import Store

# キャラ標準寸法([08]§6)。不一致は警告のみ(保存は許可)。
CHARA_STD_W, CHARA_STD_H = 96, 160
# アップロード最大サイズ(bytes)。
MAX_UPLOAD_BYTES = 2 * 1024 * 1024


class CharaStorage:
    """変換済 PNG の物理保管(assets/chara/<stored_name>.png)。"""

    def __init__(self, assets_dir: str | Path) -> None:
        self.base = Path(assets_dir)
        self.chara_dir = self.base / "chara"
        self.chara_dir.mkdir(parents=True, exist_ok=True)

    def png_path(self, stored_name: str) -> Path:
        return self.chara_dir / f"{stored_name}.png"

    def save_png(self, stored_name: str, img: Image.Image) -> Path:
        p = self.png_path(stored_name)
        img.save(p, format="PNG")
        return p

    def delete(self, stored_name: str) -> None:
        p = self.png_path(stored_name)
        if p.exists():
            p.unlink()


def _graphic_meta(g, *, dimension_warning: str | None = None) -> dict:
    """ChAraGraphic → REST メタ dict([08]§7.1)。"""
    quoted = urllib.parse.quote(g.gra_name, safe="")
    return {
        "graName": g.gra_name,
        "url": f"/api/chara/graphics/{quoted}/png",
        "width": g.width,
        "height": g.height,
        "colorKey": g.color_key,
        "dimensionWarning": dimension_warning,
        "uploadedAt": g.uploaded_at,
    }


def build_chara_router(
    store: Store,
    assets_dir: str | Path,
    *,
    require_account=None,
) -> APIRouter:
    """`/api/chara` ルータを構築。

    require_account: FastAPI 依存(認証)。None なら no-op(uploaded_by=None)。
    """
    storage = CharaStorage(assets_dir)
    router = APIRouter(prefix="/api/chara")

    # 認証依存。未指定時は誰でも None アカウントで通す(テスト/開発)。
    if require_account is None:
        async def _acct() -> str | None:  # noqa: D401
            return None
        account_dep = _acct
    else:
        account_dep = require_account

    # ------------------------------------------------------------------
    # 7.1 グラフィック
    # ------------------------------------------------------------------

    @router.post("/graphics")
    async def upload_graphic(
        file: UploadFile = File(...),
        graName: str | None = Form(None),
        colorKey: str = Form("teal"),
        account_id: str | None = Depends(account_dep),
    ) -> dict:
        raw = await file.read()
        if not raw:
            raise HTTPException(400, "空ファイル")
        if len(raw) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "ファイルが大きすぎる")

        # gra_name: 未指定ならアップロード元ファイル名(拡張子除去)。
        name = graName
        if not name:
            stem = Path(file.filename or "").stem
            if not stem:
                raise HTTPException(400, "graName 不明")
            name = stem
        if any(ord(c) < 0x20 for c in name) or len(name) > 255:
            raise HTTPException(400, "graName が不正(制御文字/長すぎ)")

        try:
            key_rgb = parse_color_key(colorKey)
        except ValueError as exc:
            raise HTTPException(400, f"colorKey が不正: {exc}") from exc

        try:
            img = Image.open(io.BytesIO(raw))
            img.load()
        except (UnidentifiedImageError, OSError) as exc:
            raise HTTPException(400, "画像として開けない") from exc

        # 透過変換(キャラは colorkey 既定)。
        rgba = convert_colorkey(img, key_rgb)
        w, h = rgba.size

        dimension_warning = None
        if (w, h) != (CHARA_STD_W, CHARA_STD_H):
            dimension_warning = (
                f"キャラ標準 {CHARA_STD_W}x{CHARA_STD_H} と不一致: {w}x{h}"
            )

        orig_sha = hashlib.sha256(raw).hexdigest()
        # stored_name: sha256 由来の安全名(小文字16進, グラ名非直結[08]§3)。
        stored_name = orig_sha[:32]

        # 冪等: 既存 sha があれば PNG 再生成せず既存メタ返却([08]§4)。
        existing = store.get_graphic_by_sha(orig_sha)
        if existing is None:
            png_path = storage.save_png(stored_name, rgba)
            g = store.upsert_graphic(
                name,
                stored_name,
                str(png_path),
                w,
                h,
                orig_sha,
                color_key=colorKey,
                uploaded_by=account_id,
            )
        else:
            g = existing

        return _graphic_meta(g, dimension_warning=dimension_warning)

    @router.get("/graphics")
    async def list_graphics() -> list[dict]:
        cur = store.conn.execute(
            "SELECT * FROM chara_graphics ORDER BY gra_key"
        )
        out = []
        for row in cur.fetchall():
            g = store.get_graphic(row["gra_name"])
            if g is not None:
                out.append(_graphic_meta(g))
        return out

    @router.get("/graphics/{gra_name}")
    async def get_graphic_meta(gra_name: str) -> dict:
        g = store.get_graphic(urllib.parse.unquote(gra_name))
        if g is None:
            raise HTTPException(404, "グラフィック未登録")
        return _graphic_meta(g)

    @router.get("/graphics/{gra_name}/png")
    async def get_graphic_png(gra_name: str) -> Response:
        g = store.get_graphic(urllib.parse.unquote(gra_name))
        if g is None:
            raise HTTPException(404, "グラフィック未登録")
        p = Path(g.png_path)
        if not p.exists():
            # png_path が stored_name 規約と一致するなら storage 経由で再解決。
            p = storage.png_path(g.stored_name)
        if not p.exists():
            raise HTTPException(404, "PNG ファイル不在")
        data = p.read_bytes()
        return Response(
            content=data,
            media_type="image/png",
            headers={"ETag": f'"{g.orig_sha256}"'},
        )

    @router.delete("/graphics/{gra_name}")
    async def delete_graphic(
        gra_name: str,
        account_id: str | None = Depends(account_dep),
    ) -> dict:
        g = store.get_graphic(urllib.parse.unquote(gra_name))
        if g is None:
            raise HTTPException(404, "グラフィック未登録")
        storage.delete(g.stored_name)
        store.conn.execute(
            "DELETE FROM chara_graphics WHERE gra_key = ?", (g.gra_key,)
        )
        store.conn.commit()
        return {"deleted": g.gra_name}

    # ------------------------------------------------------------------
    # 7.2 Index(エイリアス)
    # ------------------------------------------------------------------

    @router.get("/index")
    async def list_index() -> list[dict]:
        return [
            {"key": e.key, "graName": e.gra_name} for e in store.list_index()
        ]

    @router.put("/index/{key}")
    async def put_index(
        key: str,
        body: dict,
        account_id: str | None = Depends(account_dep),
    ) -> dict:
        gra_name = body.get("graName")
        if not gra_name:
            raise HTTPException(400, "graName 必須")
        key = urllib.parse.unquote(key)
        store.upsert_index(key, gra_name, updated_by=account_id)
        return {"key": key, "graName": gra_name}

    @router.delete("/index/{key}")
    async def delete_index(
        key: str,
        account_id: str | None = Depends(account_dep),
    ) -> dict:
        key = urllib.parse.unquote(key)
        if store.get_index(key) is None:
            raise HTTPException(404, "エイリアス未登録")
        store.conn.execute("DELETE FROM chara_index WHERE key = ?", (key,))
        store.conn.commit()
        return {"deleted": key}

    @router.post("/index/import")
    async def import_index(
        file: UploadFile = File(...),
        account_id: str | None = Depends(account_dep),
    ) -> dict:
        raw = await file.read()
        # cp932 優先、失敗時 UTF-8([08]§8)。
        try:
            text = raw.decode("cp932")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", errors="replace")
        count = store.import_index_text(text, updated_by=account_id)
        return {"imported": count}

    @router.get("/index.txt")
    async def export_index(charset: str = "utf-8") -> Response:
        text = store.export_index_text()
        cs = charset.lower()
        if cs == "cp932":
            data = text.encode("cp932", errors="replace")
            media = "text/plain; charset=shift_jis"
        else:
            data = text.encode("utf-8")
            media = "text/plain; charset=utf-8"
        return Response(content=data, media_type=media)

    # ------------------------------------------------------------------
    # 7.3 マニフェスト
    # ------------------------------------------------------------------

    @router.get("/manifest")
    async def manifest() -> dict:
        graphics: dict[str, str] = {}
        cur = store.conn.execute("SELECT gra_name FROM chara_graphics")
        for row in cur.fetchall():
            g = store.get_graphic(row["gra_name"])
            if g is not None:
                quoted = urllib.parse.quote(g.gra_name, safe="")
                graphics[g.gra_name] = f"/api/chara/graphics/{quoted}/png"
        index = {e.key: e.gra_name for e in store.list_index()}
        return {"graphics": graphics, "index": index}

    return router
