# Project context entrypoint

The product repository is rooted at `D:\Omnia`. Under **Steer #14 (`Wave 5`)**, its active runtime is the **Full Native Rust** 13-crate Cargo workspace (`Cargo.toml`, `rust/`, compiled out-of-source via `CARGO_TARGET_DIR=D:\OmniaData\build\omnia-rust-workspace`; `0` `.cpp`/`.hpp`/`CMake*` in active source): shared `omnia-winsqlite`, `omnia-core`, `omnia-storage`, `omnia-routing`, `omnia-graph`, `omnia-harness`, `omnia-connector-gateway`, `omnia-workspace-ops`, `omnia-media-capture`, `omnia-remote-control`, `omnia-runtime` (`omnia-runtime.exe`), `omnia-studio` (`omnia-studio.exe`), and the Windows Win32 + DWM Mica + Direct2D + server-side COM UIA shell `omnia-native` (`omnia-native.exe`, embedding `native/app.manifest`) paired with the zero-bundler Flagship Studio UI ("Obsidian Kinetic Atelier") under `ui/` and `7` `pwsh` QA suites under `native/`. The historical Wave 4 C++20 snapshot is preserved externally under `D:\OmniaData\backups\pre-full-rust-20261115\`, and the earlier pre-Wave-4 snapshot stays on pushed Git tag `archive/pre-cpp-rust-snapshot-20261112`.

Read [GOAL.md](GOAL.md) for requirements, atomic tasks, execution order and
retained backlog; [DOD.md](DOD.md) for acceptance; [CHECKPOINT.md](CHECKPOINT.md)
for observed state; [DECISIONS.md](DECISIONS.md) for architecture choices.
[COMPOSER_REQUIREMENTS.md](COMPOSER_REQUIREMENTS.md) owns the new editor intake.

The earlier version of this file described an older nested checkout and marked
six compatibility milestones DONE. Those historical claims are not current
native-product completion evidence. The previous text remains in Git history
and the private migration receipts. Reconcile its useful requirements with
current source before carrying any pass.
