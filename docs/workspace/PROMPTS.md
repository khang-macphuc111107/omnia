# Omnia prompt and requirement traceability index

**Index role:** Navigable index connecting user prompt transcripts, mid-run additive steers (`Steer #1..#15`), subsystem requirement specifications, and the prepared next-session launch prompt.

## Authoritative prompt & requirement artifacts

1. **Multi-host user prompt requirements matrix (`HISTORY-02`, `HISTORY-03`, `DOD-10`)**:
   - [`../handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md`](../handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md)
   - Maps all **124 user prompts** from flagship Codex session `01a1bce9-bcd9-75f3-b63a-28b855d6978f` (`7,559` thread items across `87` turns), cross-project user sessions (`htmustc proxy`, `gemini notebook`, `gg drive downloader`, `idm`, `omnia`), and all **15 Antigravity additive steers** (`Steer #1`..`Steer #15`, spanning Wave 4 C++20/Flagship UI/`C:`-`D:` deep-clean and Wave 5 **Full Native Rust** 17-crate Cargo workspace + Omnia v5 Harness, OMP+Trae Studio & Frontier Benchmarks) to concrete `PRODUCT-*`, `ROOT-*`, `DRIVE-*`, `HISTORY-*`, `RESEARCH-*`, and `DOD-*` IDs with exact ordinal/file/SHA-256 locators.
2. **Additive steer intake ledger**:
   - [`STEER_QUEUE.md`](STEER_QUEUE.md) — records every mid-run steer item (including historical `Steer #9` C++20 replacement + tag `archive/pre-cpp-rust-snapshot-20261112`, `Steer #13`, `Steer #14`, and **Steer #15** **Omnia v5** 17-crate Rust workspace with Wave 4 C++20 external backup `D:\OmniaData\backups\pre-full-rust-20261115\`), non-cancellation invariants (`token_budget IS NULL`), and reconciliation status.
3. **Prepared follow-up session launch prompt (`SESSION-01`, `DOD-16`)**:
   - [`NEXT_SESSION_PROMPT.md`](NEXT_SESSION_PROMPT.md) (`sha256=d277af284a6e2d87...`) — carries the `SESSION-G07` open-transfer contract. [`SESSION_ADMISSION.json`](SESSION_ADMISSION.json) remains `"DEFERRED"` on the current Full Native Rust branch until unified workspace Cargo build/clippy/test, `7/7` `pwsh` Win32 QA, live `/browser` CDP QA, strict audit, and 3 consecutive frozen-snapshot cleanroom audits pass; once satisfied and `READY`, creating the follow-up chat and recording its `threadId` + persistent-goal activation readback advances admission to `LAUNCHED`.
4. **Prompt-derived subsystem & UI specifications**:
   - Rich Word-grade composer, live Markdown/LaTeX, Math/Phys/Chem palettes & inline-at-caret vs tray attachments: [`COMPOSER_REQUIREMENTS.md`](COMPOSER_REQUIREMENTS.md)
   - Deterministic capability/quota/cost/latency/circuit-breaker routing: [`DYNAMIC_ROUTING_REQUIREMENTS.md`](DYNAMIC_ROUTING_REQUIREMENTS.md)
   - Flagship Studio UI ("Obsidian Kinetic Atelier") specification & prior three-candidate evaluation: [`../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md`](../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md) & [`../ui-direction/DIRECTION_DECISION.md`](../ui-direction/DIRECTION_DECISION.md)
   - Bidirectional 2-way `PeerMeshGraph` (`A <-> B`) & `GraphifyIndex` forward/reverse provenance: [`../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md`](../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md)
   - Historical Windows C++20 / Win32 / COM UIA skill (preserved for general/historical Wave 4 backup diagnostics): [`../../.agents/skills/deep-cpp-native/SKILL.md`](../../.agents/skills/deep-cpp-native/SKILL.md)
   - Bilingual Vietnamese/English typo & developer chat-shorthand intent inference: [`../../.agents/skills/vietnamese-typo-intent-inference/SKILL.md`](../../.agents/skills/vietnamese-typo-intent-inference/SKILL.md)

## Privacy and redaction boundary

Raw private prompt/session exports stay strictly outside Git under `D:\OmniaData\exports\history\` (`WATERMARK_AND_DENOMINATORS.json` + `SECRET_SCAN_VERIFICATION.json` `sha256=a01b88f6...`, `leak_count=0` across `294` files). Only audited, secret-free syntheses live in [`../handoff/`](../handoff/).
