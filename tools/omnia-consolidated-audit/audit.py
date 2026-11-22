#!/usr/bin/env python3
"""Cross-lane pre-commit, disjoint ownership, hygiene, zero-secret, and Rust inventory auditor.

Always run with ``python -B`` so no ``__pycache__`` directories or ``.pyc``
bytecode files are created inside the repository checkout.
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence

SCHEMA_VERSION = "omnia.consolidated_audit.v1"

DEFAULT_REPO_ROOT = Path(r"D:\Omnia")
DEFAULT_OWNERSHIP_PATH = Path(
    r"D:\OmniaData\coordination\master-bridge-01a1d643\DISJOINT_OWNERSHIP.json"
)
DEFAULT_EXPECTED_BRANCH = "codex/omnia-context-integration"
PROTECTED_BRANCHES = frozenset({"main", "master"})

CODEX_OWNER_KEY = "codex_01a1d643"
ANTIGRAVITY_OWNER_KEY = "antigravity_f6bc937a"

FORBIDDEN_BUILD_DIRS = frozenset({"build", "target", "CMakeFiles"})
FORBIDDEN_BUILD_FILES = frozenset({"CMakeCache.txt"})
BYTECODE_SUFFIXES = frozenset({".pyc", ".pyo"})

BINARY_SUFFIXES = frozenset(
    {
        ".a",
        ".bin",
        ".bmp",
        ".cur",
        ".db",
        ".dll",
        ".dylib",
        ".eot",
        ".exe",
        ".gif",
        ".gz",
        ".ico",
        ".idb",
        ".ilk",
        ".ipdb",
        ".iobj",
        ".jpeg",
        ".jpg",
        ".lib",
        ".o",
        ".obj",
        ".otf",
        ".pdb",
        ".pdf",
        ".png",
        ".pyc",
        ".pyo",
        ".rlib",
        ".so",
        ".sqlite",
        ".sqlite3",
        ".tar",
        ".ttf",
        ".wasm",
        ".webp",
        ".woff",
        ".woff2",
        ".zip",
    }
)

# Merge conflict markers written with quantifier escapes so this file never triggers itself.
CONFLICT_OPEN_RE = re.compile(r"^<{7}(?:\s|$)")
CONFLICT_BASE_RE = re.compile(r"^\|{7}(?:\s|$)")
CONFLICT_MID_RE = re.compile(r"^={7}$")
CONFLICT_CLOSE_RE = re.compile(r"^>{7}(?:\s|$)")

# Secret detection patterns.
SK_TOKEN_RE = re.compile(r"\bsk-(?:proj-|svcacct-|admin-|live-|test-)?[A-Za-z0-9_-]{16,}")
GHP_TOKEN_RE = re.compile(r"\bghp_[A-Za-z0-9]{20,}")
GHPAT_TOKEN_RE = re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}")
AIZA_TOKEN_RE = re.compile(r"\bAIza[0-9A-Za-z_-]{20,}")
BEARER_TOKEN_RE = re.compile(r"(?i)\bBearer\s+([^\s\"'`,;)\]\\]+)")
COOKIE_HEADER_RE = re.compile(r"(?i)(?:^|[\s\"'`(,;=])(?:Set-)?Cookie:\s*([^\r\n\"'`\\]+)")
URL_USERINFO_RE = re.compile(
    r"(?i)((?:https?|wss?|ftp)://)([^/\s:@\"'<>]+):([^/\s@\"'<>]+)@([^\s\"'<>`]+)"
)
URL_SENSITIVE_PARAM_RE = re.compile(
    r"(?i)((?:https?|wss?|ftp)://[^\s\"'<>]+[?&#]"
    r"(token|access_token|id_token|refresh_token|api_key|apikey|key|secret|"
    r"client_secret|password|passwd|pwd|auth|sig|signature|x-amz-signature|"
    r"x-amz-security-token|sas|sv|se|session|session_id|pat|bearer)=([^\s\"'<>&#\\]+))"
)
ACCESS_BEARING_URL_FIELD_RE = re.compile(
    r"(?i)\baccess[_-]?bearing[_-]?url\b\s*[:=]\s*[\"']([^\"'\r\n]+)[\"']"
)

PROSE_BEARER_WORDS = frozenset(
    {
        "token",
        "tokens",
        "auth",
        "authentication",
        "authorization",
        "header",
        "headers",
        "prefix",
        "scheme",
        "credential",
        "credentials",
        "secret",
        "secrets",
        "string",
        "value",
        "format",
    }
)
PROSE_COOKIE_WORDS = frozenset({"header", "headers", "value", "string", "name"})
REDACTED_WORDS = frozenset(
    {
        "redacted",
        "omitted",
        "masked",
        "hidden",
        "placeholder",
        "none",
        "null",
        "empty",
        "unset",
        "invalid",
        "censored",
        "stripped",
    }
)
PREFIXED_TOKEN_DUMMY_MARKERS = (
    "dummy",
    "fake",
    "placeholder",
    "synthetic",
    "example",
    "fixture",
    "abcdef",
    "wxyz",
    "123456",
    "000000",
    "xxxxxx",
    "aaaaaa",
)
SYNTHETIC_MARKERS = PREFIXED_TOKEN_DUMMY_MARKERS + (
    "mock",
    "stub",
    "sigval",
    "opaque",
    "topsecret",
    "super-secret",
    "jwt-value",
)
SK_BODY_RE = re.compile(r"^sk-(?:proj-|svcacct-|admin-|live-|test-)?([A-Za-z0-9_-]{16,})$")
GHP_BODY_RE = re.compile(r"^ghp_([A-Za-z0-9]{20,})$")
GHPAT_BODY_RE = re.compile(r"^github_pat_([A-Za-z0-9_]{20,})$")
AIZA_BODY_RE = re.compile(r"^AIza([0-9A-Za-z_-]{20,})$")
JWT_3PART_RE = re.compile(r"^eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.([A-Za-z0-9_-]{6,})$")
REPEATED_CHAR_RUN_RE = re.compile(r"(.)\1{5,}")
REPEATED_GROUP_RUN_RE = re.compile(r"(.{2,6})\1{2,}")
DOC_GENERIC_HOSTS = frozenset({"host", "hostname", "domain", "server", "target"})
TEMPLATE_EXPR_RE = re.compile(r"^\$?\{[A-Za-z0-9_.()]+\}$")
ALPHABET_LOWER = "abcdefghijklmnopqrstuvwxyz"
EXAMPLE_DOMAINS = ("example.com", "example.org", "example.net", "example.test")
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]", "::1"})

TEST_FILE_PATH_RE = re.compile(
    r"(?i)(?:^|/)(?:tests?/|fixtures?/|test_[^/]+$|.*_tests?\.(?:py|rs|cpp|hpp|js|ts|ps1)$)"
)


class AuditError(RuntimeError):
    """Raised when required audit inputs are missing or malformed."""


@dataclass(frozen=True)
class CompiledRule:
    """Compiled repo-relative ownership glob rule."""

    raw_pattern: str
    rel_pattern: str
    regex: re.Pattern[str]


@dataclass(frozen=True)
class OwnerPolicy:
    """Scoped ownership policy for one agent owner."""

    owner_id: str
    owned_repo_rules: tuple[CompiledRule, ...]
    forbidden_repo_rules: tuple[CompiledRule, ...]
    owned_external_patterns: tuple[str, ...]
    forbidden_external_patterns: tuple[str, ...]


@dataclass(frozen=True)
class OwnershipPolicy:
    """Parsed schema v3 disjoint ownership specification."""

    schema_version: int
    updated_at: str | None
    expected_branch: str
    owners: dict[str, OwnerPolicy]
    source_path: str | None = None


@dataclass(frozen=True)
class GitStatusEntry:
    """Parsed entry from ``git status --porcelain=v1 -z``."""

    status_code: str
    path: str
    orig_path: str | None = None
    deleted: bool = False


@dataclass
class HygieneBucket:
    """Mutable accumulator for hygiene metrics inside one scope."""

    files_scanned: int = 0
    text_files_scanned: int = 0
    binary_files_skipped: int = 0
    pycache_dirs: list[str] = field(default_factory=list)
    pyc_files: list[str] = field(default_factory=list)
    forbidden_build_outputs: list[dict[str, str]] = field(default_factory=list)
    non_utf8_files: list[dict[str, str]] = field(default_factory=list)
    utf8_bom_files: list[dict[str, str]] = field(default_factory=list)
    crlf_files: list[dict[str, Any]] = field(default_factory=list)
    stray_cr_files: list[dict[str, Any]] = field(default_factory=list)
    merge_conflict_markers: list[dict[str, Any]] = field(default_factory=list)
    trailing_whitespace_files: list[dict[str, Any]] = field(default_factory=list)
    trailing_whitespace_total_lines: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Serialize hygiene metrics in deterministic sorted order."""
        pycache_sorted = sorted(self.pycache_dirs)
        pyc_sorted = sorted(self.pyc_files)
        build_sorted = sorted(self.forbidden_build_outputs, key=lambda x: (x["path"], x["kind"]))
        non_utf8_sorted = sorted(self.non_utf8_files, key=lambda x: x["path"])
        bom_sorted = sorted(self.utf8_bom_files, key=lambda x: x["path"])
        crlf_sorted = sorted(self.crlf_files, key=lambda x: x["path"])
        stray_cr_sorted = sorted(self.stray_cr_files, key=lambda x: x["path"])
        conflicts_sorted = sorted(
            self.merge_conflict_markers, key=lambda x: (x["path"], int(x["line"]))
        )
        tw_sorted = sorted(self.trailing_whitespace_files, key=lambda x: x["path"])

        hard_clean = (
            not pycache_sorted
            and not pyc_sorted
            and not build_sorted
            and not non_utf8_sorted
            and not bom_sorted
            and not crlf_sorted
            and not stray_cr_sorted
            and not conflicts_sorted
        )
        strict_clean = hard_clean and not tw_sorted

        return {
            "summary": {
                "files_scanned": self.files_scanned,
                "text_files_scanned": self.text_files_scanned,
                "binary_files_skipped": self.binary_files_skipped,
                "pycache_dir_count": len(pycache_sorted),
                "pyc_file_count": len(pyc_sorted),
                "forbidden_build_output_count": len(build_sorted),
                "non_utf8_count": len(non_utf8_sorted),
                "utf8_bom_count": len(bom_sorted),
                "crlf_count": len(crlf_sorted),
                "stray_cr_count": len(stray_cr_sorted),
                "merge_conflict_marker_count": len(conflicts_sorted),
                "trailing_whitespace_file_count": len(tw_sorted),
                "trailing_whitespace_line_count": self.trailing_whitespace_total_lines,
                "hygiene_clean_hard_gates": hard_clean,
                "hygiene_clean_strict": strict_clean,
            },
            "pycache_dirs": pycache_sorted,
            "pyc_files": pyc_sorted,
            "forbidden_build_outputs": build_sorted,
            "non_utf8_files": non_utf8_sorted,
            "utf8_bom_files": bom_sorted,
            "crlf_files": crlf_sorted,
            "stray_cr_files": stray_cr_sorted,
            "merge_conflict_markers": conflicts_sorted,
            "trailing_whitespace": {
                "file_count": len(tw_sorted),
                "total_line_count": self.trailing_whitespace_total_lines,
                "files": tw_sorted,
            },
        }


