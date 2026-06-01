"""B5 LegacySocket: レガシーSJISサーバへの asyncio TCP クライアント。

phi-client `phi/protocol/connection.py`(同期 socket 版)を asyncio へ移植。

責務
------------------------------------------------------------------
- connect/reconnect/close、行送受信(bytes)、切断検知。
- 受信は `LineBuffer`(B1)で \\n 行確定。確定行(末尾 \\n/\\r 除去)を返す。
- 送信は cp932 エンコード(`send_line`)または生バイト(`send_bytes`)。
- 上位(SessionManager B6)が受信ループを回し、Parser/keepalive を担う。
  本クラスは「行の入出力」と「接続状態」だけを持つ薄いトランスポート層。

設計メモ
- バイナリ地形行(`#m57 M` 等)も \\n 区切りなので LineBuffer で安全に分割可能
  (区切り 0x0A は cp932 trail バイト値域外。B1 の説明参照)。
- read_line() は 1 行返す。サーバ切断・close 後は None。
- recv バッファに複数行あれば内部キューから順次返す(余分な await なし)。
"""
from __future__ import annotations

import asyncio
from collections import deque

from app.protocol.line_buffer import LineBuffer

RECV_BUFFER_SIZE = 32768  # phi-client constants と同値


class LegacySocket:
    """asyncio ベースの行指向 TCP クライアント。"""

    def __init__(self) -> None:
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._line_buffer = LineBuffer()
        self._pending: deque[bytes] = deque()  # 確定済み未返却行
        self._closed = False

    # ------------------------------------------------------------------
    # 接続管理
    # ------------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._writer is not None and not self._closed

    async def connect(self, host: str, port: int, timeout: float = 10.0) -> None:
        """TCP 接続。失敗時 OSError(asyncio.TimeoutError 含む)。

        再接続にも使用。内部状態(LineBuffer/キュー)はリセット。
        """
        # 既存接続が残っていれば閉じる(再接続安全化)
        if self._writer is not None:
            await self.close()
        self._line_buffer.reset()
        self._pending.clear()
        self._closed = False
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise OSError(f"connect timeout: {host}:{port}") from exc

    async def close(self) -> None:
        """接続を閉じる(冪等)。"""
        self._closed = True
        writer = self._writer
        self._writer = None
        self._reader = None
        if writer is not None:
            try:
                writer.close()
                await writer.wait_closed()
            except (OSError, asyncio.CancelledError):
                pass

    # ------------------------------------------------------------------
    # 送信
    # ------------------------------------------------------------------

    async def send_line(self, text: str) -> None:
        """*text* を cp932 エンコードし末尾 \\n を付けて送信。"""
        await self.send_bytes(text.encode("cp932", errors="replace") + b"\n")

    async def send_bytes(self, data: bytes) -> None:
        """生バイトを送信(既に \\n 等を含む前提)。"""
        if self._writer is None:
            raise ConnectionError("not connected")
        self._writer.write(data)
        await self._writer.drain()

    # ------------------------------------------------------------------
    # 受信
    # ------------------------------------------------------------------

    async def read_line(self) -> bytes | None:
        """確定済み 1 行(bytes, \\n/\\r 除去)を返す。

        切断/close 済みなら None。内部キューが空なら recv を await。
        """
        while not self._pending:
            if self._reader is None or self._closed:
                return None
            try:
                data = await self._reader.read(RECV_BUFFER_SIZE)
            except (OSError, asyncio.CancelledError):
                self._closed = True
                return None
            if not data:  # サーバが正常切断
                self._closed = True
                return None
            for line in self._line_buffer.feed(data):
                self._pending.append(line)
        return self._pending.popleft()
