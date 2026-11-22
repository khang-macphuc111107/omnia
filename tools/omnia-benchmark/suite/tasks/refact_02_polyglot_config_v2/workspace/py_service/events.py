"""Event Protocol v1 codec and validator (to be migrated to Protocol v2)."""

from __future__ import annotations

import json
import math
import time
from typing import Any


class EventValidationError(ValueError):
    """Raised when an event violates the protocol schema."""


def create_event(
    event_type: str,
    payload: dict[str, Any],
    tags_csv: str = "",
    timestamp_sec: float | int | None = None,
) -> dict[str, Any]:
    """Create a Protocol v1 event dictionary."""
    ts = time.time() if timestamp_sec is None else timestamp_sec
    event = {
        "type": event_type,
        "timestamp_sec": ts,
        "tags_csv": tags_csv,
        "payload": payload,
    }
    validate_event(event)
    return event


def validate_event(event: dict[str, Any]) -> None:
    """Validate a Protocol v1 event dictionary."""
    if not isinstance(event, dict):
        raise EventValidationError("Event must be a dict")
    if "schema_version" in event and event["schema_version"] != 1:
        raise EventValidationError(
            f"Unsupported schema_version: {event['schema_version']!r}"
        )
    ev_type = event.get("type")
    if not isinstance(ev_type, str) or not ev_type.strip():
        raise EventValidationError("Event 'type' must be a non-empty string")
    ts = event.get("timestamp_sec")
    if isinstance(ts, bool) or not isinstance(ts, (int, float)) or not math.isfinite(ts):
        raise EventValidationError("Event 'timestamp_sec' must be a finite number")
    tags_csv = event.get("tags_csv", "")
    if not isinstance(tags_csv, str):
        raise EventValidationError("Event 'tags_csv' must be a string")
    payload = event.get("payload")
    if not isinstance(payload, dict):
        raise EventValidationError("Event 'payload' must be a JSON object")


def parse_event(raw: str | dict[str, Any]) -> dict[str, Any]:
    """Parse and validate a raw JSON string or dict as a v1 event."""
    if isinstance(raw, str):
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise EventValidationError(f"Invalid JSON: {exc}") from exc
    else:
        obj = raw
    validate_event(obj)
    return obj


def serialize_event(event: dict[str, Any]) -> str:
    """Validate and serialize an event as a single-line JSON string."""
    validate_event(event)
    return json.dumps(event, ensure_ascii=False)