def _norm_slashes(value: str) -> str:
    """Convert backslashes to POSIX forward slashes and strip redundant leading/trailing slash."""
    text = value.replace("\\", "/").strip()
    while text.startswith("./"):
        text = text[2:]
    return text.rstrip("/")


def _is_windows_abs(posix_path: str) -> bool:
    return len(posix_path) >= 3 and posix_path[1] == ":" and posix_path[2] == "/"


def _split_repo_scoped_pattern(
    raw_pattern: str, repo_root: Path
) -> tuple[bool, str]:
    """Return ``(is_repo_scoped, normalized_pattern)`` relative to ``repo_root``."""
    norm_pat = _norm_slashes(raw_pattern)
    norm_root = _norm_slashes(str(repo_root.resolve()))
    root_prefix = norm_root + "/"

    if norm_pat.lower().startswith(root_prefix.lower()):
        return True, norm_pat[len(root_prefix) :]
    if norm_pat.lower() == norm_root.lower():
        return True, ""
    if _is_windows_abs(norm_pat) or norm_pat.startswith("/"):
        return False, norm_pat
    return True, norm_pat


def compile_glob_pattern(rel_pattern: str) -> re.Pattern[str]:
    """Compile a POSIX relative glob (supporting ``*``, ``?``, ``**``) into a regex."""
    pat = _norm_slashes(rel_pattern)
    if not pat:
        return re.compile(r"^$")

    out: list[str] = ["^"]
    i = 0
    n = len(pat)
    while i < n:
        if pat.startswith("/**", i) and i + 3 == n:
            out.append("/.+")
            i += 3
        elif pat.startswith("/**/", i):
            out.append("/(?:.+/)?")
            i += 4
        elif pat.startswith("**/", i) and (i == 0 or pat[i - 1] == "/"):
            out.append("(?:.+/)?")
            i += 3
        elif pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif pat[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pat[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pat[i]))
            i += 1
    out.append("$")
    return re.compile("".join(out))


def _tokenize_glob_segments(rel_pattern: str) -> tuple[str, ...]:
    """Split a normalized glob pattern into segments, marking trailing ``/**`` as ``**+``."""
    pat = _norm_slashes(rel_pattern)
    if not pat:
        return ()
    parts = pat.split("/")
    if len(parts) >= 2 and parts[-1] == "**":
        return tuple(parts[:-1] + ["**+"])
    return tuple(parts)


@lru_cache(maxsize=4096)
def _single_segment_overlap(seg_a: str, seg_b: str) -> bool:
    """Return True if two single-segment globs (``*``, ``?``, literals) share a non-empty match."""

    @lru_cache(maxsize=None)
    def _dp(i: int, j: int) -> bool:
        if i == len(seg_a) and j == len(seg_b):
            return True
        if i < len(seg_a) and seg_a[i] == "*":
            if _dp(i + 1, j):
                return True
            if j < len(seg_b) and _dp(i, j + 1):
                return True
        if j < len(seg_b) and seg_b[j] == "*":
            if _dp(i, j + 1):
                return True
            if i < len(seg_a) and _dp(i + 1, j):
                return True
        if i < len(seg_a) and j < len(seg_b):
            if seg_a[i] == "?" or seg_b[j] == "?" or seg_a[i] == seg_b[j]:
                return _dp(i + 1, j + 1)
        return False

    return _dp(0, 0)


