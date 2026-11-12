# Exhaustive Evidence-First `C:\` Drive Deep Clean Audit / Báo Cáo Kiểm Toán & Dọn Sạch Chuyên Sâu Ổ `C:\`

- **Date / Ngày thực hiện**: `2026-11-12` (`Wave 4 — Additive User Steer`)
- **Owner / Tác nhân thực thi**: `c-drive-cleaner`
- **Governed By / Quy chuẩn áp dụng**: `deep-clean`, `repo-hygiene-and-artifact-lifecycle`
- **Machine-Readable Receipt / Biên bản JSON**: `D:\OmniaData\qa\deep-clean-20261112\C_DRIVE_DEEP_CLEAN_RECEIPT.json` (`48,134` B, `sha256=ee08c5a0fdd87b67ff3e8b04630d6f62ca249e20fbd6b7af802440fd354060eb`)

---

## 1. Executive Summary / Tóm Tắt Kết Quả Thu Hồi Dung Lượng

**English**: Prior to cleanup, volume `C:` (`476.1728 GiB` total) was critically full with `452.7047 GiB` (`95.07%`) used and only **`23.4682 GiB` (`4.93%`) free**. Following strict `deep-clean` provenance, `.gitignore`, open-handle, hardlink (`GetFileInformationByHandle`), and NTFS reparse-point (`FILE_ATTRIBUTE_REPARSE_POINT = 0x400` + `robocopy /XJ`) verification across `6` serialized batches, **`183.6900 GiB` (`197,235,628,066` logical bytes across `1,371,966` files and `260,984` directories)** of proven regenerable build outputs, orphaned/superseded Cargo targets, duplicate isolated test-restore trees, package manager download caches, and stale (`> 6h`) unlocked `%TEMP%` artifacts were permanently reclaimed. Volume `C:` free space increased to **`189.6039 GiB` (`203,585,679,360` bytes, `39.82%` free)** — a net physical gain of **`+166.1357 GiB` (`+178,386,935,808` bytes)** with **zero** mutations to user source code, active servers, credentials, recovery stores, skills, or OS files.

**Tiếng Việt**: Trước khi dọn dẹp, ổ `C:` (tổng dung lượng `476.1728 GiB`) ở trạng thái đầy nghiêm trọng với `452.7047 GiB` (`95.07%`) đã sử dụng và chỉ còn trống **`23.4682 GiB` (`4.93%`)**. Áp dụng nghiêm ngặt quy trình `deep-clean` (kiểm tra nguồn gốc, `.gitignore`, tiến trình đang chạy, hardlink qua `GetFileInformationByHandle`, và chống đi xuyên reparse-point/junction bằng `FILE_ATTRIBUTE_REPARSE_POINT = 0x400` + `robocopy /XJ`) qua `6` đợt tuần tự có đo `Get-PSDrive C` trước/sau từng đợt, hệ thống đã xóa an toàn **`183.6900 GiB` (`197,235,628,066` byte logic thuộc `1,371,966` tệp và `260,984` thư mục)** gồm thư mục biên dịch `target`/`node_modules` bị git-ignore, bộ nhớ đệm Cargo mồ côi/đã thay thế bởi kiến trúc C++20, cây giải nén kiểm thử trùng lặp, bộ đệm tải gói công cụ lập trình, và tệp tạm `%TEMP%` quá hạn (`> 6 giờ`, không bị khóa). Dung lượng trống vật lý trên ổ `C:` tăng vọt lên **`189.6039 GiB` (`203,585,679,360` byte, trống `39.82%`)** — thu hồi thực tế **`+166.1357 GiB` (`+178,386,935,808` byte)** mà **không chạm vào bất kỳ** mã nguồn người dùng, ứng dụng đang chạy, khóa bảo mật, kho khôi phục gốc, thư viện kỹ năng hay tệp hệ điều hành nào.

| Metric / Chỉ số (`Get-PSDrive C`) | Before / Trước khi dọn | After / Sau khi dọn | Delta / Thay đổi |
|---|---:|---:|---:|
| **Total Capacity / Tổng dung lượng** | `476.1728 GiB` (`511,286,702,080` B) | `476.1711 GiB` (`511,284,867,072` B) | `0 B` |
| **Used Space / Đã dùng** | `452.7047 GiB` (`486,087,958,528` B) | `286.5388 GiB` (`307,668,729,856` B) | `-166.1659 GiB` (`-178,419,228,672` B) |
| **Free Space / Còn trống** | **`23.4682 GiB`** (`25,198,743,552` B) | **`189.6302 GiB`** (`203,613,908,992` B) | **`+166.1621 GiB`** (`+178,415,165,440` B) |
| **Logical Deleted / Tổng xóa logic** | — | — | **`183.6900 GiB`** (`197,235,628,066` B; `1,371,966` files; `260,984` dirs) |

