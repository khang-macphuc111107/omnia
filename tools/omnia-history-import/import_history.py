#!/usr/bin/env python3
"""Build an external, redacted Codex/Antigravity history manifest."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sqlite3
import stat
import tempfile
import time
from collections import Counter, defaultdict
from contextlib import contextmanager, nullcontext
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

try:
    import compression.zstd as _compression_zstd
except ImportError:  # pragma: no cover - Python versions before 3.14
    _compression_zstd = None

if os.name == "nt":
    import msvcrt
else:
    import fcntl

MAX_JSONL_LINES = 100_000
MAX_JSONL_SNAPSHOT_BYTES = 64 * 1024 * 1024
MAX_TEXT_FIELD = 4_000
MAX_BODY_TEXT = 8 * 1024 * 1024
MAX_MESSAGES_PER_RECORD = 20_000
MAX_AGY_FILES_PER_SURFACE = 100_000
MAX_ROLLOUT_FILES = 100_000
MAX_ROLLOUT_LINES = 100_000
MAX_ROLLOUT_LINE_BYTES = 16 * 1024 * 1024
MAX_ROLLOUT_DECODED_BYTES = 512 * 1024 * 1024
MAX_BODY_ARTIFACT_BYTES = 512 * 1024 * 1024
MAX_SNAPSHOT_SECONDS = 30.0
MAX_ACTIVE_POINTER_BYTES = 4096
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_RECEIPT_BYTES = 1024 * 1024
MAX_BODY_INDEX_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_FILE_BYTES = MAX_BODY_ARTIFACT_BYTES


def checked_path(path: Path, *, external: bool = False) -> Path:
    """Reject link/reparse components before resolving a local path."""
    path = Path(os.path.abspath(path))
    for component in (path, *path.parents):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("reparse_path_not_allowed")
    if external:
        for component in (path, *path.parents):
            if (component / ".git").exists():
                raise ValueError("repository_output_not_allowed")
    return path.resolve()


def _external_destination(path: Path, source_roots: tuple[Path, ...]) -> Path:
    destination = checked_path(path, external=True)
    for root in source_roots:
        if destination.is_relative_to(root) or destination == root:
            raise ValueError("source_output_overlap")
    return destination


def _safe_files(root: Path, stats: Counter[str], limit: int) -> Iterator[Path]:
    checked_path(root)
    count = 0
    for directory, subdirs, filenames in os.walk(root, topdown=True, followlinks=False):
        accepted = []
        for name in sorted(subdirs):
            try:
                checked_path(Path(directory) / name)
                accepted.append(name)
            except (OSError, ValueError):
                stats["unsafe_paths_skipped"] += 1
        subdirs[:] = accepted
        for name in sorted(filenames):
            path = Path(directory) / name
            try:
                checked_path(path)
                if not path.is_file():
                    continue
            except (OSError, ValueError):
                stats["unsafe_paths_skipped"] += 1
                continue
            if count >= limit:
                stats["file_limit_reached"] += 1
                return
            count += 1
            yield path

_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----", re.I), "[REDACTED_PRIVATE_KEY]"),
    (re.compile(r"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b"), "[REDACTED_API_KEY]"),
    (re.compile(r"\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"\b(?:xoxb|xoxp|xoxa)-[A-Za-z0-9-]{16,}\b"), "[REDACTED_SLACK_TOKEN]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"), "[REDACTED_GOOGLE_API_KEY]"),
    (re.compile(r"\b(?:hf|glpat)-[A-Za-z0-9_-]{16,}\b"), "[REDACTED_SERVICE_TOKEN]"),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}"), "Bearer [REDACTED_TOKEN]"),
    (re.compile(r"(?i)\b(?:password|passwd|pwd|token|secret|api[_ -]?key)\s*[:=]\s*\S+"), "[REDACTED_CREDENTIAL_FIELD]"),
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", re.I), "[REDACTED_EMAIL]"),
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical_json_bytes(payload: dict[str, Any]) -> bytes:
    """Return the exact UTF-8 bytes written by ``write_atomic``."""
    return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"


def read_jsonl_snapshot(path: Path) -> tuple[bytes, str, bool]:
    """Read one bounded byte snapshot and hash that same snapshot."""
    with path.open("rb") as handle:
        snapshot = handle.read(MAX_JSONL_SNAPSHOT_BYTES + 1)
    truncated = len(snapshot) > MAX_JSONL_SNAPSHOT_BYTES
    if truncated:
        snapshot = snapshot[:MAX_JSONL_SNAPSHOT_BYTES]
    return snapshot, sha256_bytes(snapshot), truncated


def redact_text(value: Any, home: Path, limit: int = MAX_TEXT_FIELD) -> str:
    if value is None:
        return ""
    text = str(value).replace("\x00", "")
    variants = {str(home.resolve()), home.resolve().as_posix()}
    variants |= {item.lower() for item in variants}
    for variant in sorted(variants, key=len, reverse=True):
        text = text.replace(variant, "~")
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text[:limit]


def display_path(path: Path, home: Path) -> str:
    try:
        return "~/" + path.resolve().relative_to(home.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def record_id(source: str, identity: str) -> str:
    # Metadata indexes and live databases describe the same conversation through
    # different source labels.  Canonical namespaces let the later merge step
    # retain one record while preserving all observed surfaces in ``details``.
    if source.startswith("codex."):
        namespace = "codex.thread"
    elif source.startswith("agy."):
        namespace = "agy.conversation"
    else:
        namespace = source
    digest = hashlib.sha256(f"{namespace}\0{identity}".encode("utf-8")).hexdigest()
    return f"{namespace}:{digest[:24]}"


def make_record(
    source: str,
    identity: str,
    source_path: Path,
    home: Path,
    source_hash: str | None,
    *,
    title: Any = "",
    preview: Any = "",
    timestamp: Any = None,
    retrieval_state: str = "partial",
    transcript_available: bool = False,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "record_id": record_id(source, identity),
        "source": source,
        "source_id": redact_text(identity, home),
        "source_path": display_path(source_path, home),
        "source_sha256": source_hash,
        "title": redact_text(title, home),
        "preview": redact_text(preview, home),
        "timestamp": redact_text(timestamp, home) if timestamp is not None else None,
        "metadata_available": True,
        "transcript_available": transcript_available,
        "retrieval_state": retrieval_state,
        "redaction_state": "applied",
        "details": details or {},
    }


_RETRIEVAL_STATES = frozenset({"verified", "partial", "blocked"})


def _string_values(raw: Any) -> tuple[set[str], bool]:
    """Accept legacy singleton strings without stringifying malformed values."""
    if isinstance(raw, str):
        return ({raw} if raw else set()), False
    if not isinstance(raw, (list, tuple, set)):
        return set(), True
    return {item for item in raw if isinstance(item, str) and item}, any(
        not isinstance(item, str) for item in raw
    )


def _valid_count(value: Any) -> bool:
    return type(value) is int and value >= 0


def _merge_details(old: Any, new: Any) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    invalid: set[str] = set()
    for details in (old, new):
        if not isinstance(details, dict):
            invalid.add("details")
            continue
        for key, value in details.items():
            if not isinstance(key, str):
                invalid.add("details_key")
                continue
            if key == "invalid_evidence_fields":
                fields, malformed = _string_values(value)
                invalid.update(fields)
                if malformed:
                    invalid.add(key)
            elif key in {"surfaces", "source_states", "evidence_source_states"}:
                values, malformed = _string_values(value)
                if key != "surfaces" and values - _RETRIEVAL_STATES:
                    malformed = True
                if malformed:
                    invalid.add(key)
                previous, _ = _string_values(merged.get(key, []))
                merged[key] = sorted(previous | values)
            elif key.endswith("_count") or key == "unsafe_paths_skipped":
                if not _valid_count(value):
                    invalid.add(key)
                else:
                    previous = merged.get(key, 0)
                    if not _valid_count(previous):
                        invalid.add(key)
                        previous = 0
                    merged[key] = max(previous, value)
            elif key in {"missing_trajectory", "file_limit_reached"}:
                if type(value) is not bool:
                    invalid.add(key)
                merged[key] = bool(merged.get(key) or value)
            elif key == "summary_step_count_matches":
                if type(value) is not bool:
                    invalid.add(key)
                merged[key] = merged.get(key, True) is True and value is True
            elif key in {"metadata_state", "summary_state"}:
                if value is None or value == "":
                    continue
                if not isinstance(value, str) or value not in {
                    "blocked", "partial", "missing", "verified"
                }:
                    invalid.add(key)
                    value = "partial"
                states = {merged.get(key), value}
                merged[key] = next(
                    state
                    for state in ("blocked", "partial", "missing", "verified")
                    if state in states
                )
            elif value not in (None, "", [], {}):
                merged[key] = value
    if invalid:
        merged["invalid_evidence_fields"] = sorted(invalid)
    return merged


_SOURCE_EVIDENCE_KEYS = (
    "source",
    "source_path",
    "source_sha256",
    "metadata_kind",
    "summary_sha256",
)


def _record_source_evidence(record: dict[str, Any]) -> dict[str, Any]:
    """Project one record-level observation into stable source evidence."""
    details = record.get("details")
    if not isinstance(details, dict):
        details = {}
    values = {
        "source": record.get("source"),
        "source_path": record.get("source_path"),
        "source_sha256": record.get("source_sha256"),
        "metadata_kind": details.get("metadata_kind"),
        "summary_sha256": details.get("summary_sha256"),
    }
    return {
        key: value if value is None or isinstance(value, str) else None
        for key, value in values.items()
    }


def _source_evidence_items(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        values = [raw]
    elif isinstance(raw, (list, tuple, set)):
        values = list(raw)
    else:
        return []
    result: list[dict[str, Any]] = []
    for value in values:
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("source"), str)
            or not value["source"]
        ):
            continue
        result.append({
            key: (
                value.get(key)
                if value.get(key) is None or isinstance(value.get(key), str)
                else None
            )
            for key in _SOURCE_EVIDENCE_KEYS
        })
    return result


def _merge_source_evidence(*raw_values: Any) -> list[dict[str, Any]]:
    """Return canonical, duplicate-free evidence observations in stable order."""
    merged: dict[str, dict[str, Any]] = {}
    for raw in raw_values:
        for evidence in _source_evidence_items(raw):
            key = json.dumps(
                evidence,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            merged[key] = evidence
    return [merged[key] for key in sorted(merged)]


def _source_evidence_for_record(record: dict[str, Any]) -> list[dict[str, Any]]:
    """Keep an aggregate's observed evidence; only project a fresh record."""
    details = record.get("details")
    observed = _merge_source_evidence(
        details.get("source_evidence") if isinstance(details, dict) else None
    )
    if observed:
        return observed
    return _merge_source_evidence(_record_source_evidence(record))


def _state_values(details: dict[str, Any]) -> set[str]:
    values: set[str] = set()
    for key in ("source_states", "evidence_source_states"):
        observed, _ = _string_values(details.get(key, []))
        values.update(observed & _RETRIEVAL_STATES)
    return values


def _detail_count(details: dict[str, Any], key: str) -> int:
    value = details.get(key, 0)
    return value if _valid_count(value) else 0


def _has_incomplete_evidence(details: dict[str, Any]) -> bool:
    """Return true when any recorded evidence prevents a verified claim."""
    if _merge_details({}, details).get("invalid_evidence_fields"):
        return True
    for key in (
        "unsupported_count",
        "unsupported_event_count",
        "malformed_count",
        "empty_count",
        "rejected_message_count",
        "truncated_message_count",
        "ordinal_conflict_count",
    ):
        if _detail_count(details, key) > 0:
            return True
    if details.get("missing_trajectory") or details.get("file_limit_reached"):
        return True
    if (
        details.get("line_limit_reached")
        or details.get("decoded_limit_reached")
        or details.get("decode_error")
        or details.get("identity_mismatch")
    ):
        return True
    if _detail_count(details, "unsafe_paths_skipped") > 0:
        return True
    if "summary_step_count_matches" in details and details["summary_step_count_matches"] is not True:
        return True
    for key in ("metadata_state", "summary_state"):
        if key in details and details[key] not in (None, "", "verified"):
            return True
    if _state_values(details) & {"partial", "blocked"}:
        return True
    return False


