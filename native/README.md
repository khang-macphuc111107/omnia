# Native Rust Windows Shell (`omnia-native`)

`omnia-native.exe` is the Full Native Rust Win32 + DWM Mica + Direct2D + raw COM UI
Automation desktop shell implemented in [`rust/omnia-native`](../rust/omnia-native/)
with embedded application manifest [`native/app.manifest`](app.manifest). It links
against Windows SDK system libraries (`d2d1`, `dwrite`, `uiautomationcore`, `dwmapi`,
`uxtheme`, `comctl32`, `ole32`, `oleaut32`, `user32`, `gdi32`, `psapi`, and `winsqlite3`
via `omnia-winsqlite`) without a WebView, Electron, or Node runtime.

## Build, test, and stage out-of-source

Always keep Cargo target directories and staged binaries strictly outside the
repository worktree (`D:\OmniaData\build\...`):

```powershell
# Workspace build and crate tests into external target dir
cargo test --locked -p omnia-native --target-dir D:\OmniaData\build\omnia-rust-workspace
cargo build --locked -p omnia-native --target-dir D:\OmniaData\build\omnia-rust-workspace
cargo build --locked --release -p omnia-native --target-dir D:\OmniaData\build\omnia-rust-workspace

# Stage Debug/Release outputs for default qa-paths.ps1 resolution
New-Item -ItemType Directory -Force -Path D:\OmniaData\build\omnia-rust-native-debug, D:\OmniaData\build\omnia-rust-native-release | Out-Null
Copy-Item D:\OmniaData\build\omnia-rust-workspace\debug\omnia-native.exe, D:\OmniaData\build\omnia-rust-workspace\debug\omnia_qa_seed.exe -Destination D:\OmniaData\build\omnia-rust-native-debug -Force
Copy-Item D:\OmniaData\build\omnia-rust-workspace\release\omnia-native.exe, D:\OmniaData\build\omnia-rust-workspace\release\omnia_qa_seed.exe -Destination D:\OmniaData\build\omnia-rust-native-release -Force
```

## Targets and workspace crates

- `rust/omnia-native` (`[[bin]] omnia-native`): Standalone Win32 + DWM Mica + Direct2D +
  COM UI Automation desktop shell embedding [`app.manifest`](app.manifest) via `build.rs`,
  backed by `omnia-core`, `omnia-harness`, `omnia-storage`, and `omnia-winsqlite`.
- `rust/omnia-native` (`[[bin]] omnia_qa_seed`): Disposable synthetic 125-row SQLite
  paging/guard fixture generator for external QA runs.

## Runtime behavior

- `Chat` (`101`), `Browser` (`102`), and `IDE` (`103`) select workspace modes while
  preserving the Unicode scratch draft (`112`) and rich composer symbol toolbar (`114..118`).
- Without `--session-db`, no personal database is opened automatically. Passing
  `--session-db <absolute isolated database path>` starts one bounded background
  `SessionWorker` backed by `winsqlite3` WAL and kernel `LockFileEx` byte-range ownership locking.
- Keyset pagination (`limit 50`, `Previous page` `128`, `Next page` `129`, `Refresh sessions`
  `127`) binds the page, navigation snapshot, and off-page active metadata inside one read
  transaction.
- Unsaved session settings (`122`, `123`, `124`) and unsaved scratch drafts (`112`) prompt
  before discarding navigation or closing the window.

## Native QA entrypoints

| Script | Scope | Default binary profile |
|---|---|---|
| `qa-paths.tests.ps1` | External path, reparse, and sidecar containment contract (40 cases) | Path fixtures only |
| `qa-capture.tests.ps1` | `PrintWindow` capture helper, DPI restore, and refusal guards (14 cases) | Debug executable |
| `qa-smoke.ps1` | Server-side UIA `Edit`, mode controls, Unicode draft, modal close guard, capture (4 cases) | Release executable |
| `qa-session.ps1` | Session metadata CRUD, UIA patterns, and reopen persistence (5 cases) | Release executable |
| `qa-paging.ps1` | 125-row keyset paging, off-page active edit, and SQLite write-lock pending UI (9 cases) | Release executable |
| `qa-guard.ps1` | Unsaved-form, mode, refresh, list-select, and close `#32770` modal guards (12 cases) | Debug executable |
| `qa-ownership.ps1` | Multi-process `StoreOwnership` contention and successor reopen (6 cases) | Debug executable |

`qa-paths.ps1` resolves `-Executable`, then `$env:OMNIA_NATIVE_BUILD_ROOT`, then
`OMNIA_DATA_ROOT\build\omnia-rust-native-{release,debug}\omnia-native.exe` (default sibling
`OmniaData`). Seed disposable 125-row databases for `qa-paging.ps1` and `qa-guard.ps1` with:

```powershell
D:\OmniaData\build\omnia-rust-native-release\omnia_qa_seed.exe D:\OmniaData\qa\paging-fixture
pwsh -NoProfile -File D:\Omnia\native\qa-paging.ps1 -Database D:\OmniaData\qa\paging-fixture\sessions.sqlite3
```
