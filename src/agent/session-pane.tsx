import { ArrowLeftRight, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { useAgentStore } from "./agent-store";
import { Composer } from "./composer";
import { folderName } from "./format";
import { RecoveryNotice } from "./recovery-notice";
import { TranscriptView } from "./transcript-view";

/**
 * One session's transcript + composer. Subscribes only to its own session, so several panes can be
 * visible at once; every action it issues is addressed to `sessionId`, never to the focused one.
 */
export function SessionPane({
  sessionId,
  focused,
  split,
  onFocus,
  onClose,
  onSwap,
}: {
  sessionId: string;
  focused: boolean;
  /** True when shown beside another pane: adds a pane header and focus handling. */
  split: boolean;
  onFocus?: () => void;
  onClose?: () => void;
  onSwap?: () => void;
}) {
  const session = useAgentStore((s) => s.sessions.find((entry) => entry.id === sessionId));
  const state = useAgentStore((s) => s.live[sessionId]);
  const notice = useAgentStore((s) => (focused ? s.notice : null));
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Keep the newest content in view unless the reader scrolled away (per pane).
  const itemCount = state?.items.length ?? 0;
  const tail = state?.items[itemCount - 1];
  const tailSize = tail && "text" in tail ? tail.text.length : 0;
  const pending = state?.approvals[0];
  useEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [sessionId, itemCount, tailSize, pending]);

  // Content can grow without new items (tool output, wrapping after a resize, late markdown): follow it too.
  useEffect(() => {
    stick.current = true;
    const element = scroller.current;
    const content = element?.firstElementChild;
    if (!element || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stick.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [sessionId, Boolean(state)]);

  // When a split pane becomes focused, move the keyboard into it: a waiting approval first, else the composer.
  const hasApproval = Boolean(pending);
  useEffect(() => {
    if (!split || !focused) return;
    const el = root.current;
    if (!el || el.contains(document.activeElement)) return;
    const target = el.querySelector<HTMLElement>(hasApproval ? ".ag-approval" : ".ag-composer__input");
    target?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, split]);

  const title = session?.title || "Untitled";
  const body =
    session && state ? (
      <>
        <div
          className="ag-scroll"
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <TranscriptView
            live={state}
            sessionId={sessionId}
            autoFocusApproval={!split || focused}
            onDecide={(id, decision) => void useAgentStore.getState().decide(id, decision, sessionId).catch(() => undefined)}
            onDecideAll={(id, decision) => void useAgentStore.getState().decideAll(id, decision, sessionId).catch(() => undefined)}
          />
        </div>
        {notice ? (
          <p className="ag-error ag-notice-bar" role="alert">
            {notice}
          </p>
        ) : null}
        <RecoveryNotice key={`recovery:${sessionId}`} live={state} onFork={() => useAgentStore.getState().fork(sessionId)} />
        <Composer
          key={sessionId}
          autoFocus={!split || focused}
          blocked={state.recoveryRequired}
          session={session}
          running={state.running}
          onSend={(text, images) => useAgentStore.getState().send(text, images, sessionId)}
          onStop={() => void useAgentStore.getState().interrupt(sessionId)}
          onModel={(model) => void useAgentStore.getState().setModel(model, undefined, sessionId)}
          onMode={(mode) => void useAgentStore.getState().setPermissionMode(mode, sessionId)}
        />
      </>
    ) : (
      <div className="ag-empty" role="status">
        <p className="ag-muted">{session ? "Loading…" : "This session is no longer available."}</p>
      </div>
    );

  if (!split) {
    return (
      <div id={`session-panel-${sessionId}`} role="tabpanel" aria-labelledby={`session-tab-${sessionId}`} aria-label={`Session ${title}`} className="ag-pane" ref={root}>
        {body}
      </div>
    );
  }

  return (
    <section
      id={`session-panel-${sessionId}`}
      role="tabpanel"
      aria-labelledby={`session-tab-${sessionId}`}
      ref={root}
      className={`ag-pane ag-pane--split${focused ? " ag-pane--focused" : ""}`}
      aria-label={`Session ${title}`}
      data-focused={focused ? "true" : "false"}
      onMouseDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      <header className="ag-pane__head">
        <span className="ag-pane__title" title={session?.cwd}>
          {title}
          {session ? <span className="ag-muted"> · {folderName(session.cwd)}</span> : null}
        </span>
        {focused ? <span className="ag-pane__badge">Focused</span> : null}
        {state ? <span className="ag-muted" aria-label="Run status">{state.runStatus}</span> : null}
        <span className="ag-spacer" />
        <button type="button" className="ag-icon-btn" aria-label={`Swap panes (moves ${title})`} title="Swap panes" onClick={onSwap}>
          <ArrowLeftRight size={14} aria-hidden="true" />
        </button>
        <button type="button" className="ag-icon-btn" aria-label={`Close pane ${title}`} title="Close pane" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      {body}
    </section>
  );
}
