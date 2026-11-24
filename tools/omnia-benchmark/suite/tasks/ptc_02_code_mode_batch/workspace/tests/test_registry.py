import json, unittest
from pathlib import Path

class PublicRegistryTests(unittest.TestCase):
    def test_index_count(self):
        idx = json.loads(Path("registry/index.json").read_text(encoding="utf-8"))
        self.assertEqual(idx.get("total_services"), 64)
        self.assertEqual(sorted(idx.get("cycle_nodes", [])), ["svc_12", "svc_13", "svc_14", "svc_40", "svc_41"])
