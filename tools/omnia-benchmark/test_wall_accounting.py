import time
import unittest
import urllib.request
from unittest.mock import Mock, patch

from bench_telemetry_proxy import BenchTelemetryProxy, ProxyState, _make_handler


class WallAccountingTests(unittest.TestCase):
    def setUp(self):
        self.state = ProxyState("local", "test", "wall")

    def record(self, start, end, inference=True):
        self.state.record(dict(seq=self.state.next_seq(), is_inference=inference,
                               t_req_start_ns=start, t_stream_end_ns=end, prompt_total=0))

    def assert_window(self, covered_ns, residual_ms):
        summary = self.state.get_summary((10_000_000, 30_000_000))
        self.assertEqual(summary["wire_window_inference_ns"], covered_ns)
        self.assertEqual(summary["wire_window_uncovered_ms"], residual_ms)

    def test_overlap_nesting_touching_and_completion_order(self):
        for start, end in [(16, 18), (12, 20), (18, 23), (23, 25)]:
            self.record(start * 1_000_000, end * 1_000_000)
        self.assert_window(13_000_000, 7)

    def test_clip_both_ends_and_ignore_disjoint_or_noninference(self):
        for start, end in [(1, 5), (5, 14), (26, 40), (40, 50)]:
            self.record(start * 1_000_000, end * 1_000_000)
        self.record(14_000_000, 26_000_000, inference=False)
        self.assert_window(8_000_000, 12)

    def test_sum_of_durations_is_not_wall_coverage(self):
        for start, end in [(8, 22), (18, 32)]:
            self.state.record(dict(seq=self.state.next_seq(), is_inference=True,
                                   t_req_start_ns=start * 1_000_000, t_stream_end_ns=end * 1_000_000,
                                   wire_llm_wait_ms=end - start, prompt_total=0))
        self.assertEqual(self.state.get_summary()["wire_total_llm_wait_ms"], 28)
        self.assert_window(20_000_000, 0)

    def test_injected_fault_ends_after_response_write(self):
        self.state.fault_mode = "429_502"
        self.record(0, 1)  # The next inference is the injected 429.
        cls = _make_handler(self.state)
        handler = cls.__new__(cls)
        clock = Mock(return_value=16_000_000)

        def send_response(status, body, headers):
            self.assertEqual(status, 429)
            clock.return_value = 23_000_000

        handler._send_json = send_response
        with patch("bench_telemetry_proxy.time.perf_counter_ns", clock):
            code = handler._maybe_inject_fault(self.state.next_seq(), "/v1/messages",
                                               "anthropic_messages", 16_000_000)
        self.assertEqual(code, "429")
        self.assertEqual(self.state.records[-1]["wire_llm_wait_ms"], 7)
        self.assert_window(7_000_000, 13)

    def test_mock_response_does_not_invent_an_interval(self):
        with BenchTelemetryProxy("local", "test", "wall", mock_mode=True, upstream_api_key="") as proxy:
            start = time.perf_counter_ns()
            url = f"http://127.0.0.1:{proxy.port}/v1/chat/completions"
            with urllib.request.urlopen(url, data=b"{}", timeout=5) as response:
                response.read()
            summary = proxy.state.get_summary((start, time.perf_counter_ns()))
            self.assertEqual(summary["wire_requests"], 1)
            self.assertIsNone(summary["wire_total_llm_wait_ms"])
            self.assertIsNone(summary["wire_window_uncovered_ms"])

    def test_empty_versus_unrecorded_handler(self):
        self.assert_window(0, 20)
        self.state.next_seq()
        self.assert_window(None, None)

    def test_incomplete_or_invalid_interval_is_unknown(self):
        for start, end, inference in [(None, 20, True), (10, None, True),
                                      (20, 10, True), (10, 20, None)]:
            with self.subTest(start=start, end=end, inference=inference):
                self.record(start, end, inference)
                self.assert_window(None, None)
                self.state = ProxyState("local", "test", "wall")
