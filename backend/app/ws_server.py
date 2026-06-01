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
import logging
import time

# FastAPI ハンドラの型注釈解決のため module グローバルに置く
# (`from __future__ import annotations` で注釈が文字列化されるため、
#  関数ローカル import だと FastAPI の get_type_hints が解決できない)。
from fastapi import HTTPException, Request, Response  # noqa: E402

from app.session import SessionManager

PROTOCOL_VERSION = 1

# settings scope([07]§5.7)。許可 scope 以外は BAD_REQUEST。
_SETTINGS_SCOPES = ("keybind", "notify", "display", "intervals")

# command.raw 監査ログ([07]§10)。session/text のみ記録。
# 実 uid/パスワード等のアカウント情報は本ログに含めない。
_audit_logger = logging.getLogger("phi.audit")


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

    def __init__(
        self,
        ws,
        manager: SessionManager,
        auth=None,
        *,
        rate_limiter=None,
        conn_limiter=None,
        store=None,
    ) -> None:
        self._ws = ws
        self._mgr = manager
        self._auth = auth  # AuthService | None
        # settings 永続化用 Store(CR-1)。未指定時は auth.store を流用。
        self._store = store if store is not None else getattr(auth, "store", None)
        self._rl = rate_limiter   # RateLimiter | None(command.raw/chat)
        self._cl = conn_limiter   # ConcurrencyLimiter | None(WS同時接続)
        self._outbound: asyncio.Queue[dict] = asyncio.Queue()
        # この接続が開いた session 群(切断時に detach)。
        self._sessions: list[str] = []
        # 認証済みアカウント(auth 成功後にセット)。
        self._account_id: str | None = None
        # 同時接続カウンタ確保済みか(release 二重防止)。
        self._conn_acquired = False

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
            if self._conn_acquired and self._cl is not None and self._account_id:
                self._cl.release(self._account_id)
                self._conn_acquired = False

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
        # CR-4: dispatch 全体を保護し、想定外例外で接続全体を落とさない。
        # ValueError/KeyError/TypeError は意味づけして個別応答、それ以外は
        # INTERNAL を返し接続は維持する。
        try:
            await self._dispatch_inner(msg)
        except ValueError as exc:
            await self._error(msg, "BAD_REQUEST", str(exc))
        except KeyError as exc:
            await self._error(msg, "SESSION_NOT_FOUND", str(exc))
        except TypeError as exc:
            await self._error(msg, "BAD_REQUEST", str(exc))
        except _DISCONNECT_EXC:
            raise
        except Exception as exc:  # noqa: BLE001 - 接続維持のため最終捕捉
            logging.getLogger("phi.ws").exception("dispatch failed")
            await self._error(msg, "INTERNAL", str(exc))

    async def _dispatch_inner(self, msg: dict) -> None:
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
        if t in ("settings.get", "settings.set"):
            await self._handle_settings(msg)
            return
        if t == "map.request":
            await self._handle_map_request(msg)
            return
        if t == "ping":
            # アプリ層ハートビート(§8/§6.14)。pong を即返す。
            await self._ws.send_json({
                "type": "pong", "nonce": msg.get("nonce"),
                "serverTime": int(time.time() * 1000),
            })
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
            if not self._acquire_conn(acc):
                await self._auth_rate_limited(msg)
                return
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

        if not self._acquire_conn(account_id):
            await self._auth_rate_limited(msg)
            return
        self._account_id = account_id
        await self._send_auth_ok(msg, account_id, stub=False)

    def _acquire_conn(self, account_id: str) -> bool:
        """WS同時接続数を確保(5/account, [12]§4)。確保済なら True 維持。"""
        if self._cl is None or self._conn_acquired:
            return True
        if self._cl.acquire(account_id):
            self._conn_acquired = True
            return True
        return False

    async def _auth_rate_limited(self, msg: dict) -> None:
        await self._ws.send_json({
            "type": "auth", "reqId": msg.get("reqId"), "ok": False,
            "error": {"code": "RATE_LIMITED", "message": "WS同時接続数上限(5/account)"},
        })

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
    # 設定(CR-1, [07]§5.7/§6.13)。アカウント単位で SQLite へ永続化。
    # ------------------------------------------------------------------

    async def _handle_settings(self, msg: dict) -> None:
        import json

        t = msg.get("type")
        scope = msg.get("scope")
        if scope not in _SETTINGS_SCOPES:
            await self._error(msg, "BAD_REQUEST", f"invalid scope: {scope!r}")
            return
        if self._store is None or self._account_id is None:
            # 未認証 or ストア未設定。get は空を返し、set は失敗扱い。
            await self._error(msg, "SESSION_NOT_FOUND", "no authenticated account")
            return

        if t == "settings.get":
            raw = self._store.get_account_setting(self._account_id, scope)
            value = json.loads(raw) if raw is not None else None
            await self._ws.send_json({
                "type": "settings", "reqId": msg.get("reqId"),
                "ok": True, "scope": scope, "value": value,
            })
            return

        # settings.set: value を JSON 文字列で永続化し ok 応答。
        value = msg.get("value")
        self._store.set_account_setting(
            self._account_id, scope, json.dumps(value)
        )
        await self._ws.send_json({
            "type": "settings", "reqId": msg.get("reqId"),
            "ok": True, "scope": scope, "value": value,
        })

    async def _handle_map_request(self, msg: dict) -> None:
        """CR-20: map.request → レガシーへ `#map` 送出(再描画要求)。"""
        sid = self._resolve_session(msg)
        if sid is None:
            await self._error(msg, "SESSION_NOT_FOUND", "no active session")
            return
        await self._mgr.handle_intent_raw(sid, "#map")

    # ------------------------------------------------------------------
    # intent ディスパッチ
    # ------------------------------------------------------------------

    async def _handle_intent(self, msg: dict) -> None:
        sid = self._resolve_session(msg)
        if sid is None:
            await self._error(msg, "SESSION_NOT_FOUND", "no active session")
            return
        # レート制限([12]§4): command.raw 10/10s, chat 20/10s(session単位)。
        if self._rl is not None and not self._allow_intent(msg, sid):
            await self._error(msg, "RATE_LIMITED", "レート制限超過")
            return
        # command.raw 監査([07]§10): session/text のみ構造化ログ。
        # uid/パスワード等のアカウント情報は記録しない。
        if msg.get("type") == "command" and msg.get("name") == "raw":
            _audit_logger.info(
                "command.raw",
                extra={
                    "event": "command.raw",
                    "session": sid,
                    "text": str(msg.get("text", "")),
                },
            )
        try:
            await self._mgr.handle_intent(sid, msg)
        except ValueError as exc:
            # serializer の未知 type / 不正値
            await self._error(msg, "BAD_REQUEST", str(exc))
        except TypeError as exc:
            # CR-4: list.select の value 欠落で int(None) 等 → BAD_REQUEST。
            await self._error(msg, "BAD_REQUEST", str(exc))
        except KeyError as exc:
            await self._error(msg, "SESSION_NOT_FOUND", str(exc))

    def _allow_intent(self, msg: dict, sid: str) -> bool:
        """対象 intent をレート判定。chat 全mode / command.raw のみ制限対象。"""
        t = msg.get("type")
        if t == "chat":
            return self._rl.allow("chat", sid)
        if t == "command" and msg.get("name") == "raw":
            return self._rl.allow("command.raw", sid)
        return True

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

