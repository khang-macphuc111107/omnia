import {
  Bot,
  Clipboard,
  GitBranch,
  Info,
  LockKeyhole,
  RotateCcw,
  Sparkles,
  Undo2,
  Redo2,
} from "lucide-react";
import { useMemo, useState } from "react";

export type OrchestrationStrategy = "auto" | "discuss" | "manual";
export type OrchestrationContextMode = "auto" | "partial" | "full" | "manifest";
export type OrchestrationEffort = "fast" | "balanced" | "deep" | "ultra";

export type OrchestrationRolePlan = {
  readonly id: string;
  readonly label: string;
  readonly purpose: string;
  readonly modelPolicy: string;
  readonly effort: OrchestrationEffort;
  readonly enabled: boolean;
  readonly reason: string;
};

export type OrchestrationPlan = {
  readonly prompt: string;
  readonly strategy: OrchestrationStrategy;
  readonly contextMode: OrchestrationContextMode;
  readonly maxAgents: number;
  readonly roles: readonly OrchestrationRolePlan[];
  readonly signals: readonly string[];
};

const MODEL_POLICIES = [
  { id: "auto", label: "Auto · learned route" },
  { id: "main", label: "Use main model" },
  { id: "frontier", label: "Frontier reasoning" },
  { id: "local-code", label: "Local coder" },
  { id: "fast-research", label: "Fast research" },
] as const;

const ROLE_CATALOG: readonly Omit<OrchestrationRolePlan, "modelPolicy" | "effort" | "enabled" | "reason">[] = [
  { id: "planner", label: "Planner", purpose: "Break the request into bounded tasks and dependencies." },
  { id: "researcher", label: "Researcher", purpose: "Collect relevant evidence and surface uncertainty." },
  { id: "builder", label: "Builder", purpose: "Produce the implementation or draft artifact." },
  { id: "reviewer", label: "Reviewer", purpose: "Check the result against the task contract." },
  { id: "verifier", label: "Verifier", purpose: "Run focused checks and report residual risk." },
  { id: "specialist", label: "Specialist", purpose: "Apply a domain-specific lens when the prompt asks for one." },
];

const DEFAULT_PROMPT = "Build the requested feature, research the relevant context, and report what is verified.";

function hasAny(prompt: string, words: readonly string[]): boolean {
  return words.some((word) => prompt.includes(word));
}

function roleReason(id: string, prompt: string): string {
  const normalized = prompt.toLocaleLowerCase();
  if (id === "researcher" && hasAny(normalized, ["research", "source", "latest", "compare", "citation"])) return "Prompt asks for evidence or comparison.";
  if (id === "builder" && hasAny(normalized, ["build", "code", "implement", "fix", "create", "app"])) return "Prompt contains an implementation or creation verb.";
  if (id === "reviewer" && hasAny(normalized, ["review", "check", "audit", "quality", "bug"])) return "Prompt asks for review, audit, or quality checks.";
  if (id === "verifier") return "Keep a bounded verification lane visible for the handoff.";
  if (id === "specialist" && hasAny(normalized, ["algorithm", "math", "physics", "finance", "security", "ui"])) return "Prompt contains a domain signal for specialist review.";
  if (id === "planner") return "Every multi-step request gets an explicit planning gate.";
  return "Available as an optional bounded lane; disabled until the prompt signals a need.";
}

/**
 * Derives a deterministic plan from visible prompt text. It is intentionally a
 * planning helper, not an AI claim: no model, provider, scheduler, or agent is
 * called by this function.
 */
export function deriveOrchestrationPlan(
  prompt: string,
  strategy: OrchestrationStrategy = "auto",
  contextMode: OrchestrationContextMode = "auto",
  maxAgents = 4,
): OrchestrationPlan {
  const normalized = prompt.trim().toLocaleLowerCase();
  const hasResearch = hasAny(normalized, ["research", "source", "latest", "compare", "citation", "evidence"]);
  const hasBuild = hasAny(normalized, ["build", "code", "implement", "fix", "create", "app", "ui"]);
  const hasReview = hasAny(normalized, ["review", "check", "audit", "test", "verify", "bug"]);
  const hasDomain = hasAny(normalized, ["algorithm", "math", "physics", "finance", "security", "latex"]);
  const requested = strategy === "manual"
    ? new Set(ROLE_CATALOG.map((role) => role.id))
    : new Set(["planner", ...(hasResearch ? ["researcher"] : []), ...(hasBuild ? ["builder"] : []), ...(hasReview ? ["reviewer", "verifier"] : ["verifier"]), ...(hasDomain ? ["specialist"] : [])]);
  // Keep the planner as the first bounded lane and reserve the remaining
  // slots for the prompt's strongest signals (review before the always-on
  // verifier). The cap is a visible planning limit, not a spawn count.
  const bounded = [...requested].slice(0, Math.max(1, Math.min(ROLE_CATALOG.length, maxAgents)));
  const roles = ROLE_CATALOG.map((role) => {
    const enabled = bounded.includes(role.id);
    const modelPolicy = role.id === "builder" && hasBuild ? "local-code" : role.id === "researcher" && hasResearch ? "fast-research" : "auto";
    const effort: OrchestrationEffort = role.id === "planner" || role.id === "reviewer" || role.id === "verifier" ? "deep" : "balanced";
    return { ...role, modelPolicy, effort, enabled, reason: roleReason(role.id, normalized) };
  });
  const signals = [
    hasResearch ? "evidence intent detected" : "no explicit research signal",
    hasBuild ? "implementation intent detected" : "no explicit build signal",
    hasReview ? "verification intent detected" : "verification lane retained by default",
    strategy === "discuss" ? "multi-perspective discussion staged before synthesis" : "single-plan synthesis selected",
  ];
  return { prompt: prompt.trim(), strategy, contextMode, maxAgents: Math.max(1, Math.min(8, maxAgents)), roles, signals };
}

