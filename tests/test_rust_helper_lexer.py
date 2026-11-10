"""Regression tests for the verifier's small Rust block lexer.

The helper-definition verifier is deliberately not a Rust parser, but it must
still shield braces that occur inside the literal/comment forms used by the
native source.  These tests keep that narrow lexical contract explicit on
hosts where Cargo is unavailable.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
VERIFIER_PATH = ROOT / "scripts" / "verify-rust-helper-definitions.py"
SPEC = importlib.util.spec_from_file_location("rust_helper_verifier", VERIFIER_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import bootstrap
    raise RuntimeError(f"unable to load verifier at {VERIFIER_PATH}")
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class RustHelperLexerTests(unittest.TestCase):
    def test_balances_around_raw_byte_strings_comments_and_char_literals(self) -> None:
        source = r'''{
    let json = r##"{"outer":{"inner":[1,2,3]}}"##;
    let bytes = br#"{"payload":{"brace":"}"}}"#;
    let escaped = "quoted { text }";
    let character = '{';
    let unicode_character = '\\u{7b}';
    let hex_character = '\\x7b';
    let byte_character = b'\\x7b';
    let lifetime: &'a str = "borrowed";
    /* outer comment with { braces
       /* nested comment with } braces */
       still inside the outer comment */
    if ready {
        emit(escaped);
    }
}
trailing text that must not be included
'''

        block = VERIFIER.extract_balanced_block(source, 0)

        self.assertTrue(block.endswith("}"))
        self.assertNotIn("trailing text", block)
        self.assertIn("r##\"{\"outer\"", block)
        self.assertIn("br#\"{\"payload\"", block)

    def test_escaped_char_literals_do_not_open_a_block(self) -> None:
        source = r'''{
    let unicode_character = '\u{7b}';
    let hex_character = '\x7b';
    let byte_character = b'\x7b';
    let nested = { 1 };
}
trailing text
'''

        block = VERIFIER.extract_balanced_block(source, 0)

        self.assertTrue(block.endswith("}"))
        self.assertNotIn("trailing text", block)

    def test_supports_multiple_raw_string_hash_levels(self) -> None:
        source = '{ let value = r###"{ one { two } }"###; let nested = { 1 }; }'

        block = VERIFIER.extract_balanced_block(source, 0)

        self.assertEqual(block, source)

    def test_unterminated_raw_string_fails_closed(self) -> None:
        source = '{ let value = r#"{ never closes } }'

        with self.assertRaises(SystemExit):
            VERIFIER.extract_balanced_block(source, 0)

    def test_declaration_scan_masks_comments_and_literals(self) -> None:
        source = r'''impl Storage {
    //     pub fn duplicate(&self) { }
    let ordinary = "\n    pub fn duplicate(&self) { }";
    let raw = r###"\n    pub fn duplicate(&self) { { } }\n"###;
    /*
        pub fn duplicate(&self) { }
        /* nested pub fn duplicate(&self) { } */
    */
    pub fn duplicate(&self) { }
}
'''

        # The declaration-shaped text above is non-code.  Only the final
        # active method should be visible to the uniqueness guard.
        VERIFIER.check_storage_method_uniqueness(source)

    def test_duplicate_methods_split_across_impl_blocks_fail_closed(self) -> None:
        source = r'''impl Storage {
    pub fn duplicate(&self) { }
}

impl Storage {
    pub fn duplicate(&self) { }
}
'''

        with self.assertRaises(SystemExit):
            VERIFIER.check_storage_method_uniqueness(source)

    def test_legacy_marker_inside_literal_does_not_redirect_stripping(self) -> None:
        source = r'''const TEXT: &str = "#[cfg(any())] mod legacy_goal_helper_block { fake() }";
#[cfg(any())]
mod legacy_goal_helper_block {
    fn stale_helper() {}
}
fn active_helper() {}
'''

        stripped = VERIFIER.strip_quarantined_legacy_goal_block(source)

        self.assertIn("const TEXT", stripped)
        self.assertNotIn("stale_helper", stripped)
        self.assertIn("active_helper", stripped)

    def test_unterminated_comment_and_string_fail_closed(self) -> None:
        with self.assertRaises(SystemExit):
            VERIFIER.mask_rust_non_code("fn main() { /* never closes")
        with self.assertRaises(SystemExit):
            VERIFIER.mask_rust_non_code('fn main() { let value = "never closes')


if __name__ == "__main__":  # pragma: no cover - direct invocation helper
    unittest.main()
