import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { ModalSurface } from "@/components/modal-surface";
import { agentApi, errorMessage } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { InspectorDialog } from "./inspector-dialog";
import { SchedulesDialog } from "./schedules-dialog";
import { SECONDARY_SHELL_VIEWS, SHELL_VIEWS, type ShellView } from "./shell-view";
import type { PermissionMode } from "./types";
import "./command-palette.css";

export type PaletteGroup = "Session" | "Navigation" | "Mode" | "Services";

export interface PaletteAction {
  id: string;
  group: PaletteGroup;
  label: string;
  hint?: string | undefined;
  /** Extra search terms matched by the fuzzy filter (not displayed). */
  keywords?: string | undefined;
  run: () => void;
}

export interface PaletteHandlers {
  onClose: () => void;
  onNewSession: () => void;
  onToggleSidebar: () => void;
  onOpenDownloads: () => void;
  onOpenChanges: () => void;
  onOpenArtifacts: () => void;
  /** Opens the bounded multi-provider compare workflow when available. */
  onOpenCompare?: () => void;
  onOpenWorkspaceTrust: () => void;
  onOpenServices: () => void;
  onOpenSessionSettings: () => void;
  onOpenSettings: () => void;
  currentView: ShellView;
  onNavigate: (view: ShellView) => void;
  onDeleteCurrent: () => void;
}

const GROUP_ORDER: PaletteGroup[] = ["Session", "Navigation", "Mode", "Services"];

const VIEW_KEYWORDS: Partial<Record<ShellView, string>> = {
  agent: "chat agents agent sessions coding session start",
  projects: "labs workspace folders",
  work: "labs jobs tasks background runs",
  library: "memory skills artifacts knowledge labs files documents notes",
  code: "labs workspace ide vs code editor",
  browser: "labs web internet",
};

const VIEW_HINTS: Partial<Record<ShellView, string>> = { library: "Memory, Skills" };

/**
 * Keep secondary Chat routes discoverable without adding more persistent
 * chrome. The top-level rail remains three buttons; the palette is the place
 * for power users to jump directly to Projects, Work or Library.
 */
const NAVIGABLE_VIEWS = [...SHELL_VIEWS, ...SECONDARY_SHELL_VIEWS] as const;

const MODES: Array<[PermissionMode, string]> = [
  ["plan", "Plan"],
  ["ask_all", "Ask for everything"],
  ["ask_writes", "Ask for writes"],
  ["auto", "Auto"],
  ["full", "Full access"],
];

