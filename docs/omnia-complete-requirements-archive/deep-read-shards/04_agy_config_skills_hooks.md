# Shard 04 — Exhaustive Deep-Read Audit: `agy` Config, Skills, Rules, Hooks, Scripts & `agy-fast` Drift

- **Shard**: Wave 1 Read-Only Deep-Read Shard `04` (`#401` / `#432`, worker `@cli-tui-cockpit`)
- **Audit Date**: `2026-11-28 +07:00`
- **Scope**:
  - **Target (A)**: `C:\Users\khang\.gemini\config\{skills, rules, plugins\agy-fast\{skills, doc-skills, rules, hooks.json, mcp_config.json, plugin.json, guard-config.json, skills-taxonomy.json, scripts, extensions}}` + non-secret host configs (`config.json`, `mcp_config.json`, `skills-archive/2026-11-28-pre-merge/MIGRATION_LEDGER.md`).
  - **Target (B)**: `C:\Users\khang\.gemini\antigravity\scratch\agy-fast\{skills, doc-skills, rules, hooks.json, mcp_config.json, plugin.json, guard-config.json, skills-taxonomy.json, scripts, extensions, README.md, package.json, install.ps1, install.sh}`.
  - **Runtime Ground-Truth Cross-Check (Read-Only)**: `scratch/agy-fast/native/src/{hooks_extra.rs, snapshot.rs, super_engine.rs, guard.rs, cli.rs, memory.rs}` and `D:\Omnia\.agents\skills\super-plan-run-lifecycle\SKILL.md`.
- **Coverage Status**: **100% line-by-line read (ZERO files skipped)** across all `59` target files (`5` global skills + `45` installed plugin files + `9` scratch-only/drifted files), plus `3` companion config/ledger files and Rust hook/engine source verification.
- **Privacy & Safety Compliance**: Read-only across `D:\Omnia`, `C:\Users\khang\.gemini`, and `E:\Users\khang\.gemini`. Zero access to OAuth/account credential files (`accounts.json`, `session-accounts.json`, `oauth_creds.json`, `google_accounts.json`), cookies, or `chrome-profiles/`. All encountered personal email addresses in scripts/manifests are redacted below.

---

## Executive Summary — Top 10 Verified Findings

