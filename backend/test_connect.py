#!/usr/bin/env python3
"""
レガシーphiサーバへの疎通検証スクリプト（フェーズ0 / R2録画）。

phi-client (phi/protocol/connection.py, phi/network/network_thread.py) の
接続・ログインシーケンスを単体（PySide6非依存）で再現し、サーバ応答を
UTF-8変換して標準出力へダンプする。

--record <name> 指定時は生バイト(行間 \\n 込み)を
tests/fixtures/recorded/<name>.rec.bin へ保存する(gitignore。実値はコミットしない)。
保存した録画は ProtocolParser で再生してA-08/09/06/02検証に使う(verify_recording.py)。

接続情報は backend/.env(gitignore)から読む。実値はコード/コミットに残さない。
"""
from __future__ import annotations

import argparse
import os
import select
import socket
import sys
import time
from pathlib import Path


def _load_dotenv() -> None:
    """backend/.env を最小パースで os.environ へ反映(未設定キーのみ)。"""
    env = Path(__file__).parent / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

HOST = os.environ.get("PHI_HOST", "127.0.0.1")
PORT = int(os.environ.get("PHI_PORT", "20000"))
CHARACTER_ID = os.environ.get("PHI_CHARACTER_ID", "<CHARACTER_ID>")
VERSION_STRING = os.environ.get("PHI_VERSION_STRING", "05107100")

RECV_BUFFER_SIZE = 32768
RECV_SECONDS_DEFAULT = 15.0

RECORDED_DIR = Path(__file__).parent / "tests" / "fixtures" / "recorded"


def is_sjis_lead(b: int) -> bool:
    return (0x81 <= b <= 0x9F) or (0xE0 <= b <= 0xFC)


class LineBuffer:
    def __init__(self) -> None:
        self._partial = b""

    def feed(self, data: bytes) -> list[bytes]:
        combined = self._partial + data
        parts = combined.split(b"\n")
        self._partial = parts[-1]
        return [line.rstrip(b"\r") for line in parts[:-1]]


def to_utf8(raw: bytes) -> str:
    return raw.decode("cp932", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", metavar="NAME",
                    help="生バイトを tests/fixtures/recorded/<NAME>.rec.bin へ保存")
    ap.add_argument("--seconds", type=float, default=RECV_SECONDS_DEFAULT,
                    help="受信継続秒数")
    ap.add_argument("--send", action="append", default=[],
                    help="ログイン後に送る生行(A-08/09検証用。複数可)")
    ap.add_argument("--send-delay", type=float, default=2.0,
                    help="ログイン受信後この秒数待ってから --send を送る")
    args = ap.parse_args()

    if HOST in ("", "<SERVER_IP>") or CHARACTER_ID in ("", "<CHARACTER_ID>"):
        print("[!] PHI_HOST / PHI_CHARACTER_ID 未設定(.env)。接続不可。", flush=True)
        return 2

    print(f"[*] connect {HOST}:{PORT} id=<redacted>", flush=True)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10.0)
    try:
        sock.connect((HOST, PORT))
    except OSError as exc:
        print(f"[!] 接続失敗: {exc}", flush=True)
        return 1
    print("[+] connected", flush=True)
    sock.setblocking(True)

    raw_log = bytearray() if args.record else None

    def send_line(text: str) -> None:
        sock.sendall(text.encode("cp932") + b"\n")
        print(f"  >> {text}", flush=True)

    # ログインシーケンス (network_thread._login と同一)
    send_line(f"#open {CHARACTER_ID}")
    send_line(f"#version-cli {VERSION_STRING}")
    send_line("#map-iv 10")
    send_line("#status-iv 10")
    send_line("#ex-switch eagleeye=form")
    send_line("#ex-map size=57")
    send_line("#ex-map style=solid")
    send_line("#ex-switch ex-move-recv=true")
    send_line("#ex-switch ex-list-mode-end=true")
    send_line("#ex-switch ex-disp-magic=true")

    lb = LineBuffer()
    deadline = time.monotonic() + args.seconds
    send_at = time.monotonic() + args.send_delay if args.send else None
    line_count = 0
    while time.monotonic() < deadline:
        if send_at is not None and time.monotonic() >= send_at:
            for s in args.send:
                send_line(s)
            send_at = None
        remaining = deadline - time.monotonic()
        r, _, _ = select.select([sock], [], [], min(remaining, 1.0))
        if not r:
            continue
        try:
            data = sock.recv(RECV_BUFFER_SIZE)
        except OSError as exc:
            print(f"[!] recv error: {exc}", flush=True)
            break
        if not data:
            print("[!] server closed connection", flush=True)
            break
        if raw_log is not None:
            raw_log += data
        for raw in lb.feed(data):
            line_count += 1
            text = to_utf8(raw)
            if text == "#lag":
                sock.sendall(b"#end-lag\n")
                print("  << #lag  (>> #end-lag 応答)", flush=True)
                continue
            disp = text if len(text) <= 120 else text[:120] + " …(略)"
            print(f"  << {disp}", flush=True)

    print(f"[*] 受信行数: {line_count}", flush=True)
    sock.close()

    if raw_log is not None:
        RECORDED_DIR.mkdir(parents=True, exist_ok=True)
        out = RECORDED_DIR / f"{args.record}.rec.bin"
        out.write_bytes(bytes(raw_log))
        print(f"[*] 録画保存: {out} ({len(raw_log)} bytes)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
