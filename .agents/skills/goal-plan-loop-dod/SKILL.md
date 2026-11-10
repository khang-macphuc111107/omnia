---
name: goal-plan-loop-dod
description: Use when a request has multiple requirements, dependencies, risks, or verification gates and needs measurable goals, an execution loop, and a definition of done.
---
# Goal, Plan, Loop and Definition of Done

Make progress visible and falsifiable.

## Start

Write objective, users, constraints, non-goals, risks, required artifacts, and a numbered DoD. Separate verified facts, proposals, and open questions. Inspect existing project context before asking for it.

## Decompose

Split by independent deliverable and dependency. Give each lane one owner, input, output, stop condition, and evidence location. Parallelize only independent reads or research; serialize shared mutations.

## Loop

`baseline -> research -> plan -> implement -> focused verify -> broad verify -> audit -> integrate -> record next gap`. Update `todo`, `in_progress`, `done`, `blocked`, evidence links, and the next action every iteration. If two attempts fail, preserve evidence and re-plan instead of guessing.

## DoD

A requirement is done only when implementation, behavior, tests or inspection, boundary/security checks, and a truthful artifact or receipt agree on the same snapshot. A placeholder, wrapper, mock-only path, copied code, or “looks right” screenshot is not completion unless explicitly scoped as a spike.

## Requirement ledger

Represent each requirement as `id`, verbatim request, interpretation, owner, dependency, acceptance check, evidence path, status, and next action. Mark facts, assumptions, proposals, and unknowns separately. A request to “make it deep” becomes observable gates such as source coverage, edge-case count, artifact completeness, and verification depth; it is not a license to inflate prose.

## Lane matrix

Each lane has one input, one output, one owner, a safe effect class, a stop condition, and a handoff artifact. Parallelize independent read-only research and inspections. Serialize writes that touch shared files, configuration, credentials, branches, or external systems. Before dispatching an agent, define the exact files it may edit and the evidence it must return.

## Loop health

At every iteration update `todo`, `in_progress`, `done`, `blocked`, and `next`. If a check fails twice, retain both logs, state the concrete root cause, and re-plan. Do not convert an unverified result into done because the task is lengthy. A partial result remains partial until its missing acceptance evidence is obtained. Record a user-authorized scope change as a revision; an internal owner's risk acceptance does not silently remove a mandatory requirement or prove the original objective.

## Long-running continuity

Bind each checkpoint to the current requirement IDs, source snapshot, active
operation handles, owned files and next executable action. On resume, read the
owning sources and inspect live handles before carrying a prior success or
restarting work. A timer or elapsed duration is not evidence of progress.

Group requirements by deliverable and shared dependency, preserving the
original IDs and group membership. Grouping changes scheduling, not the
completion denominator. Keep new requests in the ledger while continuing
independent work; propagate changes to affected acceptance checks and consumers.

When the user explicitly uses steer to submit additions quickly, treat
additive prompts as queued intake. Finish the interrupted deliverable,
checkpoint its next action and then consume the additions in order. Apply
corrections affecting current correctness at a safe boundary. Only an explicit
stop/cancel or incompatible replacement supersedes unfinished work. Do not
declare the previous task done, restart it, or switch to the newest prompt
merely because the message arrived. A file-backed queue records intent; it
does not prove a runtime scheduler accepted or dispatched a control operation.

Track a concise claim/evidence/unknown table for consequential conclusions.
Audit drift after code, data, schema or policy changes; do not inherit a passing
verdict from different bytes. Use bounded retry and review intervals appropriate
to the work. A long run does not gain accuracy merely by running longer.

## DoD matrix

For every row require implementation or inspected state, behavior evidence, focused verification, security/boundary review, and a receipt from the same snapshot. Include negative cases, stale-state behavior, cancellation, cleanup, and rollback when the feature can mutate state.
