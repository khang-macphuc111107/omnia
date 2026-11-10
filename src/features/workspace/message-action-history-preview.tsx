import { Activity, Clock3, History, Search, Trash2, X } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";

import { ModalSurface } from "@/components/modal-surface";

import {
  clearMessageActionHistory,
  getMessageActionHistory,
  subscribeMessageActionHistory,
  type MessageActionHistoryEntry,
} from "./message-action-history-session";

const ACTION_FILTERS = [
  ["all", "All actions"],
  ["copy", "Copy"],
  ["edit", "Edit"],
  ["branch", "Branch"],
  ["continue", "Continue"],
  ["regenerate", "Regenerate"],
  ["read-aloud", "Read aloud"],
  ["artifact", "Artifact"],
  ["feedback", "Feedback"],
] as const;

function isFeedback(action: MessageActionHistoryEntry["action"]): boolean {
  return action === "feedback-helpful" || action === "feedback-not-helpful";
}

function actionLabel(action: MessageActionHistoryEntry["action"]): string {
  if (action === "feedback-helpful") return "Helpful feedback";
  if (action === "feedback-not-helpful") return "Improvement feedback";
  if (action === "read-aloud") return "Read aloud";
  if (action === "copy-link") return "Copy message link";
  if (action === "quote") return "Quote into composer";
  if (action === "excerpt") return "Preview excerpt";
  return action[0]!.toUpperCase() + action.slice(1);
}

function relativeTime(occurredAt: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(occurredAt));
  if (!Number.isFinite(elapsed)) return "Time unavailable";
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(occurredAt).toLocaleDateString();
}

export function MessageActionHistoryPreview({
  conversationId,
  onInspectMessage,
}: {
  conversationId: string;
  onInspectMessage?: (messageId: string) => void;
}) {
  const allEntries = useSyncExternalStore(
    subscribeMessageActionHistory,
    getMessageActionHistory,
    getMessageActionHistory,
  );
  const entries = useMemo(
    () => allEntries.filter((entry) => entry.conversationId === conversationId),
    [allEntries, conversationId],
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<(typeof ACTION_FILTERS)[number][0]>("all");

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      const matchesAction = actionFilter === "all"
        || (actionFilter === "feedback" ? isFeedback(entry.action) : entry.action === actionFilter);
      const matchesQuery = !needle || `${entry.label} ${entry.role} ${entry.messageId} ${entry.action}`
        .toLocaleLowerCase()
        .includes(needle);
      return matchesAction && matchesQuery;
    });
  }, [actionFilter, entries, query]);

  return (
    <>
      <button
        type="button"
        className="message-action-history-trigger"
        aria-label={`Message action history, ${entries.length} actions`}
        title="Message action history"
        onClick={() => setOpen(true)}
      >
        <History size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <ModalSurface
          className="message-action-history"
          ariaLabel="Message action history"
          title="Message action history"
          description="Review reversible, renderer-session actions for this Chat."
          onClose={() => setOpen(false)}
        >
          <header className="message-action-history__header">
            <div>
              <span className="eyebrow"><Activity size={12} /> Chat activity</span>
              <h2>Message action history</h2>
              <p>{entries.length} recent actions · newest first · message content is not recorded</p>
            </div>
            <button type="button" className="icon-button" aria-label="Close message action history" onClick={() => setOpen(false)}><X size={16} /></button>
          </header>
          <div className="message-action-history__tools">
            <label className="message-action-history__search">
              <Search size={14} aria-hidden="true" />
              <input aria-label="Search message action history" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search actions or message ID" />
            </label>
            <label className="message-action-history__filter">
              <span>Action</span>
              <select aria-label="Filter message action history" value={actionFilter} onChange={(event) => setActionFilter(event.target.value as typeof actionFilter)}>
                {ACTION_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <button type="button" className="button button--ghost" onClick={() => clearMessageActionHistory(conversationId)} disabled={entries.length === 0}><Trash2 size={13} /> Clear Chat history</button>
          </div>
          <div className="message-action-history__list" role="list" aria-label="Message action history entries">
            {visibleEntries.map((entry) => (
              <article key={entry.id} className="message-action-history__entry" role="listitem">
                <span className={`message-action-history__role message-action-history__role--${entry.role}`} aria-hidden="true">{entry.role === "assistant" ? "A" : "Y"}</span>
                <div className="message-action-history__copy">
                  <strong>{entry.label || actionLabel(entry.action)}</strong>
                  <span>{entry.role === "assistant" ? "Assistant" : "You"} · {actionLabel(entry.action)} · <code>{entry.messageId}</code></span>
                </div>
                <time dateTime={entry.occurredAt} title={new Date(entry.occurredAt).toLocaleString()}><Clock3 size={12} />{relativeTime(entry.occurredAt)}</time>
                {onInspectMessage ? <button type="button" className="button button--ghost" onClick={() => { onInspectMessage(entry.messageId); setOpen(false); }}>Inspect</button> : null}
              </article>
            ))}
            {visibleEntries.length === 0 ? (
              <div className="message-action-history__empty" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "4px" }}>
                <History size={19} />
                <strong>{entries.length ? "No matching actions" : "No message actions yet"}</strong>{" "}
                <span>{entries.length ? "Adjust the search or action filter." : "Copy, edit, branch, or review a message to begin this local timeline."}</span>
              </div>
            ) : null}
          </div>
          <footer className="message-action-history__boundary">Renderer-session only · no durable audit log, provider telemetry, or message body is stored.</footer>
        </ModalSurface>
      ) : null}
    </>
  );
}