def patterns_can_overlap(pattern_a: str, pattern_b: str) -> bool:
    """Return True if two repo-relative glob patterns can match any common path."""
    segs_a = _tokenize_glob_segments(pattern_a)
    segs_b = _tokenize_glob_segments(pattern_b)

    @lru_cache(maxsize=None)
    def _dp(i: int, j: int) -> bool:
        if i == len(segs_a) and j == len(segs_b):
            return True
        if i < len(segs_a) and segs_a[i] == "**":
            if _dp(i + 1, j):
                return True
            if j < len(segs_b) and _dp(i, j + 1):
                return True
        if j < len(segs_b) and segs_b[j] == "**":
            if _dp(i, j + 1):
                return True
            if i < len(segs_a) and _dp(i + 1, j):
                return True
        if i < len(segs_a) and segs_a[i] == "**+":
            if j < len(segs_b) and (
                _dp(i + 1, j + 1) or _dp(i, j + 1)
            ):
                return True
        if j < len(segs_b) and segs_b[j] == "**+":
            if i < len(segs_a) and (
                _dp(i + 1, j + 1) or _dp(i + 1, j)
            ):
                return True
        if i < len(segs_a) and j < len(segs_b):
            sa, sb = segs_a[i], segs_b[j]
            if sa not in ("**", "**+") and sb not in ("**", "**+"):
                if _single_segment_overlap(sa, sb) and _dp(i + 1, j + 1):
                    return True
        return False

    return _dp(0, 0)


def load_ownership_policy(
    ownership_path: Path, repo_root: Path
) -> OwnershipPolicy:
    """Load and compile ``DISJOINT_OWNERSHIP.json`` scoped to ``repo_root``."""
    if not ownership_path.is_file():
        raise AuditError(f"Ownership file not found: {ownership_path}")
    try:
        raw = json.loads(ownership_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AuditError(f"Failed to parse ownership JSON {ownership_path}: {exc}") from exc

    if not isinstance(raw, Mapping) or not isinstance(raw.get("owners"), Mapping):
        raise AuditError(f"Ownership JSON missing 'owners' mapping: {ownership_path}")

    owners: dict[str, OwnerPolicy] = {}
    for owner_id, cfg in sorted(raw["owners"].items()):
        if not isinstance(cfg, Mapping):
            raise AuditError(f"Owner entry {owner_id!r} must be an object.")
        owned_repo: list[CompiledRule] = []
        owned_ext: list[str] = []
        for pat in cfg.get("owned_write_paths", []):
            is_repo, rel = _split_repo_scoped_pattern(str(pat), repo_root)
            if is_repo:
                owned_repo.append(
                    CompiledRule(
                        raw_pattern=str(pat),
                        rel_pattern=rel,
                        regex=compile_glob_pattern(rel),
                    )
                )
            else:
                owned_ext.append(rel)

        forb_repo: list[CompiledRule] = []
        forb_ext: list[str] = []
        for pat in cfg.get("forbidden_write_paths", []):
            is_repo, rel = _split_repo_scoped_pattern(str(pat), repo_root)
            if is_repo:
                forb_repo.append(
                    CompiledRule(
                        raw_pattern=str(pat),
                        rel_pattern=rel,
                        regex=compile_glob_pattern(rel),
                    )
                )
            else:
                forb_ext.append(rel)

        owners[str(owner_id)] = OwnerPolicy(
            owner_id=str(owner_id),
            owned_repo_rules=tuple(owned_repo),
            forbidden_repo_rules=tuple(forb_repo),
            owned_external_patterns=tuple(sorted(owned_ext)),
            forbidden_external_patterns=tuple(sorted(forb_ext)),
        )

    schema_version = int(raw.get("schema_version", 0))
    updated_at = raw.get("updated_at")
    expected_branch = str(raw.get("branch") or DEFAULT_EXPECTED_BRANCH)
    return OwnershipPolicy(
        schema_version=schema_version,
        updated_at=str(updated_at) if updated_at is not None else None,
        expected_branch=expected_branch,
        owners=owners,
        source_path=str(ownership_path),
    )


def check_policy_overlaps(policy: OwnershipPolicy) -> dict[str, Any]:
    """Detect rule-level overlaps across owners and self-contradictions inside an owner."""
    owner_ids = sorted(policy.owners.keys())
    cross_owner_repo: list[dict[str, str]] = []
    cross_owner_external: list[dict[str, str]] = []
    self_forbidden: list[dict[str, str]] = []

    for i, owner_a in enumerate(owner_ids):
        pol_a = policy.owners[owner_a]
        for owned_rule in pol_a.owned_repo_rules:
            for forb_rule in pol_a.forbidden_repo_rules:
                if patterns_can_overlap(owned_rule.rel_pattern, forb_rule.rel_pattern):
                    self_forbidden.append(
                        {
                            "owner": owner_a,
                            "owned_pattern": owned_rule.rel_pattern,
                            "forbidden_pattern": forb_rule.rel_pattern,
                        }
                    )
        for owner_b in owner_ids[i + 1 :]:
            pol_b = policy.owners[owner_b]
            for ra in pol_a.owned_repo_rules:
                for rb in pol_b.owned_repo_rules:
                    if patterns_can_overlap(ra.rel_pattern, rb.rel_pattern):
                        cross_owner_repo.append(
                            {
                                "owner_a": owner_a,
                                "pattern_a": ra.rel_pattern,
                                "owner_b": owner_b,
                                "pattern_b": rb.rel_pattern,
                            }
                        )
            for ea in pol_a.owned_external_patterns:
                for eb in pol_b.owned_external_patterns:
                    if patterns_can_overlap(ea, eb):
                        cross_owner_external.append(
                            {
                                "owner_a": owner_a,
                                "pattern_a": ea,
                                "owner_b": owner_b,
                                "pattern_b": eb,
                            }
                        )

    total = len(cross_owner_repo) + len(cross_owner_external) + len(self_forbidden)
    return {
        "overlap_count": total,
        "cross_owner_repo_overlaps": cross_owner_repo,
        "cross_owner_external_overlaps": cross_owner_external,
        "self_owned_forbidden_overlaps": self_forbidden,
    }


def classify_repo_path(
    rel_path: str, policy: OwnershipPolicy
) -> dict[str, Any]:
    """Classify one repo-relative path against all owners in ``policy``."""
    norm = _norm_slashes(rel_path)
    matched_owners: list[str] = []
    matched_patterns: dict[str, list[str]] = {}
    forbidden_hits: dict[str, list[str]] = {}

    for owner_id, owner_pol in sorted(policy.owners.items()):
        hits = [r.rel_pattern for r in owner_pol.owned_repo_rules if r.regex.match(norm)]
        if hits:
            matched_owners.append(owner_id)
            matched_patterns[owner_id] = hits
        forb = [r.rel_pattern for r in owner_pol.forbidden_repo_rules if r.regex.match(norm)]
        if forb:
            forbidden_hits[owner_id] = forb

    if len(matched_owners) > 1:
        bucket = "shared_or_unassigned"
        label = "overlap_violation"
        reason = "overlap_multiple_owners"
    elif len(matched_owners) == 1:
        owner = matched_owners[0]
        if owner == CODEX_OWNER_KEY:
            bucket = "codex_owned"
        elif owner == ANTIGRAVITY_OWNER_KEY:
            bucket = "antigravity_owned"
        else:
            bucket = f"owner:{owner}"
        label = bucket
        reason = "matched_single_owner"
    else:
        bucket = "shared_or_unassigned"
        label = "shared_or_unassigned"
        reason = "unassigned"

    return {
        "path": norm,
        "bucket": bucket,
        "owner_label": label,
        "reason": reason,
        "matched_owners": matched_owners,
        "matched_patterns": matched_patterns,
        "forbidden_hits": forbidden_hits,
        "is_overlap": len(matched_owners) > 1,
        "is_self_forbidden": any(o in forbidden_hits for o in matched_owners),
    }


def parse_git_status_porcelain_z(raw_stdout: bytes) -> list[GitStatusEntry]:
    """Parse ``git status --porcelain=v1 -z`` NUL-delimited output."""
    tokens = raw_stdout.split(b"\x00")
    entries: list[GitStatusEntry] = []
    i = 0
    while i < len(tokens):
        raw_tok = tokens[i]
        i += 1
        if not raw_tok:
            continue
        text = raw_tok.decode("utf-8", errors="replace")
        if len(text) < 4:
            continue
        xy = text[:2]
        path = _norm_slashes(text[3:])
        orig_path: str | None = None
        if "R" in xy or "C" in xy:
            if i < len(tokens) and tokens[i]:
                orig_path = _norm_slashes(tokens[i].decode("utf-8", errors="replace"))
                i += 1
        entries.append(
            GitStatusEntry(
                status_code=xy,
                path=path,
                orig_path=orig_path,
                deleted=("D" in xy),
            )
        )
    return entries


def _run_git(repo_root: Path, args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(repo_root), *args],
        capture_output=True,
        check=False,
    )


