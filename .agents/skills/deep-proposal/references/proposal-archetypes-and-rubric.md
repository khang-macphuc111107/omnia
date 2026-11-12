# Proposal Archetypes, Trade-Off Schemas & Verification Rubrics

## Archetype 1 — Engineering / Architecture / RFC Proposal (`PROPOSAL.md` / `RFC.md`)

### Canonical Section Structure
1. **Metadata Header**: `Proposal-ID`, `Title`, `Authors/Owners`, `Status` (`draft | under_review | repaired_ready_for_human_review | accepted | superseded | rejected`), `Target Subsystem`, `Review/Expiry Date`.
2. **Problem Statement & Measured Baseline**: Concrete failure mode, bottleneck, or missing capability backed by `file:line` references, profiling numbers, or incident receipts.
3. **Goals, Hard Constraints & Explicit Non-Goals**:
   - **Goals**: Measurable engineering outcomes.
   - **Hard Constraints**: OS/platform bounds, SPDX license rules (for example, permissive-only `MIT`/`Apache-2.0`, zero `GPL`/`AGPL`/`BUSL` contamination), memory/latency ceilings, security/privacy invariants.
   - **Non-Goals**: Adjacent problems intentionally excluded from this slice.
4. **Multi-Candidate Trade-Off Matrix (`Candidate A / B / C` + `Status Quo`)**:

| Criterion | Status Quo | Candidate A | Candidate B | Candidate C |
| :--- | :--- | :--- | :--- | :--- |
| **Core Mechanism** | ... | ... | ... | ... |
| **Correctness & Edge Cases** | ... | ... | ... | ... |
| **Latency / Memory / Binary Impact** | ... | ... | ... | ... |
| **Security, Privacy & License Risk** | ... | ... | ... | ... |
| **Migration & Operational Cost** | ... | ... | ... | ... |
| **Reversibility / Rollback Path** | ... | ... | ... | ... |
| **Disposition & Rejection Rationale** | Rejected / Baseline | **Selected** (why) | Rejected (exact reason) | Rejected (exact reason) |

5. **Detailed Design, Interfaces & Failure Modes**: Exact data structures, state transitions, concurrency/fencing rules, error recovery, and backwards compatibility.
6. **Rollout Plan, Rollback Triggers & Quantitative DoD**: Exact test suites, benchmarks, feature flags, and measurable conditions requiring immediate rollback.

---

## Archetype 2 — Academic / Thesis / Research Grant Proposal (`RESEARCH_PROPOSAL.md`)

Supports undergraduate capstones (`đề cương khóa luận tốt nghiệp`), master's/doctoral theses (`đề cương luận văn ThS / luận án TS`), student research (`NCKH`), and funded grant submissions.

### Canonical Section Structure
1. **Title, Problem Motivation & Scope**: Precise research phenomenon, practical/theoretical significance, and bounded study scope.
2. **Literature Review & Gap Matrix (Zero Fabricated Citations)**:
   - Every cited paper, repository, or standard must carry verified provenance (`author/year`, `venue/URL`, `inspected vs abstract-only`). Never invent DOIs, BibTeX entries, or benchmark scores.
   - Map `Approach Family -> Representative Works -> Strengths -> Specific Failure/Gap -> Proposed Contribution`.
3. **Research Questions (`RQ1..RQn`) & Falsifiable Hypotheses (`H1..Hn`)**:
   - Each `H_i` must state an observable directional effect AND what empirical result would **refute** `H_i` (null/negative outcome handling).
4. **Proposed Methodology & Formal Architecture**: Mathematical formulation, algorithmic pipeline, system invariants, and complexity bounds.
5. **Experimental Design & Evaluation Protocol**:
   - Datasets/corpora (size, splits, data-leakage/decontamination checks, licensing).
   - Baselines (strong modern baselines, not weak strawmen) + **Ablation Study Matrix** isolating each proposed component.
   - Primary/secondary metrics, statistical significance / confidence intervals, hardware/compute budget, and reproducibility artifacts.
