import unittest
from py_client.signer import sign_v1

class PublicPyTests(unittest.TestCase):
    def test_v1_present(self):
        self.assertEqual(len(sign_v1("k", b"abc")), 64)
