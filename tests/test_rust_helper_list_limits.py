"""Regression tests for entity-specific native list bounds.

These tests intentionally exercise the source-shape guard without requiring a
Rust toolchain.  Cargo remains authoritative for parsing and type checking;
this fixture protects against a cheap but costly Goal/Task/Workflow
copy-and-paste regression on developer machines that only have Python.
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


class RustHelperListLimitTests(unittest.TestCase):
    def test_live_storage_uses_entity_specific_bounds(self) -> None:
        source = VERIFIER.strip_quarantined_legacy_goal_block(
            (ROOT / "src-tauri" / "src" / "storage.rs").read_text(
                encoding="utf-8"
            )
        )

        VERIFIER.check_storage_list_limit_bindings(source)

    def test_cross_entity_bound_is_rejected(self) -> None:
        source = """
    pub fn list_goals(&self, request: ListGoalsRequest) -> NativeResult<Vec<GoalSummary>> {
        let limit = request.limit.unwrap_or(MAX_TASK_LIST_LIMIT);
    }
    pub fn list_tasks(&self, request: ListTasksRequest) -> NativeResult<Vec<TaskSummary>> {
        let limit = request.limit.unwrap_or(MAX_GOAL_LIST_LIMIT);
    }
    pub fn list_starter_workflows(
        &self,
        request: ListStarterWorkflowsRequest,
    ) -> NativeResult<Vec<StarterWorkflowSummary>> {
        let limit = request.limit.unwrap_or(MAX_STARTER_WORKFLOW_LIST_LIMIT);
    }
"""

        with self.assertRaises(SystemExit):
            VERIFIER.check_storage_list_limit_bindings(source)


if __name__ == "__main__":  # pragma: no cover - direct invocation helper
    unittest.main()
