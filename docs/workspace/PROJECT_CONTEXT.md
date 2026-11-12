# Project context entrypoint

The product repository is rooted at `D:\Omnia`. Its canonical runtime is Modern
Native C++20 (`MSVC` + `CMake` + `Ninja` + Windows 11 SDK): shared core,
storage, dynamic routing, `PeerMeshGraph`/`GraphifyIndex`, harness services,
and the loopback Studio server (`omnia-studio.exe`) live under `cpp/`, the
native Windows DWM Mica / Direct2D / server-side COM UIA shell
(`omnia-native.exe`) lives under `native/`, and the zero-bundler Flagship
Studio UI ("Obsidian Kinetic Atelier") lives under `ui/` (with the pre-Wave-4
Rust/Tauri snapshot archived losslessly on Git tag
`archive/pre-cpp-rust-snapshot-20261112`).

Read [GOAL.md](GOAL.md) for requirements, atomic tasks, execution order and
retained backlog; [DOD.md](DOD.md) for acceptance; [CHECKPOINT.md](CHECKPOINT.md)
for observed state; [DECISIONS.md](DECISIONS.md) for architecture choices.
[COMPOSER_REQUIREMENTS.md](COMPOSER_REQUIREMENTS.md) owns the new editor intake.

The earlier version of this file described an older nested checkout and marked
six compatibility milestones DONE. Those historical claims are not current
native-product completion evidence. The previous text remains in Git history
and the private migration receipts. Reconcile its useful requirements with
current source before carrying any pass.
