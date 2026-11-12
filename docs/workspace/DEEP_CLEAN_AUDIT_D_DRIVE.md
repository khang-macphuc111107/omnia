# Exhaustive Evidence-First `D:\`, `D:\OmniaData`, and `D:\Omnia` Deep Clean Audit / Báo Cáo Kiểm Toán & Dọn Sạch Chuyên Sâu Toàn Ổ `D:\`

- **Date / Ngày thực hiện**: `2026-11-12` (`Wave 4 — Full Native C++20 Migration #74 + Additive Volume-Wide Deep Clean #80`)
- **Owner / Tác nhân thực thi**: `root-cleaner`
- **Governed By / Quy chuẩn áp dụng**: `deep-clean`, `repo-hygiene-and-artifact-lifecycle`
- **Machine-Readable Receipt / Biên bản JSON**: `D:\OmniaData\qa\deep-clean-20261112\D_DRIVE_DEEP_CLEAN_RECEIPT.json` (`63,685` B, `sha256=70f2781df22d91d33bfe0559344041281ea55ea8cec7a9a3eb73a650bc3253af`)
- **Companion Reports / Báo cáo liên kết**: [DEEP_CLEAN_AUDIT_C_DRIVE.md](DEEP_CLEAN_AUDIT_C_DRIVE.md) · [EXTERNAL_LAYOUT.json](EXTERNAL_LAYOUT.json) · [SOURCE_DISPOSITION_LEDGER.json](SOURCE_DISPOSITION_LEDGER.json) · [CLEANUP_STATUS_20261112.md](CLEANUP_STATUS_20261112.md)

---

## 1. Executive Summary / Tóm Tắt Kết Quả Thu Hồi Dung Lượng

