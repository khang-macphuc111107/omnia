# Wave 1 Shard 06 — Exhaustive Deep-Read Synthesis & Omnia / Antigravity (`agy-fast`) Upgrade Blueprint

**Shard Owner:** `studio-routes-v5` (Wave 1 Read-Only Deep-Read Shard 06, assignment `#407`)
**Date:** 2026-11-28
**Policy:** Pure UTF-8 `LF`, zero secrets/credentials, strict separation between `[VERIFIED]` direct source evidence, `[CROSS-CHECKED]` baseline comparisons (`D:\Omnia` at `HEAD = 1c9342c` & `agy-fast` at `v0.18.x`), and `[PROPOSED]` Wave 2 integration candidates. Zero mutations made to `D:\Omnia` or `C:\Users\khang\.gemini`.

---

## 1. Coverage Ledger (Zero-Skip Proof & Extraction Methods)

| # | Target File (`C:\Users\khang\Downloads\Omnia\...`) | Exact Bytes | Lines / Pages | Primary & Cross-Verification Methods | Completeness & Honest Notes |
|---|---|---:|---:|---|---|
| 1 | `Xếp Hạng Desktop Agent Harness.md` | 807,171 | 349 lines (`L1–342` body+refs; `L343–349` 4 base64 PNG charts) | Full UTF-8 `read_file` across `L1–342`; Python byte/line audit on `L343–349`; decoded 4 embedded PNGs (`harness_image1..4.png`: `235,450`, `118,278`, `116,751`, `60,536` B) & visually read all 4 via `read_file` | **100% covered** (`59,434` body chars + `736,486` Works Cited/base64). Chart 3 shows 27 scored items (`64.5–99.0`), while the prose table scores 36 configurations (`29` standalone + `1` OMP + `6` hybrids). |
| 2 | `Lựa Chọn Rust Hay C++ Cho App.pdf` | 10,199,054 | 248 pages | `read_file` native PDF renderer/OCR for **all 248/248 pages** + PyMuPDF 1.28.6 (`fitz`) page-count & plain-text dump (`1,151,256` chars, `17,756` lines) + targeted line reads around wrapped code spans (`L5536–5635`) | **100% covered**. Note title-vs-content discrepancy: despite its filename, this 248-page chat (`7df3eb64389d7011`) does *not* benchmark Rust vs C++; it specifies Omnia's 3-tier Focus Isolation, 20-Subsystem Universal I/O (`Frozen Spec v1.0`), 6/7-Tier Capture–Control–Access Matrix, and AI Agent+Harness+Model liberation blueprint + 6 brutal self-audit corrections. |
| 3 | `Khởi động và Quy trình Omnia.pdf` | 2,326,494 | 98 pages | `read_file` native PDF renderer/OCR for **all 98/98 pages** + PyMuPDF 1.28.6 page-count & plain-text dump (`486,049` chars, `6,580` lines) + targeted reads on code tails (`L5860–6230`) | **100% covered** (`887a06f320df3d95`). Documents Omnia's 7-file startup chain, 7-group governance taxonomy, 4-Layer 1,000-Skill Cold-Vault system (`249+148+167+185+180+71 = 1,000` skills across 100 categories = `3,000` files), BM25 router, stdio MCP bridge, 6 Tier-3 verifiers, 24 Tier-4 pipelines, Merkle `SKILL_LOCK.json`, and 16-case Golden Eval. |
| 4 | `Collatz Conjecture Mathematical Analysis.pdf` | 2,884,892 | 31 pages | `read_file` native PDF renderer/OCR for **all 31/31 pages** + PyMuPDF 1.28.6 verification (`31` pages, `63,328` chars) | **100% covered** (`149` citations). Late-Nov 2026 mathematical survey + July 2026 `CollatzLean` dual-bug kernel soundness incident (`CVE-2026-72844`) & `ccchallenge.org` axiom-smuggling forensics. |
| 5 | `The P Versus NP Problem.pdf` | 2,948,042 | 35 pages | `read_file` native PDF renderer/OCR for **all 35/35 pages** + PyMuPDF 1.28.6 verification (`35` pages, `68,264` chars) | **100% covered** (`158` citations). Nov 28, 2026 survey of CMI status, 3+ formal barriers, 2024–2026 peer-reviewed advances vs unrefereed Autumn 2026 AI-Lean claims (`ETH` galactic bound, `VP ≠ VNP`), Arthanari Lean axiom gap, and Aaronson's 8 diagnostic signs. |

**Comparison Baselines Directly Verified (Read-Only):**
- `D:\Omnia` (`22_omnia_current_baseline.md` at `HEAD = 1c9342c`: 17 crates / 196 `.rs` files / 187,308 LOC + 11 Zero-Nerf invariants `Z-01..Z-11`, plus direct reads of `omnia-media-capture/src/{lib,desktop_isolation,input_diagnostics}.rs`, `omnia-harness/src/{deep_think,skill_registry}.rs`, `omnia-agent/src/dap.rs`, `tools/omnia-skill-parity/validate_skills.py`, `.agents/skills/omni-*/SKILL.md` & `scripts/{skill_router,verify_pack}.py`, `tools/omnia-consolidated-audit/audit.py`, `D:\OmniaData\research\omnia-clean-2026-11-12\omni-deep-1000-catalog.json`).
- `C:\Users\khang\.gemini\antigravity\scratch\agy-fast` & `C:\Users\khang\.gemini\config`: direct structure inventory + `read_file` of `docs/V018_DEEP_AUDIT_AND_BLUEPRINT.md`, `hooks.json`, `skills/deep-think/SKILL.md`, and `native/src/{guard,mcp,omni_skills,research_vault,semantic_router,super_engine}.rs`.

---

## 2. Harness Ranking Insights & Competitive Feature Matrix (`Xếp Hạng Desktop Agent Harness.md` + 4 Charts)

### 2.1 Macro Architecture: Two-Layer Split & Causal Harness Gains
As illustrated in **`harness_image1.png`**, the late-2026 SOTA ecosystem decoupled cleanly into two interoperable layers bridged by **ACP (Agent Client Protocol)**, **MCP (Model Context Protocol)**, and **`AGENTS.md` / `SKILL.md`**:
- **Layer 1 — Desktop Control Plane (ADE)**: Git worktrees & diffs, Browser DOM & CDP, OS Computer Use, Kanban & mobile remote sync (`Orca`, `Cursor 3`, `JetBrains Air`, `Pragma`, `EvoFlux`).
- **Layer 2 — Core Agent Harness**: Hashline & AST edit, LSP + DAP Debugger, Model Roles & Advisor, Code Mode & Lifecycle Hooks (`Oh My Pi`, `Claude Code`, `Codex`, `OpenCode`, `Factory Droid`).
- **Infrastructure Tier**: OS Sandbox / MicroVM / Cloud VM + Frontier & Local LLMs.

