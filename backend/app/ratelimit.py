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
from dataclasses import dataclass, field
from typing import Callable

# 既定レート([12]§4)。
COMMAND_RAW_RATE = (10, 10.0)     # 10 / 10s
CHAT_RATE = (20, 10.0)            # 20 / 10s
UPLOAD_RATE = (30, 60.0)          # 30 / 60s
REGISTER_RATE = (5, 3600.0)       # 5 / 1h
WS_CONN_LIMIT = 5                 # 5 同時 / account


@dataclass
class TokenBucket:
    """token bucket。capacity 上限、period 秒で capacity 個 refill。"""

    capacity: int
    period: float
    tokens: float = field(init=False)
    last: float = field(init=False)

    def __post_init__(self) -> None:
        self.tokens = float(self.capacity)
        self.last = -1.0  # 初回 allow で now 初期化

    @property
    def rate(self) -> float:
        """1秒あたり refill トークン数。"""
        return self.capacity / self.period

    def allow(self, now: float) -> bool:
        """1トークン消費を試みる。可なら True(消費)、不可なら False。"""
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
    """対象別(capacity, period)を保持し、キー単位で bucket を管理。"""

    def __init__(self, time_fn: Callable[[], float] | None = None) -> None:
        self._time = time_fn or time.monotonic
        # 対象名 → (capacity, period)
        self._specs: dict[str, tuple[int, float]] = {
            "command.raw": COMMAND_RAW_RATE,
            "chat": CHAT_RATE,
            "upload": UPLOAD_RATE,
            "register": REGISTER_RATE,
        }
        # (対象, キー) → TokenBucket
        self._buckets: dict[tuple[str, str], TokenBucket] = {}

    def allow(self, target: str, key: str) -> bool:
        """*target*(command.raw/chat/upload/register)を *key* 単位で判定。

        未知 target は常に許可(制限なし: move 等)。
        """
        spec = self._specs.get(target)
        if spec is None:
            return True
        bucket = self._buckets.get((target, key))
        if bucket is None:
            bucket = TokenBucket(spec[0], spec[1])
            self._buckets[(target, key)] = bucket
        return bucket.allow(self._time())

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
