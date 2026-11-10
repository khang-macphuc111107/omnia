import {
  AlertTriangle,
  Bot,
  Check,
  Clipboard,
  Download,
  Flag,
  GitBranch,
  Info,
  ListChecks,
  RotateCcw,
  Search,
  ShieldCheck,
  SquareTerminal,
  Timer,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  PERMISSION_PREVIEW_BOUNDARY,
  permissionModeCounts,
  permissionPresetLabel,
  usePermissionSession,
} from "./session-permission-contract";

export type BackgroundTaskInspectorKind = "goal" | "task" | "agent" | "tool" | "approval" | "checkpoint";
export type BackgroundTaskInspectorState = "queued" | "working" | "blocked" | "needs-review" | "ready" | "completed" | "unknown";
export type BackgroundTaskInspectorFilter = "all" | BackgroundTaskInspectorKind;
export type BackgroundTaskInspectorExportFormat = "json" | "markdown";

export interface BackgroundTaskInspectorItem {
  readonly id: string;
  readonly kind: BackgroundTaskInspectorKind;
  readonly title: string;
  readonly owner: string;
  readonly state: BackgroundTaskInspectorState;
  readonly stage: string;
  readonly summary: string;
  readonly detail: string;
  readonly parentId?: string;
  readonly authority: string;
  readonly evidence: string;
}

const seedItems: readonly BackgroundTaskInspectorItem[] = [
  { id: "goal-omnia-phase", kind: "goal", title: "Shape the Omnia phase", owner: "You", state: "working", stage: "Phase 4 · UI integration", summary: "Coordinate the renderer workbenches into one inspectable workspace.", detail: "The goal is visible in the session projection; no native scheduler or completion judge is attached.", authority: "Planning only", evidence: "Renderer projection" },
  { id: "task-context-compiler", kind: "task", title: "Review context compiler decisions", owner: "Builder", state: "blocked", stage: "Context", summary: "Resolve omitted-candidate reasons before a future native freeze.", detail: "Waiting on an authoritative context receipt; the browser preview cannot freeze provider input.", parentId: "goal-omnia-phase", authority: "No dispatch authority", evidence: "Preview ledger" },
  { id: "agent-evidence-reviewer", kind: "agent", title: "Evidence reviewer", owner: "Reviewer", state: "needs-review", stage: "Review", summary: "Check claims, source coverage, and truthfulness boundaries.", detail: "A role card is shown for rehearsal only; no child agent, lease, mailbox, or provider call exists.", parentId: "goal-omnia-phase", authority: "Review suggestions", evidence: "Synthetic role profile" },
  { id: "tool-terminal-preview", kind: "tool", title: "Terminal compiler rehearsal", owner: "IDE", state: "queued", stage: "Tool plan", summary: "Preview a Node/Python/Rust command without starting a process.", detail: "The command is synthetic and remains disabled until a native execution bridge is available.", parentId: "task-context-compiler", authority: "No process execution", evidence: "Renderer-only draft" },
  { id: "approval-network-preview", kind: "approval", title: "Network route approval", owner: "You", state: "needs-review", stage: "Access", summary: "Review a planned provider endpoint and permission mode.", detail: "This card does not grant network access or persist an approval receipt.", parentId: "goal-omnia-phase", authority: "Preview decision", evidence: "Permission rehearsal" },
  { id: "checkpoint-twin-refresh", kind: "checkpoint", title: "Project Twin refresh", owner: "Verifier", state: "completed", stage: "Evidence", summary: "Twin revision was regenerated and checked on a frozen preview snapshot.", detail: "The receipt is local evidence for this session, not a durable release attestation.", parentId: "goal-omnia-phase", authority: "Evidence reference", evidence: "Deterministic check" },
];

const kindLabels: Record<BackgroundTaskInspectorKind, string> = {
  goal: "Goal",
  task: "Task",
  agent: "Agent",
  tool: "Tool",
  approval: "Approval",
  checkpoint: "Checkpoint",
};

const stateLabels: Record<BackgroundTaskInspectorState, string> = {
  queued: "Queued",
  working: "Working",
  blocked: "Blocked",
  "needs-review": "Needs review",
  ready: "Ready",
  completed: "Completed",
  unknown: "Unknown",
};

