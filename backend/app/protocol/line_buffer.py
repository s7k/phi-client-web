"""B1 LineBuffer: Phiプロトコル用のバイト安全な行分割器。

サーバは b'\\n' 区切りで行を送る。受信は任意のチャンク境界で分割されうる
(マルチバイト文字の途中で割れることもある)。本クラスは生バイトを蓄積し、
b'\\n' で確定した行のみを返す。末尾の不完全フラグメントは次 feed() へ繰越し。

SJIS(cp932)境界について
------------------------
cp932 の2バイト文字は 先頭(lead)=0x81-0x9F / 0xE0-0xFC, 第2(trail)=0x40-0x7E / 0x80-0xFC。
区切り文字 0x0A('\\n') は trail バイトの値域に含まれないため、0x0A での分割が
マルチバイト文字を誤って割ることはない。よって行確定後に cp932 デコードすれば安全
([02]§3.3 「\\n で行確定してから変換」)。

末尾が lead バイト単独で残るケースは、その行に b'\\n' が未到達なので自然に
partial として次回へ繰越される(split の最終要素に入る)。追加の特別処理は不要。

phi-client phi/protocol/line_buffer.py を移植(移植元の冗長な if/else を整理)。
"""
from __future__ import annotations


# cp932 lead byte 範囲(判定ヘルパ。境界デバッグ・検証用に公開)
def is_sjis_lead(b: int) -> bool:
    """*b* が cp932 の先頭(lead)バイト値域か。"""
    return (0x81 <= b <= 0x9F) or (0xE0 <= b <= 0xFC)


class LineBuffer:
    """生バイトを蓄積し、確定した行(b'\\n'区切り, \\n含まず)を返す。"""

    def __init__(self) -> None:
        self._partial: bytes = b""

    def feed(self, data: bytes) -> list[bytes]:
        """*data* をバッファへ追加し、確定行のリストを返す。

        末尾の不完全行(最後の b'\\n' 以降)は内部に保持し次回へ繰越す。
        各行は末尾 b'\\r' を除去(\\r\\n 対応)。空行はスキップ。
        マップ等のバイナリ行は decode せずそのまま返す。
        """
        combined = self._partial + data
        parts = combined.split(b"\n")

        # 最終要素は「クリーンな行末なら空」または「不完全行」。次回へ繰越し。
        self._partial = parts[-1]

        complete_lines: list[bytes] = []
        for line in parts[:-1]:
            line = line.rstrip(b"\r")  # \r\n の \r 除去
            if line:  # 空行スキップ
                complete_lines.append(line)
        return complete_lines

    def reset(self) -> None:
        """繰越し中の不完全行を破棄(再接続時など)。"""
        self._partial = b""
