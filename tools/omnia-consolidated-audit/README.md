# Omnia Consolidated Cross-Lane Audit (`omnia-consolidated-audit`)

Zero-dependency Python 3 standard-library auditor providing read-only pre-commit, disjoint ownership, byte-level UTF-8 `LF` hygiene, zero-secret, and Rust crate/`*.rs` inventory verification for `D:\Omnia`.

Always run with `python -B` so zero `__pycache__` or `.pyc` files are created inside the repository checkout.

## Checks Performed

1. **Branch & Disjoint Ownership Partition (`DISJOINT_OWNERSHIP.json`, `schema_version: 3`)**:
   - Verifies current Git branch matches expected integration branch (`codex/omnia-context-integration`) and is neither `main`, `master`, nor detached `HEAD`.
   - Parses `git status --porcelain=v1 -z -uall` and partitions every changed/untracked path into `codex_owned`, `antigravity_owned`, or `shared_or_unassigned`.
   - Checks both policy-rule overlaps/self-contradictions and actual dirty-path multi-owner collisions.
2. **Hygiene Scan (`antigravity_owned` and `full_repo` reported separately)**:
   - Strict UTF-8 decoding check, UTF-8 BOM check, `CRLF` (`\r\n`) and stray `\r` detection.
   - `__pycache__` directory and `.pyc`/`.pyo` bytecode detection.
   - Forbidden in-tree build output detection (`build/`, `target/`, `CMakeFiles/`, `CMakeCache.txt`).
   - Trailing whitespace counts and state-aware Git merge conflict marker detection (without false-positiving on Markdown setext headings).
3. **Zero-Secret Scan (Changed/Untracked Text Files)**:
   - Detects non-redacted `sk-...`, `ghp_...`, `github_pat_...`, `AIza...`, `Bearer ...`, `Cookie:`, URL embedded userinfo (`scheme://user:pass@host`), and access-bearing URL query/field tokens.
   - Distinguishes real leaks (`findings`), explicit redaction placeholders (`redacted_placeholders`), and clearly synthetic test fixtures inside test paths or Rust `#[cfg(test)]` blocks (`synthetic_test_fixtures`) with exact `file`, `line`, `rule`, and masked preview.
4. **Exact `rustFiles` Ground-Truth Inventory (`D:\Omnia\rust\`)**:
   - Lists each crate directory under `rust/`, ownership classification, `Cargo.toml`/`Cargo.lock` counts, per-crate `*.rs` lists, and total `rustFiles` count (excluding `target/`).

## Usage (`python -B`)

```powershell
# Run consolidated audit (full cross-lane strict check; exits 1 if Codex trailing whitespace or unassigned files exist)
python -B -m tools.omnia-consolidated-audit.audit `
  --repo D:\Omnia `
  --ownership D:\OmniaData\coordination\master-bridge-01a1d643\DISJOINT_OWNERSHIP.json `
  --out D:\OmniaData\qa\agy-parallel-20261114\wave3b-consolidated-audit\CONSOLIDATED_AUDIT_RECEIPT.json `
  --md-out D:\OmniaData\qa\agy-parallel-20261114\wave3b-consolidated-audit\CONSOLIDATED_AUDIT_REPORT.md `
  --strict

# Run Antigravity-lane strict readiness gate (still records full-repo strict_ready honestly in JSON/Markdown)
python -B -m tools.omnia-consolidated-audit.audit `
  --repo D:\Omnia `
  --ownership D:\OmniaData\coordination\master-bridge-01a1d643\DISJOINT_OWNERSHIP.json `
  --strict --strict-scope antigravity

# Run unit and read-only live smoke tests
python -B -m unittest discover -s D:\Omnia\tools\omnia-consolidated-audit -p "test_*.py" -v
```
