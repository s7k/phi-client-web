"""B6 SessionManager: WS セッション ↔ LegacySocket の対応・状態管理。

責務([07]§4, DEVLOG A-03/A-04/A-10/A-11)
------------------------------------------------------------------
- charId 単位で 1 つの LegacySocket + ProtocolParser + CommandSerializer を保持。
- `open_session`: 新規なら接続+ログインシーケンス([03])、既存なら再アタッチ。
  再アタッチ時は build_snapshot を on_event へ流す(現在状態の一括再送)。
- recv ループを回し Parser のイベントを変換:
    - `_internal`(#lag/#remap/keepalive)→ レガシーへ自動応答。FE 非露出。
    - S→C イベントに **session 付与(A-03)** と message へ **seq 付与(A-11)**。
    - notice は部分更新を統合(world/area/name/mapset を session 状態へマージ)。
- snapshot 構築: 最新 map/status/cond/userList/mode/notice + アクティブ list/edit。
- priv のユーザ番号表(#user)を serializer の user_map へ連携。

keepalive([07]§4.3, network_thread.py): N 秒無通信で `#code-sjis`。本実装では
recv が常にブロックするため、タイマータスクで silence を監視する。
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Callable

from app.legacy_socket import LegacySocket
from app.protocol.parser import ProtocolParser
from app.protocol.serializer import CommandSerializer

VERSION_STRING = "05107100"

# keepalive: 無通信がこの秒数続いたら #code-sjis 送信(phi-client=2分)。
KEEPALIVE_SILENCE_SEC = 120.0
# FE detach 後にレガシー接続を保持する上限([02]§6, [07]§4.2)。
DETACH_TIMEOUT_SEC = 300.0

EventCallback = Callable[[dict], None]


class _SessionState:
    """1 キャラセッションの実行時状態。"""

    def __init__(self, session_id: str, char_id: str, socket: LegacySocket) -> None:
        self.id = session_id
        self.char_id = char_id
        self.socket = socket
        self.parser = ProtocolParser()
        self.serializer = CommandSerializer()
        self.on_event: EventCallback | None = None

        self._seq = 0
        self._recv_task: asyncio.Task | None = None
        self._keepalive_task: asyncio.Task | None = None
        self._last_recv = 0.0

        # snapshot 用の最新状態
        self.status: dict | None = None
        self.cond: dict | None = None
        self.map: dict | None = None
        self.mode: dict | None = None
        self.user_list: dict | None = None
        self.notice: dict = {}

        # アクティブ対話状態(A-04)
        self.list_active = False
        self.list_lines: list[str] = []
        self.edit_mode: str | None = None  # "single"|"multi"|None

    def next_seq(self) -> int:
        self._seq += 1
        return self._seq


class SessionManager:
    """複数キャラセッションの集約管理。"""

    def __init__(
        self,
        host: str = "",
        port: int = 0,
        socket_factory: Callable[[], LegacySocket] | None = None,
    ) -> None:
        self._host = host
        self._port = port
        self._socket_factory = socket_factory or LegacySocket
        # charId → SessionState(再アタッチのキー), session_id → SessionState
        self._by_char: dict[str, _SessionState] = {}
        self._sessions: dict[str, _SessionState] = {}

    # ------------------------------------------------------------------
    # セッション開始 / 再アタッチ
    # ------------------------------------------------------------------

    async def open_session(
        self,
        char_id: str,
        on_event: EventCallback,
        host: str | None = None,
        port: int | None = None,
    ) -> str:
        """charId のセッションを開く。新規=接続+ログイン、既存=再アタッチ。

        Returns 割当 session_id(A-10)。
        """
        existing = self._by_char.get(char_id)
        if existing is not None and existing.socket.connected:
            # 再アタッチ: on_event を差し替え、現在状態を snapshot で再送。
            existing.on_event = on_event
            self._emit(existing, {"type": "connection", "state": "connected"})
            self._emit(existing, self.build_snapshot(existing.id))
            return existing.id

        sock = self._socket_factory()
        session_id = uuid.uuid4().hex[:8]
        st = _SessionState(session_id, char_id, sock)
        st.on_event = on_event
        self._by_char[char_id] = st
        self._sessions[session_id] = st

        await sock.connect(host or self._host, port or self._port)
        await self._login(st, char_id)

        self._emit(st, {"type": "connection", "state": "connected"})

        loop = asyncio.get_running_loop()
        st._last_recv = loop.time()
        st._recv_task = asyncio.create_task(self._recv_loop(st))
        st._keepalive_task = asyncio.create_task(self._keepalive_loop(st))

        # 初回 snapshot(まだ状態は空に近いが契約通り送出)
        self._emit(st, self.build_snapshot(session_id))
        return session_id

    async def _login(self, st: _SessionState, char_id: str) -> None:
        """ログインシーケンス(network_thread._login 準拠)。"""
        for line in (
            f"#open {char_id}",
            f"#version-cli {VERSION_STRING}",
            "#map-iv 10",
            "#status-iv 10",
            "#ex-switch eagleeye=form",
            "#ex-map size=57",
            "#ex-map style=solid",
            "#ex-switch ex-move-recv=true",
            "#ex-switch ex-list-mode-end=true",
            "#ex-switch ex-disp-magic=true",
        ):
            await st.socket.send_line(line)

    # ------------------------------------------------------------------
    # 受信ループ
    # ------------------------------------------------------------------

    async def _recv_loop(self, st: _SessionState) -> None:
        loop = asyncio.get_running_loop()
        while True:
            raw = await st.socket.read_line()
            if raw is None:  # 切断
                self._emit(st, {"type": "connection", "state": "closed"})
                break
            st._last_recv = loop.time()
            for ev in st.parser.feed(raw):
                await self._handle_parser_event(st, ev)

    async def _keepalive_loop(self, st: _SessionState) -> None:
        loop = asyncio.get_running_loop()
        try:
            while st.socket.connected:
                await asyncio.sleep(5.0)
                if loop.time() - st._last_recv >= KEEPALIVE_SILENCE_SEC:
                    try:
                        await st.socket.send_line("#code-sjis")
                    except (OSError, ConnectionError):
                        break
                    st._last_recv = loop.time()
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Parser イベント → S→C 変換 + 状態更新
    # ------------------------------------------------------------------

    async def _handle_parser_event(self, st: _SessionState, ev: dict) -> None:
        t = ev.get("type")

        if t == "_internal":
            action = ev.get("action")
            if action == "lag":
                await st.socket.send_line("#end-lag")
            elif action == "remap":
                await st.socket.send_line("#map")
            # eagleeye 等は R2 では透過しない(B 拡張で構造化予定)
            return

        # 状態スナップショット更新
        if t == "status":
            st.status = {k: v for k, v in ev.items() if k != "type"}
        elif t == "cond":
            st.cond = {k: v for k, v in ev.items() if k != "type"}
        elif t == "map":
            st.map = {k: v for k, v in ev.items() if k != "type"}
        elif t == "mode":
            st.mode = {k: v for k, v in ev.items() if k != "type"}
        elif t == "userList":
            st.user_list = {"users": ev.get("users", [])}
            # serializer の priv 番号表へ連携(name→番号は parser.ulist)。
            st.serializer.user_map = dict(st.parser.ulist)
        elif t == "notice":
            # 部分更新をマージ(world/area/name/mapset)
            for k, v in ev.items():
                if k != "type":
                    st.notice[k] = v
        elif t == "list":
            if ev.get("active"):
                st.list_active = True
                if ev.get("lines"):
                    st.list_lines = list(ev["lines"])
            else:
                st.list_active = False
                st.list_lines = []
        elif t == "edit":
            m = ev.get("mode")
            st.edit_mode = None if m == "end" else m

        self._emit(st, ev)

    # ------------------------------------------------------------------
    # session / seq 付与して emit(A-03/A-11)
    # ------------------------------------------------------------------

    def _emit(self, st: _SessionState, ev: dict) -> None:
        if ev is None or st.on_event is None:
            return
        ev = dict(ev)
        ev["session"] = st.id          # A-03: S→C は常に session 付与
        if ev.get("type") == "message":
            ev["seq"] = st.next_seq()   # A-11: session 毎の単調増加 seq
        st.on_event(ev)

    # ------------------------------------------------------------------
    # snapshot 構築(A-04)
    # ------------------------------------------------------------------

    def build_snapshot(self, session_id: str) -> dict:
        st = self._sessions[session_id]
        snap: dict = {"type": "snapshot", "session": session_id}
        if st.map is not None:
            snap["map"] = st.map
        if st.status is not None:
            snap["status"] = st.status
        if st.cond is not None:
            snap["cond"] = st.cond
        if st.user_list is not None:
            snap["userList"] = st.user_list
        if st.mode is not None:
            snap["mode"] = st.mode
        if st.notice:
            snap["notice"] = dict(st.notice)
        # アクティブな対話状態のみ含める(A-04)
        if st.list_active:
            snap["list"] = {"active": True, "lines": list(st.list_lines)}
        if st.edit_mode is not None:
            snap["edit"] = {"mode": st.edit_mode}
        return snap

    # ------------------------------------------------------------------
    # C→S intent → serializer → LegacySocket
    # ------------------------------------------------------------------

    async def handle_intent(self, session_id: str, intent: dict) -> None:
        """1 セッションへの意図を整形・送信。chat mode=all は全 session へ同報。"""
        if intent.get("type") == "chat" and intent.get("mode") == "all":
            await self._broadcast_chat(intent)
            return
        st = self._sessions.get(session_id)
        if st is None:
            raise KeyError(f"session not found: {session_id}")
        data = st.serializer.serialize(intent)
        await st.socket.send_bytes(data + b"\n")

    async def handle_intent_raw(self, session_id: str, text: str) -> None:
        """整形済みレガシー文字列を直接送信(session.close の #x 等)。"""
        st = self._sessions.get(session_id)
        if st is None:
            raise KeyError(f"session not found: {session_id}")
        await st.socket.send_line(text)

    async def _broadcast_chat(self, intent: dict) -> None:
        """chat mode=all: 全接続セッションへ normal 整形で同報(A-08)。"""
        normal = {"type": "chat", "mode": "normal", "text": intent.get("text", "")}
        for st in list(self._sessions.values()):
            if st.socket.connected:
                data = st.serializer.serialize(normal)
                await st.socket.send_bytes(data + b"\n")

    # ------------------------------------------------------------------
    # detach / close
    # ------------------------------------------------------------------

    def detach(self, session_id: str) -> None:
        """FE 切断: on_event を外すがレガシー接続は維持(再アタッチ可)。"""
        st = self._sessions.get(session_id)
        if st is not None:
            st.on_event = None

    async def close_session(self, session_id: str) -> None:
        st = self._sessions.pop(session_id, None)
        if st is None:
            return
        self._by_char.pop(st.char_id, None)
        for task in (st._recv_task, st._keepalive_task):
            if task is not None:
                task.cancel()
        await st.socket.close()

    async def close_all(self) -> None:
        for sid in list(self._sessions.keys()):
            await self.close_session(sid)
