---
name: deep-cpp-native
description: Architect, build, debug, and verify zero-overhead native Windows 11 C++20 applications and libraries using out-of-source CMake, Ninja, MSVC (/std:c++20 /utf-8 /W4 /WX), and CTest, strict RAII handle deleters, winsqlite3 WAL with cooperative process leases, BCrypt SHA-256, DWM Dark/Mica with Direct2D/DirectWrite, server-side COM WM_GETOBJECT UI Automation plus WH_CBT modal #32770 subclassing, and Origin-guarded Winsock2 127.0.0.1 loopback bridges.
metadata:
  short-description: Native Windows 11 C++20, CMake/Ninja/MSVC, RAII, WinSQLite3, Direct2D, UIA, and Winsock2
---

# Deep C++20 Native Windows Engineering

Design, build, and verify fast, memory-safe, zero-bloat Windows 11 C++20 systems using standard-library RAII and first-party Windows SDK libraries (`winsqlite3`, `bcrypt`, `dwmapi`, `d2d1`, `dwrite`, `uiautomationcore`, `ws2_32`) without Electron, Node, or heavy third-party dependency chains.

For complete CMake/Ninja presets, RAII handle deleters, `winsqlite3` lease SQL, COM `WM_GETOBJECT` + `WH_CBT` `#32770` UIA patterns, and `Winsock2` `Origin` guards, read [references/windows-cpp20-win32-uia-and-cmake.md](references/windows-cpp20-win32-uia-and-cmake.md).

## 1. Out-of-Source CMake, Ninja, MSVC C++20 & CTest Discipline

1. **Externalized Build Trees Only**:
   - Configure and build strictly outside the repository worktree (`cmake --preset release` pointing `binaryDir` to `<external-build-root>/<target>-release`, or `cmake -G Ninja -S <repo-root> -B <external-build-dir>`). Never emit `CMakeFiles/`, `CMakeCache.txt`, `compile_commands.json`, `.obj`, `.pdb`, `.ilk`, `.lib`, or `.exe` into tracked source directories.
2. **Compiler & Linker Hardening (`vcvars64.bat` + MSVC)**:
   - Enforce `/std:c++20 /permissive- /Zc:__cplusplus /Zc:preprocessor /utf-8 /EHsc /W4 /WX` with `NOMINMAX`, `WIN32_LEAN_AND_MEAN`, and `UNICODE` / `_UNICODE` target definitions.
   - Gate subprojects cleanly (`option(BUILD_NATIVE_SHELL "Build Win32 shell" ON)` + `if(BUILD_NATIVE_SHELL AND EXISTS ...)`) so core libraries and Win32 shells compile both standalone and in unified workspace builds without build-lock contention.
3. **Deterministic `CTest` Suites**:
   - Register granular C++20 test binaries via `enable_testing()` and `add_test()`, running `ctest --test-dir <external-build-dir> --output-on-failure` in both Debug and Release configurations before claiming completion.

## 2. Zero-Overhead RAII, Type Safety & UTF-8 Boundaries

1. **Deterministic OS & SDK Resource Ownership**:
   - Wrap every Win32, SQLite, CNG, socket, and GDI/D2D resource in `std::unique_ptr` with a stateless custom deleter (`UniqueHandle`, `UniqueSqlite3`, `UniqueSqliteStmt`, `UniqueBcryptAlg`, `UniqueBcryptHash`, `UniqueSocket`) or `Microsoft::WRL::ComPtr` / atomic COM refcounting. Ban raw owning `new`/`delete` and manual cleanup paths that leak on early return.
2. **Non-Owning Views & Strict UTF-8 <-> UTF-16 Conversion**:
   - Pass `std::span<const std::byte>` for binary buffers and `std::string_view` for UTF-8 text. Keep internal domain models pure UTF-8 (`\n`), converting to `std::wstring` only at Win32 `*W` entrypoints with `MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, ...)` and `WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, ...)`. Never call legacy ANSI (`*A`) Win32 APIs.

## 3. Native Windows 11 SDK Subsystem Patterns

1. **`winsqlite3.h` (`winsqlite3.lib`) WAL + Cooperative Process Leases**:
   - Open databases with `SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX` and execute `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`.
   - Bind parameters via prepared statements (`SQLITE_TRANSIENT`) — never string-concatenate SQL.
   - Implement single-writer cooperative session leases storing `(owner_pid, process_start_filetime_100ns, heartbeat_utc_ms)`. Validate existing lease holders with `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)` + `GetProcessTimes` (`lpCreationTime` match + `WaitForSingleObject(hProc, 0) == WAIT_TIMEOUT`) so OS PID reuse after a crash never blocks recovery or steals a live owner's lease. Read-only auditors must use URI `file:...?immutable=1` or read-only connections without mutating `-wal`/`-shm` state.
