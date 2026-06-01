"""B14 レート制限([12]§4)。

token bucket(BEメモリ)。レガシーサーバ保護(過剰送信でDM側 BUFFULL 回避)兼用。

| 対象 | 制限 |
|------|------|
| `command.raw` | 10 msg / 10s / session |
| `chat`(全mode) | 20 msg / 10s / session |
| REST upload | 30 req / 分 / account |
| `POST /api/register` | 5 req / 時 / IP |
| WS接続 | 5 接続 / account 同時(=並行カウンタ) |

`move` は制限なし(レガシー側がリピート制御)。

設計
------------------------------------------------------------------
- `TokenBucket`: capacity / refill rate。`allow()` で1トークン消費可否判定。
- `RateLimiter`: キー(対象+識別子)別に bucket をキャッシュ。
- WS同時接続は token bucket でなく **並行カウンタ**(`ConcurrencyLimiter`)。
- 時刻は `time_fn`(既定 monotonic)で注入可能(テスト容易性)。
"""
from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable

# 既定レート([12]§4)。
COMMAND_RAW_RATE = (10, 10.0)     # 10 / 10s
CHAT_RATE = (20, 10.0)            # 20 / 10s
UPLOAD_RATE = (30, 60.0)          # 30 / 60s
REGISTER_RATE = (5, 3600.0)       # 5 / 1h
# CR-11: login 総当たり抑止。account+IP 単位で失敗時のみ消費(成功はリセット)。
LOGIN_RATE = (10, 300.0)          # 10 失敗 / 5分 / (account+IP)
# CR-12: chara GET 系(無認証配信)の IP レート。
CHARA_GET_RATE = (120, 60.0)      # 120 req / 60s / IP
WS_CONN_LIMIT = 5                 # 5 同時 / account

# CR-10: バケット無制限増殖(IP/session 変更による DoS)対策。
# - 満杯時に LRU で最古を退避(eviction)。
# - アイドル(満タン復帰=制限が無意味)バケットは GC で削除。
MAX_BUCKETS = 100_000             # バケット総数上限(超過で LRU eviction)
BUCKET_IDLE_TTL = 3600.0         # 最終アクセスからこの秒数で GC 対象


@dataclass
class TokenBucket:
    """token bucket。capacity 上限、period 秒で capacity 個 refill。"""

    capacity: int
    period: float
    tokens: float = field(init=False)
    last: float = field(init=False)
    # CR-10: GC 判定用の最終アクセス時刻(allow 呼出ごとに更新)。
    last_access: float = field(init=False)

    def __post_init__(self) -> None:
        self.tokens = float(self.capacity)
        self.last = -1.0  # 初回 allow で now 初期化
        self.last_access = -1.0

    def is_idle(self, now: float, ttl: float) -> bool:
        """満タン復帰済み(=制限が無意味)かつ TTL 超アイドルなら GC 可。"""
        if self.last_access < 0:
            return False
        if now - self.last_access < ttl:
            return False
        # 経過分を加味した推定トークン量が容量到達なら退避して良い。
        elapsed = now - self.last
        refilled = self.tokens + max(0.0, elapsed) * self.rate
        return refilled >= self.capacity

    @property
    def rate(self) -> float:
        """1秒あたり refill トークン数。"""
        return self.capacity / self.period

    def allow(self, now: float) -> bool:
        """1トークン消費を試みる。可なら True(消費)、不可なら False。"""
        self.last_access = now
        if self.last < 0:
            self.last = now
        else:
            elapsed = now - self.last
            if elapsed > 0:
                self.tokens = min(
                    self.capacity, self.tokens + elapsed * self.rate
                )
                self.last = now
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        return False


class RateLimiter:
    """対象別(capacity, period)を保持し、キー単位で bucket を管理。

    CR-10: バケット無制限増殖(IP/session を変えるだけの DoS)対策として、
    総数上限(`max_buckets`)で LRU eviction、TTL(`idle_ttl`)超のアイドル
    バケットを GC する。LRU 順序は `OrderedDict` の挿入/移動で表現。
    """

    def __init__(
        self,
        time_fn: Callable[[], float] | None = None,
        *,
        max_buckets: int = MAX_BUCKETS,
        idle_ttl: float = BUCKET_IDLE_TTL,
    ) -> None:
        self._time = time_fn or time.monotonic
        self._max_buckets = max_buckets
        self._idle_ttl = idle_ttl
        # 対象名 → (capacity, period)
        self._specs: dict[str, tuple[int, float]] = {
            "command.raw": COMMAND_RAW_RATE,
            "chat": CHAT_RATE,
            "upload": UPLOAD_RATE,
            "register": REGISTER_RATE,
            # CR-12: chara GET(png/list/manifest)を IP 単位でレート制限。
            "chara_get": CHARA_GET_RATE,
        }
        # (対象, キー) → TokenBucket。OrderedDict で LRU(末尾=最近使用)。
        self._buckets: "OrderedDict[tuple[str, str], TokenBucket]" = OrderedDict()

    def allow(self, target: str, key: str) -> bool:
        """*target*(command.raw/chat/upload/register)を *key* 単位で判定。

        未知 target は常に許可(制限なし: move 等)。
        """
        spec = self._specs.get(target)
        if spec is None:
            return True
        now = self._time()
        bucket = self._buckets.get((target, key))
        if bucket is None:
            self._gc(now)
            self._evict_if_full()
            bucket = TokenBucket(spec[0], spec[1])
            self._buckets[(target, key)] = bucket
        else:
            # LRU: アクセスで末尾へ移動。
            self._buckets.move_to_end((target, key))
        return bucket.allow(now)

    def _gc(self, now: float) -> None:
        """満タン復帰済み&TTL 超のアイドルバケットを削除(CR-10)。"""
        ttl = self._idle_ttl
        stale = [
            k for k, b in self._buckets.items() if b.is_idle(now, ttl)
        ]
        for k in stale:
            del self._buckets[k]

    def _evict_if_full(self) -> None:
        """総数上限超過なら LRU(先頭=最古)を退避(CR-10)。"""
        while len(self._buckets) >= self._max_buckets:
            self._buckets.popitem(last=False)

    def bucket_count(self) -> int:
        """現在のバケット数(テスト/監視用)。"""
        return len(self._buckets)

    def reset(self) -> None:
        self._buckets.clear()


