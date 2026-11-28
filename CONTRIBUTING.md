# Contributing to Omnia

Thank you for contributing to **Omnia** (`https://github.com/khang-macphuc111107/omnia`).

## Git Branching & Release Workflow

- **`master`**: Always releasable, clean production branch (`dirty_total = 0`, all CI gates green). Do not commit directly to `master`.
- **Feature & Fix Branches**: Create focused branches off `master` using conventional prefixes (`feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `ci/<topic>`, `refactor/<topic>`, `release/vX.Y.Z`).
- **Pull Requests**: Target `master`, fill out `.github/PULL_REQUEST_TEMPLATE.md`, and verify all CI checks pass before merging.
- **Zero-Nerf Review Bar**: PRs must advance Omnia's Pure-Rust 17-crate architecture, performance budgets (`omnia.exe <= 14 MiB`, warm `--version <= 15 ms`), and full-freedom default harness (`ApprovalMode::Yolo`) — never revert to retired C++20 files or introduce untracked OS/build artifacts.
- **Semantic Releases**: Releases are cut from verified `master` snapshots via annotated tags (`git tag -a vX.Y.Z -m "..."`), triggering `.github/workflows/release.yml` and attaching `SHA256SUMS.txt`.

## Local Development Prerequisites (Windows 11)

- **Rust stable** (`edition = "2021"`, `clippy`) + Windows 11 SDK (`winsqlite3`)
- **PowerShell 7 (`pwsh`)** for `native/qa-*.ps1` (do not use Windows PowerShell 5.1)
- **Python 3.12+** (always invoke as `python -B` so zero `__pycache__` enters the repo)
- **Node.js 22+** for fallback `ui/` tests and `ui-v5/` Vite/TypeScript checks

## Mandatory Out-of-Source Build & Hygiene Rules (`DOD-06`)

Never write `target/`, `build/`, `node_modules/`, `dist/`, `__pycache__/`, `*.exe`, `*.pdb`, SQLite fixtures, or QA screenshots inside the repository checkout:

```powershell
$env:CARGO_TARGET_DIR = 'D:\OmniaData\build\omnia-rust-workspace'

cargo check --workspace --offline --locked
cargo clippy --workspace --all-targets --offline --locked -- -D warnings
cargo test --workspace --offline --locked -- --test-threads=2
cargo build --workspace --release --offline --locked
cargo build -p omnia-cli --release --offline --locked  # standalone LAST to keep omnia.exe <= 14 MiB
```

## Pre-PR Verification Checklist

Run before opening a PR:

```powershell
python -B tools/omnia-skill-parity/validate_skills.py --strict-all-skills
python -B .agents/skills/omni-bilingual-skill-router/scripts/skill_router.py golden-eval
python -B platform/validate_targets.py
python -B -m unittest discover -s platform -p "test_*.py"
node --test ui/tests/*.test.js
pwsh -NoProfile -File native/qa-paths.tests.ps1
python -B tools/omnia-consolidated-audit/audit.py --secret-scope all --strict --strict-scope full
git diff --check
git ls-files --eol
```

## Line Endings, Encoding & Privacy

- All tracked text files must use **UTF-8 without BOM**, **Unix `LF`** line endings (`.gitattributes`), zero trailing whitespace, and a single trailing newline.
- Never commit API keys, tokens, cookies, browser profiles, private transcripts, or real personal identifiers. Synthetic test fixtures must use unmistakable dummy markers (`dummy`, `fake`, `fixture`) and RFC-2606 domains (`example.com`, `example.test`) or loopback addresses.
