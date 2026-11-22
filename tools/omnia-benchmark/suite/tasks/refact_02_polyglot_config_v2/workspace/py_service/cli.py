"""CLI for Python event service (currently Protocol v1)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from py_service.events import (
    EventValidationError,
    create_event,
    parse_event,
    serialize_event,
    validate_event,
)


def _parse_timestamp(raw: str | None) -> int | float | None:
    if raw is None:
        return None
    try:
        if "." not in raw and "e" not in raw.lower():
            return int(raw)
        return float(raw)
    except ValueError as exc:
        raise EventValidationError(f"Invalid --timestamp-sec value: {raw!r}") from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="py_service.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    emit_p = sub.add_parser("emit", help="Emit a single event as JSON")
    emit_p.add_argument("--type", required=True, dest="event_type")
    emit_p.add_argument("--tags", default="")
    emit_p.add_argument("--payload-json", required=True)
    emit_p.add_argument("--timestamp-sec", default=None)
    emit_p.add_argument("--event-id", default=None)

    ingest_p = sub.add_parser("ingest", help="Ingest a JSONL stream and write output JSONL")
    ingest_p.add_argument("--input", required=True)
    ingest_p.add_argument("--output", required=True)

    verify_p = sub.add_parser("verify", help="Verify all events in a JSONL stream")
    verify_p.add_argument("--input", required=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "emit":
            payload = json.loads(args.payload_json)
            ts = _parse_timestamp(args.timestamp_sec)
            event = create_event(
                event_type=args.event_type,
                payload=payload,
                tags_csv=args.tags,
                timestamp_sec=ts,
            )
            print(serialize_event(event))
            return 0

        if args.command == "ingest":
            in_path = Path(args.input)
            out_path = Path(args.output)
            lines_out: list[str] = []
            for lineno, line in enumerate(
                in_path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    ev = parse_event(stripped)
                    lines_out.append(serialize_event(ev))
                except Exception as exc:
                    raise EventValidationError(f"Line {lineno}: {exc}") from exc
            out_path.parent.mkdir(parents=True, exist_ok=True)
            content = ("\n".join(lines_out) + "\n") if lines_out else ""
            with out_path.open("w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
            return 0

        if args.command == "verify":
            in_path = Path(args.input)
            for lineno, line in enumerate(
                in_path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    obj = json.loads(stripped)
                    validate_event(obj)
                except Exception as exc:
                    raise EventValidationError(f"Line {lineno}: {exc}") from exc
            return 0

        raise EventValidationError(f"Unknown command: {args.command}")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
