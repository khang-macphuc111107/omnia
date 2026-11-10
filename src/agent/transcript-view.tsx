import { CircleAlert, Square, Volume2 } from "lucide-react";
import { createContext, Fragment, lazy, Suspense, useContext, useState, useSyncExternalStore } from "react";

import { useAgentStore } from "./agent-store";
import { ApprovalCard } from "./approval-card";
import { ArtifactCard } from "./artifact-card";
import { DEFAULT_PLAN_APPROVED_MESSAGE, PLAN_TARGET_MODES, PlanCard, type PlanTargetMode } from "./plan-card";
import { readPrefs } from "./prefs";
import { ToolGroup, ToolRow } from "./tool-row";
import { getSpeakingKey, speakMarkdown, speechSynthesisAvailable, stopSpeaking, subscribeSpeaking } from "./voice";
import { groupToolRuns, inlineDiffKey, type LiveState, type ToolItem, type TranscriptItem } from "./transcript";
import type { ApprovalDecision } from "./types";

const Markdown = lazy(() =>
  import("@/features/workspace/markdown").then((module) => ({ default: module.MessageMarkdown })),
);

/** Read-aloud toggle for one finished assistant message (on-device speechSynthesis voices). */
function ReadAloud({ text, speechKey }: { text: string; speechKey: string }) {
  const speakingKey = useSyncExternalStore(subscribeSpeaking, getSpeakingKey, getSpeakingKey);
  if (!speechSynthesisAvailable()) return null;
  const speaking = speakingKey === speechKey;
  return (
    <button
      type="button"
      className="ag-btn ag-btn--ghost ag-read-aloud"
      aria-label={speaking ? "Stop reading aloud" : "Read aloud"}
      aria-pressed={speaking}
      onClick={() => (speaking ? stopSpeaking() : void speakMarkdown(text, speechKey))}
    >
      {speaking ? <Square size={12} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
      {speaking ? "Stop" : "Read aloud"}
    </button>
  );
}

function AssistantText({ text, streaming, itemKey }: { text: string; streaming: boolean; itemKey: string }) {
  const paneId = useContext(PaneSessionContext);
  const sessionId = useAgentStore((state) => paneId ?? state.activeId);
  return (
    <div className="ag-assistant">
      <Suspense fallback={<p className="ag-plain">{text}</p>}>
        <Markdown content={text} streaming={streaming} />
      </Suspense>
      {!streaming && text.trim() ? <ReadAloud text={text} speechKey={`${sessionId ?? ""}:${itemKey}`} /> : null}
    </div>
  );
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <details className="ag-thinking">
      <summary>{streaming ? "Thinking…" : "Thought"}</summary>
      <p className="ag-plain">{text}</p>
    </details>
  );
}

/** The session a transcript belongs to; split panes provide their own. */
const PaneSessionContext = createContext<string | null>(null);

/** Rewind affordance on a user message: conversation only, or conversation and files. */
function RewindControl({ messageIndex }: { messageIndex: number }) {
  const [open, setOpen] = useState(false);
  const paneId = useContext(PaneSessionContext);
  const sessionId = useAgentStore((state) => paneId ?? state.activeId);
  const running = useAgentStore((state) => {
    const id = paneId ?? state.activeId;
    return id ? (state.live[id]?.running ?? false) : false;
  });
  const rewind = useAgentStore((state) => state.rewind);
  if (!sessionId || running) return null;
  const choose = (restoreFiles: boolean) => {
    setOpen(false);
    void rewind(sessionId, messageIndex, restoreFiles);
  };
  return open ? (
    <div className="ag-rewind" role="group" aria-label="Rewind options">
      <button type="button" className="ag-btn" onClick={() => choose(false)}>
        Rewind conversation only
      </button>
      <button type="button" className="ag-btn" onClick={() => choose(true)}>
        Rewind conversation and files
      </button>
      <button type="button" className="ag-btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <span className="ag-muted">Files changed by shell commands cannot be restored.</span>
    </div>
  ) : (
    <button type="button" className="ag-btn ag-rewind-open" aria-label="Rewind to before this message" onClick={() => setOpen(true)}>
      Rewind
    </button>
  );
}

