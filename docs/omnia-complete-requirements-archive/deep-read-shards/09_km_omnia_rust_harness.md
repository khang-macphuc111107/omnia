# Wave 1 Deep-Read — Shard 09: `khangmacphuc-omnia` Rust Harness (`omnia-harness`)

- **Shard**: `09` (`ui-atelier-pro`, board brief `#410`)
- **Target**: `D:\OmniaData\research\khangmacphuc-omnia\src-tauri\crates\omnia-harness\`
- **Coverage**: **90 / 90 files — 33,273 / 33,273 lines — 1,237,410 / 1,237,410 bytes (100.00% line-by-line, ZERO skipping)**
- **Baselines Compared (Read-Only)**:
  - `D:\Omnia\rust\omnia-harness\` (13 files, 11,340 lines)
  - `D:\Omnia\rust\omnia-agent\` (41 files, 51,898 lines)
  - `C:\Users\khang\.gemini\antigravity\scratch\agy-fast\` (Rust `native/src/` + TS `src/`/`test/` architecture)
- **Zero-Nerf Invariant**: **NEVER** weaken `D:\Omnia`'s Steer #22 default `ApprovalMode::Yolo`, empty `PermissionsEngine::default_rules()`, uncapped `token_budget = NULL`, `omnia-winsqlite` WAL (never `rusqlite`), 17-crate pure Rust workspace, Prefix-0 KV-Cache Guard, Tree-sitter CST/Hashline v2/LocAgent/Lakeview/MCP `2026-07-28`/PeerMeshGraph capabilities. Absorb **ONLY** strictly additive or superior engineering mechanisms.

---

## 1. Executive Summary & Architectural Contrast

`khangmacphuc-omnia`'s `omnia-harness` is a self-contained, zero-Tauri, pure-Tokio Rust agent harness crate (90 files, 33,273 lines) engineered with extraordinary discipline around **crash safety, Windows process-tree determinism, offline regression testing, and interactive desktop UX primitives**.

Compared against `D:\Omnia\rust\{omnia-harness,omnia-agent}` (~63,238 lines across 54 files), the two codebases are **remarkably complementary** rather than redundant:

| Dimension | `D:\Omnia` (`omnia-harness` + `omnia-agent`) | `km-omnia-harness` (`src-tauri/crates/omnia-harness`) | Verdict |
|---|---|---|---|
| **Core Loop, KV Cache & Wire Resilience** | **Far ahead**: 4-Tier Prefix-0 KV Guard, SHA-256 `InstructionEpochState`, keepalive-aware Token-Progress SSE Watchdog (`240s`), `/v1/responses` WS (`55m`), BAML SAP partial-JSON repair, Lakeview + SnapCompact + OscillationDetector, Test-Time Scaling + Slop Scanner (`engine.rs` 11.4kL) | Clean provider-neutral `Block`/`MessageAccumulator`, loud `ModelSelector` fallback, grace-period cancel, **redacted ring-buffer `RequestLog`**, chunk-split-invariant `SseParser`, immediate cumulative-to-delta usage streaming | **Keep Omnia core; absorb `RequestLog`, immediate usage deltas, `MessageAccumulator` dup-ID check, `rewind_boundary`, and loud fallback event** |
| **Checkpointing & Crash Recovery** | BLAKE3 + Deflate blobs in `omnia-winsqlite`, `preview_rollback_to_turn` (`imara-diff` Histogram), `TestOutcomeTransition` (`[Regression Alert]` + `FAIL -> PASS`) | **Superior crash & compaction invariants**: monotonic `next_key` decoupled from transcript indices, `rebase_compaction` + `summary_anchor` SHA-256, `RecoveryArchive` quarantine + `ambiguous_before`, 2-phase `prepare/confirm` rewind, partial-restore retry preservation, Windows case-alias dedup, `CheckpointScope::child()` | **P0 Hybrid Merge**: graft `km`'s compaction/crash/quarantine/child-scope state machine onto Omnia's BLAKE3+Deflate `omnia-winsqlite` store |
| **Lifecycle Hooks & Windows Process Isolation** | **25 lifecycle events**, credential env stripping, inline Rust callbacks, `fail_closed` — **BUT** `hooks.rs:615-626` spawns plain `cmd.exe` with `tokio::time::timeout` and **NO Job Object** (leaks descendants on timeout/cancel!) | Only 6 events, **BUT** **gold-standard Windows `StartGate` (`CreateEventW`) + Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)** preventing spawn-vs-attach race without touching stdin, `#[serde(skip)]` `plugin_root` anti-smuggling, fire-and-forget `Notification` + 5s drain, monotonic permission tightening | **P0 Port**: graft `StartGate` + JobObject + `plugin_root` anti-smuggling + monotonic tightening + `Notification` drain into Omnia's 25-event `HookRegistry` |
| **Offline Regression Eval Harness** | Live multi-provider benchmark suite (`tools/omnia-benchmark`), unit tests per module; no declarative JSON offline scripted agent-loop eval suite | **Standout**: 26 JSON scenarios + `ScriptedProvider` (Main/Compaction/Subagent routing, `when_model`, `when_last_result_contains`), `ScriptedApprover`, stored-ZIP `.docx` fixture builder, declarative event/file/restore assertions + pluggable live mode | **P0 Port** into `D:\Omnia` CI + **`agy-fast`** harness testing! |
| **Concurrency & Multi-Agent Isolation** | **Far ahead on topology**: 2-way `PeerMeshGraph`, `WorktreeManager` (`D:\OmniaData\worktrees`), `SwarmRuntime` (1,816L), advisor watchdogs | **`FileMutationLocks`** (Weak-ref per-canonical-file async mutex shared across root & child subagents with `CancellationToken`); **`ChildEventIds`** (outward-only approval/event ID namespacing keeping child wire history raw); `.omnia/agents/*.md` + `.claude/agents/*.md` profiles; recursive `TaskTool` (depth 5) | **P0/P1 Port**: absorb `FileMutationLocks`, `ChildEventIds`, and Markdown agent-profile discovery into `omnia-agent` (`SwarmRuntime` + `ToolRuntime`) |
| **LSP Integration** | `ProcessSupervisor` (JobObject), LSP 3.17 pull diagnostics, Tree-sitter + PPR AST fallback (`lsp.rs` 1,015L) — **BUT** ignores server->client RPCs, no `-32801/-32802` busy retry, no `$/cancelRequest`, no idle reaper, no `lsp.json` trust snapshot, no `workspace/symbol`, non-transactional `rename_symbol` | **Full LSP protocol polish**: answers `workspace/configuration` & server RPCs, 8x `-32801/-32802` busy retry, `$/cancelRequest`, 60s cold-start timeout, generation-based diagnostics burst settling (`wait_diagnostics`), 10m idle reaper, immutable `load_specs_from_snapshot`, `workspace/symbol` + project-marker auto-detect, transactional overlap-checked checkpointed `lsp_rename` | **P1 Port**: harden Omnia's `LazyLspManager` with all protocol & rename invariants while keeping Tree-sitter fallback + pull diagnostics |
| **MCP Client** | **Far ahead**: MCP `2026-07-28`, OAuth 2.1 PKCE/RFC8707/RFC9728/CIMD, Async Tasks, Form/URL Elicitation, `<1k`-token `McpToolSearchIndex`, MCP Apps `_meta`/`ui://`, Win32 suspended stdio (`mcp_client.rs` 1,942L) | Clean 2025-06-18 client with **`annotations.readOnlyHint` -> parallel batching**, `notifications/cancelled` on timeout/cancel, `nextCursor` pagination, Windows `.cmd`/`.bat` shim resolution with per-server `env.PATH`, `${VAR:-default}` env expansion, `plugin:<p>:<s>` isolation, `tokio::io::duplex` fake server | **P2 Surgical Polish**: port `readOnlyHint`, `notifications/cancelled`, `nextCursor`, `.cmd` shim resolution, `${VAR:-default}`, and duplex testutil |
| **Editing, Search & AST** | **Far ahead**: Hashline v2 (`42:a3f|`), Tree-sitter CST `ast_edit.rs`, 3-tier `imara-diff` Histogram, Pre-Read Guard, Hybrid BM25F+Trigram+SIMD search, BLAKE3 Merkle index | Standard exact-string `edit_file`/`multi_edit`, `apply_patch` (also accepts standard unified diffs), `ignore`+`regex` `glob`/`grep`, **pure-Rust `.docx`/`.xlsx`/`.pptx` (zip-bomb-guarded) + `.ipynb` extraction in `read_file`** | **Keep Omnia editing/search; P1 Port** pure-Rust Office (`.docx`/`.xlsx`/`.pptx`) + `.ipynb` extraction into `read_file` & `omnia-notebook`, plus unified-diff fallback in `apply_patch` |
| **Shell & Terminal** | Supervised Win32 JobObject `shell` + full persistent ConPTY `PtyManager` (`portable-pty`) | **Stateless-process sentinel CWD + env-diff persistence (`shell_session.rs`)** across `bash`, `pwsh`/`powershell` (curly-quote safe), `cmd` + `shell_reset` + `OutputBuf` head/tail ring + `find_git_bash` skipping WSL `System32\bash.exe` | **P1 Port**: add opt-in/default sentinel CWD+env persistence & `find_git_bash` WSL guard to non-PTY `shell` tool (fast & zero orphan ConPTY handles) |
| **Git & GitHub Tools** | `git_forensics.rs` (co-change Jaccard + `run_git`), worktree isolation in `swarm_runtime.rs` | **14 structured Git + `gh` tools**: `git_status` (`--porcelain=v2 -z` JSON), `git_diff`, `git_log`, `git_show`, `git_commit`, `git_branch`, `git_worktree`, `git_merge`, `git_rebase`, `git_pull`, `git_push` (safe `--force-with-lease` only), **`git_conflicts` + `git_resolve` (standard + `diff3`)**, `gh_pr` | **P1 Port**: expose structured `git_conflicts`/`git_resolve` + safe Git/PR tools in `DeferredToolRegistry` (preserving `check_plain` anti-option-injection & `GIT_OPTIONAL_LOCKS=0`) |
| **Plugins, Commands, Memory & Artifacts** | Cordis reversible `PluginRegistry` + `CordisPluginManager` (fault quarantine, Creator Mode), Hindsight/Graphiti/HippoRAG/ACE `MemoryEngine` + `MemoryGraph`, 12-artifact `ArtifactOs`, 1,001-skill Cold Vault `SkillRegistry` | Unified Claude-compatible plugin bundle installer (atomic staging + Windows reparse-point `0x400` / symlink-escape rejection + `.trash/` soft uninstall), custom slash commands (`.omnia/commands`, `.claude/commands`, `dir:name`, `$ARGUMENTS`/`$1..$9`), `present_plan` tool, versioned side-panel `ArtifactTool` (anti-tamper `validate_meta`), hand-editable `.omnia/memory/MEMORY.md` | **P1/P2 Port**: atomic bundle installer (`0x400` guard), custom slash commands, `present_plan`, `validate_meta` anti-tamper, and optional `MEMORY.md` bidirectional sync |
| **Permissions & Approval** | **Steer #22 default `ApprovalMode::Yolo`** + empty `default_rules()` + opt-in `strict_safety_rules()` + CaMeL taint escalation | Defaults to `AskWrites`; adds **`AllowEdited { input }`** (re-validated against deny + `PreToolUse`), ordered `ApprovalPreview` queue (`ordinal`/`total`/`remaining`), `re:` regex rules (1 MiB cap), `publishes_outward`, `allow_like` anti-smuggling | **Keep `Yolo` default (ZERO NERF); P2 Port** `AllowEdited`, `ApprovalPreview`, `re:` rules, and `allow_like` exclusively for opt-in `AlwaysAsk`/`Write` modes |
| **Web, HTTP & SQLite Tools** | **Far ahead on web**: `web_tools.rs` (1,881L) with SSRF/DNS-rebinding `EgressPolicy`, non-bypass challenge taxonomy, per-domain pacer, Tavily/Exa/Brave/DDG/Wiki/arXiv/OpenAlex/EuropePMC, isolated CDP | `http_request` general-purpose HTTP tool; `SearxngBackend`; `<pre>` PUA placeholder protection in `html_to_text`; `sqlite_query`/`sqlite_execute` (on `rusqlite` — **REJECT `rusqlite`**, port design to `omnia-winsqlite`) | **Keep Omnia `web_tools.rs`; P2 Port** `SearxngBackend`, `http_request` (with Omnia `EgressPolicy`), and `omnia-winsqlite`-backed `sqlite_query`/`sqlite_execute` |

