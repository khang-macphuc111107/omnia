# Remote setup

The root Git repository (`D:\Omnia`) is published to the verified private GitHub repository per the user's Msg #114 mandate and OS-managed Git Credential Manager (GCM) account (correcting the earlier `khang-macphuc11107` typo):

- **Active `origin` remote**: `https://github.com/khang-macphuc111107/omnia.git` (fetch & push)
- **Repository URL & visibility**: `https://github.com/khang-macphuc111107/omnia` (`private`, owner `khang-macphuc111107`)
- **Local Git identity**:
  - `user.name`: `khang-macphuc111107`
  - `user.email`: `khang.macphuc111107@gmail.com`
  - `credential.https://github.com.username`: `khang-macphuc111107`
- **Collaborator access note (`HTMusTC`)**: `HTMusTC` is a Discord handle rather than a resolvable GitHub login. Once the collaborator shares their exact GitHub username, grant repository access at `https://github.com/khang-macphuc111107/omnia/settings/access`.

## Verified publication, archived baselines & clean-clone receipts (`DELIVERY-01` / `SESSION-G06`)

- **Archived pre-Wave-4 baseline tag**: `archive/pre-cpp-rust-snapshot-20261112` -> commit `c3033728abe6f0a4906a796bf7652c84408356d7` (tree `6198c676e8ef3e2ef055625d0126d7216b57fac1`, `2,039` files, passed `3/3` consecutive zero-defect audits in `D:\OmniaData\qa\audits-20261112\final-streak-3\round-{1,2,3}-v2-receipt.json` + Wave 3B clean-clone receipt `D:\OmniaData\qa\github-clean-clone-20261112\GITHUB_DELIVERY_AND_CLONE_RECEIPT.json` `sha256=35aaac06...`).
- **Wave 4 C++20 archival backup (`pre-full-rust-20261115`)**: Historical Wave 4 C++20/CMake files (`55` files) and Commit #5 clean-clone C++20 Release CTest receipt (`D:\OmniaData\qa\github-cpp20-clean-clone-20261112\GITHUB_CPP20_DELIVERY_RECEIPT.json`) are backed up externally under `D:\OmniaData\backups\pre-full-rust-20261115\`.
- **Active Full Native Rust (`Steer #14`) target tree**: `Cargo.toml`, `Cargo.lock`, `rust/**` (`13` crates), `native/{app.manifest,qa-*,README.md}`, `ui/**`, `platform/**`, `.agents/**` (`19` skills), `tools/**`, `docs/**`. Build outputs live strictly outside `D:\Omnia` (`CARGO_TARGET_DIR=D:\OmniaData\build\omnia-rust-workspace`).
- **Boundary rule**: Never push externalized `D:\OmniaData` archives, Cargo `target/` directories, SQLite databases, raw chat transcripts, credentials, or unreviewed dirty worktrees into `origin`.

## Non-interactive push & verification commands

```powershell
$env:GCM_INTERACTIVE = 'never'
$env:GIT_TERMINAL_PROMPT = '0'
git -C "D:\Omnia" push origin master
git -C "D:\Omnia" status --short --branch
```
