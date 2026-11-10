"""Adversarial regression tests for the run-control contract verifier.

The production verifier is intentionally dependency-free and source/schema
oriented.  These tests mutate isolated copies of its inputs to ensure that a
small contract regression fails closed instead of being hidden by a nearby
conditional, a projection-only mapping, or a misleading native source body.

These tests are static evidence only.  They do not compile Rust, exercise the
Tauri runtime, or prove packaged Windows behavior.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
VERIFIER_PATH = ROOT / "scripts" / "verify-run-control-contract.py"
SPEC = importlib.util.spec_from_file_location("run_control_contract_verifier", VERIFIER_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import bootstrap
    raise RuntimeError(f"unable to load verifier at {VERIFIER_PATH}")
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def operation_schema() -> dict:
    return load_json(ROOT / "docs/omnia-ultra/schemas/run-control-operation.schema.json")


def graph_schema() -> dict:
    return load_json(ROOT / "docs/omnia-ultra/schemas/state-revision-graph.schema.json")


def check_operation_with(operation: dict, graph: dict) -> None:
    """Run the operation-schema portion with isolated in-memory fixtures."""

    def fake_load_json(path: Path) -> dict:
        if path.name == "run-control-operation.schema.json":
            return operation
        if path.name == "state-revision-graph.schema.json":
            return graph
        raise AssertionError(f"unexpected schema path: {path}")

    with patch.object(VERIFIER, "load_json", side_effect=fake_load_json):
        VERIFIER.check_operation_schema()


def mapping_fixture() -> str:
    return (ROOT / "docs/omnia-ultra/architecture/run-control-native-mapping.md").read_text(
        encoding="utf-8"
    )


def check_mapping_with(text: str) -> None:
    """Run mapping checks against a temporary specification root."""

    with tempfile.TemporaryDirectory(prefix="omnia-run-control-contract-") as directory:
        spec_root = Path(directory)
        architecture = spec_root / "architecture"
        architecture.mkdir()
        (architecture / "run-control-native-mapping.md").write_text(text, encoding="utf-8")
        with patch.object(VERIFIER, "SPEC_ROOT", spec_root):
            VERIFIER.check_mapping_document()


def native_fixture(*, duplicate_kind: str = "branch", duplicate_edge: str = "branches-from") -> str:
    return f"""
    fn state_revision_kind(self) -> Option<&'static str> {{
        match self {{
            Self::Duplicate => Some(\"{duplicate_kind}\"),
            _ => None,
        }}
    }}
    fn default_edge_kind(self) -> Option<&'static str> {{
        match self {{
            Self::Duplicate => Some(\"{duplicate_edge}\"),
            _ => None,
        }}
    }}
    """


def check_native_with(source: str) -> None:
    """Run native-boundary checks against a temporary Rust source fixture."""

    with tempfile.TemporaryDirectory(prefix="omnia-run-control-native-") as directory:
        root = Path(directory)
        native_dir = root / "src-tauri" / "src"
        native_dir.mkdir(parents=True)
        (native_dir / "run_control.rs").write_text(source, encoding="utf-8")
        with patch.object(VERIFIER, "ROOT", root):
            VERIFIER.check_native_mapping()


class RunControlContractVerifierTests(unittest.TestCase):
    def test_missing_operation_kind_fails_closed(self) -> None:
        operation = operation_schema()
        operation["properties"]["kind"]["enum"].remove("retry")
        with self.assertRaisesRegex(AssertionError, "operation kinds drifted"):
            check_operation_with(operation, graph_schema())

    def test_resume_without_checkpoint_intent_requirement_fails_closed(self) -> None:
        operation = operation_schema()
        resume = next(
            clause
            for clause in operation["allOf"]
            if clause.get("if", {}).get("properties", {}).get("kind", {}).get("const") == "resume"
        )
        resume["then"]["required"].remove("continuationIntent")
        with self.assertRaisesRegex(AssertionError, "resume operation must require continuationIntent"):
            check_operation_with(operation, graph_schema())

    def test_continue_cannot_drift_back_to_none(self) -> None:
        operation = operation_schema()
        continuation = next(
            clause
            for clause in operation["allOf"]
            if clause.get("if", {}).get("properties", {}).get("kind", {}).get("const") == "continue"
        )
        continuation["then"]["properties"]["continuationIntent"] = {"const": "none"}
        with self.assertRaisesRegex(AssertionError, "continue must reject continuationIntent=none"):
            check_operation_with(operation, graph_schema())

    def test_compare_must_keep_two_revision_minimum(self) -> None:
        operation = operation_schema()
        compare = next(
            clause
            for clause in operation["allOf"]
            if clause.get("if", {}).get("properties", {}).get("kind", {}).get("const") == "compare"
        )
        compare["then"]["properties"]["compareStateRevisionIds"]["minItems"] = 1
        with self.assertRaisesRegex(AssertionError, "compare must require at least two state revisions"):
            check_operation_with(operation, graph_schema())

    def test_missing_retry_edge_fails_closed(self) -> None:
        graph = graph_schema()
        graph["$defs"]["stateEdge"]["properties"]["kind"]["enum"].remove("retries")
        with self.assertRaisesRegex(AssertionError, "state graph is missing edge kind retries"):
            check_operation_with(operation_schema(), graph)

    def test_copy_must_remain_read_only_and_edge_free(self) -> None:
        text = mapping_fixture()
        text = text.replace(
            "| `copy` | none | none |",
            "| `copy` | branch | branches-from |",
        )
        with self.assertRaisesRegex(AssertionError, "copy as revision/edge-free"):
            check_mapping_with(text)

    def test_duplicate_must_not_become_continuation(self) -> None:
        text = mapping_fixture()
        lines = text.splitlines()
        duplicate_index = next(index for index, line in enumerate(lines) if line.startswith("| `duplicate` |"))
        lines[duplicate_index] = "| `duplicate` | continuation | continues-from | blind deep copy |"
        text = "\n".join(lines)
        text = text.replace(
            "never a blind deep copy",
            "a blind deep copy",
        )
        with self.assertRaisesRegex(AssertionError, "duplicate must require an explicit branch/fork policy"):
            check_mapping_with(text)

    def test_native_duplicate_revision_kind_must_be_branch_or_fork(self) -> None:
        with self.assertRaisesRegex(AssertionError, "native duplicate must resolve to branch or fork"):
            check_native_with(native_fixture(duplicate_kind="continuation"))

    def test_native_duplicate_edge_must_be_branch_or_fork_edge(self) -> None:
        with self.assertRaisesRegex(AssertionError, "native duplicate edge must be branches-from or forks-from"):
            check_native_with(native_fixture(duplicate_edge="continues-from"))


if __name__ == "__main__":  # pragma: no cover - direct invocation helper
    unittest.main()
