"""Regression tests for the cursor-authority source verifier.

The cursor verifier is intentionally source based because Cargo may be absent
on the host.  Its evidence still has to be scoped to the exact resolver and
the exact state-base derivation callsite; unrelated functions must not be able
to donate marker strings to a green result.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
VERIFIER_PATH = ROOT / "scripts" / "verify-cursor-authority-contract.py"
SPEC = importlib.util.spec_from_file_location("cursor_authority_verifier", VERIFIER_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import bootstrap
    raise RuntimeError(f"unable to load verifier at {VERIFIER_PATH}")
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class CursorAuthorityVerifierTests(unittest.TestCase):
    def test_test_only_resolution_helper_does_not_count_as_production_authority(self) -> None:
        source = """
        fn persist_run_control_intent() {
            derive_native_state_base();
        }

        #[cfg(test)]
        fn persist_run_control_resolution() {}

        #[cfg(test)]
        mod tests {
            fn fixture() {
                storage.persist_run_control_resolution(operation);
            }
        }
        """

        VERIFIER.check_resolution_persistence_boundary(source)

    def test_active_resolution_helper_is_rejected_as_a_production_bypass(self) -> None:
        source = """
        fn persist_run_control_intent() {
            derive_native_state_base();
        }
        fn persist_run_control_resolution() {}
        """

        with self.assertRaises(AssertionError):
            VERIFIER.check_resolution_persistence_boundary(source)

    def test_production_resolution_call_is_rejected_even_with_test_only_helper(self) -> None:
        source = """
        fn persist_run_control_intent() {
            persist_run_control_resolution(operation);
            derive_native_state_base();
        }

        #[cfg(test)]
        fn persist_run_control_resolution() {}
        """

        with self.assertRaises(AssertionError):
            VERIFIER.check_resolution_persistence_boundary(source)

    def test_cursor_revision_constant_is_extracted_from_executable_source(self) -> None:
        source = r'''
        // const CURSOR_EVENT_CANONICALIZATION_REVISION: &str = "fake";
        const RAW = r#"const CURSOR_EVENT_CANONICALIZATION_REVISION: &str = \"fake-raw\";"#;
        const CURSOR_EVENT_CANONICALIZATION_REVISION: &str = "cursor-event-c14n-v1";
        '''

        self.assertEqual(
            VERIFIER._const_string_values(
                source, "CURSOR_EVENT_CANONICALIZATION_REVISION"
            ),
            ["cursor-event-c14n-v1"],
        )

    def test_inactive_cfg_revision_constant_cannot_satisfy_native_contract(self) -> None:
        source = r'''
        #[cfg(test)]
        const CURSOR_EVENT_CANONICALIZATION_REVISION: &str = "cursor-event-c14n-v1";
        #[cfg(any())]
        #[allow(dead_code)]
        pub const CURSOR_EVENT_CANONICALIZATION_REVISION: &str = "cursor-event-c14n-v1";
        '''

        self.assertEqual(
            VERIFIER._const_string_values(
                source, "CURSOR_EVENT_CANONICALIZATION_REVISION"
            ),
            [],
        )

    def test_active_revision_constant_is_not_hidden_by_inactive_fixture(self) -> None:
        source = r'''
        #[cfg(test)]
        const CURSOR_EVENT_CANONICALIZATION_REVISION: &str = "fake-test";
        const CURSOR_EVENT_CANONICALIZATION_REVISION: &str = "cursor-event-c14n-v1";
        '''

        self.assertEqual(
            VERIFIER._const_string_values(
                source, "CURSOR_EVENT_CANONICALIZATION_REVISION"
            ),
            ["cursor-event-c14n-v1"],
        )

    def test_resolver_evidence_is_not_aggregated_from_a_neighbouring_function(self) -> None:
        source = """
        fn resolve_cursor_authority() {
            match cursor.stream_kind {
                RunControlStreamKind::Branch => {}
            }
        }

        fn unrelated_helper() {
            // These markers must not satisfy the resolver contract.
            let _ = "state_revision_journals state_revision_events run_journals run_events";
            let _ = "cursor_stream_not_found cursor_scope_conflict cursor_epoch_mismatch";
            let _ = "cursor_event_not_found cursor_sequence_event_mismatch";
            let _ = "cursor_above_fixed_watermark cursor_payload_hash_mismatch unsupported_cursor_stream";
            let _ = RunControlStreamKind::Run;
            let _ = RunControlStreamKind::Conversation;
            let _ = RunControlStreamKind::Task;
            let _ = RunControlStreamKind::Project;
            let _ = RunControlStreamKind::Provider;
            let _ = RunControlStreamKind::Recovery;
        }
        """

        implemented, body = VERIFIER.resolver_block(source)

        self.assertTrue(implemented)
        self.assertIn("RunControlStreamKind::Branch", body)
        self.assertNotIn("state_revision_journals", body)
        self.assertNotIn("unsupported_cursor_stream", body)

    def test_comments_and_strings_cannot_create_a_fake_resolver(self) -> None:
        source = r'''
        /* fn resolve_cursor_authority() {
             state_revision_journals run_journals unsupported_cursor_stream
        } */
        const TEXT: &str = "fn resolve_cursor_authority() { state_revision_events }";
        fn ordinary_helper() { }
        '''

        implemented, body = VERIFIER.resolver_block(source)

        self.assertFalse(implemented)
        self.assertEqual("", body)

    def test_raw_and_nested_comment_literals_cannot_create_a_fake_resolver(self) -> None:
        source = r'''
        const RAW = r###"
            fn resolve_cursor_authority() {
                state_revision_journals state_revision_events run_journals run_events;
                cursor_stream_not_found cursor_scope_conflict cursor_epoch_mismatch;
                cursor_event_not_found cursor_sequence_event_mismatch;
                cursor_above_fixed_watermark cursor_payload_hash_mismatch unsupported_cursor_stream;
                RunControlStreamKind::Branch;
            }
        "###;
        const BYTES = br#"fn resolve_cursor_authority() { unsupported_cursor_stream }"#;
        /* outer comment
           /* nested comment with fn resolve_cursor_authority() { fake } */
           after nested comment
        */
        fn ordinary_helper() {}
        '''

        implemented, body = VERIFIER.resolver_block(source)

        self.assertFalse(implemented)
        self.assertEqual("", body)

    def test_lexical_fragments_do_not_change_active_block_boundary(self) -> None:
        source = r'''
        fn active() {
            let ordinary = "escaped quote: \\\" and braces: { }";
            let raw = r##"comment-looking /* and braces { }"##;
            let bytes = br#"nested { bytes }"#;
            let open = '\u{7b}';
            let close = '\x7d';
            /* nested comment { /* inner } */ still comment */
            if ordinary.len() > 0 { emit(raw, bytes, open, close); }
        }
        fn after() {}
        '''

        bodies = VERIFIER._function_bodies(source, "active")

        self.assertEqual(1, len(bodies))
        self.assertTrue(bodies[0].rstrip().endswith("}"))
        self.assertNotIn("fn after", bodies[0])

    def test_definitely_inactive_cfg_resolver_cannot_satisfy_implementation(self) -> None:
        source = """
        #[cfg(any())]
        fn resolve_cursor_authority() {
            state_revision_journals state_revision_events run_journals run_events;
            cursor_stream_not_found cursor_scope_conflict cursor_epoch_mismatch;
            cursor_event_not_found cursor_sequence_event_mismatch;
            cursor_above_fixed_watermark cursor_payload_hash_mismatch unsupported_cursor_stream;
            RunControlStreamKind::Branch;
            RunControlStreamKind::Run;
            RunControlStreamKind::Conversation;
            RunControlStreamKind::Task;
            RunControlStreamKind::Project;
            RunControlStreamKind::Provider;
            RunControlStreamKind::Recovery;
        }
        """

        implemented, body = VERIFIER.resolver_block(source)

        self.assertFalse(implemented)
        self.assertEqual("", body)

    def test_inactive_cfg_module_cannot_donate_nested_resolver_evidence(self) -> None:
        source = """
        #[cfg(test)]
        mod disabled_fixture {
            fn resolve_cursor_authority() {
                state_revision_journals state_revision_events run_journals run_events;
                cursor_stream_not_found cursor_scope_conflict cursor_epoch_mismatch;
                cursor_event_not_found cursor_sequence_event_mismatch;
                cursor_above_fixed_watermark cursor_payload_hash_mismatch unsupported_cursor_stream;
                RunControlStreamKind::Branch;
                RunControlStreamKind::Run;
                RunControlStreamKind::Conversation;
                RunControlStreamKind::Task;
                RunControlStreamKind::Project;
                RunControlStreamKind::Provider;
                RunControlStreamKind::Recovery;
            }
        }
        """

        implemented, body = VERIFIER.resolver_block(source)

        self.assertFalse(implemented)
        self.assertEqual("", body)

    def test_inactive_cfg_with_extra_attribute_cannot_donate_resolver(self) -> None:
        source = """
        #[cfg(any())]
        #[inline(always)]
        pub(crate) fn resolve_cursor_authority() {
            state_revision_journals state_revision_events run_journals run_events;
            cursor_stream_not_found cursor_scope_conflict cursor_epoch_mismatch;
            cursor_event_not_found cursor_sequence_event_mismatch;
            cursor_above_fixed_watermark cursor_payload_hash_mismatch unsupported_cursor_stream;
            RunControlStreamKind::Branch;
            RunControlStreamKind::Run;
            RunControlStreamKind::Conversation;
            RunControlStreamKind::Task;
            RunControlStreamKind::Project;
            RunControlStreamKind::Provider;
            RunControlStreamKind::Recovery;
        }
        """

        implemented, body = VERIFIER.resolver_block(source)

        self.assertFalse(implemented)
        self.assertEqual("", body)

    def test_unknown_cfg_resolver_remains_candidate_for_source_only_gate(self) -> None:
        source = """
        #[cfg(feature = \"experimental-cursor\")]
        fn resolve_cursor_authority() {
            state_revision_journals state_revision_events run_journals run_events;
            cursor_stream_not_found cursor_scope_conflict cursor_epoch_mismatch;
            cursor_event_not_found cursor_sequence_event_mismatch;
            cursor_above_fixed_watermark cursor_payload_hash_mismatch unsupported_cursor_stream;
            RunControlStreamKind::Branch;
            RunControlStreamKind::Run;
            RunControlStreamKind::Conversation;
            RunControlStreamKind::Task;
            RunControlStreamKind::Project;
            RunControlStreamKind::Provider;
            RunControlStreamKind::Recovery;
        }
        """

        implemented, body = VERIFIER.resolver_block(source)

        self.assertTrue(implemented)
        self.assertIn("unsupported_cursor_stream", body)

    def test_active_pub_crate_resolver_is_detected(self) -> None:
        source = """
        pub(crate) fn resolve_cursor_authority() {
            state_revision_journals state_revision_events run_journals run_events;
            cursor_stream_not_found cursor_scope_conflict cursor_epoch_mismatch;
            cursor_event_not_found cursor_sequence_event_mismatch;
            cursor_above_fixed_watermark cursor_payload_hash_mismatch unsupported_cursor_stream;
            RunControlStreamKind::Branch;
            RunControlStreamKind::Run;
            RunControlStreamKind::Conversation;
            RunControlStreamKind::Task;
            RunControlStreamKind::Project;
            RunControlStreamKind::Provider;
            RunControlStreamKind::Recovery;
        }
        """

        implemented, body = VERIFIER.resolver_block(source)

        self.assertTrue(implemented)
        self.assertIn("unsupported_cursor_stream", body)

    def test_duplicate_active_resolvers_fail_closed(self) -> None:
        source = """
        fn resolve_cursor_authority() { RunControlStreamKind::Branch; }
        fn resolve_cursor_authority() { RunControlStreamKind::Run; }
        """

        with self.assertRaises(AssertionError):
            VERIFIER.resolver_block(source)

    def test_derivation_callsite_is_checked_in_its_own_function(self) -> None:
        storage = """
        fn derive_native_state_base() {
            resolve_cursor_authority(transaction, cursor);
        }
        fn validate_native_state_base() {
            // Deliberately unrelated: the call must be checked in derive.
        }
        """
        bodies = VERIFIER._function_bodies(storage, "derive_native_state_base")

        self.assertEqual(1, len(bodies))
        self.assertRegex(bodies[0], r"resolve_cursor_authority\s*\(")

    def test_adr_requires_selected_revision_fixed_watermark_contract(self) -> None:
        actual = VERIFIER.ADR.read_text(encoding="utf-8")
        VERIFIER.check_adr(actual)

        stale = actual.replace(
            "selected revision's own `state_revision_events.sequence_no`",
            "selected revision journal anchor",
        )
        with self.assertRaises(AssertionError):
            VERIFIER.check_adr(stale)

    def test_fixed_watermark_markers_are_scoped_to_state_base_derivation(self) -> None:
        storage = """
        fn derive_native_state_base() {
            let selected_revision_journal_anchor = transaction.query_row(
                "SELECT sequence_no, committed_at_ms FROM state_revision_events
                 WHERE stream_id = ?1 AND revision_id = ?2",
                params![stream_id, resolved_revision_id],
            );
            let fixed = CursorFixedWatermark {
                branch_sequence: selected_revision_journal_anchor.map(|anchor| anchor.0),
                run_sequence: Some(cursor.sequence),
            };
            if fact.committed_at_ms > selected_revision_committed_at_ms {
                return Err(cursor_above_fixed_watermark);
            }
            resolve_cursor_authority(transaction, cursor, fixed);
        }

        fn unrelated_helper() {
            let _ = "selected_revision_journal_anchor FROM state_revision_events";
        }
        """
        bodies = VERIFIER._function_bodies(storage, "derive_native_state_base")

        self.assertEqual(1, len(bodies))
        VERIFIER.require_all(
            bodies[0],
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
        self.assertIsNone(
            VERIFIER.re.search(r"MAX\s*\(\s*sequence_no\s*\)", bodies[0])
        )

    def test_mutable_max_watermark_is_rejected_in_state_base_derivation(self) -> None:
        storage = """
        fn derive_native_state_base() {
            let selected_revision_journal_anchor = transaction.query_row(
                "SELECT sequence_no, committed_at_ms FROM state_revision_events
                 WHERE stream_id = ?1 AND revision_id = ?2",
                params![stream_id, resolved_revision_id],
            );
            let fixed = CursorFixedWatermark {
                branch_sequence: selected_revision_journal_anchor.map(|anchor| anchor.0),
                run_sequence: Some(cursor.sequence),
            };
            let _mutable = "SELECT MAX(sequence_no) FROM state_revision_events";
            resolve_cursor_authority(transaction, cursor, fixed);
        }
        """
        body = VERIFIER._function_bodies(storage, "derive_native_state_base")[0]

        with self.assertRaises(AssertionError):
            VERIFIER.check(
                VERIFIER.re.search(r"MAX\s*\(\s*sequence_no\s*\)", body) is None,
                "derive_native_state_base must not derive a fixed cursor watermark from mutable MAX(sequence_no)",
            )

    def test_rust_unicode_and_hex_char_escapes_are_masked(self) -> None:
        source = r"""
        fn demo() {
            let open = '\u{7b}';
            let close = '\u{7d}';
            let hex = '\x7b';
            if ready { emit(open, close, hex); }
        }
        """

        masked = VERIFIER._mask_rust_non_code(source)

        # Braces inside escaped char literals must not participate in block
        # balancing, while the actual executable block remains visible.
        self.assertNotIn(r"\u{7b}", masked)
        self.assertNotIn(r"\u{7d}", masked)
        self.assertNotIn(r"\x7b", masked)
        self.assertIn("if ready { emit(open, close, hex); }", masked)

    def test_byte_char_escape_and_lifetimes_are_not_confused(self) -> None:
        source = r"""
        fn labelled<'a>(value: &'a str) {
            'outer: loop {
                let brace = b'\x7b';
                if value.is_empty() { break 'outer; }
            }
        }
        """

        masked = VERIFIER._mask_rust_non_code(source)

        self.assertIn("labelled<'a>(value: &'a str)", masked)
        self.assertIn("'outer: loop", masked)
        self.assertIn("break 'outer", masked)
        self.assertNotIn(r"b'\x7b'", masked)
        self.assertIn("if value.is_empty() { break 'outer; }", masked)

    def test_unicode_char_escape_closing_quote_is_required(self) -> None:
        source = r"fn demo() { let broken = '\u{7b; if ready { emit(); } }"

        masked = VERIFIER._mask_rust_non_code(source)

        # A malformed escape is not treated as a valid char literal.  The
        # scanner therefore does not erase the executable-looking braces or
        # silently fabricate a balanced resolver body.
        self.assertIn(r"'\u{7b;", masked)
        self.assertIn("if ready { emit(); }", masked)


if __name__ == "__main__":  # pragma: no cover - direct invocation helper
    unittest.main()
