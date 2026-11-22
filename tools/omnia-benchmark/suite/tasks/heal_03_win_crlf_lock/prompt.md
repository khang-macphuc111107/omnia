# Task: Recover Broken Windows Data Ingestion & SQLite Store Service

Run `python -m unittest discover -s tests -v`. This Python package (`winstore`) has **5 cascading Windows-native defects**:
1. `config/rules.json` starts with a UTF-8 BOM (`\ufeff`), crashing `load_rules()` in `winstore/config.py`. Handle UTF-8 BOM cleanly in `load_rules()` (`utf-8-sig`) so BOM-encoded configs always parse.
2. `winstore/ingest.py` reads CSV rows manually with `split("\n")` without stripping `\r`, corrupting the last column values with trailing `\r` on Windows CRLF files, and fails to normalize backslash paths (`data\batch_01.csv`) cleanly across OSes.
3. `winstore/db.py` (`EventStore`) opens SQLite connections without WAL mode / `busy_timeout` and leaks an uncommitted transaction on `record_batch`, causing `sqlite3.OperationalError: database is locked` under concurrent writer connections.
4. `winstore/aggregator.py` (`ConcurrentCounter`) increments shared dict totals from multiple threads without locking, losing increments under contention.
5. `winstore/export.py` writes summary JSON without explicit `encoding="utf-8"`, `newline="\n"`, or atomic temp-file + `os.replace()`. Ensure exported JSON is valid UTF-8 with LF line endings and non-ASCII characters preserved (`ensure_ascii=False`).

Fix all 5 issues so `python -m unittest discover -s tests -v` and hidden concurrency/Unicode/lock checks pass 100%.
