# Cycle 10 session tab integration

```tsx
import { SessionTabStrip, useSessionTabs } from "./session-tabs";

const rawController = useChatWorkspace();
const { controller, model } = useSessionTabs(rawController);
// Use `controller` throughout the shell, SessionList and ChatView. Its
// selectSession/createSession interceptors open/activate session tabs.
// Place the strip above the workspace, preserving existing three top modes:
<SessionTabStrip model={model} />
```

The hook observes raw active ID changes too. It does not send prompts, delete
sessions, change projects, initialize Core, or import a legacy view/store. Native
load waits for ChatController to finish its own authoritative bootstrap. Native
load/save use only `agent_session_navigation_load/save` and exact CAS revision.

## Behavior

- Ordered project and non-project session views share one strip; opening an
  already open session retains its position. Newly created sessions append.
- ArrowLeft/Right, Home/End select and focus. Delete closes a view. Control +
  Shift + ArrowLeft/Right reorders the focused tab. The final view stays open.
- Tabs are the only direct tablist children. Descriptively named close buttons
  are keyboard-focusable controls in a separate actions group; Delete also
  closes the focused tab. An empty initial strip does not expose a tablist role.
  Closing a view never deletes its data.
- Native tab order, selection, revision and receipt restore from native state.
- Conflict keeps the local view visible, shows the latest native receipt and
  requires **Use saved tabs** or **Save current tabs**. It never blindly retries.
- A save error can mean unknown acceptance. Native writes stop until explicit
  **Reload native tabs**. Cancellation stops observation; a dispatched write
  may still commit. Reload queues behind it to avoid reading before it settles.
- Local-only ChatSession identities never enter native navigation. Browser
  preview uses in-memory views and explicitly says it is not saved to native.

## Evidence boundary

The focused Vitest tests use controlled bridge responses and prove renderer
navigation behavior only. The two semantic regressions run selected axe rules
against the rendered DOM in jsdom; they do not establish a full screen-reader or
packaged accessibility pass. Root shell integration is exercised by seven shell
tests. Actual SQLite/Tauri restart restoration, packaged Windows UIA, screen
readers, geometry and visual capture still need native/runtime evidence. Session
workspace/IDE hierarchy is broader than this strip; `SESSION-009/010` are not
marked Done by this implementation.

Root owns canonical spec/DoD/checkpoint updates, final source review, native build
serialization, architecture/workflow validators, commits and publication.
