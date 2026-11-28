# Omnia checkpoint — 2026-11-28, Wave 5 revision 19 (`Steer #14..#23`: Full Native Rust 17-crate workspace `a41c4d6`, `575/575` Rust Tests, `5/5` Staged Release Binaries, Steer #22 YOLO Default + Steer #23 AI Studio Arena/Canvas/NotebookLM++/Gems Phase 4 100% PASS, Prior `6a82180` 3/3 Cleanroom Streak)

## Current continuation watermark

- Active checkout: `D:\Omnia`, branch `omnia-sota-harness`, tracking verified Steer #15–#23
  integration at **`a41c4d66bbb35bcc7aa7458979906897321455b4`** (tree
  `7953f5bec076dd8bd0d5657445f212210e6cce3b`; **`196`** Rust files across `17` crates,
  following prior 3/3 cleanroom-certified snapshot `6a82180769e9147c1d452e40a9a36e06f0561c18`
  [`cleanroom-round-{1,2,3}.json`, `0` errors, `0` warnings], Steer #22+#23 code/UI
  `05eafbbf5a074a665b681a9c0a16a48d0a8d2dbf`, Canvas Drawer + `qa-capture` IME fix
  `2f613801aceb3b9894369a99bc5768c76753fbb9`, and all 5 remaining Win32 QA IME fixes
  `a41c4d6`). All `5/5` release binaries are staged and parity-verified under
  `D:\OmniaData\build\omnia-rust-native-release\`, canonical **`FINAL_SCOREBOARD_V5`**
  (`793` trials/rows, `7,277` wire rows, `51/51` models probed, `finding_count: 0`,
  `0` 429s, `0` leaks, `0` `agy`, `0` secrets) is independently audited under
  `D:\OmniaData\qa\v5-bench\`, and all Steer #22+#23 Phase 4 live verification gates
  (`#366`, `#368`, `#372`, `#375`, `#376`) have passed `100%` (`0` defects) under
  `ADDITIVE_INTAKE` (`token_budget = NULL`, zero prior work dropped).
- **Wave 4 C++20 external archival backup**: The `55` superseded Wave 4 C++20/CMake files (`CMakeLists.txt`, `CMakePresets.json`, `cpp/**`, `native/CMakeLists.txt`, `native/{include,src,tests}/**`) are preserved outside the tree under `D:\OmniaData\backups\pre-full-rust-20261115\manifest.sha256.json` (`patch_bytes: 361065`); `0` `.cpp`/`.hpp`/`CMake*` files remain in the active product tree.
- **Active Full Native Rust target (`17` Cargo crates)**: `Cargo.toml`, `Cargo.lock`, and `rust/` (`omnia-winsqlite`, `omnia-core`, `omnia-storage`, `omnia-routing`, `omnia-graph`, `omnia-harness`, `omnia-connector-gateway`, `omnia-workspace-ops`, `omnia-media-capture`, `omnia-remote-control`, `omnia-runtime`, `omnia-studio`, `omnia-native`, `omnia-agent`, `omnia-cli`, `omnia-downloader`, `omnia-notebook`), built out-of-source via `CARGO_TARGET_DIR=D:\OmniaData\build\omnia-rust-workspace` (UI dist `543` files / `17,957.06 KiB`, `UI_DIST_CDN_HITS=0` under `D:\OmniaData\build\ui-dist` embedded into `omnia-studio.exe` via `--features embed-ui`), alongside `tools/omnia-benchmark/` and `tools/omnia-gemini-extractor/`.
- The Wave 4 C++20 and earlier Wave 3 Flagship Studio entries below remain historical receipts
  bound to their named snapshots; they do not substitute for Steer #15..#23 verification
  of the 17-crate Rust workspace.
- History acquisition remains `partial`: Codex and Antigravity metadata surfaces
  are present, while complete transcript-body recovery is not proven. Raw/private
  history remains outside the checkout.
