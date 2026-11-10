"""Dependency-free verifier for the run-control/state-graph contract.

The JSON documents are intentionally portable and are not tied to a particular
JSON-Schema implementation.  This small verifier catches the conditional
validation regressions that are easy to miss when a branch only adds a
``properties`` clause (for example, a resume operation without the required
``resume-checkpoint`` intent).

Run from the repository root with::

    python scripts/verify-run-control-contract.py

The checker is complementary to the normative schemas and to the native Rust
tests.  A PASS here is static contract evidence only; it is not native compile
or packaged Windows runtime evidence.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parents[1]
SPEC_ROOT = ROOT / "docs" / "omnia-ultra"
SCHEMA_ROOT = SPEC_ROOT / "schemas"


def fail(message: str) -> NoReturn:
    raise AssertionError(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"unable to load {path.relative_to(ROOT)}: {error}")
    check(isinstance(value, dict), f"{path.name} must contain a JSON object")
    return value


def required(schema: dict[str, Any], field: str, context: str) -> None:
    check(field in schema.get("required", []), f"{context} must require {field}")


def conditional(
    schema: dict[str, Any],
    property_name: str,
    expected_value: str,
) -> dict[str, Any]:
    for clause in schema.get("allOf", []):
        if_clause = clause.get("if", {})
        properties = if_clause.get("properties", {})
        candidate = properties.get(property_name, {})
        if candidate.get("const") == expected_value:
            return clause
        if expected_value in candidate.get("enum", []):
            return clause
    fail(f"missing conditional for {property_name}={expected_value}")


def check_operation_schema() -> tuple[dict[str, Any], dict[str, Any]]:
    operation = load_json(SCHEMA_ROOT / "run-control-operation.schema.json")
    graph = load_json(SCHEMA_ROOT / "state-revision-graph.schema.json")

    check(
        operation.get("$id") == "https://omnia.local/schemas/run-control-operation.schema.json",
        "run-control operation schema id drifted",
    )
    check(operation.get("type") == "object", "run-control operation schema must be an object")
    check(operation.get("additionalProperties") is False, "run-control operation must reject unknown fields")
    for field in (
        "schemaVersion",
        "operationId",
        "kind",
        "operationState",
        "conversationId",
        "branchId",
        "stateBase",
        "activeRunPolicy",
        "actor",
        "idempotencyKey",
        "createdAt",
    ):
        required(operation, field, "run-control operation")

    kinds = set(operation["properties"]["kind"]["enum"])
    expected_kinds = {
        "pause",
        "resume",
        "continue",
        "edit",
        "retry",
        "copy",
        "duplicate",
        "branch",
        "fork",
        "compare",
        "promote",
        "merge",
    }
    check(kinds == expected_kinds, f"run-control operation kinds drifted: {sorted(kinds)}")

    resume = conditional(operation, "kind", "resume")
    for field in ("sourceRunId", "continuationIntent"):
        required(resume["then"], field, "resume operation")
    check(
        resume["then"]["properties"]["continuationIntent"].get("const") == "resume-checkpoint",
        "resume must pin continuationIntent=resume-checkpoint",
    )

    pause = conditional(operation, "kind", "pause")
    required(pause["then"], "sourceRunId", "pause operation")

    continuation = conditional(operation, "kind", "continue")
    required(continuation["then"], "continuationIntent", "continue operation")
    check(
        continuation["then"]["properties"]["continuationIntent"].get("not", {}).get("const") == "none",
        "continue must reject continuationIntent=none",
    )

    edit = conditional(operation, "kind", "edit")
    for field in ("sourceMessageId", "sourcePromptRevisionId", "editRevisionId"):
        required(edit["then"], field, "edit operation")

    retry = conditional(operation, "kind", "retry")
    for field in ("sourceAttemptId", "sourcePromptRevisionId"):
        required(retry["then"], field, "retry operation")

    compare = conditional(operation, "kind", "compare")
    required(compare["then"], "compareStateRevisionIds", "compare operation")
    check(
        compare["then"]["properties"]["compareStateRevisionIds"].get("minItems") == 2,
        "compare must require at least two state revisions",
    )

    for kind in ("merge", "promote"):
        clause = conditional(operation, "kind", kind)
        required(clause["then"], "mergeStateRevisionIds", f"{kind} operation")
        check(
            clause["then"]["properties"]["mergeStateRevisionIds"].get("minItems") == 2,
            f"{kind} must require at least two state revisions",
        )

    blocked = conditional(operation, "operationState", "blocked")
    required(blocked["then"], "result", "blocked operation")
    blocked_result = blocked["then"]["properties"]["result"]
    check(blocked_result.get("type") == "object", "blocked result must be a non-null object")
    required(blocked_result, "blockedReason", "blocked result")
    check(
        blocked_result["properties"]["blockedReason"].get("minLength", 0) >= 1,
        "blockedReason must be non-empty",
    )

    graph_defs = graph.get("$defs", {})
    graph_edge_kinds = set(graph_defs.get("stateEdge", {}).get("properties", {}).get("kind", {}).get("enum", []))
    graph_revision_kinds = set(
        graph_defs.get("stateRevision", {}).get("properties", {}).get("kind", {}).get("enum", [])
    )
    for edge in (
        "checkpoint-of",
        "resumes-from-checkpoint",
        "continues-from",
        "edits",
        "retries",
        "branches-from",
        "forks-from",
        "merges-from",
        "promotes",
    ):
        check(edge in graph_edge_kinds, f"state graph is missing edge kind {edge}")
    for revision in ("checkpoint", "resume", "continuation", "prompt-edit", "retry-result", "branch", "fork", "merge", "promotion"):
        check(revision in graph_revision_kinds, f"state graph is missing revision kind {revision}")

    return operation, graph


def check_continuation_schema() -> None:
    schema = load_json(SCHEMA_ROOT / "continuation-intent.schema.json")
    check(schema.get("$id") == "https://omnia.local/schemas/continuation-intent.schema.json", "continuation schema id drifted")
    check(schema.get("additionalProperties") is False, "continuation intent must reject unknown fields")
    for field in ("schemaVersion", "intentId", "rootKind", "rootId", "intentKind", "stateRevisionId", "executionMode", "loopGuard", "createdAt"):
        required(schema, field, "continuation intent")
    check(
        set(schema["properties"]["rootKind"]["enum"])
        == {"run", "task", "goal", "branch", "checkpoint", "starter-workflow"},
        "continuation root kinds drifted",
    )
    check(
        "none" not in schema["properties"].get("intentKind", {}).get("enum", []),
        "continuation intent kind must never use none",
    )
    check(
        any(
            clause.get("if", {}).get("properties", {}).get("intentKind", {}).get("enum")
            == ["plan-only", "draft-only"]
            and clause.get("then", {}).get("not", {}).get("properties", {}).get("executionMode", {}).get("const")
            == "execute"
            for clause in schema.get("allOf", [])
        ),
        "plan-only and draft-only continuation intents must reject execute mode",
    )


def check_checkpoint_schema() -> None:
    schema = load_json(SCHEMA_ROOT / "run-checkpoint.schema.json")
    check(schema.get("$id") == "https://omnia.local/schemas/run-checkpoint.schema.json", "checkpoint schema id drifted")
    check(schema.get("additionalProperties") is False, "checkpoint must reject unknown fields")
    for field in ("schemaVersion", "checkpointId", "runId", "stateRevisionId", "status", "disposition", "cursor", "contentHash", "createdAt"):
        required(schema, field, "checkpoint")


def check_revision_schema() -> None:
    schema = load_json(SCHEMA_ROOT / "message-revision.schema.json")
    check(schema.get("$id") == "https://omnia.local/schemas/message-revision.schema.json", "message revision schema id drifted")
    check(schema.get("additionalProperties") is False, "message revision must reject unknown fields")
    for field in ("schemaVersion", "revisionId", "messageId", "kind", "effect", "sourceCursor", "contentHash", "createdAt"):
        required(schema, field, "message revision")


def check_mapping_document() -> None:
    path = SPEC_ROOT / "architecture" / "run-control-native-mapping.md"
    check(path.is_file(), "run-control native mapping document is missing")
    text = path.read_text(encoding="utf-8")
    expected = {
        "pause": "checkpoint-of",
        "resume": "resumes-from-checkpoint",
        "continue": "continues-from",
        "edit": "edits",
        "retry": "retries",
        "branch": "branches-from",
        "fork": "forks-from",
        "merge": "merges-from",
        "promote": "promotes",
    }
    for operation, edge in expected.items():
        row = re.search(rf"^\|\s*`{re.escape(operation)}`\s*\|.*$", text, re.MULTILINE)
        check(row is not None, f"mapping document is missing operation row {operation}")
        check(edge in row.group(0), f"mapping document maps {operation} without {edge}")

    # Copy and compare are projection-only operations.  They may create an
    # audit/read receipt, but must not append a state revision or graph edge.
    for operation in ("copy", "compare"):
        row = re.search(rf"^\|\s*`{re.escape(operation)}`\s*\|.*$", text, re.MULTILINE)
        check(row is not None, f"mapping document is missing operation row {operation}")
        row_text = row.group(0).lower()
        check("none" in row_text, f"mapping document must mark {operation} as revision/edge-free")
        check("read-only" in row_text, f"mapping document must mark {operation} as read-only")

    # Duplicate is deliberately not a blind continuation.  It must resolve to
    # an explicit branch/fork policy so source identity, authority and billing
    # lineage remain distinct.  This assertion prevents the native resolver
    # from silently drifting back to a deep-copy or continuation mapping.
    duplicate = re.search(r"^\|\s*`duplicate`\s*\|.*$", text, re.MULTILINE)
    check(duplicate is not None, "mapping document is missing operation row duplicate")
    duplicate_text = duplicate.group(0).lower()
    check("branch" in duplicate_text and "fork" in duplicate_text, "duplicate must require an explicit branch/fork policy")
    check("blind deep copy" in text.lower(), "mapping document must reject blind duplicate copies")

    # These are architectural invariants of the portable mapping document,
    # rather than Rust source requirements.  Keep the checks here so a native
    # implementation is not forced to repeat prose that belongs to the
    # normative specification.
    for phrase in (
        "child -> parent",
        "outcome-unknown",
        "stateBase",
        "idempotency",
        "native-state-revision-graph-read-v1",
    ):
        check(phrase in text, f"mapping document omits invariant {phrase}")


def check_native_mapping() -> None:
    """Catch drift between the normative mapping and the Rust resolver.

    This is intentionally a lightweight source-contract check.  It does not
    claim that Rust compiles or that a command is wired into Tauri; it merely
    prevents a known-dangerous regression where ``duplicate`` is treated as a
    normal continuation and therefore shares execution/billing lineage.
    """

    path = ROOT / "src-tauri" / "src" / "run_control.rs"
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8")
    kind_block = re.search(
        r"fn\s+state_revision_kind\s*\(.*?\)\s*->\s*Option<&'static str>\s*\{(?P<body>.*?)\n\s*\}",
        text,
        re.DOTALL,
    )
    edge_block = re.search(
        r"fn\s+default_edge_kind\s*\(.*?\)\s*->\s*Option<&'static str>\s*\{(?P<body>.*?)\n\s*\}",
        text,
        re.DOTALL,
    )
    check(kind_block is not None, "native resolver is missing state_revision_kind")
    check(edge_block is not None, "native resolver is missing default_edge_kind")
    native_kind = kind_block.group("body")
    native_edge = edge_block.group("body")
    duplicate_kind = re.search(r"Self::Duplicate\s*=>\s*Some\(\"([^\"]+)\"\)", native_kind)
    duplicate_edge = re.search(r"Self::(?:Continue\s*\|\s*)?Duplicate\s*=>\s*Some\(\"([^\"]+)\"\)", native_edge)
    check(duplicate_kind is not None, "native resolver does not map duplicate explicitly")
    check(duplicate_edge is not None, "native resolver does not map duplicate edge explicitly")
    check(
        duplicate_kind.group(1) in {"branch", "fork"},
        "native duplicate must resolve to branch or fork, never continuation",
    )
    check(
        duplicate_edge.group(1) in {"branches-from", "forks-from"},
        "native duplicate edge must be branches-from or forks-from",
    )

def main() -> int:
    try:
        check_operation_schema()
        check_continuation_schema()
        check_checkpoint_schema()
        check_revision_schema()
        check_mapping_document()
        check_native_mapping()
    except AssertionError as error:
        print(f"FAIL - {error}")
        return 1
    print("PASS - run-control schemas, conditionals, graph mapping and native boundary contract")
    return 0


if __name__ == "__main__":
    sys.exit(main())
