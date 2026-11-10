import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { prettyJson } from "./format";
import type { ApprovalDecision, ApprovalPreview, ApprovalRequest } from "./types";

/** Tools that only read or search; every other pending tool counts as destructive when batch-approved. */
const SAFE_TOOLS = /^(read_file|list_dir|glob|grep|git_(status|diff|log|show)|sqlite_query|todo_write|present_plan|web_search|web_fetch)$/;

export function isRiskyTool(tool: string): boolean {
  return !SAFE_TOOLS.test(tool);
}

interface FieldSpec {
  key: string;
  label: string;
  multiline?: boolean;
}

/** Friendly editors for common tools; anything else is edited as JSON. */
const FIELDS: Record<string, FieldSpec[]> = {
  shell: [{ key: "command", label: "Command", multiline: true }],
  write_file: [
    { key: "path", label: "File path" },
    { key: "content", label: "Content", multiline: true },
  ],
  edit_file: [
    { key: "path", label: "File path" },
    { key: "old_string", label: "Text to replace", multiline: true },
    { key: "new_string", label: "Replacement", multiline: true },
  ],
  read_file: [{ key: "path", label: "File path" }],
  list_dir: [{ key: "path", label: "Folder path" }],
  git_commit: [{ key: "message", label: "Commit message", multiline: true }],
  web_fetch: [{ key: "url", label: "URL" }],
  http_request: [{ key: "url", label: "URL" }],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses editor text into a tool input: it must be a JSON object. */
export function parseToolInput(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) return { ok: false, error: "The input must be a JSON object, like {\"key\": \"value\"}." };
    return { ok: true, value };
  } catch (cause) {
    return { ok: false, error: `Not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function InputEditor({
  tool,
  input,
  onChange,
}: {
  tool: string;
  input: unknown;
  /** Reports the edited input, or null while the editor holds something invalid. */
  onChange: (value: Record<string, unknown> | null) => void;
}) {
  const specs = isObject(input) ? (FIELDS[tool] ?? []).filter((spec) => typeof input[spec.key] === "string") : [];
  const [asJson, setAsJson] = useState(specs.length === 0);
  const [fields, setFields] = useState<Record<string, unknown>>(isObject(input) ? input : {});
  const [text, setText] = useState(() => prettyJson(input));
  const [error, setError] = useState<string | null>(null);

  const setField = (key: string, value: string) => {
    const next = { ...fields, [key]: value };
    setFields(next);
    setText(prettyJson(next));
    onChange(next);
  };
  const setJson = (value: string) => {
    setText(value);
    const parsed = parseToolInput(value);
    setError(parsed.ok ? null : parsed.error);
    if (parsed.ok) setFields(parsed.value);
    onChange(parsed.ok ? parsed.value : null);
  };

  return (
    <div className="ag-approval__editor">
      {!asJson ? (
        specs.map((spec) => (
          <label key={spec.key} className="ag-field">
            <span className="ag-label">{spec.label}</span>
            {spec.multiline ? (
              <textarea
                className="ag-input ag-approval__edit-field"
                data-approval-edit
                aria-label={spec.label}
                rows={spec.key === "content" ? 8 : 3}
                value={String(fields[spec.key] ?? "")}
                onChange={(event) => setField(spec.key, event.target.value)}
              />
            ) : (
              <input
                className="ag-input"
                data-approval-edit
                aria-label={spec.label}
                value={String(fields[spec.key] ?? "")}
                onChange={(event) => setField(spec.key, event.target.value)}
              />
            )}
          </label>
        ))
      ) : (
        <label className="ag-field">
          <span className="ag-label">Input (JSON)</span>
          <textarea
            className="ag-input ag-approval__edit-field"
            data-approval-edit
            aria-label="Tool input (JSON)"
            aria-invalid={error !== null}
            spellCheck={false}
            rows={Math.min(14, Math.max(4, text.split("\n").length))}
            value={text}
            onChange={(event) => setJson(event.target.value)}
          />
        </label>
      )}
      {error ? (
        <p className="ag-error" role="alert">
          {error}
        </p>
      ) : null}
      {specs.length > 0 ? (
        <button
          type="button"
          className="ag-link"
          onClick={() => {
            if (asJson) {
              const parsed = parseToolInput(text);
              if (!parsed.ok) {
                setError(parsed.error);
                return;
              }
              setFields(parsed.value);
            }
            setAsJson(!asJson);
          }}
        >
          {asJson ? "Edit as fields" : "Edit as JSON"}
        </button>
      ) : null}
    </div>
  );
}

type Batch = "allow" | "deny";

export function ApprovalCard({
  request,
  onDecide,
  onDecideAll,
  autoFocus = true,
}: {
  request: ApprovalRequest;
  /** Grab keyboard focus on mount; a card in an unfocused split pane must not steal it. */
  autoFocus?: boolean;
  onDecide: (toolUseId: string, decision: ApprovalDecision) => void;
  /** Answer this approval and every one queued behind it. Omit to hide the batch buttons. */
  onDecideAll?: ((toolUseId: string, decision: ApprovalDecision) => void) | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [showInput, setShowInput] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState<Record<string, unknown> | null>(null);
  const [confirm, setConfirm] = useState<Batch | null>(null);

  useEffect(() => {
    if (autoFocus) root.current?.focus({ preventScroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const queue: ApprovalPreview[] = useMemo(
    () => [{ tool_use_id: request.tool_use_id, tool: request.tool, input: request.input, summary: request.summary }, ...(request.remaining ?? [])],
    [request],
  );
  const batchable = Boolean(onDecideAll) && queue.length > 1;
  const risky = queue.some((entry) => isRiskyTool(entry.tool));

  const decide = (decision: ApprovalDecision) => onDecide(request.tool_use_id, decision);
  const deny = () => decide({ type: "deny", feedback: feedback.trim() || null });
  const decision = (kind: Batch): ApprovalDecision =>
    kind === "allow" ? { type: "allow_once" } : { type: "deny", feedback: feedback.trim() || null };
  const batch = (kind: Batch) => {
    if (!onDecideAll) return;
    if (risky && confirm !== kind) {
      setConfirm(kind);
      return;
    }
    onDecideAll(request.tool_use_id, decision(kind));
  };

  const changed = edited !== null && !sameJson(edited, request.input);
  const allowEdited = () => {
    if (!edited) return;
    decide(changed ? { type: "allow_edited", input: edited } : { type: "allow_once" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (confirm && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setConfirm(null);
      return;
    }
    if (batchable && event.ctrlKey && event.shiftKey) {
      if (event.key === "Enter") {
        event.preventDefault();
        batch("allow");
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        batch("deny");
        return;
      }
    }
    if (target.hasAttribute("data-approval-edit")) {
      if (event.key === "Escape") {
        // Leave the editor without deciding anything.
        event.preventDefault();
        event.stopPropagation();
        setEditing(false);
        root.current?.focus();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && edited) {
        event.preventDefault();
        allowEdited();
      }
      return;
    }
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      if (event.key === "Escape") {
        // Close the feedback field instead of denying outright.
        event.preventDefault();
        event.stopPropagation();
        setShowFeedback(false);
        root.current?.focus();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        deny();
      }
      return;
    }
    if (event.key === "Enter" && target.tagName !== "BUTTON" && target.tagName !== "SUMMARY") {
      event.preventDefault();
      if (editing && edited) allowEdited();
      else if (!editing) decide({ type: "allow_once" });
    }
  };

  const startEditing = () => {
    setEditing(true);
    setEdited(isObject(request.input) ? request.input : {});
  };

  return (
    <div
      ref={root}
      className="ag-approval"
      role="group"
      aria-label="Approval required"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="ag-approval__head">
        <strong>Allow {request.tool}?</strong>
        {request.total > 1 ? (
          <span className="ag-muted">
            {request.ordinal} of {request.total}
          </span>
        ) : null}
      </div>
      <p className="ag-approval__summary">{request.summary || request.tool}</p>
      <button
        type="button"
        className="ag-link"
        aria-expanded={showInput}
        onClick={() => setShowInput(!showInput)}
      >
        {showInput ? "Hide input" : "Show input"}
      </button>
      {showInput && !editing ? <pre className="ag-pre">{prettyJson(request.input)}</pre> : null}
      {editing ? <InputEditor tool={request.tool} input={request.input} onChange={setEdited} /> : null}
      {showFeedback ? (
        <textarea
          className="ag-input ag-approval__feedback"
          aria-label="Feedback for the agent"
          placeholder="Tell the agent what to do instead (sent with Deny)"
          value={feedback}
          rows={2}
          autoFocus
          onChange={(event) => setFeedback(event.target.value)}
        />
      ) : null}
      {confirm ? (
        <div className="ag-approval__confirm" role="alertdialog" aria-label="Confirm batch decision">
          <p>
            {confirm === "allow" ? "Allow" : "Deny"} all {queue.length} pending requests, including{" "}
            {queue
              .filter((entry) => isRiskyTool(entry.tool))
              .slice(0, 3)
              .map((entry) => entry.tool)
              .join(", ")}
            ?
          </p>
          <ul className="ag-approval__queue">
            {queue.map((entry) => (
              <li key={entry.tool_use_id}>
                <code>{entry.tool}</code> {entry.summary}
              </li>
            ))}
          </ul>
          <div className="ag-approval__actions">
            <button
              type="button"
              className={`ag-btn${confirm === "allow" ? " ag-btn--danger" : ""}`}
              onClick={() => onDecideAll?.(request.tool_use_id, decision(confirm))}
              autoFocus
            >
              {confirm === "allow" ? `Yes, allow all ${queue.length}` : `Yes, deny all ${queue.length}`}
            </button>
            <button type="button" className="ag-btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <div className="ag-approval__actions">
        {editing ? (
          <>
            <button type="button" className="ag-btn ag-btn--primary" disabled={!edited} onClick={allowEdited}>
              {changed ? "Allow edited" : "Allow once"}
            </button>
            <button type="button" className="ag-btn" onClick={() => setEditing(false)}>
              Cancel edit
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ag-btn ag-btn--primary" onClick={() => decide({ type: "allow_once" })}>
              Allow once
            </button>
            <button type="button" className="ag-btn" onClick={() => decide({ type: "allow_always" })}>
              Always allow
            </button>
            <button type="button" className="ag-btn" onClick={startEditing}>
              Edit
            </button>
          </>
        )}
        <button type="button" className="ag-btn" onClick={deny}>
          Deny
        </button>
        {!showFeedback ? (
          <button type="button" className="ag-link" onClick={() => setShowFeedback(true)}>
            Add feedback
          </button>
        ) : null}
        <span className="ag-muted ag-approval__hint">
          {editing ? "Ctrl+Enter allows the edited call, Esc closes the editor" : "Enter allows, Esc denies"}
        </span>
      </div>
      {batchable ? (
        <div className="ag-approval__actions ag-approval__batch" role="group" aria-label="Batch decision">
          <button
            type="button"
            className="ag-btn"
            title="Ctrl+Shift+Enter"
            aria-keyshortcuts="Control+Shift+Enter"
            onClick={() => batch("allow")}
          >
            Allow all pending ({queue.length})
          </button>
          <button
            type="button"
            className="ag-btn"
            title="Ctrl+Shift+Backspace"
            aria-keyshortcuts="Control+Shift+Backspace"
            onClick={() => batch("deny")}
          >
            Deny all pending ({queue.length})
          </button>
          <span className="ag-muted ag-approval__hint">Ctrl+Shift+Enter / Backspace</span>
        </div>
      ) : null}
    </div>
  );
}
