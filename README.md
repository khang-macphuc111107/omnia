# Omnia

Windows-first native Rust AI workspace under active development.

## Start here

- Product code: [`native/`](native/) and [`src-tauri/crates/`](src-tauri/crates/).
- Compatibility projection: [`src/`](src/), [`src-tauri/`](src-tauri/) and
  the checked-in scripts/package manifests. The compatibility lane is not
  evidence that the target native runtime is complete.
- Goal, specs, tasks and migration gates: [`docs/workspace/GOAL.md`](docs/workspace/GOAL.md).
- Acceptance and current next action: [`DOD.md`](docs/workspace/DOD.md) and
  [`CHECKPOINT.md`](docs/workspace/CHECKPOINT.md).
- Prompt editor and attachments: [`docs/workspace/COMPOSER_REQUIREMENTS.md`](docs/workspace/COMPOSER_REQUIREMENTS.md).
- Recovery and topology records: [`docs/workspace/`](docs/workspace/).

## Native development

From the repository root on Windows with Rust and the MSVC build tools:

```powershell
$env:CARGO_TARGET_DIR = 'D:\OmniaData\build\native'
cargo metadata --manifest-path native/Cargo.toml --locked --no-deps --format-version 1
cargo test --manifest-path native/Cargo.toml --locked
cargo run --manifest-path native/Cargo.toml --locked
```

The native package is an independent workspace. Shared path dependencies are
included under `src-tauri/crates`; the directory name reflects compatibility
origin and does not require a Tauri shell for the native package. The
React/Tauri files are retained as a compatibility projection while native
replacement is measured and verified.
See [`native/README.md`](native/README.md) for evaluation-shell limits.

## Delivery status

Native source and shared crates have been copied into this root with per-file
byte verification. Final UI, production chat/provider delivery, IDE/browser
integration and measured resource performance remain incomplete.

Migration remains active. Previous primary/release/rebuild checkouts contain
different changes and retain recovery ownership until reconciliation. Ten
classified research/archive/tool trees now live outside this checkout; see
[`EXTERNAL_LAYOUT.json`](docs/workspace/EXTERNAL_LAYOUT.json). Backups and
remaining operational data still need classification or relocation.
Source at this root does not establish whole-workspace cleanup or feature parity.

Private chat archives, credentials and browser profiles stay outside published
Git. Shared specifications require review and redaction. GitHub publication
and fresh-clone delivery have not yet been verified.

## Export a committed source candidate

After reviewing and committing the intended changes:

```powershell
node tools/maintained-scripts/stage-public-release.mjs
node --test tools/maintained-scripts/stage-public-release.test.mjs
```

The export uses `HEAD` and writes a new directory plus an adjacent receipt
under `D:\OmniaData\exports`. `OMNIA_SOURCE_ROOT`, `OMNIA_EXPORT_REVISION`,
`OMNIA_DATA_ROOT` and `OMNIA_EXPORT_DESTINATION` allow explicit source/revision/
external destination selection. Working-tree edits are excluded. Review
privacy, licenses and build results before publishing the candidate.
