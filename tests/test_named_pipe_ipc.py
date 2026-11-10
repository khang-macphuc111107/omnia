"""Automated test suite for Cross-Session Named Pipe IPC integration (M5 & M6).

Validates:
1. Connecting to Windows Named Pipes (\\.\\pipe\\LOCAL\\cc-msg-*) and pipe discovery.
2. Protocol message serialization and deserialization (JSON-RPC, newline-delimited,
   and <cross-session-message> wire framing with full XML/special-char escaping).
3. Dispatching task instructions to external session endpoints (Claude Desktop session
   e4bb6ce7 and Claude CLI session 8a74eb55) and capturing delivery acknowledgment.
4. Timeout handling, connection reset / broken pipe, and fallback queuing/routing.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
import re
import sys
import threading
import time
import unittest
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

# Ensure repo root is on sys.path
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from scripts.cross_session_bridge import (
    CrossSessionMessage,
    DeliveryAcknowledgment,
    SessionInfo,
    SendMessageToolPayload,
    WindowsNamedPipe,
    CrossSessionDispatcher,
    PipeConnectionError,
    PipeTimeoutError,
    PipeResetError,
    discover_sessions,
    find_session,
    serialize_envelope,
    PIPE_PREFIX,
    PIPE_URI_PREFIX,
    PIPE_NAME_PATTERN,
)

# Test session aliases and synthetic endpoints for offline testing
TEST_SESSION_DESKTOP = "e4bb6ce7"
TEST_SESSION_CLI = "8a74eb55"
TEST_PIPE_DESKTOP = r"\\.\pipe\LOCAL\cc-msg-11111111111111111111111111111111"
TEST_PIPE_CLI = r"\\.\pipe\LOCAL\cc-msg-22222222222222222222222222222222"


# ==============================================================================
# Test Cases
# ==============================================================================

class TestNamedPipeDiscoveryAndConnection(unittest.TestCase):
    """Test group 1: Connecting to Windows Named Pipes (\\\\.\\pipe\\LOCAL\\cc-msg-*)."""

    mock_pipe_name: str = ""
    h_mock_pipe: Any = None
    kernel32: Any = None

    @classmethod
    def setUpClass(cls):
        if sys.platform == "win32":
            cls.kernel32 = ctypes.windll.kernel32
            cls.mock_pipe_name = rf"\\.\pipe\LOCAL\cc-msg-test-{uuid.uuid4().hex}"
            cls.h_mock_pipe = cls.kernel32.CreateNamedPipeW(
                cls.mock_pipe_name,
                0x00000003, # PIPE_ACCESS_DUPLEX
                0x00000004 | 0x00000002 | 0x00000000, # PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT
                1,
                4096,
                4096,
                0,
                None,
            )
            assert cls.h_mock_pipe != -1 and cls.h_mock_pipe != 0

    @classmethod
    def tearDownClass(cls):
        if sys.platform == "win32" and cls.h_mock_pipe and cls.h_mock_pipe != -1:
            cls.kernel32.CloseHandle(cls.h_mock_pipe)

    def test_pipe_path_validation_regex(self):
        valid_paths = [
            r"\\.\pipe\LOCAL\cc-msg-040eb6ddd2094ac27e1fe338a08b1368",
            r"\\.\pipe\LOCAL\cc-msg-6b30a19473ba23a166426cfe78b4198d",
            r"uds:\\.\pipe\LOCAL\cc-msg-97447116ef7b3545ba5a19d2e698de97",
            r"\\.\pipe\LOCAL\cc-msg-abcdef0123456789abcdef0123456789",
        ]
        for p in valid_paths:
            self.assertTrue(bool(PIPE_NAME_PATTERN.match(p)), f"Path should match: {p}")

        invalid_paths = [
            r"\\.\pipe\other-pipe",
            r"\\.\pipe\LOCAL\cc-msg-tooshort",
            r"\\.\pipe\LOCAL\cc-msg-040eb6ddd2094ac27e1fe338a08b1368-extra",
            r"/tmp/cc-msg-040eb6ddd2094ac27e1fe338a08b1368",
            "not-a-pipe",
        ]
        for p in invalid_paths:
            self.assertFalse(bool(PIPE_NAME_PATTERN.match(p)), f"Path should NOT match: {p}")

    def test_active_pipe_discovery_in_windows_pipe_directory(self):
        """Verifies named pipe discovery in the Windows \\\\.\\pipe namespace."""
        if sys.platform != "win32":
            self.skipTest("Requires Windows platform")

        pipe_dir = r"\\.\pipe"
        pipes = [f for f in os.listdir(pipe_dir) if "cc-msg" in f]
        self.assertGreater(len(pipes), 0, "Expected at least one active cc-msg named pipe in \\\\.\\pipe")

        # Verify active test pipe fixture is discovered
        mock_pipe_short = os.path.basename(self.mock_pipe_name)
        mock_pipe_local = rf"LOCAL\{mock_pipe_short}"
        found = mock_pipe_local in pipes or mock_pipe_short in pipes
        self.assertTrue(found, f"Active named pipe {self.mock_pipe_name} must be discoverable in \\\\.\\pipe")

        # Dynamically verify any live Claude session pipes discovered on host
        for session in discover_sessions():
            if session.pipe_path:
                client = WindowsNamedPipe(session.pipe_path)
                if client.exists():
                    clean_path = session.pipe_path.removeprefix("uds:")
                    short_name = os.path.basename(clean_path)
                    local_name = rf"LOCAL\{short_name}"
                    self.assertTrue(
                        local_name in pipes or short_name in pipes or clean_path.removeprefix("\\\\.\\pipe\\") in pipes,
                        f"Live pipe {session.pipe_path} should be present in \\\\.\\pipe",
                    )

    def test_pipe_client_probe_active_endpoints(self):
        """Tests non-destructive probe connection to active session endpoints."""
        if sys.platform != "win32":
            self.skipTest("Requires Windows platform")

        # Verify probe against mock test pipe fixture
        client = WindowsNamedPipe(self.mock_pipe_name)
        self.assertTrue(client.exists(), "Mock test pipe should exist")
        self.assertTrue(client.probe(timeout_ms=1000), "Mock test pipe must be responsive")

        # Dynamically test any discovered active session endpoints without hardcoding
        for session in discover_sessions():
            if session.pipe_path:
                pipe_client = WindowsNamedPipe(session.pipe_path)
                if pipe_client.exists():
                    self.assertTrue(pipe_client.probe(timeout_ms=1000), f"Pipe {session.pipe_path} should be responsive")

    def test_pipe_client_nonexistent_pipe(self):
        """Tests probing a non-existent pipe returns False without raising unhandled errors."""
        bogus_pipe = r"\\.\pipe\LOCAL\cc-msg-00000000000000000000000000000000"
        client = WindowsNamedPipe(bogus_pipe)
        self.assertFalse(client.exists())
        self.assertFalse(client.probe(timeout_ms=50))


class TestProtocolSerializationDeserialization(unittest.TestCase):
    """Test group 2: Protocol message serialization/deserialization."""

    def test_cross_session_xml_framing_round_trip(self):
        msg = CrossSessionMessage(
            from_endpoint=r"uds:\\.\pipe\LOCAL\cc-msg-040eb6ddd2094ac27e1fe338a08b1368",
            content="Task instruction: implement UI tree-view with > and v chevrons.",
            from_session="8a74eb55-710f-47e2-bc43-cc689aad7c05",
            from_name="Điều phối subagent liên tục",
            from_mode="bypass",
            hop_chain="4aeed45def0bb9646e9b11a2",
        )
        serialized = msg.serialize()
        self.assertIn('<cross-session-message ', serialized)
        self.assertIn('from-name="Điều phối subagent liên tục"', serialized)
        self.assertIn('</cross-session-message>', serialized)

        deserialized = CrossSessionMessage.deserialize(serialized)
        self.assertEqual(deserialized.from_endpoint, msg.from_endpoint)
        self.assertEqual(deserialized.content, msg.content)
        self.assertEqual(deserialized.from_session, msg.from_session)
        self.assertEqual(deserialized.from_name, msg.from_name)
        self.assertEqual(deserialized.from_mode, msg.from_mode)
        self.assertEqual(deserialized.hop_chain, msg.hop_chain)

    def test_cross_session_xml_framing_greedy_nested_tag(self):
        """Verifies payloads containing </cross-session-message> are not prematurely truncated."""
        nested_content = (
            "Line 1: Analysis begins.\n"
            "Example XML block:\n"
            "<cross-session-message from=\"uds:\\\\pipe\">\n"
            "Nested dummy instruction\n"
            "</cross-session-message>\n"
            "Line 2: Critical instruction that must not be truncated."
        )
        msg = CrossSessionMessage(
            from_endpoint=TEST_PIPE_CLI,
            content=nested_content,
            from_name="Agent Coordinator",
        )
        serialized = msg.serialize()
        deserialized = CrossSessionMessage.deserialize(serialized)
        self.assertEqual(deserialized.content, nested_content)
        self.assertEqual(deserialized.from_endpoint, TEST_PIPE_CLI)

    def test_special_characters_and_xml_escaping(self):
        """Adversarial check: XML meta-characters, quotes, control chars, and multi-line strings."""
        adversarial_content = (
            "Complex input with <tags>, & ampersands, \"quotes\", and 'apostrophes'.\n"
            "Line 2: JSON payload: {\"cmd\": \"run\", \"flags\": [\"-v\", \"--json\"]}\n"
            "Line 3: Vietnamese accents: Tiếng Việt có dấu, mũi tên > và v."
        )
        msg = CrossSessionMessage(
            from_endpoint=r'uds:\\.\pipe\LOCAL\cc-msg-test"&<>\'',
            content=adversarial_content,
            from_name='Agent "Turbo" & <Bypass>',
        )
        serialized = msg.serialize()
        # Verify attributes are properly escaped
        self.assertNotIn('from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-test"', serialized)
        self.assertIn('&quot;', serialized)
        self.assertIn('&amp;', serialized)

        deserialized = CrossSessionMessage.deserialize(serialized)
        self.assertEqual(deserialized.from_endpoint, r'uds:\\.\pipe\LOCAL\cc-msg-test"&<>\'')
        self.assertEqual(deserialized.from_name, 'Agent "Turbo" & <Bypass>')
        self.assertEqual(deserialized.content, adversarial_content)

    def test_send_message_tool_payload_serialization(self):
        payload = SendMessageToolPayload(
            to=TEST_PIPE_DESKTOP,
            summary="Bundle gate budget check",
            message="Check scripts/check-bundle-budget.mjs and report total JS size.",
            type="message",
            recipient="Omnia Claude Code Harness",
            recipient_kind="name",
        )
        json_str = payload.to_json()
        deserialized = SendMessageToolPayload.from_json(json_str)

        self.assertEqual(deserialized.to, payload.to)
        self.assertEqual(deserialized.summary, payload.summary)
        self.assertEqual(deserialized.message, payload.message)
        self.assertEqual(deserialized.type, "message")
        self.assertEqual(deserialized.recipient, "Omnia Claude Code Harness")
        self.assertEqual(deserialized.recipient_kind, "name")

    def test_delivery_acknowledgment_serialization(self):
        raw_receipt = {
            "success": True,
            "message": "“Check AGY access” → Omnia Claude Code Harness; in session inbox",
            "msg_id": "68fd41e1-8482-404d-a035-90a21c5be57e",
            "display": "“Check AGY access” → sent to Omnia Claude Code Harness",
        }
        ack = DeliveryAcknowledgment.from_json(json.dumps(raw_receipt))
        self.assertTrue(ack.success)
        self.assertEqual(ack.msg_id, "68fd41e1-8482-404d-a035-90a21c5be57e")
        self.assertIn("in session inbox", ack.message)
        self.assertEqual(ack.display, raw_receipt["display"])

    def test_malformed_xml_handling(self):
        with self.assertRaises(ValueError):
            CrossSessionMessage.deserialize("This is plain text with no XML wrapper.")

        with self.assertRaises(ValueError):
            CrossSessionMessage.deserialize("<cross-session-message missing-from='true'>content</cross-session-message>")

    def test_malformed_json_handling(self):
        with self.assertRaises(json.JSONDecodeError):
            SendMessageToolPayload.from_json("{broken json")

        with self.assertRaises(ValueError):
            # Missing 'summary' and 'message'
            SendMessageToolPayload.from_json('{"to": "dest"}')


class TestTaskInstructionDispatch(unittest.TestCase):
    """Test group 3: Dispatching task instructions to external session endpoints."""

    def setUp(self):
        self.dispatcher = CrossSessionDispatcher(
            registry={
                "desktop": TEST_PIPE_DESKTOP,
                "cli": TEST_PIPE_CLI,
                TEST_SESSION_DESKTOP: TEST_PIPE_DESKTOP,
                TEST_SESSION_CLI: TEST_PIPE_CLI,
            }
        )

    def test_endpoint_resolution(self):
        # Resolve by known session alias
        cli_ep = self.dispatcher.resolve_endpoint(TEST_SESSION_CLI)
        self.assertEqual(cli_ep, TEST_PIPE_CLI)

        desktop_ep = self.dispatcher.resolve_endpoint(TEST_SESSION_DESKTOP)
        self.assertEqual(desktop_ep, TEST_PIPE_DESKTOP)

        # Resolve direct named pipe path
        raw_pipe = r"\\.\pipe\LOCAL\cc-msg-97447116ef7b3545ba5a19d2e698de97"
        self.assertEqual(self.dispatcher.resolve_endpoint(raw_pipe), raw_pipe)

        # Resolve with uds: prefix
        uds_pipe = r"uds:\\.\pipe\LOCAL\cc-msg-97447116ef7b3545ba5a19d2e698de97"
        self.assertEqual(self.dispatcher.resolve_endpoint(uds_pipe), raw_pipe)

        # Invalid target raises ValueError
        with self.assertRaises(ValueError):
            self.dispatcher.resolve_endpoint("invalid-session-uuid")

    def test_dispatch_to_claude_desktop_session(self):
        """Simulates dispatching task instructions to Claude Desktop (e4bb6ce7)."""
        captured_calls: List[Tuple[str, str]] = []

        def mock_transport(endpoint: str, payload_str: str) -> DeliveryAcknowledgment:
            captured_calls.append((endpoint, payload_str))
            return DeliveryAcknowledgment(
                success=True,
                message=f"Delivered to {endpoint}",
                msg_id="receipt-desktop-001",
            )

        task = "Analyze heavy imports in vite.config.ts and reduce bundle size under 5,120,000 B."
        ack = self.dispatcher.dispatch(
            target=TEST_SESSION_DESKTOP,
            task_instruction=task,
            summary="Slice B: Bundle Budget Optimization",
            transport_fn=mock_transport,
        )

        self.assertTrue(ack.success)
        self.assertEqual(ack.msg_id, "receipt-desktop-001")
        self.assertEqual(len(captured_calls), 1)

        endpoint, raw_payload = captured_calls[0]
        self.assertEqual(endpoint, TEST_PIPE_DESKTOP)
        payload = SendMessageToolPayload.from_json(raw_payload)
        self.assertEqual(payload.message, task)
        self.assertEqual(payload.summary, "Slice B: Bundle Budget Optimization")

    def test_dispatch_to_claude_cli_session(self):
        """Simulates dispatching task instructions to Claude CLI (8a74eb55)."""
        captured_calls: List[Tuple[str, str]] = []

        def mock_transport(endpoint: str, payload_str: str) -> DeliveryAcknowledgment:
            captured_calls.append((endpoint, payload_str))
            return DeliveryAcknowledgment(
                success=True,
                message=f"Delivered to {endpoint}",
                msg_id="receipt-cli-002",
            )

        task = "Reconcile 23 uncommitted files and create git commit on omnia/m0-snapshot."
        ack = self.dispatcher.dispatch(
            target=TEST_SESSION_CLI,
            task_instruction=task,
            summary="Git Consolidation Task",
            transport_fn=mock_transport,
        )

        self.assertTrue(ack.success)
        self.assertEqual(ack.msg_id, "receipt-cli-002")
        self.assertEqual(len(captured_calls), 1)
        endpoint, raw_payload = captured_calls[0]
        self.assertEqual(endpoint, TEST_PIPE_CLI)
        payload = SendMessageToolPayload.from_json(raw_payload)
        self.assertEqual(payload.message, task)


class TestTimeoutResetAndFallbackPaths(unittest.TestCase):
    """Test group 4: Timeout handling, connection reset, and fallback paths."""

    def setUp(self):
        self.dispatcher = CrossSessionDispatcher(
            connect_timeout_ms=100,
            fallback_enabled=True,
            registry={
                "desktop": TEST_PIPE_DESKTOP,
                "cli": TEST_PIPE_CLI,
                TEST_SESSION_DESKTOP: TEST_PIPE_DESKTOP,
                TEST_SESSION_CLI: TEST_PIPE_CLI,
            },
        )

    def test_connection_timeout_handling_with_fallback(self):
        """Tests that a connection timeout triggers fallback queuing rather than crashing."""
        def timing_out_transport(endpoint: str, payload: str) -> DeliveryAcknowledgment:
            raise PipeTimeoutError(f"Connection to {endpoint} timed out after 100ms")

        ack = self.dispatcher.dispatch(
            target=TEST_SESSION_DESKTOP,
            task_instruction="Instruction for timed out session",
            summary="Timeout Test",
            transport_fn=timing_out_transport,
        )

        self.assertFalse(ack.success)
        self.assertIn("queued in fallback buffer", ack.message)
        self.assertEqual(len(self.dispatcher.fallback_queue), 1)

        queued_item = self.dispatcher.fallback_queue[0]
        self.assertEqual(queued_item["endpoint"], TEST_PIPE_DESKTOP)
        self.assertIn("timed out", queued_item["error"])

    def test_connection_reset_handling_with_fallback(self):
        """Tests that a broken pipe or connection reset triggers fallback queuing."""
        def reset_transport(endpoint: str, payload: str) -> DeliveryAcknowledgment:
            raise PipeResetError(f"Named pipe connection reset by peer (ECONNRESET)")

        ack = self.dispatcher.dispatch(
            target=TEST_SESSION_CLI,
            task_instruction="Instruction for reset session",
            summary="Reset Test",
            transport_fn=reset_transport,
        )

        self.assertFalse(ack.success)
        self.assertIn("queued in fallback buffer", ack.message)
        self.assertEqual(len(self.dispatcher.fallback_queue), 1)
        self.assertIn("ECONNRESET", self.dispatcher.fallback_queue[0]["error"])

    def test_fallback_disabled_raises_exception(self):
        """Tests that if fallback is disabled, exceptions bubble up directly to caller."""
        strict_dispatcher = CrossSessionDispatcher(
            fallback_enabled=False,
            registry={TEST_SESSION_CLI: TEST_PIPE_CLI},
        )

        def failing_transport(endpoint: str, payload: str) -> DeliveryAcknowledgment:
            raise PipeConnectionError("Pipe not found")

        with self.assertRaises(PipeConnectionError):
            strict_dispatcher.dispatch(
                target=TEST_SESSION_CLI,
                task_instruction="Instruction",
                summary="Fail test",
                transport_fn=failing_transport,
            )

    def test_drain_and_retry_fallback_queue(self):
        """Tests draining the fallback queue once connectivity is restored."""
        # 1. Queue an item via failure
        def fail_transport(ep: str, pl: str) -> DeliveryAcknowledgment:
            raise PipeConnectionError("Service temporarily unavailable")

        self.dispatcher.dispatch(
            target=TEST_SESSION_DESKTOP,
            task_instruction="Queued task for later",
            summary="Deferred Task",
            transport_fn=fail_transport,
        )
        self.assertEqual(len(self.dispatcher.fallback_queue), 1)

        # 2. Simulate network / pipe recovery and drain queue
        def recovered_transport(ep: str, pl: str) -> DeliveryAcknowledgment:
            return DeliveryAcknowledgment(success=True, message="OK", msg_id="rec-99")

        recovered_dispatches = self.dispatcher.drain_fallback_queue(recovered_transport)

        self.assertEqual(len(self.dispatcher.fallback_queue), 0)
        self.assertEqual(len(recovered_dispatches), 1)
        self.assertTrue(recovered_dispatches[0]["result"].success)


if __name__ == "__main__":
    unittest.main()
