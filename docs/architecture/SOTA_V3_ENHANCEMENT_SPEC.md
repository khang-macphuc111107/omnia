# `omp-omni v0.3.0` — Frontier Late-2026 SOTA Systems & Agentic Harness Enhancement Specification

- **Target Codebase:** `C:\Users\khang\.gemini\antigravity\scratch\omp-omni\` (`v0.2.0` -> `v0.3.0`)
- **Target Toolchain & Host:** Rust `1.100.0` (Windows 11 Pro x86_64 MSVC, Intel Core i5-10300H 4C/8T, 16 GB RAM, zero Docker, zero Electron)
- **Empirical Baseline Audited:** `FINAL_SCOREBOARD_V2.md` (260 matched Tier-1 runs + 66 `omni-super v0.2.0` raw JSONs & `.trajectory.jsonl` traces)
- **Primary Engineering Goal:** Upgrade `omp-omni` from `v0.2.0` (`30.8%` Pass@1, `C7=30.84`, `I10=41.95`) to **decisively outperform `goose v1.60.2` (`53.9%` Pass@1, `C7=52.27`, `I10=58.05`)** across **Capability (C7 > 60%)**, **Speed (A8 > 65)**, **Economics (A9 > 70, Cache Hit >= 92%)**, and **Resource Footprint (A10 >= 99, `< 18 MB` single binary, `< 55 MB` live execution Peak RSS, `0` orphans)**.

---

## 1. Forensic Root-Cause Audit of `omp-omni v0.2.0` Benchmark Failures

An exhaustive forensic audit of all **66 live `omni-super v0.2.0` runs** (`20` PASS, `46` non-PASS: `38` timeouts + `8` early `completed` hard FAILs, plus `7` passing runs that still hit `300.0s`) and their sibling `.trajectory.jsonl` event streams exposed **7 concrete, quantifiable root causes** explaining the entire `-23.1pp` Pass@1 gap behind `goose`:

### 1.1 Quantified Failure Taxonomy (All 46 Non-Passing Runs + 7 `300s` Passes)

| Root Cause ID | Codebase Location (`v0.2.0`) | Empirical Evidence Across 66 Live Runs | Primary Models / Axes Hit |
|---|---|---|---|
| **RC-1: Unbounded HTTP Header & SSE Chunk Waits (`0` Retries)** | `engine.rs:1125-1127`, `engine.rs:1176-1184` | **37/46 failures (80.4%)** + **7/20 passing runs** hit `300.0s`: **12 runs** hung in `req.send()` (`Timed out connecting to...`, up to `298.1s`) and **25 runs** hung in `stream.next()` (`Timed out waiting for SSE chunk`, up to `297.8s`). **`http_retries = 0` across all 65 Tier-1 runs** because both timeouts use the *entire remaining task budget* (`timeout_dur` / `rem`) and map to `StreamTurnError::Fatal` instead of `Retryable`. Turn latencies show quantized ~32s upstream proxy stalls (`32s, 65s, 96s, 130s, 165s, 228s, 258s, 285s`), driving T2 median to **`130.7s`** (`claude-sonnet-5-5`), **`112.7s`** (`claude-opus-5-5`), and **`85.7s`** (`gpt-6.2-sol`) vs `2.4–3.9s` on T1! | All 5 models; `gpt-6.2-sol` (`0/3` Algo), `claude-sonnet-5-5` (`9/17` TO), `gemini-*` |
| **RC-2: Silent Acceptance of Truncated SSE Streams (`finish_reason = None`)** | `engine.rs:1176-1316` | **15 `llm_response` turns across 10 failed runs** terminated with `finishReason: null`, `outputTokens: 0`, `toolCallCount: 0` (upstream closed TCP/SSE early right after emitting preamble text). `stream_openai_turn` never checked `saw_done` or `finish_reason.is_some()` and returned `Ok(...)`. This directly caused **5 of the 8 `completed` hard FAILs (62.5%)**: `claude-opus-5-5/algo_01`, `claude-sonnet-5-5/{algo_02, algo_03, atlas_01, heal_02}`! | `claude-sonnet-5-5`, `claude-opus-5-5`, `gpt-6.2-sol` |
| **RC-3: Zero Runtime Self-Verification Gate & Narration-Stop Guard** | `engine.rs:742-789` | The remaining **3 of 8 `completed` hard FAILs (37.5%)** (`claude-sonnet-5-5/{atlas_02, bfcl_02, term_02}`) returned `finishReason: "stop"`, `toolCallCount: 0`, and text announcing future actions (*"I'll read the two permitted guidance files..."*, *"so I'm reading their exact contents..."*). `Empty-Thinking Recovery` only checks `turn_res.text.trim().is_empty()`, and `self_verify_gate` is purely passive text in `BASE_SYSTEM_PROMPT` with **zero runtime enforcement**! | `claude-sonnet-5-5`, `A4:Atlas`, `A5:BFCL`, `A2:Term` |
| **RC-4: Dropped Interleaved Thinking (`reasoning_content`) & Unbounded Reasoning Blowup** | `engine.rs:1853-1891` (`message_to_openai_json`), `engine.rs:1110-1117` | `message_to_openai_json` completely strips `m.reasoning` on every tool round-trip. On multi-step diagnostic tasks, Gemini reasoning models suffer **interleaved-thinking amnesia** and re-derive the entire codebase analysis from scratch every turn: e.g., `gemini-4-carbon/heal_01` exploded T5 `11,271` -> T6 `22,373` -> T7 `27,103` reasoning chars (**242s burned thinking, 0 edits written!**); `gemini-3.8-flash/algo_01` burned **`30,453` reasoning tokens vs `166` visible tokens**; `swe_01` burned `15,721` reasoning tokens with `0` edits! | `gemini-3.8-flash`, `gemini-4-carbon`, `A7:Heal` (`0/8`), `A3:Algo` (`1/11`) |
| **RC-5: Forced Turn-1 `workspace_map` Tax + Single-File Read Friction + Weak `search_code`** | `cache_guard.rs:19`, `tools.rs:216-291`, `tools.rs:471-562` | **63/65 runs** (100% of `claude-sonnet-5-5` & `gpt-6.2-sol`) burned Turn 1 calling ONLY `workspace_map` because `BASE_SYSTEM_PROMPT` explicitly ordered it — even though `context.rs` already injected `files_preview`. Worse, `read_file` accepts only a single `path`, causing `13–18` read calls before a single edit on `heal_01`/`heal_02`/`atlas_02` (vs Goose batching 4–6 files via shell/read in Turn 2 and editing by Turn 3). Meanwhile, `search_code` was called only **4 times across 65 runs** because it lacks AST symbol search, BM25F ranking, and context lines. | `A7:Heal` (`0/8`), `A6:Refact` (`2/8`), `claude-sonnet-5-5`, `gpt-6.2-sol` |
| **RC-6: Dormant Lakeview (`0` compressions), Dormant Loop Guard (`0` nudges), & `84.3%` Cache Hit** | `lakeview.rs:14-18, 132-175, 248-286`, `engine.rs:1389-1398` | `lakeview_compressions = 0` and `loop_nudges = 0` across all 65 runs. When `total_chars >= 64_000` *does* trigger in-place sliding-window mutation (`turn < cur - 6`), mutating a moving index every turn **breaks KV prefix caching**! `RepetitionLoopGuard` only catches exact identical `(tool, sha256(args))` repeated 3×, missing semantic loops (same `ModuleNotFoundError`/`AssertionError` across varying commands). Anthropic API path only puts `cache_control` on `system`, omitting tool-schema & rolling conversation breakpoints. | Long-horizon runs (`15–25` turns), `A9` Economics |
| **RC-7: Regex-Only Graph, SHA-256 Full Dir Rehash, No Hashlines, & Win32 `HeapAlloc`** | `graph_locator.rs:313-461`, `merkle.rs:146-190`, `edit.rs:209-296`, `tools.rs:840` | `graph_locator.rs` uses brittle line regexes (misses call edges, inheritance, nested methods, TS arrow exports, Rust `impl` blocks) and ranks purely by naive in-degree instead of Personalized PageRank. `merkle.rs` hashes sequentially with SHA-256, rehashes *every* directory on every refresh ($O(F + D)$ instead of $O(\Delta \log D)$), and has zero SQLite persistence. `edit.rs`/`patch.rs` lack content-addressable Hashline anchors and Histogram/Patience fuzzy hunks. `tools.rs:840` busy-sleeps 20ms per shell poll. | Large repos, multi-file refactors (`A6:Refact`), edit accuracy, RSS/CPU efficiency |

> **Why `claude-sonnet-5-5` & `claude-opus-5-5` reported `1.3–2.3 tok/s` Gen TPS in v0.2.0:**
> In `engine.rs:1251-1257`, `first_delta_at` is stamped on the first 1–2 byte preamble/reasoning chunk, then the upstream proxy stalls for `60–153s` before emitting the final tool_call chunk (`last_delta_at`), yielding `stream_span_ms = 90,604 ms` for `48` tokens (`0.53 tok/s`)! Fixing **RC-1** (per-chunk SSE stall timeout + fresh-socket retry) and **RC-2** (stream-integrity validation) simultaneously eliminates the 32s-multiple stalls and restores true `40–90+ tok/s` effective throughput.

---

## 2. Verified 2025–2026 Frontier Scientific & Open-Source Citations

Every paper, specification, and repository below was live-verified (`HTTP 200` via `export.arxiv.org` API / GitHub / official URLs on `2026-11-22`):

| # | Work / Framework | Year & Venue | Verified Live URL | Core Algorithmic Contribution Adopted in `v0.3.0` |
|---|---|---|---|---|
| 1 | **LocAgent**: *Graph-Guided LLM Agents for Code Localization* (Chen et al.) | 2025 (`arXiv:2503.09089`, ACL 2025) | https://arxiv.org/abs/2503.09089 · https://github.com/gersteinlab/LocAgent | Directed heterogeneous code graph (files, classes, functions; `contains`, `imports`, `invokes`, `inherits`) + sparse multi-hop graph traversal & BM25 search |
| 2 | **GraphLocator**: *Graph-guided Causal Reasoning for Issue Localization* (Liu et al.) | Dec 2025 (`arXiv:2512.22469`) | https://arxiv.org/abs/2512.22469 | Bridges symptom-to-cause and one-to-many mismatches via causal ego-subgraph expansion over code dependencies |
| 3 | **OrcaLoca**: *An LLM Agent Framework for Software Issue Localization* (Yu et al.) | Feb 2025 (`arXiv:2502.00350`) | https://arxiv.org/abs/2502.00350 · https://github.com/fishmingyu/OrcaLoca | Distance-aware context pruning + relevance-scored action queue over call/import neighborhoods |
| 4 | **CoSIL**: *Issue Localization via LLM-Driven Iterative Code Graph Searching* (Jiang et al.) | Mar 2025 (`arXiv:2503.22424`) | https://arxiv.org/abs/2503.22424 | Dynamic on-the-fly module call-graph pruning to keep function-level localization context compact |
| 5 | **RepoGraph**: *Enhancing AI Software Engineering with Repository-level Code Graph* (Ouyang et al.) | Oct 2024 / ICLR 2025 (`arXiv:2410.14684`) | https://arxiv.org/abs/2410.14684 | `tree-sitter` AST definition/reference extraction + k-hop ego-graph retrieval for SWE-bench agents |
| 6 | **Aider RepoMap** (Paul Gauthier) | 2024–2026 (Open-Source) | https://github.com/Aider-AI/aider | `tree-sitter` tag graph + **Personalized PageRank (PPR)** with binary-search token-budget packing |
| 7 | **Reciprocal Rank Fusion (RRF)** (Cormack, Clarke & Buettcher) | SIGIR 2009 (2025–2026 Hybrid Standard) | https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf | Training-free score-scale-invariant rank fusion $\sum_r (k + \text{rank}_r(d))^{-1}$ ($k=60$) for BM25F + trigram + symbol retrieval |
| 8 | **The Harness Problem & Hashline** (Can Bölük, `oh-my-pi`) | Feb 2026 | https://stencil.so/blog/the-harness-problem · https://github.com/can1357/oh-my-pi | Content-addressed per-line anchors (`42:a3f\| code`) eliminating whitespace/patch mismatch failures & cutting edit token waste |
| 9 | **The Complexity Trap**: *Simple Observation Masking Is as Efficient as LLM Summarization* (Lindenbauer et al., JetBrains Research & TUM) | Aug 2025 / NeurIPS 2025 DL4Code (`arXiv:2508.21433`) | https://arxiv.org/abs/2508.21433 | Tool observations are ~84% of agent tokens; deterministic observation masking halves cost while matching/beating LLM summarization |
| 10 | **ACON**: *Optimizing Context Compression for Long-horizon LLM Agents* (Kang et al.) | Oct 2025 (`arXiv:2510.00615`) | https://arxiv.org/abs/2510.00615 | Failure-informed selective retention rules (preserve error tracebacks, edited file state, and causal evidence; drop redundant exploration noise) — 26–54% peak token reduction |
| 11 | **Context-Folding / FoldAgent**: *Scaling Long-Horizon LLM Agent via Context-Folding* (Sun et al., ByteDance Seed / CMU / Stanford) | Oct 2025 (`arXiv:2510.11967`) | https://arxiv.org/abs/2510.11967 · https://github.com/sunnweiwei/FoldAgent | Epoch-aligned prefix rollback/folding preserving KV prefix cache stability across long multi-step coding trajectories |
| 12 | **Active Context Compression (Focus)** (Nikhil Verma) | Jan 2026 (`arXiv:2601.07190`) | https://arxiv.org/abs/2601.07190 | Autonomous consolidation of verified findings into compact state blocks before pruning raw exploration traces |
| 13 | **ActKV**: *Efficient LLM Agents through Action-Guided KV Cache Management* (Wang et al.) | Sep 2026 (`arXiv:2609.31395`) | https://arxiv.org/abs/2609.31395 | Action-oriented retention scoring: protect tokens directly governing upcoming executable edits/tests over stale read-only noise |
| 14 | **SWE-Search**: *Enhancing Software Agents with Monte Carlo Tree Search and Iterative Refinement* (Antoniades et al.) | Oct 2024 / ICLR 2025 (`arXiv:2410.20285`) | https://arxiv.org/abs/2410.20285 | Execution-feedback-guided iterative refinement & backtracking (+23% relative SWE-bench lift) |
| 15 | **Thinking Longer, Not Larger** (Ma et al.) & **Scaling Test-Time Compute for Agentic Coding** (Kim et al.) | Mar 2025 (`arXiv:2503.23803`) & Apr 2026 (`arXiv:2604.16529`) | https://arxiv.org/abs/2503.23803 · https://arxiv.org/abs/2604.16529 | Execution-verified decision checkpoints & structured failure-mode trajectory summaries guiding sequential refinement |
| 16 | **BLAKE3 Cryptographic Hash Specification** (O'Connor et al.) | 2020–2026 (SIMD Merkle Standard) | https://raw.githubusercontent.com/BLAKE3-team/BLAKE3-specs/master/blake3.pdf · https://github.com/BLAKE3-team/BLAKE3 | Intrinsic 1 KiB-chunk binary Merkle tree + AVX2/SSE4.1 SIMD (`5–10×` faster than SHA-256 on x86_64) |
| 17 | **Mimalloc: Free List Sharding in Action** (Leijen, Zorn & de Moura, Microsoft Research) | 2019–2026 (`mimalloc 0.1.52`) | https://www.microsoft.com/en-us/research/publication/mimalloc-free-list-sharding-in-action/ · https://github.com/purpleprotocol/mimalloc_rust | Per-page sharded free lists eliminating Windows `HeapAlloc` lock contention and reducing fragmentation under multi-threaded AST/JSON workloads |
| 18 | **Imara-Diff** (Histogram / Patience Diff in Rust) & **SOTA Reference Harnesses** (`mini-swe-agent`, `codex`, `goose`, `ripgrep`) | 2024–2026 | https://github.com/pascalkuthe/imara-diff · https://github.com/SWE-agent/mini-swe-agent · https://github.com/openai/codex · https://github.com/aaif-goose/goose · https://github.com/BurntSushi/ripgrep | Linear-space Myers + Git Histogram diff avoiding worst-case slowdowns; token-minimal `<1.5k` harness prompt budgets; `.gitignore`-aware SIMD search |

---

## 3. Verified Rust Crate Dependency Plan (`rustc 1.100.0`, Windows 11 MSVC)

All versions below were verified `HTTP 200` on `crates.io` (`2026-11-22`) with exact non-optional transitive dependency auditing so **zero LLVM/`bindgen`/`wasmtime` dependencies** enter the build graph:

### 3.1 Already in `Cargo.lock` (Zero Extra Compile Time / Zero Binary Bloat)

| Crate | Locked Version | Used For in `v0.3.0` |
|---|---|---|
| `memchr` | `2.8.3` | AVX2/SSE2 SIMD substring search (`memmem::Finder`), newline counting (`memchr_iter`) in `edit.rs`, `search.rs`, `tools.rs` |
| `aho-corasick` | `1.1.5` | Multi-keyword SIMD simultaneous scanning (diagnostic signal extraction in `lakeview.rs`, multi-literal search in `search.rs`) |
| `regex` | `1.13.2` | Fallback regex engine in `search.rs` (after trigram pre-filtering!) |
| `rustc-hash` | `2.1.3` | `FxHashMap` / `FxHashSet` (2–3× faster non-cryptographic integer/trigram/node hashing in `graph_locator.rs` & `search.rs`) |
| `rusqlite` (`bundled`) | `0.37.0` | Persistent SQLite WAL cache for BLAKE3 Merkle entries + extracted AST symbols (`omni-db`) |
| `cc` | `1.11.3` | Already compiles bundled SQLite C sources via MSVC `cl.exe`; compiles `tree-sitter` grammars & `mimalloc` C cleanly |

### 3.2 New Crates to Add to Workspace `Cargo.toml`

| Crate | Exact Version Req | MSRV | Non-Optional Build/Runtime Deps | Est. Release Binary Delta | Purpose |
|---|---|---|---|---:|---|
| `blake3` | `"1.8"` (`1.8.7`) | 1.65 | Pure Rust + SIMD intrinsics (no C required!) | `+65 KB` | SIMD Merkle leaf/directory hashing + cache keys |
| `imara-diff` | `"0.2"` (`0.2.0`) | 1.71 | Zero heavy deps (pure Rust) | `+40 KB` | Histogram/Myers diff for Tier-3 fuzzy patch matching & compact post-edit unified diff output |
| `xxhash-rust` | `{ version = "0.8", features = ["xxh3"] }` (`0.8.21`) | 1.60 | Zero deps (pure Rust `no_std`) | `+15 KB` | Ultra-fast 12-bit Hashline per-line content anchors (`42:a3f\|`) |
| `ignore` | `"0.4"` (`0.4.34`) | 1.88 | `walkdir`, `globset`, `crossbeam-deque` | `+110 KB` | `.gitignore`-aware parallel workspace walker (replaces naive recursion in `merkle.rs` & `tools.rs`) |
| `tree-sitter` | `"0.25"` (`0.25.10`) | 1.76 | `cc`, `regex`, `streaming-iterator`, `tree-sitter-language = "^0.1"` (**NO `bindgen`!**) | `+180 KB` | Incremental concrete syntax tree parser runtime |
| `tree-sitter-python` | `"0.25"` (`0.25.0`) | — | `cc`, `tree-sitter-language = "^0.1"` | `+380 KB` | Real Python AST symbols, imports, calls, inheritance |
| `tree-sitter-javascript` | `"0.25"` (`0.25.0`) | — | `cc`, `tree-sitter-language = "^0.1"` | `+290 KB` | Real JS/JSX AST symbols, ESM/CJS imports, calls |
| `tree-sitter-typescript` | `"0.23"` (`0.23.2`) | — | `cc`, `tree-sitter-language = "^0.1"` | `+620 KB` | Real TS/TSX AST (`LANGUAGE_TYPESCRIPT` + `LANGUAGE_TSX`) |
| `tree-sitter-rust` | `"0.24"` (`0.24.2`) | — | `cc`, `tree-sitter-language = "^0.1"` | `+480 KB` | Real Rust AST (`fn`, `struct`, `enum`, `trait`, `impl`, `use`, `mod`, calls) |
| `tree-sitter-go` | `"0.25"` (`0.25.0`) | — | `cc`, `tree-sitter-language = "^0.1"` | `+310 KB` | Real Go AST (`func`, methods, types, imports, calls) |
| `mimalloc` | `{ version = "0.1", default-features = false }` (`0.1.52`) | — | `libmimalloc-sys` (`cc`, Windows-native) | `+160 KB` | Windows 11 `#[global_allocator]` in `src-tauri/src/main.rs` |

