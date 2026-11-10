import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Clipboard,
  Download,
  Flag,
  Info,
  Milestone,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
} from "lucide-react";

export type PhaseCockpitStatus = "done" | "active" | "attention" | "planned";

export interface PhaseCockpitPhase {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly status: PhaseCockpitStatus;
  readonly progress: number;
  readonly summary: string;
  readonly outputs: readonly string[];
  readonly blockers: readonly string[];
  readonly nextAction: string;
  readonly surface: string;
}

export const PHASE_COCKPIT_PHASES: readonly PhaseCockpitPhase[] = Object.freeze([
  {
    id: "foundation",
    index: 1,
    title: "Foundation",
    status: "done",
    progress: 100,
    summary: "Core shell, browser preview, shared contracts, and the first provider route are shaped.",
    outputs: ["Desktop shell contract", "Provider preview", "Workspace store"],
    blockers: [],
    nextAction: "Keep the source ledger aligned with the moving tree.",
    surface: "Settings · Control Center",
  },
  {
    id: "workspace-ui",
    index: 2,
    title: "Workspace UI",
    status: "done",
    progress: 100,
    summary: "Chat, Project, Home, Library, settings, and the command surfaces are available for interaction.",
    outputs: ["Chat and Project modes", "Mission Control", "Search and export previews"],
    blockers: [],
    nextAction: "Use the preview to choose the next high-value interaction slice.",
    surface: "Home · Chats · Projects",
  },
  {
    id: "capability-studio",
    index: 3,
    title: "Capability studios",
    status: "active",
    progress: 78,
    summary: "Composer, memory, skills, research, media, evaluation, and toolchain workbenches are converging.",
    outputs: ["Composer controls", "Memory and skills review", "Science and evaluation labs"],
    blockers: ["Several surfaces still use renderer-session fixtures."],
    nextAction: "Choose one studio and connect its preview contract to a typed native boundary.",
    surface: "Settings · Library · Home workbenches",
  },
  {
    id: "evidence-handoff",
    index: 4,
    title: "Evidence and handoff",
    status: "attention",
    progress: 64,
    summary: "Receipts, exports, Project Twin projections, and release gates are visible but need one frozen snapshot.",
    outputs: ["Delivery evidence", "Handoff diff", "Diagnostics and exports"],
    blockers: ["Concurrent writers make aggregate gates snapshot-sensitive.", "Native receipts are not observed in this browser preview."],
    nextAction: "Freeze writers, refresh Project Twin, then capture one same-snapshot receipt.",
    surface: "Home · Delivery evidence · Release evidence",
  },
  {
    id: "native-vertical-slice",
    index: 5,
    title: "Native vertical slice",
    status: "planned",
    progress: 28,
    summary: "The source-level Tauri contracts are present; a supported Rust toolchain still needs to exercise them.",
    outputs: ["Guarded IPC contracts", "State and run-control schemas", "Provider gateway design"],
    blockers: ["cargo, rustc, and packaged Windows runtime are not verified on this host."],
    nextAction: "Run the native compile and packaged smoke gate on a supported Windows toolchain.",
    surface: "Native runtime · Planned",
  },
]);

const STATUS_LABELS: Record<PhaseCockpitStatus, string> = {
  done: "Complete",
  active: "In progress",
  attention: "Needs review",
  planned: "Planned",
};

type StatusFilter = "all" | PhaseCockpitStatus;
type ExportFormat = "json" | "markdown";

