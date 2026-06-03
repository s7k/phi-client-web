"""B10 REST chara API テスト([08]§7)。

FastAPI TestClient でアップロード→変換→取得、index 往復、manifest を検証。
Store は :memory:、アセットは tmp_path。
"""
from __future__ import annotations

import io

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from PIL import Image

from app.gfx import CL_TEAL
from app.rest.chara import build_chara_router
from app.store.db import Store


def _bmp_bytes(color=(255, 0, 0), size=(96, 160), teal_corner=True) -> bytes:
    """合成 BMP。左上1px を teal にして透過確認用。"""
    img = Image.new("RGB", size, color)
    if teal_corner:
        img.putpixel((0, 0), CL_TEAL)
    buf = io.BytesIO()
    img.save(buf, format="BMP")
    return buf.getvalue()


@pytest.fixture
def client(tmp_path):
    store = Store.open(":memory:")
    app = FastAPI()
    app.include_router(build_chara_router(store, tmp_path / "assets"))
    c = TestClient(app)
    c._store = store  # type: ignore[attr-defined]
    yield c
    store.close()


# --- グラフィック ---------------------------------------------------------

def test_upload_converts_and_stores(client):
    bmp = _bmp_bytes()
    r = client.post(
        "/api/chara/graphics",
        files={"file": ("野ネズミ.bmp", bmp, "image/bmp")},
        data={"graName": "野ネズミ", "colorKey": "teal"},
    )
    assert r.status_code == 200, r.text
    meta = r.json()
    assert meta["graName"] == "野ネズミ"
    assert meta["width"] == 96 and meta["height"] == 160
    assert meta["colorKey"] == "teal"
    assert meta["dimensionWarning"] is None
    # PNG 配信 → teal が透過されていること
    r2 = client.get(meta["url"])
    assert r2.status_code == 200
    assert r2.headers["content-type"] == "image/png"
    png = Image.open(io.BytesIO(r2.content)).convert("RGBA")
    assert png.getpixel((0, 0)) == (0, 0, 0, 0)        # teal → 透明
    assert png.getpixel((1, 0)) == (255, 0, 0, 255)    # 赤 → 不透明


def test_upload_default_gra_name_from_filename(client):
    r = client.post(
        "/api/chara/graphics",
        files={"file": ("t_Elf.bmp", _bmp_bytes(), "image/bmp")},
    )
    assert r.status_code == 200
    assert r.json()["graName"] == "t_Elf"


def test_upload_dimension_mismatch_rejected(client):
    """キャラ標準 96x160 と不一致は 400 で拒否。"""
    bmp = _bmp_bytes(size=(32, 32))
    r = client.post(
        "/api/chara/graphics",
        files={"file": ("x.bmp", bmp, "image/bmp")},
        data={"graName": "small"},
    )
    assert r.status_code == 400, r.text


def test_upload_duplicate_name_rejected(client):
    """同名(物理名 = lower(graName))の二重アップロードは 409。"""
    bmp = _bmp_bytes()
    r1 = client.post(
        "/api/chara/graphics",
        files={"file": ("a.bmp", bmp, "image/bmp")},
        data={"graName": "dup"},
    )
    assert r1.status_code == 200, r1.text
    r2 = client.post(
        "/api/chara/graphics",
        files={"file": ("a.bmp", bmp, "image/bmp")},
        data={"graName": "dup"},
    )
    assert r2.status_code == 409, r2.text


def test_upload_path_separator_rejected(client):
    """graName に区切り文字を含む(path traversal)は 400。"""
    r = client.post(
        "/api/chara/graphics",
        files={"file": ("a.bmp", _bmp_bytes(), "image/bmp")},
        data={"graName": "../evil"},
    )
    assert r.status_code == 400, r.text


def test_upload_invalid_image(client):
    r = client.post(
        "/api/chara/graphics",
        files={"file": ("x.bmp", b"not an image", "image/bmp")},
        data={"graName": "bad"},
    )
    assert r.status_code == 400


# --- CR-12: decompression bomb / 巨大画像拒否 ----------------------------

def test_upload_oversized_dimensions_rejected(client):
    """寸法上限(256x512)超の画像は decode/変換前に 413 で拒否。"""
    big = _bmp_bytes(size=(300, 300))  # 幅 300 > MAX_IMAGE_W=256
    r = client.post(
        "/api/chara/graphics",
        files={"file": ("big.bmp", big, "image/bmp")},
        data={"graName": "big"},
    )
    assert r.status_code == 413, r.text