> **Binary Size Budget Check:** `v0.2.0` `omp-omni.exe` = `13.69 MB`. Total estimated addition for **all** `v0.3.0` SOTA crates (including 5 full compiled `tree-sitter` grammars + BLAKE3 + Imara-Diff + `ignore` + `mimalloc`) with `lto = "thin"`, `strip = "symbols"`, `opt-level = 3` is **`~2.65 MB`**, keeping `omp-omni.exe v0.3.0` at **`~16.3 MB`** (still **38× smaller** than Goose Desktop `630.59 MB` and well below `< 18 MB` target!).
> **ABI Compatibility Note:** Pinning `tree-sitter = "0.25"` guarantees `tree-sitter-language = "0.1"` ABI 13–15 compatibility across all 5 language grammar crates with zero duplicate `tree-sitter` major versions. *(C/C++ stays on enhanced zero-bloat lexical/bracket scanner unless `tree-sitter-c = "0.24"` is explicitly opted in, saving ~400 KB.)*

---

## 4. Detailed Algorithm & Data-Structure Blueprint (`v0.3.0` Pillars)

### Pillar A (P0) — Split-Budget Resilient SSE Transport, Interleaved Thinking & Execution-Guided Loop (`crates/omni-harness/src/engine.rs`)

Directly resolves **RC-1 (37 timeouts)**, **RC-2 (5/8 hard FAILs)**, **RC-3 (3/8 hard FAILs)**, **RC-4 (Gemini thinking blowup)**, and **RC-7 (`1.3–2.3 tok/s` stall collapse)**.

