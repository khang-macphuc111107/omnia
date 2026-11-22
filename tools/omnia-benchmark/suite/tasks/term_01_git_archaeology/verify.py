#!/usr/bin/env python3
"""State verification grader for term_01_git_archaeology."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


TASK_ID = "term_01_git_archaeology"
EXPECTED_CULPRIT = "01f16febf682fe352242ef860cbaf86848acffbe"
EXPECTED_ORIG_MAIN = "0d38bf042f79250d0894a00e9e500365a7d4f718"
EXPECTED_CACHE_V2 = "e3250321ff107c704c2f820edb9a4eecf8ac2374"
EXPECTED_HOTFIX_AUTH = "56974fd7ecabab91dfce4bf136b523ce22116d65"


def find_git() -> str:
    git_bin = shutil.which("git")
    if git_bin:
        return git_bin
    fallback = Path(r"C:\Program Files\Git\cmd\git.exe")
    if fallback.is_file():
        return str(fallback)
    raise RuntimeError("git executable not found")


def run_cmd(cmd: list[str], cwd: Path, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def run_py_snippet(workspace: Path, code: str) -> tuple[bool, str]:
    proc = run_cmd([sys.executable, "-c", code], cwd=workspace, timeout=30)
    if proc.returncode == 0:
        return True, (proc.stdout.strip() or "ok")
    detail = (proc.stderr.strip() or proc.stdout.strip() or f"exit code {proc.returncode}")
    return False, detail[-500:]


def resolve_expected_commit(git_bin: str, workspace: Path, expected_hash: str, grep_msg: str) -> str:
    check = run_cmd([git_bin, "cat-file", "-t", expected_hash], cwd=workspace)
    if check.returncode == 0 and check.stdout.strip() == "commit":
        return expected_hash
    fallback = run_cmd(
        [git_bin, "log", "--all", f"--grep={grep_msg}", "--format=%H", "-n", "1"],
        cwd=workspace,
    )
    if fallback.returncode == 0 and len(fallback.stdout.strip()) == 40:
        return fallback.stdout.strip()
    return expected_hash


def verify(workspace: Path) -> dict:
    checks: list[dict] = []

    def add_check(name: str, passed: bool, group: str, detail: str) -> None:
        checks.append(
            {
                "name": name,
                "passed": bool(passed),
                "group": group,
                "detail": detail,
            }
        )

    try:
        git_bin = find_git()
        if not (workspace / ".git").exists():
            raise RuntimeError(f"Not a git repository: {workspace}")

        culprit_hash = resolve_expected_commit(
            git_bin, workspace, EXPECTED_CULPRIT, "optimize chunk hashing loop"
        )
        orig_main_hash = resolve_expected_commit(
            git_bin, workspace, EXPECTED_ORIG_MAIN, "record gateway request and error telemetry metrics"
        )

        # --- PASS_TO_PASS CHECKS ---
        br = run_cmd([git_bin, "branch", "--show-current"], cwd=workspace)
        cur_branch = br.stdout.strip()
        add_check(
            "branch_is_main",
            br.returncode == 0 and cur_branch == "main",
            "pass_to_pass",
            f"current branch={cur_branch!r}",
        )

        st = run_cmd([git_bin, "status", "--porcelain"], cwd=workspace)
        status_out = st.stdout.strip()
        add_check(
            "working_tree_clean",
            st.returncode == 0 and status_out == "",
            "pass_to_pass",
            "clean" if status_out == "" else f"dirty: {status_out[:300]}",
        )

        hotfix_anc = run_cmd([git_bin, "merge-base", "--is-ancestor", "hotfix/auth", "HEAD"], cwd=workspace)
        hotfix_tip = run_cmd([git_bin, "rev-parse", "hotfix/auth"], cwd=workspace)
        hotfix_ok = (
            hotfix_anc.returncode == 0
            and hotfix_tip.returncode == 0
            and hotfix_tip.stdout.strip() == EXPECTED_HOTFIX_AUTH
        )
        add_check(
            "hotfix_auth_ancestor",
            hotfix_ok,
            "pass_to_pass",
            f"is_ancestor={hotfix_anc.returncode == 0}, tip={hotfix_tip.stdout.strip()}",
        )

        orig_anc = run_cmd([git_bin, "merge-base", "--is-ancestor", orig_main_hash, "HEAD"], cwd=workspace)
        culprit_anc = run_cmd([git_bin, "merge-base", "--is-ancestor", culprit_hash, "HEAD"], cwd=workspace)
        add_check(
            "main_history_preserved",
            orig_anc.returncode == 0 and culprit_anc.returncode == 0,
            "pass_to_pass",
            f"orig_main_ancestor={orig_anc.returncode == 0}, culprit_in_history={culprit_anc.returncode == 0}",
        )

        ok, detail = run_py_snippet(
            workspace,
            """
