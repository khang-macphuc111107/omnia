import unittest
from packages.billing.service import create_invoice
from packages.auth.service import verify_session
from packages.notify.service import Notifier

class ServiceTests(unittest.TestCase):
    def test_billing_and_notify(self):
        env = create_invoice("tr-1", "acme", 1000, 1005)
        self.assertEqual(env.payload["total_cents"], 1075)
        n = Notifier()
        self.assertTrue(n.send(env))
        self.assertFalse(n.send(env))
        self.assertEqual(n.sent[0]["trace_id"], "tr-1")

    def test_auth_expiry_and_redaction(self):
        with self.assertRaises(ValueError) as ctx:
            verify_session("bad_secret_val_99", 0, 10)
        self.assertNotIn("bad_secret_val_99", str(ctx.exception))
        with self.assertRaises(ValueError):
            verify_session("tok_ok_1", 1000, 70001, ttl_ms=60000)
