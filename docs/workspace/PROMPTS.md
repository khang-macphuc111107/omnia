# Omnia prompt and requirement traceability index

**Index role:** Navigable index connecting user prompt transcripts, mid-run additive steers (`Steer #1..#12`), subsystem requirement specifications, and the prepared next-session launch prompt.

## Authoritative prompt & requirement artifacts

1. **Multi-host user prompt requirements matrix (`HISTORY-02`, `HISTORY-03`, `DOD-10`)**:
   - [`../handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md`](../handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md) (`sha256=0c29f1d9...`)
   - Maps all **124 user prompts** from flagship Codex session `01a1bce9-bcd9-75f3-b63a-28b855d6978f` (`7,559` thread items across `87` turns), cross-project user sessions (`htmustc proxy`, `gemini notebook`, `gg drive downloader`, `idm`, `omnia`), and all **12 Antigravity additive steers** (`Steer #1`..`Steer #12`, including Wave 4 `REQ-CPP20-MIGRATION`, `REQ-FLAGSHIP-UI`, `REQ-DDRIVE-DEEP-CLEAN`, `REQ-CDRIVE-DEEP-CLEAN`, `REQ-AUTH-BOUNDARY`) to concrete `PRODUCT-*`, `ROOT-*`, `DRIVE-*`, `HISTORY-*`, `RESEARCH-*`, and `DOD-*` IDs with exact ordinal/file/SHA-256 locators.
2. **Additive steer intake ledger**:
   - [`STEER_QUEUE.md`](STEER_QUEUE.md) — records every mid-run steer item (including explicit user architectural replacement `Steer #9` archiving Rust on tag `archive/pre-cpp-rust-snapshot-20261112`), non-cancellation invariants (`token_budget IS NULL`), and reconciliation status.
3. **Prepared follow-up session launch prompt (`SESSION-01`, `DOD-16`)**:
   - [`NEXT_SESSION_PROMPT.md`](NEXT_SESSION_PROMPT.md) (`sha256=ef94c52e0c68763a...`) — carries the `SESSION-G07` open-transfer contract. [`SESSION_ADMISSION.json`](SESSION_ADMISSION.json) remains `"READY"` (`SESSION-G01..G07` satisfied); creating the follow-up chat and recording its `threadId` + persistent-goal activation readback advances admission to `LAUNCHED`.
4. **Prompt-derived subsystem & UI specifications**:
   - Rich Word-grade composer, live Markdown/LaTeX, Math/Phys/Chem palettes & inline-at-caret vs tray attachments: [`COMPOSER_REQUIREMENTS.md`](COMPOSER_REQUIREMENTS.md)
   - Deterministic capability/quota/cost/latency/circuit-breaker routing: [`DYNAMIC_ROUTING_REQUIREMENTS.md`](DYNAMIC_ROUTING_REQUIREMENTS.md)
   - Flagship Studio UI ("Obsidian Kinetic Atelier") specification & prior three-candidate evaluation: [`../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md`](../ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md) & [`../ui-direction/DIRECTION_DECISION.md`](../ui-direction/DIRECTION_DECISION.md)
   - Bidirectional 2-way `PeerMeshGraph` (`A <-> B`) & `GraphifyIndex` forward/reverse provenance: [`../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md`](../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md)
   - Modern C++20 / Win32 / COM UIA / CMake engineering workflow: [`../../.agents/skills/deep-cpp-native/SKILL.md`](../../.agents/skills/deep-cpp-native/SKILL.md)
   - Bilingual Vietnamese/English typo & developer chat-shorthand intent inference: [`../../.agents/skills/vietnamese-typo-intent-inference/SKILL.md`](../../.agents/skills/vietnamese-typo-intent-inference/SKILL.md)

## Privacy and redaction boundary

Raw private prompt/session exports stay strictly outside Git under `D:\OmniaData\exports\history\` (`WATERMARK_AND_DENOMINATORS.json` + `SECRET_SCAN_VERIFICATION.json` `sha256=a01b88f6...`, `leak_count=0` across `294` files). Only audited, secret-free syntheses live in [`../handoff/`](../handoff/).