Empirical controlled benchmarks (**`harness_image2.png`**) prove that harness mechanics alone multiply accuracy up to **>10×** and shift cost Pareto frontiers by **13.6×** while holding the underlying LLM constant:
- **Hashline edit format** (`Grok Code Fast 1`, Can Bölük / Aden Hive): **`6.7%` -> `68.3%`** (`+61.6 pp`, >10× gain).
- **Overall Scaffold Design** (Princeton `CORE-Bench`, same LLM): **`42.0%` -> `78.0%`** (`+36.0 pp`).
- **Pruning 80% Redundant Tools** (Vercel experiment, same LLM): **`80.0%` -> `100.0%`** (`+20.0 pp`, cutting tool-schema ambiguity and latency).
- **Persistent Memory Layer** (`Claude Opus 4.5`, `Claude Code` -> `Letta`): **`41.6%` -> `59.1%`** (`+17.5 pp`).
- **Self-Verify Loop + Reasoning Sandwich** (`gpt-5.2-codex`, LangChain `Terminal-Bench 2.0`): **`52.8%` -> `66.5%`** (`+13.7 pp`, reaching top scores by alternating `xhigh` planning -> `medium` execution -> `xhigh` final verification).
- **Pareto Cost vs Capability (`Artificial Analysis Coding Agent Index v1.5`, Oct 2026)**:
  - **Best Cost Efficiency (`13.6×` cheaper)**: `Codex + GPT-6.1 Sol (xhigh)` achieves **`63` pts at `$1.04/task`** (vs **`Claude Code + Sonnet 5.5 (max)`** ceiling at **`68` pts at `$14.19/task`**; `GPT-6.1 Sol (med)` sits ~`61` pts at ~`$0.70`, `DeepSeek V4 Flash` ~`39` pts at ~`$0.08`, `Haiku 5.5 (low)` ~`28` pts at ~`$0.14`, `Opus 5.5 (max)` ~`66` pts at ~`$13.00`, `GLM-5.3` [OpenCode] ~`54` pts at ~`$4.30`).
- **Benchmark Saturation vs Long-Horizon Reality**: `SWE-bench Verified` is saturated (`77–81%` across top tools and `44.9–54.7%` memorization leakage), pushing SOTA evals toward `Terminal-Bench 4.0` (`85.2%` with `OpenCode` + `Claude Opus 4.6` vs `66.7%` vanilla), **`SWE-Marathon v1.1`** (multi-day horizon tasks where top agents score `< 22%`), **`Vibe Code Bench v1.1`** (`Claude Code + Opus 4.6` leads at `61.9%`), **`CUA-bench` / `Robo-bench`**, and **`arXiv:2607.22585`** demonstrating `17.64% -> 39.22%` improvement from closed-loop verification harnesses.

### 2.2 AI Power Index Leaderboard (`harness_image3.png` + 36-Config Dataset)
Evaluated equally across 4 pillars (`P1`: Context & Code Intel `25`, `P2`: Self-Verification `25`, `P3`: Multi-Agent & Harness `25`, `P4`: Isolation & Extensibility `25` = `100`):

| Rank Tier | App / Stack | Type | P1 | P2 | P3 | P4 | Total | Key Technical Differentiator / Risk |
|---:|---|---|---:|---:|---:|---:|---:|---|
| 1 | **Orca + Oh My Pi + Claude/Codex** | Hybrid | 24.5 | 24.5 | 25.0 | 25.0 | **99.0** | Worktree control plane + Git/GitHub PR/Diff/Terminal + OMP Core (`28` DAP actions, `omp-iso` CoW) |
| 2 | **JetBrains Air + OMP/Claude/Codex** | Hybrid | 25.0 | 23.0 | 24.5 | 24.5 | **97.0** | PSI semantic IDE context + `docker/k8s` isolation + ACP core harness |
| 3 | **K-code + Oh My Pi (OMP)** | Hybrid | 24.5 | 24.0 | 25.0 | 22.0 | **95.5** | Lightweight worktree shell + OMP Core |
| 4 | **Pragma (Tauri) + OMP/Codex** | Hybrid | 24.5 | 22.5 | 24.5 | 24.0 | **95.5** | Tauri2+Rust lightweight multi-agent shell + OMP/Codex |
| 5 | **Fletch (MicroVM) + Claude/Codex** | Hybrid | 24.0 | 22.0 | 24.5 | 24.5 | **95.0** | Lightweight MicroVM sandbox + YAML test gate + PR broker + ACP |
| 6 | **Oh My Pi (`omp`) v19.1** | Core Harness | 24.5 | 23.5 | 25.0 | 21.0 | **94.0** | **28 DAP actions**, Hashline v2, LSP across 11 langs, CoW `omp-iso`, Advisor/Roles, PTC, TUI+ACP |
| 7 | **Zed (GPUI) + Oh My Pi + Codex** | Hybrid | 25.0 | 22.5 | 24.0 | 21.5 | **93.0** | Native GPU Rust editor (`241 MB`, `178 ms`) + OMP/Codex ACP backend |
| 8 | **Factory Droid (App + Missions)** | Standalone | 22.0 | 18.5 | 24.5 | 23.0 | **88.0** | Autonomous Missions, multi-provider, BYOK, Windows-native bridge |
| 9 | **Orca (`stablyai/orca`)** | Standalone | 18.0 | 21.0 | 22.0 | 25.0 | **86.0** | Pure ADE control plane: 10/10 browser/CDP/Annotate, mobile sync, worktrees, ACP host |
| 10 | **Cursor 3 (Agents Window + IDE)** | Standalone | 21.0 | 21.0 | 22.0 | 21.0 | **85.0** | Multi-agent window, sub-500ms instant diffs, UI Design Mode, **heavyweight Electron (`5,040 MB` peak)**, cloud proxy lock-in |
| 11 | **EvoFlux (`evo-harness`)** | Standalone | 19.5 | 21.0 | 20.0 | 23.0 | **83.5** | **Tauri 2 + Rust**, per-session headless engine, **floating browser tabs**, **Windows-first UI verification** |
| 12 | **OpenAI Codex (ChatGPT Desktop)** | Standalone | 19.0 | 21.5 | 21.0 | 21.5 | **83.0** | Built-in Browser+Annotate, Automations, Review+Worktree; Windows sandbox friction + OAI ecosystem skew |
| 13 | **Claude Desktop (Code & Cowork)** | Standalone | 20.5 | 21.0 | 20.5 | 19.5 | **81.5** | `/ultrareview`, Computer Use, Local VM, MCP Apps; weaker LSP/DAP & Windows VM quirks |
| 14 | **Devin Desktop (ex-Windsurf)** | Standalone | 20.5 | 19.0 | 20.0 | 21.0 | **80.5** | Cascade deep-context, SWE-1.5 fast loops, cloud/local hybrid after Cognition merger |
| 15 | **OpenHands Agent Canvas** | Standalone | 19.0 | 17.0 | 20.0 | 24.5 | **80.5** | Strong containerized sandbox isolation (`24.5` P4) |
| 16–27 | Copilot (`79.5`), Augment Intent (`79.5`), Air standalone (`79.0`), Antigravity 2.0 (`78.5`), Fletch (`78.5`), Hermes Desktop (`78.5`), Warp+Oz (`77.5`), OpenCode v2 (`75.5`), Traycer (`75.5`), K-code (`73.5`), Pragma (`71.5`), Zed ACP (`64.5`) | Standalone | — | — | — | — | 64.5–79.5 | Specialized strengths: **Traycer** (strict Builder-vs-Evaluator separation), **Hermes** (closed-loop skill synthesis + `MEMORY.md` + FTS5), **AWS Kiro** (in 36-item full table: **EARS spec-driven** + property-based tests + **8 lifecycle hooks**), **Cline + Kanban** (`node_modules`/`target` worktree symlinking), **Aider** (RepoMap PageRank + architect/editor split) |