1. **`[VERIFIED]` Zero Drift Across All 44 Core Plugin Assets — Real Drift Lives in `guard-config.json`, `bin/`, and Legacy `dist/`**: Every file under `{skills, doc-skills, rules, hooks.json, mcp_config.json, plugin.json, skills-taxonomy.json, extensions}` and all 4 shared scripts under `scripts/` are **44/44 byte-for-byte identical** between installed `C:\Users\khang\.gemini\config\plugins\agy-fast` and `C:\Users\khang\.gemini\antigravity\scratch\agy-fast` (and `bin/agy-fast.exe` is also identical: `20,164,096 B`, SHA-256 `e8aa3353de01`). However, **`guard-config.json` drifted across 15 fields**, and `installed/bin/` accumulated **35 stale `agy-fast.exe.old.<ts>` binaries totaling `546.57 MB`**.
2. **`[VERIFIED]` `config\rules` Does Not Exist & `C:\Users\khang\.gemini` vs `E:\Users\khang\.gemini` Are Split Directories**: `C:\Users\khang\.gemini\config\rules` is absent (`exists=False`). `C:\Users\khang\.gemini` and `E:\Users\khang\.gemini` are two separate physical directories (`is_symlink=False`): `GEMINI.md` lives on `E:\Users\khang\.gemini\GEMINI.md`, while active global skills (`4`) and `agy-fast` live on `C:\Users\khang\.gemini\config\`.
3. **`[VERIFIED]` `/super-plan` & `/super-run` Are Real Executable Rust Engines, Whereas `/learn`, `global-lessons`, and `ALWAYS_ACCEPT_LEARN` Are Prose-Only**:
   - `/super-plan` and `/super-run` are wired end-to-end across `SKILL.md` (`disable-model-invocation: true`), `PreInvocation` (`guard.rs` + `super_engine.rs`), `PreToolUse` (`hooks_extra.rs`), `PostToolUse` (`.agents/super/tool_proof.jsonl`), MCP `super_engine`, and `Stop` (`evaluate_stop_super_with_guard`).
   - By contrast, **`ALWAYS_ACCEPT_LEARN` has `0` references across all 31 Rust source files**, `/learn` has no `SKILL.md` or hook handler in `agy-fast`, and `global-lessons/references/lessons.md` (`18/100` entries) is **never auto-hydrated** by `SessionStart` (`snapshot.rs`) or writable via `memory_sync` (`memory.rs` writes workspace `.agents/memory/lessons.md` only).
4. **`[VERIFIED]` 3-Way Global-Lessons Fragmentation (`agy` vs `Omnia` vs `Codex`)**: `agy-fast` points global lessons to `C:\Users\khang\.gemini\config\skills\global-lessons\references\lessons.md` (`5,307 B`, 18 lessons); `D:\Omnia\.agents\skills\super-plan-run-lifecycle\SKILL.md#L25` points Tier-2 global lessons to `D:\OmniaData\memory\global_lessons.md` (currently **missing on disk**); and `GEMINI.md` additionally cites `~/.codex/memories_v2/extensions/ad_hoc/notes/`. No automated bidirectional sync or dedup daemon exists yet.
5. **`[VERIFIED]` `auto-proceed` ("Uninterrupted Mode") Has 5 Concrete Enforcement Gaps**: Today it combines Antigravity host settings (`CASCADE_COMMANDS_AUTO_EXECUTION_EAGER` + `AGENT_PERMISSION_PRESET_TURBO` in `config/config.json`) with `PreToolUse` denying `ask_question` and converting destructive `ask` -> `deny` in unattended runs (`hooks_extra.rs#L158-188, L252-275`). **Gaps**: (a) `PreToolUse` does NOT block `write_file`/`edit_file` with `ArtifactMetadata.RequestFeedback: true` (allowing UI `"Proceed"` modal stalls!), (b) `Stop` hook does not catch plain-text trailing confirmation questions outside `/super-run`, (c) `uninterruptedMode` is global across all conversations rather than per-conversation toggleable, (d) `installed/guard-config.json` currently sets `pauseCooldown: true` which **silently disables `autoCompactAt200k`** (`guard.rs#L6525`), and (e) `disjoint_paths` ownership is not enforced proactively in `PreToolUse`.
6. **`[VERIFIED]` Self-Updater `install.mjs update` Is Broken on Installed Rust Plugin**: `installed/dist/` does not exist (`RUNTIME_FILES` no longer copies `dist/*.mjs`), yet `scripts/install.mjs#L1639-1646` hard-requires `dist/updater.mjs`. Running `node scripts/install.mjs update` from the installed plugin immediately throws `Error: Missing dist/updater.mjs`.
7. **`[VERIFIED]` Severe Legacy v0.3.1 JS vs Active v0.23.0 Rust Drift in Scratch Repo**: `scratch/README.md` (claims "5 MCP tools", "Zero per-step blocking hooks", `dist/mcp-server.mjs`), `scratch/package.json` (`version: "0.3.1"`), `scripts/build.mjs`, `scripts/test.mjs`, and `scripts/stress-benchmark.mjs` (`1,494 L`) all still describe/exercise the legacy Node.js `dist/*.mjs` bundles rather than the active `v0.23.0` Rust binary (`11` MCP tools, `6` hooks, `bin/agy-fast.exe`).
8. **`[VERIFIED]` `rules/AGENTS.md` Budget Pressure (`18,186 B` = 74.0% of Antigravity's `24 KB` Rule Cap)**: At `71` dense lines (`18.2 KB`), adding more inline instructions risks tripping Antigravity's `24 KB` single-rule ceiling (flagged by `agy-fast audit` itself!) and duplicates several rules already injected by `E:\Users\khang\.gemini\GEMINI.md`.
9. **`[VERIFIED]` PII & Portability Defects in Scripts**: `scripts/login-wsl-accounts.ps1#L3-L5` hardcodes 3 personal Gmail addresses (present in both installed and scratch!); `scripts/login-wsl-accounts.cmd#L2` hardcodes an absolute `C:\Users\khang\...` scratch path; `scripts/setup-wsl-agy.ps1` and `scripts/login-wsl-accounts.ps1` are omitted from `install.mjs`'s `RUNTIME_FILES`; and `scripts/sync_semantic_model.py#L51-59, L636-640` hardcodes local `D:\Omnia` / `E:\Users\khang` paths and retains a drifted 44-ID `TIER2_CATEGORY_IDS` fallback (vs 64 IDs in `skills-taxonomy.json`).
10. **`[VERIFIED]` Unauthenticated Localhost Write Endpoint in `extensions/plan-sync`**: `extensions/plan-sync/content.js` scrapes visible Google One plan tier + email and POSTs to `http://127.0.0.1:47890/api/accounts/tier-sync` without an install-scoped bearer token or strict `Origin` / CSRF verification, exposing local account metadata to any browser tab able to issue a simple cross-origin POST.

---

## Section 1 — Complete 100% Line-by-Line Coverage Ledger (`0` Skipped)

### 1.1 Target (A1): `C:\Users\khang\.gemini\config\skills\` & Host Configs (`8` files read, `491` lines)

| Relative Path | Lines | Bytes | SHA-256 (12) | Read | Key Semantics |
| :--- | ---: | ---: | :--- | :---: | :--- |
| `skills/global-lessons/SKILL.md` | 19 | 1,471 | `e94472fafe41` | 100% | `disable-slash-command: true`; points cross-project lessons to `references/lessons.md` (100-entry cap) + workspace fallback `pending-global-lessons.md` |
| `skills/global-lessons/references/lessons.md` | 22 | 5,307 | `71bfc02f2296` | 100% | 18 curated cross-project engineering pitfalls (PS 7, `/DELAYLOAD:ws2_32.dll`, ConPTY Release, PID reuse, WS Origin parity, hook anti-spam, Additive Steer) |
| `skills/super-plan/SKILL.md` | 70 | 10,359 | `5e8f8aeb832f` | 100% | `disable-model-invocation: true`; interactive `/super-plan` (`stopHook=OFF`, `ask_question=ALLOWED`, `coding=ALLOWED`), dual-anchored blueprint + Lanes A–F |
| `skills/super-run/SKILL.md` | 98 | 14,583 | `f29732f1ee6d` | 100% | `disable-model-invocation: true`; autonomous `/super-run` (built-in `/goal` Stop hook, `ask_question=AUTO-DENIED`, proof log, 2/3/5-Strike RCA, 3x/5x cleanroom audit) |
| `skills/vietnamese-typo-intent-inference/SKILL.md` | 29 | 2,954 | `7d934bdd7be5` | 100% | Protected-span rules + VNI/Telex/QWERTY/VN developer chat shorthand normalization |
| `config.json` *(companion host config)* | 211 | 5,500+ | — | 100% | 26 installed plugins (`agy-fast`, `swarm` enabled; `figma`, `google-developer-knowledge`, `postman` disabled); `CASCADE_COMMANDS_AUTO_EXECUTION_EAGER`, `AGENT_PERMISSION_PRESET_TURBO`, `AGENT_SETTING_POLICY_ALLOW` |
| `mcp_config.json` *(companion host config)* | 0 | 0 | — | 100% | Completely empty (`0 B`); all MCP tools come from plugins (`agy-fast/mcp_config.json`) |
| `skills-archive/2026-11-28-pre-merge/MIGRATION_LEDGER.md` | 42 | — | — | 100% | Reversible SHA-256 archive of `9` retired global skills + `8` retired `agy-fast` stubs folded into the `4` global + `8` pillar skills under `STEER-008` |
| `rules/` | — | — | — | N/A | **Directory does not exist** (`exists=False`); `sidecars/` exists and is empty (`[]`) |

### 1.2 Target (A2): `C:\Users\khang\.gemini\config\plugins\agy-fast\` (`45` files read, `7,423` lines, `350,140 B`)

| Category | Relative Path | Lines | Bytes | SHA-256 (12) | Scratch Match |
| :--- | :--- | ---: | ---: | :--- | :---: |
| **Manifests & Config** | `plugin.json` | 34 | 1,240 | `3899c8957dae` | IDENTICAL |
| | `hooks.json` | 56 | 1,116 | `6435cc32bb08` | IDENTICAL |
| | `mcp_config.json` | 45 | 876 | `4272dde5ec8d` | IDENTICAL |
| | `guard-config.json` | 58 | 1,320 | `23779614e0eb` | **DRIFTED** (`8f932ef3fb29`) |
| | `skills-taxonomy.json` | 2,984 | 88,434 | `4c59acc31e78` | IDENTICAL |
| **Rules** | `rules/AGENTS.md` | 71 | 18,186 | `2cdda8e05037` | IDENTICAL |
| **Pillar 1: Deep Research** | `skills/deep-research/SKILL.md` | 93 | 11,295 | `3c8242bddbc9` | IDENTICAL |
| | `skills/deep-research/references/citation-verification-checklist.md` | 26 | 2,817 | `4da95cd70d84` | IDENTICAL |
| **Pillar 2: Deep Think** | `skills/deep-think/SKILL.md` | 46 | 4,057 | `24f3f359ddfb` | IDENTICAL |
| | `skills/deep-think/references/formal-proof-protocols.md` | 29 | 3,072 | `2f4902404b1b` | IDENTICAL |
| | `skills/deep-think/references/rca-debugging.md` | 23 | 2,693 | `b9e96fda4d09` | IDENTICAL |
| **Pillar 3: Doc Studio** | `skills/doc-studio/SKILL.md` | 35 | 4,274 | `c2f35fa4e44d` | IDENTICAL |
| | `skills/doc-studio/references/docx.md` | 20 | 2,570 | `8d7faaf61394` | IDENTICAL |
| | `skills/doc-studio/references/latex.md` | 28 | 2,469 | `1b5c4110f490` | IDENTICAL |
| | `skills/doc-studio/references/markdown.md` | 19 | 2,315 | `85ce1157ea81` | IDENTICAL |
| | `skills/doc-studio/references/pdf.md` | 23 | 2,416 | `7a767406062f` | IDENTICAL |
| | `skills/doc-studio/references/pptx.md` | 20 | 2,329 | `54567d78152f` | IDENTICAL |
| | `skills/doc-studio/references/xlsx.md` | 20 | 2,321 | `3c8272958b11` | IDENTICAL |
| **Pillar 4: Engineering Mastery** | `skills/engineering-mastery/SKILL.md` | 33 | 3,161 | `1a71d5beb557` | IDENTICAL |
| | `skills/engineering-mastery/references/architecture-system-design.md` | 19 | 2,621 | `5f7da6ae994d` | IDENTICAL |
| | `skills/engineering-mastery/references/git-ship-and-deep-clean.md` | 30 | 4,276 | `05ad0c220440` | IDENTICAL |
| | `skills/engineering-mastery/references/refactor-peer-mesh.md` | 29 | 3,591 | `ac0dde3197ad` | IDENTICAL |
| | `skills/engineering-mastery/references/security-sast-audit.md` | 25 | 2,854 | `6014dc8c4aaa` | IDENTICAL |
| **Pillar 5: Intelligent Canvas** | `skills/intelligent-canvas-ui/SKILL.md` | 78 | 10,929 | `5efce21211a1` | IDENTICAL |
| | `skills/intelligent-canvas-ui/references/ui-ux-design-system.md` | 21 | 2,638 | `cccbea2771e7` | IDENTICAL |
| **Pillar 6: Omni Router** | `skills/omni-router/SKILL.md` | 82 | 6,108 | `59e139e997af` | IDENTICAL |
| **Pillar 7: Omnia Governance** | `skills/omnia-governance/SKILL.md` | 53 | 6,087 | `1b37f969bc6f` | IDENTICAL |
| | `skills/omnia-governance/references/evidence-recovery.md` | 25 | 2,937 | `70503d8ccc8a` | IDENTICAL |
| | `skills/omnia-governance/references/goal-plan-dod.md` | 33 | 5,029 | `04c2ff30673f` | IDENTICAL |
| | `skills/omnia-governance/references/memory-evolution-handoff.md` | 28 | 4,537 | `ea8e0148efda` | IDENTICAL |
| | `skills/omnia-governance/references/proposal-archetypes-and-rubric.md` | 62 | 6,478 | `c7e7b6b55c79` | IDENTICAL |
| | `skills/omnia-governance/references/steer-cas-queue.md` | 35 | 4,739 | `9b8926e7f31a` | IDENTICAL |
| **Pillar 8: ToS Shield** | `skills/tos-shield/SKILL.md` | 37 | 3,605 | `d99872470021` | IDENTICAL |
| **Cold `doc-skills/` (6)** | `doc-skills/doc-docx/SKILL.md` | 37 | 3,402 | `03e96b5a34df` | IDENTICAL |
| | `doc-skills/doc-latex/SKILL.md` | 40 | 3,201 | `9e902541cb9d` | IDENTICAL |
| | `doc-skills/doc-markdown/SKILL.md` | 39 | 3,298 | `5d023504a229` | IDENTICAL |
| | `doc-skills/doc-pdf/SKILL.md` | 33 | 3,159 | `0b18f95f3101` | IDENTICAL |
| | `doc-skills/doc-pptx/SKILL.md` | 38 | 3,184 | `263040867797` | IDENTICAL |
| | `doc-skills/doc-xlsx/SKILL.md` | 39 | 3,288 | `7c8f6c925947` | IDENTICAL |
| **Scripts (4 shared)** | `scripts/install.mjs` | 1,924 | 66,839 | `0f9b0e302507` | IDENTICAL |
| | `scripts/sync_semantic_model.py` | 855 | 32,108 | `ed40a62b63fa` | IDENTICAL |
| | `scripts/setup-wsl-agy.ps1` | 93 | 3,970 | `915f3eb855ee` | IDENTICAL |
| | `scripts/login-wsl-accounts.ps1` | 30 | 1,823 | `c0bc519b7b7f` | IDENTICAL |
| **Browser Extension** | `extensions/plan-sync/manifest.json` | 22 | 512 | `9eb1f4360ffa` | IDENTICAL |
| | `extensions/plan-sync/content.js` | 53 | 1,966 | `6702c79636cd` | IDENTICAL |

### 1.3 Target (B): Scratch-Only & Drifted Files (`9` files read, `2,299` lines, `108,878 B`)

| Relative Path (`scratch\agy-fast\...`) | Lines | Bytes | SHA-256 (12) | Status vs Installed |
| :--- | ---: | ---: | :--- | :--- |
| `guard-config.json` | 57 | 1,283 | `8f932ef3fb29` | **DRIFTED** (15 field diffs vs installed) |
| `README.md` | 345 | 26,409 | `bd6cc7fcf6aa` | Scratch-only; **stale upstream v0.3.1 Node.js docs** |
| `package.json` | 59 | 1,577 | `bf68277b4d0b` | Scratch-only; **stale v0.3.1 Node/esbuild manifest** |
| `install.ps1` | 156 | 5,844 | `2cf5eb44869d` | Scratch-only; PowerShell wrapper around `scripts/install.mjs` |
| `install.sh` | 90 | 2,978 | `e1ac4414ef67` | Scratch-only; POSIX sh wrapper around `scripts/install.mjs` |
| `scripts/build.mjs` | 51 | 1,650 | `ded4add9cca9` | Scratch-only; esbuild bundler for legacy `src/*.ts -> dist/*.mjs` |
| `scripts/test.mjs` | 45 | 1,315 | `6559cca7144e` | Scratch-only; Node `--test` runner for legacy `test/*.test.ts` |
| `scripts/login-wsl-accounts.cmd` | 2 | 151 | `5e2da56c7dec` | Scratch-only; hardcoded scratch path wrapper for `login-wsl-accounts.ps1` |
| `scripts/stress-benchmark.mjs` | 1,494 | 66,469 | `a27d328c98bf` | Scratch-only; 12-scenario stress suite targeting legacy `dist/*.mjs` |

### 1.4 Bonus Runtime Source Verification (Read-Only Ground Truth)

- `native/src/hooks_extra.rs` (`704/704 L`): Full `PreToolUse`, `PostToolUse`, `PostInvocation`, and `Stop` hook logic verified.
- `native/src/snapshot.rs` (`710/710 L`): Full `SessionStart` hook (`build_workspace_snapshot`, 1,500 B cap) verified.
- `native/src/super_engine.rs` (`L1-800`, `L1547-1703`, `L2579-2905` + full 73-function index of `5,237 L`): Verified `SuperEngineState`, `evaluate_pre_invocation_super`, `evaluate_gates_internal`, `evaluate_stop_super_with_guard`, and MCP schema.
- `native/src/guard.rs` (`L1-800`, `L5780-6250`, `L6480-7100` of `7,418 L`): Verified `GuardConfig`, presets, `PreInvocation` Layers 0–7, `auto_compact_at_200k`, `auto_resume_after_cooldown`, and `run_guard_cli` (`uninterrupted`, `preset`, `unlock`).
- `native/src/memory.rs` + `native/src/cli.rs` (targeted line probes) & `D:\Omnia\.agents\skills\super-plan-run-lifecycle\SKILL.md` (`44/44 L`): Verified exact lesson storage boundaries and Omnia parity gaps.

---

## Section 2 — Exact Drift Matrix (`installed` vs `scratch` vs `config`)

### 2.1 `guard-config.json` Exact 15-Field Diff (`schemaVersion: 11`)

| Field | Installed (`plugins/agy-fast/guard-config.json`) | Scratch (`scratch/agy-fast/guard-config.json`) | Operational Impact |
| :--- | :---: | :---: | :--- |
| `antiBan.autoRouteColdSkills` | **`true`** | *(key absent — relies on Rust default `true`)* | Schema key missing from scratch seed |
| `antiBan.burstMaxCalls` | `12` | `6` | Installed uses `overnight` preset; scratch uses `ultra` default |
| `antiBan.maxStopHookContinuations` | `6` | `3` | Doubles allowed Stop continuations in installed |
| `pauseCooldown` | **`true`** | `false` | **CRITICAL**: `pauseCooldown: true` disables stretch/cooldown pauses AND **silently disables `autoCompactAt200k`** (`guard.rs#L6525`: `!cfg.pause_cooldown && cfg.auto_compact_at_200k`)! |
| `cooldownMinutesRange` | `[10, 20]` | `[15, 30]` | Overnight vs Generous preset |
| `dailyMinutesRange` | `[540, 780]` | `[240, 360]` | 9–13h vs 4–6h |
| `sessionMaxMinutes` | `480` | `150` | 8h vs 2.5h |
| `stretchMinutesRange` | `[240, 360]` | `[75, 110]` | 4–6h vs 75–110m |
| `tokenGuard.dailyMaxCacheReadTokensM` | `2800` | `1200` | Overnight scaling |
| `tokenGuard.dailyMaxCacheWriteTokensM` | `420` | `180` | Overnight scaling |
| `tokenGuard.dailyMaxInputTokensM` | `300` | `120` | Overnight scaling |
| `tokenGuard.dailyMaxOutputTokensK` | `20000` | `8000` | Overnight scaling |
| `tokenGuard.dailyMaxRequests` | `15000` | `2500` | Overnight scaling |
| `tokenGuard.dailyMaxTotalTokensM` | `3500` | `1500` | Overnight scaling |
| `tokenGuard.maxSubagentsPerSession` | `36` | `12` | Matches tiered `<= 32` Swarm cap in installed; scratch caps at 12 |
| `tokenGuard.sessionMaxRequests` | `5000` | `800` | Overnight scaling |

*(Identical fields: `enabled: true`, `uninterruptedMode: true`, `autoCancelGoalOnPause: true`, `autoCompactAt200k: true`, `autoResumeAfterCooldown: true`, `blockZeroProgressStopLoop: true`, `burstWindowSecs: 20`, `minInvocationGapSecs: 2`, `warnRiskyCombo: true`, `emergencyCustomMinutes: null`, `emergencyMinutesRange: [30, 45]`, `emergency_unlock: false`, `gitAutomation.*`, `contextHardCapTokens: 750000`, `contextWarnTokens: 200000`, `minCacheHitWarnPct: 40`, `windDownLeadMinutes: 3`.)*

### 2.2 Structural, Binary & Packaging Drift

| Dimension | Installed (`C:\Users\khang\.gemini\config\plugins\agy-fast`) | Scratch (`C:\Users\khang\.gemini\antigravity\scratch\agy-fast`) | Finding & Risk |
| :--- | :--- | :--- | :--- |
| Active binary `bin/agy-fast.exe` | `20,164,096 B` (`e8aa3353de01`) | `20,164,096 B` (`e8aa3353de01`) | Byte-identical active binary |
| Stale `.old.*` binaries in `bin/` | **35 files (`546.57 MB` wasted!)** | `0` `.old.*` files | Windows atomic deploy renames locked `.exe` to `bin/agy-fast.exe.old.<ts>`, while `install.mjs#L818-830` only prunes `parentDir/.agy-fast-retired-*.exe` -> unbounded disk growth! |
| `dist/` JS bundles | **Absent (`[]`)** | `4` files (`benchmark.mjs`, `mcp-server.mjs`, `session-start.mjs`, `updater.mjs`) | **`install.mjs update` (`L1639-1646`) crashes** on installed dir with `Missing dist/updater.mjs`; `stress-benchmark.mjs` tests legacy JS `dist/`, not Rust `bin/agy-fast.exe` |
| `RUNTIME_FILES` vs disk scripts | Contains `setup-wsl-agy.ps1` + `login-wsl-accounts.ps1` | Contains both + `login-wsl-accounts.cmd` + `build/test/stress-benchmark.mjs` | `install.mjs#L42-86` omits `setup-wsl-agy.ps1`, `login-wsl-accounts.ps1`, and `extensions/plan-sync/*` from `RUNTIME_FILES` (relying on `PRESERVED_STATE_ENTRIES` for `extensions` only) |
| `C:\Users\khang\.gemini` vs `E:\Users\khang\.gemini` | `C:` holds `antigravity`, `antigravity-cli`, `config` (`skills/`, `plugins/agy-fast/`) | `E:` holds `GEMINI.md`, `skills/`, `config/`, `bin/`, `antigravity-*` | Two separate real folders (`is_symlink=False`); `E:\Users\khang\.gemini\config\skills\global-lessons\references\lessons.md` does **not** exist |
| `README.md` / `package.json` | Not copied into installed root | Upstream `v0.3.1` Node.js docs/manifest | Contradicts `plugin.json` (`v0.23.0` Rust, 11 tools, 6 hooks) — claims "5 MCP tools" and "Zero per-step blocking hooks" |
| Model2Vec binaries (`models/potion-multilingual-128M/`) | Present (`m2v_vocab.bin` `11.6 MB`, `m2v_embed.bin` `130.1 MB`, `skill_vecs.bin` `440 KB`, `1,360` skills indexed on `2026-11-28T06:27:31Z`) | Not stored in scratch | Runtime state cleanly preserved by `install.mjs` `PRESERVED_STATE_ENTRIES`, though `sync_semantic_model.py#L51-59` fallback `TIER2_CATEGORY_IDS` only has 44 IDs vs 64 in `skills-taxonomy.json` |

---

## Section 3 — Deep Execution Audit & Executable Upgrade Blueprint (The 6 Core Mechanisms)

### 3.1 Reality vs Gap Summary Matrix

| Mechanism | Current Implementation Layer | Deterministic Enforcement Today | Critical Gaps Today |
| :--- | :--- | :--- | :--- |
| **`/super-plan`** | Global `SKILL.md` (`disable-model-invocation: true`) + Rust `PreInvocation` + `PreToolUse` + `PostToolUse` + MCP `super_engine` | **HIGH (Executable)**: `guard.rs#L5827` & `super_engine.rs#L1564` bind `mode="super_plan"`, `stopHook=OFF`, `ask_question=ALLOWED` (overrides global `uninterrupted_mode` in `hooks_extra.rs#L163-167`), logs tool proof, allows codebase-aligned coding. | 1) Does not auto-scaffold `.agents/super/blueprint.md` or `memory_sync(omnia_init)`. 2) `/super-plan + /goal` silently promotes to `super_run`. 3) `D:\Omnia` lacks a split `/super-plan` command (`super-plan-run-lifecycle` is a single merged skill suppressed in `skills-taxonomy.json`). |
| **`/super-run`** | Global `SKILL.md` (`disable-model-invocation: true`) + Rust `PreInvocation` + `PreToolUse` + `PostToolUse` + `Stop` + MCP `super_engine` | **VERY HIGH (Executable)**: Auto-denies `ask_question` (`hooks_extra.rs#L168-173`); converts destructive `ask` -> `deny` (`L257-270`); logs all tool proof & resets `verifyAfterLastEdit=0` / `auditStreak=0` on source edits; built-in `/goal`-grade `Stop` hook checks 6 gates (`disjoint_ownership`, `steer_queue_drained`, open Omnia tasks/DOD, `verification_proof`, `waves_completed`, `audit_streak`) with zero-progress kill-switch & 2-Strike RCA directive. | 1) Hard `MAX_SAFE_CONTINUATIONS = 5` (`super_engine.rs#L13`) can stop long multi-wave runs prematurely if continuations are not refreshed per wave completion. 2) `disjoint_paths` is NOT enforced proactively in `PreToolUse` (only checked post-hoc on `verify_ownership` / `Stop`). 3) Does not block `ArtifactMetadata.RequestFeedback: true` modal stalls. 4) `audit_streak` only enforces when waves were registered via `plan_wave` or explicitly listed in `required_gates`. |
| **`/learn`** | **Prose-only** in `GEMINI.md`, `rules/AGENTS.md`, `super-run/SKILL.md` + raw CLI/MCP primitives (`agy-fast memory learn`, `memory_sync(retain)`, `omni_skills(create)`) | **NONE at command/hook layer**: No `config/skills/learn/SKILL.md`, no `PreInvocation` `/learn` handler, no post-task/Stop learning extractor, no automated secret-scan or overlap-dedup pipeline. *(In `D:\Omnia`, `/learn` exists in TUI & `POST /api/v5/learn/capture`, disconnected from `agy-fast`.)* | Completely relies on LLM remembering prose instructions; high risk of skipped learning, duplicate lessons/skills, or unvalidated writes. |
| **`global-lessons`** | Passive global skill (`disable-slash-command: true`) + `references/lessons.md` (`18/100` entries) | **NONE at runtime**: `snapshot.rs` (`SessionStart`) does **NOT** read `global-lessons/references/lessons.md` (`L566-586` checks workspace `.agents/memory/lessons.md` only). `memory.rs` has **zero** code reading, writing, deduplicating, or capping global lessons. | 1) Lessons aren't surfaced automatically unless the model manually calls `read_file`. 2) Split across **3 unlinked paths**: `C:\Users\khang\.gemini\config\skills\global-lessons\references\lessons.md`, `D:\OmniaData\memory\global_lessons.md` (**missing**), and `~/.codex/memories_v2/...`. 3) Fallback `pending-global-lessons.md` has no automated merge runner. |
| **`ALWAYS_ACCEPT_LEARN`** | **100% Prose-only** in `E:\Users\khang\.gemini\GEMINI.md`, `rules/AGENTS.md`, `super-run/SKILL.md`, `omnia-governance/references/memory-evolution-handoff.md` | **ZERO Rust/Hook code (`0` hits in 31 `.rs` files)**: Not enforced in `PreToolUse`, `PostToolUse`, `memory.rs`, or `omni_skills.rs`. | If an agent writes a learning artifact with `RequestFeedback: true` or calls `ask_question` before updating skills/lessons, nothing enforces auto-accept or gates security/secret safety deterministically. |
| **`auto-proceed` (Uninterrupted Mode)** | 3-layer stack: `config/config.json` (`EAGER`/`TURBO`/`ALLOW`) + `guard-config.json` (`uninterruptedMode: true`) + `hooks_extra.rs` (`PreToolUse`) + `guard.rs` (`PreInvocation` auto-resume/auto-compact) | **MEDIUM-HIGH (Partial Executable)**: Deterministically denies `ask_question` when `uninterruptedMode=true` (outside `/super-plan`); converts modal `ask` -> `deny` in unattended `/goal`/`/super-run`; arms native 1-shot `schedule` auto-resume on healthy stretch cooldowns; CLI `agy-fast guard uninterrupted on|off`. | 1) **Major Hole**: `write_file`/`edit_file` with `ArtifactMetadata.RequestFeedback: true` is NOT blocked in `PreToolUse` -> UI still pauses on `"Proceed"` button! 2) Plain-text trailing confirmation questions (`"Shall I continue?"`) outside `/super-run` are NOT caught by `Stop` hook. 3) Global-only toggle (no per-conversation `/auto-proceed on|off` override). 4) Installed `pauseCooldown: true` silently disables `autoCompactAt200k`! |

