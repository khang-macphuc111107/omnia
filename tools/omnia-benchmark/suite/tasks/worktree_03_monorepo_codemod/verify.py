#!/usr/bin/env python3
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