export function serializeOrchestrationPlan(plan: OrchestrationPlan): string {
  return JSON.stringify({
    schema: "omnia.prompt-orchestration-plan.preview.v1",
    scope: "renderer-session",
    executionDisposition: "preview-only",
    ...plan,
    boundary: [
      "Prompt analysis is deterministic renderer-local planning",
      "No model or provider request was made",
      "No agent was spawned and no scheduler, lease, approval, secret, or durable write was touched",
      "Auto model labels are policy placeholders, not learned routing evidence",
    ],
  }, null, 2);
}

type PlanHistory = { readonly past: readonly OrchestrationPlan[]; readonly present: OrchestrationPlan; readonly future: readonly OrchestrationPlan[] };

export default function AgentOrchestrationPromptPreview() {
  const [draft, setDraft] = useState(DEFAULT_PROMPT);
  const [strategy, setStrategy] = useState<OrchestrationStrategy>("auto");
  const [contextMode, setContextMode] = useState<OrchestrationContextMode>("auto");
  const [maxAgents, setMaxAgents] = useState(4);
  const initial = useMemo(() => deriveOrchestrationPlan(DEFAULT_PROMPT), []);
  const [history, setHistory] = useState<PlanHistory>({ past: [], present: initial, future: [] });
  const [status, setStatus] = useState("Type a request, then preview how Omnia would fan it out.");
  const [copied, setCopied] = useState(false);
  const plan = history.present;

  const commit = (next: OrchestrationPlan, message: string) => {
    setHistory((current) => ({ past: [...current.past, current.present].slice(-20), present: next, future: [] }));
    setStatus(message);
    setCopied(false);
  };

  const analyze = () => commit(deriveOrchestrationPlan(draft, strategy, contextMode, maxAgents), "Prompt analyzed locally; no agent or provider was dispatched.");
  const updateRole = (id: string, patch: Partial<OrchestrationRolePlan>) => commit({ ...plan, roles: plan.roles.map((role) => role.id === id ? { ...role, ...patch } : role) }, "Role override updated in the renderer plan.");
  const undo = () => setHistory((current) => {
    const previous = current.past.at(-1);
    if (!previous) return current;
    setStatus("Undid the last orchestration plan change.");
    return { past: current.past.slice(0, -1), present: previous, future: [current.present, ...current.future] };
  });
  const redo = () => setHistory((current) => {
    const next = current.future[0];
    if (!next) return current;
    setStatus("Reapplied the next orchestration plan change.");
    return { past: [...current.past, current.present], present: next, future: current.future.slice(1) };
  });
  const reset = () => {
    setDraft(DEFAULT_PROMPT);
    setStrategy("auto");
    setContextMode("auto");
    setMaxAgents(4);
    setHistory({ past: [], present: initial, future: [] });
    setStatus("Prompt orchestration plan reset; no queue or agent state changed.");
  };
  const copy = async () => {
    const payload = serializeOrchestrationPlan(plan);
    if (!navigator.clipboard?.writeText) {
      setCopied(false);
      setStatus("Clipboard unavailable; the orchestration plan remains visible in this session.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setStatus("Copied the renderer-local orchestration plan.");
    } catch {
      setStatus("Clipboard unavailable; the orchestration plan remains visible in this session.");
    }
  };

  return (
    <section className="agent-orchestration-prompt" aria-labelledby="agent-orchestration-prompt-title">
      <header className="agent-orchestration-prompt__header">
        <div><span className="eyebrow"><Sparkles size={13} /> Prompt-driven orchestration</span><h3 id="agent-orchestration-prompt-title">Turn one request into a visible agent plan</h3><p>Write the request once. Review the proposed roles, context policy, effort, and per-role model strategy before any future dispatch.</p></div>
        <span className="agent-orchestration-prompt__badge"><Bot size={12} /> Preview only</span>
      </header>
      <p className="agent-orchestration-prompt__boundary"><LockKeyhole size={13} /> Renderer-local planner. Auto means deterministic heuristics in this preview; no agent or provider was dispatched, and no learned AI routing or durable policy is claimed.</p>

      <div className="agent-orchestration-prompt__input-grid">
        <label className="agent-orchestration-prompt__prompt"><span>Task prompt</span><textarea aria-label="Orchestration task prompt" rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Describe the work Omnia should coordinate…" /></label>
        <div className="agent-orchestration-prompt__controls">
          <label><span>Strategy</span><select aria-label="Orchestration strategy" value={strategy} onChange={(event) => setStrategy(event.target.value as OrchestrationStrategy)}><option value="auto">Auto from prompt</option><option value="discuss">Discuss first</option><option value="manual">Manual role set</option></select></label>
          <label><span>Context delivery</span><select aria-label="Orchestration context mode" value={contextMode} onChange={(event) => setContextMode(event.target.value as OrchestrationContextMode)}><option value="auto">Auto</option><option value="partial">Partial · relevant sources</option><option value="full">Full visible context</option><option value="manifest">Manifest only</option></select></label>
          <label><span>Max agents</span><select aria-label="Maximum orchestration agents" value={maxAgents} onChange={(event) => setMaxAgents(Number(event.target.value))}>{[2, 3, 4, 5, 6, 8].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <button type="button" className="button button--primary" onClick={analyze}><GitBranch size={14} /> Preview plan</button>
        </div>
      </div>

      <div className="agent-orchestration-prompt__summary" aria-label="Orchestration plan summary"><div><strong>{plan.roles.filter((role) => role.enabled).length}</strong><span>enabled roles</span></div><div><strong>{plan.maxAgents}</strong><span>agent cap</span></div><div><strong>{plan.contextMode}</strong><span>context mode</span></div><div><strong>{plan.strategy}</strong><span>strategy</span></div></div>

      <div className="agent-orchestration-prompt__history" role="toolbar" aria-label="Orchestration plan history"><span><strong>Reversible plan draft</strong><small>{status}</small></span><span className="agent-orchestration-prompt__history-actions"><button type="button" className="button button--ghost" aria-label="Undo orchestration plan change" onClick={undo} disabled={!history.past.length}><Undo2 size={12} /> Undo</button><button type="button" className="button button--ghost" aria-label="Redo orchestration plan change" onClick={redo} disabled={!history.future.length}><Redo2 size={12} /> Redo</button><button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={12} /> Reset</button></span></div>

      <div className="agent-orchestration-prompt__signals" aria-label="Prompt signals">{plan.signals.map((signal) => <span key={signal}>{signal}</span>)}</div>
      <div className="agent-orchestration-prompt__roles" role="list" aria-label="Proposed agent roles">{plan.roles.map((role) => <article key={role.id} role="listitem" className={`agent-orchestration-prompt__role${role.enabled ? " is-enabled" : ""}`}><div className="agent-orchestration-prompt__role-heading"><div><strong>{role.label}</strong><small>{role.purpose}</small></div><label className="agent-orchestration-prompt__toggle"><input type="checkbox" checked={role.enabled} onChange={(event) => updateRole(role.id, { enabled: event.target.checked })} /><span>{role.enabled ? "Included" : "Optional"}</span></label></div><p>{role.reason}</p><div className="agent-orchestration-prompt__role-controls"><label><span>Model</span><select aria-label={`${role.label} orchestration model`} value={role.modelPolicy} onChange={(event) => updateRole(role.id, { modelPolicy: event.target.value })}>{MODEL_POLICIES.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label><label><span>Effort</span><select aria-label={`${role.label} orchestration effort`} value={role.effort} onChange={(event) => updateRole(role.id, { effort: event.target.value as OrchestrationEffort })}><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="deep">Deep</option><option value="ultra">Ultra</option></select></label></div></article>)}</div>

      <div className="agent-orchestration-prompt__export"><span><strong>Portable plan preview</strong><small>{copied ? "Copied" : "Contains prompt-derived roles and policy labels only."}</small></span><button type="button" className="button button--secondary" onClick={() => void copy()}><Clipboard size={13} /> {copied ? "Copied" : "Copy JSON"}</button></div>
      <p className="agent-orchestration-prompt__footnote"><Info size={13} /> Context mode is a delivery preference, not proof of a frozen context snapshot. Child roles cannot gain authority from this renderer preview.</p>
    </section>
  );
}
