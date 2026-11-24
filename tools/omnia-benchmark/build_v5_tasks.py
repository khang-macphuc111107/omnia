"""Generator & reference-solution verifier for the 9 new v5 benchmark tasks (Total: 33 tasks).

Creates under D:\\Omnia\\tools\\omnia-benchmark\\suite\\tasks\\:
  - Axis 12 (Long-Horizon Memory & Context Compaction): mem_01, mem_02, mem_03
  - Axis 13 (MCP & PTC Code Mode Multi-Tool Composition): ptc_01, ptc_02, ptc_03
  - Axis 14 (Multi-Agent Worktree Refactoring): worktree_01, worktree_02, worktree_03

Run with `--test-reference` to prove EVERY new task FAILS on unmodified baseline AND
PASSES 100% when its reference solution is applied.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from v5_tasks.axis12_memory import build_mem_01, build_mem_02, build_mem_03
from v5_tasks.axis13_mcp_ptc import build_ptc_01, build_ptc_02, build_ptc_03
from v5_tasks.axis14_worktree import build_worktree_01, build_worktree_02, build_worktree_03

TASKS_DIR = Path(__file__).resolve().parent / "suite" / "tasks"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-reference", action="store_true")
    args = ap.parse_args()

    builders = [
        build_mem_01,
        build_mem_02,
        build_mem_03,
        build_ptc_01,
        build_ptc_02,
        build_ptc_03,
        build_worktree_01,
        build_worktree_02,
        build_worktree_03,
    ]
    built = [b(TASKS_DIR) for b in builders]
    print(f"Built {len(built)} new v5 tasks: {[x['id'] for x in built]}", flush=True)

    if args.test_reference:
        print("\n=== Testing v5 reference solutions (must FAIL baseline & PASS 100% with ref) ===", flush=True)
        failures = []
        for item in built:
            tid = item["id"]
            tdir = TASKS_DIR / tid
            meta = json.loads((tdir / "task.json").read_text(encoding="utf-8"))
            tmp = Path(tempfile.mkdtemp(prefix=f"v5_ref_{tid}_"))
            try:
                shutil.copytree(tdir / "workspace", tmp, dirs_exist_ok=True)
                if meta.get("setup_script"):
                    subprocess.run(
                        [sys.executable, "-B", str(tdir / meta["setup_script"]), "--workspace", str(tmp)],
                        check=True, capture_output=True, text=True, timeout=60,
                    )
                base_r = subprocess.run(
                    [sys.executable, "-B", str(tdir / "verify.py"), "--workspace", str(tmp)],
                    capture_output=True, text=True, timeout=120,
                )
                base_p = json.loads(base_r.stdout.strip().splitlines()[-1]) if base_r.stdout.strip() else {}
                if base_r.returncode == 0 or base_p.get("passed") is True:
                    failures.append(f"{tid}: baseline unexpectedly passed!")
                    continue

                item["apply_ref"](tmp)
                r = subprocess.run(
                    [sys.executable, "-B", str(tdir / "verify.py"), "--workspace", str(tmp)],
                    capture_output=True, text=True, timeout=120,
                )
                parsed = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
                ok = r.returncode == 0 and bool(parsed.get("passed"))
                print(
                    f"  [{'PASS' if ok else 'FAIL'}] {tid:30s} base={base_p.get('score')} -> ref={parsed.get('score')} f2p={parsed.get('fail_to_pass')}",
                    flush=True,
                )
                if not ok:
                    failures.append(f"{tid}: rc={r.returncode} out={r.stdout[-300:]} err={r.stderr[-300:]}")
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        if failures:
            print("REF FAILURES:", failures)
            return 1
        print("ALL 9 V5 REFERENCE SOLUTIONS PASSED 100%!", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
