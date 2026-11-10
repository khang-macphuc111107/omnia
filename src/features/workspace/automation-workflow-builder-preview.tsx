import {
  Boxes,
  Braces,
  Check,
  ChevronDown,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { AutomationPlanStep, AutomationPlanStepKind } from "./automation-workflow-plan-preview";

export type AutomationBuilderTemplateId =
  | "research-review"
  | "ci-artifact"
  | "human-approval"
  | "data-handoff"
  | "safety-gate";

export type AutomationBuilderStepDraft = {
  kind: AutomationPlanStepKind;
  label: string;
  detail: string;
};

type BuilderVariable = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
};

type BuilderTemplate = {
  id: AutomationBuilderTemplateId;
  name: string;
  description: string;
  category: "Research" | "Delivery" | "Governance" | "Data";
  tone: "blue" | "teal" | "amber" | "coral";
  steps: readonly AutomationBuilderStepDraft[];
};

export type AutomationWorkflowBuilderPreviewProps = {
  automationName: string;
  steps: readonly AutomationPlanStep[];
  onAddSteps?: (drafts: readonly AutomationBuilderStepDraft[]) => void;
  onStatus?: (message: string) => void;
};

const builderTemplates: readonly BuilderTemplate[] = [
  {
    id: "research-review",
    name: "Research review",
    description: "Collect context, check evidence, synthesize, then ask for review.",
    category: "Research",
    tone: "blue",
    steps: [
      { kind: "context", label: "Collect research context", detail: "Resolve {{workspace}} sources visible to the workflow." },
      { kind: "condition", label: "Check evidence coverage", detail: "Continue when citation coverage is ready for {{owner}}." },
      { kind: "action", label: "Synthesize research brief", detail: "Prepare a reviewable brief without calling a provider in this preview." },
      { kind: "approval", label: "Request research review", detail: "Route changes to {{owner}} before any external side effect." },
    ],
  },
  {
    id: "ci-artifact",
    name: "CI artifact handoff",
    description: "Gate a delivery on a ready artifact, then prepare a reviewed handoff.",
    category: "Delivery",
    tone: "teal",
    steps: [
      { kind: "condition", label: "Check artifact status", detail: "Require artifact.status = ready before continuing." },
      { kind: "action", label: "Prepare release handoff", detail: "Draft a portable handoff for {{project}}." },
      { kind: "approval", label: "Review release changes", detail: "Keep deploy authority behind an explicit human review." },
      { kind: "notify", label: "Notify delivery channel", detail: "Stage a notification draft for {{owner}}; no message is sent." },
    ],
  },
  {
    id: "human-approval",
    name: "Human-in-the-loop",
    description: "Make the approval checkpoint the visible center of the workflow.",
    category: "Governance",
    tone: "amber",
    steps: [
      { kind: "context", label: "Prepare decision context", detail: "Summarize the visible request and its policy hints." },
      { kind: "condition", label: "Check review threshold", detail: "Only continue when the selected threshold is satisfied." },
      { kind: "approval", label: "Ask for approval", detail: "Pause at a visible review checkpoint for {{owner}}." },
      { kind: "notify", label: "Record decision route", detail: "Keep the decision route in the renderer rehearsal trail." },
    ],
  },
  {
    id: "data-handoff",
    name: "Data handoff",
    description: "Shape a bounded export, validate it, and prepare a destination draft.",
    category: "Data",
    tone: "coral",
    steps: [
      { kind: "context", label: "Select visible data", detail: "Use the current {{workspace}} scope only." },
      { kind: "condition", label: "Validate export shape", detail: "Check required fields before preparing a handoff." },
      { kind: "action", label: "Prepare portable export", detail: "Create a renderer-local manifest preview." },
      { kind: "notify", label: "Stage destination note", detail: "Prepare a draft notification; no connector is invoked." },
    ],
  },
  {
    id: "safety-gate",
    name: "Safety gate",
    description: "Add a compact condition and approval pair before a sensitive action.",
    category: "Governance",
    tone: "amber",
    steps: [
      { kind: "condition", label: "Check safety policy", detail: "Evaluate the visible policy hint in {{environment}}." },
      { kind: "approval", label: "Require explicit approval", detail: "Keep the action blocked until {{owner}} reviews it." },
    ],
  },
];