def audit_branch_and_ownership(
    repo_root: Path,
    policy: OwnershipPolicy,
    *,
    expected_branch: str | None = None,
) -> tuple[dict[str, Any], list[GitStatusEntry]]:
    """Audit git branch safety, porcelain dirty paths, and disjoint ownership compliance."""
    target_branch = expected_branch or policy.expected_branch or DEFAULT_EXPECTED_BRANCH
    policy_overlaps = check_policy_overlaps(policy)

    branch_proc = _run_git(repo_root, ["rev-parse", "--abbrev-ref", "HEAD"])
    head_proc = _run_git(repo_root, ["rev-parse", "HEAD"])
    status_proc = _run_git(repo_root, ["status", "--porcelain=v1", "-z", "-uall"])

    git_ok = branch_proc.returncode == 0 and status_proc.returncode == 0
    actual_branch = (
        branch_proc.stdout.decode("utf-8", errors="replace").strip()
        if branch_proc.returncode == 0
        else None
    )
    head_commit = (
        head_proc.stdout.decode("utf-8", errors="replace").strip()
        if head_proc.returncode == 0
        else None
    )
    is_protected = actual_branch in PROTECTED_BRANCHES if actual_branch else False
    is_detached = actual_branch == "HEAD"
    matches_expected = actual_branch == target_branch if actual_branch else False
    branch_ok = bool(git_ok and not is_protected and not is_detached and matches_expected)

    entries = parse_git_status_porcelain_z(status_proc.stdout) if git_ok else []
    codex_owned: list[dict[str, Any]] = []
    antigravity_owned: list[dict[str, Any]] = []
    shared_or_unassigned: list[dict[str, Any]] = []
    other_owners: dict[str, list[dict[str, Any]]] = {}
    dirty_overlap_violations: list[dict[str, Any]] = []
    self_forbidden_violations: list[dict[str, Any]] = []

    for entry in sorted(entries, key=lambda e: e.path):
        info = classify_repo_path(entry.path, policy)
        item: dict[str, Any] = {
            "path": info["path"],
            "status": entry.status_code,
            "matched_owners": info["matched_owners"],
        }
        if entry.orig_path:
            item["orig_path"] = entry.orig_path
        if info["reason"] != "matched_single_owner":
            item["reason"] = info["reason"]

        if info["is_overlap"]:
            dirty_overlap_violations.append(
                {
                    "path": info["path"],
                    "status": entry.status_code,
                    "matched_owners": info["matched_owners"],
                    "matched_patterns": info["matched_patterns"],
                }
            )
        if info["is_self_forbidden"]:
            self_forbidden_violations.append(
                {
                    "path": info["path"],
                    "status": entry.status_code,
                    "matched_owners": info["matched_owners"],
                    "forbidden_hits": info["forbidden_hits"],
                }
            )

        bucket = info["bucket"]
        if bucket == "codex_owned":
            codex_owned.append(item)
        elif bucket == "antigravity_owned":
            antigravity_owned.append(item)
        elif bucket == "shared_or_unassigned":
            shared_or_unassigned.append(item)
        else:
            other_owners.setdefault(bucket, []).append(item)

    overlap_violation_count = (
        policy_overlaps["overlap_count"]
        + len(dirty_overlap_violations)
        + len(self_forbidden_violations)
    )

    overlap_clean = overlap_violation_count == 0
    no_unassigned_dirty_files = len(shared_or_unassigned) == 0
    disjoint_clean = overlap_clean and no_unassigned_dirty_files

    result: dict[str, Any] = {
        "git_available": git_ok,
        "branch": {
            "expected_branch": target_branch,
            "actual_branch": actual_branch,
            "head_commit": head_commit,
            "is_protected_branch": is_protected,
            "is_detached_head": is_detached,
            "matches_expected_branch": matches_expected,
            "branch_ok": branch_ok,
        },
        "ownership_summary": {
            "total_dirty_paths": len(entries),
            "codex_owned_count": len(codex_owned),
            "antigravity_owned_count": len(antigravity_owned),
            "shared_or_unassigned_count": len(shared_or_unassigned),
            "policy_overlap_count": policy_overlaps["overlap_count"],
            "dirty_overlap_violation_count": len(dirty_overlap_violations),
            "self_forbidden_violation_count": len(self_forbidden_violations),
            "total_overlap_violation_count": overlap_violation_count,
            "overlap_clean": overlap_clean,
            "no_unassigned_dirty_files": no_unassigned_dirty_files,
            "disjoint_clean": disjoint_clean,
        },
        "partitions": {
            "codex_owned": codex_owned,
            "antigravity_owned": antigravity_owned,
            "shared_or_unassigned": shared_or_unassigned,
        },
        "overlap_violations": {
            "policy": policy_overlaps,
            "dirty_multi_owner": dirty_overlap_violations,
            "dirty_self_forbidden": self_forbidden_violations,
        },
    }
    if other_owners:
        result["partitions"]["other_owners"] = other_owners
    if not git_ok:
        result["git_error"] = (
            branch_proc.stderr or status_proc.stderr
        ).decode("utf-8", errors="replace").strip()

    return result, entries


def _inspect_text_bytes(raw: bytes, suffix: str) -> tuple[str, str | None, str | None]:
    """Return ``(kind, decoded_text, error_reason)`` for a file's raw bytes."""
    if suffix.lower() in BINARY_SUFFIXES:
        return "binary", None, None
    if b"\x00" in raw:
        return "invalid_text", None, "contains_nul_byte"
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        return "invalid_text", None, f"utf8_decode_error: {exc}"
    return "text", text, None


def _scan_text_hygiene(text: str, raw: bytes) -> dict[str, Any]:
    """Inspect decoded UTF-8 text and raw bytes for line-ending, conflict, and whitespace issues."""
    has_bom = raw.startswith(b"\xef\xbb\xbf")
    crlf_count = raw.count(b"\r\n")
    stray_cr_count = raw.count(b"\r") - crlf_count

    conflict_lines: list[dict[str, Any]] = []
    trailing_ws_lines: list[int] = []
    in_conflict = False

    # Strip \r before line inspection so CRLF is reported separately, not as trailing whitespace.
    for lineno, line in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        if line.endswith(" ") or line.endswith("\t"):
            trailing_ws_lines.append(lineno)

        if CONFLICT_OPEN_RE.match(line):
            in_conflict = True
            conflict_lines.append({"line": lineno, "marker": line[:20]})
        elif CONFLICT_BASE_RE.match(line):
            conflict_lines.append({"line": lineno, "marker": line[:20]})
        elif CONFLICT_MID_RE.match(line) and in_conflict:
            conflict_lines.append({"line": lineno, "marker": line[:20]})
        elif CONFLICT_CLOSE_RE.match(line):
            in_conflict = False
            conflict_lines.append({"line": lineno, "marker": line[:20]})

    return {
        "has_bom": has_bom,
        "crlf_count": crlf_count,
        "stray_cr_count": stray_cr_count,
        "conflict_lines": conflict_lines,
        "trailing_ws_lines": trailing_ws_lines,
    }


