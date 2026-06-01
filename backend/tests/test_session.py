"""B6 SessionManager テスト。

LegacySocket をモックに差し替え、Parser→イベント変換・snapshot構築・
session/seq 付与・#lag 応答・reattach を検証(実サーバ非依存)。
"""
from __future__ import annotations

import asyncio

import pytest

from app.session import SessionManager


class FakeSocket:
    """LegacySocket 互換のインメモリ偽物。

    `inject(raw)` で受信行を流し込み、`read_line` で順次返す。
    `sent` に送信行(bytes)を記録。`close` で read_line を None 化。
    """

    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self._q: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.connected = False
        self.connect_calls: list[tuple[str, int]] = []

    async def connect(self, host: str, port: int, timeout: float = 10.0) -> None:
        self.connect_calls.append((host, port))
        self.connected = True

    async def close(self) -> None:
        self.connected = False
        await self._q.put(None)

    async def send_line(self, text: str) -> None:
        self.sent.append(text.encode("cp932", errors="replace") + b"\n")

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def read_line(self) -> bytes | None:
        return await self._q.get()

    def inject(self, *lines: bytes) -> None:
        for ln in lines:
            self._q.put_nowait(ln)


def make_status(name="Hero", hp=100):
    return f"#status {name}:{hp}:{hp}:50:50:10:5:1:2:3:4".encode("cp932")


@pytest.fixture
async def mgr():
    sock = FakeSocket()
    m = SessionManager(socket_factory=lambda: sock)
    m._fake = sock  # テストアクセス用
    yield m
    await m.close_all()


async def _drain(out: list, n: int, timeout=2.0):
    """out に n 件溜まるまで待つ。"""
    async def waiter():
        while len(out) < n:
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), timeout)


async def test_open_session_returns_id_and_connects(mgr):
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)
    assert isinstance(sid, str) and sid
    assert mgr._fake.connect_calls  # 接続済み
    # ログインシーケンスに #open / #map-iv を含む
    sent = b"".join(mgr._fake.sent)
    assert b"#open char1\n" in sent
    assert b"#map-iv" in sent


async def test_events_get_session_and_seq(mgr):
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)
    mgr._fake.inject(b"hello there", b"second line")
    async def waiter():
        while len([e for e in out if e["type"] == "message"]) < 2:
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), 2.0)
    msgs = [e for e in out if e["type"] == "message"]
    assert all(e["session"] == sid for e in msgs)
    # seq は単調増加
    seqs = [e["seq"] for e in msgs]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)


async def test_lag_is_answered_internally(mgr):
    out: list[dict] = []
    await mgr.open_session("char1", on_event=out.append)
    mgr._fake.sent.clear()
    mgr._fake.inject(b"#lag")
    # #end-lag が送られるまで待つ
    async def waiter():
        while b"#end-lag\n" not in b"".join(mgr._fake.sent):
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), 2.0)
    # _internal は FE へ露出しない
    assert all(e["type"] != "_internal" for e in out)


async def test_snapshot_collects_latest_state(mgr):
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)
    mgr._fake.inject(
        make_status("Hero", 100),
        b"#cond *------",
        b"#name Hero",
        b"#mapset mansion",
    )
    async def waiter():
        while not (mgr._sessions[sid].status and mgr._sessions[sid].cond
                   and mgr._sessions[sid].notice.get("mapset")):
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), 2.0)
    snap = mgr.build_snapshot(sid)
    assert snap["type"] == "snapshot"
    assert snap["session"] == sid
    assert snap["status"]["name"] == "Hero"
    assert snap["cond"]["poison"] is True
    assert snap["notice"]["name"] == "Hero"
    assert snap["notice"]["mapset"] == "mansion"


async def test_snapshot_includes_active_list(mgr):
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)
    mgr._fake.inject(b"#list", b"1: dagger", b"2: sword", b"#end-list")
    await _drain(out, 1)
    # list がアクティブ→非アクティブで終わるので、終了後 snapshot に list は無い
    # アクティブ中の snapshot を別途検証
    mgr._fake.inject(b"#list", b"a", b"b")
    async def waiter():
        while not mgr._sessions[sid].list_active:
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), 2.0)
    snap = mgr.build_snapshot(sid)
    assert "list" in snap and snap["list"]["active"] is True


async def test_reattach_resends_snapshot(mgr):
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)
    mgr._fake.inject(make_status("Hero", 77))
    async def waiter():
        while not any(e["type"] == "status" for e in out):
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), 2.0)
    out2: list[dict] = []
    sid2 = await mgr.open_session("char1", on_event=out2.append)
    # 同一 charId は同一 session へ再アタッチ(新規接続しない)
    assert sid2 == sid
    assert len(mgr._fake.connect_calls) == 1  # 再接続していない
    snap = [e for e in out2 if e["type"] == "snapshot"]
    assert snap and snap[0]["status"]["hp"] == 77