> [!NOTE]
> **Logical Bytes vs. Physical NTFS Free Delta (`183.6900 GiB` logical vs. `+166.2505 GiB` immediate batch cluster delta)**: Rust Cargo incremental target directories (`publish-worktree\src-tauri\target`, `C:\t-alpha`) and Bun's global install cache (`C:\Users\khang\.bun\install\cache`) create same-volume NTFS hardlinks (`nNumberOfLinks > 1`) between `deps/`/`.o` artifacts and linked project packages. Per `deep-clean`, unlinking one directory entry of a multi-linked file reduces physical disk usage only when the final hardlink on volume `C:` is removed.

---

## 2. Per-Batch `Get-PSDrive C` Telemetry / Đo Lường Trước & Sau Từng Đợt

| Batch | Scope / Phạm vi | Before Free (`GiB`) | After Free (`GiB`) | Physical Free Delta (`GiB` / `B`) | Logical Deleted (`GiB` / `B`) | Files Deleted | Elapsed |
|---|---|---:|---:|---:|---:|---:|---:|
| `BATCH-01` | Codex publish-worktree git-ignored build & dependency caches | `23.4527` | `89.8409` | **`+66.3881 GiB`** (`+71,283,728,384` B) | `74.2904 GiB` (`79,768,674,324` B) | `61,322` | `37.11s` |
| `BATCH-02` | Orphaned & superseded Rust Cargo target caches and stray C:\c Cargo cache | `89.8191` | `119.9465` | **`+30.1275 GiB`** (`+32,349,134,848` B) | `32.6030 GiB` (`35,007,181,677` B) | `143,123` | `124.52s` |
| `BATCH-03` | Quarantined Cargo targets & materialized duplicate restore verification trees | `119.9465` | `133.2168` | **`+13.2702 GiB`** (`+14,248,783,872` B) | `12.8612 GiB` (`13,809,632,246` B) | `193,423` | `166.70s` |
| `BATCH-04` | Developer toolchain regenerable download & build caches | `133.2159` | `142.7577` | **`+9.5417 GiB`** (`+10,245,373,952` B) | `12.0785 GiB` (`12,969,242,330` B) | `237,068` | `313.94s` |
| `BATCH-05` | %TEMP% stale (>6h), unlocked, non-protected temporary directories & files | `142.6536` | `188.7201` | **`+46.0665 GiB`** (`+49,463,533,568` B) | `50.9484 GiB` (`54,705,417,081` B) | `734,249` | `977.21s` |
| `BATCH-06` | Documents\ChatGPT\Google Drive Downloader git-ignored Rust target cache | `188.7200` | `189.5765` | **`+0.8565 GiB`** (`+919,683,072` B) | `0.9085 GiB` (`975,480,408` B) | `2,781` | `4.60s` |

---

## 3. Itemized Reclaimed Paths & Provenance Proof / Chi Tiết Từng Đường Dẫn Đã Dọn Sạch

### 3.1 All 27 Reclaimed Targets Across Batches 1–6 / Danh Mục 27 Mục Đã Xóa

