# Omnia source topology and reconciliation index

**Index role:** Navigable index for repository ownership, 4-checkout divergence reconciliation (`ROOT-02`, `DOD-04`), safe Git worktree relocation (`ROOT-03`, `DOD-05`), and externalized non-product storage (`DRIVE-01`, `DRIVE-02`, `DOD-08`).

## Canonical product root (`D:\Omnia`)

- **Native Rust Windows package:** [`../../native/`](../../native/) ([`../../native/Cargo.toml`](../../native/Cargo.toml), [`../../native/README.md`](../../native/README.md))
- **Shared Rust domain crates:** [`../../src-tauri/crates/`](../../src-tauri/crates/) (`omnia-harness`, `omnia-provider-services`, `omnia-session-store`, `omnia-browser`, `omnia-computer`, `omnia-download`)
- **Retained compatibility projection:** [`../../src/`](../../src/), [`../../src-tauri/`](../../src-tauri/) ([`../../src-tauri/Cargo.toml`](../../src-tauri/Cargo.toml)), [`../storage-schema.sql`](../storage-schema.sql), [`../../package.json`](../../package.json)
- **Repo-owned agent skills & sync tools:** [`../../.agents/skills.json`](../../.agents/skills.json), [`../../.agents/skills/`](../../.agents/skills/) (`12` curated skills), [`../../tools/agy-history-sync/`](../../tools/agy-history-sync/), [`../../tools/maintained-scripts/`](../../tools/maintained-scripts/)

## Authoritative reconciliation & layout ledgers

1. **Per-path source disposition (`138/138` focus rows reviewed, `0` `unreviewed`)**:
   - [`SOURCE_DISPOSITION_LEDGER.json`](SOURCE_DISPOSITION_LEDGER.json) (`127` `incorporated`, `8` `superseded-with-evidence`, `3` `retained-recovery`)
   - Detailed external report: `D:\OmniaData\research\omnia-clean-2026-11-12\source-reconciliation-complete.json`
   - Preserved unique feature slices (`57` files + `27` patches = `84/84` SHA-256 verified): `D:\OmniaData\recovery\unique-source-deltas-20261112\` (`SLICE-REL-COMPARE-PREPARE`, `SLICE-BROWSER-CAPTURE-LEASE`, `SLICE-PRI-SETTINGS-CAS-AND-TELEMETRY`, `SLICE-REBUILD-CI-AND-SCRIPTS`)
   - Supporting structural diffs: [`head-path-reconciliation.json`](head-path-reconciliation.json), [`shared-path-differences.json`](shared-path-differences.json), [`source-divergence-ledger.json`](source-divergence-ledger.json)
2. **Externalized non-product layout & worktree relocation**:
   - [`EXTERNAL_LAYOUT.json`](EXTERNAL_LAYOUT.json) & [`CLEANUP_STATUS_20261112.md`](CLEANUP_STATUS_20261112.md)
   - Initial `10` non-product trees (`92,460` files / `15.16 GB`) + `2026-11-12` `12` root clutter directories (`187,694` files / `19.83 GB`) relocated to `D:\OmniaData\externalized-20261112\` (`0` capacity credit for same-volume moves).
   - Common Git store & release worktree relocated safely (`0` active locks) to `D:\OmniaData\repos\omnia` and `D:\OmniaData\worktrees\publish-worktree` and repaired via `git worktree repair` across all `4` checkouts (`D:\OmniaData\research\omnia-clean-2026-11-12\worktree-relocation-receipt-20261112.json`).
   - **Open preservation boundaries (`retirementEligible = false`)**: Primary Git-state comparison, excluded nested/Gitlink/reparse boundaries (`~20,198` unnormalized internal junctions under `upstream_extractions/`), and `D:\Omnia\Roaming` (ACL-locked to orphaned Windows SID `S-1-5-21-3752430534-...-1001`, `WinError 5`; ignored by `.gitignore` until an elevated UAC `takeown`/`icacls`/`Move-Item` pass is run).
3. **Historical nested-repo & reference triage records**:
   - [`REPO_REGISTRY.md`](REPO_REGISTRY.md), [`RELOCATION_LOG.md`](RELOCATION_LOG.md), [`RELOCATION_CANDIDATES.json`](RELOCATION_CANDIDATES.json), [`WORKSPACE_OWNERSHIP.json`](WORKSPACE_OWNERSHIP.json), [`omnia-public-git-removal.json`](omnia-public-git-removal.json)
