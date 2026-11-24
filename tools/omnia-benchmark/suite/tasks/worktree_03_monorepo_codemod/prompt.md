# Task: Cross-Language `X-Sig-V1` -> `X-Sig-V2` Canonical Signing Migration

This polyglot monorepo has 3 independent packages:
- `py_client/signer.py` (Python 3.13)
- `js_worker/verifier.mjs` (Node.js ESM)
- `rs_core/src/lib.rs` (zero-dependency Rust library)

Migrate ALL 3 packages from legacy `X-Sig-V1` (`sha256(key + body)`) to canonical **`X-Sig-V2`** (`HMAC-SHA256(key, f"{method.upper()}\n{path}\n{ts_sec}\n{nonce}\n{body_sha256}")`) — implemented cleanly in Python, Node.js, and pure Rust (`rs_core` pure-Rust SHA-256 + HMAC-SHA256 helper already provided in `rs_core/src/sha256.rs`!) — with:
- Replay protection (`abs(now_sec - ts_sec) <= 300`, non-empty `nonce` not previously seen in `used_nonces`)
- Backwards-compatible `allow_legacy: bool` flag supporting `X-Sig-V1` ONLY when explicitly `True`

Make `python -m unittest discover -s tests`, `node --test js_worker/test.mjs`, and `cargo test --manifest-path rs_core/Cargo.toml` ALL pass cleanly.
