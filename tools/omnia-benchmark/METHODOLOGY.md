# 10-Axis Coding Agent & Harness Benchmark Suite Methodology

## 1. Benchmark Provenance & Industry Alignment

This evaluation suite synthesizes the evaluation methodologies of the leading 2025–2026 coding agent and foundation model benchmarks into a single, deterministic, zero-Docker, Windows-native harness benchmark:

| Industry Benchmark | Core Principle Adopted | Mapped Suite Axis |
|---|---|---|
| **Artificial Analysis Intelligence Index v5 / Coding Agent Index v2.1** | Evaluates `(harness, model)` pairs jointly under a standardized runner; equal-weight composite 0–100 index + operational efficiency (tokens, latency, throughput) | Composite Scoring (`scorer.py`) + Axes 1–10 |
| **SWE-bench Verified** (Princeton / OpenAI) | Multi-file bug localization & patching verified strictly by hidden `FAIL_TO_PASS` (target fix) and `PASS_TO_PASS` (regression) execution tests | **Axis 1** (`swe_01`–`swe_03`) |
| **Terminal-Bench 4.1** (Stanford / Laude) | Multi-step CLI/Git/SQL/data-pipeline state engineering verified programmatically against final filesystem/repo/DB state and unseen hidden inputs | **Axis 2** (`term_01`–`term_03`) |
| **LiveCodeBench** | Contamination-free novel algorithmic synthesis verified against exhaustive edge cases, brute-force differential oracles, and asymptotic performance bounds | **Axis 3** (`algo_01`–`algo_03`) |
| **SWE-Atlas (Codebase Q&A)** | Deep cross-file repository navigation & architectural impact analysis with strict machine-verifiable JSON citation grading (exact file paths, symbols, line ranges) | **Axis 4** (`atlas_01`–`atlas_02`) |
| **BFCL v4 (Berkeley Function-Calling Leaderboard)** | Strict multi-step tool chaining, pagination/retry handling, schema compliance, AND abstention discipline (refusing forbidden actions on false-positive alerts) | **Axis 5** (`bfcl_01`–`bfcl_02`) |
| **SWE-Atlas Refactoring & Aider Polyglot** | Multi-file API migration with backwards-compatibility shims and dual-language (Python + Node.js/ESM) wire-protocol parity | **Axis 6** (`refact_01`–`refact_02`) |
| **Error Recovery & Self-Healing** | Cascading multi-fault broken build, circular import, encoding, ESM/CJS, and concurrency recovery where fixing fault *N* reveals fault *N+1* | **Axis 7** (`heal_01`–`heal_02`) |
| **Artificial Analysis Speed / Latency** | First-turn TTFT (median & p95), generation throughput (tokens/sec), and wall-clock task latency | **Axis 8** (Telemetry) |
| **SWE-bench / AA Token Economics** | Tokens-per-Resolved-Task (`total_tokens / resolved_count`), prompt cache hit rate (`cache_read / total_input`), turns/tool-calls per success, and tool error rate | **Axis 9** (Telemetry) |
| **Desktop & System Resource Profiling** | Live 250ms process-tree RSS (peak & mean MB) and CPU% during agent execution + cold-start latency, disk footprint, and idle desktop memory | **Axis 10** (System Profiling) |

---

## 2. Task Inventory (17 Deterministic Tasks across Axes 1–7)

| Axis | ID | Title | Languages / Tools | Grading |
|---|---|---|---|---|
| 1 | `swe_01_py_ledger` | Multi-currency double-entry ledger FX rounding & hold reconciliation | Python 3.13 | Hidden `FAIL_TO_PASS` + `PASS_TO_PASS` |
| 1 | `swe_02_py_scheduler` | DAG workflow executor fan-in, disconnected cycle detection & backoff cap | Python 3.13 | Hidden `FAIL_TO_PASS` + `PASS_TO_PASS` |
| 1 | `swe_03_js_router` | ESM trie router precedence backtracking, `%2F` param decode & async errors | Node.js ESM | Hidden `FAIL_TO_PASS` + `PASS_TO_PASS` |
| 2 | `term_01_git_archaeology` | Git bisect regression hunt, 3-branch merge conflict & selective revert | Git + Python | Git DAG ancestry + hash + functional checks |
| 2 | `term_02_log_etl_pipeline` | Multi-format telemetry ETL (JSONL/CSV/TSV/BOM/corrupt) + hidden re-run | Python CLI | Exact artifact match + hidden dataset re-run |
| 2 | `term_03_sqlite_migration` | Idempotent SQLite v1→v2 normalized schema migration + orphan quarantine | SQLite + Python | Schema/FK/sums/quarantine + 2x idempotency |
| 3 | `algo_01_temporal_k_shortest` | Time-windowed toll-surge shortest routing with waiting costs | Python 3.13 | Edge cases + brute oracle + perf stress |
| 3 | `algo_02_versioned_segtree` | Persistent lazy segment tree (`range_assign`/`range_negate`/`point_add`/`range_sum`/`range_max_subarray`/branching `snapshot`+`restore`) | Python 3.13 | Differential oracle + $N,Q=20\text{k}$ perf |
| 3 | `algo_03_regex_nfa_compiler` | ReDoS-immune Thompson NFA/PikeVM regex engine w/ captures (no `re`) | Python 3.13 | AST `re`-ban + captures + ReDoS `<50ms` |
| 4 | `atlas_01_trace_auth_flow` | Cross-service auth, TTL precedence & DLQ trace on 18-file monorepo | Py/TS/YAML/SQL | Exact JSON citation & line-range checks |
| 4 | `atlas_02_impact_analysis` | Breaking schema/HMAC protocol impact audit & zero-downtime rollout order | Py/TS/YAML/SQL | Ground-truth precision/recall & silent traps |
| 5 | `bfcl_01_incident_orchestrator` | Multi-alert ops tool chaining + abstention on false-positive alert | CLI tool + SQLite | HMAC audit log + DB state + JSON schema |
| 5 | `bfcl_02_schema_compiler` | Paginated API + deterministic 429 retry + strict schema reconciliation | CLI tool + JSON | Retry handling + state + strict schema |
| 6 | `refact_01_py_plugin_v2` | Async `ExecutionContext` v2 plugin refactor + v1 `DeprecationWarning` shim | Python 3.13 | Legacy v1 + v2 tests + AST migration check |
| 6 | `refact_02_polyglot_config_v2` | Dual-language Python + Node.js v2 envelope migration & v1 dual-read | Python + Node.js | Cross-runtime round-trip + v1 auto-upgrade |
| 7 | `heal_01_broken_py_pkg` | 6-fault cascading broken Python financial package recovery | Python 3.13 | `unittest` + CLI + hidden numerical checks |
| 7 | `heal_02_broken_node_service` | 5-fault cascading broken Node.js + Python subprocess bridge recovery | Node.js + Python | Unit tests + hidden Unicode/concurrency tests |

