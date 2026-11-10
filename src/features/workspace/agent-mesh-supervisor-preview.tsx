import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  GitBranch,
  Info,
  LockKeyhole,
  Network,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Undo2,
  Redo2,
  Upload,
  Waypoints,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  AGENT_MESH_SUPERVISOR_POLICY_BOUNDARY,
  AGENT_MESH_SUPERVISOR_POLICY_FIELDS,
  AGENT_MESH_SUPERVISOR_POLICY_OPTIONS,
  DEFAULT_AGENT_MESH_SUPERVISOR_POLICY,
  agentMeshSupervisorPolicyDiff,
  agentMeshSupervisorPolicyEqual,
  normalizeAgentMeshSupervisorPolicy,
  parseAgentMeshSupervisorPolicy,
  serializeAgentMeshSupervisorPolicy,
  serializeAgentMeshSupervisorPolicyMarkdown,
  type AgentMeshSupervisorPolicyDraft,
  type AgentMeshSupervisorPolicyKey,
} from "./agent-mesh-supervisor-policy";
import { AgentMeshSupervisorFlow } from "./agent-mesh-supervisor-flow";

export type AgentMeshSupervisorView = "queue" | "policies" | "signals" | "flow";
export type AgentMeshSupervisorTaskMode = "steer" | "queue" | "btw" | "parallel" | "scheduled";
export type AgentMeshSupervisorTaskState = "running" | "ready" | "blocked" | "stale" | "waiting";

export interface AgentMeshSupervisorTask {
  readonly id: string;
  readonly title: string;
  readonly mode: AgentMeshSupervisorTaskMode;
  readonly state: AgentMeshSupervisorTaskState;
  readonly owner: string;
  readonly dependencies: readonly string[];
  readonly claims: readonly string[];
  readonly route: string;
  readonly reason: string;
  readonly retry: string;
}

interface SupervisorPolicy {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly state: "enforced" | "preview" | "planned";
}

const SUPERVISOR_TASKS: readonly AgentMeshSupervisorTask[] = [
  {
    id: "task:context-audit",
    title: "Compile context availability evidence",
    mode: "steer",
    state: "running",
    owner: "Evidence researcher",
    dependencies: [],
    claims: ["read:project-context"],
    route: "fixed → parent run",
    reason: "Current atomic step is still collecting bounded references.",
    retry: "0 retries",
  },
  {
    id: "task:source-ledger",
    title: "Refresh source-ledger projection",
    mode: "queue",
    state: "ready",
    owner: "Evidence researcher",
    dependencies: ["task:context-audit"],
    claims: ["read:docs", "write:generated-ledger"],
    route: "inbox-only",
    reason: "Dependencies are visible in the preview; native readiness is unavailable.",
    retry: "0 retries",
  },
  {
    id: "task:ui-contract",
    title: "Apply renderer UI contract slice",
    mode: "parallel",
    state: "blocked",
    owner: "UI builder",
    dependencies: ["task:source-ledger"],
    claims: ["write:src/features/workspace", "write:src/styles"],
    route: "fixed → project branch",
    reason: "Blocked until its source evidence dependency is completed.",
    retry: "1 retry held",
  },
  {
    id: "task:twin-reconcile",
    title: "Reconcile Project Twin projection",
    mode: "scheduled",
    state: "stale",
    owner: "Truthfulness verifier",
    dependencies: ["task:ui-contract"],
    claims: ["write:docs/project-twin"],
    route: "follow-active (preview)",
    reason: "The visible snapshot is stale and needs a fresh native watermark.",
    retry: "No automatic retry",
  },
  {
    id: "task:handoff",
    title: "Prepare bounded parent handoff",
    mode: "btw",
    state: "waiting",
    owner: "UX reviewer",
    dependencies: ["task:ui-contract"],
    claims: ["read:review-notes"],
    route: "inbox-only",
    reason: "Side-context remains isolated until a parent explicitly promotes it.",
    retry: "0 retries",
  },
] as const;