def test_upload_pixel_bomb_rejected(client):
    """総画素が上限超の画像も 413(全画素ループ前に拒否)。"""
    # 256x512=131072 が上限。513 行で超過。幅は上限内。
    bomb = _bmp_bytes(size=(256, 513))
    r = client.post(
        "/api/chara/graphics",
        files={"file": ("bomb.bmp", bomb, "image/bmp")},
        data={"graName": "bomb"},
    )
    assert r.status_code == 413, r.text


def test_upload_within_limits_ok(client):
    """標準寸法(96x160)は許可される。"""
    ok = _bmp_bytes(size=(96, 160))
    r = client.post(
        "/api/chara/graphics",
        files={"file": ("ok.bmp", ok, "image/bmp")},
        data={"graName": "ok"},
    )
    assert r.status_code == 200, r.text


# --- CR-12: chara GET レート制限 -----------------------------------------

def test_chara_get_rate_limited(tmp_path):
    """rate_limiter 注入時、GET png は IP レート超過で 429。"""
    from app.ratelimit import RateLimiter
    store = Store.open(":memory:")
    app = FastAPI()
    # chara_get を 2 req に絞った RateLimiter。
    rl = RateLimiter()
    rl._specs["chara_get"] = (2, 60.0)
    app.include_router(build_chara_router(store, tmp_path / "assets",
                                          rate_limiter=rl))
    c = TestClient(app)
    # まず1件アップロード(upload レートは別枠)。
    c.post("/api/chara/graphics",
           files={"file": ("a.bmp", _bmp_bytes(), "image/bmp")},
           data={"graName": "g"})
    url = "/api/chara/graphics/g/png"
    assert c.get(url).status_code == 200
    assert c.get(url).status_code == 200
    assert c.get(url).status_code == 429  # 3回目超過
    store.close()


def test_case_insensitive_resolution(client):
    client.post(
        "/api/chara/graphics",
        files={"file": ("a.bmp", _bmp_bytes(), "image/bmp")},
        data={"graName": "T_Lord"},
    )
    # 小文字で取得できる(case-insensitive)
    r = client.get("/api/chara/graphics/t_lord")
    assert r.status_code == 200
    assert r.json()["graName"] == "T_Lord"


def test_list_and_delete(client):
    client.post(
        "/api/chara/graphics",
        files={"file": ("a.bmp", _bmp_bytes(), "image/bmp")},
        data={"graName": "g1"},
    )
    assert len(client.get("/api/chara/graphics").json()) == 1
    r = client.delete("/api/chara/graphics/g1")
    assert r.status_code == 200
    assert len(client.get("/api/chara/graphics").json()) == 0
    assert client.get("/api/chara/graphics/g1").status_code == 404


def test_get_meta_404(client):
    assert client.get("/api/chara/graphics/nope").status_code == 404


# --- Index ----------------------------------------------------------------

def test_index_put_get_delete(client):
    r = client.put("/api/chara/index/intelligent", json={"graName": "t_elf"})
    assert r.status_code == 200
    lst = client.get("/api/chara/index").json()
    assert {"key": "intelligent", "graName": "t_elf"} in lst
    assert client.delete("/api/chara/index/intelligent").status_code == 200
    assert client.delete("/api/chara/index/intelligent").status_code == 404


def test_index_import_export_roundtrip(client):
    # cp932 の Index.txt 取込
    src = "// comment\n知的生物 = LANU_Oyaji.bmp\nbeast = t_dog.bmp\n"
    raw = src.encode("cp932")
    r = client.post(
        "/api/chara/index/import",
        files={"file": ("Index.txt", raw, "text/plain")},
    )
    assert r.status_code == 200
    assert r.json()["imported"] == 2
    # export(utf-8): .bmp 付きで往復
    r2 = client.get("/api/chara/index.txt")
    assert r2.status_code == 200
    text = r2.content.decode("utf-8")
    assert "知的生物 = LANU_Oyaji.bmp" in text
    assert "beast = t_dog.bmp" in text
    # export(cp932)
    r3 = client.get("/api/chara/index.txt?charset=cp932")
    assert "知的生物".encode("cp932") in r3.content


# --- 管理者ゲート(変更系: 管理者限定 [08]§10) --------------------------

@pytest.fixture
def gated_app(tmp_path):
    """require_admin を注入したアプリ。account が admins 集合内なら管理者。

    依存は X-Test-Account ヘッダの account id を見る簡易スタブ。
    - ヘッダ無し → 401(未認証)。
    - admins に無い → 403(非管理者)。
    - admins にある → account_id を返す(管理者)。
    """
    store = Store.open(":memory:")
    # ID-only: uploaded_by は id_key(FK なし)。スタブ依存で管理者集合を判定。
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
        build_chara_router(store, tmp_path / "assets", require_admin=require_admin)
    )
    c = TestClient(app)
    c._store = store  # type: ignore[attr-defined]
    yield c
    store.close()


