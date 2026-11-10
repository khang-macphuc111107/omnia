import {
  AlertTriangle,
  Check,
  Clipboard,
  FileCheck2,
  FileDiff,
  FileJson2,
  Info,
  LockKeyhole,
  PackageCheck,
  Search,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent } from "react";

import type { SkillView } from "./types";
import { buildSkillPackageDiff, serializeSkillPackageDiff, type SkillPackageDiffCategory, type SkillPackageDiffRow } from "./skill-package-diff";
import {
  inspectSkillPackagePayload,
  type SkillPackageReview,
  type SkillPackageVersionChange,
} from "./skill-package-review-contract";

export interface SkillPackageReviewPreviewProps {
  readonly skills: readonly SkillView[];
  readonly enabledIds?: ReadonlySet<string>;
}

type DiffCategoryFilter = "all" | SkillPackageDiffCategory;
type DiffFormat = "json" | "markdown";

const diffCategories: Array<[DiffCategoryFilter, string]> = [
  ["all", "All fields"],
  ["identity", "Identity"],
  ["release", "Release"],
  ["metadata", "Metadata"],
  ["capability", "Capabilities"],
  ["content", "Content"],
];

function diffStatusLabel(row: SkillPackageDiffRow): string {
  return row.status === "unavailable" ? "Unavailable" : row.status === "same" ? "Unchanged" : row.status[0]!.toUpperCase() + row.status.slice(1);
}