const SUPERVISOR_POLICIES: readonly SupervisorPolicy[] = [
  {
    id: "policy:authority",
    label: "Child authority",
    value: "Subset of parent",
    detail: "A child cannot widen tools, workspace grants, environment or budget.",
    state: "enforced",
  },
  {
    id: "policy:claims",
    label: "Write-claim overlap",
    value: "Serialize or isolate",
    detail: "Shared reads may overlap; any shared write claim is held behind a conflict gate.",
    state: "enforced",
  },
  {
    id: "policy:route",
    label: "Output routing",
    value: "Fixed branch route",
    detail: "Navigating the UI does not retarget background output to the active conversation.",
    state: "enforced",
  },
  {
    id: "policy:stale",
    label: "Stale snapshot",
    value: "Block + refresh",
    detail: "A stale revision is shown as attention and never promoted as a successful reconcile.",
    state: "preview",
  },
  {
    id: "policy:recovery",
    label: "Lease recovery",
    value: "Native receipt required",
    detail: "Reclaim, heartbeat and reassignment remain unavailable until native authority exists.",
    state: "planned",
  },
] as const;

const stateLabels: Record<AgentMeshSupervisorTaskState, string> = {
  running: "Running",
  ready: "Ready preview",
  blocked: "Blocked",
  stale: "Stale snapshot",
  waiting: "Waiting",
};

function stateTone(state: AgentMeshSupervisorTaskState): string {
  if (state === "running") return "running";
  if (state === "ready") return "ready";
  if (state === "blocked" || state === "stale") return "attention";
  return "waiting";
}

function stateIcon(state: AgentMeshSupervisorTaskState) {
  if (state === "running") return <Clock3 size={13} aria-hidden="true" />;
  if (state === "ready") return <CheckCircle2 size={13} aria-hidden="true" />;
  if (state === "blocked" || state === "stale") return <AlertTriangle size={13} aria-hidden="true" />;
  return <Network size={13} aria-hidden="true" />;
}

function policyIcon(state: SupervisorPolicy["state"]) {
  if (state === "enforced") return <ShieldCheck size={14} aria-hidden="true" />;
  if (state === "preview") return <Waypoints size={14} aria-hidden="true" />;
  return <LockKeyhole size={14} aria-hidden="true" />;
}

const SUPERVISOR_POLICY_VALUE_LABELS: Record<AgentMeshSupervisorPolicyKey, Record<string, string>> = {
  childAuthority: {
    "subset-only": "Subset of parent",
    "same-as-parent": "Same as parent (review)",
    "review-each-expansion": "Review each expansion",
  },
  writeConflict: {
    serialize: "Serialize shared writes",
    "isolated-worktree": "Isolated worktree",
    "hold-for-review": "Hold for review",
    "deny-overlap": "Deny overlap",
  },
  outputRoute: {
    "fixed-parent": "Fixed parent route",
    "task-inbox": "Task inbox",
    "explicit-destination": "Explicit destination",
  },
  staleSnapshot: {
    "block-and-refresh": "Block and refresh",
    "read-only-review": "Read-only review",
    "manual-acknowledgement": "Manual acknowledgement",
  },
  leaseRecovery: {
    "native-receipt-required": "Native receipt required",
    "hold-expired": "Hold expired lease",
    "manual-recovery-preview": "Manual recovery preview",
  },
};

function supervisorPolicyValueLabel(key: AgentMeshSupervisorPolicyKey, value: string): string {
  return SUPERVISOR_POLICY_VALUE_LABELS[key][value] ?? value;
}

