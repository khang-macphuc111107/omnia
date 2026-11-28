# Omnia Multi-Platform Target Contracts & Probe (`INT-09`)

This directory defines the honest packaging, build, install, launch, capability, and recovery contracts for Omnia across target platforms (`INT-09`), backed by a live deterministic toolchain and artifact probe.

## Declared Targets (`targets.json`, schema `omnia.platform.targets.v1`)

| Target ID | Scope | Source / Artifact Contract | Current Honest Gate Rule |
|---|---|---|---|
| `windows-native` | Full Native Rust Win32 desktop shell (`omnia-native.exe`), Flagship Studio host (`omnia-studio.exe`), and async provider runtime (`omnia-runtime.exe`) | Workspace `Cargo.toml` + `Cargo.lock` + `rust/omnia-{core,storage,studio,native,runtime}/Cargo.toml` + `native/app.manifest`; out-of-source builds (`..\OmniaData\build\omnia-rust-workspace\{release,debug}`, `omnia-rust-native-{release,debug}`, `omnia-full-rust\{release,debug}`) with zero in-tree `target/` or `.exe` outputs | Probes `cargo`, `rustc`, `vswhere`, MSVC `link.exe` (`msvc_link`), `x86_64-pc-windows-msvc`, and external binaries |
| `web-studio` | Flagship Studio UI (`ui/` zero-bundler ES2022 + CSS) served over `127.0.0.1` by Rust `omnia-studio.exe` | Verified via `node --check ui/app/*.js` and Microsoft Edge headless CDP readiness | Probes `ui/` + `rust/omnia-studio` inputs, runs `node --check`, locates `msedge.exe` and external `omnia-studio.exe` |
| `android-apk` | Android mobile wrapper (`platform/android` or `android`) + NDK/Cargo cross-compile | Requires Android SDK (`ANDROID_HOME`/`ANDROID_SDK_ROOT`), `sdkmanager`, `adb`, Android NDK, Gradle, Java, `cargo-ndk`, `aarch64-linux-android` / `armv7-linux-androideabi`, and real Gradle/AndroidManifest wrapper files | Must report `toolchain_missing` and/or `unimplemented` whenever SDK/NDK/wrapper files are absent — **zero fake APKs** |
| `linux-native` | Linux Full Native Rust headless CLI (`omnia`) and async provider runtime (`omnia-runtime`) with POSIX `libsqlite3` fallback | Workspace `Cargo.toml` + `Cargo.lock` + `rust/omnia-{core,storage,winsqlite,agent,cli,runtime}/Cargo.toml`; out-of-source builds linking host POSIX `libsqlite3` | Probes `cargo`, `rustc`, `x86_64-unknown-linux-gnu`, source inputs, and external ELF binaries |
| `macos-native` | macOS Full Native Rust headless CLI (`omnia`) and async provider runtime (`omnia-runtime`) with POSIX `libsqlite3` fallback | Workspace `Cargo.toml` + `Cargo.lock` + `rust/omnia-{core,storage,winsqlite,agent,cli,runtime}/Cargo.toml`; out-of-source builds linking macOS system `libsqlite3` | Probes `cargo`, `rustc`, `aarch64-apple-darwin`, source inputs, and external Mach-O binaries |

## Usage

Always invoke Python with `-B` so zero `__pycache__` or `.pyc` files are created inside `D:\Omnia`:

```powershell
# Run the unit test suite (real probes, mock-injected Android SDK/wrapper states, MSVC linker guard, UTF-8 LF hygiene, CLI exit codes)
python -B -m unittest discover -s D:\Omnia\platform -p "test_*.py" -v

# Run the live toolchain probe and save an external QA receipt
python -B D:\Omnia\platform\validate_targets.py --json-out D:\OmniaData\qa\wave4-native-qa-20261115\PLATFORM_TARGETS_RECEIPT.json

# Optional strict gate (exits 1 if any target, including android-apk, is not ready)
python -B D:\Omnia\platform\validate_targets.py --fail-on-unready
```

## Boundaries

- `validate_targets.py` probes installed toolchains, source inputs, JS syntax (`node --check`), external build binaries, and out-of-source hygiene without modifying the repository or executing untrusted binaries.
- Functional Cargo workspace tests (`cargo test --workspace --locked --target-dir ..\OmniaData\build\...`), Win32 UIA QA (`native/qa-*.ps1`), and live Edge CDP visual checks remain owned by their dedicated test harnesses rather than being claimed from static presence checks alone.
