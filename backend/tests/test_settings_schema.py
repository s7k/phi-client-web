"""settings_schema.validate_setting の単体テスト。"""
from app.settings_schema import validate_setting


def test_valid_known_values_pass():
    assert validate_setting("keybind", {"layout": "numpad", "altG": "g",
                                        "magic": {"F1": None}, "shortcuts": {"F8": "x"},
                                        "touchHand": "left"}) is None
    assert validate_setting("notify", {"enabled": True, "regexInclude": None,
                                       "sound": False}) is None
    assert validate_setting("display", {"mapSize": 57, "mapStyle": "solid",
                                        "eagleEye": False, "cellScale": 2,
                                        "fontScale": 1.0, "theme": "dark"}) is None
    assert validate_setting("intervals", {"mapUpdate": 10, "statusUpdate": 5}) is None


def test_unknown_keys_allowed_forward_compat():
    # 未知キーは無視(前方互換)。
    assert validate_setting("display", {"mapSize": 40, "futureFlag": True}) is None
    assert validate_setting("keybind", {"up": "w"}) is None  # 旧テスト互換


def test_non_dict_value_rejected():
    assert validate_setting("display", "x") is not None
    assert validate_setting("display", None) is not None
    assert validate_setting("display", 123) is not None
    assert validate_setting("display", [1, 2]) is not None


def test_known_key_type_mismatch_rejected():
    assert validate_setting("keybind", {"layout": "joystick"}) is not None
    assert validate_setting("display", {"mapSize": 99}) is not None
    assert validate_setting("display", {"mapStyle": "iso"}) is not None
    assert validate_setting("display", {"theme": "neon"}) is not None
    assert validate_setting("display", {"fontScale": 99}) is not None  # 範囲外
    assert validate_setting("display", {"eagleEye": "yes"}) is not None  # bool以外
    assert validate_setting("display", {"cellScale": 3}) is not None  # 1/2以外
    assert validate_setting("display", {"cellScale": "2"}) is not None  # 文字列不可
    assert validate_setting("notify", {"sound": 1}) is not None  # int は bool 不可
    assert validate_setting("intervals", {"mapUpdate": 0}) is not None  # >0
    assert validate_setting("intervals", {"mapUpdate": True}) is not None  # bool不可
    assert validate_setting("keybind", {"magic": {"F1": 5}}) is not None  # str|None以外
    assert validate_setting("keybind", {"touchHand": "up"}) is not None  # left/right以外


def test_oversized_value_rejected():
    big = {"k": "a" * 9000}
    assert validate_setting("notify", big) is not None
