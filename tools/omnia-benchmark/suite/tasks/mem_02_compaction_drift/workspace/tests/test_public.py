import unittest
from router import DispatchPipeline

class PublicPipelineTests(unittest.TestCase):
    def test_basic_accept(self):
        p = DispatchPipeline()
        res = p.process_batch([{"event_id": "e1", "tenant_id": "Acme", "idempotency_key": "k1", "priority": "normal", "retry_count": 0, "payload": {"msg": "hi"}}])
        self.assertEqual(len(res["accepted"]), 1)
        self.assertEqual(res["accepted"][0]["tenant_id"], "acme")
