"""B2 CodeConverter テスト ([11]§5.2)。

- SJIS(cp932)↔UTF-8 ラウンドトリップ。
- 行種別分岐: #m57 M(バイナリ)=非変換 / #m57 O=name/graのオフセット部のみdecode / 一般行=全体変換。
- 地形バイト(0x00-0xFF)が変換で破壊されない。
- 不正バイト(errors=replace)で例外を出さない。
"""
import pytest

from app.protocol.code_converter import CodeConverter


@pytest.fixture
def cc():
    return CodeConverter()


# --- 一般行: ラウンドトリップ --------------------------------------------

@pytest.mark.parametrize(
    "text",
    [
        "hello",
        "こんにちは",
        "海山川 abc 123",
        "記号 ！？＠＃￥",
        "全角ｶﾅ 半角ｶﾅ",
        "",
    ],
)
def test_roundtrip(cc, text):
    raw = cc.encode(text)
    assert isinstance(raw, bytes)
    assert cc.decode(raw) == text


def test_decode_general_line(cc):
    raw = "ログ: 攻撃した".encode("cp932")
    assert cc.decode(raw) == "ログ: 攻撃した"


def test_encode_produces_cp932(cc):
    assert cc.encode("あ") == b"\x82\xa0"


# --- 行種別判定 ----------------------------------------------------------

@pytest.mark.parametrize(
    "raw,expected",
    [
        (b"#m57 M S 00000000:" + b"\x00" * 98, True),
        (b"#map M ........", True),
        (b"#status t_Lord : 100", False),
        (b"#cond -------", False),
        (b"#m57 O C0001:3 3 B name", False),  # O はバイナリ扱いしない(部分decode対象)
        (b"hello chat", False),
        (b"", False),
    ],
)
def test_is_binary_line(cc, raw, expected):
    assert cc.is_binary_line(raw) is expected


# --- 地形バイト非破壊 ----------------------------------------------------

def test_binary_map_line_not_converted(cc):
    """#m57 M は生バイト保持。decode で破壊されない。"""
    payload = bytes(b for b in range(256) if b not in (0x0A, 0x0D))
    raw = b"#m57 M S 00000000:" + payload
    # バイナリ行は decode せず生バイトを返す
    assert cc.decode_line(raw) == raw


def test_all_byte_values_preserved_via_passthrough(cc):
    """0x00-0xFF 全バイト(0x0A/0x0D除く)が透過で保持。"""
    payload = bytes(b for b in range(256) if b not in (0x0A, 0x0D))
    raw = b"#map M " + payload
    assert cc.decode_line(raw) == raw


# --- #m57 O: 部分デコード -----------------------------------------------

def _build_m57_o(name: str, gra: str) -> bytes:
    """parse オフセットに合わせた #m57 O 行を合成。
    raw[19:50]=name(31B cp932 右詰スペース), raw[54:69]=gra(15B), 他はASCIIプレースホルダ。
    """
    buf = bytearray(b" " * 74)
    buf[0:7] = b"#m57 O "
    buf[7] = ord("0")          # layer
    buf[8:12] = b"0001"        # char_id (hex)
    buf[13] = ord("3")         # x
    buf[15] = ord("3")         # y
    buf[17] = ord("B")         # dir
    nb = name.encode("cp932")
    buf[19 : 19 + len(nb)] = nb
    buf[51:53] = b"40"         # status (hex)
    gb = gra.encode("cp932")
    buf[54 : 54 + len(gb)] = gb
    buf[70] = ord("#")         # gigant
    buf[72:74] = b"40"         # default
    return bytes(buf)


def test_m57_o_decodes_name_and_gra(cc):
    raw = _build_m57_o("勇者タロウ", "t_Lord")
    out = cc.decode_m57_o(raw)
    assert out["name"] == "勇者タロウ"
    assert out["gra"] == "t_Lord"


def test_m57_o_offsets_not_corrupted_by_decode(cc):
    """ASCII数値フィールド(layer/id/x/y/status)は生のまま読める。"""
    raw = _build_m57_o("名前", "gra1")
    out = cc.decode_m57_o(raw)
    # 部分decodeのみ。バイナリ性のあるraw自体は破壊しない
    assert out["raw"] == raw


def test_m57_o_japanese_gra_name(cc):
    raw = _build_m57_o("テスター", "魔法使")
    out = cc.decode_m57_o(raw)
    assert out["gra"] == "魔法使"


# --- 不正バイト: 例外を出さない -----------------------------------------

def test_decode_invalid_bytes_no_exception(cc):
    """不正なcp932シーケンスでも errors=replace で例外を出さない。"""
    raw = b"\x82"  # lead byte 単独(不完全)
    result = cc.decode(raw)
    assert isinstance(result, str)  # 例外なし


def test_decode_line_invalid_general(cc):
    raw = b"chat \xff\xfe end"
    result = cc.decode_line(raw)
    assert isinstance(result, str)


def test_encode_unmappable_no_exception(cc):
    """cp932 に無い文字(絵文字等)も errors=replace で例外を出さない。"""
    result = cc.encode("emoji😀test")
    assert isinstance(result, bytes)


def test_m57_o_invalid_name_bytes_no_exception(cc):
    raw = bytearray(_build_m57_o("ok", "g"))
    raw[19:21] = b"\x82\xff"  # name領域に不正バイト
    out = cc.decode_m57_o(bytes(raw))
    assert isinstance(out["name"], str)  # 例外なし
