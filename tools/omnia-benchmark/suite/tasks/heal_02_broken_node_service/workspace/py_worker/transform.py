"""Persistent NDJSON event transformation worker for event_bridge."""

import json
import sys


def transform_event(event: dict) -> dict:
    route = event.get("route") or {}
    tag = str(route.get("tag", "GENERAL"))
    channel = str(route.get("channel", "general"))
    priority = str(route.get("priority", "normal"))

    event_id = str(event.get("id", ""))
    event_type = str(event.get("type", ""))
    message = "" if event.get("message") is None else str(event.get("message"))
    source_path = "" if event.get("source_path") is None else str(event.get("source_path"))

    segments = [seg for seg in source_path.split("/") if seg] if source_path else []
    amount = event.get("amount", None)

    return {
        "id": event_id,
        "type": event_type,
        "channel": channel,
        "priority": priority,
        "tag": tag,
        "message": message,
        "message_length": len(message),
        "source_path": source_path,
        "path_segments": segments,
        "formatted_label": f"[{tag}] {event_id}: {message}",
        "amount": amount,
        "processed": True,
    }


def main() -> int:
    for raw_line in sys.stdin:
        cleaned = raw_line.strip()
        if not cleaned:
            continue
        cleaned = cleaned.replace("\\n", " ").replace("\\t", " ")
        event = json.loads(cleaned)
        result = transform_event(event)
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
