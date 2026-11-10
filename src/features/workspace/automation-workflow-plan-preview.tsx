import {
  ArrowDown,
  ArrowUp,
  Check,
  Clipboard,
  Download,
  Eye,
  GitBranch,
  GripVertical,
  Plus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useMemo, useState } from "react";

import { AutomationConditionSetPreview, createDefaultAutomationConditionSet, validateAutomationConditionSet, type AutomationConditionSetSnapshot } from "./automation-condition-set-preview";
import { AutomationWorkflowBuilderPreview, type AutomationBuilderStepDraft } from "./automation-workflow-builder-preview";

export type AutomationPlanStepKind = "trigger" | "context" | "condition" | "action" | "approval" | "notify";
export type AutomationConditionOperator = "exists" | "equals" | "contains" | "greater-than" | "less-than";
export type AutomationApprovalRoute = "auto-preview" | "review-changes" | "always-ask" | "deny-by-default";
export type AutomationPlanExportFormat = "json" | "markdown";
export type AutomationPlanPreset = "balanced" | "lean" | "approval-first" | "research" | "ci-gate";

export type AutomationPlanStep = {
  id: string;
  kind: AutomationPlanStepKind;
  label: string;
  detail: string;
  enabled: boolean;
  /**
   * Renderer-local DAG edges.  These are planning metadata only; the native
   * scheduler remains unavailable until a future authoritative receipt exists.
   */
  dependsOn: string[];
};

export type AutomationPlanCondition = {
  field: string;
  operator: AutomationConditionOperator;
  value: string;
};

export type AutomationWorkflowPlan = {
  automationName: string;
  scopeLabel: string;
  actionLabel: string;
  connectorLabel: string;
  preset: AutomationPlanPreset;
  approvalRoute: AutomationApprovalRoute;
  condition: AutomationPlanCondition;
  conditionSet: AutomationConditionSetSnapshot;
  steps: AutomationPlanStep[];
};

export type AutomationPlanGraphSummary = {
  cycleDetected: boolean;
  duplicateStepIdCount: number;
  unknownDependencyCount: number;
  selfDependencyCount: number;
  duplicateDependencyCount: number;
  topologicalOrder: string[];
  criticalPath: string[];
  readyStepIds: string[];
};

type AutomationPlanDraftSnapshot = {
  preset: AutomationPlanPreset;
  steps: AutomationPlanStep[];
  condition: AutomationPlanCondition;
  conditionSet: AutomationConditionSetSnapshot;
  approvalRoute: AutomationApprovalRoute;
};

export type AutomationWorkflowPlanPreviewProps = {
  automationName: string;
  scopeLabel: string;
  actionLabel: string;
  connectorLabel: string;
  approvalRoute: AutomationApprovalRoute;
};

const presetLabels: Record<AutomationPlanPreset, string> = {
  balanced: "Balanced workflow",
  lean: "Lean path",
  "approval-first": "Approval first",
  research: "Research review",
  "ci-gate": "CI artifact gate",
};

const kindLabels: Record<AutomationPlanStepKind, string> = {
  trigger: "Trigger",
  context: "Context",
  condition: "Condition",
  action: "Action",
  approval: "Approval",
  notify: "Notify",
};

const operatorLabels: Record<AutomationConditionOperator, string> = {
  exists: "exists",
  equals: "equals",
  contains: "contains",
  "greater-than": "is greater than",
  "less-than": "is less than",
};

const approvalLabels: Record<AutomationApprovalRoute, string> = {
  "auto-preview": "Auto-preview",
  "review-changes": "Review changes",
  "always-ask": "Always ask",
  "deny-by-default": "Deny by default",
};

const boundary = "Plan only · renderer-local · no scheduler, connector grant, provider request, or native receipt.";

