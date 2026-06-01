"""B14 レート制限 テスト([12]§4)。"""
from __future__ import annotations

from app.ratelimit import (
    ConcurrencyLimiter,
    RateLimiter,
    TokenBucket,
)


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


# --- TokenBucket ----------------------------------------------------------

def test_bucket_capacity_then_block():
    clk = FakeClock()
    b = TokenBucket(3, 10.0)
    assert b.allow(clk()) is True
    assert b.allow(clk()) is True
    assert b.allow(clk()) is True
    assert b.allow(clk()) is False  # 容量超過


def test_bucket_refill_over_time():
    clk = FakeClock()
    b = TokenBucket(2, 10.0)  # 0.2 token/s
    assert b.allow(clk())
    assert b.allow(clk())
    assert not b.allow(clk())
    clk.advance(5.0)  # +1 token
    assert b.allow(clk())
    assert not b.allow(clk())


# --- RateLimiter ----------------------------------------------------------

def test_command_raw_10_per_10s():
    clk = FakeClock()
    rl = RateLimiter(time_fn=clk)
    for _ in range(10):
        assert rl.allow("command.raw", "sess1")
    assert not rl.allow("command.raw", "sess1")
    # 別 session は独立
    assert rl.allow("command.raw", "sess2")


def test_chat_20_per_10s():
    clk = FakeClock()
    rl = RateLimiter(time_fn=clk)
    for _ in range(20):
        assert rl.allow("chat", "s")
    assert not rl.allow("chat", "s")


def test_unknown_target_unlimited():
    rl = RateLimiter()
    for _ in range(100):
        assert rl.allow("move", "s")


def test_register_5_per_hour_per_ip():
    clk = FakeClock()
    rl = RateLimiter(time_fn=clk)
    for _ in range(5):
        assert rl.allow("register", "1.2.3.4")
    assert not rl.allow("register", "1.2.3.4")
    assert rl.allow("register", "5.6.7.8")  # 別 IP は独立


def test_upload_30_per_min():
    clk = FakeClock()
    rl = RateLimiter(time_fn=clk)
    for _ in range(30):
        assert rl.allow("upload", "acc")
    assert not rl.allow("upload", "acc")
    clk.advance(60.0)
    assert rl.allow("upload", "acc")


# --- ConcurrencyLimiter ---------------------------------------------------

def test_ws_conn_limit_5_per_account():
    cl = ConcurrencyLimiter(limit=5)
    for _ in range(5):
        assert cl.acquire("acc")
    assert not cl.acquire("acc")  # 6本目拒否
    assert cl.count("acc") == 5
    cl.release("acc")
    assert cl.acquire("acc")  # 解放で空き


def test_ws_conn_per_account_independent():
    cl = ConcurrencyLimiter(limit=2)
    assert cl.acquire("a")
    assert cl.acquire("a")
    assert not cl.acquire("a")
    assert cl.acquire("b")


def test_release_idempotent_no_negative():
    cl = ConcurrencyLimiter(limit=2)
    cl.release("x")  # 未確保でも安全
    assert cl.count("x") == 0
    cl.acquire("x")
    cl.release("x")
    cl.release("x")
    assert cl.count("x") == 0
