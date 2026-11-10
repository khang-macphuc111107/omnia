import {
  ChevronDown, ChevronRight, Columns2, GitFork, MoreHorizontal, PanelLeftClose, Pencil, Pin, Plus, Search, Trash2,
} from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { groupByFolder, relativeTime } from "./format";
import { readPrefs, writePrefs } from "./prefs";
import { ConfirmDialog } from "./ui";
import { UpdateBadge } from "./updates";
import type { AgentSessionListItem } from "./types";

type DayBucket = "Today" | "Yesterday" | "Earlier";
const DAY_ORDER: DayBucket[] = ["Today", "Yesterday", "Earlier"];

function dayBucket(ms: number, now: number): DayBucket {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (ms >= today) return "Today";
  if (ms >= today - 86_400_000) return "Yesterday";
  return "Earlier";
}

/**
 * Row actions menu. Positioned fixed and clamped to the viewport so the session list's scroll
 * container never clips it and it never spills off a narrow window.
 */
function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const initialItem = useRef<"first" | "last" | null>(null);

  const menuItems = useCallback(() => Array.from(
    panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])') ?? [],
  ), []);
  const close = useCallback((restoreFocus = false) => {
    initialItem.current = null;
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  const enterMenu = (entry: "first" | "last") => {
    if (open) {
      const items = menuItems();
      (entry === "last" ? items.at(-1) : items[0])?.focus({ preventScroll: true });
    } else {
      initialItem.current = entry;
      setStyle({ visibility: "hidden" });
      setOpen(true);
    }
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = panel.current.offsetWidth;
    const height = panel.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(rect.right - width, vw - width - 8));
    const below = rect.bottom + 4;
    const top = below + height > vh - 8 ? Math.max(8, rect.top - 4 - height) : below;
    setStyle({ left, top });
  }, [open]);

  useLayoutEffect(() => {
    if (!open || style.visibility === "hidden" || !initialItem.current) return;
    const items = menuItems();
    const item = initialItem.current === "last" ? items.at(-1) : items[0];
    initialItem.current = null;
    (item ?? panel.current)?.focus({ preventScroll: true });
  }, [open, style.visibility, menuItems]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const onLayoutChange = (event: Event) => {
      // Scrolling within the menu keeps it open; scrolling its anchor dismisses it.
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("focusin", onOutside);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onLayoutChange);
    document.addEventListener("scroll", onLayoutChange, true);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("focusin", onOutside);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onLayoutChange);
      document.removeEventListener("scroll", onLayoutChange, true);
    };
  }, [open, close]);

  return (
    <span className="ag-session__actions" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="ag-icon-btn ag-session__menu"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) close(true);
          else enterMenu("first");
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            enterMenu(event.key === "ArrowUp" ? "last" : "first");
          }
        }}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div ref={panel} id={menuId} className="ag-session__panel" style={style} role="menu" aria-label={label}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
            if (event.key === "Tab") {
              // Let the browser continue from the trigger in the normal tab order.
              close(true);
              return;
            }
            const items = menuItems();
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
              event.key === "ArrowDown" ? (index + 1) % items.length :
                event.key === "ArrowUp" ? (index - 1 + items.length) % items.length : -1;
            if (next < 0 || !items[next]) return;
            event.preventDefault();
            items[next].focus({ preventScroll: true });
          }}
        >
          {children(() => close(true))}
        </div>
      ) : null}
    </span>
  );
}