#### A.1 Split-Budget HTTP/SSE Stall Detection & Stream-Integrity Contract
Replace the single `timeout_dur` wrapper in `stream_openai_turn`, `stream_anthropic_turn`, and `stream_gemini_turn` with **3 independent bounded budgets**:
1. **Header / TTFT Timeout (`header_timeout`):** `min(remaining, 35s)` on `req.send()` (up to `50s` for `opus`/`gpt-6.2`/`gemini-4` on turns with `context_tokens > 32k`). If `req.send()` expires -> return **`StreamTurnError::Retryable`** (NOT `Fatal`!), close/evict socket by attaching `.header("Connection", "close")` on retry attempt `>= 1` so the proxy routes the retry to a fresh healthy upstream worker!
2. **Per-Chunk SSE Idle Watchdog (`chunk_idle_timeout`):** `min(remaining, 35s)` on `stream.next()` (extended to `50s` ONLY if `first_delta_at.is_none()`, i.e., waiting for first token after HTTP 200 headers while upstream thinks; once tokens start flowing, `30s` strict stall timeout). If `stream.next()` idles past the watchdog -> abort stalled socket and return **`StreamTurnError::Retryable`**!
3. **Strict Stream-Completion Integrity Proof (`saw_done || finish_reason.is_some()`):**
   - Track `let mut saw_done = false;` when `data == "[DONE]"` (OpenAI) or `"message_stop"` (Anthropic) or `candidates[0].finishReason` (Gemini).
   - At stream EOF: if `!saw_done && finish_reason.is_none()` (and `tool_calls.is_empty()` OR any tool call has unparseable truncated JSON arguments) -> return **`StreamTurnError::Retryable { detail: "Truncated SSE stream EOF before finish_reason/[DONE]" }`**!
   - **Never** treat a truncated EOF with partial preamble text (`"I'll now read..."`) as `Ok(TurnStreamResult)`!
4. **Honest Pure-Decode TPS Accounting:** Exclude any inter-chunk stall gap `> 10s` from `active_decode_ms` OR measure sum of chunk inter-arrival deltas `<= 5s` when computing `pure_decode_tps` (while still keeping total `turn_gen_ms` transparent in trajectory logs).
5. **Client Builder Optimization:** Keep `pool_idle_timeout(Duration::from_secs(30))`, `tcp_nodelay(true)`, explicit `User-Agent: omni-harness/0.3.0`, and **disable connection reuse on retry** (`Connection: close`) to defeat sticky stalled upstream proxy sockets.

#### A.2 Interleaved Thinking State Preservation & Adaptive Reasoning Effort
Grounded in Anthropic / DeepSeek V3.2 / Gemini 2025–2026 interleaved-thinking contracts:
- Extend `HarnessMessage` (`lakeview.rs`) with:
  ```rust
  pub reasoning: Option<String>,
  pub reasoning_signature: Option<String>, // Anthropic thinking block signature / Gemini thought_signature
  pub reasoning_origin_turn: u32,
  ```
- **Round-Trip Contract in `message_to_openai_json` (`engine.rs:1853`):**
  - Within the **active user prompt's multi-turn tool loop** (all assistant turns *since the latest real user prompt*, BEFORE final answer):
    - If `m.reasoning.as_deref().is_some_and(|r| !r.is_empty())` AND `!m.tool_calls.is_empty()`, preserve `obj.insert("reasoning_content", Value::String(r.clone()))` (capped safely at `12_000` chars per turn to prevent pathological explosion while keeping full intra-prompt reasoning continuity!).
    - On the **next user prompt** (multi-turn desktop chat), omit prior prompts' `reasoning_content` (matching DeepSeek V3.2 & Anthropic spec to save context tokens).
  - In `stream_anthropic_turn`: echo `{"type": "thinking", "thinking": ..., "signature": ...}` blocks verbatim before `text`/`tool_use` blocks when present.
  - **Fail-Safe Compatibility Guard:** If an OpenAI-compatible proxy returns HTTP `400` mentioning `reasoning_content`, automatically flip `self.supports_reasoning_echo = false` and retry immediately with `reasoning_content` stripped (zero breakage across all 20 Tier-2 models!).
- **Adaptive Reasoning Budget Pacing:**
  - When `self.thinking_level` is `None` (default), do NOT force heavy reasoning on routine exploration turns, AND if a Gemini/reasoning turn exceeds `8,000` reasoning tokens in a single turn without writing code or running tests, inject a concise suffix pacing nudge on the next tool response (*"[Pacing: prioritize executing edits/tests over lengthy deliberation; remaining budget: {rem_s}s / {rem_turns} turns]"*).

#### A.3 Runtime Self-Verification Gate, Narration-Stop Guard & Error-Specific Recovery Nudges
Grounded in **SWE-Search** (`arXiv:2410.20285`, ICLR 2025) & **Thinking Longer, Not Larger** (`arXiv:2503.23803`):
Track lightweight per-prompt execution state inside `NativeSuperEngine::run_prompt`:
```rust
struct ExecutionProgressState {
    files_read: u32,
    files_mutated: BTreeSet<String>,
    shell_runs_total: u32,
    verified_since_last_mutation: bool,
    last_shell_exit_code: Option<i32>,
    last_error_fingerprint: Option<u64>,
    same_error_streak: u32,
    verify_gate_nudges: u32,
    narration_nudges: u32,
}
```
When `turn_res.tool_calls.is_empty()` and `prompt_turns < max_turns` and `remaining > Duration::from_secs(20)`:
1. **Narration-Only Premature Stop Guard (`narration_nudges < 2`):**
   - Trigger if `files_mutated.is_empty() && shell_runs_total == 0` AND the visible text either:
     - ends with `:` or `...`, OR
     - contains future-action intent markers (`"I'll now"`, `"I'll read"`, `"I'm reading"`, `"Let me inspect"`, `"Next, I will"`, `"I will now"`) and is `< 600` chars.
   - Action: Do NOT exit with `completed`! Append a compact user nudge (`"[Execution Guard] You described your next step without calling a tool. Invoke the required tool(s) now (batching reads/edits) and complete the task."`) and continue the loop.
