import json
import unittest
import urllib.request
from bench_telemetry_proxy import BenchTelemetryProxy, ProxyState, _finalize_usage, _merge_usage, _normalize_usage


class TelemetryTests(unittest.TestCase):
    def test_missing_or_partial_usage_is_not_zero_spend(self):
        for events, expected in (([{}], None), ([{"input_tokens": 0}], None),
                                 ([{"input_tokens": 0}, {"output_tokens": 0}], 0)):
            with self.subTest(events=events):
                acc = {}
                for usage in events:
                    _merge_usage(acc, _normalize_usage({"usage": usage}))
                state = ProxyState("test", "omnia", "test")
                state.record(dict(is_inference=True, t_req_start_ns=1, **_finalize_usage(acc)))
                summary = state.get_summary()
                self.assertEqual(summary["wire_total_tokens"], expected)
                self.assertEqual(summary["wire_effective_cost_units"], expected)
                self.assertEqual(summary["wire_requests_missing_usage"], int(expected is None))

    def test_concurrent_completion_order_does_not_change_turn_one(self):
        state = ProxyState("test", "omnia", "test")
        for start, ttft, prompt, cached in [(2, 10, 200, 100), (1, 30, 100, 0)]:
            state.record(dict(is_inference=True, t_req_start_ns=start, wire_ttft_ms=ttft,
                              prompt_total=prompt, cache_read=cached))
        summary = state.get_summary()
        self.assertEqual(summary["wire_first_req_perf_ns"], 1)
        self.assertEqual(summary["wire_first_ttft_ms"], 30)
        self.assertEqual(summary["wire_median_ttft_ms"], 20)
        self.assertEqual(summary["wire_turn1_prompt_tokens"], 100)
        self.assertEqual(summary["wire_kv_cache_hit_rate_ge2"], 0.5)

    def test_discovery_does_not_count_as_inference_or_usage(self):
        with BenchTelemetryProxy("test", "omnia", "test", mock_mode=True, upstream_api_key="") as proxy:
            base = f"http://127.0.0.1:{proxy.port}/v1"
            with urllib.request.urlopen(base + "/models?limit=1") as response:
                self.assertEqual(json.load(response)["data"][0]["id"], "mock-model")
            with urllib.request.urlopen(base + "/chat/completions", data=b"{}") as response:
                self.assertIn(b"[DONE]", response.read())
            summary = proxy.state.get_summary()
            self.assertEqual(summary["wire_total_http_calls"], 2)
            self.assertEqual(summary["wire_requests"], 1)
            self.assertEqual(summary["wire_total_tokens"], 105)

    def test_close_and_summary_ignores_late_post_stop_records(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as td:
            wl = Path(td) / "late.wire.jsonl"
            state = ProxyState("test", "omnia", "late", log_path=wl)
            state.record({"seq": state.next_seq(), "is_inference": True, "t_req_start_ns": 1, "prompt_total": 100, "output_tokens": 10, "usage_complete": True})
            summary = state.close_and_summary()
            state.record({"seq": state.next_seq(), "is_inference": True, "t_req_start_ns": 2, "prompt_total": 200, "output_tokens": 0, "usage_complete": False})
            self.assertEqual(summary["wire_requests"], 1)
            self.assertEqual(len(state.records), 1)
            self.assertEqual(len(wl.read_text(encoding="utf-8").splitlines()), 1)
