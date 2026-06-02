"""B7 WsServer: FastAPI WebSocket エンドポイント([07])。

責務
------------------------------------------------------------------
- WS 接続ごとに 1 つの `WsConnection` を生成し、エンベロープ([07]§2)を解析。
- `hello`(§4) を接続直後に送出。
- C→S: `session.open {charId}`(A-10 応答)/その他 intent を SessionManager へ。
- S→C: SessionManager から来たイベントを outbound キュー経由で WS へ送出
  (受信ループと送信ループを分離し、イベント順序を保つ)。
- session 省略時はアクティブ(直近 open)セッションへ解決(A-03)。

認証(アカウント+複数キャラ 再設計, A-34, [07]§4.1, [12]§1, B12, A-33):
  - 1アカウント(ログインID + パスワード)の下に複数キャラ。token は FE が
    localStorage 保持(A-33: cookie 廃止)。
  - **WS 接続直後は未認証**。FE が最初に `{type:"auth", token}` を送る →
    BE が `AuthService.validate` → account_id 設定 → `{type:"auth", ok:true, isAdmin}`
    応答。token 無効は `{type:"auth", ok:false}`。
  - `settings`/`session.open` は認証後に有効。
  - `session.open {charId}`: token の account が所有する char を取得(他人の char は
    エラー)、phi_uid を復号 → 接続 + `#open <phi_uid>`。
  - REST `POST /api/auth/login {accountId,password}` で token を JSON body で返却。
    保護 REST は `Authorization: Bearer <token>` で認証。`/api/auth/logout`(Bearer)。
"""
from __future__ import annotations

import asyncio
import logging
import time

# FastAPI ハンドラの型注釈解決のため module グローバルに置く
# (`from __future__ import annotations` で注釈が文字列化されるため、
#  関数ローカル import だと FastAPI の get_type_hints が解決できない)。
from fastapi import HTTPException, Request, Response, WebSocket  # noqa: E402