function serializePhaseCockpit(phases: readonly PhaseCockpitPhase[], format: ExportFormat): string {
  const counts = phases.reduce<Record<PhaseCockpitStatus, number>>((result, phase) => {
    result[phase.status] += 1;
    return result;
  }, { done: 0, active: 0, attention: 0, planned: 0 });
  const payload = {
    schema: "omnia.phase-cockpit.preview.v1",
    scope: "renderer-session",
    snapshot: "moving-tree-ui-preview-2026-09-25",
    counts,
    phases,
    boundary: [
      "Phase status is a renderer-local projection, not a native lifecycle receipt.",
      "Progress values are planning cues and do not prove implementation coverage.",
      "This preview does not dispatch agents, providers, compilers, or release actions.",
    ],
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia phase cockpit preview",
    "",
    "> Renderer-local planning projection. Status and progress are not native lifecycle receipts.",
    "",
    `- Snapshot: ${payload.snapshot}`,
    `- Complete: ${counts.done}`,
    `- In progress: ${counts.active}`,
    `- Needs review: ${counts.attention}`,
    `- Planned: ${counts.planned}`,
    "",
    ...phases.flatMap((phase) => [
      `## ${phase.index}. ${phase.title}`,
      `- Status: ${STATUS_LABELS[phase.status]}`,
      `- Progress cue: ${phase.progress}%`,
      `- Surface: ${phase.surface}`,
      `- Summary: ${phase.summary}`,
      `- Next: ${phase.nextAction}`,
      ...(phase.blockers.length ? [`- Blockers: ${phase.blockers.join("; ")}`] : []),
      "",
    ]),
    "## Boundary",
    ...payload.boundary.map((item) => `- ${item}`),
  ].join("\n");
}

function statusIcon(status: PhaseCockpitStatus) {
  if (status === "done") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === "attention") return <ShieldAlert size={14} aria-hidden="true" />;
  if (status === "active") return <Sparkles size={14} aria-hidden="true" />;
  return <Milestone size={14} aria-hidden="true" />;
}