def _merged_retrieval_state(
    current_state: Any, incoming_state: Any, details: dict[str, Any]
) -> str:
    """Merge states without allowing incomplete evidence to become verified."""
    states = _state_values(details)
    for value in (current_state, incoming_state):
        if not isinstance(value, str) or value not in _RETRIEVAL_STATES:
            return "partial"
        states.add(value)
    if "partial" in states:
        return "partial"
    if "blocked" in states:
        # A blocked-only record has no readable evidence. Once any readable
        # source or body exists, the combined state is partial instead.
        if "verified" in states or _detail_count(details, "body_message_count") > 0:
            return "partial"
        return "blocked"
    if _has_incomplete_evidence(details):
        return "partial"
    if "verified" in states:
        return "verified"
    return "partial"


def _upsert_record(records: dict[str, dict[str, Any]], item: dict[str, Any]) -> None:
    rid = str(item["record_id"])
    incoming_evidence = _source_evidence_for_record(item)
    current = records.get(rid)
    current_evidence = (
        _source_evidence_for_record(current) if current is not None else []
    )
    item["details"] = _merge_details({}, item.get("details", {}))
    item["details"]["source_evidence"] = incoming_evidence
    if current is None:
        item["retrieval_state"] = _merged_retrieval_state(
            item.get("retrieval_state"),
            item.get("retrieval_state"),
            item["details"],
        )
        records[rid] = item
        return
    for key in ("title", "preview", "timestamp", "source_sha256"):
        if not current.get(key) and item.get(key):
            current[key] = item[key]
    current["metadata_available"] = bool(
        current.get("metadata_available") or item.get("metadata_available")
    )
    current["transcript_available"] = bool(
        current.get("transcript_available") or item.get("transcript_available")
    )
    current["details"] = _merge_details(
        current.get("details", {}),
        item["details"],
    )
    current["details"]["source_evidence"] = _merge_source_evidence(
        current_evidence,
        incoming_evidence,
    )
    source_states = _state_values(current["details"])
    for candidate in (current.get("retrieval_state"), item.get("retrieval_state")):
        if isinstance(candidate, str) and candidate in _RETRIEVAL_STATES:
            source_states.add(candidate)
        else:
            source_states.add("partial")
    current["details"]["source_states"] = sorted(source_states)
    current["details"]["evidence_source_states"] = sorted(source_states)
    current["retrieval_state"] = _merged_retrieval_state(
        current.get("retrieval_state"),
        item.get("retrieval_state"),
        current["details"],
    )
    surfaces, _ = _string_values(current["details"].get("surfaces", []))
    surfaces.add(str(item.get("source", "")))
    current["details"]["surfaces"] = sorted(item for item in surfaces if item)


