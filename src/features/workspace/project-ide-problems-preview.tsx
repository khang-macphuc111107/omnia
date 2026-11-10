import {
  AlertCircle,
  Check,
  CircleAlert,
  Clipboard,
  Copy,
  Info,
  PanelRight,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";

type ProblemSeverity = "error" | "warning" | "info";
type ProblemScope = "workspace" | "current-file";
type ProblemTriage = "unreviewed" | "reviewed" | "suppressed";

type PreviewProblem = {
  id: string;
  severity: ProblemSeverity;
  message: string;
  file: string;
  line: number;
  column: number;
  source: string;
  code: string;
};

const PREVIEW_PROBLEMS: readonly PreviewProblem[] = [
  {
    id: "problem-1",
    severity: "error",
    message: "Route union is missing the planned settings surface.",
    file: "src/router.ts",
    line: 1,
    column: 22,
    source: "TypeScript preview",
    code: "OMNIA-ROUTE-001",
  },
  {
    id: "problem-2",
    severity: "warning",
    message: "Greeting helper has no renderer-local usage in this preview.",
    file: "src/main.ts",
    line: 1,
    column: 17,
    source: "Preview lint",
    code: "OMNIA-LINT-004",
  },
  {
    id: "problem-3",
    severity: "warning",
    message: "Accent token is declared without a contrast note.",
    file: "src/styles/tokens.css",
    line: 2,
    column: 3,
    source: "Accessibility preview",
    code: "OMNIA-A11Y-002",
  },
  {
    id: "problem-4",
    severity: "info",
    message: "Test fixture is available for the selected greeting helper.",
    file: "src/main.test.ts",
    line: 4,
    column: 1,
    source: "Test inventory",
    code: "OMNIA-TEST-001",
  },
];

function severityIcon(severity: ProblemSeverity) {
  if (severity === "error") return <AlertCircle size={14} aria-hidden="true" />;
  if (severity === "warning") return <TriangleAlert size={14} aria-hidden="true" />;
  return <Info size={14} aria-hidden="true" />;
}

function severityLabel(severity: ProblemSeverity) {
  return severity === "error" ? "Error" : severity === "warning" ? "Warning" : "Info";
}

function triageLabel(triage: ProblemTriage) {
  return triage === "reviewed" ? "Reviewed" : triage === "suppressed" ? "Suppressed in preview" : "Needs review";
}

function formatPreviewProblems(problems: readonly PreviewProblem[]) {
  return problems
    .map((problem) => `${problem.severity.toUpperCase()} ${problem.code} ${problem.file}:${problem.line}:${problem.column} — ${problem.message}`)
    .join("\n");
}

export function ProjectIdeProblemsPreview({
  selectedPath,
  onOpenFile,
}: {
  readonly selectedPath: string;
  readonly onOpenFile: (path: string) => void;
}) {
  const [severity, setSeverity] = useState<ProblemSeverity | "all">("all");
  const [scope, setScope] = useState<ProblemScope>("workspace");
  const [triageFilter, setTriageFilter] = useState<ProblemTriage | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(PREVIEW_PROBLEMS[0]?.id ?? null);
  const [triage, setTriage] = useState<Record<string, ProblemTriage>>({});
  const [status, setStatus] = useState("Synthetic checks loaded · no command was run");

  const visibleProblems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return PREVIEW_PROBLEMS.filter((problem) => {
      if (severity !== "all" && problem.severity !== severity) return false;
      if (scope === "current-file" && problem.file !== selectedPath) return false;
      if (triageFilter !== "all" && (triage[problem.id] ?? "unreviewed") !== triageFilter) return false;
      if (!needle) return true;
      return `${problem.message} ${problem.file} ${problem.code} ${problem.source}`.toLowerCase().includes(needle);
    });
  }, [query, scope, selectedPath, severity, triage, triageFilter]);

  const selectedProblem = visibleProblems.find((problem) => problem.id === selectedProblemId)
    ?? visibleProblems[0]
    ?? null;

  const counts = useMemo(
    () => PREVIEW_PROBLEMS.reduce(
      (result, problem) => ({ ...result, [problem.severity]: result[problem.severity] + 1 }),
      { error: 0, warning: 0, info: 0 },
    ),
    [],
  );

  async function copyProblems() {
    const text = formatPreviewProblems(visibleProblems);
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable · diagnostics remain visible in preview");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`${visibleProblems.length} preview diagnostics copied · renderer-local only`);
    } catch {
      setStatus("Clipboard unavailable · diagnostics remain visible in preview");
    }
  }

  return (
    <section className="project-ide-problems-preview" aria-labelledby="project-ide-problems-heading">
      <header className="project-ide-problems-preview__header">
        <div>
          <span className="eyebrow">Checks and code intelligence preview</span>
          <h3 id="project-ide-problems-heading">Problems</h3>
          <p>Inspect synthetic diagnostics, narrow the context, and jump back to a preview file.</p>
        </div>
        <span className="project-ide-problems-preview__boundary"><ShieldCheck size={14} aria-hidden="true" /> Renderer-local</span>
      </header>

      <div className="project-ide-problems-preview__summary" aria-label="Preview problem counts">
        <span className="project-ide-problems-preview__count project-ide-problems-preview__count--error"><strong>{counts.error}</strong><small>errors</small></span>
        <span className="project-ide-problems-preview__count project-ide-problems-preview__count--warning"><strong>{counts.warning}</strong><small>warnings</small></span>
        <span className="project-ide-problems-preview__count project-ide-problems-preview__count--info"><strong>{counts.info}</strong><small>info</small></span>
        <span className="project-ide-problems-preview__summary-note"><Check size={13} aria-hidden="true" /> {visibleProblems.length} shown</span>
      </div>

      <div className="project-ide-problems-preview__toolbar" role="toolbar" aria-label="Preview problem filters">
        <label className="project-ide-problems-preview__search"><Search size={14} aria-hidden="true" /><span className="sr-only">Search preview problems</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search diagnostics" aria-label="Search preview problems" /></label>
        <label><span className="sr-only">Problem severity</span><select aria-label="Problem severity filter" value={severity} onChange={(event) => setSeverity(event.target.value as ProblemSeverity | "all")}><option value="all">All severities</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option></select></label>
        <label><span className="sr-only">Problem scope</span><select aria-label="Problem scope filter" value={scope} onChange={(event) => setScope(event.target.value as ProblemScope)}><option value="workspace">Workspace</option><option value="current-file">Current file</option></select></label>
        <label><span className="sr-only">Problem triage filter</span><select aria-label="Problem triage filter" value={triageFilter} onChange={(event) => setTriageFilter(event.target.value as ProblemTriage | "all")}><option value="all">All triage states</option><option value="unreviewed">Needs review</option><option value="reviewed">Reviewed</option><option value="suppressed">Suppressed in preview</option></select></label>
        <button type="button" className="button button--ghost" onClick={() => setStatus("Synthetic checks refreshed · no command was run")}><RefreshCw size={13} aria-hidden="true" /> Refresh preview</button>
        <button type="button" className="button button--ghost" onClick={() => void copyProblems()}><Copy size={13} aria-hidden="true" /> Copy</button>
      </div>

      <div className="project-ide-problems-preview__list" role="list" aria-label="Preview diagnostics">
        {visibleProblems.map((problem) => <article key={problem.id} className={`project-ide-problems-preview__item project-ide-problems-preview__item--${problem.severity}`} role="listitem">
          <button type="button" className="project-ide-problems-preview__item-main" onClick={() => { setSelectedProblemId(problem.id); onOpenFile(problem.file); setStatus(`${problem.code} opened at ${problem.file}:${problem.line}:${problem.column}`); }} aria-label={`Open ${problem.code} in ${problem.file}`}>
            <span className="project-ide-problems-preview__severity">{severityIcon(problem.severity)}<span>{severityLabel(problem.severity)}</span></span>
            <strong>{problem.message}</strong>
            <small>{problem.file}:{problem.line}:{problem.column} · {problem.code} · {problem.source} · {triageLabel(triage[problem.id] ?? "unreviewed")}</small>
          </button>
          <button type="button" className="project-ide-problems-preview__item-action" aria-label={`Inspect ${problem.code}`} onClick={() => setSelectedProblemId(problem.id)}><CircleAlert size={14} aria-hidden="true" /></button>
        </article>)}
        {visibleProblems.length === 0 ? <div className="project-ide-problems-preview__empty"><Check size={18} aria-hidden="true" /><strong>No matching preview problems</strong><small>Try another severity, scope, or search term.</small></div> : null}
      </div>

      {selectedProblem ? <aside className="project-ide-problems-preview__detail" aria-label="Selected preview diagnostic">
        <header><span><PanelRight size={14} /> Diagnostic detail</span><span className={`project-ide-problems-preview__triage project-ide-problems-preview__triage--${triage[selectedProblem.id] ?? "unreviewed"}`}>{triageLabel(triage[selectedProblem.id] ?? "unreviewed")}</span></header>
        <strong>{selectedProblem.code} · {selectedProblem.message}</strong>
        <small>{selectedProblem.file}:{selectedProblem.line}:{selectedProblem.column} · {selectedProblem.source}</small>
        <div className="project-ide-problems-preview__detail-actions">
          <button type="button" className="button button--ghost" onClick={() => { setTriage((current) => ({ ...current, [selectedProblem.id]: "reviewed" })); setStatus(`${selectedProblem.code} marked reviewed in preview`); }}>Mark reviewed</button>
          <button type="button" className="button button--ghost" onClick={() => { setTriage((current) => ({ ...current, [selectedProblem.id]: "suppressed" })); setStatus(`${selectedProblem.code} suppressed in preview`); }}>Suppress in preview</button>
          <button type="button" className="button button--ghost" onClick={() => { setTriage((current) => { const next = { ...current }; delete next[selectedProblem.id]; return next; }); setStatus(`${selectedProblem.code} triage reset in preview`); }}>Reset triage</button>
        </div>
        <p>Review state is renderer-local and session-only. No diagnostic was fixed, hidden from a native linter, or persisted.</p>
      </aside> : null}

      <div className="project-ide-problems-preview__status" role="status" aria-live="polite">{status}</div>
      <p className="project-ide-problems-preview__boundary-note"><Clipboard size={14} aria-hidden="true" /> Diagnostics are synthetic preview data. No compiler, linter, test runner, terminal, provider, filesystem read, or durable diagnostic receipt was used.</p>
    </section>
  );
}