6. **Threats to Validity & Ethics**:
   - `Internal` (confounders, implementation bugs, train-test leakage), `External` (generalization across domains/languages), `Construct` (metric-objective mismatch), `Conclusion` (sample size, variance).
7. **Milestone Timeline & Deliverable Checkpoints**: Week/month WBS with concrete go/no-go decision gates if a hypothesis fails early.

---

## Archetype 3 — Product / Spec-Kit / Feature Proposal (`PRODUCT_PROPOSAL.md`)

Aligned with closed-loop Specification-Driven Development (`/constitution -> /specify -> /clarify -> /plan -> /checklist -> /tasks -> /analyze -> /implement -> /converge`):

### Canonical Section Structure
1. **Constitution & Scope Guard**:
   - Verify alignment with project principles (`GOAL.md`, `DOD.md`). While in `/constitution`, `/specify`, `/clarify`, or `/plan` mode, **never** mutate application code; log implementation follow-ups under `Next Actions`.
2. **User Problem, Personas & Job-to-Be-Done**: Current user friction, frequency, and why existing workarounds fail.
3. **Clarification & Ambiguity Ledger**: Surface underspecified edge cases (concurrent edits, offline state, empty/error states, large inputs, IME/bilingual input) and resolve or explicitly bound them.
4. **System, UX & Accessibility Invariants**:
   - Anti-AI-slop visual hierarchy, WCAG 2.1 AA contrast (`>= 4.5:1` text, `>= 3.0:1` UI chrome), keyboard + native Accessibility/UIA tree semantics, latency budgets, and zero-secret telemetry.
5. **Requirement Quality Checklist ("Unit Tests for Requirements")**:
   - Audit completeness, unambiguous wording, and measurable acceptance criteria (`Given / When / Then`) before decomposing `/tasks`.
6. **Post-Implementation `/converge` Gate**: Define how the live build will be audited against `PRODUCT_PROPOSAL.md` to surface unmet clauses before closure.

---

## Archetype 4 — Client / Solution / RFP Proposal (`RFP_PROPOSAL_PACKAGE.md`)

### Canonical Section Structure
1. **Executive Summary & Value Proposition**: Concise synthesis of client objectives, proposed architecture, delivery timeline, and bounded commercial outcomes.
2. **Clause-by-Clause Requirement Compliance Matrix**:

| RFP Clause ID | Requirement Summary | Priority | Compliance Status | Evidence / Architecture Section / Mitigation |
| :--- | :--- | :--- | :--- | :--- |
| `RFP-1.1` | ... | Mandatory | `Compliant` / `Partial-with-Mitigation` / `Out-of-Scope` | ... |

3. **Solution Architecture, Security & Integration Boundaries**: Deployment topology, auth/RBAC, data residency, PII redaction, and Statement-of-Work (`SOW`) boundary guards.
4. **Quantified ROI, TCO & Performance Bounds**:
   - Explicit cost model (infra, token/API burn, operations) with conservative/base/peak assumptions and p95 latency/throughput bounds.
5. **WBS Delivery Schedule, Acceptance Milestones & Risk Register**: Phased deliverables, client dependencies, SLA commitments, and contingency plans.

---

## Universal Proposal Quality Gate (Pre-Handoff Checklist)

- [ ] **Zero Conflated States**: Proposal review readiness (`repaired_ready_for_human_review`) is never reported as implemented or runtime-verified product code.
- [ ] **Zero Strawman Options**: Rejected candidates represent realistic engineering/research alternatives with honest pros, cons, and reversal conditions.
- [ ] **Zero Fabricated Evidence**: Every baseline metric, citation, repo SHA, license tag, and cost/latency figure is either verified or labeled `[ASSUMPTION — requires benchmark]`.
- [ ] **Zero Slop & Zero Leaks**: Pure UTF-8 `LF`, zero placeholder `[TODO:...]` markers, zero private credentials/tokens/personal paths.
