#!/usr/bin/env python3
"""Unit tests and read-only live smoke tests for ``omnia-consolidated-audit``."""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    _SELF_DIR = str(Path(__file__).resolve().parent)
    if _SELF_DIR not in sys.path:
        sys.path.insert(0, _SELF_DIR)
    import audit  # type: ignore[no-redef]
else:
    from . import audit


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _write_lf(path: Path, text: str) -> None:
    _write_bytes(path, text.replace("\r\n", "\n").encode("utf-8"))


def _write_ownership_json(
    path: Path,
    repo_root: Path,
    *,
    branch: str = "codex/omnia-context-integration",
    codex_owned: list[str] | None = None,
    codex_forbidden: list[str] | None = None,
    agy_owned: list[str] | None = None,
    agy_forbidden: list[str] | None = None,
) -> Path:
    root_posix = repo_root.resolve().as_posix()
    payload: dict[str, Any] = {
        "schema_version": 3,
        "updated_at": "2026-11-14T19:00:00+07:00",
        "branch": branch,
        "owners": {
            "codex_01a1d643": {
                "owned_write_paths": codex_owned
                if codex_owned is not None
                else [
                    f"{root_posix}/rust/omnia-runtime/**",
                    f"{root_posix}/cpp/**",
                    f"{root_posix}/.agents/skills/kdense-*/**",
                    f"{root_posix}/README.md",
                    "D:/OmniaData/build/cpp20-msvc/**",
                ],
                "forbidden_write_paths": codex_forbidden
                if codex_forbidden is not None
                else [
                    f"{root_posix}/tools/omnia-consolidated-audit/**",
                    f"{root_posix}/rust/omnia-workspace-ops/**",
                ],
            },
            "antigravity_f6bc937a": {
                "owned_write_paths": agy_owned
                if agy_owned is not None
                else [
                    f"{root_posix}/tools/omnia-consolidated-audit/**",
                    f"{root_posix}/rust/omnia-workspace-ops/**",
                    f"{root_posix}/platform/**",
                    f"{root_posix}/.agents/skills/deep-clean/agents/openai.yaml",
                    "D:/OmniaData/qa/agy-parallel-20261114/**",
                ],
                "forbidden_write_paths": agy_forbidden
                if agy_forbidden is not None
                else [
                    f"{root_posix}/rust/omnia-runtime/**",
                    f"{root_posix}/cpp/**",
                    f"{root_posix}/README.md",
                ],
            },
        },
    }
    _write_lf(path, json.dumps(payload, indent=2) + "\n")
    return path


def _git(repo: Path, *args: str) -> None:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {proc.stderr or proc.stdout}")


def _init_git_repo(repo: Path, branch: str = "codex/omnia-context-integration") -> None:
    _git(repo, "init")
    _git(repo, "config", "user.name", "Audit Tester")
    _git(repo, "config", "user.email", "audit-tester@example.test")
    _git(repo, "checkout", "-b", branch)
    _write_lf(repo / "README.md", "# Temp Repo\n")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-m", "initial")