const defaultVariables: readonly BuilderVariable[] = [
  { id: "workspace", key: "workspace", value: "Current workspace", enabled: true },
  { id: "project", key: "project", value: "Current project", enabled: true },
  { id: "owner", key: "owner", value: "Current user", enabled: true },
  { id: "environment", key: "environment", value: "Preview environment", enabled: true },
];

const categoryLabels: Record<BuilderTemplate["category"], string> = {
  Research: "Research",
  Delivery: "Delivery",
  Governance: "Governance",
  Data: "Data",
};

function replaceVariables(value: string, variables: readonly BuilderVariable[]): string {
  const values = new Map(variables.filter((variable) => variable.enabled && variable.key.trim()).map((variable) => [variable.key.trim(), variable.value]));
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => values.get(key) ?? match);
}

function normalizeVariableKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export function serializeAutomationWorkflowBuilder(
  automationName: string,
  template: BuilderTemplate,
  variables: readonly BuilderVariable[],
): string {
  return JSON.stringify({
    schema: "omnia.automation-workflow-builder.preview.v1",
    scope: "renderer-session",
    executionDisposition: "preview-only",
    automationName: automationName.trim().slice(0, 240),
    template: {
      id: template.id,
      name: template.name,
      category: template.category,
      steps: template.steps,
    },
    variables: variables.map(({ id: _id, ...variable }) => variable),
    boundary: [
      "No durable workflow write",
      "No provider request, connector grant, scheduler dispatch, or notification",
      "Staged steps are renderer-local planning metadata only",
    ],
  }, null, 2);
}

function cloneDrafts(template: BuilderTemplate, variables: readonly BuilderVariable[]): AutomationBuilderStepDraft[] {
  return template.steps.map((step) => ({
    ...step,
    label: replaceVariables(step.label, variables),
    detail: replaceVariables(step.detail, variables),
  }));
}

