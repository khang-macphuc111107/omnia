# Project: Omnia Desktop & Cross-Platform Orchestration

## Architecture
- **Root Repository**: `D:\Omnia\repos\omnia`
- **Application Core**: Tauri 2 (Rust) + React 18 + Vite + TypeScript.
- **Frontend Layer**: `src/agent/*` (AgentShell, CommandPalette, SettingsDialog, ToolRow, TranscriptView), `src/features/workspace/*` (Markdown, WorkspaceView), `src/domain/*`.
- **Native Backend Layer**: `src-tauri/crates/*` (`omnia-harness`, `omnia-browser`, `omnia-computer`, `omnia-download`).
- **IPC & Cross-Session**: Named Pipes (`uds:\\.\pipe\LOCAL\cc-msg-*`) connecting Claude Desktop App, Claude CLI, and Antigravity orchestrators.
- **Dual Session Partitioning**:
  - **Orchestrator 1 (This Session `650bba04`)**: Slices 1, 2, 3 (Frontend Bundle Budget, UI Progressive Disclosure, Gate Verification & Git Consolidation).
  - **Orchestrator 2 (Parallel Session `e581b01d`)**: Slices 4, 5, 6 (Rust Harness, Named Pipe IPC, E2E Verification & Integration Tests).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Bundle Budget Compliance | Reduce `totalJavaScriptBytes` below 5,120,000 B in `scripts/check-bundle-budget.mjs` by replacing micromark in `src/features/workspace/markdown.tsx`, trimming static prose in `src/domain/*`, and preserving `src/labs/labs-app.tsx` dynamic import graph alongside `src/labs/workspace-surface.tsx` | M1 (DONE) | Survey & DeepInvestigator |
| 2 | UI Progressive Disclosure & IA Redesign | Modern minimalist tech UI: `ActivityRail`, `StatusBar`, `HomeStart`, `WorkspaceSurface`, collapsible tree views with `>` and `v` chevrons in `CommandPalette`, persistent `AgentShell` during workspace view switches, and `useNarrowPanelViewport` | M2 (DONE) | Survey & UI Redesign Spec |
| 3 | Verification Gate & Git Consolidation | Pass all static, bundle, Python, Node IPC, Vitest, and Rust gates; commit clean working tree on `omnia/m0-snapshot` with author `khang <SalmanaJoasia@outlook.com>` | M3 (DONE) | Survey & DeepInvestigator |
| 4 | Rust Harness & Native Subsystems | Complete Tauri/Rust integration for browser use, computer use, and downloader (`omnia-browser`, `omnia-computer`, `omnia-download`, `omnia-harness`) | M4 (DONE) | Parallel Session e581b01d |
| 5 | Cross-Session IPC & Multi-Agent Bridge | Hermetic named-pipe bridge (`scripts/cross_session_bridge.py`, `scripts/cross-session-bridge.mjs`) with dynamic discovery, XML CDATA escaping, and zero hardcoded PIDs | M5 (DONE) | Parallel Session e581b01d & Gen 2 |
| 6 | Final E2E Suite & Release Gate | Run and pass 100% of verification suites across Frontend, Python, Node IPC, and Rust native integration tests | M6 (DONE) | Consolidated Verification |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Bundle Budget Reduction | `src/features/workspace/markdown.tsx`, `src/domain/*` prose reduction, `scripts/check-bundle-budget.mjs` validation | none | DONE (total JS: 4,007,234 B / 5,120,000 B, 12/12 dynamic entries, entry 151,176 B / 500,000 B, largest async 214,508 B / 307,200 B) |
| M2 | UI Progressive Disclosure & IA | `src/agent/agent-shell.tsx`, `src/agent/command-palette.tsx`, `src/agent/activity-rail.tsx`, `src/agent/home-start.tsx`, `src/agent/status-bar.tsx`, `src/labs/workspace-surface.tsx` | M1 | DONE (40/40 `src/agent` test files / 420 tests pass; 334/334 `src/features/workspace` test files / 1,907 tests pass; Playwright `shell-host-overflow.spec.ts` 8/8 & `agent-shell-release.spec.ts` 3/3 pass; `ui-overflow-scan.mjs` 0 findings) |
| M3 | Gate Pass & Git Consolidation | Static gates, `tsc -b`, `vite build`, `check:bundle`, Vitest, Python `unittest`, Rust tests, git commit on `omnia/m0-snapshot` | M1, M2 | DONE (All gates passed; consolidated into `615fef3`, `a683081`, `eca017c` on `omnia/m0-snapshot`) |
| M4 | Rust Harness & IPC (Parallel) | `omnia-harness`, `omnia-download`, `omnia_native` (572), `native_harness_tests` (4), `native_subsystem_tests` (17) | none | DONE (640/640 Rust tests pass; `cargo clippy --offline --workspace --all-targets -- -D warnings` 0 warnings/errors; 101/101 Python tests pass) |
| M5 | Multi-Agent Coordination | Hermetic Named Pipe IPC bridge (`scripts/cross_session_bridge.py`, `scripts/cross-session-bridge.mjs`) | none | DONE (Remediation complete: 26/26 Python + 14/14 Node + 14/14 Vitest IPC tests + 5/5 bridge self-tests pass with peer auth/error rejection and zero hardcoded PIDs) |
| M6 | Final E2E Suite & Release Gate | Full verification across Frontend, Python, Node IPC, Playwright Visual/E2E, and Rust native integration tests | M1, M2, M3, M4, M5 | DONE (All suites verified 100% green) |

## Interface Contracts
### `src/features/workspace/markdown.tsx` & `src/agent/agent-shell.tsx` ↔ `scripts/check-bundle-budget.mjs`
- `markdown.tsx` remains a dynamic chunk entry and `src/labs/labs-app.tsx` remains a dynamic entry in `dist/.vite/manifest.json` (preserving all 12 required dynamic entries in `scripts/check-bundle-budget.mjs`).
- Bundle budget: `totalJavaScriptBytes` = 4,007,234 bytes <= 5,120,000 bytes (1,112,766 B headroom).
- Markdown parsing: GFM-compliant parsing, code blocks, tables, bold/italic, links without importing bulky micromark/gfm libraries.

### `src/agent/agent-shell.tsx` ↔ `src/agent/command-palette.tsx` & `src/labs/workspace-surface.tsx`
- Progressive disclosure: Tree view / nested submenus with `>` / `v` chevrons (`More tools & system`, `Session & model settings`) and keyboard ArrowRight/ArrowLeft expand/collapse.
- Persistent mounting: Keep `AgentShell` mounted when switching between `chat`, `code`, `browser`, `library`, and `projects` shell views via `WorkspaceSurface`.
- Viewport adapter: `useNarrowPanelViewport()` handling constrained sidebar widths.

## Code Layout
- Frontend Source: `D:\Omnia\repos\omnia\src\`
  - `src/features/workspace/markdown.tsx`
  - `src/agent/agent-shell.tsx`
  - `src/agent/command-palette.tsx`
  - `src/agent/agent.css`
  - `src/domain/`
- Build Scripts: `D:\Omnia\repos\omnia\scripts/check-bundle-budget.mjs`
- Agent Metadata: `D:\Omnia\.agents\teamwork/`