class OwnershipClassifierTests(unittest.TestCase):
    def test_glob_overlap_detector(self) -> None:
        self.assertFalse(
            audit.patterns_can_overlap(
                "rust/omnia-runtime/**", "rust/omnia-workspace-ops/**"
            )
        )
        self.assertFalse(
            audit.patterns_can_overlap(
                ".agents/skills/kdense-*/**",
                ".agents/skills/deep-clean/agents/openai.yaml",
            )
        )
        self.assertFalse(audit.patterns_can_overlap("foo-*", "bar-*"))
        self.assertTrue(audit.patterns_can_overlap("cpp/**", "cpp/src/**"))
        self.assertTrue(
            audit.patterns_can_overlap("tools/omnia-*/**", "tools/omnia-skill-parity/**")
        )
        self.assertTrue(audit.patterns_can_overlap("foo-*", "*-bar"))
        self.assertTrue(audit.patterns_can_overlap("*.md", "README.md"))

    def test_ownership_partition_and_overlap_detection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            _init_git_repo(repo, branch="codex/omnia-context-integration")

            _write_lf(repo / "cpp" / "main.cpp", "int main() { return 0; }\n")
            _write_lf(repo / "platform" / "targets.json", "{}\n")
            _write_lf(repo / "docs" / "unassigned.md", "# Unassigned\n")

            ownership_file = _write_ownership_json(root / "DISJOINT_OWNERSHIP.json", repo)
            policy = audit.load_ownership_policy(ownership_file, repo)
            self.assertEqual(audit.check_policy_overlaps(policy)["overlap_count"], 0)

            res, entries = audit.audit_branch_and_ownership(repo, policy)
            self.assertTrue(res["branch"]["branch_ok"])
            self.assertFalse(res["branch"]["is_protected_branch"])
            self.assertEqual(len(entries), 3)
            self.assertEqual([e["path"] for e in res["partitions"]["codex_owned"]], ["cpp/main.cpp"])
            self.assertEqual(
                [e["path"] for e in res["partitions"]["antigravity_owned"]],
                ["platform/targets.json"],
            )
            self.assertEqual(
                [e["path"] for e in res["partitions"]["shared_or_unassigned"]],
                ["docs/unassigned.md"],
            )
            self.assertTrue(res["ownership_summary"]["overlap_clean"])
            self.assertFalse(res["ownership_summary"]["no_unassigned_dirty_files"])
            self.assertFalse(res["ownership_summary"]["disjoint_clean"])

            # Removing the unassigned file makes disjoint_clean True.
            (repo / "docs" / "unassigned.md").unlink()
            res_clean, _ = audit.audit_branch_and_ownership(repo, policy)
            self.assertTrue(res_clean["ownership_summary"]["overlap_clean"])
            self.assertTrue(res_clean["ownership_summary"]["no_unassigned_dirty_files"])
            self.assertTrue(res_clean["ownership_summary"]["disjoint_clean"])

            # Introduce an overlapping ownership rule and verify both policy + dirty overlap fail cleanly.
            overlap_file = _write_ownership_json(
                root / "OVERLAP_OWNERSHIP.json",
                repo,
                agy_owned=[f"{repo.resolve().as_posix()}/cpp/**"],
            )
            overlap_policy = audit.load_ownership_policy(overlap_file, repo)
            res2, _ = audit.audit_branch_and_ownership(repo, overlap_policy)
            self.assertFalse(res2["ownership_summary"]["overlap_clean"])
            self.assertFalse(res2["ownership_summary"]["disjoint_clean"])
            self.assertGreater(res2["ownership_summary"]["policy_overlap_count"], 0)
            self.assertEqual(res2["ownership_summary"]["dirty_overlap_violation_count"], 1)

    def test_protected_branch_and_porcelain_z_rename(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            _init_git_repo(repo, branch="master")

            ownership_file = _write_ownership_json(root / "DISJOINT_OWNERSHIP.json", repo)
            policy = audit.load_ownership_policy(ownership_file, repo)
            res, _ = audit.audit_branch_and_ownership(repo, policy)
            self.assertTrue(res["branch"]["is_protected_branch"])
            self.assertFalse(res["branch"]["branch_ok"])

            parsed = audit.parse_git_status_porcelain_z(
                b"R  platform/new.json\x00platform/old.json\x00?? cpp/a.cpp\x00D  README.md\x00"
            )
            self.assertEqual(len(parsed), 3)
            self.assertEqual(parsed[0].path, "platform/new.json")
            self.assertEqual(parsed[0].orig_path, "platform/old.json")
            self.assertFalse(parsed[0].deleted)
            self.assertTrue(parsed[2].deleted)


class HygieneDetectorTests(unittest.TestCase):
    def test_hygiene_separates_antigravity_and_full_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            ownership_file = _write_ownership_json(root / "DISJOINT_OWNERSHIP.json", repo)
            policy = audit.load_ownership_policy(ownership_file, repo)

            # Clean Antigravity file.
            _write_lf(repo / "platform" / "targets.json", "{\n  \"ok\": true\n}\n")
            # Setext Markdown header using ======= must NOT trigger merge conflict marker.
            _write_lf(repo / "platform" / "README.md", "Title\n=======\n\nClean text.\n")

            # Dirty Codex-owned files (CRLF, trailing space, invalid UTF-8, CMakeCache.txt).
            _write_bytes(repo / "cpp" / "win.cpp", b"int x = 1;\r\n")
            _write_lf(repo / "cpp" / "ws.hpp", "int y = 2;   \n")
            _write_bytes(repo / "cpp" / "bad.txt", b"\xff\xfe\xfd")
            _write_lf(repo / "cpp" / "CMakeCache.txt", "CMAKE_BUILD_TYPE:STRING=Release\n")
            _write_lf(repo / "cpp" / "build" / "ignored.obj", "obj")
            _write_lf(repo / "rust" / "omnia-runtime" / "target" / "debug.txt", "bin")

            # Unassigned conflict marker + pycache/pyc.
            conflict_doc = (
                "<" * 7 + " HEAD\nleft\n" + "=" * 7 + "\nright\n" + ">" * 7 + " main\n"
            )
            _write_lf(repo / "docs" / "conflict.md", conflict_doc)
            _write_bytes(repo / "docs" / "__pycache__" / "mod.cpython-315.pyc", b"\x00\x01\x02")

            hyg = audit.audit_hygiene(repo, policy)
            agy_sum = hyg["antigravity_owned"]["summary"]
            full_sum = hyg["full_repo"]["summary"]

            self.assertTrue(agy_sum["hygiene_clean_strict"])
            self.assertEqual(agy_sum["files_scanned"], 2)
            self.assertEqual(agy_sum["crlf_count"], 0)

            self.assertFalse(full_sum["hygiene_clean_hard_gates"])
            self.assertEqual(full_sum["crlf_count"], 1)
            self.assertEqual(full_sum["non_utf8_count"], 1)
            self.assertEqual(full_sum["pycache_dir_count"], 1)
            self.assertEqual(full_sum["pyc_file_count"], 1)
            self.assertEqual(full_sum["forbidden_build_output_count"], 3)
            self.assertEqual(full_sum["merge_conflict_marker_count"], 3)
            self.assertEqual(full_sum["trailing_whitespace_file_count"], 1)

    def test_hygiene_catches_pycache_and_crlf_inside_antigravity_owned(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            ownership_file = _write_ownership_json(root / "DISJOINT_OWNERSHIP.json", repo)
            policy = audit.load_ownership_policy(ownership_file, repo)

            _write_bytes(
                repo / "tools" / "omnia-consolidated-audit" / "__pycache__" / "a.pyc",
                b"\x00\x02",
            )
            _write_bytes(
                repo / "tools" / "omnia-consolidated-audit" / "crlf.py",
                b"x = 1\r\n",
            )

            hyg = audit.audit_hygiene(repo, policy)
            agy_sum = hyg["antigravity_owned"]["summary"]
            self.assertFalse(agy_sum["hygiene_clean_hard_gates"])
            self.assertEqual(agy_sum["pycache_dir_count"], 1)
            self.assertEqual(agy_sum["pyc_file_count"], 1)
            self.assertEqual(agy_sum["crlf_count"], 1)


class SecretDetectorTests(unittest.TestCase):
    def test_detects_real_secrets_and_separates_redacted_and_synthetic(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            _init_git_repo(repo, branch="codex/omnia-context-integration")
            ownership_file = _write_ownership_json(root / "DISJOINT_OWNERSHIP.json", repo)
            policy = audit.load_ownership_policy(ownership_file, repo)

            # Construct candidate secrets dynamically so this test source stays clean.
            sk_real = "sk-" + "live-" + "9xK2mP7qL4vR8wN3zB6c"
            ghp_real = "ghp_" + "9xK2mP7qL4vR8wN3zB6cT1yF5hJ0dA2sE8uI"
            ghpat_real = "github_pat_" + "11ABCDEFG_0987654321zyxwvutsrqponm"
            aiza_real = "AIza" + "SyB9xK2mP7qL4vR8wN3zB6cT1yF5hJ0d"
            bearer_real = "Bearer " + "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
            cookie_real = "Cookie: " + "session=9xK2mP7qL4vR8wN3"
            url_real = "https://files.internal.invalid/dl?access_token=" + "tok_9xK2mP7qL4vR8"

            _write_lf(
                repo / "platform" / "leaks.txt",
                "\n".join(
                    [
                        f"a={sk_real}",
                        f"b={ghp_real}",
                        f"c={ghpat_real}",
                        f"d={aiza_real}",
                        f"e={bearer_real}",
                        f"f={cookie_real}",
                        f"g={url_real}",
                    ]
                )
                + "\n",
            )

            # Redacted + prose + template interpolation examples should NEVER trigger findings.
            _write_lf(
                repo / "platform" / "safe.py",
                "\n".join(
                    [
                        "# Rejects Bearer tokens, `Cookie:` headers, and https://user:pass@host.",
                        'HDR = "Bearer omitted"',
                        'TPL1 = f"Bearer {api_key}"',
                        'TPL2 = f"Bearer {self.api_key}"',
                        'URL = "https://gateway.example.test?token=redacted"',
                        'CK = "Cookie: [REDACTED]"',
                    ]
                )
                + "\n",
            )

            # Synthetic test fixtures inside test_*.py and Rust #[cfg(test)] should go to synthetic_test_fixtures,
            # while a real secret placed AFTER Rust #[cfg(test)] mod tests { ... } must be flagged!
            sk_synth = "sk-" + "abcdefghijklmnopqrstuvwxyz"
            signed_synth = "https://cdn." + "example.com/dl/file?X-Amz-Signature=sigval123"
            loopback_synth = "http://user:" + "secret@127.0.0.1:9222"
            _write_lf(
                repo / "platform" / "test_redaction.py",
                "\n".join(
                    [
                        f'TOKEN = "{sk_synth}"',
                        f'SIGNED = "{signed_synth}"',
                        f'REAL_LEAK_IN_TEST = "{ghp_real}"',
                    ]
                )
                + "\n",
            )
            _write_lf(
                repo / "rust" / "omnia-workspace-ops" / "src" / "lib.rs",
                "\n".join(
                    [
                        "pub fn ok() {}",
                        "#[cfg(test)]",
                        "mod tests {",
                        f'    #[test] fn t() {{ let _u = "{loopback_synth}"; }}',
                        "}",
                        f'pub const AFTER_TEST_LEAK: &str = "{aiza_real}";',
                    ]
                )
                + "\n",
            )

            _, entries = audit.audit_branch_and_ownership(repo, policy)
            sec = audit.audit_secrets(repo, policy, entries, scope="changed")

            self.assertFalse(sec["zero_secrets_clean"])
            self.assertEqual(sec["finding_count"], 9, sec["findings"])
            rules_found = {f["rule"] for f in sec["findings"]}
            self.assertEqual(
                rules_found,
                {
                    "openai_sk_token",
                    "github_pat_classic",
                    "github_pat_fine_grained",
                    "google_api_key",
                    "bearer_token",
                    "cookie_header",
                    "access_bearing_url_query",
                },
            )
            self.assertEqual(sec["synthetic_test_fixture_count"], 3)
            self.assertEqual(sec["redacted_placeholder_count"], 3)

    def test_prefixed_token_hardening_rejects_test_substring_and_allows_dummy_body(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            _init_git_repo(repo, branch="codex/omnia-context-integration")
            ownership_file = _write_ownership_json(root / "DISJOINT_OWNERSHIP.json", repo)
            policy = audit.load_ownership_policy(ownership_file, repo)

            # High-entropy prefixed tokens containing "Test"/"Sample" MUST be flagged even inside test files.
            sk_with_test = "sk-" + "proj-" + "RealKey9xQp7m" + "Test" + "3kLzW8vR2n"
            ghp_with_sample = "ghp_" + "ZxQvBnMp9xQp7m" + "Sample" + "3kLzW8vR2nXy"
            aiza_with_test = "AIza" + "SyRealKey9xQp7m" + "Test" + "3kLzW8vR2n"
            jwt_header_payload_test = (
                "eyJhbGciOiJIUzI1NiJ9."
                "eyJzdWIiOiJ0ZXN0In0."
                "RealSignature9xQp7m3kLzW8vR2n"
            )

            # Genuinely dummy/sequential prefixed bodies inside test files ARE synthetic fixtures.
            sk_dummy_seq = "sk-" + "proj-" + "abcdef" + "123456" + "7890abcdef"
            sk_dummy_rep = "sk-" + "proj-" + ("1" * 20)
            jwt_dummy_sig = (
                "eyJhbGciOiJIUzI1NiJ9."
                "eyJzdWIiOiJ0ZXN0In0."
                "dummy_sig_12345678"
            )

            _write_lf(
                repo / "platform" / "test_hardening.py",
                "\n".join(
                    [
                        f'REAL_SK = "{sk_with_test}"',
                        f'REAL_GHP = "{ghp_with_sample}"',
                        f'REAL_AIZA = "{aiza_with_test}"',
                        f'REAL_JWT = "Bearer {jwt_header_payload_test}"',
                        f'DUMMY_SEQ = "{sk_dummy_seq}"',
                        f'DUMMY_REP = "{sk_dummy_rep}"',
                        f'DUMMY_JWT = "Bearer {jwt_dummy_sig}"',
                    ]
                )
                + "\n",
            )

            _, entries = audit.audit_branch_and_ownership(repo, policy)
            sec = audit.audit_secrets(repo, policy, entries, scope="changed")

            self.assertFalse(sec["zero_secrets_clean"])
            self.assertEqual(sec["finding_count"], 4, sec["findings"])
            self.assertEqual(
                [f["line"] for f in sec["findings"]],
                [1, 2, 3, 4],
            )
            self.assertEqual(sec["synthetic_test_fixture_count"], 3, sec["synthetic_test_fixtures"])
            self.assertEqual(
                [f["line"] for f in sec["synthetic_test_fixtures"]],
                [5, 6, 7],
            )


class ReadinessScopeAndStrictCliTests(unittest.TestCase):
    def test_strict_ready_vs_antigravity_ready_and_cli_exit_codes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            _init_git_repo(repo, branch="codex/omnia-context-integration")
            ownership_file = _write_ownership_json(root / "DISJOINT_OWNERSHIP.json", repo)

            # Antigravity is strictly clean, Codex has trailing whitespace, plus an unassigned dirty file.
            _write_lf(repo / "platform" / "targets.json", '{"ok": true}\n')
            _write_lf(repo / "cpp" / "codex_note.md", "Trailing space   \n")
            _write_lf(repo / "docs" / "unassigned.md", "# Unassigned\n")

            out_json = root / "out" / "receipt.json"
            out_md = root / "out" / "report.md"

            with contextlib.redirect_stdout(io.StringIO()):
                rc_full = audit.main(
                    [
                        "--repo",
                        str(repo),
                        "--ownership",
                        str(ownership_file),
                        "--out",
                        str(out_json),
                        "--md-out",
                        str(out_md),
                        "--strict",
                    ]
                )
            self.assertEqual(rc_full, 1)

            receipt = json.loads(out_json.read_text(encoding="utf-8"))
            md_text = out_md.read_text(encoding="utf-8")
            self.assertFalse(receipt["summary"]["strict_ready"])
            self.assertTrue(receipt["summary"]["antigravity_ready"])
            self.assertTrue(receipt["summary"]["gates"]["overlap_clean"])
            self.assertFalse(receipt["summary"]["gates"]["no_unassigned_dirty_files_ok"])
            self.assertFalse(receipt["summary"]["gates"]["disjoint_ownership_ok"])
            self.assertFalse(receipt["summary"]["gates"]["full_repo_hygiene_strict_ok"])
            self.assertIn("Strict Ready (full repo)**: `False`", md_text)
            self.assertIn("Antigravity Ready**: `True`", md_text)

            with contextlib.redirect_stdout(io.StringIO()):
                rc_agy = audit.main(
                    [
                        "--repo",
                        str(repo),
                        "--ownership",
                        str(ownership_file),
                        "--out",
                        str(out_json),
                        "--strict",
                        "--strict-scope",
                        "antigravity",
                    ]
                )
            self.assertEqual(rc_agy, 0)
            receipt_after = json.loads(out_json.read_text(encoding="utf-8"))
            self.assertFalse(receipt_after["summary"]["strict_ready"])
            self.assertTrue(receipt_after["summary"]["antigravity_ready"])

            # Fixing Codex trailing whitespace and removing unassigned file makes full --strict pass.
            _write_lf(repo / "cpp" / "codex_note.md", "No trailing space\n")
            (repo / "docs" / "unassigned.md").unlink()
            with contextlib.redirect_stdout(io.StringIO()):
                rc_full_clean = audit.main(
                    [
                        "--repo",
                        str(repo),
                        "--ownership",
                        str(ownership_file),
                        "--out",
                        str(out_json),
                        "--strict",
                    ]
                )
            self.assertEqual(rc_full_clean, 0)
            receipt_clean = json.loads(out_json.read_text(encoding="utf-8"))
            self.assertTrue(receipt_clean["summary"]["strict_ready"])
            self.assertTrue(receipt_clean["summary"]["antigravity_ready"])


class RustInventoryTests(unittest.TestCase):
    def test_counts_crates_and_ignores_target_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            ownership_file = _write_ownership_json(root / "DISJOINT_OWNERSHIP.json", repo)
            policy = audit.load_ownership_policy(ownership_file, repo)

            _write_lf(repo / "rust" / "omnia-runtime" / "Cargo.toml", "[package]\nname='r'\n")
            _write_lf(repo / "rust" / "omnia-runtime" / "src" / "main.rs", "fn main() {}\n")
            _write_lf(repo / "rust" / "omnia-runtime" / "src" / "skills.rs", "pub fn s() {}\n")
            _write_lf(repo / "rust" / "omnia-runtime" / "target" / "gen.rs", "// generated\n")

            _write_lf(
                repo / "rust" / "omnia-workspace-ops" / "Cargo.toml",
                "[package]\nname='w'\n",
            )
            _write_lf(
                repo / "rust" / "omnia-workspace-ops" / "Cargo.lock",
                "# lock\n",
            )
            _write_lf(repo / "rust" / "omnia-workspace-ops" / "src" / "lib.rs", "pub fn w() {}\n")
            _write_lf(
                repo / "rust" / "omnia-workspace-ops" / "tests" / "smoke.rs",
                "#[test] fn t() {}\n",
            )

            inv = audit.audit_rust_inventory(repo, policy)
            self.assertTrue(inv["exists"])
            self.assertEqual(inv["crate_count"], 2)
            self.assertEqual(inv["total_cargo_toml"], 2)
            self.assertEqual(inv["total_cargo_lock"], 1)
            self.assertEqual(inv["total_rs_files"], 4)
            self.assertEqual(inv["rustFiles"], 4)
            by_name = {c["name"]: c for c in inv["crates"]}
            self.assertEqual(by_name["omnia-runtime"]["owner"], "codex_owned")
            self.assertEqual(by_name["omnia-runtime"]["rs_file_count"], 2)
            self.assertEqual(by_name["omnia-workspace-ops"]["owner"], "antigravity_owned")
            self.assertEqual(by_name["omnia-workspace-ops"]["rs_file_count"], 2)


class LiveOmniaSmokeTests(unittest.TestCase):
    @unittest.skipUnless(
        audit.DEFAULT_REPO_ROOT.is_dir() and audit.DEFAULT_OWNERSHIP_PATH.is_file(),
        "Live D:\\Omnia repo or DISJOINT_OWNERSHIP.json not present",
    )
    def test_live_omnia_read_only_deterministic_smoke(self) -> None:
        r1 = audit.run_consolidated_audit(
            audit.DEFAULT_REPO_ROOT, audit.DEFAULT_OWNERSHIP_PATH
        )
        r2 = audit.run_consolidated_audit(
            audit.DEFAULT_REPO_ROOT, audit.DEFAULT_OWNERSHIP_PATH
        )
        j1 = json.dumps(r1, indent=2, ensure_ascii=False)
        j2 = json.dumps(r2, indent=2, ensure_ascii=False)
        self.assertEqual(j1, j2)
        self.assertEqual(r1["deterministic_digest_sha256"], r2["deterministic_digest_sha256"])

        self.assertTrue(r1["summary"]["gates"]["branch_ok"])
        self.assertTrue(r1["summary"]["gates"]["overlap_clean"])
        self.assertTrue(r1["summary"]["gates"]["antigravity_hygiene_strict_ok"])
        if (
            not r1["summary"]["gates"]["full_repo_hygiene_strict_ok"]
            or not r1["summary"]["gates"]["no_unassigned_dirty_files_ok"]
        ):
            self.assertFalse(r1["summary"]["strict_ready"])
        agy_secret_findings = [
            f for f in r1["secrets"]["findings"] if f["owner"] == "antigravity_owned"
        ]
        self.assertEqual(agy_secret_findings, [])
        self.assertGreaterEqual(r1["rust_inventory"]["crate_count"], 4)
        self.assertGreaterEqual(r1["rust_inventory"]["rustFiles"], 17)


if __name__ == "__main__":
    unittest.main()