2. **Active Runtime Self-Verification Gate (`self_verify_gate` enabled, `verify_gate_nudges < 1`):**
   - Trigger if `!files_mutated.is_empty() && !verified_since_last_mutation` (or `last_shell_exit_code.is_some_and(|c| c != 0)`).
   - Action: Intercept premature exit! Append: `"[Self-Verify Gate] You modified [files] without running a verification test/build command after your final edit (or the last command exited non-zero). Run the relevant test/verification command via shell now and confirm exit_code == 0 before finishing."`
3. **Error-Specific Semantic Recovery Nudges (`lakeview.rs` -> `SemanticLoopGuard`):**
   - Classify every non-zero `shell` / failing `edit_file` / `apply_patch` output into a typed `ErrorKind` + 64-bit `xxh3` fingerprint of the normalized error line (stripping line numbers/paths/timestamps):
     - `ImportOrModuleShadow`: (`ModuleNotFoundError`, `ImportError`, `circular import`, `Cannot find module`) -> nudge: *"Check for stdlib-shadowing filenames in workspace root (e.g. `calendar.py`, `json.py`, `typing.py`), `sys.path` / `pyproject.toml`, and circular imports."* (Directly fixes **`A7:Heal 0/8`**!)
     - `SyntaxOrTomlOrJson`: (`SyntaxError`, `IndentationError`, `TOMLDecodeError`, `JSONDecodeError`) -> nudge: *"Re-read the failing line range with `read_file`, check quoting/UTF-8 BOM/CRLF/trailing commas, and verify syntax via `python -m py_compile` / `node --check`."*
     - `EditMismatch`: (`old_string not found`, `apply_patch failed`) -> nudge: *"Use `read_file` to get fresh `line:hash` anchors and apply via Hashline anchor mode or `write_file`."*
     - `SameErrorFingerprintStreak >= 2`: triggers **even when command arguments differ slightly** (unlike v0.2.0's exact-args guard that emitted `0` nudges!) -> forces strategy pivot!
4. **Adaptive Time/Turn Budget Pacing Suffixes (100% KV-Cache Safe!):**
   - Append ONLY to the tail of the latest tool result (never mutating earlier messages!):
     - At `elapsed >= 60% * timeout_secs` AND `files_mutated.is_empty()` -> `[Time Budget: {rem}s left, 0 files edited yet. Stop broad exploration and begin implementing + testing your fix now.]`
     - At `elapsed >= 82% * timeout_secs` -> `[Time Budget: {rem}s left. Finalize edits, run verification tests, and conclude cleanly.]`
5. **Prefix-Parallel Mixed-Batch Tool Dispatch (`engine.rs:791-862`):**
   - v0.2.0 ran ALL tools sequentially if *even 1* tool in a multi-tool batch was mutating (`all_read_only`).
   - v0.3.0 partitions `parsed_calls` into maximal contiguous runs: every contiguous block of read-only tools executes concurrently via `futures_util::future::join_all`, while preserving exact sequential ordering across mutating barriers (`edit_file`, `apply_patch`, `write_file`, `shell`)!

---

### Pillar B (P0) — `tree-sitter` Heterogeneous AST Graph + Personalized PageRank RepoMap (`crates/omni-harness/src/graph_locator.rs`, `context.rs`)

Directly resolves **RC-5** (eliminates Turn-1 `workspace_map` tax & boosts `A1:SWE`, `A4:Atlas`, `A6:Refact`, `A7:Heal`) and **RC-7** (replaces regex extraction with real AST parsing + PPR). Grounded in **LocAgent** (`arXiv:2503.09089`), **RepoGraph** (`arXiv:2410.14684`), **GraphLocator** (`arXiv:2512.22469`), **OrcaLoca** (`arXiv:2502.00350`), **CoSIL** (`arXiv:2503.22424`), and **Aider RepoMap**.

#### B.1 Real `tree-sitter` AST Extraction (`O(file_bytes)` Incremental per Dirty File)
For every changed leaf returned by the BLAKE3 Merkle delta:
- Parse using `tree_sitter::Parser` (reused per thread via `thread_local!`) with compiled grammars:
  - Python (`tree_sitter_python::LANGUAGE`)
  - TypeScript / TSX (`tree_sitter_typescript::LANGUAGE_TYPESCRIPT`, `LANGUAGE_TSX`)
  - JavaScript / JSX (`tree_sitter_javascript::LANGUAGE`)
  - Rust (`tree_sitter_rust::LANGUAGE`)
  - Go (`tree_sitter_go::LANGUAGE`)
  - Fallback lightweight lexical scanner for C/C++, SQL, JSON/TOML/YAML configs.
- Extract structured `AstSymbol` records (NOT bare strings!):
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize)]
  pub struct AstSymbol {
      pub name: String,
      pub qualified_name: String, // e.g., "Ledger.convert_currency"
      pub kind: SymbolKind,       // Class | Struct | Trait | Function | Method | Interface | Const
      pub start_line: u32,        // 1-based
      pub end_line: u32,
      pub signature: String,      // 1-line compact signature (<= 100 chars)
  }

  #[derive(Debug, Clone, Serialize, Deserialize)]
  pub struct ParsedFileAst {
      pub language: String,
      pub blake3_hash: [u8; 32],
      pub symbols: Vec<AstSymbol>,
      pub imports: Vec<String>,
      pub call_refs: Vec<String>,      // invoked identifier names (deduplicated)
      pub inherits_refs: Vec<String>,  // base class / trait / interface names
      pub doc_terms: Vec<String>,      // top docstring / comment tokens for BM25F
      pub size_bytes: u64,
  }
  ```
- **Complexity:** Parsing is $O(B_{\text{changed}})$ where $B_{\text{changed}}$ is bytes of modified files only (~2–8 ms for a 50-file repo cold, `< 0.5 ms` for 1 edited file warm).

#### B.2 Heterogeneous 3-Relation CSR Graph & Personalized PageRank (PPR)
Construct a compact **Compressed Sparse Row (CSR)** directed weighted multigraph $G = (V, E, w)$ over workspace files $V = \{0, \dots, n-1\}$:
- **Edge Types & Weights** (calibrated to LocAgent + Aider RepoMap):
  - `Import` edge $u \to v$: $w = 1.0$ (explicit module import resolved within workspace)
  - `Inherits` edge $u \to v$: $w = 1.6$ (subclass/trait implementation referencing symbol uniquely or rarely defined in $v$)
  - `CallRef` edge $u \to v$: $w = \frac{1.2}{\sqrt{\text{df}(\text{sym})}}$ (invocation in $u$ matching symbol defined in $v$, IDF-attenuated so generic names like `get`/`run`/`init` don't pollute hubs; skip symbols defined in $> 12$ files!)
  - Reverse `ImportedBy` weak back-edge $v \to u$ ($w = 0.25$) so random walks from a core bug file also surface its callers/tests (critical for `A4:Atlas` impact analysis & `A6:Refact`!).
- **Sparse Power-Iteration Personalized PageRank:**
  $$\mathbf{r}^{(t+1)} = (1 - \alpha)\,\mathbf{v} + \alpha \sum_{u \to j} \frac{w_{u,j}}{d_{\text{out}}(u)}\, r^{(t)}_u + \alpha \cdot \frac{\sum_{u \in \text{dangling}} r^{(t)}_u}{n} \cdot \mathbf{v}$$
  - Damping $\alpha = 0.85$, convergence tolerance $\|\mathbf{r}^{(t+1)} - \mathbf{r}^{(t)}\|_1 < 10^{-5}$, max iterations $T = 25$.
  - **Personalization Vector $\mathbf{v}$** (normalized to $\sum v_i = 1$):
    - Uniform baseline $\frac{0.15}{n}$ across all files.
    - `+3.0` boost for files explicitly named in the user prompt / query or currently open/edited.
    - `+2.0` boost for files defining symbols matching identifier tokens extracted from the user prompt / query / error traceback (camelCase + snake_case split).
    - `+1.5` boost for files flagged as **structural anomalies** (e.g., root-level Python file shadowing a Python stdlib module like `calendar.py`, `json.py`, `logging.py`, `email.py`, `http.py` -> auto-annotated `[WARN: shadows Python stdlib]` in the map!!).
  - **Complexity:** $O(T \cdot (|V| + |E|))$ time, $O(|V| + |E|)$ space. For $|V| = 1{,}000, |E| = 8{,}000$: `< 0.4 ms`!

#### B.3 Zero-Turn-Waste Turn-1 Embedded RepoMap (`context.rs`)
- On Turn 1, compute PPR seeded directly from the `user_prompt` text (identifiers, file paths, error names mentioned in the prompt!).
- Pack the top-ranked files + their `AstSymbol` signatures (with `Lstart-Lend` line numbers!) + key dependency edges into `<workspace_context>` using **binary search over a strict token budget** (`min(550, max(220, file_count * 25))` tokens):
  ```text
  [RepoMap | blake3=9a41e0c8b2f1 | files=14 | symbols=52 | ppr_top=10]
  - ledger/engine.py [python] (ppr=0.24, in=3) :: class LedgerEngine(L12-180), post_entry(L45), convert_fx(L92), settle_hold(L138)
  - ledger/fx.py [python] (ppr=0.19, in=2) :: class FxTable(L8-74), get_rate(L22), triangulate(L49)
  - calendar.py [python] [WARN: shadows stdlib `calendar`] (ppr=0.14) :: business_days(L4)
  Edges: ledger/engine.py -> ledger/fx.py [import,call]; tests/test_ledger.py -> ledger/engine.py [import]
  ```
- **Direct Impact:** Eliminates `63/65` wasted Turn-1 `workspace_map` calls (saving `1` full LLM round-trip + `3–130s` latency on EVERY task!), while giving models exact line numbers (`L92`) and stdlib-shadowing warnings on Token 1 of Turn 1! `workspace_map` remains available for deep subpath/symbol/ego-graph queries (`focus_symbol`, `hops: 1..2`).

---

### Pillar C (P0) — Hashline Content-Addressable Anchors + 3-Tier Histogram Diff Edit/Patch Engine (`crates/omni-harness/src/edit.rs`, `patch.rs`, `tools.rs`)

Directly resolves **RC-5 (multi-file read friction)** & **RC-7 (edit/patch robustness)**. Grounded in **Can Bölük's *The Harness Problem* / Hashline (`oh-my-pi`, Feb 2026)** and **`imara-diff` (Git Histogram Diff)**.

#### C.1 Hashline Content-Addressable Line Tags (`42:a3f| code...`)
- For each 1-based line $i$ (`lines[i-1]`), compute a deterministic **12-bit (`3` lowercase hex chars) content+context tag** using `xxhash_rust::xxh3::xxh3_64`:
  ```rust
  pub fn line_hash_tag(prev_trimmed: &str, curr_trimmed: &str, next_trimmed: &str) -> [u8; 3] {
      // Hash trimmed line + immediate neighbor fingerprint so identical blank/brace lines
      // (`}`, `return None`, ``) get distinct disambiguated anchors!
      // Format as 3 hex nibbles (4,096 buckets; collision rate < 0.025% per line, < 10^-7 over 2-line span).
  }
  ```
- `read_file` emits compact Hashline format: `  42:a3f|     return rate * amount` (adds only `+4` chars/line = `~1.0` token/line, while enabling zero-copy anchored edits!).
- **Multi-File Batch `read_file`:** Extend `read_file` schema with optional `paths: array<string>` (max `8` files per call, shared `32_000` char budget split fairly across files with automatic per-file truncation notice). Single-`path` calls stay 100% backward compatible!
  - **Impact:** Models like `claude-sonnet-5-5` and `gpt-6.2-sol` that emit 1 tool call per turn can read 5–8 files in **1 turn instead of 8 turns**!

#### C.2 3-Tier Edit Engine with Formal Uniqueness Proof (`edit.rs`)
`edit_file` supports **two mutually clean input modes** (preserving 100% backward compatibility with `old_string`/`new_string`):
- **Mode 1 — Hashline Anchor Splice (Optional `start_anchor` / `end_anchor`):**
  - Parameters: `path`, `start_anchor` (`"42:a3f"`), optional `end_anchor` (`"49:c1b"`, defaults to `start_anchor`), `new_string`.
  - Verification in **$O(1)$**: check `1 <= start <= end <= total_lines`, compute `line_hash_tag` at `start` and `end`, verify exact tag match.
  - If tag mismatches (stale line or drifted line number): search a $\pm 15$-line radius; if the *exact* `(start_tag, end_tag)` pair with identical span length occurs **uniquely** in the radius, relocate safely (`match_mode = "hashline_relocated"`); otherwise reject cleanly and return the fresh $\pm 5$ lines with current `line:hash` tags so the agent fixes in 1 turn!
  - **Token Savings:** Replaces re-emitting 40–100 lines of `old_string` with two 6-char anchors (`"42:a3f"`, `"88:d0e"`) — **50–80% fewer edit output tokens**!
- **Mode 2 — Classic `(old_string, new_string)` 3-Tier Fallback Cascade:**
  1. **Tier 1 (Exact SIMD Match — $O(N)$):** `memchr::memmem::find_iter` finds all exact byte offsets; applies if unique (or all when `replace_all: true`).
  2. **Tier 2 (Indentation-Normalized Unique Match — $O(N)$):** Trim-line rolling hash (`FxHash` pre-check before string compare), succeeds iff match count == `1`, preserves real file base indentation.
  3. **Tier 3 (`imara-diff` Histogram-Anchored Fuzzy Hunk Match — $O(N + M \cdot D)$):**
     - Activated ONLY for multi-line `old_string` ($\ge 3$ non-empty lines) when Tiers 1 & 2 miss (e.g., 1 minor comment/whitespace/trailing-comma typo in context lines).
     - Uses `imara_diff::InternedInput` + `Algorithm::Histogram` to align unique/low-frequency anchor lines (Patience/Histogram core idea: rare lines anchor blocks cleanly!), then scores candidate windows of length `[0.8M, 1.2M]` by normalized token/line similarity:
       $$\text{sim}(W, Q) = \frac{2 \cdot \text{LCS}_{\text{histogram}}(W, Q)}{|W| + |Q|}$$
     - **Formal Uniqueness Proof Guard (Zero Silent Mis-Edits!):** Accept ONLY if $\text{sim}_{\text{best}} \ge 0.88$ **AND** $(\text{sim}_{\text{best}} - \text{sim}_{\text{second\_best}}) \ge 0.10$ **AND** anchor boundary lines match trimmed! Otherwise fail with a helpful diff against the closest candidate window (line numbers + Hashlines).
- **Post-Edit Compact Unified Diff Feedback (`imara-diff`):** Both `edit_file` and `apply_patch` return a compact 3-context-line unified diff (capped at 40 lines) with new Hashline tags so the agent immediately verifies syntax/indentation without spending an extra `read_file` turn!
- **Upgrade `patch.rs` (`find_sequence`):** Add Tier-3 `imara-diff` Histogram fuzzy hunk fallback (same $\ge 0.88$ / $\ge 0.10$ uniqueness proof) + Hashline `@@ 42:a3f` anchor support inside `apply_patch`, while keeping 100% atomic dry-run + transactional backup rollback.

---

### Pillar D (P0) — Pure-Rust Hybrid Code Search Engine: BM25F + Trigram Index + RRF + SIMD (`crates/omni-harness/src/search.rs`, `tools.rs`)

Directly resolves **RC-5** (`search_code` only used 4× in 65 runs) & improves `A1:SWE`, `A4:Atlas`, `A6:Refact`. Grounded in **LocAgent** (`arXiv:2503.09089`), **BM25F** (Robertson & Zaragoza), **RRF** (Cormack et al., SIGIR 2009), and **Zoekt / Ripgrep** trigram + SIMD architecture.

#### D.1 Incrementally Maintained In-Memory Index (Coupled to BLAKE3 Merkle Delta)
Maintain `HybridSearchIndex` inside `WorkspaceGraphIndex` (updated **only** for `delta.changed_files` and `delta.removed_files` — zero redundant disk reads!):
1. **Fielded Inverted Index (BM25F):**
   - Tokenize identifiers with code-aware sub-tokenizer: split on non-alphanumeric, camelCase (`getAuthToken` -> `["getauthtoken", "get", "auth", "token"]`), and snake_case (`parse_jwt_v2` -> `["parse_jwt_v2", "parse", "jwt", "v2"]`).
   - 4 AST-derived fields per file $d$ with weights $(w_f, b_f)$:
     - `symbol_def` ($w=4.0, b=0.40$): AST class/function/method/struct names
     - `file_path` ($w=3.0, b=0.30$): path segments & stem
     - `doc_comment` ($w=1.5, b=0.50$): docstrings/comments
     - `body` ($w=1.0, b=0.75$): code body tokens
   - BM25F score for query $Q$ and file $d$ ($k_1 = 1.2$):
     $$\tilde{tf}_{d,t} = \sum_{f} w_f \cdot \frac{tf_{d,f,t}}{(1 - b_f) + b_f \frac{|d_f|}{\text{avgdl}_f}}, \qquad \text{BM25F}(d, Q) = \sum_{t \in Q} \ln\!\left(1 + \frac{N - df_t + 0.5}{df_t + 0.5}\right) \cdot \frac{\tilde{tf}_{d,t}(k_1 + 1)}{\tilde{tf}_{d,t} + k_1}$$
2. **ASCII Lowercase Trigram Inverted Index (Zoekt-Style):**
   - `FxHashMap<[u8; 3], Vec<u32>>` (sorted `FileId` posting lists).
   - For literal / regex queries with extracted literal anchor $\ge 3$ bytes, intersect the rarest trigram posting lists in $O(\min |L_i|)$ to prune `95–99%` of workspace files BEFORE scanning a single byte!
3. **SIMD Exact / Multi-Literal / Regex Line Verifier:**
   - Literal mode: `memchr::memmem::Finder` (single literal) or `aho_corasick::AhoCorasick` (multi-token).
   - Regex mode: `regex::Regex` over trigram-filtered candidates only.
   - Respects `.gitignore` via `ignore::WalkBuilder` + enforces `PermissionsEngine` per-file `Deny` rules (`.env*`, `*id_rsa*`) before indexing or reading a single byte!
4. **Reciprocal Rank Fusion (RRF, $k = 60$):**
   - In `mode = "hybrid"` (or natural-language / multi-word queries), fuse ranked lists from (1) **BM25F**, (2) **Exact/Trigram Hit Density**, and (3) **Personalized PageRank Graph Score**:
     $$\text{Score}_{\text{RRF}}(d) = \frac{1}{60 + \text{rank}_{\text{BM25F}}(d)} + \frac{1}{60 + \text{rank}_{\text{exact}}(d)} + \frac{0.7}{60 + \text{rank}_{\text{PPR}}(d)}$$
- **Enhanced `search_code` Schema (Backward Compatible):**
  - Existing args (`query`, `path`, `literal`, `case_sensitive`, `max_matches`) preserved 100%.
  - Add optional `mode: "regex" | "literal" | "hybrid" | "symbol"` (default `"regex"` for exact compatibility, or auto-promoted to `"hybrid"` when `query` is multi-word natural text with spaces and `literal == false`!) + optional `context_lines: integer` (0..3, default 0) + Hashline tags on returned matching lines (`path:42:a3f: code`)!
- **Complexity:** Index update $O(B_{\text{changed}})$; trigram+SIMD query $O(k \cdot \text{cand} + |Q|)$; BM25F+RRF query `< 1.5 ms` on 2,000 files!

---

### Pillar E (P1) — BLAKE3 SIMD Merkle Tree with Dirty-Path Propagation & Persistent SQLite AST Cache (`crates/omni-harness/src/merkle.rs`, `crates/omni-db`)

Directly resolves **RC-7** (SHA-256 overhead, full directory rehash, cold-start re-parse). Grounded in **BLAKE3 Spec** (O'Connor et al.).

#### E.1 Algorithmic Upgrades in `merkle.rs`
1. **BLAKE3 SIMD Hashing (`blake3 = "1.8"`):**
   - Replace `sha2::Sha256` with `blake3::hash` (auto-dispatches AVX2/SSE4.1 on Windows x86_64 — `5–10×` faster leaf hashing; `100%` deterministic 32-byte digest).
   - Store `[u8; 32]` raw bytes internally (zero 64-byte hex heap allocations per file/dir; format hex only at JSON/API boundaries!).
2. **True $O(|\Delta| \cdot D_{\text{depth}})$ Dirty-Path Ancestor Propagation:**
   - v0.2.0 (`merkle.rs:146-190`) sorted and rehashed *every* directory in the workspace on every `refresh()`, even when `changed_files.is_empty() && removed_files.is_empty()`!
   - v0.3.0 maintains `dir_children: BTreeMap<String, BTreeSet<String>>` and `dir_files: BTreeMap<String, BTreeSet<String>>`. On `refresh()`:
     - Collect `dirty_dirs: BTreeSet<String>` containing ONLY parent directories of `changed_files ∪ removed_files` plus all their ancestors up to `""` (root).
     - If `dirty_dirs.is_empty()` -> **`0` hashes computed, immediate return (`< 0.15 ms` on benchmark repos!)**.
     - Otherwise rehash ONLY `dirty_dirs` deepest-first with BLAKE3!
3. **`.gitignore`-Aware Walk (`ignore::WalkBuilder`):** Replaces hardcoded `IGNORED_DIRS` list alone (keeps hardcoded safety list + respects `.gitignore` while never following symlinks).

#### E.2 Persistent SQLite Cache in `crates/omni-db` (`schema.sql` + `index_cache.rs`)
Add two lightweight WAL tables to `crates/omni-db/src/schema.sql` (zero breaking changes to existing 12 tables):
```sql
CREATE TABLE IF NOT EXISTS merkle_cache (
    workspace_hash TEXT NOT NULL,
    rel_path       TEXT NOT NULL,
    size_bytes     INTEGER NOT NULL,
    mtime_secs     INTEGER NOT NULL,
    mtime_nanos    INTEGER NOT NULL,
    blake3_hex     TEXT NOT NULL,
    PRIMARY KEY (workspace_hash, rel_path)
);

