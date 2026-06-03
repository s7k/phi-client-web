"""settings scope の入力検証([07]§5.7, [12]§3)。

settings.set で受けた value を永続化前に検証し、broken data の保存を防ぐ。
方針:
- value は dict 必須(非 dict / null / スカラは拒否)。
- 既知キーは型を検証。**未知キーは許容**(FE 拡張時の前方互換)。
- JSON 化サイズ上限で肥大/濫用を抑制。
正規表現文字列の妥当性等の深い検証は通知層に委ね、ここでは型のみ。
FE 構造定義(frontend/src/stores/settingsStore.ts)と対応。
"""
from __future__ import annotations

import json
from typing import Any, Optional

# value JSON 化の最大バイト数(肥大防止)。
_MAX_VALUE_BYTES = 8192


def _is_bool(v: Any) -> bool:
    return isinstance(v, bool)


def _is_number(v: Any) -> bool:
    # bool は int サブクラスのため除外。
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_str_or_null(v: Any) -> bool:
    return v is None or isinstance(v, str)


def _check_str_null_map(v: Any) -> bool:
    """dict[str, str|None] か。"""
    if not isinstance(v, dict):
        return False
    return all(isinstance(k, str) and _is_str_or_null(val) for k, val in v.items())


# scope ごとの既知キー検証関数。未列挙キーは無視(前方互換)。
_KEYBIND_CHECKS = {
    "layout": lambda v: v in ("wasd", "numpad"),
    "magic": _check_str_null_map,
    "shortcuts": _check_str_null_map,
    "altG": lambda v: isinstance(v, str),
    "touchHand": lambda v: v in ("left", "right"),
}
_NOTIFY_CHECKS = {
    "enabled": _is_bool,
    "privOnly": _is_bool,
    "loud": _is_bool,
    "sound": _is_bool,
    "titleFlash": _is_bool,
    "regexInclude": _is_str_or_null,
    "regexExclude": _is_str_or_null,
}
_DISPLAY_CHECKS = {
    "mapSize": lambda v: v in (40, 57),
    "mapStyle": lambda v: v in ("turn", "solid"),
    "eagleEye": _is_bool,
    "cellScale": lambda v: v in (1, 2),
    "fontScale": lambda v: _is_number(v) and 0.5 <= v <= 3.0,
    "theme": lambda v: v in ("dark", "light"),
}
_INTERVALS_CHECKS = {
    "mapUpdate": lambda v: isinstance(v, int) and not isinstance(v, bool) and v > 0,
    "statusUpdate": lambda v: isinstance(v, int) and not isinstance(v, bool) and v > 0,
}

_SCOPE_CHECKS = {
    "keybind": _KEYBIND_CHECKS,
    "notify": _NOTIFY_CHECKS,
    "display": _DISPLAY_CHECKS,
    "intervals": _INTERVALS_CHECKS,
}


def validate_setting(scope: str, value: Any) -> Optional[str]:
    """scope の value を検証。問題があればエラー文字列、正常なら None。"""
    if not isinstance(value, dict):
        return f"value must be an object, got {type(value).__name__}"
    try:
        size = len(json.dumps(value).encode("utf-8"))
    except (TypeError, ValueError):
        return "value is not JSON-serializable"
    if size > _MAX_VALUE_BYTES:
        return f"value too large: {size} > {_MAX_VALUE_BYTES} bytes"

    checks = _SCOPE_CHECKS.get(scope)
    if checks is None:
        # scope 自体は呼び出し側(_SETTINGS_SCOPES)で検証済。念のため。
        return f"unknown scope: {scope!r}"
    for key, check in checks.items():
        if key in value and not check(value[key]):
            return f"invalid value for {scope}.{key}: {value[key]!r}"
    return None
