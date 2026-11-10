import { Check, CircleAlert, FileText, FolderOpen, GitBranch, Layers3, RefreshCw, ShieldCheck } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import type { MemoryView, ProjectView, SkillView, WorkspaceFolderView } from "./types";
import ContextManifestPreview from "./context-manifest-preview";
import ContextPreflightPreview, { type ContextPreflightSource, type ContextPreflightSourceStatus } from "./context-preflight-preview";
import ContextCompilerPreview from "./context-compiler-preview";
import { buildContextEstimate } from "./context-estimate";
import { ProjectScopeInheritancePreview } from "./project-scope-inheritance-preview";
import { buildProjectContextAvailabilityForProject } from "./project-context-availability-contract";
import type { ConversationView } from "./types";

type ContextSourceKind = "folders" | "instructions" | "memories" | "skills";

const sourceLabels: Record<ContextSourceKind, string> = {
  folders: "Workspace folders",
  instructions: "Project instructions",
  memories: "Relevant memories",
  skills: "Enabled skills",
};

export function ProjectContextWorkbench({
  project,
  conversations = [],
  memories = [],
  skills = [],
  contextBudget: controlledContextBudget,
  includeMemories: controlledIncludeMemories,
  includeSkills: controlledIncludeSkills,
  onContextBudgetChange,
  onIncludeMemoriesChange,
  onIncludeSkillsChange,
}: {
  readonly project: ProjectView;
  readonly conversations?: readonly ConversationView[];
  readonly memories?: MemoryView[];
  readonly skills?: SkillView[];
  /** Optional host-owned policy state shared with the Snapshot tab. */
  readonly contextBudget?: number;
  readonly includeMemories?: boolean;
  readonly includeSkills?: boolean;
  readonly onContextBudgetChange?: (value: number) => void;
  readonly onIncludeMemoriesChange?: (value: boolean) => void;
  readonly onIncludeSkillsChange?: (value: boolean) => void;
}) {
  const [selected, setSelected] = useState<ContextSourceKind>("folders");
  const [localIncludeMemories, setLocalIncludeMemories] = useState(true);
  const [localIncludeSkills, setLocalIncludeSkills] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [localContextBudget, setLocalContextBudget] = useState(3200);

  const contextBudget = controlledContextBudget ?? localContextBudget;
  const includeMemories = controlledIncludeMemories ?? localIncludeMemories;
  const includeSkills = controlledIncludeSkills ?? localIncludeSkills;
  const setContextBudget = (value: number) => {
    if (controlledContextBudget === undefined) setLocalContextBudget(value);
    onContextBudgetChange?.(value);
  };
  const setIncludeMemories = (value: boolean) => {
    if (controlledIncludeMemories === undefined) setLocalIncludeMemories(value);
    onIncludeMemoriesChange?.(value);
  };
  const setIncludeSkills = (value: boolean) => {
    if (controlledIncludeSkills === undefined) setLocalIncludeSkills(value);
    onIncludeSkillsChange?.(value);
  };

  const activeMemories = useMemo(
    () => memories.filter((memory) => memory.status === "active" && (memory.scopeLabel === "Global" || memory.scopeLabel.includes(project.name))),
    [memories, project.name],
  );
  const activeSkills = useMemo(() => skills.filter((skill) => skill.enabled && (skill.scope === "Global" || skill.scope === "Project")), [skills]);
  const folderCount = project.folders.length;
  const contextAvailability = useMemo(
    () => buildProjectContextAvailabilityForProject(project),
    [project],
  );
  const instructionCount = project.instructions.trim() ? 1 : 0;
  const selectedMemoryCount = includeMemories ? activeMemories.length : 0;
  const selectedSkillCount = includeSkills ? activeSkills.length : 0;
  const estimatedTokens = folderCount * 450 + instructionCount * 600 + selectedMemoryCount * 160 + selectedSkillCount * 300;
  const contextEstimate = useMemo(
    () => buildContextEstimate({ estimatedTokens, projectHealth: project.contextHealth }),
    [estimatedTokens, project.contextHealth],
  );

  const folderStatus: ContextPreflightSourceStatus = project.contextHealth === "missing-access" || project.folders.some((folder) => folder.state === "permission-lost" || folder.state === "offline")
    ? "blocked"
    : project.folders.some((folder) => folder.state !== "ready") || folderCount === 0 || contextAvailability.evidence.state !== "native-current"
      ? "review"
      : "ready";
  const preflightSources: ContextPreflightSource[] = [
    {
      id: "folders",
      label: "Workspace folders",
      count: folderCount,
      estimatedTokens: folderCount * 450,
      selected: true,
      status: folderStatus,
      detail: folderCount === 0
        ? "No folder grant is selected for this project."
        : folderStatus === "blocked"
          ? "One or more folder grants need access before a native read."
          : folderStatus === "review"
            ? "Folder scope or indexing state still needs native evidence."
            : "Folder references are available in this renderer projection.",
    },
    {
      id: "instructions",
      label: "Project instructions",
      count: instructionCount,
      estimatedTokens: instructionCount * 600,
      selected: instructionCount > 0,
      status: instructionCount > 0 ? "ready" : "excluded",
      detail: instructionCount > 0 ? "Selected for the preview; revision/freeze is not native." : "No project instructions are selected.",
    },
    {
      id: "memories",
      label: "Relevant memories",
      count: activeMemories.length,
      estimatedTokens: activeMemories.length * 160,
      selected: includeMemories && activeMemories.length > 0,
      status: includeMemories && activeMemories.length > 0 ? "planned" : "excluded",
      detail: includeMemories && activeMemories.length > 0 ? "Renderer candidates only; retrieval and authority checks are planned." : "Active memories are excluded from this preview.",
    },
    {
      id: "skills",
      label: "Enabled skills",
      count: activeSkills.length,
      estimatedTokens: activeSkills.length * 300,
      selected: includeSkills && activeSkills.length > 0,
      status: includeSkills && activeSkills.length > 0 ? "planned" : "excluded",
      detail: includeSkills && activeSkills.length > 0 ? "Renderer selection only; native skill activation is planned." : "Enabled skills are excluded from this preview.",
    },
  ];

  const folderStateLabel = (folder: WorkspaceFolderView) => {
    if (folder.state === "ready") {
      return contextAvailability.evidence.state === "native-current"
        ? "Indexed"
        : "Ready · native evidence unavailable";
    }
    if (folder.state === "referenced") return "Referenced · not indexed";
    return folder.state.replaceAll("-", " ");
  };
  const sourceKinds = Object.keys(sourceLabels) as ContextSourceKind[];
  const moveSourceTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? sourceKinds.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + sourceKinds.length) % sourceKinds.length;
    const nextKind = sourceKinds[nextIndex];
    if (!nextKind) return;
    setSelected(nextKind);
    document.getElementById(`project-context-tab-${nextKind}`)?.focus();
  };

  return (
    <section className="project-context-workbench" aria-labelledby="project-context-workbench-title">
      <header className="project-context-workbench__header">
        <span className="project-context-workbench__icon"><Layers3 size={18} /></span>
        <span>
          <span className="eyebrow">Renderer preview</span>
          <h2 id="project-context-workbench-title">Project Context</h2>
          <p>Choose which project sources should shape the next chat. Compilation and native synchronization are not connected yet.</p>
        </span>
        <span className="project-context-workbench__status"><CircleAlert size={13} /> Preview only</span>
      </header>

      <div className="project-context-workbench__summary" role="status">
        <div><strong>{project.name}</strong><small>{folderCount} folder{folderCount === 1 ? "" : "s"} · {activeMemories.length} memor{activeMemories.length === 1 ? "y" : "ies"} · {activeSkills.length} skill{activeSkills.length === 1 ? "" : "s"}</small></div>
        <span className={`project-context-workbench__health project-context-workbench__health--${project.contextHealth}`} title={contextAvailability.reason}><ShieldCheck size={13} /> {contextAvailability.label}</span>
      </div>
      <p className="project-context-workbench__availability" role="status" aria-live="polite">
        <CircleAlert size={13} aria-hidden="true" /> {contextAvailability.reason}
      </p>

      <div className="project-context-workbench__sources" role="tablist" aria-label="Project context sources">
        {sourceKinds.map((kind, index) => (
          <button
            key={kind}
            id={`project-context-tab-${kind}`}
            type="button"
            role="tab"
            aria-selected={selected === kind}
            aria-controls={`project-context-panel-${kind}`}
            tabIndex={selected === kind ? 0 : -1}
            className={selected === kind ? "active" : ""}
            title={`Show ${sourceLabels[kind].toLocaleLowerCase()} for this Project context preview`}
            onClick={() => setSelected(kind)}
            onKeyDown={(event) => moveSourceTab(event, index)}
          >
            {kind === "folders" ? <FolderOpen size={14} /> : kind === "instructions" ? <FileText size={14} /> : kind === "memories" ? <GitBranch size={14} /> : <Layers3 size={14} />}
            <span>{sourceLabels[kind]}</span><small>{kind === "folders" ? folderCount : kind === "instructions" ? (project.instructions.trim() ? 1 : 0) : kind === "memories" ? activeMemories.length : activeSkills.length}</small>
          </button>
        ))}
      </div>

      <div
        className="project-context-workbench__panel"
        id={`project-context-panel-${selected}`}
        role="tabpanel"
        aria-labelledby={`project-context-tab-${selected}`}
        tabIndex={0}
      >
        {selected === "folders" && (project.folders.length > 0 ? <div className="project-context-workbench__list">{project.folders.map((folder) => <article key={folder.id}><span className="project-context-workbench__item-icon"><FolderOpen size={15} /></span><span><strong>{folder.displayName}</strong><small>{folder.canonicalPath} · {folder.scope}</small></span><em>{folderStateLabel(folder)}</em></article>)}</div> : <p className="project-context-workbench__empty">No workspace folders are attached to this project.</p>)}
        {selected === "instructions" && <div className="project-context-workbench__instructions"><strong>Project instructions</strong><p>{project.instructions.trim() || "No project instructions have been added yet."}</p></div>}
        {selected === "memories" && <div className="project-context-workbench__list">{activeMemories.length ? activeMemories.map((memory) => <article key={memory.id}><span className="project-context-workbench__item-icon"><GitBranch size={15} /></span><span><strong>{memory.content}</strong><small>{memory.kind} · {memory.sourceLabel}</small></span><em>{Math.round((memory.confidence ?? 0) * 100)}%</em></article>) : <p className="project-context-workbench__empty">No active memories are currently scoped to this project.</p>}</div>}
        {selected === "skills" && <div className="project-context-workbench__list">{activeSkills.length ? activeSkills.map((skill) => <article key={skill.id}><span className="project-context-workbench__item-icon"><Layers3 size={15} /></span><span><strong>{skill.name}</strong><small>{skill.scope} · {skill.tokenFootprint.toLocaleString()} tokens</small></span><em>{skill.trust}</em></article>) : <p className="project-context-workbench__empty">No enabled project skills are available.</p>}</div>}
      </div>

      <div className="project-context-workbench__options">
        <label><input type="checkbox" checked={includeMemories} onChange={(event) => setIncludeMemories(event.target.checked)} /> Include active memories</label>
        <label><input type="checkbox" checked={includeSkills} onChange={(event) => setIncludeSkills(event.target.checked)} /> Include enabled skills</label>
        <button type="button" className="button button--ghost" title={expanded ? "Hide renderer-local context selection details" : "Show renderer-local context selection details"} onClick={() => setExpanded((value) => !value)}><RefreshCw size={14} /> {expanded ? "Hide details" : "Show details"}</button>
      </div>
      {expanded && <p className="project-context-workbench__boundary"><Check size={14} /> Preview selection: folders {folderCount}, instructions {instructionCount}, memories {selectedMemoryCount}, skills {selectedSkillCount}. A future native compiler should emit a context revision and receipt for this selection. Current capability state: read {contextAvailability.capabilities.read}, compile {contextAvailability.capabilities.compile}, dispatch {contextAvailability.capabilities.dispatch}.</p>}
      <ContextPreflightPreview
        projectName={project.name}
        projectHealth={project.contextHealth}
        sources={preflightSources}
        estimatedTokens={estimatedTokens}
        budgetTokens={contextBudget}
      />
      <ProjectScopeInheritancePreview
        project={project}
        conversations={conversations}
        memories={memories}
        skills={skills}
      />
      <ContextManifestPreview
        projectName={project.name}
        folderCount={folderCount}
        instructionCount={instructionCount}
        memoryCount={activeMemories.length}
        skillCount={activeSkills.length}
        includeMemories={includeMemories}
        includeSkills={includeSkills}
        budget={contextBudget}
        onBudgetChange={setContextBudget}
        onIncludeMemoriesChange={setIncludeMemories}
        onIncludeSkillsChange={setIncludeSkills}
        estimate={contextEstimate}
      />
      <ContextCompilerPreview
        projectId={project.id}
        projectName={project.name}
        instructions={project.instructions}
        folders={project.folders.map((folder) => ({
          id: folder.id,
          displayName: folder.displayName,
          canonicalPath: folder.canonicalPath,
          state: folder.state,
          scope: folder.scope,
        }))}
        memories={activeMemories.map((memory) => ({
          id: memory.id,
          label: memory.title?.trim() || memory.sourceLabel,
          content: memory.content,
          confidence: memory.confidence,
        }))}
        skills={activeSkills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          version: skill.version,
          tokenFootprint: skill.tokenFootprint,
        }))}
        conversations={conversations}
        includeMemories={includeMemories}
        includeSkills={includeSkills}
        budgetTokens={contextBudget}
        contextHealth={project.contextHealth}
      />
    </section>
  );
}
