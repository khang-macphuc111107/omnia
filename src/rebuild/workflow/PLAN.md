# Goal evidence panel implementation plan

**Goal:** Inspect and edit native goals, atomic plan tasks, acceptance evidence,
remaining work and reports in the original Omnia renderer.

**Architecture:** A small native adapter exposes the existing typed Goal/Task
commands. A subscribable controller owns generations and the native snapshots;
React renders those snapshots and explicit forms. Native revisions are the
durable authority. Browser preview exposes unavailable controls.

**Tech stack:** React 19, TypeScript, lucide-react, scoped CSS, Vitest/RTL.

**Spec:** `docs/rebuild/SPEC.md` sections 2, 3 and 6; assignment
`/root/cycle10_workflow_ui`; criteria WORKFLOW-001/002/003/007/008.

## Decisions and alternatives

1. A local automation ledger would support nested plans but is an in-memory
   schema unrelated to the native Goal revision. Do not represent it as durable.
2. Raw JSON alone would preserve native flexibility but makes evidence entry
   difficult. Use simple structured fields for new criteria/tasks/reports,
   retain unfamiliar values, and expose exact native JSON in the inspector.
3. Use the native APIs and immutable revision guards. A harness session ID is
   display context only: no false mapping to a `conversation_` identity.

The assigned implementation method authorizes proceeding without another
confirmation. Root owns integration, canonical documentation and independent
review; this plan remains inside the assigned files.

## Global constraints

- New files only under `src/rebuild/workflow/`; one assigned verification receipt.
- No legacy renderer imports/copies; pure `src/lib/desktop.ts` contracts only.
- Native snapshots explicitly say `preview-only`: these APIs record planning
  state, never dispatch work. No Cargo runs; root serializes native verification.
- Shared visual tokens, 4/8/12/16/24 spacing, visible names/focus, responsive layout.
- No auto-completion, automatic retry or local persistence presented as native.

## Review focus

- Old project/goal/task reads and mutation responses must not replace new scope.
- A denied/missing/invalid response is distinct from an empty successful list.
- Unknown mutation outcome is retained and requires refresh, never blind replay.
- A populated plan is insufficient for goal completion; criteria, task states and
  evidence/report gates must all pass and an explicit status action is required.
- Existing foreign metadata/criteria remain intact during report/task edits.

## Tasks and verification

- [x] Model: write failing tests for input validation, lossless metadata changes,
  reports and completion gates; implement bounded forms and native payloads.
- [x] Controller: write failing tests for list/read/create/revise/status, missing,
  denied, stale reads/mutations, cancellation, reload and no implicit dispatch;
  implement the typed native adapter plus generation-owned controller.
- [x] View: write failing RTL tests for unavailable preview, create/edit forms,
  acceptance/task/report inspection, accessible errors and close/focus behavior;
  implement `WorkflowPanel` and scoped styles.
- [ ] Run focused tests and app typecheck; report exact command/exit/scope,
  current input/source hashes, limitations and root integration contract.

## Integration

`WorkflowPanel({sessionId?, projectId?, conversationId?, onClose?})` is an inline
panel. Root owns a trigger, overlay and global focus boundary when used as a
dialog. `sessionId` does not affect native scope; project/conversation IDs do.
The panel includes a clearly labeled native scope and current session context.

## Progress and rulings

- Read canonical resume documents and native goal/task types, native command
  handlers, canonical payload validation, lifecycle transition tables, scope and
  native limits before implementation.
- Read Cycle 10 UI/MCP synthesis; apply stable generation/identity, explicit
  unavailable states and bounded announcements. No source/UI copied.
- Ruling: keep the local automation ledger out of this native panel because its
  persistence and schema have no verified native mapping. Cost: nested automation
  reports remain a separately named incomplete integration.
- Root owns final project test/build, independent review and all commits.

## Independent review follow-up

- `C10-WORKFLOW-UNKNOWN-SCOPE` reproduced before repair: four of seven
  independent controller regressions failed. Six added owned-controller cases
  also failed before the fix, including incomplete reconciliation reads.
- Retain unresolved outcomes per native project/conversation tuple outside
  transient display snapshots. Display-only harness session changes preserve
  the same tuple. Late failures still fence the originating native scope.
- Clear a fence only after an uncancelled, successful, complete refresh of its
  goal list and any selected goal/task list. Another scope, failed reads and
  truncated lists cannot clear it.
- Current renderer evidence: 37 workflow tests plus seven independent regressions
  pass. Scoped strict TypeScript and the architecture guard pass. Full app
  typecheck/build and refreshed independent review remain root-owned.
- This fence is controller memory. Native durable reconciliation across process
  restarts and packaged/live behavior remain unverified.