**English**: Prior to Wave 4 volume-wide cleanup, volume `D:` (`953.6568 GiB` total) was critically constrained with `894.2400 GiB` (`93.77%`) used and only **`59.4168 GiB` (`63,798,288,384` bytes, `6.23%`) free**. Executing Action A (`D:\Omnia` legacy Rust/Tauri/Vite working-tree removal backed by Git tag `archive/pre-cpp-rust-snapshot-20261112` @ `c3033728abe6f0a4906a796bf7652c84408356d7` plus pure-`LF` Native C++20 [`.gitignore`](../../.gitignore)) and Action B (`12` provenance-verified reclamation units across `D:\`, `D:\CodexBetaPatched`, `D:\OmniaData`, and `D:\opencode` with `FILE_ATTRIBUTE_REPARSE_POINT = 0x400` junction guards and `robocopy /MIR /MT:32` bulk unlinking) reclaimed **`799.1901 GiB` (`858,123,880,603` logical bytes across `3,344,757` files and `429,876` directories)**. Volume `D:` free space rose to **`837.5680 GiB` (`899,331,768,320` bytes, `87.83%` free)** — a net physical NTFS gain of **`+778.1512 GiB` (`+835,533,479,936` bytes)** while preserving `100%` of user source repositories (`D:\HCMUT`, `D:\htmustc-proxy`, `D:\opencode` source, `D:\Omnia` C++20/Win32/UI tree), all `4` Git worktrees, canonical recovery `.bundle`/`.asar` archives, and QA/audit ledgers.

**Tiếng Việt**: Trước đợt dọn chuyên sâu toàn ổ `D:` ở Wave 4, ổ `D:` (tổng dung lượng `953.6568 GiB`) bị đầy nghiêm trọng với `894.2400 GiB` đã dùng và chỉ còn trống **`59.4168 GiB` (`63,798,288,384` byte, `6.23%`)**. Thông qua Action A (gỡ bỏ cây thư mục Rust/Tauri/Vite cũ khỏi `D:\Omnia` sau khi đã niêm phong `100%` lịch sử trong Git tag `archive/pre-cpp-rust-snapshot-20261112` @ `c3033728abe6f0a4906a796bf7652c84408356d7`, sao lưu `2` tệp kịch bản bị git-ignore và cập nhật [`.gitignore`](../../.gitignore) chuẩn C++20 `LF`) kết hợp Action B (`12` hạng mục thu hồi dung lượng có kiểm chứng nguồn gốc, khóa tiến trình, `.gitignore`, và chống đi xuyên junction `0x400` trên `D:\`, `D:\CodexBetaPatched`, `D:\OmniaData`, `D:\opencode`), hệ thống đã giải phóng **`799.1901 GiB` (`858,123,880,603` byte logic trên `3,344,757` tệp và `429,876` thư mục)**. Dung lượng trống vật lý trên ổ `D:` tăng vọt lên **`837.5680 GiB` (`899,331,768,320` byte, trống `87.83%`)** — thu hồi thực tế **`+778.1512 GiB` (`+835,533,479,936` byte)** mà **không làm suy suyển bất kỳ** kho mã nguồn người dùng (`D:\HCMUT`, `D:\htmustc-proxy`, `D:\opencode`, mã nguồn C++20/Win32/UI tại `D:\Omnia`), `4` Git worktree liên kết, kho `.bundle`/`.asar` gốc hay biên bản kiểm toán QA nào.

| Metric / Chỉ số (`D:` Volume Telemetry) | Before / Trước Wave 4 | After / Sau Wave 4 | Delta / Thay đổi |
|---|---:|---:|---:|
| **Total Capacity / Tổng dung lượng** | `953.6568 GiB` (`1,023,981,228,032` B) | `953.6568 GiB` (`1,023,981,228,032` B) | `0 B` |
| **Used Space / Đã dùng** | `894.2400 GiB` (`960,182,939,648` B) | `116.0889 GiB` (`124,649,459,712` B) | `-778.1512 GiB` (`-835,533,479,936` B) |
| **Free Space / Còn trống** | **`59.4168 GiB`** (`63,798,288,384` B / `6.23%`) | **`837.5680 GiB`** (`899,331,768,320` B / `87.83%`) | **`+778.1512 GiB`** (`+835,533,479,936` B) |
| **Logical Reclaimed (Action A + B)** | — | — | **`799.1901 GiB`** (`858,123,880,603` B; `3,344,757` files; `429,876` dirs) |

> [!NOTE]
> **Logical Reclaimed vs. Physical NTFS Free Delta (`799.1901 GiB` logical vs. `+778.1512 GiB` physical)**: Rust Cargo incremental target trees (`D:\OmniaData\repos\omnia\src-tauri\target` `221.74 GiB` logical vs. `+196.87 GiB` physical; `D:\OmniaData\tools\cargo-target` `12.63 GiB` logical vs. `+11.59 GiB` physical; `D:\opencode\rust\*\target` `1.61 GiB` logical vs. `+1.49 GiB` physical) create same-volume NTFS hardlinks between `deps/` artifacts and top-level outputs (`~26.0 GiB` shared inode links). Conversely, purging `2,878,621` small files in `D:\CodexBetaPatched\backup\updates` reclaimed `+4.78 GiB` of extra NTFS `4 KiB` allocation-unit slack (`525.29 GiB` logical vs. `+530.07 GiB` physical), reconciling `799.19 - 26.0 + 4.8 ≈ +778.14 GiB`.

---

## 2. Action A — `D:\Omnia` Legacy Rust/Tauri Clutter Removal & Native C++20 `.gitignore`

### 2.1 Pre-Removal Cryptographic Preservation & Git-Ignored Delta Backup

- **Immutable Git Tag**: `archive/pre-cpp-rust-snapshot-20261112` -> commit `c3033728abe6f0a4906a796bf7652c84408356d7` preserves `100%` of tracked pre-migration Rust/Tauri/React/Vite files in `.git` object storage (`0` extra working-tree disk bytes).
- **Git-Ignored Script Preservation**: Pre-delete inspection caught `2` untracked `.mjs` scripts inside `D:\Omnia\scripts\research\` excluded from the tag by the legacy `research/` ignore rule. Both were copied with SHA-256 verification to `D:\OmniaData\recovery\pre-cpp-ignored-files-20261112\` (`MANIFEST.json` `sha256=0da021493635b1861e0fa21106abaf285dd175cc5080027f7677446b79a53709`):
  - `scripts/research/fetch-novel-references.mjs` (`3,208` B, `sha256=65998ba2c54f6d98afd1ea8dec852c285001492d254accd1cc1e425ddd020704`)
  - `scripts/research/refresh-cycle4-source.mjs` (`4,031` B, `sha256=00b6ae5e26426d30bdb0e3aa96a2edaef0a4f01243f596713f1cb38526acaaab`)
- **Native C++20 `.gitignore` Update**: [`.gitignore`](../../.gitignore) updated to pure UTF-8 `LF` (`1,067` B, `sha256=34b53acc61c5de712e3ac3ec94c37147be86d1ba02e716bf51995c43fcb60191`), ignoring `build/`, `out/`, `CMakeFiles/`, `CMakeCache.txt`, `compile_commands.json`, `*.obj`, `*.pdb`, `*.ilk`, `*.exp`, `*.lib`, `*.exe`, `__pycache__/`, `Roaming/`, and operational `.agents/*` while explicitly unignoring `!.agents/skills/**` and `!.agents/skills.json`.

### 2.2 Removed Legacy Directories & Root Files (`1,937` Files, `32,782,598` Logical Bytes)

| Removed Surface in `D:\Omnia` | Kind | Files | Dirs | Logical Size | Content / Tree Manifest SHA-256 | Exact Rollback Command |
|---|---|---:|---:|---:|---|---|
| `src-tauri/` | `dir` | `314` | `41` | `8.63 MiB` (`9,047,124` B) | `469ab4272d18e420…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- src-tauri`` |
| `src/` | `dir` | `1,305` | `26` | `17.59 MiB` (`18,445,524` B) | `ca33d0ad904cd8f8…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- src`` |
| `scripts/` | `dir` | `231` | `4` | `1.50 MiB` (`1,572,849` B) | `3a3b465597b305fd…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- scripts`` |
| `tests/` | `dir` | `61` | `4` | `3.33 MiB` (`3,493,646` B) | `d475b3af930b3a9e…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- tests`` |
| `design/` | `dir` | `16` | `1` | `25,761` B | `c02a503f869a0c11…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- design`` |
| `index.html` | `file` | `1` | `0` | `540` B | `beda6fcd904f1e7e…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- index.html`` |
| `package.json` | `file` | `1` | `0` | `5,835` B | `88b88c39e37ba5af…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- package.json`` |
| `package-lock.json` | `file` | `1` | `0` | `173,173` B | `a6a1bb62a2294000…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- package-lock.json`` |
| `playwright.visual.config.ts` | `file` | `1` | `0` | `3,378` B | `45ad067dde28d579…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- playwright.visual.config.ts`` |
| `tsconfig.app.json` | `file` | `1` | `0` | `853` B | `8baa6128d1097ce3…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- tsconfig.app.json`` |
| `tsconfig.context-c0.json` | `file` | `1` | `0` | `344` B | `5d9cba7766a06d9d…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- tsconfig.context-c0.json`` |
| `tsconfig.json` | `file` | `1` | `0` | `128` B | `53a5de3ac873acc5…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- tsconfig.json`` |
| `tsconfig.node.json` | `file` | `1` | `0` | `507` B | `18ce5c5af79a1dce…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- tsconfig.node.json`` |
| `vite.config.ts` | `file` | `1` | `0` | `12,829` B | `23bce0130a44239f…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- vite.config.ts`` |
| `.env.example` | `file` | `1` | `0` | `107` B | `6762114083409de5…` | ``git -C "D:\Omnia" checkout archive/pre-cpp-rust-snapshot-20261112 -- .env.example`` |

### 2.3 Complete Post-Cleanup `D:\Omnia` Root Retention Ledger (`15` Entries)

| Entry in `D:\Omnia` | Kind | Files | Dirs | Measured Size | Disposition & Architectural Role |
|---|---|---:|---:|---:|---|
| `D:\Omnia\.agents` | `dir` | `30` | `31` | `122,220` B | `retained` — Curated repository skill packages (`.agents/skills/*`, `.agents/skills.json`) synchronized 4-way |
| `D:\Omnia\.editorconfig` | `file` | `1` | `0` | `446` B | `retained` — Repository-wide UTF-8 `LF` formatting contract |
| `D:\Omnia\.git` | `dir` | `2,594` | `272` | `15.04 MiB` (`15,770,869` B) | `retained` — Primary Omnia Git object store, refs, and `archive/pre-cpp-rust-snapshot-20261112` tag |
| `D:\Omnia\.gitattributes` | `file` | `1` | `0` | `888` B | `retained` — Pure `LF` line-ending normalization rules across source & governance docs |
| `D:\Omnia\.gitignore` | `file` | `1` | `0` | `1,067` B | `retained_updated` — Native C++20 CMake/MSVC/Clang ignore contract (`sha256=34b53acc...`) |
| `D:\Omnia\AGENTS.md` | `file` | `1` | `0` | `10,456` B | `retained` — Repository autonomous execution, C++20 build boundary, and peer-mesh governance contract |
| `D:\Omnia\CMakeLists.txt` | `file` | `1` | `0` | `1,053` B | `retained` — Top-level C++20 CMake build graph ([CMakeLists.txt](../../CMakeLists.txt)) |
| `D:\Omnia\CMakePresets.json` | `file` | `1` | `0` | `1,956` B | `retained` — Out-of-source Ninja Debug/Release presets targeting `D:\OmniaData\build\*` |
| `D:\Omnia\cpp` | `dir` | `35` | `18` | `359,205` B | `retained` — Native C++20 core & HTTP/JSON-RPC studio host (`omnia-studio.exe`), 5 static `.lib` targets (`omnia_core`, `omnia_storage`, `omnia_routing`, `omnia_graph`, `omnia_harness`), and `ctest` suite (`cpp/**`) |
| `D:\Omnia\docs` | `dir` | `42` | `3` | `795,369` B | `retained_updated` — Workspace ledgers, UI direction specs, collaborator handoff, and C:/D: deep-clean audits |
| `D:\Omnia\native` | `dir` | `30` | `4` | `444,106` B | `retained` — Native C++20 Win32 + DWM Mica + Direct2D + Server-Side COM UIA desktop shell (`omnia-native.exe`, `omnia_qa_seed.exe`, `omnia_native_tests.exe` under `native/**`) |
| `D:\Omnia\README.md` | `file` | `1` | `0` | `13,352` B | `retained` — Primary Omnia architecture and build/verification entry point |
| `D:\Omnia\Roaming` | `dir` | `0` | `0` | `ACL-locked (WinError 5)` | `acl_locked_gitignored` — Empty/unreadable stale Windows SID `S-1-5-21-3752430534-...-1001` (`WinError 5`); ignored in `.gitignore` (see Section 5) |
| `D:\Omnia\tools` | `dir` | `5` | `2` | `106,882` B | `retained` — Cross-host `agy-history-sync` FTS5 tool & unit tests (`tools/agy-history-sync/**`) |
| `D:\Omnia\ui` | `dir` | `13` | `2` | `235,968` B | `retained` — Flagship Omnia Studio HTML/CSS/JS frontend served over `127.0.0.1` loopback JSON-RPC/HTTP by `omnia-studio.exe` (`ui/**`) |

---

## 3. Action B — Volume-Wide `D:\` Reclamation Units (`B1..B12`: `3,342,820` Files, `799.1596 GiB` Logical)

| Unit ID | Target Scope on `D:\` | Class | Files Deleted | Dirs Deleted | Logical Deleted (`GiB` / `Bytes`) | Physical Delta (`GiB`) | Provenance & Safety Proof |
|---|---|---|---:|---:|---:|---:|---|
| `B1-codex-backup-updates-284` | `D:\CodexBetaPatched\backup\updates\app.20260924-183409 .. app.20261013-161824 (284 directories; kept latest app.20261013-163324 + app.asar.CodexBetaPatched.original)` | `duplicate_rolling_update_snapshots` | `2,878,621` | `374,126` | `525.2870 GiB` (`564,022,590,402` B) | `+530.071 GiB` | 284 rolling ~1.85 GiB Electron auto-update snapshots; latest snapshot app.20261013-163324 and live app/codex-home/user-data-live preserved. |
| `B2-codex-dot-update-staging` | `D:\CodexBetaPatched\.update\2026* (293 stale update staging folders; empty .update retained)` | `stale_update_staging_cache` | `81,074` | `10,877` | `14.7939 GiB` (`15,884,786,442` B) | `+14.933 GiB` | 293 abandoned auto-update staging folders from 2026-09/2026-10 (0 open handles). |
| `B3-codex-test-and-probe-profiles` | `D:\CodexBetaPatched\{_asar_probe_20260923, user-data-test, test-codex-home, verify-user-data-20260927-1}` | `temporary_test_profiles_and_probes` | `6,722` | `636` | `0.3837 GiB` (`411,950,061` B) | `+0.387 GiB` | Temporary unpacked Electron asar probe and 3 isolated Chromium/SQLite test profiles; live user-data-live and codex-home untouched. |
| `B4-codex-archive-temp-and-asar-nm` | `D:\CodexBetaPatched\archive\c-cleanup-20260927\temp + user-artifacts\asar-{live,full}-20260923\node_modules` | `archived_os_temp_and_node_modules` | `18,882` | `983` | `1.2978 GiB` (`1,393,528,674` B) | `+1.316 GiB` | Archived OS temp folder (1.26 GiB) and 2 unpacked asar node_modules; codex-sessions (32.49 GiB), documents-codex, and user-artifacts preserved intact. |
| `B5-repos-omnia-rust-targets` | `D:\OmniaData\repos\omnia\src-tauri\{target, target-ide}` | `generated_build_cache` | `166,597` | `15,063` | `221.7431 GiB` (`238,094,819,704` B) | `+196.872 GiB` | Git-ignored Rust Cargo build directories (0 tracked files in git ls-files, reparse=0); .git and all source files in repos/omnia untouched. |
| `B6-omniadata-tools-cargo-target` | `D:\OmniaData\tools\cargo-target` | `obsolete_cargo_target_cache` | `17,192` | `1,714` | `12.6297 GiB` (`13,561,043,363` B) | `+11.588 GiB` | Shared Rust CARGO_TARGET_DIR superseded by Omnia Native C++20 CMake migration (0 cargo/rustc processes running). |
| `B7-archive-rust-debug-and-duplicate-extracts` | `D:\OmniaData\archive\legacy-desktop-patches-20261104\{CodexCleanupQuarantine\20260923\omnia-rust-target-debug + 6 duplicate unpacked .asar/.nupkg extract dirs}` | `archived_cargo_target_and_duplicate_asar_extracts` | `9,349` | `1,358` | `6.7080 GiB` (`7,202,689,083` B) | `+6.716 GiB` | 6.00 GiB obsolete Rust debug target + 6 unpacked .asar/.nupkg extract directories whose canonical .asar/.msix archives remain intact right beside them. |
| `B8-externalized-duplicate-restores-and-unpacked-apps` | `D:\OmniaData\externalized-20261112\{backups\omnia-dirty-trees-Qo2K58\restore-{latest,rFQ20n}\00..03, CursorApp, claude-appasar-extracted, downloads\{cursor,windsurf}_installed, LocalAppData\ai.omnia.desktop\EBWebView, 92 empty LocalAppData test dirs}` | `duplicate_restore_materializations_and_unpacked_binaries` | `154,256` | `23,863` | `14.6168 GiB` (`15,694,712,100` B) | `batched (+14.6 GiB net)` | Materialized duplicate test restores (canonical 00..03/repository.bundle + manifest.json + restore-report.json preserved), duplicate unpacked Electron app binaries (original .exe/.asar archives preserved), EBWebView cache, and 92 0-byte empty test directories. |
| `B9-qa-ephemeral-clones-and-superseded-precheck` | `D:\OmniaData\qa\github-clean-clone-20261112\{remote-github-clone, isolated-local-clone} + D:\OmniaData\qa\native-precheck-20261112` | `ephemeral_qa_clones_and_superseded_precheck` | `4,145` | `273` | `0.0882 GiB` (`94,708,480` B) | `+0.095 GiB` | Ephemeral clean-clone verification checkouts (GITHUB_DELIVERY_AND_CLONE_RECEIPT.json retained intact) and superseded native-precheck-20261112 (native-20261112, native, audits-20261112, ui-direction-20261112, cpp-native-precheck-20261112 retained). |
| `B10-quarantine-pytest-cache` | `D:\OmniaData\quarantine\omnia-clean-20261112\pytest-cache` | `quarantined_pytest_cache` | `5` | `4` | `0.0005 GiB` (`495,038` B) | `+0.000 GiB` | Quarantined .pytest_cache (CACHEDIR.TAG; 5 files SHA-256 recorded in d-drive-reclamation-receipt-20261112.json); root-scratch-20261112-033528, cleanup-20261013, cleanup-20261110, and manual retained. |
| `B11-opencode-rust-cargo-targets` | `D:\opencode\rust\{ultra-core\target, ultra-desktop\target}` | `generated_build_cache` | `5,693` | `758` | `1.6110 GiB` (`1,729,751,360` B) | `+1.490 GiB` | Git-ignored Rust Cargo target directories (.gitignore:27:target, reparse=0); D:\opencode source and all 6,326 pnpm links preserved untouched. |
| `B12-drive-stray-unix-and-test-temp` | `D:\dev\null, D:\var\tmp\herdr-render-35416-*, D:\tmp\*` | `stray_unix_paths_and_stale_test_temp` | `284` | `140` | `0.0000 GiB` (`23,298` B) | `-0.0003 GiB` | Stray POSIX /dev/null redirect artifact (36 B), /var/tmp dead PID test JSONs (611 B), and dead PID unit-test scratch in D:\tmp (22,651 B); 0 open handles; empty D:\dev, D:\tmp, D:\var\tmp containers retained. |

---

## 4. Complete Folder-by-Folder Retention Ledger Across `D:\` and `D:\OmniaData` / Danh Mục Giữ Lại Toàn Bộ Thư Mục Trên Ổ `D:\`

### 4.1 All 14 Top-Level Entries on `D:\` (100% Accounted For)

| Top-Level Path on `D:\` | Kind | Post-Clean Files | Post-Clean Dirs | Post-Clean Size | Reparse Skipped | Disposition & Retention Justification (EN / VI) |
|---|---|---:|---:|---:|---:|---|
| `D:\$RECYCLE.BIN` | `dir` | `OS-protected` | `OS-protected` | `OS-protected` | `—` | `retained` — OS Recycle Bin; per `repo-hygiene-and-artifact-lifecycle`, never emptied during automated cleanup |
| `D:\.pnpm-store` | `dir` | `122,095` | `259` | `2.8416 GiB` (`3,051,185,697` B) | `4` | `retained` — Active content-addressable pnpm store (`v3`/`v10`, `2.84 GiB`) backing `6,326` hardlinks/junctions in `D:\opencode` |
| `D:\CodexBetaPatched` | `dir` | `53,982` | `6,436` | `40.2110 GiB` (`43,176,182,411` B) | `0` | `retained_after_541.76_GiB_reclamation` — Live patched Codex Desktop install + latest backup `app.20261013-163324` + `32.49 GiB` `codex-sessions` history (see Section 4.2) |
| `D:\dev` | `dir` | `0` | `0` | `0` B | `0` | `retained_empty_container` — Stray `36 B` `D:\dev\null` removed (`B12`); `0`-byte folder harmlessly retained |
| `D:\HCMUT` | `dir` | `14,612` | `2,380` | `2.1815 GiB` (`2,342,325,083` B) | `0` | `retained` — Active user academic coursework & project workspace (`2.18 GiB`, `14,612` files) — strictly off-limits |
| `D:\htmustc-proxy` | `dir` | `1,559` | `194` | `140.62 MiB` (`147,453,031` B) | `0` | `retained` — Active user proxy repository (`0.14 GiB`, `1,559` files) — strictly off-limits |
| `D:\Omnia` | `dir` | `2,755` | `340` | `17.01 MiB` (`17,834,687` B) | `0` | `retained_cleaned_cpp20` — Primary Omnia Native C++20 repository (`17.0 MiB` incl. `.git`); legacy Rust/Vite clutter removed in Action A |
| `D:\OmniaData` | `dir` | `1,051,922` | `122,731` | `61.3797 GiB` (`65,905,992,118` B) | `20,199` | `retained_after_255.79_GiB_reclamation` — Canonical externalized data, out-of-source C++20 builds, Git worktrees, QA receipts, and recovery archives (`61.38 GiB`; see Section 4.3) |
| `D:\opencode` | `dir` | `146,973` | `18,677` | `6.9408 GiB` (`7,452,596,439` B) | `6,326` | `retained_except_gitignored_rust_targets` — User `opencode` monorepo (`6.94 GiB`, `6,326` pnpm links intact); only git-ignored `rust/{ultra-core,ultra-desktop}/target` (`1.61 GiB`) removed |
| `D:\Recovery` | `dir` | `OS-protected` | `OS-protected` | `OS-protected` | `—` | `retained` — Windows Recovery Environment (`WinRE`) boot partition image (`OS-protected`) |
| `D:\Recovery.txt` | `file` | `1` | `0` | `0` B | `0` | `retained` — `0`-byte Windows OEM recovery marker file at drive root |
| `D:\System Volume Information` | `dir` | `OS-protected` | `OS-protected` | `OS-protected` | `—` | `retained` — NTFS volume shadow copy / system metadata (`SYSTEM` ACL protected) |
| `D:\tmp` | `dir` | `0` | `0` | `0` B | `0` | `retained_empty_container` — Dead-PID test scratch (`22,651` B) cleaned in `B12`; `0`-byte container retained |
| `D:\var` | `dir` | `0` | `1` | `0` B | `0` | `retained_empty_container` — Dead-PID `var\tmp\herdr-render-35416-*` (`611` B) cleaned in `B12`; empty `var\tmp` skeleton retained |

### 4.2 `D:\CodexBetaPatched` Post-Cleanup Breakdown (`40.2110 GiB` Retained After Reclaiming `541.7623 GiB`)

| Path Inside `D:\CodexBetaPatched` | Kind | Files | Dirs | Measured Size | Why Retained |
|---|---|---:|---:|---:|---|
| `D:\CodexBetaPatched\.update` | `dir` | `0` | `0` | `0` B | `0`-byte staging root after purging `293` stale `202609*`/`202610*` folders (`14.79 GiB` in `B2`) |
| `D:\CodexBetaPatched\app` | `dir` | `10,137` | `1,322` | `1.8493 GiB` (`1,985,720,403` B) | Live unpacked Electron application runtime for CodexBetaPatched |
| `D:\CodexBetaPatched\archive` | `dir` | `11,011` | `45` | `33.5150 GiB` (`35,986,486,107` B) | Historical `c-cleanup-20260927` archive: `codex-sessions` (`32.49 GiB`), `documents-codex`, and `user-artifacts` preserved after purging `temp` + `2` unpacked `node_modules` (`1.30 GiB` in `B4`) |
| `D:\CodexBetaPatched\backup` | `dir` | `21,567` | `1,743` | `3.9717 GiB` (`4,264,577,144` B) | Single latest rollback snapshot `updates\app.20261013-163324` (`1.85 GiB`) + `app.asar.CodexBetaPatched.original` (`0.22 GiB`) + original patch backups preserved after purging `284` older duplicate `app.*` snapshots (`525.29 GiB` in `B1`) |
| `D:\CodexBetaPatched\backups` | `dir` | `11` | `3` | `300,312` B | Small patch configuration backup files preserved intact |
| `D:\CodexBetaPatched\codex-home` | `dir` | `7,060` | `2,795` | `238.63 MiB` (`250,223,995` B) | Live CodexBetaPatched configuration, auth metadata, and home state |
| `D:\CodexBetaPatched\logs` | `dir` | `1,341` | `0` | `2.95 MiB` (`3,091,209` B) | Application diagnostic and patch runtime logs |
| `D:\CodexBetaPatched\patch-state.json` | `file` | `1` | `0` | `2,231` B | Active patch metadata state file |
| `D:\CodexBetaPatched\tools` | `dir` | `436` | `10` | `453.84 MiB` (`475,889,421` B) | Bundled CLI and runtime helper binaries |
| `D:\CodexBetaPatched\user-data-live` | `dir` | `2,418` | `509` | `200.17 MiB` (`209,891,589` B) | Active Chromium/Electron profile & local session storage |

### 4.3 All 13 `D:\OmniaData` Subentries & Child Trees (`61.3797 GiB` Retained After Reclaiming `255.7863 GiB`)

| Path Inside `D:\OmniaData` | Kind | Files | Dirs | Measured Size | Reparse Skipped | Retention Justification & Wave 4 Delta |
|---|---|---:|---:|---:|---:|---|
| `D:\OmniaData\archive` | `dir` | `10,653` | `458` | `4.5697 GiB` (`4,906,673,500` B) | `0` | Canonical `.asar`/`.msix`/`.exe` patch archives + `MANIFEST.json` (`4.57 GiB`) retained after removing `6.00 GiB` `omnia-rust-target-debug` + `0.71 GiB` duplicate unpacked `.asar`/`.nupkg` folders (`B7`) |
| `D:\OmniaData\build` | `dir` | `271` | `122` | `419.97 MiB` (`440,373,229` B) | `0` | Active out-of-source C++20 CMake + Ninja Debug/Release build trees (`omnia-cpp-core-{debug,release}`, `omnia-cpp-native-{debug,release}`, `0.41 GiB`) |
| `D:\OmniaData\exports` | `dir` | `2,276` | `111` | `60.12 MiB` (`63,035,524` B) | `0` | Cross-host FTS5 conversation history export (`exports\history`) + `root-r3-8d2ad69` snapshot & receipt (`60.1 MiB`) |
| `D:\OmniaData\externalized-20261112` | `dir` | `33,438` | `5,786` | `3.8521 GiB` (`4,136,120,533` B) | `0` | Wave 1 relocated non-product roots (`3.85 GiB` retained after reclaiming `14.62 GiB` in `B8`): canonical `backups\omnia-dirty-trees-Qo2K58\00..03\repository.bundle` + `git-bundles`, original installers in `downloads`, `.agents` operational logs, and ACL-locked `CursorApp` (`1.01 GiB`) |
| `D:\OmniaData\projects` | `dir` | `17,446` | `2,069` | `555.08 MiB` (`582,041,675` B) | `0` | Externalized `omnia-public` reference tree (`0.54 GiB`, `17,446` files) recorded in [EXTERNAL_LAYOUT.json](EXTERNAL_LAYOUT.json) |
| `D:\OmniaData\qa` | `dir` | `308` | `123` | `11.85 MiB` (`12,421,393` B) | `0` | Authoritative Wave 1–4 QA & audit evidence (`audits-20261112`, `cpp-native-precheck-20261112`, `deep-clean-20261112`, `github-clean-clone-20261112\GITHUB_DELIVERY_AND_CLONE_RECEIPT.json`, `native`, `native-20261112*`, `ui-direction-20261112`) after removing `2` ephemeral clone dirs + superseded `native-precheck-20261112` (`B9`) |
| `D:\OmniaData\quarantine` | `dir` | `18,386` | `2,568` | `185.29 MiB` (`194,292,039` B) | `0` | Preserved historical review quarantines (`cleanup-20261013` `185.0 MiB`, `cleanup-20261110`, `manual`, `omnia-clean-20261112\root-scratch-20261112-033528`) after purging `.pytest_cache` (`495 KB` in `B10`) |
| `D:\OmniaData\README.md` | `file` | `1` | `0` | `1,587` B | `0` | `D:\OmniaData` external layout index document (`1,587` B) |
| `D:\OmniaData\recovery` | `dir` | `1,816` | `332` | `1.2514 GiB` (`1,343,671,904` B) | `0` | Canonical recovery stores (`harness-budget-before-20261102` `1.25 GiB`, `unique-source-deltas-20261112` `84/84` SHA-256 deltas, and `pre-cpp-ignored-files-20261112` `2` `.mjs` scripts) |
| `D:\OmniaData\repos` | `dir` | `929,815` | `107,172` | `49.5225 GiB` (`53,174,375,391` B) | `20,198` | `D:\OmniaData\repos\omnia` (`49.52 GiB`, `20,198` preserved internal `upstream_extractions` junctions): common `.git` object store for `4` healthy worktrees (`git worktree list` `rc=0`) after reclaiming `221.74 GiB` git-ignored `src-tauri/{target,target-ide}` (`B5`) |
| `D:\OmniaData\research` | `dir` | `35,071` | `3,787` | `949.62 MiB` (`995,745,374` B) | `0` | Source reconciliation, Wave 1 root/worktree/drive receipts (`omnia-clean-2026-11-12`), `111`-URL qualification ledgers (`url-qualification-20261112`), and reference research repos (`0.93 GiB`) |
| `D:\OmniaData\tools` | `dir` | `48` | `18` | `13.96 MiB` (`14,638,838` B) | `0` | Retained `7zip`, `legacy`, and `migration` helpers (`13.96 MiB`) after purging obsolete `12.63 GiB` Rust `cargo-target` (`B6`) |
| `D:\OmniaData\worktrees` | `dir` | `2,393` | `173` | `40.63 MiB` (`42,601,131` B) | `1` | Linked release worktree `D:\OmniaData\worktrees\publish-worktree` (`40.6 MiB`, `133 == 133` porcelain entries intact) |

### 4.4 Post-Cleanup Git Worktree Topology Verification (`4/4` Healthy)

```text
D:/OmniaData/repos/omnia                                          55f21dac [omnia/m0-snapshot]
<USERPROFILE>/.codex/worktrees/omnia-goal-control                12f0ab72 [codex/omnia-goal-control-20261109]
<USERPROFILE>/.codex/worktrees/omnia-ui-rebuild/publish-worktree a3d15b64 [codex/omnia-original-rebuild]
D:/OmniaData/worktrees/publish-worktree                           ca8dfa32 [codex/release-v0.1.13]
```

- `git -C "D:\OmniaData\repos\omnia" worktree list` exited `0` (`4/4` linked checkouts healthy; `publish-worktree` status count preserved at `133`).
- `D:\OmniaData\qa\github-clean-clone-20261112\GITHUB_DELIVERY_AND_CLONE_RECEIPT.json` verified intact (`sha256=35aaac06a396bfc60e6d8a9bc893ccaf28c1f298c2ed958f344bdffc9285e610`).

---

## 5. Honest ACL Boundaries (`WinError 5`) & Optional Elevated UAC Remediation

Non-elevated cleanup strictly respected Windows DACL security boundaries without attempting privilege bypasses. Two stale-ACL directories returned `[WinError 5] Access is denied` and are documented with exact optional Administrator commands:

1. **`D:\Omnia\Roaming`** (`0` readable bytes non-elevated; ignored via `Roaming/` in [`.gitignore`](../../.gitignore)):
   - **Cause**: Owned by orphaned prior Windows installation SID `S-1-5-21-3752430534-...-1001`.
   - **Optional Elevated PowerShell Command**:
     ```powershell
     takeown /F "D:\Omnia\Roaming" /R /D Y
     icacls "D:\Omnia\Roaming" /grant "$env:USERNAME:(OI)(CI)F" /T /C
     Move-Item -LiteralPath "D:\Omnia\Roaming" -Destination "D:\OmniaData\externalized-20261112\Roaming"
     ```
2. **`D:\OmniaData\externalized-20261112\CursorApp`** (`21,261` files, `4,363` dirs, `1,087,695,222` B = `1.0130 GiB`):
   - **Cause**: Duplicate extracted Cursor Electron binary directory (relocated out of `D:\Omnia` during Wave 1) carrying restrictive DACLs on `locales\*.pak` and application binaries from an elevated/foreign-SID install.
   - **Optional Elevated PowerShell Command** (reclaims an additional `~1.01 GiB` if desired):
     ```powershell
     takeown /F "D:\OmniaData\externalized-20261112\CursorApp" /R /D Y
     icacls "D:\OmniaData\externalized-20261112\CursorApp" /grant "$env:USERNAME:(OI)(CI)F" /T /C
     cmd /c rd /s /q "D:\OmniaData\externalized-20261112\CursorApp"
     ```