COOKIE_NAME = "phi_session"


def make_require_account(auth, cookie_name: str = COOKIE_NAME):
    """`require_account` 依存を生成([12]§1.3)。

    cookie `phi_session` の sessionId を `AuthService.validate` で検証し
    account_id を返す。無効/欠落は 401。REST 保護エンドポイントに注入。
    """
    async def _require_account(request: Request) -> str:
        sid = request.cookies.get(cookie_name)
        account_id = auth.validate(sid) if sid else None
        if account_id is None:
            raise HTTPException(401, "未認証")
        return account_id

    return _require_account


def create_app(
    manager: SessionManager | None = None,
    auth=None,
    *,
    assets_dir: str | None = None,
    registrar_factory=None,
    rate_limiter=None,
    conn_limiter=None,
    allowed_origins=None,
):
    """FastAPI アプリを生成(REST 統合 + WS)。

    マウント:
    - `/ws`                          : WebSocket([07])。
    - `/api/auth/login` `/logout`    : Web 認証([12]§1.3)。cookie `phi_session`。
    - `/api/chara/*`                 : キャラグラ([08], B10)。upload は要認証 + レート。
    - `/api/register/*`              : 新規登録([12]§2, B15)。register は要認証 + レート/IP。

    引数:
    - assets_dir       : キャラグラ保存先(既定 env `PHI_ASSETS_DIR` or `./assets`)。
    - registrar_factory: () -> LegacyRegistrar(既定は env のレガシー接続情報)。
    - rate_limiter     : RateLimiter(既定で生成)。
    - conn_limiter     : ConcurrencyLimiter(既定で生成)。
    - allowed_origins  : CSRF 許可 origin set(既定 env `PHI_ALLOWED_ORIGINS`)。

    *auth* 省略時は `PHI_DB_PATH` から Store を開き AuthService を構築。
    """
    import os

    from fastapi import FastAPI, WebSocket

    from app.csrf import is_origin_allowed, load_allowed_origins
    from app.ratelimit import ConcurrencyLimiter, RateLimiter

    app = FastAPI(title="phi-web gateway")
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

    rate_limiter = rate_limiter if rate_limiter is not None else RateLimiter()
    conn_limiter = conn_limiter if conn_limiter is not None else ConcurrencyLimiter()
    if allowed_origins is None:
        allowed_origins = load_allowed_origins()
    app.state.rate_limiter = rate_limiter
    app.state.conn_limiter = conn_limiter

    require_account = make_require_account(auth)

    # ------------------------------------------------------------------
    # CSRF: 変更系の Origin/Referer 検査([12]§1.3 / §7.3)。
    # ------------------------------------------------------------------
    @app.middleware("http")
    async def csrf_guard(request: Request, call_next):
        if not is_origin_allowed(
            request.method,
            request.headers.get("origin"),
            request.headers.get("referer"),
            allowed_origins,
        ):
            return Response(status_code=403, content="CSRF: origin 不許可")
        return await call_next(request)

    # ------------------------------------------------------------------
    # 認証([12]§1.3)
    # ------------------------------------------------------------------
    @app.post("/api/auth/login")
    async def login(request: Request, response: Response):
        body = await request.json()
        sid = auth.login(body.get("id", ""), body.get("password", ""))
        if sid is None:
            return Response(status_code=401)
        response.set_cookie(
            COOKIE_NAME, sid, httponly=True, secure=True, samesite="strict"
        )
        return {"ok": True}

    @app.post("/api/auth/logout")
    async def logout(request: Request, response: Response):
        sid = request.cookies.get(COOKIE_NAME)
        if sid:
            auth.logout(sid)
        response.delete_cookie(COOKIE_NAME)
        return {"ok": True}

    @app.get("/healthz")
    async def healthz():
        sessions = len(getattr(mgr, "_sessions", {}) or {})
        return {"ok": True, "sessions": sessions}

    # ------------------------------------------------------------------
    # REST ルータ(chara / register)
    # ------------------------------------------------------------------
    from app.rest.chara import build_chara_router
    from app.rest.register import build_register_router

    assets = assets_dir or os.environ.get("PHI_ASSETS_DIR") or "./assets"
    store = auth.store
    app.include_router(build_chara_router(
        store, assets,
        require_account=require_account, rate_limiter=rate_limiter,
    ))

    if registrar_factory is None:  # pragma: no cover - 統合層(本番起動)
        from app.register import LegacyRegistrar
        reg_host = os.environ.get("PHI_HOST", "")
        reg_port = int(os.environ.get("PHI_PORT", "0") or 0)

        def registrar_factory():  # type: ignore[misc]
            return LegacyRegistrar(reg_host, reg_port)

    app.include_router(build_register_router(
        store, registrar_factory, auth.cipher,
        require_account=require_account, rate_limiter=rate_limiter,
    ))

    # ------------------------------------------------------------------
    # WS([07])
    # ------------------------------------------------------------------
    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket):  # pragma: no cover - 統合層
        conn = WsConnection(
            websocket, mgr, auth=auth,
            rate_limiter=rate_limiter, conn_limiter=conn_limiter,
        )
        await conn.run()

    return app
