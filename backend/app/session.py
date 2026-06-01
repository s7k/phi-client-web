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
import logging
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
# 世界移動(#ch-srv)ハンドシェイクのタイムアウト(B13, [07]§6.10)。
WORLD_TRANSFER_TIMEOUT_SEC = 300.0

EventCallback = Callable[[dict], None]


class _ClosedEmitted(Exception):
    """内部送信失敗で closed を emit 済みであることを recv_loop へ伝える番兵。"""


class _SessionState:
    """1 キャラセッションの実行時状態。"""

    def __init__(self, session_id: str, char_id: str, socket: LegacySocket) -> None:
        self.id = session_id
        self.char_id = char_id
        self.socket = socket
        # 現在の接続先(世界移動で更新)。snapshot/再ログイン用。
        self.host = ""
        self.port = 0
        self.parser = ProtocolParser()
        self.serializer = CommandSerializer()
        self.on_event: EventCallback | None = None

        self._seq = 0
        self._recv_task: asyncio.Task | None = None
        self._keepalive_task: asyncio.Task | None = None
        # detach タイムアウトタイマ(CR-6)。再アタッチでキャンセル。
        self._detach_task: asyncio.Task | None = None
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
        store=None,
    ) -> None:
        self._host = host
        self._port = port
        self._socket_factory = socket_factory or LegacySocket
        # Store(B8): 世界移動成功時に characters.last_server を更新(任意)。
        self._store = store
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
            # 再アタッチ: detach タイマをキャンセルし、on_event を差し替え、
            # 現在状態を snapshot で再送(CR-6)。
            if existing._detach_task is not None:
                existing._detach_task.cancel()
                existing._detach_task = None
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

        st.host = host or self._host
        st.port = port or self._port
        await sock.connect(st.host, st.port)
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
        """レガシー受信ループ。CR-5: 全体を try/except で包み、例外時も
        `connection:closed` を必ず emit してから break(無言死を防止)。"""
        loop = asyncio.get_running_loop()
        try:
            while True:
                raw = await st.socket.read_line()
                if raw is None:  # 切断
                    self._emit(st, {"type": "connection", "state": "closed"})
                    break
                st._last_recv = loop.time()
                for ev in st.parser.feed(raw):
                    await self._handle_parser_event(st, ev)
        except asyncio.CancelledError:
            # close_session 由来のキャンセルは closed emit しない(正常終了)。
            raise
        except _ClosedEmitted:
            # 内部応答送信失敗(_guarded_send)。closed は emit 済み。
            pass
        except Exception:  # noqa: BLE001 - 受信/応答の予期せぬ例外
            logging.getLogger("phi.session").exception("recv loop failed")
            self._emit(st, {"type": "connection", "state": "closed"})

    async def _guarded_send(self, st: _SessionState, text: str) -> None:
        """内部応答(#end-lag/#map 等)の送信。失敗時 closed emit(CR-5)。

        送信失敗は recv_loop の except へ伝播させ closed を二重 emit しない
        よう、ここでも closed を emit して例外を再送出する。
        """
        try:
            await st.socket.send_line(text)
        except (OSError, ConnectionError) as exc:
            self._emit(st, {"type": "connection", "state": "closed"})
            raise _ClosedEmitted() from exc

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

        # 世界移動(#ch-srv): start を FE へ通知し、ハンドシェイク実行(B13)。
        if t == "worldTransfer" and ev.get("state") == "start":
            self._emit(st, ev)
            await self._handle_ch_srv(st, ev.get("server", ""))
            return

        if t == "_internal":
            action = ev.get("action")
            # CR-5: 内部応答の send_line を個別 guard。送信失敗で closed emit。
            if action == "lag":
                await self._guarded_send(st, "#end-lag")
            elif action == "remap":
                await self._guarded_send(st, "#map")
            # eagleEye 等は parser が構造化 emit するため _internal には来ない。
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
    # 世界移動(#ch-srv ハンドシェイク, B13)
    # ------------------------------------------------------------------

    async def _handle_ch_srv(self, st: _SessionState, server: str) -> None:
        """`#ch-srv` ハンドシェイクを実行(network_thread._handle_ch_srv 移植)。

        手順(classTransportCharacter::ChSrv 準拠):
          1. 宛先サーバへ接続
          2. 宛先へ `#reserve <char_id>`
          3. 宛先から `#rsv-ok`(失敗時 元へ `#no-srv`)
          4. 元へ `#trans <ip> <port>`
          5. 元から `#trs-ok`(失敗時 宛先へ `#ch-srv-no`)
          6. 宛先へ `#ch-srv-ok`
          7. 接続を宛先へ swap + 再ログイン

        全体 300 秒タイムアウト([07]§6.10)。成功時 Store.last_server 更新、
        FE へ worldTransfer(success/fail) を通知。
        本メソッドは recv_loop コンテキスト内で同期的に呼ばれ、元 socket の
        行待ち(trs-ok)は recv_loop と競合しない。
        """
        ip, _, port_s = server.partition(":")
        try:
            port = int(port_s)
        except ValueError:
            self._emit_transfer_fail(st, server)
            return

        try:
            await asyncio.wait_for(
                self._ch_srv_handshake(st, ip, port),
                timeout=WORLD_TRANSFER_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError:
            self._emit_transfer_fail(st, server)
            return
        # _ch_srv_handshake が成功/失敗で emit 済み。

    async def _ch_srv_handshake(self, st: _SessionState, ip: str, port: int) -> None:
        old_sock = st.socket
        server = f"{ip}:{port}"

        dst = self._socket_factory()
        try:
            await dst.connect(ip, port)
        except (OSError, ConnectionError):
            self._emit_transfer_fail(st, server)
            return

        # 2. 宛先へ reserve
        try:
            await dst.send_line(f"#reserve {st.char_id}")
        except (OSError, ConnectionError):
            await dst.close()
            self._emit_transfer_fail(st, server)
            return

        # 3. 宛先から rsv-ok
        if not await self._wait_for_line(dst, b"#rsv-ok", b"#rsv-no"):
            await self._safe_send(old_sock, "#no-srv")
            await dst.close()
            self._emit_transfer_fail(st, server)
            return

        # 4. 元へ trans
        if not await self._safe_send(old_sock, f"#trans {ip} {port}"):
            await dst.close()
            self._emit_transfer_fail(st, server)
            return

        # 5. 元から trs-ok
        if not await self._wait_for_line(old_sock, b"#trs-ok", b"#trs-no"):
            await self._safe_send(dst, "#ch-srv-no")
            await dst.close()
            self._emit_transfer_fail(st, server)
            return

        # 6. 宛先へ ch-srv-ok
        if not await self._safe_send(dst, "#ch-srv-ok"):
            await dst.close()
            self._emit_transfer_fail(st, server)
            return

        # 7. swap + 再ログイン
        st.socket = dst
        st.host = ip
        st.port = port
        await old_sock.close()
        try:
            await self._login(st, st.char_id)
        except (OSError, ConnectionError):
            self._emit_transfer_fail(st, server)
            return

        # 成功: Store.last_server 更新 + FE 通知。
        self._update_last_server(st, server)
        self._emit(st, {"type": "worldTransfer", "state": "success",
                        "server": server})

    async def _wait_for_line(
        self, sock: LegacySocket, ok: bytes, fail: bytes
    ) -> bool:
        """*sock* から ok/fail 行(strip 後一致)を待つ。

        ok → True、fail/#x/#close/切断 → False。タイムアウトは呼出側(全体 300s)。
        """
        while True:
            raw = await sock.read_line()
            if raw is None:
                return False
            stripped = raw.strip()
            if stripped == ok:
                return True
            if stripped in (fail, b"#x", b"#close"):
                return False
            # 関係ない行は読み飛ばす(network_thread 同様)。

    async def _safe_send(self, sock: LegacySocket, text: str) -> bool:
        try:
            await sock.send_line(text)
            return True
        except (OSError, ConnectionError):
            return False

    def _emit_transfer_fail(self, st: _SessionState, server: str) -> None:
        self._emit(st, {"type": "worldTransfer", "state": "fail",
                        "server": server})

    def _update_last_server(self, st: _SessionState, server: str) -> None:
        if self._store is None:
            return
        try:
            row = self._store.get_character(st.char_id)
            account_id = row["account_id"] if row is not None else None
            display_name = row["display_name"] if row is not None else None
            if account_id is None:
                # 既存キャラ行が無い場合は last_server だけ更新できないため skip。
                return
            self._store.upsert_character(
                st.char_id, account_id,
                display_name=display_name, last_server=server,
                legacy_uid_enc=row["legacy_uid_enc"] if row is not None else None,
                legacy_host=server,
            )
        except Exception:  # noqa: BLE001 - 永続化失敗で移動自体は成功扱い
            pass

    # ------------------------------------------------------------------
    # detach / close
    # ------------------------------------------------------------------

    def detach(self, session_id: str) -> None:
        """FE 切断: レガシー接続は維持(再アタッチ可)。CR-6/CR-7。

        - on_event を Null 化する**前**に `connection:detached` を emit(CR-7)。
        - DETACH_TIMEOUT_SEC 後に close_session するタイマタスクを起動(CR-6)。
          再アタッチ(open_session)でキャンセルされる。
        """
        st = self._sessions.get(session_id)
        if st is None:
            return
        # CR-7: detached を on_event Null 化前に通知。
        self._emit(st, {"type": "connection", "state": "detached"})
        st.on_event = None
        # 既存タイマがあれば張り替え。
        if st._detach_task is not None:
            st._detach_task.cancel()
        st._detach_task = asyncio.create_task(self._detach_timeout(session_id))

    async def _detach_timeout(self, session_id: str) -> None:
        """detach から DETACH_TIMEOUT_SEC 経過で close_session(CR-6)。"""
        try:
            await asyncio.sleep(DETACH_TIMEOUT_SEC)
        except asyncio.CancelledError:
            return
        st = self._sessions.get(session_id)
        if st is not None:
            st._detach_task = None
        await self.close_session(session_id)

    async def close_session(self, session_id: str) -> None:
        st = self._sessions.pop(session_id, None)
        if st is None:
            return
        self._by_char.pop(st.char_id, None)
        tasks = []
        # 自身(detach タイマ)からの呼び出しでは自タスクを cancel/await しない。
        current = asyncio.current_task()
        for task in (st._recv_task, st._keepalive_task, st._detach_task):
            if task is not None and task is not current:
                task.cancel()
                tasks.append(task)
        await st.socket.close()
        # CR-7: cancel 後に gather で確実に回収(return_exceptions)。
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def close_all(self) -> None:
        for sid in list(self._sessions.keys()):
            await self.close_session(sid)

    async def shutdown(self) -> None:
        """CR-18: graceful shutdown。全アクティブセッションへ `#x`(ログアウト)を
        送出してからレガシー接続を閉じる。

        プロセス再起動でゲーム状態が揮発する([07]§4.2 / [02]§6)ため、せめて
        レガシー側に正規ログアウトを通知し、宙吊り接続/キャラ残留を避ける。
        送信失敗(既に切断)は無視し、必ず close_session で後始末する。
        """
        for sid in list(self._sessions.keys()):
            st = self._sessions.get(sid)
            if st is not None and st.socket.connected:
                try:
                    await st.socket.send_line("#x")
                except (OSError, ConnectionError):
                    pass
            await self.close_session(sid)