---

## 2. Complete 90-File Coverage Ledger (100.00% Line-by-Line)

Every single file in `D:\OmniaData\research\khangmacphuc-omnia\src-tauri\crates\omnia-harness\` was read completely from line `1` to `EOF` (verified against on-disk byte and line counts):

| # | Relative Path | Lines | Bytes | Range Read | Category / Role |
|---:|---|---:|---:|---|---|
| 1 | `Cargo.toml` | 30 | 916 | `1..30` | Crate manifest (`omnia-harness`, Tokio, reqwest, quick-xml, flate2, ignore, rusqlite, similar) |
| 2 | `evals/README.md` | 36 | 2,301 | `1..36` | Eval scenario schema & live/scripted runner docs |
| 3 | `evals/ask_always_remembers.json` | 18 | 789 | `1..18` | Eval: `AllowAlways` caches subsequent matching writes |
| 4 | `evals/ask_writes_allow.json` | 19 | 813 | `1..19` | Eval: `AskWrites` allows after single approval |
| 5 | `evals/ask_writes_deny.json` | 20 | 1,051 | `1..20` | Eval: `AskWrites` deny with feedback reaches model |
| 6 | `evals/checkpoint_restore.json` | 25 | 874 | `1..25` | Eval: file write + overwrite + `restore_checkpoint` -> `after_restore` |
| 7 | `evals/compaction_small_context.json` | 26 | 1,534 | `1..26` | Eval: low `context_window` triggers `Compaction` scripted reply |
| 8 | `evals/deny_rule_respected.json` | 23 | 918 | `1..23` | Eval: explicit deny rule overrides `Full` mode |
| 9 | `evals/fallback_on_overload.json` | 17 | 768 | `1..17` | Eval: 529/overload triggers `model_fallback` & `when_model` match |
| 10 | `evals/full_mode_no_prompts.json` | 23 | 860 | `1..23` | Eval: `Full` mode executes writes with zero approvals |
| 11 | `evals/grep_glob_search.json` | 33 | 1,219 | `1..33` | Eval: gitignore-aware `glob` + `grep` pipeline |
| 12 | `evals/hook_pre_tool_use_block.json` | 31 | 1,367 | `1..31` | Eval: `PreToolUse` exit-2 hook blocks write & reports reason |
| 13 | `evals/max_turns_loop_guard.json` | 18 | 666 | `1..18` | Eval: `max_turns` aborts infinite tool loop cleanly |
| 14 | `evals/memory_write_then_prompt.json` | 28 | 1,530 | `1..28` | Eval: `memory_write` surfaces in next turn's system prompt |
| 15 | `evals/office_docx_read.json` | 19 | 828 | `1..19` | Eval: stored-ZIP `.docx` fixture extraction via `read_file` |
| 16 | `evals/parallel_subagent_budget.json` | 25 | 1,315 | `1..25` | Eval: parallel subagents share parent `TokenBudgetLedger` |
| 17 | `evals/parent_token_budget_exhaustion.json` | 22 | 1,017 | `1..22` | Eval: parent exhaustion halts before child dispatch |
| 18 | `evals/plan_mode_blocks_writes.json` | 32 | 1,429 | `1..32` | Eval: `Plan` mode blocks writes, permits `present_plan` |
| 19 | `evals/read_edit_write_flow.json` | 27 | 1,437 | `1..27` | Eval: full read -> edit -> write workspace flow |
| 20 | `evals/shell_cwd_persistence.json` | 19 | 905 | `1..19` | Eval: persistent `cd` across foreground `shell` calls |
| 21 | `evals/subagent_delegation.json` | 22 | 1,330 | `1..22` | Eval: `task` tool delegates to scripted subagent |
| 22 | `evals/subagent_no_budget.json` | 22 | 1,136 | `1..22` | Eval: uncapped subagent runs cleanly with `token_budget = None` |
| 23 | `evals/subagent_prior_usage_once.json` | 20 | 958 | `1..20` | Eval: prior session usage seeded once, never double-counted by subagents |
| 24 | `evals/subagent_token_budget_exhaustion.json` | 23 | 1,202 | `1..23` | Eval: subagent hits shared budget & propagates error |
| 25 | `evals/token_budget_exceeded.json` | 20 | 933 | `1..20` | Eval: 80% warning + stop on optional explicit token cap |
| 26 | `evals/tool_error_recovery.json` | 23 | 1,187 | `1..23` | Eval: model recovers from tool error via `when_last_result_contains` |
| 27 | `evals/transient_error_retried.json` | 17 | 656 | `1..17` | Eval: retryable provider error retried automatically |
| 28 | `evals/unknown_tool_recovery.json` | 17 | 831 | `1..17` | Eval: unknown tool returns model-visible error, loop recovers |
| 29 | `src/agent.rs` | 3,022 | 115,193 | `1..3022` | Core `Agent` loop, `ModelSelector`, ordered approval queue, `AllowEdited`, cancellation, steering, hooks |
| 30 | `src/budget.rs` | 149 | 4,670 | `1..149` | Optional `TokenBudgetLedger` (`limit: Option<u64>`), shared `Arc<Mutex>`, single 80% warning |
| 31 | `src/checkpoint.rs` | 2,025 | 83,605 | `1..2025` | Compaction-safe durable checkpointing, `rebase_compaction`, `RecoveryArchive`, 2-phase rewind, `CheckpointScope` |
| 32 | `src/commands.rs` | 272 | 9,943 | `1..272` | Custom Markdown slash commands (`.omnia`/`.claude`/user/plugin), `dir:name`, `$ARGUMENTS`/`$1..$9` |
| 33 | `src/compact.rs` | 367 | 12688 | `1..367` | Auto-compaction, `rewind_boundary` tool-pair invariant, prompt summarization |
| 34 | `src/error.rs` | 36 | 1,061 | `1..36` | `HarnessError` (`Provider`, `Protocol`, `Cancelled`, `BudgetExceeded`, `MaxTurns`, `Io`) |
| 35 | `src/eval/check.rs` | 364 | 13,216 | `1..364` | Declarative eval verifier (`files`, `proposed`/`executed`, `results`, `events`, `models`, `requests`) |
| 36 | `src/eval/fixture.rs` | 93 | 3,629 | `1..93` | Tempdir workspace materializer + minimal stored-ZIP `.docx` generator |
| 37 | `src/eval/mod.rs` | 61 | 2,278 | `1..61` | Eval module exports & scenario loader |
| 38 | `src/eval/runner.rs` | 422 | 14,454 | `1..422` | `run_scenario`, `ScriptedApprover`, checkpoint restore verification, live provider override |
| 39 | `src/eval/scenario.rs` | 367 | 11,132 | `1..367` | JSON scenario schema (`Scenario`, `TurnSpec`, `Expectation`, `EventCount`, `RequestExpectation`) |
| 40 | `src/eval/script.rs` | 241 | 7,355 | `1..241` | `ScriptedProvider` classifying Main/Compaction/Subagent requests & conditional step matching |
| 41 | `src/hooks.rs` | 1,174 | 43,741 | `1..1174` | 6-event hook engine, Windows `StartGate` + JobObject tree isolation, `settings.json` + plugin hooks |
| 42 | `src/lib.rs` | 36 | 1,045 | `1..36` | Crate root & re-exports |
| 43 | `src/lsp/client.rs` | 598 | 21,957 | `1..598` | Async stdio `LspClient`, server->client RPC replies, `-32801/-32802` retry, `$/cancelRequest`, diag settle |
| 44 | `src/lsp/config.rs` | 366 | 13,692 | `1..366` | Built-in server registry (6 servers), `lsp.json` merge, immutable `load_specs_from_snapshot`, Win shims |
| 45 | `src/lsp/framing.rs` | 122 | 4,300 | `1..122` | Incremental `Content-Length` JSON-RPC decoder (64 MiB cap, malformed recovery) |
| 46 | `src/lsp/mod.rs` | 917 | 38,274 | `1..917` | `LspManager` + idle reaper + 6 tools (`definition`/`references`/`hover`/`symbols`/`diagnostics`/`rename`) |
| 47 | `src/lsp/tests.rs` | 557 | 20,475 | `1..557` | Fake Node LSP end-to-end tests (UTF-16 emoji, rename refusals, checkpoints, trust snapshot, idle sweep) |
| 48 | `src/lsp/text.rs` | 416 | 14,756 | `1..416` | `LineIndex`, UTF-16 <-> char col, Windows `file://` URIs, `parse_workspace_edit`, overlap-checked apply |
| 49 | `src/mcp/client.rs` | 356 | 12,261 | `1..356` | `McpClient` handshake (`2025-06-18`), `tools/list` `nextCursor` pagination, `tools/call` |
| 50 | `src/mcp/config.rs` | 373 | 12,961 | `1..373` | `mcp.json`/`.mcp.json` merge, `${VAR:-default}` env expansion, `plugin:<p>:<s>` + `${OMNIA_PLUGIN_ROOT}` |
| 51 | `src/mcp/http.rs` | 405 | 15,619 | `1..405` | Streamable HTTP + SSE transport, `mcp-session-id`, server ping over SSE, `DELETE` shutdown |
| 52 | `src/mcp/manager.rs` | 282 | 9,053 | `1..282` | `McpManager` concurrent `join_all` connect, `refresh_if_changed`, per-server status & diagnostics |
| 53 | `src/mcp/mod.rs` | 46 | 1,325 | `1..46` | MCP module exports & `McpError` |
| 54 | `src/mcp/rpc.rs` | 104 | 3,068 | `1..104` | Shared JSON-RPC classifier, `ping` responder, `notifications/cancelled`, `Transport` trait |
| 55 | `src/mcp/stdio.rs` | 384 | 12,534 | `1..384` | `PipeTransport`, stdout banner tolerance, 200-line stderr ring, Windows `.cmd`/`.bat` resolver, `ProcessGuard` |
| 56 | `src/mcp/testutil.rs` | 161 | 6,102 | `1..161` | Zero-subprocess in-process `tokio::io::duplex` fake MCP server |
| 57 | `src/mcp/tool.rs` | 331 | 11,645 | `1..331` | `McpTool` adapter, FNV-1a 64-char name sanitizer, `readOnlyHint` -> `ReadWorkspace`, `structuredContent` |
| 58 | `src/memory.rs` | 657 | 25,664 | `1..657` | Hierarchical `.omnia/{memory,specs,plans,skills,artifacts}/MEMORY.md`, `[[slug]]` links, 8 KiB prompt cap |
| 59 | `src/model.rs` | 388 | 12,376 | `1..388` | Provider-neutral `Message`, `Block`, `Usage`, `StopReason`, `StreamEvent`, `MessageAccumulator` |
| 60 | `src/permission.rs` | 523 | 20,438 | `1..523` | `PermissionMode`, `PermissionPolicy::explain`, `re:` regex (1 MiB cap) + glob, `publishes_outward`, `allow_like` |
| 61 | `src/plan.rs` | 110 | 3,940 | `1..110` | `PresentPlanTool` (Plan-mode only) cleanly terminating turn & emitting `PlanPresented` |
| 62 | `src/plugins.rs` | 890 | 33,004 | `1..890` | Unified plugin bundle discovery/install (atomic stage, `0x400` reparse/symlink-escape rejection, `.trash/`) |
| 63 | `src/prompt.rs` | 233 | 8,209 | `1..233` | `SystemPromptConfig` (`Append`/`Replace`), multi-harness rule files (`OMNIA.md`/`AGENTS.md`/`CLAUDE.md`) |
| 64 | `src/provider/anthropic.rs` | 630 | 24,631 | `1..630` | Anthropic `/v1/messages` adapter, cumulative-to-delta usage, thinking budget clamp, unsigned-thinking strip |
| 65 | `src/provider/gemini.rs` | 822 | 30,605 | `1..822` | Gemini `streamGenerateContent?alt=sse`, OpenAPI `sanitize_schema`, immediate HWM usage deltas, tool-id map |
| 66 | `src/provider/mod.rs` | 52 | 1,731 | `1..52` | `Provider` trait, `ProviderConfig`, `ProviderRequest` |
| 67 | `src/provider/openai_chat.rs` | 626 | 23,417 | `1..626` | OpenAI Chat Completions (`/v1/chat/completions`), Ollama/DeepSeek quirks (`reasoning_content`, missing `index`) |
| 68 | `src/provider/openai_responses.rs` | 612 | 23,817 | `1..612` | OpenAI Responses API (`/v1/responses`), dual `by_item`/`by_index` call IDs, `incomplete`/`failed` handling |
| 69 | `src/provider/record.rs` | 512 | 16,891 | `1..512` | Redacted 50-exchange `RequestLog` wire inspector (256 KiB cap, live TTFT, RAII `Drop` commit) |
| 70 | `src/provider/sse.rs` | 739 | 24,982 | `1..739` | Chunk-split UTF-8-safe `SseParser`, HTTP error retry classification, 1B/7B/64B boundary test harness |
| 71 | `src/skills.rs` | 435 | 15,117 | `1..435` | `SKILL.md` frontmatter discovery (`.omnia`/`.claude`/user/plugins) + `load_skill` progressive tool |
| 72 | `src/subagent.rs` | 618 | 23,731 | `1..618` | `TaskTool` (recursive depth 5), `ChildEventIds` outward-only namespace, `.omnia/agents/*.md` profiles |
| 73 | `src/tool.rs` | 268 | 9,426 | `1..268` | `EffectClass`, `Tool`/`ToolRegistry`/`ToolContext`, **`FileMutationLocks`** weak-ref canonical lock arbiter |
| 74 | `src/tools/artifact.rs` | 683 | 26,571 | `1..683` | `ArtifactTool` (`html|markdown|svg|mermaid|code|csv`, 20 versions, 2 MiB cap, anti-tamper `validate_meta`) |
| 75 | `src/tools/fs.rs` | 986 | 36,249 | `1..986` | `read_file` (images/ipynb/docx/xlsx/pptx), `write_file`, `edit_file` (whitespace hint), `multi_edit`, `list_dir` |
| 76 | `src/tools/git.rs` | 2,333 | 89,839 | `1..2333` | 14 Git & `gh` tools (`status`/`diff`/`log`/`show`/`commit`/`branch`/`worktree`/`merge`/`rebase`/`pull`/`push`/`conflicts`/`resolve`/`gh_pr`) |
| 77 | `src/tools/http.rs` | 313 | 11,943 | `1..313` | `http_request` tool (non-redirecting API client, 200 KB–5 MB streaming cap, UTF-8 cut-safe truncation) |
| 78 | `src/tools/mod.rs` | 181 | 6,229 | `1..181` | `builtin_registry()` & `read_only_registry()` assembly + helpers |
| 79 | `src/tools/office.rs` | 596 | 22,423 | `1..596` | Pure-Rust minimal ZIP reader (50 MiB bomb guard) + `quick-xml` `.docx`/`.xlsx`/`.pptx` text extraction |
| 80 | `src/tools/patch.rs` | 657 | 23,270 | `1..657` | Atomic `apply_patch` accepting both `*** Begin Patch` envelope AND standard unified diffs |
| 81 | `src/tools/search.rs` | 500 | 17,953 | `1..500` | `ignore`-based `glob` (mtime-sorted, 1000 cap) & `grep` (`files_with_matches`/`content`/`count`) |
| 82 | `src/tools/session_ipc.rs` | 312 | 11,284 | `1..312` | Prototype `.omnia/sessions/<id>/inbox.jsonl` IPC (flawed — see Section 6 Reject List) |
| 83 | `src/tools/shell.rs` | 1,038 | 37,756 | `1..1038` | `shell`/`shell_output`/`shell_kill`/`shell_reset`, `OutputBuf` head+tail ring, `find_git_bash` WSL skip |
| 84 | `src/tools/shell_session.rs` | 602 | 21,173 | `1..602` | Stateless-process sentinel `CWD` + env-diff persistence across `bash`/`powershell`/`pwsh`/`cmd` |
| 85 | `src/tools/sqlite.rs` | 334 | 11,906 | `1..334` | `sqlite_query` (RO + `!stmt.readonly()`) & `sqlite_execute` (checkpointed) — uses `rusqlite` |
| 86 | `src/tools/todo.rs` | 165 | 5,447 | `1..165` | Per-session in-memory `todo_write` checklist (`EffectClass::PureCompute`) |
| 87 | `src/tools/web.rs` | 1,120 | 41,938 | `1..1120` | `web_fetch` (PUA `<pre>`-preserving HTML->Markdown) + pluggable `web_search` (`Searxng`/`Brave`/`DDG`/`Fallback`) |
| 88 | `tests/eval_suite.rs` | 34 | 1,358 | `1..34` | Integration driver running all 26 `evals/*.json` offline in `cargo test` |
| 89 | `tests/shared_budget_concurrency.rs` | 192 | 6,487 | `1..192` | Concurrent parallel-subagent shared `TokenBudgetLedger` stress tests |
| 90 | `tests/subagent_approval_namespace.rs` | 410 | 14,803 | `1..410` | Concurrent sibling subagent approval/event namespace & late `ToolProgress` tests |
| **TOTAL** | **90 files** | **33,273** | **1,237,410** | **100.00%** | **0 skipped files, 0 skipped lines** |

