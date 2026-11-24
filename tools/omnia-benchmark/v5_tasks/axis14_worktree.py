"""Suite v5 Axis 14 (Multi-Agent Worktree Refactoring) task builders.

Creates 3 deterministic tasks under D:\\Omnia\\tools\\omnia-benchmark\\suite\\tasks\\:
  1. worktree_01_parallel_services — 3 decoupled service crates/pkgs sharing broken contract v2
  2. worktree_02_conflict_merge_fix — Real Git repo w/ 2 conflicting feature branches + semantic bug
  3. worktree_03_monorepo_codemod   — Python + Node.js ESM + Rust monorepo X-Sig-V1->V2 migration
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path


def _w(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _task_meta(tid: str, title: str, langs: list[str], setup_script: str | None = None) -> str:
    return json.dumps({
        "id": tid,
        "axis": 14,
        "axis_name": "Multi-Agent Worktree Refactoring",
        "title": title,
        "difficulty": "hard",
        "languages": langs,
        "timeout_s": 300,
        "max_turns": 25,
        "grading_type": "worktree_refactor",
        "prompt_file": "prompt.md",
        "workspace_dir": "workspace",
        "setup_script": setup_script,
        "verify_script": "verify.py",
    }, indent=2) + "\n"


def build_worktree_01(tasks_dir: Path) -> dict:
    tid = "worktree_01_parallel_services"
    tdir = tasks_dir / tid
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", _task_meta(
        tid,
        "Refactor 3 decoupled services (billing, auth, notify) onto Envelope v2 contract",
        ["python", "git"],
        setup_script="setup.py",
    ))
    _w(tdir / "prompt.md", """# Task: Migrate 3 Independent Packages onto Envelope v2 Contract

`contracts/envelope.py` was upgraded to require `trace_id`, `tenant_id`, and `issued_at_ms` (and HMAC signature validation).
Three disjoint packages (`packages/billing/service.py`, `packages/auth/service.py`, `packages/notify/service.py`) are currently broken:
1. `packages/billing/service.py`: uses float USD (`amount * 1.07`) causing rounding errors and calls old `Envelope(...)` positional signature; fix to integer cents half-up (`(amount_cents * 107 + 50) // 100`) and pass `trace_id`, `tenant_id`, `issued_at_ms`.
2. `packages/auth/service.py`: ignores expired tokens (`now_ms - issued_at_ms > ttl_ms`) and leaks raw bearer strings inside ValueError messages; enforce expiry and mask secrets (`"[REDACTED]"`).
3. `packages/notify/service.py`: drops `trace_id` when constructing outbound notifications and retries failed deliveries indefinitely without deduplicating by `(tenant_id, trace_id)`.

Run `python -m unittest discover -s tests` to inspect failing tests and fix all 3 packages cleanly without editing `tests/` or `contracts/`.
""")

    _w(ws / "contracts" / "__init__.py", "from .envelope import Envelope\n")
    _w(ws / "contracts" / "envelope.py", """from dataclasses import dataclass

@dataclass(frozen=True)
class Envelope:
    trace_id: str
    tenant_id: str
    issued_at_ms: int
    payload: dict
""")
    _w(ws / "packages" / "__init__.py", "")
    _w(ws / "packages" / "billing" / "__init__.py", "")
    _w(ws / "packages" / "billing" / "service.py", """from contracts import Envelope

def create_invoice(trace_id: str, tenant_id: str, issued_at_ms: int, subtotal_cents: int) -> Envelope:
    # BUG: wrong positional args & float tax
    total = round(subtotal_cents * 1.07, 2)
    return Envelope(trace_id, total)
""")
    _w(ws / "packages" / "auth" / "__init__.py", "")
    _w(ws / "packages" / "auth" / "service.py", """def verify_session(token: str, issued_at_ms: int, now_ms: int, ttl_ms: int = 60000) -> dict:
    # BUG: leaks raw token in exception and ignores expiry
    if not token.startswith("tok_"):
        raise ValueError(f"invalid token: {token}")
    return {"ok": True, "age_ms": now_ms - issued_at_ms}
