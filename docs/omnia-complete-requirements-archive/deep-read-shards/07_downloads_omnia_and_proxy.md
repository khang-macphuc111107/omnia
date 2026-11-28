# Shard 07 — Exhaustive Deep-Read: `Downloads\Omnia\omnia` vs `D:\Omnia` & 3-Way `htmustc-proxy` Audit

- **Shard Owner:** `@verifier` (Read-Only Adversarial Verifier & Deep-Read Auditor)
- **Date:** `2026-11-28`
- **Audit Scope:**
  1. `C:\Users\khang\Downloads\Omnia\omnia\omnia\` (`224` files) vs `D:\Omnia` (`1,148` files)
  2. `C:\Users\khang\Downloads\Omnia\htmustc-proxy\htmustc-proxy\` (`1,372` files)
  3. `C:\Users\khang\Downloads\Omnia\htmustc-proxy_(0)\htmustc-proxy\` (`1,443` files)
  4. `D:\htmustc-proxy\` (`1,396` files)
- **Repo Integrity:** `D:\Omnia`, `D:\htmustc-proxy`, and `C:\Users\khang\.gemini` untouched (100% read-only).
- **Privacy & Non-Bypass Posture:** `0` credential/secret/DB/cookie/OAuth files read; CAPTCHA solvers (`internal/flowcaptcha/*`), cookie extractors (`capcut-worker/cookie-extractor/*`), billing-evasion disconnects (`autocut.go` pad/abort exploit), and vendor-identity spoofing (`claude_harness*.go` identity rewrite / forged protobuf signatures / synthetic web_search/code_exec blocks / number-quiz banks) explicitly segregated as **`DO_NOT_ADOPT`**.

---

## 1. Executive Summary & Top Discoveries

1. **Nested Archive Root Discovery:** All three Downloads folders wrap the actual repository one directory deeper (`...\omnia\omnia\`, `...\htmustc-proxy\htmustc-proxy\`, `...\htmustc-proxy_(0)\htmustc-proxy\`). After normalizing the wrapper prefix, exact SHA-256 & line-level diffing was completed across 100% of files.
2. **`Downloads\Omnia\omnia` vs `D:\Omnia` = ZERO Unported Code Missed:**
   - `224` total files (`90` byte-identical, `76` differing, `58` unique to Downloads = `55` retired Wave 4 C++20/CMake files already archived in `D:\OmniaData\backups\pre-full-rust-20261115\` + `3` stray MSVC/PowerShell junk files: `ModuleAnalysisCache`, `router-probe.obj`, `nul\r\ncl`).
   - Across all `76` differing files, **`0` functions exist in Downloads that are missing from `D:\Omnia`** (`dl_only_funcs = []` for every JS/PS/Py/MJS file). Every active `/api/*` endpoint from `cpp/src/studio/studio_server.cpp` (`2,500L`) is implemented and expanded in `D:\Omnia\rust\`.
   - The **only** historical prose in Downloads not verbatim in `D:\Omnia` is the `2026-11-13` `OMNIA-STUDIO-UI-REBUILD-20261113` rebuild specification in `docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md` (`180L` vs `136L`) and `DIRECTION_DECISION.md` §0 (`215L` vs `205L`), whose actual modular zero-bundler `ui/app/` implementation is already 100% present in `D:\Omnia\ui\`.
3. **MAJOR DISCOVERY — 3-Way `htmustc-proxy` Divergence (`htmustc-proxy_(0)` is a Massive Evolution Branch):**
   - `D:\htmustc-proxy` (`d_proxy`) is a small strict superset of `Downloads\Omnia\htmustc-proxy` (`dl_proxy`): `516` core files identical, `+4` crucial Codex MCP `/v1/responses` namespace-restoration source/test files (`responses_namespace.go` `681L`, `responses_namespace_writer.go` `153L` + tests), `4` small wiring diffs (`core.go`, `v1_g2a.go`, `v1_kiropool.go`, `plan_expiry_test.go`), and `21` runtime `data/combos/*.json` + `data/settings/*.txt` files.
   - **`Downloads\Omnia\htmustc-proxy_(0)` (`dl_proxy0`) is a HUGE newer divergent branch** containing **`+95` unique core files** and **`116` upgraded core files** (`+26,401` net core lines: `176,300L` vs `149,899L`), plus **`+16` new files and `644` modified files** in `third_party/grok2api` (`reasoning_cache.go`, HTTP/2 build transport, `stream_doomloop_test.go`, `quality-guard-query.ts`).
   - Meanwhile, `dl_proxy`/`d_proxy` hold **`31` files absent from `dl_proxy0`**: all `11` `docs/*.md` architecture/upgrade/provider specs (`2,693L`: `SRS.md`, `PLAN-UPGRADE-2026-09.md`, `FOLLOWUPS-2026-09.md`, `DEEPGRAM_PROVIDER.md`, `CAPCUT_*.md`, `T1.7-TRUST_PROXY.md`, `PROMPTS-FOR-EXECUTOR.md`), `HUONG-DAN.txt`, and legacy `internal/flowapi/*` (`16` files, superseded in `dl_proxy0` by `internal/flowweb/*` + `internal/proxy/flow_{session,generate,method}.go`).
   - **Critical Gap Between `D:\htmustc-proxy` and `htmustc-proxy_(0)`:** `d_proxy` has `responses_namespace*.go` (which `dl_proxy0` lacks!), whereas `dl_proxy0` has dozens of production battle-hardened upgrades (security, scheduler, quota, SSE, schema sanitization, `O(N)` Codex translation, image hedge/fan-out, SSRF guards, standalone bootstrap, relay audit suite) that `d_proxy` lacks!
4. **Top Legitimate Engineering Gems Harvested for `D:\Omnia` & `agy`/`agy-fast`:**
   - **Routing & Resilience:** Soft-fail demotion vs cooldown (`scopeNone` 5s demotion never causes single-account 503 outages), `preferProvenLocked` (`1-in-4` exploration probe preventing 371/371 single-account starvation), `QuotaResetPoolUntil` + HTTP 429 `resets_in_seconds`, `notServedTracker` (breaks 12h 429 retry loops with honest 404), `ModelRetiredError` detection (Code Assist HTTP 200 canned retirement notices), `ComboSet` nested DAG failover + 30s active `ComboProbe` recovery, `ShouldRetrySameAccount` (0/250/750ms burst replay), `MutateAccount` field-scoped atomic persistence (`ErrSkipWrite`), and `slotFree` broadcast channel wakeup.
   - **Wire Fidelity, KV-Cache & Performance:** `codex_translate.go` (`O(N)` vs `O(N^2)` 1.4s -> 4ms on 3,200-item / 2.1 MB Codex histories!), `responses_namespace.go` (`ResponsesNamespaceMap` + `flattenResponsesRequestTools` + `RestoreResponsesNamespaces` fixing Codex MCP/collab namespace stripping), `gemini_wire_fixes.go` (`CleanJSONSchemaRecursive` + `DisambiguateLongToolName` 55+`_8hex` + `normalizeGeminiContentsTurns`), `claude_to_chat.go` (byte-stable Anthropic->OpenAI translator preserving KV cache), `sortToolsStable` + `logCacheShape` 8-hex prefix-drift hashing, `grok2api/reasoning_cache.go` (scoped LRU encrypted-reasoning cache), `v1_stream_output.go` (hold-back with `frameEchoesRequest` exemption + zero-output `ErrEmptyCompletion`), and `SentEffort` post-shaping wire verification (`effort_report.go`).
   - **Security, Media & Ops:** `mgmt_account_redact.go` (allowlist-based lossless `***redacted***<last4>` round-trip), `session.go` (epoch-bound HMAC sessions + `RevokeAllSessions` + zero built-in default password + standalone cryptographic first-run password), `cors.go` (`operatorSurface` zero-CORS isolation + strict named-origin credentials), `logger.go` (`redactQuery` + `RedactPath`), `image_source.go` + `remote_asset.go` (DNS-rebinding-proof `dialPublicOnly` + per-hop `guardAssetRedirects` SSRF defense + `ShareSourceResolution` once-per-request fetch cache), `v1_models.go` (adaptive `imageHedgeWidth=2` hedging + `runImageFanOut` straggler cutoff), `internal/audit/*` (6-probe relay & Anthropic SSE state-machine integrity auditor), `quota_kept.go` (stale-while-error quota snapshots), `ringlog.go` (5,000-line pub/sub live console ring), and zero-bundler dashboard UX (`palette.js` Ctrl+K, `sparklineSVG`, `design.md` uniform 36px/32px tokens, `i18n` parity tests).

---

## 2. Complete 5-Tree Coverage Ledger (Zero-Skipping Attestation)

Every directory tree was inventoried (`D:\OmniaData\qa\v5-verify\shard07\inventory.json`, `dl_omnia_deep_diff.json`, `proxy_deep_analysis.json`) excluding VCS/build caches (`.git`, `node_modules`, `__pycache__`, `target`, `build`, `dist`). Every readable non-sensitive text file was read in full (`python -B` structural/symbol/diff extractors + direct line-by-line `read_file` verification of all primary specs and core modules).

| Tree | Root Path | Core Readable Files | Core Lines Read | Core Bytes Read | `third_party/` Readable Files | `third_party/` Lines Read | Excl. Sensitive | Excl. Non-Bypass | Excl. Binary | Total Accounted |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **`dl_omnia`** | `C:\Users\khang\Downloads\Omnia\omnia\omnia` | 222 | 55,892 | 2,724,360 | 0 | 0 | 0 | 0 | 2 | **224** |
| **`dl_proxy`** | `C:\Users\khang\Downloads\Omnia\htmustc-proxy\htmustc-proxy` | 539 | 149,899 | 5,514,842 | 671 | 238,853 | 6 | 4 | 152 | **1,372** |
| **`dl_proxy0`** | `C:\Users\khang\Downloads\Omnia\htmustc-proxy_(0)\htmustc-proxy` | 595 | 176,300 | 6,506,919 | 687 | 248,700 | 0 | 9 | 152 | **1,443** |
| **`d_proxy`** | `D:\htmustc-proxy` | 563 | 152,014 | 5,589,562 | 671 | 238,860 | 8 | 4 | 150 | **1,396** |
| **`d_omnia`** (ref) | `D:\Omnia` | 1,148 (ref baseline) | — | — | — | — | — | — | — | **1,148** |

### Explicit Exclusion Ledger (Privacy & Non-Bypass Compliance)

- **Excluded Sensitive Files (NEVER READ):**
  - `dl_proxy` (`6`): `config.yaml`, `data/session.secret`, `data/grok2api/config.yaml`, `data/grok2api/internal-client-key.txt`, `data/grok2api/data/grok2api/backend.db`, `data/kiropool/config.json`.
  - `d_proxy` (`8`): same `6` as `dl_proxy` PLUS `data/accounts/<redacted-email>.json` and `data/logs/requests-2026-10-20.jsonl`.
  - `dl_proxy0` (`0`): archive ships without live `data/` secrets.
- **Excluded Non-Bypass Boundary Files (NEVER READ OR EXTRACTED):**
  - `capcut-worker/cookie-extractor/{README.md,manifest.json,popup.html,popup.js}` (`4` files across all 3 proxy trees — browser cookie-extraction extension).
  - `internal/flowcaptcha/{captcharun.go,flowcaptcha.go,flowcaptcha_test.go,remote.go,solver.go}` (`5` files in `dl_proxy0` — CAPTCHA-solving client/runner).
- **Excluded Binary Files:**
  - `dl_omnia` (`2`): stray `Microsoft/Windows/PowerShell/ModuleAnalysisCache` (`8,246 B`), `router-probe.obj` (`279,954 B`).
  - Proxy trees (`150–152` each): compiled `.exe`/images/fonts/icons/vendored static assets in `third_party/`.

---

## 3. Exhaustive Diff: `Downloads\Omnia\omnia` vs `D:\Omnia`

Normalized root `C:\Users\khang\Downloads\Omnia\omnia\omnia` (`224` files) represents the **Wave 4 C++20 / PR #1 UI-rebuild snapshot (2026-11-14)** prior to the Steer #14–#23 Pure-Rust 17-crate migration and `ui-v5` Flagship Studio expansion in `D:\Omnia` (`1,148` files).

### 3.1 Breakdown by Category

| Category | File Count | Verification Result |
|---|---:|---|
| **Byte-Identical (`same`)** | **90** | Exact SHA-256 match with `D:\Omnia` (`docs/storage-schema.sql`, `ui/app/core/{dom,i18n,icons,overlay,palette,prefs,router,sessions,shell,store}.js`, `ui/app/lib/{highlight,latex,markdown,sha256}.js`, `ui/styles/**`, `ui/index.html`, `tools/agy-history-sync/**`, `12` skill files). |
| **Differing (`diff`)** | **76** | Line-by-line unified diff verified across all `76` files. **`dl_only_funcs = []` across every code file.** `D:\Omnia` is strictly newer/expanded across every subsystem. |
| **Only in `dl_omnia` (`only`)** | **58** | `55` retired C++20/CMake files (`CMakeLists.txt`, `CMakePresets.json`, `cpp/**` 33 files, `native/CMakeLists.txt` + `native/{include,src,tests}/**` 20 files) + `3` stray junk files (`ModuleAnalysisCache`, `router-probe.obj`, `nul\r\ncl` 551B). |

### 3.2 Detailed Audit of All `76` Differing Files

- **`ui/` (`22` differing files — zero missed functions):**
  - `ui/app/api.js` (`358L` in Downloads vs `632L` in `D:\Omnia`): `D:\Omnia` retains all 16 original routes and adds all runtime/agent/notebook/omnidrive/benchmark endpoints.
  - `ui/app/views/{agents,chat,knowledge,routing,settings}/*.js` & `ui/tests/*.test.js`: diffs are strictly C++20->Rust label updates (`C++ Core` -> `Rust Core`, `cplusplus` -> `rustEdition`, `quickCpp` -> `quickRust`), minor 1–10 line bugfixes already landed in `D:\Omnia`, and expanded transport/API tests (`transport.test.js` `69L` -> `140L`).
- **`native/qa-*.ps1` (`10` differing files):**
  - Downloads uses legacy `$process.MainWindowHandle` / `$process.CloseMainWindow()` and `omnia-cpp-native-{release,debug}` paths. `D:\Omnia` has strictly superior Windows 11 IME-safe `EnumWindows` class filtering (`OmniaNativeShellClass`) + `PostMessageW(WM_CLOSE)` (`a41c4d6`) + `omnia-rust-native-*` paths (`qa-capture.ps1` `133L` -> `201L`).
- **`.agents/skills/` (`9` differing files):**
  - Downloads has an older `omni-bilingual-skill-router/scripts/skill_router.py` (`412L` vs `702L` in `D:\Omnia` which adds 1,001-skill cold-vault indexing, Merkle verification, and 16/16 golden eval) and earlier `SKILL.md` descriptions (`deep-cpp-native`, `autonomous-power-continuity`, `omni-deterministic-verifiers`).
- **`tools/maintained-scripts/stage-public-release{.mjs,.test.mjs}` (`2` differing files):**
  - Downloads checked for `cpp/`/`CMakeLists.txt` and refused `.rs`/`Cargo.toml`; `D:\Omnia` properly inverted this contract for the pure-Rust 17-crate workspace (`256L` -> `269L`).
- **`docs/` & Root Governance (`33` differing files):**
  - `CHECKPOINT.md`, `GOAL.md`, `DOD.md`, `PLAN.md` (`34L` -> `251L`), `DECISIONS.md` (`233L` -> `261L`), `STEER_QUEUE.md`, `CODEBASE_AUDIT_20261114.md` (`380L` -> `386L`), `CODEBASE_ROADMAP_20261114.md` (`177L` -> `183L`), `AGENTS.md`, `README.md`, `docs/handoff/*.md` are all strictly superseded by Steer #15–#23 updates in `D:\Omnia`.
  - **Only Historical Doc Delta Noted:** `docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md` (`180L` in Downloads = `OMNIA-STUDIO-UI-REBUILD-20261113` spec documenting the `ui/` zero-bundler platform API `html`/`morph`/`rovingFocus`/`data-morph-skip` and 5-view ownership contract) and `DIRECTION_DECISION.md` §0 (`215L` vs `205L`). The **actual implementation** of that entire spec (`ui/app/core/*`, `ui/app/lib/*`, `ui/styles/*`, `ui/app/views/*`) IS ALREADY in `D:\Omnia\ui\`.

### 3.3 Verification of All `55` Retired C++20/CMake Files (`dl_omnia_only`)

Every C++20 component (`cpp/include/omnia/*`, `cpp/src/*`, `native/include/omnia_native/*`, `native/src/*`) was symbol-checked against `D:\Omnia\rust\`:
- `cpp/src/core/{json,redactor,sha256,utf8}.cpp` -> `rust/omnia-core/` (superseded + expanded with Vietnamese normalization & checked ints).
- `cpp/src/graph/{graphify_index,peer_mesh}.cpp` (`197L` + `726L`) -> `rust/omnia-graph/` (superseded + hardened with AUD-26..28 path/epoch/recipient guards).
- `cpp/src/harness/{composer_steer,memory_graph,proactive_rag,skill_registry}.cpp` -> `rust/omnia-harness/` (superseded + FTS5 revision fencing + 22 skills + cold vault).
- `cpp/src/routing/dynamic_router.cpp` (`1,257L`) -> `rust/omnia-routing/` (superseded + AUD-09 zero-mutation `simulate: true`).
- `cpp/src/storage/session_store.cpp` (`831L`) -> `rust/omnia-winsqlite/` + `rust/omnia-storage/` (superseded + explicit `ROLLBACK` on failed `COMMIT` + keyset paging).
- `cpp/src/studio/studio_server.cpp` (`2,500L`) -> `rust/omnia-studio/` + `rust/omnia-runtime/` (all 16 original routes present, `0` missing routes; expanded with WebSocket, runtime chat, Atelier, OmniDrive, benchmarks, `ui-v5` `rust-embed`).
- `native/src/{win32_shell,uia_provider,composer,session_panel,sessions,store,types,qa_seed}.cpp` (`7,359L`) -> `rust/omnia-native/` (100% pure-Rust Win32 + DWM Mica + Direct2D + COM UIA + `WH_CBT` + WebView2 `--studio` + `omnia_qa_seed.exe`, verified 90/90 in native QA).

**Verdict for `Downloads\Omnia\omnia`:** **100% accounted for; ZERO unported production code, UI modules, or scripts missed.** Safe to treat as historical Wave 4 C++20 archive (already preserved externally in `D:\OmniaData\backups\pre-full-rust-20261115\`).

---

## 4. Exhaustive 3-Way Diff & Architecture Deep-Read: `htmustc-proxy`

### 4.1 3-Way Relationship Map (`dl_proxy` vs `dl_proxy0` vs `d_proxy`)

| Comparison Pair | Identical Core Files | Only in Left | Only in Right | Modified Core Files | Net Character |
|---|---:|---:|---:|---:|---|
| **`dl_proxy` vs `d_proxy`** | 535 | 0 | **25** (`4` Go + `21` `data/` JSON/TXT) | **4** (`core.go`, `v1_g2a.go`, `v1_kiropool.go`, `plan_expiry_test.go`) | `d_proxy` = `dl_proxy` + **Codex MCP `/v1/responses` namespace restoration** (`responses_namespace*.go`) + local runtime combos. |
| **`dl_proxy` vs `dl_proxy0`** | 384 | **31** (`11` `docs/*.md`, `HUONG-DAN.txt`, `16` `internal/flowapi/*`, `3` `flow_mint_worker`/`st_refresh`) | **95** (`internal/audit/*`, `internal/flowweb/*`, `internal/app/standalone*`, `proxy/codex_translate.go`, `proxy/autocut*`, `proxy/claude_harness*`, `proxy/antigravity_entitlement.go`, `proxy/image_{source,fit}.go`, `proxy/model_retired.go`, `proxy/effort_report.go`, `handler/{model_not_served,quota_reset,mgmt_claude_harness_audit}.go`, `tools/gen_flow_models.py`, etc.) | **116** (`+26,401` net lines: `gemini_wire_fixes.go` +722L, `quota_codeassist.go` +480L, `page-providers.js` +769L, `core.go` +360L, `v1_models.go` +279L, `responses.go` +267L, `session.go` +162L, `scheduler.go` +147L, `cors.go`, `logger.go`, `account_health.go`, `account_quota.go`, `remote_asset.go`, `v1_raw.go`, etc.) | **`dl_proxy0` is a much newer production branch** with major scheduler, security, quota, schema, streaming, image-hedging, and standalone upgrades, PLUS `grok2api` upgraded (`+16` files, `644` modified). |

### 4.2 Complete Subsystem Deep-Read (Every Package Covered)

#### A. Multi-Account Scheduler, Health & Quota State Machine (`internal/proxy/{scheduler,account_health,classify,quota_codeassist,quota_kept,antigravity_entitlement,model_retired}.go`, `internal/storage/account_quota.go`, `internal/api/handler/{model_not_served,quota_reset}.go`)
- **4-Tier Candidate Partition (`scheduler.go:622-721`):** Strictly separates `candidates` (clean) -> `demoted` (5s `softFail` transient errors, model locks, timed cooldowns) -> `spent` (inferred quota exhaustion without stated reset) -> hard exclusions (`disabled`, local `QuotaLimit`, manual/auth `UnhealthyUntil == nil`, `suspended`, **provider-stated `QuotaResetAt`**, and pre-flight `AntigravityEntitlementError` tier mismatch such as `g1-ultra-tier` for Argon).
- **Soft-Fail Demotion vs Cooldown (`account_health.go:77-163`, `691-725`):** Transient 429s, 5xxs, timeouts, and empty 200s map to **`scopeNone`** — recorded in memory (`softFail` 5s window) so healthy peers are preferred immediately, **without** locking out a single-account pool (eliminating false 503 outages when 11/12 sibling accounts are on quota).
- **Proven-Model Discovery with Anti-Starvation Exploration (`scheduler.go:43-66`, `993-1091`):** `Account.ModelOK` records models proven to work on each account; `preferProvenLocked` narrows picks to proven accounts **except every 4th pick (`probeUnprovenEvery = 4`)**, which rotates inside an isolated `tierKey + "\x00probe"` namespace to explore unproven credentials until all entitled accounts are discovered (preventing the measured production failure where 371/371 requests pinned onto 1 of 67 identical Codex accounts!).
- **Stated Provider Quota Reset & Honest 429 (`storage/account_quota.go:76-103`, `scheduler.go:792-829`, `handler/quota_reset.go:25-89`):** Distinguishes provider-stated `QuotaResetAt` (e.g., Codex `usage_limit_reached` `resets_at`) from inferred exhaustion (`QuotaExhaustedUntil`), never shortens a later deadline, bounds at `MaxQuotaExhaustion = 7d`, skips guaranteed-429 accounts, and when the entire pool awaits stated resets, responds immediately with HTTP 429 + exact `Retry-After` + `code: "usage_limit_reached"` + `resets_in_seconds`.
- **Anti-12h-Retry-Loop 404 Tracker (`handler/model_not_served.go:24-67`) & Retired-Model 200 Detector (`proxy/model_retired.go:30-93`):**
  - `notServedTracker` observes failover errors: if EVERY account answers Code Assist's bare 404 `"Requested entity was not found"`, immediately returns HTTP 404 `model_not_found` instead of 12h of `429 Retry-After: 1`.
  - `detectRetiredNotice` catches Google Code Assist's HTTP 200 canned retirement strings (`"<Model> is no longer available. Please switch to <Successor>."` with absent `usageMetadata`/`modelVersion`/`responseId`/`finishReason`/`role`) on the first SSE frame -> returns HTTP 404 verbatim without punishing accounts or looping.
- **Broadcast Slot Wakeup & Zero-I/O Hot Path (`scheduler.go:155-166`, `1116-1189`; `account_health.go:509-609`; `storage/atomicwrite.go`):**
  - `slotFree chan struct{}` is lazily created only when all accounts are busy and **closed** on `ReleaseAccount` to broadcast-wake all parked selectors simultaneously (eliminating stale buffered-token theft across unrelated providers).
  - `AccountManager` buffers token usage deltas in memory (`usageFlushLoop` flushes once/second via atomic field-scoped `MutateAccount`), uses `storage.ErrSkipWrite` sentinel to skip disk writes when health/proof stamps are unchanged, and uses `CreateTemp -> Write -> Sync -> Close -> Chmod -> Rename` (`atomicwrite.go`) to prevent truncated account files on crash.
- **Conversation Affinity Preserved Under Round-Robin (`scheduler.go:941-985`):** Even when a provider is pinned to `round_robin` (`sticky_limit=1`), active conversations retain `SessionAffinity` (2h TTL) to preserve per-credential upstream KV prompt caches (measured jump from 26% -> 41% overall cache hit and up to 96% on large prompts!).
- **Code Assist Summary Quota & Stale-While-Error Cache (`quota_codeassist.go:1-1103`, `quota_kept.go:1-180`):**
  - Calls `:loadCodeAssist` -> polls async `:onboardUser` to auto-provision missing `project_id` on fresh OAuth accounts -> calls `:retrieveUserQuotaSummary` (`5h` + `weekly` windows across `Gemini Models` and `Claude and GPT models`, marking `disabled: true` 5h buckets as `Inactive` when weekly is spent instead of fake 100% green bars!) -> falls back to `:fetchAvailableModels` / `:retrieveUserQuota` with 0.1% rounding (`codeAssistPercent`), `google.protobuf.Duration` (`"2532s"`), and quoted int64 epoch parsing.
  - `quota_kept.go` serves the last good snapshot with its `UpdatedAt` timestamp when upstream quota endpoints return 429/5xx (never blanking dashboard cards on transient outages), while clearing on 401/403 auth failures and expiring Antigravity kept snapshots after 2m (`keptQuotaFreshFor`).

#### B. Combo Failover Chains & Active Health Recovery (`internal/proxy/{combo,combo_health}.go`)
- Supports `fallback`, `round-robin`, and `random` strategies with explicit `combo/` addressing prefix, nested DAG expansion (`comboMaxDepth = 4`), and self-shadowing (`"gpt-4o" -> ["gpt-4o", "claude-sonnet"]` treated as real model + fallback, not a cycle).
- Decoupled `mu`, `turnMu`, and `benchMu` locks so round-robin cursor increments and benching never block hot-path lookups; read-only `Chain()` avoids mutating round-robin cursors during dashboard polling.
- **`demoteBenched` (demote-never-drop):** Failing combo members are moved to the tail rather than removed, keeping them reachable as last resort; `RecordChainFailureFor` applies flat model-scoped locks (no backoff escalation) so failing member 1 never benches the shared provider for member 2; background `RunProbes` (`ComboProbeInterval = 30s`, `comboProbeTick = 5s`) with `probing` anti-stampede flag restores primary members automatically (`ErrComboProbeUndecided` restores so real traffic decides).

#### C. Protocol Translation, Wire Repairs & KV-Cache Invariance (`internal/proxy/{codex_translate,responses_namespace,gemini_wire_fixes,claude_to_chat,responses,responses_bridge,effort_report}.go`, `handler/responses_namespace_writer.go`)
- **`O(N)` Linear Codex Translation (`codex_translate.go:37-229`):** Eliminates `CLIProxyAPI/v7`'s `O(items * body)` `gjson`/`sjson` quadratic loops by detaching `input[]` in `openai-response -> codex` (single-pass byte-offset `system -> developer` splice) and chunking `messages[]` in batches of `16` (`chatCodexChunk`) with stripped tool-name-only headers for `chat -> codex`. **Measured speedup: `1.4s -> 4ms` (350x faster!) on a 3,200-item, 2.1 MB session**, dropping proxy CPU share from 92% to negligible while staying byte-identical to upstream translator output.
- **Codex MCP & Collab `/v1/responses` Namespace Restoration (`D:\htmustc-proxy\internal\proxy\responses_namespace.go:1-681` & `handler/responses_namespace_writer.go:1-153`):**
  - Builds per-request `ResponsesNamespaceMap` from top-level `tools[]` AND recursive `input[]` (`additional_tools`, `tool_search_output`, historical `function_call`/`custom_tool_call`), explicitly excluding `rootFunctionsNamespace = "functions"` and colliding ambiguous tool names.
  - `flattenResponsesRequestTools` expands `type: "namespace"` & dynamic input declarations (`defer_loading` stripped, deferred upgraded by active defs) for Chat/Claude/Gemini/Antigravity upstreams that otherwise drop nested namespace tools.
  - `RestoreResponsesNamespaces` & streaming `responsesNamespaceWriter` (16 MiB bounded hold for non-stream JSON, line-buffered SSE restoration) repopulate missing `"namespace"` and original un-sanitized `"name"` on outbound `function_call` / `custom_tool_call` items across direct and sidecar (`grok2api`, `kiro-pool`) routes!
- **Gemini / Antigravity Wire & Proto-Schema Sanitizer (`gemini_wire_fixes.go:57-800+`):**
  - `CleanJSONSchemaRecursive(rawSchema, strictGemini)`: resolves local `$defs`/`definitions` `$ref`, merges `allOf`, flattens `anyOf`/`oneOf` (scoring `object > array > primitive`), converts `const -> enum`, collapses `["string","null"] -> "string"`, strips 55+ unsupported JSON Schema keywords, enforces Gemini Proto-Schema invariants (`items` ONLY on `array`, `properties`/`required` ONLY on `object`, string-only `enum`), and filters `required[]` to keys present in `properties` (eliminating 400 `requires unspecified property`).
  - `DisambiguateLongToolName`: deterministically shortens >64-char MCP tool names to `<55-char-prefix>_<8hex-SHA256>` (= 64 chars) preventing duplicate truncated declarations.
  - `normalizeGeminiContentsTurns`: prevents 400 `Requests ending with a model turn are not supported` on multi-agent handoffs by merging trailing pure-text `model` turns into `user` (or appending `Continue.` after `functionCall`/`thought`).
  - `sanitizeGeminiThoughtSignatures`: replaces non-base64 cross-provider `thoughtSignature` with `skip_thought_signature_validator` on model turns and removes them on non-model turns.
- **Byte-Stable Anthropic -> OpenAI Direct Translator (`claude_to_chat.go:47-256`, `responses_bridge.go:29-44`):** Replaces non-deterministic SDK translation with single-pass fixed-order parsing, lifting prompt-cache hit rates from `24-49%` up to `92-98%`.
- **Legitimate KV-Cache Prefix-Drift Telemetry & Tool Sorting (`autocut.go:485-727` — *extracted cleanly, excluding billing-evasion cut engine*):**
  - `sortToolsStable(req)`: lexicographically sorts `tools[]` by `name` (capped at 256 tools) so client tool-ordering jitter never busts prefix KV cache.
  - `sanitizeInputToolNames(req)`: rewrites illegal historical tool names outside `^[a-zA-Z0-9_.-]+$` to `_`.
  - `logCacheShape(req)`: logs 8-char SHA-256 digests of `instr_h`, `tools_h`, `first5_h`, `first10_h`, `input_head_h`, `last2_h`, `include_h`, `text_h`, `meta_h`, `reasoning_h`, `tc_h`, `body_h` per turn — immediately pinpointing which exact JSON field drifted and invalidated KV cache!
- **Post-Shaping Wire Effort Audit (`effort_report.go:31-122`, `mgmt_effort_limits.go:26-132`):** Instead of trusting policy intent, `Dial` reads the *actual* serialized outbound wire bytes (`SentEffort`: Claude `output_config.effort` + per-turn max + `thinking.budget_tokens`, Codex/Responses `reasoning.effort`, Gemini `thinkingLevel`/`thinkingBudget`) and logs it alongside requested effort so effort-ceiling enforcement is empirically verifiable.
- **Scoped Reasoning Proof Cache (`third_party/grok2api/.../conversation/reasoning_cache.go:24-195`):** 4,096-entry, 30m-TTL LRU cache keyed by `scope + "\x00" + normalized_call_id` (handling `call_id|item_id` and `toolu_` prefix normalization) so parallel tool calls preserve their preceding encrypted reasoning proof across stateless round-trips without cross-conversation leakage.

#### D. Streaming Resilience, Empty-200 Hold-Back & Retry Architecture (`internal/proxy/{empty_sse,classify}.go`, `internal/api/handler/{v1_raw,v1_retry,v1_stream_output,v1_models}.go`)
- **Zero-Allocation Hold-Back & Output Detection (`v1_stream_output.go:32-189`, `empty_sse.go:34-201`):**
  - Holds opening SSE frames off the wire until `payloadCarriesOutput` sees real content/delta/tool/image/embedding bytes (making pre-output failover 100% invisible to clients!).
  - **`frameEchoesRequest` Breakthrough (`v1_stream_output.go:60-83`):** Exempts bulky Responses API echo frames (`response.created`, `response.in_progress` which echo 30–80 KB of instructions/tools) from the hold-back byte ceiling — fixing a bug where 17–44% of Codex requests committed prematurely on frame 1 right before an in-band `server_is_overloaded` error!
  - **Typed Smuggled-200 Classification (`empty_sse.go:151-179`):** Parses in-band `"error"` JSON inside HTTP 200 SSE frames through `UpstreamError.IsRequestScoped()` so permanent `cyber_policy`/`invalid_request`/`context_length_exceeded` rejections fail fast in 200ms instead of burning 60–75s across 4 accounts!
  - **Multi-Format Completion State Machine (`empty_sse.go:51-94`):** Recognizes `[DONE]`, `"finish_reason":"` (excluding `null`), `"response.completed"`, `"response.done"`, `"response.incomplete"`, `"type":"message_stop"`, and `"finishReason"`. Distinguishes `ErrEmptySSE`, `ErrIncompleteSSE` (2m cooldown — `incompleteStreamCooldown`), and `ErrEmptyCompletion` (well-formed 200 with zero output/usage).
- **Bounded Wall-Clock Failover & Same-Account Burst Replay (`v1_retry.go:110-336`, `classify.go:524-563`):**
  - `failoverDeadline = 60s` wall-clock cap (checked only *between* attempts, never mid-stream), `maxFailoverRounds = 3` (`300ms` inter-round pause), `ShouldRetrySameAccount` (`0ms / 250ms / 750ms` immediate replay for burst 429s & empty 200s), and `shouldForceTokenRefresh` skipping pointless refresh+replay on `IsTokenInvalidated` or static API keys without `refresh_token`.
- **Adaptive Image Hedging & Fan-Out (`v1_models.go:273-659`, `responses.go:362-649`, `image_fit.go:1-133`):**
  - Widens concurrency to `imageHedgeWidth = 2` ONLY *after* observing an upstream `"currently overloaded"` refusal (zero extra cost on healthy days; cancels losing hedge via `raceCtx` without blaming the losing account).
  - `runImageFanOut` spawns `N` (`<= 4`) independent hedged failover runs for 1-image-per-call backends, enforces `imageStragglerWait = 90s` after the first picture arrives + `imageFanOutCutoff = 240s` hard cutoff so partial pictures are returned before the gateway's 300s timeout!
  - `codexImageSteering` injects aspect-ratio/pixel-budget hints (`1536*1024 ≈ 1.57 MP`) into the prompt and post-scales/center-crops via `fitImageToSize`/`cropImageToRatio`, plus `imageHostModels` fallback (`gpt-6-luna -> gpt-5.6-luna -> gpt-6.1-sol`) when a driving text model leaves a plan.

#### E. Security Hardening, SSRF Defense & Standalone Mode (`internal/api/{session/session,middleware/cors,middleware/logger,handler/mgmt_account_redact}.go`, `internal/proxy/{image_source,remote_asset,outbound}.go`, `internal/app/standalone.go`)
- **Allowlist Lossless Credential Redaction (`mgmt_account_redact.go:32-172`):** Only `29` explicit non-secret metadata keys (`publicCredentialKeys`: `email`, `plan_type`, `tier_id`, `base_url`, `project_id`, etc.) pass in cleartext; every other key is masked to `***redacted***<last4>` on a shallow copy; PUT restores echoed placeholders from stored state (`restoreMaskedCredentials`) and POST strips placeholders (`dropMaskedCredentials`).
- **Epoch-Bound Stateless Sessions & Zero Default Password (`session.go:27-396`, `standalone.go:89-165`):**
  - Removes legacy `"123456"` default completely: unconfigured server refuses login with rate-limited `SECURITY` alert; standalone double-click mode (`standalone.go`) generates 96-bit cryptographic random `base64` password into `config.yaml` (`0600`) and prints it once on first run (`PauseIfOwnConsole` keeps Explorer console open on fatal error).
  - Cookies carry `HMAC-SHA256("dashboard-session\n" + exp + "\n" + epoch)` — domain-separated from 30-day signed media asset links (`assetlink.go`). Password change or `POST /api/auth/logout-all` rotates random `epoch` *before* persisting the new bcrypt hash, instantly invalidating every active session without breaking published media links!
- **Strict Operator-Surface CORS & Log Hygiene (`cors.go:29-117`, `logger.go:20-104`):**
  - `operatorSurface()` emits **zero** CORS headers on `/api/management/*`, `/api/auth/*`, `/management/*`, `/login/*`, and embedded admin consoles; wildcard `*` never emits `Access-Control-Allow-Credentials: true`; `Access-Control-Max-Age` fixed to `strconv.Itoa` (fixing UTF-8 codepoint bug!).
  - `redactQuery` replaces all query values with `***` while preserving sorted parameter names; `RedactPath` masks path-carried tokens (`/antigravity/***/...`).
- **DNS-Rebinding-Proof SSRF Defense (`image_source.go:76-241`, `remote_asset.go:88-267`):**
  - `dialPublicOnly` resolves DNS once, rejects if *any* returned IP is non-public (RFC1918/loopback/link-local/metadata/multicast/unspecified), and dials the vetted IP directly.
  - `guardAssetRedirects` re-validates every HTTP 3xx redirect hop (max 10 hops) against `RemoteAssetURLIsSafe` while preserving `Range` / `206 Partial Content` / `ETag` / `304` media scrubbing.
  - `imageSourceCache` (`ShareSourceResolution`) downloads caller-supplied edit/reference URLs **once** per request across retries/hedges/fan-out, routing through the account's `strict_proxy` transport without `NoProxy` bypasses.
- **Outbound Proxy Pool Memoization (`outbound.go:88-346`):** Keys memoized HTTP/SOCKS5 transports by `(poolID, strict)` and validates freshness via string equality `(url, noProxy)` (avoiding Windows ~0.5ms clock-tick timestamp collisions!), supports `host:port:user:pass` vendor shorthand, enforces `strict_proxy` fail-closed while allowing `doRelaxed` for quota reads, and auto-buffers `<= 16 MiB` replayable bodies only for non-strict fallback transports.

#### F. Relay Integrity Auditor (`internal/audit/{claude_harness,probes,sse}.go`, `handler/mgmt_claude_harness_audit.go`)
- Runs **6 bounded synthetic probes** (max 20 requests, 30s/req, 180s total, 2 MiB body cap, `CheckRedirect` refusing all redirects so `x-api-key` never leaks, `atomic.Bool` single-flight mutex):
  1. `token_usage` — compares `input + cache_read + cache_creation` vs baseline within tolerance; flags negative tokens.
  2. `identity_signals` — channel fingerprint (`msg_` prefix, `type: "message"`) + latency & family signals (with honest disclaimer that self-report is heuristic, not cryptographic proof).
  3. `sse_integrity` (`sse.go:30-246`) — **full Anthropic SSE finite-state verifier** validating event/type match, `message_start`, sequential non-overlapping `content_block_start`/`delta`/`stop`, delta-to-block type match (`text_delta`/`input_json_delta`/`thinking_delta`/`signature_delta`), monotonic non-regressing usage counters, `message_delta` `stop_reason`, `message_stop`, no trailing/unterminated frames, and presence of thinking signatures.
  4. `context_canaries` — optional binary-search 5-marker `CANARY_<16hex>` recall scan up to `MaxContextChars` (`1,024..65,536`).
  5. `tool_integrity` — forced inert `tool_choice` (`record_package` with `audit-canary-package@1.2.3`), never executed.
  6. `error_leakage` — sends 7 malformed payloads (missing model, bad messages, invalid role, negative/string `max_tokens`, bad tool schema, bad `tool_choice`) checking for HTTP 400/422 enforcement AND scanning responses for leaked `APIKey`, `sk-*`, `Bearer *`, `PRIVATE KEY`, Python tracebacks, or host filesystem paths!

#### G. Multimodal & Media Adapters (`deepgram`, `capcut-worker`, `flowweb`, `grok2api`, `kiro-pool`)
- **Deepgram (`docs/DEEPGRAM_PROVIDER.md`, `builtin_deepgram*.go`, `audio_tts_deepgram.go`, `deepgram_quota.go`):** 152 models, `Authorization: Token` scheme, STT `variant` validation before audio upload (fail-fast 400), sentence-aware 2,000-char TTS chunking with 4-way parallel synthesis + ordered audio stitching (RIFF WAV header injection; rejecting unstitchable long `opus`/`flac` upfront), 403-model-access remapped to 404 so accounts aren't globally locked, `ErrEmptyTranscript` non-punishing silence handling, and 2-hop USD credit balance quota.
- **CapCut Headless Worker (`capcut-worker/capcut_worker.py` `613L`, `docs/CAPCUT_WORKER_DESIGN.md`):** 1 Chromium process + LRU warm `BrowserContext` pool per `account_id` (`max_contexts=6`, `idle_ttl=1200s`, `recycle_gens=200`, `cdp_url` support), Playwright request interception dropping showroom/analytics/fonts (`40–60%` CPU reduction) while capturing signed media URLs via network `response` events (never DOM scraping), strict `IMAGE_PATH` + `AUDIO_MIME` exclusion so video poster JPEGs and 25 KB MP3 audio tracks are never misreturned as MP4 videos, and rendition quality scoring (`_dedup_best`).
- **Dashboard UI & Design System (`design.md`, `internal/api/dashboard/static/**`, `jstest/*.test.mjs`):** Zero-bundler `//go:embed static` classic-script modular split (`management.html` shrunk from `10,422L` -> `127L` + 13 ordered scripts + `app.css` + `i18n.js`), content-hash `?v=<hash>` cache busting, strict 36px/32px control height rhythm (`design.md`), custom desktop `.dd-menu` dropdowns, Ctrl/Cmd-K Command Palette (`palette.js`), 24h SVG sparklines (`page-dashboard.js`, `sparkline.test.mjs`), bilingual VI/EN key-parity unit tests (`i18n.test.mjs`), account-privacy tests (`account-privacy.test.mjs`), 5,000-line live console stream (`ringlog.go`), and bulk assign-proxy / reset-health / 300-row cap.

---

## 5. Strict `DO_NOT_ADOPT` / Non-Bypass & Ethical Boundary Ledger

The following mechanisms observed during deep-read are **explicitly rejected** and MUST NEVER be ported into `D:\Omnia` or `agy`/`agy-fast`:

| Component | Source Location | Reason for Rejection (`DO_NOT_ADOPT`) |
|---|---|---|
| **Billing-Evasion Mid-Stream Disconnect Engine** | `dl_proxy0`: `internal/proxy/autocut.go` (`codex-unlimited` `zz_pad9f3` / `zz_finalize_9f3` / `SentinelTaskComplete` mid-generation abort loop) | Explicitly designed to exploit an upstream billing boundary by aborting streams before `response.completed` so usage records are discarded (`QUOTA_EVASION_BOUNDARY`). *(Only the pure KV-cache helpers `sortToolsStable`, `sanitizeInputToolNames`, and `logCacheShape` are separated out as legitimate engineering.)* |
| **CAPTCHA Solver / Anti-Bot Defeat** | `dl_proxy0`: `internal/flowcaptcha/*`; `dl_proxy`: `internal/flowapi/captcha.go` | Automated CAPTCHA / reCAPTCHA solving violates non-bypass policy (`NON_BYPASS_BOUNDARY`). |
| **Browser Cookie Extraction Extension** | `capcut-worker/cookie-extractor/*` | Automated browser session/httpOnly cookie extraction (`PRIVACY_CREDENTIAL_BOUNDARY`). |
| **Deceptive Vendor Identity Spoofing & Forged Signatures** | `dl_proxy0`: `internal/proxy/claude_harness_stream.go` (`sanitizeHarnessIdentityText`, `buildSyntheticWebSearchBlocks`, `buildSyntheticCodeExecutionBlocks`, `claudeModelNumberBanks`), `claude_harness_tools.go` (`claudeHarnessThinkingSignatureForModel`), `claude_code_cloak.go` | Rewrites non-Claude model self-identification to claim "Claude by Anthropic", fabricates fake `web_search`/`code_execution` tool results, hardcodes number-quiz answers to fool detectors, and mints synthetic Anthropic Protobuf thinking signatures (`DECEPTIVE_SPOOFING_BOUNDARY`). *(Only legitimate schema validation `ValidateClaudeHarnessMessagesContract`, deterministic `claudeMessagesToChatRequest`, schema cleaning, and tool-name normalization are harvested.)* |
| **Hardcoded Fallback Passwords** | `dl_proxy`: `HUONG-DAN.txt` (`123456`) | Already fixed in `dl_proxy0/internal/api/session/session.go` — never ship default credentials. |

---

## 6. High-Value `D:\Omnia` Integration Candidates (Zero-Nerf to Steer #22 YOLO Default)

Every candidate below is strictly legitimate, non-bypass, pure-Rust portable, and preserves Omnia's Steer #22 `ApprovalMode::Yolo` default.

| Priority | Target Omnia Crate / Surface | Concrete Pattern & Structs to Port | Source Evidence | Concrete Impact on `D:\Omnia` |
|---|---|---|---|---|
| **P0** | `rust/omnia-routing` (`DynamicProviderRouter`) | **4-Tier Soft-Fail Demotion + Proven-Model 1-in-4 Explorer + Stated Quota Reset Gate:** Add `soft_fail_demotions: HashMap<CandidateId, Instant>` (5s `scopeNone`), `model_proven: HashMap<(CandidateId, ModelId), Instant>` with `probe_unproven_every = 4` isolated probe cursor, distinct `provider_quota_reset_at` (hard skip + `QuotaResetPoolUntil` returning exact `retry_after_secs`) vs inferred `quota_exhausted_until` (tail fallback), and `not_served_tracker` (honest 404 on all-404 pools). | `scheduler.go:43-66,613-1091`, `account_health.go:77-460`, `storage/account_quota.go`, `handler/{model_not_served,quota_reset}.go` | Eliminates single-account 503 outages on transient 429/5xx, prevents multi-account starvation, stops 12h 429 retry loops on unserved models, and surfaces accurate `resets_in_seconds`. |
| **P0** | `rust/omnia-runtime` & `rust/omnia-agent` | **Codex `/v1/responses` Namespace Restoration + `O(N)` Linear Translation + Gemini Proto-Schema Sanitizer:** Port `ResponsesNamespaceMap` (`ExtractResponsesNamespaces`, `flattenResponsesRequestTools`, `RestoreResponsesNamespaces` streaming line buffer) + `CleanJSONSchemaRecursive(strict_gemini)` + `DisambiguateLongToolName` (55+`_8hex`) + `normalizeGeminiContentsTurns` + `sortToolsStable` + `logCacheShape` 8-hex prefix-drift telemetry. | `d_proxy`: `responses_namespace.go:1-681`, `responses_namespace_writer.go:1-153`; `dl_proxy0`: `gemini_wire_fixes.go:57-783`, `codex_translate.go:37-229`, `claude_to_chat.go:47-256`, `autocut.go:492-727` | Fixes Codex MCP/collab namespace drops natively inside Omnia runtime, prevents Gemini 400 tool-schema & trailing-model-turn errors across 22+ tools, cuts huge-history translation latency by ~350x, and makes KV-cache prefix drift debuggable in 1 log line! |
| **P0** | `rust/omnia-runtime` (SSE & Failover Loop) | **Zero-Alloc Output Hold-Back with `frameEchoesRequest` Exemption + Smuggled-200 Typed Error Classifier + `ModelRetiredError` Detector:** Hold opening SSE frames until `payload_carries_output()` sees real content (exempting `response.created`/`response.in_progress` echoes from byte ceiling), classify in-band HTTP 200 `"error"` envelopes via `IsRequestScoped()` for 200ms fail-fast, detect `ErrEmptyCompletion` / `ErrIncompleteSSE` (2m rest) / `ModelRetiredError`, and apply `60s` inter-attempt `failover_deadline` + `0/250/750ms` `ShouldRetrySameAccount`. | `v1_stream_output.go:32-189`, `empty_sse.go:34-201`, `model_retired.go:30-119`, `v1_retry.go:123-336`, `classify.go:524-563` | Makes pre-output failover invisible to Studio/CLI/ACP clients, prevents 60–75s retry storms on policy/invalid-request errors inside 200 streams, and eliminates silent empty-200 replies. |
| **P1** | `rust/omnia-routing` & `rust/omnia-runtime` | **Nested `ComboSet` Fallback/RR/Random DAG + 30s Active `ComboProbe` Recovery:** Add virtual combo model chains (`combo/<id>`, `max_depth=4`, self-shadowing allowed, `demoteBenched` tail ordering, flat combo-member locks, non-overlapping background recovery probes). | `combo.go:1-330`, `combo_health.go:1-379` | Enables declarative resilient model chains (`opus -> sonnet -> gpt`) in Studio & CLI with automatic return to primary 30s after recovery. |
| **P1** | `rust/omnia-studio` & `rust/omnia-downloader` & `rust/omnia-notebook` | **DNS-Rebinding-Proof `dial_public_only` + Per-Hop `guard_asset_redirects` + Allowlist Lossless Secret Redaction + Epoch-Bound Sessions + Operator CORS:** Apply `dial_public_only` & per-hop redirect SSRF validation to all outbound URL fetchers (Atelier URL ingest, OmniDrive, image edits), adopt `publicCredentialKeys` allowlist `***redacted***<last4>` lossless round-trip for provider/account management endpoints, and add `redact_query` + `RedactPath` in HTTP request logging. | `image_source.go:76-241`, `remote_asset.go:88-267`, `mgmt_account_redact.go:32-172`, `session.go:222-362`, `cors.go:29-117`, `logger.go:20-104` | Closes DNS-rebinding & 3xx SSRF vectors, guarantees secrets never round-trip back to Studio browser DevTools, and allows instant global session revocation. |
| **P1** | `rust/omnia-agent` & `rust/omnia-studio` (`Observability`) | **6-Probe Relay Integrity & SSE FSM Auditor + `SentEffort` Post-Shaping Verifier + 5,000-Line Live `RingLog`:** Port `internal/audit/*` (`inspectSSE` Anthropic/OpenAI SSE finite-state checker, 7-malformed-request leak scanner, inert tool-integrity probe, optional canary context recall) as a Studio Diagnostics / CLI `omnia audit-relay` command; port `SentEffort` wire read-back and `ringlog.Buffer` (5,000 lines, non-blocking pub/sub) into Studio Observability. | `internal/audit/{claude_harness,probes,sse}.go`, `effort_report.go:31-122`, `ringlog.go:18-102` | Gives users one-click verification of third-party relays/gateways without trusting claims, proves actual effort sent on wire, and streams ~1h of live runtime logs in Studio. |
| **P1** | `rust/omnia-agent` (Multi-Turn Reasoning) | **Scoped Encrypted-Reasoning LRU Cache (`ReasoningCache`):** 4,096-entry, 30m-TTL LRU keyed by `(conversation_scope, normalized_call_id)` mapping parallel `function_call` items back to their preceding encrypted reasoning proof across stateless API hops. | `dl_proxy0/third_party/grok2api/.../reasoning_cache.go:24-195` | Prevents reasoning-signature drops during parallel tool execution across OpenAI Responses / Anthropic / Gemini bridges. |
| **P2** | `rust/omnia-runtime` (Multimodal Audio/Image) | **Deepgram Parallel Sentence-Chunked TTS + Adaptive Image Hedging (`width=2`) & Fan-Out (`N<=4`):** Add sentence-boundary 2,000-char 4-way parallel TTS stitching + `ErrEmptyTranscript` silence handling + `imageHedgeWidth=2` overload hedging + `runImageFanOut` partial-success straggler cutoff (`90s`/`240s`). | `audio_tts_deepgram.go`, `docs/DEEPGRAM_PROVIDER.md`, `v1_models.go:302-659`, `image_source.go:203-241` | Dramatically improves multimodal reliability and cuts long TTS latency (~30%) and overloaded image timeouts. |
| **P2** | `ui-v5/` (`Observability` & `Providers`) | **Stale-While-Error Quota Cards + 24h SVG Sparklines + Unified Height Rhythm & Ctrl+K Account/Provider Jump:** Render kept quota snapshots with `UpdatedAt` age on upstream 429/5xx, render `5h`/`weekly` dual windows with `Inactive` state badges (never false 100% green), add `sparklineSVG` trends to KPI cards, and extend Omnia's Ctrl+K palette to jump directly to providers/accounts/combos. | `quota_kept.go`, `quota_codeassist.go:532-626`, `page-dashboard.js`, `palette.js`, `design.md` | Directly elevates `ui-v5` Observability & Network Observatory polish with zero new runtime dependencies. |

---

## 7. High-Value `agy` / `agy-fast` Integration Candidates

Mapping directly onto `C:\Users\khang\.gemini\antigravity\scratch\agy-fast\native\src\{accounts,network,observatory,webui,recovery,telemetry,tui}.rs`:

1. **`accounts.rs` — Allowlist Redaction, Multi-Window Code Assist Quota & Pre-Flight Tier Gating:**
   - Adopt `mgmt_account_redact.go`'s allowlist-only `***redacted***<last4>` serializer + lossless PUT restoration so `agy` WebUI/CLI JSON dumps never leak OAuth refresh/access tokens.
   - Adopt `quota_codeassist.go`'s `:onboardUser` async project provisioning + `:retrieveUserQuotaSummary` (`5h` + `weekly` dual windows with `disabled -> Inactive` state, 0.1% remaining precision, `google.protobuf.Duration` `"2532s"` parsing) + `quota_kept.go` stale-while-error caching (`2m` TTL for Antigravity, instant forget on 401/403).
   - Adopt `antigravity_entitlement.go` (`g1-ultra-tier` pre-flight check for Argon models) + `model_retired.go` (detecting Code Assist HTTP 200 retirement sentences before misclassifying as incomplete SSE) + `storage/account_quota.go` (`ProviderQuotaReset` vs inferred exhaustion).
   - Adopt `atomicwrite.go` (`CreateTemp -> Sync -> Rename`) + field-scoped `MutateAccount` (`ErrSkipWrite`) to eliminate lost-update races between OAuth token refresh, quota stamps, and usage flushes, plus `singleflight` OAuth refresh dedup (`PLAN-UPGRADE-2026-09.md` T1.1).
2. **`network.rs` & `net_lab.rs` — Outbound Proxy Pool Memoization, SSRF Defense & `O(N)` Wire Hygiene:**
   - Adopt `outbound.go`'s `(poolID, strict)` memoization keyed on `(url, noProxy)` (Windows tick-collision-proof!), `host:port:user:pass` parser, `strict_proxy` fail-closed vs `doRelaxed`, and `<= 16 MiB` replayable-body buffering.
   - Adopt `image_source.go`'s `dialPublicOnly` + `remote_asset.go`'s `guardAssetRedirects` in `net_lab.rs` / remote asset fetching.
   - Adopt `responses_namespace.go` + `gemini_wire_fixes.go` (`CleanJSONSchemaRecursive` + `DisambiguateLongToolName` + `normalizeGeminiContentsTurns`) + `codex_translate.go` (`O(N)` translation) + `sortToolsStable` / `logCacheShape` prefix-drift hashing in `agy`'s proxy/router layer.
3. **`observatory.rs` & `telemetry.rs` — 5,000-Line Live `RingLog`, Relay Integrity Auditor & `SentEffort` Read-Back:**
   - Adopt `ringlog.go`'s non-blocking 5,000-line pub/sub ring buffer (`ClearSentinel`, ~1.5 MB RAM for ~1h live tail) to feed `agy` WebUI/TUI live log streaming without disk polling.
   - Port `internal/audit/*` (`sse.go` SSE FSM validator + `probes.go` 6-probe relay checker) into `observatory.rs` as an on-demand upstream health/integrity diagnostic, plus `effort_report.go`'s `SentEffort` post-shaping wire audit and `logger.go`'s `redactQuery`/`RedactPath`.
4. **`webui.rs` & `tui.rs` — Zero-Build Dashboard UX, Security & Standalone Bootstrap:**
   - Adopt `session.go`'s epoch-bound HMAC cookies + `RevokeAllSessions` + zero-default-password policy + `standalone.go`'s cryptographic first-run config/password generator and `PauseIfOwnConsole` Windows Explorer usability fix.
   - Adopt `cors.go`'s `operatorSurface` zero-CORS isolation on admin routes.
   - Adopt `palette.js` (Ctrl+K jump across pages/providers/accounts), `page-dashboard.js` 24h SVG sparklines (`sparklineSVG`), `design.md` strict 36px/32px single-height toolbar & table discipline, `?v=<hash>` embedded asset cache busting, and `i18n` VI/EN key-parity automated tests.
5. **`recovery.rs` — Non-Punishing Soft-Fail Demotion & Active `ComboProbe` Recovery:**
   - Adopt `scheduler.go`'s 4-tier candidate selection (`clean -> 5s softFail demoted -> inferred spent`, hard-skipping stated `QuotaResetAt`), `preferProvenLocked` 1-in-4 exploration probe, `slotFree` broadcast channel wakeup, `combo_health.go`'s 30s active recovery probes (`demoteBenched`), and `v1_stream_output.go`'s `frameEchoesRequest` hold-back exemption.

---

## 8. Cross-Proxy Merge Warning for `D:\htmustc-proxy` (Bonus Finding for Coordinator)

Because `D:\htmustc-proxy` (`d_proxy`) and `Downloads\Omnia\htmustc-proxy_(0)` (`dl_proxy0`) diverged on different axes:
- **`D:\htmustc-proxy` uniquely has** `responses_namespace.go` (`681L`) + `responses_namespace_writer.go` (`153L`) + `11` `docs/*.md` specs (`2,693L`).
- **`htmustc-proxy_(0)` uniquely has** the 2026-10..11 production hardening wave (`codex_translate.go` 350x speedup, `gemini_wire_fixes.go` +722L proto-schema cleaner, `quota_codeassist.go` +480L summary windows, `session.go` epoch revocation + zero default password, `cors.go` operatorSurface fix, `logger.go` `RedactPath`, `image_source.go` `dialPublicOnly` SSRF defense, `remote_asset.go` redirect guard, `model_not_served.go`, `quota_reset.go`, `model_retired.go`, `effort_report.go`, `internal/audit/*`, `standalone.go`, `v1_models.go` image hedging/fan-out, and upgraded `grok2api` `reasoning_cache.go`).
- If the user ever consolidates `D:\htmustc-proxy`, **cherry-picking ONLY the legitimate security/reliability/wire modules from `dl_proxy0` onto `d_proxy`** (keeping `d_proxy`'s `responses_namespace*.go` & `docs/*.md`, while excluding `autocut.go` billing-evasion, `flowcaptcha/*`, and `claude_harness` spoofing) yields a strictly superior clean proxy.

---

## 9. Verification & Privacy Attestation

- Scratch scripts & machine-readable ledgers persisted outside repo at `D:\OmniaData\qa\v5-verify\shard07\{inventory.json,norm_diff.json,proxy_3way.json,dl_omnia_deep_diff.json,proxy_deep_analysis.json,full_digest.txt}`.
- Zero edits performed in `D:\Omnia`, `D:\htmustc-proxy`, or `C:\Users\khang\.gemini`.
- Zero credentials, API keys, cookies, OAuth tokens, personal emails, or CAPTCHA-bypass / billing-evasion implementations included in this report.
