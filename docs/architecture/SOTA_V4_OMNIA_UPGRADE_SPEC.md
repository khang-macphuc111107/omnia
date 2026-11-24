# Omnia SOTA v4 Coding-Agent Super-Harness & Headless CLI Specification

**Target Crates:** `rust/omnia-agent/` (`omnia-agent`) and `rust/omnia-cli/` (`omnia.exe`)
**Scope:** Native Rust v4 upgrade closing all four `omp-omni v0.3` benchmark gaps (`A1:SWE`, `A6:Refact`, `A8:Speed`, `Cache Hit`) while preserving Omnia's zero-framework pure-Rust architecture (`0` Tauri/`rusqlite`/Node/Python runtime dependencies, `omnia-winsqlite` WAL storage, uncapped `token_budget = None` + `ADDITIVE_INTAKE` steer semantics, and external `CARGO_TARGET_DIR` builds).

---


## ACP persisted sessions

Omnia ACP advertises `agentCapabilities.loadSession` on stdio, WebSocket, and HTTP POST when the client requests `Accept: text/event-stream`. For HTTP clients, request SSE for `initialize`, `session/new`, and `session/load`; plain JSON POST cannot stream replay notifications and does not advertise loading. Clients should keep the `sessionId` returned by `session/new`. After restarting Omnia, initialize again, check `loadSession`, and send `session/load` with that ID and the original absolute `cwd`. Consume the replayed `session/update` notifications before handling the load result, then send the next `session/prompt` with the same ID; do not resubmit the old prompts. Checkpoints live outside the repository in the OS local application-data directory (`omnia-acp-sessions`), use UUIDv4-derived opaque IDs, a private directory and a single-writer lock, and bind each record to both its session UUID and canonical workspace path. Each checkpoint is written to a private temporary file before atomic replacement. A process killed before replacement can leave a UUID-named `.tmp` file containing conversation data. Recovery ignores temporary files; when erasing a session with the server stopped, remove any `<session-uuid>.*.tmp` files as well.

Each checkpoint records the provider/model identifier, turn counter, native conversation messages, and replayable ACP updates. Loading resolves that model against the new process’s configuration even when its default model has changed. Runtime endpoints, API keys, permission rules, approvals, grants, and trust state are never restored; a loaded session starts with fresh permission state and credentials supplied by the new process. Tool calls are validated as complete call/result pairs and invalid or interrupted journals are rejected rather than rewritten. A failed checkpoint poisons that journal for the rest of its lifetime, preventing a potentially stale checkpoint from silently being used after a side effect. Replay includes original user content blocks and finalized assistant text, thought, and tool call/result records; streaming chunk boundaries, notices, and telemetry are not restored. Checkpoints are plaintext under the local user account (Windows: inherited profile ACLs; Unix: directory 0700/files 0600). Known credentials are rejected; arbitrary sensitive text, attachments, and tool outputs can still be present. Disconnecting a WebSocket does not close its sessions: the running server retains the active session and its exclusive checkpoint lock. To reload on the same server, send `session/close` for the session ID first and let any active turn finish. Closing releases the lock once the last session reference drops, but retains the checkpoint for later `session/load`. To erase the saved conversation, stop the server before removing its UUID-named checkpoint and lock file from the OS-local `omnia-acp-sessions` directory. The ACP conversation checkpoint does not certify the separate filesystem undo store, so `session/rewind` rejects targets before the restored turn. The implementation currently has no migration for versioned checkpoint formats beyond rejecting unknown versions.

## 1. Crate Architecture

