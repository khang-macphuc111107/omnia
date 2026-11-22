#!/usr/bin/env python3
"""Unit tests for `validate_skills.py`."""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import validate_skills as vs


def _write_lf(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))


def _make_skill(
    root: Path,
    folder: str,
    *,
    fm_name: str | None = None,
    description: str = "Deterministic test skill description for parity validation.",
    body: str = "# Demo Skill\n\nClean UTF-8 LF instructions — verified.\n",
    extra_fm: str = "",
    write_openai_yaml: bool = True,
    short_description: str = "Valid test skill short description for UI display",
    default_prompt: str | None = None,
) -> Path:
    skill_dir = root / folder
    skill_dir.mkdir(parents=True, exist_ok=True)
    actual_name = folder if fm_name is None else fm_name
    prompt_val = f"Use ${folder} to execute the test workflow." if default_prompt is None else default_prompt
    fm_lines = ["---"]
    if actual_name != "__OMIT__":
        fm_lines.append(f"name: {actual_name}")
    if description != "__OMIT__":
        fm_lines.append(f"description: {description}")
    if extra_fm:
        fm_lines.append(extra_fm.rstrip("\n"))
    fm_lines.append("---")
    _write_lf(skill_dir / "SKILL.md", "\n".join(fm_lines) + "\n\n" + body)
    if write_openai_yaml:
        _write_lf(
            skill_dir / "agents" / "openai.yaml",
            (
                "interface:\n"
                f'  display_name: "{folder}"\n'
                f'  short_description: "{short_description}"\n'
                f'  default_prompt: "{prompt_val}"\n'
            ),
        )
    return skill_dir


