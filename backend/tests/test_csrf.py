"""CSRF Origin/Referer 検査 テスト([12]§1.3)。"""
from __future__ import annotations

from app.csrf import is_origin_allowed

ALLOWED = {"https://phi.example.com"}


def test_safe_methods_always_allowed():
    assert is_origin_allowed("GET", None, None, ALLOWED)
    assert is_origin_allowed("HEAD", "https://evil.com", None, ALLOWED)
    assert is_origin_allowed("OPTIONS", None, None, ALLOWED)


def test_no_allowed_set_skips_check():
    assert is_origin_allowed("POST", "https://evil.com", None, None)


def test_post_origin_match():
    assert is_origin_allowed("POST", "https://phi.example.com", None, ALLOWED)


def test_post_origin_mismatch():
    assert not is_origin_allowed("POST", "https://evil.com", None, ALLOWED)


def test_post_referer_fallback():
    assert is_origin_allowed(
        "POST", None, "https://phi.example.com/page", ALLOWED
    )
    assert not is_origin_allowed(
        "POST", None, "https://evil.com/page", ALLOWED
    )


def test_post_no_origin_no_referer_rejected():
    assert not is_origin_allowed("POST", None, None, ALLOWED)


def test_origin_with_port():
    allowed = {"http://localhost:5173"}
    assert is_origin_allowed("POST", "http://localhost:5173", None, allowed)
    assert not is_origin_allowed("POST", "http://localhost:3000", None, allowed)