| Batch | Reclaimed Path / Đường dẫn | Class / Phân loại | Logical Size (`GiB` / `Bytes`) | Files | Dirs | Provenance & Safety Proof / Bằng chứng an toàn |
|---|---|---|---:|---:|---:|---|
| `BATCH-01` | `C:\Users\khang\.codex\worktrees\omnia-ui-rebuild\publish-worktree\src-tauri\target` | `generated_build_cache` | `69.6910 GiB` (`74,830,170,567` B) | `41,926` | `2,762` | Git-ignored legacy Tauri Rust Cargo build target (.gitignore:12:target/) |
| `BATCH-01` | `C:\Users\khang\.codex\worktrees\omnia-ui-rebuild\publish-worktree\native\target` | `generated_build_cache` | `4.4194 GiB` (`4,745,303,530` B) | `7,795` | `861` | Git-ignored legacy native Rust Cargo build target (native/.gitignore:1:/target/) |
| `BATCH-01` | `C:\Users\khang\.codex\worktrees\omnia-ui-rebuild\publish-worktree\node_modules` | `generated_build_cache` | `0.1799 GiB` (`193,200,227` B) | `11,601` | `944` | Git-ignored npm node_modules dependency tree (.gitignore:1:node_modules/) |
| `BATCH-02` | `C:\t-alpha` | `orphaned_cargo_target` | `11.7795 GiB` (`12,648,161,278` B) | `10,789` | `1,744` | Orphaned root Rust Cargo release target directory (.rustc_info.json + release/; 0 .git, 0 PATH/env refs) |
| `BATCH-02` | `C:\Users\khang\.codex\cache\omnia-root-tauri-target` | `obsolete_cargo_target_cache` | `9.7912 GiB` (`10,513,253,556` B) | `6,113` | `755` | Obsolete Rust Cargo Tauri target cache superseded by Omnia C++20 migration & archive/pre-cpp-rust-snapshot-20261112 |
| `BATCH-02` | `C:\Users\khang\.codex\cache\omnia-root-native-target` | `obsolete_cargo_target_cache` | `3.4737 GiB` (`3,729,865,349` B) | `3,957` | `359` | Obsolete Rust Cargo native target cache superseded by Omnia C++20 migration & archive/pre-cpp-rust-snapshot-20261112 |
| `BATCH-02` | `C:\c` | `stray_cargo_home_cache` | `7.5585 GiB` (`8,115,901,494` B) | `122,264` | `20,596` | Stray MSYS/POSIX /c Cargo registry & git checkout cache (.global-cache, git/checkouts, git/db, registry; CARGO_HOME is unset) |
| `BATCH-03` | `C:\Users\khang\.codex\quarantine\omnia-d-clean-20261110\.cargo-target-filewatch` | `quarantined_cargo_target` | `3.7128 GiB` (`3,986,605,268` B) | `5,039` | `733` | Quarantined Rust Cargo target directory from 2026-11-10 D-clean (CACHEDIR.TAG + debug/) |
| `BATCH-03` | `C:\Users\khang\.codex\quarantine\omnia-d-clean-20261110\.cargo-target-pointer` | `quarantined_cargo_target` | `1.3789 GiB` (`1,480,571,426` B) | `4,185` | `794` | Quarantined Rust Cargo target directory from 2026-11-10 D-clean (.rustc_info.json + CACHEDIR.TAG + debug/) |
| `BATCH-03` | `C:\Users\khang\.codex\recovery\omnia-root-r10-restore-20261111\common_git` | `duplicate_restore_materialization` | `1.1405 GiB` (`1,224,572,426` B) | `1,679` | `289` | Materialized duplicate test-restore copy (links=1) verified by RESTORE.json; canonical store omnia-root-r10-20261111 & RESTORE.json/receipts retained |
| `BATCH-03` | `C:\Users\khang\.codex\recovery\omnia-root-r10-restore-20261111\goal_control` | `duplicate_restore_materialization` | `0.0518 GiB` (`55,638,381` B) | `3,029` | `254` | Materialized duplicate test-restore copy (links=1) verified by RESTORE.json; canonical store omnia-root-r10-20261111 & RESTORE.json/receipts retained |
| `BATCH-03` | `C:\Users\khang\.codex\recovery\omnia-root-r10-restore-20261111\primary` | `duplicate_restore_materialization` | `6.3289 GiB` (`6,795,557,609` B) | `172,415` | `21,883` | Materialized duplicate test-restore copy (links=1) verified by RESTORE.json; canonical store omnia-root-r10-20261111 & RESTORE.json/receipts retained |
| `BATCH-03` | `C:\Users\khang\.codex\recovery\omnia-root-r10-restore-20261111\rebuild` | `duplicate_restore_materialization` | `0.2159 GiB` (`231,796,772` B) | `4,854` | `532` | Materialized duplicate test-restore copy (links=1) verified by RESTORE.json; canonical store omnia-root-r10-20261111 & RESTORE.json/receipts retained |
| `BATCH-03` | `C:\Users\khang\.codex\recovery\omnia-root-r10-restore-20261111\release` | `duplicate_restore_materialization` | `0.0325 GiB` (`34,890,364` B) | `2,222` | `163` | Materialized duplicate test-restore copy (links=1) verified by RESTORE.json; canonical store omnia-root-r10-20261111 & RESTORE.json/receipts retained |
| `BATCH-03` | `C:\Users\khang\.codex\recovery\omnia-root-r10-restore-20261111\empty-home` | `duplicate_restore_materialization` | `0.0000 GiB` (`0` B) | `0` | `0` | Empty sandbox home directory inside isolated test restore |
| `BATCH-03` | `C:\Users\khang\.codex\recovery\omnia-root-r10-restore-20261111\empty-hooks` | `duplicate_restore_materialization` | `0.0000 GiB` (`0` B) | `0` | `0` | Empty git-hooks directory inside isolated test restore |
| `BATCH-04` | `C:\Users\khang\.cargo\registry\cache` | `package_manager_cache` | `0.1489 GiB` (`159,933,575` B) | `1,014` | `1` | Regenerable Cargo crate .crate archive download cache (.cargo/bin untouched) |
| `BATCH-04` | `C:\Users\khang\.cargo\registry\src` | `package_manager_cache` | `1.0961 GiB` (`1,176,875,959` B) | `44,996` | `10,951` | Regenerable Cargo unpacked crate source cache (.cargo/bin untouched) |
| `BATCH-04` | `C:\Users\khang\.cargo\git\checkouts` | `package_manager_cache` | `2.4492 GiB` (`2,629,817,303` B) | `38,617` | `4,969` | Regenerable Cargo git dependency checkout cache (.cargo/bin untouched) |
| `BATCH-04` | `C:\Users\khang\.cargo\git\db` | `package_manager_cache` | `1.8555 GiB` (`1,992,335,076` B) | `501` | `259` | Regenerable Cargo bare git repository cache (.cargo/bin untouched) |
| `BATCH-04` | `C:\Users\khang\.bun\install\cache` | `package_manager_cache` | `3.5616 GiB` (`3,824,274,771` B) | `130,343` | `14,055` | Regenerable Bun package install cache |
| `BATCH-04` | `C:\Users\khang\AppData\Local\npm-cache\_cacache` | `package_manager_cache` | `1.6546 GiB` (`1,776,626,756` B) | `7,647` | `7,916` | Regenerable npm content-addressable HTTP/tarball cache |
| `BATCH-04` | `C:\Users\khang\AppData\Local\go-build` | `package_manager_cache` | `0.8155 GiB` (`875,676,930` B) | `8,909` | `256` | Regenerable Go compiler build artifact cache |
| `BATCH-04` | `C:\Users\khang\AppData\Local\pip\Cache` | `package_manager_cache` | `0.3491 GiB` (`374,806,714` B) | `911` | `1,570` | Regenerable Python pip HTTP/wheel cache |
| `BATCH-04` | `C:\Users\khang\AppData\Local\uv\cache` | `package_manager_cache` | `0.1480 GiB` (`158,895,246` B) | `4,130` | `419` | Regenerable Astral uv package & wheel cache |
| `BATCH-05` | `C:\Users\khang\AppData\Local\Temp\<stale_gt_6h_unlocked>` | `os_temp_stale_gt_6h` | `50.9484 GiB` (`54,705,417,081` B) | `734,249` | `167,416` | Stale (>6h) unlocked temporary build/test/installer artifacts in %TEMP%; skipped <=6h items and antigravity*/exebox*/codex*/gemini* |
| `BATCH-06` | `C:\Users\khang\Documents\ChatGPT\Google Drive Downloader\idm_omnia_import\target` | `generated_build_cache` | `0.9085 GiB` (`975,480,408` B) | `2,781` | `503` | Git-ignored Rust Cargo target cache (.gitignore:23:idm_omnia_import/target/); live Google Drive Downloader server.js, node_modules, downloads, and 981-file idm_omnia_import manifest verified intact |