---

### 3.2 Concrete Executable Upgrade Blueprint (Across `agy`, `agy-fast`, and `D:\Omnia`)

#### A. Make `auto-proceed` Truly Uninterrupted & Deterministic (Zero Modal Freezes, Zero Security Weakening)
1. **`PreToolUse` `RequestFeedback` Guard (`native/src/hooks_extra.rs`)**:
   - Inspect `write_file` / `edit_file` payloads when `cfg.enabled && (cfg.uninterrupted_mode || is_super_run_active(&ws, conv_id))` AND NOT `is_super_plan_active(&ws, conv_id)`:
   - If `payload.pointer("/toolCall/args/ArtifactMetadata/RequestFeedback") == Some(json!(true))` (or snake_case variant), return `{"decision": "deny", "reason": "[agy-fast auto-proceed] ArtifactMetadata.RequestFeedback=true pauses execution for a UI Proceed click. Re-write with RequestFeedback: false and continue autonomously (switch to /super-plan or run /auto-proceed off to allow approval gates)."}`.
   - **Security invariant**: NEVER weaken `deny_patterns()` (destructive `rm -rf`, format, OAuth exfil, proxy launch, `agy` loop) or ToS guards; keep destructive `ask_patterns()` converted to `deny` (not `allow`) in unattended runs so safety increases while modal hangs hit zero!