export function PhaseCockpitPreview() {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState(PHASE_COCKPIT_PHASES[2]?.id ?? "");
  const [format, setFormat] = useState<ExportFormat>("json");
  const [notice, setNotice] = useState("Phase cues are renderer-local and ready for review.");

  const visiblePhases = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return PHASE_COCKPIT_PHASES.filter((phase) => {
      const matchesQuery = !normalized || [phase.title, phase.summary, phase.surface, phase.nextAction, ...phase.outputs, ...phase.blockers].join(" ").toLowerCase().includes(normalized);
      return matchesQuery && (statusFilter === "all" || phase.status === statusFilter);
    });
  }, [query, statusFilter]);
  const selected = visiblePhases.find((phase) => phase.id === selectedId) ?? visiblePhases[0] ?? null;
  const counts = useMemo(() => PHASE_COCKPIT_PHASES.reduce<Record<PhaseCockpitStatus, number>>((result, phase) => {
    result[phase.status] += 1;
    return result;
  }, { done: 0, active: 0, attention: 0, planned: 0 }), []);
  const payload = useMemo(() => serializePhaseCockpit(visiblePhases, format), [format, visiblePhases]);

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setNotice("Clipboard unavailable; no phase cockpit preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setNotice(`Copied ${format.toUpperCase()} phase cockpit preview; no durable write was made.`);
    } catch {
      setNotice("Clipboard access was denied; nothing was copied.");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-phase-cockpit-preview.${format === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Browser download started; no durable phase receipt was created.");
  };
  const reset = () => {
    setQuery("");
    setStatusFilter("all");
    setSelectedId(PHASE_COCKPIT_PHASES[2]?.id ?? "");
    setFormat("json");
    setNotice("Phase cockpit view reset to the renderer preview defaults.");
  };

  return (
    <section className="phase-cockpit-preview" aria-labelledby="phase-cockpit-preview-heading">
      <header className="phase-cockpit-preview__header">
        <div>
          <span className="eyebrow"><Milestone size={13} /> Planning · delivery · runtime</span>
          <h2 id="phase-cockpit-preview-heading">Phase cockpit</h2>
          <p>See the current work arc, the next safe boundary, and the proof still missing before promotion.</p>
        </div>
        <span className="phase-cockpit-preview__badge"><Flag size={13} /> Preview only</span>
      </header>

      <div className="phase-cockpit-preview__summary" aria-label="Phase cockpit summary">
        <article><CheckCircle2 size={15} /><span>Complete</span><strong>{counts.done}</strong><small>phase cues</small></article>
        <article><Sparkles size={15} /><span>In progress</span><strong>{counts.active}</strong><small>active phase</small></article>
        <article><ShieldAlert size={15} /><span>Needs review</span><strong>{counts.attention}</strong><small>evidence-sensitive</small></article>
        <article><Milestone size={15} /><span>Planned</span><strong>{counts.planned}</strong><small>native boundary</small></article>
      </div>

      <div className="phase-cockpit-preview__toolbar" role="toolbar" aria-label="Phase cockpit filters">
        <label className="phase-cockpit-preview__search"><Search size={14} /><span className="sr-only">Search phase cockpit</span><input aria-label="Search phase cockpit" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search phase, output, blocker, or next step" /></label>
        <label><span>Status</span><select aria-label="Filter phase cockpit status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}><option value="all">All phases</option><option value="done">Complete</option><option value="active">In progress</option><option value="attention">Needs review</option><option value="planned">Planned</option></select></label>
        <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset view</button>
        <span className="phase-cockpit-preview__result" aria-label={`${visiblePhases.length} of ${PHASE_COCKPIT_PHASES.length} phases`}>{visiblePhases.length} of {PHASE_COCKPIT_PHASES.length} phases</span>
      </div>

      <div className="phase-cockpit-preview__layout">
        <div className="phase-cockpit-preview__list" role="list" aria-label="Phase cockpit phases">
          {visiblePhases.map((phase) => (
            <button type="button" role="listitem" key={phase.id} className={`phase-cockpit-preview__phase${selected?.id === phase.id ? " is-selected" : ""}`} onClick={() => setSelectedId(phase.id)} aria-pressed={selected?.id === phase.id}>
              <span className="phase-cockpit-preview__phase-index">{phase.index}</span>
              <span><strong>{phase.title}</strong><small>{phase.summary}</small><em className={`phase-cockpit-preview__status phase-cockpit-preview__status--${phase.status}`}>{statusIcon(phase.status)} {STATUS_LABELS[phase.status]} · {phase.progress}%</em></span>
            </button>
          ))}
          {!visiblePhases.length ? <div className="phase-cockpit-preview__empty" role="status"><Search size={18} /><strong>No phases match</strong><span>Try another search or clear the status filter.</span></div> : null}
        </div>

        <aside className="phase-cockpit-preview__detail" aria-label="Selected phase detail">
          {selected ? (
            <>
              <header><div><span className="eyebrow">Phase {selected.index} · {selected.surface}</span><h3>{selected.title}</h3></div><span className={`phase-cockpit-preview__status phase-cockpit-preview__status--${selected.status}`}>{statusIcon(selected.status)} {STATUS_LABELS[selected.status]}</span></header>
              <p>{selected.summary}</p>
              <div className="phase-cockpit-preview__progress" aria-label={`${selected.progress}% progress cue`}><span style={{ width: `${selected.progress}%` }} /></div>
              <div className="phase-cockpit-preview__progress-meta"><span>{selected.progress}% progress cue</span><small>planning signal only</small></div>
              <dl><div><dt>Next safe action</dt><dd>{selected.nextAction}</dd></div><div><dt>Visible outputs</dt><dd><ul>{selected.outputs.map((output) => <li key={output}>{output}</li>)}</ul></dd></div><div><dt>Open blockers</dt><dd>{selected.blockers.length ? <ul>{selected.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : "No blocker listed in this projection."}</dd></div></dl>
            </>
          ) : <div className="phase-cockpit-preview__empty"><Info size={18} /><strong>Select a phase</strong><span>The selected phase summary will appear here.</span></div>}
        </aside>
      </div>

      <section className="phase-cockpit-preview__export" aria-label="Phase cockpit export preview">
        <header><div><span className="eyebrow"><Clipboard size={13} /> Portable planning brief</span><strong>Export the visible phase set</strong></div><label><span>Format</span><select aria-label="Phase cockpit export format" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></header>
        <p className="phase-cockpit-preview__notice" role="status" aria-live="polite">{notice}</p>
        <pre><code>{payload}</code></pre>
      </section>

      <p className="phase-cockpit-preview__boundary" role="note" aria-label="Phase cockpit boundary"><ShieldAlert size={14} /> This board is renderer-local and preview-only. It does not mark native phases complete, dispatch agents, call providers, run compilers, refresh Project Twin, or create a durable receipt.</p>
    </section>
  );
}

export default PhaseCockpitPreview;
