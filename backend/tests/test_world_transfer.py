"""B13 世界移動(#ch-srv)ハンドシェイク テスト([07]§6.10, DEVLOG)。

FakeSocket 2 台(元/宛先)で reserve→rsv-ok→trans→trs-ok→ch-srv-ok→swap→
再ログインの全手順を検証。成功時 Store.last_server 更新と worldTransfer 通知。
"""
from __future__ import annotations

import asyncio

import pytest

from app.session import SessionManager
from app.store.db import Store


class FakeSocket:
    """LegacySocket 互換のインメモリ偽物(world transfer 用)。"""

    def __init__(self, name: str = "") -> None:
        self.name = name
        self.sent: list[bytes] = []
        self._q: asyncio.Queue = asyncio.Queue()
        self.connected = False
        self.connect_calls: list[tuple[str, int]] = []
        self.closed = False

    async def connect(self, host: str, port: int, timeout: float = 10.0) -> None:
        self.connect_calls.append((host, port))
        self.connected = True

    async def close(self) -> None:
        self.connected = False
        self.closed = True
        self._q.put_nowait(None)

    async def send_line(self, text: str) -> None:
        self.sent.append(text.encode("cp932", errors="replace") + b"\n")

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def read_line(self):
        return await self._q.get()

    def inject(self, *lines: bytes) -> None:
        for ln in lines:
            self._q.put_nowait(ln)

    def sent_text(self) -> str:
        return b"".join(self.sent).decode("cp932", errors="replace")


def make_mgr(sockets, store=None):
    it = iter(sockets)
    m = SessionManager(socket_factory=lambda: next(it), store=store)
    return m


async def _wait(cond, timeout=2.0):
    async def waiter():
        while not cond():
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), timeout)


async def test_world_transfer_success():
    store = Store.open(":memory:")
    store.upsert_character("char1", "acc", display_name="Hero")

    src = FakeSocket("src")
    dst = FakeSocket("dst")
    mgr = make_mgr([src, dst], store=store)
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append, host="old", port=1)

    # ハンドシェイク用に宛先/元の応答を予約。
    # 宛先 rsv-ok は reserve 送信後に来る想定だが、queue 先入れでも順序問題なし。
    dst.inject(b"#rsv-ok")
    # 元から #ch-srv → worldTransfer(start) → trans 送信 → 元から trs-ok
    # trs-ok を先に詰めると ch-srv 行より先に read される恐れがあるため、
    # ch-srv の後に trs-ok を続けて注入する。
    src.inject(b"#ch-srv 10.0.0.2 7777", b"#trs-ok")

    await _wait(lambda: any(
        e.get("type") == "worldTransfer" and e.get("state") == "success"
        for e in out))

    # 手順検証
    assert "#reserve char1" in dst.sent_text()
    assert "#trans 10.0.0.2 7777" in src.sent_text()
    assert "#ch-srv-ok" in dst.sent_text()
    # swap: 旧 socket close、宛先で再ログイン(#open char1)
    assert src.closed
    assert "#open char1" in dst.sent_text()
    # Store.last_server 更新
    row = store.get_character("char1")
    assert row["last_server"] == "10.0.0.2:7777"
    # FE 通知: start と success の両方
    states = [e["state"] for e in out if e.get("type") == "worldTransfer"]
    assert "start" in states and "success" in states
    await mgr.close_all()
    store.close()


async def test_world_transfer_rsv_no_fails():
    src = FakeSocket("src")
    dst = FakeSocket("dst")
    mgr = make_mgr([src, dst])
    out: list[dict] = []
    await mgr.open_session("char1", on_event=out.append, host="old", port=1)

    dst.inject(b"#rsv-no")  # 宛先が拒否
    src.inject(b"#ch-srv 10.0.0.2 7777")

    await _wait(lambda: any(
        e.get("type") == "worldTransfer" and e.get("state") == "fail"
        for e in out))
    # rsv-no → 元へ #no-srv、宛先 close
    assert "#no-srv" in src.sent_text()
    assert dst.closed
    await mgr.close_all()


async def test_world_transfer_trs_no_fails():
    src = FakeSocket("src")
    dst = FakeSocket("dst")
    mgr = make_mgr([src, dst])
    out: list[dict] = []
    await mgr.open_session("char1", on_event=out.append, host="old", port=1)

    dst.inject(b"#rsv-ok")
    src.inject(b"#ch-srv 10.0.0.2 7777", b"#trs-no")  # 元が拒否

    await _wait(lambda: any(
        e.get("type") == "worldTransfer" and e.get("state") == "fail"
        for e in out))
    # trs-no → 宛先へ #ch-srv-no、宛先 close、swap せず
    assert "#ch-srv-no" in dst.sent_text()
    assert dst.closed
    await mgr.close_all()