CREATE TABLE IF NOT EXISTS ast_symbol_cache (
    blake3_hex     TEXT PRIMARY KEY,  -- content-addressable! Shared across branches & worktrees!
    language       TEXT NOT NULL,
    ast_json       TEXT NOT NULL,     -- compact serialized ParsedFileAst
    updated_at     INTEGER NOT NULL
);
```
- **Content-Addressable Cross-Worktree Reuse:** Because `ast_symbol_cache` is keyed by `blake3_hex`, creating a Git worktree or switching branches reuses cached AST symbols with **0 re-parses** for unchanged files!
- **Latency:** Warm desktop startup on a 5,000-file repository drops from `~120 ms` to **`< 8 ms`**.

---

### Pillar F (P1) — KV-Cache-Aware Epoch Observation Masking & Multi-Breakpoint Caching (`crates/omni-harness/src/lakeview.rs`, `cache_guard.rs`, `engine.rs`)

Directly resolves **RC-6** (`Lakeview Compr: 0`, `84.3%` cache hit vs `91.9%` v0.1). Grounded in **JetBrains Research *The Complexity Trap*** (`arXiv:2508.21433`, NeurIPS 2025 DL4Code), **ACON** (`arXiv:2510.00615`), **Context-Folding / FoldAgent** (`arXiv:2510.11967`), **Focus** (`arXiv:2601.07190`), and **ActKV** (`arXiv:2609.31395`).

#### F.1 Why Sliding-Window Mutation Breaks KV Prefix Cache (Mathematical Proof)
Let message sequence be $M = [m_0, m_1, \dots, m_t]$. GPU KV-cache reuse requires a byte-identical prefix $M[0..k]$.
- **v0.2.0 Naive Sliding Window:** At turn $t$, mutating $m_{t-6}$ invalidates KV entries $[t-6, t]$. At turn $t+1$, mutating $m_{t-5}$ invalidates $[t-5, t+1]$ — **re-prefilling the entire tail on EVERY turn!**
- **v0.3.0 Epoch-Aligned Hysteresis Watermark Masking:**
  - Define Soft Watermark $W_{\text{soft}} = 44{,}000$ chars (~11.5k tokens), Target Floor $W_{\text{target}} = 24{,}000$ chars, and Verbatim Recency Window $K = 4$ turns.
  - Maintain monotonic pointer `last_masked_turn: u32`.
  - **Rule 1 (Append-Only Steady State):** Whenever $\text{total\_chars}(M) < W_{\text{soft}}$, perform **ZERO mutations** -> prefix $[0..t-1]$ is **100% byte-identical** (`95–99%` KV cache hit!).
  - **Rule 2 (One-Shot Batch Epoch Fold):** When $\text{total\_chars}(M) \ge W_{\text{soft}}$, execute **ONE batch pass** masking all eligible observations in `(last_masked_turn .. current_turn - K]` in a single step, dropping size toward $W_{\text{target}}$ and advancing `last_masked_turn = current_turn - K`. The next `6–10` turns are again **100% append-only** against the new stable prefix!
  - **Rule 3 (Action-Guided Retention Policy — ActKV + ACON):**
    - **Priority 1 Mask (Always Eligible First):** *Superseded `read_file` outputs* — if file `P` was later re-read or mutated via `edit_file`/`apply_patch`/`write_file` at turn $t' > t$, replace the stale read at turn $t$ with a 1-line tombstone:
      `[Masked: read_file '{P}' L{a}..{b} ({orig} chars) — superseded by {op} at turn {t'}]`
    - **Priority 2 Mask:** Stale `workspace_map`, `search_code`, and passing (`exit_code: 0`) `shell` outputs `> 2,000` chars -> keep compact 8-line observation mask (head 4 lines + Aho-Corasick diagnostic matches + tail 4 lines + spill file ref if `> 8,000` chars).
    - **Strictly Protected (Never Masked While Active):**
      - Token-0 `system` prompt and Turn-1 `user` prompt (with embedded RepoMap).
      - The most recent failing (`is_error == true`) `shell` traceback!
      - All `edit_file` / `apply_patch` compact diff confirmations (`< 2,000` chars)!
      - The latest unread/unedited `read_file` of any file currently under modification!

#### F.2 Multi-Breakpoint Explicit Prompt Caching (`engine.rs` & `cache_guard.rs`)
- **Anthropic Native API (`stream_anthropic_turn`):** Place `cache_control: { "type": "ephemeral" }` on **3 strategic breakpoints**:
  1. `system[0]` (immutable Token-0 prompt)
  2. Last element of `tools` array (alphabetically canonicalized schemas)
  3. Last content block of the penultimate `user`/`tool_result` message (so the entire multi-turn history prefix stays hot in Anthropic's 5-min ephemeral KV cache -> **`>95%` cache hit**!).
- **OpenAI-Compatible API (`stream_openai_turn`):** Keep Token-0 `system` + canonicalized `tools` + Turn-1 `user` 100% immutable (verified by `BLAKE3` prefix hash on every turn in `cache_guard.rs`), and pass optional `prompt_cache_key: self.session_key` when supported (gracefully dropped if HTTP 400).

---

### Pillar G (P1) — Token-Minimal 2026 Prompt & Smart Shell Output Engineering (`cache_guard.rs`, `plugin.rs`, `tools.rs`)

Directly resolves **RC-5** & **RC-7**. Benchmarked against `mini-swe-agent` (`<1,500` base tokens), `codex-rs`, `Claude Code`, `Goose`, and DeepSeek `dsh`.

#### G.1 Ultra-Lean Token-0 System Prompt (`~240` Tokens, `-33%` vs v0.2.0)
Replace `BASE_SYSTEM_PROMPT` (`cache_guard.rs:15-26`, ~360 tokens) with a crisp, friction-free **~240-token** prompt that removes the Turn-1 `workspace_map` tax and enforces batch-first fast-to-code discipline:
```text
You are Omni Super-Harness, an expert software engineering agent operating inside a local workspace.

Workflow:
1. Context is pre-loaded: Turn-1 <workspace_context> already includes a PageRank AST RepoMap with file paths, symbols, line numbers, and dependency edges. Do NOT waste Turn 1 calling workspace_map unless you need a deeper subpath or symbol neighborhood.
2. Batch reads & move fast to code: read related files together with read_file(paths=[...]) or parallel calls; use search_code(mode="hybrid"|"symbol"|"regex") to pinpoint definitions/callers. Form a concise plan and start editing/testing within 2–3 turns.
3. Surgical edits:
   - read_file returns `line:hash| code` anchors. Prefer edit_file (exact old_string/new_string OR start_anchor/end_anchor hashline splice) for targeted edits, apply_patch for atomic multi-file changes, and write_file for new files/full rewrites.
   - Always inspect the returned diff/error; never repeat identical failing calls.
4. Verify before finishing: run the project's tests, build, or edge-case checks via shell after your final edit and confirm exit_code == 0. Never claim success without observed verification output.
5. Finish concisely with modified files, root cause, and observed verification results.
```
- **Schema Compression (`plugin.rs`):** Tighten parameter descriptions across all 7 tools to bring **System Prompt + 7 Tool Schemas** down from `~1,850` tokens to **`~1,250` tokens** (`-32%` Turn-1 prefill overhead!).

#### G.2 Smart Shell Output Filtering & Fast Event-Driven Supervision (`tools.rs`)
1. **ANSI & Progress-Bar Scrubber (`tools.rs:855-899`):** Before capping shell output, strip ANSI CSI/OSC escape codes (`\x1b\[[0-9;?]*[ -/]*[@-~]`), collapse `\r` carriage-return progress-bar overwrites (keeping only the final overwritten line), and dedupe consecutive identical lines (`[repeated N×]`).
2. **Traceback-Preserving Head/Tail Cap:** When output exceeds `MAX_SHELL_OUTPUT_CHARS` (`14_000` chars), preserve head `30%`, **all** `Traceback`/`Error:`/`FAILED`/`AssertionError`/`error[E` diagnostic blocks (`25%`), and tail `45%` (where pytest/unittest/jest/cargo summaries always appear!).
3. **Sub-Millisecond Child Exit Detection (`tools.rs:817-847`):** Replace fixed `std::thread::sleep(Duration::from_millis(20))` polling with adaptive backoff (`1ms -> 2ms -> 5ms -> 15ms`), saving ~`15 ms` per short command with negligible CPU!

---

### Pillar H (P2) — Windows 11 `mimalloc` Global Allocator (`src-tauri/src/main.rs`, `Cargo.toml`)

Directly improves **Axis 10 (Peak RSS, Allocation Latency, Multi-Threaded AST/Search Throughput)**. Grounded in Microsoft Research *Mimalloc: Free List Sharding in Action* (Leijen et al.).

- In `src-tauri/src/main.rs` (top of binary entrypoint):
  ```rust
  #[cfg(target_os = "windows")]
  #[global_allocator]
  static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
  ```
- **Why Windows 11 specifically:** Windows' default `HeapAlloc` / LFH (Low Fragmentation Heap) exhibits significant lock contention and working-set retention when Tokio async SSE buffers, `tree-sitter` C AST allocations, and `FxHashMap` trigram posting vectors allocate/free rapidly across worker threads. `mimalloc`'s thread-local sharded free lists reduce allocation latency by `2–3×` and trim peak fragmentation RSS by `10–25%` while preserving `0` crashes with WebView2/COM (COM allocations use `CoTaskMemAlloc`, completely independent of Rust's `#[global_allocator]`).
- **Verification Guard:** Run 10-run `--profile-startup` and 3-run GUI cold-start + steady idle RSS after enabling `mimalloc`; confirm binary size `< 18 MB`, CLI startup `<= 75 ms` p50, and GUI Private RAM `<= 125 MiB`.

---

## 5. Direct Failure-Mode Remediation Matrix (`v0.2.0` -> `v0.3.0`)

| Observed `v0.2.0` Failure Mode (`results/raw/super_harness/omni-super/`) | `v0.2.0` Score | Exact `v0.3.0` Fix(es) | Expected `v0.3.0` Recovery |
|---|---:|---|---|
| **37/46 timeouts** (`Timed out connecting to...` ×12, `Timed out waiting for SSE chunk` ×25, `0` HTTP retries) + **7 passing runs hitting `300.0s`** | `44/65` TO | **Pillar A.1** (35s header/chunk watchdog + fresh-socket `Connection: close` retry + backoff) | Eliminates 90%+ of 100–298s proxy hangs; cuts median wall time from `300s` -> `< 150s` |
| **5/8 hard `completed` FAILs** (`claude-opus/algo_01`, `claude-sonnet/{algo_02, algo_03, atlas_01, heal_02}` with `finishReason=None, ot=0`) | `0/5` | **Pillar A.1** (strict `saw_done \|\| finish_reason.is_some()` check -> retryable error) | 100% eliminated; retries cleanly instead of false `completed` exit |
| **3/8 hard `completed` FAILs** (`claude-sonnet/{atlas_02, bfcl_02, term_02}` emitting `"I'll read..."` with `tool_calls=[]`) | `0/3` | **Pillar A.3** (Narration-Only Premature Stop Guard + Runtime Self-Verify Gate) | 100% intercepted and pushed to invoke tools & verify before exiting |
| **`A7:Heal` = `0/8` (0%)** across all 5 models (`heal_01_broken_py_pkg`, `heal_02_broken_node_service`) | `0.0%` | **Pillar A.2** (Interleaved Thinking stops Gemini 242s re-thinking), **Pillar B.3** (auto stdlib-shadowing `calendar.py` warning in Turn-1 RepoMap!), **Pillar C.1** (batch `read_file(paths=[...])`), **Pillar A.3** (`ImportOrModuleShadow` nudge) | `0/8` -> `5–7/8` (`62–87%`, beating Goose's `38%`!) |
| **`gpt-6.2-sol` `A3:Algo` = `0/3`** (`algo_01` & `algo_02` hung `298s` right after Turn-1 `workspace_map`!) | `0.0%` | **Pillar B.3** (skip Turn-1 `workspace_map`) + **Pillar A.1** (35s watchdog retries stalled Turn-2 socket immediately!) | `0/3` -> `2–3/3` (matching/beating Goose's `3/3`!) |
| **`A2:Term` = `36%`** (vs Goose `82%`) & **`A1:SWE` = `45%`** (vs Goose `64%`; `swe_02` hit `89%` then timed out) | `36%` / `45%` | **Pillar A.1 + A.2 + B.3 + C.1/C.2** (faster Turn-1 start, batch reads, Hashline edits, adaptive 60%/82% pacing) | `A2:Term` -> `75–85%+`, `A1:SWE` -> `70–82%+` |
| **`claude-sonnet-5-5` = `11.8%` (`2/17`), `1.3 tok/s` Gen TPS** | `11.8%` | **Pillar A.1 + A.3 + B.3 + C.1** (fixes all 5 truncated SSE streams, all 3 narration stops, all 9 socket hangs, and 1-file-per-turn tax!) | `11.8%` -> `50–65%+` (matching/beating Goose's `47.1%`!) |
| **`Lakeview Compr: 0`, `Loop Nudges: 0`, `Cache Hit: 84.3%`** | `84.3%` | **Pillar F.1/F.2** (Epoch Hysteresis Observation Masking + 3-breakpoint caching) + **Pillar A.3** (Semantic Error-Fingerprint Loop Guard) | Cache Hit `>= 91–95%`, active zero-thrash compression on 12+ turn runs |

---

## 6. Prioritized Implementation Roadmap & Acceptance Criteria (File-by-File)

> **Backward Compatibility Invariant:** ALL `144` existing Tauri IPC commands (`IPC_CONTRACT.md`), `--eval-omni` `SuperEvalReport` JSON schema fields, `PermissionsEngine` Deny-always-wins rules, `ensure_within_workspace` containment, and Win32 Job Object `0`-orphan supervision MUST remain 100% intact. New telemetry fields in `SuperEvalReport` are strictly additive!

### Phase P0 — Immediate Pass@1 & Speed Breakthrough (Target: Beat Goose `53.9%` / `I10=58.05`)

| Order | Target Files | Concrete Changes | Unit & Integration Test Specifications |
|---|---|---|---|
| **P0.1** | `crates/omni-harness/src/engine.rs` | Implement Split-Budget HTTP/SSE timeouts (`35s` header, `35s`/`50s` chunk idle, fresh-socket `Connection: close` on retry), strict `saw_done \|\| finish_reason.is_some()` stream-integrity check returning `Retryable` on truncated EOF, Interleaved Thinking `reasoning_content` round-trip (with HTTP-400 auto-fallback), Runtime Self-Verification Gate, Narration-Only Stop Guard, 60%/82% adaptive pacing suffixes, and prefix-parallel mixed-batch tool dispatch. Add additive telemetry fields to `SuperEvalReport`: `truncated_stream_retries`, `stall_retries`, `verify_gate_nudges`, `narration_nudges`, `interleaved_reasoning_turns`. | 1. `retries_truncated_sse_eof_without_finish_reason` (mock local TCP/axum SSE server drops connection mid-text -> verifies retry succeeds, NEVER returns false `completed`).<br>2. `retries_stalled_sse_chunk_and_header_timeout` (mock server sleeps > watchdog -> verifies retry with `Connection: close`).<br>3. `preserves_interleaved_reasoning_content_within_tool_loop_and_clears_across_user_turns`.<br>4. `runtime_self_verify_gate_and_narration_guard_intercept_premature_stop`.<br>5. `mixed_batch_runs_read_prefix_in_parallel_before_mutating_barrier`. |
| **P0.2** | `Cargo.toml`, `crates/omni-harness/Cargo.toml`, `crates/omni-harness/src/graph_locator.rs`, `crates/omni-harness/src/context.rs` | Add `tree-sitter = "0.25"`, `tree-sitter-{python,javascript,typescript,rust,go}`, `rustc-hash`. Upgrade `graph_locator.rs` to real `tree-sitter` AST extraction (`AstSymbol` with line spans & signatures, imports, calls, inheritance), 3-relation CSR graph, sparse Personalized PageRank (`alpha=0.85`, query-seeded), and Python stdlib-shadowing detector (`calendar.py` etc.). Embed token-budgeted PPR RepoMap directly into Turn-1 `<workspace_context>` in `context.rs`. | 1. `tree_sitter_extracts_python_ts_js_rust_go_symbols_calls_and_inheritance`.<br>2. `ppr_ranks_query_relevant_hub_and_callers_above_unrelated_files` (verifies L1 convergence `< 1e-5` and `< 5ms` on 500 synthetic nodes).<br>3. `detects_python_stdlib_shadowing_file_in_workspace_root`.<br>4. `turn1_context_embeds_budgeted_ppr_repomap_under_600_tokens`. |
| **P0.3** | `crates/omni-harness/src/edit.rs`, `crates/omni-harness/src/patch.rs`, `crates/omni-harness/src/tools.rs`, `crates/omni-harness/src/plugin.rs` | Add `imara-diff = "0.2"`, `xxhash-rust = { version = "0.8", features = ["xxh3"] }`, `memchr` (already locked). Emit Hashline `line:hash\|` tags in `read_file` + add multi-file `paths: string[]` batch read. Add Hashline anchor mode (`start_anchor`/`end_anchor`) + Tier-3 `imara-diff` Histogram fuzzy hunk fallback (strict `sim >= 0.88 && margin >= 0.10` uniqueness proof) in `edit.rs` & `patch.rs`, plus compact post-edit unified diff feedback. | 1. `hashline_read_and_anchor_edit_rejects_stale_hash_and_relocates_unique_shift`.<br>2. `batch_read_file_reads_multiple_files_respecting_deny_rules_and_char_budget`.<br>3. `tier3_imara_histogram_fuzzy_edit_applies_unique_match_and_rejects_ambiguous`.<br>4. `edit_and_patch_return_compact_unified_diff_with_fresh_hashlines`. |
| **P0.4** | `crates/omni-harness/src/search.rs` *(new)*, `crates/omni-harness/src/tools.rs`, `crates/omni-harness/src/plugin.rs`, `crates/omni-harness/src/lib.rs` | Add `ignore = "0.4"`, `aho-corasick` (locked), `memchr` (locked). Implement `HybridSearchIndex` (BM25F 4-field AST-weighted + ASCII trigram posting lists + SIMD `memchr`/`aho-corasick`/`regex` verifier + RRF `k=60` fusion with PPR scores). Wire `mode: "regex" \| "literal" \| "hybrid" \| "symbol"` and `context_lines` into `search_code` while enforcing per-file `PermissionsEngine` Deny rules before indexing any byte! | 1. `trigram_prefilter_matches_exact_simd_and_skips_non_matching_files`.<br>2. `bm25f_rrf_ranks_ast_symbol_definition_above_comment_or_body_mentions`.<br>3. `hybrid_search_never_indexes_or_leaks_denied_env_or_ssh_files`.<br>4. `incremental_index_update_removes_deleted_file_postings`. |

### Phase P1 — Ultra-Fast Indexing, Zero-Thrash KV Cache & Token-Minimal Harness

| Order | Target Files | Concrete Changes | Unit & Integration Test Specifications |
|---|---|---|---|
| **P1.1** | `crates/omni-harness/src/merkle.rs`, `crates/omni-db/src/schema.sql`, `crates/omni-db/src/index_cache.rs` *(new)*, `crates/omni-db/src/lib.rs` | Add `blake3 = "1.8"`. Switch `merkle.rs` from SHA-256 to BLAKE3 `[u8; 32]`, implement $O(|\Delta| \cdot D_{\text{depth}})$ dirty-path ancestor propagation + `ignore::WalkBuilder`, and add optional SQLite `merkle_cache` + content-addressable `ast_symbol_cache` persistence in `omni-db`. | 1. `blake3_merkle_dirty_path_rehashes_zero_dirs_when_clean_and_only_ancestors_on_mutation`.<br>2. `sqlite_merkle_and_ast_cache_roundtrip_skips_reparse_on_warm_open`. |
| **P1.2** | `crates/omni-harness/src/lakeview.rs`, `crates/omni-harness/src/cache_guard.rs`, `crates/omni-harness/src/engine.rs` | Upgrade `lakeview.rs` to **Epoch-Aligned Hysteresis Observation Masking** (`W_soft = 44k`, `W_target = 24k`, `K = 4`, superseded `read_file` tombstones, protected latest error tracebacks & edit diffs) + **SemanticLoopGuard** (typed `ErrorKind` nudges + error-fingerprint streak detection). Upgrade `cache_guard.rs` to BLAKE3 prefix hashing and `stream_anthropic_turn` to 3-breakpoint `cache_control`. | 1. `epoch_masking_stays_append_only_under_watermark_then_folds_once_preserving_next_turns_prefix`.<br>2. `superseded_read_file_masked_while_latest_failing_traceback_stays_verbatim`.<br>3. `semantic_loop_guard_emits_stdlib_shadow_and_repeated_error_fingerprint_nudges`. |
| **P1.3** | `crates/omni-harness/src/cache_guard.rs`, `crates/omni-harness/src/plugin.rs`, `crates/omni-harness/src/tools.rs` | Deploy ultra-lean `~240`-token `BASE_SYSTEM_PROMPT` + tightened 7-tool schema descriptions (`~1,250` total base tokens). Add ANSI/CR scrubber + traceback-preserving output cap + adaptive `1ms->15ms` supervised shell exit polling in `tools.rs`. | 1. `base_system_prompt_plus_7_tools_under_1400_estimated_tokens`.<br>2. `shell_scrubber_strips_ansi_collapses_cr_progress_and_preserves_traceback`. |

### Phase P2 — Windows 11 Memory Allocator & Final Verification

| Order | Target Files | Concrete Changes | Unit & Integration Test Specifications |
|---|---|---|---|
| **P2.1** | `Cargo.toml`, `src-tauri/Cargo.toml`, `src-tauri/src/main.rs` | Add `mimalloc = { version = "0.1", default-features = false }` as `#[cfg(target_os = "windows")] #[global_allocator]` in `src-tauri/src/main.rs`. Bump workspace version `"0.2.0"` -> `"0.3.0"`. | 1. Full `cargo test --workspace` green (`0` warnings/failures).<br>2. Release build `omp-omni.exe` `< 18 MB`, `--profile-startup` p50 `<= 75 ms`, GUI Private RAM `<= 125 MiB`, `0` orphan processes.<br>3. Live `--eval-omni` smoke test on `heal_01_broken_py_pkg`, `swe_02_py_scheduler`, `algo_01_temporal_k_shortest`, `bfcl_02_schema_compiler` confirming Pass@1 recovery before full 65-run v0.3.0 benchmark sweep! |

---

## 7. Quantified v0.3.0 Target KPIs (vs `v0.2.0` & `goose v1.60.2`)

| Metric (65 Matched Tier-1 Runs) | `goose v1.60.2` | `omni-super v0.2.0` | **`omni-super v0.3.0` Target** | Primary Driver |
|---|---:|---:|---:|---|
| **Strict Pass@1** | `53.9%` (35/65) | `30.8%` (20/65) | **`>= 63.0%` (`>= 41/65`)** | Pillars A.1–A.3, B, C, D |
| **C7 Capability Index** | `52.27` | `30.84` | **`>= 61.0`** | `A7:Heal` `0% -> 65%+`, `A3:Algo` `9% -> 50%+`, `A2:Term` `36% -> 78%+` |
| **A8 Speed Score / Med Wall** | `57.7` / `294.1s` | `42.9` / `300.0s` | **`>= 64.0` / `<= 165s`** | Pillar A.1 (stall retries) + Pillar B.3 (zero Turn-1 map tax) |
| **Med TTFT (LLM)** | `2.88s` | **`2.17s`** | **`<= 1.95s`** | `~1,250` base tokens + `blake3`/PPR `< 3 ms` startup |
| **A9 Economics / Cache Hit / Tool Err** | `61.3` / `89.6%` / `16.0%` | `61.0` / `84.3%` / `2.3%` | **`>= 70.0` / `>= 91.5%` / `<= 2.5%`** | Pillar F (epoch masking + 3-breakpoint cache) + Pillar C (Hashlines) |
| **A10 Live Peak RSS / Binary Size** | `95.6` / `135.7 MB` / `630.6 MB` | `99.8` / `53.7 MB` / `13.69 MB` | **`>= 99.5` / `<= 52 MB` / `<= 17.5 MB`** | Pillar H (`mimalloc`) + Pillar E (`blake3` + SQLite AST cache) |
| **Overall I10 Composite Index** | `58.05` | `41.95` | **`>= 66.0` (#1 across ALL axes!)** | Full-stack late-2026 SOTA synthesis |
