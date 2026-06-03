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
- 変更系(upload/delete/index 編集/import)は管理者限定。認可は依存性注入
  (`require_admin`)で差し替え可能。既定は no-op(テスト容易性)。本番は WsServer
  側で AuthService 連携の依存(未認証 401・非管理者 403)に差し替える。
- GET 系(list/meta/png/manifest/index.txt)は認可不要(誰でも閲覧可, レート制限のみ)。

ファクトリ `build_chara_router(store, assets_dir, require_admin=None, rate_limiter=None)`
を提供し、アプリ組み込み時に注入する。
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

from app.gfx import convert_colorkey, parse_color_key
from app.store.db import Store

# キャラ標準寸法([08]§6)。不一致は警告のみ(保存は許可)。
CHARA_STD_W, CHARA_STD_H = 96, 160
# アップロード最大サイズ(bytes)。
MAX_UPLOAD_BYTES = 2 * 1024 * 1024
# CR-12: decompression bomb 対策。decode/全画素ループ前に寸法を強制。
# キャラグラは 96x160 が標準。マスク分割(横2倍)も考慮し余裕を持たせるが、
# 巨大画像で CPU/メモリを溶かさない上限を設ける。
MAX_IMAGE_W = 256
MAX_IMAGE_H = 512
MAX_IMAGE_PIXELS = MAX_IMAGE_W * MAX_IMAGE_H  # Pillow の bomb 検知にも使用


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


def _graphic_meta(g) -> dict:
    """ChAraGraphic → REST メタ dict([08]§7.1)。"""
    quoted = urllib.parse.quote(g.gra_name, safe="")
    return {
        "graName": g.gra_name,
        "url": f"/api/chara/graphics/{quoted}/png",
        "width": g.width,
        "height": g.height,
        "colorKey": g.color_key,
        # 寸法不一致は upload 時に 400 拒否するため常に None(応答互換のため残置)。
        "dimensionWarning": None,
        "protected": g.protected,
        "uploadedAt": g.uploaded_at,
    }


def build_chara_router(
    store: Store,
    assets_dir: str | Path,
    *,
    require_admin=None,
    rate_limiter=None,
) -> APIRouter:
    """`/api/chara` ルータを構築。

    require_admin: FastAPI 依存(管理者限定)。変更系(upload/delete/index 編集/
        import)へ適用。未認証 401・非管理者 403。None なら no-op(誰でも通す,
        テスト/開発)。GET 系(list/meta/png/manifest/index.txt)は対象外で、
        誰でも閲覧可(レート制限のまま [08]§10)。
    rate_limiter: RateLimiter(upload 30/min/account)。None なら無制限。
    """
    storage = CharaStorage(assets_dir)
    router = APIRouter(prefix="/api/chara")

    # 管理者依存(変更系)。未指定時は no-op(uploaded_by=None で誰でも通す)。
    if require_admin is None:
        async def _admin() -> str | None:  # noqa: D401
            return None
        admin_dep = _admin
    else:
        admin_dep = require_admin

    def _enforce_get_rate(request: Request) -> None:
        """CR-12: chara GET(無認証配信)を IP 単位でレート制限。"""
        if rate_limiter is None:
            return
        from app.rest.register import client_ip
        ip = client_ip(request)
        if not rate_limiter.allow("chara_get", ip):
            raise HTTPException(429, "リクエストが多すぎます(chara GET)")

    # ------------------------------------------------------------------
    # 7.1 グラフィック
    # ------------------------------------------------------------------

    @router.post("/graphics")
    async def upload_graphic(
        file: UploadFile = File(...),
        graName: str | None = Form(None),
        colorKey: str = Form("teal"),
        account_id: str | None = Depends(admin_dep),
    ) -> dict:
        # アップロードレート制限(30/min/account)。account 不明時は "anon"。
        if rate_limiter is not None:
            if not rate_limiter.allow("upload", account_id or "anon"):
                raise HTTPException(429, "アップロードレート超過(30/分/account)")
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
        # path traversal 対策: 物理名 = lower(graName) で配信するため区切り文字を禁止。
        if any(sep in name for sep in ("/", "\\")) or name in (".", ".."):
            raise HTTPException(400, "graName に使用できない文字(/ \\ .)が含まれます")

        try:
            key_rgb = parse_color_key(colorKey)
        except ValueError as exc:
            raise HTTPException(400, f"colorKey が不正: {exc}") from exc

        # CR-12: decompression bomb 対策。
        # 1) ヘッダのみ open(全画素 decode 前)で寸法を取得し上限検査。
        # 2) Pillow の MAX_IMAGE_PIXELS で多段 bomb も検知。
        # 3) 上限内のみ load()/全画素ループへ進む。
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

        # 透過変換(キャラは colorkey 既定)。寸法検査済みのため全画素ループは安全。
        rgba = convert_colorkey(img, key_rgb)
        w, h = rgba.size

        # 寸法不一致は拒否(キャラ標準 96x160 固定)。
        if (w, h) != (CHARA_STD_W, CHARA_STD_H):
            raise HTTPException(
                400,
                f"キャラ標準 {CHARA_STD_W}x{CHARA_STD_H} と不一致: {w}x{h}",
            )

        # 同名拒否: 物理名(= lower(graName))が既存なら 409。seed/既存アップロード
        # の上書き事故を防ぐ。差し替えは一旦削除してから再アップロード運用とする。
        if store.get_graphic(name) is not None:
            raise HTTPException(409, f"同名グラが既に存在します: {name}")

        orig_sha = hashlib.sha256(raw).hexdigest()
        # stored_name = lower(graName)。/assets/chara/<stored_name>.png で配信解決。
        stored_name = name.lower()

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
        return _graphic_meta(g)

    @router.get("/graphics")
    async def list_graphics(request: Request) -> list[dict]:
        _enforce_get_rate(request)
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
    async def get_graphic_meta(gra_name: str, request: Request) -> dict:
        _enforce_get_rate(request)
        g = store.get_graphic(urllib.parse.unquote(gra_name))
        if g is None:
            raise HTTPException(404, "グラフィック未登録")
        return _graphic_meta(g)

    @router.get("/graphics/{gra_name}/png")
    async def get_graphic_png(gra_name: str, request: Request) -> Response:
        _enforce_get_rate(request)
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
        account_id: str | None = Depends(admin_dep),
    ) -> dict:
        g = store.get_graphic(urllib.parse.unquote(gra_name))
        if g is None:
            raise HTTPException(404, "グラフィック未登録")
        if g.protected:
            raise HTTPException(403, "初期同梱グラは削除できません")
        storage.delete(g.stored_name)
        store.delete_graphic(g.gra_name)
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
        account_id: str | None = Depends(admin_dep),
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
        account_id: str | None = Depends(admin_dep),
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
        account_id: str | None = Depends(admin_dep),
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
    async def manifest(request: Request) -> dict:
        _enforce_get_rate(request)
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
