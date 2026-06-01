"""B1 LineBuffer テスト ([11]§5.1)。

phi-client tests/test_line_buffer.py を移植・拡張。
追加: SJIS 2バイト境界がバッファ末尾で割れるケース。
"""
from app.protocol.line_buffer import LineBuffer, is_sjis_lead


def test_is_sjis_lead_ranges():
    assert is_sjis_lead(0x82)   # 'あ' 先頭
    assert is_sjis_lead(0xE0)
    assert is_sjis_lead(0x9F)
    assert not is_sjis_lead(0x41)  # 'A'
    assert not is_sjis_lead(0x0A)  # '\n'
    assert not is_sjis_lead(0xFD)


def test_single_complete_line():
    lb = LineBuffer()
    assert lb.feed(b"hello\n") == [b"hello"]


def test_two_lines_in_one_feed():
    lb = LineBuffer()
    assert lb.feed(b"hello\nworld\n") == [b"hello", b"world"]


def test_incomplete_line_deferred():
    lb = LineBuffer()
    assert lb.feed(b"hell") == []
    assert lb.feed(b"o\n") == [b"hello"]


def test_split_across_feeds():
    lb = LineBuffer()
    assert lb.feed(b"line1\nlin") == [b"line1"]
    assert lb.feed(b"e2\n") == [b"line2"]


def test_empty_lines_skipped():
    lb = LineBuffer()
    assert lb.feed(b"a\n\nb\n") == [b"a", b"b"]


def test_crlf_stripped():
    lb = LineBuffer()
    assert lb.feed(b"hello\r\n") == [b"hello"]


def test_reset_clears_partial():
    lb = LineBuffer()
    lb.feed(b"partial")
    lb.reset()
    assert lb.feed(b"fresh\n") == [b"fresh"]


def test_multiple_partial_feeds():
    lb = LineBuffer()
    lb.feed(b"ab")
    lb.feed(b"cd")
    assert lb.feed(b"ef\n") == [b"abcdef"]


def test_binary_content_preserved():
    """マップ行は任意バイトを含む。区切りは0x0Aのみ。0x0A/0x0D以外の全バイトを保持。"""
    payload = bytes(b for b in range(256) if b not in (0x0A, 0x0D))
    line = b"#m57 M " + payload + b"\n"
    lb = LineBuffer()
    result = lb.feed(line)
    assert result == [b"#m57 M " + payload]


# --- [11]§5.1 追加要件 -------------------------------------------------

def test_byte_by_byte_feed():
    """1バイトずつ投入しても行復元。日本語(cp932)含む。"""
    line = "あいうえおhello".encode("cp932") + b"\n"
    lb = LineBuffer()
    out = []
    for i in range(len(line)):
        out += lb.feed(line[i : i + 1])
    assert out == [line.rstrip(b"\n")]


def test_sjis_lead_byte_split_at_boundary():
    """SJIS 2バイト文字の先頭バイトが末尾に残るケース。
    リードバイト単独では文字未確定 → 次feedで結合される。
    """
    # 'あ' = b'\x82\xa0' (cp932)
    a = "あ".encode("cp932")
    assert len(a) == 2 and 0x81 <= a[0] <= 0x9F
    lb = LineBuffer()
    # リードバイトのみ投入 → 行は未確定(末尾partialに保持)
    assert lb.feed(a[0:1]) == []
    # 続きとデリミタ
    assert lb.feed(a[1:2] + b"\n") == [a]


def test_sjis_lead_at_chunk_end_then_newline():
    """改行直前でちょうど割れる連続チャンク。"""
    text = "海山".encode("cp932")  # 4バイト
    lb = LineBuffer()
    # 海(2B) + 山の先頭1B
    assert lb.feed(text[0:3]) == []
    assert lb.feed(text[3:4] + b"\n") == [text]


def test_lead_byte_not_misinterpreted_as_line_end():
    """末尾がリードバイトの非改行チャンクは決して行を吐かない。"""
    lb = LineBuffer()
    # 0x82 はリードバイト
    assert lb.feed(b"x\x82") == []
    # 行内に\nがあれば確定行は返るが、末尾リードバイトは保持
    out = lb.feed(b"y\nz\x83")
    assert out == [b"x\x82y"]
    assert lb.feed(b"\x80\n") == [b"z\x83\x80"]


def test_crlf_split_across_feeds():
    """\r\n がチャンクで割れても \r 除去。"""
    lb = LineBuffer()
    assert lb.feed(b"abc\r") == []
    assert lb.feed(b"\ndef\n") == [b"abc", b"def"]


def test_trailing_partial_kept_after_complete_lines():
    lb = LineBuffer()
    assert lb.feed(b"one\ntwo\nthr") == [b"one", b"two"]
    assert lb.feed(b"ee\n") == [b"three"]
