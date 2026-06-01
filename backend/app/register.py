"""B15 新規キャラ登録(#ex-register, [12]§2)。

レガシー登録プロトコルを**一時レガシー接続**で代行([12]§2.2)。出典:
`legacy/server new_proto.c` `ex_register`/`ex_adduser_v52`/`ex_adduser_v52_finish`/`ex_get`。

フロー([12]§2.1)
------------------------------------------------------------------
1. `#ex-register start`            … 登録モード開始(サーバ timeout 600s)。
2. `#ex-get REGINFO IMG`           … 初期グラ一覧要求
       → `#ex-put REGINFO IMG` <グラ名...> `#ex-put .`
3. `#ex-register name=<名> pass=<6字> image=<索引> mail=<メール>`
4. `#ex-register end`              … 確定
       OK   → new_user でキャラ生成(サーバ通知/uid)
       NG   → `#ex-register reject [name] [pass] [image] [mail]`(欠陥項目列挙)
5. `#ex-register cancel`           … 中止

⛔ 検証はモックTCPのみ([タスク])。実サーバへ start/end は送らない
   (実キャラ作成は迷惑/クラッタ)。

uid 供給(Q-2.4)
------------------------------------------------------------------
uid = `<addw><5桁 s_id><6字 pass>` をサーバが組む。BE は addw/s_id を持たない
ため、登録成功時にサーバが返す uid 通知(`#ex-put UID <uid>` 等)を捕捉する。
通知が無い実装では uid 不明 → `legacy_uid_enc=None` 保存(後続 #open は要手当)。
本ラウンドはモック前提でこの捕捉経路を実装し、実機の供給元確認は Q-R5-1 として残す。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass

from app.legacy_socket import LegacySocket

# サーバ応答待ちタイムアウト(秒)。レガシー側 timeout は 600s だが BE 側は短く。
REGISTER_TIMEOUT_SEC = 30.0
PASS_LEN = 6


class RegisterError(Exception):
    """登録失敗の基底。"""


@dataclass
class RegisterReject(RegisterError):
    """サーバが reject(欠陥項目列挙)。"""

    fields: list[str]

    def __str__(self) -> str:  # noqa: D401
        return f"register rejected: {', '.join(self.fields)}"


class RegisterTransport(RegisterError):
    """接続/送受信失敗・タイムアウト。"""


@dataclass
class RegisterResult:
    """登録成功結果。"""

    name: str
    image_index: int
    # サーバが uid を通知した場合のみ(Q-R5-1)。無ければ None。
    uid: str | None = None


class LegacyRegistrar:
    """一時レガシー接続で #ex-register 代行([12]§2.2)。

    socket_factory: LegacySocket を返す callable(テストはモック注入)。
    """

    def __init__(
        self,
        host: str,
        port: int,
        socket_factory=None,
        *,
        timeout: float = REGISTER_TIMEOUT_SEC,
    ) -> None:
        self._host = host
        self._port = port
        self._socket_factory = socket_factory or LegacySocket
        self._timeout = timeout

    # ------------------------------------------------------------------
    # 初期グラ一覧(#ex-get REGINFO IMG)
    # ------------------------------------------------------------------

    async def fetch_graphics(self) -> list[str]:
        """初期グラ名一覧を取得([12]§2.3 GET /api/register/graphics)。"""
        sock = self._socket_factory()
        try:
            await self._connect(sock)
            await self._send(sock, "#ex-get REGINFO IMG")
            return await asyncio.wait_for(
                self._read_graphics(sock), timeout=self._timeout
            )
        except asyncio.TimeoutError as exc:
            raise RegisterTransport("REGINFO IMG タイムアウト") from exc
        finally:
            await sock.close()

    async def _read_graphics(self, sock: LegacySocket) -> list[str]:
        """`#ex-put REGINFO IMG` … `#ex-put .` 区間のグラ名を収集。"""
        graphics: list[str] = []
        started = False
        while True:
            raw = await sock.read_line()
            if raw is None:
                raise RegisterTransport("REGINFO 受信中に切断")
            line = raw.decode("cp932", errors="replace").rstrip("\r")
            if not started:
                if line.strip() == "#ex-put REGINFO IMG":
                    started = True
                continue
            if line.strip() == "#ex-put .":
                return graphics
            graphics.append(line)

    # ------------------------------------------------------------------
    # 登録(start → name/pass/image/mail → end)
    # ------------------------------------------------------------------

    async def register(
        self,
        name: str,
        password: str,
        image_index: int,
        mail: str = "",
    ) -> RegisterResult:
        """登録代行。成功で RegisterResult、reject で RegisterReject。

        ⛔ モックTCP専用。実サーバ未実行([タスク])。
        """
        sock = self._socket_factory()
        try:
            await self._connect(sock)
            await self._send(sock, "#ex-register start")
            # key=value 行(name は空白を含み得るが本実装は単純連結)。
            props = (
                f"#ex-register name={name} pass={password} "
                f"image={image_index} mail={mail}"
            )
            await self._send(sock, props)
            await self._send(sock, "#ex-register end")
            return await asyncio.wait_for(
                self._read_result(sock, name, image_index),
                timeout=self._timeout,
            )
        except asyncio.TimeoutError as exc:
            # タイムアウト時は中止を試みる(best-effort)。
            try:
                await self._send(sock, "#ex-register cancel")
            except (OSError, ConnectionError):
                pass
            raise RegisterTransport("登録応答タイムアウト") from exc
        finally:
            await sock.close()

    async def _read_result(
        self, sock: LegacySocket, name: str, image_index: int
    ) -> RegisterResult:
        """end 後の応答を解釈。

        - `#ex-register reject ...` → RegisterReject(欠陥項目)
        - `#ex-put UID <uid>`       → 成功(uid 捕捉)
        - それ以外(無通知)は read を続け、切断 or 妥当な成功シグナルで終了。
        """
        while True:
            raw = await sock.read_line()
            if raw is None:
                # 通知無しで切断 → uid 不明だが reject では無いため成功扱い。
                return RegisterResult(name=name, image_index=image_index)
            line = raw.decode("cp932", errors="replace").rstrip("\r").strip()
            if line.startswith("#ex-register reject"):
                fields = self._parse_reject(line)
                raise RegisterReject(fields)
            if line.startswith("#ex-put UID"):
                uid = line[len("#ex-put UID"):].strip() or None
                return RegisterResult(
                    name=name, image_index=image_index, uid=uid
                )
            # 関係ない行は読み飛ばす。

    @staticmethod
    def _parse_reject(line: str) -> list[str]:
        """`#ex-register reject [name] [pass] [image] [mail]` → 欠陥項目 list。"""
        rest = line[len("#ex-register reject"):]
        valid = {"name", "pass", "image", "mail"}
        return [tok for tok in rest.split() if tok in valid]

    # ------------------------------------------------------------------
    # ヘルパ
    # ------------------------------------------------------------------

    async def _connect(self, sock: LegacySocket) -> None:
        try:
            await sock.connect(self._host, self._port)
        except (OSError, ConnectionError) as exc:
            raise RegisterTransport(f"接続失敗: {exc}") from exc

    async def _send(self, sock: LegacySocket, line: str) -> None:
        try:
            await sock.send_line(line)
        except (OSError, ConnectionError) as exc:
            raise RegisterTransport(f"送信失敗: {exc}") from exc


def validate_register_input(
    name: str, password: str, image_index: int
) -> list[str]:
    """送信前のローカル検証([12]§2.1 準拠)。欠陥項目 list を返す(空=OK)。

    name: 2字以上 / pass: 正確に6字 / image: 0以上。
    サーバ側でも再検証されるが事前弾きで往復削減。
    """
    fields: list[str] = []
    if len(name) < 2:
        fields.append("name")
    if len(password) != PASS_LEN:
        fields.append("pass")
    if image_index < 0:
        fields.append("image")
    return fields
