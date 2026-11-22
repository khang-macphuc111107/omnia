import tempfile, unittest
from pathlib import Path
from wal import WalCorruptionError, append_op, replay, compact

class TestWal(unittest.TestCase):
    def test_tail_truncation_and_compact(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "log.wal"
            append_op(p, "SET", "a", 1)
            append_op(p, "SET", "b", 2)
            append_op(p, "DEL", "a")
            with open(p, "a", encoding="utf-8") as f:
                f.write("deadbeef|SET|corrupt_tail")
            st = replay(p)
            self.assertEqual(st, {"b": 2})
            n = compact(p)
            self.assertEqual(n, 1)
            self.assertEqual(replay(p), {"b": 2})
