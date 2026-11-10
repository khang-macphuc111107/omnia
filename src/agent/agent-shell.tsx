import { ChevronRight, Download, FileOutput, Folder, GitCompare, GitCompareArrows, MoreHorizontal, OctagonX, PanelLeft } from "lucide-react";
import { Component, Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { WorkbenchWindowControls } from "@/features/workspace/workbench-window-controls";
import { ActivityRail } from "./activity-rail";
import { useAgentStore } from "./agent-store";
import { agentApi, errorMessage } from "./agent-api";
// Stays eager: NewSessionDialog statically imports SystemPromptEditor from this module.
import { SessionSettingsDialog } from "./session-settings-dialog";
import { folderName } from "./format";
import { NewSessionDialog } from "./new-session-dialog";
import { readPrefs, writePrefs } from "./prefs";
import { Sidebar } from "./sidebar";
import { SessionPane } from "./session-pane";
import { SplitDivider } from "./split-divider";
import { startAgentAppearance } from "./appearance";
import { isNarrowPanelViewport, isNarrowWidth, visibleSessionIds } from "./split";
import { Popover, ConfirmDialog } from "./ui";
import { isWorkspaceView, primarySurfaceForView, PRIMARY_SURFACE_VIEWS, shellViewLabel, type ShellView, type WorkspaceView } from "./shell-view";
import { HomeStart } from "./home-start";
import { StatusBar } from "./status-bar";
import { SessionTabs } from "./session-tabs";
import { useSessionNavigation } from "./use-session-navigation";
import { toolCategory, type LiveState } from "./transcript";

import "./agent.css";
import "./themes.css";

/**
 * Harness tools that drive the real desktop (omnia-computer) or a controlled browser (omnia-browser).
 * The emergency stop pill shows only while one of these is running or awaiting approval.
 * Source of truth: src-tauri/crates/omnia-computer/src/tools.rs and omnia-browser/src/tools/schema.rs.
 */
export const COMPUTER_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "computer_windows", "computer_snapshot", "computer_screenshot", "computer_ocr", "computer_find_text",
  "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_drag", "computer_act",
  "computer_window", "computer_launch", "computer_batch", "computer_window_list", "computer_window_screenshot",
  "computer_window_click", "computer_window_type", "computer_window_key", "computer_window_ocr",
  "computer_window_find_text",
  "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_hover",
  "browser_scroll", "browser_select", "browser_upload", "browser_wait", "browser_screenshot", "browser_evaluate",
  "browser_get_text", "browser_tabs", "browser_console", "browser_network", "browser_pdf", "browser_batch",
  "browser_record", "browser_emulate", "browser_save_page",
]);

/** True while any computer/browser-control tool in this live state (or a nested subagent) is in flight or pending approval. */
export function hasActiveComputerTool(state: LiveState | null | undefined): boolean {
  if (!state) return false;
  if (state.approvals.some((approval) => COMPUTER_CONTROL_TOOLS.has(approval.tool))) return true;
  if (!state.running) return false;
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index]!;
    if (item.kind !== "tool") continue;
    if ((item.status === "running" || item.status === "pending" || item.status === "streaming") && COMPUTER_CONTROL_TOOLS.has(item.name)) return true;
    if (item.sub && hasActiveComputerTool(item.sub)) return true;
  }
  return false;
}

function stopComputer() {
  void agentApi.emergencyStopComputer().catch((cause) => useAgentStore.setState({ notice: errorMessage(cause) }));
}

/** Compact red pill, rendered only while a computer/browser-control tool is live in any session. The palette always lists it. */
function EmergencyStop() {
  const active = useAgentStore((store) => Object.values(store.live).some((state) => hasActiveComputerTool(state)));
  if (!active) return null;
  return (
    <button type="button" className="ag-estop" onClick={stopComputer} aria-label="Emergency stop computer" title="Emergency stop computer">
      <OctagonX size={13} aria-hidden="true" />
      <span>Stop</span>
    </button>
  );
}

/** Distinct files changed by finished edit tools in a live state; drives the Changes badge. */
function changedFileCount(state: LiveState | undefined): number {
  if (!state) return 0;
  const paths = new Set<string>();
  for (const item of state.items) {
    if (item.kind !== "tool" || item.status !== "ok" || toolCategory(item.name) !== "edit") continue;
    const input = item.input as { path?: unknown; file_path?: unknown } | null;
    const path = input && typeof input === "object" ? (input.path ?? input.file_path) : undefined;
    if (typeof path === "string" && path) paths.add(path);
  }
  return paths.size;
}