class BodyWriter:
    """Write redacted ordered messages to an external JSONL artifact."""

    def __init__(self, path: Path | None, home: Path) -> None:
        self.path = path
        self.home = home
        self._temp: Path | None = None
        self._handle: Any = None
        self._hash = hashlib.sha256()
        self.bytes_written = 0
        self.message_count = 0
        self.user_count = 0
        self.assistant_count = 0
        self.truncated = False
        self.truncated_messages = 0
        self.duplicates = 0
        self._seen: set[str] = set()
        self.index: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.rejected_by_record: Counter[str] = Counter()
        self.truncated_by_record: Counter[str] = Counter()
        self.ordinal_conflicts_by_record: Counter[str] = Counter()
        self.ordinal_conflict_evidence: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._seen_spans: dict[str, dict[str, Any]] = {}
        self._pending_by_record: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._pending_bytes = 0
        self._pending_by_record_count: Counter[str] = Counter()
        self.by_record: Counter[str] = Counter()
        self.by_role: Counter[str] = Counter()
        self._closed = False
        if path is not None:
            self.path = checked_path(path, external=True)
            path = self.path
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(
                prefix=f"{path.name}.", suffix=".tmp", dir=path.parent
            )
            self._temp = Path(temp_name)
            self._handle = os.fdopen(fd, "wb")

    def add(self, record_id_value: str, message: dict[str, Any]) -> bool:
        if self._closed:
            raise RuntimeError("body_writer_closed")
        role = str(message.get("role") or "")
        raw_text = str(message.get("text") or "")
        text = redact_text(raw_text, self.home, MAX_BODY_TEXT)
        if role not in {"user", "assistant"} or not text:
            self.rejected_by_record[record_id_value] += 1
            return False
        item_id = redact_text(message.get("item_id", message.get("idx", "")), self.home)
        ordinal_value = self._normalize_ordinal(message.get("ordinal", message.get("idx", 0)))
        timestamp = message.get("timestamp")
        if (
            type(ordinal_value) is not int or not 0 <= ordinal_value <= 2**63 - 1
            or (timestamp is not None and type(timestamp) not in (int, str))
            or (type(timestamp) is int and not -(2**63) <= timestamp <= 2**63 - 1)
        ):
            self.rejected_by_record[record_id_value] += 1
            return False
        if isinstance(timestamp, str):
            timestamp = redact_text(timestamp, self.home)
        try:
            content_hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
            text.encode("utf-8")
        except UnicodeError:
            self.rejected_by_record[record_id_value] += 1
            return False
        key = hashlib.sha256(
            json.dumps(
                [record_id_value, role, item_id, ordinal_value, timestamp, content_hash],
                ensure_ascii=False, separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        if key in self._seen:
            self.duplicates += 1
            span = self._seen_spans[key]
            provenance = self._message_provenance(message)
            if provenance not in span["_provenance"]:
                span["_provenance"].append(provenance)
            # Pick one canonical surface for the body; all observed surfaces
            # remain in the index. Discovery order must not choose the body.
            span["source"] = min(
                str(span["source"]), redact_text(message.get("source", ""), self.home)
            )
            return False
        is_truncated = len(raw_text) > MAX_BODY_TEXT
        if is_truncated:
            self.truncated_messages += 1
            self.truncated_by_record[record_id_value] += 1
        payload = {
            "record_id": record_id_value,
            "role": role,
            "item_id": item_id,
            "ordinal": ordinal_value,
            "timestamp": timestamp,
            "source": redact_text(message.get("source", ""), self.home),
            "text": text,
            "truncated": is_truncated,
        }
        payload["_content_sha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
        payload["_provenance"] = [self._message_provenance(message)]
        encoded_size = len(self._encode_payload(payload))
        if self._pending_bytes + encoded_size > MAX_BODY_ARTIFACT_BYTES:
            self.truncated = True
            self.rejected_by_record[record_id_value] += 1
            return False
        if self._pending_by_record_count[record_id_value] >= MAX_MESSAGES_PER_RECORD:
            self.rejected_by_record[record_id_value] += 1
            return False
        self._seen.add(key)
        self._pending_by_record[record_id_value].append(payload)
        self._pending_by_record_count[record_id_value] += 1
        self._pending_bytes += encoded_size
        self._seen_spans[key] = payload
        self.message_count += 1
        self.by_record[record_id_value] += 1
        self.by_role[role] += 1
        return True

    @staticmethod
    def _normalize_ordinal(value: Any) -> Any:
        if isinstance(value, bool):
            return value
        if isinstance(value, int):
            return value
        text = str(value).strip()
        if re.fullmatch(r"-?\d+", text):
            try:
                return int(text)
            except ValueError:
                pass
        return value

    @classmethod
    def _ordinal_sort_key(cls, value: Any) -> tuple[int, int, str]:
        normalized = cls._normalize_ordinal(value)
        if isinstance(normalized, int):
            return (0, normalized, "")
        return (1, 0, str(normalized))

    @staticmethod
    def _encode_payload(payload: dict[str, Any]) -> bytes:
        public_payload = {
            key: value for key, value in payload.items() if not key.startswith("_")
        }
        return (
            json.dumps(public_payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8")

    def _record_conflicts(
        self, record_id_value: str, payloads: list[dict[str, Any]]
    ) -> None:
        by_ordinal: dict[tuple[int, int, str], list[dict[str, Any]]] = defaultdict(list)
        for payload in payloads:
            by_ordinal[self._ordinal_sort_key(payload.get("ordinal", 0))].append(payload)
        for ordinal_key, group in by_ordinal.items():
            if len(group) < 2:
                continue
            self.ordinal_conflicts_by_record[record_id_value] += len(group) - 1
            self.ordinal_conflict_evidence[record_id_value].append(
                {
                    "ordinal": ordinal_key[1] if ordinal_key[0] == 0 else ordinal_key[2],
                    "items": [
                        {
                            "item_id": str(item.get("item_id", "")),
                            "role": str(item.get("role", "")),
                            "content_sha256": str(item.get("_content_sha256", "")),
                            "source": str(item.get("source", "")),
                        }
                        for item in sorted(
                            group,
                            key=lambda item: (
                                str(item.get("source", "")),
                                str(item.get("item_id", "")),
                                str(item.get("_content_sha256", "")),
                            ),
                        )
                    ],
                }
            )

    def _publish_pending(self) -> None:
        for record_id_value in sorted(self._pending_by_record):
            pending = self._pending_by_record[record_id_value]
            self._record_conflicts(record_id_value, pending)
            ordered = sorted(
                pending,
                key=lambda item: (
                    self._ordinal_sort_key(item.get("ordinal", 0)),
                    str(item.get("source", "")),
                    str(item.get("item_id", "")),
                    str(item.get("_content_sha256", "")),
                    str(item.get("role", "")),
                    json.dumps(item.get("timestamp"), ensure_ascii=False),
                ),
            )
            for payload in ordered:
                encoded = self._encode_payload(payload)
                span = {
                    "offset": self.bytes_written,
                    "bytes": len(encoded),
                    "sha256": hashlib.sha256(encoded).hexdigest(),
                    "provenance": sorted(
                        payload.get("_provenance", []),
                        key=lambda item: json.dumps(item, sort_keys=True),
                    ),
                }
                record_id = str(payload["record_id"])
                self.index[record_id].append(span)
                if self._handle is not None:
                    self._handle.write(encoded)
                self._hash.update(encoded)
                self.bytes_written += len(encoded)
        self._pending_by_record.clear()
        self._pending_by_record_count.clear()
        self._pending_bytes = 0

    def record_message_count(self, record_id_value: str) -> int:
        return self.by_record.get(record_id_value, 0)

    def bind_snapshot(
        self,
        record_id_value: str,
        source: str,
        snapshot_sha256: str | None,
    ) -> None:
        """Attach the finalized source hash to pending message provenance."""
        if not snapshot_sha256:
            return
        source_value = redact_text(source, self.home)
        snapshot_value = redact_text(snapshot_sha256, self.home)
        for payload in self._seen_spans.values():
            if str(payload.get("record_id")) != str(record_id_value):
                continue
            for provenance in payload.get("_provenance", []):
                if (
                    isinstance(provenance, dict)
                    and provenance.get("source") == source_value
                    and not provenance.get("snapshot_sha256")
                ):
                    provenance["snapshot_sha256"] = snapshot_value

    def _message_provenance(self, message: dict[str, Any]) -> dict[str, Any]:
        return {
            "source": redact_text(message.get("source", ""), self.home),
            "snapshot_sha256": redact_text(message.get("snapshot_sha256"), self.home) or None,
        }

    def close(self) -> dict[str, Any]:
        if self._closed:
            return self.stats()
        self._publish_pending()
        if self._handle is not None:
            try:
                self._handle.flush()
                os.fsync(self._handle.fileno())
                self._handle.close()
                self._handle = None
                if self._temp is not None and self.path is not None:
                    os.replace(self._temp, self.path)
            finally:
                if self._temp is not None:
                    self._temp.unlink(missing_ok=True)
        self._closed = True
        return self.stats()

    def write_index(self) -> dict[str, Any] | None:
        if self.path is None:
            return None
        if not self._closed:
            raise RuntimeError("body_writer_not_closed")
        payload = {
            "schema": "omnia.history-body-index.v1",
            "body_sha256": self._hash.hexdigest(),
            "body_bytes": self.bytes_written,
            "messages": self.message_count,
            "records": dict(self.index),
        }
        path = self.path.with_suffix(".index.json")
        write_atomic(path, payload)
        return {"path": str(path), "sha256": sha256_file(path), "bytes": path.stat().st_size}

    def abort(self) -> None:
        """Close the temporary file without replacing the destination."""
        if self._closed:
            return
        if self._handle is not None:
            try:
                self._handle.close()
            finally:
                self._handle = None
        if self._temp is not None:
            self._temp.unlink(missing_ok=True)
        self._closed = True

    def stats(self) -> dict[str, Any]:
        return {
            "path": str(self.path) if self.path is not None else None,
            "sha256": self._hash.hexdigest(),
            "bytes": self.bytes_written,
            "messages": self.message_count,
            "users": self.by_role.get("user", 0),
            "assistants": self.by_role.get("assistant", 0),
            "records": len(self.by_record),
            "truncated": self.truncated,
            "truncated_messages": self.truncated_messages,
            "duplicates": self.duplicates,
            "ordinal_conflicts": sum(self.ordinal_conflicts_by_record.values()),
            "rejected_messages": sum(self.rejected_by_record.values()),
        }


def _open_sqlite_ro(path: Path, timeout: float = 5.0) -> sqlite3.Connection:
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=timeout)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("BEGIN")
    return connection


@contextmanager
def _sqlite_snapshot(
    path: Path,
    *,
    snapshot_root: Path | None = None,
    timeout: float = 5.0,
) -> Iterator[tuple[sqlite3.Connection, str]]:
    """Read one consistent SQLite snapshot and hash the snapshot bytes.

    SQLite's online backup API observes a transactionally consistent database,
    including WAL state. Hashing the live ``.sqlite``, ``-wal`` and ``-shm``
    files independently can describe a mixture of revisions, so all callers
    use this context manager for both reads and provenance.
    """
    path = checked_path(path)
    if not path.exists():
        raise FileNotFoundError(path)
    if snapshot_root is not None:
        snapshot_root = checked_path(snapshot_root, external=True)
        snapshot_root.mkdir(parents=True, exist_ok=True)
    else:
        checked_path(Path(tempfile.gettempdir()), external=True)
    temp_dir = tempfile.TemporaryDirectory(
        prefix="omnia-sqlite-snapshot-",
        dir=str(snapshot_root) if snapshot_root is not None else None,
    )
    snapshot_dir = Path(temp_dir.name)
    snapshot_path = snapshot_dir / f"{path.stem}.sqlite"
    source: sqlite3.Connection | None = None
    target: sqlite3.Connection | None = None
    snapshot: sqlite3.Connection | None = None
    try:
        source = sqlite3.connect(
            path.as_uri() + "?mode=ro",
            uri=True,
            timeout=timeout,
        )
        source.execute("PRAGMA query_only=ON")
        # Establish the read transaction before invoking the online backup.
        # Without a pinned source snapshot, a busy WAL database can restart
        # the backup repeatedly while writers advance the live connection,
        # eventually reaching ``snapshot_deadline_exceeded``.
        source.execute("BEGIN")
        source.execute("SELECT name FROM sqlite_master ORDER BY name LIMIT 1").fetchall()
        target = sqlite3.connect(str(snapshot_path), timeout=timeout)
        deadline = time.monotonic() + MAX_SNAPSHOT_SECONDS

        def progress(_status: int, _remaining: int, _total: int) -> None:
            if time.monotonic() > deadline:
                raise sqlite3.OperationalError("snapshot_deadline_exceeded")

        source.backup(target, pages=256, progress=progress, sleep=0.05)
        target.commit()
        target.close()
        target = None
        digest = sha256_file(snapshot_path)
        snapshot = _open_sqlite_ro(snapshot_path, timeout=timeout)
        yield snapshot, digest
    finally:
        for connection in (snapshot, target, source):
            if connection is not None:
                try:
                    connection.rollback()
                except sqlite3.Error:
                    pass
                connection.close()
        temp_dir.cleanup()


def _sqlite_digest(path: Path, *, snapshot_root: Path | None = None) -> str:
    with _sqlite_snapshot(path, snapshot_root=snapshot_root) as (_, digest):
        return digest


def _parse_codex_message(item_type: str, item_json: Any) -> tuple[str, str, str]:
    if item_type not in {"userMessage", "agentMessage"}:
        return "", "", "unsupported"
    try:
        payload = json.loads(item_json) if isinstance(item_json, str) else item_json
    except (TypeError, json.JSONDecodeError):
        return "", "", "malformed"
    if not isinstance(payload, dict):
        return "", "", "malformed"
    if item_type == "agentMessage":
        text = payload.get("text")
        if not isinstance(text, str):
            return "", "", "malformed"
        return ("assistant", text.strip(), "ok") if text.strip() else ("", "", "empty")
    content = payload.get("content")
    if not isinstance(content, list):
        return "", "", "malformed"
    chunks = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            chunks.append(block["text"])
    text = "\n".join(chunks).strip()
    return ("user", text, "ok") if text else ("", "", "empty")


def _thread_metadata(connection: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    rows = connection.execute(
        "SELECT id, title, preview, first_user_message, created_at_ms, updated_at_ms, cwd, project_id FROM threads"
    ).fetchall()
    return {str(row[0]): {
        "title": row[1], "preview": row[2] or row[3], "created_at_ms": row[4],
        "updated_at_ms": row[5], "cwd": row[6], "project_id": row[7]
    } for row in rows}


def _extract_codex(codex_root: Path, home: Path, body_writer: BodyWriter) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    history_path = codex_root / "thread_history_1.sqlite"
    state_path = codex_root / "state_5.sqlite"
    if not history_path.exists():
        return [], {"path": display_path(history_path, home), "state": "blocked", "error": "missing"}
    messages_before = body_writer.message_count
    try:
        metadata: dict[str, dict[str, Any]] = {}
        metadata_digest: str | None = None
        metadata_state = "missing"
        metadata_error: str | None = None
        if state_path.exists():
            try:
                with _sqlite_snapshot(state_path) as (metadata_connection, digest):
                    metadata_digest = digest
                    metadata = _thread_metadata(metadata_connection)
                    metadata_state = "verified"
            except (OSError, sqlite3.Error, ValueError) as exc:
                metadata_state = "blocked"
                metadata_error = type(exc).__name__
        with _sqlite_snapshot(history_path) as (connection, digest):
            rows = connection.execute(
                "SELECT thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type "
                "FROM thread_items ORDER BY thread_id, rollout_ordinal, item_id"
            ).fetchall()
            history_digest = digest
        thread_ids = {str(row[0]) for row in rows if row and row[0] is not None}
        thread_ids.update(metadata)
        records: dict[str, dict[str, Any]] = {}
        counts = Counter()
        malformed = 0
        empty = 0
        unsupported = 0

        def ensure_record(thread_id: str) -> dict[str, Any]:
            rid = record_id("codex.thread", thread_id)
            if rid not in records:
                meta = metadata.get(thread_id, {})
                records[rid] = make_record(
                    "codex.thread",
                    thread_id,
                    history_path,
                    home,
                    history_digest,
                    title=meta.get("title"),
                    preview=meta.get("preview"),
                    timestamp=meta.get("updated_at_ms") or meta.get("created_at_ms"),
                    retrieval_state="partial",
                    transcript_available=False,
                    details={
                        "metadata_kind": "codex_sqlite",
                        "surface": "codex",
                        "thread_id": thread_id,
                        "user_count": 0,
                        "assistant_count": 0,
                        "item_count": 0,
                        "chat_item_count": 0,
                        "malformed_count": 0,
                        "empty_count": 0,
                        "unsupported_count": 0,
                        "workspace": redact_text(meta.get("cwd"), home),
                        "project_id": redact_text(meta.get("project_id"), home),
                        "metadata_source_sha256": metadata_digest,
                        "metadata_state": metadata_state,
                    },
                )
            return records[rid]

        for thread_id in sorted(thread_ids):
            ensure_record(thread_id)

        for thread_id, turn_id, item_id, ordinal, created_at_ms, item_json, item_type in rows:
            counts["items"] += 1
            record = ensure_record(str(thread_id))
            detail = record["details"]
            detail["item_count"] += 1
            role, text, status = _parse_codex_message(str(item_type), item_json)
            if status == "unsupported":
                unsupported += 1
                detail["unsupported_count"] += 1
                continue
            detail["chat_item_count"] += 1
            if status == "malformed":
                malformed += 1
                detail["malformed_count"] += 1
                continue
            if status == "empty":
                empty += 1
                detail["empty_count"] += 1
                continue
            rid = record["record_id"]
            body_writer.add(
                rid,
                {
                    "role": role,
                    "text": text,
                    "item_id": item_id,
                    "ordinal": ordinal,
                    "timestamp": created_at_ms,
                    "source": "codex",
                    "snapshot_sha256": history_digest,
                },
            )
            detail[f"{role}_count"] += 1
        for item in records.values():
            item["transcript_available"] = bool(
                body_writer.record_message_count(item["record_id"])
            )
            item["details"]["body_message_count"] = body_writer.record_message_count(
                item["record_id"]
            )
            rejected = body_writer.rejected_by_record[item["record_id"]]
            truncated = body_writer.truncated_by_record[item["record_id"]]
            item["details"]["rejected_message_count"] = rejected
            item["details"]["truncated_message_count"] = truncated
            conflicts = body_writer.ordinal_conflicts_by_record[item["record_id"]]
            item["details"]["ordinal_conflict_count"] = conflicts
            if conflicts:
                item["details"]["ordinal_conflict_evidence"] = (
                    body_writer.ordinal_conflict_evidence[item["record_id"]]
                )
            if (
                item["transcript_available"]
                and metadata_state == "verified"
                and not _has_incomplete_evidence(item["details"])
            ):
                item["retrieval_state"] = "verified"
        state = "verified" if (
            metadata_state == "verified" and
            all(item["retrieval_state"] == "verified" for item in records.values())
        ) else "partial"
        return list(records.values()), {
            "path": display_path(history_path, home),
            "sha256": history_digest,
            "state": state,
            "item_count": counts["items"],
            "records": len(records),
            "malformed_messages": malformed,
            "empty_messages": empty,
            "unsupported_items": unsupported,
            "metadata_records": len(metadata),
            "metadata_sha256": metadata_digest,
            "metadata_state": metadata_state,
            "metadata_error": metadata_error,
            "snapshot_consistency": "per_database_not_cross_database",
            "body_messages_added": body_writer.message_count - messages_before,
            "transcript_available": body_writer.message_count > messages_before,
        }
    except (OSError, sqlite3.Error, ValueError) as exc:
        return [], {"path": display_path(history_path, home), "state": "blocked", "error": type(exc).__name__}



class _HashingReader(io.RawIOBase):
    """Hash bytes consumed by a plain or Zstandard rollout reader."""

    def __init__(self, raw: Any, digest: Any) -> None:
        super().__init__()
        self.raw = raw
        self.digest = digest

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        data = self.raw.read(len(buffer))
        if not data:
            return 0
        self.digest.update(data)
        buffer[: len(data)] = data
        return len(data)

    def read(self, size: int = -1) -> bytes:
        data = self.raw.read(size)
        if not data:
            return b""
        self.digest.update(data)
        return data

    def seekable(self) -> bool:
        return False

    def close(self) -> None:
        if not self.closed:
            try:
                self.raw.close()
            finally:
                super().close()


def _rollout_identity_from_name(path: Path) -> str:
    match = re.search(
        r"(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
        path.name,
    )
    if match:
        return match.group(1)
    name = path.name
    for suffix in (".jsonl.zst", ".jsonl"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _rollout_message_from_event(payload: Any) -> tuple[str, str, str]:
    """Extract only supported user and assistant event message shapes."""
    if not isinstance(payload, dict) or payload.get("type") != "item_completed":
        return "", "", "unsupported"
    item = payload.get("item")
    if not isinstance(item, dict):
        return "", "", "malformed"
    item_type = item.get("type")
    if item_type == "UserMessage":
        role, block_type = "user", "text"
    elif item_type == "AgentMessage":
        role, block_type = "assistant", "Text"
    else:
        return "", "", "unsupported"
    content = item.get("content")
    if not isinstance(content, list):
        return "", "", "malformed"
    chunks = [
        block.get("text")
        for block in content
        if (
            isinstance(block, dict)
            and block.get("type") == block_type
            and isinstance(block.get("text"), str)
        )
    ]
    text = "\n".join(chunks).strip()
    if not text:
        return "", "", "empty"
    return role, text, "ok"


def _open_rollout_stream(path: Path, digest: Any) -> tuple[Any, Any]:
    raw = path.open("rb")
    hashing = _HashingReader(raw, digest)
    if path.suffix == ".zst":
        if _compression_zstd is None:
            hashing.close()
            raise RuntimeError("zstd_unavailable")
        try:
            stream = _compression_zstd.ZstdFile(hashing, "rb")
        except Exception:
            hashing.close()
            raise
        return raw, stream
    return raw, io.BufferedReader(hashing)


def _extract_codex_rollouts(
    codex_root: Path,
    home: Path,
    body_writer: BodyWriter,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Stream Codex rollout JSONL and Zstandard files into the body artifact."""
    sessions_root = codex_root / "sessions"
    if not sessions_root.exists():
        return [], {
            "path": display_path(sessions_root, home),
            "source": "codex.rollout",
            "state": "blocked",
            "error": "missing",
            "files": 0,
        }
    stats = Counter()
    records: list[dict[str, Any]] = []
    file_evidence: list[dict[str, Any]] = []
    messages_before = body_writer.message_count
    try:
        candidates = [
            path
            for path in _safe_files(sessions_root, stats, MAX_ROLLOUT_FILES)
            if path.name.endswith((".jsonl", ".jsonl.zst"))
        ]
    except (OSError, ValueError) as exc:
        return [], {
            "path": display_path(sessions_root, home),
            "source": "codex.rollout",
            "state": "blocked",
            "error": type(exc).__name__,
            "files": 0,
        }

    for path in candidates:
        stats["files"] += 1
        identity = _rollout_identity_from_name(path)
        rid = record_id("codex.rollout", identity)
        digest = hashlib.sha256()
        record = make_record(
            "codex.rollout",
            identity,
            path,
            home,
            None,
            retrieval_state="partial",
            transcript_available=False,
            details={
                "metadata_kind": "codex_rollout",
                "rollout_file": path.name,
                "rollout_format": "zstd_jsonl" if path.suffix == ".zst" else "jsonl",
                "identity_source": "filename",
                "session_id": identity,
                "thread_id": identity,
                "user_count": 0,
                "assistant_count": 0,
                "item_count": 0,
                "chat_item_count": 0,
                "malformed_count": 0,
                "empty_count": 0,
                "unsupported_count": 0,
                "unsupported_event_count": 0,
                "session_meta_state": "missing",
                "metadata_state": "missing",
                "source_hash_state": "partial",
                "snapshot_consistency": "single_file_stream",
            },
        )
        line_count = 0
        decoded_bytes = 0
        malformed = 0
        empty = 0
        unsupported = 0
        unsupported_events = Counter()
        decode_error: str | None = None
        line_limit_reached = False
        decoded_limit_reached = False
        raw: Any = None
        stream: Any = None
        stream_completed = False
        try:
            raw, stream = _open_rollout_stream(path, digest)
            while True:
                line = stream.readline(MAX_ROLLOUT_LINE_BYTES + 1)
                if not line:
                    stream_completed = True
                    break
                line_count += 1
                stats["decoded_lines"] += 1
                decoded_bytes += len(line)
                stats["decoded_bytes"] += len(line)
                if line_count > MAX_ROLLOUT_LINES:
                    line_limit_reached = True
                    continue
                if len(line) > MAX_ROLLOUT_LINE_BYTES:
                    malformed += 1
                    stats["oversized_lines"] += 1
                    while line and not line.endswith(b"\n"):
                        line = stream.readline(MAX_ROLLOUT_LINE_BYTES + 1)
                        decoded_bytes += len(line)
                        stats["decoded_bytes"] += len(line)
                    continue
                if decoded_bytes > MAX_ROLLOUT_DECODED_BYTES:
                    decoded_limit_reached = True
                    continue
                try:
                    envelope = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    malformed += 1
                    stats["malformed_lines"] += 1
                    continue
                if not isinstance(envelope, dict):
                    malformed += 1
                    stats["malformed_lines"] += 1
                    continue
                event_type = envelope.get("type")
                payload = envelope.get("payload")
                if event_type == "session_meta":
                    if not isinstance(payload, dict):
                        malformed += 1
                        continue
                    meta_id = payload.get("id") or payload.get("session_id")
                    if meta_id:
                        meta_identity = str(meta_id)
                        record["details"]["session_meta_state"] = "verified"
                        record["details"]["metadata_state"] = "verified"
                        record["details"]["identity_source"] = "session_meta"
                        record["details"]["session_meta_id"] = meta_identity
                        if meta_identity != identity:
                            record["details"]["identity_mismatch"] = True
                            stats["identity_mismatches"] += 1
                        record["title"] = redact_text(
                            payload.get("originator") or payload.get("source"),
                            home,
                        )
                        record["timestamp"] = redact_text(
                            payload.get("timestamp"), home
                        )
                    continue
                if event_type != "event_msg":
                    unsupported_events[str(event_type)] += 1
                    stats["unsupported_events"] += 1
                    continue
                if not isinstance(payload, dict):
                    malformed += 1
                    continue
                record["details"]["item_count"] += 1
                role, message_text, status = _rollout_message_from_event(payload)
                if status == "unsupported":
                    unsupported += 1
                    item = payload.get("item")
                    item_type = (
                        item.get("type")
                        if isinstance(item, dict)
                        else "missing"
                    )
                    unsupported_events[f"item_completed:{item_type}"] += 1
                    continue
                record["details"]["chat_item_count"] += 1
                if status == "malformed":
                    malformed += 1
                    continue
                if status == "empty":
                    empty += 1
                    continue
                item = payload["item"]
                ordinal = envelope.get("ordinal", line_count)
                timestamp = (
                    payload.get("started_at_ms")
                    or payload.get("completed_at_ms")
                    or envelope.get("timestamp")
                )
                body_writer.add(
                    rid,
                    {
                        "role": role,
                        "text": message_text,
                        "item_id": item.get("id") or f"line-{line_count}",
                        "ordinal": ordinal,
                        "timestamp": timestamp,
                        "source": "codex.rollout",
                        "snapshot_sha256": None,
                    },
                )
                record["details"][f"{role}_count"] += 1
        except Exception as exc:
            decode_error = type(exc).__name__
            stats["decode_errors"] += 1
        finally:
            for handle in (stream, raw):
                if handle is None:
                    continue
                try:
                    handle.close()
                except (OSError, ValueError, RuntimeError):
                    if decode_error is None:
                        decode_error = "close_error"

        source_hash = digest.hexdigest()
        record["source_sha256"] = source_hash
        body_writer.bind_snapshot(rid, "codex.rollout", source_hash)
        body_count = body_writer.record_message_count(rid)
        detail = record["details"]
        detail.update(
            {
                "malformed_count": malformed,
                "empty_count": empty,
                "unsupported_count": unsupported,
                "unsupported_event_count": sum(unsupported_events.values()),
                "line_count": line_count,
                "decoded_bytes": decoded_bytes,
                "line_limit_reached": line_limit_reached,
                "decoded_limit_reached": decoded_limit_reached,
                "decode_error": decode_error,
                "source_hash_state": "verified" if stream_completed else "partial",
                "body_message_count": body_count,
                "rejected_message_count": body_writer.rejected_by_record[rid],
                "truncated_message_count": body_writer.truncated_by_record[rid],
                "ordinal_conflict_count": body_writer.ordinal_conflicts_by_record[rid],
            }
        )
        if unsupported_events:
            detail["unsupported_event_types"] = dict(
                sorted(unsupported_events.items())
            )
        record["transcript_available"] = bool(body_count)
        if (
            body_count
            and detail.get("metadata_state") == "verified"
            and not _has_incomplete_evidence(detail)
        ):
            record["retrieval_state"] = "verified"
        records.append(record)
        file_state = (
            "verified"
            if stream_completed
            and not malformed
            and not line_limit_reached
            and not decoded_limit_reached
            and decode_error is None
            and not detail["unsupported_event_count"]
            else "partial"
        )
        file_evidence.append(
            {
                "source_path": display_path(path, home),
                "source_sha256": source_hash,
                "state": file_state,
                "metadata_kind": "codex_rollout",
                "line_count": line_count,
                "decoded_bytes": decoded_bytes,
                "malformed_count": malformed,
                "empty_count": empty,
                "unsupported_count": unsupported,
                "unsupported_event_count": detail["unsupported_event_count"],
                "decode_error": decode_error,
                "line_limit_reached": line_limit_reached,
                "decoded_limit_reached": decoded_limit_reached,
                "transcript_available": bool(body_count),
            }
        )

    source_state = "verified"
    if (
        not candidates
        or stats["unsafe_paths_skipped"]
        or stats["file_limit_reached"]
        or any(item["state"] != "verified" for item in file_evidence)
    ):
        source_state = "partial"
    return records, {
        "path": display_path(sessions_root, home),
        "source": "codex.rollout",
        "state": source_state,
        "files": len(candidates),
        "file_evidence": file_evidence,
        "decoded_lines": stats["decoded_lines"],
        "decoded_bytes": stats["decoded_bytes"],
        "malformed_lines": stats["malformed_lines"],
        "oversized_lines": stats["oversized_lines"],
        "unsupported_events": stats["unsupported_events"],
        "decode_errors": stats["decode_errors"],
        "identity_mismatches": stats["identity_mismatches"],
        "unsafe_paths_skipped": stats["unsafe_paths_skipped"],
        "file_limit_reached": bool(stats["file_limit_reached"]),
        "snapshot_consistency": "single_file_streams",
        "body_messages_added": body_writer.message_count - messages_before,
        "transcript_available": body_writer.message_count > messages_before,
    }

def _decode_varint(data: bytes, pos: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while pos < len(data):
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7
        if shift > 70:
            raise ValueError("varint_overflow")
    raise ValueError("truncated_varint")


def _parse_wire(data: bytes) -> dict[int, list[bytes | int]]:
    fields: dict[int, list[bytes | int]] = defaultdict(list)
    pos = 0
    while pos < len(data):
        tag, pos = _decode_varint(data, pos)
        field_number = tag >> 3
        wire_type = tag & 7
        if field_number <= 0:
            raise ValueError("invalid_field")
        if wire_type == 0:
            value, pos = _decode_varint(data, pos)
            fields[field_number].append(value)
        elif wire_type == 2:
            length, pos = _decode_varint(data, pos)
            end = pos + length
            if end > len(data):
                raise ValueError("truncated_bytes")
            fields[field_number].append(data[pos:end])
            pos = end
        elif wire_type == 1:
            end = pos + 8
            if end > len(data):
                raise ValueError("truncated_fixed64")
            fields[field_number].append(data[pos:end])
            pos = end
        elif wire_type == 5:
            end = pos + 4
            if end > len(data):
                raise ValueError("truncated_fixed32")
            fields[field_number].append(data[pos:end])
            pos = end
        else:
            raise ValueError("unsupported_wire")
    return fields


def _first_bytes(fields: dict[int, list[bytes | int]], number: int) -> bytes | None:
    for value in fields.get(number, []):
        if isinstance(value, bytes):
            return value
    return None


def _first_string(fields: dict[int, list[bytes | int]], number: int) -> str:
    value = _first_bytes(fields, number)
    if value is None:
        return ""
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        return ""


def _parse_agy_step(step_type: Any, payload: Any) -> tuple[str, str] | None:
    try:
        kind = int(step_type)
        data = bytes(payload or b"")
        outer = _parse_wire(data)
        if kind == 14:
            nested = _first_bytes(outer, 19)
            if nested is None:
                return ("", "")
            return ("user", _first_string(_parse_wire(nested), 2))
        if kind == 15:
            nested = _first_bytes(outer, 20)
            if nested is None:
                return ("", "")
            return ("assistant", _first_string(_parse_wire(nested), 3))
    except (TypeError, ValueError):
        return ("", "")
    return None


def _summary_map(summary_path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    if not summary_path.exists():
        return {}, {"state": "missing", "sha256": None, "records": 0}
    digest = None
    try:
        with _sqlite_snapshot(summary_path) as (connection, digest):
            columns = (
                "conversation_id", "title", "preview", "step_count",
                "last_modified_time", "workspace_uris", "status", "source",
                "project_id", "agent_name", "parent_conversation_id",
            )
            rows = connection.execute(
                "SELECT conversation_id,title,preview,step_count,last_modified_time,"
                "workspace_uris,status,source,project_id,agent_name,parent_conversation_id "
                "FROM conversation_summaries"
            ).fetchall()
            result = {
                str(row[0]): dict(zip(columns, row))
                for row in rows
            }
            return result, {"state": "verified", "sha256": digest, "records": len(result)}
    except (OSError, sqlite3.Error, ValueError) as exc:
        return {}, {"state": "blocked", "sha256": digest, "records": 0, "error": type(exc).__name__}


def _extract_agy_surface(root: Path, source: str, home: Path, body_writer: BodyWriter) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    summary_path = root / "conversation_summaries.db"
    summaries, summary_info = _summary_map(summary_path)
    conversations_root = root / "conversations"
    records: dict[str, dict[str, Any]] = {}
    stats = Counter()
    messages_before = body_writer.message_count
    try:
        db_paths = (
            [path for path in _safe_files(conversations_root, stats, MAX_AGY_FILES_PER_SURFACE)
             if path.parent == conversations_root and path.suffix == ".db"]
            if conversations_root.exists() else []
        )
        seen_conversation_ids: set[str] = set()
        for db_path in db_paths:
            conversation_id = db_path.stem
            seen_conversation_ids.add(conversation_id)
            summary = summaries.get(conversation_id, {})
            rid = record_id(source, conversation_id)
            record = make_record(
                source,
                conversation_id,
                db_path,
                home,
                None,
                title=summary.get("title"),
                preview=summary.get("preview"),
                timestamp=summary.get("last_modified_time"),
                retrieval_state="partial",
                transcript_available=False,
                details={
                    "metadata_kind": "agy_trajectory",
                    "conversation_id": conversation_id,
                    "surface": source,
                    "step_count_summary": summary.get("step_count"),
                    "user_count": 0,
                    "assistant_count": 0,
                    "step_count": 0,
                    "malformed_count": 0,
                    "unsupported_count": 0,
                    "summary_sha256": summary_info.get("sha256"),
                    "summary_state": summary_info["state"],
                },
            )
            try:
                with _sqlite_snapshot(db_path) as (connection, digest):
                    record["source_sha256"] = digest
                    rows = connection.execute(
                        "SELECT idx, step_type, step_payload FROM steps ORDER BY idx ASC"
                    ).fetchall()
            except (OSError, sqlite3.Error, ValueError) as exc:
                stats["blocked_databases"] += 1
                record["retrieval_state"] = "blocked"
                record["details"]["error"] = type(exc).__name__
                records[rid] = record
                continue
            for idx, step_type, payload in rows:
                stats["steps"] += 1
                record["details"]["step_count"] += 1
                parsed = _parse_agy_step(step_type, payload)
                if parsed is None:
                    record["details"]["unsupported_count"] += 1
                    continue
                role, text = parsed
                if not role or not text:
                    record["details"]["malformed_count"] += 1
                    stats["malformed_steps"] += 1
                    continue
                record["details"][f"{role}_count"] += 1
                body_writer.add(
                    rid,
                    {
                        "role": role,
                        "text": text,
                        "idx": idx,
                        "ordinal": idx,
                        "source": source,
                        "snapshot_sha256": record["source_sha256"],
                    },
                )
            record["transcript_available"] = bool(body_writer.record_message_count(rid))
            record["details"]["body_message_count"] = body_writer.record_message_count(rid)
            record["details"]["rejected_message_count"] = body_writer.rejected_by_record[rid]
            record["details"]["truncated_message_count"] = body_writer.truncated_by_record[rid]
            record["details"]["ordinal_conflict_count"] = (
                body_writer.ordinal_conflicts_by_record[rid]
            )
            if record["details"]["ordinal_conflict_count"]:
                record["details"]["ordinal_conflict_evidence"] = (
                    body_writer.ordinal_conflict_evidence[rid]
                )
            expected = summary.get("step_count")
            count_matches = expected is None or expected == record["details"]["step_count"]
            record["details"]["summary_step_count_matches"] = count_matches
            if (
                record["transcript_available"]
                and summary_info["state"] == "verified"
                and count_matches
                and not _has_incomplete_evidence(record["details"])
            ):
                record["retrieval_state"] = "verified"
            records[rid] = record
            stats["databases"] += 1
        # A summary row is still a real metadata record even if its trajectory
        # database is missing or was not readable. Keep it partial and explicit.
        for conversation_id, summary in summaries.items():
            if conversation_id in seen_conversation_ids:
                continue
            rid = record_id(source, conversation_id)
            records[rid] = make_record(
                source,
                conversation_id,
                summary_path,
                home,
                summary_info.get("sha256"),
                title=summary.get("title"),
                preview=summary.get("preview"),
                timestamp=summary.get("last_modified_time"),
                retrieval_state="partial",
                transcript_available=False,
                details={
                    "metadata_kind": "agy_summary_only",
                    "conversation_id": conversation_id,
                    "surface": source,
                    "summary_sha256": summary_info.get("sha256"),
                    "summary_state": summary_info["state"],
                    "step_count_summary": summary.get("step_count"),
                    "user_count": 0,
                    "assistant_count": 0,
                    "step_count": 0,
                    "malformed_count": 0,
                    "missing_trajectory": True,
                },
            )
            stats["summary_only"] += 1
    except (OSError, ValueError) as exc:
        return [], {"path": display_path(root, home), "state": "blocked", "error": type(exc).__name__}
    state = "verified" if (
        summary_info["state"] == "verified" and
        all(record["retrieval_state"] == "verified" for record in records.values()) and
        not stats["unsafe_paths_skipped"] and not stats["file_limit_reached"]
    ) else "partial"
    return list(records.values()), {
        "path": display_path(root, home),
        "state": state,
        "summary_records": len(summaries),
        "trajectory_databases": stats["databases"],
        "steps": stats["steps"],
        "malformed_steps": stats["malformed_steps"],
        "blocked_databases": stats["blocked_databases"],
        "summary_only": stats["summary_only"],
        "summary": summary_info,
        "unsafe_paths_skipped": stats["unsafe_paths_skipped"],
        "file_limit_reached": bool(stats["file_limit_reached"]),
        "snapshot_consistency": "per_database_not_cross_database",
        "body_messages_added": body_writer.message_count - messages_before,
        "transcript_available": body_writer.message_count > messages_before,
    }


def parse_jsonl(path: Path, source: str, home: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    records: list[dict[str, Any]] = []
    malformed = 0
    try:
        snapshot, digest, snapshot_truncated = read_jsonl_snapshot(path)
        line_limit_reached = False
        text = snapshot.decode("utf-8", errors="replace")
        for line_number, raw in enumerate(text.splitlines(), 1):
            if line_number > MAX_JSONL_LINES:
                line_limit_reached = True
                break
            line = raw.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                malformed += 1
                continue
            if not isinstance(payload, dict):
                malformed += 1
                continue
            identity = (
                payload.get("id")
                or payload.get("session_id")
                or payload.get("sessionId")
                or payload.get("conversation_id")
                or payload.get("conversationId")
                or payload.get("thread_id")
                or payload.get("threadId")
                or f"line-{line_number}"
            )
            records.append(
                make_record(
                    source,
                    str(identity),
                    path,
                    home,
                    digest,
                    title=payload.get("title") or payload.get("thread_name") or payload.get("name"),
                    preview=payload.get("first_message") or payload.get("preview") or payload.get("latest_message_preview"),
                    timestamp=payload.get("ts") or payload.get("updated_at") or payload.get("created_at"),
                    details={
                        "metadata_kind": "jsonl",
                        "line_number": line_number,
                        "snapshot_consistency": "single_read_snapshot",
                        "snapshot_truncated": snapshot_truncated,
                        "line_limit_reached": line_limit_reached,
                    },
                )
            )
    except (OSError, UnicodeError) as exc:
        return [], {"path": display_path(path, home), "state": "blocked", "error": type(exc).__name__}
    return records, {
        "path": display_path(path, home),
        "sha256": digest,
        "state": "partial",
        "parsed_records": len(records),
        "malformed_records": malformed,
        "transcript_available": False,
        "snapshot_consistency": "single_read_snapshot",
        "snapshot_bytes": len(snapshot),
        "snapshot_truncated": snapshot_truncated,
        "line_limit_reached": line_limit_reached,
    }


def sqlite_summary(path: Path, source: str, home: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    try:
        digest = sha256_file(path)
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
        try:
            tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            counts: dict[str, int] = {}
            for table in tables:
                quoted = str(table).replace('"', '""')
                try:
                    counts[str(table)] = int(connection.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0])
                except sqlite3.DatabaseError:
                    counts[str(table)] = -1
        finally:
            connection.close()
    except (OSError, sqlite3.Error) as exc:
        return [], {"path": display_path(path, home), "state": "blocked", "error": type(exc).__name__}
    transcript_rows = sum(
        value
        for key, value in counts.items()
        if value >= 0 and any(word in key.lower() for word in ("message", "transcript", "step", "trajectory"))
    )
    # Table names and row counts prove only that a transcript-shaped table is
    # present. They do not prove that message bodies were read or recovered.
    state = "partial"
    record = make_record(
        source,
        path.name,
        path,
        home,
        digest,
        title=path.name,
        preview="SQLite schema/count inventory; raw transcript bodies remain external.",
        retrieval_state=state,
        transcript_available=False,
        details={"metadata_kind": "sqlite_schema", "tables": tables, "table_counts": counts, "transcript_rows_observed": transcript_rows},
    )
    return [record], {
        "path": display_path(path, home),
        "sha256": digest,
        "state": state,
        "tables": tables,
        "table_counts": counts,
        "transcript_rows_observed": transcript_rows,
        "transcript_available": False,
    }


def inventory_surface(root: Path, source: str, home: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not root.exists():
        return [], {"path": display_path(root, home), "state": "blocked", "error": "missing"}
    stats: Counter[str] = Counter()
    file_count = 0
    total_bytes = 0
    try:
        for path in _safe_files(root, stats, MAX_AGY_FILES_PER_SURFACE):
            file_count += 1
            try:
                total_bytes += path.stat().st_size
            except OSError:
                pass
    except OSError as exc:
        return [], {"path": display_path(root, home), "state": "blocked", "error": type(exc).__name__}
    record = make_record(
        source,
        str(root),
        root,
        home,
        None,
        title=source,
        preview="Surface inventory only; full AGY transcript retrieval is not proven by filesystem presence.",
        retrieval_state="partial",
        transcript_available=False,
        details={
            "metadata_kind": "filesystem_inventory",
            "file_count": file_count,
            "total_bytes": total_bytes,
            "unsafe_paths_skipped": stats["unsafe_paths_skipped"],
            "file_limit_reached": bool(stats["file_limit_reached"]),
        },
    )
    return [record], {
        "path": display_path(root, home),
        "state": "partial",
        "file_count": file_count,
        "total_bytes": total_bytes,
        "unsafe_paths_skipped": stats["unsafe_paths_skipped"],
        "file_limit_reached": bool(stats["file_limit_reached"]),
        "transcript_available": False,
    }


def _has_agy_storage(root: Path) -> bool:
    """Select extraction from parser-supported AGY storage paths.

    Surface names are deployment details and can change as desktop, CLI, and
    development profiles evolve. A root is schema-aware when it exposes the
    summary database or direct conversation databases that this importer can
    parse. Marker-only roots remain inventory-only.
    """
    return (
        (root / "conversation_summaries.db").exists()
        or (root / "conversations").exists()
    )


def default_out_dir() -> Path:
    override = os.environ.get("OMNIA_HISTORY_DIR")
    if override:
        return Path(override)
    external = Path("D:/OmniaData")
    return external / "history" / "omnia" if external.exists() else Path.home() / ".omnia-history"


def discover(
    home: Path,
    codex_root: Path,
    gemini_root: Path,
    body_writer: BodyWriter | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    records_by_id: dict[str, dict[str, Any]] = {}
    sources: list[dict[str, Any]] = []
    source_records: list[list[str]] = []
    writer = body_writer or BodyWriter(None, home)
    for filename, source in (
        ("session_index.jsonl", "codex.session_index"),
        ("history.jsonl", "codex.history"),
    ):
        path = codex_root / filename
        if path.exists():
            items, info = parse_jsonl(path, source, home)
            for item in items:
                _upsert_record(records_by_id, item)
            info["source"] = source
            sources.append(info)
            source_records.append([str(item["record_id"]) for item in items])
        else:
            sources.append({"path": display_path(path, home), "state": "blocked", "error": "missing"})
            source_records.append([])
    sqlite_path = codex_root / "thread_history_1.sqlite"
    if sqlite_path.exists():
        items, info = _extract_codex(codex_root, home, writer)
        for item in items:
            _upsert_record(records_by_id, item)
        info["source"] = "codex.thread"
        sources.append(info)
        source_records.append([str(item["record_id"]) for item in items])
    else:
        sources.append({"path": display_path(sqlite_path, home), "state": "blocked", "error": "missing"})
        source_records.append([])
    rollout_items, rollout_info = _extract_codex_rollouts(codex_root, home, writer)
    for item in rollout_items:
        _upsert_record(records_by_id, item)
    rollout_info["source"] = "codex.rollout"
    sources.append(rollout_info)
    source_records.append([str(item["record_id"]) for item in rollout_items])
    for name in ("history", "antigravity", "antigravity-cli", "antigravity-dev", "antigravity-ide"):
        root = gemini_root / name
        if _has_agy_storage(root):
            items, info = _extract_agy_surface(root, f"agy.{name}", home, writer)
        else:
            items, info = inventory_surface(root, f"agy.{name}", home)
        for item in items:
            _upsert_record(records_by_id, item)
        info["source"] = f"agy.{name}"
        sources.append(info)
        source_records.append([str(item["record_id"]) for item in items])
    if body_writer is not None:
        body_artifact = writer.close()
        body_index = writer.write_index()
        if body_index is not None:
            body_artifact["index"] = body_index
        _finalize_record_details(records_by_id.values(), writer)
        for info, identities in zip(sources, source_records):
            if info.get("state") == "verified" and any(
                records_by_id[identity]["retrieval_state"] != "verified"
                for identity in identities
            ):
                info["state"] = "partial"
        return list(records_by_id.values()), sources, body_artifact
    return list(records_by_id.values()), sources, writer.stats()


def _finalize_record_details(
    records: Iterator[dict[str, Any]], writer: BodyWriter
) -> None:
    """Attach post-close body/index evidence before manifest counts are built."""
    for item in records:
        record_id_value = str(item.get("record_id", ""))
        details = _merge_details({}, item.get("details", {}))
        item["details"] = details
        body_count = writer.record_message_count(record_id_value)
        item["transcript_available"] = bool(body_count)
        details["body_message_count"] = body_count
        details["rejected_message_count"] = writer.rejected_by_record[record_id_value]
        details["truncated_message_count"] = writer.truncated_by_record[record_id_value]
        conflicts = writer.ordinal_conflicts_by_record[record_id_value]
        details["ordinal_conflict_count"] = conflicts
        if conflicts:
            details["ordinal_conflict_evidence"] = writer.ordinal_conflict_evidence[
                record_id_value
            ]

        # Extraction routines may only know that a body was staged until the
        # writer closes and computes conflict evidence. Elevate only records
        # whose source metadata/summary was itself verified.
        metadata_verified = details.get("metadata_state") == "verified"
        summary_verified = (
            details.get("summary_state") == "verified"
            and details.get("summary_step_count_matches") is not False
        )
        if (
            body_count
            and (metadata_verified or summary_verified)
            and not _has_incomplete_evidence(details)
        ):
            item["retrieval_state"] = "verified"
        else:
            item["retrieval_state"] = _merged_retrieval_state(
                item.get("retrieval_state"),
                item.get("retrieval_state"),
                details,
            )


def build_manifest(
    home: Path,
    codex_root: Path,
    gemini_root: Path,
    *,
    body_path: Path | None = None,
) -> dict[str, Any]:
    writer = BodyWriter(body_path, home)
    try:
        records, sources, body_artifact = discover(home, codex_root, gemini_root, writer)
    except BaseException:
        writer.abort()
        raise
    states = Counter(record["retrieval_state"] for record in records)
    return {
        "schema": "omnia.history-manifest.v2",
        "generated_at": utc_now(),
        "source_roots": {
            "codex": display_path(codex_root, home),
            "gemini": display_path(gemini_root, home),
        },
        "records": records,
        "body_artifact": body_artifact,
        "counts": {
            "records": len(records),
            "verified": states.get("verified", 0),
            "partial": states.get("partial", 0),
            "blocked": states.get("blocked", 0),
            "transcript_available": sum(bool(record["transcript_available"]) for record in records),
        },
        "sources": sources,
        "completion": {
            "verified": [
                "source hashes and redaction state are recorded",
                "metadata JSONL and SQLite bodies were read in read-only mode when accessible",
            ],
            "partial": [
                "Codex and AGY sources can remain partial when a live snapshot is incomplete or malformed",
            ],
            "blocked": [
                source["path"] for source in sources if source.get("state") == "blocked"
            ],
            "next": [
                "rerun this importer after each source snapshot changes",
            ],
        },
    }


def _stage_bytes(path: Path, payload: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        raise
    return temp_path

def write_atomic_bytes(path: Path, payload: bytes) -> None:
    staging = _stage_bytes(path, payload)
    try:
        os.replace(staging, path)
        _fsync_directory(path.parent)
    finally:
        try:
            staging.unlink()
        except FileNotFoundError:
            pass


def write_atomic(path: Path, payload: dict[str, Any]) -> None:
    write_atomic_bytes(path, canonical_json_bytes(payload))


def _restore_file_bytes(path: Path, previous: bytes | None) -> None:
    if previous is None:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return
    write_atomic_bytes(path, previous)

def _publish_immutable_json(
    out_dir: Path,
    prefix: str,
    payload: dict[str, Any],
) -> tuple[Path, str]:
    """Persist one content-addressed JSON generation.

    The returned digest is the hash of the exact UTF-8 bytes written to disk.
    Existing files are accepted only when their bytes match that digest.
    """
    out_dir = checked_path(out_dir, external=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload_bytes = canonical_json_bytes(payload)
    payload_hash = sha256_bytes(payload_bytes)
    destination = checked_path(
        out_dir / f"{prefix}.{payload_hash}.json",
        external=True,
    )
    if destination.exists():
        if not destination.is_file() or sha256_file(destination) != payload_hash:
            raise ValueError("generation_collision")
        return destination, payload_hash
    staging = _stage_bytes(destination, payload_bytes)
    try:
        try:
            os.replace(staging, destination)
        except FileExistsError:
            if not destination.is_file() or sha256_file(destination) != payload_hash:
                raise ValueError("generation_collision")
        _fsync_directory(destination.parent)
    finally:
        try:
            staging.unlink()
        except FileNotFoundError:
            pass
    return destination, payload_hash

@contextmanager
def _history_output_lock(out_dir: Path) -> Iterator[None]:
    """Hold an OS lock on one stable inode for the whole publication window."""
    out_dir = checked_path(out_dir, external=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    lock_path = checked_path(out_dir / "history-import.lock", external=True)
    # ``O_CREAT`` without replacement keeps the lock inode stable across
    # publisher crashes.  The byte lock is released by the operating system
    # when the descriptor is closed or the process exits.
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    acquired = False
    try:
        if os.fstat(fd).st_size == 0:
            os.write(fd, b"\0")
            os.fsync(fd)
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            if os.name == "nt":
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except (BlockingIOError, OSError) as exc:
            if os.name == "nt":
                if not isinstance(exc, PermissionError) and getattr(
                    exc, "winerror", None
                ) not in {32, 33, 36, 1224}:
                    raise
            elif getattr(exc, "errno", None) not in {11, 13, 35}:
                raise
            raise RuntimeError("history_import_in_progress") from exc
        if acquired:
            yield
    finally:
        if acquired:
            try:
                if os.name == "nt":
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
        os.close(fd)

def _active_pointer_payload(
    manifest_name: str,
    manifest_hash: str,
    receipt_name: str,
    receipt_hash: str,
    receipt: dict[str, Any],
) -> dict[str, Any]:
    """Build the small, atomic pointer consumed by readers."""
    if not re.fullmatch(r"[0-9a-f]{64}", manifest_hash):
        raise ValueError("active_pointer_manifest_hash_invalid")
    if not re.fullmatch(r"[0-9a-f]{64}", receipt_hash):
        raise ValueError("active_pointer_receipt_hash_invalid")
    if manifest_name != f"history-manifest.{manifest_hash}.json" or (
        receipt_name != f"history-receipt.{receipt_hash}.json"
    ):
        raise ValueError("active_pointer_path_invalid")
    generation = receipt.get("generation")
    if not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f]{64}", generation):
        raise ValueError("active_pointer_generation_invalid")
    return {
        "schema": "omnia.history-active.v1",
        "manifest": {
            "path": manifest_name,
            "sha256": manifest_hash,
        },
        "receipt": {
            "path": receipt_name,
            "sha256": receipt_hash,
        },
        "generation": generation,
    }

def _read_bounded_bytes(path: Path, limit: int, error: str) -> bytes:
    with path.open("rb") as handle:
        payload = handle.read(limit + 1)
    if len(payload) > limit:
        raise ValueError(error)
    return payload

def _receipt_path_basename(value: str) -> str:
    """Return a receipt path's basename for either slash convention."""
    separator = max(value.rfind("/"), value.rfind("\\"))
    return value[separator + 1:]

def _receipt_path_matches(
    receipt: dict[str, Any],
    key: str,
    expected: str,
    *aliases: str,
) -> bool:
    """Validate a descriptive receipt path without resolving it on disk."""
    value = receipt.get(key)
    if value is None:
        return True
    if not isinstance(value, str):
        return False
    basename = _receipt_path_basename(value)
    return bool(basename) and basename in {expected, *aliases}

def _read_generation_from_pointer(
    out_dir: Path,
    pointer_path: Path,
    *,
    pointer_bytes: bytes | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Read and verify one pointer-selected immutable generation.

    The caller decides whether this is the current pointer or the previous
    last-known-good pointer. This function never consults aliases or another
    pointer while validating the selected generation.
    """
    out_dir = checked_path(out_dir, external=True)
    pointer_path = checked_path(pointer_path, external=True)
    if not pointer_path.is_file():
        raise FileNotFoundError(pointer_path)
    if pointer_bytes is None:
        pointer_bytes = _read_bounded_bytes(
            pointer_path, MAX_ACTIVE_POINTER_BYTES, "active_pointer_too_large"
        )
    elif len(pointer_bytes) > MAX_ACTIVE_POINTER_BYTES:
        raise ValueError("active_pointer_too_large")
    pointer = json.loads(pointer_bytes.decode("utf-8"))
    if not isinstance(pointer, dict) or pointer.get("schema") != "omnia.history-active.v1":
        raise ValueError("active_pointer_invalid_schema")
    generation = pointer.get("generation")
    if not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f]{64}", generation):
        raise ValueError("active_pointer_generation_invalid")
    manifest_info = pointer.get("manifest")
    receipt_info = pointer.get("receipt")
    if not isinstance(manifest_info, dict) or not isinstance(receipt_info, dict):
        raise ValueError("active_pointer_invalid_targets")
    manifest_name = manifest_info.get("path")
    receipt_name = receipt_info.get("path")
    manifest_hash = manifest_info.get("sha256")
    receipt_hash = receipt_info.get("sha256")
    if (
        not isinstance(manifest_name, str)
        or Path(manifest_name).name != manifest_name
        or not isinstance(receipt_name, str)
        or Path(receipt_name).name != receipt_name
        or not re.fullmatch(r"history-manifest\.[0-9a-f]{64}\.json", manifest_name)
        or not re.fullmatch(r"history-receipt\.[0-9a-f]{64}\.json", receipt_name)
        or not isinstance(manifest_hash, str)
        or not re.fullmatch(r"[0-9a-f]{64}", manifest_hash)
        or not isinstance(receipt_hash, str)
        or not re.fullmatch(r"[0-9a-f]{64}", receipt_hash)
        or manifest_name != f"history-manifest.{manifest_hash}.json"
        or receipt_name != f"history-receipt.{receipt_hash}.json"
    ):
        raise ValueError("active_pointer_invalid_targets")
    manifest_path = checked_path(out_dir / manifest_name, external=True)
    receipt_path = checked_path(out_dir / receipt_name, external=True)
    manifest_bytes = _read_bounded_bytes(
        manifest_path, MAX_MANIFEST_BYTES, "active_manifest_too_large"
    )
    receipt_bytes = _read_bounded_bytes(
        receipt_path, MAX_RECEIPT_BYTES, "active_receipt_too_large"
    )
    if sha256_bytes(manifest_bytes) != manifest_hash:
        raise ValueError("active_manifest_hash_mismatch")
    if sha256_bytes(receipt_bytes) != receipt_hash:
        raise ValueError("active_receipt_hash_mismatch")
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    receipt = json.loads(receipt_bytes.decode("utf-8"))
    if not isinstance(manifest, dict) or not isinstance(receipt, dict):
        raise ValueError("active_generation_invalid_json")
    if manifest.get("schema") != "omnia.history-manifest.v2":
        raise ValueError("active_manifest_invalid_schema")
    if receipt.get("schema") != "omnia.history-import-receipt.v1":
        raise ValueError("active_receipt_invalid_schema")
    if receipt.get("manifest_sha256") != manifest_hash:
        raise ValueError("active_receipt_manifest_mismatch")
    if generation != receipt.get("generation"):
        raise ValueError("active_generation_mismatch")
    if not re.fullmatch(r"[0-9a-f]{64}", generation):
        raise ValueError("active_body_generation_invalid")
    artifact = manifest.get("body_artifact")
    if (
        not isinstance(artifact, dict)
        or artifact.get("sha256") != generation
        or artifact.get("generation") != generation
    ):
        raise ValueError("active_body_generation_mismatch")
    body_value = artifact.get("path")
    if not isinstance(body_value, str):
        raise ValueError("active_body_path_invalid")
    body_path = checked_path(Path(body_value), external=True)
    expected_body_path = checked_path(
        out_dir / f"history-bodies.{generation}.jsonl", external=True
    )
    if body_path != expected_body_path:
        raise ValueError("active_body_path_mismatch")
    body_bytes = _read_bounded_bytes(
        body_path, MAX_BODY_ARTIFACT_BYTES, "active_body_too_large"
    )
    if sha256_bytes(body_bytes) != generation:
        raise ValueError("active_body_hash_mismatch")
    if type(artifact.get("bytes")) is not int or artifact["bytes"] != len(body_bytes):
        raise ValueError("active_body_bytes_mismatch")
    index = artifact.get("index")
    index_generation = receipt.get("index_generation")
    if (
        not isinstance(index_generation, str)
        or not re.fullmatch(r"[0-9a-f]{64}", index_generation)
        or not isinstance(index, dict)
        or index.get("sha256") != index_generation
        or index.get("generation") != index_generation
    ):
        raise ValueError("active_index_generation_mismatch")
    index_value = index.get("path")
    if not isinstance(index_value, str):
        raise ValueError("active_index_path_invalid")
    index_path = checked_path(Path(index_value), external=True)
    expected_index_path = checked_path(
        out_dir / f"history-bodies.{generation}.{index_generation}.index.json",
        external=True,
    )
    if index_path != expected_index_path:
        raise ValueError("active_index_path_mismatch")
    index_bytes = _read_bounded_bytes(
        index_path, MAX_BODY_INDEX_BYTES, "active_index_too_large"
    )
    if sha256_bytes(index_bytes) != index_generation:
        raise ValueError("active_index_hash_mismatch")
    if type(index.get("bytes")) is not int or index["bytes"] != len(index_bytes):
        raise ValueError("active_index_bytes_mismatch")
    try:
        body_index = json.loads(index_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("active_index_invalid_json") from exc
    if not isinstance(body_index, dict):
        raise ValueError("active_index_invalid_json")
    if body_index.get("schema") != "omnia.history-body-index.v1":
        raise ValueError("active_index_invalid_schema")
    if body_index.get("body_sha256") != generation:
        raise ValueError("active_index_body_hash_mismatch")
    if (
        type(body_index.get("body_bytes")) is not int
        or body_index["body_bytes"] != len(body_bytes)
    ):
        raise ValueError("active_index_body_bytes_mismatch")
    index_messages = body_index.get("messages")
    if type(index_messages) is not int or index_messages < 0:
        raise ValueError("active_index_messages_invalid")
    records = body_index.get("records")
    if not isinstance(records, dict):
        raise ValueError("active_index_records_invalid")
    spans: list[tuple[int, int, str, dict[str, Any]]] = []
    for record_id_value, record_spans in records.items():
        if not isinstance(record_id_value, str) or not isinstance(record_spans, list):
            raise ValueError("active_index_record_spans_invalid")
        for span in record_spans:
            if not isinstance(span, dict):
                raise ValueError("active_index_span_invalid")
            offset = span.get("offset")
            length = span.get("bytes")
            span_hash = span.get("sha256")
            if (
                type(offset) is not int
                or offset < 0
                or type(length) is not int
                or length <= 0
                or not isinstance(span_hash, str)
                or not re.fullmatch(r"[0-9a-f]{64}", span_hash)
            ):
                raise ValueError("active_index_span_invalid")
            end = offset + length
            if end > len(body_bytes):
                raise ValueError("active_index_span_bounds")
            spans.append((offset, end, record_id_value, span))
    spans.sort(key=lambda item: (item[0], item[1], item[2]))
    cursor = 0
    for offset, end, record_id_value, span in spans:
        if offset != cursor:
            raise ValueError("active_index_span_coverage")
        encoded = body_bytes[offset:end]
        if not encoded.endswith(b"\n"):
            raise ValueError("active_index_span_line_ending")
        if sha256_bytes(encoded) != span["sha256"]:
            raise ValueError("active_index_span_hash_mismatch")
        try:
            message = json.loads(encoded.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("active_body_message_invalid_json") from exc
        if (
            not isinstance(message, dict)
            or message.get("record_id") != record_id_value
            or message.get("role") not in {"user", "assistant"}
            or type(message.get("ordinal")) is not int
            or message["ordinal"] < 0
            or (
                message.get("timestamp") is not None
                and type(message.get("timestamp")) not in {int, str}
            )
            or type(message.get("truncated")) is not bool
        ):
            raise ValueError("active_index_record_id_mismatch")
        cursor = end
    if cursor != len(body_bytes):
        raise ValueError("active_index_span_coverage")
    if index_messages != len(spans):
        raise ValueError("active_index_message_count_mismatch")
    if type(artifact.get("messages")) is not int or artifact["messages"] != len(spans):
        raise ValueError("active_body_message_count_mismatch")
    if type(artifact.get("records")) is not int or artifact["records"] != len(records):
        raise ValueError("active_body_record_count_mismatch")
    if not _receipt_path_matches(receipt, "body_path", body_path.name):
        raise ValueError("active_receipt_body_path_mismatch")
    if not _receipt_path_matches(receipt, "index_path", index_path.name):
        raise ValueError("active_receipt_index_path_mismatch")
    if not _receipt_path_matches(
        receipt,
        "manifest_path",
        manifest_name,
        "history-manifest.json",
    ):
        raise ValueError("active_receipt_manifest_path_mismatch")
    receipt_counts = receipt.get("counts")
    manifest_counts = manifest.get("counts")
    if not isinstance(receipt_counts, dict) or not isinstance(manifest_counts, dict):
        raise ValueError("active_generation_counts_missing")
    for key in ("records", "verified", "partial", "blocked", "transcript_available"):
        manifest_count = manifest_counts.get(key)
        receipt_count = receipt_counts.get(key)
        if (
            type(manifest_count) is not int
            or manifest_count < 0
            or type(receipt_count) is not int
            or receipt_count < 0
            or manifest_count != receipt_count
        ):
            raise ValueError("active_generation_counts_mismatch")
    if receipt_counts != manifest_counts:
        raise ValueError("active_generation_counts_mismatch")
    manifest_records = manifest.get("records")
    if not isinstance(manifest_records, list) or len(manifest_records) > 100000:
        raise ValueError("active_generation_records_invalid")
    observed_records = 0
    observed_verified = 0
    observed_partial = 0
    observed_blocked = 0
    observed_transcript_available = 0
    for record in manifest_records:
        if not isinstance(record, dict):
            raise ValueError("active_generation_record_invalid")
        retrieval_state = record.get("retrieval_state")
        transcript_available = record.get("transcript_available")
        if (
            not isinstance(retrieval_state, str)
            or retrieval_state not in {"verified", "partial", "blocked"}
        ):
            raise ValueError("active_generation_record_invalid_state")
        if type(transcript_available) is not bool:
            raise ValueError("active_generation_record_invalid")
        observed_records += 1
        if retrieval_state == "verified":
            observed_verified += 1
        elif retrieval_state == "partial":
            observed_partial += 1
        else:
            observed_blocked += 1
        if transcript_available:
            observed_transcript_available += 1
    if (
        observed_records != manifest_counts["records"]
        or observed_verified != manifest_counts["verified"]
        or observed_partial != manifest_counts["partial"]
        or observed_blocked != manifest_counts["blocked"]
        or observed_transcript_available != manifest_counts["transcript_available"]
    ):
        raise ValueError("active_generation_counts_mismatch")
    return pointer, manifest, receipt


def _read_active_generation(
    out_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Read the active pointer, falling back to the previous valid pointer."""
    out_dir = checked_path(out_dir, external=True)
    active_path = checked_path(out_dir / "history-active.json", external=True)
    previous_path = checked_path(
        out_dir / "history-active.previous.json", external=True
    )
    active_exists = active_path.exists()
    previous_exists = previous_path.exists()
    active_error: BaseException | None = None
    try:
        return _read_generation_from_pointer(out_dir, active_path)
    except FileNotFoundError as exc:
        active_error = exc
    except (OSError, ValueError) as exc:
        active_error = exc
    try:
        pointer, manifest, receipt = _read_generation_from_pointer(
            out_dir, previous_path
        )
    except FileNotFoundError as previous_error:
        if active_exists and not previous_exists and active_error is not None:
            raise active_error
        if not active_exists and not previous_exists:
            raise FileNotFoundError(active_path)
        raise ValueError("active_generation_unrecoverable") from previous_error
    except (OSError, ValueError) as previous_error:
        if active_error is None:
            raise ValueError("active_generation_unrecoverable") from previous_error
        raise ValueError("active_generation_unrecoverable") from active_error
    recovered_pointer = dict(pointer)
    recovered_pointer["recovered_from"] = "history-active.previous.json"
    return recovered_pointer, manifest, receipt


def _last_known_good_pointer_bytes(out_dir: Path) -> bytes | None:
    """Return raw bytes for the newest pointer that passes strict validation."""
    out_dir = checked_path(out_dir, external=True)
    for candidate in (
        out_dir / "history-active.json",
        out_dir / "history-active.previous.json",
    ):
        candidate = checked_path(candidate, external=True)
        if not candidate.is_file():
            continue
        try:
            payload = _read_bounded_bytes(
                candidate, MAX_ACTIVE_POINTER_BYTES, "active_pointer_too_large"
            )
            _read_generation_from_pointer(
                out_dir,
                candidate,
                pointer_bytes=payload,
            )
            return payload
        except (OSError, ValueError):
            continue
    return None


def _recover_compatibility_aliases(out_dir: Path) -> None:
    """Restore compatibility aliases from the verified active generation."""
    out_dir = checked_path(out_dir, external=True)
    active_path = checked_path(out_dir / "history-active.json", external=True)
    previous_path = checked_path(
        out_dir / "history-active.previous.json", external=True
    )
    if not active_path.exists() and not previous_path.exists():
        return
    _, manifest, receipt = _read_active_generation(out_dir)
    manifest_path = checked_path(out_dir / "history-manifest.json", external=True)
    receipt_path = checked_path(out_dir / "history-receipt.json", external=True)
    previous_manifest_bytes = (
        _read_bounded_bytes(
            manifest_path, MAX_MANIFEST_BYTES, "legacy_manifest_too_large"
        )
        if manifest_path.exists() else None
    )
    previous_receipt_bytes = (
        _read_bounded_bytes(
            receipt_path, MAX_RECEIPT_BYTES, "legacy_receipt_too_large"
        )
        if receipt_path.exists() else None
    )
    if (
        previous_manifest_bytes == canonical_json_bytes(manifest)
        and previous_receipt_bytes == canonical_json_bytes(receipt)
    ):
        return
    _publish_manifest_receipt_pair(
        manifest_path,
        manifest,
        receipt_path,
        receipt,
        previous_manifest_bytes,
        previous_receipt_bytes,
    )

def _publish_manifest_receipt_pair(
    manifest_path: Path,
    manifest: dict[str, Any],
    receipt_path: Path,
    receipt: dict[str, Any],
    previous_manifest_bytes: bytes | None,
    previous_receipt_bytes: bytes | None,
) -> None:
    """Update compatibility aliases with rollback on a caught exception.

    Both payloads are fully staged before either active path changes. If the
    second rename fails, previous bytes are restored. Only the active pointer
    provides an atomic generation selection when a process exits abruptly.
    """
    manifest_staging = _stage_bytes(manifest_path, canonical_json_bytes(manifest))
    try:
        receipt_staging = _stage_bytes(receipt_path, canonical_json_bytes(receipt))
    except BaseException:
        try:
            manifest_staging.unlink()
        except FileNotFoundError:
            pass
        raise

    try:
        os.replace(manifest_staging, manifest_path)
        _fsync_directory(manifest_path.parent)
        os.replace(receipt_staging, receipt_path)
        _fsync_directory(receipt_path.parent)
    except BaseException:
        rollback_error: BaseException | None = None
        try:
            _restore_file_bytes(manifest_path, previous_manifest_bytes)
        except BaseException as restore_error:
            rollback_error = RuntimeError("manifest_rollback_failed")
            rollback_error.__cause__ = restore_error
        try:
            _restore_file_bytes(receipt_path, previous_receipt_bytes)
        except BaseException as restore_error:
            if rollback_error is None:
                rollback_error = RuntimeError("receipt_rollback_failed")
                rollback_error.__cause__ = restore_error
        if rollback_error is not None:
            raise rollback_error
        raise
    finally:
        for staging in (manifest_staging, receipt_staging):
            try:
                staging.unlink()
            except FileNotFoundError:
                pass


def _fsync_directory(path: Path) -> None:
    """Best-effort directory durability; Windows may reject directory handles."""
    try:
        flags = os.O_RDONLY
        if hasattr(os, "O_DIRECTORY"):
            flags |= os.O_DIRECTORY
        fd = os.open(path, flags)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        return


def _move_or_verify_generation(staging: Path, destination: Path, expected_hash: str) -> None:
    if not staging.exists():
        raise FileNotFoundError(staging)
    if sha256_file(staging) != expected_hash:
        raise ValueError("generation_staging_hash_mismatch")
    if destination.exists():
        if sha256_file(destination) != expected_hash:
            raise ValueError("generation_collision")
        if staging != destination:
            staging.unlink()
        return
    os.replace(staging, destination)
    _fsync_directory(destination.parent)


def _publish_generation(
    out_dir: Path,
    manifest: dict[str, Any],
    receipt: dict[str, Any],
    *,
    home: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Publish immutable body/index generations before replacing the manifest."""
    artifact = manifest.get("body_artifact")
    if not isinstance(artifact, dict) or not artifact.get("path"):
        return manifest, receipt
    index = artifact.get("index")
    if not isinstance(index, dict) or not index.get("path"):
        raise ValueError("body_index_missing")
    staging_body = checked_path(Path(str(artifact["path"])), external=True)
    staging_index = checked_path(Path(str(index["path"])), external=True)
    body_hash = str(artifact.get("sha256", ""))
    index_hash = str(index.get("sha256", ""))
    if not re.fullmatch(r"[0-9a-f]{64}", body_hash) or not re.fullmatch(r"[0-9a-f]{64}", index_hash):
        raise ValueError("generation_hash_missing")
    out_dir = checked_path(out_dir, external=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    generation_body = out_dir / f"history-bodies.{body_hash}.jsonl"
    generation_index = out_dir / (
        f"history-bodies.{body_hash}.{index_hash}.index.json"
    )
    generation_body = checked_path(generation_body, external=True)
    generation_index = checked_path(generation_index, external=True)
    for staging, destination, expected_hash in (
        (staging_body, generation_body, body_hash),
        (staging_index, generation_index, index_hash),
    ):
        if not staging.exists() or sha256_file(staging) != expected_hash:
            raise ValueError("generation_staging_hash_mismatch")
        if destination.exists() and sha256_file(destination) != expected_hash:
            raise ValueError("generation_collision")
    _move_or_verify_generation(staging_body, generation_body, body_hash)
    _move_or_verify_generation(staging_index, generation_index, index_hash)
    artifact["path"] = str(generation_body)
    artifact["generation"] = body_hash
    artifact["index"]["path"] = str(generation_index)
    artifact["index"]["generation"] = index_hash
    receipt["generation"] = body_hash
    receipt["index_generation"] = index_hash
    receipt["body_path"] = display_path(generation_body, home)
    receipt["index_path"] = display_path(generation_index, home)
    return manifest, receipt

def _publish_active_generation(
    out_dir: Path,
    manifest: dict[str, Any],
    receipt: dict[str, Any],
    *,
    manifest_path: Path,
    receipt_path: Path,
    previous_manifest_bytes: bytes | None,
    previous_receipt_bytes: bytes | None,
    previous_pointer_bytes: bytes | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Publish immutable generations and then atomically advance the pointer.

    The pointer is the only authoritative active-generation selector. The
    legacy manifest and receipt paths remain compatibility derivatives and are
    updated before the pointer so a process interruption leaves the previous
    pointer usable.
    """
    manifest_generation, manifest_hash = _publish_immutable_json(
        out_dir,
        "history-manifest",
        manifest,
    )
    receipt["manifest_sha256"] = manifest_hash
    receipt_generation, receipt_hash = _publish_immutable_json(
        out_dir,
        "history-receipt",
        receipt,
    )
    pointer = _active_pointer_payload(
        manifest_generation.name,
        manifest_hash,
        receipt_generation.name,
        receipt_hash,
        receipt,
    )
    if previous_manifest_bytes is not None:
        previous = out_dir / "history-manifest.previous.json"
        write_atomic_bytes(previous, previous_manifest_bytes)
    _publish_manifest_receipt_pair(
        manifest_path,
        manifest,
        receipt_path,
        receipt,
        previous_manifest_bytes,
        previous_receipt_bytes,
    )
    try:
        if previous_pointer_bytes is not None:
            write_atomic_bytes(
                out_dir / "history-active.previous.json",
                previous_pointer_bytes,
            )
        write_atomic(out_dir / "history-active.json", pointer)
    except BaseException:
        _restore_file_bytes(manifest_path, previous_manifest_bytes)
        _restore_file_bytes(receipt_path, previous_receipt_bytes)
        raise
    return manifest, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--codex-root", type=Path)
    parser.add_argument("--gemini-root", type=Path)
    parser.add_argument("--out-dir", type=Path, default=default_out_dir())
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    home = checked_path(args.home)
    codex_root = checked_path(args.codex_root or home / ".codex")
    gemini_root = checked_path(args.gemini_root or home / ".gemini")
    source_roots = (codex_root, gemini_root)
    out_dir = _external_destination(args.out_dir, source_roots)
    body_path: Path | None
    if args.dry_run:
        body_path = None
    else:
        configured_body = os.environ.get("OMNIA_HISTORY_BODY_ARTIFACT")
        if configured_body:
            configured_destination = _external_destination(
                Path(configured_body), source_roots
            )
            staging_body = configured_destination.with_name(
                f".{configured_destination.stem}.{os.getpid()}.{time.time_ns()}"
                f"{configured_destination.suffix or '.jsonl'}"
            )
        else:
            staging_body = out_dir / (
                f".history-bodies.{os.getpid()}.{time.time_ns()}.jsonl"
            )
        body_path = _external_destination(
            staging_body,
            source_roots,
        )
        reserved = {
            out_dir / "history-manifest.json",
            out_dir / "history-manifest.previous.json",
            out_dir / "history-receipt.json",
        }
        if body_path in reserved or body_path.with_suffix(".index.json") in reserved:
            raise ValueError("body_output_collision")
    staging_paths = (
        (body_path, body_path.with_suffix(".index.json"))
        if body_path is not None
        else ()
    )
    try:
        publication_lock = (
            _history_output_lock(out_dir) if not args.dry_run else nullcontext()
        )
        with publication_lock:
            if not args.dry_run:
                # A previous process may have stopped between alias writes and
                # pointer replacement. Repair aliases only from the fully
                # verified immutable generation selected by the pointer.
                _recover_compatibility_aliases(out_dir)
            previous_pointer_bytes = (
                _last_known_good_pointer_bytes(out_dir)
                if not args.dry_run
                else None
            )
            manifest = build_manifest(home, codex_root, gemini_root, body_path=body_path)
            receipt = {
                "schema": "omnia.history-import-receipt.v1",
                "generated_at": manifest["generated_at"],
                "manifest_schema": manifest["schema"],
                "out_dir": display_path(out_dir, home),
                "counts": manifest["counts"],
                "source_count": len(manifest["sources"]),
                "dry_run": bool(args.dry_run),
                "status": (
                    "partial"
                    if manifest["counts"]["partial"] or manifest["counts"]["blocked"]
                    or any(source["state"] != "verified" for source in manifest["sources"])
                    else "verified"
                ),
            }
            if not args.dry_run:
                manifest_path = checked_path(
                    out_dir / "history-manifest.json", external=True
                )
                receipt_path = checked_path(
                    out_dir / "history-receipt.json", external=True
                )
                previous_manifest_bytes = (
                    _read_bounded_bytes(
                        manifest_path, MAX_MANIFEST_BYTES, "legacy_manifest_too_large"
                    )
                    if manifest_path.exists() else None
                )
                previous_receipt_bytes = (
                    _read_bounded_bytes(
                        receipt_path, MAX_RECEIPT_BYTES, "legacy_receipt_too_large"
                    )
                    if receipt_path.exists() else None
                )
                manifest, receipt = _publish_generation(
                    out_dir,
                    manifest,
                    receipt,
                    home=home,
                )
                receipt["manifest_path"] = display_path(manifest_path.resolve(), home)
                receipt["receipt_path"] = display_path(receipt_path.resolve(), home)
                _publish_active_generation(
                    out_dir,
                    manifest,
                    receipt,
                    manifest_path=manifest_path,
                    receipt_path=receipt_path,
                    previous_manifest_bytes=previous_manifest_bytes,
                    previous_receipt_bytes=previous_receipt_bytes,
                    previous_pointer_bytes=previous_pointer_bytes,
                )
            print(json.dumps(receipt, ensure_ascii=False, indent=2))
            return 0
    finally:
        for staging in staging_paths:
            if staging is None:
                continue
            try:
                staging.unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