function downloadSupervisorPolicy(text: string, format: "json" | "markdown"): boolean {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([text], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-agent-mesh-supervisor-policy.preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export interface AgentMeshSupervisorPreviewProps {
  readonly linkedWorkCount?: number;
}

/**
 * Renderer-local supervisor projection for the Agent Mesh contracts.
 *
 * This is intentionally a read/rehearsal surface. It does not schedule,
 * reassign, reconcile, acquire leases, or mutate a durable task graph.
 */
export function AgentMeshSupervisorPreview({ linkedWorkCount = 0 }: AgentMeshSupervisorPreviewProps) {
  const [view, setView] = useState<AgentMeshSupervisorView>("queue");
  const [selectedTaskId, setSelectedTaskId] = useState(SUPERVISOR_TASKS[0]?.id ?? null);
  const [announcement, setAnnouncement] = useState("Renderer-local supervisor preview; no scheduler mutation was made.");
  const [policy, setPolicy] = useState<AgentMeshSupervisorPolicyDraft>(DEFAULT_AGENT_MESH_SUPERVISOR_POLICY);
  const [policyPast, setPolicyPast] = useState<AgentMeshSupervisorPolicyDraft[]>([]);
  const [policyFuture, setPolicyFuture] = useState<AgentMeshSupervisorPolicyDraft[]>([]);
  const [policyExport, setPolicyExport] = useState("json");
  const policyImportRef = useRef<HTMLInputElement>(null);

  const selectedTask = SUPERVISOR_TASKS.find((task) => task.id === selectedTaskId) ?? null;
  const runningCount = SUPERVISOR_TASKS.filter((task) => task.state === "running").length;
  const readyCount = SUPERVISOR_TASKS.filter((task) => task.state === "ready").length;
  const attentionCount = SUPERVISOR_TASKS.filter((task) => task.state === "blocked" || task.state === "stale").length;
  const heldCount = SUPERVISOR_TASKS.filter((task) => task.state === "waiting").length;
  const tabs: readonly AgentMeshSupervisorView[] = ["queue", "policies", "signals", "flow"];
  const policyDiff = useMemo(() => agentMeshSupervisorPolicyDiff(policy), [policy]);
  const policySerialized = useMemo(() => serializeAgentMeshSupervisorPolicy(policy), [policy]);
  const policyMarkdown = useMemo(() => serializeAgentMeshSupervisorPolicyMarkdown(policy), [policy]);
  const policyExportText = policyExport === "json" ? policySerialized : policyMarkdown;

  const commitPolicy = (next: AgentMeshSupervisorPolicyDraft, message: string) => {
    const normalized = normalizeAgentMeshSupervisorPolicy(next);
    if (agentMeshSupervisorPolicyEqual(normalized, policy)) {
      setAnnouncement("That supervisor policy preview already matches the current draft.");
      return;
    }
    setPolicyPast((current) => [...current, policy].slice(-30));
    setPolicy(normalized);
    setPolicyFuture([]);
    setAnnouncement(`${message} Renderer-local only; no supervisor authority changed.`);
  };

  const updatePolicyField = <K extends AgentMeshSupervisorPolicyKey>(key: K, value: AgentMeshSupervisorPolicyDraft[K]) => {
    commitPolicy({ ...policy, [key]: value }, `${SUPERVISOR_POLICY_VALUE_LABELS[key][String(value)] ?? String(value)} selected for ${key}.`);
  };

  const updateParallelLimit = (value: number) => {
    commitPolicy({ ...policy, maxParallelTasks: value }, `Maximum parallel task preview changed to ${value}.`);
  };

  const undoPolicy = () => {
    const previous = policyPast.at(-1);
    if (!previous) return;
    setPolicyPast((current) => current.slice(0, -1));
    setPolicyFuture((current) => [policy, ...current]);
    setPolicy(previous);
    setAnnouncement("Undid one supervisor policy preview change; no native authority changed.");
  };

  const redoPolicy = () => {
    const next = policyFuture[0];
    if (!next) return;
    setPolicyFuture((current) => current.slice(1));
    setPolicyPast((current) => [...current, policy].slice(-30));
    setPolicy(next);
    setAnnouncement("Redid one supervisor policy preview change; no native authority changed.");
  };

  const resetPolicy = () => commitPolicy(DEFAULT_AGENT_MESH_SUPERVISOR_POLICY, "Supervisor policy preview reset to guarded defaults.");

  const copyPolicy = async () => {
    if (!navigator.clipboard?.writeText) {
      setAnnouncement("Clipboard unavailable; the supervisor policy remains visible and no durable export was created.");
      return;
    }
    try {
      await navigator.clipboard.writeText(policyExportText);
      setAnnouncement(`Supervisor policy ${policyExport.toUpperCase()} preview copied; no native policy was changed.`);
    } catch {
      setAnnouncement("Clipboard write failed; no durable supervisor policy export was created.");
    }
  };

  const importPolicy = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseAgentMeshSupervisorPolicy(await file.text());
      if (!parsed) throw new Error("This is not a valid Omnia supervisor policy preview JSON file.");
      commitPolicy(parsed, "Imported supervisor policy preview applied to this renderer session.");
    } catch (error) {
      setAnnouncement(error instanceof Error ? error.message : "Supervisor policy preview import failed.");
    } finally {
      if (policyImportRef.current) policyImportRef.current.value = "";
    }
  };

  const signalRows = useMemo(() => [
    { label: "Readiness", value: `${readyCount} candidate${readyCount === 1 ? "" : "s"}`, detail: "Derived from the visible dependency fixture; not a native scheduler decision.", tone: "ready" },
    { label: "Conflict gate", value: `${attentionCount} held`, detail: "Blocked and stale items remain visible for review instead of disappearing from the queue.", tone: "attention" },
    { label: "Side-context", value: `${heldCount} waiting`, detail: "Btw work remains isolated until explicit promotion is available.", tone: "waiting" },
    { label: "Work linkage", value: linkedWorkCount ? `${linkedWorkCount} background item${linkedWorkCount === 1 ? "" : "s"}` : "No native projection", detail: "Adjacent work count is renderer input only.", tone: "neutral" },
  ], [attentionCount, heldCount, linkedWorkCount, readyCount]);

  const previewAction = (message: string) => {
    setAnnouncement(`${message} Renderer-local preview only; no native scheduler, lease or task mutation was made.`);
  };

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    setView(nextTab);
    document.getElementById(`agent-mesh-supervisor-tab-${nextTab}`)?.focus();
  };

  return (
    <section className="agent-mesh-supervisor-preview" aria-label="Agent mesh supervisor preview">
      <header className="agent-mesh-supervisor-preview__header">
        <div>
          <span className="eyebrow"><Waypoints size={13} /> Supervisor rehearsal</span>
          <h2>Agent Mesh supervisor</h2>
          <p>See readiness, dependency gates and conflict policy before a native scheduler is allowed to act.</p>
        </div>
        <span className="agent-mesh-supervisor-preview__badge"><Network size={12} /> Preview only</span>
      </header>

      <div className="agent-mesh-supervisor-preview__metrics" aria-label="Agent mesh supervisor summary">
        <div><strong>{SUPERVISOR_TASKS.length}</strong><span>task projections</span></div>
        <div><strong>{runningCount}</strong><span>running</span></div>
        <div><strong>{readyCount}</strong><span>ready preview</span></div>
        <div><strong>{attentionCount}</strong><span>held for attention</span></div>
        <div><strong>{heldCount}</strong><span>side-context</span></div>
      </div>

      <div className="agent-mesh-supervisor-preview__toolbar" role="toolbar" aria-label="Agent mesh supervisor controls">
        <div className="agent-mesh-supervisor-preview__tabs" role="tablist" aria-label="Agent mesh supervisor view" aria-orientation="horizontal">
          <button id="agent-mesh-supervisor-tab-queue" type="button" role="tab" aria-selected={view === "queue"} aria-controls="agent-mesh-supervisor-panel-queue" tabIndex={view === "queue" ? 0 : -1} className={view === "queue" ? "is-active" : ""} onClick={() => setView("queue")} onKeyDown={(event) => moveTab(event, 0)}><GitBranch size={13} /> Queue</button>
          <button id="agent-mesh-supervisor-tab-policies" type="button" role="tab" aria-selected={view === "policies"} aria-controls="agent-mesh-supervisor-panel-policies" tabIndex={view === "policies" ? 0 : -1} className={view === "policies" ? "is-active" : ""} onClick={() => setView("policies")} onKeyDown={(event) => moveTab(event, 1)}><ShieldCheck size={13} /> Policies</button>
          <button id="agent-mesh-supervisor-tab-signals" type="button" role="tab" aria-selected={view === "signals"} aria-controls="agent-mesh-supervisor-panel-signals" tabIndex={view === "signals" ? 0 : -1} className={view === "signals" ? "is-active" : ""} onClick={() => setView("signals")} onKeyDown={(event) => moveTab(event, 2)}><Waypoints size={13} /> Signals</button>
          <button id="agent-mesh-supervisor-tab-flow" type="button" role="tab" aria-selected={view === "flow"} aria-controls="agent-mesh-supervisor-panel-flow" tabIndex={view === "flow" ? 0 : -1} className={view === "flow" ? "is-active" : ""} onClick={() => setView("flow")} onKeyDown={(event) => moveTab(event, 3)}><Network size={13} /> Flow</button>
        </div>
        <span className="agent-mesh-supervisor-preview__revision">fixture revision <code>preview-07</code></span>
      </div>

      {view === "queue" ? (
        <div id="agent-mesh-supervisor-panel-queue" className="agent-mesh-supervisor-preview__body" role="tabpanel" aria-labelledby="agent-mesh-supervisor-tab-queue" tabIndex={0}>
          <div className="agent-mesh-supervisor-preview__queue" role="list" aria-label="Supervisor task queue">
            {SUPERVISOR_TASKS.map((task) => (
              <button type="button" role="listitem" key={task.id} className={`agent-mesh-supervisor-preview__task ${selectedTaskId === task.id ? "is-selected" : ""}`} onClick={() => setSelectedTaskId(task.id)} aria-label={`${task.title}. ${stateLabels[task.state]}`}>
                <span className={`agent-mesh-supervisor-preview__task-icon agent-mesh-supervisor-preview__task-icon--${stateTone(task.state)}`}>{stateIcon(task.state)}</span>
                <span className="agent-mesh-supervisor-preview__task-copy"><strong>{task.title}</strong><small>{task.mode} · {task.owner} · {task.dependencies.length ? `${task.dependencies.length} dependency` : "no dependencies"}</small></span>
                <span className={`agent-mesh-supervisor-preview__state agent-mesh-supervisor-preview__state--${stateTone(task.state)}`}>{stateLabels[task.state]}</span>
              </button>
            ))}
          </div>
          <aside className="agent-mesh-supervisor-preview__detail" aria-label="Selected supervisor task">
            {selectedTask ? (
              <>
                <div className="agent-mesh-supervisor-preview__detail-heading"><span className={`agent-mesh-supervisor-preview__state agent-mesh-supervisor-preview__state--${stateTone(selectedTask.state)}`}>{stateIcon(selectedTask.state)} {stateLabels[selectedTask.state]}</span><code>{selectedTask.id}</code></div>
                <h3>{selectedTask.title}</h3>
                <p>{selectedTask.reason}</p>
                <dl>
                  <div><dt>Mode</dt><dd>{selectedTask.mode}</dd></div>
                  <div><dt>Owner</dt><dd>{selectedTask.owner}</dd></div>
                  <div><dt>Dependencies</dt><dd>{selectedTask.dependencies.length ? selectedTask.dependencies.join(", ") : "None"}</dd></div>
                  <div><dt>Resource claims</dt><dd>{selectedTask.claims.join(", ")}</dd></div>
                  <div><dt>Output route</dt><dd>{selectedTask.route}</dd></div>
                  <div><dt>Retry</dt><dd>{selectedTask.retry}</dd></div>
                </dl>
                <div className="agent-mesh-supervisor-preview__actions">
                  <button type="button" className="button button--secondary" onClick={() => previewAction(`Recompute readiness for ${selectedTask.id}.`)}><RefreshCw size={13} /> Recompute readiness</button>
                  <button type="button" className="button button--secondary" onClick={() => previewAction(`Preview reassignment for ${selectedTask.id}.`)}><GitBranch size={13} /> Preview reassignment</button>
                </div>
              </>
            ) : <p className="agent-mesh-supervisor-preview__empty">Select a task projection.</p>}
          </aside>
        </div>
      ) : null}

      {view === "policies" ? (
        <div id="agent-mesh-supervisor-panel-policies" className="agent-mesh-supervisor-preview__policy-panel" role="tabpanel" aria-labelledby="agent-mesh-supervisor-tab-policies" tabIndex={0}>
          <div className="agent-mesh-supervisor-preview__policy-grid">
            {SUPERVISOR_POLICIES.map((policyCard) => (
              <article className={`agent-mesh-supervisor-preview__policy agent-mesh-supervisor-preview__policy--${policyCard.state}`} key={policyCard.id}>
                <div className="agent-mesh-supervisor-preview__policy-heading"><span>{policyIcon(policyCard.state)} {policyCard.label}</span><span>{policyCard.state}</span></div>
                <strong>{policyCard.value}</strong>
                <p>{policyCard.detail}</p>
              </article>
            ))}
          </div>

          <section className="agent-mesh-supervisor-preview__policy-editor" aria-labelledby="agent-mesh-supervisor-policy-editor-title">
            <div className="agent-mesh-supervisor-preview__policy-editor-heading">
              <div><span className="eyebrow">Rehearse before native promotion</span><h3 id="agent-mesh-supervisor-policy-editor-title">Supervisor policy draft</h3></div>
              <span className="agent-mesh-supervisor-preview__policy-draft-badge">{policyDiff.length ? `${policyDiff.length} changes` : "Guarded defaults"}</span>
            </div>
            <p className="agent-mesh-supervisor-preview__policy-editor-intro">Tune the target contract for child authority, overlap handling and recovery. These controls only change this renderer session.</p>
            <div className="agent-mesh-supervisor-preview__policy-controls">
              {AGENT_MESH_SUPERVISOR_POLICY_FIELDS.map(([key, label, description]) => (
                <label key={key}>
                  <span><strong>{label}</strong><small>{description}</small></span>
                  <select value={policy[key]} onChange={(event) => updatePolicyField(key, event.target.value as AgentMeshSupervisorPolicyDraft[typeof key])} aria-label={`Supervisor policy ${label}`}>
                    {AGENT_MESH_SUPERVISOR_POLICY_OPTIONS[key].map((value) => <option key={value} value={value}>{supervisorPolicyValueLabel(key, value)}</option>)}
                  </select>
                </label>
              ))}
              <label className="agent-mesh-supervisor-preview__policy-range">
                <span><strong>Maximum parallel tasks</strong><small>Bounded rehearsal capacity; no workers are started.</small></span>
                <span aria-label="Current maximum parallel tasks">{policy.maxParallelTasks}</span>
                <input type="range" min={1} max={16} step={1} value={policy.maxParallelTasks} onChange={(event) => updateParallelLimit(event.currentTarget.valueAsNumber)} aria-label="Supervisor policy maximum parallel tasks" />
              </label>
            </div>

            <div className="agent-mesh-supervisor-preview__policy-editor-actions" role="toolbar" aria-label="Supervisor policy draft controls">
              <button type="button" className="button button--ghost" onClick={undoPolicy} disabled={policyPast.length === 0} aria-label="Undo supervisor policy preview change"><Undo2 size={13} /> Undo</button>
              <button type="button" className="button button--ghost" onClick={redoPolicy} disabled={policyFuture.length === 0} aria-label="Redo supervisor policy preview change"><Redo2 size={13} /> Redo</button>
              <button type="button" className="button button--ghost" onClick={resetPolicy} disabled={agentMeshSupervisorPolicyEqual(policy, DEFAULT_AGENT_MESH_SUPERVISOR_POLICY)}><RotateCcw size={13} /> Reset</button>
              <span>{policyPast.length} undo · {policyFuture.length} redo</span>
            </div>

            <div className="agent-mesh-supervisor-preview__policy-diff" aria-label="Supervisor policy changes from guarded defaults">
              <strong>Draft diff</strong>
              {policyDiff.length ? <ul>{policyDiff.map((change) => <li key={String(change.key)}><span>{String(change.key)}</span><b>{change.before}</b><em aria-hidden="true">→</em><b>{change.after}</b></li>)}</ul> : <p>No changes from the guarded defaults.</p>}
            </div>

            <div className="agent-mesh-supervisor-preview__policy-export" aria-labelledby="agent-mesh-supervisor-policy-export-title">
              <div className="agent-mesh-supervisor-preview__policy-export-heading"><div><span className="eyebrow">Portable preview</span><h4 id="agent-mesh-supervisor-policy-export-title">Policy package</h4></div><Download size={14} /></div>
              <p>Export/import carries only the bounded draft and boundary metadata. It is not a broker grant, lease receipt or scheduler configuration.</p>
              <div className="agent-mesh-supervisor-preview__policy-export-actions">
                <label><span>Format</span><select value={policyExport} onChange={(event) => setPolicyExport(event.target.value)} aria-label="Supervisor policy export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
                <button type="button" className="button button--ghost" onClick={() => void copyPolicy()}><Copy size={13} /> Copy</button>
                <button type="button" className="button button--ghost" onClick={() => setAnnouncement(downloadSupervisorPolicy(policyExportText, policyExport === "json" ? "json" : "markdown") ? "Supervisor policy preview download started; native policy is unchanged." : "Browser download is unavailable; the preview remains renderer-local.")}><Download size={13} /> Download</button>
                <button type="button" className="button button--ghost" onClick={() => policyImportRef.current?.click()}><Upload size={13} /> Import JSON</button>
                <input ref={policyImportRef} hidden type="file" accept="application/json,.json" aria-label="Import supervisor policy preview JSON" onChange={(event) => void importPolicy(event.target.files?.[0])} />
              </div>
              <pre aria-label="Supervisor policy preview export">{policyExportText}</pre>
            </div>
          </section>

          <p className="agent-mesh-supervisor-preview__policy-note"><Info size={14} /><span>Policy cards describe the target contract. The draft editor is renderer-local only; it does not grant authority or prove that a native broker, scheduler or lease repository is connected. They do not grant renderer authority. {AGENT_MESH_SUPERVISOR_POLICY_BOUNDARY}</span></p>
        </div>
      ) : null}

      {view === "signals" ? (
        <div id="agent-mesh-supervisor-panel-signals" className="agent-mesh-supervisor-preview__signals" role="tabpanel" aria-labelledby="agent-mesh-supervisor-tab-signals" tabIndex={0}>
          {signalRows.map((signal) => <article className={`agent-mesh-supervisor-preview__signal agent-mesh-supervisor-preview__signal--${signal.tone}`} key={signal.label}><span>{signal.label}</span><strong>{signal.value}</strong><p>{signal.detail}</p></article>)}
          <div className="agent-mesh-supervisor-preview__signals-footer"><AlertTriangle size={14} /><span>Signals are calculated from the bounded fixture and renderer inputs. No supervisor event cursor, lease receipt or scheduler watermark is available.</span></div>
        </div>
      ) : null}

      {view === "flow" ? (
        <div id="agent-mesh-supervisor-panel-flow" className="agent-mesh-supervisor-preview__flow-panel" role="tabpanel" aria-labelledby="agent-mesh-supervisor-tab-flow" tabIndex={0}>
          <AgentMeshSupervisorFlow
            tasks={SUPERVISOR_TASKS}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
          />
        </div>
      ) : null}

      <p className="agent-mesh-supervisor-preview__status" role="status" aria-live="polite">{announcement}</p>
      <p className="agent-mesh-supervisor-preview__boundary"><Info size={14} /><span>Renderer-local supervisor projection. It does not spawn or reassign agents, reorder a durable queue, acquire leases, reconcile Project Twin, dispatch providers, execute tools, persist state or read the filesystem. {linkedWorkCount ? `${linkedWorkCount} background item${linkedWorkCount === 1 ? "" : "s"} are linked as renderer input.` : "No native background projection is linked."}</span></p>
    </section>
  );
}