---

## 3. Canonical Telemetry & Token Normalization

Different agent harnesses report token counts with subtle accounting differences that invalidate naive comparisons if unnormalized:
- **Goose CLI (`--output-format stream-json`)**: `input_tokens` **includes** `cache_read_input_tokens` (`total_tokens = input_tokens + output_tokens`).
- **OMP CLI (`--mode json` / `--mode rpc`)**: per-turn `usage.input` **excludes** `usage.cacheRead` (`totalTokens = input + cacheRead + cacheWrite + output`).

`runner.py` normalizes all harnesses to an identical canonical accounting schema:
- `input_tokens`: Total prompt tokens processed (uncached + cache_read + cache_write).
- `uncached_input_tokens`: Newly processed prompt tokens (`input_tokens - cache_read_tokens - cache_write_tokens`).
- `cache_read_tokens`: Prompt tokens served from KV/prefix cache.
- `cache_write_tokens`: Prompt tokens written to KV/prefix cache.
- `output_tokens`: Total generated tokens (including reasoning/thinking tokens).
- `reasoning_tokens`: Subset of `output_tokens` spent in thinking/reasoning blocks (when reported).
- `total_tokens`: `input_tokens + output_tokens`.

---

## 4. 10-Axis Scoring Formula (`scorer.py`)

### Capability Axes (Axes 1–7, 0–100 each)
- Each task produces both a **binary pass@1** (`passed: true/false`) and a **continuous partial score** (`0.0–1.0`, used for diagnostic breakdown; strict pass@1 is used for headline scores matching SWE-bench Verified & Terminal-Bench).
- Each capability axis score $A_k \in [0, 100]$ is the mean pass@1 (%) of its tasks (strict mode) with partial-credit score also reported.
- **Coding Capability Index (7-Axis Equal-Weight Composite, AA v5 style)**:
  $$C_{\text{cap}} = \frac{1}{7}\sum_{k=1}^{7} A_k$$

### Operational & System Axes (Axes 8–10, 0–100 each)
Normalized relative to empirical reference anchors (or cohort bounds) so scores remain comparable across phases (pre-merge vs post-merge `omp-omni`):
- **Axis 8 (Speed & Throughput)**: Equal blend of normalized TTFT score ($\max(0, 100 \cdot (1 - \text{median\_ttft}/10.0))$), generation throughput ($\min(100, 100 \cdot \text{median\_tok\_s}/120.0)$), and wall-clock task speed ($\max(0, 100 \cdot (1 - \text{median\_wall}/300.0))$).
- **Axis 9 (Token Economics)**: Blend of tokens-per-resolved efficiency (log-scaled against 50k–1M tok/resolved anchor, penalizing zero-resolved runs to 0), prompt cache hit rate, and tool reliability (`1 - tool_error_rate`).
- **Axis 10 (System & Resource Efficiency)**: Blend of live task peak process-tree RSS MB (anchor 50 MB = 100, 1024 MB = 0), CPU efficiency, plus baseline cold-start latency and desktop idle RAM when `resource_baseline.json` is present.

### Overall 10-Axis Harness-Model Index
$$I_{10} = 0.70 \cdot C_{\text{cap}} + 0.10 \cdot A_8 + 0.10 \cdot A_9 + 0.10 \cdot A_{10}$$
Capability dominates at 70% (10% per capability axis), while Speed, Token Economics, and System Footprint contribute 10% each so a fast/cheap failing agent can never outrank a capable solving agent, yet among equally capable harnesses, operational efficiency cleanly breaks ties.