""")
    _w(ws / "packages" / "notify" / "__init__.py", "")
    _w(ws / "packages" / "notify" / "service.py", """from contracts import Envelope

class Notifier:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    def send(self, env: Envelope) -> bool:
        # BUG: drops trace_id and fails to deduplicate (tenant_id, trace_id)
        self.sent.append({"tenant_id": env.tenant_id, "payload": env.payload})
        return True
""")
    _w(ws / "tests" / "test_e2e.py", """import unittest
from packages.billing.service import create_invoice
from packages.auth.service import verify_session
from packages.notify.service import Notifier

class ServiceTests(unittest.TestCase):
    def test_billing_and_notify(self):
        env = create_invoice("tr-1", "acme", 1000, 1005)
        self.assertEqual(env.payload["total_cents"], 1075)
        n = Notifier()
        self.assertTrue(n.send(env))
        self.assertFalse(n.send(env))
        self.assertEqual(n.sent[0]["trace_id"], "tr-1")

    def test_auth_expiry_and_redaction(self):
        with self.assertRaises(ValueError) as ctx:
            verify_session("bad_secret_val_99", 0, 10)
        self.assertNotIn("bad_secret_val_99", str(ctx.exception))
        with self.assertRaises(ValueError):
            verify_session("tok_ok_1", 1000, 70001, ttl_ms=60000)
""")

    _w(tdir / "setup.py", r'''import argparse, subprocess
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    for cmd in [
        ["git", "init", "-b", "main"],
        ["git", "config", "user.name", "Bench Setup"],
        ["git", "config", "user.email", "bench@example.test"],
        ["git", "add", "-A"],
        ["git", "commit", "-m", "initial broken services"],
    ]:
        subprocess.run(cmd, cwd=str(ws), check=True, capture_output=True)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
''')

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for worktree_01_parallel_services."""
from __future__ import annotations
import argparse, json, subprocess, sys
from pathlib import Path

TASK_ID = "worktree_01_parallel_services"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    pub = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    checks.append({"name": "public_tests", "passed": pub.returncode == 0, "detail": "ok" if pub.returncode == 0 else pub.stderr[-300:]})

    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m in ("contracts", "packages") or m.startswith(("contracts.", "packages.")):
            del sys.modules[m]
    try:
        from packages.billing.service import create_invoice
        from packages.auth.service import verify_session
        from packages.notify.service import Notifier
        e = create_invoice("tr-x", "beta", 5000, 150)  # 150 * 107 = 16050 -> +50 = 16100 // 100 = 161
        checks.append({"name": "hidden_billing_rounding", "passed": isinstance(e.payload["total_cents"], int) and e.payload["total_cents"] == 161 and e.tenant_id == "beta" and e.issued_at_ms == 5000, "detail": repr(e)})
        ok_auth = verify_session("tok_12345", 1000, 61000, ttl_ms=60000)["ok"] is True
        exp_blk = False
        try:
            verify_session("tok_12345", 1000, 61001, ttl_ms=60000)
        except ValueError as exc:
            exp_blk = "tok_12345" not in str(exc)
        checks.append({"name": "hidden_auth_boundary", "passed": ok_auth and exp_blk, "detail": repr((ok_auth, exp_blk))})
        n = Notifier()
        checks.append({"name": "hidden_notify_dedup", "passed": n.send(e) is True and n.send(e) is False and len(n.sent) == 1 and n.sent[0]["trace_id"] == "tr-x", "detail": repr(n.sent)})
    except Exception as exc:
        checks.append({"name": "eval_exception", "passed": False, "detail": str(exc)})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "packages" / "billing" / "service.py", """from contracts import Envelope

def create_invoice(trace_id: str, tenant_id: str, issued_at_ms: int, subtotal_cents: int) -> Envelope:
    total = (int(subtotal_cents) * 107 + 50) // 100
    return Envelope(trace_id=trace_id, tenant_id=tenant_id, issued_at_ms=issued_at_ms, payload={"subtotal_cents": int(subtotal_cents), "total_cents": total})
""")
        _w(ws_dir / "packages" / "auth" / "service.py", """def verify_session(token: str, issued_at_ms: int, now_ms: int, ttl_ms: int = 60000) -> dict:
    if not token.startswith("tok_"):
        raise ValueError("invalid token: [REDACTED]")
    age = now_ms - issued_at_ms
    if age < 0 or age > ttl_ms:
        raise ValueError("session expired: [REDACTED]")
    return {"ok": True, "age_ms": age}
""")
        _w(ws_dir / "packages" / "notify" / "service.py", """from contracts import Envelope

class Notifier:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self._seen: set[tuple[str, str]] = set()

    def send(self, env: Envelope) -> bool:
        key = (env.tenant_id, env.trace_id)
        if key in self._seen:
            return False
        self._seen.add(key)
        self.sent.append({"trace_id": env.trace_id, "tenant_id": env.tenant_id, "payload": env.payload})
        return True
""")

    return {"id": tid, "apply_ref": apply_ref}