const kindIcons: Record<BackgroundTaskInspectorKind, typeof ListChecks> = {
  goal: Flag,
  task: ListChecks,
  agent: Bot,
  tool: Wrench,
  approval: ShieldCheck,
  checkpoint: Check,
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function serializeBackgroundTaskInspector(items: readonly BackgroundTaskInspectorItem[], format: BackgroundTaskInspectorExportFormat): string {
  const payload = {
    schema: "omnia.background-task-inspector.preview.v1",
    scope: "renderer-session",
    items,
    boundary: "No native task scheduler, agent spawn, tool execution, approval grant, or durable write.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia background task inspector preview",
    "",
    "- Scope: renderer-session",
    "- Boundary: no native task scheduler, agent spawn, tool execution, approval grant, or durable write.",
    "",
    ...items.flatMap((item) => [`## ${item.title} · ${kindLabels[item.kind]}`, "", `- State: ${stateLabels[item.state]}`, `- Owner: ${item.owner}`, `- Stage: ${item.stage}`, `- Summary: ${item.summary}`, ""]),
  ].join("\n");
}

export interface BackgroundTaskInspectorPreviewProps {
  readonly items?: readonly BackgroundTaskInspectorItem[];
}

export function BackgroundTaskInspectorPreview({ items = seedItems }: BackgroundTaskInspectorPreviewProps) {
  const [filter, setFilter] = useState<BackgroundTaskInspectorFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "");
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<BackgroundTaskInspectorExportFormat>("json");
  const [status, setStatus] = useState("Renderer-local task inspector preview.");
  const permissionSession = usePermissionSession();
  const permissionCounts = useMemo(() => permissionModeCounts(permissionSession.present), [permissionSession.present]);
  const permissionPreset = permissionPresetLabel(permissionSession.present);

  const visibleItems = useMemo(() => {
    const needle = normalize(query);
    return items.filter((item) => {
      if (filter !== "all" && item.kind !== filter) return false;
      if (!needle) return true;
      return [item.title, item.owner, item.stage, item.summary, item.detail, item.state, item.kind].some((value) => normalize(value).includes(needle));
    });
  }, [filter, items, query]);
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0] ?? null;
  const exportPayload = useMemo(() => serializeBackgroundTaskInspector(items, exportFormat), [exportFormat, items]);
  const counts = useMemo(() => ({
    attention: items.filter((item) => item.state === "blocked" || item.state === "needs-review").length,
    active: items.filter((item) => item.state === "queued" || item.state === "working").length,
    reviewed: reviewed.size,
  }), [items, reviewed]);

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; no task inspector data was copied."); return; }
    try { await navigator.clipboard.writeText(exportPayload); setStatus(`${exportFormat.toUpperCase()} inspector preview copied; no durable write was made.`); }
    catch { setStatus("Clipboard access was denied; the preview remains renderer-local."); }
  };

  const downloadExport = () => {
    const blob = new Blob([exportPayload], { type: exportFormat === "json" ? "application/json" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-background-task-inspector.${exportFormat === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`Started a browser download for the ${exportFormat.toUpperCase()} inspector preview.`);
  };

  return (
    <section className="background-task-inspector-preview" aria-label="Background task inspector preview">
      <header className="background-task-inspector-preview__header">
        <div>
          <span className="eyebrow"><ListChecks size={13} /> Work graph inspector</span>
          <h2>Goals, tasks, agents, tools, and approvals</h2>
          <p>Inspect the planned work graph in one place, with explicit boundaries for every authority-bearing action.</p>
        </div>
        <span className="background-task-inspector-preview__badge"><Info size={12} /> Preview only</span>
      </header>

      <div className="background-task-inspector-preview__metrics" aria-label="Background task inspector counts">
        <span><strong>{items.length}</strong><small>visible records</small></span>
        <span><strong>{counts.active}</strong><small>active or queued</small></span>
        <span><strong>{counts.attention}</strong><small>needs attention</small></span>
        <span><strong>{counts.reviewed}</strong><small>reviewed in preview</small></span>
      </div>

      <div className="background-task-inspector-preview__toolbar">
        <label className="background-task-inspector-preview__search"><span>Search records</span><span className="background-task-inspector-preview__search-control"><Search size={13} aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, owner, stage, state" aria-label="Search background task records" /></span></label>
        <label><span>Kind</span><select value={filter} onChange={(event) => setFilter(event.target.value as BackgroundTaskInspectorFilter)} aria-label="Background task inspector kind"><option value="all">All kinds</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className="button button--ghost" onClick={() => { setFilter("all"); setQuery(""); setReviewed(new Set()); setSelectedId(items[0]?.id ?? ""); setStatus("Background task inspector preview reset."); }}><RotateCcw size={13} /> Reset</button>
      </div>

      <div className="background-task-inspector-preview__body">
        <div className="background-task-inspector-preview__list" role="list" aria-label={`${visibleItems.length} background task inspector record${visibleItems.length === 1 ? "" : "s"}`}>
          {visibleItems.length === 0 ? <div className="background-task-inspector-preview__empty" role="status"><Search size={17} /><strong>No matching records</strong><small>Try another kind or search term.</small></div> : visibleItems.map((item) => {
            const Icon = kindIcons[item.kind];
            const isSelected = selected?.id === item.id;
            return <button key={item.id} type="button" role="listitem" aria-label={`${item.title}. ${stateLabels[item.state]}. ${item.summary}`} aria-pressed={isSelected} className={isSelected ? "background-task-inspector-preview__row is-selected" : "background-task-inspector-preview__row"} onClick={() => setSelectedId(item.id)}><span className="background-task-inspector-preview__row-icon"><Icon size={15} /></span><span className="background-task-inspector-preview__row-copy"><strong>{item.title}</strong><small>{item.summary}</small><em>{kindLabels[item.kind]} · {item.owner}</em></span><span className={`background-task-inspector-preview__state background-task-inspector-preview__state--${item.state}`}>{stateLabels[item.state]}</span></button>;
          })}
        </div>

        {selected ? <aside className="background-task-inspector-preview__detail" aria-label={`Details for ${selected.title}`}>
          <div className="background-task-inspector-preview__detail-heading"><span className="eyebrow">Selected record</span><span className={`background-task-inspector-preview__state background-task-inspector-preview__state--${selected.state}`}>{stateLabels[selected.state]}</span></div>
          <h3>{selected.title}</h3>
          <p>{selected.detail}</p>
          <dl><div><dt>Kind</dt><dd>{kindLabels[selected.kind]}</dd></div><div><dt>Owner</dt><dd>{selected.owner}</dd></div><div><dt>Stage</dt><dd>{selected.stage}</dd></div><div><dt>Authority</dt><dd>{selected.authority}</dd></div><div><dt>Evidence</dt><dd>{selected.evidence}</dd></div><div><dt>Parent</dt><dd>{selected.parentId ?? "Top-level record"}</dd></div></dl>
          {selected.kind === "approval" ? <section className="background-task-inspector-preview__approval-policy" aria-label="Approval permission policy preview">
            <div><span className="eyebrow">Shared permission policy</span><strong>{permissionPreset}</strong><small>Read from the renderer-session Permission Control Center.</small></div>
            <div className="background-task-inspector-preview__approval-policy-metrics"><span><strong>{permissionCounts.allow}</strong><small>allow</small></span><span><strong>{permissionCounts.prompt}</strong><small>ask</small></span><span><strong>{permissionCounts.deny}</strong><small>deny</small></span></div>
            <p><ShieldCheck size={12} /> {PERMISSION_PREVIEW_BOUNDARY} This approval card cannot convert the preview into authority.</p>
          </section> : null}
          <div className="background-task-inspector-preview__actions">
            <button type="button" className="button button--secondary" onClick={() => { setReviewed((current) => new Set(current).add(selected.id)); setStatus(`Marked ${selected.title} reviewed in this preview.`); }}><Check size={13} /> Mark reviewed</button>
            <button type="button" className="button button--ghost" onClick={() => setStatus(`Handoff rehearsal prepared for ${selected.title}; no agent was spawned.`)}><GitBranch size={13} /> Rehearse handoff</button>
            <button type="button" className="button button--ghost" disabled title="Native execution is not connected"><SquareTerminal size={13} /> Execute unavailable</button>
          </div>
          {reviewed.has(selected.id) ? <p className="background-task-inspector-preview__reviewed"><Check size={13} /> Reviewed in renderer session; no durable review receipt.</p> : null}
          <p className="background-task-inspector-preview__status" role="status" aria-label="Background task inspector status" aria-live="polite">{status}</p>
        </aside> : <aside className="background-task-inspector-preview__detail background-task-inspector-preview__detail--empty"><Timer size={18} /><strong>Select a record to inspect its authority boundary.</strong></aside>}
      </div>

      <div className="background-task-inspector-preview__export">
        <div className="background-task-inspector-preview__export-heading"><div><span className="eyebrow"><Download size={13} /> Portable view</span><strong>Export the inspector projection</strong></div><button type="button" className="button button--secondary" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="background-task-inspector-export">{exportOpen ? "Hide export" : "Preview export"}</button></div>
        {exportOpen ? <div id="background-task-inspector-export" className="background-task-inspector-preview__export-body"><div className="background-task-inspector-preview__export-toolbar"><label><span>Format</span><select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as BackgroundTaskInspectorExportFormat)} aria-label="Background task inspector export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--ghost" onClick={downloadExport}><Download size={13} /> Download</button></div><pre role="region" aria-label={`${exportFormat === "json" ? "JSON" : "Markdown"} background task inspector export preview`}>{exportPayload}</pre><p role="status" aria-label="Background task export status" aria-live="polite">{status}</p></div> : null}
      </div>

      <p className="background-task-inspector-preview__boundary"><AlertTriangle size={14} /><span>Renderer-local preview. No native task scheduler, agent spawn, lease, mailbox, tool execution, approval grant, provider request, or durable write is performed here.</span></p>
    </section>
  );
}

export default BackgroundTaskInspectorPreview;
