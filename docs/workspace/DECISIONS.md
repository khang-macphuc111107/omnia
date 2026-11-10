# Workspace decisions

## 2026-11-11 — Root Git boundary

- Decision: initialize Git at `D:\Omnia` as a workspace control-plane repository.
- Rationale: provide one clean, auditable place for topology, ownership and receipts without flattening independent product/research repos or deleting their history.
- Consequence: child repos remain independently testable and may remain dirty; root status is intentionally scoped to governance files.
- Revisit when a complete source-preserving flattened snapshot and restore test exists.