---

## 3. Module-by-Module Deep Technical Analysis & Comparison vs `D:\Omnia`

### 3.1 Compaction-Safe Crash-Resilient Checkpointing (`src/checkpoint.rs`, 2,025L) vs `D:\Omnia\rust\omnia-agent\src\checkpoint.rs` (821L)
- **What `D:\Omnia` already does better**:
  - Content-addressed **BLAKE3 + Deflate** blobs stored directly in `omnia-winsqlite` (`AgentStore`), keeping user workspaces completely clean.
  - `preview_rollback_to_turn` computing `imara_diff::Algorithm::Histogram` unified diffs and line deltas before mutation.
  - `parse_test_pass_counts` (Cargo, Jest/Vitest, Pytest, unittest, TAP, Go, custom scripts) + `[Regression Alert]` + Anti-Termination-Lag `TestOutcomeTransition::FailToPass`.
- **What `km/src/checkpoint.rs` does significantly better (MUST ABSORB)**:
  1. **Monotonic Logical Key Indirection (`next_key` + `timeline: BTreeMap<u64, TimelineEntry { index, summary }>`)**: Decouples checkpoint IDs from visible transcript message indices so keys never collide or shift across compaction or conversation rewind.
  2. **Compaction Rebasing (`rebase_compaction(split, compacted, active)`) + `summary_anchor` SHA-256**: Merges checkpoints from compacted turns (`< split`) into a single `summary: true` index-0 baseline, rebases retained turns (`index - split + 2`), and stores the SHA-256 of the summary message so a crash between manifest save and SQLite transcript commit is detected deterministically on reload.
  3. **Recovery Quarantine (`RecoveryArchive` + `ambiguous_before` barrier)**: On legacy/corrupt/crash-mismatched manifests, NEVER guesses or silently deletes history. Archives raw manifest bytes under content-addressed `recovery/manifest-<sha256>.json`, protects referenced blobs from GC, blocks file restore across the `ambiguous_before` barrier, and allows conversation continuation safely.
  4. **Two-Phase Conversation Rewind (`prepare_conversation_rewind` + `confirm_history`)**: Records `pending_conversation_rewind` (target SHA-256 + expected transcript length) before truncating SQLite history; reconciles cleanly if the process crashes mid-rewind.
  5. **Partial-Restore Retry Preservation**: If restoring 1 of 5 files fails (e.g., Windows `ERROR_SHARING_VIOLATION` lock), already-restored entries are cleared while failed entries remain tracked so a subsequent retry restores the exact remaining delta without data loss.
  6. **Windows Case-Alias Deduplication (`path_identity`)**: Normalizes path casing on Windows before inserting pre-mutation snapshots so editing `Foo.rs` then `foo.rs` in the same turn never overwrites the true pre-turn snapshot.
  7. **`CheckpointScope::child()`**: Lets child subagents snapshot files onto the parent's active checkpoint key without mutating the parent's timeline or advancing `next_key`!

