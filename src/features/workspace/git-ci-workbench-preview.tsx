import {
  Activity,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Cloud,
  Copy,
  Download,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  Layers3,
  ListChecks,
  Play,
  Plus,
  RotateCcw,
  Rocket,
  Search,
  ShieldCheck,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useMemo, useState, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

type GitCiTab = "changes" | "branches" | "pipelines" | "release" | "history";
type ChangeKind = "modified" | "added" | "deleted";
type PipelineStatus = "passing" | "running" | "failed" | "queued" | "skipped";
type ReleaseEnvironment = "Preview" | "Staging" | "Production";
type ReleaseChannel = "Canary" | "Stable" | "Nightly";
type ExportFormat = "json" | "markdown";
type DeliveryEventKind = "stage" | "commit" | "branch" | "pipeline" | "release" | "checklist";
type DeliveryEventFilter = "all" | DeliveryEventKind;

type PreviewChange = {
  id: string;
  path: string;
  kind: ChangeKind;
  additions: number;
  deletions: number;
  area: string;
  staged: boolean;
};

type PreviewBranch = {
  id: string;
  name: string;
  ahead: number;
  behind: number;
  protection: "Protected" | "Preview only" | "Review required";
  lastCommit: string;
};

type PreviewPipeline = {
  id: string;
  name: string;
  trigger: "push" | "pull_request" | "manual";
  status: PipelineStatus;
  duration: string;
  passed: number;
  total: number;
  commit: string;
  jobs: string[];
};

type ReleaseChecklist = {
  checks: boolean;
  changelog: boolean;
  artifacts: boolean;
  approvals: boolean;
};

type CustomReleaseChecklistItem = {
  id: string;
  label: string;
  detail: string;
  checked: boolean;
};

type ReleaseEvidenceStatus = "ready" | "watch" | "planned";

type ReleaseEvidence = {
  id: string;
  label: string;
  status: ReleaseEvidenceStatus;
  detail: string;
};

type DeliveryEvent = {
  id: string;
  kind: DeliveryEventKind;
  label: string;
  detail: string;
  occurredAt: string;
};

const INITIAL_CHANGES: PreviewChange[] = [
  { id: "change-ide", path: "src/features/workspace/project-ide-preview.tsx", kind: "modified", additions: 128, deletions: 18, area: "Workspace IDE", staged: false },
  { id: "change-style", path: "src/styles/project-ide-preview.css", kind: "modified", additions: 92, deletions: 2, area: "Dark UI system", staged: true },
  { id: "change-roadmap", path: "docs/roadmap.md", kind: "added", additions: 36, deletions: 0, area: "Delivery docs", staged: false },
  { id: "change-native", path: "src-tauri/src/lib.rs", kind: "modified", additions: 14, deletions: 6, area: "Native boundary", staged: false },
];

const INITIAL_BRANCHES: PreviewBranch[] = [
  { id: "branch-main", name: "preview/main", ahead: 2, behind: 0, protection: "Protected", lastCommit: "a13f2c9" },
  { id: "branch-ui", name: "preview/feature/ui", ahead: 5, behind: 1, protection: "Review required", lastCommit: "8f40b1a" },
  { id: "branch-release", name: "preview/release-candidate", ahead: 0, behind: 3, protection: "Preview only", lastCommit: "5d22e1c" },
];

const INITIAL_PIPELINES: PreviewPipeline[] = [
  { id: "pipeline-main", name: "CI / main", trigger: "push", status: "passing", duration: "2m 18s", passed: 7, total: 7, commit: "a13f2c9", jobs: ["typecheck", "focused tests", "renderer build", "bundle budget", "typography", "source ledger", "Project Twin"] },
  { id: "pipeline-preview", name: "Preview / pull request", trigger: "pull_request", status: "queued", duration: "—", passed: 0, total: 5, commit: "8f40b1a", jobs: ["lint", "focused tests", "accessibility", "preview build", "artifact manifest"] },
  { id: "pipeline-release", name: "Release / canary", trigger: "manual", status: "skipped", duration: "—", passed: 0, total: 4, commit: "5d22e1c", jobs: ["signed bundle", "migration rehearsal", "smoke check", "rollback plan"] },
];

const INITIAL_RELEASE: ReleaseChecklist = { checks: true, changelog: false, artifacts: true, approvals: false };

const INITIAL_CUSTOM_RELEASE_CHECKLIST: CustomReleaseChecklistItem[] = [];

const INITIAL_RELEASE_EVIDENCE: ReleaseEvidence[] = [
  { id: "source", label: "Source identity", status: "ready", detail: "Synthetic branch and candidate metadata are present for this session." },
  { id: "gates", label: "Quality gates", status: "watch", detail: "Preview pipeline fixtures are visible; native CI receipts are not connected." },
  { id: "artifacts", label: "Artifact provenance", status: "watch", detail: "Artifact plan is shaped, but no package, hash, or upload was produced." },
  { id: "approval", label: "Approval and rollback", status: "planned", detail: "Native approval receipt and rollback rehearsal remain Planned." },
];

const INITIAL_EVENTS: DeliveryEvent[] = [
  {
    id: "event-1",
    kind: "stage",
    label: "Synthetic delivery snapshot loaded",
    detail: "Working-tree, branch, CI, and release records are renderer fixtures.",
    occurredAt: "Session start · preview",
  },
];

function statusLabel(status: PipelineStatus): string {
  if (status === "passing") return "Passing";
  if (status === "running") return "Running";
  if (status === "failed") return "Needs attention";
  if (status === "queued") return "Queued";
  return "Skipped";
}

function triggerLabel(trigger: PreviewPipeline["trigger"]): string {
  if (trigger === "pull_request") return "Pull request";
  if (trigger === "manual") return "Manual";
  return "Push";
}

function eventKindLabel(kind: DeliveryEventKind): string {
  if (kind === "stage") return "Working tree";
  if (kind === "commit") return "Commit";
  if (kind === "branch") return "Branch";
  if (kind === "pipeline") return "CI pipeline";
  if (kind === "checklist") return "Checklist";
  return "Release";
}

function releaseEvidenceLabel(status: ReleaseEvidenceStatus): string {
  if (status === "ready") return "Ready";
  if (status === "watch") return "Watch";
  return "Planned";
}

function formatExport(payload: Record<string, unknown>, format: ExportFormat): string {
  if (format === "json") return JSON.stringify(payload, null, 2);
  const branches = Array.isArray(payload.branches) ? payload.branches as Array<Record<string, unknown>> : [];
  const changes = Array.isArray(payload.changes) ? payload.changes as Array<Record<string, unknown>> : [];
  const pipelines = Array.isArray(payload.pipelines) ? payload.pipelines as Array<Record<string, unknown>> : [];
  const events = Array.isArray(payload.events) ? payload.events as Array<Record<string, unknown>> : [];
  const evidence = Array.isArray(payload.releaseEvidence) ? payload.releaseEvidence as Array<Record<string, unknown>> : [];
  const release = payload.release && typeof payload.release === "object" ? payload.release as Record<string, unknown> : {};
  const checklist = release.checklist && typeof release.checklist === "object" ? release.checklist as Record<string, unknown> : {};
  const customChecklist = Array.isArray(release.customChecklist) ? release.customChecklist as Array<Record<string, unknown>> : [];
  const lines = [
    "# Git & CI/CD workbench preview",
    "",
    `- Project: ${String(payload.projectName ?? "Unknown")}`,
    `- Branch: ${String(payload.currentBranch ?? "Unknown")}`,
    "- Scope: renderer-session preview",
    "",
    "## Working tree",
    ...changes.map((change) => `- ${change.staged ? "[x]" : "[ ]"} ${change.path} (${change.kind}, +${change.additions}/-${change.deletions})`),
    "",
    "## Branches",
    ...branches.map((branch) => `- ${branch.name} · ahead ${branch.ahead} · behind ${branch.behind} · ${branch.protection}`),
    "",
    "## Pipelines",
    ...pipelines.map((pipeline) => `- ${pipeline.name} · ${statusLabel(pipeline.status as PipelineStatus)} · ${pipeline.passed}/${pipeline.total} jobs · ${triggerLabel(pipeline.trigger as PreviewPipeline["trigger"])}`),
    "",
    "## Release checklist",
    `- Target: ${String(release.environment ?? "Preview")} · ${String(release.channel ?? "Canary")}`,
    `- Handoff note: ${String(release.releaseNote ?? "")}`,
    ...Object.entries(checklist).map(([key, checked]) => `- ${checked ? "[x]" : "[ ]"} ${key}`),
    ...customChecklist.map((item) => `- ${item.checked ? "[x]" : "[ ]"} ${String(item.label ?? "Custom gate")}: ${String(item.detail ?? "")}`),
    "",
    "## Release evidence",
    ...evidence.map((item) => `- ${releaseEvidenceLabel(item.status as ReleaseEvidenceStatus)} · ${item.label}: ${item.detail}`),
    "",
    "## Delivery activity",
    ...events.map((event) => `- ${event.occurredAt} · ${eventKindLabel(event.kind as DeliveryEventKind)} · ${event.label}: ${event.detail}`),
    "",
    "## Boundary",
    "Renderer-local preview only. No Git command, branch creation, commit, push, CI webhook, provider request, deployment, or durable release receipt was created.",
  ];
  return lines.join("\n");
}

function downloadText(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function GitCiWorkbenchPreview({ projectName }: { readonly projectName: string }) {
  const [activeTab, setActiveTab] = useState<GitCiTab>("changes");
  const [changes, setChanges] = useState<PreviewChange[]>(INITIAL_CHANGES);
  const [branches, setBranches] = useState<PreviewBranch[]>(INITIAL_BRANCHES);
  const [pipelines, setPipelines] = useState<PreviewPipeline[]>(INITIAL_PIPELINES);
  const [currentBranchId, setCurrentBranchId] = useState("branch-main");
  const [selectedChangeId, setSelectedChangeId] = useState("change-ide");
  const [selectedPipelineId, setSelectedPipelineId] = useState("pipeline-main");
  const [branchQuery, setBranchQuery] = useState("");
  const [pipelineFilter, setPipelineFilter] = useState<"all" | PipelineStatus>("all");
  const [commitMessage, setCommitMessage] = useState("feat(ui): refine project workbench");
  const [newBranchName, setNewBranchName] = useState("");
  const [environment, setEnvironment] = useState<ReleaseEnvironment>("Preview");
  const [channel, setChannel] = useState<ReleaseChannel>("Canary");
  const [release, setRelease] = useState<ReleaseChecklist>(INITIAL_RELEASE);
  const [customReleaseChecklist, setCustomReleaseChecklist] = useState<CustomReleaseChecklistItem[]>(INITIAL_CUSTOM_RELEASE_CHECKLIST);
  const [customChecklistLabel, setCustomChecklistLabel] = useState("");
  const [customChecklistDetail, setCustomChecklistDetail] = useState("");
  const [releaseNote, setReleaseNote] = useState("UI-first delivery rehearsal · no artifact was produced");
  const [releaseEvidence] = useState<ReleaseEvidence[]>(INITIAL_RELEASE_EVIDENCE);
  const [events, setEvents] = useState<DeliveryEvent[]>(INITIAL_EVENTS);
  const [eventSequence, setEventSequence] = useState(INITIAL_EVENTS.length + 1);
  const [eventQuery, setEventQuery] = useState("");
  const [eventFilter, setEventFilter] = useState<DeliveryEventFilter>("all");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [status, setStatus] = useState("Synthetic delivery snapshot loaded · no repository was read");

  const currentBranch = branches.find((branch) => branch.id === currentBranchId) ?? branches[0]!;
  const selectedChange = changes.find((change) => change.id === selectedChangeId) ?? changes[0]!;
  const selectedPipeline = pipelines.find((pipeline) => pipeline.id === selectedPipelineId) ?? pipelines[0]!;
  const stagedCount = changes.filter((change) => change.staged).length;
  const filteredBranches = useMemo(() => {
    const needle = branchQuery.trim().toLowerCase();
    return needle ? branches.filter((branch) => branch.name.toLowerCase().includes(needle)) : branches;
  }, [branchQuery, branches]);
  const filteredPipelines = useMemo(() => pipelineFilter === "all" ? pipelines : pipelines.filter((pipeline) => pipeline.status === pipelineFilter), [pipelineFilter, pipelines]);
  const visibleEvents = useMemo(() => {
    const needle = eventQuery.trim().toLowerCase();
    return events.filter((event) => {
      const matchesQuery = !needle || [event.label, event.detail, event.occurredAt, eventKindLabel(event.kind)].some((value) => value.toLowerCase().includes(needle));
      return matchesQuery && (eventFilter === "all" || event.kind === eventFilter);
    });
  }, [eventFilter, eventQuery, events]);
  const completedReleaseChecks = Object.values(release).filter(Boolean).length + customReleaseChecklist.filter((item) => item.checked).length;
  const releaseChecklistTotal = Object.keys(release).length + customReleaseChecklist.length;
  const releaseEvidenceCounts = useMemo(() => releaseEvidence.reduce((counts, item) => {
    counts[item.status] += 1;
    return counts;
  }, { ready: 0, watch: 0, planned: 0 } as Record<ReleaseEvidenceStatus, number>), [releaseEvidence]);
  const exportPayload = useMemo(() => ({
    schema: "omnia.git-ci-workbench-preview.v1",
    projectName,
    currentBranch: currentBranch.name,
    changes,
    branches,
    pipelines,
    events,
    releaseEvidence,
    release: { environment, channel, releaseNote, checklist: release, customChecklist: customReleaseChecklist, checklistTotal: releaseChecklistTotal },
    boundary: "renderer-local-preview",
  }), [branches, changes, channel, currentBranch.name, customReleaseChecklist, environment, events, pipelines, projectName, release, releaseChecklistTotal, releaseEvidence, releaseNote]);
  const exportText = useMemo(() => formatExport(exportPayload, exportFormat), [exportFormat, exportPayload]);

  function recordEvent(kind: DeliveryEventKind, label: string, detail: string) {
    const id = `event-${eventSequence}`;
    setEventSequence((current) => current + 1);
    setEvents((current) => [{ id, kind, label, detail, occurredAt: "Just now · preview" }, ...current]);
  }

  function toggleStage(changeId: string) {
    setChanges((items) => items.map((item) => item.id === changeId ? { ...item, staged: !item.staged } : item));
    const item = changes.find((change) => change.id === changeId);
    const nextState = item?.staged ? "unstaged" : "staged";
    setStatus(`${item?.path ?? "Change"} ${nextState} in preview`);
    recordEvent("stage", `${nextState === "staged" ? "Staged" : "Unstaged"} change`, item?.path ?? "Synthetic change");
  }

  function stageAll(staged: boolean) {
    setChanges((items) => items.map((item) => ({ ...item, staged })));
    setStatus(staged ? "All synthetic changes staged in preview" : "All synthetic changes unstaged in preview");
    recordEvent("stage", staged ? "Staged all changes" : "Unstaged all changes", `${changes.length} synthetic file${changes.length === 1 ? "" : "s"}`);
  }

  function createCommitPreview() {
    if (stagedCount === 0) {
      setStatus("Select at least one change before creating a commit preview");
      return;
    }
    setBranches((items) => items.map((branch) => branch.id === currentBranchId ? { ...branch, ahead: branch.ahead + 1, lastCommit: "preview" } : branch));
    setChanges((items) => items.filter((item) => !item.staged));
    setStatus(`Commit preview prepared: ${commitMessage.trim() || "(message required)"} · no Git commit was created`);
    recordEvent("commit", "Prepared commit preview", `${stagedCount} staged file${stagedCount === 1 ? "" : "s"} · ${commitMessage.trim() || "(message required)"}`);
  }

  function createBranchPreview() {
    const normalized = newBranchName.trim().replace(/\s+/g, "-");
    if (!normalized) {
      setStatus("Enter a branch name before creating a branch preview");
      return;
    }
    const id = `branch-${normalized.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
    if (branches.some((branch) => branch.id === id)) {
      setStatus("That branch already exists in the preview");
      return;
    }
    setBranches((items) => [...items, { id, name: normalized, ahead: 0, behind: currentBranch.behind, protection: "Preview only", lastCommit: "preview" }]);
    setCurrentBranchId(id);
    setNewBranchName("");
    setStatus(`${normalized} branch preview created · no native branch was created`);
    recordEvent("branch", "Created branch preview", `${normalized} · based on ${currentBranch.name}`);
  }

  function runPipelinePreview(pipelineId: string) {
    const pipeline = pipelines.find((item) => item.id === pipelineId);
    setPipelines((items) => items.map((item) => item.id === pipelineId ? { ...item, status: "running", duration: "rehearsing" } : item));
    setSelectedPipelineId(pipelineId);
    setStatus(`${pipeline?.name ?? "Pipeline"} rehearsal started · no CI request was sent`);
    recordEvent("pipeline", "Started CI rehearsal", pipeline?.name ?? "Synthetic pipeline");
  }

  function prepareReleasePreview() {
    setReleaseNote(`${channel} release for ${environment} prepared in preview · ${completedReleaseChecks}/${releaseChecklistTotal} checks ready`);
    setStatus(`Release checklist prepared for ${environment} · ${releaseEvidenceCounts.ready} ready · ${releaseEvidenceCounts.watch} watch · deployment remains Planned`);
    recordEvent("release", "Prepared release handoff", `${environment} · ${channel} · ${completedReleaseChecks}/${releaseChecklistTotal} checks ready · ${releaseEvidenceCounts.planned} planned evidence item${releaseEvidenceCounts.planned === 1 ? "" : "s"}`);
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const tabOrder: GitCiTab[] = ["changes", "branches", "pipelines", "release", "history"];
    const currentIndex = tabOrder.indexOf(activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabOrder.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabOrder.length) % tabOrder.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabOrder.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveTab(tabOrder[nextIndex]!);
    document.getElementById(`git-ci-tab-${tabOrder[nextIndex]!}`)?.focus();
  }

  async function copyExport() {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable · export remains visible in preview");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportText);
      setStatus(`${exportFormat.toUpperCase()} delivery snapshot copied · renderer-local only`);
    } catch {
      setStatus("Clipboard unavailable · export remains visible in preview");
    }
  }

  function downloadExport() {
    downloadText(`omnia-git-ci-preview.${exportFormat === "json" ? "json" : "md"}`, exportText, exportFormat === "json" ? "application/json" : "text/markdown");
    setStatus(`${exportFormat.toUpperCase()} delivery snapshot download prepared in browser preview`);
  }

  function setChecklist(key: keyof ReleaseChecklist, event: ChangeEvent<HTMLInputElement>) {
    setRelease((current) => ({ ...current, [key]: event.target.checked }));
    setStatus(`${key} checklist state changed in release preview`);
    recordEvent("checklist", `${event.target.checked ? "Checked" : "Unchecked"} release item`, key);
  }

  function addCustomChecklistItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = customChecklistLabel.trim();
    const detail = customChecklistDetail.trim() || "Custom session gate · no native receipt attached";
    if (!label) {
      setStatus("Enter a label before adding a custom release checklist item");
      return;
    }
    if (customReleaseChecklist.length >= 12) {
      setStatus("Custom release checklist is limited to 12 session items");
      return;
    }
    const normalized = label.toLowerCase();
    if (customReleaseChecklist.some((item) => item.label.toLowerCase() === normalized)) {
      setStatus("That custom release checklist item already exists in this preview");
      return;
    }
    const id = `custom-${normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "gate"}-${customReleaseChecklist.length + 1}`;
    setCustomReleaseChecklist((current) => [...current, { id, label, detail, checked: false }]);
    setCustomChecklistLabel("");
    setCustomChecklistDetail("");
    setStatus(`${label} added to the release checklist preview`);
    recordEvent("checklist", "Added custom release item", label);
  }

  function setCustomChecklistItem(itemId: string, checked: boolean) {
    const item = customReleaseChecklist.find((entry) => entry.id === itemId);
    setCustomReleaseChecklist((current) => current.map((entry) => entry.id === itemId ? { ...entry, checked } : entry));
    setStatus(`${item?.label ?? "Custom release item"} ${checked ? "checked" : "unchecked"} in release preview`);
    recordEvent("checklist", `${checked ? "Checked" : "Unchecked"} custom release item`, item?.label ?? itemId);
  }

  function removeCustomChecklistItem(itemId: string) {
    const item = customReleaseChecklist.find((entry) => entry.id === itemId);
    setCustomReleaseChecklist((current) => current.filter((entry) => entry.id !== itemId));
    setStatus(`${item?.label ?? "Custom release item"} removed from the release checklist preview`);
    recordEvent("checklist", "Removed custom release item", item?.label ?? itemId);
  }

  function resetReleaseChecklist() {
    setRelease(INITIAL_RELEASE);
    setCustomReleaseChecklist(INITIAL_CUSTOM_RELEASE_CHECKLIST);
    setCustomChecklistLabel("");
    setCustomChecklistDetail("");
    setStatus("Release checklist reset to the default preview");
    recordEvent("checklist", "Reset release checklist", "Default four-item checklist restored");
  }

  function resetEventHistory() {
    setEvents(INITIAL_EVENTS);
    setEventSequence(INITIAL_EVENTS.length + 1);
    setEventQuery("");
    setEventFilter("all");
    setStatus("Delivery activity reset for this renderer session");
  }

  return (
    <section className="git-ci-workbench-preview" aria-labelledby="git-ci-workbench-preview-heading">
      <header className="git-ci-workbench-preview__header">
        <div>
          <span className="eyebrow">Delivery cockpit preview</span>
          <h3 id="git-ci-workbench-preview-heading">Git &amp; CI/CD workbench</h3>
          <p>Review changes, rehearse pipelines, and shape a release handoff while the native delivery bridge is still Planned.</p>
        </div>
        <span className="git-ci-workbench-preview__boundary"><GitPullRequest size={14} /> Renderer-local</span>
      </header>

      <div className="git-ci-workbench-preview__summary">
        <div className="git-ci-workbench-preview__branch-summary"><GitBranch size={14} /><span><strong>{currentBranch.name}</strong><small>synthetic branch snapshot</small></span></div>
        <label className="git-ci-workbench-preview__branch-select"><span className="sr-only">Current preview branch</span><select value={currentBranchId} onChange={(event) => { setCurrentBranchId(event.target.value); setStatus("Preview branch selected · no checkout occurred"); }} aria-label="Current preview branch">{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><ChevronRight size={13} /></label>
        <span className="git-ci-workbench-preview__summary-status"><span className={`status-dot ${changes.length > 0 ? "status-dot--warning" : "status-dot--success"}`} />{changes.length > 0 ? `${changes.length} working-tree changes` : "Working tree preview clean"}</span>
      </div>

      <div className="git-ci-workbench-preview__metrics" aria-label="Delivery preview summary">
        <article><span><Layers3 size={14} /> Changes</span><strong>{changes.length}</strong><small>{stagedCount} staged · {changes.reduce((total, item) => total + item.additions, 0)} additions</small></article>
        <article><span><GitBranch size={14} /> Branch</span><strong>{currentBranch.ahead}/{currentBranch.behind}</strong><small>ahead / behind · {currentBranch.protection}</small></article>
        <article><span><Activity size={14} /> CI health</span><strong>{pipelines.filter((pipeline) => pipeline.status === "passing").length}/{pipelines.length}</strong><small>passing pipelines in preview</small></article>
        <article><span><Rocket size={14} /> Release</span><strong>{completedReleaseChecks}/4</strong><small>checklist items ready</small></article>
      </div>

      <div className="git-ci-workbench-preview__tabs" role="tablist" aria-label="Git and CI preview views" onKeyDown={handleTabKeyDown}>
        {([ ["changes", "Changes", Layers3], ["branches", "Branches", GitBranch], ["pipelines", "Pipelines", Activity], ["release", "Release", Rocket], ["history", "History", History] ] as const).map(([id, label, Icon]) => <button key={id} id={`git-ci-tab-${id}`} type="button" role="tab" aria-selected={activeTab === id} aria-controls={`git-ci-panel-${id}`} tabIndex={activeTab === id ? 0 : -1} className={activeTab === id ? "is-active" : ""} onClick={() => setActiveTab(id)}><Icon size={13} /> {label}</button>)}
      </div>

      {activeTab === "changes" ? <div id="git-ci-panel-changes" role="tabpanel" aria-labelledby="git-ci-tab-changes" className="git-ci-workbench-preview__panel">
        <div className="git-ci-workbench-preview__panel-heading"><div><span className="eyebrow">Working tree rehearsal</span><h4>Changes ready for review</h4><p>Stage and shape a commit payload without touching a repository.</p></div><div className="git-ci-workbench-preview__inline-actions"><button type="button" className="button button--ghost" onClick={() => stageAll(true)}>Stage all</button><button type="button" className="button button--ghost" onClick={() => stageAll(false)}>Unstage all</button></div></div>
        <div className="git-ci-workbench-preview__changes-layout">
          <div className="git-ci-workbench-preview__change-list" role="list" aria-label="Synthetic working tree changes">
            {changes.length > 0 ? changes.map((change) => <article key={change.id} className={`git-ci-workbench-preview__change${selectedChangeId === change.id ? " is-selected" : ""}`}>
              <button type="button" className="git-ci-workbench-preview__change-main" onClick={() => setSelectedChangeId(change.id)}><span className={`git-ci-workbench-preview__kind git-ci-workbench-preview__kind--${change.kind}`}>{change.kind === "modified" ? "M" : change.kind === "added" ? "A" : "D"}</span><span><strong>{change.path}</strong><small>{change.area} · +{change.additions} / -{change.deletions}</small></span></button>
              <label className="git-ci-workbench-preview__stage"><span className="sr-only">Stage {change.path}</span><input type="checkbox" checked={change.staged} onChange={() => toggleStage(change.id)} aria-label={`Stage ${change.path}`} /><span>{change.staged ? "Staged" : "Stage"}</span></label>
            </article>) : <div className="git-ci-workbench-preview__empty"><CheckCircle2 size={19} /><strong>Preview working tree is clean</strong><small>Create another rehearsal to inspect more changes.</small></div>}
          </div>
          {selectedChange ? <aside className="git-ci-workbench-preview__change-detail" aria-label="Selected change preview"><div><span className="eyebrow">Selected change</span><h4>{selectedChange.path}</h4><span className={`git-ci-workbench-preview__chip git-ci-workbench-preview__chip--${selectedChange.kind}`}>{selectedChange.kind}</span></div><dl><div><dt>Area</dt><dd>{selectedChange.area}</dd></div><div><dt>Diff</dt><dd>+{selectedChange.additions} / -{selectedChange.deletions}</dd></div><div><dt>Stage state</dt><dd>{selectedChange.staged ? "Ready for commit preview" : "Review before staging"}</dd></div></dl><pre>@@ synthetic preview @@{`\n`}+ Delivery controls remain renderer-local{`\n`}- Native repository state is unchanged</pre></aside> : null}
        </div>
        <div className="git-ci-workbench-preview__commit-card"><div><span className="eyebrow">Commit rehearsal</span><strong>{stagedCount} staged file{stagedCount === 1 ? "" : "s"}</strong><small>Conventional message is editable for this session.</small></div><label><span className="sr-only">Commit message preview</span><GitCommitHorizontal size={14} /><input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} aria-label="Commit message preview" placeholder="feat: describe the change" /></label><button type="button" className="button button--secondary" onClick={createCommitPreview}><GitCommitHorizontal size={13} /> Create commit preview</button></div>
      </div> : null}

      {activeTab === "branches" ? <div id="git-ci-panel-branches" role="tabpanel" aria-labelledby="git-ci-tab-branches" className="git-ci-workbench-preview__panel">
        <div className="git-ci-workbench-preview__panel-heading"><div><span className="eyebrow">Branch map</span><h4>Compare delivery lines</h4><p>Switching a preview branch only changes this renderer session.</p></div><label className="git-ci-workbench-preview__search"><GitBranch size={14} /><span className="sr-only">Search preview branches</span><input value={branchQuery} onChange={(event) => setBranchQuery(event.target.value)} placeholder="Filter branches" aria-label="Search preview branches" /></label></div>
        <div className="git-ci-workbench-preview__branch-grid" role="listbox" aria-label="Preview branches">{filteredBranches.map((branch) => <button key={branch.id} type="button" role="option" aria-selected={branch.id === currentBranchId} className={branch.id === currentBranchId ? "is-selected" : ""} onClick={() => { setCurrentBranchId(branch.id); setStatus(`${branch.name} selected · no checkout occurred`); }}><span className="git-ci-workbench-preview__branch-icon"><GitBranch size={14} /></span><span><strong>{branch.name}</strong><small>{branch.lastCommit} · ahead {branch.ahead} · behind {branch.behind}</small></span><em>{branch.protection}</em></button>)}</div>
        <div className="git-ci-workbench-preview__create-branch"><label><span className="sr-only">New branch name</span><Plus size={14} /><input value={newBranchName} onChange={(event) => setNewBranchName(event.target.value)} placeholder="preview/feature/name" aria-label="New branch name" /></label><button type="button" className="button button--secondary" onClick={createBranchPreview}><GitBranch size={13} /> Create branch preview</button></div>
        <p className="git-ci-workbench-preview__inline-boundary"><ShieldCheck size={14} /> Branch protection is synthetic metadata; no checkout, branch ref, merge, or push was performed.</p>
      </div> : null}

      {activeTab === "pipelines" ? <div id="git-ci-panel-pipelines" role="tabpanel" aria-labelledby="git-ci-tab-pipelines" className="git-ci-workbench-preview__panel">
        <div className="git-ci-workbench-preview__panel-heading"><div><span className="eyebrow">Pipeline matrix</span><h4>Rehearse CI gates</h4><p>Inspect checks and matrix jobs before a native runner exists.</p></div><label className="git-ci-workbench-preview__select"><span>Filter</span><select value={pipelineFilter} onChange={(event) => setPipelineFilter(event.target.value as "all" | PipelineStatus)} aria-label="Filter pipeline status"><option value="all">All statuses</option><option value="passing">Passing</option><option value="running">Running</option><option value="queued">Queued</option><option value="failed">Needs attention</option><option value="skipped">Skipped</option></select></label></div>
        <div className="git-ci-workbench-preview__pipeline-layout"><div className="git-ci-workbench-preview__pipeline-list" role="listbox" aria-label="Preview pipelines">{filteredPipelines.map((pipeline) => <button key={pipeline.id} type="button" role="option" aria-selected={selectedPipelineId === pipeline.id} className={selectedPipelineId === pipeline.id ? "is-selected" : ""} onClick={() => setSelectedPipelineId(pipeline.id)}><span className={`git-ci-workbench-preview__pipeline-status git-ci-workbench-preview__pipeline-status--${pipeline.status}`}><span className="status-dot" />{statusLabel(pipeline.status)}</span><span><strong>{pipeline.name}</strong><small>{triggerLabel(pipeline.trigger)} · {pipeline.passed}/{pipeline.total} jobs · {pipeline.duration}</small></span></button>)}</div><aside className="git-ci-workbench-preview__pipeline-detail" aria-label="Selected pipeline preview"><div className="git-ci-workbench-preview__pipeline-detail-heading"><span><span className="eyebrow">Selected pipeline</span><h4>{selectedPipeline.name}</h4><small>{triggerLabel(selectedPipeline.trigger)} · commit {selectedPipeline.commit}</small></span><button type="button" className="button button--secondary" onClick={() => runPipelinePreview(selectedPipeline.id)}><Play size={13} /> Run CI preview</button></div><div className="git-ci-workbench-preview__job-grid">{selectedPipeline.jobs.map((job, index) => <div key={job}><span className={index < selectedPipeline.passed ? "status-dot status-dot--success" : "status-dot status-dot--warning"} /><span>{job}</span><small>{index < selectedPipeline.passed ? "Ready" : selectedPipeline.status === "running" ? "Rehearsing" : "Pending"}</small></div>)}</div><p className="git-ci-workbench-preview__inline-boundary"><Cloud size={14} /> No webhook, runner, network request, artifact upload, or provider dispatch was started.</p></aside></div>
      </div> : null}

      {activeTab === "release" ? <div id="git-ci-panel-release" role="tabpanel" aria-labelledby="git-ci-tab-release" className="git-ci-workbench-preview__panel">
        <div className="git-ci-workbench-preview__panel-heading"><div><span className="eyebrow">Release handoff</span><h4>Shape a deployable plan</h4><p>Configure the release target and checklist without creating an artifact or deployment.</p></div><span className="git-ci-workbench-preview__planned-chip"><Rocket size={13} /> Deploy · Planned</span></div>
        <div className="git-ci-workbench-preview__release-controls"><label><span>Environment</span><select value={environment} onChange={(event) => setEnvironment(event.target.value as ReleaseEnvironment)} aria-label="Release environment"><option>Preview</option><option>Staging</option><option>Production</option></select></label><label><span>Channel</span><select value={channel} onChange={(event) => setChannel(event.target.value as ReleaseChannel)} aria-label="Release channel"><option>Canary</option><option>Stable</option><option>Nightly</option></select></label><label className="git-ci-workbench-preview__release-note"><span>Handoff note</span><input value={releaseNote} onChange={(event) => setReleaseNote(event.target.value)} aria-label="Release handoff note" /></label></div>
        <div className="git-ci-workbench-preview__checklist" role="group" aria-label="Release checklist"><label><input type="checkbox" checked={release.checks} onChange={(event) => setChecklist("checks", event)} /><span><Check size={13} /> CI gates reviewed<small>Preview pipeline status is visible</small></span></label><label><input type="checkbox" checked={release.changelog} onChange={(event) => setChecklist("changelog", event)} /><span><History size={13} /> Changelog drafted<small>Documentation remains renderer-local</small></span></label><label><input type="checkbox" checked={release.artifacts} onChange={(event) => setChecklist("artifacts", event)} /><span><UploadCloud size={13} /> Artifact plan shaped<small>No package or upload was created</small></span></label><label><input type="checkbox" checked={release.approvals} onChange={(event) => setChecklist("approvals", event)} /><span><ShieldCheck size={13} /> Approval path reviewed<small>Native approval receipt is unavailable</small></span></label></div>
        <section className="git-ci-workbench-preview__custom-checklist" aria-label="Custom release checklist">
          <div className="git-ci-workbench-preview__custom-checklist-heading"><div><span className="eyebrow">Customize the gate set</span><h4>Session-only checklist items</h4><p>Add project-specific release gates without changing Git, CI, or native policy.</p></div><span className="git-ci-workbench-preview__custom-checklist-count">{customReleaseChecklist.length}/12 custom</span></div>
          <div className="git-ci-workbench-preview__custom-checklist-list" role="list">
            {customReleaseChecklist.length > 0 ? customReleaseChecklist.map((item) => <article key={item.id} className="git-ci-workbench-preview__custom-checklist-item" role="listitem"><label><input type="checkbox" checked={item.checked} onChange={(event) => setCustomChecklistItem(item.id, event.target.checked)} aria-label={`Custom checklist: ${item.label}`} /><span><strong>{item.label}</strong><small>{item.detail}</small></span></label><button type="button" className="button button--ghost" onClick={() => removeCustomChecklistItem(item.id)} aria-label={`Remove custom checklist: ${item.label}`}><Trash2 size={13} /> Remove</button></article>) : <div className="git-ci-workbench-preview__custom-checklist-empty">No custom gates yet · the default four-item checklist remains active.</div>}
          </div>
          <form className="git-ci-workbench-preview__custom-checklist-form" onSubmit={addCustomChecklistItem}>
            <label><span className="sr-only">Custom checklist label</span><input value={customChecklistLabel} onChange={(event) => setCustomChecklistLabel(event.target.value)} placeholder="e.g. Verify migration rehearsal" aria-label="Custom checklist label" /></label>
            <label><span className="sr-only">Custom checklist detail</span><input value={customChecklistDetail} onChange={(event) => setCustomChecklistDetail(event.target.value)} placeholder="Optional evidence note" aria-label="Custom checklist detail" /></label>
            <button type="submit" className="button button--secondary"><Plus size={13} /> Add custom gate</button>
            <button type="button" className="button button--ghost" onClick={resetReleaseChecklist}><RotateCcw size={13} /> Reset checklist</button>
          </form>
          <p className="git-ci-workbench-preview__inline-boundary"><ShieldCheck size={14} /> Custom checklist labels and checked states are renderer-local session metadata; they are included in export preview but never persisted or executed.</p>
        </section>
        <section className="git-ci-workbench-preview__evidence" aria-label="Release evidence matrix">
          <div className="git-ci-workbench-preview__evidence-heading"><div><span className="eyebrow">Handoff evidence</span><h4>Candidate readiness map</h4><p>Separate what is ready in this preview from what still needs a native receipt.</p></div><span className="git-ci-workbench-preview__evidence-summary"><strong>{releaseEvidenceCounts.ready}</strong> ready · <strong>{releaseEvidenceCounts.watch}</strong> watch · <strong>{releaseEvidenceCounts.planned}</strong> planned</span></div>
          <div className="git-ci-workbench-preview__evidence-list" role="list">
            {releaseEvidence.map((item) => <article key={item.id} role="listitem" className={`git-ci-workbench-preview__evidence-item git-ci-workbench-preview__evidence-item--${item.status}`}><span className="git-ci-workbench-preview__evidence-status">{releaseEvidenceLabel(item.status)}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></article>)}
          </div>
          <p className="git-ci-workbench-preview__inline-boundary"><ShieldCheck size={14} /> Evidence rows are synthetic handoff metadata. They do not certify the current source tree, package hashes, signatures, CI provider, or rollback state.</p>
        </section>
        <div className="git-ci-workbench-preview__release-footer"><span><CircleAlert size={14} /> {completedReleaseChecks}/{releaseChecklistTotal} checks ready for {environment} · {channel}</span><div><button type="button" className="button button--secondary" onClick={prepareReleasePreview}><Rocket size={13} /> Prepare release preview</button><button type="button" className="button button--ghost" disabled aria-label="Deploy release planned">Deploy · Planned</button></div></div>
      </div> : null}

      {activeTab === "history" ? <div id="git-ci-panel-history" role="tabpanel" aria-labelledby="git-ci-tab-history" className="git-ci-workbench-preview__panel">
        <div className="git-ci-workbench-preview__panel-heading"><div><span className="eyebrow">Session activity</span><h4>Delivery activity ledger</h4><p>Review the local rehearsal trail for staging, commits, branches, CI, checklists, and release handoffs.</p></div><div className="git-ci-workbench-preview__inline-actions"><button type="button" className="button button--ghost" onClick={resetEventHistory}><RotateCcw size={13} /> Reset activity</button><button type="button" className="button button--ghost" onClick={() => { setEvents([]); setStatus("Delivery activity cleared for this renderer session"); }} disabled={events.length === 0}><Trash2 size={13} /> Clear</button></div></div>
        <div className="git-ci-workbench-preview__history-toolbar" role="toolbar" aria-label="Delivery activity filters">
          <label className="git-ci-workbench-preview__search"><Search size={14} /><span className="sr-only">Search delivery activity</span><input value={eventQuery} onChange={(event) => setEventQuery(event.target.value)} placeholder="Search activity" aria-label="Search delivery activity" /></label>
          <label className="git-ci-workbench-preview__select"><span>Filter</span><select value={eventFilter} onChange={(event) => setEventFilter(event.target.value as DeliveryEventFilter)} aria-label="Filter delivery activity"><option value="all">All activity</option><option value="stage">Working tree</option><option value="commit">Commits</option><option value="branch">Branches</option><option value="pipeline">CI pipelines</option><option value="checklist">Checklists</option><option value="release">Release</option></select></label>
          <span className="git-ci-workbench-preview__result-count"><ListChecks size={13} /> {visibleEvents.length} shown · {events.length} total</span>
        </div>
        <div className="git-ci-workbench-preview__history-list" role="list" aria-label="Delivery activity events">
          {visibleEvents.length > 0 ? visibleEvents.map((event) => <article key={event.id} className="git-ci-workbench-preview__history-row" role="listitem"><span className={`git-ci-workbench-preview__history-icon git-ci-workbench-preview__history-icon--${event.kind}`}><ListChecks size={14} /></span><div><strong>{event.label}</strong><small>{event.detail}</small></div><span className="git-ci-workbench-preview__history-meta"><b>{eventKindLabel(event.kind)}</b><time>{event.occurredAt}</time></span></article>) : <div className="git-ci-workbench-preview__empty"><ListChecks size={19} /><strong>No activity matches these filters</strong><small>Rehearse a delivery action or reset the filters.</small></div>}
        </div>
        <p className="git-ci-workbench-preview__inline-boundary"><ShieldCheck size={14} /> Activity is a renderer-local session ledger. It is not a Git reflog, CI provider log, audit receipt, or durable event journal.</p>
      </div> : null}

      <div className="git-ci-workbench-preview__export-toolbar"><span><Download size={13} /> Portable delivery snapshot</span><button type="button" className="button button--ghost" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="git-ci-export-preview">{exportOpen ? "Hide export" : "Preview export"}</button></div>
      {exportOpen ? <section id="git-ci-export-preview" className="git-ci-workbench-preview__export" aria-label="Git and CI export preview"><div className="git-ci-workbench-preview__export-controls"><label><span>Format</span><select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)} aria-label="Delivery export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyExport()}><Copy size={13} /> Copy</button><button type="button" className="button button--ghost" onClick={downloadExport}><Download size={13} /> Download</button></div><pre tabIndex={0}><code>{exportText}</code></pre><p><ShieldCheck size={14} /> Export is redacted preview metadata only. No source contents, credentials, local paths, or native receipt was added.</p></section> : null}

      <div className="git-ci-workbench-preview__status" role="status" aria-live="polite">{status}</div>
      <p className="git-ci-workbench-preview__boundary-note"><ShieldCheck size={14} /> This workbench uses synthetic repository, branch, CI, and release data. It does not run Git, read/write the workspace, create commits or branches, push, call CI providers, upload artifacts, deploy, or persist delivery state.</p>
    </section>
  );
}