class ValidateSkillsTests(unittest.TestCase):
    def test_valid_skill_with_nested_name_passes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            extra = (
                "metadata:\n"
                "  openclaw:\n"
                "    envVars:\n"
                "    - name: NESTED_ENV_VAR\n"
                "      required: false\n"
            )
            skill_dir = _make_skill(root, "kdense-demo-skill", extra_fm=extra)
            res = vs.validate_skill_dir(skill_dir)
            self.assertTrue(res["valid"], msg=res["errors"])
            self.assertEqual(res["frontmatter_name"], "kdense-demo-skill")
            self.assertEqual(res["warnings"], [])

    def test_frontmatter_name_mismatch_fails(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            skill_dir = _make_skill(Path(td), "kdense-citation-management", fm_name="citation-management")
            res = vs.validate_skill_dir(skill_dir)
            self.assertFalse(res["valid"])
            self.assertTrue(any("!= folder name" in err for err in res["errors"]))

    def test_missing_description_and_todo_handling(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            no_desc = _make_skill(root, "no-desc", description="__OMIT__")
            res1 = vs.validate_skill_dir(no_desc)
            self.assertFalse(res1["valid"])
            self.assertTrue(any("missing top-level 'description'" in err for err in res1["errors"]))

            todo_outside = _make_skill(root, "todo-outside", body="[TODO: finish this]\n")
            res2 = vs.validate_skill_dir(todo_outside)
            self.assertFalse(res2["valid"])
            self.assertTrue(any("[TODO:...]" in err for err in res2["errors"]))

            todo_fenced = _make_skill(
                root,
                "todo-fenced",
                body="```markdown\n[TODO: example inside fence]\n```\n",
            )
            res3 = vs.validate_skill_dir(todo_fenced)
            self.assertTrue(res3["valid"], msg=res3["errors"])

    def test_description_angle_brackets_and_length_fail(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bad_angles = _make_skill(root, "bad-angles", description="Uses <forbidden> brackets")
            res1 = vs.validate_skill_dir(bad_angles)
            self.assertFalse(res1["valid"])
            self.assertTrue(any("angle brackets" in err for err in res1["errors"]))

            too_long = _make_skill(root, "too-long", description="x" * 1025)
            res2 = vs.validate_skill_dir(too_long)
            self.assertFalse(res2["valid"])
            self.assertTrue(any("> 1024" in err for err in res2["errors"]))

    def test_openai_yaml_missing_fields_and_prompt_token(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            missing_oy = _make_skill(root, "missing-oy", write_openai_yaml=False)
            res1 = vs.validate_skill_dir(missing_oy)
            self.assertFalse(res1["valid"])
            self.assertTrue(any("missing agents/openai.yaml" in err for err in res1["errors"]))

            bad_prompt = _make_skill(
                root,
                "bad-prompt",
                short_description="Too short",
                default_prompt="Run workflow without skill dollar mention.",
            )
            res2 = vs.validate_skill_dir(bad_prompt)
            self.assertFalse(res2["valid"])
            self.assertTrue(any("must reference $bad-prompt" in err for err in res2["errors"]))
            self.assertTrue(any("outside 25..64 chars" in w for w in res2["warnings"]))

    def test_openai_yaml_icon_traversal_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            skill_dir = _make_skill(root, "icon-escape", write_openai_yaml=False)
            _write_lf(
                skill_dir / "agents" / "openai.yaml",
                (
                    "interface:\n"
                    '  display_name: "Icon Escape"\n'
                    '  short_description: "Tests relative icon containment boundary"\n'
                    '  default_prompt: "Use $icon-escape to verify icon containment."\n'
                    '  icon_small: "../../outside.png"\n'
                ),
            )
            res = vs.validate_skill_dir(skill_dir)
            self.assertFalse(res["valid"])
            self.assertTrue(any("escapes skill root" in err for err in res["errors"]))

    def test_crlf_bom_and_control_bytes_detected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            skill_dir = _make_skill(root, "hygiene-bad")
            sk = skill_dir / "SKILL.md"
            raw = sk.read_bytes().replace(b"\n", b"\r\n")
            sk.write_bytes(b"\xef\xbb\xbf" + raw + b"\x0b")
            res = vs.validate_skill_dir(skill_dir)
            self.assertFalse(res["valid"])
            joined = "\n".join(res["errors"])
            self.assertIn("UTF-8 BOM", joined)
            self.assertIn("CRLF", joined)
            self.assertIn("0x0b", joined)

    def test_invalid_utf8_bytes_detected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "bad.md"
            p.write_bytes(b"# Title\n\xff\xfeinvalid\n")
            hygiene = vs.inspect_bytes_hygiene(p)
            self.assertFalse(hygiene["utf8_valid"])
            self.assertFalse(hygiene["clean"])

    def test_mojibake_detector_catches_double_utf8_and_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "mojibake.md"
            # Line 1: clean, Line 2: â€” (\xc3\xa2\xe2\x82\xac\xe2\x80\x9d), Line 3: CafÃ©, Line 4: Â·, Line 5: Ä‘, Line 6: U+FFFD
            content = (
                "Line one clean\n"
                "Double em-dash: â€” broken\n"
                "French: CafÃ©\n"
                "Bullet: Â· broken\n"
                "Vietnamese broken: Ä‘\n"
                "Replacement: \ufffd\n"
            )
            _write_lf(p, content)
            hygiene = vs.inspect_bytes_hygiene(p)
            self.assertFalse(hygiene["clean"])
            self.assertGreaterEqual(hygiene["mojibake_count"], 5)
            lines_hit = {f["line"] for f in hygiene["mojibake_findings"]}
            self.assertEqual(lines_hit, {2, 3, 4, 5, 6})

    def test_mojibake_detector_allows_clean_vietnamese_and_em_dash(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "clean_vi.md"
            _write_lf(
                p,
                "# Báo cáo Omnia — Kiểm toán Ổ D:\\\n"
                "Khởi động và Quy trình Omnia — MÃ SỐ, ÂM LƯỢNG, ĐÃ HOÀN TẤT.\n",
            )
            hygiene = vs.inspect_bytes_hygiene(p)
            self.assertTrue(hygiene["clean"], msg=hygiene["mojibake_findings"])
            self.assertEqual(hygiene["mojibake_count"], 0)
            self.assertEqual(hygiene["em_dash_utf8_count"], 2)

    def test_skills_json_validation(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            skills_root = ws / ".agents" / "skills"
            skills_root.mkdir(parents=True)
            manifest = ws / ".agents" / "skills.json"
            _write_lf(manifest, json.dumps({"entries": [{"path": ".agents/skills"}]}))
            ok = vs.validate_skills_json(manifest, workspace_root=ws, expected_skills_root=skills_root)
            self.assertTrue(ok["valid"], msg=ok["errors"])

            bad_manifest = ws / ".agents" / "bad_skills.json"
            _write_lf(bad_manifest, json.dumps({"entries": [{"path": "~/.codex/skills"}]}))
            bad = vs.validate_skills_json(
                bad_manifest,
                workspace_root=ws,
                expected_skills_root=skills_root,
                require_drive_absolute=True,
            )
            self.assertFalse(bad["valid"])
            self.assertTrue(any("unexpanded home token" in e for e in bad["errors"]))
            self.assertTrue(any("drive-absolute" in e for e in bad["errors"]))

    def test_cross_host_parity_sync_drift_and_missing(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            ws_skills = base / "ws" / ".agents" / "skills"
            codex = base / "codex"
            uagents = base / "uagents"
            for root in (ws_skills, codex, uagents):
                _make_skill(root, "skill-synced")
            _make_skill(ws_skills, "skill-drifted")
            _make_skill(codex, "skill-drifted", body="# Different body\n")
            _make_skill(uagents, "skill-drifted", write_openai_yaml=False)
            _make_skill(ws_skills, "skill-only-ws")

            parity = vs.check_cross_host_parity(ws_skills, {"codex": codex, "user_agents": uagents})
            self.assertEqual(parity["drift_count"], 2)
            self.assertEqual(parity["missing_mirror_count"], 2)
            by_slug = {r["slug"]: r for r in parity["workspace_skills_parity"]}
            self.assertTrue(by_slug["skill-synced"]["all_peers_in_sync"])
            self.assertFalse(by_slug["skill-drifted"]["all_peers_in_sync"])
            self.assertEqual(by_slug["skill-only-ws"]["peers"]["codex"]["status"], "missing_skill")

    def test_cross_host_duplicate_name_and_prefixed_twins(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            ws_skills = base / "ws_skills"
            codex = base / "codex"
            _make_skill(ws_skills, "kdense-citation-management", fm_name="citation-management")
            _make_skill(codex, "kdense-citation-management", fm_name="citation-management")
            _make_skill(codex, "citation-management", fm_name="citation-management")

            parity = vs.check_cross_host_parity(ws_skills, {"codex": codex})
            codex_dups = parity["root_summaries"]["codex"]["duplicate_frontmatter_names"]
            self.assertIn("citation-management", codex_dups)
            self.assertEqual(
                sorted(codex_dups["citation-management"]),
                ["citation-management", "kdense-citation-management"],
            )
            self.assertEqual(len(parity["prefixed_duplicate_twins"]), 1)
            self.assertTrue(parity["prefixed_duplicate_twins"][0]["frontmatter_name_collision"])

    def test_reparse_point_detection_unit(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            normal = Path(td) / "normal"
            normal.mkdir()
            self.assertFalse(vs.is_reparse_point(normal))
            fake_stat = SimpleNamespace(st_file_attributes=vs.FILE_ATTRIBUTE_REPARSE_POINT, st_mode=0)
            with mock.patch("os.lstat", return_value=fake_stat):
                self.assertTrue(vs.is_reparse_point(normal))

    def test_full_audit_and_cli_outputs_utf8_lf(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            ws = base / "Omnia"
            skills_root = ws / ".agents" / "skills"
            _make_skill(skills_root, "deep-clean")
            _write_lf(ws / ".agents" / "skills.json", json.dumps({"entries": [{"path": ".agents/skills"}]}))
            docs_dir = ws / "docs" / "workspace"
            _write_lf(docs_dir / "CHECKPOINT.md", "# Checkpoint — Valid UTF-8\n")
            staged = base / "staged-kdense"
            _make_skill(staged, "kdense-scientific-writing")
            codex = base / "codex"
            uagents = base / "uagents"
            _make_skill(codex, "deep-clean")
            _make_skill(uagents, "deep-clean")

            json_out = base / "out" / "receipt.json"
            md_out = base / "out" / "report.md"

            with contextlib.redirect_stdout(io.StringIO()):
                rc = vs.main(
                    [
                        "--workspace-root",
                        str(ws),
                        "--codex-skills",
                        str(codex),
                        "--user-agents-skills",
                        str(uagents),
                        "--global-skills-json",
                        str(base / "nonexistent_global.json"),
                        "--staged-kdense-dir",
                        str(staged),
                        "--json-out",
                        str(json_out),
                        "--md-out",
                        str(md_out),
                        "--strict",
                    ]
                )
            self.assertEqual(rc, 0)
            self.assertEqual(json_out.read_bytes().count(b"\r\n"), 0)
            self.assertEqual(md_out.read_bytes().count(b"\r\n"), 0)
            receipt = json.loads(json_out.read_text(encoding="utf-8"))
            self.assertEqual(receipt["summary"]["curated_runtime_valid"], 1)
            self.assertEqual(receipt["summary"]["staged_kdense_valid"], 1)
            self.assertTrue(receipt["summary"]["docs_workspace_clean"])

            # Inject a defect into deep-clean/agents/openai.yaml and verify --strict exits 1
            _write_lf(skills_root / "deep-clean" / "agents" / "openai.yaml", "interface:\n  display_name: \"x\"\n")
            with contextlib.redirect_stdout(io.StringIO()):
                rc_fail = vs.main(
                    [
                        "--workspace-root",
                        str(ws),
                        "--codex-skills",
                        str(codex),
                        "--user-agents-skills",
                        str(uagents),
                        "--global-skills-json",
                        str(base / "nonexistent_global.json"),
                        "--strict",
                    ]
                )
            self.assertEqual(rc_fail, 1)

    def test_portable_default_paths_use_home_and_repo_root(self) -> None:
        self.assertEqual(vs.DEFAULT_CODEX_SKILLS, Path.home() / ".codex" / "skills")
        self.assertEqual(vs.DEFAULT_USER_AGENTS_SKILLS, Path.home() / ".agents" / "skills")
        self.assertEqual(vs.DEFAULT_GLOBAL_SKILLS_JSON, Path.home() / ".gemini" / "config" / "skills.json")
        self.assertEqual(vs.DEFAULT_WORKSPACE_ROOT, Path(__file__).resolve().parents[2])

    def test_docs_hygiene_scan_reports_exact_line_on_mojibake(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            docs_dir = Path(td)
            _write_lf(docs_dir / "CLEAN.md", "# Clean — UTF-8 LF\n")
            _write_lf(docs_dir / "BROKEN.md", "# Line 1\n# Line 2\nBroken dash: â€” here\n")
            res = vs.scan_docs_hygiene(docs_dir)
            self.assertFalse(res["clean"])
            self.assertEqual(res["files_with_issues"], ["BROKEN.md"])
            broken = [f for f in res["files"] if Path(f["path"]).name == "BROKEN.md"][0]
            self.assertEqual(broken["mojibake_findings"][0]["line"], 3)


if __name__ == "__main__":
    unittest.main()