### 3.2 Lifecycle Hooks & Race-Free Windows Job-Object Tree Isolation (`src/hooks.rs`, 1,174L) vs `D:\Omnia\rust\omnia-agent\src\hooks.rs` (756L)
- **What `D:\Omnia` already does better**:
  - **25 lifecycle events** (OMP + Claude Code + Omnia parity) vs `km`'s 6 events (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `Notification`).
  - Automatic secret-env stripping (`API_KEY`/`AUTH_TOKEN`/`SECRET`), inline Rust callbacks, and per-hook `fail_closed`.
- **Critical Gap Caught in `D:\Omnia\rust\omnia-agent\src\hooks.rs` (lines 615–626)**:
  - `D:\Omnia` spawns hook commands via `tokio::process::Command::new("cmd.exe")` + `tokio::time::timeout(timeout, child.wait_with_output())` **WITHOUT a Windows Job Object** (and does not call `spawn_supervised_command`). When a hook times out or is cancelled, `tokio` drops the `Child` handle, **leaking any spawned grandchild processes**!
- **What `km/src/hooks.rs` does better (MUST ABSORB)**:
  1. **Windows `StartGate` + Job Object (`owned_hook_tree`)**: Creates an unnamed `CreateJobObjectW` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` AND a named manual-reset event `CreateEventW("Local\\omnia-hook-<uuid>")`. The PowerShell launcher opens/waits on that event *before* executing the user hook command so `AssignProcessToJobObject` completes strictly BEFORE any descendant can spawn — **zero race window and stdin pipe stays completely free for JSON payload delivery**! Fails closed if Job Object attachment fails. Proven by a self-spawning TCP listener regression test.
  2. **Plugin Root Anti-Smuggling**: `plugin_root: Option<PathBuf>` marked `#[serde(skip)]` on `HookCommand` so workspace `settings.json` cannot spoof `OMNIA_PLUGIN_ROOT`.
  3. **Strict Monotonic Permission Tightening**: `PreToolUse` hooks can tighten `Allow -> Ask -> Deny` (and edit input), but can **NEVER** override a user `Deny` rule or suppress an explicit policy `Ask`.
  4. **Async `Notification` Hooks + Graceful Drain**: `fire_notification` runs non-blocking on a tracked `JoinSet` and drains up to 5s at run end (`drain_notifications`).
  5. **`Stop` Hook Loop Cap**: `MAX_STOP_HOOK_CONTINUES = 3` prevents runaway stop-hook infinite loops.

