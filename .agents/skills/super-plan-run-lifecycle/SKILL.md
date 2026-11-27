---
name: super-plan-run-lifecycle
description: Use when starting, orchestrating, verifying, or handing off complex multi-step engineering work in Omnia requiring proactive cross-linked Goal, Spec, Blueprint, Plan, Todo, Progress, receipt-gated DoD, Checkpoint, Handoff, Memory, 2-Tier Lessons, Learn, and Skill evolution.
metadata:
  short-description: Proactive 12-artifact Lifecycle OS, Learn, Lessons & Skills
---

# Super Plan, Run & 12-Artifact Workspace Lifecycle OS

Maintain a single-source-of-truth, bidirectionally cross-linked engineering lifecycle persisted in SQLite WAL (`omnia-harness::artifact_os`) and atomic UTF-8 LF workspace files (`omnia lifecycle` / Studio `MissionLifecycleView` / agent `workspace_lifecycle` & `skill_codify` tools).

## 1. Zero-Overlap 12-Artifact Document Hierarchy

Keep every fact in its canonical owner and cross-link artifacts via typed bidirectional edges (`satisfies`, `blocks`, `derived_from`, `supersedes`, `learned_from`, `cites`) and `[[wiki]]` links:
1. **`Goal` (`GOAL.md`)**: Objective, constraints, non-goals, stable requirement IDs, `token_budget = NULL`, `ADDITIVE_INTAKE` SteerQueue preservation.
2. **`Spec` (`SPEC.md`)**: Crisp scoped contract (`< 150` lines) with numbered testable Acceptance Criteria (`AC-1..N`), edge cases, and non-goals (*What*).
3. **`Blueprint` (`BLUEPRINT.md`)**: Macro architecture, module boundaries, data flows, ADRs, security/KV-cache invariants (*Why*).
4. **`Plan` (`PLAN.md`)**: Link to `Spec`, `Global Constraints`, `Review Focus` (top 5 edge/failure modes pinned to tests), and ordered phases with per-task `Files` + `Consumes/Produces` interfaces.
5. **`Todo` / `Tasks` (`TASKS.md`)**: Live execution DAG checklist (`todo | in_progress | done | blocked | skipped`) updated at every phase transition.
6. **`Progress` (`STATUS.md`)**: Live completion counts, active wave/strike watermark (`.agents/super/state.json`), and navigable index.
7. **`DoD` (`DOD.md`)**: Falsifiable Definition of Done gates — **strictly receipt-gated**: never flip a gate to `Verified` without a fresh machine `ExecutionReceipt` from the current snapshot.
8. **`Checkpoint` (`CHECKPOINT.md`)**: Exact commit SHA, tree hash, staged binary SHA-256s, test receipts, and next executable action.
9. **`Handoff` (`HANDOFF.md` + `.agents/memory/handoff-state.json`)**: Forensic 6-state continuation receipt (`Verified | Partial | Unresolved | Blocked | Next | Exact Practical Limits`) preserving manual notes between `<!-- AGENT_NOTES_START -->` and `<!-- AGENT_NOTES_END -->`.
10. **`Memory` (`MemoryGraph` WAL)**: Bi-temporal Hindsight (`WorldFact`, `Experience`, `Observation`, `MentalModel`), OWASP ASI06 provenance trust/quarantine, and cryptographic `ErasureReceipt`.
11. **`Lessons` & `Learn` (2-Tier)**: Project `.agents/memory/lessons.md` + `lessons.jsonl` (auto-hydrated into Turn-1 `<workspace_context>` without mutating Prefix-0!) and Global `D:\OmniaData\memory\global_lessons.md` for cross-project invariants.
12. **`Skills` (`.agents/skills/` + Cold Vault)**: Lean startup core (`<= 1,000` tok frontmatter) + on-demand BM25/fuzzy Cold Vault lookup (`omni-deep-1000-catalog.json`) + `SKILL_LOCK.json` Merkle attestation.

## 2. Proactive Lifecycle & Anti-Bloat Rules

- **Hydrate Before Acting**: On session start, read `HANDOFF.md`, `.agents/memory/lessons.md`, `GOAL.md`, `SPEC.md`, `PLAN.md`, `TASKS.md`, `DOD.md`, and `.agents/super/state.json` into Turn-1 `<workspace_context>` (keeping Tier-0 `BASE_SYSTEM_PROMPT` 100% static for BLAKE3 KV-cache invariance).
- **Additive Steer Continuity**: Queue mid-run steers (`ADDITIVE_INTAKE`), keep `token_budget = NULL`, finish the interrupted deliverable, reconcile conflicts, and resume remaining backlog items.
- **Deterministic Phase-3 Verification (`verify_artifact`)**: Verify UTF-8/LF/no-BOM/control-bytes/SHA-256, secret redaction, WCAG contrast, `< 5,000`-token ceilings, and citation integrity programmatically — never self-certify in prose.
- **Anti-Bloat Auto-Handoff**: Whenever context approaches `~140k` tokens or before compaction/pause, write `HANDOFF.md` (preserving `<!-- AGENT_NOTES_START -->...<!-- AGENT_NOTES_END -->`), update `handoff-state.json`, and persist new lessons.

## 3. Continuous `/learn` & Atomic Skill Codification (`skill_codify`)

When authorized work uncovers a verified reusable pitfall, architecture invariant, or recurring gap (detected by `Gap Radar Evolver`):
1. **Capture Lesson**: Record root cause, verified fix, and provenance locator via `POST /api/v5/learn/capture` (`Lessons` Tier-1 project or Tier-2 global).
2. **Semantic Overlap Deduplication**: Run `Semantic Overlap Audit` against all installed skills before creating any new folder; prefer upgrading an existing atomic skill over creating duplicates.
3. **Skill Quality Gate**: Every codified skill MUST have:
   - Hyphen-case `name:` matching directory slug (`<= 64` chars).
   - `description:` starting with `"Use when..."` (triggers only, `<= 1,024` chars, zero `<` or `>` angle brackets).
   - Compact frontmatter (`<= 110` tok) and body (`<= 3,500` tok), explicit `agents/openai.yaml` (`short_description` `25..64` chars, `default_prompt` citing `$<slug>`), and pure UTF-8 LF without BOM.
4. **Cross-Host Parity & Lock Verification**: Sync identically across `.agents/skills/`, `~/.codex/skills/`, and `~/.agents/skills/`, update `SKILL_LOCK.json` / `GEMINI.md`, and verify `0` drift via `validate_skills.py --strict-all-skills` and `audit.py --secret-scope all --strict`.
