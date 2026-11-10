# Project context entrypoint

The product repository is rooted at `D:\Omnia`. Its preferred runtime is native
Rust. `native/` is an independent Windows shell package and shared services
currently live under `src-tauri/crates/`. The React/Tauri source is retained
compatibility code during migration.

Read [GOAL.md](GOAL.md) for requirements, atomic tasks, execution order and
retained backlog; [DOD.md](DOD.md) for acceptance; [CHECKPOINT.md](CHECKPOINT.md)
for observed state; [DECISIONS.md](DECISIONS.md) for architecture choices.
[COMPOSER_REQUIREMENTS.md](COMPOSER_REQUIREMENTS.md) owns the new editor intake.

The earlier version of this file described an older nested checkout and marked
six compatibility milestones DONE. Those historical claims are not current
native-product completion evidence. The previous text remains in Git history
and the private migration receipts. Reconcile its useful requirements with
current source before carrying any pass.
