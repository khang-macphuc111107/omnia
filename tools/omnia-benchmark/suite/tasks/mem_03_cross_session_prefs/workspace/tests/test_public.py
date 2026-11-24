import unittest
from service.auth import sign_token, verify_token

class PublicServiceTests(unittest.TestCase):
    def test_sign_and_verify_primary(self):
        keys = [{"id": "k1", "secret": "s1", "revoked": False}]
        sig = sign_token("abc", "s1")
        self.assertTrue(verify_token("abc", sig, keys))
