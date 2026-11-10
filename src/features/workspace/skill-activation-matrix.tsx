import { ArrowRight, Check, Clipboard, Download, Layers3, LockKeyhole, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import type { ProjectView, SkillView } from "./types";
import {
  buildProjectSkillActivationDiff,
  serializeProjectSkillActivationDiff,
} from "./skill-project-activation-diff";

export type ProjectSkillActivation = Readonly<Record<string, Readonly<Record<string, boolean>>>>;

export interface SkillActivationMatrixProps {
  readonly skills: readonly SkillView[];
  readonly projects: readonly ProjectView[];
  readonly activeProjectId: string;
  readonly enabledIds: ReadonlySet<string>;
  readonly reviewedSkillIds: ReadonlySet<string>;
  readonly projectActivation: ProjectSkillActivation;
  readonly selectedSkillId: string | null;
  readonly onSelectSkill: (skillId: string) => void;
  readonly onToggleGlobal: (skill: SkillView) => void;
  readonly onToggleProject: (skill: SkillView, projectId: string) => void;
  readonly onUndoProject: () => void;
  readonly onResetProjects: () => void;
  readonly canUndoProject: boolean;
}

export function isProjectSkillActive(
  activation: ProjectSkillActivation,
  projectId: string,
  skillId: string,
): boolean {
  return activation[projectId]?.[skillId] === true;
}

function projectCellState(
  skill: SkillView,
  projectId: string,
  enabledIds: ReadonlySet<string>,
  activation: ProjectSkillActivation,
): "inherited" | "enabled" | "disabled" | "manual" {
  if (skill.scope === "Global") return enabledIds.has(skill.id) ? "inherited" : "disabled";
  if (skill.scope === "Manual") return "manual";
  return isProjectSkillActive(activation, projectId, skill.id) ? "enabled" : "disabled";
}

function stateLabel(state: ReturnType<typeof projectCellState>): string {
  switch (state) {
    case "inherited":
      return "Inherited";
    case "enabled":
      return "Enabled";
    case "manual":
      return "Manual only";
    default:
      return "Off";
  }
}

function downloadProjectDiff(payload: string, format: "json" | "markdown"): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-skill-project-activation-diff-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function SkillActivationMatrix({
  skills,
  projects,
  activeProjectId,
  enabledIds,
  reviewedSkillIds,
  projectActivation,
  selectedSkillId,
  onSelectSkill,
  onToggleGlobal,
  onToggleProject,
  onUndoProject,
  onResetProjects,
  canUndoProject,
}: SkillActivationMatrixProps) {
  const [baselineBySkill, setBaselineBySkill] = useState<Record<string, string>>({});
  const [reviewedDiffs, setReviewedDiffs] = useState<ReadonlySet<string>>(() => new Set());
  const [compareProjectId, setCompareProjectId] = useState("");
  const [diffFormat, setDiffFormat] = useState<"json" | "markdown">("json");
  const [diffStatus, setDiffStatus] = useState("Compare project activation drafts before a future native context snapshot.");
  const visibleProjects = projects.filter((project) => project.archived !== true);
  const focusProjectId = visibleProjects.some((project) => project.id === activeProjectId)
    ? activeProjectId
    : visibleProjects[0]?.id ?? "";
  const selectedComparisonProjectId = visibleProjects.some((project) => project.id === compareProjectId && project.id !== focusProjectId)
    ? compareProjectId
    : visibleProjects.find((project) => project.id !== focusProjectId)?.id ?? focusProjectId;
  const selected = skills.find((skill) => skill.id === selectedSkillId) ?? skills[0] ?? null;
  const baselineDraft = selected ? baselineBySkill[selected.id] ?? selected.permissions.join(", ") : "";
  const permissionDiff = useMemo(() => {
    if (!selected) return { added: [] as string[], removed: [] as string[], unchanged: [] as string[] };
    const baseline = new Map(baselineDraft.split(",").map((value) => value.trim()).filter(Boolean).map((value) => [value.toLowerCase(), value]));
    const current = new Map(selected.permissions.map((value) => [value.toLowerCase(), value]));
    return {
      added: [...current].filter(([key]) => !baseline.has(key)).map(([, value]) => value),
      removed: [...baseline].filter(([key]) => !current.has(key)).map(([, value]) => value),
      unchanged: [...current].filter(([key]) => baseline.has(key)).map(([, value]) => value),
    };
  }, [baselineDraft, selected]);
  const activationDiff = useMemo(
    () => buildProjectSkillActivationDiff(
      skills,
      visibleProjects,
      focusProjectId,
      selectedComparisonProjectId,
      enabledIds,
      projectActivation,
    ),
    [enabledIds, focusProjectId, projectActivation, selectedComparisonProjectId, skills, visibleProjects],
  );
  const activationDiffPayload = useMemo(
    () => serializeProjectSkillActivationDiff(activationDiff, diffFormat),
    [activationDiff, diffFormat],
  );

  return (
    <div className="skill-studio__matrix" role="region" aria-label="Per-project skill activation matrix">
      <div className="skill-studio__section-heading">
        <div>
          <span className="eyebrow">Scope matrix</span>
          <h3>Activation by project</h3>
          <p className="skill-studio__matrix-subtitle">
            Compare global defaults with project overrides before a future native context snapshot.
          </p>
        </div>
        <span className="skill-studio__chip skill-studio__chip--blue"><Layers3 size={11} /> {visibleProjects.length} projects</span>
      </div>

      <div className="skill-studio__matrix-legend" aria-label="Activation matrix legend">
        <span><i className="skill-studio__matrix-dot skill-studio__matrix-dot--active" /> Enabled</span>
        <span><i className="skill-studio__matrix-dot skill-studio__matrix-dot--inherited" /> Inherited global</span>
        <span><i className="skill-studio__matrix-dot" /> Off</span>
        <span><LockKeyhole size={12} /> Renderer-local</span>
      </div>

      <div className="skill-studio__matrix-history" role="toolbar" aria-label="Project skill preview actions">
        <span>Project cells are independent renderer-session drafts.</span>
        <button type="button" className="button button--ghost" onClick={onUndoProject} disabled={!canUndoProject}>Undo project change</button>
        <button type="button" className="button button--ghost" onClick={onResetProjects}>Reset project cells</button>
      </div>

      {visibleProjects.length === 0 ? (
        <div className="skill-studio__empty"><Layers3 size={22} /><strong>No active projects</strong><span>Create or unarchive a project to preview scoped activation.</span></div>
      ) : (
        <div className="skill-studio__matrix-scroll" tabIndex={0}>
          <table className="skill-studio__matrix-table">
            <thead>
              <tr>
                <th scope="col">Skill</th>
                <th scope="col">Global</th>
                {visibleProjects.map((project) => (
                  <th key={project.id} scope="col" className={project.id === focusProjectId ? "is-focus" : undefined}>
                    <span>{project.name}</span>
                    {project.id === focusProjectId ? <small>Active project</small> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => {
                const globalEnabled = enabledIds.has(skill.id);
                const reviewNeeded = skill.trust === "Unreviewed" && !reviewedSkillIds.has(skill.id);
                return (
                  <tr key={skill.id} className={selectedSkillId === skill.id ? "is-selected" : undefined}>
                    <th scope="row">
                      <button type="button" className="skill-studio__matrix-skill" onClick={() => onSelectSkill(skill.id)} aria-label={`Inspect ${skill.name}`}>
                        <span className="skill-studio__matrix-skill-icon">{skill.icon || <Layers3 size={13} />}</span>
                        <span><strong>{skill.name}</strong><small>{skill.scope} · v{skill.version}</small></span>
                      </button>
                    </th>
                    <td>
                      {skill.scope === "Global" ? (
                        <button
                          type="button"
                          className={`skill-studio__matrix-cell${globalEnabled ? " is-active" : ""}`}
                          aria-pressed={globalEnabled}
                          aria-label={`Toggle ${skill.name} global activation`}
                          onClick={() => onToggleGlobal(skill)}
                          disabled={reviewNeeded}
                          title={reviewNeeded ? "Review this skill before enabling it" : "Toggle global preview activation"}
                        >
                          <Check size={12} /> {globalEnabled ? "On" : "Off"}
                        </button>
                      ) : (
                        <span className="skill-studio__matrix-static">{skill.scope === "Project" ? "—" : "Manual"}</span>
                      )}
                    </td>
                    {visibleProjects.map((project) => {
                      const state = projectCellState(skill, project.id, enabledIds, projectActivation);
                      const canToggle = skill.scope === "Project" && !reviewNeeded;
                      return (
                        <td key={project.id} className={project.id === focusProjectId ? "is-focus" : undefined}>
                          {canToggle ? (
                            <button
                              type="button"
                              className={`skill-studio__matrix-cell${state === "enabled" ? " is-active" : ""}`}
                              aria-pressed={state === "enabled"}
                              aria-label={`Toggle ${skill.name} for ${project.name}`}
                              onClick={() => onToggleProject(skill, project.id)}
                              title={`Toggle ${skill.name} for ${project.name}`}
                            >
                              {state === "enabled" ? <Check size={12} /> : null} {stateLabel(state)}
                            </button>
                          ) : (
                            <span className={`skill-studio__matrix-static${state === "inherited" ? " is-inherited" : ""}`}>
                              {state === "inherited" ? <Check size={12} /> : state === "manual" ? <ShieldCheck size={12} /> : null}
                              {stateLabel(state)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="skill-studio__matrix-compare" aria-label="Project activation diff preview">
        <header>
          <div>
            <span className="eyebrow">Project diff preview</span>
            <h4>Compare activation drafts</h4>
            <p>Review explicit project overrides and inherited states before a future native context snapshot.</p>
          </div>
          <span className="skill-studio__chip skill-studio__chip--blue">{activationDiff.changedRows.length} changes</span>
        </header>
        <div className="skill-studio__matrix-compare-toolbar" role="toolbar" aria-label="Project activation diff controls">
          <label>
            <span>From active project</span>
            <strong>{activationDiff.fromProjectName}</strong>
          </label>
          <ArrowRight size={14} aria-hidden="true" />
          <label>
            <span>Compare with</span>
            <select
              aria-label="Compare project activation with"
              value={selectedComparisonProjectId}
              onChange={(event) => setCompareProjectId(event.target.value)}
              disabled={visibleProjects.length < 2}
            >
              {visibleProjects.filter((project) => project.id !== focusProjectId).map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
              {visibleProjects.length < 2 ? <option value={focusProjectId}>No second project</option> : null}
            </select>
          </label>
          <label>
            <span>Export format</span>
            <select aria-label="Project activation diff format" value={diffFormat} onChange={(event) => setDiffFormat(event.target.value as "json" | "markdown")}>
              <option value="json">JSON</option>
              <option value="markdown">Markdown</option>
            </select>
          </label>
          <span className="skill-studio__matrix-compare-status" role="status" aria-live="polite">{diffStatus}</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              if (!navigator.clipboard?.writeText) {
                setDiffStatus("Clipboard access is unavailable; no activation diff was copied.");
                return;
              }
              void navigator.clipboard.writeText(activationDiffPayload)
                .then(() => setDiffStatus(`Copied ${activationDiff.changedRows.length} renderer-local activation changes.`))
                .catch(() => setDiffStatus("Clipboard access was denied; no activation diff was copied."));
            }}
          >
            <Clipboard size={13} /> Copy
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setDiffStatus(downloadProjectDiff(activationDiffPayload, diffFormat)
              ? "Browser download started; native project policy was not changed."
              : "File download is unavailable; no activation diff was exported.")}
          >
            <Download size={13} /> Download
          </button>
        </div>
        <div className="skill-studio__matrix-compare-metrics" role="status" aria-label="Project activation diff summary">
          <span><strong>{activationDiff.counts.added}</strong> Enabled in compare</span>
          <span><strong>{activationDiff.counts.removed}</strong> Disabled in compare</span>
          <span><strong>{activationDiff.counts.changed}</strong> Provenance changes</span>
          <span><strong>{activationDiff.counts.unchanged}</strong> Unchanged</span>
        </div>
        <div className="skill-studio__matrix-compare-list" role="list" aria-label="Project activation differences">
          {activationDiff.changedRows.length === 0 ? (
            <div className="skill-studio__matrix-compare-empty"><Check size={15} /><span>No visible differences between these project drafts.</span></div>
          ) : activationDiff.changedRows.map((row) => (
            <div key={row.skillId} className="skill-studio__matrix-compare-row" role="listitem">
              <span><strong>{row.skillName}</strong><small>{row.scope} · {row.kind}</small></span>
              <code>{row.from.state}</code>
              <ArrowRight size={13} aria-hidden="true" />
              <code>{row.to.state}</code>
            </div>
          ))}
        </div>
        <details className="skill-studio__matrix-compare-payload">
          <summary>Inspect {diffFormat.toUpperCase()} diff payload</summary>
          <pre tabIndex={0} aria-label="Project activation diff export payload"><code>{activationDiffPayload}</code></pre>
        </details>
        <p className="skill-studio__boundary"><LockKeyhole size={14} /><span>Diff and exports are renderer-local. They do not install a package, grant a permission, persist project policy, compile context, or inject a provider request.</span></p>
      </section>

      <section className="skill-studio__matrix-review" aria-label="Skill permission comparison preview">
        {selected ? (
          <>
            <header><div><span className="eyebrow">Selected skill · v{selected.version}</span><h4>{selected.name} permission comparison</h4></div><span className="skill-studio__chip skill-studio__chip--amber">Not a historical revision</span></header>
            <p>Current permissions come from the seeded catalog. The editable baseline defaults to the current list; enter another list to preview a version permission diff. No earlier package snapshot or hash is available.</p>
            <label><span>Editable baseline permissions (comma-separated)</span><input aria-label="Skill permission comparison baseline" value={baselineDraft} onChange={(event) => setBaselineBySkill((current) => ({ ...current, [selected.id]: event.target.value }))} /></label>
            <div className="skill-studio__matrix-diff" role="list" aria-label="Skill permission changes">
              {([ ["Added", permissionDiff.added], ["Removed", permissionDiff.removed], ["Unchanged", permissionDiff.unchanged] ] as const).map(([label, values]) => (
                <div role="listitem" key={label}><strong>{label} ({values.length})</strong><span>{values.join(", ") || "None"}</span></div>
              ))}
            </div>
            <button type="button" className="button button--secondary" onClick={() => setReviewedDiffs((current) => new Set(current).add(selected.id))}>{reviewedDiffs.has(selected.id) ? "Reviewed in preview" : "Mark diff reviewed in preview"}</button>
            <p className="skill-studio__boundary"><LockKeyhole size={14} /><span>Review records only a renderer-session marker. There is no verified prior version, package hash, native permission grant, or provider injection.</span></p>
          </>
        ) : <p>No skill is available for permission comparison.</p>}
      </section>

      <p className="skill-studio__boundary"><LockKeyhole size={14} /><span>Project activation changes are renderer-local. No package install, permission grant, context compile, provider injection, or durable project policy is performed.</span></p>
    </div>
  );
}
