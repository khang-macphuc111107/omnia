import unittest
from ratelimit import TokenBucketLimiter

class TestBucket(unittest.TestCase):
    def test_burst_and_retry(self):
        t = [0.0]
        lim = TokenBucketLimiter(rate_per_sec=2.0, capacity=4.0, clock=lambda: t[0])
        self.assertEqual(lim.allow("k", 3.0), (True, 0.0))
        ok, wait = lim.allow("k", 2.0)
        self.assertFalse(ok)
        self.assertAlmostEqual(wait, 0.5, places=6)
