# Omnia prompt and requirement traceability index

**Index role:** Navigable index connecting user prompt transcripts, mid-run additive steers, subsystem requirement specifications, and the prepared next-session launch prompt.

## Authoritative prompt & requirement artifacts

1. **Multi-host user prompt requirements matrix (`HISTORY-02`, `HISTORY-03`, `DOD-10`)**:
   - [`../handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md`](../handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md)
   - Maps all **124 user prompts** from flagship Codex session `01a1bce9-bcd9-75f3-b63a-28b855d6978f` (`7,559` thread items across `87` turns), cross-project user sessions (`htmustc proxy`, `gemini notebook`, `gg drive downloader`, `idm`, `omnia`), and all **8 Antigravity additive steers** (`Steer #1`..`Steer #8`, including `REQ-AGENT-01`, `REQ-STEER-06`, `REQ-STEER-07`, `REQ-AGY-WIN-SKILLS`, `REQ-AUTH-BOUNDARY`) to concrete `PRODUCT-*`, `ROOT-*`, `HISTORY-*`, `RESEARCH-*`, and `DOD-*` IDs with exact ordinal/file/SHA-256 locators.
2. **Additive steer intake ledger**:
   - [`STEER_QUEUE.md`](STEER_QUEUE.md) — records every mid-run steer item, non-cancellation invariants (`token_budget IS NULL`), and reconciliation status.
3. **Prepared follow-up session launch prompt (`SESSION-01`, `DOD-16`)**:
   - [`NEXT_SESSION_PROMPT.md`](NEXT_SESSION_PROMPT.md) — carries the `SESSION-G07` open-transfer contract. Launch remains `DEFERRED` until all seven gates in [`SESSION_ADMISSION.json`](SESSION_ADMISSION.json) reach `READY`.
4. **Prompt-derived subsystem specifications**:
   - Rich Word-grade composer, live Markdown/LaTeX, Math/Phys/Chem palettes & inline-at-caret vs tray attachments: [`COMPOSER_REQUIREMENTS.md`](COMPOSER_REQUIREMENTS.md)
   - Deterministic capability/quota/cost/latency/circuit-breaker routing: [`DYNAMIC_ROUTING_REQUIREMENTS.md`](DYNAMIC_ROUTING_REQUIREMENTS.md)
   - Three-candidate anti-AI-slop visual direction (`PENDING_USER_REVIEW`): [`../ui-direction/DIRECTION_DECISION.md`](../ui-direction/DIRECTION_DECISION.md)
   - Bidirectional 2-way `PeerMeshGraph` (`A <-> B`) & `Graphify` forward/reverse provenance: [`../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md`](../handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md)
   - Bilingual Vietnamese/English typo & developer chat-shorthand intent inference (`ko`, `dc`, `cx`, `ms`, `nhx`, `trg`, `htai`, `dko`, `vde`, `nckh`, `bth`, `vs`, `r`, `th`, `lun`, `nx`, VNI/Telex/QWERTY slips): [`../../.agents/skills/vietnamese-typo-intent-inference/SKILL.md`](../../.agents/skills/vietnamese-typo-intent-inference/SKILL.md)

## Privacy and redaction boundary

Raw private prompt/session exports stay strictly outside Git under `D:\OmniaData\exports\history\` (`WATERMARK_AND_DENOMINATORS.json` + `SECRET_SCAN_VERIFICATION.json`, `leak_count=0` across `294` files). Only audited, secret-free syntheses live in [`../handoff/`](../handoff/).