2. **Per-Conversation `/auto-proceed [on|off|status]` Executable Slash Command + Skill**:
   - Add `C:\Users\khang\.gemini\config\skills\auto-proceed\SKILL.md` (`disable-model-invocation: true`) AND handle `prompt_has_slash_command(effective_user_input, "/auto-proceed")` inside `guard.rs` (`PreInvocation`) storing `auto_proceed_overrides: HashMap<String, bool>` in `GuardState` (keyed by `conv_id`, bounded 64 entries) so one tab can toggle interactive mode without mutating global `guard-config.json` for parallel tabs.
3. **Plain-Text Trailing Question Stop-Hook Guard (`hooks_extra.rs` `evaluate_stop_hook_with_guard`)**:
   - When `auto_proceed` is active (even outside `/super-run`, while NOT in `/super-plan`, NOT in cooldown/error, and bounded to max `2` nudges per turn with zero-progress kill-switch), scan the final 3 non-empty lines of `lastAssistantMessage` for unanswered interactive confirmation prompts (`/\b(shall i proceed|would you like me to|ready to continue|confirm before|chọn phương án|bạn có muốn tôi tiếp tục)\b.*\?$/i`) and return `{"decision": "continue", "reason": "[agy-fast auto-proceed] Uninterrupted Mode is ON — do not pause for confirmation. Auto-select the (Recommended) option, document it concisely, and execute directly."}`.