from app.session import SessionManager
from app.settings_schema import validate_setting

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
        login_throttle=None,
        store=None,
    ) -> None:
        self._ws = ws
        self._mgr = manager
        self._auth = auth  # AuthService | None
        # settings 永続化用 Store(CR-1)。未指定時は auth.store を流用。
        self._store = store if store is not None else getattr(auth, "store", None)
        self._rl = rate_limiter   # RateLimiter | None(command.raw/chat)
        self._cl = conn_limiter   # ConcurrencyLimiter | None(WS同時接続)
        self._lt = login_throttle  # LoginThrottle | None(将来用, 未配線)
        self._outbound: asyncio.Queue[dict] = asyncio.Queue()
        # この接続が開いた session 群(切断時に detach)。
        self._sessions: list[str] = []
        # 認証済みアカウント(token 検証で設定。A-34)。
        self._account_id: str | None = None
        # 同時接続カウンタ確保済みか(release 二重防止)。
        self._conn_acquired = False

    # ------------------------------------------------------------------
    # エントリポイント
    # ------------------------------------------------------------------

    async def run(self) -> None:
        await self._ws.accept()
        # 接続直後は未認証(A-33)。FE が `{type:"auth", token}` を送るまで未認証。
        await self._ws.send_json({
            "type": "hello",
            "protocolVersion": PROTOCOL_VERSION,
            "serverTime": int(time.time() * 1000),
            "authenticated": False,
            "isAdmin": False,
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

    async def _handle_auth(self, msg: dict) -> None:
        """WS auth メッセージ `{type:"auth", token}` を処理(A-33/A-34)。

        token を `AuthService.validate` で検証し account_id を設定。
        成功: `{type:"auth", ok:true, isAdmin}`。失敗/欠落: `{type:"auth", ok:false}`。
        auth 未設定(テスト/開発)時は token 無しでも ok:true で通す(未認証許可)。
        token はログ/応答に出さない(資格情報)。
        """
        token = msg.get("token")
        if self._auth is None:
            await self._ws.send_json({
                "type": "auth", "reqId": msg.get("reqId"),
                "ok": True, "isAdmin": False,
            })
            return
        ident = self._auth.validate(token) if token else None
        if ident is None or not self._acquire_conn(ident.account_id):
            await self._ws.send_json({
                "type": "auth", "reqId": msg.get("reqId"), "ok": False,
            })
            return
        self._account_id = ident.account_id
        await self._ws.send_json({
            "type": "auth", "reqId": msg.get("reqId"),
            "ok": True, "isAdmin": self._auth.is_admin(ident.account_id),
        })

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
        except Exception:  # noqa: BLE001 - 接続維持のため最終捕捉
            # L-4: 内部例外文字列はクライアントへ返さず、詳細はサーバログのみ。
            logging.getLogger("phi.ws").exception("dispatch failed")
            await self._error(msg, "INTERNAL", "内部エラー")

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

    def _acquire_conn(self, key: str) -> bool:
        """WS同時接続数を確保(5/identity, [12]§4)。確保済なら True 維持。"""
        if self._cl is None or self._conn_acquired:
            return True
        if self._cl.acquire(key):
            self._conn_acquired = True
            return True
        return False

    # ------------------------------------------------------------------
    # session.open(A-10 / A-34: charId → 復号 → open)
    # ------------------------------------------------------------------

    async def _handle_session_open(self, msg: dict) -> None:
        """`session.open {charId}`(A-34)。

        token の account が所有する char を取得(他人/不在の char はエラー)、
        phi_uid を復号 → `open_session(open_id=phi_uid, host=char.host, port=char.port)`
        → `#open <phi_uid>`。応答 `{ok, session, isAdmin, label}`。
        phi_uid はログ/エラーに出さない(資格情報)。

        開発/テスト用に auth 未設定時は charId をそのまま open_id として使う
        (従来 FakeSocket テスト互換)。
        """
        char_id = msg.get("charId") or msg.get("id")
        if not char_id:
            await self._error(msg, "BAD_REQUEST", "charId が必要")
            return
        char_id = str(char_id)

        if self._auth is None:
            # 未配線(テスト): charId をそのまま open_id 扱い。host/port は msg から。
            try:
                host = self._coerce_host(msg.get("host"))
                port = self._coerce_port(msg.get("port"))
            except ValueError as exc:
                await self._error(msg, "BAD_REQUEST", str(exc))
                return
            await self._open_and_respond(
                msg, open_id=char_id, key=char_id,
                host=host, port=port, is_admin=False, label=None,
            )
            return

        if self._account_id is None:
            await self._error(msg, "SESSION_NOT_FOUND", "未認証")
            return
        row = self._auth.store.get_character(char_id)
        if row is None or row["account_id"] != self._account_id:
            # 他人の char / 不在は所有エラー(生 uid は出さない)。
            await self._ws.send_json({
                "type": "session.open", "reqId": msg.get("reqId"),
                "ok": False,
                "error": {"code": "FORBIDDEN", "message": "キャラが見つからない"},
            })
            return
        if row["phi_uid_enc"] is None:
            await self._error(msg, "BAD_REQUEST", "キャラに PHI uid 未登録")
            return
        open_id = self._auth.cipher.decrypt(row["phi_uid_enc"])
        await self._open_and_respond(
            msg, open_id=open_id, key=char_id,
            host=row["host"], port=row["port"],
            is_admin=self._auth.is_admin(self._account_id),
            label=row["label"],
        )

    async def _open_and_respond(
        self, msg: dict, *, open_id: str, key: str,
        host: str | None, port: int | None, is_admin: bool, label: str | None,
    ) -> None:
        """open_session 実行 + session.open 応答。phi_uid はログ/エラー非出力。"""
        try:
            sid = await self._mgr.open_session(
                open_id, on_event=self._enqueue, key=key,
                host=host, port=port,
            )
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
            "ok": True, "session": sid, "isAdmin": is_admin, "label": label,
        })

    @staticmethod
    def _coerce_host(value) -> str | None:
        """host 入力を正規化。None/空文字 → None(既定/保存値へフォールバック)。"""
        if value is None:
            return None
        s = str(value).strip()
        return s or None

    @staticmethod
    def _coerce_port(value) -> int | None:
        """port 入力を int 検証。None → None。不正(非数値/範囲外)は ValueError。"""
        if value is None or value == "":
            return None
        try:
            port = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("port が不正(整数で指定)") from exc
        if not (1 <= port <= 65535):
            raise ValueError("port が範囲外(1-65535)")
        return port

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
            await self._error(msg, "SESSION_NOT_FOUND", "未認証(設定には要セッション)")
            return

        if t == "settings.get":
            raw = self._store.get_account_setting(self._account_id, scope)
            # 旧 broken データ(不正JSON)に備え握る。壊れていれば None 返却。
            try:
                value = json.loads(raw) if raw is not None else None
            except (ValueError, TypeError):
                value = None
            await self._ws.send_json({
                "type": "settings", "reqId": msg.get("reqId"),
                "ok": True, "scope": scope, "value": value,
            })
            return

        # settings.set: value を検証 → JSON 文字列で永続化し ok 応答。
        value = msg.get("value")
        err = validate_setting(scope, value)
        if err is not None:
            await self._error(msg, "BAD_REQUEST", f"invalid settings value: {err}")
            return
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