def _record_file_hygiene(
    bucket: HygieneBucket,
    *,
    rel_path: str,
    owner: str,
    raw: bytes,
    suffix: str,
) -> None:
    """Record hygiene findings for a single file into ``bucket``."""
    bucket.files_scanned += 1
    if rel_path.rsplit("/", 1)[-1] in FORBIDDEN_BUILD_FILES:
        bucket.forbidden_build_outputs.append(
            {"path": rel_path, "kind": "file", "owner": owner}
        )
    if suffix.lower() in BYTECODE_SUFFIXES:
        bucket.pyc_files.append(rel_path)

    kind, text, err_reason = _inspect_text_bytes(raw, suffix)
    if kind == "binary":
        bucket.binary_files_skipped += 1
        return
    if kind == "invalid_text" or text is None:
        bucket.non_utf8_files.append(
            {"path": rel_path, "owner": owner, "reason": err_reason or "invalid_utf8"}
        )
        return

    bucket.text_files_scanned += 1
    info = _scan_text_hygiene(text, raw)
    if info["has_bom"]:
        bucket.utf8_bom_files.append({"path": rel_path, "owner": owner})
    if info["crlf_count"] > 0:
        bucket.crlf_files.append(
            {"path": rel_path, "owner": owner, "crlf_count": info["crlf_count"]}
        )
    if info["stray_cr_count"] > 0:
        bucket.stray_cr_files.append(
            {"path": rel_path, "owner": owner, "stray_cr_count": info["stray_cr_count"]}
        )
    for hit in info["conflict_lines"]:
        bucket.merge_conflict_markers.append(
            {
                "path": rel_path,
                "owner": owner,
                "line": hit["line"],
                "marker": hit["marker"],
            }
        )
    tw_lines = info["trailing_ws_lines"]
    if tw_lines:
        bucket.trailing_whitespace_total_lines += len(tw_lines)
        bucket.trailing_whitespace_files.append(
            {
                "path": rel_path,
                "owner": owner,
                "line_count": len(tw_lines),
                "sample_lines": tw_lines[:10],
            }
        )


def audit_hygiene(
    repo_root: Path, policy: OwnershipPolicy
) -> dict[str, Any]:
    """Scan ``antigravity_owned`` paths and the ``full_repo`` separately for hygiene issues."""
    full_bucket = HygieneBucket()
    agy_bucket = HygieneBucket()

    for root, dirs, files in os.walk(repo_root):
        if ".git" in dirs:
            dirs.remove(".git")
        dirs.sort()
        files.sort()

        root_path = Path(root)
        rel_root = (
            "" if root_path == repo_root else _norm_slashes(str(root_path.relative_to(repo_root)))
        )

        # Inspect directory-level artifacts before pruning large build trees.
        kept_dirs: list[str] = []
        for dirname in dirs:
            rel_dir = f"{rel_root}/{dirname}" if rel_root else dirname
            dir_owner = classify_repo_path(rel_dir, policy)["owner_label"]
            if dirname == "__pycache__":
                full_bucket.pycache_dirs.append(rel_dir)
                if dir_owner == "antigravity_owned":
                    agy_bucket.pycache_dirs.append(rel_dir)
                kept_dirs.append(dirname)
            elif dirname in FORBIDDEN_BUILD_DIRS:
                entry = {"path": rel_dir, "kind": "directory", "owner": dir_owner}
                full_bucket.forbidden_build_outputs.append(entry)
                if dir_owner == "antigravity_owned":
                    agy_bucket.forbidden_build_outputs.append(entry)
            else:
                kept_dirs.append(dirname)
        dirs[:] = kept_dirs

        for filename in files:
            file_path = root_path / filename
            rel_file = f"{rel_root}/{filename}" if rel_root else filename
            owner = classify_repo_path(rel_file, policy)["owner_label"]
            try:
                raw = file_path.read_bytes()
            except OSError as exc:
                err_entry = {"path": rel_file, "owner": owner, "reason": f"read_error: {exc}"}
                full_bucket.files_scanned += 1
                full_bucket.non_utf8_files.append(err_entry)
                if owner == "antigravity_owned":
                    agy_bucket.files_scanned += 1
                    agy_bucket.non_utf8_files.append(err_entry)
                continue

            suffix = file_path.suffix
            _record_file_hygiene(
                full_bucket, rel_path=rel_file, owner=owner, raw=raw, suffix=suffix
            )
            if owner == "antigravity_owned":
                _record_file_hygiene(
                    agy_bucket, rel_path=rel_file, owner=owner, raw=raw, suffix=suffix
                )

    return {
        "antigravity_owned": agy_bucket.to_dict(),
        "full_repo": full_bucket.to_dict(),
    }


def _mask_secret(token: str) -> str:
    """Return a non-sensitive preview preserving prefix/tail length."""
    if len(token) <= 10:
        return token[:2] + "***"
    return f"{token[:6]}...{token[-4:]}"


def _is_template_placeholder(value: str) -> bool:
    """Return True for code interpolation placeholders like ``{api_key}`` or ``${TOKEN}``."""
    stripped = value.strip()
    return bool(TEMPLATE_EXPR_RE.match(stripped))


def _is_redacted_value(value: str) -> bool:
    """Return True if a credential value is an explicit redaction placeholder."""
    cleaned = value.strip().strip("\"'`.,;)").lower()
    if not cleaned:
        return True
    if cleaned in REDACTED_WORDS:
        return True
    if cleaned.startswith("<") and cleaned.endswith(">"):
        return True
    if cleaned.startswith("[") and cleaned.endswith("]"):
        return True
    if cleaned.startswith("{") and cleaned.endswith("}"):
        return True
    if set(cleaned) <= {"*", ".", "x", "-"} and len(cleaned) >= 3:
        return True
    if "redacted" in cleaned or "omitted" in cleaned:
        return True
    return False


def _strip_rust_strings_and_line_comments(line: str) -> str:
    """Strip Rust quoted literals and line comments for balanced brace tracking."""
    out: list[str] = []
    i = 0
    n = len(line)
    in_quote: str | None = None
    while i < n:
        ch = line[i]
        if in_quote:
            if ch == "\\" and i + 1 < n:
                i += 2
                continue
            if ch == in_quote:
                in_quote = None
            i += 1
            continue
        if ch == "/" and i + 1 < n and line[i + 1] == "/":
            break
        if ch == '"':
            in_quote = '"'
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _rust_test_line_numbers(lines: list[str]) -> set[int]:
    """Return 1-based line numbers inside ``#[cfg(test)]`` blocks of a Rust file."""
    test_lines: set[int] = set()
    pending_cfg_test = False
    in_test_block = False
    brace_depth = 0

    for lineno, line in enumerate(lines, 1):
        stripped = line.strip()
        if "#[cfg(test)]" in stripped:
            pending_cfg_test = True
            test_lines.add(lineno)
            continue
        if pending_cfg_test or in_test_block:
            test_lines.add(lineno)
            clean = _strip_rust_strings_and_line_comments(line)
            opens = clean.count("{")
            closes = clean.count("}")
            if pending_cfg_test and opens > 0:
                in_test_block = True
                pending_cfg_test = False
                brace_depth = opens - closes
                if brace_depth <= 0:
                    in_test_block = False
                    brace_depth = 0
            elif in_test_block:
                brace_depth += opens - closes
                if brace_depth <= 0:
                    in_test_block = False
                    brace_depth = 0
    return test_lines


SYNTHETIC_DUMMY_EXACT_RE = re.compile(
    r"^(?:secret|passwd|password|token|apikey|api_key|sig|signature)[_-]?\d{0,4}$"
)


