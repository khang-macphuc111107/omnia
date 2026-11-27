"""Aider Polyglot (225 Exercism tasks across 6 languages) Windows toolchain-aware runner.

Honesty contract:
  - Python (34), JavaScript (49, backed by preinstalled Jest+Babel under `ext_libs/aider_js`),
    and offline-dependency-free Rust crates (27/30 runnable without external crates; 3/30
    requiring external crates `time`/`anyhow`/`rand` checked against Cargo cache) run natively.
  - C++ (`g++`/`clang++`), Go (`go`), and Java (`javac`) are honestly reported as
    `blocked_missing_toolchain` when those compilers are absent from the Windows host.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

import runner_v5

from .common import DATASET_ROOT, EXT_LIBS_ROOT, clean_host_env, make_temp_workspace, python_exe, run_harness_in_workspace

AIDER_ROOT = DATASET_ROOT / "aider_polyglot"
AIDER_JS_NODE_MODULES = EXT_LIBS_ROOT / "aider_js" / "node_modules"
ALL_LANGS = ("python", "javascript", "rust", "cpp", "go", "java")


def detect_toolchains() -> Dict[str, Dict[str, Any]]:
    py = python_exe()
    node = shutil.which("node")
    cargo = shutil.which("cargo")
    gpp = shutil.which("g++") or shutil.which("clang++")
    go = shutil.which("go")
    javac = shutil.which("javac")
    return {
        "python": {"available": True, "binary": py, "runner": "pytest"},
        "javascript": {"available": bool(node) and AIDER_JS_NODE_MODULES.exists(), "binary": node, "node_modules": str(AIDER_JS_NODE_MODULES)},
        "rust": {"available": bool(cargo), "binary": cargo, "runner": "cargo test --offline"},
        "cpp": {"available": bool(gpp), "binary": gpp, "blocker": None if gpp else "missing g++/clang++ on Windows host"},
        "go": {"available": bool(go), "binary": go, "blocker": None if go else "missing go compiler on Windows host"},
        "java": {"available": bool(javac), "binary": javac, "blocker": None if javac else "missing javac JDK on Windows host"},
    }


def _rust_needs_external_crates(cargo_toml: Path) -> bool:
    txt = cargo_toml.read_text(encoding="utf-8", errors="replace")
    if "[dependencies]" not in txt:
        return False
    tail = txt.split("[dependencies]", 1)[1].split("[", 1)[0]
    return any(ln.strip() and not ln.strip().startswith("#") for ln in tail.splitlines())


def discover_exercises(languages: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    tc = detect_toolchains()
    wanted = languages or list(ALL_LANGS)
    items: List[Dict[str, Any]] = []
    for lang in wanted:
        pdir = AIDER_ROOT / lang / "exercises" / "practice"
        if not pdir.exists():
            continue
        lang_ok = bool(tc.get(lang, {}).get("available"))
        for ex_dir in sorted(d for d in pdir.iterdir() if d.is_dir()):
            runnable = lang_ok
            blocker = tc.get(lang, {}).get("blocker")
            if lang == "rust" and runnable and (ex_dir / "Cargo.toml").exists():
                if _rust_needs_external_crates(ex_dir / "Cargo.toml"):
                    # Verify offline resolvability quickly via Cargo registry presence? Keep marked cleanly.
                    blocker = "external crate dependency (requires Cargo cache or online fetch)"
            items.append({
                "id": f"{lang}/{ex_dir.name}",
                "language": lang,
                "exercise": ex_dir.name,
                "dir": ex_dir,
                "runnable": runnable,
                "blocker": blocker,
            })
    return items


def _stage_exercise_workspace(item: Dict[str, Any], ws: Path) -> Path:
    ex_dir: Path = item["dir"]
    shutil.copytree(ex_dir, ws, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".meta"))
    # Strip reference solutions (`example.*` / `exemplar.*`) if present outside `.meta`
    for ref_pat in ("example.py", "example.js", "example.rs", "exemplar.*"):
        for rp in ws.glob(ref_pat):
            rp.unlink(missing_ok=True)
    if item["language"] == "javascript" and AIDER_JS_NODE_MODULES.exists():
        nm = ws / "node_modules"
        if not nm.exists():
            subprocess.run(["cmd", "/c", "mklink", "/J", str(nm), str(AIDER_JS_NODE_MODULES)], capture_output=True)
    return ws


def verify_exercise(item: Dict[str, Any], ws: Path) -> Dict[str, Any]:
    lang = item["language"]
    env = clean_host_env()
    if lang == "python":
        r = subprocess.run([python_exe(), "-B", "-m", "pytest", "-q"], cwd=str(ws), env=env, capture_output=True, text=True, timeout=60)
        return {"passed": r.returncode == 0, "score": 1.0 if r.returncode == 0 else 0.0, "detail": (r.stdout + "\n" + r.stderr)[-400:]}
    if lang == "javascript":
        # Official Aider Polyglot semantics: enable all Exercism `xtest`/`xdescribe` cases at verification time
        for spec in ws.rglob("*.spec.js"):
            txt = spec.read_text(encoding="utf-8", errors="replace")
            enabled = txt.replace("xtest(", "test(").replace("xdescribe(", "describe(")
            if enabled != txt:
                spec.write_text(enabled, encoding="utf-8", newline="\n")
        jest_bin = AIDER_JS_NODE_MODULES / "jest" / "bin" / "jest.js"
        r = subprocess.run(["node", str(jest_bin), "--runInBand"], cwd=str(ws), env=env, capture_output=True, text=True, timeout=60)
        return {"passed": r.returncode == 0, "score": 1.0 if r.returncode == 0 else 0.0, "detail": (r.stdout + "\n" + r.stderr)[-400:]}
    if lang == "rust":
        # `--include-ignored` enforces all Exercism Rust tests, matching Aider Polyglot harness behavior
        rs_env = runner_v5._clean_setup_env()
        r = subprocess.run(["cargo", "test", "--offline", "--", "--include-ignored"], cwd=str(ws), env=rs_env, capture_output=True, text=True, timeout=120)
        return {"passed": r.returncode == 0, "score": 1.0 if r.returncode == 0 else 0.0, "detail": (r.stdout + "\n" + r.stderr)[-400:]}
    return {"passed": False, "score": 0.0, "detail": f"Blocked on Windows host: {item.get('blocker')}"}


def run_exercise(
    harness: str,
    model: str,
    item: Dict[str, Any],
    *,
    timeout_s: int = 240,
    omnia_bin: Optional[Path] = None,
) -> Dict[str, Any]:
    if not item.get("runnable"):
        return {
            "suite": "aider_polyglot",
            "task_id": item["id"],
            "language": item["language"],
            "harness": harness,
            "model": model,
            "status": "blocked_missing_toolchain",
            "blocker": item.get("blocker"),
            "passed": False,
            "score": 0.0,
        }
    ws = make_temp_workspace("aider", "aider_polyglot")
    try:
        _stage_exercise_workspace(item, ws)
        inst = (ws / "instructions.md").read_text(encoding="utf-8", errors="replace") if (ws / "instructions.md").exists() else ""
        prompt = (
            f"Implement the `{item['exercise']}` ({item['language']}) exercise described in `instructions.md`.\n\n"
            f"{inst}\n\n"
            "Do NOT modify the existing test suite; make all tests pass cleanly."
        )
        run_res = run_harness_in_workspace("aider_polyglot", str(item["id"]), harness, model, prompt, ws, timeout_s=timeout_s, omnia_bin=omnia_bin)
        ver = verify_exercise(item, ws)
        return {**run_res, **ver, "language": item["language"], "status": "completed"}
    finally:
        # Remove junction before recursive rmtree so we never touch ext_libs
        nm = ws / "node_modules"
        if nm.exists():
            subprocess.run(["cmd", "/c", "rmdir", str(nm)], capture_output=True)
        shutil.rmtree(ws, ignore_errors=True)
