import unittest
from gateway.config import GatewayConfig
from gateway.server import Gateway

class BaseTests(unittest.TestCase):
    def test_init(self):
        gw = Gateway(GatewayConfig())
        self.assertEqual(gw.cfg.service_name, 'gw')
