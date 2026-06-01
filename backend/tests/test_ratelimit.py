"""B14 レート制限 テスト([12]§4)。"""
from __future__ import annotations

from app.ratelimit import (
    ConcurrencyLimiter,
    LoginThrottle,
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


# --- CR-10: バケット LRU eviction / TTL GC --------------------------------

def test_bucket_lru_eviction_caps_total():
    clk = FakeClock()
    rl = RateLimiter(time_fn=clk, max_buckets=3, idle_ttl=10_000.0)
    # 4 個の異なるキーで bucket 生成 → 上限 3 で最古が退避される。
    for i in range(4):
        rl.allow("register", f"ip{i}")
    assert rl.bucket_count() == 3
    # 最古(ip0)が退避され、ip1..ip3 が残る。
    # ip0 は再作成扱い(=満タン)になるため allow True。
    assert rl.allow("register", "ip0")


def test_bucket_gc_removes_idle_full_buckets():
    clk = FakeClock()
    # idle_ttl=100s。register は 5/3600s。1 消費後 100s 放置でも満タン復帰せず
    # (refill 遅い)→ GC されない。フル復帰するまで放置すれば GC。
    rl = RateLimiter(time_fn=clk, max_buckets=1000, idle_ttl=100.0)
    rl.allow("upload", "a")  # upload=30/60s。1 消費。
    assert rl.bucket_count() == 1
    clk.advance(200.0)  # 満タン復帰(60s で 30 個)+ TTL 超過。
    # 新キー追加時に GC 走行 → アイドルの "a" が消える。
    rl.allow("upload", "b")
    # a は GC 済み、b のみ。
    assert rl.bucket_count() == 1


def test_bucket_gc_keeps_active_limited_bucket():
    clk = FakeClock()
    rl = RateLimiter(time_fn=clk, max_buckets=1000, idle_ttl=100.0)
    # register を使い切る(5 消費)。トークン枯渇のためアイドルでも GC 不可
    # (満タン復帰していない)。
    for _ in range(5):
        rl.allow("register", "x")
    clk.advance(200.0)  # TTL 超だが refill は遅い(5/3600s)→ 満タン未満。
    rl.allow("upload", "y")  # GC トリガ。
    # x は枯渇中なので保持される(制限がまだ有効)。
    assert ("register", "x") in rl._buckets


# --- CR-11: LoginThrottle(account+IP 失敗バックオフ) --------------------

def test_login_throttle_allows_until_failures_exhaust():
    clk = FakeClock()
    lt = LoginThrottle(time_fn=clk, rate=(3, 300.0))
    # 失敗を3回記録するまでは check True、4回目で False。
    for _ in range(3):
        assert lt.check("alice", "1.2.3.4")
        lt.record_failure("alice", "1.2.3.4")
    assert not lt.check("alice", "1.2.3.4")  # 枯渇


def test_login_throttle_success_resets():
    clk = FakeClock()
    lt = LoginThrottle(time_fn=clk, rate=(3, 300.0))
    for _ in range(3):
        lt.record_failure("bob", "1.1.1.1")
    assert not lt.check("bob", "1.1.1.1")
    lt.reset_key("bob", "1.1.1.1")  # 認証成功でリセット。
    assert lt.check("bob", "1.1.1.1")


def test_login_throttle_account_ip_independent():
    clk = FakeClock()
    lt = LoginThrottle(time_fn=clk, rate=(2, 300.0))
    for _ in range(2):
        lt.record_failure("a", "9.9.9.9")
    assert not lt.check("a", "9.9.9.9")
    # 同 account でも別 IP は独立。
    assert lt.check("a", "8.8.8.8")
    # 同 IP でも別 account は独立。
    assert lt.check("b", "9.9.9.9")


def test_login_throttle_refill_over_time():
    clk = FakeClock()
    lt = LoginThrottle(time_fn=clk, rate=(2, 100.0))  # 0.02/s
    lt.record_failure("c", "1")
    lt.record_failure("c", "1")
    assert not lt.check("c", "1")
    clk.advance(60.0)  # +1 token
    assert lt.check("c", "1")


def test_login_throttle_bucket_gc():
    clk = FakeClock()
    lt = LoginThrottle(time_fn=clk, rate=(2, 100.0), max_buckets=1000,
                       idle_ttl=50.0)
    lt.record_failure("d", "1")
    assert lt.bucket_count() == 1
    clk.advance(200.0)  # 満タン復帰 + TTL 超。
    lt.record_failure("e", "2")  # GC トリガ。
    assert lt.bucket_count() == 1  # d は GC 済み。


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