from service.metrics import MetricsRegistry
m = MetricsRegistry()
assert m.get_counter("x") == 0
assert m.increment("x") == 1
assert m.increment("x", 4) == 5
try:
    m.increment("x", -1)
    raise AssertionError("negative increment should fail")
except ValueError:
    pass
m.observe("lat", 10.5)
snap = m.snapshot()
assert snap["counters"]["x"] == 5
assert snap["observations"]["lat"] == [10.5]
snap["observations"]["lat"].append(99.0)
assert m.snapshot()["observations"]["lat"] == [10.5]
print("metrics ok")
""",
        )
        add_check("metrics_module_preserved", ok, "pass_to_pass", detail)

        ok, detail = run_py_snippet(
            workspace,
            """
import ast
from pathlib import Path
from service.auth import TokenAuthenticator

tree = ast.parse(Path("service/auth.py").read_text(encoding="utf-8"))
uses_compare_digest = any(
    isinstance(node, ast.Attribute) and node.attr == "compare_digest"
    for node in ast.walk(tree)
)
assert uses_compare_digest, "service/auth.py must use hmac.compare_digest"

now = [1_700_000_000.0]
auth = TokenAuthenticator("verify-secret-42", clock=lambda: now[0])
tok = auth.issue_token("u-42", "admin", ttl_seconds=30)
claims = auth.verify_token(tok)
assert claims is not None and claims["user_id"] == "u-42" and claims["role"] == "admin"

# Tampered signature
parts = tok.split(":")
bad_sig = ":".join(parts[:3] + [("a" if parts[3][0] != "a" else "b") + parts[3][1:]])
assert auth.verify_token(bad_sig) is None

# Tampered role
bad_role = ":".join([parts[0], "user", parts[2], parts[3]])
assert auth.verify_token(bad_role) is None

# Exact boundary expiration (now == expires_at)
now[0] = 1_700_000_030.0
assert auth.verify_token(tok) is None

# Malformed tokens
assert auth.verify_token("not:valid") is None
assert auth.verify_token("u:admin:notint:abc") is None
print("auth ok")
""",
        )
        add_check("auth_security_functional", ok, "pass_to_pass", detail)

        # --- FAIL_TO_PASS CHECKS ---
        culprit_file = workspace / "CULPRIT_COMMIT.txt"
        if culprit_file.is_file():
            raw_culprit = culprit_file.read_text(encoding="utf-8").strip()
            tracked = run_cmd([git_bin, "ls-files", "--error-unmatch", "CULPRIT_COMMIT.txt"], cwd=workspace)
            culprit_ok = (raw_culprit == culprit_hash) and (tracked.returncode == 0)
            culprit_detail = (
                f"matched {culprit_hash} (tracked={tracked.returncode == 0})"
                if culprit_ok
                else f"got={raw_culprit!r}, expected={culprit_hash!r}, tracked={tracked.returncode == 0}"
            )
        else:
            culprit_ok = False
            culprit_detail = "CULPRIT_COMMIT.txt missing"
        add_check("culprit_commit_identified", culprit_ok, "fail_to_pass", culprit_detail)

        cache_anc = run_cmd([git_bin, "merge-base", "--is-ancestor", "feature/cache-v2", "HEAD"], cwd=workspace)
        cache_tip = run_cmd([git_bin, "rev-parse", "feature/cache-v2"], cwd=workspace)
        cache_merged_ok = (
            cache_anc.returncode == 0
            and cache_tip.returncode == 0
            and cache_tip.stdout.strip() == EXPECTED_CACHE_V2
        )
        add_check(
            "feature_cache_v2_merged",
            cache_merged_ok,
            "fail_to_pass",
            f"is_ancestor={cache_anc.returncode == 0}, tip={cache_tip.stdout.strip()}",
        )

        ls_art = run_cmd([git_bin, "ls-files", "build/artifact.bin"], cwd=workspace)
        ls_build = run_cmd([git_bin, "ls-files", "build"], cwd=workspace)
        ign_test = run_cmd([git_bin, "check-ignore", "-q", "build/test.bin"], cwd=workspace)
        ign_art = run_cmd([git_bin, "check-ignore", "-q", "build/artifact.bin"], cwd=workspace)
        art_ok = (
            ls_art.returncode == 0
            and ls_art.stdout.strip() == ""
            and ls_build.stdout.strip() == ""
            and ign_test.returncode == 0
            and ign_art.returncode == 0
        )
        add_check(
            "build_artifact_untracked_and_ignored",
            art_ok,
            "fail_to_pass",
            f"tracked_build={ls_build.stdout.strip()!r}, ignore_test={ign_test.returncode == 0}, ignore_art={ign_art.returncode == 0}",
        )

        pub = run_cmd([sys.executable, "test_suite.py"], cwd=workspace, timeout=60)
        pub_out = (pub.stdout + "\n" + pub.stderr).strip()
        add_check(
            "public_test_suite_passes",
            pub.returncode == 0,
            "fail_to_pass",
            "all public tests passed" if pub.returncode == 0 else pub_out[-400:],
        )

        ok, detail = run_py_snippet(
            workspace,
            """