export function AutomationWorkflowBuilderPreview({ automationName, steps, onAddSteps, onStatus }: AutomationWorkflowBuilderPreviewProps) {
  const [templateId, setTemplateId] = useState<AutomationBuilderTemplateId>("research-review");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<BuilderTemplate["category"] | "all">("all");
  const [variables, setVariables] = useState<BuilderVariable[]>(() => defaultVariables.map((variable) => ({ ...variable })));
  const [showVariables, setShowVariables] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [customLabel, setCustomLabel] = useState("");
  const [customDetail, setCustomDetail] = useState("A local checkpoint added from the workflow builder.");
  const [status, setStatus] = useState("Choose a template to stage reusable steps into this plan.");

  const visibleTemplates = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return builderTemplates.filter((template) => {
      const matchesCategory = category === "all" || template.category === category;
      const matchesQuery = !normalizedQuery || [template.name, template.description, template.category].join(" ").toLocaleLowerCase().includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }, [category, query]);
  const selectedTemplate = builderTemplates.find((template) => template.id === templateId) ?? builderTemplates[0]!;
  const resolvedDrafts = useMemo(() => cloneDrafts(selectedTemplate, variables), [selectedTemplate, variables]);
  const exportPayload = useMemo(() => serializeAutomationWorkflowBuilder(automationName, selectedTemplate, variables), [automationName, selectedTemplate, variables]);
  const variableKeys = new Set(variables.map((variable) => variable.key));

  const announce = (message: string) => {
    setStatus(message);
    onStatus?.(message);
  };

  const selectTemplate = (next: AutomationBuilderTemplateId) => {
    setTemplateId(next);
    const template = builderTemplates.find((candidate) => candidate.id === next);
    if (template) announce(`${template.name} selected; inspect its steps before staging.`);
  };

  const stageTemplate = () => {
    if (!resolvedDrafts.length) {
      announce("This template has no steps to stage.");
      return;
    }
    onAddSteps?.(resolvedDrafts);
    announce(`Staged ${resolvedDrafts.length} ${selectedTemplate.name} step${resolvedDrafts.length === 1 ? "" : "s"} into the renderer plan; no native workflow changed.`);
  };

  const stageCustom = () => {
    const label = replaceVariables(customLabel, variables).trim();
    if (!label) {
      announce("Name the custom checkpoint before staging it.");
      return;
    }
    onAddSteps?.([{ kind: "condition", label: label.slice(0, 180), detail: replaceVariables(customDetail, variables).trim().slice(0, 500) || "Local checkpoint." }]);
    setCustomLabel("");
    announce(`Staged ${label} as a renderer-local checkpoint.`);
  };

  const addVariable = () => {
    const baseKey = normalizeVariableKey("new-variable");
    let suffix = 1;
    let key = baseKey;
    while (variableKeys.has(key)) {
      suffix += 1;
      key = `${baseKey}-${suffix}`;
    }
    const next = { id: `builder-variable-${Date.now()}`, key, value: "", enabled: true };
    setVariables((current) => [...current, next]);
    announce(`Added ${key}; fill its value before staging a template.`);
  };

  const updateVariable = (id: string, patch: Partial<BuilderVariable>) => {
    setVariables((current) => current.map((variable) => variable.id === id ? { ...variable, ...patch } : variable));
  };

  const removeVariable = (id: string) => {
    setVariables((current) => current.filter((variable) => variable.id !== id));
    announce("Removed a builder variable from this renderer session.");
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      announce("Clipboard unavailable; the builder export remains renderer-local.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      announce("Builder JSON copied; no durable export was created.");
    } catch {
      announce("Clipboard access was denied; the builder export remains renderer-local.");
    }
  };

  return (
    <section className="automation-builder" aria-labelledby="automation-builder-heading">
      <header className="automation-builder__header">
        <div>
          <span className="eyebrow"><Workflow size={13} /> Reusable builder</span>
          <h5 id="automation-builder-heading">Workflow builder palette</h5>
          <p>Stage a guided step sequence, bind visible variables, or add a custom checkpoint without leaving the plan editor.</p>
        </div>
        <span className="automation-builder__badge"><Sparkles size={12} /> Preview only</span>
      </header>
      <p className="automation-builder__boundary"><Boxes size={13} /> Renderer-local builder · {steps.length} plan step{steps.length === 1 ? "" : "s"} currently staged · no scheduler, provider request, or durable write.</p>

      <div className="automation-builder__toolbar">
        <label className="automation-builder__search"><span>Find templates</span><span className="automation-builder__search-control"><Search size={13} aria-hidden="true" /><input aria-label="Search builder templates" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Research, delivery, approval" /></span></label>
        <label><span>Category</span><select aria-label="Builder template category" value={category} onChange={(event) => setCategory(event.target.value as BuilderTemplate["category"] | "all")}><option value="all">All categories</option>{(Object.keys(categoryLabels) as BuilderTemplate["category"][]).map((value) => <option key={value} value={value}>{categoryLabels[value]}</option>)}</select></label>
        <span className="automation-builder__count" role="status" aria-live="polite">{visibleTemplates.length} template{visibleTemplates.length === 1 ? "" : "s"} shown</span>
      </div>

      <div className="automation-builder__layout">
        <div className="automation-builder__templates" role="list" aria-label="Workflow builder templates">
          {visibleTemplates.map((template) => <article key={template.id} className={`automation-builder__template automation-builder__template--${template.tone}`} role="listitem"><button type="button" className="automation-builder__template-select" aria-pressed={template.id === selectedTemplate.id} onClick={() => selectTemplate(template.id)}><span className="automation-builder__template-icon"><Workflow size={14} /></span><span><strong>{template.name}</strong><small>{template.description}</small></span><span className="automation-builder__template-meta">{template.category} · {template.steps.length} steps</span></button></article>)}
          {visibleTemplates.length === 0 ? <div className="automation-builder__empty">No reusable templates match this search.</div> : null}
        </div>

        <div className="automation-builder__inspector" aria-label="Selected workflow builder template">
          <div className="automation-builder__inspector-heading"><div><span className="eyebrow">Selected template</span><strong>{selectedTemplate.name}</strong><small>{selectedTemplate.description}</small></div><span className="automation-builder__template-meta">{selectedTemplate.category}</span></div>
          <ol className="automation-builder__drafts" aria-label="Selected template steps">{resolvedDrafts.map((draft, index) => <li key={`${draft.kind}-${index}`}><span>{index + 1}</span><div><strong>{draft.label}</strong><small>{draft.kind} · {draft.detail}</small></div></li>)}</ol>
          <div className="automation-builder__inspector-actions"><button type="button" className="button button--primary" onClick={stageTemplate}><Plus size={13} /> Stage template</button><button type="button" className="button button--ghost" onClick={() => setShowVariables((open) => !open)} aria-expanded={showVariables}><Braces size={13} /> {showVariables ? "Hide variables" : "Bind variables"}</button><button type="button" className="button button--ghost" onClick={() => setShowExport((open) => !open)} aria-expanded={showExport}>{showExport ? "Hide JSON" : "Preview JSON"}</button></div>
        </div>
      </div>

      {showVariables ? <section className="automation-builder__variables" aria-label="Workflow builder variables"><div className="automation-builder__section-heading"><div><span className="eyebrow">Visible bindings</span><strong>Resolve template placeholders</strong><small>Values are substitutions for this renderer session only. Empty or disabled values remain as placeholders.</small></div><button type="button" className="button button--ghost" onClick={addVariable}><Plus size={13} /> Add variable</button></div><div className="automation-builder__variable-list">{variables.map((variable) => <div className="automation-builder__variable" key={variable.id}><label><span>Key</span><input aria-label={`Variable key ${variable.id}`} value={variable.key} onChange={(event) => updateVariable(variable.id, { key: normalizeVariableKey(event.target.value) })} /></label><label><span>Value</span><input aria-label={`Variable value ${variable.id}`} value={variable.value} onChange={(event) => updateVariable(variable.id, { value: event.target.value })} /></label><label className="automation-builder__variable-toggle"><span>Enabled</span><input type="checkbox" checked={variable.enabled} onChange={(event) => updateVariable(variable.id, { enabled: event.target.checked })} /></label><button type="button" className="button button--ghost" aria-label={`Remove variable ${variable.key}`} onClick={() => removeVariable(variable.id)}><Trash2 size={13} /></button></div>)}</div></section> : null}

      <section className="automation-builder__custom" aria-label="Custom workflow checkpoint"><div className="automation-builder__section-heading"><div><span className="eyebrow">Custom checkpoint</span><strong>Add a one-off gate</strong><small>Use <code>{"{{variable}}"}</code> placeholders to reuse the visible bindings.</small></div><ChevronDown size={14} aria-hidden="true" /></div><div className="automation-builder__custom-grid"><label><span>Checkpoint name</span><input aria-label="Custom checkpoint name" value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} placeholder="e.g. Confirm source freshness" /></label><label><span>Checkpoint detail</span><input aria-label="Custom checkpoint detail" value={customDetail} onChange={(event) => setCustomDetail(event.target.value)} /></label><button type="button" className="button button--secondary" onClick={stageCustom}><Plus size={13} /> Stage checkpoint</button></div></section>

      {showExport ? <section className="automation-builder__export" aria-label="Workflow builder export"><div className="automation-builder__section-heading"><div><span className="eyebrow">Portable builder draft</span><strong>{automationName || "Untitled automation"}</strong><small>Export contains template metadata and visible variable values only.</small></div><button type="button" className="button button--ghost" onClick={() => void copyExport()}><Check size={13} /> Copy JSON</button></div><pre>{exportPayload}</pre></section> : null}
      <p className="automation-builder__status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}

export default AutomationWorkflowBuilderPreview;
