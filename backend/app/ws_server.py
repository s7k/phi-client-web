"""B7 WsServer: FastAPI WebSocket エンドポイント([07])。

責務
------------------------------------------------------------------
- WS 接続ごとに 1 つの `WsConnection` を生成し、エンベロープ([07]§2)を解析。
- `hello`(§4) を接続直後に送出。
- C→S: `auth`(stub)/`session.open`(A-10 応答)/その他 intent を SessionManager へ。
- S→C: SessionManager から来たイベントを outbound キュー経由で WS へ送出
  (受信ループと送信ループを分離し、イベント順序を保つ)。
- session 省略時はアクティブ(直近 open)セッションへ解決(A-03)。

認証([07]§4.1, [12]§1, B12):
  - WS `auth` は **Web セッション(cookie の sessionId)検証**(`AuthService.validate`)、
    または id+password 直接検証([12]§1.3 のフォールバック)。認証成功で
    当該アカウントのキャラ一覧(store)を返す。
  - REST `/api/auth/login` / `/api/auth/logout` も最小実装(httpOnly cookie)。
"""
from __future__ import annotations

import asyncio
import time

from app.session import SessionManager

PROTOCOL_VERSION = 1


class WsDisconnect(Exception):
    """WS 切断シグナル(starlette WebSocketDisconnect の抽象)。"""


# starlette が利用可能なら本物の例外も捕捉対象に含める。
try:  # pragma: no cover - 環境依存
    from starlette.websockets import WebSocketDisconnect as _StarletteDisconnect
    _DISCONNECT_EXC: tuple[type[Exception], ...] = (WsDisconnect, _StarletteDisconnect)
except Exception:  # pragma: no cover
    _DISCONNECT_EXC = (WsDisconnect,)


