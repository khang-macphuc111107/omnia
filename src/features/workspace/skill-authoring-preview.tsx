import {
  Check,
  Clipboard,
  Download,
  FileJson2,
  FilePlus2,
  FileText,
  LockKeyhole,
  Plus,
  Redo2,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent } from "react";

import { ProductIcon } from "@/components/product-icons";

type SkillScope = "Global" | "Project" | "Manual";
type SkillTrust = "Verified" | "Reviewed" | "Unreviewed";
type ManifestFormat = "json" | "markdown";
type SkillTemplate = "blank" | "code-review" | "research" | "cse-coach";

export interface SkillDraftPreview {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly summary: string;
  readonly scope: SkillScope;
  readonly trust: SkillTrust;
  readonly icon: string;
  readonly instructions: string;
  readonly permissions: readonly string[];
  readonly resources: readonly string[];
  readonly tags: readonly string[];
  readonly evaluationCases: readonly SkillEvaluationCase[];
  readonly source?: "Built in" | "Local" | "Imported";
  readonly enabled?: boolean;
  readonly tokenFootprint?: number;
}

export interface SkillEvaluationCase {
  readonly id: string;
  readonly title: string;
  readonly input: string;
  readonly expected: string;
}

export interface SkillAuthoringPreviewProps {
  readonly initialDraft?: Partial<SkillDraftPreview> | null;
  readonly onStage?: (draft: SkillDraftPreview) => void;
}

const starterDraft: SkillDraftPreview = {
  id: "skill-new-draft",
  name: "New skill draft",
  version: "0.1.0",
  summary: "A renderer-local skill draft waiting for instructions and review.",
  scope: "Manual",
  trust: "Unreviewed",
  icon: "✦",
  instructions: "# New skill draft\n\n## Goal\nDescribe what this skill should help with.\n\n## Workflow\n1. Inspect the request and available context.\n2. Apply the bounded instructions.\n3. Return an auditable result with assumptions called out.",
  permissions: [],
  resources: ["Prompt template"],
  tags: ["draft"],
  evaluationCases: [],
  source: "Imported",
  enabled: false,
  tokenFootprint: 0,
};

const templateDrafts: Record<SkillTemplate, SkillDraftPreview> = {
  blank: starterDraft,
  "code-review": {
    ...starterDraft,
    id: "skill-code-reviewer",
    name: "Code review companion",
    summary: "Reviews supplied code for correctness, maintainability, and explicit risk.",
    scope: "Project",
    icon: "⌘",
    instructions: "# Code review companion\n\n## Goal\nReview supplied code without mutating the workspace.\n\n## Workflow\n1. Establish the requested scope and language.\n2. Inspect correctness, edge cases, security, and maintainability.\n3. Return findings by severity with concrete remediation ideas.\n\n## Output\nUse a concise finding list followed by a small verification plan.",
    permissions: ["read project context"],
    resources: ["Prompt template", "Review rubric", "Examples and constraints"],
    tags: ["code", "review", "safe-default"],
    evaluationCases: [{ id: "review-case-1", title: "Find a boundary bug", input: "Review a function that indexes the final item without checking for an empty list.", expected: "Identify the empty-input risk, point to the relevant condition, and propose a bounded fix." }],
    source: "Imported",
    enabled: false,
    tokenFootprint: 0,
  },
  research: {
    ...starterDraft,
    id: "skill-evidence-researcher",
    name: "Evidence-first researcher",
    summary: "Turns a research question into a claim matrix with source-level provenance.",
    scope: "Global",
    trust: "Reviewed",
    icon: "⌕",
    instructions: "# Evidence-first researcher\n\n## Goal\nSynthesize supplied or retrieved sources without hiding uncertainty.\n\n## Workflow\n1. Break the question into answerable claims.\n2. Record source quality, date, and coverage for each claim.\n3. Separate observation, interpretation, and open questions.\n\n## Output\nReturn a cited synthesis and a short list of unresolved gaps.",
    permissions: ["read research context", "use citations"],
    resources: ["Prompt template", "Claim matrix", "Citation rubric"],
    tags: ["research", "evidence", "citations"],
    evaluationCases: [{ id: "research-case-1", title: "Separate evidence from inference", input: "Two supplied sources agree on the event but differ on its cause.", expected: "State the shared fact, attribute each explanation to its source, and mark the cause as unresolved." }],
    source: "Imported",
    enabled: false,
    tokenFootprint: 0,
  },
  "cse-coach": {
    ...starterDraft,
    id: "skill-cse-coach",
    name: "CSE problem-solving coach",
    summary: "Explains algorithms, proofs, complexity, and adversarial edge cases.",
    scope: "Project",
    icon: "λ",
    instructions: "# CSE problem-solving coach\n\n## Goal\nHelp reason about algorithms before presenting implementation.\n\n## Workflow\n1. Restate constraints and identify the bottleneck.\n2. Compare candidate approaches and prove the selected invariant.\n3. Explain complexity and test adversarial cases.\n\n## Output\nGive a proof sketch, pseudocode, and complexity notes.",
    permissions: ["read problem context"],
    resources: ["Prompt template", "Complexity checklist"],
    tags: ["algorithms", "math", "learning"],
    evaluationCases: [{ id: "cse-case-1", title: "Test a hidden constraint", input: "Compare an O(n^2) approach and an O(n log n) approach for n up to 200,000.", expected: "Reject the quadratic approach under the stated bound and explain the asymptotic reason." }],
    source: "Imported",
    enabled: false,
    tokenFootprint: 0,
  },
};

