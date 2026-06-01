"""B5 LegacySocket テスト(モックTCPサーバ=asyncio)。

実サーバ非依存。asyncio の TCP サーバを立て、フィクスチャ的バイト列を
再生してクライアント(LegacySocket)の送受信・切断検知・再接続を検証。
"""
from __future__ import annotations

import asyncio

import pytest

from app.legacy_socket import LegacySocket


class MockServer:
    """テスト用の最小 asyncio TCP サーバ。

    - 接続を受けたら `script`(bytes)を送る(分割送信して行境界跨ぎも再現)。
    - クライアント送信行を `received`(list[bytes])へ記録。
    - `close_after_send=True` なら送信後に切断。
    """

    def __init__(self, script: bytes = b"", *, close_after_send: bool = False,
                 chunk: int = 7):
        self.script = script
        self.close_after_send = close_after_send
        self.chunk = chunk
        self.received: list[bytes] = []
        self._server: asyncio.AbstractServer | None = None
        self.host = "127.0.0.1"
        self.port = 0
        self.conn_count = 0
        self._writers: list[asyncio.StreamWriter] = []

    async def start(self) -> None:
        self._server = await asyncio.start_server(
            self._handle, self.host, 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        # 活きているハンドラ接続を強制切断してから listen socket を閉じる
        # (wait_closed が活動接続待ちでハングするのを回避)。
        for w in self._writers:
            try:
                w.close()
            except OSError:
                pass
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader,
                      writer: asyncio.StreamWriter) -> None:
        self.conn_count += 1
        self._writers.append(writer)
        # 台本を分割送信
        data = self.script
        for i in range(0, len(data), self.chunk):
            writer.write(data[i:i + self.chunk])
            await writer.drain()
            await asyncio.sleep(0)
        if self.close_after_send:
            writer.close()
            return
        # 以降クライアント入力を読み取り記録(行単位)
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                self.received.append(line)
        except (ConnectionError, asyncio.CancelledError):
            pass


@pytest.fixture
async def mock_server():
    srv = MockServer()
    await srv.start()
    yield srv
    await srv.stop()


async def test_connect_and_recv_lines(mock_server):
    mock_server.script = b"#name Taro\n#status x:1\n"
    sock = LegacySocket()
    await sock.connect(mock_server.host, mock_server.port)
    assert sock.connected
    lines = []
    # 2 行受信するまで読む
    for _ in range(2):
        line = await asyncio.wait_for(sock.read_line(), timeout=2.0)
        lines.append(line)
    assert lines == [b"#name Taro", b"#status x:1"]
    await sock.close()
    assert not sock.connected


async def test_recv_handles_split_multibyte(mock_server):
    # cp932 マルチバイト("あ"=0x82 0xa0)を含む行を細切れ送信
    body = "#name あいう".encode("cp932") + b"\n"
    mock_server.script = body
    mock_server.chunk = 3
    sock = LegacySocket()
    await sock.connect(mock_server.host, mock_server.port)
    line = await asyncio.wait_for(sock.read_line(), timeout=2.0)
    assert line == "#name あいう".encode("cp932")
    await sock.close()


async def test_send_line_encodes_cp932(mock_server):
    sock = LegacySocket()
    await sock.connect(mock_server.host, mock_server.port)
    await sock.send_line("#open テスト")
    await sock.send_bytes(b"hit\n")
    # サーバ側受信を待つ
    await asyncio.sleep(0.1)
    await sock.close()
    assert mock_server.received[0] == "#open テスト".encode("cp932") + b"\n"
    assert mock_server.received[1] == b"hit\n"


async def test_detects_server_close(mock_server):
    mock_server.script = b"#name Taro\n"
    mock_server.close_after_send = True
    sock = LegacySocket()
    await sock.connect(mock_server.host, mock_server.port)
    line = await asyncio.wait_for(sock.read_line(), timeout=2.0)
    assert line == b"#name Taro"
    # サーバ切断後 read_line は None を返す
    nxt = await asyncio.wait_for(sock.read_line(), timeout=2.0)
    assert nxt is None
    assert not sock.connected
    await sock.close()


async def test_connect_failure_raises():
    sock = LegacySocket()
    # 使われていない(到達不能)ポート
    with pytest.raises(OSError):
        await sock.connect("127.0.0.1", 1, timeout=1.0)


async def test_reconnect(mock_server):
    mock_server.script = b"#name A\n"
    sock = LegacySocket()
    await sock.connect(mock_server.host, mock_server.port)
    assert await asyncio.wait_for(sock.read_line(), timeout=2.0) == b"#name A"
    await sock.close()
    # 再接続(LineBuffer はリセットされる)
    await sock.connect(mock_server.host, mock_server.port)
    assert sock.connected
    assert mock_server.conn_count == 2
    await sock.close()
