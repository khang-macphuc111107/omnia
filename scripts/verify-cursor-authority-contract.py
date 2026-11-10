"""Static verifier for ADR 0008 cursor authority and provenance.

This checker is intentionally independent of the Rust toolchain.  It validates
that the durable schema, wire-level shape guards, and native resolver source
remain aligned with the multi-stream cursor decision in
``docs/adr/0008-run-control-multi-stream-cursor-authority.md``.

The verifier has two modes:

* the default mode reports the currently implemented portion and exits zero
  when the resolver is still pending.  This keeps the repository's portable
  checks useful on hosts without Cargo while making the missing authority
  boundary explicit in CI output;
* ``--require-implementation`` turns the pending state into a failure.  Use
  this gate once the native resolver is wired into ``derive_native_state_base``.

This is source-contract evidence only.  It does not claim Rust compilation,
SQLite runtime behavior, or packaged Windows verification.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import NoReturn


ROOT = Path(__file__).resolve().parents[1]
ADR = ROOT / "docs" / "adr" / "0008-run-control-multi-stream-cursor-authority.md"
SCHEMA = ROOT / "docs" / "storage-schema.sql"
RUN_CONTROL = ROOT / "src-tauri" / "src" / "run_control.rs"
STORAGE = ROOT / "src-tauri" / "src" / "storage.rs"
RUN_JOURNAL = ROOT / "src-tauri" / "src" / "run_journal.rs"


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


def require_all(text: str, needles: tuple[str, ...], context: str) -> None:
    missing = [needle for needle in needles if needle not in text]
    check(not missing, f"{context} is missing: {', '.join(missing)}")


def check_adr(text: str) -> None:
    require_all(
        text,
        (
            "| `branch` |",
            "| `run` |",
            "| `conversation` |",
            "| `task` |",
            "| `project` |",
            "| `provider` |",
            "| `recovery` |",
            "streamKind, streamId, journalEpoch, sequence, eventId",
            "cursor_stream_not_found",
            "cursor_sequence_event_mismatch",
            "cursor_above_fixed_watermark",
            "unsupported_cursor_stream",
            "state_base_rejects_payload_hash_mismatch",
        ),
        "ADR 0008",
    )
    # The ADR intentionally explains this invariant in prose rather than by
    # requiring one brittle sentence.  Accept the normative wording currently
    # used by the document: the branch-journal sequence and the state-revision
    # ``branch_sequence`` are different coordinates and must not be compared
    # or substituted.  Requiring all three fragments keeps this check strict
    # while allowing harmless wording edits in the surrounding paragraph.
    require_all(
        text,
        (
            "The branch journal sequence",
            "state revision `branch_sequence`",
            "different coordinates",
            "it must never compare or",
            "substitute one for the other",
            "selected revision's own `state_revision_events.sequence_no`",
            "mutable journal `MAX(sequence_no)`",
            "exact run-journal sequence captured",
            "`committed_at_ms`",
            "cross-stream snapshot boundary",
        ),
        "ADR 0008 fixed-watermark distinction",
    )
    check(
        "must fail closed" in text.lower(),
        "ADR 0008 must require fail-closed behavior",
    )


def check_schema(text: str) -> None:
    require_all(
        text,
        (
            "CREATE TABLE run_journals",
            "CREATE TABLE run_events",
            "CREATE TABLE state_revision_journals",
            "CREATE TABLE state_revision_events",
            "UNIQUE (run_id, sequence_no)",
            "UNIQUE (run_id, id)",
            "UNIQUE (stream_id, sequence_no)",
            "UNIQUE (stream_id, id)",
            "UNIQUE (stream_id, revision_id)",
        ),
        "durable journal schema",
    )

    # These checks make sure sequence identity is scoped by the owning stream;
    # a global event counter must never become a cursor authority substitute.
    run_event = re.search(
        r"CREATE TABLE run_events\s*\((?P<body>.*?)\n\)\s*STRICT;",
        text,
        re.DOTALL,
    )
    state_event = re.search(
        r"CREATE TABLE state_revision_events\s*\((?P<body>.*?)\n\)\s*STRICT;",
        text,
        re.DOTALL,
    )
    check(run_event is not None, "run_events table body is missing")
    check(state_event is not None, "state_revision_events table body is missing")
    check("sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1)" in run_event.group("body"), "run_events sequence must be positive")
    check("sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1)" in state_event.group("body"), "state_revision_events sequence must be positive")


def check_shape_guards(run_control: str) -> None:
    require_all(
        run_control,
        (
            "pub struct RunControlCursor",
            "pub journal_epoch: Option<String>",
            "pub sequence: i64",
            "pub event_id: Option<String>",
            "pub payload_hash: Option<String>",
            "resolvedAtCursors must not contain duplicate stream addresses",
            "cursor provenance must include journalEpoch and eventId together",
            "cursor provenance must be omitted when sequence is zero",
        ),
        "RunControlCursor shape guards",
    )


def _mask_rust_non_code(source: str) -> str:
    """Mask Rust comments/literals while preserving source indices.

    Cursor authority is a source-only gate, but a fake resolver in a comment or
    string must not satisfy it.  This small lexer intentionally mirrors the
    shielding used by the other native verifiers: it understands nested block
    comments, ordinary/char literals, and arbitrary-hash raw strings while
    leaving executable identifiers and braces in place.
    """

    masked = list(source)

    def blank(start: int, end: int) -> None:
        for index in range(start, end):
            if masked[index] != "\n":
                masked[index] = " "

    def raw_string_start(position: int) -> tuple[int, int] | None:
        if position >= len(source) or source[position] not in {"r", "b"}:
            return None
        cursor = position + 1
        if source[position] == "b":
            if cursor >= len(source) or source[cursor] != "r":
                return None
            cursor += 1
        hashes = 0
        while cursor < len(source) and source[cursor] == "#":
            hashes += 1
            cursor += 1
        if cursor < len(source) and source[cursor] == '"':
            return cursor, hashes
        return None

    def char_literal_end(position: int) -> int | None:
        """Return the exclusive end of a Rust char/byte-char literal.

        A simple ``'x'`` look-ahead is not enough here: Rust also permits
        escaped code points such as ``'\\u{7b}'`` and byte chars such as
        ``b'\\x7f'``.  If those forms are left unmasked, braces and marker
        text inside a source-only fixture can alter block extraction.  Keep
        this deliberately lexical (not a Rust parser), but consume one
        escaped unit and the body of a Unicode escape before requiring the
        closing quote.  Returning ``None`` is important for lifetimes and
        labels (``&'a str``, ``'label: loop``), which must remain executable
        source rather than being mistaken for char literals.
        """

        if position >= len(source) or source[position] != "'":
            return None
        cursor = position + 1
        if cursor >= len(source) or source[cursor] in "\r\n":
            return None

        if source[cursor] == "\\":
            # Consume the backslash and its escape discriminator first.
            cursor += 2
            if cursor > len(source):
                return None
            # Unicode escapes have a braced body.  Consume through the first
            # closing brace; the final quote check below still decides
            # whether this was actually a char literal.
            escape_kind = source[position + 2] if position + 2 < len(source) else ""
            if escape_kind == "u":
                if cursor >= len(source) or source[cursor] != "{":
                    return None
                cursor += 1
                while cursor < len(source) and source[cursor] != "}":
                    if source[cursor] in "\r\n":
                        return None
                    cursor += 1
                if cursor >= len(source):
                    return None
                cursor += 1
            elif escape_kind == "x":
                # ``\\xNN`` is the other multi-character Rust escape.
                cursor += 2
        else:
            # A direct literal is one Unicode scalar in valid Rust source.
            # Python's source string indexing is code-point based, which is
            # sufficient for this source-shielding helper.
            cursor += 1

        if cursor < len(source) and source[cursor] == "'":
            return cursor + 1
        return None

    index = 0
    while index < len(source):
        character = source[index]
        next_character = source[index + 1] if index + 1 < len(source) else ""

        if character == "/" and next_character == "/":
            end = source.find("\n", index + 2)
            end = len(source) if end < 0 else end
            blank(index, end)
            index = end
            continue
        if character == "/" and next_character == "*":
            cursor = index + 2
            depth = 1
            while cursor < len(source) and depth:
                pair = source[cursor : cursor + 2]
                if pair == "/*":
                    depth += 1
                    cursor += 2
                elif pair == "*/":
                    depth -= 1
                    cursor += 2
                else:
                    cursor += 1
            if depth:
                # Preserve the source shape but fail closed on an unterminated
                # comment instead of letting later text look like code.
                blank(index, len(source))
                break
            blank(index, cursor)
            index = cursor
            continue

        raw_start = raw_string_start(index)
        if raw_start is not None:
            quote_position, hash_count = raw_start
            closing = '"' + ("#" * hash_count)
            end = source.find(closing, quote_position + 1)
            if end < 0:
                blank(index, len(source))
                break
            end += len(closing)
            blank(index, end)
            index = end
            continue
        if character == '"':
            cursor = index + 1
            escaped = False
            while cursor < len(source):
                current = source[cursor]
                if escaped:
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif current == '"':
                    cursor += 1
                    break
                cursor += 1
            blank(index, cursor)
            index = cursor
            continue
        char_end = char_literal_end(index)
        if char_end is not None:
            blank(index, char_end)
            index = char_end
            continue
        index += 1

    return "".join(masked)


def _balanced_block_end(masked: str, open_brace: int) -> int | None:
    """Return the closing brace for a masked Rust block."""

    depth = 0
    for index in range(open_brace, len(masked)):
        if masked[index] == "{":
            depth += 1
        elif masked[index] == "}":
            depth -= 1
            if depth == 0:
                return index
    return None


def _matching_delimiter(masked: str, open_index: int, opening: str, closing: str) -> int | None:
    """Find a matching delimiter in already-masked Rust source."""

    depth = 0
    for index in range(open_index, len(masked)):
        if masked[index] == opening:
            depth += 1
        elif masked[index] == closing:
            depth -= 1
            if depth == 0:
                return index
    return None


def _cfg_expression_is_definitely_inactive(expression: str) -> bool:
    """Return whether a cfg expression is unconditionally absent.

    This source-only verifier cannot evaluate feature, target, or environment
    predicates.  Those predicates therefore remain eligible evidence.  The
    forms below are unconditionally disabled for production resolver
    discovery, and must not be allowed to satisfy the implementation gate.
    """

    normalized = re.sub(r"\s+", "", expression).lower()
    return normalized in {"test", "false", "any()"}


def _inactive_cfg_ranges(masked: str) -> list[tuple[int, int]]:
    """Find definitely-disabled Rust modules/functions and their source spans.

    A resolver hidden in ``#[cfg(any())] mod ...`` or ``#[cfg(test)] fn ...``
    is not an active production implementation.  Keeping this range detection
    bounded to declarations with a balanced body avoids treating an unrelated
    later function as part of the disabled item when a fixture is malformed.
    """

    ranges: list[tuple[int, int]] = []
    cfg_pattern = re.compile(
        r"#\s*\[\s*cfg\s*\(\s*(?P<expression>[^\]]*)\)\s*\]"
    )
    declaration_pattern = re.compile(
        # Rust permits outer attributes before visibility/qualifiers and also
        # between those qualifiers and the item keyword.  Accept both forms;
        # otherwise ``#[cfg(any())] #[inline] pub fn ...`` would evade the
        # inactive range and donate a fake resolver body to the source gate.
        r"\s*(?:(?:#\s*\[[^\]]*\])\s*|"
        r"(?:(?:pub(?:\s*\([^)]*\))?|async|unsafe|const)\s+))*"
        r"(?:mod|fn)\s+[A-Za-z_]\w*[^\{;]*\{" 
    )

    # ``const``/``static`` items are terminated by a semicolon rather than a
    # balanced body.  Keep this matcher separate from the function/module
    # matcher above: allowing ``const`` as a generic qualifier there would
    # make it too easy to consume the item keyword and accidentally match a
    # later declaration.  The scanner below then finds the first top-level
    # semicolon, ignoring delimiters in the initializer (for example a macro
    # invocation or a block expression).
    value_declaration_pattern = re.compile(
        r"\s*(?:(?:#\s*\[[^\]]*\])\s*|"
        r"(?:(?:pub(?:\s*\([^)]*\))?|unsafe|async|extern(?:\s+\"[^\"]*\")?)\s+))*"
        r"(?:const|static)(?:\s+mut)?\s+[A-Za-z_]\w*\b"
    )

    def semicolon_terminated_item_end(start: int) -> int | None:
        """Return the top-level semicolon ending an item, if one exists."""

        opening_to_closing = {"(": ")", "[": "]", "{": "}"}
        closing_to_opening = {value: key for key, value in opening_to_closing.items()}
        stack: list[str] = []
        for index in range(start, len(masked)):
            character = masked[index]
            if character in opening_to_closing:
                stack.append(character)
            elif character in closing_to_opening:
                if stack and stack[-1] == closing_to_opening[character]:
                    stack.pop()
                else:
                    # Malformed source: fail closed rather than allowing a
                    # semicolon from an unrelated later item to be consumed.
                    return None
            elif character == ";" and not stack:
                return index
        return None

    for match in cfg_pattern.finditer(masked):
        if not _cfg_expression_is_definitely_inactive(match.group("expression")):
            continue
        declaration = declaration_pattern.match(masked, match.end())
        if declaration is not None:
            open_brace = masked.rfind("{", declaration.start(), declaration.end())
            end = _balanced_block_end(masked, open_brace)
            if end is not None:
                ranges.append((match.start(), end + 1))
            continue

        declaration = value_declaration_pattern.match(masked, match.end())
        if declaration is None:
            continue
        end = semicolon_terminated_item_end(declaration.start())
        if end is not None:
            ranges.append((match.start(), end + 1))
    return ranges


def _position_in_ranges(position: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start <= position < end for start, end in ranges)


def _function_bodies(source: str, name: str) -> list[str]:
    """Extract active function bodies for one exact Rust function name.

    This is deliberately bounded source evidence rather than a Rust parser.
    It nevertheless binds the signature, opening brace, and body together so
    a neighbouring helper cannot provide resolver tokens for the target.
    """

    masked = _mask_rust_non_code(source)
    inactive_ranges = _inactive_cfg_ranges(masked)
    pattern = re.compile(
        rf"\b(?:pub(?:\s*\([^)]*\))?\s+)?"
        rf"(?:async\s+|unsafe\s+|const\s+)*"
        rf"fn\s+{re.escape(name)}\s*\("
    )
    bodies: list[str] = []
    for match in pattern.finditer(masked):
        if _position_in_ranges(match.start(), inactive_ranges):
            continue
        open_paren = masked.find("(", match.start(), match.end())
        close_paren = _matching_delimiter(masked, open_paren, "(", ")")
        if close_paren is None:
            continue
        open_brace = masked.find("{", close_paren + 1)
        if open_brace < 0:
            continue
        end = _balanced_block_end(masked, open_brace)
        if end is None:
            continue
        # Return the original slice after using masked source only for lexical
        # boundary discovery.  Resolver contracts intentionally include SQL
        # table names and stable error-code strings; those literals are part of
        # the evidence and must remain visible to the marker checks.
        bodies.append(source[open_brace : end + 1])
    return bodies


def _active_lexical_source(source: str) -> str:
    """Return executable-looking source with definitely inactive cfg ranges blanked.

    The cursor verifier intentionally does not evaluate arbitrary Cargo feature
    predicates, but it can and must exclude declarations under unconditional
    ``cfg(test)``, ``cfg(false)`` and ``cfg(any())``.  Keeping this helper
    separate makes production-boundary checks use the same lexical policy as
    resolver discovery instead of accidentally counting test fixtures or
    comments as native authority paths.
    """

    masked = list(_mask_rust_non_code(source))
    for start, end in _inactive_cfg_ranges("".join(masked)):
        for index in range(start, end):
            if masked[index] != "\n":
                masked[index] = " "
    return "".join(masked)


def _const_string_values(source: str, name: str) -> list[str]:
    """Extract executable ``const NAME: &str = "...";`` values.

    Rust string literals are blanked by the lexical projection, so declaration
    discovery and value extraction are intentionally two-step: find the exact
    executable declaration on the masked source, then read only that bounded
    original slice.  A marker in a comment, raw string, or SQL fixture cannot
    satisfy the contract.
    """

    # Use the production lexical projection so a constant declared only in a
    # definitely inactive cfg block cannot satisfy the native contract. The
    # projection preserves source offsets, allowing the exact original literal
    # to be validated below without accepting comments/raw strings.
    masked = _active_lexical_source(source)
    declaration = re.compile(
        rf"\bconst\s+{re.escape(name)}\s*:\s*&str\s*=\s*"
    )
    values: list[str] = []
    for match in declaration.finditer(masked):
        semicolon = masked.find(";", match.end())
        if semicolon < 0:
            continue
        original = source[match.start() : semicolon + 1]
        value = re.fullmatch(
            rf"\s*const\s+{re.escape(name)}\s*:\s*&str\s*=\s*\"([^\"]*)\"\s*;\s*",
            original,
            flags=re.DOTALL,
        )
        if value is not None:
            values.append(value.group(1))
    return values


def canonical_hash_block(storage: str) -> tuple[bool, str]:
    """Return the one active canonical cursor-event hash helper, if present."""

    matches = _function_bodies(storage, "canonical_cursor_event_hash")
    if len(matches) > 1:
        fail(
            "canonical_cursor_event_hash(...) has multiple active definitions; "
            "cursor payload hashes must have one native implementation"
        )
    if not matches:
        return False, ""
    return True, matches[0]


def check_canonical_hash_contract(storage: str, adr: str) -> None:
    """Keep the native hash revision and envelope aligned with ADR 0008.

    This guard deliberately preserves the historical hash domain.  Adding a
    new JSON field (for example ``canonicalizationRevision``) would change the
    digest for already-persisted events and therefore requires an explicit
    migration rather than a silent source edit.
    """

    require_all(
        adr,
        (
            "canonicalization revision `cursor-event-c14n-v1`",
            '"schemaVersion": 1',
            '"streamKind": "run|branch"',
            '"streamId": "<native stream id>"',
            '"journalEpoch": "<native epoch>"',
            '"sequence": 1',
            '"eventId": "<native event id>"',
            '"eventType": "<native event type>"',
            '"payload": "<parsed persisted payload_json>"',
        ),
        "ADR 0008 canonical cursor-event hash envelope",
    )
    values = _const_string_values(
        storage, "CURSOR_EVENT_CANONICALIZATION_REVISION"
    )
    check(
        values == ["cursor-event-c14n-v1"],
        "native cursor-event canonicalization revision must be declared exactly "
        "once as cursor-event-c14n-v1",
    )
    implemented, body = canonical_hash_block(storage)
    check(
        implemented,
        "native cursor-event canonical hash helper is missing",
    )
    require_all(
        body,
        (
            "CURSOR_EVENT_CANONICALIZATION_REVISION",
            '"schemaVersion": 1',
            '"streamKind": stream_kind',
            '"streamId": stream_id',
            '"journalEpoch": journal_epoch',
            '"sequence": sequence',
            '"eventId": event_id',
            '"eventType": event_type',
            '"payload": payload',
        ),
        "native cursor-event canonical hash helper",
    )
    check(
        '"canonicalizationRevision"' not in body,
        "native cursor-event hash envelope changed; add an explicit hash-domain "
        "migration before embedding canonicalizationRevision",
    )
    check(
        re.search(
            r"CURSOR_EVENT_CANONICALIZATION_REVISION\s*!=\s*"
            r'"cursor-event-c14n-v1"',
            body,
        )
        is not None,
        "native cursor-event hash helper must reject an unsupported revision",
    )


def check_resolution_persistence_boundary(storage: str) -> None:
    """Prevent a production caller from bypassing typed cursor resolution."""

    # ``_function_bodies`` excludes definitely inactive cfg ranges.  Any
    # active definition therefore represents a production bypass, regardless
    # of whether it is public or private.
    active_resolution_helpers = _function_bodies(
        storage, "persist_run_control_resolution"
    )
    check(
        not active_resolution_helpers,
        "persist_run_control_resolution must remain test-only; production callers "
        "must enter through persist_run_control_intent",
    )

    active_source = _active_lexical_source(storage)
    active_calls = re.findall(
        r"\bpersist_run_control_resolution\s*\(", active_source
    )
    check(
        not active_calls,
        "production source must not call persist_run_control_resolution; it would "
        "bypass native cursor-authority resolution",
    )

    test_only_declaration = re.search(
        r"#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*"
        r"(?:(?:#\s*\[[^\n]*\])\s*)*"
        r"(?:(?:pub(?:\s*\([^)]*\))?|async|unsafe|const)\s+)*"
        r"fn\s+persist_run_control_resolution\s*\(",
        _mask_rust_non_code(storage),
    )
    check(
        test_only_declaration is not None,
        "persist_run_control_resolution must have an explicit cfg(test) boundary",
    )

    intent_bodies = _function_bodies(storage, "persist_run_control_intent")
    check(
        len(intent_bodies) == 1,
        "storage must contain exactly one active persist_run_control_intent entry point",
    )
    check(
        re.search(r"derive_native_state_base\s*\(", intent_bodies[0]) is not None,
        "persist_run_control_intent must derive the native state base before persistence",
    )


def resolver_block(storage: str) -> tuple[bool, str]:
    """Return whether one typed resolver exists and its exact function body.

    The implementation may live in ``storage.rs`` or in a future dedicated
    ``cursor_authority.rs`` module.  We accept either location, but never
    concatenate files: required authority markers must belong to the resolver
    declaration itself.
    """

    candidates = [storage]
    dedicated = ROOT / "src-tauri" / "src" / "cursor_authority.rs"
    if dedicated.is_file():
        candidates.append(read(dedicated))

    matches: list[str] = []
    for candidate in candidates:
        matches.extend(_function_bodies(candidate, "resolve_cursor_authority"))
    if len(matches) > 1:
        fail(
            "typed resolve_cursor_authority(...) has multiple active definitions; "
            "authority must have exactly one implementation"
        )
    if not matches:
        return False, ""
    return True, matches[0]


def check_resolver(storage: str, run_control: str, run_journal: str, require: bool) -> bool:
    implemented, resolver_body = resolver_block(storage)
    if not implemented:
        message = (
            "typed resolve_cursor_authority(...) is not implemented yet; "
            "ADR 0008 remains a pending native gate"
        )
        if require:
            fail(message)
        print(f"PENDING - {message}")
        return False

    check_canonical_hash_contract(storage, read(ADR))
    check_resolution_persistence_boundary(storage)

    require_all(
        resolver_body,
        (
            "state_revision_journals",
            "state_revision_events",
            "run_journals",
            "run_events",
            "journal_epoch",
            "sequence_no",
            "cursor_stream_not_found",
            "cursor_scope_conflict",
            "cursor_epoch_mismatch",
            "cursor_event_not_found",
            "cursor_sequence_event_mismatch",
            "cursor_above_fixed_watermark",
            "cursor_payload_hash_mismatch",
            "unsupported_cursor_stream",
        ),
        "typed cursor resolver",
    )
    check(
        re.search(r"RunControlStreamKind::Branch", resolver_body) is not None,
        "typed resolver must include branch authority",
    )
    check(
        re.search(r"RunControlStreamKind::Run", resolver_body) is not None,
        "typed resolver must include run authority",
    )
    for unsupported in ("Conversation", "Task", "Project", "Provider", "Recovery"):
        check(
            re.search(rf"RunControlStreamKind::{unsupported}", resolver_body) is not None,
            f"typed resolver must classify unsupported {unsupported.lower()} streams",
        )

    state_base_bodies = _function_bodies(storage, "derive_native_state_base")
    check(
        len(state_base_bodies) == 1,
        "storage must contain exactly one active derive_native_state_base function",
    )
    check(
        re.search(r"resolve_cursor_authority\s*\(", state_base_bodies[0]) is not None,
        "derive_native_state_base must call the typed cursor resolver",
    )

    # Historical replay must freeze the branch watermark at the selected
    # revision's own journal event.  A mutable ``MAX(sequence_no)`` lookup
    # would let a later candidate/rejected event enter an older state base.
    # Keep these markers scoped to the state-base derivation body so an
    # unrelated helper cannot donate evidence to this gate.
    state_base_body = state_base_bodies[0]
    require_all(
        state_base_body,
        (
            "selected_revision_journal_anchor",
            "FROM state_revision_events",
            "WHERE stream_id = ?1 AND revision_id = ?2",
            "branch_sequence: selected_revision_journal_anchor.map",
            "run_sequence: Some(cursor.sequence)",
            "fact.committed_at_ms > selected_revision_committed_at_ms",
        ),
        "selected-revision fixed watermark derivation",
    )
    check(
        re.search(r"MAX\s*\(\s*sequence_no\s*\)", state_base_body) is None,
        "derive_native_state_base must not derive a fixed cursor watermark from mutable MAX(sequence_no)",
    )

    # Keep the independent replay implementation visibly aligned with the
    # resolver's run-cursor ownership.  This catches an accidental resolver
    # that validates against a different stream than the replay path.
    require_all(
        run_journal,
        ("run_journals", "run_events", "validate_cursor_identity"),
        "run journal replay authority",
    )
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--require-implementation",
        action="store_true",
        help="fail when the typed native resolver has not landed yet",
    )
    args = parser.parse_args()
    try:
        adr = read(ADR)
        schema = read(SCHEMA)
        run_control = read(RUN_CONTROL)
        storage = read(STORAGE)
        run_journal = read(RUN_JOURNAL)
        check_adr(adr)
        check_schema(schema)
        check_shape_guards(run_control)
        implemented = check_resolver(storage, run_control, run_journal, args.require_implementation)
    except AssertionError as error:
        print(f"FAIL - {error}")
        return 1
    if implemented:
        print("PASS - ADR 0008 schema, cursor shape, typed authority and replay contracts")
    else:
        print("PASS - ADR 0008 static contracts verified; native typed resolver pending")
    return 0


if __name__ == "__main__":
    sys.exit(main())