def _upload(c, headers=None):
    return c.post(
        "/api/chara/graphics",
        files={"file": ("g.bmp", _bmp_bytes(), "image/bmp")},
        data={"graName": "g", "colorKey": "teal"},
        headers=headers or {},
    )


def test_upload_admin_200(gated_app):
    r = _upload(gated_app, {"X-Test-Account": "admin1"})
    assert r.status_code == 200, r.text
    assert r.json()["graName"] == "g"


def test_upload_non_admin_403(gated_app):
    r = _upload(gated_app, {"X-Test-Account": "user1"})
    assert r.status_code == 403


def test_upload_unauthenticated_401(gated_app):
    r = _upload(gated_app)
    assert r.status_code == 401


def test_index_put_admin_only(gated_app):
    # 未認証 401 / 非管理者 403 / 管理者 200。
    assert gated_app.put(
        "/api/chara/index/k", json={"graName": "g"}
    ).status_code == 401
    assert gated_app.put(
        "/api/chara/index/k", json={"graName": "g"},
        headers={"X-Test-Account": "user1"},
    ).status_code == 403
    assert gated_app.put(
        "/api/chara/index/k", json={"graName": "g"},
        headers={"X-Test-Account": "admin1"},
    ).status_code == 200


def test_index_delete_and_import_admin_only(gated_app):
    # import: 非管理者 403。
    raw = "beast = t_dog.bmp\n".encode("cp932")
    assert gated_app.post(
        "/api/chara/index/import",
        files={"file": ("Index.txt", raw, "text/plain")},
        headers={"X-Test-Account": "user1"},
    ).status_code == 403
    # import: 管理者 200。
    assert gated_app.post(
        "/api/chara/index/import",
        files={"file": ("Index.txt", raw, "text/plain")},
        headers={"X-Test-Account": "admin1"},
    ).status_code == 200
    # delete: 未認証 401。
    assert gated_app.delete("/api/chara/index/beast").status_code == 401
    # delete: 管理者 200。
    assert gated_app.delete(
        "/api/chara/index/beast", headers={"X-Test-Account": "admin1"}
    ).status_code == 200


def test_delete_graphic_admin_only(gated_app):
    # 管理者でアップロード後、非管理者 delete は 403。
    _upload(gated_app, {"X-Test-Account": "admin1"})
    assert gated_app.delete(
        "/api/chara/graphics/g", headers={"X-Test-Account": "user1"}
    ).status_code == 403
    assert gated_app.delete(
        "/api/chara/graphics/g", headers={"X-Test-Account": "admin1"}
    ).status_code == 200


def test_delete_protected_seed_forbidden(client):
    """protected=1(seed)のグラは管理者でも削除不可(403)。"""
    store = client._store  # type: ignore[attr-defined]
    store.upsert_graphic(
        "seedgra", "seedgra", "/x/seedgra.png", 96, 160, "shaseed",
        protected=True,
    )
    r = client.delete("/api/chara/graphics/seedgra")
    assert r.status_code == 403, r.text
    # 一覧では protected フラグが立つ。
    items = client.get("/api/chara/graphics").json()
    assert any(g["graName"] == "seedgra" and g["protected"] for g in items)


def test_get_endpoints_open_to_anyone(gated_app):
    # GET 系は認可不要(管理者ゲート対象外)。未認証でも 200。
    gated_app.post(
        "/api/chara/graphics",
        files={"file": ("g.bmp", _bmp_bytes(), "image/bmp")},
        data={"graName": "g"},
        headers={"X-Test-Account": "admin1"},
    )
    assert gated_app.get("/api/chara/graphics").status_code == 200
    assert gated_app.get("/api/chara/graphics/g").status_code == 200
    assert gated_app.get("/api/chara/graphics/g/png").status_code == 200
    assert gated_app.get("/api/chara/index").status_code == 200
    assert gated_app.get("/api/chara/index.txt").status_code == 200
    assert gated_app.get("/api/chara/manifest").status_code == 200


# --- マニフェスト ---------------------------------------------------------

def test_manifest(client):
    client.post(
        "/api/chara/graphics",
        files={"file": ("a.bmp", _bmp_bytes(), "image/bmp")},
        data={"graName": "野ネズミ"},
    )
    client.put("/api/chara/index/beast", json={"graName": "t_dog"})
    m = client.get("/api/chara/manifest").json()
    assert "野ネズミ" in m["graphics"]
    assert m["graphics"]["野ネズミ"].endswith("/png")
    assert m["index"]["beast"] == "t_dog"