function cloneDraft(draft: SkillDraftPreview): SkillDraftPreview {
  return {
    ...draft,
    permissions: [...draft.permissions],
    resources: [...draft.resources],
    tags: [...draft.tags],
    evaluationCases: draft.evaluationCases.map((evaluationCase) => ({ ...evaluationCase })),
    ...(draft.source ? { source: draft.source } : {}),
    ...(draft.enabled === undefined ? {} : { enabled: draft.enabled }),
    ...(draft.tokenFootprint === undefined ? {} : { tokenFootprint: draft.tokenFootprint }),
  };
}

function resolveInitialDraft(initialDraft?: Partial<SkillDraftPreview> | null): SkillDraftPreview {
  if (!initialDraft) return cloneDraft(starterDraft);
  const normalized = normalizeDraft({ ...starterDraft, ...initialDraft });
  return normalized ? cloneDraft(normalized) : cloneDraft(starterDraft);
}

function normalizeDraft(value: unknown): SkillDraftPreview | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SkillDraftPreview>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) return null;
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) return null;
  const scope: SkillScope = candidate.scope === "Global" || candidate.scope === "Project" || candidate.scope === "Manual" ? candidate.scope : "Manual";
  const trust: SkillTrust = candidate.trust === "Verified" || candidate.trust === "Reviewed" || candidate.trust === "Unreviewed" ? candidate.trust : "Unreviewed";
  return {
    id: candidate.id.trim(),
    name: candidate.name.trim(),
    version: typeof candidate.version === "string" && candidate.version.trim() ? candidate.version.trim() : "0.1.0",
    summary: typeof candidate.summary === "string" ? candidate.summary : "",
    scope,
    trust,
    icon: typeof candidate.icon === "string" ? candidate.icon.slice(0, 3) : "✦",
    instructions: typeof candidate.instructions === "string" ? candidate.instructions : "",
    permissions: Array.isArray(candidate.permissions) ? candidate.permissions.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [],
    resources: Array.isArray(candidate.resources) ? candidate.resources.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [],
    tags: Array.isArray(candidate.tags) ? candidate.tags.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [],
    evaluationCases: Array.isArray(candidate.evaluationCases) ? candidate.evaluationCases.slice(0, 24).flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const evaluationCase = item as Partial<SkillEvaluationCase>;
      return [{
        id: typeof evaluationCase.id === "string" && evaluationCase.id.trim() ? evaluationCase.id.trim().slice(0, 80) : `evaluation-case-${index + 1}`,
        title: typeof evaluationCase.title === "string" ? evaluationCase.title.slice(0, 120) : "",
        input: typeof evaluationCase.input === "string" ? evaluationCase.input.slice(0, 3000) : "",
        expected: typeof evaluationCase.expected === "string" ? evaluationCase.expected.slice(0, 3000) : "",
      }];
    }) : [],
    source: candidate.source === "Built in" || candidate.source === "Local" || candidate.source === "Imported" ? candidate.source : "Imported",
    enabled: candidate.enabled === true,
    tokenFootprint: typeof candidate.tokenFootprint === "number" && Number.isFinite(candidate.tokenFootprint) ? Math.max(0, Math.round(candidate.tokenFootprint)) : 0,
  };
}

