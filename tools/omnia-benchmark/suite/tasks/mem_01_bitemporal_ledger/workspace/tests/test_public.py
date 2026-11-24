import unittest
from policy_engine import evaluate_order

class PublicPolicyTests(unittest.TestCase):
    def test_schema_keys(self):
        out = evaluate_order({"amount_cents": 2000, "tier": "standard", "region": "US"}, "2026-10-26T00:00:00Z")
        for k in ("decision", "reason", "fee_cents", "hold_hours", "active_policy_rev"):
            self.assertIn(k, out)
        self.assertEqual(out["active_policy_rev"], "rev-3.1")