def _bearer_token(request: Request) -> str | None:
    """`Authorization: Bearer <token>` ヘッダから token を取り出す(A-33)。

    無し/スキーム不一致は None。token はログに出さない(資格情報)。
    """
    header = request.headers.get("authorization")
    if not header:
        return None
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


def make_require_account(auth):
    """`require_account` 依存を生成([12]§1.3, A-34, A-33 Bearer)。

    `Authorization: Bearer <token>` の token を `AuthService.validate` で検証し
    account_id を返す。無効/欠落は 401。REST 保護エンドポイントに注入。
    """
    async def _require_account(request: Request) -> str:
        token = _bearer_token(request)
        account_id = auth.validate_account(token) if token else None
        if account_id is None:
            raise HTTPException(401, "未認証")
        return account_id

    return _require_account


def make_require_admin(auth):
    """`require_admin` 依存を生成([08]§10, 管理者限定の変更系, A-33 Bearer)。

    `require_account` と同経路で Bearer token 検証し account_id を解決後、
    `accounts.is_admin` を確認。未認証は 401、非管理者は 403。
    キャラグラの変更系(upload/delete/index 編集/import)に注入。
    """
    async def _require_admin(request: Request) -> str:
        token = _bearer_token(request)
        account_id = auth.validate_account(token) if token else None
        if account_id is None:
            raise HTTPException(401, "未認証")
        if not auth.is_admin(account_id):
            raise HTTPException(403, "管理者権限が必要")
        return account_id

    return _require_admin