export function serializeSkillDraft(draft: SkillDraftPreview, format: ManifestFormat): string {
  if (format === "markdown") {
    return [
      `# ${draft.name}`,
      "",
      "> Renderer-local authoring preview. This package is not installed or injected into a provider request.",
      "",
      `- **ID:** \`${draft.id}\``,
      `- **Version:** ${draft.version}`,
      `- **Scope:** ${draft.scope}`,
      `- **Trust:** ${draft.trust}`,
      `- **Tags:** ${draft.tags.join(", ") || "none"}`,
      "",
      draft.instructions,
      "",
      "## Permissions",
      ...(draft.permissions.length ? draft.permissions.map((permission) => `- ${permission}`) : ["- none listed"]),
      "",
      "## Resources",
      ...(draft.resources.length ? draft.resources.map((resource) => `- ${resource}`) : ["- none listed"]),
      "",
      "## Evaluation cases (not executed)",
      ...(draft.evaluationCases.length ? draft.evaluationCases.flatMap((evaluationCase, index) => [`### ${index + 1}. ${evaluationCase.title || "Untitled case"}`, "", `Input: ${evaluationCase.input || "(empty)"}`, "", `Expected behavior: ${evaluationCase.expected || "(empty)"}`, ""]) : ["- none drafted"]),
    ].join("\n");
  }
  return JSON.stringify({
    schema: "omnia.skill-authoring-preview.v1",
    scope: "renderer-session",
    nativeActivation: "planned",
    draft,
  }, null, 2);
}

function downloadText(payload: string, filename: string, type: string): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function Boundary({ children }: { readonly children: string }) {
  return <p className="skill-authoring__boundary"><LockKeyhole size={14} /><span>{children}</span></p>;
}