def _extract_prefixed_token_body(value: str) -> str | None:
    """Return the random payload/signature body for real-prefix secrets, else None."""
    for rx in (SK_BODY_RE, GHP_BODY_RE, GHPAT_BODY_RE, AIZA_BODY_RE, JWT_3PART_RE):
        m = rx.match(value)
        if m:
            return m.group(1)
    return None


def _has_dummy_or_sequential_body(text: str) -> bool:
    """Return True only when ``text`` itself is unmistakably dummy or sequential."""
    lower = text.lower()
    if any(marker in lower for marker in PREFIXED_TOKEN_DUMMY_MARKERS):
        return True
    rev_alpha = ALPHABET_LOWER[::-1]
    if any(
        ALPHABET_LOWER[i : i + 8] in lower or rev_alpha[i : i + 8] in lower
        for i in range(len(ALPHABET_LOWER) - 7)
    ):
        return True
    if "0123456789" in lower:
        return True
    if REPEATED_CHAR_RUN_RE.search(lower) or REPEATED_GROUP_RUN_RE.search(lower):
        return True
    return False


def _is_synthetic_value(value: str, *, url_host: str | None = None) -> tuple[bool, str | None]:
    """Return ``(is_synthetic, reason)`` if ``value`` is demonstrably synthetic/dummy."""
    prefixed_body = _extract_prefixed_token_body(value)
    if prefixed_body is not None:
        if _has_dummy_or_sequential_body(prefixed_body):
            return True, "synthetic_prefixed_dummy_body"
        return False, None

    lower = value.lower()
    if SYNTHETIC_DUMMY_EXACT_RE.match(lower):
        return True, "synthetic_dummy_placeholder"
    if any(marker in lower for marker in SYNTHETIC_MARKERS):
        return True, "synthetic_marker_in_token"
    if any(ALPHABET_LOWER[i : i + 12] in lower for i in range(len(ALPHABET_LOWER) - 11)):
        return True, "sequential_alphabet_dummy"
    if "0123456789" in lower:
        return True, "sequential_digits_dummy"
    if url_host is not None:
        host_only = url_host.lower().split(":", 1)[0]
        is_rfc2606 = any(
            host_only == dom or host_only.endswith("." + dom) for dom in EXAMPLE_DOMAINS
        )
        is_loopback = host_only in LOOPBACK_HOSTS
        has_real_prefix = bool(
            SK_TOKEN_RE.search(value)
            or GHP_TOKEN_RE.search(value)
            or GHPAT_TOKEN_RE.search(value)
            or AIZA_TOKEN_RE.search(value)
            or JWT_3PART_RE.match(value)
            or value.startswith("eyJ")
        )
        if (is_rfc2606 or is_loopback) and not has_real_prefix:
            return True, "example_or_loopback_test_url"
    return False, None


def _scan_line_secrets(line: str) -> list[dict[str, str]]:
    """Return candidate secret matches on one line before synthetic/test classification."""
    candidates: list[dict[str, str]] = []

    for rule_name, regex in (
        ("openai_sk_token", SK_TOKEN_RE),
        ("github_pat_classic", GHP_TOKEN_RE),
        ("github_pat_fine_grained", GHPAT_TOKEN_RE),
        ("google_api_key", AIZA_TOKEN_RE),
    ):
        for match in regex.finditer(line):
            tok = match.group(0)
            candidates.append(
                {
                    "rule": rule_name,
                    "token": tok,
                    "classification_hint": "redacted" if _is_redacted_value(tok) else "candidate",
                    "url_host": "",
                }
            )

    for match in BEARER_TOKEN_RE.finditer(line):
        tok = match.group(1)
        if tok.lower() in PROSE_BEARER_WORDS or _is_template_placeholder(tok):
            continue
        if _is_redacted_value(tok):
            candidates.append(
                {
                    "rule": "bearer_token",
                    "token": tok,
                    "classification_hint": "redacted",
                    "url_host": "",
                }
            )
            continue
        if len(tok) >= 8 or any(ch.isdigit() or ch in "._-+=" for ch in tok):
            candidates.append(
                {
                    "rule": "bearer_token",
                    "token": tok,
                    "classification_hint": "candidate",
                    "url_host": "",
                }
            )

    for match in COOKIE_HEADER_RE.finditer(line):
        val = match.group(1).strip()
        if not val or val.lower() in PROSE_COOKIE_WORDS or _is_template_placeholder(val):
            continue
        if _is_redacted_value(val):
            candidates.append(
                {
                    "rule": "cookie_header",
                    "token": val,
                    "classification_hint": "redacted",
                    "url_host": "",
                }
            )
            continue
        if "=" in val or len(val) >= 6:
            candidates.append(
                {
                    "rule": "cookie_header",
                    "token": val,
                    "classification_hint": "candidate",
                    "url_host": "",
                }
            )

    for match in URL_USERINFO_RE.finditer(line):
        username = match.group(2)
        password = match.group(3)
        host_and_rest = match.group(4)
        host = host_and_rest.split("/", 1)[0].split(")", 1)[0].rstrip(".,;:")
        if _is_template_placeholder(password):
            continue
        if (
            host.lower().split(":", 1)[0] in DOC_GENERIC_HOSTS
            and username.lower() in {"user", "username"}
            and password.lower() in {"pass", "password", "secret", "token"}
        ):
            continue
        hint = "redacted" if _is_redacted_value(password) else "candidate"
        candidates.append(
            {
                "rule": "access_bearing_url_userinfo",
                "token": password,
                "classification_hint": hint,
                "url_host": host,
            }
        )

    for match in URL_SENSITIVE_PARAM_RE.finditer(line):
        full_url = match.group(1)
        param_val = match.group(3)
        host = full_url.split("://", 1)[1].split("/", 1)[0].split("?", 1)[0]
        hint = "redacted" if _is_redacted_value(param_val) else "candidate"
        candidates.append(
            {
                "rule": "access_bearing_url_query",
                "token": param_val,
                "classification_hint": hint,
                "url_host": host,
            }
        )

    for match in ACCESS_BEARING_URL_FIELD_RE.finditer(line):
        url_val = match.group(1)
        if URL_USERINFO_RE.search(url_val) or URL_SENSITIVE_PARAM_RE.search(url_val):
            continue
        if "://" in url_val:
            host = url_val.split("://", 1)[1].split("/", 1)[0].split("?", 1)[0]
            hint = "redacted" if _is_redacted_value(url_val) else "candidate"
            if "?" in url_val or "#" in url_val:
                candidates.append(
                    {
                        "rule": "access_bearing_url_field",
                        "token": url_val,
                        "classification_hint": hint,
                        "url_host": host,
                    }
                )

    return candidates


def _collect_secret_scan_paths(
    repo_root: Path,
    status_entries: Sequence[GitStatusEntry],
    *,
    scope: str,
) -> list[str]:
    """Determine repo-relative file paths to scan for secrets."""
    if scope == "changed":
        return sorted({e.path for e in status_entries if not e.deleted})
    if scope == "all":
        paths: list[str] = []
        for root, dirs, files in os.walk(repo_root):
            if ".git" in dirs:
                dirs.remove(".git")
            dirs[:] = sorted(d for d in dirs if d not in FORBIDDEN_BUILD_DIRS and d != "__pycache__")
            root_path = Path(root)
            rel_root = (
                ""
                if root_path == repo_root
                else _norm_slashes(str(root_path.relative_to(repo_root)))
            )
            for filename in sorted(files):
                paths.append(f"{rel_root}/{filename}" if rel_root else filename)
        return paths
    raise AuditError(f"Unsupported secret_scope: {scope!r}")