// The workspace views (former Labs) stay a lazy chunk, loaded on first navigation away from the agent.
const WorkspaceSurface = lazy(() => import("@/labs/workspace-surface"));
export const LabsApp = lazy(() => import("@/labs/labs-app"));

// Surfaces that only render after a user action load on first open, keeping them out of startup JS.
const DiffPane = lazy(() => import("./diff-pane").then((module) => ({ default: module.DiffPane })));
const ArtifactsPanel = lazy(() => import("./artifacts-panel").then((module) => ({ default: module.ArtifactsPanel })));
const DownloadsPanel = lazy(() => import("./downloads-panel").then((module) => ({ default: module.DownloadsPanel })));
const WorkspaceTrustDialog = lazy(() => import("./workspace-trust-dialog").then((module) => ({ default: module.WorkspaceTrustDialog })));
const ServicesDialog = lazy(() => import("./services-dialog").then((module) => ({ default: module.ServicesDialog })));
const CompareSessionDialog = lazy(() => import("./compare-session-dialog").then((module) => ({ default: module.CompareSessionDialog })));
const SettingsDialog = lazy(() => import("./settings-dialog").then((module) => ({ default: module.SettingsDialog })));
const CommandPalette = lazy(() => import("./command-palette").then((module) => ({ default: module.CommandPalette })));