### 1.1 `omnia-agent` (23 Native Rust Modules)
- **Core Runtime & Safety:** `path_guard.rs` (fail-closed canonicalization, strict `\\?\<Drive>:\` verbatim-only check, UNC/NT device/NTFS ADS/Windows reserved device name blocks, NTFS reparse-point `0x0400` + dangling symlink containment), `permissions.rs` (deny-always-wins policy, fail-closed `ApprovalMode`, untrusted-repo shell gate), `supervisor.rs` (Win32 Job Object `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` zero-orphan subprocess management, provider API-key env stripping, `process_tree_rss_bytes`), `agent_store.rs` (pure `omnia-winsqlite` WAL store for Merkle cache, AST symbol cache, 20 MiB LRU BLAKE3+Deflate checkpoint blobs, turn checkpoints, and persistent ACE playbook).
- **Provider Streaming & Wire Routing:** `engine.rs` (multi-dialect SSE streaming across OpenAI `/v1/chat/completions`, OpenAI `/v1/responses`, Anthropic `/v1/messages` with consecutive-user merge & `redacted_thinking`, and Gemini `generateContent` over `x-goog-api-key` header; non-pooled fresh-socket retry client; default-on bounded pre-TTFT hedging), `sap_json.rs` (Rust BAML Schema-Aligned Parsing partial-JSON tool-call repair & schema coercion), `cache_guard.rs` (4-tier Prefix-0 BLAKE3 KV-cache invariant checker & usage tracker), `trajectory.rs` (append-only JSONL trajectory & telemetry logger), `sanitizer.rs` (CaMeL/Spotlighting/Unicode Tag/Bidi/exfiltration filter + `redact_secrets`).
- **Code Intelligence & Adaptive Editing:** `edit.rs` (`ModelEditAffinity` adaptive edit router, Hashline v2 `line:xxhash|`, Tree-sitter syntactic `BlockDiff`, 3-tier fuzzy fallback `0.95/0.92/0.80`, post-edit AST syntax delta + fast `py_compile`/`node --check` compiler diagnostics), `patch.rs` (atomic multi-file `apply_patch` via `imara-diff`), `graph_locator.rs` + `git_forensics.rs` (Tree-sitter `0.25` 5-grammar CST + 4-relation CSR code graph + `search_entity` / `traverse_graph` / `symbols_in_file` + Personalized PageRank RepoMap + pure-Rust Git Jaccard co-change), `search.rs` (BM25F + Zoekt trigram + SIMD + Reciprocal Rank Fusion), `merkle.rs` (BLAKE3 dirty-path Merkle index), `lsp.rs` (zero-startup-cost `LazyLspManager` over JSON-RPC 2.0 stdio with strict path containment & deterministic AST fallback).
- **Context, Loop Control & Interop:** `lakeview.rs` (context-scaled epoch observation masking, `>4 KB` secret-redacted scratch spill, Factory Anchored Iterative Summarization, and `OscillationDetector`), `checkpoint.rs` (BLAKE3+Deflate atomic `/rewind` checkpoints + `TestOutcomeTransition` Anti-Termination-Lag tracking), `context.rs` (lean non-standard rules + Turn-1 RepoMap skeleton), `plugin.rs` + `tools.rs` (static core tools, 4 MiB read safety cap, KV-invariant `DeferredToolRegistry` wired to built-in semantic tools `lsp_query`, `graph_traverse`, `search_entity` and external extension handlers), `acp.rs` + `lib.rs` (`SuperHarnessManager` + concurrent-cancel `run_acp_stdio_server` JSON-RPC 2.0 ACP server).

### 1.2 `omnia-cli` (`omnia.exe`)
- Global allocator: `#[global_allocator] mimalloc::MiMalloc`.
- Strictly headless dependency graph (`anyhow`, `mimalloc`, `omnia-agent`, `serde_json`, `tokio` — zero GUI, Studio, Downloader, Notebook, `omnia-core`, or `chrono` dependencies).
- Supported subcommands & flags:
  - `omnia run --workspace <dir> --model <id> --base-url <url> [--api-key <key>] [--wire-api auto|chat|responses|messages|gemini] --output-format stream-json|json|text --auto-approve [--max-turns N] [--timeout-secs S] "<prompt>"` (env fallbacks: `OMNIA_API_KEY`, `HTMUSTC_API_KEY`, `OPENAI_API_KEY`, `OMNIA_BASE_URL`, `OMNIA_HOME`).
  - `omnia rewind --workspace <dir> --turn <n>`
  - `omnia --version`
  - `omnia --profile-startup`
  - `omnia --acp`

---

## 2. Root-Cause Closure Matrix (`omp-omni v0.3` -> `Omnia SOTA v4`)

| Benchmark Gap (`v0.3`) | Verified Root Cause | Omnia SOTA v4 Fix | Implementation Site |
|---|---|---|---|
| **`A8:Speed` (`34.6` vs `57.7`)** & **34/65 `300s` timeouts** | SSE `: ping` keepalive frames reset `inter_chunk_timeout`, causing 196–226s hung turns (`stall_retries=0`); `gen_tps` divided by stall-polluted `gen_dur_ms`; malformed tool JSON burned full round-trips. | **Token-Progress SSE Watchdog** (`last_meaningful_delta_at`, immune to empty lines & `: ping`; `22s` fast / `45s` reasoning pre-delta, `25s` post-delta, `90s` hard per-turn deadline, `Connection: close` fresh-socket retry), **Pre-TTFT Bounded Hedging** (`<= 5%` budget, immediate loser cancel), **Rust SAP Partial-JSON Repair**, honest dual `active_decode_tps` & `e2e_tps`. | `engine.rs` (`compute_token_progress_wait`, `stream_*_turn`), `sap_json.rs` |
| **`Cache Hit` (`83.0%` vs `89.6%`)** | Flat `44,000`-char Lakeview watermark prematurely busted 1M-ctx prefixes; `prompt_cache_key` gated to `gpt-*` only; Claude routed over OpenAI-compat without explicit breakpoints. | **Strict 4-Tier Prefix-0 Layout** (static sorted Tier 0 -> lean Tier 1 -> append-only Tier 2 -> tail-only Tier 3), session-stable `prompt_cache_key` & `X-Session-Id` on **all** families, native Anthropic `/v1/messages` with **3-breakpoint `cache_control: {"type": "ephemeral"}`** (+ automatic `404/405/501` fallback to `/v1/chat/completions`), **Context-Scaled Lakeview** (`W_soft = min(0.45 * ctx_chars, 280_000)`) + Stage 1 `>4 KB` spill + Stage 2 **Factory Anchored Iterative Summarization**. | `cache_guard.rs`, `engine.rs`, `lakeview.rs` |
| **`A1:SWE` (`45%` vs `64%`)** & **Gemini Flash reasoning burn** | `gpt-6.2-sol` Turn-1 empty-stop after 214–221s hang; Gemini Flash burned 55–70% output on unconstrained thinking + `>8k` guard skipped when edits/shell ran; missing `thought_signature` round-trip; post-pass churn. | **2-Stage Empty-Thinking Recovery** + Unicode-normalized (`U+2019` -> `'`) narration-only stop guard; **Adaptive Gemini `reasoning_effort`** (`"medium"` default, escalating to `"high"` on error), verbatim `thought_signature`/`thoughtSignature` preservation, unconditional `>8,000`-token reasoning blowup guard; **Anti-Termination-Lag** (`FAIL -> PASS` immediate stop eligibility) + `OscillationDetector` (`S_t == S_{t-2}` repo hash cycle, exact repeat, zero-mutation churn); persistent SQLite ACE Playbook covering both `shell` and `edit_file`/`apply_patch`. | `engine.rs`, `checkpoint.rs`, `lakeview.rs`, `agent_store.rs` |
| **`A6:Refact` (`38%` vs `50%`)** & **Unwired D2/D7 features** | Text-only search missed cross-file symbols/callers; single edit mode caused format misuse; `DeferredToolRegistry` was a dead-end error; `/rewind` had zero callers. | **Adaptive Multi-Mode Edit Engine** (`ModelEditAffinity`: Hashline v2 default, UnifiedDiff for DeepSeek/Codex, Tree-sitter `BlockDiff` symbol edit, 3-tier fuzzy fallback, atomic `apply_patch`, post-edit AST + `py_compile`/`node --check` compiler delta); **LocAgent** `search_entity` / `traverse_graph` + **Lazy On-Demand LSP** (`0ms` cold start) wired into `DeferredToolRegistry`; `PASTE`-lite speculative read pool; public `/rewind` on `NativeSuperEngine`, `SuperHarnessManager`, and `omnia rewind`. | `edit.rs`, `patch.rs`, `graph_locator.rs`, `lsp.rs`, `plugin.rs`, `tools.rs`, `lib.rs` |

---

## 3. Verified 2025–2026 Evidence & Citation Index

All papers and primary engineering references below were verified HTTP 200 against primary sources (`export.arxiv.org`, publisher blogs, and GitHub APIs) during Phase 1 research:

1. **Harness Anatomy & Ablation Laws:**
   - Barbaste et al. (Jul 2026), *Production Coding-Agent Harness Anatomy*, `arXiv:2609.00006` (0/11 production harnesses use agent frameworks or vector DBs; convergence on hand-rolled async loops, deterministic lexical/AST retrieval, `SKILL.md`, ACP).
   - Vats & Golev (Jun 2026), *The 40x Scaffold Effect*, `arXiv:2607.22585` (up to 40x token variance across harnesses on identical models; harness-level `REASON`, `VERIFY/MAX_TURNS`, and `idle-loop/TIME` failure fingerprints).
   - Fan et al. (Sep 2026), *Component Ablation in Coding Agents*, `arXiv:2609.20804` (rule-based observation masking before LLM summarization maximizes efficiency; elided-content recovery yields 0 accuracy gain).
   - Gloaguen et al. / ETH Zurich (Feb 2026), *Repo Context File Cost Tax*, `arXiv:2602.11988` (bloated `AGENTS.md` files add >20% inference cost without reliable solve-rate gain; load only lean non-standard rules).
2. **Adaptive Editing & Structural Retrieval:**
   - Can Bölük (Feb 2026), *The Harness Problem* (`https://stencil.so/blog/the-harness-problem`) — Hashline v2 (`line:xxhash|`) beats `apply_patch` on 14/16 models (+15 pts avg, -21% to -61% output tokens).
   - Yang (Jul 2026), *Model-Aware Edit Format Affinity*, `arXiv:2607.21674`; Glukhov et al. / JetBrains (Oct 2025), *Diff-XYZ*, `arXiv:2510.12487` (DeepSeek/Codex native diff affinity vs Hashline/replace affinity).
   - Cheng et al. (Apr 2026), *BlockDiff / FuncDiff / AdaEdit*, `arXiv:2604.27296` (syntactic Tree-sitter block rewrites cut latency and cost >30% on long files).
   - Chen et al. (ACL 2025), *LocAgent*, `arXiv:2503.09089`; Ouyang et al. (ICLR 2025), *RepoGraph*, `arXiv:2410.14684` (directed heterogeneous code graph + multi-hop traversal reaches 92.7% file localization at -86% cost).
3. **KV-Cache Invariance, Context Compression & Progressive Disclosure:**
   - Yichao Ji / Manus (Jul 2025), *Context Engineering for AI Agents* (`https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus`) — strict Prefix-0 stability, append-only turns, external file offloading, preserving error traces.
   - Hong et al. / Chroma (Jul 2025), *Context Rot* (`https://www.trychroma.com/research/context-rot`) — frontier model degradation prior to max window.
   - Lindenbauer et al. / JetBrains & TUM (Aug 2025), *Observation Masking*, `arXiv:2508.21433` (~84% observation share; rule-based masking halves cost).
   - Factory (Dec 2025), *Evaluating Context Compression* (`https://factory.com/news/evaluating-compression`) — Anchored Iterative Summarization outperforms rolling full re-summarization on artifact recall.
   - Sadani & Kumar (Apr 2026), *Tool Attention*, `arXiv:2604.21816` — KV-invariant progressive tool disclosure cuts schema overhead 95–99%.
4. **Speculative Parallelism, Loop Control, Resilience & Streaming Repair:**
   - Sui et al. (Mar 2026), *PASTE*, `arXiv:2603.18897`; Kim et al. (2023), *LLMCompiler*, `arXiv:2312.04511` (mid-SSE speculative read-only execution cuts completion latency up to 43.5%).
   - Cim et al. (Nov 2026), *Termination Lag*, `arXiv:2611.14960` (35–60% wasted post-solution steps and 1–8% self-regression prevented via deterministic `FAIL -> PASS` convergence signaling).
   - Hou et al. (Jul 2026), *IAL-Scan*, `arXiv:2607.01641` (ring-buffer oscillation and repo-state cycle detection).
   - Dean & Barroso, *The Tail at Scale* (`https://research.google/pubs/the-tail-at-scale/`) — bounded pre-TTFT hedged requests.
   - BoundaryML, *Schema-Aligned Parsing (SAP)* (`https://boundaryml.com/blog/schema-aligned-parsing`) — zero-roundtrip partial/malformed tool-call JSON repair and schema coercion.

---

## 4. Exported Public API Surface (For Wave 3 Studio / Runtime Wiring)

`omnia-agent` exports the following primary integration types for `omnia-studio`, `omnia-runtime`, and `omnia-cli`:
- `SuperHarnessManager::{new, spawn_session, send_prompt, rewind_to_turn, respond_confirm, abort_session, set_model, get_state, list_running, cache_stats, merkle_status, graph_map}` + `ManagedSpawnRequest`
- `NativeSuperEngine`, `run_super_eval`, `run_acp_stdio_server`
- `WireApiMode` (`Auto`, `Chat`, `Responses`, `Messages`, `Gemini`)
- `SuperEvalOptions`, `SuperEvalReport`, `HarnessStreamEvent`, `HarnessEventSink`, `PromptRunSummary`, `StreamBudgetConfig`
- `AgentStore` (pure `omnia-winsqlite` WAL backend), `PermissionsEngine`, `ApprovalMode`, `validate_workspace_dir`, `redact_secrets`
- `WorkspaceGraphIndex`, `EntitySearchHit`, `GraphTraversalReport`, `LazyLspManager`
- `ModelEditAffinity`, `edit_file_by_symbol_block`, `run_fast_compiler_syntax_check`
- `AnchoredSummary`, `OscillationDetector`, `OscillationAlert`, `TestOutcomeTransition`, `TurnCheckpointStore`
- `repair_tool_json`, `SapRepairResult`