def create_app(
    manager: SessionManager | None = None,
    auth=None,
    *,
    assets_dir: str | None = None,
    registrar_factory=None,
    rate_limiter=None,
    conn_limiter=None,
    login_throttle=None,
):
    """FastAPI アプリを生成(REST 統合 + WS)。

    マウント:
    - `/ws`                          : WebSocket([07])。auth は接続後 `{type:"auth",token}`。
    - `/api/auth/register|login|logout` : アカウント認証([12]§1, A-34)。token を JSON 返却。
    - `/api/characters/*`            : キャラ CRUD([12]§1, A-34)。要認証 + 所有検証。
    - `/api/chara/*`                 : キャラグラ([08], B10)。変更系は管理者限定 + レート。
    - `/api/register/*`              : 新規登録([12]§2, B15)。register は要認証 + レート/IP。

    引数:
    - assets_dir       : キャラグラ保存先(既定 env `PHI_ASSETS_DIR` or `./assets`)。
    - registrar_factory: () -> LegacyRegistrar(既定は env のレガシー接続情報)。
    - rate_limiter     : RateLimiter(既定で生成)。
    - conn_limiter     : ConcurrencyLimiter(既定で生成)。

    *auth* 省略時は `PHI_DB_PATH` から Store を開き AuthService を構築。

    A-33: token 認証(Bearer/WS-auth)へ移行し cookie を廃止。アンビエント資格
    (cookie)が無いため CSRF 対策(Origin 検査)は不要 → ミドルウェア未装着。
    """
    import contextlib
    import os

    from fastapi import FastAPI  # WebSocket はモジュールレベルでimport(注釈解決のため)

    from app.ratelimit import ConcurrencyLimiter, LoginThrottle, RateLimiter

    mgr = manager or SessionManager(
        host=os.environ.get("PHI_HOST", ""),
        port=int(os.environ.get("PHI_PORT", "0") or 0),
    )

    # CR-18: graceful shutdown で全アクティブセッションへ #x + detach。
    @contextlib.asynccontextmanager
    async def lifespan(_app):
        yield
        shutdown = getattr(mgr, "shutdown", None)
        if callable(shutdown):
            await shutdown()

    app = FastAPI(title="phi-client-web gateway", lifespan=lifespan)
    app.state.session_manager = mgr

    if auth is None:  # pragma: no cover - 統合層(本番起動)
        from app.auth import AuthService
        from app.store import Store
        auth = AuthService(Store.open(os.environ.get("PHI_DB_PATH")))
    app.state.auth = auth

    rate_limiter = rate_limiter if rate_limiter is not None else RateLimiter()
    conn_limiter = conn_limiter if conn_limiter is not None else ConcurrencyLimiter()
    login_throttle = login_throttle if login_throttle is not None else LoginThrottle()
    app.state.rate_limiter = rate_limiter
    app.state.conn_limiter = conn_limiter
    app.state.login_throttle = login_throttle

    require_account = make_require_account(auth)
    require_admin = make_require_admin(auth)

    # A-33: cookie 廃止で CSRF(Origin 検査)ミドルウェアは撤去。
    # token を localStorage 保持 + Bearer/WS-auth で送るためアンビエント資格が無く、
    # CSRF も Secure cookie の非HTTPS拒否問題も発生しない。

    # ------------------------------------------------------------------
    # 認証(アカウント+複数キャラ, A-34, A-33: token を JSON body 返却)
    # ------------------------------------------------------------------
    @app.post("/api/auth/register")
    async def register_account(request: Request):
        """新規アカウント作成。body `{accountId, password}`。

        - 成功 `{ok:true}`。
        - 既存 accountId → 409。
        - accountId 空 / パスワード最小長未満 → 400。
        password はログ/エラーへ出さない(資格情報)。
        """
        body = await request.json()
        account_id = str(body.get("accountId", "") or "")
        password = str(body.get("password", "") or "")
        try:
            auth.register(account_id, password)
        except ValueError as exc:
            if str(exc) == "account exists":
                raise HTTPException(409, "アカウントは既に存在します") from exc
            raise HTTPException(400, str(exc)) from exc
        return {"ok": True}

    @app.post("/api/auth/login")
    async def login_account(request: Request):
        """アカウント検証→token 発行。body `{accountId, password}`。

        - 成功 `{ok:true, token, isAdmin}`(Set-Cookie しない)。
        - 失敗(未登録/パスワード不一致)→ 401。
        - 総当たり抑止(account+IP レート, LoginThrottle)。
        password/token はログ/エラーへ出さない。
        """
        from app.rest.register import client_ip

        body = await request.json()
        account_id = str(body.get("accountId", "") or "")
        password = str(body.get("password", "") or "")
        ip = client_ip(request)
        if not login_throttle.check(account_id, ip):
            raise HTTPException(429, "ログイン試行が多すぎます")
        token = auth.login(account_id, password)
        if token is None:
            login_throttle.record_failure(account_id, ip)
            raise HTTPException(401, "認証失敗")
        login_throttle.reset_key(account_id, ip)
        return {"ok": True, "token": token, "isAdmin": auth.is_admin(account_id)}

    @app.post("/api/auth/logout")
    async def logout(request: Request):
        token = _bearer_token(request)
        if token:
            auth.logout(token)
        return {"ok": True}

    @app.get("/healthz")
    async def healthz():
        sessions = len(getattr(mgr, "_sessions", {}) or {})
        return {"ok": True, "sessions": sessions}

    # ------------------------------------------------------------------
    # REST ルータ(chara / register)
    # ------------------------------------------------------------------
    from app.rest.chara import build_chara_router
    from app.rest.characters import build_characters_router
    from app.rest.register import build_register_router

    assets = assets_dir or os.environ.get("PHI_ASSETS_DIR") or "./assets"
    store = auth.store
    app.include_router(build_chara_router(
        store, assets,
        require_admin=require_admin, rate_limiter=rate_limiter,
    ))
    app.include_router(build_characters_router(
        store, auth.cipher, require_account,
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
            login_throttle=login_throttle,
        )
        await conn.run()

    return app
