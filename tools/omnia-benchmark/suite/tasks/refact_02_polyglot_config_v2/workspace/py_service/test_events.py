"""Unit tests for py_service (baseline v1; update/extend for v2 migration)."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from py_service.events import (
    EventValidationError,
    create_event,
    parse_event,
    serialize_event,
)

FIXTURE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "v1_events.jsonl"


class TestPyServiceEvents(unittest.TestCase):
    def test_parse_v1_fixture_lines(self) -> None:
        lines = [
            line.strip()
            for line in FIXTURE_PATH.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(lines), 4)
        parsed = [parse_event(line) for line in lines]
        self.assertEqual(parsed[0]["payload"]["user"], "alice")
        self.assertEqual(parsed[1]["payload"]["city"], "café 東京")
        self.assertEqual(parsed[3]["payload"]["counts"]["sent"], 42)

    def test_create_and_serialize_roundtrip(self) -> None:
        ev = create_event(
            event_type="order.created",
            payload={"amount": 99, "currency": "USD"},
            tags_csv="web, priority",
            timestamp_sec=1710506096,
        )
        raw = serialize_event(ev)
        reparsed = parse_event(raw)
        self.assertEqual(reparsed["payload"], {"amount": 99, "currency": "USD"})

    def test_reject_invalid_payload(self) -> None:
        with self.assertRaises(EventValidationError):
            parse_event(
                json.dumps(
                    {
                        "type": "bad.event",
                        "timestamp_sec": 1710506096,
                        "tags_csv": "",
                        "payload": [1, 2, 3],
                    }
                )
            )


if __name__ == "__main__":
    unittest.main()
