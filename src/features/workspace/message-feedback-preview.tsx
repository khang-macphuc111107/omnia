import { Check, CircleAlert, MessageSquareText, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { recordMessageAction } from "./message-action-history-session";

type FeedbackChoice = "helpful" | "not-helpful";

const QUICK_REASONS = {
  helpful: [
    ["accurate", "Accurate"],
    ["concise", "Concise"],
    ["well-structured", "Well structured"],
    ["actionable", "Actionable"],
  ],
  "not-helpful": [
    ["incomplete", "Incomplete"],
    ["incorrect", "Incorrect"],
    ["off-topic", "Off-topic"],
    ["too-verbose", "Too verbose"],
  ],
} as const satisfies Record<FeedbackChoice, readonly (readonly [string, string])[]>;

export function MessageFeedbackPreview({ messageId, conversationId }: { messageId: string; conversationId?: string }) {
  const [choice, setChoice] = useState<FeedbackChoice | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const boundaryId = useId();

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>("button, textarea")?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = (next: FeedbackChoice, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setChoice(next);
    setReason(null);
    setStatus(null);
    setOpen(true);
  };

  const clear = () => {
    setChoice(null);
    setReason(null);
    setNote("");
    setOpen(false);
    setStatus("Feedback preview cleared in this renderer session.");
  };

  const submit = () => {
    if (!choice) return;
    const label = choice === "helpful" ? "Helpful" : "Not helpful";
    if (conversationId) {
      recordMessageAction({
        conversationId,
        messageId,
        role: "assistant",
        action: choice === "helpful" ? "feedback-helpful" : "feedback-not-helpful",
        label: `${label} feedback preview recorded`,
      });
    }
    setOpen(false);
    setStatus(`${label} feedback preview recorded for this message; no telemetry or native write was sent.`);
    triggerRef.current?.focus();
  };

  return (
    <div className="message-feedback" data-message-id={messageId}>
      <button
        type="button"
        className={choice === "helpful" ? "message-feedback__button message-feedback__button--active" : "message-feedback__button"}
        aria-label="Helpful (renderer preview)"
        aria-pressed={choice === "helpful"}
        aria-controls={open ? panelId : undefined}
        aria-expanded={open && choice === "helpful"}
        title="Mark helpful in this renderer session"
        onClick={(event) => choose("helpful", event.currentTarget)}
      >
        <ThumbsUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={choice === "not-helpful" ? "message-feedback__button message-feedback__button--active message-feedback__button--negative" : "message-feedback__button"}
        aria-label="Not helpful (renderer preview)"
        aria-pressed={choice === "not-helpful"}
        aria-controls={open ? panelId : undefined}
        aria-expanded={open && choice === "not-helpful"}
        title="Mark not helpful in this renderer session"
        onClick={(event) => choose("not-helpful", event.currentTarget)}
      >
        <ThumbsDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <section
          ref={panelRef}
          id={panelId}
          className="message-feedback__panel"
          role="dialog"
          aria-modal="false"
          aria-label="Message feedback preview"
          aria-describedby={boundaryId}
        >
          <header className="message-feedback__panel-header">
            <div>
              <span className="eyebrow">Renderer-local feedback</span>
              <strong>
                {choice === "helpful" ? "What worked?" : "What should improve?"}
              </strong>
            </div>
            <button
              type="button"
              className="icon-button icon-button--small"
              aria-label="Close feedback preview"
              title="Close feedback preview"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </header>
          <div className="message-feedback__reasons" role="group" aria-label="Feedback reasons">
            {QUICK_REASONS[choice ?? "helpful"].map(([value, label]) => (
              <button
                key={value}
                  type="button"
                  className={reason === value ? "message-feedback__reason message-feedback__reason--active" : "message-feedback__reason"}
                  aria-pressed={reason === value}
                  title={`${reason === value ? "Remove" : "Choose"} feedback reason: ${label}`}
                  onClick={() => setReason((current) => (current === value ? null : value))}
              >
                {reason === value ? <Check size={12} aria-hidden="true" /> : null}
                {label}
              </button>
            ))}
          </div>
          <label className="message-feedback__note">
            <span>Optional note</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add a short note for your own review…"
              aria-label="Feedback note (renderer preview)"
              rows={3}
            />
          </label>
          <p id={boundaryId} className="message-feedback__boundary" role="note">
            <CircleAlert size={13} aria-hidden="true" />
            <span>Preview only: this does not send telemetry, call a provider, or persist feedback natively.</span>
          </p>
          <footer className="message-feedback__panel-actions">
            <button type="button" className="button button--ghost" onClick={clear} title="Clear this feedback draft">
              Clear
            </button>
            <button type="button" className="button button--primary" onClick={submit} title="Save this feedback in the renderer preview">
              <MessageSquareText size={14} aria-hidden="true" /> Save preview
            </button>
          </footer>
        </section>
      ) : null}
      {status ? (
        <span className="message-feedback__status" role="status" aria-live="polite">
          {status}
        </span>
      ) : null}
    </div>
  );
}
