# Workspace decisions

## 2026-11-11 — Root Git boundary

- Historical decision: initialize Git at `D:\Omnia` as a workspace control-plane repository.
- Rationale: provide one clean, auditable place for topology, ownership and receipts without flattening independent product/research repos or deleting their history.
- Consequence: child repos remain independently testable and may remain dirty; root status is intentionally scoped to governance files.
- Revisit when a complete source-preserving flattened snapshot and restore test exists.

### Supersession — actual product root

The user's later requirement supersedes the governance-only end state.
`D:\Omnia` now tracks native and retained compatibility source directly.
The older checkouts remain recovery/reconciliation owners, not the root
entrypoint. Reconciliation and restore gates remain mandatory before retiring
their metadata. Bulk nonproduct material is moved outside the product tree.

## 2026-11-11 — Native source admission

- Decision: admit the rebuild checkout's `native/` and its shared crate
  dependency closure directly under `D:\Omnia`, excluding `.git`, `target`,
  `node_modules`, caches and reparse points.
- Rationale: the user requires actual product source at the root; promoting
  only `repos\omnia` would omit the newer native Rust lane and provider/session
  services.
- Evidence: external `handoff-intake/NATIVE_ADMISSION.json`; 197 files and
  2,588,993 bytes verified by SHA-256 before and after copy.
- Limits: this is not a semantic merge of divergent checkouts, and it gives
  no credit for final UI, provider delivery, packaging, performance or
  feature parity. Existing dirty sources remain preserved until disposition.

## 2026-11-11 — D: cleanup boundary

- Decision: inventory D: and classify ownership before reclaiming space.
- Rationale: same-volume moves do not free space and broad deletion could
  destroy unrelated projects, recovery data or active work.
- Rule: only regenerate/delete a candidate after owner, reproducibility,
  retention and containment are recorded; otherwise quarantine or retain it.

## 2026-11-11 — Queued additive steer

- Decision: finish an interrupted deliverable before consuming new additive
  prompts. The user explicitly uses steer as quick queue intake.
- Corrections affecting current work apply at a safe boundary; explicit
  stop/cancel/replacement supersedes the named work.
- Evidence: current chat correction and GOAL revision 2, commit `3058494`.
- Scope: planning/continuation behavior; a file-backed queue is not a durable
  runtime scheduling receipt.

## 2026-11-11 — External data and generated cache

- Decision: retain classified archive/research/quarantine/legacy tooling under
  `D:\OmniaData`, outside the product checkout. Record exact old/current
  mappings in `EXTERNAL_LAYOUT.json`; retain private detailed manifests.
- Method: same-volume `Move-Item` with destination collision checks, full
  relative-path/type/size/mtime comparisons, nonzero directory identities and
  selected anchor hashes. Before-file identity fields were zero; no per-file
  NTFS identity proof is carried. The separate correction receipt preserves
  that limitation. This is not a full content hash sweep or a backup restore drill.
- Generated output: after validating Cargo cache markers, zero tracked files,
  reparse boundaries and no observed Cargo/Rust/Omnia process, use `cargo clean`
  on the old native integration target.
- Limits: moving data earns no reclaimed-capacity credit. Cargo's reported
  logical bytes and measured drive free-space delta are separate.

## 2026-11-11 — Preserve bytes and Git state as separate restore claims

- Decision: keep raw common/linked Git metadata and source bytes; qualify
  restored status under recorded source semantics and separately retain content
  reevaluation. Do not normalize source/index to make a restore appear clean.
- Evidence: CHECKPOINT's r10 preservation section routes to the private base
  snapshot, trailing-space supplement, 20-comparison R2 receipt and correction.
- Correction: all three linked indexes were already captured. Source-side
  sparse-checkout reapply was accidentally invoked by one diagnostic; the
  recorded postconditions do not justify calling the continuation read-only.
- Primary regular bytes and the trailing-space supplement now have isolated
  size/SHA-256 readback; reuse the existing restore rather than making another
  full copy. CHECKPOINT owns the exact materialization receipt and denominator.
- Limits: inherited EOL/stat-cache differences remain findings. Primary Git-state
  comparison and excluded-owner/consumer preservation are pending; retirement
  remains false.

## 2026-11-11 — Atomic UI direction and routing contracts

- Decision: add one focused `deep-ui-direction` skill under
  `C:\Users\khang\.codex\skills` and route its outputs through the existing
  quantitative UI, technical design and behavioral QA skills.
- Rationale: the user's “good taste / anti-AI-slop / preview first” request is a
  distinct decision workflow, while token selection, measurement and functional
  QA already have owning skills. Synonym-only deep skills would make routing
  noisier and increase false confidence.
- Evidence: the skill passed
  `C:\\Users\\khang\\\.codex\\skills\\\.system\\skill-creator\\scripts\\quick_validate\.py`.
  A bounded external receipt outside the product tree records 10 GitHub queries,
  68 unique repository identities, 8 official pages and 11 selected README
  retrievals. The receipt is discovery/content-extract evidence, not exhaustive
  source review or runtime proof; social/video links remain unreviewed.
- Decision: add `DYNAMIC_ROUTING_REQUIREMENTS.md` as the product specification
  for quota/cost/latency/model/provider routing before implementation. Reuse
  existing provider/profile/token/cost/run-journal foundations only after a
  schema and ownership review; do not create duplicate ledgers by assumption.
- Limits: neither contract has Omnia runtime, preview, user-review, provider
  delivery or performance credit yet. Research, implementation, loading and
  invocation remain separate states.


## 2026-11-11 — Bounded UI-style research receipt

- Evidence: external receipt C:\Users\khang\.codex\research\omnia-ui-direction\20261111\UI_STYLE_RESEARCH_RECEIPT.json records 10 GitHub queries, 68 unique repository identities, 8 official pages fetched and 11 selected README retrievals. A content-extract receipt records the actual inspected text ranges and access limitations.
- Admission: retain only general workflow lessons—explicit reference provenance, layered tokens, accessible primitives, state coverage, preview before implementation and separate visual/behavioral gates. Do not vendor repository code, assets, fonts or copied visual identity.
- Limits: GitHub search results are discovery evidence; selected README inspection is high-level and official pages are not exhaustive. Social/video sources and named terms remain unreviewed. No Omnia runtime, UI preview, user approval or performance credit is earned.