### 3.3 Deterministic Offline Harness Eval Suite (`src/eval/*` + `evals/*.json` + `tests/eval_suite.rs`, 2,225L)
- **Status in `D:\Omnia`**: `D:\Omnia` has an excellent live 10-axis -> v5 coding-agent benchmark suite (`tools/omnia-benchmark`), plus Rust unit tests per module, **but lacks a declarative, zero-network, CI-speed end-to-end Agent Loop regression suite** testing multi-turn tool execution, compaction, subagents, approvals, checkpoints, hooks, fallbacks, and error recovery together in <2 seconds!
- **Key Mechanisms in `km/src/eval/`**:
  - `ScriptedProvider` (`script.rs`): Classifies each `ProviderRequest` into `RequestKind::{Main, Compaction, Subagent}` by inspecting system prompt / tool surface, matches steps with optional `when_model` and `when_last_result_contains` guards, emits exact `StreamEvent` streams (text, thinking, tool calls, usage, retryable/non-retryable provider errors).
  - `ScriptedApprover` (`runner.rs`): Feeds ordered approval decisions (`allow_once`, `allow_always`, `deny`, `allow_edited`) per tool call.
  - `fixture.rs`: Materializes temp workspace files + builds valid stored-ZIP `.docx` files on the fly without binary fixtures checked into Git!
  - `check.rs`: Evaluates `files` (`exists`/`equals`/`contains`/`not_contains`), `proposed`/`executed` (`exact`/`ordered`/`includes`/`excludes`/`count`), `results`/`no_results`, snake_case `events` count ranges (`min`/`max`/`eq`), `models_requested`, `requests` (system/message assertions), AND executes `restore_checkpoint` -> verifies `after_restore` file states!
  - **Dual Mode**: `RunOptions { provider: Some(live_provider), .. }` lets the exact same 26 JSON scenarios run offline in `cargo test` OR live against real endpoints.

### 3.4 Per-File Concurrency & Subagent Namespace Isolation (`src/tool.rs`, `src/subagent.rs`, `tests/subagent_approval_namespace.rs`)
- **`FileMutationLocks` (`src/tool.rs:38-163`)**:
  - `Mutex<BTreeMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>` shared across the root `ToolContext` and every cloned subagent `ToolContext`.
  - Canonicalizes the deepest existing ancestor + normalizes remaining components + lowercases on Windows so nonexistent files, symlink aliases, and case-variant paths (`Src/Foo.rs` vs `src/foo.rs`) contend on the exact same mutex without blocking unrelated files, while honoring `CancellationToken` via `tokio::select!`.
  - **Comparison vs `D:\Omnia`**: `D:\Omnia\rust\omnia-agent\src\edit.rs` uses `FileReadTracker` + `atomic_write_bom_free` (preventing torn writes), and `WorktreeManager` isolates git worktrees, **but in-workspace parallel subagents / sibling tool calls in `ToolRuntime` lack a per-canonical-file async mutation lock** (meaning two concurrent `edit_file` calls to different regions of the same file can race and drop one edit!). Adopting `FileMutationLocks` (and acquiring sorted locks for multi-file `apply_patch` / `lsp_rename`!) cleanly eliminates this race.
- **`ChildEventIds` (`src/subagent.rs` + `tests/subagent_approval_namespace.rs`)**:
  - Qualifies ONLY outward-facing event & approval IDs (`subagent_<uuid>_t<turn>_<raw_id>`) while leaving child provider wire history & tool-result IDs raw (`call_0`, `call_1`). Prevents UI/approval-map collisions when parallel sibling subagents emit identical provider call IDs, and keeps late `ToolProgress` events correctly routed across turns.
- **Markdown Subagent Profiles (`src/subagent.rs`)**:
  - Discovers `.omnia/agents/*.md`, `.claude/agents/*.md`, user `agents/*.md`, and enabled plugin `agents/*.md` with YAML frontmatter (`name`, `description`, `tools`, `model: inherit`, `read_only`) + recursive `TaskTool` capped at `DEFAULT_MAX_SUBAGENT_DEPTH = 5`.
  - **Comparison vs `D:\Omnia`**: `D:\Omnia` has `SwarmRuntime` + `recipes.rs`, but adding `.omnia/agents/*.md` & `.claude/agents/*.md` frontmatter profile discovery gives drop-in Claude Code subagent compatibility.

### 3.5 Agent Loop, Ordered Approvals, Loud Fallback & Compaction Boundary (`src/agent.rs`, `src/compact.rs`, `src/permission.rs`, `src/plan.rs`, `src/budget.rs`)
- **Ordered Approval Queue + `AllowEdited` (`src/agent.rs`)**:
  - Batches tool approvals with explicit queue metadata (`ApprovalRequest { ordinal, total, remaining: Vec<ApprovalPreview> }`).
  - `ApprovalDecision::AllowEdited { input }` re-validates the user-edited JSON input against deny rules AND re-runs `PreToolUse` hooks, then prepends a notice to the `ToolResult` telling the model the user modified arguments.
  - **Zero-Nerf Application**: Keep `D:\Omnia`'s default `ApprovalMode::Yolo` untouched (`0` prompts by default). Adopt `AllowEdited` + `ApprovalPreview` queue + `re:` regex rules (1 MiB cap) + `publishes_outward` + `allow_like` anti-smuggling **strictly for opt-in `AlwaysAsk` / `Write` modes**.
- **Loud `ModelSelector` Fallback & Safe Retry (`src/agent.rs`)**:
  - Retries with exponential backoff ONLY when `!streamed_any` (never after partial deltas/usage).
  - Emits explicit `AgentEvent::ModelFallback { from, to, reason }` on 429/529/404/5xx/model-400/403 and sticks to the fallback for the rest of the run (never silent switching).
- **Orphaned Tool-Call Self-Healing & `rewind_boundary` (`src/agent.rs`, `src/compact.rs`)**:
  - On mid-batch cancellation/interruption, retains already-completed tool results & pending `SteerQueue` messages; on next `push_user`, auto-synthesizes error `ToolResult` blocks for any dangling `ToolUse` calls so Anthropic/OpenAI/Gemini never 400-reject the resumed transcript.
  - `compact::rewind_boundary` guarantees compaction splits & conversation rewinds NEVER sever a `ToolResult` from its owning assistant `ToolUse` (even when mid-batch steer text was merged into the tool-result user message!).
- **`PresentPlanTool` (`src/plan.rs`)**:
  - Registered exclusively in `Plan` mode; calling `present_plan` cleanly ends the turn and emits `AgentEvent::PlanPresented` + `plan_ready` notification.
- **Optional `TokenBudgetLedger` (`src/budget.rs`)**:
  - Defaults to `limit: None` (uncapped). **Strict Zero-Nerf Rule**: `D:\Omnia` keeps `token_budget = NULL` by default; `km`'s `Arc<Mutex>` shared parent+sibling accounting with single 80% warning & `u128` overflow-free threshold check should ONLY activate if a user explicitly configures a cap.

### 3.6 Provider Plumbing & Redacted Wire Inspector (`src/provider/*`, 3,993L)
- **`RequestLog` / `ExchangeHandle` (`src/provider/record.rs`, 512L)**:
  - 50-exchange in-memory ring buffer, 256 KiB payload cap, records HTTP status & TTFT *live while streaming*, RAII `Drop` guarantees commit on cancel/panic, automatically redacts sensitive headers (`authorization`, `x-api-key`, `x-goog-api-key`, `cookie`, `token`, `secret`, etc.) AND URL userinfo + sensitive query params (`key`, `api_key`, `token`, `auth`).
  - **High-value win** for `D:\Omnia` (`omnia-studio` Diagnostics/Inspector pane + `omnia-agent` debug traces) AND `agy-fast` Observatory!
- **Immediate Cumulative-to-Delta Usage Accounting (`anthropic.rs`, `gemini.rs`)**:
  - Tracks high-water marks and emits `StreamEvent::Usage` deltas *as each chunk arrives* (ignoring regressing/negative counters, saturating `candidatesTokenCount + thoughtsTokenCount`), so dropped streams or mid-stream errors never hide tokens already consumed.
- **Chunk-Split-Invariant `SseParser` (`sse.rs`) & `MessageAccumulator` (`model.rs`)**:
  - Decodes UTF-8 only on complete `\n`-terminated lines (immune to multi-byte UTF-8 split across TCP chunks), verified by `run_fixture` at 1-byte, 7-byte, and 64-byte chunk splits.
  - `MessageAccumulator` rejects duplicate pending/completed tool call IDs within a single assistant message (`HarnessError::Protocol`), preventing corrupt tool-result routing.
  - `OpenAiChatProvider` tolerates Ollama/LM Studio/DeepSeek quirks (omitted `index`/`id`, `finish_reason: "stop"` with tool calls, `reasoning_content`/`reasoning`, `prompt_cache_hit_tokens`).

