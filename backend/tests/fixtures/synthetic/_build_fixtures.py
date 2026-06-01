"""合成フィクスチャ生成スクリプト(再現用。テストには bin を直接読む)。

doc03 の実応答例ベースの **安全な** 合成バイナリ。秘匿値(実 IP/ID/実名)は含めず、
ダミー名(ExampleChar / Lord 等)に置換。オフセットは map_data.py の実装に厳密準拠。

実行:
  python tests/fixtures/synthetic/_build_fixtures.py
で本ディレクトリへ *.bin を再生成する。期待 JSON は手書きで対応付け。
"""
from __future__ import annotations

from pathlib import Path

OUT = Path(__file__).parent


def _pad(s: str, n: int, enc: str = "cp932") -> bytes:
    """cp932 右スペース詰め固定長。"""
    b = s.encode(enc)
    return b[:n].ljust(n, b" ")


def build_m57_O(layer: int, char_id: int, x: int, y: int, direction: str,
                name: str, status: int, gra: str, gigant: str,
                default: int) -> bytes:
    """#m57 O 1 行(>=74 バイト)を厳密オフセットで構築。

    [0:7]   '#m57 O '
    [7]     Layer(hex 1桁)
    [8:12]  ID(hex 4桁)
    [12]    ':'(区切り。コードは未参照だが実フォーマット踏襲)
    [13]    X(ASCII 数字)
    [14]    ' '
    [15]    Y
    [16]    ' '
    [17]    Dir(B/R/F/L)
    [18]    ' '
    [19:50] Name(31 バイト cp932)
    [50]    ' '
    [51:53] Status(hex 2桁)
    [53]    ' '
    [54:69] Gra(15 バイト cp932)
    [69]    ' '
    [70]    Gigant('#'/'*')
    [71]    ' '
    [72:74] Default(hex 2桁)
    """
    buf = bytearray(74)
    buf[0:7] = b"#m57 O "
    buf[7] = ord(format(layer, "x"))
    buf[8:12] = format(char_id, "04x").encode("ascii")
    buf[12] = ord(":")
    buf[13] = ord(str(x))
    buf[14] = ord(" ")
    buf[15] = ord(str(y))
    buf[16] = ord(" ")
    buf[17] = ord(direction)
    buf[18] = ord(" ")
    buf[19:50] = _pad(name, 31)
    buf[50] = ord(" ")
    buf[51:53] = format(status, "02x").encode("ascii")
    buf[53] = ord(" ")
    buf[54:69] = _pad(gra, 15)
    buf[69] = ord(" ")
    buf[70] = ord(gigant)
    buf[71] = ord(" ")
    buf[72:74] = format(default, "02x").encode("ascii")
    return bytes(buf)


def build_m57_M(direction: str, time_hex: str, cells: list[tuple[int, int]]) -> bytes:
    """#m57 M 7x7。

    [0:7]   '#m57 M '
    [7]     Dir(N/E/S/W)
    [8]     ' '
    [9:17]  Time(8 hex)
    [17]    ':'
    [18:116] 98 バイト(chip,attr)×49
    """
    buf = bytearray(18)
    buf[0:7] = b"#m57 M "
    buf[7] = ord(direction)
    buf[8] = ord(" ")
    buf[9:17] = time_hex.encode("ascii")
    buf[17] = ord(":")
    assert len(cells) == 49
    chip = bytearray()
    for c, a in cells:
        chip.append(c)
        chip.append(a)
    return bytes(buf) + bytes(chip)


def build_user(no: int, name: str) -> bytes:
    """#user。[6:10]=4桁番号 / [11:42]=31 バイト cp932 名前。

    [0:6]  '#user '
    [6:10] 番号(4桁 ASCII)
    [10]   ' '
    [11:42] Name(31 バイト)
    """
    buf = bytearray(42)
    buf[0:6] = b"#user "
    buf[6:10] = format(no, "04d").encode("ascii")
    buf[10] = ord(" ")
    buf[11:42] = _pad(name, 31)
    return bytes(buf)


def main() -> None:
    # --- #m57 M (7x7 地形) ---
    cells = [((i * 3) % 256, (i % 8)) for i in range(49)]
    (OUT / "m57_M.bin").write_bytes(build_m57_M("N", "0000abcd", cells))

    # --- #m57 O キャラ(通常) ---
    (OUT / "m57_O_char.bin").write_bytes(
        build_m57_O(0, 1, 3, 3, "B", "ExampleChar", 0x40, "t_Lord", "#", 0x40)
    )
    # --- #m57 O 日本語グラ名 ---
    (OUT / "m57_O_jp.bin").write_bytes(
        build_m57_O(1, 0x000a, 2, 4, "F", "勇者タロウ", 0x08, "侍", "*", 0x12)
    )
    # --- #m57 O バッククォート/空白を含むグラ名 ---
    (OUT / "m57_O_special.bin").write_bytes(
        build_m57_O(2, 0x00ff, 0, 6, "R", "Guard A", 0x00, "`obj weird`", "#", 0x05)
    )

    # --- #m57 . (確定) ---
    (OUT / "m57_dot.bin").write_bytes(b"#m57 .")

    # --- #status ---
    (OUT / "status.bin").write_bytes(
        "#status t_Lord : 4775: 4775: 3344: 3344: 24063: 2161: 7269: 3712: 5290: 2540"
        .encode("cp932")
    )

    # --- #cond (毒のみ有効) ---
    (OUT / "cond.bin").write_bytes(b"#cond *------")
    (OUT / "cond_none.bin").write_bytes(b"#cond -------")

    # --- 一般ログ行(日本語 + マークアップ) ---
    (OUT / "log_plain.bin").write_bytes("ExampleChar が攻撃した".encode("cp932"))
    (OUT / "log_markup.bin").write_bytes(
        "/*color=red*/警告/*.*/ です".encode("cp932")
    )

    # --- priv ---
    (OUT / "priv.bin").write_bytes("[ExampleChar] > こんにちは".encode("cp932"))

    # --- #user ---
    (OUT / "user.bin").write_bytes(build_user(12, "ExampleChar"))


if __name__ == "__main__":
    main()
    print("synthetic fixtures generated.")
