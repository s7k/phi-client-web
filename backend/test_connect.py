#!/usr/bin/env python3
"""
レガシーphiサーバへの疎通検証スクリプト（フェーズ0）。

phi-client (phi/protocol/connection.py, phi/network/network_thread.py) の
接続・ログインシーケンスを単体（PySide6非依存）で再現し、サーバ応答を
UTF-8変換して標準出力へダンプする。
"""
from __future__ import annotations

import os
import select
import socket
import sys
import time

# 接続先・キャラIDは秘匿のため環境変数から取得（実値はコミットしない）。
#   PHI_HOST=<server-ip> PHI_PORT=<port> PHI_CHARACTER_ID=<id> python test_connect.py
HOST = os.environ.get("PHI_HOST", "127.0.0.1")
PORT = int(os.environ.get("PHI_PORT", "20000"))
CHARACTER_ID = os.environ.get("PHI_CHARACTER_ID", "<CHARACTER_ID>")
VERSION_STRING = "05107100"

RECV_BUFFER_SIZE = 32768
RECV_SECONDS = 15.0  # この秒数だけ受信し続けて終了


def is_sjis_lead(b: int) -> bool:
    return (0x81 <= b <= 0x9F) or (0xE0 <= b <= 0xFC)


class LineBuffer:
    def __init__(self) -> None:
        self._partial = b""

    def feed(self, data: bytes) -> list[bytes]:
        combined = self._partial + data
        parts = combined.split(b"\n")
        self._partial = parts[-1]
        out = []
        for line in parts[:-1]:
            out.append(line.rstrip(b"\r"))
        return out


def to_utf8(raw: bytes) -> str:
    return raw.decode("cp932", errors="replace")


def main() -> int:
    print(f"[*] connect {HOST}:{PORT} id={CHARACTER_ID}", flush=True)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10.0)
    try:
        sock.connect((HOST, PORT))
    except OSError as exc:
        print(f"[!] 接続失敗: {exc}", flush=True)
        return 1
    print("[+] connected", flush=True)
    sock.setblocking(True)

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
    deadline = time.monotonic() + RECV_SECONDS
    line_count = 0
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        r, _, _ = select.select([sock], [], [], min(remaining, 1.0))
        if not r:
            # ラグ計測などの応答が必要な場合のキープアライブ
            continue
        try:
            data = sock.recv(RECV_BUFFER_SIZE)
        except OSError as exc:
            print(f"[!] recv error: {exc}", flush=True)
            break
        if not data:
            print("[!] server closed connection", flush=True)
            break
        for raw in lb.feed(data):
            line_count += 1
            text = to_utf8(raw)
            # #lag には #end-lag 応答
            if text == "#lag":
                sock.sendall(b"#end-lag\n")
                print("  << #lag  (>> #end-lag 応答)", flush=True)
                continue
            # 長い行は先頭120文字
            disp = text if len(text) <= 120 else text[:120] + " …(略)"
            print(f"  << {disp}", flush=True)

    print(f"[*] 受信行数: {line_count}", flush=True)
    sock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
