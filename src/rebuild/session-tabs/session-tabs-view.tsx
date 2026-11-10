import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import type { ChatController } from "../chat/chat-controller";
import { SessionTabsCoordinator, type NavigationBridge, type SessionTabsState } from "./session-tabs";
import "./session-tabs.css";

export interface SessionTabItem {
  id: string;
  title: string;
  scope: "project" | "non-project";
  active: boolean;
  localOnly: boolean;
  running: boolean;
}

export interface SessionTabsModel extends SessionTabsState {
  tabs: readonly SessionTabItem[];
  selectSession: (id: string) => void;
  closeSession: (id: string) => void;
  moveSession: (id: string, index: number) => void;
  createSession: (cwd?: string) => Promise<ChatController["activeSession"]>;
  reload: () => Promise<void>;
  cancelPending: () => void;
  useSavedTabs: () => void;
  saveCurrentTabs: () => void;
}

export interface SessionTabsControllerResult {
  model: SessionTabsModel;
  /** Contract-preserving controller with navigation intercepted for tab open. */
  controller: ChatController;
  coordinator: SessionTabsCoordinator;
}

export function useSessionTabs(controller: ChatController, bridge?: NavigationBridge): SessionTabsControllerResult {
  const coordinator = useMemo(() => new SessionTabsCoordinator(bridge), [bridge]);
  const state = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);

  useEffect(() => {
    coordinator.activate();
    return () => coordinator.suspend();
  }, [coordinator]);
  useEffect(() => { coordinator.updateController(controller); }, [controller, coordinator]);

  // A controller object is intentionally a per-render projection. The
  // coordinator keeps the native navigation contract out of ChatController.
  const intercepted = useMemo<ChatController>(() => ({
    ...controller,
    selectSession: coordinator.selectSession,
    createSession: coordinator.createSession,
  }), [controller, coordinator]);

  const tabs = useMemo<readonly SessionTabItem[]>(() => state.openIds.map((id) => {
    const session = controller.sessions.find((value) => value.id === id) ?? coordinator.getSession(id);
    return {
      id,
      title: session?.title || "Loading conversation",
      scope: session?.scope ?? "non-project",
      active: id === state.activeId,
      localOnly: session?.localOnly === true,
      running: session?.running === true,
    };
  }), [controller.sessions, coordinator, state.activeId, state.openIds]);

  const model = useMemo<SessionTabsModel>(() => ({
    ...state,
    tabs,
    selectSession: coordinator.selectSession,
    closeSession: (id) => { coordinator.closeSession(id); },
    moveSession: coordinator.moveSession,
    createSession: coordinator.createSession,
    reload: coordinator.reload,
    cancelPending: coordinator.cancelPending,
    useSavedTabs: coordinator.useSavedTabs,
    saveCurrentTabs: coordinator.saveCurrentTabs,
  }), [coordinator, state, tabs]);

  return { model, controller: intercepted, coordinator };
}

export interface SessionTabStripProps {
  model: SessionTabsModel;
  ariaLabel?: string;
}

function phaseLabel(model: SessionTabsModel): string {
  if (model.phase === "loading") return "Restoring tabs…";
  if (model.phase === "saving") return "Saving tab order…";
  if (model.phase === "conflict") return "Another window changed the tab order";
  if (model.phase === "error") return "Tab persistence unavailable";
  if (model.phase === "cancelled") return "Tab restore stopped";
  if (model.source === "preview") return "Preview tabs · not saved to native";
  if (model.phase === "waiting") return "Waiting for native conversation history";
  return model.source === "native" && model.receiptId ? `Saved · revision ${model.revision}` : "Session tabs";
}

