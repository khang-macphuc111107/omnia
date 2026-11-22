# Task: Polyglot Event Protocol v2 Migration (Python + Node.js) with v1 Dual-Read

## Context
This workspace contains two event-processing services that currently speak **Event Protocol v1**:
- **Python service** (`py_service/events.py`, `py_service/cli.py`, `py_service/test_events.py`) — pure Python 3.13 stdlib only.
- **Node.js ESM client** (`js_client/src/events.mjs`, `js_client/src/cli.mjs`, `js_client/test/events.test.mjs`) — pure Node.js built-ins only (`node:fs`, `node:crypto`, `node:assert/strict`, etc.; zero npm packages).

Your goal is to migrate **BOTH** runtimes to **Event Protocol v2** as formally specified in `spec/protocol_v2.md`, ensuring **100% cross-runtime canonicalization & checksum parity** and **bit-for-bit identical v1 -> v2 dual-read upgrades**.

---

## Requirements

Read `spec/protocol_v2.md` thoroughly and implement every rule across both Python (`py_service/`) and Node.js (`js_client/`):

1. **Canonical JSON & SHA-256 Checksum (`spec/protocol_v2.md`)**
   - Recursively sort all object keys lexicographically by Unicode code point (including nested objects and objects inside arrays).
   - Emit compact JSON with no insignificant whitespace and raw UTF-8 characters (`ensure_ascii=False` in Python, matching `JSON.stringify` in Node.js).
   - Compute `checksum` as lowercase 64-hex SHA-256 of the UTF-8 canonical JSON of the v2 envelope excluding `"checksum"`.

2. **v2 Envelope Creation (`create_event` / `createEvent` & CLI `emit`)**
   - Always emit valid **v2** envelopes (`schema_version: 2`, `event_id`, `event_type`, `occurred_at`, `tags`, `payload`, `checksum`).
   - CLI `emit` supports `--type <str>`, optional `--tags <csv>`, `--payload-json <json>`, optional `--timestamp-sec <num>`, and optional `--event-id <str>`.
   - Default `event_id` for freshly emitted events is a lowercase UUIDv4 string; default `occurred_at` is current UTC time formatted as `YYYY-MM-DDTHH:MM:SS.mmmZ`.

3. **v1 -> v2 Dual-Read Auto-Upgrade (`parse_event` / `parseEvent` & CLI `ingest`)**
   - Both runtimes MUST read JSONL streams containing v1 events, v2 events, or mixed v1+v2 events via `ingest --input <in.jsonl> --output <out.jsonl>`.
   - Upgrade v1 events deterministically using the exact `event_id`, `occurred_at`, `tags`, and `checksum` formulas in `spec/protocol_v2.md` so Python and Node.js produce **bit-for-bit identical** canonical v2 JSONL lines (UTF-8, `\n` LF line endings).
   - Pass already-valid v2 events through after strict validation (preserving their existing `event_id` unchanged).
   - Reject any invalid or tampered event with a non-zero exit code and diagnostic message on stderr.

4. **Strict v2 Validation (`validate_event` / `validateEvent` & CLI `verify`)**
   - `verify --input <in.jsonl>` MUST strictly validate every line as a v2 envelope and exit non-zero on:
     - Unknown or non-integer `schema_version` (anything other than exact integer `2`, including `1`, `3`, `"2"`, `true`)
     - Missing required fields or unexpected extra top-level keys
     - Missing/empty `event_id` or `event_type`
     - Non-UTC or malformed `occurred_at` (must strictly match `YYYY-MM-DDTHH:MM:SS.mmmZ` and be a valid calendar date/time)
     - Non-array, unsorted, duplicate, empty, or non-string `tags`
     - Non-object `payload` (reject arrays, primitives, `null`)
     - Invalid or tampered `checksum`

5. **Unit Tests**
   - Update/extend `py_service/test_events.py` and `js_client/test/events.test.mjs` so both test suites pass cleanly and exercise v2 emission, validation, and v1 fixture dual-read upgrade:
     ```bash
     python -m unittest py_service/test_events.py -v
     node js_client/test/events.test.mjs
     ```
