"""Independent contract verifier for Omnia run-control schemas.

This probe deliberately does not import the Rust implementation and does not
claim that native Pause/Resume/Continue execution exists.  It checks the
checked-in JSON contracts for closed vocabularies, source requirements,
state-base modes, cardinality guards, redaction and bounded fields.  Native
transaction, restart, provider and packaged-Windows evidence remains a
separate gate.

Run from the repository root with::

    python scripts/verify-run-control-schema.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ROOT = ROOT / "docs" / "omnia-ultra" / "schemas"

OPERATION_PATH = SCHEMA_ROOT / "run-control-operation.schema.json"
CHECKPOINT_PATH = SCHEMA_ROOT / "run-checkpoint.schema.json"
CONTINUATION_PATH = SCHEMA_ROOT / "continuation-intent.schema.json"
MESSAGE_REVISION_PATH = SCHEMA_ROOT / "message-revision.schema.json"
STATE_GRAPH_PATH = SCHEMA_ROOT / "state-revision-graph.schema.json"

OPERATION_KINDS = {
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
OPERATION_STATES = {"resolved", "applied", "blocked", "rejected", "cancelled", "failed"}
STATE_BASE_MODES = {
    "exact-historical",
    "current-state",
    "historical-plus-selected-deltas",
    "fresh-branch",
    "fresh-goal-start",
}
CONTINUATION_INTENTS = {
    "unfinished-answer",
    "next-plan-task",
    "resume-checkpoint",
    "bootstrap-active-goal",
    "research-next",
    "test-next",
    "review-next",
    "plan-only",
    "draft-only",
}
CHECKPOINT_STATUSES = {
    "requested",
    "checkpointing",
    "paused",
    "resuming",
    "expired",
    "blocked",
    "invalidated",
}
CHECKPOINT_DISPOSITIONS = {
    "cooperative-checkpoint",
    "provider-supported-suspend",
    "cancel-then-reconcile",
    "pending-effect-checkpoint",
    "held",
    "outcome-unknown",
}
RAW_OR_SECRET_NAMES = {
    "credential",
    "credentialRef",
    "apiKey",
    "accessToken",
    "refreshToken",
    "cookie",
    "cookies",
    "password",
    "promptBody",
    "responseBody",
    "reasoningBody",
    "attachmentBytes",
    "fileBytes",
    "absolutePath",
    "rawUrl",
    "requestBody",
}


class VerificationError(AssertionError):
    """A contract assertion with a concise CI-facing message."""


def fail(message: str) -> NoReturn:
    raise VerificationError(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def load(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"missing schema: {path}")
    except json.JSONDecodeError as error:
        fail(f"invalid JSON in {path}: {error}")
    check(isinstance(value, dict), f"schema root must be an object: {path.name}")
    return value


def require_closed_object(document: dict[str, Any], path: Path) -> None:
    check(document.get("type") == "object", f"{path.name}: root type must be object")
    check(
        document.get("additionalProperties") is False,
        f"{path.name}: root must reject unknown properties",
    )
    properties = document.get("properties")
    check(isinstance(properties, dict), f"{path.name}: properties must be an object")
    leaked = sorted(set(properties) & RAW_OR_SECRET_NAMES)
    check(not leaked, f"{path.name}: raw/secret property names are forbidden: {leaked}")


def enum(document: dict[str, Any], name: str) -> list[Any]:
    properties = document.get("properties", {})
    value = properties.get(name, {}).get("enum")
    check(isinstance(value, list), f"missing enum for {name}")
    return value


def required(document: dict[str, Any], names: set[str], label: str) -> None:
    actual = set(document.get("required", []))
    check(names <= actual, f"{label}: required fields missing {sorted(names - actual)}")


def condition_for_kind(document: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for rule in document.get("allOf", []):
        if not isinstance(rule, dict):
            continue
        condition = rule.get("if", {})
        if condition.get("properties", {}).get("kind", {}).get("const") == kind:
            matches.append(rule)
        elif kind in condition.get("properties", {}).get("kind", {}).get("enum", []):
            matches.append(rule)
    return matches


def then_required(rule: dict[str, Any]) -> set[str]:
    return set(rule.get("then", {}).get("required", []))


def verify_operation(document: dict[str, Any]) -> dict[str, Any]:
    path = OPERATION_PATH
    require_closed_object(document, path)
    required(
        document,
        {
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
        },
        path.name,
    )
    check(document.get("properties", {}).get("schemaVersion", {}).get("const") == 2, "operation schemaVersion must be 2")
    check(set(enum(document, "kind")) == OPERATION_KINDS, "operation kind vocabulary drifted")
    check(set(enum(document, "operationState")) == OPERATION_STATES, "operation state vocabulary drifted")
    check(
        set(enum(document, "continuationIntent"))
        >= {"none", "unfinished-answer", "next-plan-task", "resume-checkpoint"},
        "operation continuation intent vocabulary is incomplete",
    )
    check(
        set(enum(document, "activeRunPolicy"))
        == {
            "apply-at-safe-boundary",
            "interrupt-new-attempt",
            "queue-after-terminal",
            "fork-parallel",
            "not-applicable",
        },
        "active-run policy vocabulary drifted",
    )

    expected_sources = {
        "pause": {"sourceRunId"},
        "resume": {"sourceRunId"},
        "continue": {"continuationIntent"},
        "edit": {"sourceMessageId", "sourcePromptRevisionId", "editRevisionId"},
        "retry": {"sourceAttemptId", "sourcePromptRevisionId"},
        "compare": {"compareStateRevisionIds"},
        "promote": {"mergeStateRevisionIds"},
        "merge": {"mergeStateRevisionIds"},
    }
    for kind, expected in expected_sources.items():
        rules = condition_for_kind(document, kind)
        check(rules, f"{path.name}: no conditional rule for operation kind {kind}")
        check(
            any(expected <= then_required(rule) for rule in rules),
            f"{path.name}: {kind} source requirements drifted",
        )
    continue_rules = condition_for_kind(document, "continue")
    check(
        any(
            rule.get("then", {}).get("properties", {})
            .get("continuationIntent", {})
            .get("not", {})
            .get("const")
            == "none"
            for rule in continue_rules
        ),
        "continue must reject the none intent",
    )
    compare_rules = condition_for_kind(document, "compare")
    check(
        any(
            rule.get("then", {}).get("properties", {})
            .get("compareStateRevisionIds", {})
            .get("minItems")
            == 2
            for rule in compare_rules
        ),
        "compare must require at least two revisions",
    )
    merge_rules = condition_for_kind(document, "merge") + condition_for_kind(document, "promote")
    check(
        any(
            rule.get("then", {}).get("properties", {})
            .get("mergeStateRevisionIds", {})
            .get("minItems")
            == 2
            for rule in merge_rules
        ),
        "merge/promote must require at least two revisions",
    )
    blocked_rules = [
        rule
        for rule in document.get("allOf", [])
        if rule.get("if", {}).get("properties", {}).get("operationState", {}).get("const")
        == "blocked"
    ]
    check(blocked_rules, "blocked operation rule is missing")
    check(
        any("result" in rule.get("then", {}).get("required", []) for rule in blocked_rules),
        "blocked operation must carry a result/diagnostic envelope",
    )

    state_base = document.get("properties", {}).get("stateBase", {})
    check(
        state_base.get("$ref") == "state-revision-graph.schema.json#/$defs/stateBase",
        "operation stateBase must use the canonical state-revision graph definition",
    )
    actor = document.get("properties", {}).get("actor", {})
    check(actor.get("additionalProperties") is False, "operation actor must be closed")
    check(
        set(actor.get("properties", {}).get("kind", {}).get("enum", []))
        == {"user", "agent", "automation", "recovery"},
        "operation actor vocabulary drifted",
    )
    check(
        document.get("properties", {}).get("idempotencyKey", {}).get("maxLength") == 512,
        "operation idempotency key bound drifted",
    )
    return {
        "schemaVersion": 2,
        "operationKinds": len(OPERATION_KINDS),
        "operationStates": len(OPERATION_STATES),
        "conditionalSourceRules": len(expected_sources),
        "blockedReasonGuard": True,
        "closedObject": True,
    }


def verify_checkpoint(document: dict[str, Any]) -> dict[str, Any]:
    path = CHECKPOINT_PATH
    require_closed_object(document, path)
    required(document, {"schemaVersion", "checkpointId", "runId", "stateRevisionId", "status", "disposition", "cursor", "contentHash", "createdAt"}, path.name)
    check(document.get("properties", {}).get("schemaVersion", {}).get("const") == 1, "checkpoint schemaVersion must be 1")
    check(set(enum(document, "status")) == CHECKPOINT_STATUSES, "checkpoint status vocabulary drifted")
    check(set(enum(document, "disposition")) == CHECKPOINT_DISPOSITIONS, "checkpoint disposition vocabulary drifted")
    check(document.get("properties", {}).get("cursor", {}).get("minimum") == 0, "checkpoint cursor must be non-negative")
    check(document.get("properties", {}).get("contentHash", {}).get("minLength") == 1, "checkpoint content hash must be present")
    check(document.get("properties", {}).get("idempotencyKey", {}).get("minLength") == 1, "checkpoint idempotency key must be present")
    return {"schemaVersion": 1, "statuses": len(CHECKPOINT_STATUSES), "dispositions": len(CHECKPOINT_DISPOSITIONS), "closedObject": True}


def verify_continuation(document: dict[str, Any]) -> dict[str, Any]:
    path = CONTINUATION_PATH
    require_closed_object(document, path)
    required(document, {"schemaVersion", "intentId", "rootKind", "intentKind", "stateRevisionId", "executionMode", "loopGuard", "createdAt"}, path.name)
    check(document.get("properties", {}).get("schemaVersion", {}).get("const") == 1, "continuation schemaVersion must be 1")
    check(set(enum(document, "intentKind")) == CONTINUATION_INTENTS, "continuation intent vocabulary drifted")
    check(
        set(enum(document, "executionMode")) == {"preview", "plan-only", "draft-only", "execute"},
        "continuation execution mode vocabulary drifted",
    )
    semantic_guards = document.get("allOf", [])
    check(
        any(
            clause.get("if", {}).get("properties", {}).get("intentKind", {}).get("enum")
            == ["plan-only", "draft-only"]
            and clause.get("then", {}).get("not", {}).get("properties", {}).get("executionMode", {}).get("const")
            == "execute"
            for clause in semantic_guards
        ),
        "continuation plan/draft intent kinds must reject execute mode",
    )
    root_kind = set(enum(document, "rootKind"))
    check(root_kind == {"run", "task", "goal", "branch", "checkpoint", "starter-workflow"}, "continuation root vocabulary drifted")
    loop_guard = document.get("properties", {}).get("loopGuard", {})
    check(loop_guard.get("additionalProperties") is False, "continuation loop guard must be closed")
    check(set(loop_guard.get("required", [])) == {"chainId", "duplicateSignature", "maxAutomaticSegments"}, "continuation loop guard requirements drifted")
    check(loop_guard.get("properties", {}).get("maxAutomaticSegments", {}).get("minimum") == 1, "continuation automatic segment bound must be positive")
    progress_score = loop_guard.get("properties", {}).get("progressScore", {})
    check(progress_score.get("type") == ["string", "null"], "continuation progressScore must be canonical numeric text or null")
    check(progress_score.get("minLength") == 1, "continuation progressScore must not be empty")
    check(progress_score.get("maxLength") == 128, "continuation progressScore byte bound drifted")
    check(
        progress_score.get("pattern") == r"^-?(?:0|[0-9]+)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$",
        "continuation progressScore numeric grammar drifted",
    )
    budget = document.get("properties", {}).get("budget", {})
    check(budget.get("type") == ["object", "null"], "continuation budget must allow native null serialization")
    for field in ("maxTokens", "maxCost", "maxDurationSeconds", "maxSegments"):
        property_schema = budget.get("properties", {}).get(field, {})
        check(
            isinstance(property_schema.get("type"), list) and "null" in property_schema["type"],
            f"continuation budget {field} must allow native null serialization",
        )
    check(budget.get("additionalProperties") is False, "continuation budget must be closed")
    max_cost = budget.get("properties", {}).get("maxCost", {})
    check(max_cost.get("type") == ["string", "null"], "continuation maxCost must be canonical numeric text or null")
    check(max_cost.get("minLength") == 1, "continuation maxCost must not be empty")
    check(max_cost.get("maxLength") == 128, "continuation maxCost byte bound drifted")
    check(
        max_cost.get("pattern") == r"^(?:0|[0-9]+)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$",
        "continuation maxCost numeric grammar drifted",
    )
    return {"schemaVersion": 1, "intents": len(CONTINUATION_INTENTS), "loopGuard": True, "budgetClosed": True}


def verify_message_revision(document: dict[str, Any]) -> dict[str, Any]:
    path = MESSAGE_REVISION_PATH
    require_closed_object(document, path)
    required(document, {"schemaVersion", "revisionId", "messageId", "kind", "effect", "sourceCursor", "contentHash", "createdAt"}, path.name)
    check(document.get("properties", {}).get("schemaVersion", {}).get("const") == 1, "message revision schemaVersion must be 1")
    check(set(enum(document, "kind")) == {"draft", "user", "assistant", "tool", "system", "annotation"}, "message revision kind vocabulary drifted")
    check(
        set(enum(document, "effect"))
        == {"edit-draft", "replace-queued", "edit-as-branch", "replay-historical", "retry-current-state", "selected-delta-retry", "annotation-or-correction"},
        "message revision effect vocabulary drifted",
    )
    check(document.get("properties", {}).get("sourceCursor", {}).get("minimum") == 0, "message revision source cursor must be non-negative")
    return {"schemaVersion": 1, "kinds": 6, "effects": 7, "closedObject": True}


def verify_state_graph(document: dict[str, Any]) -> dict[str, Any]:
    path = STATE_GRAPH_PATH
    definitions = document.get("$defs", {})
    check(isinstance(definitions, dict), "state graph $defs must be an object")
    state_base = definitions.get("stateBase")
    check(isinstance(state_base, dict), "canonical stateBase definition is missing")
    check(state_base.get("type") == "object", "stateBase definition must be an object")
    check(state_base.get("additionalProperties") is False, "stateBase must reject unknown properties")
    base_props = state_base.get("properties", {})
    check(set(base_props.get("mode", {}).get("enum", [])) == STATE_BASE_MODES, "stateBase mode vocabulary drifted")
    required_fields = set(state_base.get("required", []))
    check(
        {
            "mode",
            "sourceStateRevisionId",
            "requestedHeadStateRevisionId",
            "resolvedStateRevisionId",
            "resolvedStateDigest",
            "selectedDeltaIds",
            "contextManifestId",
            "resolutionReason",
            "resolvedAt",
            "resolvedAtCursors",
        }
        <= required_fields,
        "stateBase required identity/resolution fields drifted",
    )
    return {"stateBaseModes": len(STATE_BASE_MODES), "requiredIdentityFields": len(required_fields), "closedObject": True}


def verify() -> dict[str, Any]:
    operation = load(OPERATION_PATH)
    checkpoint = load(CHECKPOINT_PATH)
    continuation = load(CONTINUATION_PATH)
    message_revision = load(MESSAGE_REVISION_PATH)
    state_graph = load(STATE_GRAPH_PATH)
    return {
        "sourceDate": "2026-09-11",
        "schemas": {
            OPERATION_PATH.name: verify_operation(operation),
            CHECKPOINT_PATH.name: verify_checkpoint(checkpoint),
            CONTINUATION_PATH.name: verify_continuation(continuation),
            MESSAGE_REVISION_PATH.name: verify_message_revision(message_revision),
            STATE_GRAPH_PATH.name: verify_state_graph(state_graph),
        },
        "nativeRuntime": "not-tested-by-this-probe",
        "redactionPropertyScan": True,
    }


def main() -> int:
    try:
        result = verify()
    except VerificationError as error:
        print(f"RUN_CONTROL_SCHEMA_VERIFY: FAIL: {error}", file=sys.stderr)
        return 1
    print("RUN_CONTROL_SCHEMA_VERIFY: PASS")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