### 3.7 Language Server Protocol Subsystem (`src/lsp/*`, 2,976L) vs `D:\Omnia\rust\omnia-agent\src\lsp.rs` (1,015L)
- **What `D:\Omnia` already does better**: `ProcessSupervisor` (JobObject), LSP 3.17 pull diagnostics (`textDocument/diagnostic`), Tree-sitter syntax-error overlay + PPR `WorkspaceGraphIndex` AST fallback when no LSP binary is installed.
- **8 Concrete Protocol Hardenings in `km/src/lsp/` Missing from `D:\Omnia`**:
  1. **Server->Client RPC Responder (`client.rs:92-116`)**: Answers `workspace/configuration` (`vec![null; n]`), `client/registerCapability`, `window/workDoneProgress/create`, and `workspace/*/refresh` (prevents `rust-analyzer` & `tsserver` stalls!).
  2. **Indexing Busy Retry (`client.rs:360-367`)**: Automatically retries `-32801` (`ContentModified`) and `-32802` (`ServerCancelled`) up to 8x with 400ms cancellable backoff.
  3. **`$/cancelRequest` on Timeout/Cancel (`client.rs:407-411`)** + **60s Cold-Start `FIRST_REQUEST_TIMEOUT` vs 30s Warm `REQUEST_TIMEOUT`** (Omnia currently uses 3s/5s which fails on cold `rust-analyzer`!).
  4. **Diagnostics Generation + Burst Settling (`wait_diagnostics`, `client.rs:482-529`)**: Captures per-URI generation counter BEFORE `didOpen`/`didChange`, waits up to 25s (fresh) / 8s (warm), then settles up to 1.5s until 350ms quiet so syntax + semantic diagnostics arrive together.
  5. **10-Minute Idle Server Reaper (`mod.rs:208-243`)**: `Weak<LspManager>` background sweeper calling polite `shutdown` -> `exit` -> kill so idle language servers don't hog gigabytes of RAM.
  6. **Immutable Trust-Boundary `lsp.json` Snapshot (`load_specs_from_snapshot`, `config.rs:164-178`)**: Pins approved project/user `lsp.json` bytes to a canonical workspace root, preventing post-approval TOCTOU executable hijacking or cross-workspace subagent misuse.
  7. **`workspace/symbol` + Project-Marker Auto-Inference (`mod.rs:577-620`)**: Infers server from `Cargo.toml`/`tsconfig.json`/`go.mod`/`pyproject.toml`/`compile_commands.json` when no file is open yet.
  8. **Transactional Checkpointed `lsp_rename` (`text.rs:238-304`, `mod.rs:816-914`)**: Prefers `documentChanges` over `changes`, refuses file create/rename/delete ops, validates workspace containment + UTF-8 + non-overlapping ranges across ALL files BEFORE writing a single byte, checkpoints every target file first, preserves UTF-8 BOM, and emits `file:line:col old -> new` summary.

### 3.8 Model Context Protocol (`src/mcp/*`, 2,442L) vs `D:\Omnia\rust\omnia-agent\src\mcp_client.rs` (1,942L)
- **`D:\Omnia` is far ahead overall** (MCP `2026-07-28`, OAuth 2.1 PKCE/RFC8707/RFC9728/CIMD, Async Tasks, Form/URL Elicitation, `<1k`-token `McpToolSearchIndex`, MCP Apps, Win32 suspended stdio).
- **7 Surgical Polish Items from `km/src/mcp/`**:
  1. `annotations.readOnlyHint == true` -> map to read-only `EffectClass` so consecutive read-only MCP calls batch in parallel.
  2. Emit `notifications/cancelled` (`requestId`, `reason`) on BOTH request timeout AND `CancellationToken` cancel.
  3. Follow `nextCursor` pagination on `tools/list` (capped at 100 pages).
  4. Windows `.exe`/`.cmd`/`.bat`/`.com` shim resolution honoring per-server `env.PATH` (`stdio.rs:258-308`).
  5. `${VAR}` and `${VAR:-default}` environment interpolation in `mcp.json` + plugin-scoped `plugin:<plugin>:<server>` with `${OMNIA_PLUGIN_ROOT}` (`config.rs:66-193`).
  6. HTTP transport handling JSON batches + SSE streams + server-initiated `ping` inside SSE via POST + `DELETE` with `mcp-session-id` on shutdown (`http.rs`).
  7. `tokio::io::duplex` zero-subprocess fake MCP server (`testutil.rs`) for fast deterministic unit tests.

### 3.9 Built-In Tools Analysis (`src/tools/*`, 10,820L)
1. **Pure-Rust Office & Jupyter Extraction (`tools/office.rs` 596L + `tools/fs.rs:172-280`) — STANDOUT**:
   - Minimal hand-rolled ZIP EOCD/Central-Directory reader (`flate2` + `quick-xml`, zero `zip` crate bloat), rejecting encrypted/ZIP64 archives and enforcing `MAX_TOTAL_BYTES = 50 MB` cumulative decompression cap via `.take(remaining + 1)` (immune to zip bombs!).
   - Extracts `.docx` (`word/document.xml` paragraphs/tabs/breaks), `.xlsx` (`sharedStrings.xml` skipping phonetic `rPh` runs, `workbook.xml` + `.rels`, `inlineStr`, booleans, `AB12` column-index alignment into TSV), and `.pptx` (numeric `slideN.xml` sort).
   - `render_notebook` renders `.ipynb` cells + stream/error/`text/plain` outputs while omitting raw base64 images cleanly.
2. **Stateless-Process Durable Shell State (`tools/shell_session.rs` 602L + `tools/shell.rs` 1,038L) — STANDOUT**:
   - Wraps foreground `bash`, `pwsh`/`powershell` (with Unicode curly-quote escaping `ps_quote` for `\u{2018}`..`\u{201b}`), and `cmd` with a per-call sentinel `__OMNIA_<12hex>__` emitting `CWD`, `RC`, before-env (`A:`), after-env (`B:`), and `END`; `StateCapture` strips the trailer out of band, diffs `set`/`unset` (ignoring `SHLVL`/`PWD`/`OLDPWD`/`=C:`), and replays overrides on the next call.
   - `find_git_bash` explicitly skips `C:\Windows\System32\bash.exe` (WSL launcher) and probes Git for Windows paths.
   - `OutputBuf` keeps 15 KB head + 15 KB tail (`VecDeque`) and `join_readers` bounds grandchild pipe drains to 2s.
3. **14 Structured Git + `gh` CLI Tools (`tools/git.rs` 2,333L) — STANDOUT**:
   - Direct `git` spawn (zero shell), `-c core.quotepath=false -c color.ui=false --no-pager`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`, `GIT_OPTIONAL_LOCKS=0` on read-only ops, `check_plain` anti-option-injection (`-`, `\0`, `\n`).
   - `git_status` (`--porcelain=v2 --branch -z` JSON), **`git_conflicts` + `git_resolve`** (parses merge & `diff3` `|||||||` markers into JSON hunks, supports `ours`/`theirs`/`content`, rejects residual markers & path traversal, checkpoints before write, stages with `git add --`), `git_worktree`, `git_merge`, `git_rebase`, `git_pull`, `git_push` (blocks raw `--force`/refspecs, allows `--force-with-lease`), `gh_pr` (`GH_PROMPT_DISABLED=1`, preserves non-zero `checks` stdout table, auth guidance without touching tokens).
4. **Versioned Side-Panel `ArtifactTool` (`tools/artifact.rs` 683L)**:
   - `html|markdown|svg|mermaid|code|csv` versioned store (20 versions, 2 MiB cap, 100/session), atomic `meta.json.tmp` rename, `symlink_metadata` check, and anti-tamper `validate_meta` verifying `meta.id == dir_name` & no control chars.
5. **Dual-Format `ApplyPatchTool` (`tools/patch.rs` 657L)**:
   - Accepts BOTH `*** Begin Patch` Codex envelopes AND standard `--- a/f` / `+++ b/f` unified diffs in-memory atomically. *(Bug caught: omits `lock_file_mutation`, unlike `fs.rs`.)*
6. **General-Purpose `HttpRequestTool` (`tools/http.rs` 313L) & `SqliteQueryTool`/`SqliteExecuteTool` (`tools/sqlite.rs` 334L)**:
   - `http_request` supports non-redirecting API inspection with streaming `max_bytes` cap and cut-safe UTF-8 truncation (`error.error_len().is_none()` -> `valid_up_to()`).
   - `sqlite_query` enforces both `SQLITE_OPEN_READ_ONLY` AND `!stmt.readonly()`; `sqlite_execute` checkpoints `.db` first. *(Must reimplement on `omnia-winsqlite`, NEVER `rusqlite`.)*
7. **Web Tools (`tools/web.rs` 1,120L)**:
   - `D:\Omnia\rust\omnia-agent\src\web_tools.rs` (1,881L) is vastly stronger (SSRF/DNS-rebinding `EgressPolicy`, non-bypass challenge taxonomy, per-domain pacer, 8+ web & academic backends, isolated CDP). Only worth borrowing: `SearxngBackend` (`OMNIA_SEARXNG_URL`) and the PUA sentinel (`\u{e000}N\u{e001}`) `<pre>` indentation protector in `html_to_text`. *(Bug caught: `WebFetchTool` spec claims "Follows redirects" while `client()` sets `Policy::none()`.)*
8. **Plugins, Slash Commands, Skills, Prompts & Memory (`src/{plugins,commands,skills,prompt,memory}.rs`, 2,487L)**:
   - `plugins.rs` (890L): Unified Claude-Code/Omnia plugin bundle (`omnia-plugin.json` or `.claude-plugin/plugin.json`) contributing `skills/`, `agents/`, `commands/`, `hooks.json`, and `mcp.json` with `${OMNIA_PLUGIN_ROOT}`, atomic staging install (`copy_tree` rejecting Windows reparse points `0x400`, symlinks, escapes, `.git`, >5,000 files, >64 MiB), `.trash/` soft uninstall/replace, and `plugins.json` toggle.
   - `commands.rs` (272L): Custom Markdown slash commands (`.omnia/commands`, `.claude/commands`, user, plugins) with `dir:name` namespacing and quoted `$ARGUMENTS` + `$1..$9` positional expansion.
   - `memory.rs` (657L): Human-editable `.omnia/{memory,specs,plans,skills,artifacts}/MEMORY.md` with `[[slug]]` wiki-links, checkpointed `memory_{read,write,delete}`, and 8 KiB char-boundary line-aligned prompt cap (complements Omnia's SQLite `MemoryEngine`/`MemoryGraph` as an optional workspace Markdown projection).

---

## 4. Prioritized `D:\Omnia` Integration Candidates (Zero-Nerf Blueprint)

All targets keep `D:\Omnia`'s `--offline --locked` 17-crate Rust workspace, `omnia-winsqlite`, Steer #22 default `ApprovalMode::Yolo`, and `token_budget = NULL`.

### P0 — Critical Correctness, Crash-Safety & Regression Infrastructure
| ID | Capability from `km-omnia-harness` | Exact `D:\Omnia` Target Crate & File | Implementation & Zero-Nerf Notes |
|---|---|---|---|
| **OMN-01** | **Windows `StartGate` (`CreateEventW`) + JobObject (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) hook tree isolation + `#[serde(skip)]` `plugin_root` + monotonic tightening + `Notification` 5s drain** | `rust/omnia-agent/src/hooks.rs` (and share `StartGate` via `rust/omnia-workspace-ops/src/process_ops.rs`) | Fixes live orphan-process leak on hook timeout/cancel in `hooks.rs:615-626`. Keep all 25 Omnia events + secret-env stripping + inline hooks. Include TCP-listener self-spawning child regression test. Zero new crates (uses existing `windows-sys`). |
| **OMN-02** | **Compaction-safe monotonic checkpoint keys, `rebase_compaction` + `summary_anchor`, `RecoveryArchive` quarantine + `ambiguous_before`, 2-phase `prepare/confirm` rewind, partial-restore retry preservation, Windows case-alias dedup, `CheckpointScope::child()`** | `rust/omnia-agent/src/checkpoint.rs` + `rust/omnia-agent/src/agent_store.rs` | Keep Omnia's BLAKE3+Deflate `omnia-winsqlite` blob storage, `preview_rollback_to_turn`, and `TestOutcomeTransition`. Store `timeline` + `recovery_manifests` + `pending_rewind` in `omnia-winsqlite` tables so checkpoints survive Lakeview/SnapCompact compactions and mid-rewind crashes cleanly. |
| **OMN-03** | **Deterministic Offline Scripted Harness Eval Suite (`ScriptedProvider`, `ScriptedApprover`, stored-ZIP fixture builder, declarative event/file/restore checks, 26+ JSON scenarios)** | `rust/omnia-agent/src/eval/` (new module) + `rust/omnia-agent/evals/*.json` + `rust/omnia-agent/tests/eval_suite.rs` | Runs offline in `cargo test --workspace --offline --locked` in <2s! Covers default `Yolo` mode, opt-in `AlwaysAsk`/`Plan`, `PreToolUse` exit-2, Lakeview compaction + checkpoint rewind, subagent isolation, loud fallback, error recovery, Office `.docx` reads, and `shell` CWD persistence. |
| **OMN-04** | **`FileMutationLocks` weak-ref canonical per-file async mutex (shared root <-> subagents, cancellation-aware, sorted multi-file locking)** | `rust/omnia-agent/src/tools.rs`, `edit.rs`, `patch.rs`, `lsp.rs` | Eliminates concurrent sibling-edit races on the same file (including Windows case aliases and not-yet-created paths) without serializing unrelated files. Acquire locks in canonical sorted order for multi-file `apply_patch` and `lsp_rename` to guarantee deadlock freedom. |

