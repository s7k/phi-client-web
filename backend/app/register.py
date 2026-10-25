"""B15 新規キャラ登録(#ex-register, [12]§2)。

レガシー登録プロトコルを**一時レガシー接続**で代行([12]§2.2)。出典:
`legacy/server new_proto.c` `ex_register`/`ex_adduser_v52`/`ex_adduser_v52_finish`/`ex_get`。

フロー([12]§2.1)
------------------------------------------------------------------
1. `#ex-register start`            … 登録モード開始(サーバ timeout 600s)。
2. `#ex-get REGINFO IMG`           … 初期グラ一覧要求
       → `#ex-put REGINFO IMG` <グラ名...> `#ex-put .`
3. `name="<名>" pass=<6字> image=<索引> mail=<メール>`
       … `#` 無しの行で送る。`#ex-register` を前置すると phi_dm.c は
         start/end/cancel 以外として捨てる(ex_adduser_v52 に届かない)
4. `#ex-register end`              … 確定
       OK   → new_user でキャラ生成し `#set-user-id <uid>` を返す
       NG   → `#ex-register reject [name] [pass] [image] [mail]`(欠陥項目列挙)
5. `#ex-register cancel`           … 中止

uid 供給
------------------------------------------------------------------
uid = `<addw><5桁 s_id><6字 pass>` をサーバが組む。BE は addw/s_id を持たない
ため、new_user が送る `#set-user-id <uid>` を捕捉する
(upd-phi-server-v5y `src/core/phi_dm.c` new_user)。
登録が通るとその接続はそのままログイン状態になるので、uid 捕捉後に `#x` で抜ける。
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
    # `#set-user-id` で受け取った uid。
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

        """
        sock = self._socket_factory()
        try:
            await self._connect(sock)
            await self._send(sock, "#ex-register start")
            # name は空白を含み得るので "" で囲む(get_property が対応)。
            props = (
                f'name="{name}" pass={password} '
                f"image={image_index} mail={mail}"
            )
            await self._send(sock, props)
            await self._send(sock, "#ex-register end")
            result = await asyncio.wait_for(
                self._read_result(sock, name, image_index),
                timeout=self._timeout,
            )
            # 登録した接続はログイン済みになっている。ログアウトして閉じる。
            try:
                await self._send(sock, "#x")
            except RegisterTransport:
                pass
            return result
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
        - `#set-user-id <uid>`      → 成功(uid 捕捉)
        - uid を受け取る前に切断 → RegisterTransport(uid 無しでは #open 出来ない)。
        """
        while True:
            raw = await sock.read_line()
            if raw is None:
                raise RegisterTransport("登録結果を受け取る前に切断")
            line = raw.decode("cp932", errors="replace").rstrip("\r").strip()
            if line.startswith("#ex-register reject"):
                fields = self._parse_reject(line)
                raise RegisterReject(fields)
            if line.startswith("#set-user-id"):
                uid = line[len("#set-user-id"):].strip() or None
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


def _has_control_chars(s: str) -> bool:
    """改行・タブ等の制御文字(C0 + DEL)を含むか(CR-13 プロトコル行注入対策)。

    `#ex-register name=<名> pass=<pass> ...` の1行に連結して送るため、改行や
    制御文字が混入すると行を割って任意プロトコルコマンドを注入され得る。
    """
    return any(ord(c) < 0x20 or ord(c) == 0x7F for c in s)


def validate_register_input(
    name: str, password: str, image_index: int, mail: str = ""
) -> list[str]:
    """送信前のローカル検証([12]§2.1 準拠)。欠陥項目 list を返す(空=OK)。

    name: 2字以上 / pass: 正確に6字 / image: 0以上。
    CR-13: name/pass/mail に改行・制御文字を含む場合は拒否(プロトコル行注入)。
    サーバ側でも再検証されるが事前弾きで往復削減。
    """
    fields: list[str] = []
    # name は "" で囲んで送るので " を含めない。
    if len(name) < 2 or _has_control_chars(name) or '"' in name:
        fields.append("name")
    if len(password) != PASS_LEN or _has_control_chars(password):
        fields.append("pass")
    if image_index < 0:
        fields.append("image")
    if mail and _has_control_chars(mail):
        fields.append("mail")
    return fields
