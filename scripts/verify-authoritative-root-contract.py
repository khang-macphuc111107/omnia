"""Static contract guard for native authoritative goal/task/workflow roots.

The v16/v17 SQLite schema already defines authoritative goal, task, task
dependency, and starter-workflow rows.  This verifier protects the next
boundary: those rows must be created, revised, listed, and transitioned by a
native receipt-backed API rather than by renderer-generated IDs or direct
renderer SQL.

The native root API is intentionally allowed to be pending while the storage
and continuation contracts are being built.  The default mode therefore
checks the schema and reports missing native capabilities without failing the
existing CI.  Once the API is implemented, CI should invoke:

    python scripts/verify-authoritative-root-contract.py --require-api

``--require-api`` fails when any required capability is absent, is not
registered in ``tauri::generate_handler!``, or is implemented as an obvious
renderer/direct-SQL bypass.  This is static evidence only; Rust compilation,
SQLite runtime behavior, and packaged Windows IPC remain separate gates.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, NoReturn


ROOT = Path(__file__).resolve().parents[1]
NATIVE_ROOT = ROOT / "src-tauri" / "src"
NATIVE_LIB = NATIVE_ROOT / "lib.rs"
SCHEMA = ROOT / "docs" / "storage-schema.sql"
RENDERER_ROOT = ROOT / "src"

ROOT_TABLES = (
    "goals",
    "goal_revisions",
    "tasks",
    "task_revisions",
    "task_dependencies",
    "starter_workflows",
    "starter_workflow_revisions",
)

# Every trigger in the v16/v17 root schema is part of the storage contract.
# Keeping this list complete is intentional: checking only the most visible
# immutable triggers would allow a migration to silently lose a scope guard,
# revision-pointer guard, or state-anchor guard while the verifier continued to
# report a green result.
ROOT_TRIGGERS = (
    # v16 root identity, scope, lifecycle and revision lineage guards.
    "goals_scope_guard_insert",
    "goals_current_revision_insert_guard",
    "goals_scope_guard_update",
    "goals_current_revision_guard",
    "goals_immutable_delete_guard",
    "goal_revisions_scope_guard_insert",
    "goal_revisions_immutable_update",
    "goal_revisions_immutable_delete",
    "tasks_scope_guard_insert",
    "tasks_current_revision_insert_guard",
    "tasks_scope_guard_update",
    "tasks_current_revision_guard",
    "tasks_immutable_delete_guard",
    "task_revisions_scope_guard_insert",
    "task_revisions_immutable_update",
    "task_revisions_immutable_delete",
    "task_dependencies_scope_guard_insert",
    "task_dependencies_immutable_update",
    "task_dependencies_immutable_delete",
    "starter_workflows_scope_guard_insert",
    "starter_workflows_current_revision_insert_guard",
    "starter_workflows_scope_guard_update",
    "starter_workflows_current_revision_guard",
    "starter_workflows_immutable_delete_guard",
    "starter_workflow_revisions_scope_guard_insert",
    "starter_workflow_revisions_immutable_update",
    "starter_workflow_revisions_immutable_delete",
    # v17 exact profile/conversation/branch state-anchor guards.
    "goals_state_revision_scope_guard_insert",
    "goals_state_revision_scope_guard_update",
    "goal_revisions_state_revision_scope_guard_insert",
    "tasks_state_revision_scope_guard_insert",
    "tasks_state_revision_scope_guard_update",
    "task_revisions_state_revision_scope_guard_insert",
    "starter_workflows_state_revision_scope_guard_insert",
    "starter_workflows_state_revision_scope_guard_update",
    "starter_workflow_revisions_state_revision_scope_guard_insert",
)

# v18 adds the shared native receipt address used by all authoritative-root
# mutations.  It is kept separate from ROOT_TRIGGERS so the legacy v16/v17
# trigger count remains useful when diagnosing a migration regression.
ROOT_RECEIPT_TABLE = "authoritative_root_mutation_receipts"
ROOT_RECEIPT_TRIGGERS = (
    "authoritative_root_receipts_scope_guard_insert",
    "authoritative_root_receipts_immutable_update",
    "authoritative_root_receipts_immutable_delete",
)

# v19 tightens the immutable task-dependency insertion boundary.  The trigger
# name already appears in ROOT_TRIGGERS because it is a v16 identity/scope
# guard, but the v19 migration replaces its body with terminal-task checks.
# Keep those semantic checks explicit here so a future migration cannot retain
# only the old same-scope/cycle guard while silently dropping terminal source
# or target rejection.
ROOT_DEPENDENCY_V19_TRIGGER = "task_dependencies_scope_guard_insert"
ROOT_DEPENDENCY_V19_MARKER = "-- Omnia schema v19: terminal task dependency insertion guards."

# These fragments are deliberately structural rather than formatting-sensitive
# SQL parsers. They catch a table being recreated without one of the fields
# needed by the native DTO/receipt contract while remaining stable across
# harmless whitespace or comment changes.
ROOT_COLUMN_CONTRACTS: dict[str, tuple[str, ...]] = {
    "goals": (
        "id TEXT PRIMARY KEY",
        "profile_id TEXT NOT NULL",
        "project_id TEXT",
        "conversation_id TEXT",
        "branch_id TEXT",
        "current_revision_id TEXT",
        "state_revision_id TEXT",
        "status TEXT NOT NULL",
        "canonical_payload_sha256 TEXT NOT NULL",
        "created_at_ms INTEGER NOT NULL",
        "updated_at_ms INTEGER NOT NULL",
        "deleted_at_ms INTEGER",
    ),
    "goal_revisions": (
        "revision_id TEXT PRIMARY KEY",
        "goal_id TEXT NOT NULL",
        "revision_no INTEGER NOT NULL",
        "payload_json TEXT NOT NULL",
        "content_sha256 TEXT NOT NULL",
        "state_revision_id TEXT",
        "created_at_ms INTEGER NOT NULL",
    ),
    "tasks": (
        "id TEXT PRIMARY KEY",
        "profile_id TEXT NOT NULL",
        "goal_id TEXT NOT NULL",
        "project_id TEXT",
        "conversation_id TEXT",
        "branch_id TEXT",
        "current_revision_id TEXT",
        "state_revision_id TEXT",
        "status TEXT NOT NULL",
        "canonical_payload_sha256 TEXT NOT NULL",
        "created_at_ms INTEGER NOT NULL",
        "updated_at_ms INTEGER NOT NULL",
        "deleted_at_ms INTEGER",
    ),
    "task_revisions": (
        "revision_id TEXT PRIMARY KEY",
        "task_id TEXT NOT NULL",
        "revision_no INTEGER NOT NULL",
        "payload_json TEXT NOT NULL",
        "content_sha256 TEXT NOT NULL",
        "state_revision_id TEXT",
        "created_at_ms INTEGER NOT NULL",
    ),
    "task_dependencies": (
        "id TEXT PRIMARY KEY",
        "profile_id TEXT NOT NULL",
        "from_task_id TEXT NOT NULL",
        "to_task_id TEXT NOT NULL",
        "dependency_kind TEXT NOT NULL",
        "created_at_ms INTEGER NOT NULL",
    ),
    "starter_workflows": (
        "id TEXT PRIMARY KEY",
        "profile_id TEXT NOT NULL",
        "project_id TEXT",
        "conversation_id TEXT",
        "branch_id TEXT",
        "current_revision_id TEXT",
        "state_revision_id TEXT",
        "status TEXT NOT NULL",
        "enabled INTEGER NOT NULL",
        "canonical_payload_sha256 TEXT NOT NULL",
        "created_at_ms INTEGER NOT NULL",
        "updated_at_ms INTEGER NOT NULL",
        "deleted_at_ms INTEGER",
    ),
    "starter_workflow_revisions": (
        "revision_id TEXT PRIMARY KEY",
        "starter_workflow_id TEXT NOT NULL",
        "revision_no INTEGER NOT NULL",
        "definition_json TEXT NOT NULL",
        "content_sha256 TEXT NOT NULL",
        "state_revision_id TEXT",
        "created_at_ms INTEGER NOT NULL",
    ),
}

ROOT_RECEIPT_COLUMN_CONTRACT = (
    "receipt_id TEXT PRIMARY KEY",
    "profile_id TEXT NOT NULL",
    "idempotency_key_hash TEXT NOT NULL",
    "root_kind TEXT NOT NULL",
    "operation_kind TEXT NOT NULL",
    "root_id TEXT NOT NULL",
    "revision_id TEXT",
    "canonical_payload_sha256 TEXT NOT NULL",
    "scope_json TEXT NOT NULL",
    "result_json TEXT NOT NULL",
    "receipt_sha256 TEXT NOT NULL",
    "created_at_ms INTEGER NOT NULL",
)


@dataclass(frozen=True)
class CommandContract:
    """Exact native command/storage pair required by one root capability."""

    command: str
    storage_method: str


@dataclass(frozen=True)
class Capability:
    """One root API capability and its exact native command contracts.

    This deliberately avoids deriving capability membership from substrings.
    A broader command (for example ``task_dependency_create``) must never be
    allowed to satisfy the distinct ``task_create`` capability merely because
    both names contain ``task`` and ``create``.
    """

    key: str
    commands: tuple[CommandContract, ...]


@dataclass(frozen=True)
class CommandDefinition:
    """One active production command definition and its bounded body.

    The verifier is intentionally source based, but command identity must be
    established from the same declaration that is checked for delegation.  A
    set of names is not sufficient: it loses duplicate declarations and can
    let an inactive/test-only declaration satisfy an active API contract.
    """

    name: str
    parameters: str
    body: str | None


CAPABILITIES = (
    Capability("goal.create", (CommandContract("goal_create", "create_goal"),)),
    Capability("goal.read", (CommandContract("goal_read", "read_goal"),)),
    Capability("goal.list", (CommandContract("goal_list", "list_goals"),)),
    Capability(
        "goal.revision_read",
        (CommandContract("goal_revision_read", "read_goal_revision"),),
    ),
    Capability(
        "goal.revision_create",
        (CommandContract("goal_revision_create", "create_goal_revision"),),
    ),
    Capability("goal.lifecycle", (CommandContract("goal_status_update", "update_goal_status"),)),
    Capability("task.create", (CommandContract("task_create", "create_task"),)),
    Capability("task.read", (CommandContract("task_read", "read_task"),)),
    Capability("task.list", (CommandContract("task_list", "list_tasks"),)),
    Capability(
        "task.revision_read",
        (CommandContract("task_revision_read", "read_task_revision"),),
    ),
    Capability(
        "task.revision_create",
        (CommandContract("task_revision_create", "create_task_revision"),),
    ),
    Capability(
        "task.dependency_create",
        (CommandContract("task_dependency_create", "create_task_dependency"),),
    ),
    Capability(
        "task.dependency_list",
        (CommandContract("task_dependency_list", "list_task_dependencies"),),
    ),
    Capability("task.lifecycle", (CommandContract("task_status_update", "update_task_status"),)),
    Capability(
        "starter_workflow.create",
        (CommandContract("starter_workflow_create", "create_starter_workflow"),),
    ),
    Capability(
        "starter_workflow.read",
        (CommandContract("starter_workflow_read", "read_starter_workflow"),),
    ),
    Capability(
        "starter_workflow.list",
        (CommandContract("starter_workflow_list", "list_starter_workflows"),),
    ),
    Capability(
        "starter_workflow.revision_read",
        (
            CommandContract(
                "starter_workflow_revision_read",
                "read_starter_workflow_revision",
            ),
        ),
    ),
    Capability(
        "starter_workflow.revision_create",
        (
            CommandContract(
                "starter_workflow_revision_create",
                "create_starter_workflow_revision",
            ),
        ),
    ),
    Capability(
        "starter_workflow.lifecycle",
        (
            CommandContract("starter_workflow_status_update", "update_starter_workflow_status"),
            CommandContract("starter_workflow_enabled_update", "update_starter_workflow_enabled"),
        ),
    ),
)


def fail(message: str) -> NoReturn:
    raise AssertionError(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        fail(f"unable to read {path.relative_to(ROOT)}: {error}")


def parse_registered_commands(source: str) -> set[str]:
    """Parse the single active ``generate_handler!`` registration.

    This remains a bounded source check rather than a Rust parser. Masking
    comments and literals is nevertheless important: a commented-out command
    must not make an otherwise unregistered native endpoint look reachable.
    Multiple active registrations and duplicate entries fail closed instead of
    being silently merged into a set.  The application has one production
    core handler; accepting only that one block prevents a test/secondary
    handler from laundering registration evidence for the authoritative API.
    """

    masked = mask_rust_non_code(source)
    inactive_ranges = _inactive_cfg_ranges(masked)
    macro_pattern = re.compile(r"\btauri::generate_handler!\s*\[")
    active_blocks: list[tuple[int, int]] = []
    for match in macro_pattern.finditer(masked):
        if _position_in_ranges(match.start(), inactive_ranges):
            continue
        attributes = _attribute_block_before(masked, match.start())
        if any(
            _cfg_expression_is_inactive(cfg.group("expression"))
            for cfg in re.finditer(
                r"#\s*\[\s*cfg\s*\(\s*(?P<expression>[^\]]*)\)\s*\]",
                attributes,
            )
        ):
            continue
        open_bracket = match.end() - 1
        close_bracket = _balanced_delimiter_end(masked, open_bracket, "[", "]")
        check(
            close_bracket is not None,
            "unterminated tauri::generate_handler! registration",
        )
        active_blocks.append((open_bracket, close_bracket))

    check(active_blocks, "src-tauri/src/lib.rs is missing generate_handler")
    check(
        len(active_blocks) == 1,
        "src-tauri/src/lib.rs must contain exactly one active generate_handler registration",
    )
    open_bracket, close_bracket = active_blocks[0]
    registered: set[str] = set()
    body = masked[open_bracket + 1 : close_bracket]
    entries = body.split(",")
    for index, raw_entry in enumerate(entries):
        line = raw_entry.strip()
        if not line and index == len(entries) - 1:
            continue
        check(line, "empty entry in tauri::generate_handler registration")
        command = re.fullmatch(r"(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)", line)
        check(command is not None, f"unable to parse registered command entry: {line}")
        command_name = command.group(1)
        check(
            command_name not in registered,
            f"duplicate registered command entry: {command_name}",
        )
        registered.add(command_name)
    return registered


def mask_rust_non_code(source: str) -> str:
    """Mask comments and literals while preserving indices and newlines.

    This verifier is intentionally source-based rather than a Rust parser, but
    it must not accept a fake ``#[tauri::command]`` in a comment/string or let
    braces inside a literal corrupt bounded function-body extraction.  Rust
    block comments may nest, and raw strings can contain arbitrary comment
    markers/braces, so a pair of non-nesting regular expressions is not enough
    here.  The small scanner below deliberately handles only the lexical
    constructs relevant to this source-shape check, while preserving line
    positions and leaving executable identifiers/calls intact.
    """

    def blank_range(buffer: list[str], start: int, end: int) -> None:
        """Blank ``source[start:end]`` while retaining newline positions."""

        for position in range(start, end):
            if source[position] != "\n":
                buffer[position] = " "

    def raw_string_end(start: int) -> int | None:
        """Return the exclusive end of a Rust raw/byte-raw string."""

        cursor = start
        if source.startswith("br", cursor):
            cursor += 2
        elif source.startswith("r", cursor):
            cursor += 1
        else:
            return None

        hashes = 0
        while cursor < len(source) and source[cursor] == "#":
            hashes += 1
            cursor += 1
        if cursor >= len(source) or source[cursor] != '"':
            return None

        opener_end = cursor + 1
        closing = '"' + ("#" * hashes)
        terminator = source.find(closing, opener_end)
        if terminator < 0:
            # An unterminated raw literal consumes the remainder.  Failing
            # closed is safer than allowing command-shaped text inside it to
            # become false production evidence.
            return len(source)
        return terminator + len(closing)

    def normal_string_end(start: int) -> int | None:
        """Return the exclusive end of a normal/byte string literal."""

        cursor = start
        if cursor < len(source) and source[cursor] == "b":
            cursor += 1
        if cursor >= len(source) or source[cursor] != '"':
            return None
        cursor += 1
        while cursor < len(source):
            character = source[cursor]
            if character == "\\":
                # Escape pairs are opaque to the lightweight scanner.  A
                # trailing backslash is still consumed and the literal then
                # fails closed at EOF.
                cursor += 2
                continue
            if character == '"':
                return cursor + 1
            cursor += 1
        return len(source)

    def char_literal_end(start: int) -> int | None:
        """Recognise a Rust char literal without swallowing lifetimes."""

        if source[start] != "'" or start + 2 >= len(source):
            return None
        cursor = start + 1
        if source[cursor] == "\\":
            cursor += 1
            if cursor >= len(source) or source[cursor] in "\r\n":
                return None
            if source[cursor] == "u" and cursor + 1 < len(source) and source[cursor + 1] == "{":
                cursor += 2
                while cursor < len(source) and source[cursor] != "}":
                    if source[cursor] in "\r\n":
                        return None
                    cursor += 1
                if cursor >= len(source):
                    return None
                cursor += 1
            elif source[cursor] == "x":
                cursor += 1
                for _ in range(2):
                    if cursor < len(source) and source[cursor] not in "\r\n":
                        cursor += 1
            else:
                cursor += 1
        else:
            if source[cursor] in "\r\n" or source[cursor] == "'":
                return None
            cursor += 1
        if cursor < len(source) and source[cursor] == "'":
            return cursor + 1
        return None

    masked = list(source)
    cursor = 0
    length = len(source)
    while cursor < length:
        if source.startswith("//", cursor):
            end = source.find("\n", cursor + 2)
            if end < 0:
                end = length
            blank_range(masked, cursor, end)
            cursor = end
            continue

        if source.startswith("/*", cursor):
            start = cursor
            cursor += 2
            depth = 1
            while cursor < length and depth:
                if source.startswith("/*", cursor):
                    depth += 1
                    cursor += 2
                elif source.startswith("*/", cursor):
                    depth -= 1
                    cursor += 2
                else:
                    cursor += 1
            blank_range(masked, start, cursor)
            continue

        # Raw strings must be checked before ordinary identifiers/literals so
        # comment markers and braces in their body stay opaque.
        raw_end = raw_string_end(cursor) if source[cursor] in "rb" else None
        if raw_end is not None:
            # ``raw_string_end`` only returns a value when the current token
            # starts with r/br followed by a quote/hash delimiter.
            blank_range(masked, cursor, raw_end)
            cursor = raw_end
            continue

        normal_end = normal_string_end(cursor) if source[cursor] in '"b' else None
        if normal_end is not None:
            # Include the optional byte-string prefix in the masked range.
            blank_range(masked, cursor, normal_end)
            cursor = normal_end
            continue

        char_end = char_literal_end(cursor) if source[cursor] == "'" else None
        if char_end is not None:
            blank_range(masked, cursor, char_end)
            cursor = char_end
            continue

        cursor += 1

    return "".join(masked)


def _balanced_block_end(masked: str, open_brace: int) -> int | None:
    """Return the closing brace for a masked Rust block."""

    depth = 0
    for index in range(open_brace, len(masked)):
        character = masked[index]
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return index
    return None


def _balanced_delimiter_end(
    masked: str, opening: int, opener: str, closer: str
) -> int | None:
    """Return the matching delimiter for a masked Rust macro/group span."""

    depth = 0
    for index in range(opening, len(masked)):
        character = masked[index]
        if character == opener:
            depth += 1
        elif character == closer:
            depth -= 1
            if depth == 0:
                return index
    return None


def _split_cfg_arguments(expression: str) -> list[str] | None:
    """Split a cfg predicate's top-level comma-separated arguments.

    ``cfg`` expressions are small Rust-like predicate trees.  A regular
    expression that only recognises ``any()``/``all()`` misses definitely
    inactive combinations such as ``all(any(), feature = \"native\")``.
    This bounded splitter deliberately understands only delimiter nesting;
    literals/comments have already been masked by :func:`mask_rust_non_code`.
    Returning ``None`` on malformed nesting keeps the source-only verifier
    fail-open for expressions it cannot prove inactive.
    """

    if not expression:
        return []
    parts: list[str] = []
    start = 0
    depth = 0
    opening = {"(": ")", "[": "]", "{": "}"}
    closing = {value: key for key, value in opening.items()}
    stack: list[str] = []
    for index, character in enumerate(expression):
        if character in opening:
            stack.append(opening[character])
            depth += 1
            continue
        if character in closing:
            if not stack or stack.pop() != character:
                return None
            depth -= 1
            continue
        if character == "," and depth == 0:
            argument = expression[start:index]
            if not argument:
                return None
            parts.append(argument)
            start = index + 1
    if stack or depth != 0:
        return None
    argument = expression[start:]
    if not argument:
        return None
    parts.append(argument)
    return parts


def _cfg_expression_truth(expression: str) -> bool | None:
    """Return definite truth for a masked, normalized cfg predicate.

    ``True``/``False`` are returned only when the predicate is independent of
    an unknown feature/target/environment value.  The special ``test`` atom
    is treated as false because this verifier models production command
    discovery rather than ``cfg(test)`` fixtures.  Unknown atoms deliberately
    return ``None`` so a source-only check never hides a potentially active
    production command.
    """

    if expression == "true":
        return True
    if expression in {"false", "test"}:
        return False

    predicate = re.fullmatch(r"(any|all|not)\((.*)\)", expression)
    if predicate is None:
        return None

    operator, body = predicate.groups()
    if operator == "not":
        arguments = _split_cfg_arguments(body)
        if arguments is None or len(arguments) != 1:
            return None
        nested = _cfg_expression_truth(arguments[0])
        return None if nested is None else not nested

    if not body:
        return operator == "all"
    arguments = _split_cfg_arguments(body)
    if arguments is None:
        return None
    values = [_cfg_expression_truth(argument) for argument in arguments]
    if operator == "any":
        if any(value is True for value in values):
            return True
        if all(value is False for value in values):
            return False
        return None
    if any(value is False for value in values):
        return False
    if all(value is True for value in values):
        return True
    return None


def _cfg_expression_is_inactive(expression: str) -> bool:
    """Recognise cfg forms that are definitely absent from production builds.

    Feature/target expressions remain unknown to a source-only verifier and
    therefore stay eligible.  We evaluate the small ``any``/``all``/``not``
    predicate tree only when its truth value is definite; this catches nested
    impossible forms while retaining fail-open behaviour for environment-
    dependent expressions.
    """

    normalized = re.sub(r"\s+", "", expression).lower()
    return _cfg_expression_truth(normalized) is False


def _inactive_cfg_ranges(masked: str) -> list[tuple[int, int]]:
    """Find definitely-disabled cfg modules/functions and their source spans."""

    ranges: list[tuple[int, int]] = []
    cfg_pattern = re.compile(
        r"#\s*\[\s*cfg\s*\(\s*(?P<expression>[^\]]*)\)\s*\]"
    )
    for match in cfg_pattern.finditer(masked):
        if not _cfg_expression_is_inactive(match.group("expression")):
            continue

        # Rust permits additional outer attributes between a cfg attribute
        # and the item it controls, for example:
        #
        #   #[cfg(test)]
        #   #[allow(dead_code)]
        #   mod fixtures { ... }
        #
        # Looking only for ``cfg`` immediately followed by ``mod``/``fn``
        # would leave the nested production-looking commands visible to this
        # source verifier.  Consume the complete contiguous attribute block,
        # then identify the controlled module/function declaration.
        _, declaration_start = _attribute_block_after(masked, match.end())
        declaration = re.match(
            r"\s*(?:(?:pub(?:\s*\([^)]*\))?)\s+)?"
            r"(?:unsafe\s+|async\s+)?"
            r"(?:mod|fn|trait|impl)\b[^\{]*\{",
            masked[declaration_start:],
        )
        if declaration is None:
            # Unknown cfg-controlled syntax remains eligible rather than
            # risking a false negative for a production item we do not know
            # how to bound safely.
            continue
        open_brace = declaration_start + declaration.end() - 1
        end = _balanced_block_end(masked, open_brace)
        if end is not None:
            ranges.append((match.start(), end + 1))
    return ranges


def _position_in_ranges(position: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start <= position < end for start, end in ranges)


def _attribute_block_after(masked: str, position: int) -> tuple[str, int]:
    """Read contiguous attributes/whitespace after a command attribute."""

    cursor = position
    parts: list[str] = []
    attribute = re.compile(r"\s*#\s*\[[^\]]*\]")
    while True:
        match = attribute.match(masked, cursor)
        if match is None:
            break
        parts.append(match.group(0))
        cursor = match.end()
    return "".join(parts), cursor


def _attribute_block_before(masked: str, position: int) -> str:
    """Read contiguous attribute lines immediately preceding a command."""

    prefix = masked[:position]
    # Attributes are line-oriented in Rust.  Limiting the look-back to the
    # current contiguous block avoids accidentally inheriting a cfg from an
    # unrelated declaration above a blank/non-attribute line.
    lines = prefix.splitlines(keepends=True)
    collected: list[str] = []
    for line in reversed(lines):
        stripped = line.strip()
        if not stripped:
            if collected:
                break
            continue
        if stripped.startswith("#") and stripped.endswith("]"):
            collected.append(line)
            continue
        break
    return "".join(reversed(collected))


def _command_definition_pattern() -> re.Pattern[str]:
    return re.compile(
        r"#\s*\[\s*tauri::command(?:\s*\([^\]]*\))?\s*\]"
        r"(?P<attributes>(?:\s*#\s*\[[^\]]*\])*)"
        r"\s*(?:pub\s+)?(?:async\s+)?fn\s+(?P<name>[A-Za-z_]\w*)"
        r"\s*\((?P<parameters>[^\{]*)\)\s*(?:->[^\{]+)?\{"
    )


def parse_command_definitions(source: str) -> list[CommandDefinition]:
    """Return exact active command declarations and their own bodies.

    The previous implementation returned only a set of names and extracted a
    body later by searching for the first function with that name.  That made
    a neighbouring command, test module, or inactive declaration capable of
    satisfying a different capability.  Keeping the declaration and body
    together makes every command contract independently verifiable.
    """

    masked = mask_rust_non_code(source)
    inactive_ranges = _inactive_cfg_ranges(masked)
    definitions: list[CommandDefinition] = []
    for match in _command_definition_pattern().finditer(masked):
        if _position_in_ranges(match.start(), inactive_ranges):
            continue
        preceding = _attribute_block_before(masked, match.start())
        following = match.group("attributes")
        if any(
            _cfg_expression_is_inactive(cfg.group("expression"))
            for attributes in (preceding, following)
            for cfg in re.finditer(
                r"#\s*\[\s*cfg\s*\(\s*(?P<expression>[^\]]*)\)\s*\]",
                attributes,
            )
        ):
            continue
        open_brace = match.end() - 1
        end = _balanced_block_end(masked, open_brace)
        body = masked[open_brace : end + 1] if end is not None else None
        definitions.append(
            CommandDefinition(
                match.group("name"),
                match.group("parameters"),
                body,
            )
        )
    return definitions


def command_body(source: str, command: str) -> str | None:
    """Return the body belonging to one exact active command declaration."""

    matches = [definition for definition in parse_command_definitions(source) if definition.name == command]
    if len(matches) != 1:
        return None
    return matches[0].body


def direct_storage_calls(body: str) -> list[tuple[str, int]]:
    """Return direct ``state.storage.<method>(...)`` calls and brace depth.

    A command contract is a thin IPC boundary.  Looking for a method name
    anywhere in a function body is not sufficient: ``other.state.storage``
    and a helper closure nested inside the command could otherwise donate a
    convincing-looking call.  The receiver must be the standalone command
    parameter ``state`` and the call must occur at the outer function-body
    depth (depth ``1`` because the body itself starts with ``{``).

    The command body has already passed through ``mask_rust_non_code`` before
    it reaches this helper, so braces and call-shaped text in comments or
    literals cannot create evidence.
    """

    call_pattern = re.compile(
        r"(?<![\w.:])state\s*\.\s*storage\s*\.\s*"
        r"(?P<method>[A-Za-z_]\w*)\s*\("
    )
    calls: list[tuple[str, int]] = []
    for match in call_pattern.finditer(body):
        prefix = body[: match.start()]
        depth = prefix.count("{") - prefix.count("}")
        calls.append((match.group("method"), depth))
    return calls


def command_has_standalone_state_parameter(definition: CommandDefinition) -> bool:
    """Require the command's storage receiver to be an actual ``state`` arg.

    Matching ``state.storage`` in the body alone is insufficient: a malformed
    or adversarial fixture could declare a command with no ``state`` argument
    and create a local variable named ``state``.  Rust would reject the real
    production command in most such cases, but this verifier intentionally
    runs before compilation, so the source contract must fail closed itself.
    The parameter name is intentionally exact and may be written as ``mut
    state``; the type is left to Rust's compiler because projects can use a
    type alias or a qualified ``tauri::State`` path.
    """

    return re.search(r"(?:^|,)\s*(?:mut\s+)?state\s*:", definition.parameters) is not None


def command_shadows_state(body: str) -> bool:
    """Reject obvious local bindings that could donate a fake outer call."""

    # ``body`` is already masked, so comment/string text cannot trigger these
    # checks.  A nested closure or block that binds ``state`` is rejected too:
    # fail-closed is preferable to letting a source-shape approximation infer
    # the receiver's provenance incorrectly.
    return re.search(
        r"\b(?:let|for)\s+(?:mut\s+)?state\b|"
        r"\b(?:if|while)\s+let\s+(?:Some\s*\(\s*)?state\b|"
        r"\|\s*(?:mut\s+)?state\s*(?:\||,)",
        body,
    ) is not None


def native_rust_sources() -> list[tuple[Path, str]]:
    """Read every native Rust module, not only the historical command file.

    The authoritative-root API may live in a dedicated module (for example
    ``authoritative_roots.rs``) while ``lib.rs`` registers it through a module
    path.  Restricting the audit to ``native_commands.rs`` would silently turn
    a valid implementation into a false pending result.  Reading all checked-
    in native modules keeps this verifier independent of the eventual module
    split while still limiting the scope to ``src-tauri/src``.
    """

    sources: list[tuple[Path, str]] = []
    for path in sorted(NATIVE_ROOT.rglob("*.rs")):
        try:
            sources.append((path, path.read_text(encoding="utf-8", errors="replace")))
        except OSError as error:
            fail(f"unable to read native Rust source {path.relative_to(ROOT)}: {error}")
    check(sources, "src-tauri/src contains no Rust source files")
    return sources


def schema_checks(schema: str) -> list[str]:
    findings: list[str] = []
    required_markers = (
        "-- Omnia schema v16: authoritative goals, tasks, and starter workflows.",
        "-- Omnia schema v17: authoritative-root state-anchor stream guards.",
        "-- Omnia schema v18: immutable authoritative-root mutation receipts.",
        ROOT_DEPENDENCY_V19_MARKER,
    )
    for marker in required_markers:
        check(marker in schema, f"schema marker missing: {marker}")

    for table in ROOT_TABLES:
        table_match = re.search(
            rf"CREATE TABLE\s+{re.escape(table)}\s*\((?P<body>[\s\S]*?)\n\)\s*STRICT;",
            schema,
        )
        check(table_match is not None, f"missing root table: {table}")
        table_body = table_match.group("body")
        for column in ROOT_COLUMN_CONTRACTS[table]:
            check(
                re.search(rf"\b{re.escape(column)}\b", table_body) is not None,
                f"{table} is missing authoritative column contract: {column}",
            )

    for trigger in ROOT_TRIGGERS:
        check(re.search(rf"CREATE TRIGGER\s+{re.escape(trigger)}\b", schema) is not None, f"missing root trigger: {trigger}")

    # The v19 trigger is not merely an existence marker.  Its body must retain
    # the terminal source/target guards introduced by the migration.  Search
    # only the suffix after the v19 marker because the same trigger is also
    # defined by the original v16 schema; inspecting the first definition
    # would produce a false failure even though the migration correctly
    # replaces it.
    v19_suffix = schema.rsplit(ROOT_DEPENDENCY_V19_MARKER, 1)[-1]
    dependency_trigger = re.search(
        rf"CREATE TRIGGER\s+{re.escape(ROOT_DEPENDENCY_V19_TRIGGER)}\b[\s\S]*?\nEND;",
        v19_suffix,
    )
    check(dependency_trigger is not None, "missing v19 task dependency insertion trigger body")
    dependency_body = dependency_trigger.group(0)
    check(
        "task dependency source is terminal" in dependency_body,
        "v19 task dependency trigger is missing terminal source guard",
    )
    check(
        "task dependency target is terminal" in dependency_body,
        "v19 task dependency trigger is missing terminal target guard",
    )
    check(
        "source.status IN ('completed', 'cancelled', 'archived')" in dependency_body,
        "v19 task dependency trigger does not enumerate terminal source statuses",
    )
    check(
        "target.status IN ('completed', 'cancelled', 'archived')" in dependency_body,
        "v19 task dependency trigger does not enumerate terminal target statuses",
    )

    receipt_match = re.search(
        rf"CREATE TABLE\s+{re.escape(ROOT_RECEIPT_TABLE)}\s*\((?P<body>[\s\S]*?)\n\)\s*STRICT;",
        schema,
    )
    check(receipt_match is not None, f"missing authoritative root receipt table: {ROOT_RECEIPT_TABLE}")
    receipt_body = receipt_match.group("body")
    for column in ROOT_RECEIPT_COLUMN_CONTRACT:
        check(
            re.search(rf"\b{re.escape(column)}\b", receipt_body) is not None,
            f"{ROOT_RECEIPT_TABLE} is missing receipt column contract: {column}",
        )
    for trigger in ROOT_RECEIPT_TRIGGERS:
        check(
            re.search(rf"CREATE TRIGGER\s+{re.escape(trigger)}\b", schema) is not None,
            f"missing authoritative root receipt trigger: {trigger}",
        )
    check(
        re.search(
            r"UNIQUE\s*\(\s*profile_id\s*,\s*idempotency_key_hash\s*,\s*root_kind\s*,\s*operation_kind\s*\)",
            receipt_body,
        )
        is not None,
        "authoritative root receipts must have a profile/idempotency/root/operation uniqueness address",
    )

    # Keep this output useful in CI logs without duplicating all object names.
    findings.append(f"schema tables={len(ROOT_TABLES)}")
    findings.append(f"schema authoritative columns={sum(len(columns) for columns in ROOT_COLUMN_CONTRACTS.values())}")
    findings.append(f"schema immutable/scope triggers={len(ROOT_TRIGGERS)}")
    findings.append(f"schema root receipt triggers={len(ROOT_RECEIPT_TRIGGERS)}")
    findings.append("schema v19 terminal dependency guards=2")
    return findings


def renderer_direct_sql_findings() -> list[str]:
    """Bounded literal scan, not a JavaScript/SQL parser or data-flow analysis.

    Inspect each renderer string/template separately so JSX, comments and
    unrelated literals cannot donate SQL keywords to one another. Dynamic SQL
    assembled across literals/interpolations is outside this static check.
    SELECT projections recognize stars, comma-separated identifiers, explicit
    AS aliases and simple function calls. Implicit aliases/complex expressions
    are outside this heuristic subset, avoiding multiword UI prose as SQL.
    """

    findings: list[str] = []
    renderer_tokens = re.compile(
        r"(?P<comment>//[^\r\n]*|/\*[\s\S]*?\*/)"
        r"|(?P<literal>'(?:\\[\s\S]|[^'\\])*'"
        r'|"(?:\\[\s\S]|[^"\\])*"'
        r"|`(?:\\[\s\S]|[^`\\])*`)"
    )
    names = "|".join(map(re.escape, ROOT_TABLES))
    root_identifier = (
        rf'(?:"(?:{names})"|`(?:{names})`|\[(?:{names})\]'
        rf'|(?:{names})(?![\w$]))'
    )
    identifier = r'(?:"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\w$]+)'
    table = rf"(?:{identifier}\s*\.\s*)?{root_identifier}(?!\s*\.)"
    conflict = r"(?:OR\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE)\s+)?"
    # Require SQL-shaped projections, not arbitrary prose before FROM. In
    # particular, implicit aliases are intentionally excluded: "a goal" is
    # indistinguishable from UI copy without a full parser/call-site analysis.
    column = rf"{identifier}(?:\s*\.\s*(?:{identifier}|\*))*"
    function = rf"{identifier}\s*\([^;()]{{0,80}}\)"
    projection = rf"(?:{function}|{column}|\*)(?:\s+AS\s+{identifier})?"
    select = (
        r"\bSELECT\s+(?=[^;]{0,240}?\bFROM\b)(?:(?:DISTINCT|ALL)\s+)?"
        + projection + rf"(?:\s*,\s*{projection})*\s+FROM\s+"
        + rf"(?:{table}|[^;]{{0,240}}?\bJOIN\s+{table})"
    )
    statement = re.compile(
        select
        + r"|\bINSERT\s+" + conflict + r"INTO\s+" + table
        + r"|\bREPLACE\s+INTO\s+" + table
        + r"|\bUPDATE\s+" + conflict + table + r"\s+SET\b"
        + r"|\bDELETE\s+FROM\s+" + table,
        re.IGNORECASE,
    )
    # Preserve quoted identifiers, but mask SQL comments and string values.
    # Keeping newlines makes source-line diagnostics stable after masking.
    sql_tokens = re.compile(
        r"--[^\r\n]*|/\*[\s\S]*?\*/|'(?:''|[^'])*'"
        r'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]'
    )

    def mask_sql_token(match: re.Match[str]) -> str:
        token = match.group()
        if token.startswith(("--", "/*", "'")):
            return re.sub(r"[^\r\n]", " ", token)
        # A semicolon inside an identifier is not a statement boundary.
        return token.replace(";", " ")

    for path in RENDERER_ROOT.rglob("*"):
        if path.suffix not in {".ts", ".tsx", ".js", ".jsx"} or not path.is_file():
            continue
        source = path.read_text(encoding="utf-8", errors="replace")
        for token in renderer_tokens.finditer(source):
            if token.group("literal") is None:
                continue
            raw_sql = token.group("literal")[1:-1]
            # Decode relevant JS escapes once, retaining source offsets so an
            # escaped newline does not shift the reported renderer line.
            escapes = {"n": "\n", "r": "\r", "t": "\t", "'": "'", '"': '"', "`": "`", "\\": "\\"}
            parts: list[str] = []
            offsets: list[int] = []
            for piece in re.finditer(r"\\[\s\S]|[^\\]+", raw_sql):
                value = piece.group()
                if value.startswith("\\") and value[1:] in escapes:
                    parts.append(escapes[value[1:]])
                    offsets.append(piece.start())
                else:
                    parts.append(value)
                    offsets.extend(range(piece.start(), piece.end()))
            sql = sql_tokens.sub(mask_sql_token, "".join(parts))
            for match in statement.finditer(sql):
                line = source.count("\n", 0, token.start() + 1 + offsets[match.start()]) + 1
                findings.append(f"{path.relative_to(ROOT)}:{line}: renderer SQL references authoritative root table")
    return findings


def find_capability_commands(native_source: str, capability: Capability) -> set[str]:
    """Return only exact command names declared by the capability contract."""
    definitions = {definition.name for definition in parse_command_definitions(native_source)}
    return {
        contract.command
        for contract in capability.commands
        if contract.command in definitions
    }


def api_checks(native_sources: list[tuple[Path, str]], lib_source: str, require_api: bool) -> tuple[list[str], list[str]]:
    registered = parse_registered_commands(lib_source)
    parsed_sources = [
        (path, parse_command_definitions(source)) for path, source in native_sources
    ]
    passed: list[str] = []
    missing: list[str] = []

    for capability in CAPABILITIES:
        resolved: list[str] = []
        capability_failed = False
        for contract in capability.commands:
            command = contract.command
            definitions = [
                (path, definition)
                for path, source_definitions in parsed_sources
                for definition in source_definitions
                if definition.name == command
            ]
            if not definitions:
                missing.append(
                    f"{capability.key}: missing native #[tauri::command] {command}"
                )
                capability_failed = True
                continue
            if len(definitions) != 1:
                locations = ", ".join(path.relative_to(ROOT).as_posix() for path, _ in definitions)
                missing.append(
                    f"{capability.key}: command {command} has {len(definitions)} active definitions ({locations})"
                )
                capability_failed = True
                continue
            if command not in registered:
                missing.append(f"{capability.key}: command {command} is not registered")
                capability_failed = True
                continue
            body = definitions[0][1].body
            if body is None:
                missing.append(f"{capability.key}: unable to extract body for command {command}")
                capability_failed = True
                continue
            definition = definitions[0][1]
            if not command_has_standalone_state_parameter(definition):
                missing.append(
                    f"{capability.key}: {command} must declare a standalone state parameter"
                )
                capability_failed = True
                continue
            if command_shadows_state(body):
                missing.append(
                    f"{capability.key}: {command} shadows the native state receiver"
                )
                capability_failed = True
                continue
            storage_calls = direct_storage_calls(body)
            expected_calls = [
                (method, depth)
                for method, depth in storage_calls
                if method == contract.storage_method
            ]
            if expected_calls != [(contract.storage_method, 1)]:
                missing.append(
                    f"{capability.key}: {command} does not delegate to state.storage.{contract.storage_method}"
                )
                capability_failed = True
                continue
            if storage_calls != [(contract.storage_method, 1)]:
                methods = ", ".join(
                    f"{method}@depth{depth}" for method, depth in storage_calls
                )
                missing.append(
                    f"{capability.key}: {command} contains additional or nested storage calls ({methods})"
                )
                capability_failed = True
                continue
            if re.search(r"\b(?:execute|execute_batch|query_row|prepare)\s*\(", body):
                missing.append(
                    f"{capability.key}: {command} contains direct SQL instead of storage delegation"
                )
                capability_failed = True
                continue
            resolved.append(command)
        if not capability_failed:
            passed.append(f"{capability.key}={','.join(resolved)}")

    if not require_api:
        return passed, missing
    return passed, missing


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-api",
        action="store_true",
        help="fail when any native root capability is missing or bypasses registration/storage",
    )
    args = parser.parse_args()

    schema = read(SCHEMA)
    native_sources = native_rust_sources()
    lib_source = read(NATIVE_LIB)

    try:
        schema_findings = schema_checks(schema)
        passed, missing = api_checks(native_sources, lib_source, args.require_api)
        renderer_findings = renderer_direct_sql_findings()
        if renderer_findings:
            missing.extend(renderer_findings)
        if args.require_api and missing:
            fail("; ".join(missing))
    except AssertionError as error:
        print(f"AUTHORITATIVE_ROOT_CONTRACT: FAIL: {error}", file=sys.stderr)
        return 1

    print("AUTHORITATIVE_ROOT_CONTRACT: PASS (" + ", ".join(schema_findings) + ")")
    if passed:
        print("native capabilities: " + "; ".join(passed))
    if missing:
        print("native capabilities pending: " + "; ".join(missing))
        print("run with --require-api after native root CRUD/revision APIs land")
    else:
        print("native capabilities: all required root API capabilities detected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
