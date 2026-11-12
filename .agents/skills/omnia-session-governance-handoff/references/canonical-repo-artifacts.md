# Canonical 7-Layer Artifact Taxonomy for Autonomous Engineering Repositories

Distilled from *Khởi động và Quy trình Omnia*, each artifact class serves one distinct governance or runtime purpose without polluting the repository root:

## 1. Agent Orchestration, Session Admission & Handoff
- `AGENTS.md` / `GEMINI.md`: Role boundaries, disjoint ownership rules, build/QA commands, and mandatory skill routing.
- `docs/workspace/SESSION_ADMISSION.json`: Prerequisite gate for session startup/closure (`DEFERRED` vs `ADMITTED`, commit SHA, dirty-tree check, external receipts).
- `docs/handoff/COLLABORATOR_HANDOFF.md`: Repo-safe, zero-secret architecture and roadmap transfer contract for human collaborators (`HTMusTC`) and resuming agents.
- `docs/handoff/USER_PROMPT_REQUIREMENTS_MATRIX.md` & `LESSONS_LEARNED_AND_ANTIPATTERNS.md`: Traceable requirement-to-evidence matrix and historical failure guardrails.

## 2. Goal, DoD & Execution State Tracking
- `docs/workspace/GOAL.md`: Master mission, scope boundaries, non-goals, and parent/leaf requirement IDs (`token_budget` kept `NULL`/unlimited unless user-mandated).
- `docs/workspace/DOD.md`: Quantitative acceptance gates (`DOD-01`..`DOD-16`) requiring matching implementation, behavior, tests, and receipts.
- `docs/workspace/CHECKPOINT.md`: Snapshot-bound progress ledger recording verified vs open items and exact artifact locators.
- `docs/workspace/DECISIONS.md`: Architectural Decision Records (ADRs), trade-offs, and supersession history.

## 3. Architecture, UI Direction & Subsystem Specs
- `docs/workspace/COMPOSER_REQUIREMENTS.md`: Caret-accurate rich composer, Markdown/LaTeX/symbol palette, and inline-vs-tray attachment contract.
- `docs/workspace/DYNAMIC_ROUTING_REQUIREMENTS.md`: Deterministic provider/model router, atomic quota reservation, circuit breaker, and secret-free route receipts.
- `docs/ui-direction/DIRECTION_DECISION.md`: Multi-candidate UI direction comparison matrix, token seeds, anti-slop critique, and `PENDING_USER_REVIEW` gate.

## 4. Skills & Progressive-Disclosure Tooling
- `.agents/skills.json` & `.agents/skills/<slug>/SKILL.md`: Workspace-portable procedural skills loaded on demand.
- `~/.gemini/config/skills.json` & `~/.codex/skills/<slug>/SKILL.md`: Machine-global synchronized skill roots shared across Codex, Omnia, and Antigravity.

## 5. Memory, Context & Multi-Host History Ledgers (Externalized When Private)
- `.omnia/memory/` & `~/.codex/memories_v2/`: Hierarchical and provenance-tagged (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`) durable memory notes.
- `D:\OmniaData\exports\history\WATERMARK_AND_DENOMINATORS.json`: Exact multi-host transcript denominators, SHA-256 hashes, and redaction verification receipts.

## 6. Root Hygiene, External Layout & Recovery Ledgers
- `docs/workspace/EXTERNAL_LAYOUT.json`: Authoritative map of build targets (`CARGO_TARGET_DIR`), QA outputs, research outputs, and externalized clutter under `D:\OmniaData\`.
- `docs/workspace/SOURCE_DISPOSITION_LEDGER.json`: Per-path reconciliation ledger (`incorporated`, `superseded-with-evidence`, `retained-recovery`) across worktrees.
- `docs/workspace/CLEANUP_STATUS_*.md` & `REMOTE_SETUP.md`: Cleanup receipts and target remote repository identity.
