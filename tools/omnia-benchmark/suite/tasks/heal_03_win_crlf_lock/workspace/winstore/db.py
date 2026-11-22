import sqlite3
from pathlib import Path

class EventStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        # BUG 3: zero timeout, no WAL
        return sqlite3.connect(str(self.db_path), timeout=0.01)

    def _init_schema(self) -> None:
        conn = self._connect()
        conn.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, amount INTEGER, city TEXT)")
        conn.commit()
        conn.close()

    def record_batch(self, rows: list[dict]) -> int:
        conn = self._connect()
        for r in rows:
            conn.execute("INSERT OR REPLACE INTO events(id, amount, city) VALUES (?, ?, ?)", (str(r["id"]), int(r["amount"]), str(r["city"])))
        # BUG 3b: forgets commit() and leaves connection open holding write lock!
        return len(rows)

    def count(self) -> int:
        conn = self._connect()
        try:
            return int(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])
        finally:
            conn.close()