export default function SkillAuthoringPreview({ initialDraft = null, onStage }: SkillAuthoringPreviewProps) {
  const [draft, setDraft] = useState<SkillDraftPreview>(() => resolveInitialDraft(initialDraft));
  const [history, setHistory] = useState<{ past: SkillDraftPreview[]; future: SkillDraftPreview[] }>({ past: [], future: [] });
  const [template, setTemplate] = useState<SkillTemplate>("blank");
  const [manifestFormat, setManifestFormat] = useState<ManifestFormat>("json");
  const [manifestOpen, setManifestOpen] = useState(false);
  const [status, setStatus] = useState("Draft changes stay in this renderer session.");
  const fileInput = useRef<HTMLInputElement>(null);

  const validation = useMemo(() => {
    const checks = [
      { label: "Skill ID", ok: /^[a-z0-9][a-z0-9-]{2,63}$/.test(draft.id) },
      { label: "Name", ok: draft.name.trim().length >= 3 },
      { label: "Version", ok: /^\d+\.\d+\.\d+$/.test(draft.version) },
      { label: "Instructions", ok: draft.instructions.trim().length >= 48 },
      { label: "Scope", ok: Boolean(draft.scope) },
      { label: "Evaluation cases", ok: draft.evaluationCases.every((evaluationCase) => evaluationCase.title.trim().length >= 3 && evaluationCase.input.trim().length >= 10 && evaluationCase.expected.trim().length >= 10) },
    ];
    return { checks, passed: checks.filter((check) => check.ok).length };
  }, [draft]);

  const manifest = useMemo(() => serializeSkillDraft(draft, manifestFormat), [draft, manifestFormat]);

  const updateDraft = (change: (current: SkillDraftPreview) => SkillDraftPreview, message = "Draft updated in renderer preview.") => {
    setDraft((current) => {
      const next = cloneDraft(change(current));
      setHistory((currentHistory) => ({ past: [...currentHistory.past, cloneDraft(current)], future: [] }));
      return next;
    });
    setStatus(message);
  };

  const applyTemplate = () => {
    updateDraft(() => cloneDraft(templateDrafts[template]), `Applied the ${template === "blank" ? "blank" : template} starter template in preview.`);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      setDraft(cloneDraft(previous));
      return { past: current.past.slice(0, -1), future: [cloneDraft(draft), ...current.future] };
    });
    setStatus("Undid the last renderer-local authoring change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      setDraft(cloneDraft(next));
      return { past: [...current.past, cloneDraft(draft)], future: current.future.slice(1) };
    });
    setStatus("Reapplied the next renderer-local authoring change.");
  };

  const reset = () => {
    setHistory((current) => ({ past: [...current.past, cloneDraft(draft)], future: [] }));
    setDraft(resolveInitialDraft(initialDraft));
    setStatus("Reset the authoring draft to its renderer-local starting point.");
  };

  const stageDraft = () => {
    if (validation.passed < validation.checks.length) {
      setStatus("Resolve local validation issues before staging this skill draft.");
      return;
    }
    onStage?.(cloneDraft(draft));
    setStatus(onStage ? "Skill draft staged in this renderer preview; native catalog is unchanged." : "Native catalog writes remain planned.");
  };

  const copyManifest = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no authoring package was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(manifest);
      setStatus(`Copied the renderer-local ${manifestFormat.toUpperCase()} authoring preview.`);
    } catch {
      setStatus("Clipboard access was denied; no authoring package was copied.");
    }
  };

  const exportManifest = () => {
    const extension = manifestFormat === "json" ? "json" : "md";
    setStatus(downloadText(manifest, `omnia-skill-authoring-preview.${extension}`, manifestFormat === "json" ? "application/json" : "text/markdown")
      ? `Started a browser download for the renderer-local ${manifestFormat.toUpperCase()} preview.`
      : "Browser download is unavailable; no authoring package was exported.");
  };

  const importDraft = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 512 * 1024) {
      setStatus("Import rejected: authoring draft is larger than the 512 KB preview limit.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result).replace(/^\\uFEFF/, "")) as { draft?: unknown };
        const normalized = normalizeDraft(parsed.draft ?? parsed);
        if (!normalized) throw new Error("invalid");
        updateDraft(() => normalized, "Imported a validated renderer-local authoring draft.");
      } catch {
        setStatus("Import rejected: expected an Omnia skill draft JSON object with id and name.");
      }
    };
    reader.onerror = () => setStatus("Import failed: the browser could not read this preview file.");
    reader.readAsText(file);
  };

  const setField = <K extends keyof SkillDraftPreview>(field: K, value: SkillDraftPreview[K]) => {
    updateDraft((current) => ({ ...current, [field]: value }));
  };

  const setListField = (field: "permissions" | "tags", value: string) => {
    setField(field, value.split(",").map((item) => item.trim()).filter(Boolean));
  };

  const addResource = () => updateDraft((current) => ({ ...current, resources: [...current.resources, `Resource ${current.resources.length + 1}`] }));
  const removeResource = (resource: string) => updateDraft((current) => ({ ...current, resources: current.resources.filter((item) => item !== resource) }));
  const addEvaluationCase = () => updateDraft((current) => ({ ...current, evaluationCases: [...current.evaluationCases, { id: `evaluation-case-${Date.now()}-${current.evaluationCases.length + 1}`, title: "", input: "", expected: "" }] }), "Added a draft evaluation case; it has not been executed.");
  const updateEvaluationCase = (id: string, field: "title" | "input" | "expected", value: string) => updateDraft((current) => ({ ...current, evaluationCases: current.evaluationCases.map((evaluationCase) => evaluationCase.id === id ? { ...evaluationCase, [field]: value } : evaluationCase) }));
  const removeEvaluationCase = (id: string) => updateDraft((current) => ({ ...current, evaluationCases: current.evaluationCases.filter((evaluationCase) => evaluationCase.id !== id) }));

  return (
    <section className="skill-authoring" aria-label="Skill authoring preview">
      <header className="skill-authoring__header">
        <div className="skill-authoring__hero"><span className="skill-authoring__hero-icon"><FilePlus2 size={21} /></span><div><span className="eyebrow">Skill authoring lab</span><h2>Shape an instruction package before it enters the catalog</h2><p>Draft metadata, instructions, resources, and permission intent with fast reversible controls.</p></div></div>
        <span className="skill-authoring__status"><Sparkles size={13} /> Preview only</span>
      </header>

      <div className="skill-authoring__toolbar" role="toolbar" aria-label="Skill authoring actions">
        <label><span>Starter</span><select aria-label="Skill starter template" value={template} onChange={(event) => setTemplate(event.target.value as SkillTemplate)}><option value="blank">Blank draft</option><option value="code-review">Code review</option><option value="research">Evidence research</option><option value="cse-coach">CSE coach</option></select></label>
        <button type="button" className="button button--primary" onClick={applyTemplate}><Sparkles size={14} /> Apply starter</button>
        <span className="skill-authoring__toolbar-spacer" />
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo skill draft edit"><Undo2 size={14} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo skill draft edit"><Redo2 size={14} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset skill draft"><RotateCcw size={14} /> Reset</button>
      </div>

      <div className="skill-authoring__status-line" role="status" aria-live="polite"><Check size={14} /> {status}</div>

      <div className="skill-authoring__layout">
        <form className="skill-authoring__form" onSubmit={(event) => event.preventDefault()}>
          <div className="skill-authoring__section-heading"><div><span className="eyebrow">Identity</span><h3>Catalog metadata</h3></div><span className="skill-studio__chip skill-studio__chip--teal">Renderer-local</span></div>
          <div className="skill-authoring__field-grid">
            <label><span>Name</span><input aria-label="Skill draft name" value={draft.name} onChange={(event) => setField("name", event.target.value)} /></label>
            <label><span>Stable ID</span><input aria-label="Skill draft id" value={draft.id} onChange={(event) => setField("id", event.target.value)} /></label>
            <label><span>Version</span><input aria-label="Skill draft version" value={draft.version} onChange={(event) => setField("version", event.target.value)} /></label>
            <label><span>Icon mark</span><input aria-label="Skill draft icon" maxLength={3} value={draft.icon} onChange={(event) => setField("icon", event.target.value)} /></label>
            <label><span>Scope</span><select aria-label="Skill draft scope" value={draft.scope} onChange={(event) => setField("scope", event.target.value as SkillScope)}><option>Global</option><option>Project</option><option>Manual</option></select></label>
            <label><span>Trust marker</span><select aria-label="Skill draft trust" value={draft.trust} onChange={(event) => setField("trust", event.target.value as SkillTrust)}><option>Verified</option><option>Reviewed</option><option>Unreviewed</option></select></label>
          </div>
          <label className="skill-authoring__wide-field"><span>Summary</span><textarea aria-label="Skill draft summary" rows={2} value={draft.summary} onChange={(event) => setField("summary", event.target.value)} /></label>
          <div className="skill-authoring__section-heading"><div><span className="eyebrow">Instruction package</span><h3>Prompt body and resources</h3></div><FileText size={18} /></div>
          <label className="skill-authoring__wide-field"><span>Instructions (Markdown)</span><textarea aria-label="Skill draft instructions" rows={13} value={draft.instructions} onChange={(event) => setField("instructions", event.target.value)} /></label>
          <label className="skill-authoring__wide-field"><span>Permission intent (comma separated)</span><input aria-label="Skill draft permissions" value={draft.permissions.join(", ")} onChange={(event) => setListField("permissions", event.target.value)} placeholder="read project context, use citations" /></label>
          <label className="skill-authoring__wide-field"><span>Tags (comma separated)</span><input aria-label="Skill draft tags" value={draft.tags.join(", ")} onChange={(event) => setListField("tags", event.target.value)} placeholder="research, evidence, safe-default" /></label>
          <div className="skill-authoring__evaluation-heading"><div><span className="eyebrow">Quality scenarios</span><strong>Cases for later evaluation</strong><small>These are authored expectations only; Omnia does not run a model or score them here.</small></div><button type="button" className="button button--ghost" onClick={addEvaluationCase}><Plus size={13} /> Add case</button></div>
          <div className="skill-authoring__evaluation-list" aria-label="Skill evaluation cases">
            {draft.evaluationCases.map((evaluationCase, index) => (
              <fieldset key={evaluationCase.id} className="skill-authoring__evaluation-case">
                <legend>Case {index + 1}</legend>
                <label><span>Scenario title</span><input aria-label={`Evaluation case ${index + 1} title`} value={evaluationCase.title} onChange={(event) => updateEvaluationCase(evaluationCase.id, "title", event.target.value)} /></label>
                <label><span>Input / situation</span><textarea aria-label={`Evaluation case ${index + 1} input`} rows={2} value={evaluationCase.input} onChange={(event) => updateEvaluationCase(evaluationCase.id, "input", event.target.value)} /></label>
                <label><span>Expected behavior</span><textarea aria-label={`Evaluation case ${index + 1} expected behavior`} rows={2} value={evaluationCase.expected} onChange={(event) => updateEvaluationCase(evaluationCase.id, "expected", event.target.value)} /></label>
                <button type="button" className="button button--ghost" aria-label={`Remove evaluation case ${index + 1}`} onClick={() => removeEvaluationCase(evaluationCase.id)}><Trash2 size={13} /> Remove case</button>
              </fieldset>
            ))}
            {draft.evaluationCases.length === 0 ? <p className="skill-authoring__muted">No scenarios yet. Adding a case creates a local completeness check only.</p> : null}
          </div>
          <div className="skill-authoring__resource-heading"><span className="eyebrow">Attached resources</span><button type="button" className="button button--ghost" onClick={addResource}><Plus size={13} /> Add resource</button></div>
          <div className="skill-authoring__resource-list" aria-label="Skill draft resources">{draft.resources.map((resource) => <div key={resource}><FileText size={14} /><span>{resource}</span><button type="button" aria-label={`Remove ${resource}`} onClick={() => removeResource(resource)}><Trash2 size={13} /></button></div>)}{draft.resources.length === 0 ? <span className="skill-authoring__muted">No resources attached.</span> : null}</div>
        </form>

        <aside className="skill-authoring__inspector" aria-label="Skill authoring inspector">
          <div className="skill-authoring__section-heading"><div><span className="eyebrow">Authoring inspector</span><h3>{draft.name || "Untitled skill"}</h3></div><span className="skill-authoring__mark" aria-hidden="true"><ProductIcon name="skill" size={16} /></span></div>
          <p className="skill-authoring__summary">{draft.summary || "Add a summary so the catalog can explain this package."}</p>
          <div className="skill-authoring__chips"><span className="skill-studio__chip">v{draft.version || "0.1.0"}</span><span className="skill-studio__chip skill-studio__chip--blue">{draft.scope}</span><span className={`skill-studio__chip ${draft.trust === "Verified" ? "skill-studio__chip--teal" : draft.trust === "Reviewed" ? "skill-studio__chip--blue" : "skill-studio__chip--amber"}`}>{draft.trust}</span></div>
          <div className="skill-authoring__validation"><div className="skill-authoring__validation-heading"><span>Local validation</span><strong>{validation.passed}/{validation.checks.length}</strong></div>{validation.checks.map((check) => <div key={check.label}><span className={check.ok ? "is-pass" : "is-pending"}>{check.ok ? <Check size={12} /> : "•"}</span><span>{check.label}</span><em>{check.ok ? "Ready" : "Needs review"}</em></div>)}</div>
          <div className="skill-authoring__inspector-section"><span className="eyebrow">Permission intent</span><div className="skill-authoring__chips">{draft.permissions.length ? draft.permissions.map((permission) => <span key={permission} className="skill-studio__chip">{permission}</span>) : <span className="skill-authoring__muted">No permissions listed</span>}</div></div>
          <div className="skill-authoring__inspector-section"><span className="eyebrow">Evaluation coverage</span><strong>{draft.evaluationCases.length} authored · not run</strong><small>Case completeness is checked locally; no model is called.</small></div>
          <div className="skill-authoring__inspector-section"><span className="eyebrow">Draft actions</span><div className="skill-authoring__actions"><button type="button" className="button button--secondary" onClick={() => setManifestOpen((current) => !current)} aria-expanded={manifestOpen}><FileJson2 size={14} /> {manifestOpen ? "Hide manifest" : "Preview manifest"}</button>{onStage ? <button type="button" className="button button--primary" onClick={stageDraft} disabled={validation.passed < validation.checks.length}><Check size={14} /> Stage in preview</button> : <button type="button" className="button button--ghost" disabled title="Native catalog writes are planned"><Check size={14} /> Save to catalog planned</button>}</div></div>
          <div className="skill-authoring__actions"><button type="button" className="button button--ghost" onClick={() => fileInput.current?.click()}><Upload size={14} /> Import JSON</button><button type="button" className="button button--ghost" onClick={() => void copyManifest()}><Clipboard size={14} /> Copy</button><button type="button" className="button button--secondary" onClick={exportManifest}><Download size={14} /> Export</button></div>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={importDraft} />
          {manifestOpen ? <section className="skill-authoring__manifest" aria-label="Skill authoring manifest preview"><header><div><span className="eyebrow">Draft package</span><strong>{manifestFormat.toUpperCase()} preview</strong></div><span className="skill-studio__chip skill-studio__chip--amber">No native install</span></header><label><span>Format</span><select aria-label="Skill authoring manifest format" value={manifestFormat} onChange={(event) => setManifestFormat(event.target.value as ManifestFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><pre tabIndex={0}><code>{manifest}</code></pre><Boundary>This package is an inspectable renderer-session draft. It does not install, load, authorize, persist, or inject this skill into a provider request.</Boundary></section> : null}
        </aside>
      </div>
    </section>
  );
}

export { normalizeDraft, starterDraft };
