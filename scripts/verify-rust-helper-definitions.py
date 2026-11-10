"""Static guard for native storage helper and method definitions.

This repository is also developed on machines that do not have the Rust
toolchain installed.  The native storage module therefore needs a small,
dependency-free check that catches a particularly expensive failure mode:
call sites for checkpoint/continuation/message-revision or authoritative-root
helpers landing before their definitions are merged.  It also catches a
second expensive failure mode on toolchain-less hosts: two public ``Storage``
methods with the same name being merged into one ``impl`` block.

This is intentionally narrower than a Rust compiler.  It does not attempt to
parse Rust or prove type-checking; it only verifies that the helpers required
by the v15 run-control storage boundary exist exactly once under
``src-tauri/src`` and that the Goal/Task/Starter Workflow list methods use
their own limit constants.  ``cargo check`` remains authoritative when
available.

Run from the repository root with::

    python scripts/verify-rust-helper-definitions.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUST_ROOT = ROOT / "src-tauri" / "src"

# Keep this list explicit and reviewable.  These names form the storage-side
# integrity boundary for the durable v15 run-control tables.  If a helper is
# intentionally removed, update this manifest and its callers in one change.
REQUIRED_HELPERS = (
    # Checkpoints.
    "checkpoint_status_wire",
    "checkpoint_disposition_wire",
    "validate_partial_output_policy",
    "validate_provider_acceptance",
    "validate_nonnegative_optional",
    "validate_content_hash",
    "validate_optional_run_control_text",
    "stored_checkpoint_from_row",
    "decode_checkpoint_row",
    "checkpoint_matches_request",
    # Continuation intents.
    "validate_continuation_root_kind",
    "validate_continuation_intent_kind",
    "validate_execution_mode",
    "validate_continuation_intent_execution_mode",
    "continuation_intent_execution_mode_conflicts",
    "validate_effort",
    "normalize_opaque_id_list",
    "normalize_continuation_budget",
    "normalize_loop_guard",
    "continuation_payload_hash",
    "continuation_budget_json",
    "continuation_loop_guard_json",
    "stored_continuation_intent_from_row",
    "decode_continuation_intent_row",
    "continuation_intent_matches",
    "ensure_continuation_root",
    # Message revisions.
    "validate_message_revision_kind",
    "message_revision_effect_wire",
    "validate_message_revision_effect",
    "stored_message_revision_from_row",
    "decode_message_revision_row",
    "message_revision_matches",
    # Shared run/scope/time helpers.
    "load_run_scope",
    "ensure_state_revision_scope",
    "timestamp_rfc3339",
)

# Goal authority has a larger canonicalisation/receipt surface than the v15
# run-control helpers above.  Keep the list explicit so a partial merge cannot
# silently leave two active implementations (or remove the one used by the
# public Goal API) while the host is missing ``cargo``.
GOAL_HELPERS = (
    "goal_revision_from_row",
    "goal_summary_from_row",
    "validate_goal_summary_record",
    "json_value_contains_nul",
    "normalize_goal_json_component",
    "canonical_json_component",
    "canonicalize_goal_payload",
    "normalize_goal_payload_fields",
    "normalize_goal_payload_json",
    "canonical_goal_payload_json",
    "validate_goal_status",
    "validate_goal_status_transition",
    "validate_goal_scope",
    "canonical_goal_scope_json",
    "load_goal_mutation_receipt",
    "canonical_goal_receipt_material_json",
    "validate_goal_mutation_receipt",
    "persist_goal_mutation_receipt",
    "load_goal_snapshot_for_revision",
    "validate_goal_revision_record",
)

# Task and starter-workflow authority was added after the Goal API.  Keep this
# list explicit even though the current implementation lives in ``storage.rs``:
# a future split into dedicated modules must not silently drop a helper or
# leave a call site pointing at a stale name.  These are the exact helper names
# used by the native Storage methods; functions such as
# ``canonical_root_scope_json`` and the receipt helpers are listed separately
# as shared-root helpers below.
TASK_HELPERS = (
    "task_revision_from_row",
    "task_summary_from_row",
    "task_dependency_from_row",
    "validate_task_summary_record",
    "validate_task_dependency_record",
    "normalize_task_payload_fields",
    "normalize_task_payload_json",
    "validate_task_status",
    "validate_task_status_transition",
    "validate_task_scope",
    "validate_task_scope_filters",
    "load_task_snapshot_for_revision",
    "load_task_dependency_endpoint",
    "validate_task_dependency_kind",
)

WORKFLOW_HELPERS = (
    "workflow_revision_from_row",
    "workflow_summary_from_row",
    "validate_workflow_summary_record",
    "normalize_workflow_payload_fields",
    "normalize_workflow_definition",
    "canonicalize_workflow_payload",
    "load_workflow_snapshot",
    "validate_workflow_status",
    "validate_workflow_status_transition",
    "workflow_payload_json_from_snapshot",
)

SHARED_ROOT_HELPERS = (
    "canonical_root_scope_json",
    "validate_root_scope",
    "load_root_mutation_receipt",
    "validate_root_mutation_receipt",
    "persist_root_mutation_receipt",
)

# List bounds are part of the native API contract.  Keep this mapping close to
# the helper-definition guard so an accidental cross-entity limit copy/paste is
# caught on toolchain-less hosts before it reaches a Rust build.
LIST_METHOD_LIMITS = {
    "list_goals": "MAX_GOAL_LIST_LIMIT",
    "list_tasks": "MAX_TASK_LIST_LIMIT",
    "list_starter_workflows": "MAX_STARTER_WORKFLOW_LIST_LIMIT",
}


def strip_quarantined_legacy_goal_block(source: str) -> str:
    """Remove the intentionally disabled legacy Goal helper module.

    A stale Goal implementation is retained in ``storage.rs`` under
    ``#[cfg(any())] mod legacy_goal_helper_block`` as migration evidence.  It
    must not participate in the active-definition count: Rust excludes it from
    compilation, while a raw text scan would report every Goal helper twice.
    This function removes exactly that balanced module and leaves all other
    source text untouched, so an accidentally active duplicate still fails the
    verifier.
    """

    # Locate the attribute in lexical code only.  A raw source ``find`` can be
    # redirected by migration text embedded in a SQL/JSON/string literal and
    # then remove the wrong brace-balanced region.
    lexical_source = mask_rust_non_code(source)
    legacy_match = re.search(
        r"#\[cfg\(any\(\)\)\]\s*(?:#\[[^\n]*\]\s*)*"
        r"mod\s+legacy_goal_helper_block\b",
        lexical_source,
    )
    if legacy_match is None:
        return source
    marker_start = legacy_match.start()
    module_start = lexical_source.find("mod", marker_start, legacy_match.end())
    if module_start < 0:  # pragma: no cover - defensive regex invariant
        fail("legacy_goal_helper_block marker is malformed")
    open_brace = lexical_source.find("{", module_start)
    if open_brace < 0:
        fail("legacy_goal_helper_block is missing its opening brace")

    depth = 0
    i = open_brace
    while i < len(lexical_source):
        char = lexical_source[i]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[:marker_start] + source[i + 1 :]
        i += 1

    fail("legacy_goal_helper_block has unbalanced braces")
    return source


def fail(message: str) -> None:
    print(f"RUST_HELPER_DEFINITION_VERIFY: FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def extract_balanced_block(source: str, open_brace: int) -> str:
    """Return the balanced Rust block beginning at ``open_brace``.

    This is intentionally a small lexer rather than a Rust parser.  It skips
    strings and comments so braces in SQL/JSON literals do not terminate the
    block early.  The function is used only for a duplicate-method guard;
    ``cargo`` remains the authoritative parser/type checker.
    """

    depth = 0
    in_string = False
    escaped = False
    in_char = False
    char_escaped = False
    in_line_comment = False
    block_comment_depth = 0
    index = open_brace

    def raw_string_start(position: int) -> tuple[int, int] | None:
        """Return (quote_position, hash_count) for a Rust raw string start.

        The verifier only needs lexical shielding, not full Rust parsing.  It
        still has to understand raw strings because the native source embeds
        JSON/SQL containing braces, for example ``r#"{...}"#``.
        """

        if position >= len(source) or source[position] not in {"r", "b"}:
            return None
        cursor = position + 1
        if source[position] == "b":
            if cursor >= len(source) or source[cursor] != "r":
                return None
            cursor += 1
        hash_count = 0
        while cursor < len(source) and source[cursor] == "#":
            hash_count += 1
            cursor += 1
        if cursor < len(source) and source[cursor] == '"':
            return cursor, hash_count
        return None

    def char_literal_start(position: int) -> bool:
        """Recognize a Rust char/byte-char literal without mistaking lifetimes."""

        if position >= len(source) or source[position] != "'":
            return False
        cursor = position + 1
        if cursor >= len(source):
            return False
        if source[cursor] == "\\":
            cursor += 1
            if cursor >= len(source):
                return False
            if source[cursor] == "u" and cursor + 1 < len(source) and source[cursor + 1] == "{":
                cursor += 2
                while cursor < len(source) and source[cursor] != "}":
                    cursor += 1
                if cursor >= len(source):
                    return False
                cursor += 1
            elif source[cursor] == "x":
                # Rust hexadecimal character escapes are ``\\xNN``.
                cursor += 3
            else:
                cursor += 1
        else:
            cursor += 1
        return cursor < len(source) and source[cursor] == "'"

    while index < len(source):
        character = source[index]
        next_character = source[index + 1] if index + 1 < len(source) else ""

        if in_line_comment:
            if character == "\n":
                in_line_comment = False
            index += 1
            continue
        if block_comment_depth:
            if character == "*" and next_character == "/":
                block_comment_depth -= 1
                index += 2
                continue
            if character == "/" and next_character == "*":
                block_comment_depth += 1
                index += 2
                continue
            index += 1
            continue
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if in_char:
            if char_escaped:
                char_escaped = False
            elif character == "\\":
                char_escaped = True
            elif character == "'":
                in_char = False
            index += 1
            continue
        if character == "/" and next_character == "/":
            in_line_comment = True
            index += 2
            continue
        if character == "/" and next_character == "*":
            block_comment_depth = 1
            index += 2
            continue
        raw_start = raw_string_start(index)
        if raw_start is not None:
            quote_position, hash_count = raw_start
            closing = '"' + ("#" * hash_count)
            end = source.find(closing, quote_position + 1)
            if end < 0:
                fail("unterminated Rust raw string while checking Storage methods")
            index = end + len(closing)
            continue
        if character == '"':
            in_string = True
            index += 1
            continue
        if char_literal_start(index):
            in_char = True
            index += 1
            continue
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return source[open_brace : index + 1]
        index += 1

    fail("unterminated Rust block while checking Storage methods")
    return ""


def mask_rust_non_code(source: str) -> str:
    """Replace Rust comments and literals with spaces while preserving lines.

    The verifier intentionally is not a Rust parser, but declaration-level
    checks must not treat text inside comments, strings, chars, or raw strings
    as active code.  Every masked character is replaced by a space (newlines
    are retained), so line-anchored source checks and diagnostics keep their
    original offsets.  Unterminated lexical constructs fail closed because a
    Rust compiler would reject the same source.
    """

    output = list(source)
    index = 0
    in_line_comment = False
    block_comment_depth = 0
    in_string = False
    string_escaped = False
    in_char = False
    char_escaped = False
    raw_end: str | None = None

    def blank(start: int, end: int) -> None:
        for position in range(start, end):
            if output[position] != "\n":
                output[position] = " "

    def identifier_continue(character: str) -> bool:
        return character == "_" or character.isalnum()

    def raw_string_start(position: int) -> tuple[int, int] | None:
        if position >= len(source) or source[position] not in {"r", "b"}:
            return None
        # A raw literal prefix cannot be part of an identifier.  This avoids
        # treating arbitrary identifier text such as ``error`` as a literal
        # opener while retaining valid ``r#"..."#`` and ``br#"..."#``.
        if position > 0 and identifier_continue(source[position - 1]):
            return None
        cursor = position + 1
        if source[position] == "b":
            if cursor >= len(source) or source[cursor] != "r":
                return None
            cursor += 1
        hash_count = 0
        while cursor < len(source) and source[cursor] == "#":
            hash_count += 1
            cursor += 1
        if cursor < len(source) and source[cursor] == '"':
            return cursor, hash_count
        return None

    def char_literal_start(position: int) -> bool:
        if position >= len(source) or source[position] != "'":
            return False
        cursor = position + 1
        if cursor >= len(source):
            return False
        if source[cursor] == "\\":
            cursor += 1
            if cursor >= len(source):
                return False
            if source[cursor] == "u" and cursor + 1 < len(source) and source[cursor + 1] == "{":
                cursor += 2
                while cursor < len(source) and source[cursor] != "}":
                    cursor += 1
                if cursor >= len(source):
                    return False
                cursor += 1
            elif source[cursor] == "x":
                cursor += 3
            else:
                cursor += 1
        else:
            cursor += 1
        return cursor < len(source) and source[cursor] == "'"

    while index < len(source):
        character = source[index]
        next_character = source[index + 1] if index + 1 < len(source) else ""

        if raw_end is not None:
            closing = '"' + raw_end
            if source.startswith(closing, index):
                blank(index, index + len(closing))
                index += len(closing)
                raw_end = None
            else:
                if character != "\n":
                    output[index] = " "
                index += 1
            continue
        if in_line_comment:
            if character == "\n":
                in_line_comment = False
            else:
                output[index] = " "
            index += 1
            continue
        if block_comment_depth:
            if character == "/" and next_character == "*":
                blank(index, index + 2)
                block_comment_depth += 1
                index += 2
                continue
            if character == "*" and next_character == "/":
                blank(index, index + 2)
                block_comment_depth -= 1
                index += 2
                continue
            if character != "\n":
                output[index] = " "
            index += 1
            continue
        if in_string:
            if character != "\n":
                output[index] = " "
                if string_escaped:
                    string_escaped = False
                elif character == "\\":
                    string_escaped = True
                elif character == '"':
                    in_string = False
            index += 1
            continue
        if in_char:
            if character != "\n":
                output[index] = " "
                if char_escaped:
                    char_escaped = False
                elif character == "\\":
                    char_escaped = True
                elif character == "'":
                    in_char = False
            index += 1
            continue
        if character == "/" and next_character == "/":
            blank(index, index + 2)
            in_line_comment = True
            index += 2
            continue
        if character == "/" and next_character == "*":
            blank(index, index + 2)
            block_comment_depth = 1
            index += 2
            continue
        raw_start = raw_string_start(index)
        if raw_start is not None:
            quote_position, hash_count = raw_start
            blank(index, quote_position + 1)
            raw_end = "#" * hash_count
            index = quote_position + 1
            continue
        if character == '"':
            output[index] = " "
            in_string = True
            string_escaped = False
            index += 1
            continue
        if char_literal_start(index):
            in_char = True
            output[index] = " "
            index += 1
            continue
        index += 1

    if raw_end is not None:
        fail(f"unterminated Rust raw string while masking source at offset {index}")
    if block_comment_depth:
        fail(f"unterminated Rust block comment while masking source at offset {index}")
    if in_string:
        fail(f"unterminated Rust string while masking source at offset {index}")
    if in_char:
        fail(f"unterminated Rust character literal while masking source at offset {index}")
    return "".join(output)


def storage_impl_bodies(source: str) -> list[str]:
    """Extract every active ``impl Storage`` body for method checks.

    The current source uses one block, but allowing multiple blocks keeps the
    uniqueness guard fail-closed if a future split moves methods into another
    module or extension block.  Each candidate is found on masked lexical text
    and extracted from the original source with the brace-aware lexer.
    """

    # Search the lexical projection so prose, SQL, and migration comments
    # cannot donate a fake impl boundary.  Use the original source for the
    # returned body because downstream checks need the real identifiers and
    # line-preserving source text.
    lexical_source = mask_rust_non_code(source)
    matches = list(re.finditer(r"\bimpl\s+Storage\s*\{", lexical_source))
    if not matches:
        fail("storage.rs is missing its impl Storage block")
    bodies: list[str] = []
    for match in matches:
        open_brace = lexical_source.find("{", match.start(), match.end())
        if open_brace < 0:  # pragma: no cover - defensive regex invariant
            fail("impl Storage is missing its opening brace")
        bodies.append(extract_balanced_block(source, open_brace))
    return bodies


def storage_impl_body(source: str) -> str:
    """Extract the first active ``impl Storage`` body for compatibility."""

    return storage_impl_bodies(source)[0]


def check_storage_method_uniqueness(source: str) -> None:
    """Reject duplicate public ``Storage`` method names in storage.rs.

    The storage module has one authoritative ``impl Storage`` block.  A
    declaration-level scan is deliberately used here instead of trying to
    parse Rust braces: storage.rs contains SQL/raw-string literals whose
    braces are not Rust block delimiters.  Cargo remains authoritative for
    syntax and type checking.
    """

    source = mask_rust_non_code("\n".join(storage_impl_bodies(source)))
    names = re.findall(
        r"(?m)^ {4}pub(?:\s*\([^)]*\))?\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(",
        source,
    )
    counts: dict[str, int] = {}
    for name in names:
        counts[name] = counts.get(name, 0) + 1
    duplicates = sorted(name for name, count in counts.items() if count > 1)
    if duplicates:
        fail("duplicate public Storage methods: " + ", ".join(duplicates))


def storage_method_body(
    source: str, method_name: str, *, source_is_masked_impl_body: bool = False
) -> str:
    """Extract one public ``Storage`` method region by declaration lines.

    This is a source-shape check, not a Rust parser.  The returned region ends
    at the next four-space-indented public method declaration, which is enough
    to validate that a list method references only its entity-specific bound
    without interpreting nested SQL/JSON/raw-string braces.
    """

    if not source_is_masked_impl_body:
        source = mask_rust_non_code(storage_impl_body(source))
    match = re.search(
        rf"(?m)^ {{4}}pub(?:\s*\([^)]*\))?\s+(?:async\s+)?fn\s+{re.escape(method_name)}\s*\(",
        source,
    )
    if match is None:
        fail(f"Storage is missing required list method: {method_name}")
    next_method = re.search(
        r"(?m)^ {4}pub(?:\s*\([^)]*\))?\s+(?:async\s+)?fn\s+[A-Za-z_]\w*\s*\(",
        source[match.end() :],
    )
    end = match.end() + next_method.start() if next_method else len(source)
    return source[match.start() : end]


def check_storage_list_limit_bindings(source: str) -> None:
    """Ensure each list method references only its entity-specific bound."""

    list_limit_pattern = r"\bMAX_(?:GOAL|TASK|STARTER_WORKFLOW)_LIST_LIMIT\b"
    masked_impl_body = mask_rust_non_code("\n".join(storage_impl_bodies(source)))
    for method_name, expected_limit in LIST_METHOD_LIMITS.items():
        method_body = storage_method_body(
            masked_impl_body, method_name, source_is_masked_impl_body=True
        )
        referenced_limits = sorted(set(re.findall(list_limit_pattern, method_body)))
        if referenced_limits != [expected_limit]:
            fail(
                f"{method_name} must use only {expected_limit}; "
                f"found {referenced_limits or 'no list limit constant'}"
            )


def main() -> int:
    if not RUST_ROOT.is_dir():
        fail(f"Rust source directory does not exist: {RUST_ROOT}")

    source_files = sorted(RUST_ROOT.rglob("*.rs"))
    if not source_files:
        fail(f"no Rust source files found under {RUST_ROOT}")

    source = "\n".join(path.read_text(encoding="utf-8") for path in source_files)
    source = strip_quarantined_legacy_goal_block(source)
    source_for_definitions = mask_rust_non_code(source)
    definitions: dict[str, int] = {}
    helper_manifest = (
        *REQUIRED_HELPERS,
        *GOAL_HELPERS,
        *TASK_HELPERS,
        *WORKFLOW_HELPERS,
        *SHARED_ROOT_HELPERS,
    )
    for helper in helper_manifest:
        # Allow private, pub(crate), and public functions, with an optional
        # async modifier.  The function name is still required to be a real
        # Rust identifier followed by an opening parameter list.
        pattern = re.compile(
            rf"\b(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+{re.escape(helper)}\s*\("
        )
        definitions[helper] = len(pattern.findall(source_for_definitions))

    missing = [name for name, count in definitions.items() if count == 0]
    duplicate = [name for name, count in definitions.items() if count > 1]
    if missing:
        fail("missing helper definitions: " + ", ".join(missing))
    if duplicate:
        fail("duplicate helper definitions: " + ", ".join(duplicate))

    storage_source_path = RUST_ROOT / "storage.rs"
    if not storage_source_path.is_file():
        fail(f"native storage source does not exist: {storage_source_path}")
    storage_source = strip_quarantined_legacy_goal_block(
        storage_source_path.read_text(encoding="utf-8")
    )
    check_storage_method_uniqueness(storage_source)
    check_storage_list_limit_bindings(storage_source)
    print(
        "RUST_HELPER_DEFINITION_VERIFY: PASS "
        f"({len(helper_manifest)} required native helpers defined exactly once; "
        "Storage public method names unique; list-limit bindings correct)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
