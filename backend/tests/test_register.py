"""B15 登録(#ex-register)テスト([12]§2)。

⛔ 実サーバ未接続。モックTCP(スクリプト応答)のみで検証([タスク])。
"""
from __future__ import annotations

import asyncio
from collections import deque

import pytest

from app.register import (
    LegacyRegistrar,
    RegisterReject,
    RegisterResult,
    RegisterTransport,
    validate_register_input,
)


class ScriptedSocket:
    """LegacySocket 互換モック。send_line で受信スクリプトを駆動するフックも持つ。

    `script`: クライアント送信行 → 追加で inbox へ積む応答 list のマップ。
    `inbox`: 事前/動的に積む応答(bytes, cp932)。read_line が順次返す。
    """

    def __init__(self, on_send=None, preload=None) -> None:
        self.connected = False
        self.sent: list[str] = []
        self._inbox: deque[bytes | None] = deque(preload or [])
        self._on_send = on_send

    async def connect(self, host, port, timeout=10.0):
        self.connected = True

    async def close(self):
        self.connected = False

    async def send_line(self, text: str):
        self.sent.append(text)
        if self._on_send is not None:
            for resp in self._on_send(text):
                self._inbox.append(resp)

    async def send_bytes(self, data: bytes):
        self.sent.append(data.decode("cp932", errors="replace"))

    async def read_line(self):
        # 応答が無ければ「切断(None)」を返す(無限待ち回避)。
        if self._inbox:
            return self._inbox.popleft()
        return None


def _b(s: str) -> bytes:
    return s.encode("cp932")


# --- fetch_graphics -------------------------------------------------------

@pytest.mark.asyncio
async def test_fetch_graphics():
    def on_send(text):
        if text == "#ex-get REGINFO IMG":
            return [
                _b("#ex-put REGINFO IMG"),
                _b("戦士"),
                _b("魔法使い"),
                _b("僧侶"),
                _b("#ex-put ."),
            ]
        return []

    sock = ScriptedSocket(on_send=on_send)
    reg = LegacyRegistrar("h", 0, socket_factory=lambda: sock)
    graphics = await reg.fetch_graphics()
    assert graphics == ["戦士", "魔法使い", "僧侶"]
    assert "#ex-get REGINFO IMG" in sock.sent


# --- register 成功(uid 通知あり) -----------------------------------------

@pytest.mark.asyncio
async def test_register_success_with_uid():
    def on_send(text):
        if text == "#ex-register end":
            return [_b("#ex-put UID AAA00042pass12")]
        return []

    sock = ScriptedSocket(on_send=on_send)
    reg = LegacyRegistrar("h", 0, socket_factory=lambda: sock)
    result = await reg.register("Hero", "abc123", 0, "x@y.z")
    assert isinstance(result, RegisterResult)
    assert result.name == "Hero"
    assert result.uid == "AAA00042pass12"
    # 送信順序: start → props → end
    assert sock.sent[0] == "#ex-register start"
    assert sock.sent[1].startswith("#ex-register name=Hero pass=abc123 image=0 mail=x@y.z")
    assert sock.sent[2] == "#ex-register end"


@pytest.mark.asyncio
async def test_register_success_no_uid_notification():
    # end 後にサーバ無通知で切断 → reject でなければ成功扱い(uid None)。
    sock = ScriptedSocket(on_send=lambda t: [])
    reg = LegacyRegistrar("h", 0, socket_factory=lambda: sock)
    result = await reg.register("Hero", "abc123", 1)
    assert result.uid is None
    assert result.name == "Hero"


# --- reject 各項目 --------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("reject_line,expected", [
    ("#ex-register reject name", ["name"]),
    ("#ex-register reject pass", ["pass"]),
    ("#ex-register reject image", ["image"]),
    ("#ex-register reject mail", ["mail"]),
    ("#ex-register reject name pass image mail", ["name", "pass", "image", "mail"]),
])
async def test_register_reject_fields(reject_line, expected):
    def on_send(text):
        if text == "#ex-register end":
            return [_b(reject_line)]
        return []

    sock = ScriptedSocket(on_send=on_send)
    reg = LegacyRegistrar("h", 0, socket_factory=lambda: sock)
    with pytest.raises(RegisterReject) as ei:
        await reg.register("Hero", "abc123", 0)
    assert ei.value.fields == expected