def build_worktree_02(tasks_dir: Path) -> dict:
    tid = "worktree_02_conflict_merge_fix"
    tdir = tasks_dir / tid
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", _task_meta(
        tid,
        "Merge conflicting Git feature branches (rate-limiter + audit-hmac) & fix combined semantics",
        ["python", "git"],
        setup_script="setup.py",
    ))
    _w(tdir / "prompt.md", """# Task: Merge Two Conflicting Feature Branches Onto `main` and Fix Interaction Bug

This Git repository has two unmerged feature branches alongside `main`:
- `feat/rate-limiter`: adds sliding-window rate limiting (`gateway/limiter.py` + `gateway/config.py`)
- `feat/audit-hmac`: adds HMAC-SHA256 audit logging (`gateway/audit.py` + `gateway/config.py`)

Your job:
1. Merge BOTH `feat/rate-limiter` AND `feat/audit-hmac` onto `main` (so `main` contains both branches' Git ancestry, with zero leftover conflict markers).
2. Wire `gateway/server.py` (`Gateway.handle(req)`) so:
   - Both `ALLOWED` AND rate-limit `DENIED` requests emit signed audit records via `AuditLogger`.
   - Rate-limited `DENIED` requests do NOT consume/advance the sliding-window allowed quota!
   - Preserve merged `GatewayConfig` fields from both branches (`rate_limit`, `window_ms`, `audit_hmac_key`).
3. Commit your resolved integration on `main` and verify all tests pass cleanly.
""")

    _w(ws / "gateway" / "__init__.py", "")
    _w(ws / "gateway" / "config.py", "class GatewayConfig:\n    def __init__(self, service_name: str = 'gw') -> None:\n        self.service_name = service_name\n")
    _w(ws / "gateway" / "server.py", "from .config import GatewayConfig\n\nclass Gateway:\n    def __init__(self, cfg: GatewayConfig) -> None:\n        self.cfg = cfg\n\n    def handle(self, req: dict) -> dict:\n        return {'decision': 'ALLOWED', 'audit': None}\n")
    _w(ws / "tests" / "test_gateway.py", "import unittest\nfrom gateway.config import GatewayConfig\nfrom gateway.server import Gateway\n\nclass BaseTests(unittest.TestCase):\n    def test_init(self):\n        gw = Gateway(GatewayConfig())\n        self.assertEqual(gw.cfg.service_name, 'gw')\n")

    _w(tdir / "setup.py", r'''import argparse, subprocess
from pathlib import Path

def _w(p: Path, s: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding="utf-8", newline="\n")

def _git(ws: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(ws), check=True, capture_output=True)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    _git(ws, "init", "-b", "main")
    _git(ws, "config", "user.name", "Bench Setup")
    _git(ws, "config", "user.email", "bench@example.test")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-m", "base gateway")

    # Branch 1: feat/rate-limiter
    _git(ws, "checkout", "-b", "feat/rate-limiter")
    _w(ws / "gateway" / "config.py", "class GatewayConfig:\n    def __init__(self, service_name: str = 'gw', rate_limit: int = 2, window_ms: int = 1000) -> None:\n        self.service_name = service_name\n        self.rate_limit = rate_limit\n        self.window_ms = window_ms\n")
    _w(ws / "gateway" / "limiter.py", """class SlidingLimiter:
    def __init__(self, limit: int, window_ms: int) -> None:
        self.limit = limit
        self.window_ms = window_ms
        self._hits: dict[str, list[int]] = {}

    def allow(self, key: str, ts_ms: int) -> bool:
        arr = [t for t in self._hits.get(key, []) if ts_ms - t < self.window_ms]
        # BUG if someone records denied hits into arr, so only append when allowed!
        if len(arr) >= self.limit:
            self._hits[key] = arr
            return False
        arr.append(ts_ms)
        self._hits[key] = arr
        return True
""")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-m", "feat: sliding window rate limiter")

    # Branch 2: feat/audit-hmac (off main -> conflicts on gateway/config.py)
    _git(ws, "checkout", "main")
    _git(ws, "checkout", "-b", "feat/audit-hmac")
    _w(ws / "gateway" / "config.py", "class GatewayConfig:\n    def __init__(self, service_name: str = 'gw', audit_hmac_key: str = 'dummy_gw_key') -> None:\n        self.service_name = service_name\n        self.audit_hmac_key = audit_hmac_key\n")
    _w(ws / "gateway" / "audit.py", """import hashlib, hmac, json

class AuditLogger:
    def __init__(self, hmac_key: str) -> None:
        self.hmac_key = hmac_key.encode("utf-8")
        self.entries: list[dict] = []

    def record(self, req_id: str, decision: str) -> dict:
        msg = json.dumps({"req_id": req_id, "decision": decision}, separators=(",", ":"), sort_keys=True)
        sig = hmac.new(self.hmac_key, msg.encode("utf-8"), hashlib.sha256).hexdigest()
        entry = {"req_id": req_id, "decision": decision, "sig": sig}
        self.entries.append(entry)
        return entry
""")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-m", "feat: audit hmac logger")

    _git(ws, "checkout", "main")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
''')

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for worktree_02_conflict_merge_fix."""
from __future__ import annotations
import argparse, hashlib, hmac, json, subprocess, sys
from pathlib import Path

TASK_ID = "worktree_02_conflict_merge_fix"

def _is_anc(ws: Path, branch: str) -> bool:
    r = subprocess.run(["git", "merge-base", "--is-ancestor", branch, "HEAD"], cwd=str(ws), capture_output=True)
    return r.returncode == 0

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    head_branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=str(ws), capture_output=True, text=True).stdout.strip()
    checks.append({"name": "git_ancestry_both_branches", "passed": head_branch == "main" and _is_anc(ws, "feat/rate-limiter") and _is_anc(ws, "feat/audit-hmac"), "detail": f"head={head_branch}"})
    st = subprocess.run(["git", "status", "--porcelain"], cwd=str(ws), capture_output=True, text=True).stdout.strip()
    checks.append({"name": "git_clean", "passed": st == "", "detail": repr(st[:200])})

    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m == "gateway" or m.startswith("gateway."):
            del sys.modules[m]
    try:
        from gateway.config import GatewayConfig
        from gateway.server import Gateway
        cfg = GatewayConfig(service_name="prod", rate_limit=2, window_ms=1000, audit_hmac_key="dummy_secret_k")
        gw = Gateway(cfg)
        r1 = gw.handle({"req_id": "1", "client": "c1", "ts_ms": 100})
        r2 = gw.handle({"req_id": "2", "client": "c1", "ts_ms": 200})
        r3 = gw.handle({"req_id": "3", "client": "c1", "ts_ms": 300})
        # After 1000ms window slides past 100 (at 1105), c1 MUST be ALLOWED again (r3 did not pollute window!)
        r4 = gw.handle({"req_id": "4", "client": "c1", "ts_ms": 1105})
        exp3 = hmac.new(b"dummy_secret_k", b'{"decision":"DENIED","req_id":"3"}', hashlib.sha256).hexdigest()
        checks.append({"name": "limiter_audit_interaction", "passed": (
            r1["decision"] == "ALLOWED" and r2["decision"] == "ALLOWED" and r3["decision"] == "DENIED" and r4["decision"] == "ALLOWED"
            and r3["audit"]["sig"] == exp3 and len(gw.audit.entries) == 4
        ), "detail": repr((r1["decision"], r2["decision"], r3, r4["decision"]))})
    except Exception as exc:
        checks.append({"name": "eval_exception", "passed": False, "detail": str(exc)})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        import subprocess
        subprocess.run(["git", "merge", "--no-ff", "--no-edit", "feat/rate-limiter"], cwd=str(ws_dir), check=True, capture_output=True)
        subprocess.run(["git", "merge", "--no-ff", "--no-edit", "feat/audit-hmac"], cwd=str(ws_dir), capture_output=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        _w(ws_dir / "gateway" / "config.py", """class GatewayConfig:
    def __init__(self, service_name: str = 'gw', rate_limit: int = 2, window_ms: int = 1000, audit_hmac_key: str = 'dummy_gw_key') -> None:
        self.service_name = service_name
        self.rate_limit = rate_limit
        self.window_ms = window_ms
        self.audit_hmac_key = audit_hmac_key
