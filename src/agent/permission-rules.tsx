import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import "./permission-rules.css";

import { agentApi, errorMessage } from "./agent-api";
import type {
  PermissionRule,
  PermissionRuleTestResult,
  PermissionRulesListing,
  RuleAction,
  RuleScope,
} from "./types";

const ACTIONS: RuleAction[] = ["allow", "ask", "deny"];
const SCOPE_LABEL: Record<RuleScope, string> = {
  global: "Global (all projects)",
  project: "Project (.omnia/permissions.json)",
  session: "This session only",
};

export const ruleText = (rule: PermissionRule) =>
  rule.pattern ? `${rule.tool} (${rule.pattern})` : `${rule.tool} (any call)`;

/**
 * The user's permission rules, in one place: add, edit, delete and reorder per
 * scope, and ask "would this call be allowed?" against the saved rules.
 * Deny always wins over allow, whatever the order.
 */
export function PermissionRulesManager({
  sessionId,
  cwd,
  scopes,
}: {
  sessionId?: string | undefined;
  cwd?: string | undefined;
  scopes: RuleScope[];
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const toolRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef("Add rule");
  const pendingFocus = useRef<string | null>(null);
  const [scope, setScope] = useState<RuleScope>(scopes[0] ?? "global");
  const [listing, setListing] = useState<PermissionRulesListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<PermissionRule>({ tool: "", pattern: "", action: "allow" });
  const [testTool, setTestTool] = useState("shell");
  const [testInput, setTestInput] = useState('{"command": "ls"}');
  const [testResult, setTestResult] = useState<PermissionRuleTestResult | null>(null);

  const target = { sessionId, cwd };

  const load = useCallback(() => {
    // Promise.resolve().then(...) so a missing/throwing host only shows an error.
    Promise.resolve()
      .then(() => agentApi.permissionRules({ sessionId, cwd }))
      .then((next) => {
        setListing(next);
        setError(null);
      })
      .catch((cause) => setError(errorMessage(cause)));
  }, [sessionId, cwd]);

  useEffect(load, [load]);

  useEffect(() => {
    if (editing !== null && !busy) toolRef.current?.focus();
  }, [editing, busy]);

  useEffect(() => {
    if (busy || editing !== null || !pendingFocus.current) return;
    const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const button = buttons.find((item) => item.getAttribute("aria-label") === pendingFocus.current)
      ?? buttons.find((item) => item.textContent === "Add rule");
    button?.focus();
    pendingFocus.current = null;
  }, [busy, editing, listing]);

  const cancelEdit = () => {
    pendingFocus.current = returnFocus.current;
    setEditing(null);
    setError(null);
  };

  const rules: PermissionRule[] =
    scope === "global" ? (listing?.global ?? []) : scope === "project" ? (listing?.project?.rules ?? []) : (listing?.session ?? []);
  const projectBlocked = scope === "project" && !listing?.project;

  const save = async (next: PermissionRule[], focusLabel = returnFocus.current) => {
    if (busy) return;
    pendingFocus.current = focusLabel;
    setBusy(true);
    setError(null);
    try {
      setListing(await agentApi.setPermissionRules(scope, next, target));
      setEditing(null);
    } catch (cause) {
      pendingFocus.current = null;
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      if (editing !== null) toolRef.current?.focus();
    }
  };

  const startEdit = (index: number | "new") => {
    returnFocus.current = index === "new" ? "Add rule" : `Edit rule ${index + 1}`;
    setError(null);
    setEditing(index);
    const existing = index === "new" ? undefined : rules[index];
    setDraft(existing ? { ...existing, pattern: existing.pattern ?? "" } : { tool: "", pattern: "", action: "allow" });
  };

  const commit = () => {
    const rule: PermissionRule = {
      tool: draft.tool.trim(),
      pattern: draft.pattern?.trim() ? draft.pattern.trim() : null,
      action: draft.action,
    };
    if (!rule.tool) {
      setError("A rule needs a tool name, glob, or re: regex.");
      return;
    }
    const next = [...rules];
    if (editing === "new") next.push(rule);
    else if (editing !== null) next[editing] = rule;
    void save(next);
  };

  const move = (index: number, delta: number) => {
    const next = [...rules];
    const to = index + delta;
    const a = next[index];
    const b = next[to];
    if (!a || !b) return;
    next[index] = b;
    next[to] = a;
    void save(next, `Move rule ${to + 1} ${delta < 0 ? "down" : "up"}`);
  };

  const runTest = async () => {
    setError(null);
    setTestResult(null);
    let input: unknown;
    try {
      input = JSON.parse(testInput);
    } catch {
      setError("The test input must be valid JSON, for example {\"command\": \"git status\"}.");
      return;
    }
    try {
      setTestResult(await agentApi.testPermissionRule({ ...target, tool: testTool.trim(), input }));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <div className="ag-rules" ref={rootRef}>
      <p className="ag-muted">
        Rules are yours: visible, editable, and checked in order. Deny always wins over allow. A tool may be a name, a glob, or{" "}
        <code>re:</code> followed by a regex; the pattern is matched against the main argument (command or path). A regex is
        unanchored, so use <code>^</code> and <code>$</code> to match the whole value.
      </p>
      {scopes.length > 1 ? (
        <div className="ag-field">
          <label className="ag-label" htmlFor={`${id}-scope`}>
            Rules for
          </label>
          <select
            id={`${id}-scope`}
            className="ag-input"
            value={scope}
            disabled={busy}
            onChange={(event) => {
              setScope(event.target.value as RuleScope);
              setEditing(null);
              setError(null);
            }}
          >
            {scopes.map((value) => (
              <option key={value} value={value}>
                {SCOPE_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {scope === "project" && listing?.project && !listing.project.trusted && listing.project.exists ? (
        <p className="ag-muted" role="status">
          This project's rules are not applied until you trust the workspace configuration.
        </p>
      ) : null}
      {scope === "project" && listing?.project?.error ? (
        <p className="ag-error" role="alert">
          {listing.project.error}
        </p>
      ) : null}
      {projectBlocked ? <p className="ag-muted">Open a project folder to manage project rules.</p> : null}
      {!projectBlocked ? (
        <>
          {rules.length === 0 ? <p className="ag-muted">No rules in this scope.</p> : null}
          <ul className="ag-rules__list" aria-label={`${scope} permission rules`}>
            {rules.map((rule, index) => (
              <li key={`${index}:${rule.tool}:${rule.pattern ?? ""}`} className="ag-rules__item">
                <span className="ag-rules__action">{rule.action}</span>
                <span className="ag-rules__rule">{ruleText(rule)}</span>
                <div className="ag-rules__controls" role="group" aria-label={`Rule ${index + 1} controls`}>
                <button type="button" className="ag-icon-btn" aria-label={`Move rule ${index + 1} up`} disabled={busy || editing !== null || index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp size={14} aria-hidden="true" />
                </button>
                <button type="button" className="ag-icon-btn" aria-label={`Move rule ${index + 1} down`} disabled={busy || editing !== null || index === rules.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown size={14} aria-hidden="true" />
                </button>
                <button type="button" className="ag-icon-btn" aria-label={`Edit rule ${index + 1}`} disabled={busy} onClick={() => startEdit(index)}>
                  <Pencil size={14} aria-hidden="true" />
                </button>
                <button type="button" className="ag-icon-btn" aria-label={`Delete rule ${index + 1}`} disabled={busy || editing !== null} onClick={() => void save(rules.filter((_, at) => at !== index), rules.length > 1 ? `Delete rule ${Math.min(index + 1, rules.length - 1)}` : "Add rule")}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
                </div>
              </li>
            ))}
          </ul>
          {editing !== null ? (
            <div
              className="ag-rules__edit"
              role="group"
              aria-label={editing === "new" ? "New rule" : `Edit rule ${editing + 1}`}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (busy) {
                  if (event.key === "Escape" || event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelEdit();
                } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
                  event.preventDefault();
                  event.stopPropagation();
                  commit();
                }
              }}
            >
              <select disabled={busy} className="ag-input" aria-label="Rule action" value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value as RuleAction })}>
                {ACTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <input ref={toolRef} disabled={busy} className="ag-input" aria-label="Rule tool" placeholder="Tool: shell, mcp__*, re:^git_" value={draft.tool} onChange={(event) => setDraft({ ...draft, tool: event.target.value })} />
              <input disabled={busy} className="ag-input" aria-label="Rule pattern" placeholder="Pattern on the command or path (optional)" value={draft.pattern ?? ""} onChange={(event) => setDraft({ ...draft, pattern: event.target.value })} />
              <button type="button" className="ag-btn ag-btn--primary" disabled={busy} onClick={commit}>
                Save rule
              </button>
              <button type="button" className="ag-btn" disabled={busy} onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          ) : (
            <div>
              <button type="button" className="ag-btn" disabled={busy} onClick={() => startEdit("new")}>
                Add rule
              </button>
            </div>
          )}
        </>
      ) : null}
      {error ? (
        <p className="ag-error" role="alert">
          {error}
        </p>
      ) : null}
      <div
        className="ag-rules__edit"
        role="group"
        aria-label="Test a call"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            event.stopPropagation();
            void runTest();
          }
        }}
      >
        <input className="ag-input" aria-label="Test tool" value={testTool} onChange={(event) => setTestTool(event.target.value)} />
        <input className="ag-input" aria-label="Test input (JSON)" value={testInput} onChange={(event) => setTestInput(event.target.value)} />
        <button type="button" className="ag-btn" onClick={() => void runTest()}>
          Test call
        </button>
      </div>
      {testResult ? (
        <p className="ag-rules__result" role="status">
          Would be {testResult.decision === "allow" ? "allowed" : testResult.decision === "deny" ? "denied" : "asked about"} in{" "}
          {testResult.mode} mode:{" "}
          {testResult.rule
            ? `${testResult.rule.scope} rule ${testResult.rule.index + 1} (${testResult.rule.action} ${ruleText(testResult.rule)}).`
            : testResult.reason}
        </p>
      ) : null}
    </div>
  );
}