def audit_secrets(
    repo_root: Path,
    policy: OwnershipPolicy,
    status_entries: Sequence[GitStatusEntry],
    *,
    scope: str = "changed",
) -> dict[str, Any]:
    """Scan changed/untracked (or all) text files for non-redacted secrets."""
    rel_paths = _collect_secret_scan_paths(repo_root, status_entries, scope=scope)

    files_scanned = 0
    findings: list[dict[str, Any]] = []
    synthetic_test_fixtures: list[dict[str, Any]] = []
    redacted_placeholders: list[dict[str, Any]] = []

    for rel_path in rel_paths:
        file_path = repo_root / rel_path
        if not file_path.is_file():
            continue
        try:
            raw = file_path.read_bytes()
        except OSError:
            continue
        kind, text, _ = _inspect_text_bytes(raw, file_path.suffix)
        if kind != "text" or text is None:
            continue

        files_scanned += 1
        owner = classify_repo_path(rel_path, policy)["owner_label"]
        is_test_path = bool(TEST_FILE_PATH_RE.search(rel_path))
        lines = text.splitlines()
        rust_test_lines = (
            _rust_test_line_numbers(lines) if file_path.suffix.lower() == ".rs" else set()
        )

        for lineno, line in enumerate(lines, 1):
            in_test_context = is_test_path or (lineno in rust_test_lines)
            for cand in _scan_line_secrets(line):
                preview = _mask_secret(cand["token"])
                if cand["classification_hint"] == "redacted":
                    redacted_placeholders.append(
                        {
                            "file": rel_path,
                            "line": lineno,
                            "rule": cand["rule"],
                            "owner": owner,
                            "preview": preview,
                        }
                    )
                    continue

                if in_test_context:
                    url_host = cand["url_host"] or None
                    is_synth, synth_reason = _is_synthetic_value(
                        cand["token"], url_host=url_host
                    )
                    if is_synth:
                        synthetic_test_fixtures.append(
                            {
                                "file": rel_path,
                                "line": lineno,
                                "rule": cand["rule"],
                                "owner": owner,
                                "preview": preview,
                                "reason": synth_reason,
                            }
                        )
                        continue

                findings.append(
                    {
                        "file": rel_path,
                        "line": lineno,
                        "rule": cand["rule"],
                        "owner": owner,
                        "preview": preview,
                    }
                )

    return {
        "scope": scope,
        "files_scanned": files_scanned,
        "zero_secrets_clean": len(findings) == 0,
        "finding_count": len(findings),
        "synthetic_test_fixture_count": len(synthetic_test_fixtures),
        "redacted_placeholder_count": len(redacted_placeholders),
        "findings": findings,
        "synthetic_test_fixtures": synthetic_test_fixtures,
        "redacted_placeholders": redacted_placeholders,
    }


def audit_rust_inventory(
    repo_root: Path, policy: OwnershipPolicy
) -> dict[str, Any]:
    """Inventory all crates, ``Cargo.toml`` manifests, and ``*.rs`` files under ``rust/``."""
    rust_root = repo_root / "rust"
    if not rust_root.is_dir():
        return {
            "exists": False,
            "rust_root": "rust",
            "crate_count": 0,
            "total_cargo_toml": 0,
            "total_cargo_lock": 0,
            "total_rs_files": 0,
            "rustFiles": 0,
            "total_rs_bytes": 0,
            "crates": [],
            "root_level_files": [],
        }

    crates: list[dict[str, Any]] = []
    root_level_rs: list[str] = []
    root_cargo_toml = 0
    root_cargo_lock = 0
    total_rs_files = 0
    total_rs_bytes = 0
    total_cargo_toml = 0
    total_cargo_lock = 0

    for entry in sorted(rust_root.iterdir(), key=lambda p: p.name):
        if entry.is_file():
            rel = f"rust/{entry.name}"
            if entry.name == "Cargo.toml":
                root_cargo_toml += 1
                total_cargo_toml += 1
            elif entry.name == "Cargo.lock":
                root_cargo_lock += 1
                total_cargo_lock += 1
            elif entry.suffix == ".rs":
                root_level_rs.append(rel)
                total_rs_files += 1
                total_rs_bytes += entry.stat().st_size
            continue

        if not entry.is_dir() or entry.name in ("target", ".git"):
            continue

        crate_rel = f"rust/{entry.name}"
        crate_owner = classify_repo_path(f"{crate_rel}/Cargo.toml", policy)["owner_label"]
        crate_cargo_toml = 0
        crate_cargo_lock = 0
        crate_rs_files: list[str] = []
        crate_rs_bytes = 0

        for sub_root, dirs, files in os.walk(entry):
            dirs[:] = sorted(d for d in dirs if d not in ("target", ".git"))
            sub_path = Path(sub_root)
            for fname in sorted(files):
                fpath = sub_path / fname
                rel_file = _norm_slashes(str(fpath.relative_to(repo_root)))
                if fname == "Cargo.toml":
                    crate_cargo_toml += 1
                elif fname == "Cargo.lock":
                    crate_cargo_lock += 1
                elif fpath.suffix == ".rs":
                    crate_rs_files.append(rel_file)
                    crate_rs_bytes += fpath.stat().st_size

        total_cargo_toml += crate_cargo_toml
        total_cargo_lock += crate_cargo_lock
        total_rs_files += len(crate_rs_files)
        total_rs_bytes += crate_rs_bytes

        crates.append(
            {
                "name": entry.name,
                "path": crate_rel,
                "owner": crate_owner,
                "cargo_toml_count": crate_cargo_toml,
                "cargo_lock_count": crate_cargo_lock,
                "rs_file_count": len(crate_rs_files),
                "rs_bytes": crate_rs_bytes,
                "rs_files": crate_rs_files,
            }
        )

    return {
        "exists": True,
        "rust_root": "rust",
        "crate_count": len(crates),
        "total_cargo_toml": total_cargo_toml,
        "total_cargo_lock": total_cargo_lock,
        "total_rs_files": total_rs_files,
        "rustFiles": total_rs_files,
        "total_rs_bytes": total_rs_bytes,
        "root_cargo_toml_count": root_cargo_toml,
        "root_cargo_lock_count": root_cargo_lock,
        "root_level_rs_files": root_level_rs,
        "crates": crates,
    }


