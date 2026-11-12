# Omnia source topology and reconciliation index

**Index role:** Navigable index for repository ownership, 4-checkout divergence reconciliation (`ROOT-02`, `DOD-04`), pre-C++20 Rust snapshot archival, safe Git worktree relocation (`ROOT-03`, `DOD-05`), and externalized storage + `C:\`/`D:\` reclamation (`DRIVE-01`, `DRIVE-02`, `DOD-08`).

## Canonical product root (`D:\Omnia`)

- **Root CMake & presets:** [`../../CMakeLists.txt`](../../CMakeLists.txt), [`../../CMakePresets.json`](../../CMakePresets.json)
- **Native C++20 core, harness & Studio server (`omnia-studio.exe`):** [`../../cpp/`](../../cpp/) ([`../../cpp/CMakeLists.txt`](../../cpp/CMakeLists.txt)) — `omnia_core`, `omnia_storage`, `omnia_routing`, `omnia_graph`, `omnia_harness`, `omnia-studio.exe`, and `6` CTest suites
- **Native C++20 Win32 desktop shell (`omnia-native.exe`):** [`../../native/`](../../native/) ([`../../native/CMakeLists.txt`](../../native/CMakeLists.txt), [`../../native/README.md`](../../native/README.md)) — `omnia-native.exe`, `omnia_qa_seed.exe`, `omnia_native_tests.exe` (`29` CTest cases), and `7` PowerShell QA workflows (`native/qa-*.ps1`)
- **Flagship Studio UI ("Obsidian Kinetic Atelier"):** [`../../ui/`](../../ui/) ([`../../ui/index.html`](../../ui/index.html), [`../../ui/styles/`](../../ui/styles/), [`../../ui/app/`](../../ui/app/)) & [`../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md`](../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md)
- **Repo-owned agent skills, sync tools & SQL reference:** [`../../.agents/skills.json`](../../.agents/skills.json), [`../../.agents/skills/`](../../.agents/skills/) (`13` curated skills incl. `deep-cpp-native`), [`../../tools/agy-history-sync/`](../../tools/agy-history-sync/), [`../../tools/maintained-scripts/`](../../tools/maintained-scripts/), [`../storage-schema.sql`](../storage-schema.sql)
- **Lossless pre-C++20 Rust/Tauri archival:** Git tag `archive/pre-cpp-rust-snapshot-20261112` (`c3033728abe6f0a4906a796bf7652c84408356d7`, preserving all `1,937` retired Rust/Tauri/legacy web files) + `D:\OmniaData\recovery\pre-cpp-ignored-files-20261112\MANIFEST.json` (`sha256=0da02149...`, preserving `2` formerly git-ignored research scripts). Active `D:\Omnia` carries **`0` `.rs` and `0` `Cargo.*` files**.

## Authoritative reconciliation, layout & deep-clean ledgers

1. **Per-path source disposition (`138/138` focus rows reviewed, `0` `unreviewed`)**:
   - [`SOURCE_DISPOSITION_LEDGER.json`](SOURCE_DISPOSITION_LEDGER.json) (`127` `incorporated`, `8` `superseded-with-evidence`, `3` `retained-recovery`, plus `wave4Cpp20ArchitecturalReplacement`)
   - Detailed external report: `D:\OmniaData\research\omnia-clean-2026-11-12\source-reconciliation-complete.json`
   - Preserved unique feature slices (`57` files + `27` patches = `84/84` SHA-256 verified): `D:\OmniaData\recovery\unique-source-deltas-20261112\`
   - Supporting structural diffs: [`head-path-reconciliation.json`](head-path-reconciliation.json), [`shared-path-differences.json`](shared-path-differences.json), [`source-divergence-ledger.json`](source-divergence-ledger.json)
2. **Externalized non-product layout, worktree relocation & `C:\`/`D:\` deep-clean reclamation**:
   - [`EXTERNAL_LAYOUT.json`](EXTERNAL_LAYOUT.json), [`CLEANUP_STATUS_20261112.md`](CLEANUP_STATUS_20261112.md), [`DEEP_CLEAN_AUDIT_D_DRIVE.md`](DEEP_CLEAN_AUDIT_D_DRIVE.md), & [`DEEP_CLEAN_AUDIT_C_DRIVE.md`](DEEP_CLEAN_AUDIT_C_DRIVE.md)
   - **`D:\` exhaustive reclamation**: `59.42 GiB -> 837.57 GiB` free (**`+778.15 GiB` physical / `799.19 GiB` logical** across `3,344,757` files; receipt `D:\OmniaData\qa\deep-clean-20261112\D_DRIVE_DEEP_CLEAN_RECEIPT.json`, `sha256=70f2781d...`).
   - **`C:\` exhaustive reclamation**: `23.47 GiB -> 189.60 GiB` free (**`+166.14 GiB` physical / `183.69 GiB` logical** across `1,371,966` files; receipt `D:\OmniaData\qa\deep-clean-20261112\C_DRIVE_DEEP_CLEAN_RECEIPT.json`, `sha256=ee08c5a0...`).
   - **Combined Wave 4 capacity gained**: **`+944.29 GiB` physical** (`982.88 GiB` logical) with `FILE_ATTRIBUTE_REPARSE_POINT` (`0x400`) non-traversal guards across `20,198` `repos/omnia` junctions, `6,326` `opencode` links, and `4` `.pnpm-store` links.
   - Common Git store & release worktree remain healthy (`4/4` checkouts, `publish-worktree` porcelain `133 == 133`) under `D:\OmniaData\repos\omnia` and `D:\OmniaData\worktrees\publish-worktree`.
   - **Open preservation & ACL boundaries (`retirementEligible = false`)**: Primary Git-state comparison, excluded nested/Gitlink/reparse boundaries, `D:\Omnia\Roaming` (orphaned SID `S-1-5-21-3752430534-...-1001`, `WinError 5`), and `D:\CodexApp\WindowsApps` (`WinError 5` OS AppX ACL).
3. **Historical nested-repo & reference triage records**:
   - [`REPO_REGISTRY.md`](REPO_REGISTRY.md), [`RELOCATION_LOG.md`](RELOCATION_LOG.md), [`RELOCATION_CANDIDATES.json`](RELOCATION_CANDIDATES.json), [`WORKSPACE_OWNERSHIP.json`](WORKSPACE_OWNERSHIP.json), [`omnia-public-git-removal.json`](omnia-public-git-removal.json)