""")
        _w(ws_dir / "gateway" / "server.py", """from .audit import AuditLogger
from .config import GatewayConfig
from .limiter import SlidingLimiter

class Gateway:
    def __init__(self, cfg: GatewayConfig) -> None:
        self.cfg = cfg
        self.limiter = SlidingLimiter(cfg.rate_limit, cfg.window_ms)
        self.audit = AuditLogger(cfg.audit_hmac_key)

    def handle(self, req: dict) -> dict:
        allowed = self.limiter.allow(str(req["client"]), int(req["ts_ms"]))
        decision = "ALLOWED" if allowed else "DENIED"
        entry = self.audit.record(str(req["req_id"]), decision)
        return {"decision": decision, "audit": entry}
""")
        subprocess.run(["git", "add", "-A"], cwd=str(ws_dir), check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "merge both feature branches and wire gateway"], cwd=str(ws_dir), check=True, capture_output=True)

    return {"id": tid, "apply_ref": apply_ref}


def build_worktree_03(tasks_dir: Path) -> dict:
    tid = "worktree_03_monorepo_codemod"
    tdir = tasks_dir / tid
    if tdir.exists():
        shutil.rmtree(tdir)
    ws = tdir / "workspace"

    _w(tdir / "task.json", _task_meta(
        tid,
        "Python + Node.js ESM + Rust monorepo X-Sig-V1->X-Sig-V2 canonical signing migration",
        ["python", "javascript", "rust"],
    ))
    _w(tdir / "prompt.md", """# Task: Cross-Language `X-Sig-V1` -> `X-Sig-V2` Canonical Signing Migration

