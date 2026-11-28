# Provenance & Architecture Manifest: `Downloads\Omnia` & 22 Deep-Read Shards

- **Archive Root:** `D:\Omnia\docs\omnia-complete-requirements-archive\`
- **Source Roots Covered:**
  1. `C:\Users\khang\Downloads\Omnia\` — **`3,362` files**, **`207,255,348` bytes** (`197.65 MiB`)
  2. `D:\OmniaData\research\mega-deep-read-20261128\` (`01_*.md`..`22_*.md`) — **`22` core shard reports**, **`1,514,098` bytes** original -> **`1,512,357` bytes** archived
- **Total Materialized Files Tracked Below:** `4` PDFs + `3` root `.md` specs + `11` `htmustc-proxy-docs/*.md` + `22` `deep-read-shards/*.md` = **`40` archived files** (plus this manifest).
- **CI & Security Hygiene Verification:** Verified via `D:\Omnia\tools\omnia-consolidated-audit\audit.py --secret-scope all`: `0` UTF-8 BOMs, `0` CRLF or stray CR bytes, `0` trailing-whitespace lines, `0` merge conflict markers, and `0` non-redacted secret findings.

---

## 1. Top-Level Quantitative Reconciliation (`Downloads\Omnia` = `3,362` Files / `207,255,348` Bytes)

Every file under `C:\Users\khang\Downloads\Omnia\` is accounted for down to the exact byte without touching or committing live secrets, binaries, build caches, or retired C++20 artifacts.

| Top-Level Entry in `Downloads\Omnia` | Total Files | Total Bytes | Archived Disposition | Exclusion / Normalization Disposition |
|---|---:|---:|---|---|
| **Root PDFs (`*.pdf`)** | **4** | **18,358,482** | **4/4 copied verbatim** to `downloads-omnia-docs/` | Byte-for-byte identical SHA-256 (`0` modifications) |
| **Root Markdown (`*.md`)** | **3** | **1,636,512** | **3/3 archived** to `downloads-omnia-docs/` (`1,644,498` B) | Only trailing Google Docs hard breaks `  $` (`53 + 3,748 + 191 = 3,992` lines) converted to `<br>`; LF preserved; 100% prose, headings, prompts, and inline base64 PNGs preserved |
| **`htmustc-proxy/`** (`htmustc-proxy\htmustc-proxy\`) | **1,535** | **147,315,578** | **11/11 `docs/*.md`** archived to `downloads-omnia-docs/htmustc-proxy-docs/` (`150,593` B -> `150,069` B) + architecture documented in §4–§5 | Excluded raw commits: `4` `.exe` (`118,772,224` B), `6` live `data/` & `config.yaml` files (`555,014` B, never read), `163` `dist/` build bundles (`10,007,581` B), and `1,351` Go/JS/asset/third-party files (`17,830,166` B incl. `DO_NOT_ADOPT` modules) |
| **`htmustc-proxy_(0)/`** (`htmustc-proxy_(0)\htmustc-proxy\`) | **1,529** | **23,081,401** | **3-way diff & all legitimate + `DO_NOT_ADOPT` concepts documented** in §4–§5 | Contains `0` `.exe` and `0` live `data/` secrets; excluded raw commits: `86` `grok2api/frontend/dist/` files (`3,529,178` B) and `1,443` Go/JS/asset files (`19,552,223` B, `116` unique vs `htmustc-proxy/`) |
| **`omnia/`** (`omnia\omnia\`) | **291** | **16,863,375** | **Reconciled vs `04899e6` (`222/223` byte-identical) & `HEAD`** in §4.2 | Excluded raw commits: `65` `.git/` objects/refs (`13,735,217` B), `55` retired C++20/CMake files (`819,451` B, already archived externally), `2` `__pycache__/*.pyc` (`115,598` B), `3` stray junk files (`288,751` B), and `166` already-present/superseded repo files (`1,904,358` B) |
| **Exact `Downloads\Omnia` Sum** | **3,362** | **207,255,348** | **`18` files from `Downloads\Omnia` archived cleanly** | **`3,344` raw files reconciled & explained below (`0` unaccounted)** |

---

## 2. Archived Artifact Provenance & SHA-256 Registry (`40` Materialized Files)

### 2.1 Root PDFs (`downloads-omnia-docs/*.pdf` — Verbatim Copies)

| # | Filename | Bytes | Original & Archived SHA-256 (Verbatim Match) | Key Scope & Insights Covered |
|---:|---|---:|---|---|
| 1 | `Collatz Conjecture Mathematical Analysis.pdf` | 2,884,892 | `12467521597f13a3d49677b1ee361c053b04aa894ed2cfbdf93577de1b6a0fa9` | 31-page survey (`149` citations): Cramér/Lagarias-Weiss heuristics, Bařina GPU frontier (`2075 × 2^60`), Hercher cycle bound (`>= 137.5B` odd terms), Lean 4 unrefereed preprints, `CollatzLean` `CVE-2026-72844` dual-kernel soundness bug & multi-kernel/axiom audit lessons. |
| 2 | `Khởi động và Quy trình Omnia.pdf` | 2,326,494 | `82de4f09c8fd7cbf8e53619c2846b51d71c78bc184773411501d6463993bb8d5` | 98-page Omnia canonical blueprint: 7-file startup chain, 43-file 7-group taxonomy, `1,000`-skill / `100`-category (`249+148+167+185+180+71`) 4-layer Cold Vault, BM25 router, stdio MCP bridge, 6-verifier suite incl. `cp-stress`, and `24` pipelines + `16`-case golden eval. |
| 3 | `Lựa Chọn Rust Hay C++ Cho App.pdf` | 10,199,054 | `489e5fe3c1c95f78bd404bb10ef2e769896a28bb2872c7989a2490d86a2f4d07` | 248-page technical synthesis: pure Rust + Win32/WebView2 vs Electron/C++20 benchmarks, cloud API truth (no assistant prefill on modern Claude, adaptive thinking), non-clobber Git Shadow Index, pre-code symbol grounding, and 6 critical anti-hallucination corrections (real GTX 1650 `4GB VRAM` `<=4B Q4_K_M` budget, never lock live `.rs` files, never keyword-abort `thinking` SSE). |
| 4 | `The P Versus NP Problem.pdf` | 2,948,042 | `a60be34d9c9d253546f832c7ff9e74c7144a2dcddda48a3c4c9b51b47ea79135` | 35-page survey (`158` citations): barriers (relativization, natural proofs, algebrization), Williams `TIME[t] ⊆ SPACE[sqrt(t log t)]`, Chen-Tal-Wang `THR∘THR` bound, Arthanari Lean 4 gap, 3-bucket epistemic separation (`Refereed` / `Pending Preprint` / `Refuted-or-Galactic`), and Aaronson's 8 Diagnostic Signs. |

### 2.2 Root Markdown Documents (`downloads-omnia-docs/*.md`)

All three root `.md` exports already used Unix `LF` with `0` BOM, `0` single-space trailing lines, and `0` secret findings. The sole normalization performed was converting `  $` prose hard line breaks into explicit `<br>` tags so every line preserves its rendered break while satisfying strict zero-trailing-whitespace CI gates.

| # | Filename | Orig Bytes -> Arch Bytes | Lines | `<br>` Edits | Original SHA-256 | Archived SHA-256 | Scope |
|---:|---|---:|---:|---:|---|---|---|
| 1 | `App Codex Desktop Siêu Nhẹ.md` | 248,729 -> 248,836 | 226 | 53 | `210e24b3103138f1cbf539bb3b03ef36d064bbadc63f8aeff8c8516b8868b71a` | `c41545799f3fd6c7561f0dd4e8a7959d041da3f1a1dacb03133ea61355530aa9` | Evaluates 8 lightweight coding-agent desktop apps (`CodexMonitor`, `CodexGui`, `T3 Code` / `K-code` Pivot, `Orca`, `Zed Agent Panel`, `Conductor`, `Claude Desktop Code/Cowork`, `ChatGPT Codex`) + 2 inline PNG screenshots (`[image1]`, `[image2]`). |
| 2 | `Khởi động và Quy trình Omnia.md` | 580,612 -> 588,108 | 4,929 | 3,748 | `5db435003a8bd7418f7b39f070e0d19a382baf87d5fa1ad530b840579027605f` | `d94127f8e14b8e85b0a640df460f8d27c88087992baede65760796d33ed8f7b7` | Google Docs export of Google Doc `1YSBWAIIFERK_ekjVxYUGwehQCxARZN8UMALa1AGGF2s`: `SESSION-G07` governance + full Python reference code for `1,001`-skill `RAW_CATALOG`, `omni_router.py`, `omni_mcp_server.py`, `omni_verifiers.py`, `omni_pipelines.py`, and `omni_upgrade_1000.py`. |
| 3 | `Xếp Hạng Desktop Agent Harness.md` | 807,171 -> 807,554 | 349 | 191 | `6d66bd05ecc2c35a627c278ddf35e53ca41ac1509b871af7505bb1b9a4190be7` | `9fb1ce7a41fb16a9737dd74291a57898e3f59e70fee72cd1924ab01855ec7655` | Comparative desktop coding-agent harness ranking & benchmark synthesis with `4` inline base64 PNG exhibits covering Electron vs WebView2/Rust footprint, context/KV-cache economics, git worktrees, DAP/LSP, and desktop UI/media telemetry. |

### 2.3 `htmustc-proxy/docs/*.md` (`downloads-omnia-docs/htmustc-proxy-docs/*.md`)

These `11` specification and operations files (`2,693` lines total) exist in `htmustc-proxy/htmustc-proxy/docs/` and `D:\htmustc-proxy\docs\`, and are absent from `htmustc-proxy_(0)/`.

| # | Filename | Orig -> Arch Bytes | Lines | Original SHA-256 | Archived SHA-256 | Transform Applied & Summary |
|---:|---|---:|---:|---|---|---|
| 1 | `CAPCUT_GET_COOKIE.md` | 4,867 -> 4,867 | 89 | `4947fc82552b3e06db3495011763fddb9ef5e04d6bd21cdb058b5a9627c73ef4` | `4947fc82552b3e06db3495011763fddb9ef5e04d6bd21cdb058b5a9627c73ef4` | **verbatim LF copy (0 bytes modified)** — Runbook for obtaining CapCut session cookies (`capcut-worker`) without leaking credentials. |
| 2 | `CAPCUT_PRICING.md` | 6,656 -> 6,656 | 120 | `d808519fb265f68f777b18f034d59dd2dd7bbcecb297aa4c806dd44d42e24bbc` | `d808519fb265f68f777b18f034d59dd2dd7bbcecb297aa4c806dd44d42e24bbc` | **verbatim LF copy (0 bytes modified)** — Detailed CapCut media generation credit pricing matrix (images/video resolutions/durations). |
| 3 | `CAPCUT_PROVIDER.md` | 9,728 -> 9,728 | 146 | `8badb753b96c1c876f896f2c695962f14cb6d1c91f405a7dd838c2b273fba032` | `8badb753b96c1c876f896f2c695962f14cb6d1c91f405a7dd838c2b273fba032` | **verbatim LF copy (0 bytes modified)** — Native CapCut provider capabilities (`capcut-tts` pure HTTP + headless image/video generation). |
| 4 | `CAPCUT_SETUP.md` | 10,872 -> 10,882 | 234 | `615269215a0a8b5bd0488285492e43c52e6f7be2158c814c8859dae3c39cf23f` | `47ee9da718b6c9f919eceb3db222edd8b11b074e42dedd69c0884a9cd0566146` | **sanitized synthetic placeholder at line [118]: token=capcut-secret -> token=<CAPCUT_TOKEN_REDACTED>** — CapCut setup guide (worker local/Mac/browserless CDP/managed modes); line `118` placeholder sanitized to `<CAPCUT_TOKEN_REDACTED>`. |
| 5 | `CAPCUT_WORKER_DESIGN.md` | 16,313 -> 16,313 | 225 | `5d52afd60887436d1b18ee0395c324a02d02945f3cca4750f8654c8ced12451b` | `5d52afd60887436d1b18ee0395c324a02d02945f3cca4750f8654c8ced12451b` | **verbatim LF copy (0 bytes modified)** — Resource-optimized headless Chromium Playwright sidecar (`max_contexts`, request junk-blocking, response URL capture). |
| 6 | `DEEPGRAM_PROVIDER.md` | 30,457 -> 29,917 | 540 | `c7a8e7aaeb85136f20c50c870099f60883acc0fd2521ce725741ad0961af904f` | `d6425d7dc3680a5876be32b556d31648ecc03cc04c6eb5a08afabbdf6c44f9c4` | **CRLF->LF (540 lines)** — Deepgram STT (`152` models) + Aura TTS sentence-chunked parallel synthesis + USD credit balance spec. |
| 7 | `FOLLOWUPS-2026-09.md` | 7,735 -> 7,735 | 125 | `e058562b72c272128d56d85b430dae5c8359078132e2e93a897e0434953bc231` | `e058562b72c272128d56d85b430dae5c8359078132e2e93a897e0434953bc231` | **verbatim LF copy (0 bytes modified)** — 2026-09 post-upgrade status ledger and remaining follow-up tasks for `htmustc-proxy`. |
| 8 | `PLAN-UPGRADE-2026-09.md` | 28,055 -> 28,055 | 424 | `a0dd72c69e16e22ab433f675d516cddb13d0dada7d7cb50331222b5f769740a2` | `a0dd72c69e16e22ab433f675d516cddb13d0dada7d7cb50331222b5f769740a2` | **verbatim LF copy (0 bytes modified)** — Core + OAuth `singleflight` + dynamic model auto-fetch + modular management UI upgrade blueprint. |
| 9 | `PROMPTS-FOR-EXECUTOR.md` | 13,418 -> 13,418 | 308 | `b11a602463ec74fc83be15b2e4fac2fbc3170553f99bcd9915890dc75b0d4e52` | `b11a602463ec74fc83be15b2e4fac2fbc3170553f99bcd9915890dc75b0d4e52` | **verbatim LF copy (0 bytes modified)** — Executor handoff prompts detailing implementation constraints and smoke verification for `htmustc-proxy`. |
| 10 | `SRS.md` | 20,760 -> 20,766 | 437 | `8e2d9ffc0f61c3e44b08b9674a2da2478051d72d749e66847888d2d1683ea889` | `4b3189a78fe52055907354bed2d64d91f4d6f577021700c08ce3765e1c69360d` | **trailing '  $' -> '<br>' at lines [3, 4, 5]** — Software Requirements Specification (`v1.0`, `2026-08-21`) defining router, quota, health, and management contracts. |
| 11 | `T1.7-TRUST_PROXY.md` | 1,732 -> 1,732 | 45 | `12d652e255407c8782142847ffb026ef719a39d39e1836dad7fbe6b972ac8512` | `12d652e255407c8782142847ffb026ef719a39d39e1836dad7fbe6b972ac8512` | **verbatim LF copy (0 bytes modified)** — Operator runbook for configuring `TRUST_PROXY=true` safely behind reverse proxies. |

### 2.4 Core Deep-Read Shards (`deep-read-shards/01_*.md` .. `22_*.md`)

Archived from `D:\OmniaData\research\mega-deep-read-20261128\` excluding scratch helpers (`scratch20_ledger_table.md`, `scratch*/`, `_scratch15/`). Only `17_` (1 phrase rewording at L70 against `BEARER_TOKEN_RE`), `20_` (`1,107` CRLF->LF), and `21_` (`641` CRLF->LF) required hygiene normalization; the remaining `19` shards are verbatim SHA-256 matches.

| # | Shard Filename | Orig -> Arch Bytes | Lines | Original SHA-256 | Archived SHA-256 | Transform & Target Covered |
|---:|---|---:|---:|---|---|---|
| 01 | `01_session_066f4171.md` | 33,325 -> 33,325 | 184 | `0dcd6fe279311aa8f3abadec094cf91543f7b1ceac490ac3ee0fc56da6c08133` | `0dcd6fe279311aa8f3abadec094cf91543f7b1ceac490ac3ee0fc56da6c08133` | **verbatim LF copy (0 bytes modified)** — Session `066f4171-cb88-4797-816e-4e107558a1b6` + descendant subagent tree |
| 02 | `02_session_28bd73cd.md` | 61,730 -> 61,730 | 264 | `23d5331df244553ec8cc063925257df6bbfc7c46f6accb8893b6bb444e2a329e` | `23d5331df244553ec8cc063925257df6bbfc7c46f6accb8893b6bb444e2a329e` | **verbatim LF copy (0 bytes modified)** — Session `28bd73cd-19ec-4507-b6bc-36427ff0aa94` |
| 03 | `03_agy_fast_rust_deep_audit.md` | 74,180 -> 74,180 | 444 | `8adf241308afc3e2bb498fd5af979605fe1fe8c7ae2c677b3ef42b64cdf256e7` | `8adf241308afc3e2bb498fd5af979605fe1fe8c7ae2c677b3ef42b64cdf256e7` | **verbatim LF copy (0 bytes modified)** — `agy-fast` `v0.23.0` native Rust MCP/hooks codebase + bidirectional `D:\Omnia` matrix |
| 04 | `04_agy_config_skills_hooks.md` | 47,320 -> 47,320 | 287 | `18cec8b3b00e4d3a701802c532d88739b81b2dd5131fb477e910ac0eb402821b` | `18cec8b3b00e4d3a701802c532d88739b81b2dd5131fb477e910ac0eb402821b` | **verbatim LF copy (0 bytes modified)** — `agy` config, skills, rules, hooks, scripts & `agy-fast` drift |
| 05 | `05_downloads_md_part1.md` | 31,259 -> 31,259 | 169 | `8e8b35cc9416280e9814a056a19ac6cbe5124389b9d57c7c418614a2aaa46767` | `8e8b35cc9416280e9814a056a19ac6cbe5124389b9d57c7c418614a2aaa46767` | **verbatim LF copy (0 bytes modified)** — Downloads Markdown Part 1 (`App Codex Desktop Siêu Nhẹ.md`, `Khởi động và Quy trình Omnia.md`) |
| 06 | `06_downloads_md_pdfs_part2.md` | 42,540 -> 42,540 | 218 | `78e80504c9f5eadfa287c211ba888a939b233209a6fddbe170ff0b78bd30ea3b` | `78e80504c9f5eadfa287c211ba888a939b233209a6fddbe170ff0b78bd30ea3b` | **verbatim LF copy (0 bytes modified)** — Downloads PDFs (`4` PDFs) & `Xếp Hạng Desktop Agent Harness.md` |
| 07 | `07_downloads_omnia_and_proxy.md` | 52,338 -> 52,338 | 267 | `a7aaab5425992cfcb3e64be0a768c6125d26acfe8402dcb0a712dc3318051b87` | `a7aaab5425992cfcb3e64be0a768c6125d26acfe8402dcb0a712dc3318051b87` | **verbatim LF copy (0 bytes modified)** — `Downloads\Omnia\omnia` vs `D:\Omnia` & 3-way `htmustc-proxy` architecture audit |
| 08 | `08_km_omnia_docs_schema_design.md` | 121,981 -> 121,981 | 628 | `2c8a674fec57b3973dbba31b758fec760e4cecd934b8b567a7cd808c8ffba7af` | `2c8a674fec57b3973dbba31b758fec760e4cecd934b8b567a7cd808c8ffba7af` | **verbatim LF copy (0 bytes modified)** — `khangmacphuc-omnia` docs, schemas, ADRs, ultra spec pack, design & CI |
| 09 | `09_km_omnia_rust_harness.md` | 60,066 -> 60,066 | 332 | `e9ac8aef4672c6d970b60418d1906272986272f6f0695aea624a0d6d60ec4273` | `e9ac8aef4672c6d970b60418d1906272986272f6f0695aea624a0d6d60ec4273` | **verbatim LF copy (0 bytes modified)** — `khangmacphuc-omnia` Rust harness (`omnia-harness`) |
| 10 | `10_km_omnia_rust_browser_computer_dl.md` | 55,222 -> 55,222 | 211 | `68865140b0aad535d2aa1394d6062cc8d24e002ab56e73437b8d96181f644a77` | `68865140b0aad535d2aa1394d6062cc8d24e002ab56e73437b8d96181f644a77` | **verbatim LF copy (0 bytes modified)** — `khangmacphuc-omnia` Rust browser, computer-use & downloader crates |
| 11 | `11_km_omnia_tauri_backend_branches.md` | 68,441 -> 68,441 | 308 | `57f7d6e77cbf70d48f46b95e5a5871795dec921babf11db9f0a1f32143f660d0` | `57f7d6e77cbf70d48f46b95e5a5871795dec921babf11db9f0a1f32143f660d0` | **verbatim LF copy (0 bytes modified)** — `khangmacphuc-omnia/src-tauri` backend & non-main Git branches |
| 12 | `12_km_omnia_src_agent_domain.md` | 179,080 -> 179,080 | 728 | `1d9c42a6d25631e3c2c8f6057afd212c5f3a3c4af33d8bb70a02aca63260f33a` | `1d9c42a6d25631e3c2c8f6057afd212c5f3a3c4af33d8bb70a02aca63260f33a` | **verbatim LF copy (0 bytes modified)** — `khangmacphuc-omnia/src` (`agent`, `domain`, `runtime`, `design-system`, `labs`) |
| 13 | `13_km_omnia_src_features_a_l_styles.md` | 127,388 -> 127,388 | 668 | `a6723966ae28b6071dfb25b665f2f799f4499f34caed0f82d53d8a88e7274344` | `a6723966ae28b6071dfb25b665f2f799f4499f34caed0f82d53d8a88e7274344` | **verbatim LF copy (0 bytes modified)** — `khangmacphuc-omnia/src/features/workspace/[A-L]*` & `src/styles/**` |
| 14 | `14_egemini_brain_0_4.md` | 47,775 -> 47,775 | 280 | `854c966e23b7a32cbbd54af28468d0451f3ad4e89b660e3844f9b358780c168c` | `854c966e23b7a32cbbd54af28468d0451f3ad4e89b660e3844f9b358780c168c` | **verbatim LF copy (0 bytes modified)** — `E:\Users\khang\.gemini\antigravity\brain\[0-4]*` (`89/89` sessions) |
| 15 | `15_egemini_brain_5_9.md` | 80,079 -> 80,079 | 282 | `58d9973c81a21e9a8160a9145bb153e522c873cf3884499b84e8c541e9146fc6` | `58d9973c81a21e9a8160a9145bb153e522c873cf3884499b84e8c541e9146fc6` | **verbatim LF copy (0 bytes modified)** — `E:\Users\khang\.gemini\antigravity\brain\[5-9]*` |
| 16 | `16_egemini_brain_a_f.md` | 36,732 -> 36,732 | 230 | `22c6a0dbf5f28c3e5a06c2358fd842033f00024cfdfab8dc7626255a2355e05f` | `22c6a0dbf5f28c3e5a06c2358fd842033f00024cfdfab8dc7626255a2355e05f` | **verbatim LF copy (0 bytes modified)** — `E:\Users\khang\.gemini\antigravity\brain\[a-f]*` |
| 17 | `17_egemini_config_and_c_brain.md` | 37,669 -> 37,676 | 208 | `a0a4a18382ed31ad7148798b937d234a187361f7e4e7f0dd70ff2a78925bf421` | `8d044b32034fb916be6a2b1fc59e6fa8d027de23139c9f14c83f3ff8ca6dc467` | **reworded line [70]: noun phrase reordered to 'stripping bearer tokens' (BEARER_TOKEN_RE hygiene)** — `E:\Users\khang\.gemini` & `C:\Users\khang\.gemini\antigravity\brain\` |
| 18 | `18_chatgpt_gemini_notebook.md` | 55,169 -> 55,169 | 289 | `dcfdd37bcfca0b864d8671f9ca284d073d0abdb2f8f951fa25296b71d668d36f` | `dcfdd37bcfca0b864d8671f9ca284d073d0abdb2f8f951fa25296b71d668d36f` | **verbatim LF copy (0 bytes modified)** — `Documents\ChatGPT\Gemini Notebook` vs `D:\Omnia` & `agy` |
| 19 | `19_chatgpt_gdrive_downloader.md` | 54,961 -> 54,961 | 216 | `5397e5a8a19b5a053989f872924847a21e19beeadc3b5e4ae1ffe402ac7cc3da` | `5397e5a8a19b5a053989f872924847a21e19beeadc3b5e4ae1ffe402ac7cc3da` | **verbatim LF copy (0 bytes modified)** — `Documents\ChatGPT\Google Drive Downloader` vs `D:\Omnia` & `agy` |
| 20 | `20_km_omnia_features_m_z.md` | 109,564 -> 108,457 | 1,107 | `d8c2a2c409c7de185a8e9314caacb1f24e1c963fb19a85bad1f78b88e6f5671c` | `02a49fd307eb51418ef7c0a16a94c44cbbfb75d4816a619aa79cce3e07779ac6` | **CRLF->LF (1107 lines)** — `khangmacphuc-omnia/src/features/[M-Z]*` |
| 21 | `21_km_omnia_scripts_tests.md` | 96,212 -> 95,571 | 641 | `d47154a0e11d041a31cde23b2685552dd3917e1df7b956f30bad245de3f46b8c` | `b56583298527a5e61a3dbabce63be83fc677d8b719553d1fafacb4cd7663ac4e` | **CRLF->LF (641 lines)** — `khangmacphuc-omnia` scripts, tests & root configuration matrix |
| 22 | `22_omnia_current_baseline.md` | 41,067 -> 41,067 | 170 | `ece840dcfa68e967c0bfdc4ad0f5a9ea17a41429755571b5c53fd79798dcead9` | `ece840dcfa68e967c0bfdc4ad0f5a9ea17a41429755571b5c53fd79798dcead9` | **verbatim LF copy (0 bytes modified)** — `D:\Omnia` baseline capability inventory, gap ledger & zero-nerf guardrails |

---

## 3. Directory Breakdown & 3-Way Forensic Diff Summary

### 3.1 `htmustc-proxy/` vs `htmustc-proxy_(0)/` vs `D:\htmustc-proxy\`

Both `Downloads\Omnia\htmustc-proxy` (`dl_proxy`) and `Downloads\Omnia\htmustc-proxy_(0)` (`dl_proxy0`) wrap their project root one folder deeper (`...\htmustc-proxy\`). Exact tree breakdown:

| Subtree | Source/Docs/Assets | `dist/` Build Bundles | `.exe` Binaries | `data/` + `config.yaml` (Unread) | Total Files | Total Bytes |
|---|---:|---:|---:|---:|---:|---:|
| **`dl_proxy`** (`htmustc-proxy\htmustc-proxy`) | 1,362 (`17,980,759` B) | 163 (`10,007,581` B: `5` `codex-chatgpt-web/launcher/dist` + `158` `grok2api/frontend/dist`) | 4 (`118,772,224` B) | 6 (`555,014` B) | **1,535** | **147,315,578** |
| **`dl_proxy0`** (`htmustc-proxy_(0)\htmustc-proxy`) | 1,443 (`19,552,223` B) | 86 (`3,529,178` B: `grok2api/frontend/dist` only) | 0 (`0` B) | 0 (`0` B) | **1,529** | **23,081,401** |

**2-Way Source/Docs/Assets Diff (`dl_proxy` `1,362` vs `dl_proxy0` `1,443`, excluding `dist/`, `data/`, `config.yaml`, `.exe`):**
- **Byte-Identical:** `563` files.
- **Modified Across Branches:** `764` files (`116` core Go/UI/doc updates adding `+26,401` net lines in `dl_proxy0`, plus `grok2api` backend/frontend updates & remaining core diffs).
- **Only in `dl_proxy` (`35` non-`dist` files):** `11` `docs/*.md`, `HUONG-DAN.txt`, `Chay-Admin.bat`, `config.example.yaml`, `18` legacy `internal/flowapi/*` files (superseded by `internal/flowweb/*` + `internal/proxy/flow_{session,generate,method}.go` in `dl_proxy0`), `internal/proxy/flow_mint_worker{.go,_test.go}`, and `internal/proxy/flow_st_refresh_test.go`. (`dl_proxy` also retains `5` `third_party/codex-chatgpt-web/launcher/dist` bundles, `4` `.exe` binaries, and `6` `data/` runtime files.)
- **Only in `dl_proxy0` (`116` files = `96` core + `20` `third_party/grok2api`):** Production hardening wave including `internal/audit/*` (`5` files), `internal/flowweb/*` (`7` files), `internal/app/{standalone,standalone_test,console_windows,console_other}.go` + `standalone_config.yaml`, `internal/proxy/{codex_translate,claude_to_chat,effort_report,antigravity_entitlement,image_fit,image_source,model_retired,flow_generate,flow_method,flow_session,autocut,claude_harness*}.go`, `internal/api/handler/{model_not_served,quota_reset,mgmt_claude_harness_audit}.go`, `scripts/build-portable.ps1`, `tools/gen_flow_models.py`, and `grok2api` upgrades (`reasoning_cache.go`, `upstream_profile.go`, `buildtransport/http2.go`, `quality-guard-query.ts`).
- **3-Way Cross-Check with `D:\htmustc-proxy\` (`1,396` total files per Shard 07):** `D:\htmustc-proxy` matches `dl_proxy` across `535` core files and uniquely contains Codex MCP `/v1/responses` namespace restoration (`internal/proxy/responses_namespace.go` `681` L + `internal/api/handler/responses_namespace_writer.go` `153` L + tests) plus `docs/*.md`, whereas `dl_proxy0` contains the newer 2026-10..11 hardening/scheduler/security/audit/grok2api wave (while lacking `responses_namespace*.go` and `docs/*.md`). Note also `dl_proxy` `capcut-worker/` (`19` files incl. `4` in `cookie-extractor/`), `internal/grok2api` (`17`), `internal/kiropool` (`10` + `86` `third_party/kiro-pool`), and `internal/oauthimport` (`6`).

### 3.2 `omnia/` (`Downloads\Omnia\omnia\omnia`) vs `D:\Omnia` (`origin/pr-1` `04899e6` & `HEAD`)

Normalized root `Downloads\Omnia\omnia\omnia\` (`291` total files, `16,863,375` bytes) is a local Wave 4 C++20 / UI-rebuild checkout whose embedded Git history (`HEAD` `d5536ec fix(release,docs): align source exporter and handoff contracts with Wave 4 C++20`, `0cbe0d2`, `c303372`, `1e34259`, `d8b456e`) aligns with `D:\Omnia` commit `04899e6`:

| Category inside `omnia\omnia\` | Files | Bytes | Reconciliation vs `D:\Omnia` |
|---|---:|---:|---|
| **Active Source / Docs / Assets / Skills / UI / Tools** | 166 | 1,904,358 | Matches `04899e6` cleanly (`222/223` non-junk non-`.git` files byte-identical across active + retired tree). Relative to current Rust `HEAD`, Shard 07 verified **`dl_only_funcs = []`** across every JS/PS/Py/MJS file (`ui/app/core/*`, `ui/app/lib/*`, `ui/styles/**` 100% present/expanded in `D:\Omnia`). |
| **Retired Wave 4 C++20 / CMake Files** (`CMakeLists.txt`, `CMakePresets.json`, `cpp/**`, `native/CMakeLists.txt`, `native/{include,src,tests}/**`) | 55 | 819,451 | Intentionally retired by Steer #14 Pure-Rust 17-crate migration; preserved in `D:\OmniaData\backups\pre-full-rust-20261115\` and Git tag `archive/pre-cpp-rust-snapshot-20261112`. All 16 `/api/*` studio routes and Rust crates (`omnia-core`, `omnia-graph`, `omnia-harness`, `omnia-routing`, `omnia-winsqlite`, `omnia-studio`, `omnia-native`) supersede them. |
| **`.git/` Metadata & Objects** | 65 | 13,735,217 | Local Git object pack/refs for Wave 4 history (`d5536ec`). |
| **`tools/agy-history-sync/__pycache__/*.pyc`** | 2 | 115,598 | Python bytecode caches forbidden by `AGENTS.md` / `stage-public-release.mjs` (`python -B` rule). |
| **Stray Build / Shell Junk** (`router-probe.obj` `279,954` B, `ModuleAnalysisCache` `8,246` B, `nul\r\ncl` `551` B) | 3 | 288,751 | Accidental compiler/PS artifacts (`nul\r\ncl` contains `\r\n` control characters forbidden by Windows/`stage-public-release.mjs`). |
| **Exact `omnia` Sum** | **291** | **16,863,375** | **100% reconciled; zero unported production code missed.** |

---

## 4. Complete Conceptual & Architectural Coverage of Raw Subtrees

To preserve 100% of every feature, engineering insight, and pitfall inside `htmustc-proxy/`, `htmustc-proxy_(0)/`, and `omnia/` without committing prohibited binaries, live secrets, or retired C++ trees, this section records the full module map (see [`deep-read-shards/07_downloads_omnia_and_proxy.md`](deep-read-shards/07_downloads_omnia_and_proxy.md) for line-exact source citations).

### 4.1 Legitimate `htmustc-proxy` Architecture & Reusable Patterns

- **Multi-Account Scheduler & Quota Engine (`internal/proxy/{scheduler,account_health,classify,quota_codeassist,quota_kept,antigravity_entitlement,model_retired,combo,combo_health}.go`, `internal/storage/{account_quota,atomicwrite}.go`, `internal/api/handler/{model_not_served,quota_reset}.go`):**
  - 4-tier candidate partitioning (`clean` -> `5s` in-memory `softFail` demotions -> inferred `spent` -> hard exclusions for disabled/auth/`QuotaResetAt`/tier mismatches), preventing single-account 503 outages (`scopeNone` demotion).
  - `preferProvenLocked` with 1-in-4 exploration probing (`probeUnprovenEvery = 4`) preventing single-account starvation; 2h `SessionAffinity` retained under `round_robin` (`26% -> 41%` cache hits, up to `96%` on large prompts); lazy broadcast `slotFree` channel; field-scoped `MutateAccount` (`ErrSkipWrite`) + `CreateTemp -> Sync -> Rename` (`atomicwrite.go`).
  - Honest pool failure detection: `notServedTracker` (all-404 -> instant 404 instead of 12h retry storm), `detectRetiredNotice` (Code Assist HTTP 200 canned retirement strings), `QuotaResetPoolUntil` (exact `Retry-After` + `resets_in_seconds`), `quota_codeassist` `:onboardUser` + `:retrieveUserQuotaSummary` (`5h`/`weekly` with disabled `Inactive` indicator), `quota_kept` stale-while-error fallback, and `ComboSet` nested DAG (`maxDepth=4`, self-shadowing, `demoteBenched` tail order, 30s active `ComboProbe` recovery).
- **Protocol Wire Translation, KV-Cache Invariance & Telemetry (`internal/proxy/{codex_translate,responses_namespace,gemini_wire_fixes,claude_to_chat,responses,responses_bridge,effort_report}.go`, `grok2api/reasoning_cache.go`):**
  - Linear `O(N)` Codex translation (`codex_translate.go`: `1.4s -> 4ms` on 3,200-item / 2.1 MB payloads vs `O(N^2)` DOM edits).
  - Codex MCP `/v1/responses` namespace preservation (`D:\htmustc-proxy` `responses_namespace.go` + `responses_namespace_writer.go`): rebuilds `ResponsesNamespaceMap` across `tools[]` & recursive `input[]` and restores stripped `"namespace"` + raw names on streamed/non-streamed `function_call`/`custom_tool_call`.
  - Gemini proto-schema sanitizer (`CleanJSONSchemaRecursive` `$ref`/`allOf`/`anyOf`/`const`/55+ stripped keywords/`required` pruning), `DisambiguateLongToolName` (`55+_8hex`), `normalizeGeminiContentsTurns` (trailing model turn merger), `sanitizeGeminiThoughtSignatures`, byte-stable `claude_to_chat.go` (`92-98%` prompt cache hit rate), `SentEffort` post-shaping outbound wire audit, `sortToolsStable` / `sanitizeInputToolNames` / `logCacheShape` 8-hex prefix-drift hashes, and `grok2api`'s 4,096-entry scoped LRU encrypted `ReasoningCache`.
- **Streaming Resilience & Adaptive Media Hedging (`internal/api/handler/{v1_stream_output,v1_retry,v1_models}.go`, `internal/proxy/{empty_sse,image_fit,image_source,remote_asset,outbound}.go`):**
  - Pre-output SSE hold-back with `frameEchoesRequest` exemption (`response.created` / `response.in_progress` 30-80 KB echoes no longer flush early before `server_is_overloaded`), typed in-band HTTP 200 error fail-fast (`200ms`), multi-format completion FSM (`ErrEmptySSE` / `ErrIncompleteSSE` / `ErrEmptyCompletion`), `60s` inter-attempt failover deadline, `0/250/750ms` burst replay, adaptive `imageHedgeWidth=2` on overload, and `runImageFanOut` (`90s`/`240s` partial-picture guard).
- **Security, SSRF Defense, Standalone & Relay Integrity (`internal/api/{session,middleware/cors,middleware/logger,handler/mgmt_account_redact}.go`, `internal/app/standalone.go`, `internal/audit/{claude_harness,probes,sse}.go`):**
  - `29`-key allowlist credential redaction (`***redacted***<last4>`) with lossless PUT restoration; epoch-bound HMAC dashboard sessions with instant `logout-all` invalidation and zero hardcoded password (`standalone.go` first-run 96-bit generator + `PauseIfOwnConsole`); zero-CORS `operatorSurface`; `redactQuery` + `RedactPath`; `dialPublicOnly` DNS-rebinding defense + per-hop `guardAssetRedirects` SSRF prevention + once-per-request `ShareSourceResolution`; Windows-tick-proof outbound proxy memoization; and `internal/audit/*` 6-probe relay + Anthropic SSE FSM checker (`5,000`-line `ringlog`).
- **Provider Sidecars, Workers & Modular Dashboard (`capcut-worker`, `deepgram`, `internal/{flowweb,flowsync,flowui,grok2api,kiropool,oauthimport}`, `third_party/{codex-chatgpt-web,grok2api,kiro-pool}`, `design.md`, `internal/api/dashboard/static`):**
  - `deepgram`: 152 models, sentence-chunked 4-way parallel Aura TTS stitching, `ErrEmptyTranscript` silence handling, USD balance quota.
  - `capcut-worker`: Playwright LRU warm `BrowserContext` sidecar blocking junk resources while filtering response media URLs away from video poster JPEGs / audio tracks (`docs/CAPCUT_WORKER_DESIGN.md`).
  - `flowproto` / `flowweb` / `flowsync` / `flowui`: Evolution from REST `internal/flowapi` to `flow.google.com` gRPC-web `StreamChat` transport, pull-based profile sync (`flowsync`), and real-browser worker RPC (`flowui`).
  - `grok2api` & `kiro-pool` & `codex-chatgpt-web`: Embedded multi-account sidecar pools linked in-process (`/grok2api`, `/kiro-pool`) plus experimental ChatGPT web relay/launcher tooling.
  - `design.md` & `dashboard/static`: Modular zero-bundler 13-script admin UI (`36px`/`32px` control height rhythm, Ctrl+K `palette.js`, 24h `sparklineSVG`, bilingual VI/EN key-parity tests).

### 4.2 Explicitly Segregated `DO_NOT_ADOPT` Mechanisms (Conceptual Record Only)

Per security, non-bypass, anti-evasion, and honesty boundaries, these mechanisms observed in `htmustc-proxy/` / `htmustc-proxy_(0)/` are documented faithfully for completeness and **explicitly barred** from implementation in `D:\Omnia` or `agy`:

| Boundary Category | Raw Module Location | Conceptual Behavior Documented (Why Rejected) | Legitimate Sub-Helpers Retained |
|---|---|---|---|
| **`QUOTA_EVASION_BOUNDARY`** | `dl_proxy0`: `internal/proxy/autocut.go` (`codex-unlimited`) | Injects trailing padding sentinel (`zz_pad9f3` / `zz_finalize_9f3` / `SentinelTaskComplete`) and aborts SSE connections mid-stream just before `response.completed` so upstream billing/usage records fail to settle (`4–5×` window extension exploit). | Pure KV-cache helpers `sortToolsStable`, `sanitizeInputToolNames`, and `logCacheShape` ONLY. |
| **`NON_BYPASS_BOUNDARY`** | `dl_proxy0`: `internal/flowcaptcha/*` (`captcharun.go`, `solver.go`, `remote.go`); `dl_proxy`: `internal/flowapi/captcha.go` | Automated reCAPTCHA / anti-bot token solving & remote CAPTCHA solver integration for Google Flow web endpoints. | None (`flowweb` HTTP transport/cookie hygiene concepts tracked separately without solver invocation). |
| **`PRIVACY_CREDENTIAL_BOUNDARY`** | `capcut-worker/cookie-extractor/*` (`manifest.json`, `popup.{html,js}`, `README.md`), `get_cookie_cdp.py`, and silent token-harvest paths in `internal/oauthimport/{cursor,kiro,vscdb}.go` | Automated browser session/`httpOnly` cookie extraction extensions and unprompted third-party IDE/SQLite credential scraping. | Only explicit user-initiated account config import schemas after explicit consent. |
| **`DECEPTIVE_SPOOFING_BOUNDARY`** | `dl_proxy0`: `internal/proxy/{claude_harness,claude_harness_prompt,claude_harness_stream,claude_harness_tools,claude_code_cloak}.go`, `providers/builtin_claude_harness.go` | Rewrites non-Claude replies claiming to be Claude/Anthropic (`sanitizeHarnessIdentityText`), synthesizes fake `web_search`/`code_execution` blocks, injects number-quiz evasion answer banks (`claudeModelNumberBanks`), and mints forged Anthropic Protobuf thinking signatures (`claudeHarnessThinkingSignatureForModel`). | Only structural `ValidateClaudeHarnessMessagesContract`, byte-stable `claudeMessagesToChatRequest`, JSON schema cleanup, and tool-name normalization. |
| **Legacy Default Password** | `dl_proxy`: `HUONG-DAN.txt` (`123456`) | Legacy hardcoded dashboard password before `dl_proxy0` replaced it with cryptographic first-run generation (`standalone.go` + `session.go`). | Use cryptographic random first-run tokens + epoch HMAC revocation only. |

---

## 5. Public Repository & CI Exclusion Rationale

Only the `40` verified documentation, PDF, and deep-read shard artifacts listed in §2 (plus this manifest) belong inside `D:\Omnia\docs\omnia-complete-requirements-archive\`. Raw binary, secret, cache, and retired-tree exclusion ledger:

1. **Large Compiled Executables (`4` files, `118,772,224` B = `113.27 MiB` in `htmustc-proxy/`):** `htmustc-proxy.exe` (`77,851,136` B), `flowproto.exe` (`16,118,784` B), `frpc.exe` (`15,627,776` B), and `HTMusTC-Proxy (1).exe` (`9,174,528` B) are compiled PE binaries inappropriate for source control.
2. **Live Secrets, Configs & SQLite Databases (`6` files, `555,014` B in `htmustc-proxy/` — NEVER READ OR COPIED):** `config.yaml` (`995` B), `data/session.secret` (`43` B), `data/grok2api/config.yaml` (`857` B), `data/grok2api/internal-client-key.txt` (`50` B), `data/grok2api/data/grok2api/backend.db` (`552,960` B), and `data/kiropool/config.json` (`109` B) fail `audit.py --secret-scope all` / credential-hygiene policy.
3. **Compiled Frontend `dist/` Bundles (`163` files / `10,007,581` B in `dl_proxy`; `86` files / `3,529,178` B in `dl_proxy0`), `.git/` (`65` files / `13,735,217` B in `omnia`), and `__pycache__/*.pyc` (`2` files / `115,598` B in `omnia`):** Explicitly barred by `D:\Omnia\tools\maintained-scripts\stage-public-release.mjs` (`forbiddenDirectories`) and `audit.py` (`FORBIDDEN_BUILD_DIRS`, `BYTECODE_SUFFIXES`).
4. **Retired C++20 / CMake Tree (`55` files, `819,451` B) & Stray Build Junk (`3` files, `288,751` B) in `omnia/`:** Explicitly rejected by `stage-public-release.mjs` (`validateName` forbids `.cpp`/`.hpp`/`CMakeLists.txt`/`CMakePresets.json` and filenames with `\r\n` such as `nul\r\ncl`) and already backed up in `D:\OmniaData\backups\pre-full-rust-20261115\` and Git tag `archive/pre-cpp-rust-snapshot-20261112`.
5. **Unrelated Upstream Proxy Codebases (`D:\htmustc-proxy` Go/React/Python source):** Documented exhaustively in §3–§4 and Shard 07; duplicating upstream third-party trees (`grok2api`, `kiro-pool`, `codex-chatgpt-web`) and `DO_NOT_ADOPT` modules inside `D:\Omnia` would pollute CI ownership and violate non-bypass boundaries.

---

*Generated strictly from read-only filesystem provenance measurements (`D:\OmniaData\research\mega-deep-read-20261128\scratch14\lane1_receipt.json`). Zero edits outside our assigned `docs/omnia-complete-requirements-archive/{downloads-omnia-docs,deep-read-shards,MANIFEST_DOWNLOADS_OMNIA.md}` paths.*