2. **`bcrypt.h` (`bcrypt.lib`) CNG Streaming SHA-256**:
   - Compute SHA-256 digests (`BCRYPT_SHA256_ALGORITHM`) via RAII `BCRYPT_ALG_HANDLE` (`BCRYPT_HASH_REUSABLE_FLAG`) and `BCRYPT_HASH_HANDLE` over `std::span<const std::byte>` chunks for content-addressed attachments, lockfiles, and plaintext-free erasure receipts.
3. **`dwmapi.h` + `d2d1.h` + `dwrite.h` Per-Monitor DPI v2 Shell**:
   - Enable `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`, apply `DwmSetWindowAttribute` (`DWMWA_USE_IMMERSIVE_DARK_MODE = 20`, `DWMWA_SYSTEMBACKDROP_TYPE = 38` Mica/Tabbed backdrop with clean surface fallback), scale every control metric via `GetDpiForWindow(hwnd)` on `WM_DPICHANGED`, size status panels dynamically so multi-line telemetry never clips, and recreate `ID2D1HwndRenderTarget` resources cleanly on `D2DERR_RECREATE_TARGET`.
4. **Server-Side COM `WM_GETOBJECT` UI Automation + `WH_CBT` `#32770` Modal Subclassing**:
   - Implement `IRawElementProviderSimple`, `IValueProvider` (`UIA_EditControlTypeId` / `UIA_DocumentControlTypeId`), and `IInvokeProvider` (`UIA_ButtonControlTypeId`), returning them from `WM_GETOBJECT` (`lParam == UiaRootObjectId`) via `UiaReturnRawElementProvider`. Server-side providers allow reliable headless/background UIA inspection and value injection without `UIAutomationClientsideProviders` `SetFocus` failures.
   - Route modal `MessageBoxW` confirmations through a thread-scoped `SetWindowsHookExW(WH_CBT, HookProc, nullptr, GetCurrentThreadId())` wrapper: on `HCBT_ACTIVATE` for class `#32770`, enumerate standard buttons (`IDOK=1`, `IDCANCEL=2`, `IDYES=6`, `IDNO=7`), guard against double subclassing with `GetPropW`/`SetPropW`, and in `IInvokeProvider::Invoke()` activate the root `#32770` dialog (`SetActiveWindow(GetAncestor(hwnd, GA_ROOT))`) before posting `BM_CLICK`. Disconnect providers with `UiaDisconnectProvider` on `WM_NCDESTROY`.
5. **`Winsock2` (`ws2_32.lib`) `127.0.0.1` Loopback & WebView2/Studio Bridge Security**:
   - Bind sockets strictly to `htonl(INADDR_LOOPBACK)` (`127.0.0.1`) with `SO_EXCLUSIVEADDRUSE` (never `INADDR_ANY` `0.0.0.0`).
   - Enforce `Host` (`127.0.0.1:<port>`) and exact loopback `Origin` (`http://127.0.0.1:<port>`) checks (`403 Forbidden` on mismatch or cross-origin `https://evil.example`) across all state-mutating HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`) and companion WebSocket `Upgrade` handshakes.
   - Canonicalize static `--ui-root` file paths via `std::filesystem::weakly_canonical` and verify prefix containment before serving `.html`/`.css`/`.js`/`.svg` assets so `..` traversal or reparse points cannot escape `--ui-root`.

## 4. Verification & Hygiene Checklist

- **Zero Warnings & Clean CTest**: `cmake --build` passes with `0` warnings under `/W4 /WX`; `ctest --output-on-failure` passes `100%` in Debug and Release, including negative cross-origin `403` and stale-PID lease-recovery tests.
- **Process & Sandbox Hygiene**: Terminate spawned GUI/studio processes cleanly after automated UIA/HTTP smoke captures (`0` orphan `.exe` processes left in isolated `exebox-*` or CI desktops).
- **Source & Secret Hygiene**: Pure UTF-8 `LF` (`git diff --check` exit `0`), `0` personal paths in tracked files, and runtime-constructed synthetic prefixes in secret-redactor unit tests so static secret scanners stay `0`-finding clean.