This polyglot monorepo has 3 independent packages:
- `py_client/signer.py` (Python 3.13)
- `js_worker/verifier.mjs` (Node.js ESM)
- `rs_core/src/lib.rs` (zero-dependency Rust library)

Migrate ALL 3 packages from legacy `X-Sig-V1` (`sha256(key + body)`) to canonical **`X-Sig-V2`** (`HMAC-SHA256(key, f"{method.upper()}\\n{path}\\n{ts_sec}\\n{nonce}\\n{body_sha256}")`) — implemented cleanly in Python, Node.js, and pure Rust (`rs_core` pure-Rust SHA-256 + HMAC-SHA256 helper already provided in `rs_core/src/sha256.rs`!) — with:
- Replay protection (`abs(now_sec - ts_sec) <= 300`, non-empty `nonce` not previously seen in `used_nonces`)
- Backwards-compatible `allow_legacy: bool` flag supporting `X-Sig-V1` ONLY when explicitly `True`

Make `python -m unittest discover -s tests`, `node --test js_worker/test.mjs`, and `cargo test --manifest-path rs_core/Cargo.toml` ALL pass cleanly.
""")

    _w(ws / "py_client" / "__init__.py", "")
    _w(ws / "py_client" / "signer.py", """import hashlib

def sign_v1(key: str, body: bytes) -> str:
    return hashlib.sha256(key.encode("utf-8") + body).hexdigest()

