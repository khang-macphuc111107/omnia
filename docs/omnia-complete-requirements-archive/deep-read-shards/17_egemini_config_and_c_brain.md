# Wave 1 Shard 17 Exhaustive Deep-Read Report: `E:\Users\khang\.gemini` & `C:\Users\khang\.gemini\antigravity\brain\`

- **Swarm Role / Shard:** `egem-config-cli` (`#388`)
- **Timestamp:** `2026-11-28T17:02:00+07:00`
- **Mode:** Strictly read-only across all targets (`D:\Omnia`, `E:\Users\khang\.gemini`, and `C:\Users\khang\.gemini` untouched; report written solely to `D:\OmniaData\research\mega-deep-read-20261128\17_egemini_config_and_c_brain.md`).
- **Secret Hygiene:** Zero OAuth credentials, `clientSecret`s, bearer tokens, session cookies, API keys, or personal account emails included.

---

## 1. Complete Coverage Ledger (Zero-Skip Accounting)

### 1.1 Target (A): `E:\Users\khang\.gemini\`

| Subtree | Total Files on Disk | Strictly Excluded (`.pb`, `.db*`, creds, cookies, `conversations/`, media) | Vendored / Build Excluded | Active Text / Code / Config Inspected | Key Observed Artifacts & Breakdown |
| :--- | ---: | ---: | ---: | ---: | :--- |
| `GEMINI.md` | 1 | 0 | 0 | **1** | `9,510` B global execution continuity rule (Additive Steer Queue, `token_budget=NULL`, Graphify-first, PeerMesh `disjoint_paths`, `ALWAYS_ACCEPT_LEARN`, Steer #18–#23 invariants). |
| `config/` | 1,146 | 31 | 0 | **1,115** | `config.json` (18 plugins, 1 disabled `neo4j`, turbo `userSettings`), `skills.json` (4 mounts), `node_modules/sidecar_sdk/` (4 files), `projects/` (6 JSONs), `plugins/` across **19 plugins** (`690` `.md` skills/specs/refs + scripts/configs/tests). |
| `skills/` | 5 | 0 | 0 | **5** | `agent-reach` (`SKILL.md` + `references/{capabilities,maintenance,sessions}.md`, v1.6.1) + `antigravity-cleaner` (`SKILL.md`, v5.4.7). |
| `antigravity-dev/` | 33 | 4 | 0 | **29** | `antigravity_state.pbtxt` + `builtin/` (`19` `.md`, `10` scripts/manifests). SHA-256 diff vs `antigravity-cli/builtin/`: `17/20` skills/docs identical; **3 differed** (`hooks.md`, `generative_ui/SKILL.md`, `plugin/SKILL.md`); `0` dev-only files. |
| `antigravity-cli/` | 25,260 | 1,312 | 14,958 (`go-sdk/`) | **8,990** | `32` top-level configs/logs/caches/annotations (`settings.json`, `jetski_state.pbtxt`, `history.jsonl`, `cli.log`, `log/*.log` [6], `cache/CHANGELOG.md` 1.0.0..1.4.12 [1,165L], `cache/marketplaces/*` [official 20, partners 60], `annotations/c2cc6103-*.pbtxt`) + `41` `builtin/` (`swarm` sidecar & skills) + `116` `brain/` user `.md`/scratch/evidence files + `8,801` `.system_generated/` logs/steps/chunks across `126` session dirs (`123` `transcript.jsonl`, `17,843` JSONL lines, `28` `USER_INPUT` prompts). |
| `history/` | 29 | 0 | 0 | **29** | `history/2/` minimal shadow `.git` workspace (`HEAD` -> `main`, empty `gitignore`, standard `.git/hooks/*.sample`). |
| `tmp/` | 5 | 0 | 0 | **5** | `tmp/2/.project_root` + `4` `tmp/2/chats/session-2026-11-07T10-{48,49,50,52}-a2a-serv.jsonl` (`12` lines total). |
| **Total (A)** | **26,479** | **1,347** | **14,958** | **10,174** | Note: `8851cf65/scratch/go-sdk/` (`14,958` upstream Go stdlib files) verified by tree inventory and skipped to prevent context flooding; `agy-filter/__pycache__` `.pyc` noted as binary cache. |

> **Exclusions Honored Strictly (Zero Bytes Read):** `oauth_creds.json`, `google_accounts.json`, all `.pb` / `.db` / `.db-shm` / `.db-wal` / `.sqlite` files (including `antigravity-cli/conversations/*.pb`, `conversation_summaries.db`, `implicit/*.pb`, `jetbox_summaries_proto.pb`), image/font binaries, and `clientSecret` fields inside `config/plugins/g*/auth.json` (only architectural schema observed; secrets withheld).

---

### 1.2 Target (B): `C:\Users\khang\.gemini\antigravity\brain\`

| Metric / Partition | Count | Notes / Exact Reconciliation |
| :--- | ---: | :--- |
| Total directory entries on disk (`2026-11-28 17:03`) | 109 | `108` UUID session dirs + `1` `tempmediaStorage` (`78` target + `4` excluded/self + `26` post-`16:44` swarm siblings = `108`). |
| Excluded coordinator / self IDs | 4 | `066f4171-cb88-4797-816e-4e107558a1b6`, `28bd73cd-19ec-4507-b6bc-36427ff0aa94`, `761c8ffe-7157-4ece-ba6f-a774211c7075`, and self `e5748b75-6a27-40b0-a20c-01eaa3904e70`. |
| Active Wave 1 swarm sibling folders (`mtime >= 2026-11-28 16:44:34`) | 26 | Spawned concurrently after Wave 1 launch; excluded from pre-swarm target denominator. |
| **Pre-Swarm Target (B) Sessions (`mtime < 2026-11-28 16:44:00`)** | **78** | Reconciles to brief's **"82 session folders"**: `78` targets + `3` explicitly excluded (`066f4171`, `28bd73cd`, `761c8ffe`) + `1` self (`e5748b75`) = `82` pre-swarm baseline sessions. |
| Target (B) Transcripts Parsed | **78 / 78** | **`49,593`** `transcript.jsonl` lines parsed (+ targeted `transcript_full.jsonl` hydration for all truncated `USER_INPUT` and `send_message` payloads); **`175`** `USER_INPUT` prompts across **`12`** primary human sessions + **`66`** subagent/pipeline sessions. |
| Target (B) Non-System `.md` Artifacts Inspected | **18 / 18** | `f523d245/scratch/omnia_integration_blueprint.md` (1 file), `2a6c295c/scratch/shard01/*.md` (15 files incl. `child_9fee_{full,ledger}.md`, `report_{4a34_v2_final,6489_full}.md`, `user_prompts.md`), `95d0b4c9/scratch/shard02/*.md` (2 files: `board_digest.md`, `planner_digest.md`). |
| Target (B) Non-Build Scratch Files Inspected | **133 / 133** | Excludes `3,878` Rust `target/` & `node_modules/` build files while reading `Cargo.toml`, `Cargo.lock`, `.rs`, `.py`, `.mjs`, `.ps1`, `.diff`, `.json`, and `.txt` harness outputs. |
| Target (B) Browser Sandbox Files Accounted | **206** | Across `839651bb` (15 files) and peer session `browser_sandbox/` captures. |

---

## 2. Config, Plugin & Built-in Architecture Findings (`Target A`)

### 2.1 User Settings, Skill Mounts & Plugin Registry (`E:\Users\khang\.gemini\config\`)

1. **`config.json` (`160L`)**:
   - **18 Installed Plugins** (`neo4j` disabled `"enabled": false`): `agy-filter`, `auth0`, `browse`, `chrome-devtools-plugin`, `gcalendar`, `gdocs`, `gdrive`, `gmail`, `gsheets`, `gslides`, `keenable`, `keenable-select`, `modern-web-guidance-plugin`, `neo4j`, `parallel`, `science`, `supabase`, `superpowers`, `tavily` (`19` dirs on disk including `agy-filter`; `marketplace` cache holds `20` official + `60` partner plugins).
   - **High-Autonomy `userSettings`:** `ARTIFACT_REVIEW_MODE_TURBO`, `CASCADE_COMMANDS_AUTO_EXECUTION_EAGER`, `BROWSER_JS_EXECUTION_POLICY_TURBO`, `enableTerminalSandbox: false`, `AGENT_SETTING_POLICY_ALLOW`, `AGENT_PERMISSION_PRESET_TURBO`, `MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION`, `remoteControlEnabled: true` (`remoteControlHostname: "acernitro5-silent-shard"`), `useAiCredits: true`, `verboseConversationSteps: true`.
2. **`skills.json` (`17L`)**: Mounts 4 skill roots (`D:/Omnia/.agents/skills`, `E:/Users/khang/.codex/skills` excluding `.system`, `E:/Users/khang/.codex/skills/.system`, `E:/Users/khang/.agents/skills`). Note: `CHANGELOG 1.2.10` changed directory scanning from recursive to top-level-only unless `include_only` names nested paths!
3. **`node_modules/sidecar_sdk/` (`index.mjs`, `preload.js`, `esm_resolver.js`, `register_loader.js`)**:
   - Loopback `127.0.0.1` HTTP bridge authenticated by `X-Sidecar-Token`.
   - Direct `ANTIGRAVITY_AGENTAPI_EXE` execution avoids Windows `.bat` `spawn` `ENOENT` issues (`agentapi.bat` only wraps `language_server.exe` otherwise).
   - `preload.js` synchronizes host theme CSS tokens onto `:root`, forwards keyboard chords while guarding IME composition & editable inputs, and exposes `window.sidecar.{fetch,getWorkspaceUris,onWorkspaceChange,agent,ui}`.

### 2.2 Notable Plugin Engineering Patterns in `config/plugins/` & `skills/`

- **`agy-filter` (`776L` Python hook + 3 test suites / 47 tests + 5x verifier):**
  - `PreInvocation`: injects `PRE_FRAMING_MARKER` with a 20-step / `1800s` per-session cooldown (`claim_pre_framing`) to prevent spurious safety/refusal triggers.
  - `Stop`: O(1) backward 256KB-chunk `USER_INPUT` tail-reader (`read_current_turn_tail_lines`), tri-classifies failures (`phrase_filter` / `soft_refusal` EN+VN / `stream_drop` `503`/`EOF`/`MAX_TOKENS`/`MALFORMED_FUNCTION_CALL`), fail-fasts on `_NON_RETRYABLE_ERROR_RE` (`401`/`403`/invalid key), and escalates across 3 recovery tiers (`<=3`, `<=7`, `8..12`, `MAX_RECOVERY_ATTEMPTS=12`, atomic state writes with `STATE_TTL_SECONDS=86400`).
  - **Gap discovered vs `antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`:** `hooks.md` (CLI `1.4.x` era) adds `Stop.continuationActive` + `terminationReason` enums and `PreInvocation.terminationBehavior: "terminate"` + `metadata.user_markdown` (rendered to user UI only, hidden from model context) + `PLUGIN_ROOT`/`PLUGIN_DATA` env vars — `agy-filter/filter.py` does not yet inspect `continuationActive`.
- **`superpowers` (`208` files incl. `docs/superpowers/specs/*.md`, `docs/porting-to-a-new-harness.md`, `docs/windows/polyglot-hooks.md`):**
  - **Empirical Harness Studies (`2026-06-10`, `07-06`, `07-15`, `07-30`, `10-06`):**
    - *"Cheapen mechanics, never judgment"*: weak/haiku reviewers missed `10/10` defects and even advocated for broken code; controller downgrade collapsed quality gates `4/5`.
    - Scoped re-reviews + 5-round fix-loop circuit breaker (3 resumes + 2 capable takeovers + human escalation) cut subagent thrash.
    - Plan-scoped workspaces (`.superpowers/sdd/<plan-slug>/`) eliminate cross-plan ledger collisions and `6–13` wasted git forensic tool calls (`task-start` / `task-done` single-call atomic scripts).
    - **Three-Path Brainstorming Router (`2026-07-30` T4):** classifies tasks aloud (`Spike` / `Bounded` / `Architectural`, taking heavier path when uncertain) and enforces `worker-review prohibition` (T1: workers never spawn sub-reviewers recursively unless explicitly structured).
    - **Windows Polyglot Hooks (`hooks/run-hook.cmd` + `docs/windows/polyglot-hooks.md`):** extensionless hook scripts prevent Claude Code/shell `.sh` auto-prepend; no `-l` login shell, no `cygpath`, silent clean exit when Git Bash is absent.
    - **Visual Companion Auth Hardening (`2026-06-10`/`11`):** `HttpOnly; SameSite=Strict` port-scoped cookies, WebSocket `Origin` header check, `fs.realpathSync()` containment inside `CONTENT_DIR` rejecting symlinks & hardlinks to `state/server-info`, stripping bearer tokens from visible URL after bootstrap.
- **`modern-web-guidance-plugin` (`policies/modern-web-guidance.toml`):** Uses TOML declarative policy rules (`toolName`, `commandRegex`, `decision = "ask_user"`, `priority = 100`, `modes = ["plan"]`) — clean pattern for mode-gated tool policies.
- **Google Workspace CLIs (`gcalendar`, `gdocs`, `gdrive`, `gmail`, `gsheets`, `gslides`):** Consistent `auth.json` OAuth2 token delivery via env (`GCLI_ACCESS_TOKEN`) + polyglot `.cmd`/POSIX launcher shims caching pinned binary builds under `ANTIGRAVITY_APP_DATA_DIR/plugin_data/<dir>/bin/<tool>-<version>.exe`.
- **`keenable` (`scripts/gitleaks-selftest.sh`):** Builds runtime-assembled synthetic secret fixtures inside `mktemp -d` with mandatory `hit`/`miss` expectations so `.gitleaks.toml` allowlists never silently widen to blind production tests without tripping repo scanners on test literals.
- **`agent-reach` (`skills/agent-reach/`, v1.6.1) & `antigravity-cleaner` (`skills/antigravity-cleaner/`, v5.4.7):** Read-only web/social extraction via CloakBrowser/Chrome dedicated debugging ports + OpenCLI selective cookie reuse (`NEED_LOGIN`/`PLATFORM_BLOCKED`/`RATE_LIMITED`/`BUSY` honest gates, `2/platform`, `4/total`, `10s` cooldown); `antigravity-cleaner` provides `isProtectedPID` ancestor shield + 16-target quota/cookie maintenance.
- **`browse/opencode/` & `scripts/validate-template.mjs`:** Cross-harness OpenCode plugin adapter + 39-rule marketplace/plugin template validator (rejects `..` or absolute paths, missing frontmatter, manifest/marketplace name mismatches).

### 2.3 Antigravity CLI Builtins & Changelog Forensics (`E:\Users\khang\.gemini\antigravity-cli\`)

- **`antigravity-dev` vs `antigravity-cli` Diff:** `17/20` shared files byte-identical; CLI (`1.5.6`) updated:
  - `hooks.md`: added `PLUGIN_ROOT`/`PLUGIN_DATA` env vars, `PreInvocation.terminationBehavior: "terminate"`, `errorMessage.userMessage`, `metadata.user_markdown`, and `Stop.continuationActive` + `terminationReason` enums.
  - `generative_ui/SKILL.md`: flush inline embeds (`p-0 m-0`, `<= 450px` target / `800px` cap, no outer card, semantic CSS variables incl. `--card-border`, `--code-foreground`, `--link`, `--chart-1..6`, forbidding `:root` fallbacks and `--vscode-*`/`--app-*` host internals).
  - `plugin/SKILL.md`: blocked `run_command` Language Server RPC mutations (`JetboxWriteState`, `DeletePlugin`, `InstallCustomization`), replacing them with `customization://<dir>` links and `<plugin-card catalog-id="..."></plugin-card>` cards.
- **`builtin/plugins/swarm/` (`main.mjs`, `hive.js`, `channels.mjs`, `narrator_bootstrap.js`, `styles.css`, `hive.css`, plus `native_swarm`, `swarm_narrator`, `swarm_monitor`, `swarm_pane`):**
  - `SWARM_OVERVIEW` feature flag toggles `narrator` sandboxed `srcdoc` HTML (`FRAME_CSP`, `GATE_SETTLE_MS=100`, `GATE_SPAM_MS=250`, `ACTIVATION_MS=5500`) + fallback coordinator `plan.json` threads (`hive.js`) + `SHOT_RE` visual progress reel + before/after swipe comparator + `1x/2x/3x` device-pixel-snapped Pixel Bees (`snapBees`)!
  - `channels.mjs`: `#channel` / `@#channel` routing (`channelsAt`, `activeAt`, `seesIn`, `visibleUnread`).
  - `swarm_monitor`: `*/3 * * * *` daemon (`STUCK_MS=600000`, `STEP_ERROR_SETTLE_MS=60000`), 3-alert cap, goes dormant on bare `[done]` without `@`.
  - **Bug lesson in `main.mjs` / `native_swarm`:** Coordinator uses `view_file`/read on narrator files via `allowedFilesOf`/`canonicalFile`, workers write `workspace:"share"` worktrees, while `inherit` verifiers CANNOT see uncommitted edits in a worker's `share` worktree unless committed/merged or explicitly targeting the worker's worktree path!
- **`cache/CHANGELOG.md` (`1.0.0`–`1.4.12`, `1,165L`) High-Signal Harness Engineering Tricks:**
  - `1.3.x–1.4.x`: `_meta: {"antigravity/alwaysLoad": true}` MCP per-tool opt-in + 10KB output truncation threshold; `_meta["antigravity.google/root_conversation_id"]` on MCP `tools/call`; OSC 7501 terminal tab status; `/compact` preserving images/PDFs + parent's 10 recent messages + tool declarations for **KV prefix reuse**; `GIT_EDITOR=false`/`HGEDITOR=false`/`JJ_EDITOR=false` env suppression; 5-min SSE stall retry dropping empty steps; outdated thinking-block sanitization on mid-turn tool/prompt mutation; `INVALID_MEDIA` byte-offset header recovery; ConPTY Windows key-release filtering (`1.1.18`); `-70%` scrollback allocation & `-100MB` startup trim at `15s`; `/diff` `Per Turn` consolidated diffs, hunk folding, `/` search, `Commit Tree`; non-recursive customization scans (`1.2.10` `include_only`); dedicated 20,000-token rule budget (`1.2.7`); symlink dedup for rules (`1.2.15`); Go `time.Duration` `--print-timeout`; Windows file-delete sharing-violation retry (`1.1.22`); SQLite WAL checkpoint on exit & `too many SQL variables` revert batching (`1.1.14`, `1.1.26`).

---

## 3. Session Prompts, Unfinished Work & Technical Discoveries Across Both Brains

### 3.1 `E:\Users\khang\.gemini\antigravity-cli\brain` (`126` dirs, `123` transcripts, `28` `USER_INPUT`s)

| Session | Prompts / Focus | Status / Unfinished Work | Key Innovations & Lessons |
| :--- | :--- | :--- | :--- |
| **`061ffa08`** | 7 prompts: HCMUT DSA Lab Topic 3 live in Chrome Canary -> rejected silent Playwright -> demanded **non-hijacking Virtual Pointer & Keyboard overlay** ("tạo ra con chuột và bàn phím lẫn lớp overlay riêng") -> picked `"cách 2"`. | `314` steps (`GENERIC/DONE`), **unfinished** user goal on live Topic 3 completion & virtual cursor implementation. | Inspired Omnia's `01-virtual-pointer-contract.md` (`8bd4633a`): dual-layer pointer + user-precedence pause (`Physical-user precedence`), CDP `Input.dispatchMouseEvent` + topmost click-through overlay! |
| **`7055d5c7`** -> **`0c3f23f4`** | 11 prompts: Build **Adaptive All-in-One Downloader** (`Google Drive` PDF/video/folders, Chrome Canary cookies, >IDM, `blob:`/`HLS`/`.m3u8`/`128` chunks, JS-hidden streams, **encrypted streams / auto screen capture fallback**, real Võ Tiến folder test). `U@48` (`13,874` chars) supplied full 4-Pillar First-Principles Spec. Delegated to `DeepCoder` (`0c3f23f4`, `36` steps). | `7055d5c7` stopped at delegation (`SYSTEM_MESSAGE/DONE`); `0c3f23f4` handed off to Layer-0 coding worker (`SYSTEM_MESSAGE/DONE`). | **4-Pillar Downloader Spec**: (A) Probe `HEAD`/`Range: bytes=0-0` + GDrive `403`/`410` **Hot-Swapping URL** + MSE `blob:` extension bridge; (B) **In-Flight Chunk Splitting** (HTTP/2 cut slow straggler mid-stream) + BBR/AIMD dynamic concurrency; (C) **O(1) RAM Sliding Window Ring Buffer** for zero-temp-disk HLS/DASH merge; (D) Bitfield crash recovery + `429` evasion. |
| **`c2cc6103`** (+ **`63b1cd7e`** + 19 workers) | `/teamwork-preview` Fix ALL UI bugs in Omnia's workspace screens (`Home`, `Projects`, `Background work`, `Library`, `Memory`, `Skills`, `Code`, `Browser`, dialogs) via `ui-fixer` 20-worker roster (`scratch/roster.md`). | **Interrupted / Unfinished** at `182` steps (`PR`: *"Typecheck running; workers are under way. I'll wait for notifications"*). | Reusable multi-width Playwright probe (`360/480/768/1024/1366/1920`, locale parity, horizontal overflow & text overlap detection) across `584` baseline/panel files in `scratch/`. |
| **`158ae3d3`**, **`d166cd72`** (+ **`304eaa4c`**, **`523958e9`**, **`b88206a9`**) | Continuation of `codex://threads/01a1a777` (Downloader) & `01a1cdd7` (Codex MCP `unsupported call` triage + skill audit + `htmustc-proxy`). | `158ae3d3` hit `2` empty-model-output errors (`1.1.28` era), recovered & resumed `DeepCoder` on `Google Drive Downloader`. `d166cd72` completed with `learning_proposal.md` + `walkthrough.md`. | Root-caused Codex `0.167.0` `router.rs:365` `unsupported call` (`htmustc.id.vn` stripping `"namespace"` on `/v1/responses` SSE); `code_mode` V8 `text(value)` vs `output_text`; `ns.name == "functions"` root protection; `npx.cmd` + `startup_timeout_sec=30`; `274/274` `SKILL.md` + `718/718` link cleanups; `agy --print-timeout 10m`. |
| **`f34aa60f`**, **`6c4f699e`**, **`650bba04`**, **`e581b01d`**, **`a537f5fd`**, **`e9f7d668`** | Omnia Claude Desktop/CLI continuation, `433/433` Vitest (`2,782` tests), `5MB` JS bundle trim, Cross-Session Named Pipe IPC (`18/18`), `editor_server.rs` `SameSite=Lax` iframe `vscode-tkn`, `sovereign-browser-workbench.tsx` native WebView `10px` gutter. | `650bba04` ended on `GENERIC/ERROR` (`720` steps); `f34aa60f` completed final read-only review (`antigravity-browser-final-review.md`). | `SameSite=Lax` breaks `vscode-tkn` cookies when embedded in `tauri.localhost` iframes; `10px` separator gutter protects native child WebView resize bounds (`260..640px`) and preserves omnibox draft/selection across URL normalization. |

### 3.2 `C:\Users\khang\.gemini\antigravity\brain\` (`78` pre-swarm targets, `49,593` lines, `175` `USER_INPUT`s)

**12 Human-Prompted Primary Sessions:**
1. **`0f76c0f5`** (+ 14 subagent sessions `0ca83191`, `9404ab39`, `3eb48851`, `9b500d60`, `836d7aa0`, `e817fe7a..ff2e85af`, `2026-11-24`): Omnia Super-Harness vs Goose/OpenCode/OMP/Codex/Claude Code (`ui`: OMP + Trae + VS Code IDE; HTMUSTC API benchmark). **Killed by Google Antigravity Ultra ToS ban at `~6.04h`** (`~5h` continuous autonomous swarm `21:10:49` -> `01:58:15` with zero human input).
2. **`58fe57a6`** (`10,933` steps, `137` prompts, `7,354` errors — **Mega `agy-fast` Evolution Campaign**): Clone/optimize `INK-Q/agy-fast` in Pure Rust -> ban RCA (`U@440..536`: 17 normal swarm `read_board` Stop hooks in `0f76c0f5`, NOT 1s spam; whereas session 2 hit Stop-hook spam + `5h` unattended flag) -> design legit `PreInvocation`/`Stop` anti-ban guardrails, `200k` auto-compact, dual-pool telemetry (`Gemini Models` vs `Claude & GPT`), live OAuth multi-account (`U@8927..9319`: zero fake/mock metrics, identify active account & real tier Pro/Ultra/Plus/Edu/Free, count-down timers to exact second), 7-tab TUI mouse/focus fixes (`U@8510`), and **`U@10767` (`26,757`-char 8-Pillar Enterprise Mission Control + Network/Internet Observatory + Flagship Zero-CDN Web App)** + **`U@10821` Safe Interrupted Session Recovery** (sleep/restart/limit/stop-hook auto-resume when stable).
   - Downstream verification/feature sessions (`c1211e2f..e14dde3f`, `37cc7bb3`, `8e4e3c1f`, `dac1d391`, `af83c7a5`, `e77285fa`, `7d7fb2db`, `ee9a9896` -> `17237a96` / `3682f0bb` / `a274d782` / `3afc99aa` / `ac93f9a8` / `254bd34e`, `8118fbcf` -> `8ed7a55c` / `18a0d897` / `c3bb65f5`, `a5643509`, `b2363446`, `f523d245`) delivered `v0.18 -> v0.21` (3-Layer Cold Auto-Router) -> `v0.22` -> `v0.23` (`118/118` `-D warnings` tests, `0.36ms` median semantic routing, `43/43` deployed parity).
3. **`1e33c400` -> `79d7d3e5` -> `d7d2673e` -> `4813d7f9` (+ `2a6c295c`, `95d0b4c9`, `06ade853`, `2b65e4ed`, `66d80e5f`, `54df9299`, `33f65dd3`, `74250ae5`, `1e6a27a8`, `742f78b4`, `8bd4633a`)**:
   - **`79d7d3e5` (`U@1265`)**: Asked to make Omnia beat ChatGPT/Claude/Gemini/AI Studio/Perplexity/NotebookLM web; **HALTED** on pre-tool security policy hook triggered on `d:/Omnia/rust/omnia-cli/src/main.rs`. Its `scratch/apply_s17_*.py` + `apply_steer16_engine.py` scripts (`4,294L` Python patch scripts) specify Steer #16–#17 features.
   - **`d7d2673e` & `4813d7f9`**: Sealed Steer #22+#23 (`087854c`) and ran Cleanroom Audit Rounds (`1,2,3`).
   - **`66d80e5f`**: **HALTED** per pre-tool security policy hook (`no tools invoked`).
   - **`1e6a27a8`**: **RUNNING** at snapshot (`GENERIC/RUNNING`, waiting on `run_python_tools_all.py` `task-150`, `2026-11-28T16:57:30+07:00`).
   - **`33f65dd3`**: `shard11_workflow.py` hit `WorkflowError: failed to resolve agent "self": subagent "self" not found or not allowed to be invoked`!
4. **`67ac308a`**: Requested a copy-paste Omnia Master Prompt inspired by `58fe57a6` (`U@10542`) — generated a complete **10-Dimension Omnia Playbook** (keeping `omnia.exe <= 14 MiB` & cold `--version` latency closed alongside Observatory, Composer, IDE, CDP Browser, PeerMesh/Graphify, Atelier, OmniDrive, and Memory/MCP).
5. **`9fee7092` -> `648959b7` + `4a342d99`**: DeepInvestigator forensic audit of `/super-plan` + `/super-run` + `global-lessons` + `agy-fast v0.18` (6 P0 + 9 P1 + 6 P2 + 6 SOTA upgrades + 11 patches + 5 remaining gaps).
6. **`506cc532` (CMD Window Flash)**: Isolated flashing console windows via Win32 `CreateToolhelp32Snapshot` watcher (`watch_cmd.ps1`) to `agy.exe` (`v1.5.18`, **PE Subsystem 3 — Console app**) + `language_server.exe agentapi` + `cmd /s /c "bin\agy-fast.exe --hook-pre-invocation"`. Pending live `watch_cmd.ps1` v5 capture for exact parent caller of `agy.exe`.
7. **`1af34bb7` (Phantom Speaker Ding)**: 38-min `IAudioMeterInformation` / Event Log trace pinned sound to `taskhostw.exe` (`PlaySndSrv`) triggered by background `MessageBeep()` / terminal `\a` (including hidden UAC-waiting PowerShell scripts; Event Log never records callers of `MessageBeep`).
8. **`81c7f128` + `1c958716` (Vietnamese IME)**: Replaced UniKey with **EVKey 6.1.1 x64** (`per-app` mode, tray icon visible) to eliminate modern app accent-jumping/char duplication.
9. **`03ed597e`**, **`2b13083e`**, **`604c9051`**, **`6f57bb16`**, **`839651bb`**: SoftMaker clean uninstall + OnlyOffice vs WPS (`03ed597e`); pre-installing `rg`/tools + `sudo -> gsudo` PowerShell aliases (`2b13083e`); PowerShell 7.7.0 SemVer vs MSIX 7.7.5.0 quirk (`604c9051`); HTMUSTC & `gpt-6.2-astra` evaluation report (`6f57bb16`); GitHub Wiki Home init (`839651bb`).

---

## 4. High-Priority Omnia (`D:\Omnia`) Integration Candidates

> Ranked by impact and grounded in `omnia_integration_blueprint.md` (`f523d245`), `super_audit_harness` (`c3bb65f5`), `apply_s17_*.py` / `apply_steer16_engine.py` (`79d7d3e5`), `7055d5c7`, `061ffa08`/`8bd4633a`, `f34aa60f`, `swarm_board`, `CHANGELOG.md`, and `v0.21–v0.23` (`17237a96..254bd34e`). *(Note: Verify current HEAD status in `D:\Omnia` before implementing, as Steer #16–#23 landed parts of this stack.)*

### P0 — Correctness, Governance FSM, Security & KV-Prefix Invariants

1. **Full 7-Layer Omnia State Machine & `omnia_state.json` SSOT (`f523d245` Delta):**
   - Ensure `TASKS.md` + storage + MCP expose the full **7-state Task FSM** (`todo | in_progress | partial | blocked | done | cancelled | archived`) + `discuss`/`plan` pre-phase, **`task_dependencies`**, **`task_revisions`**, and **Parent/Leaf Completion Invariant** (closing a scoped leaf never marks parent `done`).
   - Enforce the **6-stage Epistemic Evidence Ladder** (`UNPROVEN -> ACQUIRED -> READ -> SYNTHESIZED -> REVIEWED -> RUNTIME_VERIFIED -> PUBLISHED`) in `RECEIPTS.json` and **`ErasureReceipt`** (`verified_plaintext_free: true`, `previous_digest_sha256`) on memory deletion.
   - Adopt `STATUS.md`, `PLAN.md`, `DISCUSS.md` (`3`-candidate matrix + Spec-Kit `/clarify`), `TRANSFER_CONTRACT.md`, `NEXT_SESSION_PROMPT.md`, `PROMPTS.md`, and `AUDIT_LOG.md` cleanly without counter drift, and require **frozen `(commit_sha, tree_sha)` + distinct reviewers** writing audit receipts **outside tracked files** (`.agents/super/audit_rounds.jsonl`) so receipts never self-mutate git hashes.
2. **Adversarial Guard & Verification Hardening (`c3bb65f5` `super_audit_harness` 7 Repros):**
   - Never let `PostToolUse` hooks bump `head_revision` of the workflow CAS counter (`REPRO1`), and scope active plan/run modes & `complete` commands strictly by `conversationId` (`REPRO3`/`REPRO4`).
   - Require shell proof parsers to reject **comment-hidden test commands** (`echo done # ; cargo test`) while recognizing **quoted Windows executables** (`& "C:\Program Files\Rust\cargo.exe" test`) (`REPRO5`).
   - Reject empty `commitSha`/`treeSha` in audit-streak advancement (`REPRO6`), canonicalize `excluded_paths` against dot-directory carve-outs (`src/*` vs `src/.github`, `REPRO7`), and separate governance-doc edits from invalidating unrelated verified code streaks (`REPRO2`).
   - Maintain **simulation dry-run isolation** (`AUD-09`: `SIMULATED_DETERMINISTIC` with zero durable state/quota mutation).
3. **Wire API & Prefix-0 KV Cache Invariance (`79d7d3e5` `apply_steer16_engine.py` + `CHANGELOG.md`):**
   - Route OpenAI Responses-capable families via `WireApiMode::Auto`, while preserving Gemini/Claude over `/v1/messages` where prompt-prefix delta stays **~6 tokens/turn vs ~2k tokens/turn loss** (37/103 breaks observed on OpenAI chat/responses translation).
   - Keep `BadReasoningEffort` HTTP 400 detection explicit (before falling back to `EndpointUnsupported`), preserve `thought_signature` round-tripping across turns, sanitize outdated thinking blocks on mid-turn tool/prompt mutation (`CHANGELOG 1.4.x`), and preserve attached media + tool declarations + recent 10 messages across `/compact`.
4. **Windows Atomic Upgrade & File-Lock Resilience (`254bd34e` Defect #1 + `CHANGELOG 1.1.22`):**
   - Never run destructive `rm -rf` before staging upgrades; use **NTFS rename-aside** for running/locked `omnia-*.exe` binaries (`EPERM`), fail fast if state-stash backup throws, and retry Windows sharing-violation unlinks with bounded backoff (`~1s`).

### P1 — Super-Harness Telemetry, Router Lab, Downloader & Semantic Routing

5. **Steer #17 Observability, Pre-Flight & Dry-Run Rewind (`79d7d3e5` `apply_s17_*.py` + `58fe57a6` `U@10767`):**
   - **Engine (`engine.rs`):** `preview_rewind_to_turn` (zero-mutation diff preview), `preflight_prompt` (token/KV estimate before send), `TurnTelemetryRecord`, `ToolCallWaterfallEntry`, `total_kv_savings_usd`, `compact_conversation_now`, `export_session_markdown(privacy_mask)`.
   - **Routing (`omnia-routing`):** `ScoreWaterfall5` (`capability`, `privacy`, `headroom`, `latency`, `reliability_preference`), `QuotaRunwayProjection`, `FailoverEvent` timeline persisted in SQLite.
   - **Network & Speedtest (`omnia net` / `speedtest` + TUI `F4` drawer / `F5` `PrivacyMask`):** Dual-stack IPv4/IPv6 + CGNAT `100.64.0.0/10` check, multi-resolver DNS benchmark (`System` vs `1.1.1.1`/`8.8.8.8`/`9.9.9.9` DoH/DoT + DNS leak ASN parity), proxy/PAC/TLS-MITM inspector, cancellable Cloudflare speedtest + unloaded/loaded bufferbloat grading, and `p50/p90/p95/p99/MAD/IQR` latency distributions (never averages alone).
6. **Sub-Millisecond Semantic Skill/Plugin Router (`b2363446` + `254bd34e` Defects #3–#6):**
   - Port `agy-fast`'s 3-layer cold router (`~0.36ms` warm median, zero-FP OOS/code-snippet filtering so code like `figma_mock.rs` doesn't false-trigger `figma`), fixing the 3 audited pitfalls: (a) preserve explicit namespace intent (`doc-skills/<slug>` vs workspace `.agents/skills/` override parity between `route` and `load`); (b) hash string-path `mcpServers`, `.claude-plugin/plugin.json`, `agents/`, and `sidecars/` in corpus fingerprint; (c) NFC/NFD Unicode normalization before Vietnamese dedup hashing + stateless fast-reject before loading disk SRIX indexes (`~141ms` cold penalty saved).
7. **Adaptive All-in-One `omnia-downloader` Architecture (`7055d5c7` `U@48` + `0c3f23f4`):**
   - Upgrade multi-stream downloader with: `HEAD`/`Range: bytes=0-0` probe (catching fake `Accept-Ranges` `200 OK` servers), Closed-Loop **BBR/AIMD dynamic concurrency**, HTTP/2 **In-Flight Chunk Splitting** for slow end-game stragglers, **O(1) RAM Sliding Window Ring Buffer** for out-of-order HLS/DASH muxing with zero temp disk duplication, **Hot-Swapping Expiring URLs** (`403`/`410`), bitfield crash recovery, and MSE (`blob:`) / AES-128 browser bridge (`0x0` fallback capture only when encrypted DRM).
8. **Superpowers-Proven Subagent & Peer-Mesh Ergonomics:**
   - Adopt Brainstorming **3-Path Classifier** (`Spike` / `Bounded` / `Architectural`), **Worker-Review Prohibition** (no blind sub-review recursion), **5-Round Fix-Loop Circuit Breaker**, and **"Cheapen mechanics, never judgment"** (never downgrade reviewer/verifier models below capable threshold).

### P2 — Desktop Browser, Studio UI, Virtual Pointer & Dual-Host UX

9. **Non-Hijacking Virtual Pointer & Isolated Window Capture (`061ffa08` + `8bd4633a` `research_windows_runtime.txt`):**
   - Implement the `01..08` Virtual Pointer contract: semantic element/CDP target snap (`Input.dispatchMouseEvent`) + topmost click-through intent/execution visual cursor overlay + strict **Physical-User Precedence** (instant pause/yield on human mouse/key move) + WGC offscreen/frame-freshness verification.
10. **Flagship Studio (`ui-v5`) & Swarm Board Innovations (`f34aa60f` + `swarm_board` + `7d7fb2db` `gate3/4`):**
    - Verify `SameSite=Lax` cookie/token handling (`vscode-tkn`) inside embedded IDE frames and maintain the `10px` native WebView splitter gutter (`260..640px`).
    - Borrow `swarm_board` UX into `SwarmView`: narrator `view.json` threads, `SHOT_RE` visual progress reel + before/after swipe comparator, `#channel` / `@#channel` filter tabs, compact `1x–3x` integer-scaled agent avatars, and `gate3`/`gate4`-style live CDP QA (testing populated tables across `4` themes x `3`+ widths, DNS-rebinding `Host`, CSRF `Origin`, zero console/external-CDN leaks).
11. **Zero-Friction Embedded Widgets & Windows Hygiene:**
    - Adopt `generative_ui` semantic flush embed CSS tokens (`p-0 m-0`, `--card-border`, `--chart-1..6`); audit console subprocess launches for `CREATE_NO_WINDOW` (`506cc532`) and `MessageBeep`/`\a` suppression (`1af34bb7`).

---

## 5. High-Priority `agy` / `agy-fast` Candidates (`Target A` + `Target B`)

### P0 — Critical Overnight, Hook & Installer Fixes for `agy-fast`

*(Sourced from `4a342d99` @ `v0.18` and `254bd34e` @ `v0.23`; re-check against current `agy-fast` HEAD before patching.)*

1. **Fix `pauseCooldown: true` False Wind-Down & `/goal` Self-Cancel (`4a342d99` P0-1, `guard.rs:5842-5857` & `5528-5549`):** Gate `near_total_tok`, `near_reqs`, and `acute_zero_prog` (`=2`) with `!cfg.pause_cooldown`, and evaluate `near_reqs` against rebased `eff_sess_reqs` (not raw `cached_session_requests`) — this single omission fired `<!-- GOAL_CANCELLED -->` **11x** while cooldowns were explicitly paused.
2. **Scope Telemetry, Burst Epochs & Warning Sets by `conversationId` + Lock `guard-state.json` (`4a342d99` P0-3):**
   - Replace scalar `last_conversation_id`, `cached_*`, and warning flags (`context_warned_conv`, `wind_down_warned_conv`, etc.) with bounded per-conversation maps (`<= 32`), add cross-process file locking around `guard-state.json` read-modify-write, and prevent child swarm workers from starving or overwriting coordinator burst/request budgets (`guard.rs:2791` clamp `<= 30` and `webui.rs`/`tui.rs` `<= 20` kill 32-worker swarms!).
   - Preserve `active_goal_convs`, `cooldown_until_epoch`, `session_req_offset`, `session_sec_offset`, and `context_cap_bonus` across `00:00` midnight rollover.
3. **Eliminate Unattended Freezes & Destructive Overwrites (`4a342d99` P0-2, P0-6, P1-5):**
   - Never overwrite `<ws>/HANDOFF.md` in `write_forensic_handoff()` (write `.agents/memory/guard-handoff.md` or preserve `<!-- AGENT_NOTES_START/END -->`).
   - Use `prompt_has_slash_command` (never raw `low.contains("/goal")`) in `inspect_transcript_stop_hook_tail`, distinguish `/super-plan` (allow `ask_question`) from `/super-run`/`/goal` (deny `ask_question`, fixing false `"never blocked"` injection), and in `ask_patterns()` (`hooks_extra.rs:170-177`) return `"deny"` with safe-alternative guidance instead of `"ask"` during `uninterruptedMode` + `/goal` (otherwise headless/overnight runs freeze indefinitely!).
   - Make `recovery.rs` `--print-timeout` configurable instead of hardcoded `300s`, update its resume prompt to reference `.agents/super/state.json` + `@monitor resume`, and coordinate with `guard.rs` `schedule` to avoid double-resumes.
4. **Sync Matcher & Tab Strings (`4a342d99` Part 0 #3):** Update `hooks.json` matcher from legacy tool names to `mcp_agy-fast_fast_apply_edits`, fix stale `"Tab [5]"` / `"5-tab"` / `"6-tab"` strings in `hooks_extra.rs`, `guard.rs`, `plugin.json`, `AGENTS.md`, and `tos-shield` to match the **7-tab TUI** (`Tab [4]` Accounts, `Tab [7]` Shield & Alerts).
5. **Fix Windows `install.mjs` Locked-Binary & State-Loss Bug (`254bd34e` Defect #1, verify parity on HEAD):** Stage upgrades outside live target first, rename-aside locked `bin/agy-fast.exe` (`EPERM` when MCP server is running), and fail fast instead of swallowing `catch {}` before `fs.rm`. Also resolve `agy-fast canvas dossier` CLI parity + `skills doctor` missing-directory false-green (`doc_eval_total == 0`).

### P1 — `agy` CLI, Platform & Anti-Ban Enhancements

6. **Eliminate Console Window Flashes (`506cc532`):** Wrap `agy.exe` (`v1.5.18`, PE Subsystem 3 — Console) and `language_server.exe agentapi` / `cmd /s /c` hook invocations cleanly (or provide a Win32 GUI/hidden-window shim / `CREATE_NO_WINDOW`) so background `PreInvocation` / metadata polls never steal focus or flash brief CMD windows on the desktop.
7. **Adopt `1.4.x` Hook & Workflow Primitives (`hooks.md`, `agy-filter`, `33f65dd3`):**
   - Update `agy-filter/filter.py` to honor `Stop.continuationActive` & `terminationReason`, and leverage `PreInvocation.terminationBehavior: "terminate"` + `metadata.user_markdown` for clean user-only UI diagnostics without polluting prompt context or KV prefix.
   - Support Windows polyglot `run-hook.cmd` + `${PLUGIN_ROOT}` / `PLUGIN_DATA` cleanly across `hooks.json` (remember `superpowers` Antigravity marketplace spec note on `hooks.json` path expansion) and guard `run_workflow` against `self`-agent resolution errors (`33f65dd3`: `WorkflowError: failed to resolve agent "self"`) and sibling-branch cancel-all cascades.
8. **Verifier-Worktree & `swarm_monitor` Guardrails (`4a342d99` P1-1, P1-2):** Teach `/super-run` and `native_swarm` that `workspace:"share"` workers live in isolated worktrees invisible to `inherit` verifiers until committed/merged or explicitly pathed via `swarm{action:"status"}`, auto-attach `swarm_monitor` (`*/3 * * * *`), and keep worker-review recursion disabled.
9. **Antigravity Ultra ToS-Safe Cadence (`58fe57a6` U@440–536):** Enforce active-turn wind-down before sustained `5h` unattended thresholds (saving `PROGRESS.md`/`CHECKPOINT.md` + `/compact` before pausing cleanly without `Stop` hook loop spam), and separate heavy autonomous multi-hour `/swarm` runs cleanly onto commercial APIs / Omnia (`htmustc` / direct providers) rather than consumer Ultra slots.

### P2 — Browser Computer Use, MCP & Plugin UX

10. **Virtual Cursor + Non-Blocking Overlay for `/browser` (`061ffa08`):** Add an optional visible synthetic cursor & key-action HUD overlay routed via CDP so users can observe browser actions live without losing local mouse/keyboard control.
11. **Codex-Grade MCP & `modern-web-guidance` Policy Upgrades:** Surface a declarative `.toml` mode-policy layer (`policies/*.toml`), expose `auth.json` OAuth2 `env` delivery (`g*` pattern) for external CLIs, advertise `_meta["antigravity/alwaysLoad"]` selectively to stay under tool-budget caps, and ship a diagnostic command catching `logs_2.sqlite` / `.codex-plugin` / `SKILL.md` / `npx.cmd` Windows cold-start issues (`d166cd72` `codex-mcp-namespace-diagnostics`).

---

## 6. Verification & Hygiene Receipts (Read-Only Deliverable Check)

- **Workspace cleanliness:** `D:\Omnia` and `C:\Users\khang\.gemini` untouched; Python executed strictly with `python -B` (`0` `__pycache__` emitted by this shard).
- **Encoding & secret audit:** Verified `17_egemini_config_and_c_brain.md` as UTF-8 without BOM, Unix `LF`, and `0` credential/token/cookie/personal-email matches.
