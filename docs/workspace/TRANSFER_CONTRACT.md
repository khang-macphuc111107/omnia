# Omnia collaborator and next-session transfer contract

**Contract role:** Single navigable handoff checklist for collaborator **HTMusTC** and any incoming Omnia coding session (`SESSION-01`, `DOD-11`, `DOD-15`, `DOD-16`).

## 1. Mandatory onboarding sequence

1. Read [`../../README.md`](../../README.md) and [`../../AGENTS.md`](../../AGENTS.md) for build commands (`$env:CARGO_TARGET_DIR = 'D:\OmniaData\tools\cargo-target'` or sibling `..\OmniaData\tools\cargo-target` on a fresh clone), serialized Cargo execution, and external `native/qa-*.ps1` guards.
2. Read [`../handoff/COLLABORATOR_HANDOFF.md`](../handoff/COLLABORATOR_HANDOFF.md), [`../handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md`](../handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md), [`../handoff/LESSONS_LEARNED_AND_ANTIPATTERNS.md`](../handoff/LESSONS_LEARNED_AND_ANTIPATTERNS.md), and [`../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md`](../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md).
3. Inspect [`GOAL.md`](GOAL.md), [`DOD.md`](DOD.md), [`CHECKPOINT.md`](CHECKPOINT.md), and [`SESSION_ADMISSION.json`](SESSION_ADMISSION.json) before modifying product code or governance state.

## 2. Verified baseline vs open transfer boundaries

| Area | Verified in repository & external receipts | Transferred as open / partial (`openTransfer` in `SESSION_ADMISSION.json`) |
|---|---|---|
| **Rust workspaces & tests** | `cargo fmt --check` exit `0` + **`524/524` locked tests passing** (`omnia-provider-services` `31`, `omnia-harness` `393`, `omnia-session-store` `71`, `omnia-native` `29`) | Full end-to-end live provider streaming, WebView-free Browser/IDE runtime, and packaged release resource benchmarks |
| **Native Win32 shell & QA** | **`7/7` PowerShell QA workflows (`90/90` cases `rc=0`)** (`uiaIssue: null`, `#32770` `WH_CBT` background UIA invoke, `0` status-panel clipping at `1220x820`) | Physical keyboard/Vietnamese IME E2E matrix, Windows Narrator pass, multi-DPI resize stress, and live provider wire-up |
| **UI visual direction** | [`../ui-direction/DIRECTION_DECISION.md`](../ui-direction/DIRECTION_DECISION.md) + 3 offline interactive HTML/CSS/JS candidates (`24/24` WCAG 2.2 ratios `>= 5.78:1`, `0` AI-slop gradients) | **`PENDING_USER_REVIEW`** — user approval of Candidate A / B / C before full native visual restyling |
| **Skills & routing** | `12` byte-identical pure `LF` skills in [`../../.agents/skills/`](../../.agents/skills/) (`24/24` `quick_validate.py` `PASS`) + external `100`-category / `1,001`-skill catalog | Live Omnia runtime invocation receipts for newly added skills beyond unit/router discovery tests |
| **History & sync tooling** | [`../../tools/agy-history-sync/`](../../tools/agy-history-sync/) (`5/5` tests `OK`; AGY Desktop `144/144`, CLI `126/126`, unified `1,102` threads; `PASS_ZERO_LEAKS` across `294` files) | Incremental tail re-acquisition of the `18` active swarm conversations after session closure |
| **Source & `D:\` cleanup** | `138/138` focus rows reconciled (`84/84` unique delta artifacts hashed), `12` clutter dirs externalized, `4` worktrees repaired, **`+10.125 GiB` `D:\` reclaimed** | Excluded primary boundaries (`retirementEligible=false` in [`SOURCE_DISPOSITION_LEDGER.json`](SOURCE_DISPOSITION_LEDGER.json)) and elevated UAC move of `D:\Omnia\Roaming` (`WinError 5` orphaned SID) |
| **Delivery & follow-up session** | Local identity `khang-macphuc111107 <khang.macphuc111107@gmail.com>` ([`REMOTE_SETUP.md`](REMOTE_SETUP.md)); zero-secret & pure `LF` hygiene verified | Authenticated push to `https://github.com/khang-macphuc111107/omnia`, independent clean-clone build/test (`DELIVERY-01`), 3-round whole-goal audit (`DOD.md`), and `SESSION-01` activation ([`NEXT_SESSION_PROMPT.md`](NEXT_SESSION_PROMPT.md)) |
