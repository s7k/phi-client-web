"""B11 キャラタイプ フォールバック解決([09] / data/chara_type_fallback.json)。

map イベント([07]§6.2)の各キャラは `gra`(=gra_name)と `default`(typeコード)
を持つ。グラ解決フロー([08]§9):
  1. gra_name で specific PNG 解決(本モジュール対象外: Store/manifest 側)
  2. 無ければ typeコード → Web key → webFallbackGra(既定グラ名)
  3. typeコード未一致は key=intelligent(0x01) を既定([09]§3)
  4. それも無ければプレースホルダ

本モジュールは 2/3 を担う: typeコード(int) → key → webFallbackGra。
case-insensitive(キーは小文字正規化)で扱う。
"""
from __future__ import annotations

import json
from pathlib import Path

# backend/data/chara_type_fallback.json(app の親 = backend/)。
_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "chara_type_fallback.json"

# typeコード未一致時の既定 key([09]§3, GetDefaultGraIndex 準拠)。
DEFAULT_KEY = "intelligent"


class CharaFallback:
    """chara_type_fallback.json を読み込み typeコード/key を解決。"""

    def __init__(self, types: list[dict]) -> None:
        # code(int) → エントリ
        self._by_code: dict[int, dict] = {}
        # key(小文字) → エントリ
        self._by_key: dict[str, dict] = {}
        for t in types:
            code = t.get("code")
            key = t.get("key")
            if code is not None:
                self._by_code[int(code)] = t
            if key:
                self._by_key[str(key).lower()] = t

    @classmethod
    def load(cls, path: str | Path | None = None) -> "CharaFallback":
        p = Path(path) if path is not None else _DATA_PATH
        data = json.loads(p.read_text(encoding="utf-8"))
        return cls(data.get("types", []))

    # ------------------------------------------------------------------
    # 解決
    # ------------------------------------------------------------------

    def key_for_code(self, code: int | None) -> str:
        """typeコード → Web key。未一致は DEFAULT_KEY(intelligent)。"""
        if code is not None:
            entry = self._by_code.get(int(code))
            if entry is not None:
                return entry["key"]
        return DEFAULT_KEY

    def fallback_gra(self, code: int | None) -> str | None:
        """typeコード → webFallbackGra(既定グラ名)。

        コード一致時はそのエントリの webFallbackGra(None もあり得る)。
        未一致時は intelligent の webFallbackGra(=t_elf)。
        """
        if code is not None and int(code) in self._by_code:
            return self._by_code[int(code)].get("webFallbackGra")
        return self.fallback_gra_for_key(DEFAULT_KEY)

    def fallback_gra_for_key(self, key: str) -> str | None:
        """Web key(case-insensitive) → webFallbackGra。未知 key は None。"""
        entry = self._by_key.get(key.lower())
        return entry.get("webFallbackGra") if entry else None

    def entry_for_code(self, code: int | None) -> dict | None:
        """typeコード → エントリ全体(未一致は None)。"""
        if code is None:
            return None
        return self._by_code.get(int(code))