function downloadDiff(payload: string, format: DiffFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-skill-package-diff-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function packagePayloadForSkill(skill: SkillView | undefined): string {
  if (!skill) {
    return JSON.stringify({
      schema: "omnia.skill-authoring-preview.v1",
      scope: "renderer-session",
      nativeActivation: "planned",
      draft: {
        id: "skill-package-review",
        name: "Package review sample",
        version: "0.1.0",
        summary: "A sample package to inspect before a future catalog update.",
        scope: "Manual",
        trust: "Unreviewed",
        icon: "◈",
        instructions: "# Package review sample\n\nInspect this package before allowing it into the skill catalog.\n\nReturn a bounded review with version and permission changes.",
        permissions: ["read project context"],
        resources: ["Review checklist"],
        tags: ["preview", "review"],
      },
    }, null, 2);
  }
  return JSON.stringify({
    schema: "omnia.skill-authoring-preview.v1",
    scope: "renderer-session",
    nativeActivation: "planned",
    draft: {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      summary: skill.description,
      scope: skill.scope,
      trust: skill.trust,
      icon: skill.icon,
      instructions: `# ${skill.name}\n\n${skill.description}\n\nReview this package before a future catalog update.`,
      permissions: skill.permissions,
      resources: ["Prompt template", "Review checklist"],
      tags: [skill.scope.toLowerCase(), skill.source.toLowerCase()],
    },
  }, null, 2);
}

const versionTone: Record<SkillPackageVersionChange, string> = {
  new: "skill-package-review__chip--blue",
  same: "skill-package-review__chip--teal",
  patch: "skill-package-review__chip--teal",
  minor: "skill-package-review__chip--blue",
  major: "skill-package-review__chip--amber",
  downgrade: "skill-package-review__chip--red",
};

const versionLabel: Record<SkillPackageVersionChange, string> = {
  new: "New package",
  same: "Same version",
  patch: "Patch update",
  minor: "Minor update",
  major: "Major update",
  downgrade: "Downgrade",
};

function Boundary({ children }: { readonly children: string }) {
  return <p className="skill-package-review__boundary"><LockKeyhole size={14} /><span>{children}</span></p>;
}

function ReviewSummary({ review }: { readonly review: SkillPackageReview }) {
  if (!review.package) {
    return <div className="skill-package-review__empty"><AlertTriangle size={20} /><strong>Package needs attention</strong><span>Resolve the checks below before this preview can be staged.</span></div>;
  }
  const hasRisk = review.versionChange === "major" || review.versionChange === "downgrade" || review.addedPermissions.length > 0 || review.scopeChanged;
  return (
    <div className={`skill-package-review__summary${hasRisk ? " is-risk" : ""}`} role="status" aria-live="polite">
      {hasRisk ? <AlertTriangle size={18} /> : <PackageCheck size={18} />}
      <span>
        <strong>{review.versionChange ? versionLabel[review.versionChange] : "Review ready"} · {review.package.name}</strong>
        <small>{review.existing ? `Comparing against installed v${review.existing.version}.` : "No matching installed skill was found in the current catalog projection."}</small>
      </span>
    </div>
  );
}

export default function SkillPackageReviewPreview({ skills, enabledIds }: SkillPackageReviewPreviewProps) {
  const firstSkill = useMemo(() => skills.find((skill) => enabledIds?.has(skill.id)) ?? skills[0], [enabledIds, skills]);
  const [payload, setPayload] = useState(() => packagePayloadForSkill(firstSkill));
  const [review, setReview] = useState<SkillPackageReview>(() => inspectSkillPackagePayload(packagePayloadForSkill(firstSkill), skills));
  const [status, setStatus] = useState("Sample package loaded for review; no catalog update was requested.");
  const [categoryFilter, setCategoryFilter] = useState<DiffCategoryFilter>("all");
  const [changesOnly, setChangesOnly] = useState(false);
  const [diffFormat, setDiffFormat] = useState<DiffFormat>("json");
  const [diffExportOpen, setDiffExportOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const diffRows = useMemo(() => buildSkillPackageDiff(review), [review]);
  const visibleDiffRows = useMemo(() => diffRows.filter((row) =>
    (categoryFilter === "all" || row.category === categoryFilter) && (!changesOnly || row.status !== "same"),
  ), [categoryFilter, changesOnly, diffRows]);
  const diffPayload = useMemo(() => serializeSkillPackageDiff(diffRows, diffFormat), [diffFormat, diffRows]);

  const inspect = () => {
    const next = inspectSkillPackagePayload(payload, skills);
    setReview(next);
    setStatus(next.canStage
      ? "Package passed local checks. Staging remains renderer-local and does not install or activate it."
      : next.error ?? "Package review found issues; no package was staged.");
  };

  const copyPayload = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no package was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus("Copied the renderer-local package payload.");
    } catch {
      setStatus("Clipboard access was denied; no package was copied.");
    }
  };

  const importPackage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 512 * 1024) {
      setStatus("Import rejected: package is larger than the 512 KB preview limit.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const nextPayload = String(reader.result).replace(/^\uFEFF/, "");
      setPayload(nextPayload);
      setReview(inspectSkillPackagePayload(nextPayload, skills));
      setStatus("Imported package into the renderer-local review buffer.");
    };
    reader.onerror = () => setStatus("Import failed: the browser could not read this package file.");
    reader.readAsText(file);
  };

  const stagePreview = () => {
    setStatus(review.canStage
      ? "Package marked for staging in this renderer preview only; native catalog is unchanged."
      : "Resolve local review checks before staging this package preview.");
  };

  const copyDiff = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no diff was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(diffPayload);
      setStatus(`Copied ${diffRows.length} renderer-local package diff rows as ${diffFormat.toUpperCase()}.`);
    } catch {
      setStatus("Clipboard access was denied; no diff was copied.");
    }
  };

  const exportDiff = () => {
    setStatus(downloadDiff(diffPayload, diffFormat)
      ? "Browser download started; no app-managed package write occurred."
      : "File download is unavailable in this surface; no diff was exported.");
  };

  return (
    <section className="skill-package-review" aria-label="Skill package review preview">
      <header className="skill-package-review__header">
        <div>
          <span className="eyebrow">Package lifecycle preview</span>
          <h3><FileCheck2 size={17} /> Review before catalog change</h3>
          <p>Import a skill package, inspect version and capability changes, then decide whether to stage it for a later native workflow.</p>
        </div>
        <span className="skill-package-review__status"><ShieldCheck size={13} /> Preview only</span>
      </header>

      <div className="skill-package-review__toolbar" role="toolbar" aria-label="Skill package review actions">
        <button type="button" className="button button--secondary" onClick={() => fileInput.current?.click()}><Upload size={14} /> Import package</button>
        <button type="button" className="button button--ghost" onClick={inspect}><FileCheck2 size={14} /> Inspect payload</button>
        <button type="button" className="button button--ghost" onClick={() => void copyPayload()}><Clipboard size={14} /> Copy JSON</button>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={importPackage} />
        <span className="skill-package-review__toolbar-status" role="status" aria-live="polite">{status}</span>
      </div>

      <div className="skill-package-review__layout">
        <div className="skill-package-review__editor">
          <label><span>Package JSON</span><textarea aria-label="Skill package JSON" value={payload} onChange={(event) => setPayload(event.target.value)} rows={18} spellCheck={false} /></label>
          <div className="skill-package-review__editor-actions">
            <button type="button" className="button button--primary" onClick={inspect}><FileJson2 size={14} /> Run local review</button>
            <span><Info size={13} /> Max 512 KB · no file write</span>
          </div>
        </div>

        <div className="skill-package-review__results">
          <ReviewSummary review={review} />
          <div className="skill-package-review__checks" aria-label="Skill package validation checks">
            {review.checks.map((check) => (
              <div key={check.id} className={`skill-package-review__check${check.passed ? " is-pass" : " is-fail"}`}>
                <span>{check.passed ? <Check size={13} /> : <X size={13} />}</span>
                <div><strong>{check.label}</strong><small>{check.detail}</small></div>
                <em>{check.passed ? "Pass" : "Review"}</em>
              </div>
            ))}
          </div>

          {review.package ? (
            <>
              <div className="skill-package-review__diff-grid">
                <article><span className="eyebrow">Version</span><strong>{review.existing ? `v${review.existing.version}` : "—"} → v{review.package.version}</strong><span className={`skill-package-review__chip ${review.versionChange ? versionTone[review.versionChange] : ""}`}>{review.versionChange ? versionLabel[review.versionChange] : "Unknown"}</span></article>
                <article><span className="eyebrow">Scope</span><strong>{review.existing?.scope ?? "No baseline"} → {review.package.declaredScope}</strong><span className={`skill-package-review__chip${review.scopeChanged ? " skill-package-review__chip--amber" : " skill-package-review__chip--teal"}`}>{review.scopeChanged ? "Changed" : "Same"}</span></article>
                <article><span className="eyebrow">Summary</span><strong>{review.summaryChanged ? "Description changed" : "No description diff"}</strong><span className="skill-package-review__chip">Metadata</span></article>
              </div>
              <div className="skill-package-review__permission-diff" aria-label="Skill package permission diff">
                <div><span className="eyebrow">Capability diff</span><strong>{review.addedPermissions.length + review.removedPermissions.length === 0 ? "No permission changes" : `${review.addedPermissions.length + review.removedPermissions.length} permission change${review.addedPermissions.length + review.removedPermissions.length === 1 ? "" : "s"}`}</strong></div>
                {review.addedPermissions.map((permission) => <span key={`added:${permission}`} className="skill-package-review__diff-chip skill-package-review__diff-chip--added"><Check size={11} /> Added · {permission}</span>)}
                {review.removedPermissions.map((permission) => <span key={`removed:${permission}`} className="skill-package-review__diff-chip skill-package-review__diff-chip--removed"><X size={11} /> Removed · {permission}</span>)}
              </div>
              <section className="skill-package-review__field-diff" aria-label="Skill package field diff">
                <header>
                  <div><span className="eyebrow">Package diff workbench</span><strong>{diffRows.filter((row) => row.status !== "same" && row.status !== "unavailable").length} changed · {diffRows.filter((row) => row.status === "unavailable").length} unavailable</strong></div>
                  <button type="button" className="button button--ghost" onClick={() => setDiffExportOpen((current) => !current)} aria-expanded={diffExportOpen} aria-controls="skill-package-diff-export"><FileJson2 size={13} /> {diffExportOpen ? "Hide export" : "Export diff"}</button>
                </header>
                <div className="skill-package-review__diff-tools" role="toolbar" aria-label="Package diff filters">
                  <label><Search size={13} /><select aria-label="Filter package diff category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as DiffCategoryFilter)}>{diffCategories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label className="skill-package-review__diff-toggle"><input type="checkbox" checked={changesOnly} onChange={(event) => setChangesOnly(event.target.checked)} /><span>Hide unchanged</span></label>
                  <span role="status" aria-live="polite">Showing {visibleDiffRows.length} of {diffRows.length} fields</span>
                </div>
                <div className="skill-package-review__field-diff-list" role="list" aria-label="Package field differences">
                  {visibleDiffRows.map((row) => (
                    <article key={row.id} className={`skill-package-review__field-row skill-package-review__field-row--${row.status}`} role="listitem">
                      <div className="skill-package-review__field-label"><span className="skill-package-review__chip">{row.category}</span><strong>{row.label}</strong><em>{diffStatusLabel(row)}</em></div>
                      <div className="skill-package-review__field-values"><div><span>Installed projection</span><p>{row.baseline}</p></div><div><span>Incoming package</span><p>{row.candidate}</p></div></div>
                      {row.added.length || row.removed.length ? <div className="skill-package-review__field-deltas">{row.added.map((value) => <span key={`added:${value}`} className="skill-package-review__diff-chip skill-package-review__diff-chip--added"><Check size={11} /> Added · {value}</span>)}{row.removed.map((value) => <span key={`removed:${value}`} className="skill-package-review__diff-chip skill-package-review__diff-chip--removed"><X size={11} /> Removed · {value}</span>)}</div> : null}
                    </article>
                  ))}
                  {visibleDiffRows.length === 0 ? <div className="skill-package-review__empty"><FileDiff size={18} /><strong>No fields match these filters</strong><span>Choose another category or show unchanged fields.</span></div> : null}
                </div>
                {diffExportOpen ? <div id="skill-package-diff-export" className="skill-package-review__diff-export" aria-label="Package diff export preview">
                  <label><span>Format</span><select aria-label="Package diff export format" value={diffFormat} onChange={(event) => setDiffFormat(event.target.value as DiffFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
                  <span className="skill-package-review__diff-export-note">Renderer-local snapshot · body diff unavailable</span>
                  <button type="button" className="button button--ghost" onClick={() => void copyDiff()}><Clipboard size={13} /> Copy</button>
                  <button type="button" className="button button--secondary" onClick={exportDiff}><Upload size={13} /> Download</button>
                  <pre tabIndex={0} aria-label="Package diff export payload"><code>{diffPayload}</code></pre>
                </div> : null}
              </section>
            </>
          ) : null}
          <div className="skill-package-review__actions">
            <button type="button" className="button button--primary" onClick={stagePreview} disabled={!review.canStage}><PackageCheck size={14} /> Stage in preview</button>
            <span><FileDiff size={13} /> {review.package ? "Body diff is unavailable until a native package provenance store exists." : "Resolve the local checks before staging this package preview."}</span>
          </div>
          <Boundary>Review is renderer-local. It does not install, update, remove, trust, authorize, persist, load, or inject a skill into a provider request.</Boundary>
        </div>
      </div>
    </section>
  );
}