function stepTemplates(props: AutomationWorkflowPlanPreviewProps): AutomationPlanStep[] {
  return [
    { id: "trigger", kind: "trigger", label: "Receive trigger", detail: "Source event is represented as preview metadata.", enabled: true, dependsOn: [] },
    { id: "context", kind: "context", label: "Prepare visible context", detail: `${props.scopeLabel} · no filesystem read or retrieval call.`, enabled: true, dependsOn: ["trigger"] },
    { id: "condition", kind: "condition", label: "Check guard condition", detail: "Condition is rehearsed locally and does not gate a native run.", enabled: true, dependsOn: ["context"] },
    { id: "action", kind: "action", label: props.actionLabel, detail: `${props.connectorLabel} · no endpoint or external side effect.`, enabled: true, dependsOn: ["condition"] },
    { id: "approval", kind: "approval", label: "Apply review route", detail: `${approvalLabels[props.approvalRoute]} · approval state is preview metadata.`, enabled: true, dependsOn: ["action"] },
    { id: "notify", kind: "notify", label: "Route attention", detail: "Notification draft remains local to this renderer session.", enabled: true, dependsOn: ["approval"] },
  ];
}

export function buildAutomationWorkflowPlan(props: AutomationWorkflowPlanPreviewProps, preset: AutomationPlanPreset = "balanced"): AutomationWorkflowPlan {
  const steps = stepTemplates(props);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const orderedIds: Record<AutomationPlanPreset, readonly string[]> = {
    balanced: ["trigger", "context", "condition", "action", "approval", "notify"],
    lean: ["trigger", "context", "action"],
    "approval-first": ["trigger", "context", "condition", "approval", "action", "notify"],
    research: ["trigger", "context", "condition", "action", "notify"],
    "ci-gate": ["trigger", "context", "condition", "action", "approval", "notify"],
  };
  const selectedSteps = (orderedIds[preset] ?? orderedIds.balanced).flatMap((id) => {
    const step = byId.get(id);
    return step ? [step] : [];
  });
  if (preset === "lean") {
    const condition = byId.get("condition");
    if (condition) condition.enabled = false;
  }
  // Presets may omit stages. Reconnect the remaining steps to the nearest
  // retained predecessor so the preview graph never contains a dangling edge.
  const selectedIds = new Set(selectedSteps.map((step) => step.id));
  const normalizedSteps = selectedSteps.map((step) => {
    const dependencies = step.dependsOn.filter((dependency) => selectedIds.has(dependency));
    if (preset === "lean" && step.id === "action") return { ...step, dependsOn: ["context"] };
    if (preset === "research" && step.id === "notify") return { ...step, dependsOn: ["action"] };
    return { ...step, dependsOn: dependencies };
  });
  return {
    automationName: props.automationName,
    scopeLabel: props.scopeLabel,
    actionLabel: props.actionLabel,
    connectorLabel: props.connectorLabel,
    preset,
    approvalRoute: props.approvalRoute,
    condition: preset === "ci-gate"
      ? { field: "artifact.status", operator: "equals", value: "ready" }
      : { field: "context.status", operator: "exists", value: "" },
    conditionSet: createDefaultAutomationConditionSet(preset === "ci-gate"),
    steps: normalizedSteps,
  };
}

/**
 * Inspect the visible workflow as a local directed acyclic graph. This helper
 * deliberately reports facts about the draft only; it does not authorize a
 * scheduler, connector, provider call, or native execution.
 */
