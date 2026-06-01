"""B8 Store: SQLite による Web側ストア。

公開 API は `Store` クラス。スキーマは `schema.sql`、`Store.migrate()` で適用。
詳細スキーマ: [02]§6 / [08]§4 / [12]§1.4。
"""
from app.store.db import Store, connect, ChAraGraphic, IndexEntry

__all__ = ["Store", "connect", "ChAraGraphic", "IndexEntry"]
