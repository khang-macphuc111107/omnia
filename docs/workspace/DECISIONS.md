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

## 2026-11-12 — Four-keyword research and reversible Cargo quarantine

- Decision: preserve the four exact GitHub searches as external discovery
  evidence, then inspect only a bounded, explicitly selected top-five subset
  per keyword. Do not imply that 400 search rows or 324 deduplicated
  repositories were fully read.
- Evidence: `github-four-keywords.json` and
  `github-four-keywords-unique.json` record 100 results for each of `agent`,
  `memory`, `code` and `open`, sorted by stars descending. The bounded ledger
  records README hashes, license endpoint results and tree metadata for 16
  unique repositories.
- Admission rule: no external source code, assets, credentials, private
  transcripts, issue/comment bodies or runtime behavior are admitted from this
  research batch. Any later reuse requires a separate license, privacy,
  security, compatibility and implementation review.
- Decision: externalize three generated Cargo target caches from the dirty
  child repository to `D:\OmniaData\quarantine\omnia-clean-20261112\cargo-targets`
  by exact path after a receipt proved containment, ignore state, zero tracked
  files, zero status entries, ordinary directories and no observed Cargo/rustc
  process.
- Limits: the move is reversible and same-volume. File counts and logical
  bytes read back exactly, but free-space delta is zero and no deletion or
  reclamation credit is earned. Child status remains dirty and missing
  directory warnings remain. Future cleanup must be candidate-by-candidate.

## 2026-11-12 — Pytest cache quarantine

- Decision: move the two small pytest cache directories out of the child source
  tree after path-specific checks. The status-visible `.pytest-cache` marker is
  retained in external quarantine rather than silently discarded.
- Evidence: `cleanup-receipt-pytest-cache-move.json` records one five-byte file
  and four standard pytest cache files, zero tracked files, exact containment,
  ordinary-directory checks and zero same-volume free-space delta.
- Limits: producer provenance for the marker is not proven; no deletion or
  disk-reclamation credit is claimed. The child repository remains dirty and
  all larger or mixed-ownership candidates remain preserved.

## 2026-11-12 — Graphify bounded admission and Vite output quarantine

- Decision: record Graphify as RESEARCH_ONLY. Public API metadata, README,
  license and six selected canonical files support reusable design hypotheses,
  not source or runtime admission. The candidate lessons are deterministic
  indexing, explicit edge provenance, bounded query settings, graph-first
  navigation and opt-in query logging.
- Evidence: external files under
  C:\Users\khang\.codex\research\omnia-clean-2026-11-12\supplement-20261112\graphify.
  The recursive tree had 1,306 entries and was not truncated, but only six
  files were opened. Issues, comments, media and runtime were not reviewed.
- Decision: externalize dist from the child repository after proving it is
  generated Vite output, ignored, untracked, non-reparse, status-free and not
  referenced by a running process at the final check.
- Evidence: pre/move receipts bind 140 files and 6,924,863 logical bytes;
  readback matches and the exact reverse move is recorded.
- Limit: quarantine is on D:, so free-space delta is zero. No deletion,
  recycle-bin purge or capacity credit is implied. All mixed-ownership and
  potentially active candidates remain retained.


## 2026-11-12 — Node dependency quarantine

- Decision: move `node_modules` out of the child source tree as a reversible
  generated-output unit. It was ignored, untracked, non-reparse, status-free and
  not referenced by a running process at the final gate.
- Evidence: pre/move receipts record 12,111 files and 194,672,966 logical bytes;
  readback matches. `package-lock.json` hash and `npm ci` regeneration route are
  recorded. The exact reverse move is the restore path.
- Limit: same-volume move changed free space by 0 bytes. No deletion or
  capacity credit is claimed. Keep source, lockfile and quarantine provenance;
  do not delete the quarantine until a restore/build check qualifies it.

## 2026-11-12 — OpenHands uv cache quarantine

- Decision: move `D:\Omnia\repos\omnia\.toolchains\openhands-uv-cache` out of the child source tree as one reversible generated-cache unit.
- Evidence: the pre-move receipt records 85,557 entries, 71,261 files and 2,083,312,334 logical bytes; the directory was ignored, untracked, status-free, ordinary, non-reparse and not referenced by an active process at the final gate. The move receipt confirms matching readback, source absence and the exact reverse move command.
- Producer and recovery: uv/OpenHands package-cache markers and the supported uv regeneration route remain documented; no lockfile, source, nested repository, profile or worktree was changed.
- Limit: quarantine is on D:, so the free-space delta is 0 bytes. No deletion, recycle-bin purge or capacity credit is implied. Retain the quarantine until a controlled restore/build check and retention decision are complete.