export function useNarrowPanelViewport(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" ? isNarrowPanelViewport(window.innerWidth) : false));
  useEffect(() => {
    const sync = () => setNarrow(isNarrowPanelViewport(window.innerWidth));
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  return narrow;
}

class SurfaceErrorBoundary extends Component<
  { label: string; onClose?: (() => void) | undefined; children: ReactNode },
  { error: string | null }
> {
  override state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error) };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="ag-empty" role="alert">
        <p>{this.props.label} could not be loaded.</p>
        <p className="ag-muted">{this.state.error}</p>
        <div className="ag-row">
          <button type="button" className="ag-btn" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
          {this.props.onClose ? (
            <button type="button" className="ag-btn ag-btn--ghost" onClick={this.props.onClose}>
              Close
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}

/** Side-column placeholder. `.ag-downloads` lives in the eager agent.css, so the frame is styled before a panel's own CSS chunk arrives. */
function PanelFallback({ label }: { label: string }) {
  return (
    <aside className="ag-downloads" aria-label={`${label} loading`} aria-busy="true">
      <p className="ag-muted ag-center" role="status">Loading {label.toLowerCase()}…</p>
    </aside>
  );
}

/** Modal placeholder. It keeps role="dialog" so the shell's Escape guard behaves as it does once the real dialog mounts. */
function DialogFallback({ label }: { label: string }) {
  return (
    <div className="ag-scrim">
      <div className="ag-dialog ag-dialog--small" role="dialog" aria-modal="true" aria-label={`${label} loading`} aria-busy="true">
        <p className="ag-muted" role="status">Loading {label.toLowerCase()}…</p>
      </div>
    </div>
  );
}

export function AgentShell() {
  const store = useAgentStore();
  const { sessions, activeId, live, ready, startupError, notice, split, narrow } = store;
  const narrowPanel = useNarrowPanelViewport();
  const [sidebarOpen, setSidebarOpen] = useState(() => readPrefs().sidebarOpen !== false);
  const [dialog, setDialog] = useState<"new" | "settings" | "trust" | "services" | "compare" | "session" | null>(null);
  const [view, setView] = useState<ShellView>("agent");
  // Last workspace view shown; once set the surface stays mounted (hidden) so switching back is instant.
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(null);
  const [rightPanel, setRightPanel] = useState<"changes" | "artifacts" | "downloads" | null>(null);
  const artifactRequest = useAgentStore((entry) => entry.artifactRequest);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const { openIds: openTabIds, open: openSessionTab, close: closeSessionTabView } = useSessionNavigation(ready, sessions.map((entry) => entry.id), activeId);
  // Joined to a string so the selector result is stable between unrelated store updates.
  const awaitingKey = useAgentStore((entry) => Object.keys(entry.live).filter((id) => (entry.live[id]?.approvals.length ?? 0) > 0).join("|"));
  const awaitingIds = awaitingKey ? awaitingKey.split("|") : [];
  const changesCount = useAgentStore((entry) => changedFileCount(entry.activeId ? entry.live[entry.activeId] : undefined));
  const splitHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void useAgentStore.getState().init();
  }, []);

  useEffect(() => startAgentAppearance(), []);

  // Narrow windows fall back to a single pane (the split state is kept for when the window widens).
  useEffect(() => {
    const sync = () => useAgentStore.getState().setNarrow(isNarrowWidth(window.innerWidth));
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  // The agent created/updated an artifact, or a transcript card asked to open one.
  useEffect(() => {
    if (!artifactRequest) return;
    const { sessionId, reason } = artifactRequest;
    if (reason === "open") {
      if (sessionId !== useAgentStore.getState().activeId) void useAgentStore.getState().open(sessionId);
      setRightPanel("artifacts");
    } else if (reason === "created" && sessionId === useAgentStore.getState().activeId) {
      setRightPanel((panel) => panel ?? "artifacts");
    }
  }, [artifactRequest]);

  // Transcript tool rows ask for the full diff via a window event.
  useEffect(() => {
    const onOpenChanges = () => {
      setView("agent");
      setRightPanel("changes");
      if (narrowPanel) setSidebarOpen(false);
    };
    window.addEventListener("omnia:open-changes", onOpenChanges);
    return () => window.removeEventListener("omnia:open-changes", onOpenChanges);
  }, [narrowPanel]);

  const session = sessions.find((entry) => entry.id === activeId) ?? null;
  const state = activeId ? live[activeId] : undefined;
  const running = state?.running ?? false;
  const splitPanes = split.panes && !narrow ? split.panes : null;
  const visibleIds = visibleSessionIds(split, activeId, narrow);

  const navigate = useCallback((next: ShellView) => {
    setView(next);
    if (isWorkspaceView(next)) setWorkspaceView(next);
  }, []);
  const showAgent = useCallback(() => setView("agent"), []);
  // Projects/work/library are secondary Chat routes. Keep Chat highlighted in
  // the primary chrome while Browser and IDE remain the only other modes.
  const agentView = view === "agent";
  const primaryView = primarySurfaceForView(view);

  const openSession = useCallback((id: string, closeDrawer = true) => {
    openSessionTab(id);
    void useAgentStore.getState().open(id);
    if (closeDrawer && narrowPanel) setSidebarOpen(false);
  }, [narrowPanel, openSessionTab]);

  const closeSessionTab = useCallback((id: string) => {
    const fallback = closeSessionTabView(id);
    if (id === useAgentStore.getState().activeId) void useAgentStore.getState().open(fallback);
  }, [closeSessionTabView]);

  const viewRef = useRef(view);
  viewRef.current = view;

  // Escape denies the pending approval, otherwise interrupts a running agent.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.altKey && ((key === "k" && !event.shiftKey) || (key === "p" && event.shiftKey))) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // Ctrl+, opens Settings from every view.
      if (mod && !event.altKey && !event.shiftKey && (event.key === "," || event.code === "Comma")) {
        event.preventDefault();
        if (!document.querySelector('[role="dialog"]')) setDialog("settings");
        return;
      }
      // Alt+1..3 switches the three primary surfaces (also from inputs).
      if (event.altKey && !mod && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
        const target = PRIMARY_SURFACE_VIEWS[Number(event.code.slice(5)) - 1];
        if (target && !document.querySelector('[role="dialog"]')) {
          event.preventDefault();
          navigate(target.id);
        }
        return;
      }
      // The remaining shortcuts belong to the agent view.
      if (viewRef.current !== "agent") return;
      if (mod && !event.altKey && !event.shiftKey && (event.key === "\\" || event.code === "Backslash")) {
        event.preventDefault();
        useAgentStore.getState().toggleSplit();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      const current = useAgentStore.getState();
      const id = current.activeId;
      const liveState = id ? current.live[id] : undefined;
      const approval = liveState?.approvals[0];
      if (approval) {
        event.preventDefault();
        void current.decide(approval.tool_use_id, { type: "deny", feedback: null }).catch(() => undefined);
      } else if (liveState?.running) {
        event.preventDefault();
        void current.interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  // The narrow-window sidebar is a drawer: Escape closes it.
  const drawerOpen = sidebarOpen && narrowPanel;
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setSidebarOpen(false);
      writePrefs({ sidebarOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const toggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    writePrefs({ sidebarOpen: open });
  };

  const commitRename = () => {
    const title = renaming?.trim();
    setRenaming(null);
    if (session && title && title !== session.title) void store.rename(session.id, title);
  };

  const toggleRightPanel = (target: "changes" | "artifacts" | "downloads") => {
    setRightPanel((current) => {
      const next = current === target ? null : target;
      if (next && narrowPanel && sidebarOpen) setSidebarOpen(false);
      return next;
    });
  };

  return (
    <>
      <div className="ag-shell">
        <ActivityRail view={primaryView} onNavigate={navigate} onOpenSettings={() => setDialog("settings")} />
        <div className="ag-shell__main">
        <div className="ag-shell__views">
        <div className="ag-app" hidden={!agentView} aria-hidden={!agentView || undefined}>
          {sidebarOpen ? (
            <Sidebar
              sessions={sessions}
              activeId={activeId}
              visibleIds={visibleIds}
              splitOpen={splitPanes !== null}
              onOpenInSplit={(id) => store.openInSplit(id)}
              onNew={() => setDialog("new")}
              onOpen={(id) => {
                openSession(id);
              }}
              onRename={(id, title) => void store.rename(id, title)}
              onFork={(id) => void store.fork(id)}
              onDelete={(id) => void store.remove(id)}
              onUpdates={() => setDialog("settings")}
              awaitingIds={awaitingIds}
              onCollapse={() => toggleSidebar(false)}
            />
          ) : null}
          {drawerOpen ? <div className="ag-sidebar-scrim" data-testid="sidebar-scrim" aria-hidden="true" onClick={() => toggleSidebar(false)} /> : null}

          <main className="ag-main">
            <header className="ag-header" data-tauri-drag-region>
              {!sidebarOpen ? (
                <button type="button" className="ag-icon-btn" aria-label="Show sidebar" title="Show sidebar" onClick={() => toggleSidebar(true)}>
                  <PanelLeft size={16} aria-hidden="true" />
                </button>
              ) : null}
              {session && renaming !== null ? (
                <input
                  className="ag-input ag-header__rename"
                  aria-label="Session title"
                  value={renaming}
                  autoFocus
                  onChange={(event) => setRenaming(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename();
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setRenaming(null);
                    }
                  }}
                />
              ) : session ? (
                <h1 className="ag-header__title" data-tauri-drag-region>
                  <span className="ag-header__breadcrumb" title={session.cwd}>
                    <Folder size={13} aria-hidden="true" />
                    <span>{folderName(session.cwd)}</span>
                  </span>
                  <ChevronRight className="ag-header__breadcrumb-separator" size={13} aria-hidden="true" />
                  <span className="ag-header__session-title" title={session.title || "Untitled"}>{session.title || "Untitled"}</span>
                </h1>
              ) : (
                <h1 className="ag-header__title" data-tauri-drag-region>Home</h1>
              )}
              <span className="ag-spacer" data-tauri-drag-region />
              <EmergencyStop />
              {session ? (
                <div className="ag-header__tools" role="group" aria-label="Session panels">
                  {([
                    ["changes", "Changes", GitCompare, changesCount],
                    ["artifacts", "Artifacts", FileOutput, 0],
                    ["downloads", "Downloads", Download, 0],
                  ] as const).map(([id, label, Icon, count]) => (
                    <button
                      key={id}
                      type="button"
                      className="ag-icon-btn ag-header__panel"
                      aria-label={label}
                      title={count > 0 ? `${label} (${count})` : label}
                      aria-pressed={rightPanel === id}
                      onClick={() => toggleRightPanel(id)}
                    >
                      <Icon size={15} aria-hidden="true" />
                      {count > 0 ? <span className="ag-header__badge" aria-hidden="true">{count > 99 ? "99+" : count}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {session ? (
                <button
                  type="button"
                  className="ag-icon-btn ag-header__compare"
                  aria-label="Compare provider models"
                  aria-haspopup="dialog"
                  title="Compare provider models"
                  onClick={() => setDialog("compare")}
                >
                  <GitCompareArrows size={15} aria-hidden="true" />
                </button>
              ) : null}
              {session ? (
                <Popover label="More session actions" className="ag-icon-btn ag-header__more" placement="down" trigger={<MoreHorizontal size={16} aria-hidden="true" />}>
                  {(close) => (
                    <ul className="ag-menu" role="menu">
                      {([
                        [split.panes ? "Close split view" : "Open split view", () => store.toggleSplit(), false],
                        ["Rename session", () => setRenaming(session.title), false],
                        ["Session settings", () => setDialog("session"), false],
                        ["Workspace trust", () => setDialog("trust"), false],
                        ["Services", () => setDialog("services"), false],
                        ["Delete session", () => setConfirmDelete(true), true],
                      ] as const).map(([label, run, warn]) => (
                        <li role="none" key={label}>
                          <button type="button" role="menuitem" className={`ag-menu__item${warn ? " ag-menu__item--warn" : ""}`} onClick={() => { close(); run(); }}>{label}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Popover>
              ) : null}
              <WorkbenchWindowControls />
            </header>

            <SessionTabs
              sessions={sessions}
              openIds={openTabIds}
              activeId={activeId}
              onOpen={(id) => openSession(id, false)}
              onNew={() => setDialog("new")}
              onClose={closeSessionTab}
            />

            {startupError ? (
              <div className="ag-empty" role="alert">
                <p>The agent is not available.</p>
                <p className="ag-muted">{startupError}</p>
                <button type="button" className="ag-btn" onClick={() => void store.init()}>Retry startup</button>
              </div>
            ) : !ready ? (
              <div className="ag-empty" role="status">
                <p className="ag-muted">Starting…</p>
              </div>
            ) : splitPanes ? (
              <div className="ag-split" ref={splitHost}>
                {([0, 1] as const).map((index) => (
                  <Fragment key={index}>
                    {index === 1 ? <SplitDivider host={splitHost} /> : null}
                    <div className="ag-split__cell" style={{ flex: `${index === 0 ? split.ratio : 1 - split.ratio} 1 0` }}>
                      <SessionPane
                        sessionId={splitPanes[index]}
                        focused={split.focused === index}
                        split
                        onFocus={() => store.focusSplitPane(index)}
                        onClose={() => store.closeSplitPane(index)}
                        onSwap={() => store.swapSplit()}
                      />
                    </div>
                  </Fragment>
                ))}
              </div>
            ) : session ? (
              <SessionPane key={session.id} sessionId={session.id} focused split={false} />
            ) : (
              <>
                {notice ? <p className="ag-error ag-shell__notice" role="alert">{notice}</p> : null}
                <HomeStart onNavigate={navigate} onOpenSettings={() => setDialog("settings")} />
              </>
            )}
          </main>

          {rightPanel === "changes" && session ? (
            <SurfaceErrorBoundary label="Changes" onClose={() => setRightPanel(null)}>
              <Suspense fallback={<PanelFallback label="Changes" />}>
                <DiffPane key={session.id} sessionId={session.id} running={running} onClose={() => setRightPanel(null)} />
              </Suspense>
            </SurfaceErrorBoundary>
          ) : rightPanel === "artifacts" && session ? (
            <SurfaceErrorBoundary label="Artifacts" onClose={() => setRightPanel(null)}>
              <Suspense fallback={<PanelFallback label="Artifacts" />}>
                <ArtifactsPanel key={session.id} sessionId={session.id} request={artifactRequest} onClose={() => setRightPanel(null)} />
              </Suspense>
            </SurfaceErrorBoundary>
          ) : rightPanel === "downloads" && session ? (
            <SurfaceErrorBoundary label="Downloads" onClose={() => setRightPanel(null)}>
              <Suspense fallback={<PanelFallback label="Downloads" />}>
                <DownloadsPanel key={session.id} sessionId={session.id} onClose={() => setRightPanel(null)} />
              </Suspense>
            </SurfaceErrorBoundary>
          ) : null}
        </div>
        {workspaceView ? (
          <section
            className="ag-workspace"
            aria-label={shellViewLabel(workspaceView)}
            hidden={agentView}
            aria-hidden={agentView || undefined}
          >
            <header className="ag-workspace__bar" data-tauri-drag-region>
              {!sidebarOpen ? (
                <button type="button" className="ag-icon-btn" aria-label="Show chat sidebar" title="Show chat sidebar" onClick={() => toggleSidebar(true)}>
                  <PanelLeft size={16} aria-hidden="true" />
                </button>
              ) : null}
              <h1 className="ag-workspace__title" data-tauri-drag-region>{shellViewLabel(workspaceView)}</h1>
              <span className="ag-spacer" data-tauri-drag-region />
              <EmergencyStop />
              <WorkbenchWindowControls />
            </header>
            <div className="ag-workspace__body">
              {sidebarOpen ? (
                <aside className="ag-workspace__chat-sidebar" aria-label="Chat sessions">
                  <Sidebar
                    sessions={sessions}
                    activeId={activeId}
                    visibleIds={visibleIds}
                    splitOpen={splitPanes !== null}
                    onOpenInSplit={(id) => store.openInSplit(id)}
                    onNew={() => setDialog("new")}
                    onOpen={(id) => openSession(id)}
                    onRename={(id, title) => void store.rename(id, title)}
                    onFork={(id) => void store.fork(id)}
                    onDelete={(id) => void store.remove(id)}
                    onUpdates={() => setDialog("settings")}
                    awaitingIds={awaitingIds}
                    onCollapse={() => toggleSidebar(false)}
                  />
                </aside>
              ) : null}
              <div className="ag-workspace__surface">
                <SurfaceErrorBoundary label={shellViewLabel(workspaceView)} onClose={showAgent}>
                  <Suspense fallback={<p className="ag-muted ag-center" role="status">Opening {shellViewLabel(workspaceView).toLowerCase()}…</p>}>
                    <WorkspaceSurface view={workspaceView} onNavigate={navigate} />
                  </Suspense>
                </SurfaceErrorBoundary>
              </div>
            </div>
          </section>
        ) : null}
        </div>
        <StatusBar view={view} />
        </div>
      </div>

      {confirmDelete && session ? (
        <ConfirmDialog
          title="Delete session"
          body={`Delete "${session.title || "Untitled"}"? This cannot be undone.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void store.remove(session.id);
          }}
        />
      ) : null}
      {dialog === "services" && session ? (
        <Suspense fallback={<DialogFallback label="Session services" />}>
          <ServicesDialog key={session.id} sessionId={session.id} onClose={() => setDialog(null)} />
        </Suspense>
      ) : null}
      {dialog === "compare" && session ? (
        <Suspense fallback={<DialogFallback label="Compare provider models" />}>
          <CompareSessionDialog key={session.id} session={session} onClose={() => setDialog(null)} />
        </Suspense>
      ) : null}
      {dialog === "session" && session ? <SessionSettingsDialog key={session.id} session={session} onClose={() => setDialog(null)} /> : null}
      {dialog === "trust" && session ? (
        <Suspense fallback={<DialogFallback label="Workspace trust" />}>
          <WorkspaceTrustDialog key={session.cwd} cwd={session.cwd} onClose={() => setDialog(null)} />
        </Suspense>
      ) : null}
      {dialog === "new" ? (
        <NewSessionDialog
          onCreate={(input) => {
            showAgent();
            return store.create(input);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "settings" ? (
        <Suspense fallback={<DialogFallback label="Settings" />}>
          <SettingsDialog onClose={() => setDialog(null)} />
        </Suspense>
      ) : null}
      {paletteOpen ? (
        <Suspense fallback={<DialogFallback label="Command palette" />}>
          <CommandPalette
            onClose={() => setPaletteOpen(false)}
            onNewSession={() => setDialog("new")}
            onToggleSidebar={() => {
              showAgent();
              toggleSidebar(!sidebarOpen);
            }}
            onOpenDownloads={() => {
              showAgent();
              setRightPanel("downloads");
            }}
            onOpenChanges={() => {
              showAgent();
              setRightPanel("changes");
            }}
            onOpenArtifacts={() => {
              showAgent();
              setRightPanel("artifacts");
            }}
            onOpenCompare={() => {
              showAgent();
              if (session) setDialog("compare");
            }}
            onOpenWorkspaceTrust={() => setDialog("trust")}
            onOpenServices={() => setDialog("services")}
            onOpenSessionSettings={() => setDialog("session")}
            onOpenSettings={() => setDialog("settings")}
            currentView={view}
            onNavigate={navigate}
            onDeleteCurrent={() => setConfirmDelete(true)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