export function ItemList({ items, groupTools = true }: { items: TranscriptItem[]; groupTools?: boolean }) {
  const paneId = useContext(PaneSessionContext);
  const activeId = useAgentStore((state) => state.activeId);
  const sessionId = paneId ?? activeId;
  const openDiffKey = inlineDiffKey(items);
  const renderTool = (item: ToolItem) => (
    <Fragment key={item.key}>
      <ToolRow item={item} defaultOpen={item.key === openDiffKey}>
        {item.sub && item.sub.items.length > 0 ? (
          <div className="ag-nested" aria-label="Subagent activity">
            <ItemList items={item.sub.items} groupTools={!item.sub.running} />
          </div>
        ) : null}
      </ToolRow>
      <ArtifactCard item={item} sessionId={sessionId} />
    </Fragment>
  );
  return (
    <>
      {(groupTools ? groupToolRuns(items) : items).map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.key} className="ag-user">
                {item.images > 0 ? (
                  <span className="ag-muted">
                    {item.images} image{item.images > 1 ? "s" : ""}
                  </span>
                ) : null}
                {item.text ? <p className="ag-plain">{item.text}</p> : null}
                {item.messageIndex !== undefined ? <RewindControl messageIndex={item.messageIndex} /> : null}
              </div>
            );
          case "steer":
            return (
              <div key={item.key} className="ag-user ag-user--steer">
                <span className="ag-muted">Steered</span>
                <p className="ag-plain">{item.text}</p>
              </div>
            );
          case "text":
            return <AssistantText key={item.key} text={item.text} streaming={item.streaming} itemKey={item.key} />;
          case "thinking":
            return <Thinking key={item.key} text={item.text} streaming={item.streaming} />;
          case "tool":
            return renderTool(item);
          case "toolGroup":
            return (
              <ToolGroup key={item.key} group={item}>
                {item.tools.map(renderTool)}
              </ToolGroup>
            );
          case "error":
            return (
              <div key={item.key} className="ag-error" role="alert">
                <span><CircleAlert size={14} className="ag-error__icon" aria-hidden="true" /> <strong className="ag-error__label">Error:</strong> {item.message}</span>
                <span className="ag-muted">Send a message to try again.</span>
              </div>
            );
          case "notice":
            return (
              <div key={item.key} className="ag-notice">
                {item.text}
              </div>
            );
        }
      })}
    </>
  );
}

/**
 * Shown when a Plan-mode run has ended: the plan from `present_plan`, or else
 * the run's final assistant message. Approving switches the permission mode
 * and tells the agent to proceed.
 */
export function PlanProposal({ live, sessionId }: { live: LiveState; sessionId: string | null }) {
  const id = useAgentStore((state) => sessionId ?? state.activeId);
  const mode = useAgentStore((state) => state.sessions.find((entry) => entry.id === id)?.permissionMode);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const last = live.items[live.items.length - 1];
  const plan = live.plan?.text ?? (last?.kind === "text" ? last.text.trim() : "");
  if (!id || mode !== "plan" || live.running || live.runStatus !== "completed" || !plan || dismissed === plan) return null;

  const prefs = readPrefs();
  const initialMode = PLAN_TARGET_MODES.find((entry) => entry === prefs.planApproveMode) ?? "ask_writes";
  const approve = async (target: PlanTargetMode) => {
    setBusy(true);
    try {
      const store = useAgentStore.getState();
      await store.setPermissionMode(target, id);
      // setPermissionMode reports failure through the store notice; continue only if it took effect.
      if (useAgentStore.getState().sessions.find((entry) => entry.id === id)?.permissionMode !== target) return;
      await store.send(prefs.planApprovedMessage?.trim() || DEFAULT_PLAN_APPROVED_MESSAGE, [], id);
    } catch {
      /* the store already surfaced the failure */
    } finally {
      setBusy(false);
    }
  };
  const keepPlanning = (feedback: string) => {
    if (!feedback) {
      setDismissed(plan);
      return;
    }
    setBusy(true);
    void useAgentStore
      .getState()
      .send(feedback, [], id)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return <PlanCard plan={plan} initialMode={initialMode} busy={busy} onApprove={(target) => void approve(target)} onKeepPlanning={keepPlanning} />;
}

export function TranscriptView({
  live,
  onDecide,
  onDecideAll,
  sessionId = null,
  autoFocusApproval = true,
}: {
  live: LiveState;
  onDecide: (toolUseId: string, decision: ApprovalDecision) => void;
  /** "Allow all pending" / "Deny all pending"; omit to hide the batch buttons. */
  onDecideAll?: (toolUseId: string, decision: ApprovalDecision) => void;
  /** Owning session (split panes); defaults to the store's active session. */
  sessionId?: string | null;
  autoFocusApproval?: boolean;
}) {
  const approval = live.approvals[0];
  return (
    <PaneSessionContext.Provider value={sessionId}>
    <div className="ag-transcript" role="log" aria-label="Conversation" aria-live="polite">
      <ItemList items={live.items} groupTools={!live.running} />
      {live.retry ? (
        <div className="ag-notice" role="status">
          Retrying (attempt {live.retry.attempt})…
        </div>
      ) : null}
      {approval ? <ApprovalCard key={approval.tool_use_id} request={approval} onDecide={onDecide} onDecideAll={onDecideAll} autoFocus={autoFocusApproval} /> : null}
      {!approval ? <PlanProposal live={live} sessionId={sessionId} /> : null}
      {live.running && !approval && !live.retry ? (
        <div className="ag-working" role="status">
          Working…
        </div>
      ) : null}
    </div>
    </PaneSessionContext.Provider>
  );
}