class WsConnection:
    """1 WebSocket 接続のライフサイクル。

    duck-typing: *ws* は accept/send_json/receive_json を持てばよい
    (starlette WebSocket / テスト用 Fake いずれも可)。
    """

    def __init__(self, ws, manager: SessionManager, auth=None) -> None:
        self._ws = ws
        self._mgr = manager
        self._auth = auth  # AuthService | None
        self._outbound: asyncio.Queue[dict] = asyncio.Queue()
        # この接続が開いた session 群(切断時に detach)。
        self._sessions: list[str] = []
        # 認証済みアカウント(auth 成功後にセット)。
        self._account_id: str | None = None

    # ------------------------------------------------------------------
    # エントリポイント
    # ------------------------------------------------------------------

    async def run(self) -> None:
        await self._ws.accept()
        await self._ws.send_json({
            "type": "hello",
            "protocolVersion": PROTOCOL_VERSION,
            "serverTime": int(time.time() * 1000),
        })
        sender = asyncio.create_task(self._sender_loop())
        try:
            await self._receiver_loop()
        finally:
            sender.cancel()
            for sid in self._sessions:
                self._mgr.detach(sid)

    # ------------------------------------------------------------------
    # 送信ループ(SessionManager → WS)
    # ------------------------------------------------------------------

    def _enqueue(self, ev: dict) -> None:
        """SessionManager コールバック(同期)からイベントを積む。"""
        self._outbound.put_nowait(ev)

    async def _sender_loop(self) -> None:
        try:
            while True:
                ev = await self._outbound.get()
                await self._ws.send_json(ev)
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # 受信ループ(WS → SessionManager)
    # ------------------------------------------------------------------

    async def _receiver_loop(self) -> None:
        while True:
            try:
                msg = await self._ws.receive_json()
            except _DISCONNECT_EXC:
                return
            await self._dispatch(msg)

    async def _dispatch(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "auth":
            await self._handle_auth(msg)
            return
        if t == "session.open":
            await self._handle_session_open(msg)
            return
        if t == "session.close":
            await self._handle_session_close(msg)
            return
        # それ以外は intent。session 解決して SessionManager へ。
        await self._handle_intent(msg)

    # ------------------------------------------------------------------
    # auth(B12 本実装)
    # ------------------------------------------------------------------

    async def _handle_auth(self, msg: dict) -> None:
        """WS auth: Web セッション(sessionId)検証 or id+password 検証。

        - auth サービス未設定時は従来 stub 互換(任意 id を通す)。
        - sessionId 提示時: `AuthService.validate` で account 解決。
        - id+password 提示時: `AuthService.authenticate` で検証。
        成功時、store からキャラ一覧を返す([12]§1.2)。
        """
        if self._auth is None:
            # 後方互換 stub(テスト/開発用)。
            acc = msg.get("id", "")
            self._account_id = acc
            await self._send_auth_ok(msg, acc, stub=True)
            return

        account_id = None
        sid = msg.get("sessionId")
        if sid:
            account_id = self._auth.validate(sid)
        elif msg.get("id") is not None and msg.get("password") is not None:
            if self._auth.authenticate(msg["id"], msg["password"]):
                account_id = msg["id"]

        if account_id is None:
            await self._ws.send_json({
                "type": "auth", "reqId": msg.get("reqId"), "ok": False,
                "error": {"code": "AUTH_FAILED", "message": "認証失敗"},
            })
            return

        self._account_id = account_id
        await self._send_auth_ok(msg, account_id, stub=False)

    async def _send_auth_ok(self, msg: dict, account_id: str, *, stub: bool) -> None:
        if stub or self._auth is None:
            characters = [{"charId": account_id, "name": account_id, "lastServer": None}]
        else:
            characters = [
                {
                    "charId": r["char_id"],
                    "name": r["display_name"] or r["char_id"],
                    "lastServer": r["last_server"],
                }
                for r in self._auth.store.list_characters(account_id)
            ]
        await self._ws.send_json({
            "type": "auth", "reqId": msg.get("reqId"),
            "ok": True, "characters": characters,
        })

    # ------------------------------------------------------------------
    # session.open(A-10)
    # ------------------------------------------------------------------

    async def _handle_session_open(self, msg: dict) -> None:
        char_id = msg.get("charId")
        if not char_id:
            await self._error(msg, "BAD_REQUEST", "charId required")
            return
        try:
            sid = await self._mgr.open_session(char_id, on_event=self._enqueue)
        except OSError as exc:
            await self._ws.send_json({
                "type": "session.open", "reqId": msg.get("reqId"),
                "ok": False,
                "error": {"code": "LEGACY_DISCONNECTED", "message": str(exc)},
            })
            return
        if sid not in self._sessions:
            self._sessions.append(sid)
        # A-10: reqId エコー + 割当 session を返す。connection+snapshot は
        # open_session 内で on_event(=_enqueue)経由で続く。
        await self._ws.send_json({
            "type": "session.open", "reqId": msg.get("reqId"),
            "ok": True, "session": sid,
        })

    async def _handle_session_close(self, msg: dict) -> None:
        sid = self._resolve_session(msg)
        if sid is None:
            await self._error(msg, "SESSION_NOT_FOUND", "no active session")
            return
        await self._mgr.handle_intent_raw(sid, "#x")
        await self._mgr.close_session(sid)
        if sid in self._sessions:
            self._sessions.remove(sid)

    # ------------------------------------------------------------------
    # intent ディスパッチ
    # ------------------------------------------------------------------

    async def _handle_intent(self, msg: dict) -> None:
        sid = self._resolve_session(msg)
        if sid is None:
            await self._error(msg, "SESSION_NOT_FOUND", "no active session")
            return
        try:
            await self._mgr.handle_intent(sid, msg)
        except ValueError as exc:
            # serializer の未知 type / 不正値
            await self._error(msg, "BAD_REQUEST", str(exc))
        except KeyError as exc:
            await self._error(msg, "SESSION_NOT_FOUND", str(exc))

    def _resolve_session(self, msg: dict) -> str | None:
        """session 明示 or 省略時アクティブ解決(A-03)。"""
        sid = msg.get("session")
        if sid is not None:
            return sid
        if len(self._sessions) == 1:
            return self._sessions[0]
        return self._sessions[-1] if self._sessions else None

    # ------------------------------------------------------------------
    # エラー
    # ------------------------------------------------------------------

    async def _error(self, msg: dict, code: str, message: str) -> None:
        ev: dict = {"type": "error", "error": {"code": code, "message": message}}
        if msg.get("reqId") is not None:
            ev["reqId"] = msg["reqId"]
        if msg.get("session") is not None:
            ev["session"] = msg["session"]
        await self._ws.send_json(ev)


# ----------------------------------------------------------------------
# FastAPI アプリ(本番エンドポイント)
# ----------------------------------------------------------------------

def create_app(manager: SessionManager | None = None, auth=None):
    """FastAPI アプリを生成。

    - `/ws`: WebSocket エンドポイント([07])。
    - `/api/auth/login` / `/api/auth/logout`: Web 認証([12]§1.3)。
      cookie 名 `phi_session`、httpOnly/Secure/SameSite=Strict。

    *auth* 省略時は `PHI_DB_PATH` から Store を開き AuthService を構築。
    """
    from fastapi import FastAPI, Request, Response, WebSocket

    app = FastAPI(title="phi-web gateway")
    import os
    mgr = manager or SessionManager(
        host=os.environ.get("PHI_HOST", ""),
        port=int(os.environ.get("PHI_PORT", "0") or 0),
    )
    app.state.session_manager = mgr

    if auth is None:  # pragma: no cover - 統合層(本番起動)
        from app.auth import AuthService
        from app.store import Store
        auth = AuthService(Store.open(os.environ.get("PHI_DB_PATH")))
    app.state.auth = auth

    COOKIE = "phi_session"

    @app.post("/api/auth/login")
    async def login(request: Request, response: Response):
        body = await request.json()
        sid = auth.login(body.get("id", ""), body.get("password", ""))
        if sid is None:
            return Response(status_code=401)
        # [12]§1.3: httpOnly + Secure + SameSite=Strict cookie。
        response.set_cookie(
            COOKIE, sid, httponly=True, secure=True, samesite="strict"
        )
        return {"ok": True}

    @app.post("/api/auth/logout")
    async def logout(request: Request, response: Response):
        sid = request.cookies.get(COOKIE)
        if sid:
            auth.logout(sid)
        response.delete_cookie(COOKIE)
        return {"ok": True}

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket):  # pragma: no cover - 統合層
        conn = WsConnection(websocket, mgr, auth=auth)
        await conn.run()

    return app
