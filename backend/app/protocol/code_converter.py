"""B2 CodeConverter: SJIS(cp932) ⇔ UTF-8 変換。行種別で戦略を分岐。

戦略([02]§3.3, [03]§4.1, phi-client parser.py/map_data.py で実証):

- バイナリ行(`#m57 M` / `#map M`): 地形チップ等の生バイト。**cp932変換厳禁**。
  生バイトのまま保持(構造化は ProtocolParser/map_data が担当)。
- 部分デコード行(`#m57 O`): name=raw[19:50], gra=raw[54:69] のみ cp932 デコード。
  他フィールド(layer/id/x/y/dir/status/gigant/default)は ASCII数値で生バイト保持。
- 一般行(チャット・ログ・#status・#cond・#ex-notice 等): 行全体を cp932→UTF-8 変換。

errors='replace' で不正バイト・未マップ文字でも例外を出さない。
受信は \\n で行確定後に変換する前提(LineBuffer が境界を吸収)。
"""
from __future__ import annotations

ENCODING = "cp932"

# #m57 O フィールドオフセット(phi-client map_data.parse_m57_O 準拠)
_M57_O_NAME = slice(19, 50)   # 31バイト cp932 名前(右詰スペース)
_M57_O_GRA = slice(54, 69)    # 15バイト cp932 グラ名(右詰スペース)

# バイナリ(生バイト)扱いする行頭プレフィクス
_BINARY_PREFIXES = (b"#m57 M", b"#map M")


class CodeConverter:
    """SJIS(cp932) ⇔ UTF-8 双方向変換 + 行種別分岐。"""

    # --- 基本変換 --------------------------------------------------------

    def decode(self, raw: bytes) -> str:
        """cp932 バイト列 → UTF-8 str。不正バイトは置換。"""
        return raw.decode(ENCODING, errors="replace")

    def encode(self, text: str) -> bytes:
        """UTF-8 str → cp932 バイト列。未マップ文字は置換。"""
        return text.encode(ENCODING, errors="replace")

    # --- 行種別判定 ------------------------------------------------------

    def is_binary_line(self, raw: bytes) -> bool:
        """*raw* が生バイト保持すべきバイナリ行(地形チップ)か。"""
        return raw.startswith(_BINARY_PREFIXES)

    # --- 行レベル変換 ----------------------------------------------------

    def decode_line(self, raw: bytes) -> str | bytes:
        """1行を種別に応じて変換。

        - バイナリ行 → 生バイトをそのまま返す(bytes)。
        - 一般行 → UTF-8 str。

        `#m57 O` のような部分デコード行は呼び出し側で `decode_m57_o` を使う
        (本メソッドは一般 str 変換を行わず、生バイトでは破壊しないが
         混在行のため明示的に専用メソッドへ誘導する設計)。
        """
        if self.is_binary_line(raw):
            return raw
        return self.decode(raw)

    def decode_m57_o(self, raw: bytes) -> dict:
        """`#m57 O` 行の cp932 領域(name/gra)のみデコード。

        数値フィールドは ASCII のため生バイトを保持。元の raw も保持し、
        ProtocolParser が他フィールドをオフセットで読めるようにする。

        Returns
        -------
        dict: { "name": str, "gra": str, "raw": bytes }
        """
        name = raw[_M57_O_NAME].decode(ENCODING, errors="replace").rstrip()
        gra = raw[_M57_O_GRA].decode(ENCODING, errors="replace").rstrip()
        return {"name": name, "gra": gra, "raw": raw}