**Graveyard & Anti-Pattern Lessons (9 Deprecated/Risky Tools):**
- **Emdash** (YC W26 — *critical security warning*): Auto-executed untrusted repository `setup`/worktree scripts & insecure local telemetry; Omnia MUST never auto-execute untrusted repo scripts outside explicit policy/YOLO user intent or silently phone home.
- **Continue / Void / PearAI / Supermaven / Sweep Desktop / Devin-Windsurf overlap casualties**: Fragmented forks without an open ACP/MCP protocol or deep execution loop failed to match native harnesses.
- **Cursor 3 Lock-In & Electron Bloat (`harness_image4.png`, Hyperlane IDE Benchmark, Apple M5 Max, 2,500-module TS repo, Aug 2026)**:
  - **Zed (Native Rust + GPUI)**: **`241 MB`** steady RSS, **`178 ms`** cold start (`1.0×`).
  - **Hyperlane v2026.08.7 (Optimized Electron)**: `2,095 MB` steady / `2,240 MB` peak (`9` procs, `1.8%` idle CPU), `496.5 ms` (`2.8×`).
  - **VS Code 1.133.0 (Electron)**: `2,779 MB` steady / `3,232 MB` peak (`13` procs, `0.3%` idle CPU), `693 ms` (`3.9×`).
  - **Antigravity v1.107.0 (Electron)**: `3,339 MB` steady / `3,785 MB` peak (`18` procs, **`33.4%` idle CPU!**), `1,617 ms` (`9.1×`).
  - **Cursor 3 v3.9.16 (Electron)**: `4,496 MB` steady / **`5,040 MB` peak (`25` procs, `5.2%` idle CPU = `18.7×` Zed RAM!)**, `2,407 ms` (`13.5×`).
- **Windows / WSL2 & Token Economics Rules**:
  - *"Parallelize Last"*: Do NOT spin up 4–5 parallel subagents unless subtasks are truly independent — multi-agent coordination burns **`3.75×–15×` tokens** cleanly if used blindly. Reserve swarm meshes for disjoint deliverables + independent verification!
  - Windows caveats: WSL2 filesystem bridge breaks perf if repo lives on `/mnt/c/`; Cursor/Codex Windows extensions lag macOS sandboxing -> Tauri2 / Pure-Rust native shells (`EvoFlux`, `Pragma`, **`Omnia`**) win on Windows RAM/latency & BYOK freedom (`$0.25/1M` / local endpoints).

---

## 3. Windows I/O, Focus Isolation, Sovereignty & AI Agent Liberation (`Lựa Chọn Rust Hay C++ Cho App.pdf`, 248 Pages)

### 3.1 Three-Tier Focus Isolation, Zero-Leak Automation & Fixing Codex Chrome Failures (pp. 1–6)
1. **3-Tier Focus & Session Isolation**:
   - *Tier 1*: In-process hook (`omnia_focus_shim.dll` + shared-memory ring buffer) intercepts focus/foreground queries — **NOT sufficient alone** because of **5 fatal flaws**: (a) PPL / anti-cheat blocks DLL injection, (b) `RawInput`/`DirectInput` bypasses Win32 messages, (c) Defender/EDR/ACG flags unsigned DLL injection, (d) multi-process Chromium isolates `RenderWidgetHostHWND` from browser UI HWND, (e) global hotkeys & audio focus leak across processes.
   - *Tier 2*: **Isolated Loopback Desktop Session / Window Station** (`CreateDesktopW` / `CreateProcessW` on hidden desktop + offscreen rendering) — **zero physical cursor/keyboard hijack (`SendInput` & global clipboard banned!)**, substituting UIA `ValuePattern.SetValue`, `WM_CHAR`, `IDataObject` + `IDropTarget::Drop`, and loopback **CDP / WebDriver BiDi**.
   - *Tier 3*: **Lightweight Micro-VM / Windows Sandbox with GPU-PV** for strict untrusted workloads.
   - **Hard-Lock Guardrail**: `CurrentDesktop == UserActiveDesktop` checks prevent background agents from ever hijacking user focus.
2. **Diagnosing & Fixing Codex's Chrome Computer-Use Failure**:
   - Codex's Windows Chrome `computer_use` safety gate failed when trying to verify the active URL via `IUIAutomation` (stalling on Chromium UIA tree stalls/missing extension).
   - **Solution — Multi-Source Non-Blocking URL Resolver**: Fuse non-blocking UIA/Window Title + `--remote-debugging-pipe` CDP `/json/list` + bounded GPU/fast OCR fallback on address bar + `RenderWidgetHostHWND` routing — never hang the agent on synchronous cross-process UIA queries.

