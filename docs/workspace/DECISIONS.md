# Workspace decisions

## 2026-11-11 — Root Git boundary

- Decision: initialize Git at `D:\Omnia` as a workspace control-plane repository.
- Rationale: provide one clean, auditable place for topology, ownership and receipts without flattening independent product/research repos or deleting their history.
- Consequence: child repos remain independently testable and may remain dirty; root status is intentionally scoped to governance files.
- Revisit when a complete source-preserving flattened snapshot and restore test exists.

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