4. **Decouple `autoCompactAt200k` from `pauseCooldown` (`guard.rs#L6525`)**:
   - Change `!cfg.pause_cooldown && cfg.auto_compact_at_200k` -> `cfg.enabled && cfg.auto_compact_at_200k` (so pausing stretch cooldowns during intensive overnight runs NEVER silently kills 200k auto-compaction!).

#### B. Turn `/learn`, `global-lessons`, and `ALWAYS_ACCEPT_LEARN` Into Real Executable Infrastructure
1. **Dedicated Executable `/learn` Skill (`C:\Users\khang\.gemini\config\skills\learn\SKILL.md`)**:
   - `disable-model-invocation: true` so `/learn [scope=auto|project|global|skill] [topic]` becomes a first-class slash command across `agy` CLI, Desktop, and IDE (and synced to `D:\Omnia\.agents\skills\`).
   - Wires directly to new deterministic MCP action `memory_sync({ action: "learn_apply", scope: "auto|project|global|skill", autoAccept: true, text, category, provenance, targets })` (and CLI `agy-fast memory learn --global|--sync`).
2. **Make `ALWAYS_ACCEPT_LEARN` a Real Config Flag + `PreToolUse` / `MCP` Gate (`guard-config.json` + `memory.rs` + `omni_skills.rs`)**:
   - Add `learnPolicy: { alwaysAcceptLearn: true, autoExtractOnSuperComplete: true, globalLessonsCap: 100, syncTargets: ["gemini-global", "omnia-data", "codex"] }` to `guard-config.json` (`schemaVersion: 12`).
   - When `memory_sync(learn_apply)` runs:
     1. **Deterministic Secret & PII Gate (Mandatory)**: Reject any entry triggering `audit.rs` secret patterns (`AKIA`, `ghp_`, `AIza`, `sk-`, bearer/cookie/private-key, personal emails) BEFORE writing a single byte.
     2. **Semantic + Lexical Dedup Gate**: Compute normalized trigram/Jaccard + Model2Vec cosine against existing entries in `.agents/memory/lessons.md`, `C:\Users\khang\.gemini\config\skills\global-lessons\references\lessons.md`, and `omni_skills(route)` — merge/strengthen matching entries instead of duplicating.
     3. **Cap-100 LRU/Priority Enforcement**: Enforce the 100-entry global cap deterministically, archiving superseded entries with provenance rather than growing unboundedly.
     4. **Cross-Host Atomic Mirror**: Atomically mirror validated global lessons across:
        - `C:\Users\khang\.gemini\config\skills\global-lessons\references\lessons.md` (SSOT for Antigravity)
        - `D:\OmniaData\memory\global_lessons.md` (SSOT for `omnia-harness::artifact_os` & `omnia.exe` TUI `/lessons`)
        - Pending merge drain: automatically ingest any `<workspace>/.agents/memory/pending-global-lessons.md` when host allows external writes!
     5. **Skill Validation Gate**: When promoting a playbook to a skill (`omni_skills(create)`), auto-run `skill-doctor` + `secrets` + `preservation` verifiers before returning `applied`, and **forbid weakening any security/permission/ToS rule** even under `alwaysAcceptLearn: true`.
3. **Auto-Hydrate Top Global Lessons in `SessionStart` (`snapshot.rs`)**:
   - Update `build_workspace_snapshot()` (`snapshot.rs#L565-605`) to check `C:\Users\khang\.gemini\config\skills\global-lessons\references\lessons.md`, reporting entry count (`global-lessons (18/100)`) in `Continuity:` and optionally injecting the top 3 workspace-stack-matched lesson titles (e.g., Rust/Cargo + PowerShell + Windows lessons when `Cargo.toml` is detected, bounded `<= 280 B` within the `1,500 B` snapshot cap — zero static KV-cache churn!).
4. **`PostSuperComplete` Auto-Learn Hook (`super_engine.rs`)**:
   - Inside `handle_complete()` (`super_engine.rs#L3754`) when a `/super-run` finishes cleanly with `edits > 0` or `error_calls >= 2`, inspect whether any lesson was retained during the run (`tool_proof_counts.memory_sync == 0`); if `0` and `alwaysAcceptLearn == true`, return a compact structured prompt in the completion receipt (or auto-capture verified RCA summaries from `.agents/memory/RUN_JOURNAL.md` via `learn_apply`).

#### C. Harden `/super-plan` & `/super-run` Execution Contracts
1. **Proactive `PreToolUse` `disjoint_paths` Guard (`hooks_extra.rs` + `super_engine.rs`)**:
   - When `super_run` has an active wave with registered `workers[]` and a worker calls `edit_file`/`write_file`/`apply_edits` with a known worker/conversation identity, verify path containment against `owned_paths` / `excluded_paths` *before* the write lands on disk.
2. **Wave-Scoped Continuation Budget (`super_engine.rs`)**:
   - Reset `stop_continuations_by_conv` whenever `handle_advance_wave()` transitions a wave to `completed` (not just on fresh user prompts), preventing `MAX_SAFE_CONTINUATIONS = 5` from halting healthy 6+ wave autonomous `/super-run` executions while retaining the 1-strike zero-progress kill-switch!
3. **Auto-Scaffold on `super_engine(init)`**:
   - Add optional `bootstrapOmnia: true` (default `true` on `super_plan`/`super_run` init when `.agents/super/blueprint.md` is absent) so `/super-plan` immediately initializes `.agents/super/blueprint.md` + `engine_state.json` without manual boilerplate turns.
4. **Unify `agy-fast` `super-plan`/`super-run` with `D:\Omnia` (`omnia-cli` & `omnia-harness`)**:
   - Expose `/super-plan`, `/super-run`, `/auto-proceed`, and `/learn --global` consistently in `D:\Omnia` (`rust/omnia-cli/src/tui.rs` + `omnia-harness::artifact_os`), reading the shared `D:\OmniaData\memory\global_lessons.md` mirrored from `global-lessons/references/lessons.md`, and remove `super-plan-run-lifecycle` shadowing ambiguity in `skills-taxonomy.json`.

---

## Section 4 — Complete Asset, Script, Hook & Extension Audit

### 4.1 Active Global & Plugin Skill Topology (`2026-11-28` Consolidated State)

- **4 Global Skills** (`C:\Users\khang\.gemini\config\skills\`): `super-plan` (70L), `super-run` (98L), `global-lessons` (19L + 22L refs), `vietnamese-typo-intent-inference` (29L). Backed by reversible `skills-archive/2026-11-28-pre-merge/` (`9` retired global + `8` retired `agy-fast` stubs with SHA-256 receipts).
- **8 Bundled `agy-fast` Pillar Skills + 19 Progressive-Disclosure Reference Docs** (`1,039 L`, `108.8 KB`):
  1. `deep-research` (93L + 26L ref): 6-stage active web + `research_vault` pipeline enforcing NotebookLM-grade inline `[[S###]](url#:~:text=...)` citations + automated `verify_citations({ strict: true })`.
  2. `deep-think` (46L + 29L formal proofs + 23L RCA): 3-branch Tree-of-Thought, scratch differential brute-force oracles, 2-Strike RCA, `transcript_full.jsonl` hook forensics.
  3. `doc-studio` (35L + 6 format refs `130 L`): Unified 6-format authoring (`.docx`, `.xlsx`, `.pptx`, `.pdf`, `.tex`, `.md`) with Vietnamese NFC font safety, zero-pollution `uv run --with`, and mandatory programmatic post-export inspection.
  4. `engineering-mastery` (33L + 4 refs `103 L`): Graphify-first `quick_outline`, Hashline `apply_edits`, bidirectional `A <-> B` peer-mesh swarms, `agy-fast audit`/`cache-audit`/`slop`/`preservation`, Git worktrees, and NTFS `/XJ` reparse-safe Deep Clean with `0 B` same-volume capacity accounting.
  5. `intelligent-canvas-ui` (78L + 21L ref): Modality decision matrix (`<agent-embed>` `<= 450px` flush widgets, `canvas_studio` SEP-1865 `research_dossier`/`code_canvas`/`file_preview`/`image_preview`/`web_preview`, strict `default-src 'none'` CSP, WCAG 2.1 AA, zero `.innerHTML`).
  6. `omni-router` (82L): 2-tier hierarchical Cold Vault routing (`skills-taxonomy.json`), 24 flagship DAG pipelines, 7 native Phase-3 verifiers (`preservation`, `contrast`, `tokens`, `bakers`, `secrets`, `skill-doctor`, `slop`), and `omni_skills(create)` with Merkle `SKILL_LOCK.json` resealing.
  7. `omnia-governance` (53L + 5 refs `183 L`): Canonical 7-layer artifact taxonomy backed by `.agents/memory/omnia_state.json` (`omnia.workspace-state.v2`, CAS `headVersion`, `tokenBudget: null`), 4 proposal archetypes, 7-state evidence recovery, `ADDITIVE_INTAKE` CAS + tombstone fencing, `SESSION-G01..G07`, cryptographic `ErasureReceipt`, and 6-state completion receipt.
  8. `tos-shield` (37L): Anti-ban boundaries, clean `<!-- GOAL_CANCELLED -->` exit, Swarm `[board]` wakeup exemption, dual-pool (`Gemini` vs `Claude & GPT`) quota balancing, tiered `<= 32` worker caps.
- **6 Cold `doc-skills/`** (`226 L`, `19.5 KB`): `doc-docx`, `doc-latex`, `doc-markdown`, `doc-pdf`, `doc-pptx`, `doc-xlsx` — indexed as `source_kind: 0` (`Tier 1`) in `skill_vecs.bin` so bilingual EN/VN document export prompts auto-route in `< 2 ms`. Note: their content strongly overlaps `skills/doc-studio/references/*.md` (intentional cold-router companion pair, though maintenance must keep both synchronized).
- **2-Tier Taxonomy & Model2Vec Semantic Router (`skills-taxonomy.json` + `sync_semantic_model.py`)**:
  - `100` Omni categories (`1,001` skills) split into **36 Tier-1** (`383` skills, open semantic+lexical auto-routing) and **64 Tier-2** (`618` skills, hard-gated opt-in EN/VN anchors only in `PreInvocation`), plus **99-slug `external_dedup_blocklist`** (`88` present on disk across Codex `270`, Agents `39`, Omnia `22`).
  - Compiled `minishlab/potion-multilingual-128M` (`256D`, `500,353` vocab, ScaleMCP TDWA `0.40*name + 0.35*desc + 0.25*triggers`, int8 quantized) indexes **`1,360` total skills** (`6` doc + `1,001` vault + `157` plugin + `196` external cold; `618` Tier-2 gated) in `m2v_vocab.bin` (`11.64 MB`), `m2v_embed.bin` (`130.09 MB`), and `skill_vecs.bin` (`440.1 KB`).

### 4.2 Rules, Hooks & MCP Surface

- **`rules/AGENTS.md` (`71 L`, `18,186 B`)**: Always-on rule packing 11 MCP schemas, Deep Think, Deep Research + NotebookLM citations, `/super-plan`/`/super-run`, `ADDITIVE_INTAKE`, Omnia Governance v2, `ALWAYS_ACCEPT_LEARN`, Hybrid Model2Vec Router, `canvas_studio`, Anti-Ban, Uninterrupted Mode, and Dual-Pool guidance. **Risk**: At `18.2 KB` (74% of Antigravity's `24 KB` single-rule ceiling), further inline additions risk silent truncation or `agy-fast audit` failure; static content overlapping `E:\Users\khang\.gemini\GEMINI.md` should be deduplicated to keep KV prefix compact (`< 14 KB` target).
- **`hooks.json` (`56 L`, `6` hooks, `5s` timeout each)**: All 6 lifecycle hooks (`SessionStart`, `PreInvocation`, `PreToolUse "*"`, `PostToolUse "*"`, `PostInvocation`, `Stop`) invoke `bin\agy-fast.exe --hook-*`. Well-bounded (`< 1 ms` fast-path on `PostToolUse` non-edits; `250 ms` scan breaker on `SessionStart`; `2s` anti-spin throttle on silent repeat terminate in `PreInvocation`).
- **`mcp_config.json` (`45 L`, `11` eager tools)**: Single stdio Rust server `fast` (`bin\agy-fast.exe --mcp`) with all 11 tools marked `eager: true`: `batch_search`, `apply_edits`, `read_slices`, `quick_outline`, `run_checks`, `memory_sync`, `workspace_health`, `research_vault`, `omni_skills`, `super_engine`, `canvas_studio`.

### 4.3 Scripts & Browser Extension Security/Hygiene Audit

| File | Observed Behavior | Verified Defects / Risks |
| :--- | :--- | :--- |
| `scripts/install.mjs` (`1,924 L`) | Node `>= 20` installer/doctor/config/uninstall with staged atomic swap, `PRESERVED_STATE_ENTRIES`, `rules/*.local.md` preservation, and T3 Code ACP / `GEMINI_HOME` isolated profile sync. | 1) `runUpdate()` (`L1639-1646`) requires deleted `dist/updater.mjs` -> **broken on Rust installs**. 2) `cleanupRetiredBinaries()` (`L818-830`) only cleans `parentDir/.agy-fast-retired-*.exe`, missing `bin/agy-fast.exe.old.*` -> **`546.57 MB` leaked across 35 files**. 3) `RUNTIME_FILES` omits `setup-wsl-agy.ps1`, `login-wsl-accounts.ps1`, and `extensions/plan-sync/*`. |
| `scripts/sync_semantic_model.py` (`855 L`) | Pure-stdlib (optional `numpy`) HuggingFace downloader + binary compiler (`M2VV0001` Bloom+hash vocab, `M2VE0001` int8 embeddings, `M2VS0001` TDWA skill vectors). | 1) Hardcoded fallback `TIER2_CATEGORY_IDS` (`L51-59`) has `44` IDs vs `64` in `skills-taxonomy.json`. 2) Hardcoded local personal paths (`D:\Omnia\.agents\skills`, `E:\Users\khang\...` at `L636-640`) instead of env/config discovery. |
| `scripts/setup-wsl-agy.ps1` (`93 L`) | Provisions minimal 384 MB RAM / 0 swap / 10s idle-shutdown WSL2 Debian partition (`agy-acc-2`), installs official `agy` CLI (`curl -fsSL https://antigravity.google/cli/install.sh | bash`), terminates to 0 MB idle. | Uses `gsudo` / `RunAs` UAC elevation and unpinned `curl | bash`; omits `--no-optional` verification of installer checksum; missing from `install.mjs` `RUNTIME_FILES`. |
| `scripts/login-wsl-accounts.ps1` (`30 L`) + `.cmd` (`2 L`) | Interactive one-time login helper for 3 WSL2 partitions (`agy-acc-2..4`) running `agy -p "Reply ." --disable-slash-commands --print-timeout 25s` then `wsl --terminate`. | **PII Leak**: Hardcodes 3 personal Gmail addresses at `L3-L5` (`<redacted-personal-email-1..3>`) inside both installed & scratch trees! `.cmd` wrapper hardcodes absolute `C:\Users\khang\...` scratch path. |
| `scripts/build.mjs`, `test.mjs`, `stress-benchmark.mjs` (`1,590 L`) | Legacy esbuild bundler, Node test runner, and thorough 12-scenario MCP stress/soak/ReDoS/git-redteam benchmark. | **All target legacy JS `dist/*.mjs`**, NOT `bin/agy-fast.exe`! Porting `stress-benchmark.mjs` to accept `--bin=bin/agy-fast.exe` (switching `process.execPath, [MCP_SERVER]` -> `bin, ["--mcp"]` and `["--hook-session-start"]`) would immediately give the Rust binary a 12-scenario real-world torture gate! |
| `extensions/plan-sync/{manifest.json, content.js}` (`75 L`) | MV3 Chrome extension (`v0.12.0`) scraping Google One visible tier (`Ultra`/`Pro`/`Plus`/`Free`, EN+VN `"gói hiện tại"`) + email on `one.google.com`, POSTing to `http://127.0.0.1:47890/api/accounts/tier-sync` at `1.2s`/`3.0s`/`5.5s`. | **Security Gap**: Localhost endpoint `127.0.0.1:47890/api/accounts/tier-sync` is called with plain `Content-Type: application/json` and **no per-install auth token** (`X-Agy-Fast-Token`) — vulnerable to local CSRF / unauthorized tier overwrites if the server doesn't enforce strict `Origin: https://one.google.com` + token auth. Also fragile DOM scraping (`body.innerText` regex picks first email on page). |