### 3.2 `omnia-input-calibrator`, `omnia-pointer-calibrator` & Frozen 20-Subsystem Universal I/O Matrix (pp. 7–49)
The specification expands iteratively (`6` -> `14` -> `17` -> **`20` Universal I/O Subsystems (`Frozen Spec v1.0`)**):
- **Vietnamese Input & Typing Calibrator (`omnia-input-calibrator`)**: Recovers unconverted Telex/VNI text, scores QWERTY physical key Euclidean slip distance (`1u` pitch) + Damerau-Levenshtein transposition, handles Gen-Z Vietnamese shorthand with context disambiguation, runs a **5-point key calibration profile**, and applies deterministic hardware filters: **Matrix De-ghosting** (`Δt < 15 ms`), **Dead-Zone Heatmap**, **Velocity Filter** (`Δt < 25 ms`), **Per-Key Debounce** (`< 40 ms`), **Omni-Pangram + 7-test suite**, full `104/108`-key + Win11 Copilot key + NKRO + OEM `0x0C` Fn/Media keys + 5-group multi-key chord matrix + Sticky-Modifier unlocker / Broken-Chord remap / Phantom Media-Key blocker.
- **20 Universal I/O Subsystems Summary (`Frozen Spec v1.0`)**:
  1. **Precision Mouse & Switch Forensics**: Debounce (`0–150 ms`), Drag-Drop Continuity Bridge (`< 35 ms`), Encoder Reverse Glitch filter (`< 80 ms`), One-Euro / Kalman pointer smoothing, 24+ MMO buttons, HyperShift/G-Shift, 4-way tilt, SmartShift free-spin, 8-way Actions Ring, Super Drag, **16 Edge Mouse Gestures** (`21` actions + per-site exclusions).
  2. **Precision Touchpad & Force-Pad**: ClickPad / Force-Pad (`HID 0x0E` 12 haptic waveforms, `0x40` threshold, hysteresis), TrackPoint / NumberPad modes, **Side-Region Edge Scroll** (Left/Right/Bottom/Dual, `1.5–30 mm` / `3–35%`, **Cursor Lock**, **Chiral Scroll**, **Edge Motion**), Windows 11 Precision Touchpad Registry (`HKCU\...\PrecisionTouchPad`: `Curtains`, `Implicit Curtains`, `Super Curtains` in Himetric, `ClickForceSensitivity`, `AAPDisabled`, `FlipFlopWheel`, `EnableCursorSuppression = 0`, `MouseDataQueueSize`).
  3. **Elevated UIPI Broker & I2C Power Fix**: `uiAccess` / elevated UIPI diagnostics boundary and `I2C HID` sleep-lag fix (`EnhancedPowerManagementEnabled = 0`).
  4. **Low-Level Keyboard & QMK/VIA**: `ScanCode Set 1/2 E0/E1`, QMK/VIA raw HID (`0xFF60:0x61`), Mod-Tap, Flow Tap, Autoshift, Caps Word.
  5. **Touchscreens (`25-pt LinearityData`)**: Capacitive, IR, Resistive, SAW calibration & jitter suppression.
  6. **Hall Effect / Analog Keyboards**: Per-key Actuation Point, Rapid Trigger (RT), Dynamic Keystroke (DKS), SOCD cleaning.
  7. **HID Lighting & Dial**: `HID LampArray (0x59)`, `RadialController` Surface Dial integration.
  8. **Stylus & Graphics Tablets (`6` Protocols)**: EMR, MPP, AES, USI, Apple Pencil Pro, Passive; `EDID` `MapInputRectToMonitor`, parallax offset, `OpenTabletDriver` DSP filter pipeline, `WinTab32.dll`, `CreateSyntheticPointerDevice`.
  9. **Virtual HID & High-Polling Subsystems**: `vhf.sys` (Virtual HID Framework), `GameInput DMA`, `MMCSS` `0.5 ms` timer alignment, `BLE HOGP` `7.5 ms` interval, `HID Battery 0x85`, `HID Heat Map 0x0D`.
  10. **Display / Audio / Video / Sensors / Security / Bus / Compute I/O (`10–20`)**: Display `DDC/CI` + `IddCx` (Indirect Display Driver) + `DXGI Desktop Duplication` (with hardware pointer shape); `WASAPI Process Loopback` + `MIDI 2.0 UMP`; `MediaFrameReader` + `MFCreateVirtualCamera`; `HID Sensors 0x20` + `FIDO2 0xF1D0`; `GameInput` / `OpenXR`; `USB-C PD` / `ACPI`; `IOCP` / `io_uring` / `WPD` / `MTP`; `Shared Memory` / `QUIC` / `TPM2`; `Winsock RIO` / `XDP`; `DirectML` / `DriverKit` / `AIDL HAL`; `ETW USB-UCX` / `UEFI NVRAM`.

