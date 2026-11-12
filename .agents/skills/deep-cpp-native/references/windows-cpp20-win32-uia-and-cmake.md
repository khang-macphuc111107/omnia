# Windows 11 C++20, CMake/Ninja, RAII, WinSQLite3, Direct2D, Server-Side UIA & Winsock2 Reference

## Table of Contents

1. [Out-of-Source CMake and Ninja Blueprint](#1-out-of-source-cmake-and-ninja-blueprint)
2. [Zero-Overhead RAII Deleters and UTF-8 Conversion](#2-zero-overhead-raii-deleters-and-utf-8-conversion)
3. [WinSQLite3 WAL Store and Cooperative Process Lease](#3-winsqlite3-wal-store-and-cooperative-process-lease)
4. [Windows CNG BCrypt Streaming SHA-256](#4-windows-cng-bcrypt-streaming-sha-256)
5. [DWM Dark Mica and Direct2D Per-Monitor DPI v2](#5-dwm-dark-mica-and-direct2d-per-monitor-dpi-v2)
6. [Server-Side COM UI Automation and Modal Dialog Subclassing](#6-server-side-com-ui-automation-and-modal-dialog-subclassing)
7. [Winsock2 Loopback Bridge and Origin Containment Guard](#7-winsock2-loopback-bridge-and-origin-containment-guard)

---

## 1. Out-of-Source CMake and Ninja Blueprint

Keep source trees 100% free of generated build artifacts by pairing `CMakePresets.json` (pointing to an externalized build root) with strict target-scoped compile options:

```cmake
cmake_minimum_required(VERSION 3.26)
project(native_studio_cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(project_warnings INTERFACE)
if(MSVC)
  target_compile_options(project_warnings INTERFACE
    /std:c++20 /permissive- /Zc:__cplusplus /Zc:preprocessor
    /utf-8 /EHsc /W4 /WX
  )
  target_compile_definitions(project_warnings INTERFACE
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS
  )
endif()

add_library(studio_core STATIC
  cpp/src/core/sha256.cpp
  cpp/src/storage/session_store.cpp
)
target_include_directories(studio_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/cpp/include")
target_link_libraries(studio_core
  PUBLIC project_warnings
  PRIVATE bcrypt winsqlite3 ws2_32 psapi
)

enable_testing()
add_executable(studio_core_tests cpp/tests/test_core.cpp)
target_link_libraries(studio_core_tests PRIVATE studio_core project_warnings)
add_test(NAME studio_core_tests COMMAND studio_core_tests)

option(BUILD_NATIVE_SHELL "Build Win32 UIA shell" ON)
if(BUILD_NATIVE_SHELL AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/native/CMakeLists.txt")
  add_subdirectory(native)
endif()
```

Invoke inside a Visual Studio x64 Native Tools (`vcvars64.bat`) shell with an external `-B` directory:

```bat
cmd /c ""%ProgramFiles(x86)%\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -S "<repo-root>" -B "<external-build-root>/release" && cmake --build "<external-build-root>/release" && ctest --test-dir "<external-build-root>/release" --output-on-failure"
```

---

## 2. Zero-Overhead RAII Deleters and UTF-8 Conversion

Stateless empty-struct deleters compile down to zero pointer-size overhead (`sizeof(UniqueHandle) == sizeof(HANDLE)`):

```cpp
#pragma once
#include <windows.h>
#include <bcrypt.h>
#include <winsock2.h>
#include <winsqlite/winsqlite3.h>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>

struct KernelHandleDeleter {
  using pointer = HANDLE;
  void operator()(HANDLE h) const noexcept {
    if (h != nullptr && h != INVALID_HANDLE_VALUE) {
      ::CloseHandle(h);
    }
  }
};
using UniqueHandle = std::unique_ptr<HANDLE, KernelHandleDeleter>;

struct SqliteDbDeleter {
  void operator()(sqlite3* db) const noexcept {
    if (db) ::sqlite3_close_v2(db);
  }
};
using UniqueSqliteDb = std::unique_ptr<sqlite3, SqliteDbDeleter>;

struct SqliteStmtDeleter {
  void operator()(sqlite3_stmt* st) const noexcept {
    if (st) ::sqlite3_finalize(st);
  }
};
using UniqueSqliteStmt = std::unique_ptr<sqlite3_stmt, SqliteStmtDeleter>;

struct BcryptAlgDeleter {
  using pointer = BCRYPT_ALG_HANDLE;
  void operator()(BCRYPT_ALG_HANDLE h) const noexcept {
    if (h) ::BCryptCloseAlgorithmProvider(h, 0);
  }
};
using UniqueBcryptAlg = std::unique_ptr<BCRYPT_ALG_HANDLE, BcryptAlgDeleter>;

struct BcryptHashDeleter {
  using pointer = BCRYPT_HASH_HANDLE;
  void operator()(BCRYPT_HASH_HANDLE h) const noexcept {
    if (h) ::BCryptDestroyHash(h);
  }
};
using UniqueBcryptHash = std::unique_ptr<BCRYPT_HASH_HANDLE, BcryptHashDeleter>;

struct WinsockSocketDeleter {
  using pointer = SOCKET;
  void operator()(SOCKET s) const noexcept {
    if (s != INVALID_SOCKET) ::closesocket(s);
  }
};
using UniqueSocket = std::unique_ptr<SOCKET, WinsockSocketDeleter>;

inline std::wstring utf8_to_wide(std::string_view utf8) {
  if (utf8.empty()) return {};
  const int needed = ::MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
      static_cast<int>(utf8.size()), nullptr, 0);
  if (needed <= 0) throw std::runtime_error("Invalid UTF-8 sequence");
  std::wstring out(static_cast<size_t>(needed), L'\0');
  ::MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
      static_cast<int>(utf8.size()), out.data(), needed);
  return out;
}

inline std::string wide_to_utf8(std::wstring_view wide) {
  if (wide.empty()) return {};
  const int needed = ::WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, wide.data(),
      static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) throw std::runtime_error("Invalid UTF-16 sequence");
  std::string out(static_cast<size_t>(needed), '\0');
  ::WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, wide.data(),
      static_cast<int>(wide.size()), out.data(), needed, nullptr, nullptr);
  return out;
}
```

---

## 3. WinSQLite3 WAL Store and Cooperative Process Lease

Windows recycles PIDs rapidly. Always pair `owner_pid` with the 64-bit `FILETIME` process creation timestamp from `GetProcessTimes` so a crashed owner's recycled PID is detected as stale and safely reclaimed inside an `IMMEDIATE` transaction:

```cpp
#include <cstdint>

struct ProcessIdentity {
  std::uint32_t pid{};
  std::uint64_t creation_time_100ns{};
};

inline bool query_process_identity(std::uint32_t pid, ProcessIdentity& out) noexcept {
  UniqueHandle proc(::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  if (!proc) return false;
  if (::WaitForSingleObject(proc.get(), 0) != WAIT_TIMEOUT) return false; // exited
  FILETIME create_ft{}, exit_ft{}, kernel_ft{}, user_ft{};
  if (!::GetProcessTimes(proc.get(), &create_ft, &exit_ft, &kernel_ft, &user_ft)) return false;
  ULARGE_INTEGER uli{};
  uli.LowPart = create_ft.dwLowDateTime;
  uli.HighPart = create_ft.dwHighDateTime;
  out = ProcessIdentity{pid, uli.QuadPart};
  return true;
}

inline bool is_lease_holder_alive(std::uint32_t holder_pid, std::uint64_t recorded_creation_100ns) noexcept {
  ProcessIdentity live{};
  if (!query_process_identity(holder_pid, live)) return false;
  return recorded_creation_100ns == 0 || live.creation_time_100ns == recorded_creation_100ns;
}
```

Recommended initialization pragmas right after `sqlite3_open_v2`:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS process_ownership_lease (
  lease_key TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  owner_start_100ns INTEGER NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL
);
```

---

## 4. Windows CNG BCrypt Streaming SHA-256

Zero-dependency cryptographic SHA-256 using Windows `bcrypt.lib`:

```cpp
#include <array>
#include <ntstatus.h>

inline std::string bcrypt_sha256_hex(std::span<const std::byte> data) {
  BCRYPT_ALG_HANDLE raw_alg = nullptr;
  if (::BCryptOpenAlgorithmProvider(&raw_alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) {
    throw std::runtime_error("BCryptOpenAlgorithmProvider failed");
  }
  UniqueBcryptAlg alg(raw_alg);

  BCRYPT_HASH_HANDLE raw_hash = nullptr;
  if (::BCryptCreateHash(alg.get(), &raw_hash, nullptr, 0, nullptr, 0, 0) < 0) {
    throw std::runtime_error("BCryptCreateHash failed");
  }
  UniqueBcryptHash hash(raw_hash);

  if (!data.empty()) {
    auto* ptr = reinterpret_cast<PUCHAR>(const_cast<std::byte*>(data.data()));
    if (::BCryptHashData(hash.get(), ptr, static_cast<ULONG>(data.size()), 0) < 0) {
      throw std::runtime_error("BCryptHashData failed");
    }
  }

  std::array<unsigned char, 32> digest{};
  if (::BCryptFinishHash(hash.get(), digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
    throw std::runtime_error("BCryptFinishHash failed");
  }

  static constexpr char kHex[] = "0123456789abcdef";
  std::string hex(64, '\0');
  for (size_t i = 0; i < digest.size(); ++i) {
    hex[i * 2]     = kHex[(digest[i] >> 4) & 0x0F];
    hex[i * 2 + 1] = kHex[digest[i] & 0x0F];
  }
  return hex;
}
```

When writing unit tests for secret redaction (`sk-*`, `ghp_*`, `AIza*`, PEM private key headers), assemble test tokens at runtime (for example, `std::string("sk-") + std::string(24, 'x')` or `std::string("-----BEGIN ") + "PRIVATE KEY-----"`) so repository-wide static secret scanners never raise false-positive alerts on test source files.

---

## 5. DWM Dark Mica and Direct2D Per-Monitor DPI v2

1. Call `::SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)` at process startup before creating any `HWND`.
2. Apply Windows 11 DWM attributes gracefully (ignoring unsupported HRESULTs on older builds):

```cpp
#include <dwmapi.h>

inline void apply_win11_studio_chrome(HWND hwnd, bool dark_mode = true) noexcept {
  const BOOL use_dark = dark_mode ? TRUE : FALSE;
  constexpr DWORD kDwmUseImmersiveDarkMode = 20;
  constexpr DWORD kDwmSystemBackdropType   = 38;
  constexpr int   kDwmSbtMainWindowMica    = 2; // DWMSBT_MAINWINDOW
  ::DwmSetWindowAttribute(hwnd, kDwmUseImmersiveDarkMode, &use_dark, sizeof(use_dark));
  ::DwmSetWindowAttribute(hwnd, kDwmSystemBackdropType, &kDwmSbtMainWindowMica, sizeof(kDwmSbtMainWindowMica));
}
```

3. On `WM_DPICHANGED`, resize the window using `reinterpret_cast<const RECT*>(lParam)` via `SetWindowPos(..., SWP_NOZORDER | SWP_NOACTIVATE)` and recompute font/control heights (`MulDiv(base_px, dpi, 96)`), keeping status/telemetry panels tall enough (`>= 150` logical px scaled by DPI) to avoid bottom-edge text clipping.
4. For `Direct2D` (`ID2D1HwndRenderTarget`) + `DirectWrite` (`IDWriteFactory`), if `EndDraw()` returns `D2DERR_RECREATE_TARGET`, release target-bound brushes/bitmaps and recreate them on the next `WM_PAINT`.

---

## 6. Server-Side COM UI Automation and Modal Dialog Subclassing

Background/non-foreground UI Automation tests fail with `InvalidOperationException` when relying on Windows' default client-side `SetFocus` proxy (`UIAutomationClientsideProviders`). Expose server-side COM providers directly:

1. **Custom / Rich Edit Controls (`WM_GETOBJECT`)**:
   - Implement `IRawElementProviderSimple` (`ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading`, `UIA_ControlTypePropertyId = UIA_EditControlTypeId` or `UIA_DocumentControlTypeId`, `UIA_AutomationIdPropertyId`, `UIA_IsValuePatternAvailablePropertyId = VARIANT_TRUE`) and `IValueProvider` (`SetValue` sending `WM_SETTEXT` + notifying parent `EN_CHANGE`, `get_Value` reading `GetWindowTextLengthW`/`GetWindowTextW`).
   - Handle `WM_GETOBJECT`:
     ```cpp
     if (static_cast<long>(lParam) == static_cast<long>(UiaRootObjectId)) {
       return ::UiaReturnRawElementProvider(hwnd, wParam, lParam, provider);
     }
     ```
   - Call `::UiaDisconnectProvider(provider)` in `WM_NCDESTROY` so UIA out-of-process clients never hold dangling `HWND` references.

2. **Modal `#32770` (`MessageBoxW`) Non-Foreground `InvokePattern.Invoke()` via `WH_CBT`**:
   - Standard Win32 `MessageBoxW` spins an internal modal loop whose `#32770` buttons fail `InvokePattern.Invoke()` when the desktop or window is unfocused.
   - Install a thread-scoped `WH_CBT` hook around `MessageBoxW`:
     ```cpp
     inline int uia_safe_modal_message_box(HWND owner, LPCWSTR text, LPCWSTR caption, UINT type) {
       HHOOK hook = ::SetWindowsHookExW(
           WH_CBT,
           [](int code, WPARAM wParam, LPARAM lParam) -> LRESULT {
             if (code == HCBT_ACTIVATE) {
               HWND dlg = reinterpret_cast<HWND>(wParam);
               wchar_t cls[32]{};
               if (::GetClassNameW(dlg, cls, 32) > 0 && ::wcscmp(cls, L"#32770") == 0) {
                 for (int id : {IDOK, IDCANCEL, IDYES, IDNO}) {
                   if (HWND btn = ::GetDlgItem(dlg, id)) {
                     attach_server_side_button_uia_once(btn); // guarded by GetPropW(btn, kSubclassedProp)
                   }
                 }
               }
             }
             return ::CallNextHookEx(nullptr, code, wParam, lParam);
           },
           nullptr,
           ::GetCurrentThreadId());
       const int result = ::MessageBoxW(owner, text, caption, type);
       if (hook) ::UnhookWindowsHookEx(hook);
       return result;
     }
     ```
   - Inside `attach_server_side_button_uia_once(HWND btn)`: check `::GetPropW(btn, kPropName)` first so repeated `HCBT_ACTIVATE` notifications never double-subclass the button; in `IInvokeProvider::Invoke()`, call `::SetActiveWindow(::GetAncestor(btn, GA_ROOT))` and `::SendMessageW(btn, BM_CLICK, 0, 0)`.

---

## 7. Winsock2 Loopback Bridge and Origin Containment Guard

When hosting a local studio UI (`WebView2` / `msedge --app=http://127.0.0.1:<port>`) from a C++20 `Winsock2` server:

1. **Loopback-Only Socket Binding**:
   ```cpp
   sockaddr_in addr{};
   addr.sin_family = AF_INET;
   addr.sin_addr.s_addr = ::htonl(INADDR_LOOPBACK); // strictly 127.0.0.1
   addr.sin_port = ::htons(port);
   BOOL excl = TRUE;
   ::setsockopt(listen_sock, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
                reinterpret_cast<const char*>(&excl), sizeof(excl));
   ```
2. **Cross-Origin Localhost CSRF & WebSocket Defense**:
   - Any website open in a user's browser can issue `fetch("http://127.0.0.1:8787/api/...", { method: "POST" })` or `new WebSocket("ws://127.0.0.1:8787/...")`.
   - Verify `Host` equals `127.0.0.1:<port>` (defeating DNS rebinding).
   - On every state-mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) and every WebSocket `Upgrade`, if `Origin` is present (or required for browser routes), verify exact equality against `http://127.0.0.1:<port>`; return `HTTP/1.1 403 Forbidden` immediately on any foreign origin (such as `https://evil.example` or `null`).
3. **Canonical Static Asset Containment**:
   - Resolve `ui_root = std::filesystem::weakly_canonical(raw_ui_root)` once at startup.
   - For each `GET /<rel_path>`, reject NUL bytes, backslashes, or leading `//`, compute `candidate = std::filesystem::weakly_canonical(ui_root / rel_path)`, verify `std::mismatch(ui_root.begin(), ui_root.end(), candidate.begin()).first == ui_root.end()`, and reject reparse points outside `ui_root` before reading bytes.