import hashlib
from service.checksum import DEFAULT_SALT, compute_frame_checksum, verify_frame_checksum

def ref_checksum(chunks, salt=DEFAULT_SALT):
    h = hashlib.sha256()
    h.update(salt + b"\\x00")
    for c in chunks:
        b = c.encode("utf-8") if isinstance(c, str) else bytes(c)
        h.update(len(b).to_bytes(4, "big") + b)
    return h.hexdigest()

vectors = [
    (["alpha", b"\\x00\\xff", "日本語🚀"], DEFAULT_SALT),
    (["ab", "c"], DEFAULT_SALT),
    (["a", "bc"], DEFAULT_SALT),
    (["", "a"], DEFAULT_SALT),
    (["a", ""], DEFAULT_SALT),
    ([], DEFAULT_SALT),
    ([""], DEFAULT_SALT),
    (["café", "naïve"], b"CUSTOM-SALT"),
]
for chunks, salt in vectors:
    exp = ref_checksum(chunks, salt=salt)
    got = compute_frame_checksum(chunks, salt=salt)
    assert got == exp, f"mismatch for {chunks!r}: got={got}, exp={exp}"
    assert verify_frame_checksum(chunks, exp.upper(), salt=salt)
    assert not verify_frame_checksum(chunks, ("0" if exp[0] != "0" else "1") + exp[1:], salt=salt)

assert compute_frame_checksum(["ab", "c"]) != compute_frame_checksum(["a", "bc"])
assert compute_frame_checksum([]) != compute_frame_checksum([""])
assert compute_frame_checksum(["café"]) != compute_frame_checksum(["caf"])
assert not verify_frame_checksum(["x"], "not-a-digest")
print("checksum edge cases ok")
""",
        )
        add_check("hidden_checksum_edge_cases", ok, "fail_to_pass", detail)

        ok, detail = run_py_snippet(
            workspace,
            """
from service.cache import ResponseCache

now = [1000.0]
c = ResponseCache(max_size=2, default_ttl=10.0, clock=lambda: now[0])
c.set("a", 1)
c.set("b", 2, ttl=25.0)
assert c.get("a") == 1  # a becomes MRU
c.set("c", 3)           # evicts b (LRU)
assert c.get("b") is None
assert c.get("a") == 1
assert c.get("c") == 3
assert c.stats()["evictions"] == 1

# Update existing key refreshes TTL & recency without eviction
now[0] = 1005.0
c.set("a", 10, ttl=20.0)  # expires at 1025.0
now[0] = 1010.0           # c expired (1000 + 10 = 1010)
assert c.get("c") is None
assert c.get("a") == 10

