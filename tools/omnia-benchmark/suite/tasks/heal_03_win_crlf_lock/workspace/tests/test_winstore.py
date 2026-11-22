import tempfile, unittest
from pathlib import Path
from winstore.config import load_rules
from winstore.ingest import read_csv_rows
from winstore.db import EventStore

class TestWinStore(unittest.TestCase):
    def test_rules_and_csv(self):
        rules = load_rules(Path("config/rules.json"))
        self.assertEqual(rules["currency"], "VND")
        rows = read_csv_rows("data/batch_01.csv")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["city"], "Hà Nội")

    def test_db_two_batches(self):
        with tempfile.TemporaryDirectory() as td:
            st = EventStore(Path(td) / "ev.db")
            st.record_batch([{"id": "1", "amount": 10, "city": "HN"}])
            st.record_batch([{"id": "2", "amount": 20, "city": "DN"}])
            self.assertEqual(st.count(), 2)
