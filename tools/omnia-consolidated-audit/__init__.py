"""Cross-lane pre-commit, disjoint ownership, hygiene, zero-secret, and Rust inventory audit package."""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import importlib
from typing import Any

__all__ = [
    "AuditError",
    "DEFAULT_EXPECTED_BRANCH",
    "DEFAULT_OWNERSHIP_PATH",
    "DEFAULT_REPO_ROOT",
    "SCHEMA_VERSION",
    "audit_branch_and_ownership",
    "audit_hygiene",
    "audit_rust_inventory",
    "audit_secrets",
    "check_policy_overlaps",
    "classify_repo_path",
    "compile_glob_pattern",
    "format_markdown_summary",
    "load_ownership_policy",
    "parse_git_status_porcelain_z",
    "patterns_can_overlap",
    "run_consolidated_audit",
]


def __getattr__(name: str) -> Any:
    """Lazy-load symbols from ``.audit`` so ``python -m ...audit`` avoids runpy warnings."""
    if name in __all__:
        mod = importlib.import_module(f"{__name__}.audit")
        return getattr(mod, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
