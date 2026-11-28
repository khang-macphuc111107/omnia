# Omnia Wiki

Welcome to the official **Omnia v5.1.0** engineering knowledge base — Windows-first **Full Native Rust 18-Crate Autonomous Agent Harness, Pure-Rust Computer Use (`omnia-computer`), 6-App Flagship Web Studio, `ratatui` TUI, and Win32 Mica Desktop Shell**.

## Quick Links

- [Architecture (18 Rust Crates)](Architecture-17-Crates.md) — Dependency topology (`+omnia-computer`), storage, routing, peer-mesh graph, and out-of-source build contracts.
- [CLI & `ratatui` TUI Reference](CLI-and-TUI-Reference.md) — Lean `12.763 MiB` `omnia.exe`, `0.11 ms` startup profile, `omnia learn`, `omnia proceed`, `omnia --mcp`, opt-in `--sandbox`, slash commands, Arena, Research, Deep Think, Lifecycle OS, and Skills CLI.
- [Flagship Studio UI (`ui-v5`)](Flagship-Studio-UI-v5.md) — AI Studio Parallel 2-4 Model Arena & Elo (`AUD-24` cancel), Live Sandboxed Artifact Canvas, 14-format `SourcePreviewModal`, zero-CDN math, ChatGPT Tree Branching, Perplexity Pro Answer Engine, NotebookLM++ (`AtelierView`), OmniDrive AIMD/HLS/DASH, and Capability Matrix (`AUD-25`).
- [Harness Freedom & Security Model](Harness-Freedom-and-Security.md) — Default `YOLO / Turbo / Full-Access / Auto-Approve` posture vs opt-in `--sandbox` / strict guardrails, loopback HTTP hardening (`AUD-02`), and non-bypass boundaries.
- [Benchmarks & v5 Scoreboard](Benchmarks-v5-Scoreboard.md) — Suite v5 (`#1 omnia 90.79% = 69/76`), `9/9` public suites (`47/47` benchmark tests incl. Issue #8 `container_runner.py`), `51/51` models probed, `5/5` efforts, and honest Docker/WSL2 container boundaries.
- [Git Workflow & Release Guide](Git-Workflow-and-Release-Guide.md) — Branching model, CI/CD (`release.yml` `embed-ui`), 3-round Cleanroom Audits, and reproducible releases.

## Release Snapshot (`v5.1.0`)

| Metric | Verified Value |
| --- | --- |
| Workspace Architecture | **18 Pure-Rust Crates** (`edition = "2021"`, `+omnia-computer`, `0` in-tree `.cpp`/`.hpp`/`CMake*`) |
| Standalone `omnia.exe` | **`12.763 MiB`** (`<= 14 MiB`), `--profile-startup` **`0.11 ms` / `5.71 MiB` RSS** |
| Rust Unit & Integration Tests | **`734 passed, 0 failed, 1 ignored`** (`50` suites / `18` crates) + `20/20` CLI + `34/34` Studio `embed-ui` (`0` Clippy warnings) |
| Studio Web & Fallback Tests | `ui-v5` **`2,564` Vite modules** (`0` CDN) + fallback `ui/` **`127/127`** `node --test` (`AUD-02/24/25` closed) |
| Suite v5 Benchmark Rank | **#1 `omnia` (`69/76 = 90.79%`, `80.6 MB` med RSS, `77.95%` KV, McNemar `p < 1e-5`)**, `47/47` benchmark tests |
| Playwright 4x4 WCAG Audit | **`16/16`** theme x viewport cells `>= 5.94:1`, `0px` overflow, `0` console/CDN errors (`a41c4d6` baseline) |
| Win32 Native & Target Contracts | `qa-paths` **`40/40`** & `qa-capture` **`14/14`** on v5.1.0 `omnia-native.exe`; `platform/targets.json` **`14/14`** (`linux`/`macos-native`); 5 live Win32 QA suites + frozen commit/3x cleanroom pending |
| Skills Parity & Golden Eval | **`22/22`** 3-way skills (`0` drift) + **`1,001`** Cold Vault + Model2Vec seek router + **`16/16` (`100%`)** bilingual eval |