export function buildAutomationPlanGraph(steps: readonly AutomationPlanStep[]): AutomationPlanGraphSummary {
  const byId = new Map<string, AutomationPlanStep>();
  let duplicateTaskIdCount = 0;
  for (const step of steps) {
    if (byId.has(step.id)) duplicateTaskIdCount += 1;
    else byId.set(step.id, step);
  }

  let unknownDependencyCount = 0;
  let selfDependencyCount = 0;
  let duplicateDependencyCount = 0;
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const [id] of byId) {
    adjacency.set(id, []);
    indegree.set(id, 0);
  }
  for (const step of byId.values()) {
    const seen = new Set<string>();
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) selfDependencyCount += 1;
      if (!byId.has(dependency)) {
        unknownDependencyCount += 1;
        continue;
      }
      if (seen.has(dependency)) {
        duplicateDependencyCount += 1;
        continue;
      }
      seen.add(dependency);
      adjacency.get(dependency)?.push(step.id);
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
    }
  }

  const queue = steps.filter((step) => byId.get(step.id) === step && (indegree.get(step.id) ?? 0) === 0).map((step) => step.id);
  const topologicalOrder: string[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (!id) continue;
    topologicalOrder.push(id);
    for (const child of adjacency.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }

  const cycleDetected = topologicalOrder.length < byId.size || selfDependencyCount > 0;
  const depthCache = new Map<string, number>();
  const depth = (id: string, visiting: ReadonlySet<string> = new Set()): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    const step = byId.get(id);
    if (!step) return 0;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(id);
    const value = 1 + Math.max(0, ...step.dependsOn.filter((dependency) => byId.has(dependency)).map((dependency) => depth(dependency, nextVisiting)));
    depthCache.set(id, value);
    return value;
  };
  let deepestId: string | undefined;
  let deepest = 0;
  for (const step of byId.values()) {
    const value = depth(step.id);
    if (value > deepest) {
      deepest = value;
      deepestId = step.id;
    }
  }
  const criticalPath: string[] = [];
  const criticalSeen = new Set<string>();
  let currentId = deepestId;
  while (currentId && !criticalSeen.has(currentId)) {
    criticalSeen.add(currentId);
    criticalPath.unshift(currentId);
    const step = byId.get(currentId);
    currentId = step?.dependsOn.filter((dependency) => byId.has(dependency)).sort((left, right) => depth(right) - depth(left))[0];
  }

  const readyStepIds = steps
    .filter((step) => byId.get(step.id) === step && step.enabled)
    .filter((step) => step.dependsOn.every((dependency) => byId.has(dependency) && byId.get(dependency)?.enabled))
    .map((step) => step.id);
  return { cycleDetected, duplicateStepIdCount: duplicateTaskIdCount, unknownDependencyCount, selfDependencyCount, duplicateDependencyCount, topologicalOrder, criticalPath, readyStepIds };
}

function safeText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function clonePlanDraft(snapshot: AutomationPlanDraftSnapshot): AutomationPlanDraftSnapshot {
  return {
    ...snapshot,
    steps: snapshot.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] })),
    condition: { ...snapshot.condition },
    conditionSet: { join: snapshot.conditionSet.join, rules: snapshot.conditionSet.rules.map((rule) => ({ ...rule })) },
  };
}

export function serializeAutomationWorkflowPlan(plan: AutomationWorkflowPlan, format: AutomationPlanExportFormat): string {
  const graph = buildAutomationPlanGraph(plan.steps);
  const normalized = {
    schema: "omnia.automation-workflow-plan.preview.v1",
    scope: "renderer-session",
    executionDisposition: "preview-only",
    boundary,
    plan: {
      ...plan,
      automationName: safeText(plan.automationName, 240),
      condition: { ...plan.condition, field: safeText(plan.condition.field, 160), value: safeText(plan.condition.value, 240) },
      conditionSet: {
        join: plan.conditionSet.join,
        rules: plan.conditionSet.rules.map((rule) => ({ ...rule, field: safeText(rule.field, 160), value: safeText(rule.value, 240) })),
      },
      graphSummary: graph,
      steps: plan.steps.map((step) => ({ ...step, label: safeText(step.label, 180), detail: safeText(step.detail, 500), dependsOn: [...step.dependsOn] })),
    },
  };
  if (format === "json") return JSON.stringify(normalized, null, 2);
  return [
    "# Omnia automation workflow plan preview",
    "",
    `> ${boundary}`,
    "",
    `- Automation: ${normalized.plan.automationName}`,
    `- Scope: ${normalized.plan.scopeLabel}`,
    `- Action: ${normalized.plan.actionLabel}`,
    `- Approval route: ${approvalLabels[normalized.plan.approvalRoute]}`,
    `- Condition: ${normalized.plan.condition.field} ${operatorLabels[normalized.plan.condition.operator]} ${normalized.plan.condition.value || "(empty)"}`,
    `- Additional guard rules: ${normalized.plan.conditionSet.join === "all" ? "ALL" : "ANY"}`,
    ...normalized.plan.conditionSet.rules.map((rule, index) => `  - ${index + 1}. ${rule.field || "(field needed)"} ${operatorLabels[rule.operator]} ${rule.value || (rule.operator === "exists" ? "(no value required)" : "(value needed)")}`),
    `- DAG: ${graph.cycleDetected ? "cycle detected" : "acyclic preview"}; order ${graph.topologicalOrder.map((id) => normalized.plan.steps.findIndex((step) => step.id === id) + 1).join(" → ") || "(none)"}`,
    `- Critical path: ${graph.criticalPath.map((id) => normalized.plan.steps.findIndex((step) => step.id === id) + 1).join(" → ") || "(none)"}`,
    "",
    "## Steps",
    "",
    ...normalized.plan.steps.map((step, index) => `${index + 1}. ${step.enabled ? "[enabled]" : "[disabled]"} ${kindLabels[step.kind]} · ${step.label} — ${step.detail}${step.dependsOn.length ? ` (depends on step ${step.dependsOn.map((id) => normalized.plan.steps.findIndex((candidate) => candidate.id === id) + 1).join(", ")})` : ""}`),
    "",
  ].join("\n");
}