### 3.2 Top 20 Largest Reclaimed Stale (`> 6h`) `%TEMP%` Entries (`BATCH-05`) / 20 Mục Tạm Lớn Nhất Trong `%TEMP%`

| Rank | `%TEMP%` Entry Name | Type | Logical Size | Files | Stale Age (`hours`) | Reason / Lý do |
|---:|---|---|---:|---:|---:|---|
| `1` | `claude` | `dir` | `12.4219 GiB (13,337,908,882 B)` | `12,312` | `8.55h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `2` | `omnia-hermes-pm-323e68b6b96f4ab299a7f3ba765f59dc` | `dir` | `2.4356 GiB (2,615,163,050 B)` | `52,631` | `41.89h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `3` | `omnia-openhands-native-ui-tdhNQx` | `dir` | `1.3659 GiB (1,466,572,152 B)` | `70,331` | `180.86h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `4` | `omnia-openhands-packaged-home-6a4b2f67bd2540f38256d3ba2aa48d43` | `dir` | `1.3624 GiB (1,462,916,327 B)` | `69,752` | `186.29h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `5` | `omnia-openhands-dispatch-Z0enmx` | `dir` | `1.2293 GiB (1,319,927,382 B)` | `63,935` | `185.14h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `6` | `omnia-openhands-packaged-persistence-R023xc` | `dir` | `1.1964 GiB (1,284,598,537 B)` | `60,449` | `185.24h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `7` | `omnia-openhands-packaged-persistence-jMDhxk` | `dir` | `1.1913 GiB (1,279,187,586 B)` | `60,466` | `185.27h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `8` | `omnia-openhands-packaged-persistence-aZ2JUw` | `dir` | `1.1819 GiB (1,269,005,140 B)` | `60,529` | `185.30h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `9` | `omnia-openhands-ui-20261105` | `dir` | `991.70 MiB (1,039,872,207 B)` | `45,641` | `185.96h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `10` | `omnia-vscode-official-runtime-PAX8tq` | `dir` | `973.53 MiB (1,020,819,799 B)` | `2,787` | `181.93h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `11` | `omnia-vscode-official-runtime-gKOu3N` | `dir` | `972.38 MiB (1,019,618,362 B)` | `2,768` | `181.96h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `12` | `omnia-vscode-official-runtime-FEeBgR` | `dir` | `968.95 MiB (1,016,014,140 B)` | `2,782` | `165.99h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `13` | `26920af.msp` | `file` | `912.04 MiB (956,342,272 B)` | `1` | `694.89h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `14` | `omnia-opencode-prepackaged-input-0a60910adbd0468693cb809307f689be` | `dir` | `864.33 MiB (906,314,181 B)` | `93` | `165.12h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `15` | `omnia-ui-cycle9-1d60c13814ac496ba3ff5512b7e86fdb` | `dir` | `685.53 MiB (718,834,012 B)` | `15,140` | `100.27h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `16` | `V9L85Xdws-VfP5vWu7FTl` | `dir` | `622.59 MiB (652,837,467 B)` | `11,890` | `123.19h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `17` | `omnia-vscode-official-runtime-bUYaJq` | `dir` | `607.15 MiB (636,639,206 B)` | `897` | `160.55h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `18` | `omnia-cherry-stream-qfbUHB` | `dir` | `596.08 MiB (625,036,360 B)` | `252` | `160.00h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `19` | `omnia-opencode-packaged-provider-ymdKse` | `dir` | `542.97 MiB (569,343,870 B)` | `143` | `165.26h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |
| `20` | `omnia-cherry-native-TX5o3S` | `dir` | `499.44 MiB (523,704,755 B)` | `266` | `186.95h` | Unlocked temporary test/build/installer artifact (`> 6h` across entire subtree; `0` active processes) |

- **Protected & Active `%TEMP%` Exclusions Honored (`BATCH-05`)**: Strictly skipped every entry matching `antigravity*`, `exebox*`, `codex*`, `gemini*`, every NTFS reparse point, every file/subtree modified within the last `6` hours (`102` entries / `71,043,983` B), and cleanly bypassed `1,928` OS/process-locked items via `PermissionError`/`OSError` handling with `0` crashes.

---

## 4. Complete Folder-by-Folder Retention Ledger on `C:\` / Danh Mục Giữ Lại Toàn Bộ Thư Mục Trên Ổ `C:\`

### 4.1 Top-Level `C:\` Root Entries (Post-Cleanup Verified: `C:\c` and `C:\t-alpha` Removed, All 25 Legitimate Entries Retained)

| Path on `C:\` | Category | Measured Size | Disposition | Retention Justification (EN / VI) |
|---|---|---:|---|---|
| `C:\Windows` | `os_system` | `28.5000 GiB` | `retained` | Windows 11 OS kernel, System32, WinSxS component store, and system drivers |
| `C:\Program Files` | `installed_applications` | `16.1389 GiB` | `retained` | Active 64-bit installed applications, MSVC/SDK toolchains, Git, browsers |
| `C:\Program Files (x86)` | `installed_applications` | `13.6569 GiB` | `retained` | Active 32-bit installed applications, Windows Kits, Visual Studio Installer |
| `C:\ProgramData` | `os_application_data` | `2.6932 GiB` | `retained` | Shared machine-wide application configs, Microsoft Defender signatures, package metadata |
| `C:\pagefile.sys` | `os_virtual_memory` | `15.8350 GiB` | `retained` | Active Windows virtual memory paging file (kernel-locked) |
| `C:\hiberfil.sys` | `os_power_state` | `6.3340 GiB` | `retained` | Active Windows Fast Startup / hibernation image (kernel-locked) |
| `C:\swapfile.sys` | `os_virtual_memory` | `0.0156 GiB` | `retained` | Active Windows modern-app swap file (kernel-locked) |
| `C:\System Volume Information` | `os_ntfs_metadata` | `OS-protected` | `retained` | NTFS volume shadow copy / system restore metadata (SYSTEM ACL protected) |
| `C:\Recovery` | `os_recovery` | `OS-protected` | `retained` | Windows Recovery Environment (WinRE) boot image |
| `C:\$Recycle.Bin` | `user_recycle_bin` | `OS-protected` | `retained` | Per repo-hygiene-and-artifact-lifecycle hard gate: never empty user Recycle Bin during cleanup |
| `C:\msys64` | `developer_toolchain` | `2.2820 GiB` | `retained` | Active MSYS2 / MinGW64 / Clang64 POSIX & C/C++ development environment |
| `C:\msys64.backup-20261109-041233` | `user_backup_with_credentials` | `0.2651 GiB` | `retained` | Inspected home/khang and found .gnupg, .bash_history, .bashrc; preserved per deep-clean credential & user-history gate |
| `C:\Java` | `developer_toolchain` | `0.4338 GiB` | `retained` | Installed JDK runtime toolchain |
| `C:\Python315` | `developer_toolchain` | `0.1706 GiB` | `retained` | Active system Python 3.15 interpreter used by automation & verification scripts |
| `C:\Temp` | `evidence_and_scratch` | `0.0066 GiB` | `retained` | Contains omnia-ui-research-20261108 & cdptest small research artifacts (6.6 MiB); preserved until owner review |
| `C:\.codex` | `empty_scaffold` | `0.0000 GiB` | `retained` | 0-byte directory skeleton (research/); harmless |
| `C:\msys2-recovery-work` | `empty_scaffold` | `0.0000 GiB` | `retained` | 0-byte empty directory |
| `C:\tmp` | `empty_scaffold` | `0.0000 GiB` | `retained` | 0-byte empty browser-use download directory placeholders |
| `C:\Config.Msi` | `os_installer_state` | `0.0000 GiB` | `retained` | Windows Installer rollback metadata directory |
| `C:\Intel` | `driver_scaffold` | `0.0000 GiB` | `retained` | Intel driver log folder |
| `C:\inetpub` | `os_feature_dir` | `0.0000 GiB` | `retained` | IIS default root folder |
| `C:\PerfLogs` | `os_diagnostics` | `0.0000 GiB` | `retained` | Windows Performance Monitor log root |
| `C:\Documents and Settings` | `os_reparse_junction` | `0.0000 GiB` | `retained` | Windows legacy compatibility NTFS junction pointing to C:\Users |
| `C:\DumpStack.log.tmp` | `os_crash_dump_log` | `0.0001 GiB` | `retained` | Kernel crash-dump stack log (64 KiB, system-locked) |
| `C:\Users` | `user_profiles` | `OS-protected` | `retained_with_scoped_cache_reclamation` | Primary user profile root (C:\Users\khang); only proven disposable caches/targets/stale temp were cleaned inside |

### 4.2 `C:\Users\khang`, `.codex`, `Documents`, and `AppData\Local` Retention Ledger / Chi Tiết Giữ Lại Trong Hồ Sơ Người Dùng

| Retained Path | Measured Post-Clean Size | Disposition | Why Retained (EN / VI) |
|---|---:|---|---|
| `C:\Users\khang\Documents\ChatGPT\Gemini Notebook` | `32.1640 GiB` | `retained` | Active user project & converted media archive (output_converted 20.90 GiB + mhh-upload-20261105 9.65 GiB + .runtime 0.92 GiB + node_modules 0.07 GiB) |
| `C:\Users\khang\Documents\ChatGPT\Google Drive Downloader` | `12.7735 GiB` | `retained_except_gitignored_rust_target` | Live running user app (node server.js PID 8920) + MHH downloads (10.92 GiB) + downloads (1.04 GiB) + node_modules (0.12 GiB) + 981-file idm_omnia_import source; ONLY git-ignored idm_omnia_import/target (0.91 GiB) was reclaimed |
| `C:\Users\khang\Downloads` | `20.2249 GiB` | `retained` | User personal Downloads folder (4,110 files) — strictly off-limits |
| `C:\Users\khang\Documents\Virtual Machines` | `16.3115 GiB` | `retained` | User VMware/virtual machine disk images — strictly off-limits |
| `C:\Users\khang\PC-Research-20261109` | `10.7725 GiB` | `retained` | User research workspace outside authorized disposable cache scope |
| `C:\Users\khang\CrossDevice` | `7.3360 GiB` | `retained` | Windows Cross-Device / Phone Link user media synchronization folder |
| `C:\Users\khang\.codex\recovery\omnia-root-r10-20261111` | `6.4079 GiB` | `retained` | Canonical content-addressed recovery store (SNAPSHOT.json, SUPPLEMENT.json, manifests/, objects/) bound to D:\Omnia\docs\workspace\SOURCE_DISPOSITION_LEDGER.json |
| `C:\Users\khang\.codex\recovery\omnia-root-r10-restore-20261111\{RESTORE.json,receipts}` | `0.0017 GiB` | `retained` | Isolated restore audit receipts (RESTORE.json + 52 JSON receipts) preserved after reclaiming 7.77 GiB of duplicate links=1 materialized test copies |
| `C:\Users\khang\.codex\recovery\btw-01a1b300-8820-7001-b8a1-e4e6a832009d` | `0.0907 GiB` | `retained` | Unique recovered /btw user prompts and V3/V5/V12 planning evidence |
| `C:\Users\khang\Documents\Codex` | `4.1037 GiB` | `retained` | HCMUT CO2011 academic project workspaces & Python .venv environments (0 Cargo target / node_modules bloat) |
| `C:\Users\khang\.claude` | `4.1628 GiB` | `retained` | Claude Code configuration, sessions, and local state |
| `C:\Users\khang\.codex\packages` | `3.7098 GiB` | `retained` | Installed Codex runtime packages |
| `C:\Users\khang\.gemini` | `3.2376 GiB` | `retained` | Active Antigravity / Gemini brain transcripts, config, and global rules (explicitly excluded) |
| `C:\Users\khang\.cache` | `2.8207 GiB` | `retained` | Shared HuggingFace/Playwright/model & tool runtime caches outside explicit purge list |
| `C:\Users\khang\LocalAI` | `2.6542 GiB` | `retained` | User LocalAI models and binaries |
| `C:\Users\khang\.codex\omnia-research` | `2.5936 GiB` | `retained` | Authoritative Omnia setup receipts, source catalogs, and research plans |
| `C:\Users\khang\.rustup` | `2.5448 GiB` | `retained` | Installed Rust toolchains and rustup binaries |
| `C:\Users\khang\.codex\sessions` | `2.2234 GiB` | `retained` | Codex conversation history & session JSONL logs |
| `C:\Users\khang\.codex\worktrees\omnia-ui-rebuild\publish-worktree` | `0.2730 GiB` | `retained_source_and_git` | All tracked/untracked source files, .git link, and 81 git status entries preserved 100% intact after purging git-ignored target/ and node_modules/ |
| `C:\Users\khang\.codex\worktrees\omnia-goal-control` | `0.0518 GiB` | `retained` | Clean Codex git worktree (0 target/ or node_modules/ directories present) |
| `C:\Users\khang\.cargo\bin` | `0.1674 GiB` | `retained` | 14 installed Cargo binaries preserved untouched |
| `C:\Users\khang\.codex\.tmp\bundled-marketplaces` | `0.0150 GiB` | `retained` | Actively referenced by C:\Users\khang\.codex\config.toml |
| `C:\Users\khang\.codex\skills & C:\Users\khang\.agents\skills` | `0.0155 GiB` | `retained` | Curated cross-host agent skill libraries |
| `C:\Users\khang\AppData\Local\{Google,Packages,Programs,Microsoft,strobe,Claude-Data,GitHubDesktop,OpenAI,DiscordCanary,ms-playwright,npm-cache\_npx,...}` | `32.8500 GiB` | `retained` | Active browsers, UWP/MSIX packages, installed user programs, IDE/desktop app state, and npx MCP caches |

---

## 5. Deep-Clean Forensic Decisions & Post-Cleanup Verification Gates / Quyết Định Kiểm Toán & Xác Minh Sau Dọn Dẹp

1. **`C:\Users\khang\.codex\worktrees\omnia-ui-rebuild\publish-worktree` (`74.2904 GiB` logical / `+66.3881 GiB` physical reclaimed)**:
   - Verified `src-tauri\target` (`.gitignore:12:target/`), `native\target` (`native/.gitignore:1:/target/`), and `node_modules` (`.gitignore:1:node_modules/`) via `git check-ignore -v` and `git ls-files` (`0` tracked files inside).
   - Post-cleanup `git status --porcelain=v1` verified **exact `81 == 81` unignored status entries preserved byte-for-byte** (`gitStatusIdentical = true`). Checked `omnia-goal-control` worktree: confirmed `0` `target*`/`node_modules` existed.
2. **`C:\Users\khang\.codex\recovery` (`7.7695 GiB` reclaimed, `6.5003 GiB` canonical recovery + receipts preserved)**:
   - Cross-checked `D:\Omnia\docs\workspace\SOURCE_DISPOSITION_LEDGER.json` (lines `1248–1249`) and `CHECKPOINT.md` (lines `192–210`): `omnia-root-r10-20261111` (`6.4079 GiB`) is the authoritative content-addressed recovery store (`SNAPSHOT.json`, `SUPPLEMENT.json`, `manifests/`, `objects/`) required for `100%` SHA-256 recovery blob readback, and `btw-01a1b300-8820-7001-b8a1-e4e6a832009d` (`0.0907 GiB`) holds unique recovered user prompts — **both retained `100%` untouched**.
   - Inspected `omnia-root-r10-restore-20261111` (`7.7712 GiB`) via Win32 `GetFileInformationByHandle` (`nNumberOfLinks = 1`): proved its 5 materialized worktree copies (`primary`, `common_git`, `rebuild`, `goal_control`, `release`) were standalone duplicate copies extracted solely for the `2026-11-10T23:33:40Z` readback test (`allFileReadbackHashes = pass`). Reclaimed the `7.7695 GiB` duplicate directories while **retaining `RESTORE.json` (`21,847` B) and `receipts\` (`52` JSON receipts, `1.83 MB`)**.
3. **`C:\Users\khang\Documents\{ChatGPT,Codex}` & `C:\msys64.backup-20261109-041233` (`0.9085 GiB` reclaimed, `49.91 GiB` user data/live app preserved)**:
   - Process command-line inspection (`Win32_Process`) caught a **live running `node server.js` process (`PID 8920`)** inside `Documents\ChatGPT\Google Drive Downloader`! Accordingly, `Google Drive Downloader\node_modules` (`0.1155 GiB`), `MHH` (`10.9204 GiB`), `downloads` (`1.0361 GiB`), and `Gemini Notebook` (`output_converted` `20.8989 GiB`, `mhh-upload-20261105` `9.6521 GiB`, `node_modules` `0.0691 GiB`) were kept `100%` untouched.
   - Reclaimed **only** `Google Drive Downloader\idm_omnia_import\target` (`0.9085 GiB`, `.gitignore:23:idm_omnia_import/target/`, `0` tracked files, `0` entries in `idm_omnia_import/manifest.json`), then ran `node scripts/verify_idm_import_manifest.js` -> **`{"ok": true, "checked": 981}`**.
   - Inspected `Documents\Codex` (`4.1037 GiB`): confirmed it holds `CO2011` academic repositories and Python `.venv` environments with `0` Cargo `target/` or `node_modules/` bloat — retained `100%` untouched.
   - Inspected `C:\msys64.backup-20261109-041233\home\khang` (`0.2651 GiB`): discovered `.gnupg` and `.bash_history`; retained `100%` untouched per `deep-clean` credential & history preservation rules.
4. **Toolchain Binaries & Protected Harness Surfaces**:
   - Verified `C:\Users\khang\.cargo\bin` (`14/14` executables intact), `C:\Users\khang\.codex\.tmp\bundled-marketplaces` (referenced by `config.toml`), `C:\Users\khang\.codex\skills`, `C:\Users\khang\.agents\skills`, and `C:\Users\khang\.gemini` are `100%` untouched.