- Active Wave 0 -> Wave 5 executable sequence (`Steer #15..#23`):
  1. Phase 0 baseline cleanup (`0f18b34`, DONE) & Steer #15–#21 3/3 Cleanroom Milestone (`6a82180769e9147c1d452e40a9a36e06f0561c18`, DONE): achieved `3/3` consecutive zero-defect Cleanroom Audit Rounds (`D:\OmniaData\qa\v5-verify\cleanroom-round-{1,2,3}.json`: R1 `EE2AA46E...` `28/28`, R2 isolated clone `C015FEFC...`, R3 `C71400E2...` `0` errors / `0` warnings / `broken_links: []`) before Additive Steer #22 and Steer #23 were queued (`ADDITIVE_INTAKE`, resetting active streak to `0` per `DOD.md` Gate Protocol).
  2. Wave 1–5 + Steer #16..#23 implementation, staged binaries & Phase 4 live QA (`a7f56c3..a41c4d6`, LANDED & 100% VERIFIED):
     - **Final Staged Release Binaries (`a41c4d6` / `2f61380` / `05eafbb`, `D:\OmniaData\build\omnia-rust-native-release\`)**:
       - `omnia.exe`: **`12,990,464` B (`12.389 MiB <= 14 MiB`)**, SHA-256 `5EFB97E44E14314BB59AAD94D0AA44D0F55355A9451D0C0BA666DB1BFDA8479D` (`--version`: `omnia 0.1.0`, warm 10x median `8.29–10.40 ms <= 15 ms`, `--profile-startup`: `0.08–0.12 ms` / `5.67–5.68 MiB` RSS, bare default `ApprovalMode::Yolo`, `omnia arena --offline --json`, `--acp` JSON-RPC 2.0, `omnia net --offline --json --privacy-mask`, `omnia skills doctor|route|pipelines`, `omnia rag sources|status|ingest|query`, `omnia lifecycle status|super-state`, `omnia think start|list`, `omnia research --offline --export`).
       - `omnia-studio.exe` (`embed-ui`): **`37,428,736` B (`35.695 MiB`)**, SHA-256 `6A771FFAC42331BDA3ACAE38DAD460CD92CB7AB75467256E4A0E24700D82B8FD` (`--smoke --port 0` = `HTTP/1.1 200 OK`, embeds `543`-file `ui-dist` `17,957.06 KiB`, `0` CDNs).
       - `omnia-runtime.exe`: **`16,102,400` B (`15.356 MiB`)**, SHA-256 `E3D06A022C4738F1FB11190A82C8A5E7B85E2A4DDDC7BE0B620FBB20C1DB7973`.
       - `omnia-native.exe`: **`383,488` B (`0.366 MiB`)**, SHA-256 `C2DB1434B5EE8708CF8DFA2864C29BFE7005E1732FB0F99A16D5C4D0AF7ED16C`.
       - `omnia_qa_seed.exe`: **`232,960` B (`0.222 MiB`)**, SHA-256 `314477D5F43997F11E58569D496C901103F9885EF13293FC51E8F9BF1027DB1E`.
     - **17-Crate Rust, UI & Tooling Unit/Build Receipts (`05eafbb` / `2f61380` / `a41c4d6`)**: `3/3` `clippy --all-targets --offline --locked -- -D warnings` clean (`--workspace`, `omnia-studio --features embed-ui`, standalone `omnia-cli`, `0` new external crates); **`575/575`** workspace Rust tests PASS (`omnia-agent` `191/191`, `omnia-studio` `27/27` default & `27/27` `embed-ui`, `omnia-cli` `15/15` workspace & standalone, `omnia-notebook` `25/25`, `omnia-workspace-ops` `41/41`, `omnia-harness` `17/17` + remaining 11 crates); modular fallback `ui/` (`f76b4a5`, `59/59` `node --check`, `11/11` suites **`119/119`** `node --test` PASS); `10/10` Python tool suites (`179/181`, `2` zstd-skipped, `0` failures, `0` `__pycache__`, incl. `platform` `14/14` closing `TRK-06` and `agy-history-sync` `AUD-30`/`AUD-31` `7/7`) + `maintained-scripts` `10/10`; `validate_skills.py --strict-all-skills` **`22/22`** valid (`0` drift); `skill_router.py golden-eval` **`16/16` (`100%`)**.
     - **Phase 4 Live Full-Stack, Playwright, TUI, Win32 & PR #1 Receipts (`05eafbb` / `2f61380` / `a41c4d6`)**:
       - `wave4-steer22-23-fullstack.json` (**`RC=0`, `ok: true`, `9/9` groups PASS**): Steer #22 bare default YOLO (`write_file`/`read_file` outside workspace via `resolve_tool_path`, auto `shell`, loopback `web_fetch` via `EgressPolicy::unrestricted()`, 4 aliases + `--approval-mode plan` opt-in); Steer #23 `omnia arena`, `/api/v5/arena/{compare,vote,leaderboard,runs}` (Elo persisted), `/api/v5/studio/{personas,estimate}` (`4` seeded Gems CRUD + JSON schema), `/api/v5/sessions/{id}/{branches,fork}`, `/api/v5/research/answer` (`rag|code|deep`), Atelier v2 `quiz`/`mind_map`/`audio_overview`, `Origin: 403` + OmniDrive non-bypass intact + `0` secret leaks.
       - `wave4-playwright-oracle.json` (`PW_RC=0`, `MICA_RC=0`, **`16/16`** 4×4 WCAG `>= 5.94:1`, `0px` overflow, `layoutContinuityOk: true`, **`defaultSoloOk: true`**, **`arenaOk: true`**, **`canvasDrawerOk: true`**, `lifecycleLinkOk: true`, `hasRealV5Scoreboard: true` `#1 omnia 90.8% (69/76)`, `0` console/page/4xx/5xx/external errors, Mica SHA-256 `E12A67AC...`).
       - `native-qa-final` (**`7/7` `pwsh` `90/90` `rc=0`**, `qa-paths.tests` `40/40`, `qa-capture.tests` `14/14`, `qa-smoke` `uiaIssue: null` asserting BOTH `Edit` `114` & `Document` `112`, `qa-session`, `qa-paging`, `qa-guard`, `qa-ownership` `6/6`, with `Find-OmniaQaMainWindow` / `Close-OmniaQaWindow` Windows 11 Vietnamese IME `UAC_InputIndicatorOverlayWnd` immunity across all 7 scripts).
       - `wave4-final-systems.json` (`14/14` Studio/runtime + `8.55 ms` CLI + `loop5` + `hookExit2`), `wave4-steer17-fullstack.json` (`13/13` `/api/v5/*` + RFC 9110 §5.3 + live scoreboard `0` `agy`), `wave4-steer18-20-fullstack.json` (`RC=0`), `diag_tui_pty.py` (`RC=0`, `YOLO · AUTO | FOCUS:CODE | GEM:STD`, `/arena /persona /focus /fork`, `TUI_EXITED_0`), `parallel/cli_v5_steer22_23.json` (`16/16` PASS), `parallel/post_05eafbb_audit.json` (`13/13` PASS), and PR #1 `pr1_audit_checklist.json` v1.1 (`29/32` `VERIFIED_PASS`, `2` `PARTIAL_IN_RUST` [`AUD-02` `omnia-studio/src/http.rs` alternate loopback port, `AUD-25` UI capability matrix], `1` `OPEN_PRODUCT_ENHANCEMENT` [`AUD-24` chat cancel UX]).
     - **Steer #16 Canonical `FINAL_SCOREBOARD_V5` (`D:\OmniaData\qa\v5-bench\`, `793` trials/rows, `7,277` wire rows, `51/51` models probed, `finding_count: 0`, `0` 429s, `0` leaks, `0` `agy`, `0` secrets)**: `final_scoreboard_v5.json` (`417,727 B` / `0.398 MiB < 2 MiB`, SHA-256 `737AC6DD5F99FDCA08AD9C6F0F7D42CB4A1229F889F5894C32AEBC14BC4146D3`), `FINAL_SCOREBOARD_V5.md` (`39,440 B`, SHA-256 `AEDBB99FCAC3B1AFAE02CCE40CD6F97E2922074069A95D12561736365E3184D6`), `htmustc_models_catalog.json` (`121,606 B`, SHA-256 `87A8DEC53E8E9D1FF69590965ED2539BBA22B330AB5BA4449D2DEDC22999E976`), `final_self_audit_v5.json` (`6/6` scopes PASS, `finding_count: 0`, `integrity_passed: true`, SHA-256 `47D5EFCF1785BA4F7B6FB5AC7FA3AA7BBE2623A0327DFB03169FA9D85605DBF0`), independently audited PASS in `D:\OmniaData\qa\v5-verify\wave3-final-audit.json`. Suite v5 (`502` trials, `4,859` wire rows): **`#1 omnia 69/76 (90.79%, CI [82.19, 95.47], mean 0.9197, I14 63.10)`** beats all 6 competitors (`goose 38.16%`, `codex 33.33%`, `opencode 32.89%`, `claude 27.14%`, `omp 18.18%`, `dsh 10.61%`) at exact two-sided McNemar `p < 1e-5` (`gpt-6.2-sol`: `37/39 = 94.87%` vs `codex 61.54%` `p=0.00024`; `claude-sonnet-5-5`: `32/37 = 86.49%` vs `goose 35.14%` `p<1e-5`); `9/9` public suites (`146` rows, `935` wire rows; `omnia` #1 or tied #1 on `6/8` head-to-head agent suites at `5x-9x` lower RSS); All-51 HTMUSTC Matrix (`80` trials across `20/20` live LLMs + `14` HTTP 403 key-restricted + `17` HTTP 403 media); 5-Level Effort Sweep (`65` trials); honest `DEFERRED_BOUNDARY` container blockers recorded (`Terminal-Bench 4.1` & `SWE-bench Verified/Pro` without Docker/WSL2).
  3. Final Frozen Commit & Fresh 3-Round Cleanroom Audit Streak (NEXT): `@build-gate` seals the final frozen `dirty_total: 0` commit (`audit.py --secret-scope all --strict --strict-scope full` `strict_ready: true`), then `@verifier` runs **`3` consecutive independent zero-defect Cleanroom Audit Rounds** (`D:\OmniaData\qa\v5-verify\cleanroom-round-{1,2,3}.json`, including isolated `--no-local --no-hardlinks` clean clone in `D:\OmniaData\tmp\`, `0` findings, `0` warnings) on the post-Steer-#23 frozen SHA before advancing `SESSION_ADMISSION.json` from `DEFERRED` to `READY`.
- Follow-up admission stays **`DEFERRED`** until the final frozen post-Steer-#23 commit and 3 consecutive
  cleanroom audit rounds above pass.

## Resume here

- Goal `OMNIA-ROOT-CLEAN-2026-11-11` remains **ACTIVE**. Read [GOAL.md](GOAL.md)
  for the objective, 16 parent tasks, 12 product leaves and seven chat-admission
  gates; read [DOD.md](DOD.md) for acceptance and the independent audit rule.
- Persistent tool goal was read active in this chat. Its API has no active
  objective-edit operation; GOAL revision 8 owns the detailed objective.
- Additive steer is queued: finish the interrupted deliverable, checkpoint
  its next action, then consume additions in order. Corrections affecting
  current correctness apply at a safe boundary. Explicit cancellation or
  incompatible replacement supersedes only the named work.
- Inspected committed baseline: `177bfbd0ddba226974e8da13975cd86d288370a7`,
  tree `13609bdf58e72d964e0e8e05d2a1d5e2f7650a56`, branch `master`,
  `docs: checkpoint scoped source preservation`.
  R10 checkpoint-r4 freshly observed clean root status and no staged paths.
  The r7 QA and r9 documentation are committed; `8d2ad69` remains the earlier
  layout milestone. The receipt for this logical preservation checkpoint belongs
  in external `continuation-r10-source-preservation/checkpoint-r4`, avoiding a
  self-hash update. No product implementation is changed by this document batch.
- Archived pre-C++20 GitHub baseline (Commit #3 / tag `archive/pre-cpp-rust-snapshot-20261112`): `c3033728abe6f0a4906a796bf7652c84408356d7`,
  tree `6198c676e8ef3e2ef055625d0126d7216b57fac1`, `2,039` tracked files on
  `https://github.com/khang-macphuc111107/omnia`, verified across **3/3 consecutive zero-defect audit rounds** (`round-{1,2,3}-v2-receipt.json`, `errors=0, warnings=0`).
- Active Wave 4 Full Native C++20 + Flagship Studio UI + `C:`/`D:` Deep-Clean baseline (Commit #5 on `origin/master`): `0` `.rs` / `0` `Cargo.*` files, `35/35` unified CTest cases, `7/7` Win32 QA workflows (`90/90` `rc=0`), `45/45` Edge CDP UI states, `+778.15 GiB` freed on `D:` (`837.57 GiB` free) + `+166.14 GiB` freed on `C:` (`189.60 GiB` free), independently verified in `FINAL_WAVE4_VERIFICATION_RECEIPT_20261112.json` (`sha256=0e776c268a90fd712d390f3427a26bc503641438439cd69411c4221fd4ba47fc`) and remote clean-clone C++20 Release CTest receipt `D:\OmniaData\qa\github-cpp20-clean-clone-20261112\GITHUB_CPP20_DELIVERY_RECEIPT.json`.
- Session admission in [SESSION_ADMISSION.json](SESSION_ADMISSION.json) is
  **`DEFERRED` for the current dirty continuation**. The prior `READY` state
  remains snapshot-scoped to the frozen Wave 3/4 evidence; the current
  candidate is `d5536ecd1381e45f16146406d70f13584fdf0d4f` with a dirty working
  tree. Rust runtime `cargo fmt --check`, `cargo check --locked` and
  `cargo test --locked` passed (`12/12`) and are recorded in
  `D:\OmniaData\qa\governance-rust-rebaseline-20261114\RUST_RUNTIME_REBASELINE_RECEIPT.json`.
  Full admission gates must be rerun or explicitly rebound before follow-up
  chat launch.

## Completed QA batch and current documentation ownership

The r7 intake observed these exact intentional QA changes, all preserved in
external `continuation-r7/before` before document edits:

| State at intake | Paths |
|---|---|
| Modified | `native/README.md`, `native/qa-guard.ps1`, `native/qa-ownership.ps1`, `native/qa-paging.ps1`, `native/qa-session.ps1`, `native/qa-smoke.ps1` |
| New, untracked | `native/qa-capture.ps1`, `native/qa-capture.tests.ps1`, `native/qa-paths.ps1`, `native/qa-paths.tests.ps1` |
| Owning documents repaired in r7 | `GOAL.md`, `DOD.md`, this checkpoint |

All of that logical batch is in commit `952c211`; r7/COMMIT.json records its
successful commit and clean status. These paths are historical intake states,
not a claim that they are currently dirty. The r9 three-document correction is
committed as `828c9e8`. The prior r10 preservation checkpoint is committed as
`177bfbd`, with before-bytes and receipts under external `checkpoint-r3`.
The current bounded deliverable records primary materialization in the existing
goal/DoD/disposition/admission/prompt/decision consumers. It preserves the complete
task, product, DoD, research and admission denominators. The present checkpoint
uses external `checkpoint-r4` for before-bytes, commands, checks and its commit
receipt.
The first baseline's unquoted `HEAD^{tree}` failed PowerShell argument parsing;
`BASELINE-CORRECTED.json` uses the quoted argument and records the actual tree.
The failed partial baseline is retained and supplies no tree evidence.

Root integrator owns this serialized integration. Logs, captures, SQLite
fixtures, executable targets, contracts and before/after receipts stay outside
`D:\Omnia`. Git history owns the prior tracked bytes; external baseline copies
own the pre-existing uncommitted QA bytes. No old checkout metadata is retired.

## Scoped QA evidence

Private receipt root:
`C:\Users\khang\.codex\research\omnia-restructure\20261111\handoff-intake`.
`continuation-r7` contains the recorded command/exit/stdout/stderr rerun receipts.
They are historical checks, not newly executed by this documentation batch:

| Check | Cases | Result receipt | Scope |
|---|---:|---|---|
| QA paths | 40 | `path-contract-rerun.result.json` | Isolated path fixtures; no product execution |
| Capture helper | 14 | `capture-contract-rerun.result.json` | Actual native window, ownership/DPI/overwrite/bounds/exit negatives |
| Session | 5 | `session-rerun.result.json` | Synthetic metadata, settings and reopen via UIA |
| Ownership | 6 | `ownership-rerun.result.json` | Cooperative store exclusion, preserved owner and successor reopen |
| Paging | 9 | `paging-rerun.result.json` | 125-row synthetic fixture, navigation and pending writer |
| Unsaved-form/selection guard | 12 | `guard-rerun.result.json` | Unsaved metadata, discard/cancel and failed-selection preservation |
| Smoke | 4 | `smoke-rerun.result.json` | Mode/draft/unsaved-close via control messages; UIA warning retained |

All seven named rerun receipts record exit 0. Separate paging and guard
fixture-producer receipts also record exit 0. Each wrapper binds all nine QA
script hashes and the external executable. The final smoke rerun finished
`2026-11-10T22:08:06.3266916Z`. No Rust application rebuild occurred.
Historical r5 receipts stay historical. Native QA entrypoints
now share `qa-paths.ps1` and `qa-capture.ps1` instead of writing captures and
fixtures under the source tree. The capture helper uses one DPI-unaware
geometry/capture space, limits dimensions, refuses overwrite, rechecks owner
and bounds, and restores caller DPI in `finally`.

Bound external debug executable:
`C:\Users\khang\.codex\cache\omnia-root-native-target\debug\omnia-native.exe`.
SHA-256: `1CA3C8A98B81F733B5588D283D7EAECA4FA243DE81847CE5014D0E64F862172F`.
Capture helper: `486644EFD7C2AD8BCC974AF1F2A815C056D228635D82443668D71EB9B934B228`.
Repaired path helper:
`E78DD779761CB19567A093547138C90537B500FAF36EEF53A6F098891C67B240`.
Path tests:
`87EC7B99464CAFB0FB713C4540959BFE13577A3505618E1E760AA7EC5D2187BA`.
The r7 source/evidence manifest binds the final batch and records reuse limits.

### Executable-boundary repair

Root review found that an absolute executable inside the product repository
was accepted. The new negative case first failed with exit 1, retained as
`path-contract-r7.result.json` and its stdout/stderr. The helper now routes the
executable through `Resolve-OmniaQaExternalPath`; the 40-case rerun and every
affected native QA workflow passed against external fixtures. The failed
receipt is neither overwritten nor counted as passing. Location guards do
not establish that an arbitrary external executable or database is trustworthy.

### Open visual/accessibility findings

- The large right/bottom black padding in the earlier r4 capture was repaired.
  The inspected r7 session image is 1220 × 820; API success, dimensions and hashes
  alone do not prove complete rendering.
- The r7 session capture still clips status-panel text near the bottom.
  Keep this open under `QUALITY-01`; it is not a flawless screenshot.
- Smoke retains `uiaIssue: "Missing UIA control: Edit "`. Its exit-0 control-
  message cases are not a passing native accessibility assessment.
- None of these receipts establishes provider Send/streaming/cancel, final UI,
  persistent composer/transcript/attachments, browser/IDE, physical keyboard,
  Vietnamese IME, Narrator, hidden/minimized capture, process-private input,
  DPI/resize matrix, packaged performance or absolute absence of bugs.

## Preview and active commands

Continuation-r6 records that old preview PID `2272` was stopped during resume;
the r7 baseline then observed no `omnia-native.exe`. After commit `952c211`,
continuation-r8 launched and retained a replacement evaluation shell:

- PID `38256`; start UTC `2026-11-10T22:22:44.9797906Z`; HWND `3014860`.
- Executable is the external debug binary bound above; working directory
  `D:\Omnia`; no `--session-db` was supplied.
- r8/BASELINE.json, OBSERVATION.json and RETENTION.json own the launch,
  visibility and retention evidence. The recording failure involving read-only
  `$PID` occurred after launch; recovery identified the existing process and
  recorded it without launching a duplicate.
- r8 observed visible/responding/not minimized/not foreground. Capture:
  `D:\OmniaData\qa\native\continuation-r8\native-preview-r8-window.png`,
  1220 × 820, SHA-256
  `460541807FA61BD2BCDE78E2A8468A675826BDCE05B445B6A8EB96178E37199F`.
- r9/PREVIEW-REOBSERVATION.json, recorded
  `2026-11-10T22:47:09.5471586Z`, found the same PID/start/path/hash/HWND,
  alive and responding. This is a process check; visibility and pixel state
  still have r8's observation time.

Preserve this preview for the user. Reobserve identity before acting, relaunching
or stopping it. No persistent terminal command session is owned here. The
evaluation shell reports provider delivery, storage and draft persistence
disconnected; this is not a final UI or working provider-chat qualification.

## Source closure and reconciliation

Actual product source is tracked at `D:\Omnia`: independent `native/`, shared
`src-tauri/crates/` and retained React/Tauri compatibility source. Native
admission verified 197 files / 2,588,993 bytes. Root admissions are committed;
this is still not a semantic merge of primary/release/rebuild/goal-control work.
Both local manifest/format checks passed. Native tests passed their recorded
suites. The repaired Tauri root rerun ended `2026-11-10T19:43:52.8602675Z`,
exit 0: 833 host unit tests, 6 project-file-watch tests and 4 + 17 integration
tests. The original missing-schema failure remains in the receipt root.

Continuation-r3 records an isolated local `--no-local --no-hardlinks` clone
of `8d2ad69`, both locked no-deps metadata checks and native tests with exit 0.
Existing Cargo registry/build caches were used; this is not a GitHub clone,
cold installation, packaged behavior or complete compatibility build. Reuse
only unchanged input scope; the QA helpers belong to later commit `952c211`.

Corrected private NUL/rename-aware inventory at `2026-11-10T20:12:44Z`:

| Owner | Changed tracked | Untracked | Total status entries |
|---|---:|---:|---:|
| Primary | 3,008 | 1,775 | 4,783 |
| Release | 25 | 108 | 133 |
| Rebuild | 80 | 1 | 81 |
| Goal-control | 0 | 0 | 0 |

`continuation-r2/source-state-v2` contains complete HEAD/index/status records;
no rename occurred in that read. A stable read is not an atomic backup.
HEAD-only union is 42,012 paths, four-way intersection 2,020 and current focus
276 paths / 138 differing paths. Historical 277-focus counts used a different
predicate. Semantic reconciliation remains open. R10 advanced scoped
preservation and isolated restore as recorded below; excluded owners and
consumer boundaries still prevent metadata retirement. Revalidate current
bytes before carrying any disposition.

## Source preservation and isolated restore — r10

Private evidence root (LANE):
`C:\Users\khang\.codex\research\omnia-restructure\20261111\handoff-intake\continuation-r10-source-preservation`.
Snapshot root (SNAP):
`C:\Users\khang\.codex\recovery\omnia-root-r10-20261111`.
Isolated restore (RESTORE):
`C:\Users\khang\.codex\recovery\omnia-root-r10-restore-20261111`.
These private inputs remain outside published Git.

### Acquired and restored scope

- `SNAP/SNAPSHOT.json`: 184,169 regular files / 8,342,167,917 logical bytes
  across common Git, primary, release, rebuild and goal-control. The method
  checks per-file stability with pinned ancestors; it is not volume-atomic.
- `SNAP/SUPPLEMENT.json`: 23 PNG files / 5,273,303 bytes whose parent directory
  has a trailing space. Extended Windows path semantics preserve that name;
  do not normalize it onto a different directory. The supplement is separate
  from the base snapshot denominator and was consumed during primary restore.
- `LANE/restore-reconciliation-r2/RESTORE-R2.json`, SHA-256
  `102b1fc8217faa3796517a5dcdec30f68ae21cf79d9c2bddd45a243b11e43786`,
  finished `2026-11-10T23:47:18.236997Z`: 20/20 comparisons match HEAD, refs,
  index stage records, index flags and status for goal-control, release, rebuild
  and the nested Pydantic owner. `WORKING-BYTE-READBACK.json` separately verifies
  all 10,076 included regular files from the three linked worktrees.
- Nested Pydantic was separately acquired and restored: 28 physical files /
  287,343 bytes; HEAD `0f7648a1b0685389ea368ea4f7b754b393cea8c7`.
  Its absent/empty index and many tracked deletions are preserved; 28 physical
  files does not mean 28 entries in the Git tree. Use `SNAP/manifests/
  rebuild_pydantic.jsonl` and `LANE/restore-reconciliation-r2/NESTED-OWNER.json`.
- `LANE/restore-reconciliation-r2/PRIMARY-MATERIALIZATION.json`, SHA-256
  `5345bb971b723af654e19fddb4e70dce2df8b64518a236985fbb8b8ca76ab5a7`,
  finished `2026-11-11T13:52:58.621312Z`: 172,415 ordinary files /
  6,795,557,609 bytes, 21,881 directories and the separate 23 PNG files /
  5,273,303 bytes were materialized under `RESTORE/primary`. Every included
  file was read back for size and SHA-256; no missing files or size/hash
  mismatches were recorded. Windows extended-length paths preserve the exact
  trailing-space name.
- The first materialization attempt wrote and checked 168,499 primary files
  before ordinary path handling failed at the trailing-space destination.
  Corrected terminal session `78177` reused and verified those existing bytes,
  then completed the supplement; its observed terminal exit is 0. No second
  full restore was created. The receipt leaves 1,029 primary boundaries
  unmaterialized and does not compare primary Git status or establish current
  source drift, consumer validity or deletion eligibility.

### Corrected diagnosis and conditional status equality

The earlier missing-linked-index diagnosis is **superseded**. The snapshot
already includes all three indexes and 24 linked-worktree admin files;
`LANE/ADMIN-AND-STAT-CACHE-PROBE.json` records every admin hash matching live
and restored copies. Initial restore mismatches involved `core.autocrlf=false`
versus source semantics, new stat metadata and the absent nested owner.

R2 preserves raw indexes, restores captured mtimes only in the isolated
working directories and uses explicit isolated Git/work-tree paths with
`core.autocrlf=true`, `core.longpaths=true`, `core.ignorecase=true` and
`core.trustctime=false`. Its status equality is conditional on those inputs.

Separate `CONTENT-REEVALUATION.json` with `core.trustctime=true` still matches
goal-control and release; rebuild has 130 records versus the source's 81,
exposing 49 inherited EOL/stat-cache differences. Keep this finding alongside
the matching byte receipt. Neither matching cached status nor matching bytes
proves semantic cleanliness. Historical `RESTORE/RESTORE.json` and the exit-0
common-Git fsck receipt remain historical; R2 did not rerun fsck.

### Source-side diagnostic correction

`probe_restore_cause2.py` accidentally invoked `git sparse-checkout reapply`
on source goal-control, release and rebuild. Return codes/stdout/stderr for
those calls were not retained. Do not describe all r10 source operations as
read-only. `LANE/SOURCE-POST-PROBE-CORRECTION.json` records that all four owners'
HEAD/refs/index stage/index flags/status and raw index hashes still matched
acquisition afterward; the later admin probe matched all 24 admin files.
The R2 implementation now allowlists source query commands. Do not rerun the
erroneous diagnostic. These checks support only their named postconditions.

### Remaining preservation gates

`retirementEligible=false`; `ROOT-02` and `ROOT-03` are `IN_PROGRESS`, `DOD-05`
is `PARTIAL`, `SESSION-G02` is `PARTIAL`, session decision is `DEFERRED`, and
whole-goal independent audit streak remains **0**. No metadata retirement,
source relocation or deletion is credited to this batch.

Primary included-byte materialization is verified within the receipt's scope.
Primary Git-state comparison remains pending. Its 11 Gitlink owners,
57 reparse records and 961 generated boundaries, plus remaining release/rebuild
boundaries and actual consumers, need separate ownership/disposition. The
supplement also lists further nested owners. Preserve these boundaries and
reacquire current source state before retiring anything. The 403 byte-delta
candidates and the disposition ledger's 138 unreviewed HEAD focus rows do not
have semantic review or merge credit. Repeated root readback is not an
independent audit, and tool-dispatch failures provide no agent-review credit.

## Layout and capacity

Ten classified nonproduct trees moved to `D:\OmniaData`, retaining 92,460 files
and 15,156,174,074 logical bytes; [EXTERNAL_LAYOUT.json](EXTERNAL_LAYOUT.json)
owns the mappings. Full path/type/size/mtime, nonzero directory identities and
selected anchor hashes were checked. Before-file device/inode fields were
zero, so per-file identity and an all-content-hash backup are not proven.
Same-volume relocation has **zero reclaimed-capacity credit**.

Supported Cargo cleanup of the former native integration target reported
9,632 files / 12.1 GiB, exit 0. Observed D: free-byte delta was 11,357,032,448
(about 10.58 GiB); it differs from Cargo logical-byte accounting and can include
concurrent activity. Earlier Cargo/pnpm cleanup has separate receipts; do not
double count. The historical D_DRIVE_TOPLEVEL_INVENTORY file inventories
`D:\Omnia`, not a complete drive-root recursive size survey. Primary/common Git,
linked worktrees, backups, profiles, downloads/logs/output and other operational
consumers still require classified ownership before relocation or reclamation.

## History, research and skills

The historical structural watermark is 852 rollout files, 2,256,736,449 bytes,
528,619 physical records and 14,630 bounded units. Semantic review credit at
that watermark remains **0**. Of 101 source-DB/raw-rollout gaps, 99 have alternate
projected items; growth, truncation, missing state and review remain open.
See private `handoff-intake/history`. Neither discovery nor hashing proves
reading or understanding all chats.

Queued-steer guidance already exists in `goal-plan-loop-dod`, `deep-steer`
and root instructions. Validation/projection is not proof Omnia loaded or
invoked the skills. Research quotas, atomic source qualification and native
product requirements remain in GOAL without changing their denominator.

## Queued additive requirements — UI direction and dynamic routing

The latest queued request adds two bounded contracts without changing the
16-parent, 12-product-leaf, 16-DoD or seven-admission denominators:

- `PRODUCT-CHAT` now has the atomic
  [DYNAMIC_ROUTING_REQUIREMENTS.md](DYNAMIC_ROUTING_REQUIREMENTS.md) contract.
  It is specification-only at this checkpoint. Existing provider profiles,
  models, token/cost fields, generations, attempts and run journals must be
  inspected before introducing storage. Quota reservation, post-run
  reconciliation, stale/unknown usage, health, rate limits, privacy boundaries,
  fallback and route/outcome receipts need runtime evidence before status can
  advance.
- `PRODUCT-WORKSPACE` now requires preview-first visual direction. The local
  `deep-ui-direction` skill was created and passed the skill creator validator.
  It owns reference provenance, three-candidate style exploration, weighted
  direction decisions, direction briefs, measurable token seeds, addressable
  previews, independent critique, anti-slop review and user-review status.
  `modern-tech-ui-design`, `deep-ui-quantitative` and `deep-ui-qa`
  retain token implementation, measurement and behavior QA respectively.
  No Omnia preview, user approval or live UI credit exists yet.
- The bounded UI-style receipt is now stored outside the product tree at
  `C:\Users\khang\.codex\research\omnia-ui-direction\20261111\UI_STYLE_RESEARCH_RECEIPT.json`.
  It records ten GitHub queries, 68 unique first-seen repository identities,
  eight fetched official design/accessibility pages and eleven selected README
  retrievals, plus a content-extract receipt. It admits only process-level
  lessons; no source code, assets, fonts or visual identity were copied. The
  supplied social/video material and related terms remain unreviewed. The
  receipt is not exhaustive source review or Omnia runtime proof.
These additions are open requirements. They do not alter the preservation,
history, publication, admission or final-audit states.

## Bounded UI-style research receipt

A receipt is stored outside the product tree at C:\Users\khang\.codex\research\omnia-ui-direction\20261111\UI_STYLE_RESEARCH_RECEIPT.json. It records 10 GitHub queries, 68 unique first-seen repository identities, 8 fetched official design/accessibility pages, 11 selected README retrievals and a separate content-extract receipt. It admits process-level lessons only: reference provenance, layered tokens, accessible primitives, state coverage, preview/QA separation and measurable contrast/focus checks. No source code, assets, fonts or visual identity were copied. Social/video links remain unreviewed and the receipt is not exhaustive source or runtime proof.

## Four-keyword research and Cargo-cache cleanup — 2026-11-12

The exact GitHub queries `agent`, `memory`, `code` and `open` each returned 100
repositories sorted by stars descending. The metadata envelope records the query
URLs, retrieval time, result totals and repository fields; identity
deduplication produced 324 unique entries. A bounded canonical-source ledger
then inspected README, license endpoint and recursive tree metadata for 16
unique top-five selections. README hashes and HTTP statuses are recorded in
`C:\Users\khang\.codex\research\omnia-clean-2026-11-12\github-bounded-source-ledger.json`.
This is discovery and bounded inspection evidence only. It is not exhaustive
source, issue, comment, media or runtime review and no repository code or asset
was admitted to Omnia.

Three ignored, untracked, ordinary Cargo target directories in
`D:\Omnia\repos\omnia` were moved by exact path to
`D:\OmniaData\quarantine\omnia-clean-20261112\cargo-targets` after a
path-specific receipt. The after readback matched 4,513, 3,709 and 4,727 files
and their recorded logical bytes. The same-volume move produced zero D: free
space delta, so it earns no reclamation credit. The child status remains 4,783
entries with 12 missing-directory warnings; no source, nested repository,
worktree, profile, backup or recovery data was deleted.

Receipts:

- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-cargo-targets-pre.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-cargo-targets-move.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\repos-omnia-status-after-cargo-move.json`

## Next executable actions

1. Finish this primary-materialization checkpoint before consuming queued additions.
   Verify exact task/DoD/product/admission IDs and transfer states, evidence
   hashes, local references, JSON and `git diff --check`; inspect the complete
   staged diff and commit only the intended documentation update. Record the
   returned commit/tree/status under LANE/checkpoint-r4; do not rewrite this
   checkpoint merely to embed its own hash.
2. Reuse verified `RESTORE/primary`; compare primary Git state under recorded
   source semantics with isolated configuration, retaining conditional status
   and independent content reevaluation as separate results. Do not duplicate
   the full restore or rerun the erroneous source sparse-checkout diagnostic.
3. Preserve/classify all remaining nested/Gitlink/reparse/generated boundaries,
   inspect consumers and reacquire source state for drift. Keep retirement
   ineligible. Continue ROOT-02 semantic reconciliation, safe externalization,
   measured drive cleanup, isolated closure and bounded refactoring afterward.
4. Inspect and plan the dynamic routing contract against the existing native
   provider/storage source; do not duplicate ledgers before a schema/ownership
   map exists.
5. For each UI surface, make the direction record and preview before full
   implementation, then collect independent critique and user-review status.
   Preserve the retained preview and known visual/UIA findings.
6. Carry complete history/research/product/quality requirements in GOAL's queue.
   Publish only after privacy/license/account/clone gates; launch the requested
   follow-up chat under all seven reviewed admission gates with detailed goal
   activation.
7. Continue child-repository classification from the unchanged 4,783-entry
   status. Reconcile missing-directory warnings and nested/reparse owners before
   touching profiles, upstream extractions, backups or deleted source. Treat the
   Cargo quarantine as reversible and decide on deletion only with a separate
   retention and restore proof.

## Four-keyword research and cache quarantine — 2026-11-12

The exact GitHub queries `agent`, `memory`, `code` and `open` each returned 100
repositories sorted by stars descending. The metadata envelope records query
URLs, retrieval time, result totals and repository fields; identity
deduplication produced 324 unique entries. A bounded canonical-source ledger
inspected README, license endpoint and recursive tree metadata for 16 unique
top-five selections. This is discovery and bounded inspection evidence only;
it is not exhaustive source, issue, comment, media or runtime review and no
external code or asset was admitted to Omnia.

The generated-cache cleanup then moved `.pytest-cache` (one status-visible
five-byte marker) and `.pytest_cache` (four standard pytest cache files) to
`D:\OmniaData\quarantine\omnia-clean-20261112\pytest-cache`. Exact containment,
ordinary-directory status, zero tracked files and destination collision checks
passed. The same-volume move measured zero free-space delta. The child
repository still has 4,783 status entries and the previously recorded missing
upstream-directory warnings; no source, nested repository, worktree, profile,
backup or recovery data was deleted.

Receipt: `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-pytest-cache-move.json`.

## Graphify supplement and dist quarantine — 2026-11-12

A canonical public GitHub API review was recorded for `Graphify-Labs/graphify`
at ref `v8`. Repository, README, license and recursive tree endpoints returned
HTTP 200; the tree response contained 1,306 entries with `truncated=false`.
The repository metadata reports `Apache-2.0`. The README and six selected files
(`ARCHITECTURE.md`, `docs/how-it-works.md`, `graphify/manifest.py`,
`graphify/querylog.py`, `graphify/rcfile.py`, and
`graphify/always_on/claude-md.md`) were decoded, hashed and retained in the
external supplement directory. This is bounded review evidence, not exhaustive
source, issue, discussion, comment, media or runtime review.

The useful candidate patterns are deterministic code indexing separate from
semantic extraction, explicit `EXTRACTED`/`INFERRED`/`AMBIGUOUS` provenance,
module input/output contracts, bounded configurable query depth/budget, and
scoped graph-first navigation before broad raw search. Admission is
`RESEARCH_ONLY`: no external source, asset, credential, private content or
runtime was copied into Omnia. Full disposition:
`C:\Users\khang\.codex\research\omnia-clean-2026-11-12\supplement-20261112\graphify-disposition.md`.

The next generated-only cleanup unit classified `dist` as an ordinary ignored
and untracked Vite build output (140 files, 6,924,863 logical bytes). The
`package.json` build route is `tsc -b && vite build`; no reparse point, tracked
file, status entry or active process reference remained at the mutation check.
The directory was moved by exact path to
`D:\OmniaData\quarantine\omnia-clean-20261112\dist`. Readback matched file
count and bytes. The move stayed on D:, so free-space delta was 0 and no
reclamation credit is claimed. Restore is a single exact reverse move recorded
in the receipt. Child repository source/profile/worktree state remains dirty and
independently owned.

Receipts:

- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-dist-pre.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\cleanup-receipt-dist-move.json`
- `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\repos-omnia-status-after-dist-move.json`

## Latest bounded unit — Graphify disposition and Vite dist quarantine

Graphify was reviewed from public GitHub API evidence at ref `v8`: repository,
README, license and recursive tree all returned 200; 1,306 tree entries were
reported without truncation. README plus six canonical files were actually
opened. The Apache-2.0 metadata and candidate lessons are recorded outside the
product tree. Admission is `RESEARCH_ONLY`; this does not claim exhaustive
source/comment/media/runtime review and no external code was copied.

`D:\Omnia\repos\omnia\dist` was an ordinary, ignored, untracked generated
Vite output with 140 files and 6,924,863 logical bytes. Its producer is the
tracked `package.json` build script (`tsc -b && vite build`) and
`package-lock.json` is present. A path-specific receipt proved containment,
zero reparse entries, zero tracked/status-visible files and no active process
reference at mutation time. The directory was moved to
`D:\OmniaData\quarantine\omnia-clean-20261112\dist`; readback matched. This
same-volume move changed free space by 0 bytes, so it is reversible
externalization and earns no capacity credit. The source path is absent and
path-scoped Git status is clean after the move.

The child repository remains dirty and independently owned. The root control
plane is clean at the last committed checkpoint. Remaining candidates include
`node_modules`, `.toolchains\openhands-uv-cache`, `.omnia\cache`, Chrome
profile data, upstream extraction trees and mixed source deletions; they remain
preserved until owner, consumer, retention and restore evidence are complete.


## Node dependency quarantine — 2026-11-12

The generated `node_modules` directory was separately classified as a normal,
ignored and untracked dependency install: 12,111 files and 194,672,966 logical
bytes, no reparse entries, zero tracked/status-visible files and no active
process reference at the final gate. `package.json` declares the build/test
scripts and the unchanged `package-lock.json` provides the regeneration route.
An exact-path move placed it at
`D:\OmniaData\quarantine\omnia-clean-20261112\node_modules`; readback counts
and bytes matched and the source path is absent. This is reversible
same-volume externalization with zero free-space delta, not deletion or
capacity reclamation. Restore command and pre/move receipts are recorded
outside the product tree. No source, lockfile, nested repository, profile or
worktree data was touched.

## OpenHands uv cache quarantine — 2026-11-12

The generated `D:\Omnia\repos\omnia\.toolchains\openhands-uv-cache` directory was separately classified as an ignored, untracked uv/OpenHands package cache. Pre-move evidence recorded 85,557 entries, 71,261 files, 2,083,312,334 logical bytes, zero reparse entries, zero tracked files, zero status-visible files and no active process reference at the final gate. The retained `.gitignore`, `.lock` and `CACHEDIR.TAG` markers, plus `uv` cache producer and regeneration route, are recorded in the external receipts. An exact-path move placed it at `D:\OmniaData\quarantine\omnia-clean-20261112\openhands-uv-cache`; readback counts and bytes matched and the source path is absent. This is reversible same-volume externalization with a zero-byte free-space delta, not deletion or capacity reclamation. The recorded reverse move is the restore route. No source edits, nested repository, profile, worktree or unknown cache data was touched.

## Root scratch quarantine — 2026-11-12

Fifteen root-level Playwright/build probe scripts and generated logs were classified as temporary artifacts after reading their contents and checking their Git state. The exact paths were `.tmp-build-preview-mock.log`, `.tmp-build-renderer.log`, `.tmp-check.cjs`, `.tmp-inspect.cjs`, `.tmp-long.cjs`, `.tmp-poll.cjs`, `.tmp-preview-check.cjs`, `.tmp-preview.mjs`, `.tmp-preview2.mjs`, `.tmp-preview3.mjs`, `.tmp-preview4.mjs`, `.tmp-prod-mock.cjs`, `.tmp-rag-tsc.log`, `.tmp-workspace-test.log` and `debug.log`. Their pre-move receipt records 15 files and 41,003 logical bytes; the move receipt confirms byte and SHA-256 readback, source absence and the exact reverse move by manifest. They were moved to `D:\OmniaData\quarantine\omnia-clean-20261112\root-scratch-20261112-033528`. The move was same-volume and therefore produced no meaningful capacity recovery (observed filesystem delta was -4,096 bytes); no deletion or recycle-bin operation was performed. The child repository remains independently dirty with source changes, deletions, untracked extraction/profile material, nested Git roots, worktrees and missing-directory warnings.

## Fresh child status after root scratch quarantine — 2026-11-12

A complete `git status --porcelain=v1 -uall` was rerun after the root scratch move. The child repository `D:\Omnia\repos\omnia` is still on `omnia/m0-snapshot` at `55f21dacf5acb2c6f386aff1ece6a5245bad0fc4`; the captured status has 4,772 entries: 199 modified, 2,809 deleted, 1,764 untracked, zero renames, zero added-only entries and zero other statuses. Git emitted 12 missing-directory warnings under upstream extraction paths; those paths remain an unresolved ownership/source-integrity boundary. The authoritative porcelain, stderr and JSON summary are stored at `C:\Users\khang\.codex\research\omnia-clean-2026-11-12\child-status-post-root-scratch-20261112-033648\`. This evidence supersedes the earlier 4,783-entry historical baseline for the current checkpoint only. It does not prove the child is clean, that deleted paths are safe to restore, or that extracted/profile material can be deleted.

## Wave 2 & additive execution receipts — 2026-11-12

Independent final lane audit: `D:\OmniaData\qa\audits-20261112\FINAL_VERIFICATION_RECEIPT_20261112.json` and `FINAL_VERIFICATION_REPORT_20261112.md` -> **`PASS_ALL_SCOPED_LANES_ZERO_OPEN_DEFECTS` (`0` open defects; all 3 mid-wave findings `DEFECT-01..03` repaired and re-verified)**.

### Bound artifacts, test counts and SHA-256 digests

- **Serialized Cargo build & tests (`$env:CARGO_TARGET_DIR = 'D:\OmniaData\tools\cargo-target'`, `524/524` passed)**:
  - `omnia-provider-services` (`31/31`): `src-tauri/crates/omnia-provider-services/src/dynamic_router.rs` (`133,752 B`, `sha256=ce1ef4abdeb631c09fcb6bee1ebcbb1d3d6f6fb88527e7acf81be576ec97c930`).
  - `omnia-harness` (`393/393`; `1` ignored): `proactive_rag.rs` (`52,745 B`, `sha256=e2fa4d338b9fdc4fe8522c4ce895b11bfd1f2f0ec527f962dcd55ba4ec5b9a7b`), `agent_graph.rs` (`55,618 B`, `sha256=adc1da5e9f91db375616707141c03a1f1b9c631f229828274dc31cf14da1b0ef`), `skills.rs` (`sha256=37e29aea7387dc71...`), plus hierarchical/cyclic-graph `memory.rs`.
  - `omnia-session-store` (`71/71`) & `omnia-native` (`29/29`): `native/src/composer.rs` (`82,419 B`, `sha256=2a5463baa284b78346acd2b1bfa205e665399b82bc7d10930d530b3d1f3c78b5`), `native/src/uia_edit.rs` (`20,965 B`, `sha256=1cd9a2649bc3b38c184a68f627abf9b6b29cdcafcbfe3507937560954457a98b`), `native/src/session_panel.rs` (`24,563 B`, `sha256=4c638e4123c851e4d0e4032165cea890fbc4eb47098fb103cba8a6927ebc8c09`), `native/src/win32.rs` (`18,895 B`, `sha256=942c3b648ccc343ac89a9e826c80655b180f64eea96b1bebcda6f1d52157d5cf`).
  - External binaries: `debug\omnia-native.exe` (`3,488,256 B`, `sha256=42e405d28e4b583eb97d56107c63192cb0f4ebbd83aa9c89e7448b95feaa6d7f` at Wave 2 `7/7` QA execution time; relinked to `sha256=d2f7edf167014684428a11d5e42c174e8b62d2681c4fa0c5af48f6d7151bf609` when Wave 3B clean-clone `cargo test` compiled into shared `CARGO_TARGET_DIR`) and `release\omnia-native.exe` (`2,160,128 B`, `sha256=65944d8685fa4e219cbcf43f5d6bf99eb7fb379fa1a4bb2d8caab077380a2872`).
- **External Win32 Native QA (`7/7` workflows, `90/90` cases `rc=0`)**:
  - Receipt: `D:\OmniaData\qa\native-20261112\QA_SUITE_SUMMARY_RECEIPT.json` (`qa-paths.tests.ps1` `40/40`, `qa-capture.tests.ps1` `14/14`, `qa-smoke.ps1` `4/4` with `"uiaIssue": null`, `qa-session.ps1` `5/5`, `qa-paging.ps1` `9/9`, `qa-guard.ps1` `12/12`, `qa-ownership.ps1` `6/6`; `0` status-panel clipping in `1220x820` PNG captures). Note: the two open r7 `QUALITY-01` defects recorded earlier in this file (lines 107–110) are now resolved for this evaluation shell; live provider/IME/Narrator scope remains open.
- **Skills, catalog, history, research, UI direction & cleanup**:
  - `12` curated skills in `.agents/skills/` (`36/36` 3-root `quick_validate.py` `PASS`, incl. `deep-proposal` `SKILL.md` `sha256=c33d1650e106f95b7bee5101552dbaf8f12dc20af7f74a87f55c47abc141dc1e` and `omni-deterministic-verifiers` `SKILL.md` `sha256=02b4ef73f456db8577768d976687219daa46cd34e6f02df1263d16eae70b74b3`); external sanitized GDoc `GDOC_1YSB_SANITIZED.md` (`sha256=099ea575...`) & `omni-deep-1000-catalog.json` (`100` categories / `1,001` specs, `sha256=5075c05b...`); `273` unique skills mounted live across 4 roots in Windows Antigravity.
  - `tools/agy-history-sync/` (`agy_history_sync.py` `sha256=f029c2b1...`, `test_agy_history_sync.py` `sha256=acf55a6d...`, `5/5` tests `OK`): Desktop `144/144` DBs (`0` ghost), CLI `126/126` DBs (`0` ghost), unified FTS5 `1,102` threads (`sha256=efee7f1e...`), `PASS_ZERO_LEAKS` (`sha256=f89557e4...`) across `294` files.
  - `COMPLETE_103_URL_LEDGER.json` (`sha256=ef6d38dc...`) + `REA_8_URL_SUPPLEMENT_LEDGER.json` (`sha256=a9a9eadd...`, `8` REA URLs + `github/spec-kit` `v1.4.0`).
  - `docs/ui-direction/DIRECTION_DECISION.md` (`sha256=7366e4aa...`, `PENDING_USER_REVIEW`) + 3 interactive prototypes under `D:\OmniaData\qa\ui-direction-20261112\`.
  - `SOURCE_DISPOSITION_LEDGER.json` (`138/138` focus rows reviewed, `84/84` delta files/patches hashed; `retirementEligible=false`), `EXTERNAL_LAYOUT.json` (`12` root clutter dirs externalized + `4` worktrees healthy; `Roaming` orphaned SID documented), and `d-drive-reclamation-receipt-20261112.json` (**`+10,871,586,816` B / `+10.125 GiB`** reclaimed on `D:\`).

### Navigable workspace index map

Use [STATUS.md](STATUS.md) to jump directly to [PLAN.md](PLAN.md), [TASKS.md](TASKS.md), [PROMPTS.md](PROMPTS.md), [SESSIONS.md](SESSIONS.md), [SOURCES.md](SOURCES.md), [REFS.md](REFS.md), [STEER_QUEUE.md](STEER_QUEUE.md), and [TRANSFER_CONTRACT.md](TRANSFER_CONTRACT.md).

## Wave 3B GitHub delivery, clean-clone and session admission — 2026-11-12

- **GitHub remote & Commit #1 push (`DELIVERY-01` / `SESSION-G06` -> `PASS_SCOPED`)**:
  - Private repository `https://github.com/khang-macphuc111107/omnia` (`origin` -> `https://github.com/khang-macphuc111107/omnia.git`, owner `khang-macphuc111107`, `credential.https://github.com.username=khang-macphuc111107`) received Commit #1 `d8b456e357dde65d8ee314194743fb93655f5d6a` (tree `5f8ecc4966a859dcc032bca0b3013d2f81233abb`, `2,039` tracked files). Collaborator handle `HTMusTC` was verified to be a Discord handle rather than a GitHub login; collaborator invite is left to the user's exact GitHub login choice under `https://github.com/khang-macphuc111107/omnia/settings/access`.
- **Independent remote GitHub clone & isolated local clone (`ROOT-05` / `SESSION-G01` -> `PASS_SCOPED`)**:
  - Receipt: `D:\OmniaData\qa\github-clean-clone-20261112\GITHUB_DELIVERY_AND_CLONE_RECEIPT.json` (`8,958 B`, `sha256=35aaac06a396bfc60e6d8a9bc893ccaf28c1f298c2ed958f344bdffc9285e610`, `allChecksPassed=true`).
  - Verified checks on `remote-github-clone` and `isolated-local-clone`: both `HEAD` SHAs equal `d8b456e357dde65d8ee314194743fb93655f5d6a` (`2,039` tracked files), `cargo metadata --locked --no-deps` `rc=0` on `src-tauri/Cargo.toml` and `native/Cargo.toml`, `cargo fmt --all --check` `rc=0` on both workspaces, `524/524` locked Cargo tests `rc=0`, `5/5` `tools/agy-history-sync` unit tests `rc=0`, and `12/12` `.agents/skills/*` `quick_validate.py` validations `rc=0`.
- **Release native shell runtime telemetry & `exebox-*` desktop boundary (`QUALITY-01`)**:
  - Receipt: `D:\OmniaData\qa\native-20261112\retained-preview\native-shell-cycle24-runtime.json` (`6,111 B`, `sha256=1a4aa5cac935a76687432cb9ccf54fb4e390c2ef50cfc26c95b545fb9dd93a77`) and `native-shell-cycle24-window.png` (`107,800 B`, `sha256=68b669ce7e26e0d9abe2836490ca78f9566184607c7903d81e259a7f4e0c7ded`).
  - Measured `D:\OmniaData\tools\cargo-target\release\omnia-native.exe` (`2,160,128 B`, `sha256=65944d8685fa4e219cbcf43f5d6bf99eb7fb379fa1a4bb2d8caab077380a2872`): `16,560,128 B` (`15.79 MiB`) working set (`17,453,056 B` peak), `0.0%` idle CPU, `163.22 ms` window discovery, `4/4` mode/close smoke checks passed, `uiaIssue: null`.
  - Honest desktop boundary: Antigravity executes tool commands inside isolated `exebox-*` Windows desktops rather than the interactive `Default` desktop, so `PID 11532` was cleanly terminated after capture (`0` orphan processes) rather than leaving an invisible background process. Launch `D:\OmniaData\tools\cargo-target\release\omnia-native.exe` directly from an interactive `Default`-desktop terminal/Explorer session to inspect live.
- **4-way `/learn` synchronization & `SESSION_ADMISSION.json` `READY`**:
  - `~/.codex/AGENTS.md` updated with `OMNIA_CONTINUITY_AND_PEER_MESH`, all `12` curated skills synchronized byte-identically across `D:\Omnia\.agents\skills\`, `~/.codex/skills/`, `~/.agents/skills/`, and Antigravity (`4-way` parity), and `8` pure-`LF` notes authored in this session under `ad_hoc/notes` (including `2026-11-12-antigravity-win32-uia-and-git-lessons.md`, within a shared multi-session directory of `60+` `.md` notes where `33` pre-session historical notes use `CRLF`).
  - [SESSION_ADMISSION.json](SESSION_ADMISSION.json) advanced to **`READY`** (`SESSION-G01..G07` satisfied, `promptSha256=d277af284a6e2d8716f9ccb77ef07a16326321d53b725520c4499015d8619cfb`). Handoff docs `COLLABORATOR_HANDOFF.md` (`sha256=535867f2...`) and `USER_PROMPT_REQUIREMENTS_MATRIX.md` (`sha256=3e8c56f8...`) are synchronized (`PASS_ZERO_LEAKS` `sha256=f89557e4...`); the pushed `HEAD === origin/master` snapshot is audited across 3 independent frozen-snapshot verification rounds under `D:\OmniaData\qa\audits-20261112\final-streak-3\`.

## Wave 3 3-round clean audit & Wave 4 Full Native C++20, Flagship Studio UI and C:/D: deep-clean receipts — 2026-11-12

- **Pre-C++20 3-Round Audit Closure & Lossless Git Tag (`archive/pre-cpp-rust-snapshot-20261112`)**:
  - Commit #2 (`1e342592aa85d8e0fdb453e4c337a00000b0cbfb`) and Commit #3 (`c3033728abe6f0a4906a796bf7652c84408356d7`, tree `6198c676e8ef3e2ef055625d0126d7216b57fac1`) resolved all R1–R3 audit findings and earned **3/3 independent zero-finding audit rounds** (`round-1-v2-receipt.json` `sha256=830288fb...`, `round-2-v2-receipt.json` `sha256=928982af...`, `round-3-v2-receipt.json` `sha256=e880b431...`), archived on pushed tag `archive/pre-cpp-rust-snapshot-20261112` + `D:\OmniaData\recovery\pre-cpp-ignored-files-20261112\MANIFEST.json` (`sha256=0da021493635b1861e0fa21106abaf285dd175cc5080027f7677446b79a53709`).
- **Wave 4 Consolidated Independent Audit (`7/7` Lanes PASS, `0` Open Defects)**:
  - Master receipt: `D:\OmniaData\qa\audits-20261112\FINAL_WAVE4_VERIFICATION_RECEIPT_20261112.json` (`2,621 B`, `sha256=0e776c268a90fd712d390f3427a26bc503641438439cd69411c4221fd4ba47fc`) and `FINAL_WAVE4_VERIFICATION_REPORT_20261112.md` (`2,802 B`, `sha256=4c6fefbec6e040fa65c44ae4378894d3dccba3954c97333196cdc5c8b4313f62`).
  - Lane receipts: `audit-wave4-skills.json` (`bd4a63d8...`), `audit-wave4-ui.json` (`d28d9bb3...`), `audit-wave4-cpp-core.json` (`19b5da2c...`), `audit-wave4-cpp-native.json` (`86a3cc0a...`), `audit-wave4-cdrive-and-handoff.json` (`c4f23330...`), and `audit-wave4-ddrive-and-whole-repo.json`.
- **Wave 4 Bound C++20, UI, Skill, Handoff & Deep-Clean Artifacts**:
  - **Root & C++20 Core (`cpp/`, `10,287` LOC, `6/6` CTest suites PASS)**: `CMakeLists.txt` (`1,053 B`, `sha256=9c007cf33eee0b89c98e5847441523d340cae07f90d7ebb84442e448bb1c42e8`), `CMakePresets.json` (`1,956 B`, `sha256=2347b9869adbb961cc53a710b6bdb0942a29b0f78f7365b61bdf319dca7a6473`), `cpp/CMakeLists.txt` (`2,437 B`, `sha256=7f157c3382f9a6c1d748bd2df1ce149df816e300d33386f94b7681936361f3df`), `cpp/src/studio/studio_server.cpp` (`78,394 B`, `sha256=584dfe742d830cd700b65b6357a31631faa7fc05a472ea9cd6f93ad72f22c6a4`); external Release `omnia-studio.exe` (`687,616 B`, `sha256=fb7872433110f450d98a91f250df53cc7accb1cd858e11a75679756e380b5a5c`, `9.30 MiB` working set) & Debug `omnia-studio.exe` (`2,929,152 B`, `sha256=e0419d700db6128902d99cbd0bbdb5c24ac4d13fc2c992183ec2cf8e47d05afc`).
  - **Native Win32 C++20 Shell (`native/`, `29/29` CTest cases PASS; unified `35/35` CTests PASS; `7/7` Win32 QA `90/90` `rc=0`)**: `native/CMakeLists.txt` (`4,189 B`, `sha256=f373689eba9b199a679ed014e8808500c235d43e9bfc874505d294d4b46ae634`), `native/README.md` (`4,454 B`, `sha256=58fcaab5486165ff9eaef85c4bf6dd796a1c0418669876da59c744bd216045ac`); external Release `omnia-native.exe` (`289,792 B`, `sha256=41030923c5f42444157aea6b8a83522d6fa5ed96831f4c8c98f240bd997c550c`), `omnia_qa_seed.exe` (`142,336 B`, `sha256=51c20e5a47524115ef8186911e93b81126ae17a853e44bd6db9a195103d74e3d`), `omnia_native_tests.exe` (`584,704 B`, `sha256=775b77fd0e63d0838de332752e5c78d946eba4e5316ba9d00b7908cb7d491f47`), Debug `omnia-native.exe` (`2,405,888 B`, `sha256=b356a24b6bce67cfc52c266f9d646c77bc27938c1cb0ab875552586be741846b`), and `D:\OmniaData\qa\cpp-native-precheck-20261112\QA_SUITE_SUMMARY_RECEIPT.json` (`sha256=6f668cb0f38e3ae22c05d312bf28b3cd91a5dc6cc471c7169da3e2fd39d3151d`). Note: Wave 2–3 Cargo binaries in `D:\OmniaData\tools\cargo-target` cited in historical sections above were intentionally reclaimed during Wave 4 Action B (`+12.63 GiB`) after archiving `archive/pre-cpp-rust-snapshot-20261112`.
  - **Flagship Studio UI ("Obsidian Kinetic Atelier")**: `ui/index.html` (`37,428 B`, `sha256=914e14917f63f5aff813352b4bd269eb961dd9128ed14994aa1108cbd6690d7d`) + [FLAGSHIP_STUDIO_UI_SPEC.md](../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md) (`11,506 B`, `sha256=db381ed0dcb84a3eab6e62d02ac2da37d90ea1dee863fd779ac34deee9a2e8c3`; `87/87` WCAG 2.2 checks `>= 5.12:1`, `45/45` Edge CDP states `maxOverflowX = 0 px`).
  - **13 Curated Skills & Handoff Suite**: `deep-cpp-native/SKILL.md` (`sha256=b87fd5ca3472223c84c9d4a55f6a3f8e4a892fa4c31204a22f2a530551920634`), `omni-bilingual-skill-router/SKILL.md` (`sha256=e65f88d0c566ffcc431319e42687f361da002aeb0076300b3cecb5c58e25b6c6`), `cpp-skill-sync-receipt.json` (`sha256=27df8cf8a51c6b2ecce1ade32136d3fff18234a1809c6472c8270596f530db33`); `COLLABORATOR_HANDOFF.md` (`sha256=50a191c0...`), `USER_PROMPT_REQUIREMENTS_MATRIX.md` (`sha256=0c29f1d9...`), `BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md` (`sha256=35c7f92d...`), `LESSONS_LEARNED_AND_ANTIPATTERNS.md` (`sha256=27f303ae...`), and `SECRET_SCAN_VERIFICATION.json` (`sha256=a01b88f620fa5ff70bdad9c068afefb5b9daca661f172717bcbc8043d84dd1ac`, `PASS_ZERO_LEAKS`).
  - **`D:\` & `C:\` Deep-Clean Audit Reports & Receipts (`+944.29 GiB` physical)**: `.gitignore` (`1,067 B`, `sha256=34b53acc61c5de712e3ac3ec94c37147be86d1ba02e716bf51995c43fcb60191`), [DEEP_CLEAN_AUDIT_D_DRIVE.md](DEEP_CLEAN_AUDIT_D_DRIVE.md) (`29,379 B`, `sha256=a51f017a02ecfc8c0e81bace752fcc99dd4876f764b7237b42c0ae7234882aed`), `D_DRIVE_DEEP_CLEAN_RECEIPT.json` (`63,685 B`, `sha256=70f2781df22d91d33bfe0559344041281ea55ea8cec7a9a3eb73a650bc3253af`, `+778.1512 GiB` physical -> `837.57 GiB` free), [DEEP_CLEAN_AUDIT_C_DRIVE.md](DEEP_CLEAN_AUDIT_C_DRIVE.md) (`29,828 B`, `sha256=1a88e1fe3ae9cafc2bd8a49b941f42c08b02aa15d8a9daadc57fa151f4922ac6`), and `C_DRIVE_DEEP_CLEAN_RECEIPT.json` (`48,134 B`, `sha256=ee08c5a0fdd87b67ff3e8b04630d6f62ca249e20fbd6b7af802440fd354060eb`, `+166.1357 GiB` physical -> `189.60 GiB` free).
  - **Commit #5 GitHub Push & Zero-Bloat Clean-Clone C++20 Receipt**: Bound externally in `D:\OmniaData\qa\github-cpp20-clean-clone-20261112\GITHUB_CPP20_DELIVERY_RECEIPT.json` (`HEAD === origin/master`, unified Release CMake/Ninja build + `35/35` `ctest --output-on-failure` PASS, temporary clone and build directories immediately purged).

## Wave 5 (`Steer #14..#15`) Full Native Rust 17-crate & Phase 0 baseline — 2026-11-24

- **Pre-Full-Rust C++20 Backup (`D:\OmniaData\backups\pre-full-rust-20261115\`)**: Verified SHA-256 backup manifest `manifest.sha256.json` covering `55` superseded Wave 4 C++20/CMake files (`patch_bytes: 361065`). Active source tree contains **`0` `.cpp`/`.hpp`/`CMake*`** files.
- **17-Crate Full Native Rust Cargo Workspace (`Cargo.toml`, `Cargo.lock`, `rust/*`, branch `omnia-sota-harness`)**:
  - Core & subsystem crates (`13`): `omnia-winsqlite`, `omnia-core`, `omnia-storage`, `omnia-routing`, `omnia-graph`, `omnia-harness`, `omnia-connector-gateway`, `omnia-workspace-ops`, `omnia-media-capture`, `omnia-remote-control`, `omnia-agent` (`27` `*.rs`), `omnia-downloader` (`15` `*.rs`), `omnia-notebook` (`13` `*.rs`).
  - Binary & shell crates (`4`): `omnia-cli` (`omnia.exe`), `omnia-runtime` (`omnia-runtime.exe`), `omnia-studio` (`omnia-studio.exe`), `omnia-native` (`omnia-native.exe` + `omnia_qa_seed.exe`).
  - Maintained Python/Node tooling added since Nov 15: `tools/omnia-benchmark/` and `tools/omnia-gemini-extractor/`.
- **Phase 0 Hygiene & 19-Skill Parity (`2026-11-24`, `@hygiene-gov`)**:
  - Removed forbidden in-tree `D:\Omnia\target\` (`3,009` files, `1,114,962,395` B, `0` reparse/tracked) and `D:\Omnia\tools\omnia-benchmark\__pycache__\` (`13` `.pyc` files, `296,328` B), freeing `+1,108,557,824` bytes on `D:`.
  - Relocated `D:\Omnia\Roaming\` (`5` files, `1,576,297` B, `0` reparse/tracked, verified SHA-256 readback) to `D:\OmniaData\quarantine\roaming-20261124\Roaming` (`RELOCATION_RECEIPT.json`, same-volume `0` capacity credit).
  - Updated `D:\Omnia\.gitattributes` with explicit `text eol=lf` rules for all source/doc/config/script/UI files.
  - Shortened `deep-general-graph-orchestration` `SKILL.md` `metadata.short-description` and `agents/openai.yaml` `interface.short_description` to `60` chars (`<= 64`), updated `validate_skills.py` cross-drive profile resolution (`E:\Users\khang`) + `E:\Users\khang\.gemini\config\skills.json`, and verified **`19/19` skills valid, `0` cross-host drift, `17/17` validator tests OK**.
  - Updated governance & handoff docs to remove dead `cpp/`/`CMakeLists.txt` links and document all 17 crates, `tools/omnia-benchmark`, `tools/omnia-gemini-extractor`, and `Steer #15` Omnia v5 objective.
  - Resolved Nov 24 Phase 0 cross-lane CRLF and secret-scanner blockers in clean baseline `0f18b34`, landed Wave 1–2 (`a7f56c3..178492b`), Wave 3.1–3.3 (`a793bb7..49e8746`), Steer #16 Gate A (`35d73ce`) & canonical `FINAL_SCOREBOARD_V5` (`b0587fb`), and Steer #17 (`552438a..0b8be95`):
    - `a7f56c3..49e8746`: 17-crate Rust SOTA v5 harness + `ui-v5` Studio/IDE (`embed-ui`) + `ratatui` CLI + `omnia-native --studio` + ConPTY/RSS/Anthropic/retry/`56 KB` PTC fixes + `lto = "fat"` + `cpp-c-ast` feature gate + MSVC `/DELAYLOAD` + `clippy --all-targets -- -D warnings` cleanup.
    - `35d73ce..b0587fb`: Steer #16 default `EffortLevel::Max` + CLI `--effort` + all-51 `htmustc.id.vn` auto-routing + post-first-byte SSE wire-idle watchdog + full parallel `FINAL_SCOREBOARD_V5` (`793` trials/rows, `7,277` wire rows, `51/51` models probed, independently verified PASS by `@verifier` in `D:\OmniaData\qa\v5-verify\wave3-final-audit.json`: `6/6` scopes `finding_count: 0`, `integrity_passed: true`, `final_scoreboard_v5.json` `0.398 MiB < 2 MiB`, Suite v5 `#1 omnia 69/76 = 90.79%`, all 6 McNemar `p < 1e-5`).
    - `552438a..0b8be95`: Steer #17 Native Rust Network/Speedtest/Bufferbloat Observatory (`omnia-workspace-ops::net_diag`), `p50..p99/IQR` telemetry, SQLite Router Lab Trip/Reset & 5-segment waterfalls, CredMan CRUD, Global Privacy Mask (`P`), Alerts/Diffs/Exports, live `/api/benchmarks/scoreboard` UI, TUI cockpit, and `QUALITY-01` Win32 closure (`steer17-fullstack-0b8be95.json` `13/13`, `steer17-playwright-0b8be95.json` `16/16` WCAG `>= 5.94:1`, `native-qa-steer17/summary.json` `7/7` `pwsh` `90/90` `uiaIssue: null`, all 5/5 release binaries staged with `omnia.exe` `11.693 MiB` / `8.99 ms`).
- **Additive Steer #18 + Steer #19 + Steer #20 (`2026-11-28`, `ADDITIVE_INTAKE`, `token_budget = NULL`) & Remaining Gates (blocking `SESSION_ADMISSION.json` `READY`)**:
  1. Governance/skills & carry-forward `AUD-30`/`AUD-31` landed (`@hygiene-gov`): `AUD-30`/`AUD-31` ported to `tools/agy-history-sync/{agy_history_sync,test_agy_history_sync}.py` (`7/7` tests PASS); 3 new atomic skills (`deep-research`, `deep-think`, `super-plan-run-lifecycle`) authored + `omni-bilingual-skill-router` upgraded (`34+` synonyms, `24` Rust-native pipelines, `16/16` bilingual golden eval) -> **`22/22` 3-way synced skills (`16` curated + `6` `kdense-*`, `0` drift)**; Steer #18–#20 Addendum added to [`../architecture/OMNIA_DEEP_AUDIT_AND_ENHANCEMENT_SPEC.md`](../architecture/OMNIA_DEEP_AUDIT_AND_ENHANCEMENT_SPEC.md).
  2. Active Steer #18–#20 Phase 2 Rust + UI implementation (`@studio-net-api`, `@harness-opt`, `@ui-native-flagship`): native `omnia-harness::{research_vault,deep_think,artifact_os,skill_registry}` + Studio `/api/v5/{research,think,lifecycle,learn,skills,rag}/*` + OmniDrive v3.0 / Atelier endpoints + `AUD-09`/`AUD-14`/`AUD-26`/`T2.3`; Default-ON Deep Research / Deep Think / Lifecycle agent tools + multi-backend search + CLI/TUI; and `ui-v5` Universal Markdown/LaTeX/Code Cards + `SourcePreviewModal` + `ResearchSourceDrawer` + `MissionLifecycleView` + 4-Tab `OmniDriveView`.
  3. Final Wave 4 cleanroom closure: serialized 17-crate `--workspace --offline --locked` + Vite `ui-dist` + `omnia-studio --features embed-ui` + standalone `omnia-cli --release` (`<= 14 MiB`, `<= 15 ms`), `7/7` `pwsh` QA, 4×4 4x-CPU Playwright E2E + `--require-scoreboard` + `verify_steer18_20`, frozen `dirty_total: 0` commit (`@build-gate`), `audit.py --secret-scope all --strict --strict-scope full`, `validate_skills.py --strict-all-skills` (`22/22`, `0` drift), and **`3` consecutive frozen-snapshot cleanroom audit rounds (`@verifier`)** before advancing `SESSION_ADMISSION.json` from `DEFERRED` to `READY`.