export function SessionTabStrip({ model, ariaLabel = "Open sessions" }: SessionTabStripProps) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const first = model.tabs[0];
  const last = model.tabs[model.tabs.length - 1];
  const focusTab = (id: string) => { tabRefs.current.get(id)?.focus(); };
  useLayoutEffect(() => {
    if (pendingFocus.current) { focusTab(pendingFocus.current); pendingFocus.current = null; }
  }, [model.tabs]);
  const closeTab = (id: string) => {
    if (model.tabs.length <= 1) return;
    const index = model.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const active = model.tabs.find((tab) => tab.active && tab.id !== id);
    const next = active ?? model.tabs[index + 1] ?? model.tabs[index - 1];
    if (next) { pendingFocus.current = next.id; focusTab(next.id); }
    model.closeSession(id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("[role=tab]") : null;
    if (!current || !first || !last) return;
    const index = model.tabs.findIndex((tab) => tab.id === current.dataset.sessionTab);
    if (index < 0) return;
    const choose = (id: string) => { model.selectSession(id); focusTab(id); };
    if (event.ctrlKey && event.shiftKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault(); model.moveSession(model.tabs[index]!.id, index + (event.key === "ArrowLeft" ? -1 : 1)); return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault(); choose(model.tabs[(index + 1) % model.tabs.length]?.id ?? first.id);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault(); choose(model.tabs[(index - 1 + model.tabs.length) % model.tabs.length]?.id ?? first.id);
    } else if (event.key === "Home") {
      event.preventDefault(); choose(first.id);
    } else if (event.key === "End") {
      event.preventDefault(); choose(last.id);
    } else if (event.key === "Delete") {
      event.preventDefault(); if (current.dataset.sessionTab) closeTab(current.dataset.sessionTab);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); if (current.dataset.sessionTab) model.selectSession(current.dataset.sessionTab);
    }
  };

  return <section className="rb-session-tabs" aria-label={ariaLabel} data-phase={model.phase} data-source={model.source}>
    <div className="rb-session-tabs__bar">
      <div className="rb-session-tabs__tablist" role={model.tabs.length ? "tablist" : undefined} aria-label={model.tabs.length ? ariaLabel : undefined} onKeyDown={onKeyDown}>
      {model.tabs.map((tab) => <button
        key={tab.id}
        ref={(element) => { if (element) tabRefs.current.set(tab.id, element); else tabRefs.current.delete(tab.id); }}
        type="button"
        role="tab"
        tabIndex={tab.active ? 0 : -1}
        aria-selected={tab.active}
        aria-label={`${tab.title}${tab.scope === "project" ? " · project" : " · non-project"}${tab.localOnly ? " · preview only" : ""}`}
        data-session-tab={tab.id}
        aria-keyshortcuts="Delete Control+Shift+ArrowLeft Control+Shift+ArrowRight"
        className={`rb-session-tab${tab.active ? " is-active" : ""}`}
        onClick={() => model.selectSession(tab.id)}
      >
        <span className="rb-session-tab__scope" aria-hidden="true">{tab.scope === "project" ? "P" : "C"}</span>
        <span className="rb-session-tab__title">{tab.title}</span>
        {tab.running ? <span className="rb-session-tab__running" aria-label="running">●</span> : null}
      </button>)}
      {!model.tabs.length ? <span className="rb-session-tabs__empty">No open sessions</span> : null}
      </div>
      <div className="rb-session-tabs__close-actions" role="group" aria-label="Session tab actions">
        {model.tabs.map((tab) => <button key={`close-${tab.id}`} type="button" className="rb-session-tab__close" aria-label={`Close ${tab.title} session tab`} disabled={model.tabs.length <= 1} title={model.tabs.length <= 1 ? `Keep ${tab.title} open` : `Close ${tab.title} view · conversation is kept`} onClick={() => closeTab(tab.id)}><X size={13} aria-hidden="true" /></button>)}
      </div>
    </div>
    <div className="rb-session-tabs__status" role="status" aria-live="polite">
      <span className="rb-session-tabs__phase">{phaseLabel(model)}</span>
      {model.receiptId ? <code className="rb-session-tabs__receipt" title={`Native navigation receipt ${model.receiptId}`}>{model.receiptId}</code> : null}
      {model.source === "native" && model.tabs.some((tab) => tab.localOnly) ? <span>Local draft tabs are not saved</span> : null}
      {model.phase === "loading" || model.phase === "saving" ? <button type="button" className="rb-session-tabs__action" onClick={model.cancelPending}>Stop</button> : null}
      {model.phase === "error" || model.phase === "cancelled" ? <button type="button" className="rb-session-tabs__action" onClick={() => void model.reload()}>Reload native tabs</button> : null}
      {model.phase === "conflict" ? <><button type="button" className="rb-session-tabs__action" onClick={model.useSavedTabs}>Use saved tabs</button><button type="button" className="rb-session-tabs__action" onClick={model.saveCurrentTabs}>Save current tabs</button></> : null}
    </div>
    {model.error ? <p className="rb-session-tabs__feedback" role="alert">{model.error}</p> : null}
  </section>;
}

export { SessionTabsCoordinator } from "./session-tabs";
export type { NavigationBridge, NavigationSnapshot, SaveNavigationRequest, SessionTabsState } from "./session-tabs";
