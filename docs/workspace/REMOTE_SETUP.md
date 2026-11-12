# Remote setup

The root Git repository (`D:\Omnia`) is published to the verified private GitHub repository per the user's Msg #114 mandate and OS-managed Git Credential Manager (GCM) account (correcting the earlier `khang-macphuc11107` typo):

- **Active `origin` remote**: `https://github.com/khang-macphuc111107/omnia.git` (fetch & push)
- **Repository URL & visibility**: `https://github.com/khang-macphuc111107/omnia` (`private`, owner `khang-macphuc111107`)
- **Local Git identity**:
  - `user.name`: `khang-macphuc111107`
  - `user.email`: `khang.macphuc111107@gmail.com`
  - `credential.https://github.com.username`: `khang-macphuc111107`
- **Collaborator access note (`HTMusTC`)**: `HTMusTC` is a Discord handle rather than a resolvable GitHub login. Once the collaborator shares their exact GitHub username, grant repository access at `https://github.com/khang-macphuc111107/omnia/settings/access`.

## Verified publication, archived Rust tag & C++20 clean-clone receipts (`DELIVERY-01` / `SESSION-G06`)

- **Archived pre-C++20 Rust/Tauri baseline tag**: `archive/pre-cpp-rust-snapshot-20261112` -> commit `c3033728abe6f0a4906a796bf7652c84408356d7` (tree `6198c676e8ef3e2ef055625d0126d7216b57fac1`, `2,039` files, passed `3/3` consecutive zero-defect audits in `D:\OmniaData\qa\audits-20261112\final-streak-3\round-{1,2,3}-v2-receipt.json` + Wave 3B clean-clone receipt `D:\OmniaData\qa\github-clean-clone-20261112\GITHUB_DELIVERY_AND_CLONE_RECEIPT.json` `sha256=35aaac06...`).
- **Wave 4 Full Native C++20 + Flagship Studio UI delivery (`origin/master`)**: Commit #4 replaces all Rust/Cargo/legacy web files (`0` `.rs`, `0` `Cargo.*`) with the self-contained C++20 + Flagship Studio UI tree (`CMakeLists.txt`, `CMakePresets.json`, `cpp/**`, `native/**`, `ui/**`, `.agents/**`, `tools/**`, `docs/**`) and verifies an independent remote GitHub clone + out-of-source Release CMake/Ninja build + `35/35` `ctest --output-on-failure` cases in `D:\OmniaData\qa\github-cpp20-clean-clone-20261112\GITHUB_CPP20_DELIVERY_RECEIPT.json` (with temporary clone and build directories immediately purged so zero duplicate disk bloat remains).
- **Boundary rule**: Never push externalized `D:\OmniaData` archives, CMake build directories, SQLite databases, raw chat transcripts, credentials, or unreviewed dirty worktrees into `origin`.

## Non-interactive push & verification commands

```powershell
$env:GCM_INTERACTIVE = 'never'
$env:GIT_TERMINAL_PROMPT = '0'
git -C "D:\Omnia" push origin master
git -C "D:\Omnia" status --short --branch
```
