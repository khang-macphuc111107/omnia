# Git Workflow & Release Guide

Omnia uses a disciplined trunk-and-branch release workflow backed by automated GitHub Actions CI/CD and 3-round frozen-snapshot Cleanroom Audits.

## Branching Model

- **`master`**: Protected production trunk — always clean, CI-green, and releasable.
- **Working Branches**: All development happens on named branches (`omnia-sota-harness`, `feat/*`, `fix/*`, `docs/*`, `ci/*`, `release/vX.Y.Z`) and promotes cleanly into `master` once verified.
- **Historical Archives**: Preserved via immutable tags (e.g., `archive/pre-cpp-rust-snapshot-20261112`).

## CI/CD Workflows (`.github/workflows/`)

| Workflow | Trigger | Gates |
| --- | --- | --- |
| `ci.yml` | Push & PR to `master` / feature branches | Zero-secret & hygiene audit (`audit.py`), `22/22` skills + `16/16` golden eval, `10/10` Python test suites, `119/119` fallback `ui/` JS tests, `17`-crate Windows `cargo check` + `clippy -D warnings` + `cargo test`, lean `omnia.exe <= 14 MiB`, and `native/qa-paths.tests.ps1` (`40/40`). |
| `release.yml` | Tag push `v*` / manual dispatch | Builds all 5 Windows x86_64 release binaries (standalone `omnia-cli` LAST), packages `omnia-<tag>-windows-x86_64.zip` + `SHA256SUMS.txt`, and publishes GitHub Release assets. |
| `wiki-sync.yml` | Push to `master` touching `docs/wiki/**` | Mirrors `docs/wiki/*.md` into `omnia.wiki.git` automatically once Wiki is initialized. |

## 3-Round Frozen-Snapshot Cleanroom Audit (`DOD-05`)

Before cutting a major semantic release tag (`vX.Y.Z`), an independent read-only verifier runs 3 distinct rounds on one frozen commit (`dirty_total = 0`):

1. **Round 1**: Full workspace check, `3/3` `clippy -D warnings`, all `575+` Rust tests, `10/10` Python suites, `119/119` fallback `ui/` tests, `tsc --noEmit`, `22/22` skills, `16/16` golden eval, and `audit.py --strict`.
2. **Round 2**: True zero-cache isolated `git clone --no-local --no-hardlinks` into an external temp directory + clean `CARGO_TARGET_DIR`, verifying cold `cargo test --workspace --offline --locked`, packaging validation, and strict audit before removing temp artifacts.
3. **Round 3**: Cross-surface truthfulness audit verifying `0` broken Markdown links, exact `5/5` release binary SHA-256 parity with `CHECKPOINT.md`, live `--version` & `--smoke` checks, and honest boundary disclosures.
