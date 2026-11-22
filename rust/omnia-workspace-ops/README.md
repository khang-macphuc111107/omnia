# `omnia-workspace-ops` (`INT-06`)

Standalone Rust 2021 library implementing workspace-contained file and bounded command operations for Omnia:

1. **Canonical Workspace Containment (`src/path_guard.rs`)**:
   - `resolve_workspace_root(root)` and `resolve_contained_path(root, candidate)` enforce strict workspace-root containment.
   - Rejects `..` parent traversal, NUL bytes, Windows `\\?\` / `\\.\` / UNC / drive-relative prefixes, NTFS alternate data stream colons, trailing dots/spaces, Windows reserved device names (`CON`, `NUL`, `AUX`, `PRN`, `COM1`..`COM9`, `LPT1`..`LPT9`), and any symlink or NTFS reparse point component (`FILE_ATTRIBUTE_REPARSE_POINT = 0x400`).

2. **Safe UTF-8 LF File Ops & External Rollback (`src/fs_ops.rs`)**:
   - `read_text_file` validates strict UTF-8 and enforces `LineEndingPolicy::NormalizeToLf` or `LineEndingPolicy::RejectCrlf`, reporting SHA-256 digests and line counts.
   - `read_snippet` slices 1-based inclusive line ranges with aligned line numbers.
   - `write_atomic` performs `temp + sync_all + rename` inside the target directory, computes before/after SHA-256 digests and LCS-based `unified_diff` summaries, and writes backup blobs + `.rollback.json` receipts strictly to an external `rollback_dir` outside the workspace (never creating `.bak` files inside the workspace).
   - `rollback_write` verifies SHA-256 integrity and restores original content (or removes newly created files).

3. **Bounded Subprocess Execution (`src/process_ops.rs`)**:
   - `run_bounded_command` validates `cwd` inside the workspace root, drains stdout/stderr concurrently up to `max_stdout_bytes` / `max_stderr_bytes`, enforces `timeout_ms` with Windows process-tree termination (`taskkill /PID <pid> /T /F` + `child.kill()`), records elapsed `duration_ms`, and returns explicit timeout termination receipts (`timed_out: true`, `exit_code: None`, `success: false`).

## Build & Verification (Out-of-Source `CARGO_TARGET_DIR`)

Always keep build artifacts outside the repository checkout (`DOD-06`):

```powershell
$env:CARGO_TARGET_DIR = "D:\OmniaData\build\agy-workspace-ops-20261114"
cargo fmt --manifest-path D:\Omnia\rust\omnia-workspace-ops\Cargo.toml -- --check
cargo test --manifest-path D:\Omnia\rust\omnia-workspace-ops\Cargo.toml --offline
```
