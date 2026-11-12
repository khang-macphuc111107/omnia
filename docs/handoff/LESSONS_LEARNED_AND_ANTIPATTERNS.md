# Omnia — Lessons Learned & Engineering Anti-Patterns

This postmortem handbook distills **12 costly failure modes caught across Omnia's Codex, Antigravity (Desktop & CLI), and Claude histories** into concrete, enforceable rules so collaborator **HTMusTC** and future AI agents never repeat them.

---

## Quick Reference Checklist

| # | Anti-Pattern | Permanent Guardrail |
|---|---|---|
| 1 | Polluting `D:\Omnia` with `target/`, `.tmp-*`, screenshots, backups, or nested worktrees | Set `CARGO_TARGET_DIR=D:\OmniaData\tools\cargo-target`; route all runtime/QA/research/worktrees to `D:\OmniaData\*`. |
| 2 | Shipping template "AI slop" UI without preview candidates, DPI/resize checks, or UIA inspection | Lock 3 distinct interactive previews first (`PENDING_USER_REVIEW`), enforce contrast/hit-target metrics, and run UIA + cropped region captures. |
| 3 | Proliferating overlapping `deep-*` skills & >300-char descriptions | Keep skills orthogonal with crisp trigger boundaries and `< 300 char` frontmatter descriptions (`omnia-harness/src/skills.rs`). |
| 4 | Treating mid-run `steer` as "replace & forget" or setting silent `token_budget` caps | Treat `steer` as an additive queue (reconcile conflicts, finish all prior backlog); leave `token_budget = NULL` unless user-specified. |
| 5 | Globbing only `*.jsonl` (missing 103 `.jsonl.zst` rollouts) or ignoring SQLite `.db` protobufs | Always inventory compressed archives (`.jsonl.zst`) and SQLite wire-format `.db` steps (`step_type=17` 429 errors); never claim semantic coverage from hashes alone. |
| 6 | PowerShell double-quoted here-string (`@"..."@`) interpolation corrupting Markdown & code | Always use single-quoted literal here-strings (`@'...'@`) or Python UTF-8 file writers, followed by `git diff --check`. |
| 7 | Misreporting same-drive quarantine moves (`D:\` -> `D:\`) as freed disk space | Verify actual volume free bytes (`Get-PSDrive D`) before and after cleanup; same-volume moves relocate clutter (`0 B` freed), not reclaim space. |
| 8 | Hijacking physical mouse/keyboard focus during `computer-use` / browser QA | Default to headless CDP, `PrintWindow` (`bgwin.rs`), bottom-z-order targets, and Virtual Cursor overlays—never steal physical cursor focus unprompted. |
| 9 | Mutating source Git trees during "read-only" checks or pushing unauthorized side branches | Never run `git sparse-checkout reapply` / `checkout` on reference trees; open SQLite with `?mode=ro` + `PRAGMA query_only=ON`; verify exact GitHub org/branch (`111107`, not `11107`). |
| 10 | Hardcoding models, regex-blocking `gpt` model IDs, or stalling on HTTP 429 walls | Use data-driven capability registries + Dynamic Router (`routing.rs`) with atomic quota reservation, interactive reserve, and cross-provider circuit breakers. |
| 11 | Mixing inline paste and attachment-tray semantics or duplicating binary blobs | Preserve ordered inline document nodes (`inline-at-caret` vs `tray`) backed by one content-addressed `payload_id` and `Esc`-safe paste modals. |
| 12 | Allowing transient chat credentials, browser cookies, or API keys near exports/repos | Enforce OS Keyring `SecretBroker` in code, ban cookie/master-key imports, and run automated zero-secret regex verification before staging or handoff. |

---

## Detailed Postmortems

### 1. Repository Root Pollution (`ROOT-01`..`ROOT-06`)
- **Provenance**: Codex `01a1bce9` Prompts `#2`, `#21`, `#94`–`#100`, `#115`, `#121`; Claude `be2beaab`, `308b37b9`.
- **What Went Wrong**: Parallel agents dumped Rust `target/` builds, `.tmp-*` probe scripts, full-screen PNG captures, beside-source `.bak`/copy files, `.claude`/`.agents` scratchpads, and nested `repos/omnia` / `publish-worktree` clones directly inside `D:\Omnia`. This bloated `D:\`, slowed IDE indexing/ripgrep to a crawl, and risked accidentally staging scratch artifacts to GitHub.
- **Permanent Rule**:
  1. `D:\Omnia` is **strictly** for tracked product source, manifests, deterministic tests, and canonical docs (`docs/{workspace,ui-direction,handoff}`).
  2. Always export `$env:CARGO_TARGET_DIR = "D:\OmniaData\tools\cargo-target"`.
  3. Store all runtime DBs, QA screenshots, UI preview HTML bundles, research clones, and worktrees under `D:\OmniaData\`.

---

### 2. Blind UI Implementation, Status-Panel Clipping & Missing UIA Controls
- **Provenance**: Codex `01a1bce9` Prompts `#5`, `#23`, `#109`, `#110`, `#113`; Antigravity CLI `c2cc6103` (+ 20 `ui-fixer` workers); [CHECKPOINT.md](../workspace/CHECKPOINT.md).
- **What Went Wrong**:
  - Earlier web/Tauri iterations produced generic dark-gradient "AI slop" cards with low-contrast muted text, inconsistent spacing, and overflowing flex containers.
  - Early native Win32 builds passed basic process-launch checks while hiding two real UX defects caught only by region-cropped capture + UI Automation (`UIA`) inspection: (a) right/bottom status-panel text clipping at standard widths, and (b) custom-drawn composer areas missing an accessible `UIA Edit` control (`Missing UIA control: Edit`).
- **Permanent Rule**:
  1. Follow the **Preview-First 3-Candidate Gate** ([DIRECTION_DECISION.md](../ui-direction/DIRECTION_DECISION.md)) and wait for human approval (`PENDING_USER_REVIEW` -> `APPROVED`) before rewriting major UI surfaces.
  2. Every native Win32 interactive input **must** expose standard keyboard navigation + UI Automation roles (`Edit`, `Button`, `List`, `TabItem`).
  3. Visual QA must test multiple window sizes/DPIs, scroll through long lists, and capture **cropped component regions** (`native/qa-capture.ps1`).

---

### 3. Skill Catalog Explosion & `300-Char` Description Truncation
- **Provenance**: Collaborator spec chat (`6e51d544` `Pasted text.txt` L15–L19); Codex `01a1bce9` Prompts `#2`, `#114`, `#124`; [skills.rs](../../src-tauri/crates/omnia-harness/src/skills.rs).
- **What Went Wrong**: Creating dozens of overlapping `deep-*` skills (`deep-engineer`, `deep-senior`, `deep-junior`, `deep-task`, `deep-decision`, `deep-resolve`, etc.) with verbose frontmatter caused two compounding bugs:
  1. `omnia-harness/src/skills.rs` truncates long skill descriptions when building the system prompt index, chopping off distinguishing trigger clauses placed at the end of descriptions.
  2. When 15+ skills share near-identical adjectives, the LLM hallucinates or picks suboptimal skills—degrading output quality compared to having fewer, sharper skills.
- **Permanent Rule**:
  1. Front-load every `SKILL.md` `description` within **180–280 characters**: state **exact trigger action + artifact owned + explicit "Don't use for..." boundary** in the first two sentences.
  2. Merge near-synonyms into single authoritative domain skills rather than spawning persona/adjective duplicates.

---

### 4. Dropping Unfinished Backlog on Mid-Run `Steer` & Unauthorized `token_budget` Caps
- **Provenance**: Codex `01a1bce9` Prompts `#20`, `#98`, `#102`, `#114`; `goals_1.sqlite` history.
- **What Went Wrong**:
  - When the user sent a short mid-turn `steer` (e.g., *"also crawl these 6 links"* or *"fix that flag"*), agents repeatedly abandoned the 80%-complete clean-root / product-wiring backlog and stopped right after answering the steer.
  - Separately, an earlier goal configuration set a finite `token_budget` cap on an overnight run, causing premature halting before Definition of Done gates passed.
- **Permanent Rule**:
  1. **Additive Steer Invariant**: Every `steer` pushes onto an active task ledger. Complete/checkpoint the interrupted step, execute the steer, reconcile any conflict with prior/completed items, and **immediately resume all unfinished ledger tasks**.
  2. **Unlimited Default Budget**: Keep `token_budget = NULL` unless the user explicitly specifies a numeric token ceiling.

---

### 5. Incomplete History Globbing (`*.jsonl` Missing `.jsonl.zst`) & Hash-Only Overclaiming
- **Provenance**: Historical `.codex\research\...\inventory.py` (`2026-11-10`) vs current `D:\OmniaData\exports\history\WATERMARK_AND_DENOMINATORS.json`; [DOD.md](../workspace/DOD.md) `DOD-09` & `DOD-10`.
- **What Went Wrong**:
  - An earlier inventory script globbed only `*.jsonl` (`852` files) and falsely reported that `101` threads in `state_5.sqlite` had "missing rollout files on disk"—missing all **`103` `.jsonl.zst`** zstd-compressed archives sitting right beside them (including critical `Gemini Notebook` and `Google Drive Downloader` sessions)!
  - Similarly, reading only Antigravity `brain/*/transcript_full.jsonl` missed all `step_type=17` (`ERROR_MESSAGE` HTTP 429 quota exhaustion) records stored exclusively inside SQLite `conversations/*.db` wire-format protobufs (`steps.step_payload`).
  - Finally, computing file SHA-256 hashes alone was previously conflated with "reading and extracting requirements."
- **Permanent Rule**:
  1. Always check compressed variants (`.zst`, `.gz`) and binary SQLite `.db` stores (opened strictly via `?mode=ro` + `PRAGMA query_only=ON`).
  2. Separate **structural acquisition** (byte count + SHA-256 + growing-tail watermark) from **semantic extraction** (parsed turns, extracted requirements, verified redaction).

---

### 6. PowerShell Double-Quoted Here-String (`@"..."@`) Escaping Corruption
- **Provenance**: [CHECKPOINT.md](../workspace/CHECKPOINT.md) historical edits (`\native` turned into `<newline>ative`, `` ` `` backticks stripped from Markdown inline code, `$PID`/`$env` expanded to empty strings, heading lines concatenated).
- **What Went Wrong**: Writing Markdown or Rust/JSON files via PowerShell `Set-Content` with double-quoted `@"..."@` caused PowerShell to interpret backticks (`` `n ``, `` `t ``, `` `r ``, `` `` ``) and `$variables` silently corrupting documentation and code blocks.
- **Permanent Rule**:
  1. Prefer structured file-edit tools or Python UTF-8 `Path.write_text(..., encoding="utf-8")`.
  2. In PowerShell scripts, **always** use single-quoted literal here-strings (`@' ... '@`) and verify with `git diff --check`.

---

### 7. Confusing Same-Volume Quarantine Moves with Disk Reclamation (`DRIVE-02`)
- **Provenance**: Codex `01a1bce9` storage audits (`CLEAN-08`, `CLEAN-11`, `CLEAN-13`, `CLEAN-16`, `CLEAN-19`).
- **What Went Wrong**: Moving multi-gigabyte directories from `D:\Omnia\...` to `D:\OmniaData\...` cleaned the git working tree (`ROOT-*`), but was initially misreported as "reclaiming disk space on `D:`"—even though moving files within the same NTFS volume frees **0 bytes** on `D:`.
- **Permanent Rule**:
  - Distinguish **repo externalization** (`D:\Omnia` -> `D:\OmniaData`, `0 B` volume delta) from **true space reclamation** (deleting reproducible `target/`/`node_modules` caches after build verification, or cross-volume archival when authorized), and always record pre/post `Get-PSDrive` free bytes.

---

### 8. Stealing Physical Mouse/Keyboard Focus During Desktop & Browser Automation
- **Provenance**: Codex `01a19808`, `01a1bb7b`, `01a1bce9` Prompts `#5`, `#23`; Antigravity `061ffa08`; Claude `6f2d773c`.
- **What Went Wrong**: Naive `pyautogui` / `SetCursorPos` / foreground-activation scripts yanked the user's cursor and popped windows over active work while the user was typing or studying.
- **Permanent Rule**:
  - Use headless CDP (`omnia-browser`) for web surfaces and `PrintWindow` / unfocused window messaging (`omnia-computer/src/bgwin.rs` + `native/qa-capture.ps1`) for Win32 surfaces. Never move the OS hardware cursor without explicit opt-in; use the **Omnia Virtual Cursor** overlay for visual feedback.

---

### 9. Accidental Source-Tree Mutations & GitHub Handle / Branch Mistakes
- **Provenance**: [CHECKPOINT.md](../workspace/CHECKPOINT.md) round 10 (`git sparse-checkout reapply` dirtied reference checkout); Codex `01a1bb7b` Prompt `#7` (`khang-macphuc11107` typo vs `khang-macphuc111107`); Codex `01a1bce9` Prompt `#96` vs `#114`.
- **What Went Wrong**:
  1. Running `git sparse-checkout` / `git status -u` side-effecting commands inside an external reference repo modified its worktree during an "inspection" step.
  2. A missing `1` in `khang-macphuc111107` caused push authentication confusion in an earlier project.
  3. Creating unsolicited `codex/*` branches instead of committing/staging cleanly on the user's requested branch created merge friction.
- **Permanent Rule**:
  1. Treat external repos and chat DBs as **strictly read-only** (`git --no-optional-locks` for status checks; `?mode=ro` for SQLite).
  2. Canonical GitHub target is `https://github.com/khang-macphuc111107/omnia` (four `1`s: `111107`). Never push or switch branches without verifying target branch policy.

---

### 10. Static Model Hardcoding, Regex Model-ID Bugs & Unhandled HTTP 429 Storms
- **Provenance**: Claude `9659b2b4` (regex blocked `gpt` models on proxy), `25b55b68` (L3630), `308b37b9`; Antigravity `.db` `step_type=17` (`154+` HTTP 429 `RESOURCE_EXHAUSTED` steps); Codex `01a1bce9` Prompts `#108`, `#122`.
- **What Went Wrong**: Hardcoding one provider/model or validating model names via rigid prefix regexes broke OpenAI-compatible proxy routing (`htmustc-proxy`) and caused entire agent swarms to stall when a single provider bucket hit rate limits while sibling providers/accounts had ample quota.
- **Permanent Rule**:
  - Route all LLM calls through `omnia-provider-services::routing` ([DYNAMIC_ROUTING_REQUIREMENTS.md](../workspace/DYNAMIC_ROUTING_REQUIREMENTS.md)) with data-driven model capability descriptors, per-account circuit breakers, atomic token reservation, and automatic cross-provider fallback before side-effect commit.

---

### 11. Collapsing Inline Paste & Attachment Tray into One Lossy Bucket
- **Provenance**: Codex `01a1bce9` Prompt `#97`; [COMPOSER_REQUIREMENTS.md](../workspace/COMPOSER_REQUIREMENTS.md).
- **What Went Wrong**: Standard chat UIs dump every pasted screenshot into a bottom attachment strip, stripping positional context when a user writes multi-step bug reports or math derivations (*"compare this formula [image 1] with the broken render below [image 2]"*). Conversely, forcing every pasted 50 MB `.zip` inline bloats the editor.
- **Permanent Rule**:
  - Preserve **dual-mode attachment semantics** (`inline-at-caret` ordered document node vs `attachment tray`) via the `Ctrl+V` chooser modal and spatial drag-and-drop zones, backed by a single content-addressed `payload_id` store so switching or referencing never duplicates bytes.

---

### 12. Plaintext Credentials, Session Cookies & Master Keys in Local Workspaces
- **Provenance**: Codex `01a1bce9` Prompt `#119` (plaintext social login shared for link crawling), `01a19c1a` (`ord=117`), `01a1bb7b` (`ord=432`); `Documents\ChatGPT\Gemini Notebook` (`canary_cookies*`, `chrome_master_key.bin`).
- **What Went Wrong**: During urgent scraping/ingestion tasks, plaintext passwords and exported Chromium cookie/DPAPI dumps appeared in chat prompts or sibling prototype folders. Any unredacted history export or naive directory copy would leak live personal credentials.
- **Permanent Rule**:
  1. **Zero Plaintext Persistence**: Omnia stores provider secrets exclusively in the OS Keyring via `SecretBroker` (`Zeroizing<String>` in RAM, `provider_secret_<uuid>` opaque references on disk).
  2. **Mandatory Redaction & Automated Verification**: Every history export, research artifact, and repo doc must pass deterministic credential/token/cookie/PII redaction and automated secret-scanner verification (`verify_zero_secrets.py` + `stage-public-release.mjs`) with **0** violations prior to handoff or `git push`.