### 3.3 Full Capture–Control–Access Matrix & Safe Boundary vs Omnia (`desktop_isolation.rs`) (pp. 62–82)
The PDF designs a 6/7-Tier Sovereignty stack (spanning Windows 11 `24H2–26H1`, Android `15–17`, iPadOS `18/26`, macOS, and out-of-band hardware `UVC HDMI` + `RP2040/ESP32-S3` + `SWD/JTAG/Intel DCI`) and includes concrete Rust code (`p. 80–82`) for:
- `InputDeadmanSwitch` (heartbeat monitor forcing 1:1 passthrough after `250 ms` timeout so input filters NEVER lock up the user's keyboard/mouse).
- `ZeroCopyRingHeader` (`#[repr(C, align(64))]`, `MAGIC = 0x4F4D_4E49_415F_494F`, lock-free shared-memory indices + `dropped_packets`).
- `elevate_runtime_privileges()` + `enable_privilege("SeDebugPrivilege" / "SeTakeOwnershipPrivilege")` + `uiAccess` check.

> **CRITICAL ARCHITECTURE GUARDRAIL (Verified Against `D:\Omnia\rust\omnia-media-capture\src\desktop_isolation.rs`):**
> Omnia ALREADY audited this territory and deliberately encoded a strict boundary in `DesktopCapabilityMatrix::windows_11_truthful_default()`:
> - **`DocumentedUserMode` (PERMITTED)**: `IVirtualDesktopManager` (same-process), `Windows.Graphics.Capture`, `WASAPI Process Loopback`, `ConPTY`, `CDP / WebDriver BiDi`.
> - **`OutOfScope`**: Cross-desktop global `SetCursorPos`/`SendInput` cursor stealing.
> - **`Forbidden` (NEVER PORT TO OMNIA)**: `SeTcbPrivilege` elevation, `uiAccess=true` spoofing / UIPI bypass, unsigned kernel driver injection / DSE bypass, DRM/`WDA_EXCLUDEFROMCAPTURE`/`FLAG_SECURE` bypass, and foreign-process `Winlogon` token duplication / stealth global DLL API hooking (`omnia_focus_shim.dll`).
> **Safe Adoption Rule**: Adopt ONLY documented user-mode runtime capabilities (`WASAPI Process Loopback`, `Windows.Graphics.Capture`, read-only HID/Registry telemetry collectors, `ConPTY`, `CDP/BiDi`, and `InputDeadmanSwitch` `250 ms` failsafe on any local user-opted input helper) while discarding all `Forbidden` elevation/hook concepts!

### 3.4 AI Agent + Harness + Model Liberation & Brutal 6-Point Self-Audit Postmortem (pp. 82–248)
The second half of the PDF designs an autonomous coding harness and then **audits and corrects its own hallucinations and design errors across pp. 166–248** — producing gold-standard architectural rules:
1. **Verified Cloud API Realities (p. 166)**:
   - Claude 4.6/5.x **removed assistant message prefill** (`400 invalid_request_error`) and deprecated `thinking.budget_tokens` (must use `adaptive` + `tool_choice: "auto"` without conflicting `temperature`).
   - Client harnesses CANNOT inject XGrammar-2 token masks or run model abliteration on remote cloud APIs.
   - `strict: true` JSON schemas still allow model `refusal` and reject regex `pattern`, `minLength`, `minimum`/`maximum`, and `format`.
2. **Anti-Sandbagging Without Gagging ReAct Reasoning (pp. 172–229)**:
   - Forcing `tool_choice: "required"` breaks ReAct `Reason` steps (driving Performative Compliance / underground sandbagging and colliding with Claude adaptive thinking). **Solution**: keep `tool_choice: "auto"` + explicit `<ephemeral_tail_directive>` + **Canonical API/WDK/W3C Alias Table** + **Semantic Decoupling**.
   - Locking `rm`/`mv`/line-shrink broke `Full Control`. **Solution**: full shell/refactor freedom backed by **Git Shadow Index** (`GIT_INDEX_FILE=.git/omnia_shadow.idx` + `.git/omnia_shadow_info/exclude` filtering `target/`/`node_modules/` so `.git/index` is NEVER clobbered and rollbacks take `< 15 ms`!).
   - **Pre-Code Live Symbol Grounding (`<verified_api_grounding>`)** + **`Intent-Derived Oracle Tests` (`SPEC_ECHO`)** + **Intent-Aligned Diff Auditor** (verify deleted lines match user intent, not silent truncation).
3. **6 Brutal Final Self-Audit Corrections (pp. 232–248 — MUST ENFORCE!)**:
   - *(1) Zero Fabricated Benchmarks*: Earlier "Hydrogen/Carbon" percentages (`12x`, `79%`, `57%`, `<0.4%`, `88.2%`) in the chat were hallucinated -> never cite unverified speedup ratios; measure empirically.
   - *(2) Honest Proxy Routing (`htmustc`)*: Never assume Gemini bypasses `/v1/chat/completions` to native `v1beta` with `systemInstruction` or invent unverified `thoughtSignature`/`reasoning_effort` internals when routing through an OpenAI-compatible proxy (`400` errors!).
   - *(3) Never Demand `100%` Mutation Kill Rate*: Equivalent mutants cause infinite hangs & catastrophic compile time; target focused behavioral + differential oracles instead.
   - *(4) Never Keyword-Abort `thinking` SSE Streams*: Killing SSE whenever `thinking` contains `"instead of"`, `"simpler"`, or `"alternative"` destroys `> 50%` of legitimate engineering tradeoff reasoning.
   - *(5) Never Lock Pre-Written `.rs` Test Files Before Implementation*: Locking `.rs` tests breaks compilation when signatures evolve -> lock **JSON behavioral truth-table fixtures (`tests/fixtures/*.json`) + black-box CLI/API behavior scripts** instead, and NEVER inject `compile_error!()` into live files; remember Tree-sitter CST cannot replace `rustc`/`cargo` for Rust CFG/reachability.
   - *(6) Real AN515-55 Hardware (`GTX 1650/Ti 4GB VRAM`) & Clean Proxy Path*: Never offload an `8B` (`5.03 GB`) local model alongside Win11 DWM+WebView2 (`0.8–1.2 GB`) — stick strictly to **`3B–4B` (`Q4_K_M` `2.1–2.5 GB`) under `VRAM Semaphore = 1`**, and NEVER insert BARTpho/ViT5 (`512–1024` tok) or a `4B` VN diacritic restorer into coding proxy paths! Plus add **Anti-Helplessness History Pruning** (collapse repeated compiler error retries after 2 identical failures while preserving 1 concrete diagnostic anchor).

---

## 4. Omnia Startup, Governance & 1,000-Skill 4-Layer Vault (`Khởi động và Quy trình Omnia.pdf`, 98 Pages)

1. **7-File Startup Reading Chain & 7-Group Repo Taxonomy (pp. 1–6)**:
   - Canonical boot chain: `SESSION_ADMISSION` -> `README` -> `AGENTS` -> `GOAL` -> `DOD` -> `CHECKPOINT` -> `COMPOSER_REQUIREMENTS`.
   - 7 artifact groups: (1) Agent/Session/Handoff contracts, (2) Goal/Spec/Plan/Task contracts, (3) Evidence/Verification/Audit ledgers, (4) Architecture/Module specs, (5) UI/Composer contracts, (6) Environment/Storage/Cleanup ledgers, (7) Research/Refs/Decisions/Prompt logs.
2. **1,000-Skill / 100-Category Architecture (`3,000` Files) & Arithmetic Correction (pp. 6–88)**:
   - Each skill has 3 standardized files: `SKILL.md` (strict 5-phase template: `Preflight` -> `Design & Constraints` -> `Execution` -> `Deterministic Verification` -> `Receipt & Handoff`), `references/invariants.md`, `references/receipt.template.md`.
   - **Self-Corrected Arithmetic (p. 85)**: Although p. 16 described Categories 1–24 as "250 skills", exact summation proves `bootstrap_deep_skills.py` generated **`249`** skills; adding Part 1 (Cats 25–38: `148`), Part 2 (Cats 39–54: `167`), Part 3 (Cats 55–72: `185`), Part 4 (Cats 73–90: `180`), and Cats 91–100 (`71` skills = `9×7 + 8`, incl. `deep-omni-*` self-evolution & `SKILL_LOCK.json`) hits **`249 + 148 + 167 + 185 + 180 + 71 = 1,000` skills (`3,000` files)** across `100` domains (frontier RLVR, CP/Olympiad, CS proofs, quant/accounting, medicine, culinary/high-hydration baking, PCB/FPGA, robotics, DFIR, OS/kernel, PQC/quantum, Vietnamese heritage, `deep-meta-*` calibration, nuclear/fusion, ZK/Web3, VMs/JITs/fonts, VN NLP/ASR/TTS, `deep-omni-*`).
3. **4-Layer Zero-Bloat Runtime Architecture (pp. 65–98)**:
   - **Layer 1 — Zero-Bloat Vault + NTFS Junctions**: Only `<= 12` core skills stay hot-mounted (`< 1,000` startup tokens); remaining 1,000 skills live in cold storage (`omni-vault` / JSON catalog) and mount on-demand without polluting context.
   - **Layer 2 — Bilingual Router (`omni_router.py`) + Lightweight MCP Bridge (`omni_mcp_server.py`) + `omni_doctor.py`**: Pure-stdlib VN-EN BM25 (`< 8 ms`) + 4-stage DAG (`Preflight -> Domain -> Verify -> Receipt`) + 3-tool MCP stdio JSON-RPC server hard-capped under `15,500` chars (`~4.5k` tokens).
   - **Layer 3 — Deterministic Phase-3 Verifier Suite (`omni_verifiers.py`, 6 Subcommands)**: `preservation` (SHA-256, `mtime_ns`, CRLF/LF, trailing spaces), `contrast` (WCAG 2.1 luminance `4.5:1` / `3.0:1` / `7.0:1`), `bakers` (DDT `3 * DDT - Room - Flour - Friction`), `tokens` (5k truncation chunk planner), `secrets` (`AKIA`/`sk-`/`AIza`/`gh[pousr]_`/PEM/userinfo regexes), and **`cp-stress`** (auto-compiles C++20 `gen.cpp`, `brute.cpp`, `sol.cpp` with `-std=c++20 -O2 -Wall` and runs randomized differential stress testing for `N` iterations, returning exact failing counterexamples!).
   - **Layer 4 — 24 Pre-Wired Pipelines (`omni_pipelines.py`) & Attestation (`omni_upgrade_1000.py`)**: 24 flagship multi-skill DAG workflows + cryptographic Merkle-style **`SKILL_LOCK.json`** + **16-case VN/EN Golden Routing Benchmark**.

---

## 5. Mathematical Surveys, Formal-Verification Soundness & Epistemic Hygiene (`Collatz` 31p + `P vs NP` 35p)

### 5.1 Collatz Conjecture State of the Art (`Collatz Conjecture Mathematical Analysis.pdf`, 31p, 149 Citations)
- **Dynamics & Computational Frontiers**: Standard `C(n)`, shortcut `T(n)`, Syracuse `Syr(n)`; Lagarias-Weiss (1992) Cramér model (`mean ≈ 6.95212 ln n` shortcut / `10.42818 ln n` std, ceiling `γ_RW ≈ 41.677647`, peak exponent `2.0`); Path Record `#98` (`2026`, Robert Göransson `n = 2,745,951,154,258,759,552,159`, `log t_T / log n = 1.9532`); **Bařina GPU verification (`2^71` Jan 2025 -> `2075 × 2^60 ≈ 2.39 × 10^21` Nov 2026, `1,335×` speedup)**; **Angeltveit (`arXiv:2602.10466`)** recursive low-bit-first tree search (`45–50×` fewer survivors, `2^75` feasible); **Hercher (June 14, 2026 corrigendum)** excluding non-trivial cycles `< 137,528,045,312` odd terms (`>= 355,504,839,929` total steps, `m >= 92` local minima).
- **Lean 4 Unaudited Preprints & 6 Structural Lenses**: Allikvere (Jul 2026), Mazur (Jul/Sept 2026 `61,169` lines `sorry`-free), Kenny Lau/Axiom (Oct 2026 density `|N/2^{2^163}|` odd `< N`), Alick (`m <= 101`) — ALL remain unrefereed/pending audit. Structural obstructions across `Z_2` 2-adic conjugacy, Fatou/Julia wandering domains, Hardy/Fréchet spaces, inverse trees/Christoffel words (`T_rot` & `mod 32`), `F_2[x]` (carry-free solvable) vs `5n+1`/`Z^-`, Conway `Π_2^0`-completeness (`BB(5)=47,176,870` Coq Jul 2024 vs `BB(6)` Antihydra `608` holdouts).

### 5.2 P vs NP State of the Art (`The P Versus NP Problem.pdf`, 35p, 158 Citations)
- **Foundations, Constructive Split & Worlds**: CMI `$1M` prize (`Unsolved`, 2-year peer-review wait); Cook-Levin / Karp-21 / Ladner `NPI` / Nash 1955 / Gödel 1956; Constructive Scenario A vs Non-Constructive/Galactic Scenario B (Robertson-Seymour, AKS, Coppersmith-Winograd; Aaronson Nov 2026 `4%` `P=NP` split `2%` vs `2%`); Impagliazzo's Five Worlds + Obfustopia + Optiland + Meta-Complexity (`MCSP`, `K^t`, Hirahara, Liu-Pass `pKt`, Kabanets-Kolokolova STOC 2026).
- **Barriers, Peer-Reviewed 2024–2026 Breakthroughs & Autumn 2026 Preprints**:
  - *Barriers*: Relativization (1975), Natural Proofs (1994/97), Algebrization (2008/09, tightened by Chen-Hu-Ren Nov 2025), Bounded Arithmetic `S_2^1` / `Π_2` independence.
  - *Peer-Reviewed Advances*: Cook-Mertz STOC 2024 (`TreeEval` `O(log n log log n)` space) -> **Ryan Williams (2025/2026)**: `TIME[t] ⊆ SPACE[sqrt(t log t)]`; **Chen-Tal-Wang (STOC 2026)** `n^{2.5-ε}` `THR∘THR` lower bound; IPS/PIT Proof Complexity (STOC 2026).
  - *Unrefereed Autumn 2026 AI-Lean Preprints*: Oct 26–27 ETH refutation (`2^{O(n (log log n)^2 / log n)}` — crossover `> 10^{10,000}` variables, completely galactic!), Nov 23 `VP ≠ VNP` (`exp(Ω((log n)^{4/3}))` — algebraic only, does NOT yield `P ≠ NP` or `#P ⊈ NC^2/poly`), Oct 6 UGC, Nov 6 Aaronson-Ambainis `t-query`.
  - *Applied Solvers & Quantum Limits*: CDCL (`Kissat`, `CaDiCaL-SC2025`, AWS Zelkova `1B` SMT queries/day), MILP (`~1,000×` controlled / `~20B ×` 1989–2024 vs polyhedral bounds), FPT (`1.25284^k`), and `BQP` limits (BBBV `Ω(2^{n/2})`, Forrelation, DQI TQC 2026 Parekh linear-girth boundary).

### 5.3 Critical Epistemic & Formal-Verification Rules for AI Harnesses
1. **`CollatzLean` Dual-Bug Kernel Soundness Incident (`CVE-2026-72844`, July 25–28, 2026, Lean `#14576`/`PR #14577`)**: A dual kernel-bug alignment allowed invalid proofs to pass **both** official Lean 4 AND a stale `nanoda` checker.
2. **Arthanari Lean 4 Gap (`yudin_nemirovski`, June 2026) & `ccchallenge.org` Axiom Smuggling (`2^ω > 3^n`)**: *"Lean checks the proofs, but no machine checks that this file says what the paper says."* Machine-checked proofs regularly hide unproved custom `axiom`s, mismatched theorem statements, or syntactic exploits.
3. **Mandatory Harness & `DeepThinkEngine` Guardrails**:
   - Require **Axiom Footprint Auditing** (whitelist ONLY standard foundational axioms e.g. `propExt`, `classical.choice`, `quot.sound`; hard-fail custom `axiom`s and `sorry`/`admit`).
   - Require **Multi-Kernel Independent Replay** (re-verify proofs across independent checkers e.g. Lean Kernel Arena / updated `nanoda` / `con-leche`) + **Human/Cross-Model Statement-Fidelity Audit**.
   - Enforce **3-Bucket Epistemic Separation**: `(1) Peer-Reviewed Refereed Result` vs `(2) AI/Unrefereed Preprint Pending Audit` vs `(3) Refuted / Kernel-Exploit / Galactic-Crossover (`> 10^{10,000}`)`.
   - Embed **Scott Aaronson's 8 Diagnostic Signs** (e.g., failing to confront known barriers, skipping toy/bounded tests, unclear/swapping definitions, non-uniform/galactic crossover masquerading as practical poly-time) directly into `DeepThinkEngine` adversarial red-team prompts.

---

## 6. `D:\Omnia` Integration Candidates (Verified Against `1c9342c` & `Z-01..Z-11`)

Every candidate below is strictly additive, non-nerfing (respects all `11` invariants `Z-01..Z-11`: `ApprovalMode::Yolo` default, empty `default_rules()`, `EffortLevel::Max`, `SOLO` default, `token_budget = None`, `EgressPolicy::unrestricted()`, `omnia.exe <= 14 MiB` / `<= 15 ms`, zero `Forbidden` elevation/kernel/DRM hacks):

| # | Already in `D:\Omnia` (`Verified`) | Gap / Upgrade from Shard 06 Sources | Concrete Target in `D:\Omnia` | Priority |
|---|---|---|---|---|
| **O-01** | `omnia-agent` has `edit_file` (Hashline/`imara-diff`), `ast_edit`, `graph_locator`, `dap.rs`, `lsp.rs`, `ptc.rs` | Inspect `dap.rs` (`1,017` LOC) vs OMP's **28 DAP actions** (`evaluate`, `variables`, `setVariable`, `stepBack`, `reverseContinue`, `dataBreakpoints`, `disassemble`, `exceptionInfo`, `modules`, `loadedSources`, etc.) and expose complete DAP workflow in `IdeWorkbench.tsx`; tighten Vercel-style compact tool projection (keep 35 tools wired but lazy-load heavy schemas on demand via `discover_tools` to trim system prompt tokens) | `rust/omnia-agent/src/{dap.rs,tools.rs}`, `ui-v5/src/components/workbenches/IdeWorkbench.tsx` | **P1** |
| **O-02** | `omnia-agent` has `swarm_runtime` git worktrees & `checkpoint.rs` (`/rewind`) | Add **Zero-Clobber Git Shadow Index** (`GIT_INDEX_FILE=.git/omnia_shadow.idx` + `.git/omnia_shadow_info/exclude` skipping `D:\OmniaData`, `target/`, `node_modules/`) for `< 15 ms` whole-workspace rollback even across `rm`/`mv`/build artifacts WITHOUT corrupting `.git/index`; plus **`node_modules`/cache junction/symlink sharing** in worktrees (`Cline Kanban`) and future optional **ProjFS** CoW mode (`omp-iso`) | `rust/omnia-agent/src/{checkpoint.rs,swarm_runtime.rs}` | **P1** |
| **O-03** | `omnia-agent/src/engine.rs` has SSE watchdog, Prefix-0 BLAKE3, `tool_choice: "auto"` | Add **Pre-Code Live Symbol Grounding** (`<verified_api_grounding>` via `lsp_query`/`graph_locator` tail injection, preserving Prefix-0), **Intent-Aligned Diff Auditor** on large deletions, **Anti-Helplessness History Pruning** (collapse repeated identical compile failures after 2 attempts keeping 1 crisp error anchor), and **`SPEC_ECHO` + Locked JSON Behavioral Fixtures (`tests/fixtures/*.json`)** (never lock live `.rs` tests!) | `rust/omnia-agent/src/{engine.rs,cache_guard.rs,trajectory.rs}` | **P1** |
| **O-04** | `omnia-media-capture` ALREADY built `desktop_isolation.rs` (`DesktopCapabilityMatrix` forbidding `SeTcbPrivilege`/UIPI/unsigned drivers/DRM bypass) and `input_diagnostics.rs` (`2,439` LOC pure-Rust evaluators!) | **Gap**: `input_diagnostics.rs` evaluates *passed-in* structs only; `desktop_isolation.rs` catalogs `WASAPI Process Loopback` & `Windows.Graphics.Capture` & `CDP/BiDi` without full live runtime execution! Add **documented user-mode collectors/executors ONLY**: (1) read-only `HKCU\...\PrecisionTouchPad` / HID `0x0D`/`0x0E` / USB polling telemetry collector feeding `input_diagnostics`, (2) **`Windows.Graphics.Capture` + `DXGI` pointer capture** alongside `PrintWindow`, (3) live **`WASAPI Process Loopback`** capture pipe, (4) **Multi-Source Non-Blocking Chrome URL Resolver** (Title + non-blocking UIA + CDP pipe + OCR fallback), (5) **`InputDeadmanSwitch` (250 ms)** & aligned **`ZeroCopyRingHeader`** if local user-opted input helpers run | `rust/omnia-media-capture/src/{window_capture.rs,browser_cdp.rs,input_diagnostics.rs}` + new `wasapi_loopback.rs` / `hid_probe.rs` (zero `Forbidden` APIs!) | **P1** |
| **O-05** | `ui-v5` has `BrowserWorkbench.tsx` + CDP screencast (`browser_cdp.rs`) | Add **EvoFlux floating browser preview** inside `Chat`/`IDE` & **Orca/Codex "Browser Annotate + Live CSS Design Mode"** (click DOM node -> capture selector + computed styles + optional screenshot -> inject into `Composer.tsx` prompt) | `ui-v5/src/components/workbenches/BrowserWorkbench.tsx`, `Composer.tsx`, `rust/omnia-media-capture/src/browser_cdp.rs` | **P1** |
| **O-06** | `omnia-harness` has `DeepThinkEngine` (`deep_think.rs`, 592 LOC) + `ResearchVault` | Integrate **Formal Verification & Epistemic Hygiene Gate** into `DeepThinkEngine`: (1) optional **Axiom Footprint & Proof Replay check** (ban unproved `axiom`/`sorry`, flag single-checker proofs), (2) **3-Bucket Epistemic Tag** (`RefereedTheorem` vs `PendingPreprint` vs `RefutedOrGalactic`), (3) **Aaronson 8-Sign Checklist** embedded in `RedTeamChallenge`, (4) **"Galactic Bound Detector"** flagging huge crossover bounds (`> 10^{10}` or asymptotic-only `VP≠VNP` non-implications) | `rust/omnia-harness/src/deep_think.rs`, `rust/omnia-studio/src/routes_research_lifecycle_v5.rs` | **P1** |
| **O-07** | `omnia-agent` has `recipes.rs`, `hooks.rs` (25 hooks), `SkillRegistry` (`skill_registry.rs`), `verify_pack.py`, `skill_router.py` | Add **AWS Kiro EARS (`WHEN ... SHALL ...`) Spec Gate** in `ArtifactOs` `SPEC.md` validator, **Fletch YAML Deterministic Verification Gate** (`recipes.rs` / `AgentConfig`), **`cp-stress` Differential Stress Verifier** (`gen` vs `brute` vs `sol` in `verify_pack.py`), **4 GB VRAM (`GTX 1650`) strict helper budget rule** (`3B–4B Q4_K_M` max, `VRAM Semaphore = 1`, zero `8B` / BARTpho in proxy path), and **`Hermes` closed-loop skill distillation** (already partially in `/learn` -> wire auto-trigger receipt after tricky solved bugs) | `rust/omnia-harness/src/artifact_os.rs`, `rust/omnia-routing/src/lib.rs`, `.agents/skills/omni-deterministic-verifiers/scripts/verify_pack.py` | **P2** |
| **O-08** | Native Windows RAM/startup footprint (`omnia.exe` `12.39 MiB` / `8.3–10.4 ms`, `omnia-native.exe` `0.37 MiB`) | **Competitive USP Protection**: Highlight & enforce Omnia's `~35 MiB` `omnia-studio` + `WebView2` / Win32 shell memory budget vs Electron competitors (`Cursor 3` `5,040 MB`, `Antigravity` `3,785 MB` / `33.4%` idle CPU) in `ObservabilityView` / `SystemHardwarePanel`, and keep standalone `omnia.exe` lean | `ui-v5/src/components/observability/SystemHardwarePanel.tsx`, `.github/workflows/release.yml` (fix missing `ui-v5` + `--features embed-ui`!) | **P0/P1** |

---

## 7. Antigravity (`agy`) & `agy-fast` Integration Candidates (Verified Against `agy-fast` `native/src/` & `~/.gemini/`)

Directly verified in `C:\Users\khang\.gemini\antigravity\scratch\agy-fast`: `agy-fast` already has a pure-Rust MCP server (`11` tools: `batch_search`, `apply_edits`, `read_slices`, `quick_outline`, `run_checks`, `memory_sync`, `workspace_health`, `research_vault`, `omni_skills`, `super_engine`, `canvas_studio`), 6 lifecycle hooks (`hooks.json`), a 4-stage hybrid dense+BM25F `semantic_router.rs` (`Model2Vec`, `5,356` LOC), `guard.rs` (`7,418` LOC), and `deep-think` skill. High-impact additions from Shard 06:

| # | Target in `agy` / `agy-fast` | Already Present (`Verified`) | Concrete Upgrade Candidate |
|---|---|---|---|
| **A-01** | `agy-fast/skills/deep-think/SKILL.md` + `references/formal-proof-protocols.md` | 5-phase ToT + brute-force differential oracle + red-team prompt | Embed **Formal Proof Anti-Exploit Gate**: (a) Lean/Coq/Isabelle **Axiom Footprint Check** (only `propExt`/`classical.choice`/`quot.sound`), (b) **Multi-Kernel Replay + Statement-Fidelity Audit** (`CollatzLean` `CVE-2026-72844` / `yudin_nemirovski` lesson), (c) **Aaronson's 8 Diagnostic Signs** + **Galactic Bound / Domain-Jump Warning** (`ETH > 10^{10,000}`, `VP≠VNP ↛ P≠NP`) |
| **A-02** | `agy-fast/native/src/tools_checks.rs` & `omni_skills.rs` (`verify`) | `run_checks` shell runner; `omni_skills` has 7 verifiers (`preservation`, `contrast`, `tokens`, `bakers`, `secrets`, `skill-doctor`, `slop`) | Add **`cp-stress` Differential Verifier** (`gen`/`brute`/`sol` randomized stress harness from `Khởi động PDF` p. 91) + **`SPEC_ECHO` Locked JSON Oracle check** (verifying behavioral fixtures instead of locking brittle source test files) + **Semantic Decoupling / Anti-Sandbagging Pre-Code Symbol Grounding** hint in `read_slices` / `quick_outline` |
| **A-03** | `agy-fast/native/src/guard.rs` & `super_engine.rs` & `gitflow.rs` | `guard.rs` lockfile + atomic write, `super_engine` 7 lanes + `snapshot.rs` | Add **Non-Clobber Shadow Git Index (`GIT_INDEX_FILE=.git/agy_shadow.idx` + `.git/omnia_shadow_info/exclude`)** for instant clean rollback without touching user's `.git/index`; add **Parallelize-Last Cost Guard** telemetry (flag spawning `> 2` subagents on non-disjoint slices given `3.75×–15×` token overhead); add **Anti-Helplessness Prompt Pruning** in `/super-run` recovery (`MAX_RETRY_BOUNCE = 2` identical compiler errors -> compact diagnostic state) |
| **A-04** | `agy-fast` + Omnia Interop (`mcp_config.json`, `native/src/mcp.rs`) | Standalone stdio MCP JSON-RPC server (`11` tools, `8,400–8,800 B` cap) | Keep `mcp.rs` strictly lean (`<= 11` well-scoped tools, avoiding the 80% tool-bloat penalty shown by Vercel's `+20.0 pp` benchmark!), add **EARS spec validation** in `super_engine` blueprint phase, and optionally bridge `canvas_studio` / `browser` Playwright CDP `noDefaults: true` attachment to avoid light-mode flashes on live Desktop UI |
| **A-05** | `~/.gemini/GEMINI.md` & `agy-fast/native/src/audit.rs` | Already enforces `ADDITIVE_INTAKE`, `token_budget = NULL`, `Graphify`, `2-way peer mesh`, `ALWAYS_ACCEPT_LEARN` | Add 2 concise durable rules: **(1)** *"Never equate proof-assistant compilation with mathematical/spec truth — audit axioms, statement fidelity, and multi-kernel replay"*; **(2)** *"Never enable repo setup auto-exec (`Emdash` flaw), lock live `.rs` test files pre-impl, abort SSE thinking on alternative keywords, or assign `> 4B` models to `4 GB VRAM` GPUs"* |
| **A-06** | `C:\Users\khang\.gemini\config\plugins\agy-fast` (`semantic_router.rs` + `omni-vault`) | Already mounts `Model2Vec` `.srix` + Cold Vault + 24 DAGs (exceeds PDF's pure-BM25 `omni_router.py`!) | Ensure `omni_upgrade_1000`-style **Merkle `SKILL_LOCK.json`** attestation + **16-case VN/EN Golden Eval** runs automatically in `cargo test` / CI whenever `omni-vault` or `skills-taxonomy.json` changes, preventing silent routing drift |

---

## 8. Hygiene & Verification Receipt for This Report

- **Output Path:** `D:\OmniaData\research\mega-deep-read-20261128\06_downloads_md_pdfs_part2.md`
- **Secret & Credential Redaction:** Verified clean (`0` API keys, `0` tokens, `0` cookies, `0` private session URLs, `0` credentials).
- **Encoding & Formatting:** Pure UTF-8 (no BOM), Unix `LF` (`\n`), zero trailing whitespace, single EOF newline.
- **Unverified / Preserved Boundaries:** Nothing inside `D:\Omnia` or `C:\Users\khang\.gemini` was edited; external source files under `C:\Users\khang\Downloads\Omnia\` remain unmodified.