### P1 — High-Impact Capability Upgrades
| ID | Capability from `km-omnia-harness` | Exact `D:\Omnia` Target Crate & File | Implementation & Zero-Nerf Notes |
|---|---|---|---|
| **OMN-05** | **Full LSP Protocol Hardening**: server->client RPC responder (`workspace/configuration`, etc.), `-32801/-32802` busy retries, `$/cancelRequest`, 60s cold-start timeout, generation-based diagnostics burst settling, 10m idle reaper, immutable trust-snapshot `lsp.json`, `workspace/symbol` + marker inference, transactional pre-validated checkpointed `lsp_rename` | `rust/omnia-agent/src/lsp.rs` | Keep Omnia's `ProcessSupervisor`, LSP 3.17 pull diagnostics, and Tree-sitter/PPR AST fallback. Add `FileMutationLocks` + `TurnCheckpointStore` snapshotting to `rename_symbol` before writing any file. |
| **OMN-06** | **Pure-Rust Office (`.docx`/`.xlsx`/`.pptx`, 50 MiB zip-bomb guard) & `.ipynb` Notebook Text Extraction** | `rust/omnia-workspace-ops/src/office_extract.rs` (new, reusable by BOTH `omnia-agent/src/tools.rs` `read_file` AND `omnia-notebook` Atelier ingest!) | Zero `zip` crate needed (`flate2` + `quick-xml` only; check if `quick-xml` is vendored in `Cargo.lock` — if not, minimal zero-dep XML tag/entity scanner is ~150 lines so `--offline --locked` stays 100% intact!). Huge win for both coding agents and NotebookLM++ Atelier! |
| **OMN-07** | **Stateless-Process Sentinel Shell CWD + Env-Diff Persistence (`shell_session.rs` pattern) + `shell_reset` + `find_git_bash` WSL skip** | `rust/omnia-agent/src/tools.rs` (non-PTY `shell` path) | Complements persistent ConPTY (`pty_session.rs`) with lightweight, zero-orphan persistent `cd` + env exports across `bash`, `pwsh`/`powershell` (curly-quote safe), and `cmd`. Scope state to `ToolRuntime` instance (fixing `km`'s global-map leak!). |
| **OMN-08** | **Structured Git Conflict & Collaboration Tools (`git_conflicts` + `git_resolve` w/ `diff3`, `git_status` `--porcelain=v2 -z`, `git_merge`/`rebase`/`worktree`/`push --force-with-lease`, `gh_pr`, `check_plain` anti-option-injection)** | `rust/omnia-agent/src/git_tools.rs` (new, registered in `DeferredToolRegistry` so Prefix-0 stays `<1.3k` tokens!) | Preserves `GIT_OPTIONAL_LOCKS=0` on read-only ops and `spawn_supervised_command`. Huge productivity jump for merge/rebase conflict resolution and PR workflows. |
| **OMN-09** | **`ChildEventIds` Outward-Only Subagent ID Namespacing + `.omnia/agents/*.md` & `.claude/agents/*.md` Profile Discovery** | `rust/omnia-agent/src/swarm_runtime.rs` + `rust/omnia-agent/src/context.rs` | Prevents parallel sibling approval/UI ID collisions while keeping child LLM wire history clean (`call_0`). Unlocks drop-in Claude Code custom subagent markdown profiles. |
| **OMN-10** | **Redacted 50-Exchange `RequestLog` Wire Inspector + Immediate Cumulative-to-Delta Usage Streaming + `MessageAccumulator` Dup-Call-ID Guard + `rewind_boundary` Tool-Pair Invariant** | `rust/omnia-agent/src/engine.rs`, `lakeview.rs`, `rust/omnia-studio/` (Inspector API) | Exposes live TTFT, HTTP status, and secret-redacted request/response bodies to Studio Inspector without leaking keys/cookies/query tokens. Guarantees compaction/rewind never orphans `ToolResult` from `ToolUse` and mid-stream drops never lose usage accounting. |

### P2 — Ergonomics, Ecosystem Parity & Surgical Polish
| ID | Capability from `km-omnia-harness` | Exact `D:\Omnia` Target Crate & File | Implementation & Zero-Nerf Notes |
|---|---|---|---|
| **OMN-11** | **Unified Claude/Omnia Plugin Bundle Installer** (atomic staging, Windows `0x400` reparse-point & symlink-escape rejection, 5,000-file/64 MiB cap, `.trash/` soft uninstall, `${OMNIA_PLUGIN_ROOT}` for skills/agents/commands/hooks/MCP) | `rust/omnia-agent/src/dynamic_plugins.rs` + `rust/omnia-harness/src/skill_registry.rs` | Extends Omnia's Cordis `CordisPluginManager` (keeping fault quarantine & Creator Mode) to safely install third-party `.claude-plugin` / `omnia-plugin` bundles. |
| **OMN-12** | **Custom Markdown Slash Commands** (`.omnia/commands`, `.claude/commands`, user, plugin; `dir:name` namespaces; quoted `$ARGUMENTS` + `$1..$9` positional expansion) | `rust/omnia-agent/src/recipes.rs` (or `commands.rs`) + `omnia-cli` + `omnia-studio` | Extends `recipes.rs` with zero-YAML Markdown prompt commands compatible with Claude Code repositories. |
| **OMN-13** | **Opt-In Approval UX Polish**: `AllowEdited { input }` (re-checked via deny + `PreToolUse`), ordered `ApprovalPreview` queue (`ordinal`/`total`/`remaining`), `re:` regex rules (1 MiB cap), `publishes_outward`, `allow_like` anti-smuggling, and `PresentPlanTool` (`present_plan`) | `rust/omnia-agent/src/permissions.rs`, `tools.rs`, `engine.rs` | **STRICT ZERO NERF**: default remains `ApprovalMode::Yolo` + empty `default_rules()`; these upgrades ONLY enrich opt-in `AlwaysAsk`/`Write`/`Plan` modes. |
| **OMN-14** | **MCP Surgical Polish**: `annotations.readOnlyHint` -> parallel batching, `notifications/cancelled` on timeout/cancel, `nextCursor` pagination, Windows `.cmd`/`.bat` shim resolution honoring per-server `env.PATH`, `${VAR:-default}` env expansion, `tokio::io::duplex` testutil | `rust/omnia-agent/src/mcp_client.rs` | Layer cleanly onto Omnia's superior MCP `2026-07-28` client. |
| **OMN-15** | **Extra Deferred Tools**: `http_request` (wired through Omnia's `EgressPolicy`), `SearxngBackend` (`OMNIA_SEARXNG_URL`), unified-diff fallback in `patch.rs`, `sqlite_query`/`sqlite_execute` (implemented on **`omnia-winsqlite`**, NOT `rusqlite`!), and `ArtifactTool` `validate_meta` anti-tamper check | `rust/omnia-agent/src/{web_tools.rs,patch.rs,tools.rs}`, `rust/omnia-harness/src/artifact_os.rs` | Keeps core 7-tool prefix untouched by registering `http_request`/`sqlite_*` in `DeferredToolRegistry`. |

---

## 5. Prioritized `agy` / `agy-fast` Integration Candidates

Targeted at `C:\Users\khang\.gemini\antigravity\scratch\agy-fast\` (`native/src/` Rust daemon/MCP/TUI/WebUI/Observatory + `src/`/`test/` TS harness):

| Priority | Capability from `km-omnia-harness` | Target Area in `agy` / `agy-fast` | Concrete Benefit |
|---|---|---|---|
| **P0** | **Offline Declarative Scripted Eval Suite (`eval/scenario.rs`, `script.rs`, `check.rs`, `runner.rs`, 26 JSON scenarios)** | `agy-fast/native/tests/` & `agy-fast/test/` | Gives `agy-fast` deterministic CI-grade regression coverage of tool loops, compaction, hook blocks, recovery, and subagent budgets in <2s without burning API quota. |
| **P0** | **Windows `StartGate` (`CreateEventW`) + Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) process-tree containment** | `agy-fast/native/src/exec.rs` + hook/check runners (`tools_checks.rs`) | Guarantees 0 leaked child/grandchild processes on timeout or cancellation on Windows without racing `AssignProcessToJobObject` or hijacking stdin. |
| **P0** | **Compaction-Safe Crash-Resilient Snapshot/Checkpointing (`timeline`, `RecoveryArchive`, partial-restore retry preservation, Windows case-alias dedup)** | `agy-fast/native/src/snapshot.rs` & `recovery.rs` | Elevates `agy-fast`'s session recovery & file rollback so partial Windows file locks or crashes mid-rewind never drop snapshot metadata or overwrite case-alias originals. |
| **P1** | **`FileMutationLocks` weak-ref canonical per-file async mutex** | `agy-fast/native/src/tools_edit.rs` & parallel MCP tool dispatcher | Prevents concurrent `apply-edits` / parallel agent calls from racing on the same file (including case/symlink aliases) while keeping disjoint edits parallel. |
| **P1** | **Redacted Ring-Buffer `RequestLog` Wire Inspector + Chunk-Split-Safe `SseParser`** | `agy-fast/native/src/observatory.rs`, `telemetry.rs`, `webui.rs` | Feeds live TTFT, HTTP status, and secret-redacted wire request/response inspection directly into `agy-fast` Observatory & WebUI without leaking API keys or cookies. |
| **P1** | **Stateless-Process Sentinel Shell CWD + Env-Diff Persistence (`shell_session.rs`) + `find_git_bash` WSL skip** | `agy-fast/native/src/exec.rs` & `src/utils/exec-utils.ts` | Lets `agy-fast` fast-path shell commands preserve `cd`/env across invocations without heavy persistent PTY shells and avoids hitting `System32\bash.exe`. |
| **P1** | **Pure-Rust Zip-Bomb-Guarded `.docx`/`.xlsx`/`.pptx` + `.ipynb` Reader (`tools/office.rs`)** | `agy-fast/native/src/tools_read.rs` & `src/tools/read-slices.ts` | Enables instant native slicing/reading of Office documents and Jupyter notebooks inside `agy-fast`'s `read-slices` tool with zero external Python/Office dependencies. |
| **P2** | **Structured `git_conflicts` (`diff3`) + `git_resolve` + `git_status` (`--porcelain=v2 -z`) + `check_plain` anti-option-injection** | `agy-fast/native/src/gitflow.rs` | Strengthens `agy-fast`'s git workflow automation with structured conflict-hunk resolution and flag-injection safety. |
| **P2** | **`ChildEventIds` Outward-Only Subagent Namespacing + Unified `.claude-plugin` / Custom Slash Command Discovery (`$ARGUMENTS`/`$1..$9`) + `tokio::io::duplex` MCP Testutil** | `agy-fast` MCP/plugin bridge & `src/protocol/mcp.ts` | Enables clean multi-agent event routing, atomic `0x400`-safe plugin installation, and subprocess-free MCP protocol tests. |

---

## 6. Reject / Do-Not-Port List & Bugs Caught in `km-omnia-harness`

1. **REJECT `rusqlite` (`Cargo.toml`, `src/tools/sqlite.rs`)**: `D:\Omnia` strictly standardizes on `omnia-winsqlite` (`winsqlite3` FFI, WAL + cooperative process leases, zero bundled C amalgamation). Port the `sqlite_query`/`sqlite_execute` tool UX onto `omnia-winsqlite`, NEVER add `rusqlite`.
2. **REJECT `AskWrites` Default & Hardcoded Shell Prompts (`src/permission.rs`)**: Violates `D:\Omnia` Steer #22 (`ApprovalMode::Yolo` default + empty `PermissionsEngine::default_rules()`).
3. **REJECT Non-Null Default Token Caps**: `km`'s `TokenBudgetLedger` defaults to `None`, which aligns with `D:\Omnia`; never activate a default cap unless explicitly requested by the user.
4. **REJECT `src/tools/session_ipc.rs` (312L)**: Early prototype with 3 concrete defects caught during line-by-line audit:
   - Line 163 writes `from_session: ctx.tool_use_id.clone()` instead of `ctx.session_id`.
   - Lines 158 & 234 join untrusted `target_session_id` / `session_id` directly into `.omnia/sessions/` without path-traversal validation (`../`).
   - `SessionReadTool` declares `EffectClass::ReadWorkspace` (line 221) yet mutates/truncates `inbox.jsonl` when `drain: true` (lines 248–251).
   - `D:\Omnia`'s `PeerMeshGraph` (`omnia-graph`) + `SwarmRuntime` (`omnia-agent`) completely supersedes this.
5. **REJECT `km/src/tools/search.rs` & `km/src/tools/fs.rs` (`edit_file`) as replacements**: `D:\Omnia`'s Hybrid BM25F+Trigram+SIMD `search.rs`, BLAKE3 Merkle index, Tree-sitter CST `ast_edit.rs`, and Hashline v2 + 3-tier `imara-diff` Histogram `edit.rs` are strictly superior.
6. **REJECT `km/src/tools/web.rs` `WebFetchTool` as a replacement**: Lacks `D:\Omnia`'s SSRF/DNS-rebinding `EgressPolicy`, non-bypass CAPTCHA/auth challenge taxonomy, per-domain rate pacer, and academic connectors; also contains a doc/implementation mismatch (`spec()` line 262 claims `"Follows redirects"`, while `client()` line 29 sets `redirect::Policy::none()`).
7. **FIX BEFORE PORTING (4 Subtle Bugs Caught in `km`)**:
   - `tools/patch.rs` (`apply_patch`) omits `ctx.lock_file_mutation(&path)` — fix by acquiring sorted `FileMutationLocks` for all patch targets.
   - `tools/shell.rs` (`jobs()`), `tools/shell_session.rs` (`store()`), and `tools/todo.rs` (`store()`) use process-global `OnceLock<Mutex<HashMap<...>>>` maps with no session-eviction API — fix by scoping to `ToolRuntime`/session lifetime or adding explicit eviction.
   - `tools/shell.rs`, `lsp/client.rs`, and `mcp/stdio.rs` fall back to `taskkill /T /F /PID` instead of `hooks.rs`'s race-free `StartGate` + Windows Job Object — use `Omnia`'s `ProcessSupervisor` / `StartGate` uniformly.
   - `tools/artifact.rs` holds a process-wide `static LOCK: Mutex<()>` across disk I/O and doesn't check Windows reparse points on `.omnia/artifacts` parent — fix with per-session lock + `FILE_ATTRIBUTE_REPARSE_POINT (0x400)` guard.
