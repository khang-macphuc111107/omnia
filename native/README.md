# Native C++20 Windows Shell (`omnia-native`)

`omnia-native.exe` is an independent Modern C++20 Win32 + DWM Mica + Direct2D +
Server-Side UI Automation desktop shell. It links exclusively against first-party
Windows 11 SDK system libraries (`winsqlite3`, `bcrypt`, `ws2_32`, `dwmapi`,
`d2d1`, `dwrite`, `uiautomationcore`, `comctl32`, `uxtheme`, `gdi32`, `user32`,
`ole32`, `oleaut32`) without a WebView, Electron, or Node runtime.

## Build and test out-of-source

Always keep generated build artifacts strictly outside the repository worktree:

```powershell
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul && cmake -G Ninja -S D:\Omnia\native -B D:\OmniaData\build\omnia-cpp-native-release -DCMAKE_BUILD_TYPE=Release && cmake --build D:\OmniaData\build\omnia-cpp-native-release && ctest --test-dir D:\OmniaData\build\omnia-cpp-native-release --output-on-failure'
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul && cmake -G Ninja -S D:\Omnia\native -B D:\OmniaData\build\omnia-cpp-native-debug -DCMAKE_BUILD_TYPE=Debug && cmake --build D:\OmniaData\build\omnia-cpp-native-debug && ctest --test-dir D:\OmniaData\build\omnia-cpp-native-debug --output-on-failure'
```

`native/CMakeLists.txt` builds cleanly both standalone (`cmake -S D:\Omnia\native`)
and via `add_subdirectory(native)` from the root `CMakeLists.txt`.

## Targets

- `omnia_native_lib`: Static C++20 library implementing `HarnessStore` (`winsqlite3.h` WAL +
  kernel-backed `LockFileEx` `StoreOwnership`), `Sessions` & bounded `SessionWorker`,
  `RichComposer` (15 Math/Physics/Chemistry symbols, SHA-256 deduplicated attachments,
  paste chooser, drop zones, conversion states, atomic draft persistence), server-side
  COM UI Automation (`IRawElementProviderSimple`, `IValueProvider`, `IInvokeProvider`,
  thread-scoped `WH_CBT` `#32770` modal button subclassing), and the Win32 + DWM Mica +
  Direct2D shell.
- `omnia-native.exe`: Standalone `WIN32` desktop shell (`1220x820`).
- `omnia_qa_seed.exe`: Disposable synthetic 125-row SQLite paging/guard fixture generator.
- `omnia_native_tests.exe`: 29 C++20 `CTest` unit and integration tests.

## Runtime behavior

- `Chat` (`101`), `Browser` (`102`), and `IDE` (`103`) select workspace modes while
  preserving the Unicode scratch draft (`112`) and rich composer symbol toolbar (`114..118`).
- Without `--session-db`, no personal database is opened automatically. Passing
  `--session-db <absolute isolated database path>` starts one bounded background
  `SessionWorker` backed by `winsqlite3` WAL and kernel byte-range ownership locking.
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
`OMNIA_DATA_ROOT\build\omnia-cpp-native-{release,debug}\omnia-native.exe` (default sibling
`OmniaData`). Seed disposable 125-row databases for `qa-paging.ps1` and `qa-guard.ps1` with:

```powershell
D:\OmniaData\build\omnia-cpp-native-release\omnia_qa_seed.exe D:\OmniaData\qa\paging-fixture
pwsh -NoProfile -File D:\Omnia\native\qa-paging.ps1 -Database D:\OmniaData\qa\paging-fixture\sessions.sqlite3
```
