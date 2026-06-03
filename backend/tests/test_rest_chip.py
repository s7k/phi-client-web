"""REST chip API テスト(マップチップシート)。

入力左右分割(1024x96)→ convert_chip → 512x96 透過PNG、寸法/同名/protected/管理者ゲート。
Store は :memory:、アセットは tmp_path。
"""
from __future__ import annotations

import io

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from PIL import Image

from app.rest.chip import build_chip_router
from app.store.db import Store


def _chip_bytes(size=(1024, 96)) -> bytes:
    """合成 BMP(左=画像/右=マスク)。右半分を白で塗り不透明領域を作る。"""
    w, h = size
    img = Image.new("RGB", size, (255, 0, 0))
    if w % 2 == 0:
        half = w // 2
        for y in range(h):
            for x in range(half, w):
                img.putpixel((x, y), (255, 255, 255))  # マスク白=不透明
    buf = io.BytesIO()
    img.save(buf, format="BMP")
    return buf.getvalue()


@pytest.fixture
def client(tmp_path):
    store = Store.open(":memory:")
    app = FastAPI()
    app.include_router(build_chip_router(store, tmp_path / "assets"))
    c = TestClient(app)
    c._store = store  # type: ignore[attr-defined]
    yield c
    store.close()


def test_upload_converts_to_512x96(client):
    r = client.post(
        "/api/chip/graphics",
        files={"file": ("Town.bmp", _chip_bytes(), "image/bmp")},
        data={"mapset": "Town"},
    )
    assert r.status_code == 200, r.text
    meta = r.json()
    assert meta["mapset"] == "Town"
    assert meta["width"] == 512 and meta["height"] == 96
    # 配信 PNG が 512x96 RGBA
    r2 = client.get(meta["url"])
    assert r2.status_code == 200
    png = Image.open(io.BytesIO(r2.content)).convert("RGBA")
    assert png.size == (512, 96)


def test_upload_dimension_mismatch_rejected(client):
    r = client.post(
        "/api/chip/graphics",
        files={"file": ("x.bmp", _chip_bytes(size=(512, 96)), "image/bmp")},
        data={"mapset": "bad"},
    )
    assert r.status_code == 400, r.text


def test_upload_duplicate_name_rejected(client):
    r1 = client.post(
        "/api/chip/graphics",
        files={"file": ("a.bmp", _chip_bytes(), "image/bmp")},
        data={"mapset": "dup"},
    )
    assert r1.status_code == 200, r1.text
    r2 = client.post(
        "/api/chip/graphics",
        files={"file": ("a.bmp", _chip_bytes(), "image/bmp")},
        data={"mapset": "dup"},
    )
    assert r2.status_code == 409, r2.text


def test_upload_path_separator_rejected(client):
    r = client.post(
        "/api/chip/graphics",
        files={"file": ("a.bmp", _chip_bytes(), "image/bmp")},
        data={"mapset": "../evil"},
    )
    assert r.status_code == 400, r.text


def test_case_insensitive_and_list(client):
    client.post(
        "/api/chip/graphics",
        files={"file": ("a.bmp", _chip_bytes(), "image/bmp")},
        data={"mapset": "Forest"},
    )
    assert client.get("/api/chip/graphics/forest").status_code == 200
    lst = client.get("/api/chip/graphics").json()
    assert any(c["mapset"] == "Forest" for c in lst)


def test_delete_and_404(client):
    client.post(
        "/api/chip/graphics",
        files={"file": ("a.bmp", _chip_bytes(), "image/bmp")},
        data={"mapset": "g1"},
    )
    assert client.delete("/api/chip/graphics/g1").status_code == 200
    assert client.get("/api/chip/graphics/g1").status_code == 404
    assert client.delete("/api/chip/graphics/g1").status_code == 404


def test_delete_protected_seed_forbidden(client):
    store = client._store  # type: ignore[attr-defined]
    store.upsert_chip(
        "seedchip", "seedchip", "/x/seedchip.png", 512, 96, "shaseed",
        protected=True,
    )
    r = client.delete("/api/chip/graphics/seedchip")
    assert r.status_code == 403, r.text
    items = client.get("/api/chip/graphics").json()
    assert any(c["mapset"] == "seedchip" and c["protected"] for c in items)


# --- 管理者ゲート -----------------------------------------------------------

@pytest.fixture
def gated_app(tmp_path):
    store = Store.open(":memory:")
    admins = {"admin1"}

    async def require_admin(request: Request) -> str:
        acc = request.headers.get("X-Test-Account")
        if not acc:
            raise HTTPException(401, "未認証")
        if acc not in admins:
            raise HTTPException(403, "管理者権限が必要")
        return acc

    app = FastAPI()
    app.include_router(
        build_chip_router(store, tmp_path / "assets", require_admin=require_admin)
    )
    c = TestClient(app)
    yield c
    store.close()


def _upload(c, headers=None):
    return c.post(
        "/api/chip/graphics",
        files={"file": ("g.bmp", _chip_bytes(), "image/bmp")},
        data={"mapset": "g"},
        headers=headers or {},
    )


def test_upload_admin_gate(gated_app):
    assert _upload(gated_app).status_code == 401
    assert _upload(gated_app, {"X-Test-Account": "user1"}).status_code == 403
    assert _upload(gated_app, {"X-Test-Account": "admin1"}).status_code == 200


def test_get_open_to_anyone(gated_app):
    _upload(gated_app, {"X-Test-Account": "admin1"})
    assert gated_app.get("/api/chip/graphics").status_code == 200
    assert gated_app.get("/api/chip/graphics/g").status_code == 200
    assert gated_app.get("/api/chip/graphics/g/png").status_code == 200
