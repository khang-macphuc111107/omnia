---
name: deep-proposal
description: Author, critique, and verify rigorous Engineering/RFC, Academic/Thesis/Grant, Product/Spec-Kit, and Client/RFP proposals with baseline evidence, explicit non-goals, multi-option trade-off matrices, rejection rationale, falsifiable hypotheses, compliance ledgers, rollback gates, and honest review states.
metadata:
  short-description: Evidence-backed Engineering RFC, Thesis/Grant, Spec-Kit, and RFP proposals
---

# Deep Proposal Synthesis & Adversarial Critique

Author decision-grade, anti-slop proposals across engineering architecture, academic research/theses, product specifications, and enterprise RFPs. Every claim, baseline metric, citation, cost/latency bound, and acceptance criterion must trace to verifiable evidence or be explicitly labeled as an assumption to test.

For detailed section templates, comparison tables, and scoring rubrics across all four archetypes, read [references/proposal-archetypes-and-rubric.md](references/proposal-archetypes-and-rubric.md).

## 1. Classify the Proposal Archetype & Canonical Artifact

Select the exact archetype (or explicit hybrid) before drafting, and enforce a **Scope Guard** separating *proposal authoring/review* from *production code mutation*:

1. **Engineering / Architecture / RFC Proposal (`PROPOSAL.md` / `RFC.md`)**:
   - **Required Core**: Problem framing with measured baseline (`p50/p95`, memory, failure rate, maintenance friction), hard constraints, **explicit Non-Goals**, **`Candidate A / B / C` (+ `Status Quo / Do Nothing`) trade-off matrix** with explicit **rejection rationale** for non-chosen options, phased migration & **rollback/reversal triggers**, and quantitative **DoD & runtime verification gates**.
2. **Academic / Thesis / Research Grant Proposal (`RESEARCH_PROPOSAL.md` — BSc/MSc/PhD `đề cương luận văn / khóa luận / NCKH` & grants)**:
   - **Required Core**: Grounded **literature gap matrix** (`Prior Work -> Verified Mechanism -> Specific Limitation -> Proposed Delta`, **zero** fabricated citations/DOIs), **falsifiable hypotheses & Research Questions (`RQ1..RQn`)**, formal **methodology, dataset/corpus provenance & evaluation protocol** (baselines, ablations, metrics, statistical significance, reproducibility/compute budget), **threats to validity** (`internal`, `external`, `construct`, `conclusion`) + ethics/privacy guardrails, and milestone schedule with concrete artifacts.
3. **Product / Spec-Kit / Feature Proposal (`PRODUCT_PROPOSAL.md`)**:
   - **Required Core**: User problem & workflow friction, **Constitution / Scope Guard** aligned with closed-loop Specification-Driven Development (`/constitution -> /specify -> /clarify -> /plan -> /checklist -> /tasks -> /analyze -> /implement -> /converge`), **system & UX/accessibility invariants** (WCAG contrast, keyboard/UIA operability, offline/privacy boundaries, anti-AI-slop posture), and **testable acceptance criteria + privacy-safe telemetry**. Treat requirement checklists as *"unit tests for specification clarity"*, never as proof that code is implemented.
4. **Client / Solution / RFP Proposal (`RFP_PROPOSAL_PACKAGE.md`)**:
   - **Required Core**: Executive business alignment, **clause-by-clause Requirement Compliance Matrix** (`Compliant`, `Partial-with-Mitigation`, `Alternative-Proposed`, `Out-of-Scope`), **quantified ROI & bounded cost/latency/capacity envelopes** (explicit formulas and sensitivity ranges, zero ungrounded marketing multiples), **Work Breakdown Structure (WBS) delivery phases** with acceptance gates, and **SLA, security/licensing posture & risk mitigation register**.

## 2. Mandatory Execution Workflow

1. **Preflight & Context Hydration**:
   - Inspect authoritative repository docs (`GOAL.md`, `DOD.md`, `DECISIONS.md`), codebase constraints, RFP/rubric clauses, or verified literature ledgers first. Separate `observed` facts, `verified` measurements, `inferred` estimates, and `unknowns`.
2. **Premise Stress-Test & Non-Goal Lock**:
   - Challenge flawed premises early (for example, solving a workflow bottleneck with an unnecessary microservice or copyleft dependency). Lock explicit **Out-of-Scope / Non-Goals** to prevent scope creep.
3. **Genuine Multi-Candidate Trade-Off Analysis**:
   - Compare at least **3 materially distinct options** (including `Candidate A`, `Candidate B`, `Candidate C` or `Status Quo`) across correctness, security/licensing, latency/memory, operational complexity, cost, and reversibility. Never use strawman alternatives; state exact conditions under which a rejected candidate would become preferable.
4. **Adversarial Self-Audit & Anti-Slop Pass**:
   - Strip vague filler ("seamless", "revolutionary", "world-class"), unquantified speedups, missing failure modes, unverified citations, and conflated lifecycle claims.
5. **Honest Proposal Lifecycle Receipt**:
   - Tag status strictly as `draft`, `under_review`, `repaired_ready_for_human_review`, `accepted`, `superseded`, or `rejected`. Approving or repairing a proposal **never** claims runtime implementation or benchmark completion.
