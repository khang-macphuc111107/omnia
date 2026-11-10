# Native Windows package

`omnia-native` is an independent Rust/Win32 evaluation executable. It shares
Rust session, provider and harness libraries from `src-tauri/crates` without
starting the Tauri host, a WebView, Electron or Node. Final UI, provider Send,
Browser and IDE integration remain open in
[the project goal](../docs/workspace/GOAL.md).

## Build and run from the repository root

Use Windows, Rust and the MSVC C/C++ build tools. Keep generated targets outside
the checkout:

```powershell
$env:CARGO_TARGET_DIR = 'D:\OmniaData\build\native'
cargo metadata --manifest-path native/Cargo.toml --locked --no-deps --format-version 1
cargo test --manifest-path native/Cargo.toml --locked
cargo build --manifest-path native/Cargo.toml --locked
& (Join-Path $env:CARGO_TARGET_DIR 'debug/omnia-native.exe')
```

Use `--release` when measuring release behavior and run the executable under
`release` in the same target directory. Tests from an isolated local clone are
recorded in [the checkpoint](../docs/workspace/CHECKPOINT.md); they use existing
Cargo caches and do not establish a cold installation or packaged performance.

## Current behavior

- Chat, Browser and IDE buttons select shell modes. Browser/IDE explain the
  pending integrations; they do not start an engine or open a project.
- A Unicode draft survives mode switches in memory. It is not a persisted
  transcript and is not delivered to a provider.
- Without `--session-db`, the shell does not open a personal database. To
  evaluate session metadata, pass an absolute path to a disposable fixture.
  Opening may perform recovery writes; the option is not a read-only observer.
- Shared `HarnessStore` ownership prevents a competing cooperative opener on
  the tested Windows filesystem. It is not an authorization boundary against
  hostile path replacement or uncooperative software.
- The session panel uses keyset pages of at most 50, Previous/Next and Refresh.
  One read transaction binds the current page, navigation and active metadata.
  An active session outside the page remains editable. At most 256 previous
  cursors are retained; Refresh restarts at the first page.
- Summaries are bounded at 256 KiB each, with 2 MiB raw JSON for a read page,
  sentinel and active record. Writes between requests can move rows; this is
  not a frozen multipage export.
- Unsaved title/model/effort require explicit discard before replacing
  navigation or closing. Failed storage and selection retain the form.

The shared libraries contain provider and run-control logic; this shell has no
connected provider Send/Cancel workflow. Library integration tests do not prove
those controls are available in the native window.

## Native QA entrypoints

The QA scripts can open disposable visible windows. The user requested live
observation, so `-KeepOpen` deliberately leaves the tested app visible. Each
script reports only its named scope; UIA/control-message checks are distinct
from physical keyboard, Vietnamese IME, Narrator and end-to-end provider QA.

| Script | Scope | Inputs |
|---|---|---|
| `qa-smoke.ps1` | Mode controls, draft, window capture and one process sample | Release executable |
| `qa-session.ps1` | Session metadata, settings and reopen through UIA | Release executable; creates isolated fixture |
| `qa-paging.ps1` | Paging and worker behavior | Release executable and disposable 125-row database |
| `qa-guard.ps1` | Unsaved-form and failed-selection guards | Debug executable and disposable seeded database |
| `qa-ownership.ps1` | Competing process ownership and reopen | Debug executable, new database and external output prefix |

`qa-paths.ps1` resolves `-Executable`, then absolute `CARGO_TARGET_DIR`, then
`OMNIA_DATA_ROOT\build\native` (default sibling `OmniaData`). The first four
scripts reserve a fresh external run directory under `OmniaData\qa\native`,
or accept a new absolute `-OutputDirectory`. Existing destinations and reparse
ancestors are refused. Ownership QA retains its explicit fresh `-OutputPrefix`
contract. Explicit executables and resolved build targets must also be external
to the repository. Database paths must be absolute and external: paging/guard
require an existing seeded file; ownership requires a new file with no existing
SQLite sidecars. These guards establish location and file type, not whether
an externally supplied database is disposable. Use only fixtures you created
for the run.

`qa-capture.ps1` shares the screenshot implementation for smoke, session,
paging and ownership QA. It verifies the HWND/process owner, uses one
DPI-unaware geometry/capture context for this evaluation shell, bounds the
bitmap, refuses an existing image and restores caller DPI after success or
failure. Receipts include logical bounds, dimensions and process creation time.
Physical screen coordinates, minimized/hidden windows and complete pixel
rendering need separate qualification and visual inspection.

```powershell
cargo build --manifest-path native/Cargo.toml --locked --release
pwsh -NoProfile -File native/qa-session.ps1 -KeepOpen
pwsh -NoProfile -File native/qa-paths.tests.ps1
pwsh -NoProfile -File native/qa-capture.tests.ps1 -Executable (Join-Path $env:CARGO_TARGET_DIR 'debug/omnia-native.exe') -OutputDirectory D:\OmniaData\qa\capture-helper-new-run
```

For paging or guard QA, first run the fixture producer with a **new** external
directory (use a different fixture for each workflow):

```powershell
cargo run --manifest-path native/Cargo.toml --locked --example qa_seed -- D:\OmniaData\qa\paging-fixture
pwsh -NoProfile -File native/qa-paging.ps1 -Executable (Join-Path $env:CARGO_TARGET_DIR 'debug/omnia-native.exe') -Database D:\OmniaData\qa\paging-fixture\sessions.sqlite3
```

The path tests exercise fixture files and guards; they do not launch or qualify
the product. Screenshots, logs and receipts stay outside this checkout.
Historical cycle 24–34 reports belong to the preserved rebuild evidence and are
not included as current release receipts. This root guide links only to current
project files. Physical input, accessibility, DPI/resize, final design,
packaging and comparative CPU/RAM/disk/GPU measurements remain open under
[the definition of done](../docs/workspace/DOD.md).