function SessionRow({
  session,
  active,
  shown,
  splitOpen,
  unread,
  awaiting,
  pinned,
  onTogglePin,
  onOpen,
  onOpenInSplit,
  onRename,
  onFork,
  onDelete,
}: {
  session: AgentSessionListItem;
  active: boolean;
  /** Visible in the other split pane (not focused). */
  shown: boolean;
  splitOpen: boolean;
  unread: boolean;
  /** A tool call in this session is waiting for the user's approval. */
  awaiting: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  onOpen: () => void;
  onOpenInSplit?: (() => void) | undefined;
  onRename: (title: string) => void;
  onFork: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const title = session.title || "Untitled";

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== session.title) onRename(draft.trim());
  };

  return (
    <li
      className={`ag-session${active ? " ag-session--active" : ""}${shown ? " ag-session--shown" : ""}`}
      onContextMenu={(event) => {
        // Right-click opens the same actions menu as the "..." button.
        const trigger = event.currentTarget.querySelector<HTMLButtonElement>(".ag-session__menu");
        if (!trigger || editing) return;
        event.preventDefault();
        if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
      }}
    >
      {editing ? (
        <input
          className="ag-input ag-session__edit"
          aria-label="Session title"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="ag-session__main"
          aria-current={active ? "true" : undefined}
          onClick={onOpen}
        >
          <span className="ag-session__title" title={title}>{title}</span>
          {shown ? <Columns2 size={12} className="ag-session__split" role="img" aria-label="Open in split" /> : null}
          {awaiting ? <span className="ag-awaiting" role="img" aria-label="Awaiting approval" title="Awaiting approval" /> : null}
          {session.running && !awaiting ? <span className="ag-running" role="img" aria-label="Running" /> : null}
          {!session.running && !awaiting && unread ? <span className="ag-unread" role="img" aria-label="Unread" /> : null}
          <span className="ag-session__time">{relativeTime(session.updatedAtMs)}</span>
        </button>
      )}
      <button
        type="button"
        className={`ag-icon-btn ag-session__pin${pinned ? " ag-session__pin--on" : ""}`}
        aria-label={`${pinned ? "Unpin" : "Pin"} ${title}`}
        aria-pressed={pinned}
        onClick={onTogglePin}
      >
        <Pin size={13} aria-hidden="true" />
      </button>
      <RowMenu label={`Actions for ${title}`}>
        {(close) => (
          <ul className="ag-menu" role="none">
            <li role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="ag-menu__item"
                onClick={() => {
                  close();
                  setDraft(session.title);
                  setEditing(true);
                }}
              >
                <Pencil size={13} aria-hidden="true" /> Rename
              </button>
            </li>
            {onOpenInSplit ? (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="ag-menu__item"
                  disabled={active}
                  title={active ? (splitOpen ? "Already the focused pane" : "Pick another session to split with") : undefined}
                  onClick={() => {
                    close();
                    onOpenInSplit();
                  }}
                >
                  <Columns2 size={13} aria-hidden="true" /> Open in split
                </button>
              </li>
            ) : null}
            <li role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="ag-menu__item"
                onClick={() => {
                  close();
                  onFork();
                }}
              >
                <GitFork size={13} aria-hidden="true" /> Fork
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="ag-menu__item ag-menu__item--warn"
                onClick={() => {
                  close();
                  onDelete();
                }}
              >
                <Trash2 size={13} aria-hidden="true" /> Delete
              </button>
            </li>
          </ul>
        )}
      </RowMenu>
    </li>
  );
}

