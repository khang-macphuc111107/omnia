---
name: omni-bilingual-skill-router
description: Use when routing Vietnamese or English tasks to active or cold-vault Omnia skills, composing 4-stage DAGs, picking Omnia v5 pipelines, checking Merkle locks, or running the 16-case golden eval.
metadata:
  short-description: Bilingual VN-EN BM25 skill router, 24 DAG pipelines & golden eval
---

# Omni Bilingual Skill Router & DAG Composer

Route natural-language Vietnamese or English requests to the highest-signal installed and cold-vault skills and assemble a 4-stage execution DAG (`Preflight -> Domain Execution -> Verification Gate -> Receipt & Handoff`) in milliseconds while keeping active startup frontmatter `< 1,000` tokens.

## Executable Helper (`scripts/skill_router.py`)

Run the zero-dependency Python 3 router (`python -B`) against live skill roots (`<workspace>/.agents/skills`, `~/.codex/skills`, `~/.codex/skills/.system`, `~/.agents/skills`) and optional external cold-vault catalog (`omni-deep-1000-catalog.json`):

```bash
# 1. Rank installed skills for a bilingual Vietnamese/English query & compose a 4-stage DAG
python -B scripts/skill_router.py route "nghiên cứu sâu web search RAG trích dẫn nguồn và lập kế hoạch DoD" -k 6

# 2. Search across both active skills and external 1,001-skill Cold Vault catalog (0 startup bloat)
python -B scripts/skill_router.py route "tối ưu tải file HTTP range 128 luồng" --vault "D:\OmniaData\research\omnia-clean-2026-11-12\omni-deep-1000-catalog.json"

# 3. List all 24 pre-wired Omnia v5 multi-skill pipelines
python -B scripts/skill_router.py pipelines

# 4. Resolve a named pipeline into a 4-stage execution DAG
python -B scripts/skill_router.py pipeline omnia-deep-research
python -B scripts/skill_router.py pipeline omnia-rust-flagship-studio

# 5. Run Merkle SHA-256 + frontmatter (<= 110 tok) / body (<= 3,500 tok) health doctor
python -B scripts/skill_router.py doctor

# 6. Run the 16-case Bilingual Golden Routing Benchmark (>= 95% Top-5 Recall gate)
python -B scripts/skill_router.py golden-eval
```

## 4-Stage Execution DAG Composition

Sequence matched skills into four deterministic stages rather than invoking overlapping skills ad hoc:
1. **Stage 1 — Preflight, Intake & Lifecycle Framing**: `autonomous-power-continuity`, `additive-steer-queue`, `vietnamese-typo-intent-inference`, `omnia-session-governance-handoff`, `goal-plan-loop-dod`, `super-plan-run-lifecycle`.
2. **Stage 2 — Core Domain, Research, Reasoning & Bidirectional Peer-Mesh Execution**: `deep-research`, `deep-think`, `deep-proposal`, `deep-general-graph-orchestration`, `deep-clean`, `deep-steer`, `deep-cpp-native` (historical/general C++ diagnostics), and `kdense-*` scientific research projections. Within Stage 2–3, peers may form bounded duplex cycles (`A <-> B`) with strict `disjoint_paths`.
3. **Stage 3 — Deterministic Runtime Verification & Quantitative QA**: `omni-deterministic-verifiers`, `codex-mcp-namespace-diagnostics`, plus native `verify_artifact` / `audit.py --secret-scope all --strict`.
4. **Stage 4 — Provenance Receipt, Handoff & Continuous `/learn`**: `omnia-session-governance-handoff`, `super-plan-run-lifecycle` (6-state receipt, 2-Tier Lessons, Semantic Overlap Audit, Gap Radar Evolver, 3-way skill sync).

## Hot / Cold Vault Discipline (Zero Startup Bloat)

- Keep workspace `.agents/skills/` lean (`22` canonical skills: `16` curated + `6` `kdense-*`) so startup context stays low and CI stays fast.
- Query specialized `100`-category / `1,001`-skill blueprints on demand from the external Cold Vault (`D:\OmniaData\research\omnia-clean-2026-11-12\omni-deep-1000-catalog.json`) without dumping synthetic stub folders into the repository.
- Enforce compact frontmatter (`<= 110` tokens) and bodies (`<= 3,500` tokens), putting bulky schemas or domain matrices in `references/`.
