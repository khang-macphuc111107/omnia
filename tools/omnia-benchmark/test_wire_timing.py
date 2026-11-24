import http.client
import http.server
import json
import queue
import threading
import unittest

from bench_telemetry_proxy import BenchTelemetryProxy, _sse_has_content_or_tool


def frames(*events):
    return b"".join(b"data: " + json.dumps(event).encode() + b"\n\n" for event in events) + b"data: [DONE]\n\n"


class WireTimingTests(unittest.TestCase):
    def setUp(self):
        replies = self.replies = queue.Queue()

        class Upstream(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                status, content_type, body = replies.get(timeout=3)
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                if callable(body):
                    self.end_headers()
                    body(self.wfile)
                else:
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            def log_message(self, *args):
                pass

        upstream = http.server.HTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, args=(0.05,), daemon=True)
        thread.start()
        self.addCleanup(upstream.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(upstream.shutdown)
        self.proxy = BenchTelemetryProxy("local", "test", "timing", upstream_api_key="",
                                        upstream_base=f"http://127.0.0.1:{upstream.server_port}")
        # A client can consume the last byte before the request thread records telemetry.
        self.recorded = queue.Queue()
        record = self.proxy.state.record

        def capture(row):
            record(row)
            self.recorded.put(row)

        self.proxy.state.record = capture
        self.proxy.start()
        self.addCleanup(self.proxy.stop)

    def request(self, path, status, content_type, body, stream=True):
        self.replies.put((status, content_type, body))
        conn = http.client.HTTPConnection("127.0.0.1", self.proxy.port, timeout=4)
        try:
            conn.request("POST", path, json.dumps({"model": "test", "stream": stream}),
                         {"Content-Type": "application/json"})
            response = conn.getresponse()
            self.assertEqual(response.status, status)
            response.read()
        finally:
            conn.close()
        row = self.recorded.get(timeout=3)
        self.assertIsNotNone(row["wire_ttfb_ms"])
        return row

    def test_only_observed_inference_deltas_have_ttft(self):
        chat = "/v1/chat/completions"
        gem = "/v1beta/models/test:"
        text = {"choices": [{"delta": {"content": "ok"}}]}
        role = {"choices": [{"delta": {"role": "assistant"}}]}
        full = b'{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}'
        for path, stream_path in [(chat, chat), (gem + "generateContent", gem + "streamGenerateContent")]:
            for endpoint, status, ctype, body, stream in [
                (path, 200, "application/json", full, False),
                (stream_path, 429, "application/json", b'{"error":"limit"}', True),
                (stream_path, 502, "text/event-stream", frames(text), True),
                (stream_path, 200, "text/event-stream", frames(role, {"usage": {}}), True),
            ]:
                with self.subTest(path=endpoint, status=status, ctype=ctype):
                    row = self.request(endpoint, status, ctype, body, stream)
                    self.assertIsNone(row["t_first_content_delta_ns"])
                    self.assertIsNone(row["wire_ttft_ms"])
            row = self.request(stream_path, 200, "text/event-stream", frames(role, text))
            self.assertGreaterEqual(row["wire_ttft_ms"], row["wire_ttfb_ms"])
            self.assertEqual(row["wire_ttft_ms"], round((row["t_first_content_delta_ns"] - row["t_req_start_ns"]) / 1e6, 2))
        summary = self.proxy.state.get_summary()
        self.assertIsNone(summary["wire_first_ttft_ms"])
        self.assertIsNotNone(summary["wire_median_ttft_ms"])

    def test_incomplete_delta_is_forwarded_before_it_is_measured(self):
        release = threading.Event()
        prefix = b'data: {"choices":[{"delta":{"content":"'

        def split_body(writer):
            writer.write(prefix)
            writer.flush()
            if release.wait(timeout=3):
                writer.write(b'ok"}}]}\n\ndata: [DONE]\n\n')

        self.replies.put((200, "text/event-stream", split_body))
        conn = http.client.HTTPConnection("127.0.0.1", self.proxy.port, timeout=4)
        try:
            conn.request("POST", "/v1/chat/completions", '{"model":"test","stream":true}',
                         {"Content-Type": "application/json"})
            response = conn.getresponse()
            self.assertEqual(response.read(len(prefix)), prefix)
            release.set()
            self.assertIn(b"[DONE]", response.read())
        finally:
            release.set()
            conn.close()
        row = self.recorded.get(timeout=3)
        self.assertGreater(row["t_first_content_delta_ns"], row["t_first_sse_byte_ns"])

    def test_native_stream_protocols_observe_payload_not_control_events(self):
        for path, control, delta in [
            ("/v1/messages", {"type": "content_block_delta", "delta": {
                "type": "signature_delta", "signature": "opaque"}},
             {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{"}}),
            ("/v1/responses", {"type": "response.output_item.added", "item": {"type": "message"}},
             {"type": "response.reasoning_summary_text.delta", "delta": "thinking"}),
        ]:
            with self.subTest(path=path):
                row = self.request(path, 200, "text/event-stream", frames(control))
                self.assertIsNone(row["wire_ttft_ms"])
                row = self.request(path, 200, "text/event-stream", frames(control, delta))
                self.assertGreaterEqual(row["wire_ttft_ms"], row["wire_ttfb_ms"])

    def test_transport_delta_shapes(self):
        def block(kind, **fields):
            return {"type": "content_block_delta", "delta": {"type": kind, **fields}}

        def tool(**fields):
            return {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": fields}]}}]}

        for event in [block("thinking_delta", thinking="x"), block("text_delta", text=" "),
                      block("input_json_delta", partial_json="{"), tool(name="run"), tool(arguments="{}"),
                      {"choices": [{"delta": {"reasoning_content": "x"}}]},
                      {"choices": [{"delta": {"reasoning": "x"}}]},
                      {"type": "response.reasoning_summary_text.delta", "delta": "x"},
                      {"type": "response.function_call_arguments.delta", "delta": "{}"},
                      {"type": "response.output_text.delta", "delta": "x"}]:
            with self.subTest(event=event):
                self.assertTrue(_sse_has_content_or_tool(event))
        for event in [block("signature_delta", signature="sig"), block("text_delta", text=""), tool(),
                      {"type": "response.output_text.delta", "delta": ""}, {"type": "response.completed"},
                      {"type": "content_block_start"}, {"choices": [{"delta": {}, "finish_reason": "stop"}]}]:
            with self.subTest(event=event):
                self.assertFalse(_sse_has_content_or_tool(event))