export function Sidebar({
  sessions,
  activeId,
  visibleIds,
  splitOpen = false,
  onOpenInSplit,
  onNew,
  onOpen,
  onRename,
  onFork,
  onDelete,
  onUpdates,
  onCollapse,
  awaitingIds = [],
}: {
  sessions: AgentSessionListItem[];
  activeId: string | null;
  /** Sessions currently on screen (both split panes); defaults to the active one. */
  visibleIds?: string[];
  splitOpen?: boolean;
  onOpenInSplit?: (id: string) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onFork: (id: string) => void;
  onDelete: (id: string) => void;
  /** Opens Settings > Updates from the "Update available" badge (Settings itself lives in the rail). */
  onUpdates: () => void;
  onCollapse: () => void;
  /** Sessions with a pending tool approval. */
  awaitingIds?: readonly string[];
}) {
  const [query, setQuery] = useState("");
  const [pinned, setPinned] = useState<string[]>(() => readPrefs().pinnedSessions ?? []);
  const [collapsed, setCollapsed] = useState<string[]>(() => readPrefs().collapsedProjects ?? []);
  const [lastSeen, setLastSeen] = useState<Record<string, number>>(() => readPrefs().lastSeen ?? {});
  const [pendingDelete, setPendingDelete] = useState<AgentSessionListItem | null>(null);

  const onScreen = visibleIds ?? (activeId ? [activeId] : []);
  const onScreenKey = onScreen.join("|");
  // Mark the open session(s) as seen; baseline never-tracked sessions so only later activity shows a dot.
  useEffect(() => {
    let next: Record<string, number> | null = null;
    // Forget sessions that no longer exist so the stored map does not grow forever.
    const live = new Set(sessions.map((session) => session.id));
    if (sessions.length > 0 && Object.keys(lastSeen).some((id) => !live.has(id))) {
      next = Object.fromEntries(Object.entries(lastSeen).filter(([id]) => live.has(id)));
    }
    for (const session of sessions) {
      const seen = lastSeen[session.id];
      if (onScreen.includes(session.id) ? seen !== session.updatedAtMs : seen === undefined) {
        next = next ?? { ...lastSeen };
        next[session.id] = session.updatedAtMs;
      }
    }
    if (next) {
      setLastSeen(next);
      writePrefs({ lastSeen: next });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, onScreenKey, lastSeen]);

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle
        ? sessions.filter(
            (s) => (s.title || "Untitled").toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle),
          )
        : sessions,
    [sessions, needle],
  );
  const pinnedSessions = useMemo(
    () => filtered.filter((s) => pinned.includes(s.id)).sort((a, b) => b.updatedAtMs - a.updatedAtMs),
    [filtered, pinned],
  );
  const groups = useMemo(() => {
    const now = Date.now();
    return groupByFolder(filtered.filter((s) => !pinned.includes(s.id))).map((group) => ({
      ...group,
      days: DAY_ORDER.map((label) => ({
        label,
        sessions: group.sessions.filter((s) => dayBucket(s.updatedAtMs, now) === label),
      })).filter((day) => day.sessions.length > 0),
    }));
  }, [filtered, pinned]);

  const togglePin = (id: string) => {
    const next = pinned.includes(id) ? pinned.filter((p) => p !== id) : [id, ...pinned];
    setPinned(next);
    writePrefs({ pinnedSessions: next });
  };
  const toggleCollapsed = (cwd: string) => {
    const next = collapsed.includes(cwd) ? collapsed.filter((c) => c !== cwd) : [...collapsed, cwd];
    setCollapsed(next);
    writePrefs({ collapsedProjects: next });
  };

  const renderRow = (session: AgentSessionListItem) => {
    const seen = lastSeen[session.id];
    return (
      <SessionRow
        key={session.id}
        session={session}
        active={session.id === activeId}
        shown={session.id !== activeId && onScreen.includes(session.id)}
        splitOpen={splitOpen}
        onOpenInSplit={onOpenInSplit ? () => onOpenInSplit(session.id) : undefined}
        unread={!onScreen.includes(session.id) && seen !== undefined && session.updatedAtMs > seen}
        awaiting={awaitingIds.includes(session.id)}
        pinned={pinned.includes(session.id)}
        onTogglePin={() => togglePin(session.id)}
        onOpen={() => onOpen(session.id)}
        onRename={(title) => onRename(session.id, title)}
        onFork={() => onFork(session.id)}
        onDelete={() => setPendingDelete(session)}
      />
    );
  };

  return (
    <aside className="ag-sidebar" aria-label="Sessions">
      <div className="ag-sidebar__top">
        <button type="button" className="ag-btn ag-btn--primary ag-sidebar__new" onClick={onNew}>
          <Plus size={14} aria-hidden="true" /> New chat
        </button>
        <button type="button" className="ag-icon-btn" aria-label="Hide sidebar" onClick={onCollapse}>
          <PanelLeftClose size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="ag-sidebar__search">
        <Search size={13} aria-hidden="true" />
        <input
          type="search"
          className="ag-input ag-sidebar__search-input"
          aria-label="Search sessions"
          placeholder="Search sessions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
      </div>
      <nav className="ag-sidebar__list" aria-label="Session list">
        {sessions.length === 0 ? <p className="ag-muted ag-sidebar__empty">No sessions yet.</p> : null}
        {sessions.length > 0 && filtered.length === 0 ? (
          <p className="ag-muted ag-sidebar__empty">No matching sessions.</p>
        ) : null}
        {pinnedSessions.length > 0 ? (
          <section className="ag-group" aria-label="Pinned">
            <h2 className="ag-group__title">Pinned</h2>
            <ul>{pinnedSessions.map(renderRow)}</ul>
          </section>
        ) : null}
        {groups.map((group) => {
          const open = needle !== "" || !collapsed.includes(group.cwd);
          return (
            <section key={group.cwd} className="ag-group" aria-label={group.name}>
              <h2 className="ag-group__title" title={group.cwd}>
                <button
                  type="button"
                  className="ag-group__toggle"
                  aria-expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${group.name}`}
                  onClick={() => toggleCollapsed(group.cwd)}
                >
                  {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                  <span>{group.name}</span>
                </button>
              </h2>
              {open
                ? group.days.map((day) => (
                    <div key={day.label} className="ag-day">
                      <h3 className="ag-day__title">{day.label}</h3>
                      <ul>{day.sessions.map(renderRow)}</ul>
                    </div>
                  ))
                : null}
            </section>
          );
        })}
      </nav>
      <div className="ag-sidebar__foot"><UpdateBadge onOpen={onUpdates} /></div>
      {pendingDelete ? (
        <ConfirmDialog
          title="Delete session?"
          body={`"${pendingDelete.title || "Untitled"}" and its history will be removed. Files the agent changed are not touched.`}
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            onDelete(pendingDelete.id);
            setPendingDelete(null);
          }}
        />
      ) : null}
    </aside>
  );
}
