# Task: Fix Crash-Safe Append-Only WAL Reader & Compactor

Fix `wal/store.py` so `python -m unittest discover -s tests -v` and hidden crash-recovery tests pass:
1. Each WAL line is `<crc32_hex>|<op>|<key>|<value_json>` where `crc32_hex` is `f"{zlib.crc32(payload.encode('utf-8')) & 0xffffffff:08x}"` over `f"{op}|{key}|{value_json}"`.
2. `replay(path)` MUST verify every line's CRC32 checksum. If the **final** line is truncated or corrupt (partial crash write), stop cleanly and return state up to the last valid record. If a **non-final** line is corrupted, raise `WalCorruptionError`.
3. Support `SET` and `DEL` operations; `compact(path)` must atomically rewrite the WAL keeping only live keys (sorted by key) as `SET` records with valid CRC32 checksums, removing deleted/overwritten history.