def run_consolidated_audit(
    repo_root: Path = DEFAULT_REPO_ROOT,
    ownership_path: Path = DEFAULT_OWNERSHIP_PATH,
    *,
    expected_branch: str | None = None,
    secret_scope: str = "changed",
    include_timestamp: bool = False,
) -> dict[str, Any]:
    """Run all 4 audit lanes read-only and assemble a deterministic report dictionary."""
    resolved_repo = repo_root.resolve()
    resolved_ownership = ownership_path.resolve()
    policy = load_ownership_policy(resolved_ownership, resolved_repo)

    branch_ownership, status_entries = audit_branch_and_ownership(
        resolved_repo, policy, expected_branch=expected_branch
    )
    hygiene = audit_hygiene(resolved_repo, policy)
    secrets = audit_secrets(
        resolved_repo, policy, status_entries, scope=secret_scope
    )
    rust_inventory = audit_rust_inventory(resolved_repo, policy)

    agy_hyg = hygiene["antigravity_owned"]["summary"]
    full_hyg = hygiene["full_repo"]["summary"]
    own_sum = branch_ownership["ownership_summary"]
    branch_info = branch_ownership["branch"]

    overall_gates = {
        "branch_ok": branch_info["branch_ok"],
        "overlap_clean": own_sum["overlap_clean"],
        "no_unassigned_dirty_files_ok": own_sum["no_unassigned_dirty_files"],
        "disjoint_ownership_ok": own_sum["disjoint_clean"],
        "antigravity_hygiene_strict_ok": agy_hyg["hygiene_clean_strict"],
        "full_repo_hygiene_hard_gates_ok": full_hyg["hygiene_clean_hard_gates"],
        "full_repo_hygiene_strict_ok": full_hyg["hygiene_clean_strict"],
        "zero_secrets_ok": secrets["zero_secrets_clean"],
    }
    antigravity_ready = (
        overall_gates["branch_ok"]
        and overall_gates["overlap_clean"]
        and overall_gates["antigravity_hygiene_strict_ok"]
        and overall_gates["full_repo_hygiene_hard_gates_ok"]
        and overall_gates["zero_secrets_ok"]
    )
    strict_ready = all(overall_gates.values())

    core_payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "repo_root": _norm_slashes(str(resolved_repo)),
        "ownership_policy": {
            "source_path": _norm_slashes(str(resolved_ownership)),
            "schema_version": policy.schema_version,
            "updated_at": policy.updated_at,
            "expected_branch": policy.expected_branch,
        },
        "summary": {
            "strict_ready": strict_ready,
            "antigravity_ready": antigravity_ready,
            "gates": overall_gates,
            "branch": branch_info["actual_branch"],
            "head_commit": branch_info["head_commit"],
            "dirty_total": own_sum["total_dirty_paths"],
            "dirty_codex_owned": own_sum["codex_owned_count"],
            "dirty_antigravity_owned": own_sum["antigravity_owned_count"],
            "dirty_shared_or_unassigned": own_sum["shared_or_unassigned_count"],
            "overlap_violations": own_sum["total_overlap_violation_count"],
            "antigravity_files_scanned": agy_hyg["files_scanned"],
            "full_repo_files_scanned": full_hyg["files_scanned"],
            "full_repo_trailing_whitespace_files": full_hyg["trailing_whitespace_file_count"],
            "secret_findings": secrets["finding_count"],
            "synthetic_test_fixtures": secrets["synthetic_test_fixture_count"],
            "rustFiles": rust_inventory["total_rs_files"],
            "rust_crates": rust_inventory["crate_count"],
            "rust_cargo_toml": rust_inventory["total_cargo_toml"],
        },
        "branch_and_ownership": branch_ownership,
        "hygiene": hygiene,
        "secrets": secrets,
        "rust_inventory": rust_inventory,
    }

    canonical_bytes = json.dumps(
        core_payload, indent=2, ensure_ascii=False, sort_keys=False
    ).encode("utf-8")
    core_payload["deterministic_digest_sha256"] = hashlib.sha256(canonical_bytes).hexdigest()
    if include_timestamp:
        core_payload["audited_at_utc"] = datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
    return core_payload


def format_markdown_summary(report: Mapping[str, Any]) -> str:
    """Format a concise UTF-8 LF Markdown summary from a consolidated audit report."""
    s = report["summary"]
    g = s["gates"]
    lines = [
        "# Omnia Consolidated Cross-Lane Audit",
        "",
        f"- **Schema**: `{report['schema_version']}`",
        f"- **Repo**: `{report['repo_root']}`",
        f"- **Branch**: `{s['branch']}` (`branch_ok={g['branch_ok']}`, `head={s['head_commit']}`)",
        f"- **Strict Ready (full repo)**: `{s['strict_ready']}`",
        f"- **Antigravity Ready**: `{s['antigravity_ready']}`",
        f"- **Deterministic Digest (SHA-256)**: `{report['deterministic_digest_sha256']}`",
        "",
        "## Ownership Partition (`git status --porcelain`)",
        f"- `codex_owned`: {s['dirty_codex_owned']}",
        f"- `antigravity_owned`: {s['dirty_antigravity_owned']}",
        f"- `shared_or_unassigned`: {s['dirty_shared_or_unassigned']} (`no_unassigned_dirty_files_ok={g['no_unassigned_dirty_files_ok']}`)",
        f"- `overlap_violations`: {s['overlap_violations']} (`overlap_clean={g['overlap_clean']}`, `disjoint_ownership_ok={g['disjoint_ownership_ok']}`)",
        "",
        "## Hygiene",
        f"- **Antigravity-owned** (`{s['antigravity_files_scanned']}` files): `strict_clean={g['antigravity_hygiene_strict_ok']}`",
        f"- **Full repo** (`{s['full_repo_files_scanned']}` files): `hard_gates_ok={g['full_repo_hygiene_hard_gates_ok']}`, `strict_clean_ok={g['full_repo_hygiene_strict_ok']}`, `trailing_whitespace_files={s['full_repo_trailing_whitespace_files']}`",
        "",
        "## Zero-Secret Scan",
        f"- `finding_count`: {s['secret_findings']} (`zero_secrets_ok={g['zero_secrets_ok']}`)",
        f"- `synthetic_test_fixture_count`: {s['synthetic_test_fixtures']}",
        "",
        "## Rust Inventory (`rustFiles` Ground Truth)",
        f"- `rustFiles` (`*.rs` total): **{s['rustFiles']}** across **{s['rust_crates']}** crates (`{s['rust_cargo_toml']}` `Cargo.toml` files)",
    ]
    for crate in report["rust_inventory"]["crates"]:
        lines.append(
            f"  - `{crate['name']}` ({crate['owner']}): {crate['rs_file_count']} `*.rs`, {crate['cargo_toml_count']} `Cargo.toml`"
        )
    lines.append("")
    return "\n".join(lines)


def _write_utf8_lf(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))


def build_arg_parser() -> argparse.ArgumentParser:
    """Create the CLI argument parser for ``omnia-consolidated-audit``."""
    parser = argparse.ArgumentParser(
        description=(
            "Read-only cross-lane pre-commit, disjoint ownership, hygiene, "
            "zero-secret, and Rust inventory auditor for Omnia."
        )
    )
    parser.add_argument(
        "--repo",
        type=Path,
        default=DEFAULT_REPO_ROOT,
        help="Path to the target Git repository (default: D:\\Omnia).",
    )
    parser.add_argument(
        "--ownership",
        type=Path,
        default=DEFAULT_OWNERSHIP_PATH,
        help="Path to DISJOINT_OWNERSHIP.json.",
    )
    parser.add_argument(
        "--expected-branch",
        default=None,
        help="Override expected working branch (defaults to ownership policy branch).",
    )
    parser.add_argument(
        "--secret-scope",
        choices=("changed", "all"),
        default="changed",
        help="Secret scan file scope: 'changed' (git status) or 'all' (default: changed).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write full JSON report to this UTF-8 LF path.",
    )
    parser.add_argument(
        "--md-out",
        type=Path,
        default=None,
        help="Write Markdown summary report to this UTF-8 LF path.",
    )
    parser.add_argument(
        "--include-timestamp",
        action="store_true",
        help="Include volatile UTC timestamp in the output report.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero unless the selected --strict-scope readiness gate is True.",
    )
    parser.add_argument(
        "--strict-scope",
        choices=("full", "antigravity"),
        default="full",
        help="Readiness gate checked by --strict: 'full' (default) or 'antigravity'.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point returning 0 on success (or 1 on --strict gate failure)."""
    args = build_arg_parser().parse_args(argv)
    report = run_consolidated_audit(
        repo_root=args.repo,
        ownership_path=args.ownership,
        expected_branch=args.expected_branch,
        secret_scope=args.secret_scope,
        include_timestamp=args.include_timestamp,
    )
    if args.out is not None:
        _write_utf8_lf(
            args.out, json.dumps(report, indent=2, ensure_ascii=False) + "\n"
        )
    if args.md_out is not None:
        _write_utf8_lf(args.md_out, format_markdown_summary(report))

    print(json.dumps(report["summary"], indent=2, ensure_ascii=False))
    if args.strict:
        ready_key = (
            "antigravity_ready"
            if args.strict_scope == "antigravity"
            else "strict_ready"
        )
        if not report["summary"][ready_key]:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
