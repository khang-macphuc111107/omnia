# Event Protocol v2 Specification

This document defines the canonical **Event Protocol v2** JSON envelope format, cross-runtime canonicalization rules, deterministic v1-to-v2 upgrade semantics, and strict validation rules shared by `py_service` (Python 3.13) and `js_client` (Node.js ESM).

---

## 1. Legacy v1 Format (Read-Only Input for Dual-Read Upgrade)

A v1 event JSON object has:
- `type` (`string`, non-empty): event type identifier (e.g. `"order.created"`)
- `timestamp_sec` (`number`, finite int or float, NOT boolean): Unix epoch seconds (e.g. `1710506096` or `1710506096.25`)
- `tags_csv` (`string`, optional, defaults to `""`): comma-separated tags (e.g. `" beta, alpha, beta , "`)
- `payload` (`object`): JSON object (not `null`, not array)
- `schema_version` (optional): omitted or exact integer `1`
- `event_id` (optional `string`): if present and non-empty after trimming, preserved on upgrade

---

## 2. Canonical v2 Envelope Schema

Every valid v2 event is a JSON object with **EXACTLY** these 7 top-level keys:

| Key | Type | Contract |
| --- | --- | --- |
| `schema_version` | `integer` | MUST be exact integer `2` (reject `bool`, string `"2"`, float non-integer, `1`, `3`, etc.) |
| `event_id` | `string` | Non-empty trimmed string. Fresh events default to lowercase UUIDv4 (`xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`). Upgraded v1 events without an existing `event_id` use the deterministic formula in Section 4. |
| `event_type` | `string` | Non-empty trimmed string (mapped from v1 `type`). |
| `occurred_at` | `string` | RFC3339 UTC timestamp with **exact millisecond precision** ending in `Z`: `YYYY-MM-DDTHH:MM:SS.mmmZ` (regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`, valid calendar date/time). Offsets like `+00:00` or `+02:00` are REJECTED. |
| `tags` | `array<string>` | Array of non-empty trimmed strings, **deduplicated** and **sorted ascending** lexicographically by Unicode code point. |
| `payload` | `object` | Arbitrary JSON object (`dict` in Python, plain non-null non-array object in JS). Finite numbers only (`NaN`/`Infinity` forbidden). |
| `checksum` | `string` | Lowercase 64-char hex SHA-256 digest of the UTF-8 canonical JSON of the v2 envelope **without** the `checksum` field (Section 3). |

No missing keys and no extra top-level keys are allowed in a v2 envelope.

---

## 3. Canonical JSON & Checksum Rules

To guarantee bit-for-bit cross-runtime parity between Python and Node.js:

1. **Recursive Key Sorting**: Every JSON object at every nesting depth (including objects nested inside arrays) MUST have its keys sorted in ascending lexicographical order by Unicode code point (Python `sort_keys=True`; JavaScript recursive object reconstruction sorting keys with `(a, b) => (a < b ? -1 : a > b ? 1 : 0)`).
2. **Compact Separators**: No spaces after `,` or `:` (Python `separators=(",", ":")`; JavaScript `JSON.stringify(canonicalized)` with no indentation argument).
3. **Raw UTF-8 Output**: Do NOT escape non-ASCII Unicode characters to `\uXXXX` (Python `ensure_ascii=False`, matching JavaScript `JSON.stringify` UTF-8 output). For example, `"café"` and `"東京"` remain literal UTF-8 characters.
4. **Checksum Computation**:
   - Build a shallow copy of the v2 envelope containing the 6 fields: `event_id`, `event_type`, `occurred_at`, `payload`, `schema_version`, `tags` (i.e., excluding `checksum`).
   - Serialize using `canonical_json(unsigned_envelope)`.
   - Compute `SHA-256` over `canonical_json(unsigned_envelope).encode("utf-8")` and format as lowercase 64-character hexadecimal string.
5. **JSONL Serialization (`serialize_event` / `serializeEvent`)**:
   - Validate the v2 event, then emit `canonical_json(event)` (single line, no embedded raw newlines).
   - Output JSONL files MUST be UTF-8 encoded using `\n` (LF) line endings.

---

## 4. Deterministic v1 -> v2 Upgrade Rules

When upgrading a v1 event to v2:

1. **`event_type`**: `v1["type"]` (must be a non-empty string after trimming; preserve value or fail if empty/non-string).
2. **`occurred_at`**:
   - Validate `timestamp_sec` is a finite number (not `bool`, not `NaN`/`Infinity`).
   - Convert to integer milliseconds since Unix epoch: `ms = round(timestamp_sec * 1000)` (`Math.round(timestamp_sec * 1000)` in JS).
   - Format UTC instant as `YYYY-MM-DDTHH:MM:SS.mmmZ`:
     - Python: `dt = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=ms)`, formatted `dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"`.
     - JavaScript: `new Date(ms).toISOString()`.
3. **`tags`**:
   - Read `tags_csv = v1.get("tags_csv", "")` (must be a string).
   - Split on `","`, trim whitespace on each token, discard empty strings, deduplicate, and sort ascending lexicographically.
4. **`payload`**:
   - Must be a JSON object (`dict` in Python, plain non-null non-array object in JS). Preserve recursively.
5. **`event_id`**:
   - If `v1` already has a non-empty string `event_id` (non-empty after `.strip()` / `.trim()`), preserve it.
   - Otherwise compute deterministically from the normalized v2 semantic fields:
     ```text
     seed_obj = {
       "event_type": event_type,
       "occurred_at": occurred_at,
       "payload": payload,
       "tags": tags
     }
     event_id = "v1-" + sha256_hex(utf8_bytes(canonical_json(seed_obj)))[:16]
     ```
6. **`schema_version`**: `2`
7. **`checksum`**: Compute per Section 3 over the 6 fields (`event_id`, `event_type`, `occurred_at`, `payload`, `schema_version`, `tags`).

---

## 5. Dual-Read (`parse_event` / `ingest`) vs Strict Verification (`validate_event` / `verify`)

- **`parse_event` / `parseEvent` & CLI `ingest`**:
  - If `schema_version` is present:
    - If exact integer `2`: validate strictly as v2 (reject if invalid or checksum mismatch; do NOT recompute checksum or mutate `event_id`).
    - If exact integer `1`: upgrade via Section 4.
    - Otherwise: REJECT (raise error / exit non-zero).
  - If `schema_version` is absent:
    - Treat as v1 and upgrade via Section 4 (reject if required v1 fields are missing or invalid).
- **`validate_event` / `validateEvent` & CLI `verify`**:
  - Strictly validates a **v2** envelope against Section 2 and Section 3.
  - MUST reject raw v1 events, unknown `schema_version`, missing/extra keys, malformed/non-UTC `occurred_at`, invalid/unsorted/duplicate `tags`, non-object `payload`, or tampered `checksum`.

---

## 6. CLI Contract (Both `py_service.cli` and `js_client/src/cli.mjs`)

1. `emit --type <str> [--tags <csv>] --payload-json <json> [--timestamp-sec <num>] [--event-id <str>]`
   - Prints one canonical v2 JSON line to stdout (UTF-8) and exits `0`.
2. `ingest --input <path> --output <path>`
   - Reads JSONL from `--input` (ignoring blank lines), upgrades v1 / validates v2, writes canonical v2 JSONL (UTF-8, `\n` LF) to `--output`, exits `0` on success or non-zero on any error.
3. `verify --input <path>`
   - Strictly validates every non-empty JSONL line in `--input` as a valid v2 envelope; exits `0` if all valid, non-zero otherwise.
