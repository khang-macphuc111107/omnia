"""Automated contract and verification tests for the Omnia Rust native subsystems (M4 & M6).

Covers:
1. omnia-harness: cancellation grace periods, hung tool future drop semantics,
   duplicate tool call ID protocol rejection, multi-provider model routing & fallback.
2. omnia-download: HTTP range chunking constraints, resume verification rules,
   and header isolation / fail-closed security.
3. omnia-browser & omnia-computer: tool catalogs, effect class separation,
   payload schemas, blocked process safety policies, and emergency stop kill switch contracts.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC_TAURI = ROOT / "src-tauri"
CRATES = SRC_TAURI / "crates"


class NativeSubsystemContractTests(unittest.TestCase):
    """Static and behavioral contract tests for native subsystem crates."""

    # -------------------------------------------------------------------------
    # omnia-harness contracts
    # -------------------------------------------------------------------------
    def test_omnia_harness_cancellation_grace_contract(self) -> None:
        """Verify TOOL_CANCEL_GRACE is explicitly 2 seconds and hung tool future is dropped."""
        agent_rs = (CRATES / "omnia-harness" / "src" / "agent.rs").read_text(encoding="utf-8")

        # 1. Grace period definition
        self.assertIn(
            "const TOOL_CANCEL_GRACE: Duration = Duration::from_secs(2);",
            agent_rs,
            "TOOL_CANCEL_GRACE must be exactly 2 seconds",
        )

        # 2. Select block handles cancellation with timeout grace (defaulting to TOOL_CANCEL_GRACE)
        self.assertTrue(
            "tokio::time::timeout(TOOL_CANCEL_GRACE, &mut pending).await.ok()" in agent_rs
            or (
                "unwrap_or(TOOL_CANCEL_GRACE)" in agent_rs
                and "tokio::time::timeout(grace, &mut pending).await.ok()" in agent_rs
            ),
            "Cancellation select branch must apply TOOL_CANCEL_GRACE timeout to pending tool future",
        )

        # 3. Future is dropped after select
        self.assertIn("drop(pending);", agent_rs, "Pending tool future must be dropped after cancel/finish")

    def test_omnia_harness_duplicate_tool_call_rejection_contract(self) -> None:
        """Verify duplicate tool call ID rejection contract in model message accumulator."""
        model_rs = (CRATES / "omnia-harness" / "src" / "model.rs").read_text(encoding="utf-8")

        # Must check both pending_tools and completed blocks
        self.assertIn("self.pending_tools.iter().any(|entry| &entry.0 == id)", model_rs)
        self.assertIn("self.blocks.iter().any(", model_rs)
        self.assertIn("duplicate tool call id `{id}` in one assistant message", model_rs)

    def test_omnia_harness_fallback_routing_criteria(self) -> None:
        """Verify provider model fallback error conditions (429, 529, 500..600, model unavailable)."""
        agent_rs = (CRATES / "omnia-harness" / "src" / "agent.rs").read_text(encoding="utf-8")

        self.assertIn("fn is_fallback_error(error: &HarnessError) -> bool", agent_rs)
        self.assertIn("Some(429 | 529 | 404)", agent_rs)
        self.assertIn("(500..600).contains(code)", agent_rs)
        self.assertIn("ModelFallback", agent_rs, "ModelFallback event must be emitted on switch")

    # -------------------------------------------------------------------------
    # omnia-download contracts
    # -------------------------------------------------------------------------
    def test_omnia_download_chunking_and_content_range_contract(self) -> None:
        """Verify RFC 7233 content range parsing and chunk size constraints."""
        http_rs = (CRATES / "omnia-download" / "src" / "http.rs").read_text(encoding="utf-8")

        self.assertIn("fn parse_content_range(v: &str) -> Option<(u64, u64, u64)>", http_rs)
        self.assertIn("unit.eq_ignore_ascii_case(\"bytes\")", http_rs)
        self.assertIn("(s <= e && e < t).then_some((s, e, t))", http_rs)
        self.assertIn("server returned mismatched Content-Range", http_rs)

    def test_omnia_download_resume_verification_fail_closed(self) -> None:
        """Verify resume_ranges enforces matching URL, validators, file size, and clean headers."""
        http_rs = (CRATES / "omnia-download" / "src" / "http.rs").read_text(encoding="utf-8")

        self.assertIn("fn resume_ranges(", http_rs)
        self.assertIn("spec.headers.is_empty()", http_rs, "Authenticated headers must invalidate resume")
        self.assertIn("spec.cookies.is_none()", http_rs, "Cookies must invalidate resume")
        self.assertIn("spec.body.is_none()", http_rs, "Body-bearing requests must invalidate resume")
        self.assertIn("state.size == size", http_rs)
        self.assertIn("state.etag == probe.etag", http_rs)
        self.assertIn("state.last_modified == probe.last_modified", http_rs)
        self.assertIn("part_len == Some(size)", http_rs)

    # -------------------------------------------------------------------------
    # omnia-browser contracts
    # -------------------------------------------------------------------------
    def test_omnia_browser_tool_catalog_and_effects(self) -> None:
        """Verify all 21 browser tools are defined with BrowserControl effect class."""
        schema_rs = (CRATES / "omnia-browser" / "src" / "tools" / "schema.rs").read_text(encoding="utf-8")

        expected_browser_tools = [
            "browser_navigate",
            "browser_snapshot",
            "browser_click",
            "browser_type",
            "browser_press",
            "browser_hover",
            "browser_scroll",
            "browser_select",
            "browser_upload",
            "browser_wait",
            "browser_screenshot",
            "browser_evaluate",
            "browser_get_text",
            "browser_tabs",
            "browser_console",
            "browser_network",
            "browser_pdf",
            "browser_batch",
            "browser_record",
            "browser_emulate",
            "browser_save_page",
        ]

        self.assertIn("pub const ALL_KINDS: [Kind; 21]", schema_rs)
        for tool in expected_browser_tools:
            self.assertIn(f'"{tool}"', schema_rs, f"Browser tool catalog must declare {tool}")

        self.assertIn("EffectClass::BrowserControl", schema_rs)

    def test_omnia_browser_url_normalization_rules(self) -> None:
        """Verify browser URL normalization logic handles localhost, IP, and web protocols."""
        exec_rs = (CRATES / "omnia-browser" / "src" / "tools" / "exec.rs").read_text(encoding="utf-8")

        self.assertIn("pub fn normalize_url(raw: &str) -> String", exec_rs)
        self.assertIn('if local { "http" } else { "https" }', exec_rs)

    # -------------------------------------------------------------------------
    # omnia-computer contracts
    # -------------------------------------------------------------------------
    def test_omnia_computer_tool_catalog_and_effects(self) -> None:
        """Verify 21 computer tools with proper effect class segregation."""
        tools_rs = (CRATES / "omnia-computer" / "src" / "tools.rs").read_text(encoding="utf-8")

        expected_computer_tools = [
            "computer_windows",
            "computer_snapshot",
            "computer_screenshot",
            "computer_ocr",
            "computer_find_text",
            "computer_click",
            "computer_type",
            "computer_key",
            "computer_scroll",
            "computer_drag",
            "computer_act",
            "computer_window",
            "computer_launch",
            "computer_batch",
            "computer_window_list",
            "computer_window_screenshot",
            "computer_window_click",
            "computer_window_type",
            "computer_window_key",
            "computer_window_ocr",
            "computer_window_find_text",
        ]

        self.assertIn("const ALL: [Kind; 21]", tools_rs)
        for tool in expected_computer_tools:
            self.assertIn(f'"{tool}"', tools_rs, f"Computer tool catalog must declare {tool}")

        # Effect classes
        self.assertIn("EffectClass::ReadWorkspace", tools_rs)
        self.assertIn("EffectClass::ComputerControl", tools_rs)

    def test_omnia_computer_blocked_apps_security_policy(self) -> None:
        """Verify security-critical credential/elevation applications are blocked by default."""
        safety_rs = (CRATES / "omnia-computer" / "src" / "safety.rs").read_text(encoding="utf-8")

        critical_apps = [
            "CredentialUIBroker.exe",
            "consent.exe",
            "LogonUI.exe",
            "WindowsSecurity.exe",
            "1Password.exe",
            "Bitwarden.exe",
            "KeePass.exe",
        ]

        for app in critical_apps:
            self.assertIn(f'"{app}"', safety_rs, f"Default blocked apps must include {app}")

    def test_omnia_computer_kill_switch_contract(self) -> None:
        """Verify KillSwitch supports immediate emergency trigger, cancel token firing, and reset."""
        safety_rs = (CRATES / "omnia-computer" / "src" / "safety.rs").read_text(encoding="utf-8")

        self.assertIn("pub struct KillSwitch", safety_rs)
        self.assertIn("pub fn trigger(&self)", safety_rs)
        self.assertIn("t.cancel();", safety_rs)
        self.assertIn("pub fn reset(&self)", safety_rs)
        self.assertIn("pub fn is_triggered(&self) -> bool", safety_rs)


if __name__ == "__main__":
    unittest.main()