# --- transport / timeout --------------------------------------------------

@pytest.mark.asyncio
async def test_register_connect_failure():
    class FailSock(ScriptedSocket):
        async def connect(self, host, port, timeout=10.0):
            raise OSError("refused")

    reg = LegacyRegistrar("h", 0, socket_factory=lambda: FailSock())
    with pytest.raises(RegisterTransport):
        await reg.register("Hero", "abc123", 0)


@pytest.mark.asyncio
async def test_register_timeout_sends_cancel():
    # read_line が永遠にブロック → timeout → cancel 送出。
    class BlockSock(ScriptedSocket):
        async def read_line(self):
            await asyncio.sleep(10)
            return None

    sock = BlockSock()
    reg = LegacyRegistrar("h", 0, socket_factory=lambda: sock, timeout=0.05)
    with pytest.raises(RegisterTransport):
        await reg.register("Hero", "abc123", 0)
    assert "#ex-register cancel" in sock.sent


# --- ローカル事前検証 -----------------------------------------------------

def test_validate_input():
    assert validate_register_input("Hero", "abc123", 0) == []
    assert validate_register_input("H", "abc123", 0) == ["name"]
    assert validate_register_input("Hero", "short", 0) == ["pass"]
    assert validate_register_input("Hero", "abc123", -1) == ["image"]
    assert set(validate_register_input("H", "x", -1)) == {"name", "pass", "image"}


# --- CR-13: プロトコル行注入(改行/制御文字)拒否 ------------------------

def test_validate_rejects_newline_in_name():
    assert "name" in validate_register_input("He\nro", "abc123", 0)
    assert "name" in validate_register_input("He\r\n#x", "abc123", 0)


def test_validate_rejects_control_char_in_pass():
    # 6字だが制御文字混入 → pass 欠陥。
    assert "pass" in validate_register_input("Hero", "ab\x00d12", 0)
    assert "pass" in validate_register_input("Hero", "ab\tc12", 0)


def test_validate_rejects_newline_in_mail():
    bad = validate_register_input("Hero", "abc123", 0, mail="a@b\n#kill")
    assert "mail" in bad


def test_validate_clean_mail_ok():
    assert validate_register_input("Hero", "abc123", 0, mail="a@b.example") == []


# --- CR-10: XFF 詐称耐性(client_ip) -------------------------------------

class _FakeClient:
    def __init__(self, host):
        self.host = host


class _FakeReq:
    def __init__(self, peer, xff=None):
        self.client = _FakeClient(peer)
        self.headers = {}
        if xff is not None:
            self.headers["x-forwarded-for"] = xff


def test_client_ip_ignores_xff_when_no_trusted_proxy():
    from app.rest.register import client_ip
    # trusted_hops=0(既定): XFF を信用せず peer IP のみ。
    req = _FakeReq("10.0.0.1", xff="1.2.3.4, 5.6.7.8")
    assert client_ip(req, trusted_hops=0) == "10.0.0.1"


def test_client_ip_uses_real_client_behind_one_proxy():
    from app.rest.register import client_ip
    # trusted_hops=1: 右から1段(=直近プロキシ=peer 相当)を剥がした手前。
    # XFF = "<client>, <proxy>" の形。peer=プロキシ。
    req = _FakeReq("10.0.0.1", xff="203.0.113.9, 10.0.0.1")
    assert client_ip(req, trusted_hops=1) == "203.0.113.9"


def test_client_ip_spoofed_left_xff_not_used():
    from app.rest.register import client_ip
    # 攻撃者が左に偽 IP を詰めても、trusted_hops=1 では右から1段手前を採用。
    req = _FakeReq("10.0.0.1", xff="9.9.9.9, 203.0.113.9, 10.0.0.1")
    # hops=1 → idx = 3-1-1 = 1 → 203.0.113.9(偽の 9.9.9.9 は無視)。
    assert client_ip(req, trusted_hops=1) == "203.0.113.9"


def test_client_ip_no_xff_falls_back_to_peer():
    from app.rest.register import client_ip
    req = _FakeReq("198.51.100.2")
    assert client_ip(req, trusted_hops=2) == "198.51.100.2"
