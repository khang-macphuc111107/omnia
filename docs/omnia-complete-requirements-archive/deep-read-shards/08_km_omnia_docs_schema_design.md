# Wave 1 Deep-Read Shard 08: `khangmacphuc-omnia` Docs, Schemas, ADRs, Ultra Spec Pack, Research, Audits, Project Twin, Design & CI

- **Audit Target Root:** `D:\OmniaData\research\khangmacphuc-omnia\` (read-only; zero edits).
- **Exact Shard 08 Scope:** `README.md`, `docs/**`, `design/**`, `.agents/**`, `.github/**`, `artifacts/**`.
- **Coverage Receipt:** **377 / 377 files (100.0%, ZERO skipping)** — `375` text/code/schema/SQL/SVG/YAML/JSON/Markdown files (**70,505 lines**) + `2` PNG desktop shell screenshots visually inspected (`omnia-app-overview.png`, `omnia-shell-chat-nav-final.png`), totaling **3,870,740 bytes**.
- **Baseline Cross-Reference:** Verified against `D:\Omnia` (`HEAD 1c9342c`, 17-crate pure Native Rust + SolidJS `ui-v5` + Win32/Direct2D/WebView2; see Shard 22 `22_omnia_current_baseline.md`) and live Antigravity / `agy` / `agy-fast` surfaces (`C:\Users\khang\.gemini\config\skills\`, `C:\Users\khang\.gemini\antigravity\builtin\skills\`, `E:\Users\khang\.gemini\antigravity-{cli,dev}\`).
- **Epistemic Standard:** Strictly distinguishes `observed` source/schema facts, `verified` executable checks, `normative-target` specifications/previews inside `khangmacphuc-omnia`, `inferred` integration recommendations, and `blocked`/`unverified` boundaries. Zero secrets or credential values are reproduced.

---

## 1. Executive Verdict & Cross-Architecture Delta

`khangmacphuc-omnia` (Tauri 2 + React/TypeScript + 4 Rust crates: `omnia-harness`, `omnia-browser`, `omnia-computer`, `omnia-download`) and `D:\Omnia` (17-crate pure Native Rust + SolidJS `ui-v5` + Win32/Direct2D/WebView2) are **asymmetric complements**:

| Dimension | `khangmacphuc-omnia` (Shard 08 Evidence) | `D:\Omnia` Current Baseline (`HEAD 1c9342c`) | Strategic Synergy |
|---|---|---|---|
| **Runtime & Shipping Maturity** | Capability ledger honestly records **`25 partial`, `30 planned`, `0 verified`**; many UI workbenches are renderer-local previews (`2,104` Vite modules, `3.89 MB` JS over `2.15 MB` budget); earlier Sept 2026 audits lacked a Rust toolchain until Nov 2026 (`701-713` `omnia_native` tests + `474` workspace tests). | **Production 17-crate Native Rust workspace** (`196` `.rs` files, `187,308` LOC), `5` Windows release binaries (`omnia.exe` `12.389 MiB` / `8.29-10.40 ms`), `360` Studio HTTP route arms + `/ws`, `35` agent tools, live Arena/Canvas/Atelier/OmniDrive/Swarm/Observatory, `575/575` workspace tests + `7/7` Win32 QA (`90/90`). | Port `khangmacphuc-omnia`'s **normative contracts, SQL invariants, schemas, validators, and fault harnesses** directly into `D:\Omnia`'s live Rust runtime. |
| **SQLite Schema & State Integrity** | **Industry-leading 21-version `STRICT` + `WITHOUT ROWID` DDL** (`docs/storage-schema.sql`, `4,545` lines) with `PRAGMA trusted_schema = OFF`, immutability triggers, `WITH RECURSIVE` SQLite DAG cycle rejection, Branch-Head CAS, `outcome-unknown` reconciliation, `provider_definition_revisions` (v20 TOCTOU fix), and 14-timestamp telemetry + superseding usage ledger. | Functional WAL SQLite across `SessionStore`, `HarnessStore`, `RecallStore`, `ops_store.rs` (`17` tables), `agent_store.rs`, `research_vault.rs`, `artifact_os.rs`, `notebook/store.rs` — but **overlapping `RecallStore` vs `ops_store.rs`**, mutable provider profiles, no `STRICT`/immutability triggers, and no State-Revision CAS graph. | Consolidate `D:\Omnia` storage and adopt v7/v8/v11-v20 immutability, CAS, `outcome-unknown`, and `provider_definition_revisions` contracts. |
| **Spec/Schema Governance & Verification** | **45 Draft 2020-12 JSON schemas**, zero-dependency `validate-spec.ps1` (closed manifest, 400L cap, DFS cycle checks, single-prompt enforcement), `validate-agent-catalog.mjs` (persona-authority firewall + filler hash detector), `validate-conversation-navigation.mjs`, 96-source SHA-256 `source-ledger.json`, 40-case provider fault harness (`PF-001..040`), 74-case Git auth fault catalog (`GAF-*`). | Strong `audit.py --secret-scope all`, `validate_skills.py` (`22/22`), `platform/validate_targets.py`, and `omnia-benchmark`; lacks deterministic SSE/UTF-8 fragmentation fault harness, persona-vs-role schema firewall, cross-layer enum/schema drift gates, and executable W3C DTCG UI token/typography gates. | Adopt deterministic fault harnesses, executable UI token/typography/bundle gates, and zero-dependency schema/source-ledger validators into both `D:\Omnia` and `agy`/`agy-fast`. |
| **Default Execution Posture (Zero-Nerf Guardrail)** | Strict deny-by-default exact-approval broker posture (`OM-TM-001..040`); renderer has zero authority. | **Steer #22 Default Full-Freedom YOLO/SOLO (`Z-01..Z-11`)**: `ApprovalMode::Yolo`, `workspace_trusted: true`, empty `PermissionsEngine::default_rules()`, unrestricted path/egress defaults, `EffortLevel::Max`, `token_budget = None`, `ADDITIVE_INTAKE`, opt-in strict/sandbox modes. | **CRITICAL RULE:** Adopt durability, replay, `outcome-unknown` billing safety, frozen lineage, provenance tagging, fault tests, and opt-in strict receipts **WITHOUT ever nerfing `Z-01..Z-11`** or adding nagging approval prompts in default YOLO mode! |

---

## 2. Deep Architectural Analysis: 16 Superior Design Pillars

### Pillar 1: SQLite `STRICT` + `WITHOUT ROWID` Schema Evolution v1-v21 (`docs/storage-schema.sql`, `4,545L`)
Files: `docs/storage-schema.sql`, `docs/security-storage-architecture.md`, `docs/validate_storage_schema.py`, `docs/validate_attachment_schema.py`, `docs/audit/PROVIDER_ATTEMPT_LINEAGE_*`, `docs/audit/PROVIDER_DEFINITION_REVISION_V20_RECEIPT_2026-09-25.md`.

- **Defense-in-Depth SQLite Hardening**: Enforces `PRAGMA foreign_keys = ON`, `PRAGMA trusted_schema = OFF`, `STRICT` tables, `WITHOUT ROWID` on join/edge tables, lowercase 64-hex `CHECK` constraints for SHA-256 digests, and append-only `BEFORE UPDATE` / `BEFORE DELETE` `RAISE(ABORT, ...)` triggers on every receipt, ledger, lineage, journal, and revision table.
- **21-Version Schema Architecture**:
  - **v1-v3**: Profiles, workspaces, projects, conversations, branches, messages, generations, provider profiles, migration receipts (`schema_migrations` with checksums).
  - **v4 & v6 (Exact-One-Owner Attachments)**: `attachment_blobs` (content-addressed SHA-256), `attachment_drafts` (enforcing exact single owner via SQLite check constraints — never orphaned or shared across scopes), and immutable `attachment_binding_receipts` binding opaque draft IDs to frozen provider inputs.
  - **v7 (Durable Run Event Journal)**: Gap-free `run_journals` + append-only `run_events` with monotonic `(run_id, seq)` uniqueness and strict immutability triggers.
  - **v8 (Content-Free Telemetry, Superseding Usage & Microunit Cost)**: `run_timing_observations` (14 monotonic sub-phase timestamps separating hidden reasoning/thinking TTFT from visible output TTFT/TTFM/TPS), `run_usage_ledger` (append-only with `supersedes_entry_id` enabling downward `provider-final` / `provider-invoice` corrections within the same attempt), and `run_cost_statements` (`amount_microunits` integer math + frozen `price_snapshot_hash`, never floating-point USD drift).
  - **v9-v10 (Multimodal Bridge Persistence)**: `multimodal_bridge_plans`, `multimodal_bridge_artifacts`, and `multimodal_bridge_stage_receipts` with planning-only provider-stage guards (`provider_acceptance = 'not-applicable'` until real carrier dispatch) and fail-closed rejection of `unclassified` MIME types.
  - **v11-v13 (State-Revision Graph & Branch-Head CAS)**: `state_revision_streams`, `state_revisions`, `state_revision_parents`, `state_revision_edges`, `state_revision_heads`, `state_revision_idempotency` + operation-fact columns (v13) enforcing single accepted head per stream, candidate isolation, and cross-stream scope guards.
  - **v14 (Provider-Attempt Lineage)**: Immutable `provider_attempt_lineage_facts` recording frozen scope, provider-definition hash, canonical `endpoint_fingerprint_sha256`, adapter revision, parameter hash, requested/effective effort, and nullable unknown provenance (`NULL`, never fabricated `0`/`""`).
  - **v15 (Run Control Receipts)**: `run_control_operations`, `run_control_operation_events`, `run_checkpoints`, `continuation_intents`, `message_revisions` — verified by independent SQLite close/reopen/rollback/redaction probes forbidding persisted secrets, cookies, raw prompts, or absolute paths.
  - **v16-v19 (Authoritative Roots & SQL-Native Cycle Detection)**: `goals`, `goal_revisions`, `tasks`, `task_revisions`, `task_dependencies` (with an **in-SQLite `WITH RECURSIVE` `BEFORE INSERT` trigger** rejecting self-loops and transitive dependency cycles atomically, plus v19 terminal-task dependency guard blocking new dependencies on completed/cancelled/archived tasks), `starter_workflows`, `starter_workflow_revisions`.
  - **v20-v21 (Immutable Provider Definition Revisions)**: `provider_definition_revisions` captures bounded transport/routing definitions + opaque `credential_ref` handles in the same transaction as `frozen_provider_inputs` & `provider_attempt_lineage_facts`. Dispatch re-canonicalizes and hashes the immutable revision while separately verifying the live profile is enabled — **eliminating mutable-profile TOCTOU** without rereading drifted fields!
- **Cross-Layer Boundary Audit Lesson (`PROVIDER_ATTEMPT_LINEAGE_BOUNDARY_CONTRACT_AUDIT`)**: Documented real validator divergence between Rust (`validate_nonempty_bounded` using UTF-8 bytes & rejecting all Unicode control chars), JSON Schema (character length & rejecting leading whitespace), and SQLite `CHECK` (character length, accepting U+000B vertical tab, inconsistent NUL handling). Recommends **Policy A (Unicode-character contract, trim at preparation boundary, reject C0/DEL/C1 controls identically across Rust/JSON/SQLite)** with boundary fuzz tests (`40 x 'é'` vs `41 x 'é'`, U+0000, U+000B).

### Pillar 2: State-Revision Graph, Branch-Head CAS & 5 State-Base Retry/Fork Model
Files: `docs/CONVERSATION_BRANCH_ARCHITECTURE.md`, `docs/omnia-ultra/architecture/state-revision-graph.md`, `docs/omnia-ultra/interaction/branching-copy-fork.md`, `docs/audit/STATE_REVISION_*`, `docs/audit/SELECTED_DELTA_STATE_BASE_CONTRACT_AUDIT_2026-09-12.md`, `docs/audit/FRESH_CONTINUATION_BOOTSTRAP_NATIVE_CONTRACT_2026-09-12.md`.

- **Canonical Graph Orientation & Accepted-vs-Candidate Isolation**: Edges follow canonical `child -> parent` direction. Every branch maintains an atomic `accepted_head` pointer updated via Compare-And-Swap (`expected_head_state_revision_id`). Unaccepted outputs (`candidate`, `rejected`, `superseded`, `outcome-unknown`, `conflicted`, `blocked`) never silently become the active head — solving the classic **`Retry A -> Retry B` contamination bug** where retrying an earlier prompt accidentally leaks unaccepted or superseded branches into current-state context.
- **5 Explicit State-Base Modes**:
  1. `exact-historical`: Replay from the exact historical state revision (reproduces content/config provenance without resurrecting revoked credentials or grants).
  2. `current-state`: Retry an earlier prompt while incorporating accepted downstream state up to the current accepted head.
  3. `historical-plus-selected-deltas`: Explicitly cherry-pick accepted downstream revisions via a canonicalized, hashed **Selected-Delta Manifest** (`derives-selected-delta-from` edges, monotonic order, excluding superseded/conflicted/revoked/`outcome-unknown` items).
  4. `fresh-branch`: Isolated branch initialized strictly by an atomic native SQLite bootstrap transaction (`run_control_bootstrap_required` if the client attempts to fabricate a root revision ID/digest/cursor).
  5. `fresh-goal-start`: Fresh run anchored to an authoritative Goal/Task/Starter-Workflow root.
- **Fixed-Watermark Reads & MAC-Signed Keyset Cursors**: Graph reads execute in one SQLite read transaction, clamping future requested watermarks to the native fact horizon, with bounded keyset pagination using **process-local MAC-authenticated cursors** and serialized byte budgets (preventing unbounded memory spikes on 5,000-message trees).
- **Compact IPC DTO vs Rich Export Schema**: `STATE_REVISION_GRAPH_CONTRACT_AUDIT` explicitly separates the compact, redacted runtime IPC DTO (`StateRevisionGraphSnapshot`) from the full portable export envelope (`state-revision-graph.schema.json`), requiring an explicit lossless adapter that refuses to synthesize missing immutable fields from mutable tables.

### Pillar 3: Authoritative Roots, Two-Phase Run Control & Truthful Pause/Resume/Continue
Files: `docs/omnia-ultra/architecture/authoritative-root-api-contract.md`, `docs/omnia-ultra/architecture/run-control-native-mapping.md`, `docs/omnia-ultra/interaction/run-control-edit-retry.md`, `docs/omnia-ultra/security/authority-continuity-and-replay.md`, `docs/audit/RUN_CONTROL_*`, `docs/audit/TASK_WORKFLOW_NATIVE_TEST_MATRIX_2026-09-12.md`.

- **Dual Hash Domains & Idempotency Payload-Drift Rejection**: Every authoritative mutation (`create_goal`, `create_task`, `create_task_dependency`, `run_control_apply`) hashes both `content_sha256` and `canonical_payload_sha256`. Replaying the exact same `(idempotency_key, canonical_payload_sha256)` returns the original immutable receipt with an explicit replay flag; reusing the same `idempotency_key` with any mutated field fails closed with `payload_drift` and zero partial writes.
- **10-State `effect.state` & Billing-Safe `outcome-unknown` Reconciliation**: Tracks external side effects across 10 explicit states (`none` -> `pending` -> `dispatched` -> `outcome-unknown` -> `reconciled` / `confirmed` / `failed` / etc.). When a network stream drops *after* provider acceptance without a terminal event, the attempt enters `outcome-unknown` — **blocking automatic duplicate retries** (preventing silent double-billing or duplicate external writes) until reconciled via provider status check or explicit user override.
- **Truthful Pause Dispositions**: Never pretends an external provider HTTP stream paused cleanly in-place. Maps every Pause action to one of 5 truthful dispositions: `cooperative-checkpoint`, `provider-supported-suspend`, `cancel-then-reconcile`, `pending-effect-checkpoint`, or `held`. Resume always creates a new linked execution segment after fresh revalidation.
- **Typed No-Text `Continue` & Immutable Message Edits**: `Continue` works after partial output, from a checkpoint, or on an empty Goal/Task chat via a typed `ContinuationIntent` with loop/no-progress guards. Editing a previous prompt NEVER mutates the original message row in-place; it appends an immutable `message_revisions` record linked to a sibling run/branch.
- **Queue vs Active Generation Separation**: Explicitly separates the durable user prompt queue from `generations.state = queued|running` (which startup crash recovery marks failed/interrupted).

### Pillar 4: Durable Run Event Journal, Multi-Stream Cursor Replay & Content-Free Telemetry
Files: `docs/OBSERVABILITY_PROJECT_CHAT_CONTRACT.md`, `docs/omnia-ultra/observability/*.md`, `docs/omnia-ultra/schemas/request-telemetry.schema.json`, `docs/omnia-ultra/schemas/run-event-journal.schema.json`, `docs/audit/TELEMETRY_RETRY_LINEAGE_AUDIT.md`.

- **Journal First, Projections Second**: Commands mutate state and append ordered journal events inside the same SQLite transaction; projections/UI views are strictly rebuildable from the journal and never fabricate synthetic IDs or timestamps.
- **14 Monotonic Sub-Phase Timestamps**: Separates `queued`, `context_compiled`, `dispatch_started`, `tcp_connected`, `tls_established`, `first_byte_received`, `first_reasoning_token`, `first_visible_token` (TTFT vs TTFM), `stream_completed`, `tool_started/completed`, and `persisted` — eliminating misleading TTFT numbers on long-thinking models (`claude-*-thinking`, `o*`/`gpt-6.x`, `gemini-4` max effort).
- **Truthful Coverage Vocabulary (`unknown != 0`)**: Every usage, cache, quota, and cost field carries `(source, authority, coverage: complete|partial|unknown|planned, unknownReason)`. Missing provider billing/cache fields stay explicitly `unknown` (`null`), NEVER coerced to `0` or `"healthy"`.
- **Superseding Usage Ledger & Deterministic Retry Receipts**: Usage ledger entries support downward corrections (`provider-final`, `provider-invoice`) via `supersedes_entry_id` scoped strictly within a single attempt. `RetryDecisionReceipt` logs the normalized error class, provider `Retry-After`, acceptance evidence, idempotency safety, jittered delay, and fallback route — with the **deterministic safety classifier always running before any AI retry advisor**.
- **Cross-Layer Enum Alignment (`TRLA-002`)**: Caught concrete kebab-case vs snake_case wire drift (`local-estimate` vs `estimate`, `provider-final` vs `provider_final`) between Rust/SQLite and JSON schemas — requiring one canonical persisted vocabulary plus round-trip adapter conformance tests.

### Pillar 5: Context Compiler, 6-Layer Cache Taxonomy & Fidelity-Gated Compaction
Files: `docs/CONTEXT_COMPILER_ARCHITECTURE.md`, `docs/omnia-ultra/architecture/cache-context-routing.md`, `docs/omnia-ultra/architecture/model-routing-context-policy.md`, `docs/omnia-ultra/goal/13-cache-context-routing-compaction.md`, `docs/research/PROVIDER_CACHE_CONTEXT_OPTIMIZATION_RESEARCH.md`, `docs/audit/OMNIA_PROJECT_DECK_CACHE_TELEMETRY_PHASE_2026-09-29.md`.

- **Strict 6-Layer Cache Separation**: Separates (1) local content-addressed object cache, (2) context-compilation cache, (3) retrieval/RAG cache, (4) provider-native prompt prefix cache, (5) provider file/upload handle cache, and (6) response-reuse cache. Enforces `providerNative.evidencePolicy == "provider-reported-only"` so local reuse is NEVER presented as provider prompt-cache billing savings.
- **8 Context Delivery Modes & Frozen `RunSnapshot`**: Explicit delivery modes (`full`, `partial`, `auto`, `summary-plus-sources`, `manifest-only`, `retrieval-on-demand`, `fresh`, `forked-snapshot`) compiled once into an immutable `RunSnapshot` / `frozen_provider_inputs` record before dispatch, recording exact included and omitted item manifests.
- **Mandatory Compaction Survival Kinds & Rollback Gate**: Compaction is forbidden from dropping 7 pinned item kinds: `security-policy`, `user-correction`, `goal`, `task`, `citation`, `memory-supersession`, and `continuation-cursor`. A fidelity check compares post-compaction survival invariants and rolls back compaction if required facts were lost.

### Pillar 6: Multimodal Capability Bridge v2 & Isolated Local Toolchain
Files: `docs/PROVIDER_MULTIMODAL_DESIGN.md`, `docs/omnia-ultra/architecture/multimodal-bridge-contract-v2.md`, `docs/omnia-ultra/runtimes/local-multimodal-toolchain.md`, `docs/research/OFFICIAL_MULTIMODAL_PROVIDER_OPERATION_MATRIX_2026-08-14.md`, `docs/audit/MULTIMODAL_CAPABILITY_BRIDGE_AUDIT_2026-08-14.md`, `docs/audit/UNIVERSAL_ENDPOINT_MULTIMODAL_RED_TEAM_AUDIT_2026-08-14.md`, `docs/audit/NATIVE_MULTIMODAL_ADMISSION_VERTICAL_SLICE_2026-09-09.md`.

- **Operation-by-Modality Capability Matrix (No Facade Parity Assumptions)**: Universal `"OpenAI-compatible"` proxy endpoints frequently strip audio/PDF/video/cache/structured-output fields silently (`UNIVERSAL_ENDPOINT_MULTIMODAL_RED_TEAM_AUDIT`). Bridge v2 requires explicit `operationCapabilities[]` snapshots per `(provider, endpoint, model, modality, operation)` — never inferring capability from provider brand or model name.
- **7 Resolved Bridge Modes**: `direct-native`, `local-transform`, `specialist-bridge-model`, `hybrid-ensemble`, `surrogate-to-primary`, `human-review`, and `unsupported` (fail-closed, never silently dropping attachments).
- **9 Canonical Intermediate Representations (CIRs) & Coordinate Closure**: Normalized multimodal artifacts preserve exact locators across `page`, `sheet-cell`, `slide`, `byte-range`, `image-region`, `time-range`, `code-range`, `table-range`, and `archive-member`.
- **5 Epistemic Provenance Labels & 13-Dimension Non-Compensatory Fidelity**: Tags every extracted chunk as `source-observation`, `derived-representation`, `specialist-interpretation`, `model-inference`, or `unresolved`. Evaluates 13 fidelity dimensions where **no high average score can mask a failed decisive gate** (e.g., dropped math equations, truncated spreadsheet rows, or missing slide charts).
- **Untrusted Attachment Containment (`data-not-control`)**: Extracted OCR, transcripts, PDF metadata, and EXIF tags are labeled as untrusted data — never interpreted as control instructions, policy changes, or secret grants.

### Pillar 7: Universal Provider Protocol Adapters, 40-Case Fault Harness & 74-Case Git Auth Fault Catalog
Files: `docs/PROVIDER_ARCHITECTURE.md`, `docs/PROVIDER_FAULT_HARNESS.md`, `docs/GIT_AUTH_CREDENTIAL_FAULT_CATALOG.md`, `docs/adr/0003..0008`.

- **40-Case Deterministic Provider Fault Harness (`PF-001..PF-040`)**:
  - Eliminates flaky wall-clock `sleep()` calls by using explicit **blocking synchronization checkpoints** (`await_stage` / `release_stage`) inside an in-process mock HTTP/SSE server.
  - Uses a **SHA-256-seeded `FragmentationPlan`** to deterministically split wire chunks across multibyte UTF-8 scalar boundaries (Vietnamese diacritics, CJK, emoji), SSE `\r\n\r\n` vs `\n\n` delimiters, partial JSON escape sequences, and mid-tool-call deltas.
  - Injects `OMNIA_SYNTHETIC_SECRET_CANARY` into headers/errors/URLs to verify zero secret leakage across logs, journal events, telemetry DTOs, and error messages across OpenAI, Anthropic, Gemini, and OpenAI-compatible adapters.
  - Covers mid-stream disconnects before vs after acceptance (`outcome-unknown`), `429 Retry-After` delta-seconds vs HTTP-date parsing, `5xx` storms, invalid JSON/SSE framing, oversized frames, cancellation races, and stale-profile TOCTOU.
- **74-Case Git Auth & Credential Fault Catalog (`GAF-CFG-*`, `GAF-BRK-*`, `GAF-HTTP-*`)**: Exhaustively catalogs Git configuration, Windows Credential Manager/GCM broker, SSH/HTTPS auth, proxy/redirect credential stripping, and secret-free error reporting faults.

### Pillar 8: Agent Tool DAG, Monotonic Fencing Leases & Role-vs-Persona Firewall
Files: `docs/AGENT_TOOL_DAG_CONTRACT.md`, `docs/omnia-ultra/harness/*.md`, `docs/omnia-ultra/harness/{agent-catalog,role-profiles,persona-packs}.json`, `docs/omnia-ultra/tools/validate-agent-catalog.mjs`, `docs/audit/SPECIALIST_PERSONA_CATALOG_AUDIT_2026-08-14.md`.

- **Three Strictly Separated Objects**:
  1. **Role Profile v2 (`role-profiles.json`)**: Operational mission, non-goals, typed input/output schemas, required evidence, tool *classes*, budget defaults, failure modes, escalation/stop rules, and linked evaluation suites.
  2. **Persona Pack (`persona-packs.json`)**: Communication style, voice, language, pedagogy, explanation density, and presentation preferences ONLY. `validate-agent-catalog.mjs` **hard-rejects 24 forbidden authority keys** (`toolIds`, `allowedTools`, `grantIds`, `capabilityGrants`, `secretRefs`, `credentials`, `approvalPolicy`, `sandboxPolicy`, `networkPolicy`, `environmentGrants`, etc.) inside any persona!
  3. **Agent-Instance Resolution Receipt**: Immutable snapshot of resolved profile/persona revisions, model route, context manifest, and budget.
- **Anti-Filler Hash Deduplication & Honest Counting**: Computes both `canonicalHash` and `differentiationHash` across role profiles to reject duplicate "filler" profiles that only rename display titles, and derives counts strictly from valid manifests (`10/100` roles, `6/40` personas honestly reported rather than marketing-inflated).
- **Deterministic Resource Locks & Monotonic Fencing Leases**: Sorts named resource lock claims canonically to prevent deadlocks across parallel agents/tools, and pins leases to `(owner_id, expiry, monotonic_lease_generation)` so stale workers cannot overwrite or release after takeover.

### Pillar 9: Conversation Navigation, Queue/Steer/Btw/Schedule & Cross-Field Validation
Files: `docs/omnia-ultra/interaction/{queue-steer-schedule,prompt-navigation-and-jump,prompt-workshop-and-modes,project-chat-foundation}.md`, `docs/omnia-ultra/tools/validate-conversation-navigation.mjs`, `docs/audit/QUEUE_RENDERER_FEASIBILITY_2026-09-14.md`, `docs/audit/PROMPT_NAVIGATION_*.md`, `docs/audit/PROMPT_INTELLIGENCE_RENDERER_PREVIEW_RECEIPT_2026-09-30.md`.

- **Four Distinct Prompt Surfaces**: Separates (1) Main Composer, (2) Durable Queue/Steer/Parallel/Scheduled batch lane, (3) Ephemeral `/btw` side-question (never mutates main branch unless explicitly promoted), and (4) Prompt Experiment Studio / Workshop (variants, semantic Enhance diff, deterministic reviewer lanes, line compare) — each with separate history, tool scope, cost attribution, and mutation boundaries.
- **Executable Cross-Field Validator (`validate-conversation-navigation.mjs`, `510L`)**: Enforces invariants across `queue`, `steer`, `btw`, `parallel`, and `scheduled` operations, verifies `authorityInheritance.* == false` on side/scheduled contexts, runs DFS batch dependency cycle detection, and embeds built-in negative fixtures.
- **Content-Free `JumpTarget` Anchors**: Message/artifact/citation/region jump targets carry bounded semantic fingerprints + native event cursors (never copying full prompt/response bodies into navigation records) and detect `stale`, `hidden`, `superseded`, `wrong-branch`, and `fingerprint-drift` states cleanly.

### Pillar 10: Threat Model (`OM-TM-001..040`), Remote Client E2E & Honesty Hard Boundaries
Files: `docs/THREAT_MODEL.md` (`660L`), `docs/REMOTE_CLIENT_ARCHITECTURE.md` (`716L`), `docs/omnia-ultra/security/*.md`, `docs/audit/SECURITY_AUTHORITY_AUDIT_2026-08-14.md`.

- **40 STRIDE Threats Mapped to Controls**: Covers prompt injection / indirect attachment injection (`data-not-control`), credential exfiltration, loopback DNS rebinding & origin spoofing, symlink/reparse escape, cross-branch authority leak, replay/double-billing (`outcome-unknown`), remote pairing MITM, browser/cookie vault abuse, and **`OM-TM-040` (Adaptive/Learned Routing Isolation)** guaranteeing that bandits/RL/classifiers NEVER decide security boundaries, egress, or permissions.
- **Unified Remote Client Protocol (`REMOTE_CLIENT_ARCHITECTURE.md`)**: Device-keyed pairing, per-device granular grants, explicit replay windows, E2E framing, and clean revocation — mapping directly onto `D:\Omnia`'s `omnia-remote-control` crate (which currently keeps state ephemeral in memory in `routes_legacy.rs`).
- **Non-Bypass Hard Boundaries (`hard-boundaries.md`)**: Zero covert keylogging, zero browser password/cookie DB theft, zero CAPTCHA/anti-bot/fingerprint evasion, zero DRM/paywall bypass — 100% aligned with `D:\Omnia`'s `Z-09`.

### Pillar 11: Learning & Research Harness + 14-Suite Evaluation Plan (`LH-01..LH-14`)
Files: `docs/LEARNING_RESEARCH_HARNESS.md`, `docs/research/LEARNING_HARNESS_EVALUATION_PLAN.md`, `docs/audit/DYNAMIC_ROUTING_LEARNING_AUDIT_2026-08-14.md`, `docs/omnia-ultra/architecture/adaptive-intelligence-plane.md`, `docs/omnia-ultra/harness/evaluations-learning-routing.md`, `docs/omnia-ultra/schemas/{routing-decision-receipt,adaptive-policy-release,evaluation-benchmark-run}.schema.json`.

- **14-Suite Evaluation Corpus (`LH-01..LH-14`, 436+ Authored Cases)**: Covers bilingual Vietnamese/English routing & comprehension, citation faithfulness, tool-use precision, coding repair, prompt-injection resilience, multimodal fidelity, and crucially **`LH-08` (Lost-in-the-Middle Position Permutation & 0..64 Distractor Scaling)** testing whether context compilers and RAG rankers degrade as critical facts shift across prompt positions and distractor densities.
- **Safe Adaptive Routing Lifecycle**: Records propensity-logged decision episodes (`routing-decision-receipt.schema.json`) enabling unbiased counterfactual IPS/DR offline replay, and gates any learned routing policy behind `adaptive-policy-release.schema.json` (`offline -> shadow -> canary -> auto-kill-switch`) strictly outside the security path.

### Pillar 12: Living Project Twin, Smart Overview Refresh & Offline Interactive Atlas
Files: `docs/project-twin/*` (9 files, `3,155L`), `docs/omnia-ultra/project-twin/*.md`, `docs/audit/PROJECT_CONTROL_DECK_EVIDENCE_CROSSWALK_2026-09-21.md`.

- **Two-Layer Provenance Graph**: Separates human-curated `catalog.json` (domain intent, ownership, taxonomy) from deterministically regenerated `graph.json` (`25` nodes, `32` edges, `45` evidence links) + single-file zero-network `atlas.html` (`atlas.css` + `atlas.js`) with line-exact SHA-256 `sourceRefs`.
- **Schema-Enforced Inference Honesty**: `graph.schema.json` allows a `confidence` score ONLY on inferred edges (`origin == "inferred"`), forbidding synthetic confidence numbers on directly extracted structural facts.
- **Material-Change Smart Overview Refresh**: Prevents noisy LLM overview thrashing by hashing structural deltas, gating refresh on material changes, preserving user-locked titles & aliases, and surfacing explicit stale-watermark badges.

### Pillar 13: Windows Virtual Pointer, Window Twin, Targeted Capture & WebView2 CDP
Files: `docs/research/windows-runtime/01..08` (`882L`), `docs/omnia-ultra/runtimes/{virtual-pointer-window-control,targeted-capture-and-presence,browser-network-capture,machines-headless-remote}.md`, `docs/audit/BROWSER_SURFACE_AND_NAVIGATION_AUDIT.md`.

- **6-Tier Transport Escalation Hierarchy**: `T0` App/API -> `T1` Browser DOM/AX/CDP -> `T2` Windows UIA -> `T3` Window-local IPC -> `T4` Isolated Desktop/VM -> `T5` Physical `SendInput` (explicitly opt-in / disabled by default so the user's physical cursor isn't hijacked).
- **Independent Semantic vs Visual Channels & Anti-Reuse Binding**: Separates `semantic_available` (UIA/DOM tree) from `visual_available` (WGC/`PrintWindow` bitmap), pins every target with a `TargetBinding` `(hwnd, pid, create_time, generation_epoch)` to block PID/HWND reuse races, and executes a 4-stage `PointerIntent -> PointerDispatch -> PointerObservation -> PointerVerification` loop.
- **Window Twin & Intent/Execution/Verification Overlay**: Projects a non-physical blue/cyan virtual cursor and Shadow Mode dry-run preview showing intended target vs executed action vs post-action verification.
- **Critical WebView2 Deprecation Note**: Explicitly documents that `Microsoft.Web.WebView2.DevToolsProtocolExtension` is deprecated; use built-in `CoreWebView2.CallDevToolsProtocolMethodAsync` / `GetDevToolsProtocolEventReceiver` directly.

### Pillar 14: Design System, Executable W3C DTCG Tokens, Brand Catalog & UI Quality Gates
Files: `docs/ui/*` (6 files, `1,525L`), `design/logo-catalog-2026-09-15/*` (16 files), `docs/brand-options/2026-09-15/*` (16 files), `docs/assets/*.png` (2 screenshots), `docs/FRONTEND_MODULARIZATION_PLAN.md`, `docs/audit/UI_*.md`, `docs/audit/STRUCTURED_IO_RENDERER_PREVIEW_RECEIPT_2026-09-30.md`.

- **Executable W3C DTCG Design Tokens (`docs/ui/design-tokens.json`)**: Single source of truth generating CSS variables + TypeScript tokens verified in CI by `npm run tokens:check`.
- **Brand Identity & Role-vs-State Icon Separation**: 12 non-purple geometric SVG logos (`L01 Command Ring` selected) + 8/10 coder-centric color palettes; enforces strict separation between static **role icons** and live **runtime state glyphs** (never reusing an error/warning hue as decoration).
- **Automated Static UI Gates**:
  - `check:typography`: Migrated `115` sub-10px declarations (`6.8px..9px`) down to **`0` literal declarations below `10px`** across `34` stylesheets (`--font-micro: 11px`, `--font-caption: 12px`).
  - `check:hit-targets`, `check:imports` (`394` modules / `806` local imports enforcing acyclic boundaries), `check:acl`, `check:bundle` (hard budget enforcement — refused to silently raise `2.15 MB` budget when aggregate reached `2.61-3.89 MB`), and `/__visual` isolated Playwright fixture.
- **Visual Inspection of `docs/assets/*.png`**:
  - `omnia-app-overview.png`: Clean 3-column calm light-surface workspace with left session/project rail, center structured transcript + grounded composer, and right collapsible inspector/evidence rail — restrained typography and clear visual hierarchy.
  - `omnia-shell-chat-nav-final.png`: Compact header/sidebar with inline jump/navigation popover, branch pills, explicit preview/boundary badges, and zero clipped toolbar controls.
- **Structured I/O & Lazy Workbench Boundaries**: `structured-io-block.ts` provides typed source-kind/channel/format detection (`JSON/JSONL/Markdown/LaTeX/shell/ANSI/diff/stack/HTTP/YAML/SQL`) with container-query CSS (`min-w-0`), while Project Control Deck wraps optional heavy workbenches in a semantic loading/retry/dismiss error boundary that preserves the surrounding shell on chunk load failure.

### Pillar 15: 45 JSON Schemas, Spec Validator Toolchain, Source Ledger, Headless Perf & CI Gates
Files: `docs/omnia-ultra/schemas/*.schema.json` (45 files), `docs/omnia-ultra/tools/*` (6 files), `docs/omnia-ultra/goal/{requirements,capability-ledger,source-ledger}.json`, `.github/workflows/{ci,fast-feedback,release}.yml`, `artifacts/performance/headless-receipt.json`, `docs/audit/PERFORMANCE_EVIDENCE_PLAN_2026-09-09.md`, `docs/QA_STRATEGY.md`, `.agents/checkpoints/*`.

- **`validate-spec.ps1` (`563L`)**: Zero-dependency governance gate validating closed `manifest.allFiles` and `manifest.schemas` (no unlisted orphan docs/schemas), frontmatter `id` uniqueness, 400-line per-doc modularity ceiling, bidirectional `requirements.json <-> capability-ledger.json <-> acceptance-gates.md` parity, DFS dependency cycle checks, and single canonical copy-ready execution prompt enforcement.
- **96-Source Provenance Ledger (`generate-source-ledger.mjs` + `validate-source-ledger.mjs`)**: Computes SHA-256 digests for all local sources, rejects path traversal, and explicitly labels external URLs as `documented-only` unless snapshot-verified.
- **Headless Performance Runner & Honest Evidence Formatter (`omnia.performance-headless.v1`, `perf:evidence`)**: Captures 4-page timings + memory + bundle sizes (`artifacts/performance/headless-receipt.json`, `1,648L`), computes deterministic `p50` and nearest-rank `p95`, keeps unmeasured targets explicitly `not-measured` (never `0`), and defines concrete p95 targets (`Warm shell <= 1500ms`, `Cold launch <= 3000ms`, `Local send feedback <= 100ms`, `10k-conv indexed search <= 300ms`).
- **CI & Windows Rust Hardening**:
  - `check:command-parity` verifying 1:1 parity between frontend IPC calls, registered backend commands, and production definitions (`188/191/191`).
  - **Windows Common Controls v6 `resource.lib` Test Loader Fix**: Documented why Tauri/Win32 manifest resource linking caused `cargo test` executables to crash before test discovery with `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` (fixed via `test = false` on the resource-linked lib crate / separate integration test binaries — directly valuable for `D:\Omnia`'s `omnia-native`!).
  - **Duplicate Rust Method & Unresolved Helper Audit Lesson (`TASK_WORKFLOW_NATIVE_TEST_MATRIX` re-audit)**: Caught a parallel-agent merge bug where two `impl Storage` blocks defined duplicate methods calling undefined helpers while narrow regex verifiers still passed — motivating AST/compiler-backed verification rather than partial regex scans.

### Pillar 16: Multi-Agent Benchmark Synthesis & Evidence Epistemology
Files: `docs/research/*` (`OMNIA_HARNESS_BENCHMARKS.md`, `OPENAI_CODEX_HARNESS_RESEARCH.md`, `CLAUDE_CODE_HARNESS_RESEARCH.md`, `OPENHANDS_OFFICIAL_HARNESS_RESEARCH.md`, `CONTINUE_AIDER_OPENCODE_HARNESS_RESEARCH.md`, etc.), `docs/adr/0001..0008`, `docs/omnia-harness/*`, `docs/qa/*`.

- **Pinned Primary-Source Benchmark Discipline**: Every external harness studied (OpenAI Codex, Claude Code, OpenHands `v1.13.0` + SDK, Aider, Continue, OpenCode) records exact pinned version/commit, license boundary, clean-room `Adopt / Adapt / Defer / Reject` disposition, and security caveats (e.g., OpenHands' warning that host mode is not isolation and generated in-process workflow code is open-world).
- **6-Layer Evidence Taxonomy (`RUN_CONTROL_NATIVE_TEST_PLAN`)**: Separates `contract`, `reducer`, `sqlite`, `renderer`, `integration`, and `packaged` receipts — forbidding promotion of a renderer preview or SQL probe into a packaged-runtime claim, and preserving historical release manifests (`RELEASE_PROVENANCE_AUDIT`) rather than silently overwriting them when source trees evolve.

---

## 3. Prioritized `D:\Omnia` Integration Blueprint (Zero-Nerf / YOLO-Safe)

Every candidate below is mapped to exact live `D:\Omnia` crates/files verified in Shard 22 (`HEAD 1c9342c`) and strictly preserves **all 11 Wave 2 Zero-Nerf / Default YOLO Invariants (`Z-01..Z-11`)**.

| Priority | Integration Candidate (from Shard 08) | Exact `D:\Omnia` Target Crate(s) & File(s) | Concrete Engineering Upgrade | `Z-01..Z-11` YOLO Preservation Guarantee |
|---|---|---|---|---|
| **P0** | **40-Case Deterministic Provider Fault Harness (`PF-001..PF-040`)** | `rust/omnia-agent/tests/provider_fault_harness.rs`, `rust/omnia-routing/tests/`, `rust/omnia-connector-gateway/tests/` | Add zero-`sleep` blocking-checkpoint mock SSE server + SHA-256-seeded `FragmentationPlan` splitting multibyte UTF-8 (Vietnamese), SSE `\r\n`/`\n`, JSON escapes, `429 Retry-After`, cancellation races, and `OMNIA_SYNTHETIC_SECRET_CANARY` leak assertions across all 4 wire dialects (`/v1/messages`, `/v1/responses`, `/v1/chat/completions`, Gemini). | Pure test harness; strengthens `Z-05`, `Z-08`, `Z-09` with zero runtime overhead. |
| **P0** | **Immutable `provider_definition_revisions` + `provider_attempt_lineage_facts` + `outcome-unknown` Billing Safety** | `rust/omnia-storage/src/{session_store.rs,sessions.rs,native_store.rs}`, `rust/omnia-routing/src/{lib.rs,sqlite_store.rs}`, `rust/omnia-agent/src/engine.rs`, `rust/omnia-studio/src/{ops_store.rs,routes_studio_v5.rs,routes_arena_studio_v5.rs}` | Freeze transport/routing definition + opaque `credential_ref` at prepare time (`v20` pattern); record immutable attempt lineage + `effect.state` (`outcome-unknown` on post-acceptance drop); wire `DynamicProviderRouter::cancel_reservation` into `/api/chat/stop`, `/api/router/cancel`, and Arena cancel (closes **Issue #9 `AUD-24`**!). | Never blocks YOLO execution; prevents silent double-billing & stale-profile TOCTOU while preserving `Z-01`, `Z-05`, `Z-08`. |
| **P0** | **Consolidate `RecallStore` vs `ops_store.rs` + SQLite `STRICT`/Immutability Triggers + 14-Timestamp Telemetry & `unknown != 0`** | `rust/omnia-storage/src/{recall_store.rs,session_store.rs}`, `rust/omnia-studio/src/{ops_store.rs,routes_observatory_v5.rs}`, `ui-v5/src/components/workbenches/obs/AiTelemetryPanel.tsx` | Unify overlapping telemetry/kanban/kb/paste/routine tables into one WAL schema with `PRAGMA trusted_schema = OFF`, immutability triggers on receipts/usage ledger, microunit cost + frozen price hash, 14 monotonic timestamps (separating hidden thinking vs visible TTFT/TPS), and `provider-reported-only` cache evidence (`unknown` != `0`). | Pure observability/durability upgrade; zero runtime gating (`Z-01`, `Z-07`, `Z-08`). |
| **P0** | **State-Revision Graph, Branch-Head CAS & 5 State-Base Retry/Fork Engine** | `rust/omnia-storage/src/session_store.rs`, `rust/omnia-studio/src/{ops_store.rs,routes_arena_studio_v5.rs,routes_studio_v5.rs}`, `ui-v5/src/components/chat/Transcript.tsx` | Upgrade `chat_branches` to canonical `child -> parent` `state_revisions` with `expected_head` CAS, `accepted` vs `candidate` isolation (`Retry A -> Retry B`), immutable `message_revisions`, idempotency `payload_drift` rejection, and selectable state bases (`exact-historical`, `current-state`, `historical-plus-selected-deltas`, `fresh-branch`). | Enhances branching/rewind reliability without adding confirmation friction in YOLO (`Z-01`, `Z-06`, `Z-07`). |
| **P0** | **Cross-Layer Boundary & Contract Validators (API/Route Parity + UI Typography/Tokens/Bundle + Rust Helper/CI Hygiene)** | `tools/omnia-consolidated-audit/audit.py`, `ui-v5/scripts/` (or `tools/maintained-scripts/`), `.github/workflows/{ci,release}.yml`, `rust/omnia-studio/src/http.rs` | Add `check:route-parity` (matching `ui-v5/src/api/client.ts` `167` calls against `omnia-studio` `360` arms), `check:typography` (`0` literal `<10px` fonts), `check:tokens` (W3C DTCG JSON -> `ui-v5/src/styles/tokens.css`), `check:bundle` budget gate, Unicode Policy-A boundary parity tests across Rust/JSON/SQLite, and fix `.github/workflows/release.yml` (`ui-dist` + `--features embed-ui`) + `AUD-02` bound-port check. | Protects `Z-09`, `Z-10`, `Z-11`; zero behavioral nerf. |
| **P1** | **Multimodal Capability Bridge v2 & CIR Coordinate-Closure Workers (`PRODUCT-ATTACHMENTS`)** | `rust/omnia-harness/src/rich_composer.rs`, `rust/omnia-notebook/src/{ingestion.rs,preview.rs}`, `rust/omnia-agent/src/{lakeview.rs,engine.rs}`, `rust/omnia-storage/src/session_store.rs` | Add explicit per-`(provider, model, modality, operation)` `operationCapabilities[]` registry (never assuming `"OpenAI-compatible"` parity), 7 bridge resolution modes, 9 CIR locator types (`page/sheet-cell/slide/image-region/time-range/...`), 5 epistemic labels, 13 non-compensatory fidelity gates, and `data-not-control` provenance tagging. | Tags untrusted attachment provenance WITHOUT triggering silent `Yolo -> AlwaysAsk` downgrade (`Z-02` explicitly preserved!). |
| **P1** | **Role Profile v2 vs Persona Pack Firewall + Anti-Filler Deduplication** | `rust/omnia-studio/src/{ops_store.rs,routes_arena_studio_v5.rs}`, `rust/omnia-harness/src/skill_registry.rs`, `ui-v5/src/components/workbenches/AIStudioArenaView.tsx`, `tools/omnia-skill-parity/validate_skills.py` | Split `studio_personas` (Gems: voice/model/effort/temperature/style) from operational Role Profiles; add `canonicalHash`/`differentiationHash` deduplication and reject hidden authority/secret keys inside imported third-party persona packs (while preserving YOLO tool access for the user's active session). | User stays in full `Yolo` (`Z-01`); blocks malicious third-party persona JSON from smuggling secrets/hidden overrides (`Z-09`). |
| **P1** | **SQL-Native Task Dependency Cycle Guard (`WITH RECURSIVE`) & Durable `PeerMeshGraph` + Fencing Leases** | `rust/omnia-graph/src/peer_mesh.rs`, `rust/omnia-storage/src/native_store.rs`, `rust/omnia-studio/src/{ops_store.rs,routes_legacy.rs}`, `ui-v5/src/components/workbenches/SwarmView.tsx` | Persist `PeerMeshGraph` + `ops_kanban_tasks` dependencies into SQLite WAL with `WITH RECURSIVE` cycle-detection trigger + terminal-task guard + monotonic fencing leases (`owner_id`, `lease_generation`, `expiry`) and sorted deadlock-free resource claims; wire `read_since` polling & stalled-peer alerts in `SwarmView`. | Improves multi-agent reliability and crash recovery with zero friction (`Z-01`, `Z-07`). |
| **P1** | **6-Layer Cache Evidence Separation & Compaction Survival Guard** | `rust/omnia-agent/src/{cache_guard.rs,context.rs,lakeview.rs}`, `ui-v5/src/components/workbenches/obs/AiTelemetryPanel.tsx` | Enforce 7 mandatory survival kinds during `FoldAgent`/Lakeview compaction (`security-policy`, `user-correction`, `goal`, `task`, `citation`, `memory-supersession`, `continuation-cursor`) with fidelity-gated rollback, and display Local Reuse vs Provider-Reported Prompt Cache on separate rows in Observatory. | Strengthens `Z-08` Prefix-0 KV invariance & long-horizon fidelity. |
| **P1** | **Windows 6-Tier Virtual Pointer, `TargetBinding` Anti-Reuse & Window Twin (`BrowserWorkbench`)** | `rust/omnia-media-capture/src/{browser_cdp.rs,window_capture.rs,input_diagnostics.rs}`, `ui-v5/src/components/browser/BrowserWorkbench.tsx` | Add `TargetBinding` `(hwnd, pid, create_time, generation)` anti-reuse guard, separate `semantic_available` vs `visual_available` readiness flags, 4-stage `Intent -> Dispatch -> Observation -> Verification` overlay (cyan virtual cursor + Shadow Mode), and keep built-in `CoreWebView2` CDP (never deprecated `DevToolsProtocolExtension`). | Enhances `omnia-media-capture` reliability & `Z-09` non-bypass; physical `SendInput` stays explicit opt-in tier `T5`. |
| **P1** | **Capability Matrix UI (`AUD-25`) + Headless Perf Evidence Runner (`perf:evidence`)** | `ui-v5/src/components/workbenches/obs/SystemHardwarePanel.tsx`, `ui/app/views/settings/`, `tools/omnia-benchmark/` | Render live `/api/capabilities` readiness + timestamps + remediation cleanly separated from `/api/health` (closes **Issue #9 `AUD-25`**), and add `omnia.performance-headless.v1` p50/p95 runner (`Warm <= 1500ms`, `Local send <= 100ms`, `10k search <= 300ms`) with explicit `not-measured` status. | Closes Issue #9 & elevates `Z-10` startup/latency discipline. |
| **P2** | **74-Case Git Auth Fault Suite (`GAF-*`) & 14-Suite Learning/Eval Corpus (`LH-01..LH-14`, incl. `LH-08` Lost-in-the-Middle)** | `rust/omnia-agent/src/git_forensics.rs`, `tools/omnia-benchmark/`, `rust/omnia-routing/src/lib.rs` | Port synthetic `GAF-*` Git credential redaction tests into `git_forensics` tests, add bilingual Vi/En `LH-08` (position permutation + 0..64 distractors) into `omnia-benchmark`, and add propensity logging + `offline -> shadow -> canary -> kill-switch` policy release envelopes for adaptive routing (`OM-TM-040` outside security path). | Zero runtime impact on default YOLO; strictly raises benchmark & routing quality. |
| **P2** | **Living Project Twin Offline Atlas Export & Material-Change Smart Overview** | `rust/omnia-graph/src/graphify_index.rs`, `rust/omnia-harness/src/artifact_os.rs`, `ui-v5/src/components/workbenches/MissionLifecycleView.tsx` | Add zero-network single-file `atlas.html` export from `GraphifyIndex` with line-exact SHA-256 `sourceRefs`, inference-only `confidence` enforcement, and material-change-gated overview refresh with user title lock. | Zero-CDN offline artifact (`Z-11`) complementing 12-Artifact OS. |
| **P2** | **Remote Client Durable Pairing & Device Revocation (`omnia-remote-control`)** | `rust/omnia-remote-control/src/{pairing.rs,replay.rs}`, `rust/omnia-studio/src/routes_capabilities.rs` | Persist paired device keys, granular device scopes, replay windows, and revocation lists in SQLite WAL instead of ephemeral `RemoteControlState` in `routes_legacy.rs`. | Hardens remote access (`Z-09`) without affecting local YOLO workflow (`Z-01`). |
| **P2** | **Brand Logo SVG System (`L01 Command Ring`), Structured I/O Block & Lazy Workbench Error Boundaries** | `ui-v5/src/components/shell/TopBar.tsx`, `ui-v5/src/components/chat/{Transcript.tsx,ArtifactCanvasDrawer.tsx}`, `ui-v5/src/App.tsx` | Adopt crisp geometric SVG brand mark, typed Structured I/O inspector block (`JSON/JSONL/diff/ANSI/HTTP/SQL` raw-vs-normalized toggle), semantic `ErrorBoundary` around lazy workbenches, and `JumpTarget` content-free semantic-fingerprint minimap/anchors. | Elevates Flagship Studio UI polish & accessibility (`Z-11`). |

---

## 4. Prioritized `agy` / `agy-fast` Integration Blueprint

Mapped directly to live Antigravity (`agy`) & `agy-fast` surfaces (`C:\Users\khang\.gemini\config\skills\{super-plan,super-run,global-lessons}`, `C:\Users\khang\.gemini\antigravity\builtin\skills\{native_swarm,run-workflow,automation,conversations,generative_ui,ui-plugin-navigation}`, `E:\Users\khang\.gemini\GEMINI.md`, and `agy-fast` Rust engine / accounts / routing / TUI / WebUI / observatory).

| Priority | Integration Candidate (from Shard 08) | Exact `agy` / `agy-fast` Target Surface | Concrete Engineering Upgrade |
|---|---|---|---|
| **P0** | **Closed Spec-Pack, Bidirectional Ledger & Single-Prompt Validator (`validate-spec.ps1` pattern)** | `/super-plan` & `/super-run` skills (`C:\Users\khang\.gemini\config\skills\{super-plan,super-run}\SKILL.md`), `agy` artifact verifiers | Upgrade `/super-plan` & `/super-run` artifact gates to validate closed manifest coverage, unique requirement/task IDs, bidirectional `GOAL <-> PLAN <-> TASKS <-> DOD` traceability, DFS task-dependency cycle rejection, 400-line modular doc hygiene, and explicit separation of immutable goal specs from mutable continuation checkpoints. |
| **P0** | **6-Layer Evidence Taxonomy & Same-Snapshot Receipt Discipline (`contract|reducer|sqlite|renderer|integration|packaged`)** | `/super-run` verifier phase, `/learn` (`global-lessons`), `E:\Users\khang\.gemini\GEMINI.md` | Require every `/super-run` DoD receipt and swarm `[done]` post to tag its exact verification layer and block stale-binary / renderer-preview overclaims; record missing/unavailable toolchains explicitly as `unverified`/`unavailable` rather than inferring pass. |
| **P0** | **40-Case Deterministic Provider Fault Harness (`PF-001..PF-040`) & `outcome-unknown` Replay Guard** | `agy-fast` Rust provider/account router & SSE streaming engine, account failover observatory | Add zero-`sleep` blocking-checkpoint + SHA-256-seeded UTF-8/SSE fragmentation tests and `OMNIA_SYNTHETIC_SECRET_CANARY` redaction checks to `agy-fast`; track `outcome-unknown` after provider acceptance so `agy-fast` account/model failover never silently double-bills non-idempotent requests on post-acceptance wire drops. |
| **P0** | **14-Timestamp Telemetry, Superseding Usage Ledger & `unknown != 0` Coverage** | `agy-fast` Observatory / TUI / WebUI telemetry panels, `conversation_summaries.db` analytics | Split hidden reasoning TTFT from visible-output TTFT/TTFM/TPS across Gemini/Claude/Codex models; keep local prefix/context reuse strictly separated from `provider-reported-only` prompt cache hits; preserve `unknown` (`null`) instead of zeroing missing quota/billing headers. |
| **P1** | **Conversation State-Revision Graph, Branch-Head CAS & 5 State-Base Replay/Checkpointing** | `agy` `conversations` API/skill, `agy-fast` session rewind/branching & checkpointing | Model conversation edits, retries, and forks as an immutable `child -> parent` state-revision graph with `accepted` vs `candidate` isolation (`Retry A -> Retry B`), idempotency `payload_drift` rejection, and fixed-watermark cursor replay across TUI/WebUI/IDE clients. |
| **P1** | **Monotonic Fencing Leases & Sorted Resource Claims for Swarm Workers** | `native_swarm` & `run-workflow` skills (`C:\Users\khang\.gemini\antigravity\builtin\skills\`), `agy-fast` parallel orchestrator | Pair disjoint file ownership with monotonic `(worker_id, lease_generation, expiry)` fencing tokens and canonical resource-lock ordering so revived/stale swarm workers cannot clobber post-takeover artifacts or edits. |
| **P1** | **Role Profile v2 vs Persona Pack Firewall + Anti-Filler Hash Deduplication** | `agy` plugins/skills/custom-agents registry (`agy-customizations`, `plugin` skills) | Enforce machine-checked separation between operational agent profiles (typed I/O, stop/escalation rules, eval suites) and stylistic persona overlays (hard-rejecting hidden tool/grant/secret keys), plus `differentiationHash` duplicate detection across installed skill/agent catalogs. |
| **P1** | **Compaction Survival Invariants & `LH-08` Lost-in-the-Middle Context Eval** | `agy` `/compact` engine, `agy-fast` context compiler & benchmark suite | Pin 7 survival kinds across `/compact` (`user-correction`, `goal`, `task`, `citation`, `memory-supersession`, `continuation-cursor`, `security-policy`) with fidelity-gated compaction rollback, and run `LH-08` bilingual Vi/En position-permutation + 0..64 distractor stress tests against `agy-fast` context compilation. |
| **P1** | **96-Source Provenance Ledger (`source-ledger.json`) & Living Offline Atlas (`atlas.html`)** | `/super-plan` research phase, `deep-research` workflows, `generative_ui` interactive outputs | Auto-generate SHA-256-hashed local source ledgers with explicit `documented-only` external URL tags and render zero-network interactive `atlas.html` dependency/provenance maps inline via `generative_ui` artifacts. |
| **P2** | **Executable W3C DTCG Design Tokens, Typography/Bundle Gates & Headless Perf Receipt (`perf:evidence`)** | `agy-fast` WebUI / Canvas Studio & MCP Apps (`mcp-app-development`) | Drive WebUI/MCP-App themes from a single W3C DTCG `design-tokens.json` with automated `tokens:check`, `check:typography` (`>=10px` floor), `check:hit-targets`, `check:bundle`, and deterministic `p50`/`p95` `perf:evidence` receipts (`not-measured` explicit). |
| **P2** | **6-Tier Windows Virtual Pointer & `TargetBinding` Anti-Reuse for Browser/Desktop Automation** | `agy` browser/computer-use sidecars & `ui-plugin-navigation` | Enforce `T0..T5` transport preference (API/DOM/CDP/UIA before physical input), separate `semantic_available` vs `visual_available`, bind windows with `(hwnd, pid, create_time, generation)`, and visualize Intent-vs-Execution-vs-Verification cursors in Shadow Mode. |
| **P2** | **Propensity-Logged Adaptive Routing (`OM-TM-040` Security-Isolated) & `adaptive-policy-release`** | `agy-fast` multi-account / multi-model dynamic router | Log routing decision episodes with action propensities for offline counterfactual evaluation (`offline -> shadow -> canary -> kill-switch`) while keeping learned routing strictly decoupled from security/permission checks. |

---

## 5. Complete 377 / 377 File Coverage Ledger (100% Zero-Skipping)

### 5.1 Group Summary

| Directory / Scope Group | Files | Lines | Bytes | Coverage |
|---|---:|---:|---:|---|
| `README.md` | 1 | 135 | 12,127 | 100% READ |
| `docs/* (root)` | 25 | 13,809 | 748,117 | 100% READ |
| `docs/adr/**` | 9 | 2,628 | 120,971 | 100% READ |
| `docs/assets/**` | 2 | 0 | 285,584 | 100% READ |
| `docs/audit/**` | 65 | 10,009 | 517,613 | 100% READ |
| `docs/brand-options/**` | 16 | 315 | 27,220 | 100% READ |
| `docs/checkpoints/**` | 1 | 7 | 317 | 100% READ |
| `docs/omnia-harness/**` | 3 | 291 | 31,614 | 100% READ |
| `docs/omnia-ultra/**` | 180 | 24,648 | 1,213,757 | 100% READ |
| `docs/project-twin/**` | 9 | 3,155 | 176,403 | 100% READ |
| `docs/qa/**` | 4 | 955 | 42,733 | 100% READ |
| `docs/releases/**` | 1 | 163 | 16,336 | 100% READ |
| `docs/research/**` | 24 | 10,187 | 490,533 | 100% READ |
| `docs/ui/**` | 6 | 1,525 | 82,808 | 100% READ |
| `design/**` | 16 | 252 | 25,761 | 100% READ |
| `.agents/**` | 11 | 450 | 18,420 | 100% READ |
| `.github/**` | 3 | 328 | 12,398 | 100% READ |
| `artifacts/**` | 1 | 1,648 | 48,028 | 100% READ |
| **TOTAL (Shard 08)** | **377** | **70,505** | **3,870,740** | **377/377 (100%)** |

### 5.2 Exhaustive File-by-File Ledger (All 377 Files)

| # | Relative Path (`khangmacphuc-omnia/`) | Lines | Bytes | Kind | Status | Distilled Scope / Document ID / Key Contents |
|---:|---|---:|---:|---|---|---|
| 1 | `.agents/checkpoints/fresh-preview-evidence-20261108.md` | 35 | 1,522 | `md` | READ (100%) | Fresh preview UI evidence — 2026-11-08 |
| 2 | `.agents/checkpoints/ide-accessibility-contract-20261108.md` | 39 | 1,565 | `md` | READ (100%) | IDE accessibility contract — 2026-11-08 |
| 3 | `.agents/checkpoints/multimodal-endpoint-slice-result-20261108.md` | 44 | 2,209 | `md` | READ (100%) | Multimodal generation endpoint planning slice |
| 4 | `.agents/checkpoints/native-loader-current-receipt-20261108.md` | 65 | 1,916 | `md` | READ (100%) | Native test loader current receipt — 2026-11-08 |
| 5 | `.agents/checkpoints/observability-projection-fix-result-20261108.md` | 45 | 2,018 | `md` | READ (100%) | Observability projection repair receipt — 2026-11-08 |
| 6 | `.agents/checkpoints/provider-lineage-receipt-fix-20261108.md` | 35 | 1,421 | `md` | READ (100%) | Provider lineage receipt contract fix — 2026-11-08 |
| 7 | `.agents/checkpoints/rag-local-adapter-result-20261108.md` | 44 | 1,725 | `md` | READ (100%) | Local RAG adapter receipt — 2026-11-08 |
| 8 | `.agents/checkpoints/rag-native-admission-result-20261108.md` | 44 | 2,056 | `md` | READ (100%) | Native RAG admission evidence — 2026-11-08 |
| 9 | `.agents/checkpoints/rag-provider-contract-result-20261108.md` | 32 | 1,611 | `md` | READ (100%) | RAG provider contract slice — 2026-11-08 |
| 10 | `.agents/checkpoints/release-native-ci-gate-20261108.md` | 29 | 1,016 | `md` | READ (100%) | Release native CI gate — 2026-11-08 |
| 11 | `.agents/checkpoints/upstream-catalog-reproducibility-20261108.md` | 38 | 1,361 | `md` | READ (100%) | Upstream catalog reproducibility receipt — 2026-11-08 |
| 12 | `.github/workflows/ci.yml` | 115 | 4,884 | `yml` | READ (100%) | GitHub Actions workflow `quality` (jobs: push, pull_request, renderer, native, storage-contract, visual-contract) |
| 13 | `.github/workflows/fast-feedback.yml` | 29 | 680 | `yml` | READ (100%) | GitHub Actions workflow `fast-feedback` (jobs: push, pull_request, renderer-fast) |
| 14 | `.github/workflows/release.yml` | 184 | 6,834 | `yml` | READ (100%) | GitHub Actions workflow `release` (jobs: push, workflow_dispatch, validate, windows-bundle) |
| 15 | `README.md` | 135 | 12,127 | `md` | READ (100%) | Omnia |
| 16 | `artifacts/performance/headless-receipt.json` | 1,648 | 48,028 | `json` | READ (100%) | omnia.performance-headless.v1 — JSON data (schemaVersion, generatedAt, status, metadata, metrics, events...) |
| 17 | `design/logo-catalog-2026-09-15/README.md` | 60 | 4,084 | `md` | READ (100%) | Omnia logo + palette exploration |
| 18 | `design/logo-catalog-2026-09-15/index.html` | 73 | 8,810 | `html` | READ (100%) | HTML page: Omnia logo + palette exploration |
| 19 | `design/logo-catalog-2026-09-15/logo-01-command-ring.svg` | 5 | 352 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 20 | `design/logo-catalog-2026-09-15/logo-02-terminal-aperture.svg` | 4 | 293 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 21 | `design/logo-catalog-2026-09-15/logo-03-branch-node.svg` | 7 | 594 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 22 | `design/logo-catalog-2026-09-15/logo-04-layered-window.svg` | 5 | 303 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 23 | `design/logo-catalog-2026-09-15/logo-05-hex-core.svg` | 5 | 367 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 24 | `design/logo-catalog-2026-09-15/logo-06-stack-cursor.svg` | 4 | 317 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 25 | `design/logo-catalog-2026-09-15/logo-07-orbit-grid.svg` | 6 | 394 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 26 | `design/logo-catalog-2026-09-15/logo-08-chevron-loop.svg` | 4 | 305 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 27 | `design/logo-catalog-2026-09-15/logo-09-prompt-diamond.svg` | 4 | 319 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 28 | `design/logo-catalog-2026-09-15/logo-10-compile-spark.svg` | 6 | 389 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 29 | `design/logo-catalog-2026-09-15/logo-11-nodal-arc.svg` | 7 | 436 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 30 | `design/logo-catalog-2026-09-15/logo-12-monogram-o.svg` | 4 | 293 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 256 256) |
| 31 | `design/logo-catalog-2026-09-15/logo-contact-sheet.svg` | 43 | 3,328 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 1600 1120) |
| 32 | `design/logo-catalog-2026-09-15/palette-board.svg` | 15 | 5,177 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 1600 980) |
| 33 | `docs/AGENT_TOOL_DAG_CONTRACT.md` | 363 | 13,671 | `md` | READ (100%) | Omnia Agent, Tool, Task DAG, and Mailbox Contract |
| 34 | `docs/CONTEXT_COMPILER_ARCHITECTURE.md` | 59 | 3,405 | `md` | READ (100%) | Omnia Context Compiler & Hierarchical Memory Architecture |
| 35 | `docs/CONVERSATION_BRANCH_ARCHITECTURE.md` | 405 | 16,600 | `md` | READ (100%) | Omnia Conversation and Branch Architecture |
| 36 | `docs/FRONTEND_MODULARIZATION_PLAN.md` | 804 | 36,250 | `md` | READ (100%) | Frontend modularization plan |
| 37 | `docs/GIT_AUTH_CREDENTIAL_FAULT_CATALOG.md` | 248 | 23,788 | `md` | READ (100%) | Git authentication and credential fault catalog |
| 38 | `docs/HARNESS_ARCHITECTURE.md` | 62 | 3,456 | `md` | READ (100%) | Omnia Harness Architecture: Decentralized Multi-Agent DAG & Sovereign Kernel |
| 39 | `docs/IMPLEMENTATION_STATUS.md` | 1,873 | 140,472 | `md` | READ (100%) | Omnia implementation status |
| 40 | `docs/LEARNING_RESEARCH_HARNESS.md` | 170 | 9,802 | `md` | READ (100%) | Omnia learning and research harness |
| 41 | `docs/NATIVE_INTEGRATION_AUDIT_20261107.md` | 50 | 2,533 | `md` | READ (100%) | Native integration audit — 2026-11-07 |
| 42 | `docs/OBSERVABILITY_PROJECT_CHAT_CONTRACT.md` | 564 | 24,217 | `md` | READ (100%) | Omnia observability contract for Project and Chat |
| 43 | `docs/OMNIA_VERTICAL_SLICE_DOD_20261107.md` | 86 | 6,132 | `md` | READ (100%) | Omnia vertical slice DoD — 2026-11-07 |
| 44 | `docs/PRODUCT_SPEC.md` | 69 | 6,251 | `md` | READ (100%) | Omnia — Sovereign Desktop Ecosystem & Autonomous Harness Specification |
| 45 | `docs/PROVIDER_ARCHITECTURE.md` | 671 | 36,267 | `md` | READ (100%) | Omnia provider and BYOK architecture |
| 46 | `docs/PROVIDER_FAULT_HARNESS.md` | 410 | 18,018 | `md` | READ (100%) | Provider fault harness |
| 47 | `docs/PROVIDER_MULTIMODAL_DESIGN.md` | 511 | 17,805 | `md` | READ (100%) | Omnia provider-neutral multimodal input design |
| 48 | `docs/QA_STRATEGY.md` | 308 | 23,481 | `md` | READ (100%) | Omnia quality strategy |
| 49 | `docs/README.md` | 141 | 22,915 | `md` | READ (100%) | Omnia documentation |
| 50 | `docs/REMOTE_CLIENT_ARCHITECTURE.md` | 716 | 32,695 | `md` | READ (100%) | Omnia remote clients architecture |
| 51 | `docs/THREAT_MODEL.md` | 660 | 50,968 | `md` | READ (100%) | Omnia security threat model |
| 52 | `docs/UPSTREAM_HARNESS_INTEGRATION_20261107.md` | 49 | 5,069 | `md` | READ (100%) | Upstream harness reuse ledger — 2026-11-07 |
| 53 | `docs/UPSTREAM_INTEGRATION_INVENTORY.md` | 109 | 9,335 | `md` | READ (100%) | Omnia upstream integration inventory |
| 54 | `docs/adr/0001-desktop-runtime-and-core-boundary.md` | 127 | 5,852 | `md` | READ (100%) | ADR 0001 — Tauri desktop runtime and versioned core boundary |
| 55 | `docs/adr/0002-unified-kernel-execution-and-capabilities.md` | 180 | 7,494 | `md` | READ (100%) | ADR 0002: Unified kernel execution, capabilities, approvals, and audit |
| 56 | `docs/adr/0003-attachment-draft-ownership-and-atomic-bind.md` | 147 | 6,819 | `md` | READ (100%) | ADR 0003 — Durable attachment drafts and atomic message binding |
| 57 | `docs/adr/0004-durable-run-event-journal-and-cursor-replay.md` | 269 | 11,567 | `md` | READ (100%) | ADR 0004 — Durable run event journal and cursor replay |
| 58 | `docs/adr/0005-local-first-telemetry-and-usage-ledger.md` | 310 | 13,443 | `md` | READ (100%) | ADR 0005: Local-first telemetry and an append-only usage ledger |
| 59 | `docs/adr/0005-persistent-isolated-and-auto-machine-runtime.md` | 482 | 20,632 | `md` | READ (100%) | ADR 0005: Persistent, isolated, remote, and Auto machine runtime |
| 60 | `docs/adr/0006-native-multimodal-bridge-admission-authority.md` | 362 | 18,479 | `md` | READ (100%) | ADR 0006 — Native Multimodal Bridge Admission Authority |
| 61 | `docs/adr/0007-state-revision-graph-and-branch-head-cas.md` | 453 | 21,770 | `md` | READ (100%) | ADR 0007 — Immutable state revisions and branch-head compare-and-swap |
| 62 | `docs/adr/0008-run-control-multi-stream-cursor-authority.md` | 298 | 14,915 | `md` | READ (100%) | `OMNIA-ADR-0008` — Run-control multi-stream cursor authority and provenance (proposed) |
| 63 | `docs/assets/omnia-app-overview.png` | 0 | 142,792 | `binary-image` | VIEWED (PNG) | PNG visual screenshot (142,792 bytes); inspected via read_file |
| 64 | `docs/assets/omnia-shell-chat-nav-final.png` | 0 | 142,792 | `binary-image` | VIEWED (PNG) | PNG visual screenshot (142,792 bytes); inspected via read_file |
| 65 | `docs/audit/ACTIVE_RUN_UX_AUDIT_2026-08-14.md` | 330 | 17,450 | `md` | READ (100%) | `OMNIA-AUDIT-ACTIVE-RUN-UX-2026-08-14` — Active-run control UX and state-consistency audit (audit-current-tree) |
| 66 | `docs/audit/BRIDGE_NATIVE_PERSISTENCE_REVIEW_2026-08-15.md` | 283 | 15,465 | `md` | READ (100%) | `OMNIA-AUDIT-BRIDGE-NATIVE-PERSISTENCE-2026-08-15` — Native multimodal bridge persistence review (evidence) |
| 67 | `docs/audit/CANONICAL_GOAL_HARDENING_V2_2026-08-14.md` | 73 | 2,536 | `md` | READ (100%) | `OMNIA-AUDIT-CANONICAL-GOAL-HARDENING-V2-2026-08-14` — Canonical goal hardening v2 receipt (audit-current-tree) |
| 68 | `docs/audit/CAPABILITY_LEDGER_UI_WAVE_RECEIPT_2026-09-30.md` | 57 | 5,492 | `md` | READ (100%) | `OMNIA-AUDIT-CAPABILITY-LEDGER-UI-WAVE-2026-09-30` — Capability ledger UI wave receipt (renderer-partial) |
| 69 | `docs/audit/DYNAMIC_ROUTING_LEARNING_AUDIT_2026-08-14.md` | 241 | 17,530 | `md` | READ (100%) | `OMNIA-AUDIT-DYNAMIC-ROUTING-LEARNING-2026-08-14` — Dynamic routing and adaptive-learning contract audit (audit-evidence) |
| 70 | `docs/audit/FILE_ARTIFACT_BRIDGE_RENDERER_PREVIEW_RECEIPT_2026-09-30.md` | 38 | 1,693 | `md` | READ (100%) | File and artifact bridge renderer preview receipt — September 30, 2026 |
| 71 | `docs/audit/FINAL_VERIFICATION_RECEIPT_20261107.md` | 64 | 3,440 | `md` | READ (100%) | Omnia final verification receipt — 2026-11-07 |
| 72 | `docs/audit/FRESH_CONTINUATION_BOOTSTRAP_NATIVE_CONTRACT_2026-09-12.md` | 304 | 13,016 | `md` | READ (100%) | `OMNIA-AUDIT-FRESH-CONTINUATION-BOOTSTRAP-2026-09-12` — Native fresh continuation bootstrap contract (design-blocker) |
| 73 | `docs/audit/FRONTEND_RUN_GRAPH_AUDIT.md` | 184 | 8,742 | `md` | READ (100%) | Frontend run-graph audit |
| 74 | `docs/audit/GOAL_PROMPT_FINAL_REDTEAM_2026-08-14.md` | 209 | 10,244 | `md` | READ (100%) | `OMNIA-AUDIT-GOAL-PROMPT-FINAL-REDTEAM-2026-08-14` — Final red-team receipt for the copy-ready Omnia Ultra goal (audit-receipt) |
| 75 | `docs/audit/GOAL_ROADMAP_PLAN_RENDERER_PREVIEW_RECEIPT_2026-09-30.md` | 44 | 1,920 | `md` | READ (100%) | Goal, roadmap, and plan renderer preview receipt — September 30, 2026 |
| 76 | `docs/audit/KERNEL_EXECUTION_CONTRACT_AUDIT.md` | 651 | 26,867 | `md` | READ (100%) | Omnia Kernel execution contract audit |
| 77 | `docs/audit/LOCAL_MODEL_READINESS_2026-08-14.md` | 55 | 2,268 | `md` | READ (100%) | `OMNIA-AUDIT-LOCAL-MODEL-READINESS-2026-08-14` — Local model readiness probe (audit-current-tree) |
| 78 | `docs/audit/MAINTAINABILITY_INFORMATION_ARCHITECTURE_AUDIT_2026-08-14.md` | 409 | 21,929 | `md` | READ (100%) | `OMNIA-AUDIT-MAINTAINABILITY-IA-2026-08-14` — Omnia Ultra maintainability and information-architecture audit (audit-current-tree) |
| 79 | `docs/audit/MEMORY_SKILLS_RENDERER_PREVIEW_RECEIPT_2026-09-30.md` | 45 | 2,515 | `md` | READ (100%) | `OMNIA-AUDIT-MEMORY-SKILLS-RENDERER-PREVIEW-2026-09-30` — Memory and Skills renderer-preview receipt (bounded-renderer-evidence) |
| 80 | `docs/audit/MULTIMODAL_BRIDGE_UI_INTEGRATION_REVIEW_2026-08-15.md` | 285 | 14,452 | `md` | READ (100%) | `OMNIA-AUDIT-MULTIMODAL-BRIDGE-UI-INTEGRATION-2026-08-15` — Multimodal bridge UI integration review (evidence) |
| 81 | `docs/audit/MULTIMODAL_BRIDGE_UNIVERSAL_ENDPOINTS_RED_TEAM_2026-08-14.md` | 458 | 31,561 | `md` | READ (100%) | `OMNIA-AUDIT-MULTIMODAL-BRIDGE-UNIVERSAL-ENDPOINTS-2026-08-14` — Multimodal bridge and universal-endpoint red-team audit (audit-current-tree) |
| 82 | `docs/audit/NATIVE_BRANCH_FORK_ATOMIC_RECEIPT_2026-09-24.md` | 38 | 1,689 | `md` | READ (100%) | Native branch/fork atomic receipt slice |
| 83 | `docs/audit/NATIVE_BROWSER_CONTRACT_RECEIPT_20261108.md` | 84 | 3,510 | `md` | READ (100%) | Native browser contract receipt — 2026-11-08 |
| 84 | `docs/audit/NATIVE_MULTIMODAL_ADMISSION_EVIDENCE_PLAN_2026-08-15.md` | 237 | 13,276 | `md` | READ (100%) | Native multimodal admission evidence plan |
| 85 | `docs/audit/NATIVE_MULTIMODAL_ADMISSION_VERTICAL_SLICE_2026-09-09.md` | 73 | 3,666 | `md` | READ (100%) | Native multimodal admission vertical-slice receipt — 2026-09-09 |
| 86 | `docs/audit/NATIVE_PROJECT_METADATA_UPDATE_RECEIPT_2026-09-24.md` | 44 | 1,860 | `md` | READ (100%) | Native Project metadata update slice |
| 87 | `docs/audit/NATIVE_RUN_JOURNAL_VERTICAL_SLICE.md` | 167 | 8,695 | `md` | READ (100%) | Native run-journal vertical slice |
| 88 | `docs/audit/NATIVE_TELEMETRY_READ_TEST_RECEIPT_2026-08-14.md` | 65 | 2,544 | `md` | READ (100%) | Native telemetry-read focused test receipt |
| 89 | `docs/audit/NATIVE_TEST_LOADER_RECEIPT.md` | 76 | 2,872 | `md` | READ (100%) | Native test loader blocker receipt |
| 90 | `docs/audit/NATIVE_TEST_LOADER_RECEIPT_20261107.md` | 105 | 4,174 | `md` | READ (100%) | Native test loader verification — 2026-11-07 |
| 91 | `docs/audit/OFFICIAL_MULTIMODAL_PROVIDER_MATRIX_RECEIPT_2026-08-14.md` | 71 | 3,362 | `md` | READ (100%) | `OMNIA-AUDIT-OFFICIAL-MULTIMODAL-MATRIX-2026-08-14` — Official multimodal provider-operation matrix research receipt (audit) |
| 92 | `docs/audit/OMNIA_COMPACT_UI_CONTINUATION_2026-10-01.md` | 46 | 2,471 | `md` | READ (100%) | Omnia compact UI continuation — October 1, 2026 |
| 93 | `docs/audit/OMNIA_CONTINUATION_CHECKPOINT_2026-09-29.md` | 170 | 10,290 | `md` | READ (100%) | `OMNIA-CONTINUATION-CHECKPOINT-2026-09-29` — Omnia Ultra continuation checkpoint — Project Deck, context, cache and telemetry (informational) |
| 94 | `docs/audit/OMNIA_GOAL_CHAT_INTERACTION_2026-10-01.md` | 174 | 10,479 | `md` | READ (100%) | Omnia Goal/Chat interaction continuation — October 1, 2026 |
| 95 | `docs/audit/OMNIA_PHASE_PLAN_PROJECT_DECK_CACHE_TELEMETRY_2026-09-29.md` | 315 | 17,570 | `md` | READ (100%) | `OMNIA-PHASE-PLAN-PROJECT-DECK-CACHE-TELEMETRY-2026-09-29` — Atomic phase plan — Project Deck, context, cache, routing and telemetry (operational-plan) |
| 96 | `docs/audit/OMNIA_PROJECT_CHAT_HANDOFF_CONTINUATION_2026-09-24.md` | 67 | 3,721 | `md` | READ (100%) | Omnia Project / Chat / Handoff continuation — September 24, 2026 |
| 97 | `docs/audit/OMNIA_PROJECT_DECK_CACHE_TELEMETRY_PHASE_2026-09-29.md` | 138 | 7,278 | `md` | READ (100%) | `OMNIA-AUDIT-PROJECT-DECK-CACHE-TELEMETRY-2026-09-29` — Documentation audit receipt — Project Deck cache/context/routing/telemetry phase (evidence-note) |
| 98 | `docs/audit/OMNIA_PROJECT_PLAN_CHAT_HANDOFF_SELECTION_2026-09-24.md` | 64 | 4,176 | `md` | READ (100%) | Omnia Project Plan → Chat and Handoff selection — September 24, 2026 |
| 99 | `docs/audit/OMNIA_RENDERER_UI_CONTINUATION_2026-09-24.md` | 69 | 4,159 | `md` | READ (100%) | Omnia renderer Project/Chat continuation — September 24, 2026 |
| 100 | `docs/audit/OMNIA_ULTRA_GOAL_PACK_GAP_AUDIT.md` | 344 | 17,266 | `md` | READ (100%) | `OMNIA-AUDIT-ULTRA-GOAL-PACK-GAPS` — Omnia Ultra goal-pack coverage and drift audit (audit-current-tree) |
| 101 | `docs/audit/OMNIA_ULTRA_SPEC_INTEGRATION_RECEIPT_2026-08-15.md` | 152 | 5,846 | `md` | READ (100%) | `OMNIA-AUDIT-OMNIA-ULTRA-SPEC-INTEGRATION-2026-08-15` — Omnia Ultra spec integration and release-gate receipt (audit-receipt) |
| 102 | `docs/audit/PERFORMANCE_EVIDENCE_PLAN_2026-09-09.md` | 186 | 7,749 | `md` | READ (100%) | Performance evidence plan — September 9, 2026 |
| 103 | `docs/audit/PROJECT_CONTROL_DECK_EVIDENCE_CROSSWALK_2026-09-21.md` | 176 | 11,006 | `md` | READ (100%) | `OMNIA-AUDIT-PROJECT-CONTROL-DECK-EVIDENCE-CROSSWALK-2026-09-21` — Project Control Deck and canonical Overview tab evidence crosswalk (evidence-backed-preview) |
| 104 | `docs/audit/PROMPT_INTELLIGENCE_RENDERER_PREVIEW_RECEIPT_2026-09-30.md` | 44 | 1,888 | `md` | READ (100%) | `OMNIA-AUDIT-PROMPT-INTELLIGENCE-RENDERER-PREVIEW-2026-09-30` — Prompt intelligence and Discuss renderer-preview receipt (bounded-renderer-evidence) |
| 105 | `docs/audit/PROMPT_NAVIGATION_DOMAIN_SLICE_2026-09-14.md` | 85 | 3,957 | `md` | READ (100%) | Prompt-navigation domain-slice receipt — September 14, 2026 |
| 106 | `docs/audit/PROMPT_NAVIGATION_RENDERER_PREVIEW_2026-09-14.md` | 73 | 3,426 | `md` | READ (100%) | Prompt-navigation renderer-preview receipt — September 14, 2026 |
| 107 | `docs/audit/PROVIDER_ATTEMPT_LINEAGE_BOUNDARY_CONTRACT_AUDIT_2026-09-11.md` | 136 | 6,761 | `md` | READ (100%) | Provider-attempt lineage boundary contract audit |
| 108 | `docs/audit/PROVIDER_ATTEMPT_LINEAGE_RECEIPT_READ_2026-09-24.md` | 55 | 2,847 | `md` | READ (100%) | `OMNIA-AUDIT-PROVIDER-ATTEMPT-LINEAGE-RECEIPT-READ-2026-09-24` — Provider attempt lineage receipt read slice (development-evidence) |
| 109 | `docs/audit/PROVIDER_ATTEMPT_LINEAGE_V14_STATUS_DRAFT_2026-09-10.md` | 157 | 6,846 | `md` | READ (100%) | Provider-attempt lineage v14 status draft — September 10, 2026 |
| 110 | `docs/audit/PROVIDER_ATTEMPT_LINEAGE_V14_TEST_PLAN_2026-09-10.md` | 115 | 6,254 | `md` | READ (100%) | `OMNIA-AUDIT-PROVIDER-ATTEMPT-LINEAGE-V14-TEST-PLAN` — Provider attempt lineage v14 test plan (evidence-plan) |
| 111 | `docs/audit/PROVIDER_DEFINITION_REVISION_V20_RECEIPT_2026-09-25.md` | 50 | 2,439 | `md` | READ (100%) | Provider-definition revision v20 receipt |
| 112 | `docs/audit/QUEUE_RENDERER_FEASIBILITY_2026-09-14.md` | 175 | 8,552 | `md` | READ (100%) | `OMNIA-AUDIT-QUEUE-RENDERER-FEASIBILITY-2026-09-14` — Queue and steer renderer feasibility audit (evidence-bound-audit) |
| 113 | `docs/audit/RELEASE_PROVENANCE_AUDIT_2026-09-09.md` | 127 | 5,469 | `md` | READ (100%) | `OMNIA-AUDIT-RELEASE-PROVENANCE-2026-09-09` — Release provenance and source-manifest audit (observed-failure) |
| 114 | `docs/audit/RUN_CONTROL_NATIVE_TEST_PLAN_2026-09-11.md` | 348 | 18,794 | `md` | READ (100%) | `OMNIA-AUDIT-RUN-CONTROL-NATIVE-TEST-PLAN-2026-09-11` — Native run-control deterministic test plan (evidence-plan) |
| 115 | `docs/audit/RUN_CONTROL_STORAGE_V15_VERIFICATION_2026-09-11.md` | 93 | 3,475 | `md` | READ (100%) | Run-control storage v15 verification receipt |
| 116 | `docs/audit/RUN_CONTROL_TEST_RECEIPT_2026-08-14.md` | 128 | 6,366 | `md` | READ (100%) | `OMNIA-AUDIT-RUN-CONTROL-TEST-RECEIPT-2026-08-14` — Run-control contract test receipt (audit-current-tree) |
| 117 | `docs/audit/SECURITY_AUTHORITY_AUDIT_2026-08-14.md` | 121 | 6,333 | `md` | READ (100%) | `OMNIA-AUDIT-SECURITY-AUTHORITY-2026-08-14` — Security and authority audit for resilient run control (audit) |
| 118 | `docs/audit/SELECTED_DELTA_STATE_BASE_CONTRACT_AUDIT_2026-09-12.md` | 191 | 7,880 | `md` | READ (100%) | `OMNIA-AUDIT-SELECTED-DELTA-STATE-BASE-2026-09-12` — Selected-delta state-base contract and native enforcement gap (audit-open) |
| 119 | `docs/audit/SPECIALIST_PERSONA_CATALOG_AUDIT_2026-08-14.md` | 312 | 21,305 | `md` | READ (100%) | `OMNIA-AUDIT-SPECIALIST-PERSONA-CATALOG-2026-08-14` — Specialist agent and persona catalog audit (audit-current-tree) |
| 120 | `docs/audit/SPEC_AND_STATE_REVISION_EVIDENCE_2026-09-10.md` | 145 | 6,889 | `md` | READ (100%) | Omnia Ultra specification and state-revision evidence receipt — September 10, 2026 |
| 121 | `docs/audit/STATE_REVISION_CAS_IMPLEMENTATION_RECEIPT_2026-09-09.md` | 99 | 4,332 | `md` | READ (100%) | State-revision/CAS implementation receipt — September 9, 2026 |
| 122 | `docs/audit/STATE_REVISION_GRAPH_CONTRACT_AUDIT_2026-09-10.md` | 109 | 5,990 | `md` | READ (100%) | State-revision graph contract audit — September 10, 2026 |
| 123 | `docs/audit/STRUCTURED_IO_RENDERER_PREVIEW_RECEIPT_2026-09-30.md` | 52 | 2,417 | `md` | READ (100%) | Structured I/O renderer preview receipt — September 30, 2026 |
| 124 | `docs/audit/TASK_WORKFLOW_NATIVE_TEST_MATRIX_2026-09-12.md` | 268 | 13,628 | `md` | READ (100%) | Task and Starter Workflow Native API Test Matrix |
| 125 | `docs/audit/TELEMETRY_RETRY_LINEAGE_AUDIT.md` | 273 | 15,911 | `md` | READ (100%) | Telemetry, retry and state-lineage audit |
| 126 | `docs/audit/UI_ACCESSIBILITY_CUSTOMIZATION_RECEIPT_2026-09-30.md` | 46 | 2,115 | `md` | READ (100%) | `OMNIA-AUDIT-UI-ACCESSIBILITY-CUSTOMIZATION-2026-09-30` — Accessibility and appearance customization renderer receipt (bounded-renderer-evidence) |
| 127 | `docs/audit/UI_FIRST_CLICK_FOCUS_RECEIPT_2026-09-30.md` | 46 | 1,706 | `md` | READ (100%) | `OMNIA-AUDIT-UI-FIRST-CLICK-FOCUS-2026-09-30` — First-click and focus-safe overlay renderer receipt (bounded-renderer-evidence) |
| 128 | `docs/audit/UI_TYPOGRAPHY_AUDIT.md` | 125 | 5,477 | `md` | READ (100%) | Omnia UI typography audit |
| 129 | `docs/audit/WORKSPACE_LIBRARY_RENDERER_PREVIEW_RECEIPT_2026-09-30.md` | 45 | 1,777 | `md` | READ (100%) | `OMNIA-AUDIT-WORKSPACE-LIBRARY-RENDERER-PREVIEW-2026-09-30` — Workspace library renderer-preview receipt (bounded-renderer-evidence) |
| 130 | `docs/brand-options/2026-09-15/README.md` | 45 | 2,858 | `md` | READ (100%) | Omnia brand options — 15 September 2026 |
| 131 | `docs/brand-options/2026-09-15/index.html` | 63 | 8,397 | `html` | READ (100%) | HTML page: Omnia brand options |
| 132 | `docs/brand-options/2026-09-15/logo-01-terminal-o.svg` | 9 | 762 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 133 | `docs/brand-options/2026-09-15/logo-02-grid-o.svg` | 17 | 1,059 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 134 | `docs/brand-options/2026-09-15/logo-03-cursor-gate.svg` | 9 | 770 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 135 | `docs/brand-options/2026-09-15/logo-04-node-loop.svg` | 11 | 976 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 136 | `docs/brand-options/2026-09-15/logo-05-dual-chevron.svg` | 8 | 690 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 137 | `docs/brand-options/2026-09-15/logo-06-stack-mark.svg` | 14 | 868 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 138 | `docs/brand-options/2026-09-15/logo-07-prompt-aperture.svg` | 9 | 782 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 139 | `docs/brand-options/2026-09-15/logo-08-hex-core.svg` | 9 | 719 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 140 | `docs/brand-options/2026-09-15/logo-09-bracket-o.svg` | 9 | 728 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 141 | `docs/brand-options/2026-09-15/logo-10-flowline.svg` | 10 | 811 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 142 | `docs/brand-options/2026-09-15/logo-11-monogram-om.svg` | 8 | 756 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 143 | `docs/brand-options/2026-09-15/logo-12-scanline.svg` | 10 | 821 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 512 512) |
| 144 | `docs/brand-options/2026-09-15/palette-board.svg` | 29 | 3,853 | `svg` | READ (100%) | Vector brand logo SVG (viewBox=0 0 1440 920) |
| 145 | `docs/brand-options/2026-09-15/palette-snippets.css` | 55 | 2,370 | `css` | READ (100%) | Stylesheet (81 CSS custom properties) |
| 146 | `docs/checkpoints/pre-rebuild-20261107.md` | 7 | 317 | `md` | READ (100%) | Pre-rebuild checkpoint |
| 147 | `docs/omnia-harness/CONTINUATION-GOALS-2026-10-31.md` | 73 | 16,863 | `md` | READ (100%) | Omnia continuation goals — 2026-10-31 |
| 148 | `docs/omnia-harness/FEATURES.md` | 130 | 10,201 | `md` | READ (100%) | Omnia Harness — Danh mục tính năng (v1 brainstorm, 2026-10-30) |
| 149 | `docs/omnia-harness/M1-HARNESS-DESIGN.md` | 88 | 4,550 | `md` | READ (100%) | M1 — Omnia Harness (Rust) · Thiết kế |
| 150 | `docs/omnia-ultra/00-START-HERE.md` | 101 | 6,458 | `md` | READ (100%) | `OMNIA-ULTRA-START` — Omnia Ultra specification pack entry point (normative-target) |
| 151 | `docs/omnia-ultra/01-MASTER-CHARTER.md` | 80 | 3,019 | `md` | READ (100%) | `OMNIA-ULTRA-CHARTER` — Universal Intelligent Operating Workbench charter (normative-target) |
| 152 | `docs/omnia-ultra/02-PRECEDENCE-AND-STATUS.md` | 54 | 2,082 | `md` | READ (100%) | `OMNIA-ULTRA-PRECEDENCE` — Precedence, evidence and status rules (normative) |
| 153 | `docs/omnia-ultra/03-TERMINOLOGY.md` | 55 | 2,374 | `md` | READ (100%) | `OMNIA-ULTRA-TERMINOLOGY` — Canonical terminology (normative) |
| 154 | `docs/omnia-ultra/04-CURRENT-STATE-BRIDGE.md` | 183 | 10,647 | `md` | READ (100%) | `OMNIA-ULTRA-CURRENT-STATE` — Bridge between target pack and current source (operational) |
| 155 | `docs/omnia-ultra/README.md` | 19 | 696 | `md` | READ (100%) | `OMNIA-ULTRA-README` — Omnia Ultra specification pack (normative-target) |
| 156 | `docs/omnia-ultra/architecture/README.md` | 37 | 1,271 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-INDEX` — Architecture bundle (normative-target) |
| 157 | `docs/omnia-ultra/architecture/adaptive-intelligence-plane.md` | 46 | 1,264 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-AI-PLANE` — Deep AI intelligence plane (normative-target) |
| 158 | `docs/omnia-ultra/architecture/authoritative-root-api-contract.md` | 386 | 19,576 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-AUTHORITATIVE-ROOT-API` — Authoritative-root native API contract (normative-target) |
| 159 | `docs/omnia-ultra/architecture/authority-and-event-model.md` | 55 | 1,692 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-AUTHORITY` — Authority, event journal and projections (normative-target) |
| 160 | `docs/omnia-ultra/architecture/cache-context-routing.md` | 110 | 5,653 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-CACHE-CONTEXT-ROUTING` — Cache, context and provider reuse architecture (normative-target) |
| 161 | `docs/omnia-ultra/architecture/canonical-domain-model.md` | 38 | 1,267 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-DOMAIN` — Canonical domain object model (normative-target) |
| 162 | `docs/omnia-ultra/architecture/client-runtime-topology.md` | 50 | 1,068 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-CLIENTS` — Client and runtime topology (normative-target) |
| 163 | `docs/omnia-ultra/architecture/context-memory-search.md` | 62 | 1,567 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-CONTEXT` — Context compiler, memory and retrieval (normative-target) |
| 164 | `docs/omnia-ultra/architecture/data-lineage-and-storage.md` | 42 | 1,041 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-LINEAGE` — Data lineage, artifacts and storage (normative-target) |
| 165 | `docs/omnia-ultra/architecture/multimodal-bridge-contract-v2.md` | 295 | 14,866 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-MULTIMODAL-BRIDGE-CONTRACT-V2` — Multimodal bridge contract v2 envelope and replay semantics (normative-target) |
| 166 | `docs/omnia-ultra/architecture/multimodal-capability-bridge.md` | 248 | 15,130 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-MULTIMODAL-CAPABILITY-BRIDGE` — Multimodal capability negotiation, fidelity and safety contract (normative-target) |
| 167 | `docs/omnia-ultra/architecture/run-control-native-mapping.md` | 185 | 11,454 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-RUN-CONTROL-NATIVE-MAPPING` — Run-control operation to state-revision and native receipt mapping (normative-target) |
| 168 | `docs/omnia-ultra/architecture/runtime-composition-and-lifecycle.md` | 268 | 13,609 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-RUNTIME` — Runtime composition and lifecycle (current) |
| 169 | `docs/omnia-ultra/architecture/self-update-and-continuation.md` | 41 | 1,162 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-UPDATE` — Self-build, self-update and durable continuation (normative-target) |
| 170 | `docs/omnia-ultra/architecture/state-revision-graph.md` | 191 | 10,337 | `md` | READ (100%) | `OMNIA-ULTRA-ARCH-STATE-REVISION-GRAPH` — Authorized state revision graph and causality contract (normative-target) |
| 171 | `docs/omnia-ultra/delivery/98-agent-reading-protocol.md` | 39 | 1,410 | `md` | READ (100%) | `OMNIA-ULTRA-DELIVERY-READING` — Protocol for AI and human maintainers (normative) |
| 172 | `docs/omnia-ultra/delivery/99-execution-prompt.md` | 25 | 1,070 | `md` | READ (100%) | `OMNIA-ULTRA-EXECUTION-PROMPT` — Execution prompt compatibility alias (operational-alias) |
| 173 | `docs/omnia-ultra/delivery/CONTINUOUS_PHASE_STATUS.md` | 400 | 25,155 | `md` | READ (100%) | `OMNIA-DELIVERY-CONTINUOUS-PHASE-STATUS` — Omnia continuous phase status (informational) |
| 174 | `docs/omnia-ultra/delivery/FAST_PREVIEW.md` | 55 | 1,813 | `md` | READ (100%) | `OMNIA-DELIVERY-FAST-PREVIEW` — Fast Omnia preview workflow (informational) |
| 175 | `docs/omnia-ultra/delivery/NATIVE_NEXT_PHASE.md` | 49 | 2,828 | `md` | READ (100%) | `OMNIA-DELIVERY-NATIVE-NEXT-PHASE` — Native runtime next phase (planned) |
| 176 | `docs/omnia-ultra/delivery/PHASE4_UI_REPORT.md` | 35 | 1,654 | `md` | READ (100%) | `OMNIA-DELIVERY-PHASE4-UI-REPORT` — Omnia UI-first Phase 4 report (current) |
| 177 | `docs/omnia-ultra/delivery/README.md` | 16 | 592 | `md` | READ (100%) | `OMNIA-ULTRA-DELIVERY-INDEX` — Delivery, roadmap and verification bundle (normative-target) |
| 178 | `docs/omnia-ultra/delivery/acceptance-gates.md` | 172 | 15,358 | `md` | READ (100%) | `OMNIA-ULTRA-DELIVERY-GATES` — Release and capability acceptance gates (normative-target) |
| 179 | `docs/omnia-ultra/delivery/capability-coverage.md` | 145 | 13,797 | `md` | READ (100%) | `OMNIA-ULTRA-DELIVERY-COVERAGE` — Capability coverage matrix (operational-ledger) |
| 180 | `docs/omnia-ultra/delivery/capability-ledger.json` | 847 | 66,733 | `json` | READ (100%) | JSON Schema: capability-ledger.json (0 props, 0 req) |
| 181 | `docs/omnia-ultra/delivery/research-derived-decisions.md` | 191 | 7,467 | `md` | READ (100%) | `OMNIA-ULTRA-DELIVERY-RESEARCH-DECISIONS` — Research-derived design decisions (research-derived) |
| 182 | `docs/omnia-ultra/delivery/roadmap.md` | 74 | 2,549 | `md` | READ (100%) | `OMNIA-ULTRA-DELIVERY-ROADMAP` — Dependency-ordered roadmap (normative-target) |
| 183 | `docs/omnia-ultra/delivery/source-ledger.json` | 3,086 | 119,276 | `json` | READ (100%) | JSON Schema: Omnia Ultra research and source ledger (0 props, 0 req) |
| 184 | `docs/omnia-ultra/delivery/source-ledger.md` | 207 | 12,856 | `md` | READ (100%) | `OMNIA-ULTRA-DELIVERY-SOURCES` — Research and source ledger (research-ledger) |
| 185 | `docs/omnia-ultra/delivery/test-matrix.md` | 149 | 5,307 | `md` | READ (100%) | `OMNIA-ULTRA-DELIVERY-TESTS` — Verification matrix (normative-target) |
| 186 | `docs/omnia-ultra/delivery/workstreams-and-dependencies.md` | 54 | 1,517 | `md` | READ (100%) | `OMNIA-ULTRA-DELIVERY-WORKSTREAMS` — Parallel workstreams and dependency rules (normative-target) |
| 187 | `docs/omnia-ultra/goal/00-copy-ready-prompt.md` | 266 | 17,101 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-COPY-PROMPT` — Copy-ready Omnia Ultra execution goal (operational-prompt) |
| 188 | `docs/omnia-ultra/goal/01-product-outcome-and-ui.md` | 40 | 2,019 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-PRODUCT-UI` — Product outcome and UI quality goal (normative-target) |
| 189 | `docs/omnia-ultra/goal/02-conversation-and-harness.md` | 48 | 2,525 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-CONVERSATION-HARNESS` — Conversation navigation and Ultra harness goal (normative-target) |
| 190 | `docs/omnia-ultra/goal/03-provider-observability.md` | 39 | 1,953 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-PROVIDER-OBSERVABILITY` — Provider, model and request observability goal (normative-target) |
| 191 | `docs/omnia-ultra/goal/04-context-project-twin-learning.md` | 44 | 2,169 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-CONTEXT-TWIN` — Context, Project Twin and learning goal (normative-target) |
| 192 | `docs/omnia-ultra/goal/05-files-workbenches-integrations.md` | 41 | 1,941 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-FILES-WORKBENCHES` — Files, artifacts, workbenches and integrations goal (normative-target) |
| 193 | `docs/omnia-ultra/goal/06-runtime-security-adaptive.md` | 44 | 2,137 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-RUNTIME-SECURITY` — Runtime, privacy and adaptive intelligence goal (normative-target) |
| 194 | `docs/omnia-ultra/goal/07-delivery-maintainability.md` | 35 | 1,644 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-DELIVERY-MAINTAINABILITY` — Delivery, maintainability and evidence goal (normative-target) |
| 195 | `docs/omnia-ultra/goal/08-interaction-operations-matrix.md` | 113 | 6,556 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-INTERACTION-OPERATIONS` — Atomic interaction operations matrix (normative-target) |
| 196 | `docs/omnia-ultra/goal/09-request-inspector-and-recovery.md` | 107 | 5,991 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-REQUEST-INSPECTOR-RECOVERY` — Request inspector and recovery contract (normative-target) |
| 197 | `docs/omnia-ultra/goal/10-adaptive-intelligence-and-evaluation.md` | 91 | 4,888 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-ADAPTIVE-INTELLIGENCE` — Adaptive intelligence and evaluation governance (normative-target) |
| 198 | `docs/omnia-ultra/goal/11-project-twin-and-goal-lifecycle.md` | 88 | 4,579 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-PROJECT-TWIN-LIFECYCLE` — Project Twin and goal lifecycle contract (normative-target) |
| 199 | `docs/omnia-ultra/goal/12-composer-voice-file-and-rendering.md` | 82 | 4,252 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-COMPOSER-VOICE-FILE-RENDERING` — Composer, voice, file bridge and live rendering contract (normative-target) |
| 200 | `docs/omnia-ultra/goal/13-cache-context-routing-compaction.md` | 54 | 2,810 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-CACHE-CONTEXT-ROUTING` — Cache, model routing, context delivery and compaction goal (normative-target) |
| 201 | `docs/omnia-ultra/goal/14-telemetry-data-and-safe-learning.md` | 48 | 2,588 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-TELEMETRY-DATA-SAFE-LEARNING` — Comprehensive telemetry, analytics and safe learning data goal (normative-target) |
| 202 | `docs/omnia-ultra/goal/15-local-model-parity-and-readiness.md` | 46 | 2,230 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-LOCAL-MODEL-PARITY` — Local model readiness and product parity goal (normative-target) |
| 203 | `docs/omnia-ultra/goal/16-run-control-edit-retry-state.md` | 92 | 5,323 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-RUN-CONTROL-RETRY-STATE` — Pause, continue, edit, retry and state-aware history goal (normative-target) |
| 204 | `docs/omnia-ultra/goal/17-run-control-atomic-matrix.md` | 46 | 2,465 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-RUN-CONTROL-ATOMIC-MATRIX` — Atomic run-control, state graph and retry goal matrix (normative-target) |
| 205 | `docs/omnia-ultra/goal/18-structured-io-and-log-rendering.md` | 29 | 1,344 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-STRUCTURED-IO-LOG-RENDERING` — Structured syntax-highlighted input, output and logs goal (normative-target) |
| 206 | `docs/omnia-ultra/goal/19-generative-media-endpoints-and-editing.md` | 31 | 1,430 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-GENERATIVE-MEDIA-ENDPOINTS` — Provider-neutral image and video generation and editing goal (normative-target) |
| 207 | `docs/omnia-ultra/goal/20-universal-endpoints-and-local-model-catalog.md` | 39 | 1,974 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-UNIVERSAL-ENDPOINTS-LOCAL-MODELS` — Universal provider endpoints and hardware-aware local model catalog goal (normative-target) |
| 208 | `docs/omnia-ultra/goal/21-multimodal-bridge-and-specialist-personas.md` | 62 | 3,394 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-MULTIMODAL-BRIDGE-PERSONAS` — Universal multimodal bridge and specialist agent catalog goal (normative-target) |
| 209 | `docs/omnia-ultra/goal/README.md` | 52 | 4,432 | `md` | READ (100%) | `OMNIA-ULTRA-GOAL-README` — Omnia Ultra goal bundle (normative-navigation) |
| 210 | `docs/omnia-ultra/goal/requirements.json` | 784 | 46,535 | `json` | READ (100%) | JSON Schema: requirements.json (0 props, 0 req) |
| 211 | `docs/omnia-ultra/harness/README.md` | 22 | 573 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-INDEX` — Harness, agents and learning bundle (normative-target) |
| 212 | `docs/omnia-ultra/harness/academic-specialist-taxonomy.md` | 272 | 24,098 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-ACADEMIC-SPECIALIST-TAXONOMY` — Academic, scientific and technical specialist taxonomy (normative-target) |
| 213 | `docs/omnia-ultra/harness/agent-lifecycle-and-lineage.md` | 65 | 1,635 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-LIFECYCLE` — Agent lifecycle, lineage and communication (normative-target) |
| 214 | `docs/omnia-ultra/harness/agents-subagents-personas.md` | 60 | 2,075 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-AGENTS` — Agent, subagent, team and persona taxonomy (normative-target) |
| 215 | `docs/omnia-ultra/harness/catalog/README.md` | 124 | 6,322 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-CATALOG-README` — Specialist catalog maintenance and lifecycle policy (operational) |
| 216 | `docs/omnia-ultra/harness/catalog/agent-catalog.json` | 39 | 7,890 | `json` | READ (100%) | 1 — JSON data (schemaVersion, catalogId, revisionId, lifecycle, sourceManifestRevisionId, profileRefs...) |
| 217 | `docs/omnia-ultra/harness/catalog/persona-packs.json` | 138 | 14,435 | `json` | READ (100%) | 1 — JSON data (schemaVersion, catalogKind, personas) |
| 218 | `docs/omnia-ultra/harness/catalog/role-profiles.json` | 366 | 49,933 | `json` | READ (100%) | 1 — JSON data (schemaVersion, catalogKind, profiles) |
| 219 | `docs/omnia-ultra/harness/evaluations-learning-routing.md` | 70 | 1,728 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-EVAL` — Evaluation, adaptive learning and routing (normative-target) |
| 220 | `docs/omnia-ultra/harness/memory-skills-tools-mcp.md` | 55 | 1,576 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-CUSTOMIZATION` — Memory, skills, tools, MCP and plugins (normative-target) |
| 221 | `docs/omnia-ultra/harness/model-routing-context-policy.md` | 109 | 5,482 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-MODEL-ROUTING-CONTEXT` — Main and subagent model routing, context delivery and compaction (normative-target) |
| 222 | `docs/omnia-ultra/harness/specialist-agent-persona-catalog.md` | 122 | 6,188 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-SPECIALIST-PERSONA-CATALOG` — Built-in specialist agent and persona catalog (normative-target) |
| 223 | `docs/omnia-ultra/harness/suggestions-next-action.md` | 57 | 1,477 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-SUGGESTIONS` — Suggestion and next-action engine (normative-target) |
| 224 | `docs/omnia-ultra/harness/ultra-workflow.md` | 63 | 1,545 | `md` | READ (100%) | `OMNIA-ULTRA-HARNESS-ULTRA` — Ultra workflow and effort contract (normative-target) |
| 225 | `docs/omnia-ultra/interaction/README.md` | 34 | 973 | `md` | READ (100%) | `OMNIA-ULTRA-INTERACTION-INDEX` — Interaction bundle (normative-target) |
| 226 | `docs/omnia-ultra/interaction/active-run-variants-compare.md` | 73 | 3,354 | `md` | READ (100%) | `OMNIA-ULTRA-INT-ACTIVE-RUN-VARIANTS-COMPARE` — Active-run copy, branch, fork, compare and promotion contract (normative-target) |
| 227 | `docs/omnia-ultra/interaction/background-work-inspector.md` | 36 | 1,046 | `md` | READ (100%) | `OMNIA-ULTRA-INT-BACKGROUND` — Background work, subagent and request inspector (normative-target) |
| 228 | `docs/omnia-ultra/interaction/branching-copy-fork.md` | 86 | 2,559 | `md` | READ (100%) | `OMNIA-ULTRA-INT-BRANCH` — Branch, copy, fork, clone, replay and merge semantics (normative-target) |
| 229 | `docs/omnia-ultra/interaction/composer-large-paste-live-render.md` | 49 | 1,503 | `md` | READ (100%) | `OMNIA-ULTRA-INT-COMPOSER` — Large paste, file conversion and live Markdown/LaTeX input (normative-target) |
| 230 | `docs/omnia-ultra/interaction/continue-without-prompt.md` | 92 | 4,644 | `md` | READ (100%) | `OMNIA-ULTRA-INT-CONTINUE-WITHOUT-PROMPT` — Typed no-text continuation planner and loop guards (normative-target) |
| 231 | `docs/omnia-ultra/interaction/conversation-workspace-library.md` | 137 | 6,095 | `md` | READ (100%) | `OMNIA-ULTRA-INT-CONVERSATION-LIBRARY` — Conversation, project and workspace library lifecycle (normative-target) |
| 232 | `docs/omnia-ultra/interaction/project-chat-foundation.md` | 370 | 14,610 | `md` | READ (100%) | `OMNIA-ULTRA-INT-PROJECT-CHAT-FOUNDATION` — Project and Chat interaction foundation (normative-target) |
| 233 | `docs/omnia-ultra/interaction/prompt-edit-state-aware-retry.md` | 68 | 3,146 | `md` | READ (100%) | `OMNIA-ULTRA-INT-PROMPT-EDIT-STATE-RETRY` — Immutable prompt revisions and state-aware retry contract (normative-target) |
| 234 | `docs/omnia-ultra/interaction/prompt-intelligence.md` | 37 | 1,407 | `md` | READ (100%) | `OMNIA-ULTRA-INT-PROMPT` — Prompt autocomplete, Enhance, Workshop and next actions (normative-target) |
| 235 | `docs/omnia-ultra/interaction/prompt-navigation-and-jump.md` | 69 | 2,128 | `md` | READ (100%) | `OMNIA-ULTRA-INT-JUMP` — Jump prompt and prompt navigation (normative-target) |
| 236 | `docs/omnia-ultra/interaction/queue-steer-schedule.md` | 62 | 2,066 | `md` | READ (100%) | `OMNIA-ULTRA-INT-QUEUE` — Queue, steer, interrupt, side question and scheduling (normative-target) |
| 237 | `docs/omnia-ultra/interaction/run-checkpoint-resume.md` | 74 | 3,203 | `md` | READ (100%) | `OMNIA-ULTRA-INT-RUN-CHECKPOINT-RESUME` — Truthful pause, checkpoint and resume contract (normative-target) |
| 238 | `docs/omnia-ultra/interaction/run-control-edit-retry.md` | 325 | 19,249 | `md` | READ (100%) | `OMNIA-ULTRA-INTERACTION-RUN-CONTROL-RETRY` — Pause, continue, edit, retry and state-aware run control (normative-target) |
| 239 | `docs/omnia-ultra/interaction/selection-reference-annotations.md` | 51 | 1,614 | `md` | READ (100%) | `OMNIA-ULTRA-INT-REFERENCE` — Selection hover, reply and annotation (normative-target) |
| 240 | `docs/omnia-ultra/interaction/structured-io-log-rendering.md` | 71 | 3,545 | `md` | READ (100%) | `OMNIA-ULTRA-INT-STRUCTURED-IO-LOG-RENDERING` — Structured input, output, tool and command-log rendering (normative-target) |
| 241 | `docs/omnia-ultra/interaction/ui-shell-accessibility.md` | 38 | 1,283 | `md` | READ (100%) | `OMNIA-ULTRA-INT-UI` — UI shell, overlay, focus and accessibility (normative-target) |
| 242 | `docs/omnia-ultra/interaction/voice-input-and-conversation.md` | 35 | 1,261 | `md` | READ (100%) | `OMNIA-ULTRA-INT-VOICE` — Voice input and speech conversation (normative-target) |
| 243 | `docs/omnia-ultra/manifest.json` | 407 | 17,828 | `json` | READ (100%) | 1 — JSON data (schemaVersion, packId, version, lastReviewed, entry, executionPrompt...) |
| 244 | `docs/omnia-ultra/observability/README.md` | 23 | 618 | `md` | READ (100%) | `OMNIA-ULTRA-OBS-INDEX` — Observability and request telemetry bundle (normative-target) |
| 245 | `docs/omnia-ultra/observability/cost-usage-analytics.md` | 46 | 1,151 | `md` | READ (100%) | `OMNIA-ULTRA-OBS-COST` — Usage, cost, quota and quality analytics (normative-target) |
| 246 | `docs/omnia-ultra/observability/logs-traces-debug.md` | 62 | 1,525 | `md` | READ (100%) | `OMNIA-ULTRA-OBS-DEBUG` — Request logs, traces and debug replay (normative-target) |
| 247 | `docs/omnia-ultra/observability/model-picker-health-profiles.md` | 72 | 1,958 | `md` | READ (100%) | `OMNIA-ULTRA-OBS-MODEL` — Live model picker, health and effort profiles (normative-target) |
| 248 | `docs/omnia-ultra/observability/provider-attempt-lineage.md` | 167 | 8,796 | `md` | READ (100%) | `OMNIA-ULTRA-OBS-PROVIDER-ATTEMPT-LINEAGE` — Immutable provider attempt lineage contract (normative-target) |
| 249 | `docs/omnia-ultra/observability/request-lifecycle.md` | 74 | 1,764 | `md` | READ (100%) | `OMNIA-ULTRA-OBS-LIFECYCLE` — Request lifecycle and timeline (normative-target) |
| 250 | `docs/omnia-ultra/observability/request-usage-telemetry.md` | 117 | 3,184 | `md` | READ (100%) | `OMNIA-ULTRA-OBS-USAGE` — Token, throughput, quota and request usage (normative-target) |
| 251 | `docs/omnia-ultra/observability/retry-fallback-repair.md` | 69 | 2,661 | `md` | READ (100%) | `OMNIA-ULTRA-OBS-RETRY` — Retry, fallback, repair and outcome-unknown policy (normative-target) |
| 252 | `docs/omnia-ultra/observability/telemetry-timeseries-analytics.md` | 107 | 5,383 | `md` | READ (100%) | `OMNIA-ULTRA-OBS-TELEMETRY-TIMESERIES` — Telemetry time-series analytics and anchor queries (normative-target) |
| 253 | `docs/omnia-ultra/observability/universal-provider-protocol-adapters.md` | 104 | 5,312 | `md` | READ (100%) | `OMNIA-ULTRA-OBS-UNIVERSAL-PROVIDER-PROTOCOLS` — Universal provider endpoint and protocol adapter contract (normative-target) |
| 254 | `docs/omnia-ultra/project-twin/README.md` | 18 | 463 | `md` | READ (100%) | `OMNIA-ULTRA-TWIN-INDEX` — Living Project Twin bundle (normative-target) |
| 255 | `docs/omnia-ultra/project-twin/graph-and-atlas.md` | 34 | 1,093 | `md` | READ (100%) | `OMNIA-ULTRA-TWIN-GRAPH` — Graph model and interactive atlas (normative-target) |
| 256 | `docs/omnia-ultra/project-twin/project-chat-twin-contract.md` | 220 | 9,091 | `md` | READ (100%) | `OMNIA-ULTRA-PROJECT-CHAT-TWIN` — Project and Chat information architecture contract (normative-target) |
| 257 | `docs/omnia-ultra/project-twin/project-overview-smart-refresh.md` | 90 | 3,837 | `md` | READ (100%) | `OMNIA-ULTRA-TWIN-OVERVIEW` — Project Overview and smart title refresh (normative-target) |
| 258 | `docs/omnia-ultra/project-twin/roadmaps-blueprints-plans.md` | 42 | 1,374 | `md` | READ (100%) | `OMNIA-ULTRA-TWIN-PLANNING` — Universal roadmaps, blueprints and plans (normative-target) |
| 259 | `docs/omnia-ultra/project-twin/update-provenance-staleness.md` | 34 | 847 | `md` | READ (100%) | `OMNIA-ULTRA-TWIN-UPDATE` — Incremental update, provenance and staleness (normative-target) |
| 260 | `docs/omnia-ultra/runtimes/README.md` | 18 | 405 | `md` | READ (100%) | `OMNIA-ULTRA-RUNTIME-INDEX` — Machine, browser and control runtime bundle (normative-target) |
| 261 | `docs/omnia-ultra/runtimes/browser-network-capture.md` | 35 | 1,162 | `md` | READ (100%) | `OMNIA-ULTRA-RUNTIME-BROWSER` — Browser workspace, privacy and authorized capture (normative-target) |
| 262 | `docs/omnia-ultra/runtimes/local-multimodal-toolchain.md` | 235 | 13,556 | `md` | READ (100%) | `OMNIA-ULTRA-RUNTIME-LOCAL-MULTIMODAL-TOOLCHAIN` — Local multimodal transform, bridge-runtime and fidelity toolchain (normative-target) |
| 263 | `docs/omnia-ultra/runtimes/machines-headless-remote.md` | 39 | 1,147 | `md` | READ (100%) | `OMNIA-ULTRA-RUNTIME-MACHINES` — Machine modes, headless execution and remote clients (normative-target) |
| 264 | `docs/omnia-ultra/runtimes/privileged-broker-security.md` | 28 | 851 | `md` | READ (100%) | `OMNIA-ULTRA-RUNTIME-PRIVILEGED` — Typed Windows privileged-operation broker (normative-target) |
| 265 | `docs/omnia-ultra/runtimes/targeted-capture-and-presence.md` | 107 | 4,886 | `md` | READ (100%) | `OMNIA-ULTRA-RUNTIME-TARGETED-CAPTURE` — Targeted screen, window, tab and audio capture (normative-target) |
| 266 | `docs/omnia-ultra/runtimes/virtual-pointer-window-control.md` | 49 | 1,754 | `md` | READ (100%) | `OMNIA-ULTRA-RUNTIME-POINTER` — Virtual pointer and target-window automation (normative-target) |
| 267 | `docs/omnia-ultra/schemas/academic-specialist-workflow.schema.json` | 169 | 6,022 | `json` | READ (100%) | JSON Schema: Omnia academic and technical specialist workflow plan (15 props, 10 req) |
| 268 | `docs/omnia-ultra/schemas/adaptive-policy-release.schema.json` | 173 | 9,060 | `json` | READ (100%) | JSON Schema: Omnia adaptive policy release record (14 props, 13 req) |
| 269 | `docs/omnia-ultra/schemas/agent-catalog.schema.json` | 95 | 5,011 | `json` | READ (100%) | JSON Schema: Omnia versioned agent and persona catalog (13 props, 12 req) |
| 270 | `docs/omnia-ultra/schemas/agent-profile-resolution-receipt.schema.json` | 131 | 6,468 | `json` | READ (100%) | JSON Schema: Omnia immutable agent profile-resolution receipt (16 props, 14 req) |
| 271 | `docs/omnia-ultra/schemas/agent-role-profile-v2.schema.json` | 181 | 10,324 | `json` | READ (100%) | JSON Schema: Omnia operational agent role profile (v2) (36 props, 29 req) |
| 272 | `docs/omnia-ultra/schemas/agent-role-profile.schema.json` | 26 | 1,717 | `json` | READ (100%) | JSON Schema: Omnia specialist agent role profile (16 props, 10 req) |
| 273 | `docs/omnia-ultra/schemas/authority-continuity.schema.json` | 166 | 5,152 | `json` | READ (100%) | JSON Schema: Omnia authority continuity and side-effect reconciliation record (11 props, 9 req) |
| 274 | `docs/omnia-ultra/schemas/cache-policy.schema.json` | 68 | 3,150 | `json` | READ (100%) | JSON Schema: Omnia cache policy (9 props, 7 req) |
| 275 | `docs/omnia-ultra/schemas/capability-ledger.schema.json` | 72 | 2,525 | `json` | READ (100%) | JSON Schema: Omnia Ultra capability coverage ledger (4 props, 3 req) |
| 276 | `docs/omnia-ultra/schemas/capture-session.schema.json` | 87 | 3,435 | `json` | READ (100%) | JSON Schema: Omnia targeted capture session (17 props, 8 req) |
| 277 | `docs/omnia-ultra/schemas/comparison-session.schema.json` | 17 | 1,111 | `json` | READ (100%) | JSON Schema: Omnia pinned comparison session (7 props, 6 req) |
| 278 | `docs/omnia-ultra/schemas/context-delivery-policy.schema.json` | 63 | 3,228 | `json` | READ (100%) | JSON Schema: Omnia context delivery and compaction policy (10 props, 7 req) |
| 279 | `docs/omnia-ultra/schemas/continuation-intent.schema.json` | 42 | 3,071 | `json` | READ (100%) | JSON Schema: Omnia no-text continuation intent (14 props, 9 req) |
| 280 | `docs/omnia-ultra/schemas/conversation-library.schema.json` | 140 | 4,989 | `json` | READ (100%) | JSON Schema: Omnia Project library snapshot (17 props, 7 req) |
| 281 | `docs/omnia-ultra/schemas/conversation-navigation.schema.json` | 125 | 4,902 | `json` | READ (100%) | JSON Schema: Omnia conversation navigation contract (14 props, 5 req) |
| 282 | `docs/omnia-ultra/schemas/goal-requirements.schema.json` | 97 | 3,265 | `json` | READ (100%) | JSON Schema: Omnia Ultra atomic goal requirement registry (4 props, 3 req) |
| 283 | `docs/omnia-ultra/schemas/grounded-surrogate-observation.schema.json` | 127 | 4,579 | `json` | READ (100%) | JSON Schema: Omnia grounded multimodal surrogate observation (11 props, 10 req) |
| 284 | `docs/omnia-ultra/schemas/local-model-catalog-query.schema.json` | 21 | 2,263 | `json` | READ (100%) | JSON Schema: Omnia local model catalog search and recommendation query (11 props, 7 req) |
| 285 | `docs/omnia-ultra/schemas/local-model.schema.json` | 100 | 3,556 | `json` | READ (100%) | JSON Schema: Omnia local model registry record (18 props, 9 req) |
| 286 | `docs/omnia-ultra/schemas/local-multimodal-transform-receipt.schema.json` | 179 | 6,574 | `json` | READ (100%) | JSON Schema: Omnia local multimodal transform receipt (19 props, 10 req) |
| 287 | `docs/omnia-ultra/schemas/media-generation-job.schema.json` | 32 | 3,057 | `json` | READ (100%) | JSON Schema: Omnia image and video generation job (22 props, 11 req) |
| 288 | `docs/omnia-ultra/schemas/message-revision.schema.json` | 21 | 1,170 | `json` | READ (100%) | JSON Schema: Omnia immutable message and prompt revision (11 props, 8 req) |
| 289 | `docs/omnia-ultra/schemas/modality-bridge-contract-v2.schema.json` | 415 | 12,841 | `json` | READ (100%) | JSON Schema: Omnia multimodal bridge contract v2 envelope (19 props, 16 req) |
| 290 | `docs/omnia-ultra/schemas/modality-bridge-execution-receipt.schema.json` | 213 | 8,193 | `json` | READ (100%) | JSON Schema: Omnia multimodal bridge stage execution receipt (20 props, 16 req) |
| 291 | `docs/omnia-ultra/schemas/modality-bridge-plan.schema.json` | 484 | 18,027 | `json` | READ (100%) | JSON Schema: Omnia multimodal capability bridge plan (20 props, 15 req) |
| 292 | `docs/omnia-ultra/schemas/model-profile.schema.json` | 76 | 3,124 | `json` | READ (100%) | JSON Schema: Omnia model profile (11 props, 7 req) |
| 293 | `docs/omnia-ultra/schemas/model-routing-policy.schema.json` | 81 | 3,619 | `json` | READ (100%) | JSON Schema: Omnia main and subagent model routing policy (9 props, 8 req) |
| 294 | `docs/omnia-ultra/schemas/native-state-revision-graph-read-v1.schema.json` | 235 | 8,015 | `json` | READ (100%) | JSON Schema: Omnia native state-revision graph read v1 (17 props, 17 req) |
| 295 | `docs/omnia-ultra/schemas/persona-pack.schema.json` | 142 | 6,987 | `json` | READ (100%) | JSON Schema: Omnia presentation persona pack (20 props, 17 req) |
| 296 | `docs/omnia-ultra/schemas/profile-chat-library.schema.json` | 39 | 1,648 | `json` | READ (100%) | JSON Schema: Omnia standalone Chat library snapshot (15 props, 7 req) |
| 297 | `docs/omnia-ultra/schemas/project-overview.schema.json` | 91 | 3,022 | `json` | READ (100%) | JSON Schema: Omnia Project Overview revision (26 props, 8 req) |
| 298 | `docs/omnia-ultra/schemas/project-twin.schema.json` | 60 | 2,674 | `json` | READ (100%) | JSON Schema: Omnia Living Project Twin manifest (11 props, 7 req) |
| 299 | `docs/omnia-ultra/schemas/provider-attempt-lineage-receipt.schema.json` | 133 | 4,537 | `json` | READ (100%) | JSON Schema: Omnia renderer-safe provider attempt lineage receipt (16 props, 16 req) |
| 300 | `docs/omnia-ultra/schemas/provider-attempt-lineage.schema.json` | 336 | 11,423 | `json` | READ (100%) | JSON Schema: Omnia immutable provider attempt lineage fact (35 props, 35 req) |
| 301 | `docs/omnia-ultra/schemas/provider-endpoint-capability.schema.json` | 76 | 6,098 | `json` | READ (100%) | JSON Schema: Omnia provider endpoint capability snapshot (17 props, 11 req) |
| 302 | `docs/omnia-ultra/schemas/request-telemetry.schema.json` | 156 | 6,896 | `json` | READ (100%) | JSON Schema: Omnia request telemetry observation (18 props, 8 req) |
| 303 | `docs/omnia-ultra/schemas/retry-policy.schema.json` | 43 | 1,886 | `json` | READ (100%) | JSON Schema: Omnia retry policy (13 props, 5 req) |
| 304 | `docs/omnia-ultra/schemas/routing-decision-receipt.schema.json` | 197 | 10,678 | `json` | READ (100%) | JSON Schema: Omnia immutable routing decision receipt (17 props, 15 req) |
| 305 | `docs/omnia-ultra/schemas/run-checkpoint.schema.json` | 28 | 1,761 | `json` | READ (100%) | JSON Schema: Omnia durable run checkpoint (18 props, 9 req) |
| 306 | `docs/omnia-ultra/schemas/run-control-operation.schema.json` | 157 | 7,314 | `json` | READ (100%) | JSON Schema: Omnia resolved pause, continue, edit and retry operation (25 props, 11 req) |
| 307 | `docs/omnia-ultra/schemas/source-ledger.schema.json` | 191 | 7,247 | `json` | READ (100%) | JSON Schema: Omnia Ultra source and provenance ledger (11 props, 11 req) |
| 308 | `docs/omnia-ultra/schemas/state-revision-graph.schema.json` | 379 | 17,286 | `json` | READ (100%) | JSON Schema: Omnia immutable execution state revision graph (9 props, 9 req) |
| 309 | `docs/omnia-ultra/schemas/state-revision-receipt.schema.json` | 110 | 4,497 | `json` | READ (100%) | JSON Schema: Omnia immutable state-revision idempotency receipt (11 props, 0 req) |
| 310 | `docs/omnia-ultra/schemas/structured-block.schema.json` | 26 | 1,767 | `json` | READ (100%) | JSON Schema: Omnia structured input, output and log block (16 props, 7 req) |
| 311 | `docs/omnia-ultra/schemas/telemetry-analytics-query.schema.json` | 60 | 2,696 | `json` | READ (100%) | JSON Schema: Omnia telemetry analytics query (9 props, 6 req) |
| 312 | `docs/omnia-ultra/security/README.md` | 17 | 353 | `md` | READ (100%) | `OMNIA-ULTRA-SECURITY-INDEX` — Security bundle (normative) |
| 313 | `docs/omnia-ultra/security/approvals-sandbox-secrets.md` | 37 | 1,179 | `md` | READ (100%) | `OMNIA-ULTRA-SECURITY-CAPABILITIES` — Approvals, sandbox and secret handling (normative) |
| 314 | `docs/omnia-ultra/security/authority-continuity-and-replay.md` | 162 | 8,178 | `md` | READ (100%) | `OMNIA-ULTRA-SECURITY-AUTHORITY-CONTINUITY` — Authority continuity, replay and side-effect reconciliation (normative-target) |
| 315 | `docs/omnia-ultra/security/hard-boundaries.md` | 34 | 1,304 | `md` | READ (100%) | `OMNIA-ULTRA-SECURITY-BOUNDARIES` — Non-negotiable safety and legality boundaries (normative) |
| 316 | `docs/omnia-ultra/tools/README.md` | 55 | 2,437 | `md` | READ (100%) | `OMNIA-ULTRA-TOOLS-INDEX` — Specification validation tools (operational) |
| 317 | `docs/omnia-ultra/tools/generate-source-ledger.mjs` | 328 | 11,769 | `mjs` | READ (100%) | Executable mjs tool/script (8 funcs: slug, hashFile, localSource, urlSource, repositorySource) |
| 318 | `docs/omnia-ultra/tools/validate-agent-catalog.mjs` | 471 | 25,767 | `mjs` | READ (100%) | Executable mjs tool/script (24 funcs: filesForRoot, parseArgs, readJson, canonical, sha256) |
| 319 | `docs/omnia-ultra/tools/validate-conversation-navigation.mjs` | 510 | 24,778 | `mjs` | READ (100%) | Executable mjs tool/script (19 funcs: parseArgs, isObject, add, unknownFields, validTimestamp) |
| 320 | `docs/omnia-ultra/tools/validate-source-ledger.mjs` | 316 | 17,808 | `mjs` | READ (100%) | Executable mjs tool/script (18 funcs: parseArgs, isObject, add, readJson, checkUnknownFields) |
| 321 | `docs/omnia-ultra/tools/validate-spec.ps1` | 563 | 27,435 | `ps1` | READ (100%) | Executable ps1 tool/script (5 funcs: Get-RelativeSpecPath, Test-ResolvablePath, Get-FrontmatterValue, Test-JsonField, Test-DependencyCycles) |
| 322 | `docs/omnia-ultra/workbenches/README.md` | 17 | 339 | `md` | READ (100%) | `OMNIA-ULTRA-WORKBENCH-INDEX` — Specialized workbenches (normative-target) |
| 323 | `docs/omnia-ultra/workbenches/file-artifact-studio.md` | 31 | 1,276 | `md` | READ (100%) | `OMNIA-ULTRA-WORKBENCH-FILES` — Universal file, document and media studio (normative-target) |
| 324 | `docs/omnia-ultra/workbenches/generative-media-endpoints.md` | 83 | 4,296 | `md` | READ (100%) | `OMNIA-ULTRA-WORKBENCH-GENERATIVE-MEDIA-ENDPOINTS` — Image/video generation endpoints and provenance-aware media/document editing (normative-target) |
| 325 | `docs/omnia-ultra/workbenches/ide-git-docker-devops.md` | 32 | 1,131 | `md` | READ (100%) | `OMNIA-ULTRA-WORKBENCH-ENGINEERING` — IDE, Git, GitHub, Docker and delivery (normative-target) |
| 326 | `docs/omnia-ultra/workbenches/integrations-automation.md` | 35 | 1,119 | `md` | READ (100%) | `OMNIA-ULTRA-WORKBENCH-INTEGRATIONS` — Integrations, unified inbox and automation (normative-target) |
| 327 | `docs/omnia-ultra/workbenches/local-model-catalog-and-tuning.md` | 84 | 4,473 | `md` | READ (100%) | `OMNIA-ULTRA-WORKBENCH-LOCAL-MODEL-CATALOG-TUNING` — Hardware-aware local model catalog, download and advanced tuning (normative-target) |
| 328 | `docs/omnia-ultra/workbenches/local-model-lab.md` | 106 | 4,638 | `md` | READ (100%) | `OMNIA-ULTRA-WORKBENCH-LOCAL-MODELS` — Local model registry, runtime and evaluation lab (normative-target) |
| 329 | `docs/omnia-ultra/workbenches/research-learning-science.md` | 30 | 1,428 | `md` | READ (100%) | `OMNIA-ULTRA-WORKBENCH-RESEARCH` — Research, learning, science and competitive programming (normative-target) |
| 330 | `docs/project-twin/README.md` | 61 | 2,901 | `md` | READ (100%) | `OMNIA-TWIN-CURRENT-README` — Current-tree Project Twin (generated-evidence-projection) |
| 331 | `docs/project-twin/atlas.css` | 49 | 2,958 | `css` | READ (100%) | Stylesheet (7 CSS custom properties) |
| 332 | `docs/project-twin/atlas.html` | 32 | 47,672 | `html` | READ (100%) | HTML page: Omnia Project Twin Atlas |
| 333 | `docs/project-twin/atlas.js` | 66 | 4,351 | `js` | READ (100%) | Executable js tool/script (4 funcs: filteredNodes, renderDetail, renderEdges, render) |
| 334 | `docs/project-twin/catalog.json` | 436 | 31,155 | `json` | READ (100%) | JSON Schema: Omnia current-tree Project Twin catalog (0 props, 0 req) |
| 335 | `docs/project-twin/catalog.schema.json` | 113 | 3,827 | `json` | READ (100%) | JSON Schema: Omnia human-owned Project Twin catalog (7 props, 7 req) |
| 336 | `docs/project-twin/graph.json` | 1,851 | 63,350 | `json` | READ (100%) | 1 — JSON data (schemaVersion, projectId, revisionId, sourceSnapshot, nodes, edges...) |
| 337 | `docs/project-twin/graph.schema.json` | 116 | 4,970 | `json` | READ (100%) | JSON Schema: Omnia Project Twin graph (7 props, 7 req) |
| 338 | `docs/project-twin/manifest.json` | 431 | 15,219 | `json` | READ (100%) | 1 — JSON data (schemaVersion, projectId, revisionId, sourceSnapshot, documents, graphs...) |
| 339 | `docs/qa/DEFINITION_OF_DONE.md` | 121 | 5,702 | `md` | READ (100%) | `OMNIA-DOCS-DEFINITION-OF-DONE` — Definition of done for Omnia feature slices (normative-guidance) |
| 340 | `docs/qa/HEADLESS_PERFORMANCE_RUNNER.md` | 67 | 3,092 | `md` | READ (100%) | Headless renderer performance runner |
| 341 | `docs/qa/OMNIA_COMPLETION_LEDGER.json` | 646 | 24,578 | `json` | READ (100%) | 1 — JSON data (schemaVersion, generatedAt, repository, sourceRevision, goal, status...) |
| 342 | `docs/qa/OMNIA_COMPLETION_LEDGER.md` | 121 | 9,361 | `md` | READ (100%) | Omnia completion ledger — 2026-11-08 |
| 343 | `docs/releases/omnia-0.1.0-phase1-preview-source.sha256` | 163 | 16,336 | `sha256` | READ (100%) | Phase 1 preview source SHA-256 manifest (163 hashed entries) |
| 344 | `docs/research/CLAUDE_CODE_HARNESS_REFRESH_2026-10-01.md` | 248 | 14,303 | `md` | READ (100%) | Claude Code harness refresh (2026-10-01) |
| 345 | `docs/research/CLAUDE_CODE_HARNESS_RESEARCH.md` | 1,626 | 69,737 | `md` | READ (100%) | Claude Code Harness Research for Omnia |
| 346 | `docs/research/CONTINUE_AIDER_OPENCODE_HARNESS_RESEARCH.md` | 1,061 | 49,495 | `md` | READ (100%) | Continue, Aider, and OpenCode harness research for Omnia |
| 347 | `docs/research/HARNESS_EVIDENCE_REFRESH_2026-09-21.md` | 72 | 3,637 | `md` | READ (100%) | `OMNIA-RESEARCH-HARNESS-EVIDENCE-REFRESH-2026-09-21` — Harness evidence refresh for Omnia (local-snapshot-refresh) |
| 348 | `docs/research/HARNESS_EVIDENCE_REFRESH_2026-09-24.md` | 120 | 6,390 | `md` | READ (100%) | `OMNIA-RESEARCH-HARNESS-EVIDENCE-REFRESH-2026-09-24` — Harness evidence refresh for Omnia (local-snapshot-refresh) |
| 349 | `docs/research/LEARNING_HARNESS_EVALUATION_PLAN.md` | 740 | 32,982 | `md` | READ (100%) | Omnia learning and research harness evaluation plan |
| 350 | `docs/research/OFFICIAL_HARNESS_REFRESH_2026-08-14.md` | 400 | 20,674 | `md` | READ (100%) | `OMNIA-RESEARCH-OFFICIAL-HARNESS-REFRESH-2026-08-14` — Official harness refresh for Omnia (research-addendum) |
| 351 | `docs/research/OFFICIAL_MULTIMODAL_PROVIDER_OPERATION_MATRIX_2026-08-14.md` | 228 | 20,370 | `md` | READ (100%) | Official multimodal provider-operation matrix — 2026-08-14 |
| 352 | `docs/research/OFFICIAL_UI_REFERENCE_REFRESH.md` | 975 | 35,306 | `md` | READ (100%) | Official UI Reference Refresh for Omnia |
| 353 | `docs/research/OMNIA_HARNESS_BENCHMARKS.md` | 456 | 44,006 | `md` | READ (100%) | Omnia harness benchmark and adoption matrix |
| 354 | `docs/research/OPENAI_CODEX_HARNESS_RESEARCH.md` | 744 | 36,968 | `md` | READ (100%) | OpenAI Codex Harness Research for Omnia |
| 355 | `docs/research/OPENHANDS_OFFICIAL_HARNESS_RESEARCH.md` | 1,338 | 63,952 | `md` | READ (100%) | OpenHands official harness research for Omnia |
| 356 | `docs/research/PROVIDER_CACHE_CONTEXT_OPTIMIZATION_RESEARCH.md` | 141 | 5,329 | `md` | READ (100%) | `OMNIA-RESEARCH-PROVIDER-CACHE-CONTEXT-2026-08-14` — Provider cache and context optimization research (research-current) |
| 357 | `docs/research/PROVIDER_TELEMETRY_REQUEST_PROVENANCE_RESEARCH.md` | 1,019 | 39,787 | `md` | READ (100%) | Provider Telemetry, Request Provenance, and Model-Run Observability |
| 358 | `docs/research/UNIVERSAL_PROVIDER_LOCAL_MODEL_RESEARCH_2026-08-14.md` | 37 | 1,647 | `md` | READ (100%) | Universal provider and local-model research — 2026-08-14 |
| 359 | `docs/research/windows-runtime/01-virtual-pointer-contract.md` | 150 | 6,572 | `md` | READ (100%) | Virtual pointer contract |
| 360 | `docs/research/windows-runtime/02-transport-selection.md` | 93 | 5,362 | `md` | READ (100%) | Transport selection and capability tiers |
| 361 | `docs/research/windows-runtime/03-capture-and-offscreen.md` | 103 | 5,405 | `md` | READ (100%) | Capture, minimized windows, and offscreen execution |
| 362 | `docs/research/windows-runtime/04-browser-cdp.md` | 91 | 4,517 | `md` | READ (100%) | Browser CDP and Edge Canary attachment |
| 363 | `docs/research/windows-runtime/05-observability-and-proof.md` | 124 | 3,756 | `md` | READ (100%) | Observability, proof receipts, and replay |
| 364 | `docs/research/windows-runtime/06-security-and-test-matrix.md` | 146 | 4,403 | `md` | READ (100%) | Security boundaries and verification matrix |
| 365 | `docs/research/windows-runtime/07-source-register.md` | 33 | 4,688 | `md` | READ (100%) | Source register |
| 366 | `docs/research/windows-runtime/08-advanced-design-ideas.md` | 198 | 6,958 | `md` | READ (100%) | Advanced design ideas for Omnia's window and pointer plane |
| 367 | `docs/research/windows-runtime/README.md` | 44 | 4,289 | `md` | READ (100%) | Windows virtual input, window automation, and offscreen capture |
| 368 | `docs/security-storage-architecture.md` | 436 | 19,103 | `md` | READ (100%) | Omnia Security and Local Storage Architecture |
| 369 | `docs/storage-schema.sql` | 4,545 | 207,647 | `sql` | READ (100%) | SQLite DDL v1-v21: 78 tables, 142 triggers, 108 indexes |
| 370 | `docs/ui/README.md` | 46 | 3,888 | `md` | READ (100%) | Omnia Desktop UI/UX specification |
| 371 | `docs/ui/component-contracts.md` | 379 | 15,712 | `md` | READ (100%) | Omnia UI component contracts |
| 372 | `docs/ui/design-tokens.json` | 179 | 9,855 | `json` | READ (100%) | JSON Schema: design-tokens.json (0 props, 0 req) |
| 373 | `docs/ui/icon-system.md` | 101 | 4,555 | `md` | READ (100%) | Omnia icon system |
| 374 | `docs/ui/phase-1-acceptance.md` | 154 | 12,642 | `md` | READ (100%) | Omnia Desktop — Chat Complete UI acceptance backlog |
| 375 | `docs/ui/product-ui-spec.md` | 666 | 36,156 | `md` | READ (100%) | Omnia Desktop — Chat Complete product UI specification |
| 376 | `docs/validate_attachment_schema.py` | 456 | 16,776 | `py` | READ (100%) | Executable py tool/script (17 funcs: new_database, insert_base_scope, insert_run_graph, insert_draft, fixture) |
| 377 | `docs/validate_storage_schema.py` | 44 | 1,461 | `py` | READ (100%) | Executable py tool/script (1 funcs: main) |