c.set("d", 4, ttl=5.0)    # expires at 1015.0
now[0] = 1020.0
purged = c.purge_expired()
assert purged == 1
assert len(c) == 1
assert c.get("a") == 10
st = c.stats()
assert st["size"] == 1 and st["hits"] >= 5 and st["misses"] >= 2
print("cache v2 lru/ttl ok")
""",
        )
        add_check("hidden_cache_v2_lru_ttl", ok, "fail_to_pass", detail)

        ok, detail = run_py_snippet(
            workspace,
            """
from service.app import GatewayService
from service.checksum import compute_frame_checksum

auth_now = [1_750_000_000.0]
cache_now = [200.0]
svc = GatewayService(
    "integration-secret-key",
    cache_size=2,
    auth_clock=lambda: auth_now[0],
    cache_ttl=15.0,
    cache_clock=lambda: cache_now[0],
)
tok_admin = svc.auth.issue_token("alice", "admin", ttl_seconds=60)
tok_user = svc.auth.issue_token("alice", "user", ttl_seconds=60)

c1 = ["txn:1", "café"]
d1 = compute_frame_checksum(c1)
c2 = ["txn:2", "日本語"]
d2 = compute_frame_checksum(c2)
c3 = ["txn:3", "payload"]
d3 = compute_frame_checksum(c3)

# 1. Miss on c1 (admin)
r1 = svc.handle_request(tok_admin, c1, d1)
assert r1["ok"] and not r1["cached"] and r1["data"]["role"] == "admin"

# 2. Same user + payload but different role MUST NOT share cache entry
r_role = svc.handle_request(tok_user, c1, d1)
assert r_role["ok"] and not r_role["cached"] and r_role["data"]["role"] == "user"

# 3. Hit on c1 (admin) -> makes (alice,admin,d1) MRU over (alice,user,d1)
r1_hit = svc.handle_request(tok_admin, c1, d1)
assert r1_hit["ok"] and r1_hit["cached"] and r1_hit["data"]["role"] == "admin"

# 4. Insert c2 (admin) -> cache_size=2 evicts (alice,user,d1)
r2 = svc.handle_request(tok_admin, c2, d2)
assert r2["ok"] and not r2["cached"]

# 5. c1 (admin) still cached, while (alice,user,d1) was evicted
assert svc.handle_request(tok_admin, c1, d1)["cached"] is True
assert svc.handle_request(tok_user, c1, d1)["cached"] is False

# 6. TTL expiry on cache_clock
cache_now[0] = 216.0
r3 = svc.handle_request(tok_admin, c1, d1)
assert r3["ok"] and not r3["cached"]

# 7. Bad checksum increments checksum_failures
r_bad_ck = svc.handle_request(tok_admin, c3, d1)
assert not r_bad_ck["ok"] and r_bad_ck["error"] == "checksum_mismatch"

# 8. Expired auth token increments auth_failures
auth_now[0] += 60.0
r_exp = svc.handle_request(tok_admin, c3, d3)
assert not r_exp["ok"] and r_exp["error"] == "unauthorized"

# 9. Verify telemetry counters match all 9 requests
counters = svc.metrics.snapshot()["counters"]
assert counters["requests_total"] == 9, counters
assert counters["cache_hits"] == 2, counters
assert counters["cache_misses"] == 5, counters
assert counters["checksum_failures"] == 1, counters
assert counters["auth_failures"] == 1, counters
print("integrated gateway ok")
""",
        )
        add_check("hidden_integrated_gateway", ok, "fail_to_pass", detail)

        error = None
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"

    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    total = len(checks)
    passed_cnt = sum(1 for c in checks if c["passed"])
    all_passed = error is None and total > 0 and passed_cnt == total
    score = round(passed_cnt / total, 4) if total > 0 and error is None else 0.0

    return {
        "task_id": TASK_ID,
        "passed": all_passed,
        "score": score,
        "fail_to_pass": {
            "passed": sum(1 for c in f2p if c["passed"]),
            "total": len(f2p),
        },
        "pass_to_pass": {
            "passed": sum(1 for c in p2p if c["passed"]),
            "total": len(p2p),
        },
        "checks": checks,
        "error": error,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Verify {TASK_ID}.")
    parser.add_argument("--workspace", required=True, help="Workspace directory to grade")
    args = parser.parse_args()
    result = verify(Path(args.workspace).resolve())
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