async def test_priv_user_map_wired_to_serializer(mgr):
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)
    # #user 行: raw[6:10]=番号4桁, raw[11:42]=名前31B
    no = b"0007"
    name = "Friend".encode("cp932").ljust(31)
    mgr._fake.inject(b"#user " + no + b" " + name)
    async def waiter():
        while mgr._sessions[sid].user_list is None:
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), 2.0)
    # priv 送信が #user 表で番号解決される
    mgr._fake.sent.clear()
    await mgr.handle_intent(sid, {"type": "chat", "mode": "priv",
                                  "to": "u7", "text": "hi"})
    sent = b"".join(mgr._fake.sent)
    assert b"7" in sent and b"hi" in sent


# ======================================================================
# CR-2/5/6/7 是正ラウンド F1
# ======================================================================

import app.session as session_mod  # noqa: E402


def _ee_row(size: int, y: int, cells):
    hdr = b"#ex-eagleeye M %02d %02d " % (size, y)
    return hdr + b"".join(bytes([c, a]) for c, a in cells)


async def test_eagleeye_passthrough_to_fe(mgr):
    # CR-2: 構造化 eagleEye が session を付与して FE へ透過(破棄しない)。
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)
    mgr._fake.inject(
        b"#ex-eagleeye start",
        _ee_row(0, 0, [(7, 0)]),
        b"#ex-eagleeye pos 0 0",
        b"#ex-eagleeye end",
    )
    async def waiter():
        while not any(e["type"] == "eagleEye" for e in out):
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), 2.0)
    ev = next(e for e in out if e["type"] == "eagleEye")
    assert ev["session"] == sid
    assert ev["width"] == 1 and ev["height"] == 1
    assert ev["cells"] == [{"chip": 7, "attr": 0}]
    # _internal は FE へ漏れない
    assert all(e["type"] != "_internal" for e in out)


async def test_recv_loop_emits_closed_on_disconnect(mgr):
    # CR-5: read_line None(切断) で connection:closed を emit。
    out: list[dict] = []
    await mgr.open_session("char1", on_event=out.append)
    mgr._fake._q.put_nowait(None)
    async def waiter():
        while not any(e.get("type") == "connection" and e.get("state") == "closed"
                      for e in out):
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), 2.0)


async def test_recv_loop_emits_closed_on_internal_send_failure(mgr):
    # CR-5: #lag 応答(#end-lag)送信失敗で closed emit して無言死しない。
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)

    async def boom(text):
        raise ConnectionError("send broke")
    mgr._sessions[sid].socket.send_line = boom  # type: ignore[assignment]
    mgr._fake.inject(b"#lag")
    async def waiter():
        while not any(e.get("type") == "connection" and e.get("state") == "closed"
                      for e in out):
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), 2.0)
    # closed は一度だけ
    closed = [e for e in out if e.get("type") == "connection"
              and e.get("state") == "closed"]
    assert len(closed) == 1


async def test_detach_emits_detached_before_null(mgr):
    # CR-7: detach で connection:detached を on_event Null 化前に emit。
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)
    mgr.detach(sid)
    assert any(e.get("type") == "connection" and e.get("state") == "detached"
               for e in out)
    # 以後 on_event は Null(以降の emit は届かない)
    assert mgr._sessions[sid].on_event is None


async def test_detach_timeout_closes_session(mgr, monkeypatch):
    # CR-6: detach から DETACH_TIMEOUT_SEC 経過で close_session。
    monkeypatch.setattr(session_mod, "DETACH_TIMEOUT_SEC", 0.05)
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)
    mgr.detach(sid)
    async def waiter():
        while sid in mgr._sessions:
            await asyncio.sleep(0.005)
    await asyncio.wait_for(waiter(), 2.0)
    assert sid not in mgr._sessions
    assert "char1" not in mgr._by_char


async def test_detach_then_reattach_survives(mgr, monkeypatch):
    # CR-6: 期限前の再アタッチでタイマがキャンセルされ存続。
    monkeypatch.setattr(session_mod, "DETACH_TIMEOUT_SEC", 0.2)
    out: list[dict] = []
    sid = await mgr.open_session("char1", on_event=out.append)
    mgr.detach(sid)
    out2: list[dict] = []
    sid2 = await mgr.open_session("char1", on_event=out2.append)
    assert sid2 == sid
    # detach タイマはキャンセル済
    assert mgr._sessions[sid]._detach_task is None
    # 期限相当を超えて待っても存続
    await asyncio.sleep(0.3)
    assert sid in mgr._sessions


async def test_close_session_awaits_cancelled_tasks(mgr):
    # CR-7: close_session が recv/keepalive を cancel 後に gather 回収。
    sid = await mgr.open_session("char1", on_event=lambda e: None)
    st = mgr._sessions[sid]
    recv, keep = st._recv_task, st._keepalive_task
    await mgr.close_session(sid)
    assert recv.cancelled() or recv.done()
    assert keep.cancelled() or keep.done()
    assert sid not in mgr._sessions
