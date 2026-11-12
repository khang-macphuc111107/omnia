---
name: additive-steer-queue
description: Preserve all unfinished and in-progress tasks when mid-run user steer messages arrive by treating new prompts as additive queue intake, reconciling conflicts with completed work, and never imposing artificial goal budget caps.
metadata:
  short-description: Additive steer queue and zero-drop backlog continuity
---

# Additive Steer Queue

Prevent dropped requirements during rapid, multi-message user steering. Many users send mid-run steer messages to append new ideas while work is still executing; arrival order is conversational intake, **not** an instruction to abandon unfinished tasks.

## Core Invariants

1. **Default to `ADDITIVE_INTAKE`**: Every new user message arriving while goals or tasks remain `in_progress` or `todo` appends to the durable work ledger rather than replacing it.
2. **Zero Silent Drops**: Never mark an interrupted task `done`, silently drop queued items, or reset a long-running checklist when pivoting to handle an urgent steer.
3. **Explicit Cancellation Only**: Remove or supersede an existing requirement **only** when the user explicitly says to cancel, stop, or replace that specific item, or when two requirements are provably mutually exclusive (in which case, surface the conflict).
4. **No Artificial Budget Caps**: Never configure or inject a synthetic token/step budget cap (`token_budget` stays `NULL`/unlimited unless the user explicitly asks for a cap).

## Intake & Resume Workflow

1. **Snapshot Current State Before Pivoting**:
   - Record exact `completed`, `in_progress` (with file/step cursor), `todo`, and `blocked` items before acting on the newly arrived message.
2. **Classify Each Incoming Clause**:
   - `ADDITIVE_INTAKE`: New deliverable, URL, feature, or audit request -> append to the active queue with new requirement IDs.
   - `BOUNDARY_CORRECTION`: Refinement to how current work should be done (for example, path convention, git identity, anti-slop constraint) -> apply at the next safe boundary and check whether already-completed items need a reconciliation patch.
   - `EXPLICIT_STOP_OR_REPLACE`: User explicitly cancels a named item -> mark `superseded` or `cancelled` with citation to the user message.
3. **Reconcile Against Completed & In-Flight Work**:
   - Check whether the new steer modifies assumptions used by `completed` deliverables (for example, schema, path layout, naming, or ignore rules). Patch any affected artifact and re-verify it rather than leaving stale outputs behind.
4. **Drain the Full Queue**:
   - After finishing the immediate steer slice, automatically pull the next `in_progress` / `todo` item from the ledger and continue until **all** original and added DoD gates are verified.

## Ledger Schema

Maintain a compact, falsifiable queue state across turns:

| req_id | source_msg | classification | status | owner / files | conflict_check | verification_evidence |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |

## Relationship to Neighboring Skills

- Use this skill for **conversational multi-prompt intake and backlog continuity**.
- Use `deep-steer` when mutating formal CAS-fenced runtime graph/control-plane state (`pause`, `resume`, `rewire`, `cancel` with head-revision checks).
- Use `goal-plan-loop-dod` and `autonomous-power-continuity` for full-context hydration, parallel swarm dispatch, and DoD verification gates.
