# Omnia Wiki

Welcome to the official **Omnia v5.0.0** engineering knowledge base — Windows-first **Full Native Rust 17-Crate Autonomous Agent Harness, 6-App Flagship Web Studio, `ratatui` TUI, and Win32 Mica Desktop Shell**.

## Quick Links

- [Architecture (17 Rust Crates)](Architecture-17-Crates.md) — Dependency topology, storage, routing, peer-mesh graph, and out-of-source build contracts.
- [CLI & `ratatui` TUI Reference](CLI-and-TUI-Reference.md) — Lean `12.389 MiB` `omnia.exe`, `8.29-10.40 ms` cold/warm `--version`, slash commands, Arena, Research, Deep Think, Lifecycle OS, and Skills CLI.
- [Flagship Studio UI (`ui-v5`)](Flagship-Studio-UI-v5.md) — AI Studio Parallel 2-4 Model Arena & Elo, Live Sandboxed Artifact Canvas, ChatGPT Tree Branching, Claude Thinking Accordions, Perplexity Pro Answer Engine, and NotebookLM++ (`AtelierView`).
- [Harness Freedom & Security Model](Harness-Freedom-and-Security.md) — Default `YOLO / Turbo / Full-Access / Auto-Approve` posture vs opt-in strict guardrails, loopback HTTP hardening, and non-bypass boundaries.
- [Benchmarks & v5 Scoreboard](Benchmarks-v5-Scoreboard.md) — Suite v5 (`#1 omnia 90.79% = 69/76`), `9/9` public suites, `51/51` models probed, `5/5` efforts, and honest Docker/WSL2 container boundaries.
- [Git Workflow & Release Guide](Git-Workflow-and-Release-Guide.md) — Branching model, CI/CD, 3-round Cleanroom Audits, and reproducible releases.

## Release Snapshot (`v5.0.0`)

| Metric | Verified Value |
| --- | --- |
| Workspace Architecture | **17 Pure-Rust Crates** (`edition = "2021"`, `0` in-tree `.cpp`/`.hpp`/`CMake*`) |
| Standalone `omnia.exe` | **`12.389 MiB`** (`<= 14 MiB`), warm `--version` **`8.29-10.40 ms`** (`<= 15 ms`) |
| Rust Unit & Integration Tests | **`575/575`** workspace + **`27/27`** `embed-ui` + **`15/15`** standalone CLI (`3/3` `clippy -D warnings`) |
| Suite v5 Benchmark Rank | **#1 `omnia` (`69/76 = 90.79%`, `80.6 MB` med RSS, `77.95%` KV, McNemar `p < 1e-5`)** |
| Playwright 4x4 WCAG Audit | **`16/16`** theme x viewport cells `>= 5.94:1`, `0px` overflow, `0` console/CDN errors |
| Win32 Native QA (`pwsh`) | **`7/7` suites (`90/90` PASS)**, `uiaIssue: null`, Windows 11 IME resilient |
| Skills Parity & Golden Eval | **`22/22`** 3-way skills (`0` drift) + **`1,001`** Cold Vault + **`16/16` (`100%`)** bilingual eval |
