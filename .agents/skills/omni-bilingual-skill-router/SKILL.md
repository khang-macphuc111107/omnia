---
name: omni-bilingual-skill-router
description: Search and compose multi-skill execution DAGs across Vietnamese and English queries using fast BM25 ranking, pre-wired Omnia engineering pipelines, hot-cold vault mounting, and SHA-256 lockfile health checks without bloating active prompt context.
metadata:
  short-description: Bilingual VN-EN BM25 skill router, DAG composer, and lockfile doctor
---

# Omni Bilingual Skill Router & DAG Composer

Route natural-language Vietnamese or English engineering requests to the highest-signal installed skills and assemble a 4-stage execution DAG (`Preflight -> Domain Execution -> Verification Gate -> Receipt & Handoff`) in milliseconds without dumping hundreds of full `SKILL.md` bodies into startup context.

## Executable Helper (`scripts/skill_router.py`)

Run the bundled zero-dependency Python 3 router directly against live skill roots (`<workspace>/.agents/skills`, `~/.codex/skills`, `~/.codex/skills/.system`, `~/.agents/skills`):

```bash
# 1. Rank installed skills for a bilingual Vietnamese/English task & compose a 4-stage DAG
python scripts/skill_router.py route "thiết kế giao diện trình soạn thảo live Markdown LaTeX chống AI slop" -k 6

# 2. List pre-wired Omnia multi-skill pipelines (mapped to live installed skills)
python scripts/skill_router.py pipelines

# 3. Resolve a named Omnia pipeline into an actionable 4-stage DAG
python scripts/skill_router.py pipeline omnia-ui-surface

# 4. Run Merkle SHA-256 + frontmatter/body token-budget doctor across skill roots
python scripts/skill_router.py doctor
```

## 4-Stage Execution DAG Composition

Whenever multiple skills match a complex request, sequence them into four deterministic stages rather than invoking overlapping skills ad hoc:

1. **Stage 1 — Preflight, Intake & Context Guards**: `autonomous-power-continuity`, `additive-steer-queue`, `vietnamese-typo-intent-inference`, `omnia-session-governance-handoff`, `goal-plan-loop-dod`.
2. **Stage 2 — Core Domain & Bidirectional Peer-Mesh Execution**: Subsystem design, decision-grade proposals (`deep-proposal`), Graphify bidirectional graph navigation, and 2-way peer-mesh collaboration skills (for example, `deep-proposal`, `deep-general-graph-orchestration`, `deep-ui-direction`, `design-system`, `deep-rust-performance`, `rag-ingestion-and-retrieval`, `low-disruption-desktop-control`). Within Stage 2–3, peers may form bounded bidirectional feedback cycles (`author <-> verifier`, `sibling <-> sibling`) governed by `deep-general-graph-orchestration`.
3. **Stage 3 — Runtime Verification & Quantitative QA**: `omni-deterministic-verifiers`, `ui-quantitative-audit`, `verification-before-completion`, `security-state-machine-audit`.
4. **Stage 4 — Provenance Receipt & Continuous Learning**: `cross-artifact-ledger-binding`, `memory-skill-evolution`, `omnia-session-governance-handoff`.

## Hot / Cold Vault Discipline (When Scaling Beyond 250+ Skills)

- Keep workspace `.agents/skills/` focused on high-signal, project-relevant canonical skills so collaborators and CI remain fast and uncluttered.
- Store specialized or experimental large-catalog skills in global user roots (`~/.codex/skills` or a cold vault `.agents/vault/skills/`) and load only matched `SKILL.md` + `references/` files on demand.
- Keep individual `SKILL.md` frontmatter compact (`<= 110` tokens) and bodies `< 3,500` tokens by placing bulky schemas or domain matrices inside `references/`.