---

## Section 5 — Actionable Integration Candidates (`D:\Omnia` vs `agy` / `agy-fast`)

### 5.1 High-Value `D:\Omnia` Integration Candidates (Preserving Steer #22 Default YOLO Harness!)

1. **Unified Global Lessons Mirror (`D:\OmniaData\memory\global_lessons.md` <-> `C:\Users\khang\.gemini\config\skills\global-lessons\references\lessons.md`)**:
   - Wire `omnia-harness::artifact_os` (`Lessons` Tier-2) and `POST /api/v5/learn/capture` to seed & atomically mirror `D:\OmniaData\memory\global_lessons.md` with Antigravity's `global-lessons/references/lessons.md` (currently absent on `D:\OmniaData\memory\`), running secret-redaction + dedup + cap-100 on write.
2. **Adopt `agy-fast`'s Executable `/super-plan` & `/super-run` Contract Parity in `omnia-cli` & `omnia-agent`**:
   - Add `/super-plan`, `/super-run`, `/auto-proceed`, and `/learn --global` slash commands in `rust/omnia-cli/src/tui.rs` backed by `.agents/super/engine_state.json` + `tool_proof.jsonl` + `audit_rounds.jsonl` compatibility, while **strictly preserving Omnia's Steer #22 `ApprovalMode::Yolo` default** (`PermissionsEngine::default_rules()` remains empty; safety/ownership guards remain opt-in or wave-contract scoped!).