const EFFORTS: Array<[string | null, string]> = [
  [null, "Provider default"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["max", "Max"],
];

/** Subsequence fuzzy score; null when the query does not match. Lower is better. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let at = -1;
  let gaps = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return null;
    if (at >= 0) gaps += next - at - 1;
    at = next;
  }
  return 100 + gaps;
}

function actionScore(query: string, action: PaletteAction): number | null {
  const own = fuzzyScore(query, action.label);
  if (own !== null && own < 100) return own;
  const extra = action.keywords && query.trim() ? action.keywords.toLowerCase().indexOf(query.trim().toLowerCase()) : -1;
  if (extra >= 0) return 50 + extra;
  return own;
}

export function CommandPalette(props: PaletteHandlers) {
  const { onClose } = props;
  const sessions = useAgentStore((s) => s.sessions);
  const activeId = useAgentStore((s) => s.activeId);
  const running = useAgentStore((s) => (s.activeId ? s.live[s.activeId]?.running ?? false : false));
  const splitState = useAgentStore((s) => s.split);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<PaletteGroup, boolean>>({
    Session: false,
    Navigation: false,
    Mode: false,
    Services: false,
  });
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const lastCollapsed = useRef<PaletteGroup | null>(null);
  const active = sessions.find((entry) => entry.id === activeId) ?? null;

  const toggleGroup = (group: PaletteGroup) => {
    setCollapsedGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  const actions = useMemo<PaletteAction[]>(() => {
    const store = () => useAgentStore.getState();
    const toAgent = () => {
      if (props.currentView !== "agent") props.onNavigate("agent");
    };
    const list: PaletteAction[] = [
      { id: "new", group: "Session", label: "New session", run: props.onNewSession },
    ];
    if (active) {
      list.push({ id: "rename", group: "Session", label: "Rename current session", run: () => { setRenaming(true); setQuery(active.title); setIndex(0); } });
      list.push({ id: "delete", group: "Session", label: "Delete current session", run: props.onDeleteCurrent });
      if (running) list.push({ id: "interrupt", group: "Session", label: "Interrupt run", run: () => void store().interrupt() });
    }
    for (const entry of sessions) {
      list.push({
        id: `open:${entry.id}`,
        group: "Navigation",
        label: `Switch to ${entry.title || "Untitled"}`,
        hint: entry.id === activeId && props.currentView === "agent" ? "current" : undefined,
        run: () => {
          toAgent();
          void store().open(entry.id);
        },
      });
    }
    list.push({ id: "sidebar", group: "Navigation", label: "Toggle sidebar", run: props.onToggleSidebar });
    {
      const split = store().split;
      list.push({
        id: "split-toggle",
        group: "Navigation",
        label: split.panes ? "Close split view" : "Open split view",
        hint: "Ctrl+\\",
        run: () => {
          toAgent();
          store().toggleSplit();
        },
      });
      if (split.panes) {
        list.push({
          id: "split-focus",
          group: "Navigation",
          label: "Focus other pane",
          run: () => {
            toAgent();
            store().focusSplitPane(split.focused === 0 ? 1 : 0);
          },
        });
        list.push({
          id: "split-swap",
          group: "Navigation",
          label: "Swap split panes",
          run: () => {
            toAgent();
            store().swapSplit();
          },
        });
      }
    }
    list.push({ id: "settings", group: "Navigation", label: "Open Settings", hint: "Ctrl+,", keywords: "preferences options configuration providers", run: props.onOpenSettings });
    for (const view of NAVIGABLE_VIEWS) {
      list.push({
        id: `view:${view.id}`,
        group: "Navigation",
        label: `Go to ${view.label}`,
        hint: view.id === props.currentView ? "current" : [VIEW_HINTS[view.id], view.shortcut].filter(Boolean).join(" · "),
        keywords: VIEW_KEYWORDS[view.id],
        run: () => props.onNavigate(view.id),
      });
    }
    if (active) {
      list.push({ id: "downloads", group: "Navigation", label: "Open Downloads panel", run: props.onOpenDownloads });
      list.push({ id: "changes", group: "Navigation", label: "Open Changes panel", run: props.onOpenChanges });
      list.push({ id: "artifacts", group: "Navigation", label: "Open Artifacts panel", run: props.onOpenArtifacts });
      if (props.onOpenCompare) {
        list.push({ id: "compare", group: "Session", label: "Compare provider models", keywords: "multi model fan out", run: props.onOpenCompare });
      }
      list.push({ id: "workspace-trust", group: "Session", label: "Workspace trust", run: props.onOpenWorkspaceTrust });
      list.push({ id: "session-settings", group: "Session", label: "Session settings (system prompt, fallbacks, budget)", run: props.onOpenSessionSettings });
      list.push({ id: "services", group: "Services", label: "Open Services", run: props.onOpenServices });
      list.push({ id: "inspect", group: "Services", label: "Inspect requests", hint: "raw provider traffic", run: () => setInspecting(true) });
      for (const [mode, label] of MODES) {
        list.push({
          id: `mode:${mode}`,
          group: "Mode",
          label: `Permission mode: ${label}`,
          hint: active.permissionMode === mode ? "current" : undefined,
          run: () => void store().setPermissionMode(mode),
        });
      }
      for (const [value, label] of EFFORTS) {
        list.push({
          id: `effort:${value ?? "default"}`,
          group: "Mode",
          label: `Reasoning effort: ${label}`,
          hint: (active.reasoningEffort ?? null) === value ? "current" : undefined,
          run: () => void store().setEffort(value),
        });
      }
    }
    list.push({ id: "schedules", group: "Services", label: "Scheduled tasks", hint: "recurring prompts", run: () => setScheduling(true) });
    list.push({
      id: "estop",
      group: "Services",
      label: "Emergency stop computer",
      run: () => void agentApi.emergencyStopComputer().catch((cause) => useAgentStore.setState({ notice: errorMessage(cause) })),
    });
    return list;
  }, [sessions, activeId, active, running, splitState, props]);

  const groupCounts = useMemo(() => {
    const counts: Record<PaletteGroup, number> = { Session: 0, Navigation: 0, Mode: 0, Services: 0 };
    for (const act of actions) {
      counts[act.group] = (counts[act.group] || 0) + 1;
    }
    return counts;
  }, [actions]);

  const presentGroups = useMemo(() => {
    return GROUP_ORDER.filter((group) => groupCounts[group] > 0);
  }, [groupCounts]);

  const visible = useMemo(() => {
    if (renaming) return [];
    const scored = actions
      .map((action, order) => ({ action, order, score: actionScore(query, action) }))
      .filter((entry): entry is { action: PaletteAction; order: number; score: number } => entry.score !== null);
    if (query.trim()) {
      scored.sort((a, b) => a.score - b.score || a.order - b.order);
      return scored.map((entry) => entry.action);
    }
    scored.sort((a, b) => GROUP_ORDER.indexOf(a.action.group) - GROUP_ORDER.indexOf(b.action.group) || a.order - b.order);
    return scored
      .filter((entry) => !collapsedGroups[entry.action.group])
      .map((entry) => entry.action);
  }, [actions, query, renaming, collapsedGroups]);

  const selected = Math.min(index, Math.max(visible.length - 1, 0));
  const selectedId = !renaming ? visible[selected]?.id : undefined;

  useEffect(() => {
    if (inspecting || scheduling || !selectedId) return;
    // Scroll only the results viewport, never the page behind the modal.
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !option) return;
    const listBounds = list.getBoundingClientRect();
    const bounds = option.getBoundingClientRect();
    if (bounds.top < listBounds.top) list.scrollTop += bounds.top - listBounds.top;
    else if (bounds.bottom > listBounds.bottom) list.scrollTop += bounds.bottom - listBounds.bottom;
  }, [selectedId, inspecting, scheduling]);

  const run = (action: PaletteAction | undefined) => {
    if (!action) return;
    const keepOpen = action.id === "rename" || action.id === "inspect" || action.id === "schedules";
    action.run();
    if (!keepOpen) onClose();
  };

  const submitRename = () => {
    const title = query.trim();
    if (active && title) void useAgentStore.getState().rename(active.id, title);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (renaming) {
      if (event.key === "Enter") {
        event.preventDefault();
        submitRename();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (visible.length) setIndex((selected + 1) % visible.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (visible.length) setIndex((selected - 1 + visible.length) % visible.length);
    } else if (event.key === "Home" && (!query || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setIndex(0);
    } else if (event.key === "End" && (!query || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setIndex(Math.max(visible.length - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(visible[selected]);
    } else if (event.key === "ArrowLeft") {
      if (!query.trim() && visible[selected]) {
        event.preventDefault();
        const currentGroup = visible[selected]!.group;
        if (!collapsedGroups[currentGroup]) {
          lastCollapsed.current = currentGroup;
          setCollapsedGroups((prev) => ({ ...prev, [currentGroup]: true }));
        }
      }
    } else if (event.key === "ArrowRight") {
      if (!query.trim()) {
        event.preventDefault();
        const groupToExpand =
          lastCollapsed.current && collapsedGroups[lastCollapsed.current]
            ? lastCollapsed.current
            : GROUP_ORDER.find((g) => collapsedGroups[g]);
        if (groupToExpand) {
          setCollapsedGroups((prev) => ({ ...prev, [groupToExpand]: false }));
        }
      }
    }
  };

  const showGroups = !renaming && !query.trim();

  if (scheduling) return <SchedulesDialog onClose={onClose} />;
  if (inspecting && active) return <InspectorDialog sessionId={active.id} onClose={onClose} />;

  return (
    <ModalSurface className="ag-palette" scrimClassName="ag-scrim ag-palette-scrim" ariaLabel="Command palette" onClose={onClose} initialFocusRef={input}>
      <input
        ref={input}
        className="ag-input ag-palette__input"
        role="combobox"
        aria-expanded={!renaming}
        aria-controls={!renaming ? "ag-palette-list" : undefined}
        aria-autocomplete="list"
        aria-activedescendant={!renaming && visible[selected] ? `ag-palette-${visible[selected]!.id}` : undefined}
        aria-label={renaming ? "New session title" : "Search commands"}
        placeholder={renaming ? "New session title, Enter to save" : "Type a command"}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
        onKeyDown={onKeyDown}
      />
      <ul ref={listRef} id="ag-palette-list" className="ag-palette__list" role="listbox" aria-label="Commands" hidden={renaming}>
        {showGroups ? (
          presentGroups.map((group) => {
            const isCollapsed = collapsedGroups[group];
            const groupActions = actions.filter((a) => a.group === group);
            return (
              <Fragment key={`group-section-${group}`}>
                <li key={`group-${group}`} role="presentation" className="ag-palette__group">
                  <button
                    type="button"
                    className="ag-palette__group-toggle"
                    aria-expanded={!isCollapsed}
                    aria-label={`Toggle ${group} category`}
                    onClick={() => toggleGroup(group)}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="ag-palette__chevron" size={12} aria-hidden="true" />
                    ) : (
                      <ChevronDown className="ag-palette__chevron" size={12} aria-hidden="true" />
                    )}
                    <span>{group}</span>
                  </button>
                  <span className="ag-palette__group-count" aria-label={`${groupCounts[group]} actions`}>
                    {groupCounts[group]}
                  </span>
                </li>
                {!isCollapsed
                  ? groupActions.map((action) => {
                      const position = visible.indexOf(action);
                      return (
                        <li key={action.id} role="presentation">
                          <div
                            id={`ag-palette-${action.id}`}
                            role="option"
                            aria-selected={position === selected}
                            className="ag-palette__option ag-palette__option--nested"
                            onMouseMove={() => setIndex(position)}
                            onClick={() => run(action)}
                          >
                            <span className="ag-palette__label">{action.label}</span>
                            {action.hint ? <span className="ag-muted">{action.hint}</span> : null}
                          </div>
                        </li>
                      );
                    })
                  : null}
              </Fragment>
            );
          })
        ) : (
          visible.map((action, position) => (
            <li key={action.id} role="presentation">
              <div
                id={`ag-palette-${action.id}`}
                role="option"
                aria-selected={position === selected}
                className="ag-palette__option"
                onMouseMove={() => setIndex(position)}
                onClick={() => run(action)}
              >
                <span className="ag-palette__label">{action.label}</span>
                {action.hint ? <span className="ag-muted">{action.hint}</span> : null}
              </div>
            </li>
          ))
        )}
        {!renaming && visible.length === 0 ? <li className="ag-palette__group" role="presentation">No matching commands</li> : null}
      </ul>
      <div className="ag-palette__footer" aria-hidden="true">
        <span>↑↓ navigate</span>
        <span>•</span>
        <span>↵ select</span>
        <span>•</span>
        <span>← / → collapse / expand</span>
        <span>•</span>
        <span>Esc close</span>
      </div>
    </ModalSurface>
  );
}