class LoginThrottle:
    """CR-11: login 総当たり抑止(account+IP 失敗バックオフ)。

    token bucket を流用。`check()` で残トークンを見て許可判定し、認証**失敗時のみ**
    `record_failure()` で 1 消費、**成功時** `reset_key()` でバケット解放。
    これにより正規ログイン(成功)はカウントされず、連続失敗のみ抑止される。
    バケットは TTL/LRU(`RateLimiter` と同じ)で GC し無制限増殖を防ぐ。
    """

    def __init__(
        self,
        time_fn: Callable[[], float] | None = None,
        *,
        rate: tuple[int, float] = LOGIN_RATE,
        max_buckets: int = MAX_BUCKETS,
        idle_ttl: float = BUCKET_IDLE_TTL,
    ) -> None:
        self._time = time_fn or time.monotonic
        self._cap, self._period = rate
        self._max_buckets = max_buckets
        self._idle_ttl = idle_ttl
        self._buckets: "OrderedDict[str, TokenBucket]" = OrderedDict()

    @staticmethod
    def make_key(account_id: str, ip: str) -> str:
        return f"{account_id}\x00{ip}"

    def _gc(self, now: float) -> None:
        stale = [k for k, b in self._buckets.items() if b.is_idle(now, self._idle_ttl)]
        for k in stale:
            del self._buckets[k]

    def _get(self, key: str, *, create: bool) -> TokenBucket | None:
        b = self._buckets.get(key)
        if b is not None:
            self._buckets.move_to_end(key)
            return b
        if not create:
            return None
        now = self._time()
        self._gc(now)
        while len(self._buckets) >= self._max_buckets:
            self._buckets.popitem(last=False)
        b = TokenBucket(self._cap, self._period)
        self._buckets[key] = b
        return b

    def check(self, account_id: str, ip: str) -> bool:
        """試行を許可してよいか(トークン残あり)を判定(消費しない)。"""
        b = self._get(self.make_key(account_id, ip), create=False)
        if b is None:
            return True
        now = self._time()
        b.last_access = now
        # refill だけ反映してトークン残を覗く(消費しない)。
        if b.last < 0:
            return b.tokens >= 1.0
        elapsed = now - b.last
        projected = min(b.capacity, b.tokens + max(0.0, elapsed) * b.rate)
        return projected >= 1.0

    def record_failure(self, account_id: str, ip: str) -> None:
        """認証失敗を記録(1 トークン消費)。枯渇後の以降の試行を抑止。"""
        b = self._get(self.make_key(account_id, ip), create=True)
        assert b is not None
        b.allow(self._time())

    def reset_key(self, account_id: str, ip: str) -> None:
        """認証成功でバケット解放(失敗カウントをリセット)。"""
        self._buckets.pop(self.make_key(account_id, ip), None)

    def bucket_count(self) -> int:
        return len(self._buckets)

    def reset(self) -> None:
        self._buckets.clear()


class ConcurrencyLimiter:
    """WS同時接続数の並行カウンタ(account 単位)。"""

    def __init__(self, limit: int = WS_CONN_LIMIT) -> None:
        self._limit = limit
        self._counts: dict[str, int] = {}

    def acquire(self, key: str) -> bool:
        """1接続分を確保。上限超過なら False(確保せず)。"""
        cur = self._counts.get(key, 0)
        if cur >= self._limit:
            return False
        self._counts[key] = cur + 1
        return True

    def release(self, key: str) -> None:
        """1接続分を解放(冪等。0未満にはしない)。"""
        cur = self._counts.get(key, 0)
        if cur <= 1:
            self._counts.pop(key, None)
        else:
            self._counts[key] = cur - 1

    def count(self, key: str) -> int:
        return self._counts.get(key, 0)