3. **Adopt Pure-Rust Model2Vec (`M2VV0001`/`M2VE0001`/`M2VS0001`) Binary Format in `omnia-harness::skill_registry`**:
   - Reuse the compiled `skill_vecs.bin` (`440 KB`) + `m2v_vocab.bin` / `m2v_embed.bin` read-only lookup to augment Omnia's BM25 Cold Vault (`omni-deep-1000-catalog.json`) with `< 2 ms` multilingual VN/EN semantic recall without adding any Python/ONNX runtime dependency or exceeding the `omnia.exe <= 14 MiB` binary ceiling.
4. **Port `stress-benchmark.mjs` Red-Team & Edge-Path Assertions to Omnia QA**:
   - Incorporate `S7` (12-level CJK/space/symlink dedup), `S10` (20 hostile read-only git injection payloads), and `S11` (4-byte ZWJ emoji UTF-8 byte-cap truncation with zero lone surrogates) into `tools/omnia-benchmark` or `omnia-workspace-ops` tests.
5. **Reconcile `skills-taxonomy.json` `external_dedup_blocklist` Against `D:\Omnia\.agents\skills/`**:
   - Currently `skills-taxonomy.json` blocks `12` of Omnia's `22` curated skills (`additive-steer-queue`, `deep-clean`, `deep-general-graph-orchestration`, `deep-proposal`, `deep-research`, `deep-steer`, `deep-think`, `goal-plan-loop-dod`, `kdense-citation-management`, `kdense-literature-review`, `omni-bilingual-skill-router`, `omni-deterministic-verifiers`, `omnia-session-governance-handoff`, `super-plan-run-lifecycle`, `vietnamese-typo-intent-inference` — actually `15`!). Verify workspace-local `D:\Omnia\.agents\skills\` precedence stays authoritative when working inside `D:\Omnia`.