def sign_v2(key: str, method: str, path: str, ts_sec: int, nonce: str, body: bytes) -> str:
    return "unimplemented"
""")
    _w(ws / "js_worker" / "verifier.mjs", """import crypto from "node:crypto";

export function verifyRequest({ key, method, path, tsSec, nonce, body, sigV2, sigV1, nowSec, usedNonces, allowLegacy = false }) {
  return false;
}
""")
    _w(ws / "js_worker" / "test.mjs", """import test from "node:test";
import assert from "node:assert/strict";
import { verifyRequest } from "./verifier.mjs";

test("rejects unimplemented", () => {
  assert.equal(verifyRequest({ key: "k", method: "GET", path: "/", tsSec: 10, nonce: "n", body: "", sigV2: "x", nowSec: 10, usedNonces: new Set() }), false);
});
""")
    _w(ws / "rs_core" / "Cargo.toml", '[package]\nname = "rs_core"\nversion = "0.1.0"\nedition = "2021"\n')
    _w(ws / "rs_core" / "src" / "sha256.rs", """const K: [u32; 64] = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    msg.push(0x80);
    while (msg.len() % 64) != 56 { msg.push(0); }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 { w[i] = u32::from_be_bytes([chunk[4*i],chunk[4*i+1],chunk[4*i+2],chunk[4*i+3]]); }
        for i in 16..64 {
            let s0 = w[i-15].rotate_right(7) ^ w[i-15].rotate_right(18) ^ (w[i-15] >> 3);
            let s1 = w[i-2].rotate_right(17) ^ w[i-2].rotate_right(19) ^ (w[i-2] >> 10);
            w[i] = w[i-16].wrapping_add(s0).wrapping_add(w[i-7]).wrapping_add(s1);
        }
        let [mut a,mut b,mut c,mut d,mut e,mut f,mut g,mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g; g = f; f = e; e = d.wrapping_add(t1); d = c; c = b; b = a; a = t1.wrapping_add(t2);
        }
        for (slot, val) in h.iter_mut().zip([a,b,c,d,e,f,g,hh]) { *slot = slot.wrapping_add(val); }
    }
    let mut out = [0u8; 32];
    for (i, v) in h.iter().enumerate() { out[4*i..4*i+4].copy_from_slice(&v.to_be_bytes()); }
    out
}

pub fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    let mut k = [0u8; 64];
    if key.len() > 64 { let hk = sha256(key); k[..32].copy_from_slice(&hk); } else { k[..key.len()].copy_from_slice(key); }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 { ipad[i] ^= k[i]; opad[i] ^= k[i]; }
    let mut inner = Vec::with_capacity(64 + data.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(data);
    let ih = sha256(&inner);
    let mut outer = Vec::with_capacity(96);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&ih);
    sha256(&outer).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
""")
    _w(ws / "rs_core" / "src" / "lib.rs", """pub mod sha256;

