"""Automated Suite Integrity Validator & Manifest Generator.

Verifies every task under `suite/tasks/`:
  1. `task.json`, `prompt.md`, `workspace/`, `verify.py` exist and conform to schema.
  2. Copies `workspace/` into a fresh isolated temp dir, runs `setup.py` if configured,
     and executes `verify.py --workspace <tmp>`.
  3. Asserts the UNMODIFIED baseline workspace FAILS verification (`passed == False`, rc != 0).
  4. For Axis 1 SWE-bench (`fail_to_pass`) tasks, additionally verifies:
     - `pass_to_pass.total > 0` and `pass_to_pass.passed == pass_to_pass.total` (100% pass on baseline)
     - `fail_to_pass.total > 0` and `fail_to_pass.passed == 0` (0% pass on baseline)
  5. Writes `suite/manifest.json` summarizing all verified tasks.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

from runner import BENCH_ROOT, TASKS_DIR, build_clean_env, discover_tasks, prepare_workspace, run_verifier


def main() -> int:
    env = build_clean_env()
    tasks = discover_tasks()
    if not tasks:
        print("ERROR: No tasks found in", TASKS_DIR)
        return 1

    failures = []
    manifest_tasks = []

    print(f"=== Validating {len(tasks)} benchmark tasks ===", flush=True)
    for task in tasks:
        tid = task["id"]
        tdir: Path = task["_dir"]
        prompt_path = tdir / task.get("prompt_file", "prompt.md")
        verify_path = tdir / task.get("verify_script", "verify.py")

        if not prompt_path.exists() or prompt_path.stat().st_size < 50:
            failures.append(f"{tid}: missing or empty prompt.md")
            continue
        if not verify_path.exists():
            failures.append(f"{tid}: missing verify.py")
            continue

        tmp = Path(tempfile.mkdtemp(prefix=f"hb_val_{tid}_"))
        try:
            prepare_workspace(task, tmp, env)
            res = run_verifier(task, tmp, env, timeout_s=90)
            passed = bool(res.get("passed"))
            rc = res.get("verifier_exit_code")
            f2p = res.get("fail_to_pass") or {}
            p2p = res.get("pass_to_pass") or {}
            err = res.get("error")

            ok = True
            notes = []
            if passed or rc != 1:
                ok = False
                notes.append(f"expected graded failure (passed=False, rc=1); got passed={passed}, rc={rc}")
            if err or not any(c.get("passed") is False for c in res.get("checks", [])):
                ok = False
                notes.append(f"verifier error: {err}" if err else "no failed grading check")
            if task.get("grading_type") == "fail_to_pass":
                if not p2p.get("total") or p2p.get("passed") != p2p.get("total"):
                    ok = False
                    notes.append(f"SWE baseline pass_to_pass broken: {p2p}")
                if not f2p.get("total") or f2p.get("passed", 0) != 0:
                    ok = False
                    notes.append(f"SWE baseline fail_to_pass not 0: {f2p}")

            status = "OK" if ok else "FAIL"
            print(
                f"  [{status}] A{task['axis']} {tid:30s} | base_score={res.get('score', 0):.2f} | "
                f"f2p={f2p.get('passed', 0)}/{f2p.get('total', 0)} | p2p={p2p.get('passed', 0)}/{p2p.get('total', 0)} | "
                f"dur={res.get('verifier_duration_s', 0):.2f}s"
                + (f" | {'; '.join(notes)}" if notes else ""),
                flush=True,
            )
            if not ok:
                failures.append(f"{tid}: {'; '.join(notes)}")
            else:
                manifest_tasks.append({k: v for k, v in task.items() if k != "_dir"})
        except Exception as exc:
            print(f"  [FAIL] A{task['axis']} {tid:30s} | exception: {exc}", flush=True)
            failures.append(f"{tid}: exception {exc}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print("FAILURES:")
        for f in failures:
            print("  -", f)
        return 1
    manifest_path = BENCH_ROOT / "suite" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": "1.0",
        "total_tasks": len(manifest_tasks),
        "axes_covered": sorted({int(t["axis"]) for t in manifest_tasks}),
        "tasks": manifest_tasks,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")

    print(f"\nValidated {len(manifest_tasks)}/{len(tasks)} tasks. Manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