### 5.2 High-Value `agy` / `agy-fast` Hardening & Cleanup Candidates

1. **Prune `546.57 MB` of `installed/bin/agy-fast.exe.old.*` & Fix `install.mjs`**:
   - Extend `cleanupRetiredBinaries()` to prune `bin/agy-fast.exe.old.*`, update `runUpdate()` to invoke `bin/agy-fast.exe` (or rebuild/download Rust release assets) instead of missing `dist/updater.mjs`, and add `setup-wsl-agy.ps1` + `extensions/plan-sync/*` to `RUNTIME_FILES`.
2. **Implement Executable `auto-proceed`, `/learn`, `global-lessons`, and `ALWAYS_ACCEPT_LEARN` Upgrades** (Section 3.2 above):
   - `PreToolUse` `ArtifactMetadata.RequestFeedback: true` guard, per-conv `/auto-proceed` override, `SessionStart` global-lessons hydration, `memory_sync(learn_apply)` secret-gated cross-host mirror, wave-reset `super-run` continuations, and decoupling `autoCompactAt200k` from `pauseCooldown`.
3. **Sync `guard-config.json` Schema & Fix `pauseCooldown: true` Drift**:
   - Ensure `autoRouteColdSkills` is serialized in scratch default `guard-config.json`, document why `pauseCooldown: true` is active on installed (or switch back to `false` under `overnight` preset so `autoCompactAt200k` stays armed).
4. **Scrub PII & Hardcoded Paths from Scripts**:
   - Refactor `scripts/login-wsl-accounts.ps1` to read partition/email pairs from untracked local config (`~/.gemini/config/plugins/agy-fast/wsl-accounts.local.json` or CLI params) instead of hardcoding personal Gmail addresses; fix `login-wsl-accounts.cmd` relative `%~dp0` path; load external skill roots dynamically in `sync_semantic_model.py` and sync its `TIER2_CATEGORY_IDS` fallback to all `64` IDs.
5. **Harden `extensions/plan-sync` & Trim `rules/AGENTS.md`**:
   - Require a per-install local bearer token + strict `Origin: https://one.google.com` check on `127.0.0.1:47890/api/accounts/tier-sync`.
   - Slim `rules/AGENTS.md` from `18.2 KB` down to `~12–14 KB` by deduplicating rules already present in `GEMINI.md` and `SKILL.md` progressive references, preserving safe headroom under Antigravity's `24 KB` cap.
   - Refresh `scratch/README.md` and `scratch/package.json` (`0.3.1` -> `0.23.0`) and adapt `scripts/stress-benchmark.mjs` to test `bin/agy-fast.exe --mcp` directly.