pub fn sign_v2(key: &str, method: &str, path: &str, ts_sec: i64, nonce: &str, body: &[u8]) -> String {
    let _ = (key, method, path, ts_sec, nonce, body);
    String::from("unimplemented")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_sha_helper() {
        assert_eq!(sha256::hex_encode(&sha256::sha256(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
""")
    _w(ws / "tests" / "test_py_signer.py", """import unittest
from py_client.signer import sign_v1

class PublicPyTests(unittest.TestCase):
    def test_v1_present(self):
        self.assertEqual(len(sign_v1("k", b"abc")), 64)
""")

    _w(tdir / "verify.py", r'''#!/usr/bin/env python3
"""Hidden verifier for worktree_03_monorepo_codemod."""
from __future__ import annotations
import argparse, hashlib, hmac, json, subprocess, sys
from pathlib import Path

TASK_ID = "worktree_03_monorepo_codemod"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    checks = []

    py_t = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    checks.append({"name": "py_tests", "passed": py_t.returncode == 0, "detail": "ok" if py_t.returncode == 0 else py_t.stderr[-300:]})
    js_t = subprocess.run(["node", "--test", "js_worker/test.mjs"], cwd=str(ws), capture_output=True, text=True, timeout=30)
    checks.append({"name": "js_tests", "passed": js_t.returncode == 0, "detail": "ok" if js_t.returncode == 0 else js_t.stderr[-300:]})
    rs_t = subprocess.run(["cargo", "test", "--manifest-path", "rs_core/Cargo.toml"], cwd=str(ws), capture_output=True, text=True, timeout=90)
    checks.append({"name": "rust_tests", "passed": rs_t.returncode == 0, "detail": "ok" if rs_t.returncode == 0 else rs_t.stderr[-300:]})

    sys.path.insert(0, str(ws))
    for m in list(sys.modules):
        if m == "py_client" or m.startswith("py_client."):
            del sys.modules[m]
    try:
        from py_client.signer import sign_v2
        sig = sign_v2("dummy_key_1", "post", "/v2/pay", 1700000000, "nonce-42", b'{"a":1}')
        bhash = hashlib.sha256(b'{"a":1}').hexdigest()
        exp = hmac.new(b"dummy_key_1", f"POST\n/v2/pay\n1700000000\nnonce-42\n{bhash}".encode(), hashlib.sha256).hexdigest()
        checks.append({"name": "py_sign_v2_exact", "passed": sig == exp, "detail": repr((sig, exp))})

        # Cross-language check: Python sign_v2 -> Node.js verifyRequest + replay/window/legacy checks!
        js_probe = (
            f"import {{ verifyRequest }} from './js_worker/verifier.mjs';"
            f"const used = new Set();"
            f"const ok1 = verifyRequest({{ key:'dummy_key_1', method:'POST', path:'/v2/pay', tsSec:1700000000, nonce:'nonce-42', body:'{{\"a\":1}}', sigV2:'{sig}', nowSec:1700000100, usedNonces:used }});"
            f"const replay = verifyRequest({{ key:'dummy_key_1', method:'POST', path:'/v2/pay', tsSec:1700000000, nonce:'nonce-42', body:'{{\"a\":1}}', sigV2:'{sig}', nowSec:1700000100, usedNonces:used }});"
            f"const expired = verifyRequest({{ key:'dummy_key_1', method:'POST', path:'/v2/pay', tsSec:1700000000, nonce:'nonce-43', body:'{{\"a\":1}}', sigV2:'{sig}', nowSec:1700000500, usedNonces:used }});"
            f"const v1sha = '{hashlib.sha256(b'dummy_key_1{\"a\":1}').hexdigest()}';"
            f"const legOff = verifyRequest({{ key:'dummy_key_1', method:'POST', path:'/v2/pay', tsSec:1700000000, nonce:'nonce-44', body:'{{\"a\":1}}', sigV1:v1sha, nowSec:1700000100, usedNonces:used, allowLegacy:false }});"
            f"const legOn = verifyRequest({{ key:'dummy_key_1', method:'POST', path:'/v2/pay', tsSec:1700000000, nonce:'nonce-45', body:'{{\"a\":1}}', sigV1:v1sha, nowSec:1700000100, usedNonces:used, allowLegacy:true }});"
            f"console.log(JSON.stringify({{ ok1, replay, expired, legOff, legOn }}));"
        )
        jp = subprocess.run(["node", "--input-type=module", "-e", js_probe], cwd=str(ws), capture_output=True, text=True, timeout=30)
        jr = json.loads(jp.stdout.strip().splitlines()[-1]) if jp.returncode == 0 else {}
        checks.append({"name": "cross_lang_js_verify", "passed": jr == {"ok1": True, "replay": False, "expired": False, "legOff": False, "legOn": True}, "detail": repr((jr, jp.stderr[-200:]))})

        # Cross-language check: Rust rs_core sign_v2 binary check via cargo test or tiny test
        rs_probe = (
            f'\n#[test]\nfn hidden_cross_lang_sig() {{\n'
            f'    assert_eq!(sign_v2("dummy_key_1", "post", "/v2/pay", 1700000000, "nonce-42", br#"{{"a":1}}"#), "{exp}");\n'
            f'}}\n'
        )
        lib_p = ws / "rs_core" / "src" / "lib.rs"
        orig_lib = lib_p.read_text(encoding="utf-8")
        try:
            lib_p.write_text(orig_lib + rs_probe, encoding="utf-8", newline="\n")
            rt = subprocess.run(["cargo", "test", "--manifest-path", "rs_core/Cargo.toml", "hidden_cross_lang_sig"], cwd=str(ws), capture_output=True, text=True, timeout=90)
            checks.append({"name": "cross_lang_rust_sign_v2", "passed": rt.returncode == 0, "detail": "ok" if rt.returncode == 0 else rt.stderr[-250:]})
        finally:
            lib_p.write_text(orig_lib, encoding="utf-8", newline="\n")
    except Exception as exc:
        checks.append({"name": "eval_exception", "passed": False, "detail": str(exc)})

    ok_n = sum(1 for c in checks if c["passed"])
    passed = ok_n == len(checks)
    print(json.dumps({"task_id": TASK_ID, "passed": passed, "score": round(ok_n / len(checks), 4), "fail_to_pass": {"passed": ok_n, "total": len(checks)}, "pass_to_pass": {"passed": 0, "total": 0}, "checks": checks}))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
''')

    def apply_ref(ws_dir: Path) -> None:
        _w(ws_dir / "py_client" / "signer.py", """import hashlib, hmac

def sign_v1(key: str, body: bytes) -> str:
    return hashlib.sha256(key.encode("utf-8") + body).hexdigest()

def sign_v2(key: str, method: str, path: str, ts_sec: int, nonce: str, body: bytes) -> str:
    bhash = hashlib.sha256(body).hexdigest()
    msg = f"{method.upper()}\\n{path}\\n{int(ts_sec)}\\n{nonce}\\n{bhash}".encode("utf-8")
    return hmac.new(key.encode("utf-8"), msg, hashlib.sha256).hexdigest()
""")
        _w(ws_dir / "js_worker" / "verifier.mjs", """import crypto from "node:crypto";

export function verifyRequest({ key, method, path, tsSec, nonce, body, sigV2, sigV1, nowSec, usedNonces, allowLegacy = false }) {
  if (!nonce || (usedNonces && usedNonces.has(nonce))) return false;
  if (Math.abs(Number(nowSec) - Number(tsSec)) > 300) return false;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  if (sigV2) {
    const bhash = crypto.createHash("sha256").update(buf).digest("hex");
    const msg = `${String(method).toUpperCase()}\\n${path}\\n${Number(tsSec)}\\n${nonce}\\n${bhash}`;
    const exp = crypto.createHmac("sha256", key).update(msg).digest("hex");
    const a = Buffer.from(String(sigV2), "utf8");
    const b = Buffer.from(exp, "utf8");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      if (usedNonces) usedNonces.add(nonce);
      return true;
    }
    return false;
  }
  if (allowLegacy && sigV1) {
    const exp1 = crypto.createHash("sha256").update(Buffer.from(key, "utf8")).update(buf).digest("hex");
    const a = Buffer.from(String(sigV1), "utf8");
    const b = Buffer.from(exp1, "utf8");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      if (usedNonces) usedNonces.add(nonce);
      return true;
    }
  }
  return false;
}
""")
        _w(ws_dir / "rs_core" / "src" / "lib.rs", """pub mod sha256;

pub fn sign_v2(key: &str, method: &str, path: &str, ts_sec: i64, nonce: &str, body: &[u8]) -> String {
    let bhash = sha256::hex_encode(&sha256::sha256(body));
    let msg = format!("{}\\n{}\\n{}\\n{}\\n{}", method.to_ascii_uppercase(), path, ts_sec, nonce, bhash);
    sha256::hmac_sha256_hex(key.as_bytes(), msg.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_sha_helper() {
        assert_eq!(sha256::hex_encode(&sha256::sha256(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
    #[test]
    fn test_sign_v2_nonempty() {
        assert_eq!(sign_v2("k", "post", "/a", 10, "n1", b"hi").len(), 64);
    }
}
""")

    return {"id": tid, "apply_ref": apply_ref}