function downloadPlan(payload: string, format: AutomationPlanExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-automation-workflow-plan.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function AutomationWorkflowPlanPreview(props: AutomationWorkflowPlanPreviewProps) {
  const initial = useMemo(() => buildAutomationWorkflowPlan(props), [props]);
  const [preset, setPreset] = useState<AutomationPlanPreset>(initial.preset);
  const [steps, setSteps] = useState<AutomationPlanStep[]>(initial.steps);
  const [selectedStepId, setSelectedStepId] = useState(initial.steps[0]?.id ?? "");
  const [condition, setCondition] = useState<AutomationPlanCondition>(initial.condition);
  const [approvalRoute, setApprovalRoute] = useState<AutomationApprovalRoute>(props.approvalRoute);
  const [format, setFormat] = useState<AutomationPlanExportFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [graphValidationOpen, setGraphValidationOpen] = useState(false);
  const [historyPast, setHistoryPast] = useState<AutomationPlanDraftSnapshot[]>([]);
  const [historyFuture, setHistoryFuture] = useState<AutomationPlanDraftSnapshot[]>([]);
  const [status, setStatus] = useState("Edit the visible plan, then rehearse its gates locally.");
  const [conditionSet, setConditionSet] = useState<AutomationConditionSetSnapshot>(() => initial.conditionSet);

  const selectedStep = steps.find((step) => step.id === selectedStepId) ?? steps[0];
  const enabledCount = steps.filter((step) => step.enabled).length;
  const graph = useMemo(() => buildAutomationPlanGraph(steps), [steps]);
  const snapshot = (): AutomationPlanDraftSnapshot => ({ preset, steps, condition, conditionSet, approvalRoute });
  const remember = () => {
    setHistoryPast((current) => [...current, clonePlanDraft(snapshot())].slice(-24));
    setHistoryFuture([]);
  };
  const restore = (next: AutomationPlanDraftSnapshot) => {
    setPreset(next.preset);
    setSteps(next.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] })));
    setSelectedStepId(next.steps[0]?.id ?? "");
    setCondition({ ...next.condition });
    setConditionSet({ join: next.conditionSet.join, rules: next.conditionSet.rules.map((rule) => ({ ...rule })) });
    setApprovalRoute(next.approvalRoute);
  };
  const conditionReady = condition.field.trim().length > 0 && (condition.operator === "exists" || condition.value.trim().length > 0);
  const exportPayload = useMemo(() => serializeAutomationWorkflowPlan({
    automationName: props.automationName,
    scopeLabel: props.scopeLabel,
    actionLabel: props.actionLabel,
    connectorLabel: props.connectorLabel,
    preset,
    approvalRoute,
    condition,
    conditionSet,
    steps,
  }, format), [approvalRoute, condition, conditionSet, format, preset, props.actionLabel, props.automationName, props.connectorLabel, props.scopeLabel, steps]);

  const updateStep = (patch: Partial<AutomationPlanStep>) => {
    if (!selectedStep) return;
    remember();
    setSteps((current) => current.map((step) => step.id === selectedStep.id ? { ...step, ...patch } : step));
  };

  const updateDependencies = (stepId: string, dependencyId: string, enabled: boolean) => {
    remember();
    setSteps((current) => current.map((step) => step.id === stepId
      ? { ...step, dependsOn: enabled ? [...step.dependsOn, dependencyId] : step.dependsOn.filter((id) => id !== dependencyId) }
      : step));
  };

  const moveStep = (direction: -1 | 1) => {
    if (!selectedStep) return;
    const index = steps.findIndex((step) => step.id === selectedStep.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= steps.length) return;
    remember();
    setSteps((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (!moved) return current;
      next.splice(nextIndex, 0, moved);
      return next;
    });
    setStatus("Step order changed in the renderer plan; no native workflow was rewritten.");
  };

  const addBuilderSteps = (drafts: readonly AutomationBuilderStepDraft[]) => {
    const normalized = drafts
      .map((draft) => ({ ...draft, label: draft.label.trim().slice(0, 180), detail: draft.detail.trim().slice(0, 500) }))
      .filter((draft) => draft.label.length > 0);
    if (!normalized.length) {
      setStatus("The builder did not produce a named step.");
      return;
    }
    remember();
    const usedIds = new Set(steps.map((step) => step.id));
    let previousId = selectedStep?.id ?? steps.at(-1)?.id;
    const created = normalized.map((draft, index) => {
      let suffix = steps.length + index + 1;
      let id = `builder-step-${suffix}`;
      while (usedIds.has(id)) {
        suffix += 1;
        id = `builder-step-${suffix}`;
      }
      usedIds.add(id);
      const next: AutomationPlanStep = { id, kind: draft.kind, label: draft.label, detail: draft.detail || "Renderer-local builder step.", enabled: true, dependsOn: previousId ? [previousId] : [] };
      previousId = id;
      return next;
    });
    setSteps((current) => [...current, ...created]);
    setSelectedStepId(created.at(-1)?.id ?? selectedStepId);
    setStatus(`Staged ${created.length} builder step${created.length === 1 ? "" : "s"} in the renderer plan; no native workflow changed.`);
  };

  const addCheckpoint = () => {
    addBuilderSteps([{ kind: "condition", label: "Custom checkpoint", detail: "New local guard condition." }]);
  };

  const removeSelected = () => {
    if (!selectedStep || selectedStep.kind === "trigger") {
      setStatus("The trigger step stays in the preview plan.");
      return;
    }
    remember();
    const next = steps
      .filter((step) => step.id !== selectedStep.id)
      .map((step) => ({ ...step, dependsOn: step.dependsOn.filter((dependency) => dependency !== selectedStep.id) }));
    setSteps(next);
    setSelectedStepId(next[0]?.id ?? "");
    setStatus("Removed the selected step from this renderer plan.");
  };

  const reset = () => {
    const next = buildAutomationWorkflowPlan(props);
    remember();
    setPreset(next.preset);
    setSteps(next.steps);
    setSelectedStepId(next.steps[0]?.id ?? "");
    setCondition(next.condition);
    setConditionSet(next.conditionSet);
    setApprovalRoute(next.approvalRoute);
    setStatus("Workflow plan reset for this renderer session.");
  };

  const applyPreset = (nextPreset: AutomationPlanPreset) => {
    const next = buildAutomationWorkflowPlan(props, nextPreset);
    remember();
    setPreset(nextPreset);
    setSteps(next.steps);
    setSelectedStepId(next.steps[0]?.id ?? "");
    setCondition(next.condition);
    setConditionSet(next.conditionSet);
    setApprovalRoute(nextPreset === "approval-first" || nextPreset === "ci-gate" ? "always-ask" : nextPreset === "research" ? "review-changes" : props.approvalRoute);
    setStatus(`${presetLabels[nextPreset]} loaded into the renderer plan.`);
  };

  const toggleStep = (stepId: string) => {
    remember();
    setSteps((current) => current.map((item) => item.id === stepId ? { ...item, enabled: !item.enabled } : item));
  };

  const updateCondition = (patch: Partial<AutomationPlanCondition>) => {
    remember();
    setCondition((current) => ({ ...current, ...patch }));
  };

  const updateConditionSet = (next: AutomationConditionSetSnapshot) => {
    remember();
    setConditionSet({ join: next.join, rules: next.rules.map((rule) => ({ ...rule })) });
  };

  const resetConditionSet = () => {
    remember();
    setConditionSet(createDefaultAutomationConditionSet(preset === "ci-gate"));
    setStatus("Additional guard rules reset in this renderer plan.");
  };

  const conditionSetValidation = useMemo(() => validateAutomationConditionSet(conditionSet), [conditionSet]);

  const updateApprovalRoute = (nextRoute: AutomationApprovalRoute) => {
    remember();
    setApprovalRoute(nextRoute);
  };

  const undo = () => {
    const previous = historyPast[historyPast.length - 1];
    if (!previous) {
      setStatus("Nothing to undo in this renderer plan.");
      return;
    }
    setHistoryPast((current) => current.slice(0, -1));
    setHistoryFuture((current) => [clonePlanDraft(snapshot()), ...current].slice(0, 24));
    restore(previous);
    setStatus("Undid the last renderer-local plan edit.");
  };

  const redo = () => {
    const next = historyFuture[0];
    if (!next) {
      setStatus("Nothing to redo in this renderer plan.");
      return;
    }
    setHistoryFuture((current) => current.slice(1));
    setHistoryPast((current) => [...current, clonePlanDraft(snapshot())].slice(-24));
    restore(next);
    setStatus("Redid the last renderer-local plan edit.");
  };

  const rehearse = () => {
    const disabled = steps.length - enabledCount;
    if (graph.cycleDetected || graph.duplicateStepIdCount > 0 || graph.unknownDependencyCount > 0 || graph.selfDependencyCount > 0 || graph.duplicateDependencyCount > 0) {
      setGraphValidationOpen(true);
      setStatus("Plan rehearsal paused: review the DAG validation findings before this local rehearsal; no endpoint called.");
      return;
    }
    const allGuardsReady = conditionReady && conditionSetValidation.ready;
    setStatus(allGuardsReady
      ? `Plan rehearsal ready: ${enabledCount} enabled steps${disabled ? `, ${disabled} disabled` : ""}; ${graph.readyStepIds.length} ready frontier step${graph.readyStepIds.length === 1 ? "" : "s"}; no endpoint called.`
      : !conditionReady
        ? "Plan rehearsal needs a field and value before the condition can be considered ready."
        : conditionSetValidation.errors[0] ?? "Add at least one additional guard rule before rehearsal.");
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; the workflow plan remains renderer-local.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`${format.toUpperCase()} workflow plan copied; no durable export was created.`);
    } catch {
      setStatus("Clipboard access was denied; the workflow plan remains renderer-local.");
    }
  };

  return (
    <section className="automation-plan" aria-labelledby="automation-plan-heading">
      <header className="automation-plan__header">
        <div>
          <span className="eyebrow"><GitBranch size={13} /> Workflow plan · gates</span>
          <h4 id="automation-plan-heading">Plan steps &amp; guardrails</h4>
          <p>Shape the visible execution graph before a future native runtime is wired.</p>
        </div>
        <span className="automation-plan__badge"><Eye size={13} /> Preview only</span>
      </header>
      <p className="automation-plan__boundary"><ShieldCheck size={14} /> {boundary}</p>

      <div className="automation-plan__summary" aria-label="Workflow plan summary">
        <span><SlidersHorizontal size={13} /> {enabledCount}/{steps.length} enabled</span>
        <span><Sparkles size={13} /> {conditionReady ? "Condition ready" : "Condition needs input"}</span>
        <span><WandSparkles size={13} /> {approvalLabels[approvalRoute]}</span>
        <span><GitBranch size={13} /> {graph.cycleDetected ? "DAG needs review" : `${graph.topologicalOrder.length} ordered · ${graph.readyStepIds.length} ready`}</span>
      </div>

      <div className="automation-plan__preset"><label><span>Plan preset</span><select aria-label="Workflow plan preset" value={preset} onChange={(event) => applyPreset(event.target.value as AutomationPlanPreset)}>{(Object.keys(presetLabels) as AutomationPlanPreset[]).map((value) => <option key={value} value={value}>{presetLabels[value]}</option>)}</select></label><small>Preset changes only reorder or stage visible preview steps; they do not activate a scheduler.</small></div>

      <div className="automation-plan__body">
        <ol className="automation-plan__steps" aria-label="Workflow plan steps">
          {steps.map((step, index) => (
            <li key={step.id} className={selectedStep?.id === step.id ? "is-selected" : undefined}>
              <button type="button" className="automation-plan__step" onClick={() => setSelectedStepId(step.id)} aria-pressed={selectedStep?.id === step.id}>
                <span className="automation-plan__step-index"><GripVertical size={12} />{index + 1}</span>
                <span><strong>{step.label}</strong><small>{kindLabels[step.kind]} · {step.enabled ? "enabled" : "disabled"}</small></span>
              </button>
              <button type="button" className="automation-plan__step-toggle" aria-label={`${step.enabled ? "Disable" : "Enable"} ${step.label}`} aria-pressed={step.enabled} onClick={() => toggleStep(step.id)}>{step.enabled ? <Check size={13} /> : "Off"}</button>
            </li>
          ))}
        </ol>

        <div className="automation-plan__editor" aria-label="Selected workflow step editor">
          {selectedStep ? (
            <>
              <div className="automation-plan__editor-heading"><div><span className="eyebrow">Selected step</span><h5>{selectedStep.label}</h5></div><span className="automation-plan__kind">{kindLabels[selectedStep.kind]}</span></div>
              <label><span>Label</span><input aria-label="Workflow step label" value={selectedStep.label} onChange={(event) => updateStep({ label: event.target.value })} /></label>
              <label><span>Step detail</span><textarea aria-label="Workflow step detail" value={selectedStep.detail} onChange={(event) => updateStep({ detail: event.target.value })} /></label>
              <fieldset className="automation-plan__dependencies"><legend>Depends on</legend><small>Draft graph edges only; no agent ordering or execution is created.</small><div>{steps.filter((step) => step.id !== selectedStep.id).map((step) => <label key={step.id}><input type="checkbox" checked={selectedStep.dependsOn.includes(step.id)} onChange={(event) => updateDependencies(selectedStep.id, step.id, event.target.checked)} /><span>{step.label}</span></label>)}</div></fieldset>
              <div className="automation-plan__editor-actions"><button type="button" className="button button--ghost" onClick={() => moveStep(-1)} disabled={steps[0]?.id === selectedStep.id} aria-label="Move step up"><ArrowUp size={13} /> Up</button><button type="button" className="button button--ghost" onClick={() => moveStep(1)} disabled={steps[steps.length - 1]?.id === selectedStep.id} aria-label="Move step down"><ArrowDown size={13} /> Down</button><button type="button" className="button button--ghost" onClick={removeSelected} disabled={selectedStep.kind === "trigger"}><Trash2 size={13} /> Remove</button></div>
            </>
          ) : <p>No workflow step selected.</p>}
        </div>
      </div>

      <AutomationWorkflowBuilderPreview automationName={props.automationName} steps={steps} onAddSteps={addBuilderSteps} onStatus={setStatus} />

      <div className="automation-plan__controls">
        <div className="automation-plan__condition"><div className="automation-plan__subheading"><div><span className="eyebrow">Guard condition</span><strong>Rehearse a gate</strong></div><span className={conditionReady ? "automation-plan__state is-ready" : "automation-plan__state"}>{conditionReady ? "Ready" : "Needs input"}</span></div><div className="automation-plan__condition-grid"><label><span>Field</span><input aria-label="Workflow condition field" value={condition.field} onChange={(event) => updateCondition({ field: event.target.value })} placeholder="context.status" /></label><label><span>Operator</span><select aria-label="Workflow condition operator" value={condition.operator} onChange={(event) => updateCondition({ operator: event.target.value as AutomationConditionOperator })}>{(Object.keys(operatorLabels) as AutomationConditionOperator[]).map((operator) => <option key={operator} value={operator}>{operatorLabels[operator]}</option>)}</select></label><label><span>Value</span><input aria-label="Workflow condition value" value={condition.value} onChange={(event) => updateCondition({ value: event.target.value })} placeholder={condition.operator === "exists" ? "Optional for exists" : "e.g. ready"} /></label></div></div>
        <div className="automation-plan__approval"><label><span>Approval route</span><select aria-label="Workflow approval route" value={approvalRoute} onChange={(event) => updateApprovalRoute(event.target.value as AutomationApprovalRoute)}>{(Object.keys(approvalLabels) as AutomationApprovalRoute[]).map((route) => <option key={route} value={route}>{approvalLabels[route]}</option>)}</select></label><small>Preview policy only; no approval prompt or grant is issued.</small></div>
      </div>

      <AutomationConditionSetPreview snapshot={conditionSet} onChange={updateConditionSet} onReset={resetConditionSet} />

      <section className="automation-plan__graph" aria-label="Workflow DAG validation">
        <div className="automation-plan__subheading"><div><span className="eyebrow">Dependency graph</span><strong>{graph.cycleDetected || graph.duplicateStepIdCount || graph.unknownDependencyCount || graph.selfDependencyCount || graph.duplicateDependencyCount ? "Needs review" : "Acyclic preview graph"}</strong></div><button type="button" className="button button--ghost" onClick={() => setGraphValidationOpen((open) => !open)} aria-expanded={graphValidationOpen}>{graphValidationOpen ? "Hide checks" : "Validate DAG"}</button></div>
        <div className="automation-plan__graph-flow" aria-label="Workflow topological order">{graph.topologicalOrder.map((id, index) => { const step = steps.find((item) => item.id === id); return <span key={id}>{index ? <ArrowDown size={12} aria-hidden="true" /> : null}<strong>{step?.label ?? id}</strong></span>; })}</div>
        <p>Critical path: {graph.criticalPath.map((id) => steps.find((step) => step.id === id)?.label ?? id).join(" → ") || "None"}. Ready now: {graph.readyStepIds.map((id) => steps.find((step) => step.id === id)?.label ?? id).join(", ") || "none"}.</p>
        {graphValidationOpen ? <ul className="automation-plan__graph-checks"><li>{graph.cycleDetected ? "Cycle or self-edge detected." : "No cycle detected in the visible draft graph."}</li><li>{graph.unknownDependencyCount} unknown edge(s); {graph.duplicateStepIdCount} duplicate step ID(s).</li><li>{graph.selfDependencyCount} self-edge(s); {graph.duplicateDependencyCount} duplicate edge(s).</li></ul> : null}
      </section>

      <div className="automation-plan__actions"><button type="button" className="button button--secondary" onClick={addCheckpoint}><Plus size={13} /> Add checkpoint</button><button type="button" className="button button--primary" onClick={rehearse}><WandSparkles size={13} /> Rehearse plan</button><button type="button" className="button button--ghost" onClick={undo} disabled={historyPast.length === 0} aria-label="Undo plan edit">Undo</button><button type="button" className="button button--ghost" onClick={redo} disabled={historyFuture.length === 0} aria-label="Redo plan edit">Redo</button><button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset</button><button type="button" className="button button--ghost" onClick={() => setExportOpen((open) => !open)} aria-expanded={exportOpen}><Clipboard size={13} /> {exportOpen ? "Hide export" : "Preview export"}</button></div>

      {exportOpen ? <section className="automation-plan__export" aria-label="Workflow plan export"><div className="automation-plan__export-toolbar"><label><span>Format</span><select aria-label="Workflow plan export format" value={format} onChange={(event) => setFormat(event.target.value as AutomationPlanExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--ghost" onClick={() => setStatus(downloadPlan(exportPayload, format) ? "Browser download started; no native plan receipt was created." : "Browser download unavailable; export remains local.")}><Download size={13} /> Download</button></div><pre><code>{exportPayload}</code></pre></section> : null}
      <p className="automation-plan__status" aria-live="polite">{status}</p>
    </section>
  );
}

export default AutomationWorkflowPlanPreview;
