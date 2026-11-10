# Durable session tabs implementation plan

**Goal:** One ordered strip opens project and non-project native sessions without
dispatching a prompt or deleting conversation data when a view closes.

**Spec:** `docs/rebuild/SPEC.md`, `SESSION-009` and the session portion of
`SESSION-010`; exact ownership is `/root/cycle10_session_tabs` in
`docs/rebuild/ASSIGNMENTS.md`. Root owns shell integration and canonical documents.

## Decisions

1. Use the real `agent_session_navigation_load/save` CAS contract. A local-only
cache cannot establish native restoration; silently overwriting a conflict would
discard another window's choices. Keep local interaction responsive, serialize
saves and require an explicit conflict decision.
2. A framework-independent coordinator owns validated native snapshots, ordered
view state and generation guards. A small React hook intercepts the existing
ChatController's selection/creation contracts. No chat, native or old UI imports
at runtime beyond the permitted pure desktop bridge.
3. Native save transport failure is outcome-unknown. Stop automatic writes and
offer reload; canceling observation cannot cancel an IPC write already accepted.
Reload waits for dispatched work to settle. A load started before local interaction
replays only navigation intents, without restoring stale selection over the user.

## Work and verification

- [x] Write coordinator regressions, run red: ordered restore, close without
delete, keep last tab, CAS conflict, save serialization, stale load, canceled
observation, unmount, invalid response, local-only exclusion, newly created tab.
- [x] Implement coordinator plus strictly validated native adapter. Run green.
- [x] Write strip/hook regressions, run red: Arrow/Home/End, focus after close,
scope labels, explicit preview status and intercepted sidebar/new-session flows.
- [x] Implement React hook and strip with scoped CSS, existing semantic tokens,
36px tab height, accessible labels and visible receipt/conflict/error recovery.
- [x] Run focused tests and app typecheck, self-review actual source, record command,
exit/revision/hash and limitations in the assigned receipt. The focused suite is
35/35 and the shell plus tab suite is 42/42. Architecture guard passes. Earlier
typecheck failures are retained as historical integration observations in the
receipt; current verification is recorded with exact exit status there.
- [x] Resolve fresh delivery accessibility finding: only tabs are tablist
children; descriptive close actions form a separate keyboard-focusable group.
The initial empty strip does not expose a tablist role. Targeted axe required
children/parent, nested-interactive and button-name checks pass in jsdom.
- [ ] Root independently reviews and captures integrated UI/native runtime.

## Review focus

- Early selection while restore is loading must retain the newer user intent.
- CAS conflict and outcome-unknown errors must never trigger blind write replay.
- Local draft identities must never reach native navigation persistence.
- Delayed save/create/load completion after cancellation or unmount must not
change selection or dispatch a follow-up operation.
- Closing the active tab selects its neighbor and retains the last visible tab;
closing views never calls a delete or send handler.

Native restoration/runtime, Windows UIA and complete workspace/IDE hierarchy
remain integration evidence obligations. These tests do not mark DoD Done.
