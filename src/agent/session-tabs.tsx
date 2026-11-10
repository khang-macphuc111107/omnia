import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import type { AgentSessionListItem } from "./types";
import { folderName } from "./format";
import "./session-tabs.css";

export interface SessionTabsProps {
  sessions: readonly AgentSessionListItem[];
  openIds: readonly string[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
}

/** Browser-like session tabs. Closing a tab only closes the view; it never deletes the native session. */
export function SessionTabs({ sessions, openIds, activeId, onOpen, onNew, onClose }: SessionTabsProps) {
  const tabs = useMemo(() => openIds.map((id) => sessions.find((session) => session.id === id)).filter((session): session is AgentSessionListItem => Boolean(session)), [openIds, sessions]);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const newTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (activeId && !openIds.includes(activeId)) onOpen(activeId);
  }, [activeId, onOpen, openIds]);

  const focusTab = (index: number) => {
    const target = tabs[(index + tabs.length) % tabs.length];
    if (target) tabRefs.current[target.id]?.focus();
  };

  const closeTab = (id: string, index: number) => {
    // Move focus before the current view is removed. The tab strip remains
    // keyboard reachable even when its last open view closes to Home.
    const fallback = tabs[index - 1] ?? tabs[index + 1];
    if (fallback) tabRefs.current[fallback.id]?.focus();
    else newTabRef.current?.focus();
    onClose(id);
  };

  return (
    <nav className="ag-session-tabs" aria-label="Open sessions">
      <div className="ag-session-tabs__list" role="tablist" aria-orientation="horizontal">
        {tabs.map((session, index) => {
          const selected = session.id === activeId;
          const title = session.title || "Untitled";
          return (
            <div className={`ag-session-tab${selected ? " ag-session-tab--active" : ""}`} key={session.id} role="presentation">
              <button
                ref={(element) => { tabRefs.current[session.id] = element; }}
                type="button"
                role="tab"
                id={`session-tab-${session.id}`}
                aria-selected={selected}
                // Unselected views are lazy and have no mounted panel.
                aria-controls={selected ? `session-panel-${session.id}` : undefined}
                tabIndex={selected || (activeId === null && index === 0) ? 0 : -1}
                title={`${title}\n${session.cwd}`}
                onClick={() => onOpen(session.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") { event.preventDefault(); focusTab(index + 1); }
                  else if (event.key === "ArrowLeft") { event.preventDefault(); focusTab(index - 1); }
                  else if (event.key === "Home") { event.preventDefault(); focusTab(0); }
                  else if (event.key === "End") { event.preventDefault(); focusTab(tabs.length - 1); }
                  else if (event.key === "Delete" || (event.key.toLowerCase() === "w" && (event.ctrlKey || event.metaKey))) { event.preventDefault(); closeTab(session.id, index); }
                }}
              >
                <span className="ag-session-tab__status" aria-hidden="true" data-running={session.running ? "true" : "false"} />
                <span className="ag-session-tab__label">{title}</span>
                <span className="ag-session-tab__folder">{folderName(session.cwd)}</span>
              </button>
              <button type="button" className="ag-session-tab__close" aria-label={`Close ${title} tab`} title="Close tab" onClick={() => closeTab(session.id, index)}>
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <button ref={newTabRef} type="button" className="ag-session-tabs__new" aria-label="New session tab" title="New session" onClick={onNew}><Plus size={14} aria-hidden="true" /></button>
    </nav>
  );
}
