import {
  Braces,
  ArrowLeftRight,
  Check,
  Clipboard,
  Download,
  Filter,
  Layers3,
  ListChecks,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import { compileChatContext, estimateContextTokens, type CompiledChatContext } from "./context-harness";
import type { ProjectContextHealth } from "./project-context-availability-contract";
import type { ConversationView } from "./types";

const PREVIEW_NOW = "2026-09-19T00:00:00.000Z";

export interface ContextCompilerFolderCandidate {
  readonly id: string;
  readonly displayName: string;
  readonly canonicalPath: string;
  readonly state: string;
  readonly scope: string;
}

export interface ContextCompilerMemoryCandidate {
  readonly id: string;
  readonly label: string;
  readonly content: string;
  readonly confidence: number | null;
}

export interface ContextCompilerSkillCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly tokenFootprint: number;
}

export type ContextCompilerView = "decisions" | "messages" | "order" | "compare";
export type ContextCompilerDecisionFilter = "all" | "selected" | "omitted";

export interface ContextCompilerReferenceResult {
  readonly compiled: CompiledChatContext | null;
  readonly error: string | null;
  readonly status: "reference-only" | "withheld" | "failed";
  readonly withholdingReason: string | null;
  readonly candidateCount: number;
  readonly historyCount: number;
  readonly folderCount: number;
  readonly memoryCount: number;
  readonly skillCount: number;
}

export interface ContextCompilerBaselineDecision {
  readonly id: string;
  readonly kind: string;
  readonly sourceRef: string;
  readonly tokenEstimate: number;
  readonly selected: boolean;
  readonly reason: string;
}

/** A renderer-session checkpoint; it is not a frozen or durable context revision. */
export interface ContextCompilerBaseline {
  readonly schema: "omnia.context-compiler-baseline.preview.v1";
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly consumedInputTokens: number;
  readonly availableInputTokens: number;
  readonly decisions: readonly ContextCompilerBaselineDecision[];
}

export interface ContextCompilerComparison {
  readonly addedCandidates: readonly ContextCompilerBaselineDecision[];
  readonly removedCandidates: readonly ContextCompilerBaselineDecision[];
  readonly newlySelected: readonly ContextCompilerBaselineDecision[];
  readonly newlyOmitted: readonly ContextCompilerBaselineDecision[];
  readonly changedOmissionReasons: readonly {
    readonly id: string;
    readonly from: string;
    readonly to: string;
  }[];
  readonly changedTokenEstimates: readonly {
    readonly id: string;
    readonly from: number;
    readonly to: number;
  }[];
  readonly consumedTokenDelta: number;
  readonly availableTokenDelta: number;
}

function contextCompilerWithholdingReason(
  contextHealth: ProjectContextHealth | undefined,
): string | null {
  if (contextHealth === "missing-access") {
    return "Project access is unavailable; aggregate context admission is withheld until a native access receipt exists.";
  }
  if (contextHealth === "over-budget") {
    return "The project is over the renderer preview budget; aggregate context admission is withheld until native selection or compaction evidence exists.";
  }
  return null;
}

export function captureContextCompilerBaseline(
  compiled: CompiledChatContext,
): ContextCompilerBaseline {
  return Object.freeze({
    schema: "omnia.context-compiler-baseline.preview.v1",
    candidateCount: compiled.snapshot.candidateItemIds.length,
    selectedCount: compiled.snapshot.selectedItemIds.length,
    consumedInputTokens: compiled.snapshot.consumedInputTokens,
    availableInputTokens: compiled.snapshot.budget.availableInputTokens,
    decisions: Object.freeze(compiled.previewItems.map((item) => Object.freeze({
      id: item.id,
      kind: item.kind,
      sourceRef: item.sourceRef,
      tokenEstimate: item.tokenEstimate,
      selected: item.selected,
      reason: item.reason,
    }))),
  });
}

export function compareContextCompilerBaseline(
  baseline: ContextCompilerBaseline,
  compiled: CompiledChatContext,
): ContextCompilerComparison {
  const current = compiled.previewItems.map((item): ContextCompilerBaselineDecision => ({
    id: item.id,
    kind: item.kind,
    sourceRef: item.sourceRef,
    tokenEstimate: item.tokenEstimate,
    selected: item.selected,
    reason: item.reason,
  }));
  const beforeById = new Map(baseline.decisions.map((item) => [item.id, item]));
  const currentById = new Map(current.map((item) => [item.id, item]));
  const addedCandidates = current.filter((item) => !beforeById.has(item.id));
  const removedCandidates = baseline.decisions.filter((item) => !currentById.has(item.id));
  const newlySelected: ContextCompilerBaselineDecision[] = [];
  const newlyOmitted: ContextCompilerBaselineDecision[] = [];
  const changedOmissionReasons: Array<{ id: string; from: string; to: string }> = [];
  const changedTokenEstimates: Array<{ id: string; from: number; to: number }> = [];

  for (const item of current) {
    const previous = beforeById.get(item.id);
    if (!previous) continue;
    if (!previous.selected && item.selected) newlySelected.push(item);
    if (previous.selected && !item.selected) newlyOmitted.push(item);
    if (!previous.selected && !item.selected && previous.reason !== item.reason) {
      changedOmissionReasons.push({ id: item.id, from: previous.reason, to: item.reason });
    }
    if (previous.tokenEstimate !== item.tokenEstimate) {
      changedTokenEstimates.push({ id: item.id, from: previous.tokenEstimate, to: item.tokenEstimate });
    }
  }

  return Object.freeze({
    addedCandidates: Object.freeze(addedCandidates),
    removedCandidates: Object.freeze(removedCandidates),
    newlySelected: Object.freeze(newlySelected),
    newlyOmitted: Object.freeze(newlyOmitted),
    changedOmissionReasons: Object.freeze(changedOmissionReasons.map((change) => Object.freeze(change))),
    changedTokenEstimates: Object.freeze(changedTokenEstimates.map((change) => Object.freeze(change))),
    consumedTokenDelta: compiled.snapshot.consumedInputTokens - baseline.consumedInputTokens,
    availableTokenDelta: compiled.snapshot.budget.availableInputTokens - baseline.availableInputTokens,
  });
}

function previewHash(seed: number): string {
  const digit = (seed % 16).toString(16);
  return digit.repeat(64);
}

function safeIso(value: string | undefined): string {
  if (value !== undefined && !Number.isNaN(Date.parse(value))) return value;
  return PREVIEW_NOW;
}

function referenceText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "project";
}

function buildConversationTurns(
  projectId: string,
  projectName: string,
  conversations: readonly ConversationView[],
): { turns: Array<{ id: string; role: "user" | "assistant"; text: string; contentHash: string; createdAt: string; current?: boolean }>; historyCount: number } {
  const projectConversations = conversations
    .filter((conversation) => conversation.projectId === projectId || conversation.projectName === projectName)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const conversation = projectConversations[0];
  const turns: Array<{ id: string; role: "user" | "assistant"; text: string; contentHash: string; createdAt: string; current?: boolean }> = [];
  let hasUser = false;
  for (const message of conversation?.messages ?? []) {
    const text = message.content;
    if (!text.trim()) continue;
    if (message.role === "assistant" && !hasUser) continue;
    hasUser = hasUser || message.role === "user";
    turns.push({
      id: `turn:${conversation?.id ?? slug(projectName)}:${message.id}`,
      role: message.role,
      text,
      contentHash: previewHash(turns.length + 4),
      createdAt: safeIso(message.createdAt),
    });
  }
  const currentDraft = conversation?.draft && conversation.draft.trim().length > 0
    ? conversation.draft
    : `Review the current context for ${projectName} and identify the next useful step.`;
  turns.push({
    id: `turn:${conversation?.id ?? slug(projectName)}:current-request`,
    role: "user",
    text: currentDraft,
    contentHash: previewHash(turns.length + 4),
    createdAt: PREVIEW_NOW,
    current: true,
  });
  return { turns, historyCount: turns.length - 1 };
}

export function buildContextCompilerReference({
  projectId,
  projectName,
  instructions,
  folders,
  memories,
  skills,
  conversations,
  includeMemories,
  includeSkills,
  budgetTokens,
  contextHealth,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly instructions: string;
  readonly folders: readonly ContextCompilerFolderCandidate[];
  readonly memories: readonly ContextCompilerMemoryCandidate[];
  readonly skills: readonly ContextCompilerSkillCandidate[];
  readonly conversations: readonly ConversationView[];
  readonly includeMemories: boolean;
  readonly includeSkills: boolean;
  readonly budgetTokens: number;
  readonly contextHealth?: ProjectContextHealth | undefined;
}): ContextCompilerReferenceResult {
  const { turns, historyCount } = buildConversationTurns(projectId, projectName, conversations);
  const projectInstruction = instructions;
  const instructionInputs = [
    {
      id: `product:${projectId}`,
      kind: "product_instruction" as const,
      text: "Treat this context as a renderer-only rehearsal. Keep evidence and instructions separate.",
      contentHash: previewHash(1),
      sourceRef: "omnia:context-compiler-preview",
      authority: "platform_invariant" as const,
      scope: "global" as const,
      priority: 1000,
      required: true,
      pinned: true,
    },
    ...(projectInstruction.trim()
      ? [{
          id: `project-instruction:${projectId}`,
          kind: "project_instruction" as const,
          text: projectInstruction,
          contentHash: previewHash(2),
          sourceRef: `project:${projectId}:instructions`,
          authority: "user_instruction" as const,
          scope: "project" as const,
          priority: 800,
          required: true,
          pinned: true,
        }]
      : []),
    ...(includeSkills
      ? skills.map((skill, index) => ({
          id: `skill:${skill.id}`,
          kind: "skill_instruction" as const,
          text: `Skill ${skill.name} v${skill.version}\n${referenceText(skill.description, "No description supplied.")}`,
          contentHash: previewHash(index + 3),
          sourceRef: `skill:${skill.id}`,
          authority: "workflow_guidance" as const,
          scope: "project" as const,
          priority: 120,
          required: false,
          pinned: false,
        }))
      : []),
  ];

  const retrievedChunks = [
    ...folders.map((folder, index) => ({
      id: `folder:${folder.id}`,
      sourceKind: "workspace" as const,
      sourceId: folder.id,
      sourceVersionId: `metadata:${folder.id}:preview`,
      sourceLabel: folder.displayName,
      text: `Workspace folder metadata only: ${folder.displayName}; scope=${folder.scope}; state=${folder.state}. No file content was read and the local path is omitted from this renderer export.`,
      contentHash: previewHash(index + 8),
      score: folder.state === "ready" ? 0.75 : 0.45,
      priority: 30,
      tokenEstimate: 48,
    })),
    ...(includeMemories
      ? memories.map((memory, index) => ({
          id: `memory:${memory.id}`,
          sourceKind: "connected-source" as const,
          sourceId: memory.id,
          sourceVersionId: `memory:${memory.id}:preview`,
          sourceLabel: memory.label,
          text: `Memory preview candidate (untrusted reference): ${referenceText(memory.content, "No memory content supplied.")}`,
          contentHash: previewHash(index + 20),
          score: Math.max(0, Math.min(1, memory.confidence ?? 0.5)),
          priority: 20,
          tokenEstimate: Math.max(20, estimateContextTokens(memory.content)),
        }))
      : []),
  ];

  const candidateCount = instructionInputs.length + turns.length + retrievedChunks.length;
  const withholdingReason = contextCompilerWithholdingReason(contextHealth);
  if (withholdingReason !== null) {
    return {
      compiled: null,
      error: null,
      status: "withheld",
      withholdingReason,
      candidateCount,
      historyCount,
      folderCount: folders.length,
      memoryCount: includeMemories ? memories.length : 0,
      skillCount: includeSkills ? skills.length : 0,
    };
  }

  try {
    const compiled = compileChatContext({
      snapshotId: `context-preview:${projectId}`,
      instructions: instructionInputs,
      turns,
      retrievedChunks,
      modelContextLimit: budgetTokens + 240,
      reservedOutputTokens: 120,
      providerOverheadTokens: 60,
      toolSchemaTokens: 0,
      safetyMarginTokens: 60,
      now: PREVIEW_NOW,
      tokenizer: "omnia-conservative-reference-v2",
      estimatorUncertain: true,
      maximumRetrievedChunks: Math.max(12, retrievedChunks.length),
      maximumChunksPerSource: 4,
      metadata: {
        projectId,
        projectName,
        memoryCandidatesIncluded: includeMemories,
        skillCandidatesIncluded: includeSkills,
      },
    });
    return {
      compiled,
      error: null,
      status: "reference-only",
      withholdingReason: null,
      candidateCount: compiled.previewItems.length,
      historyCount,
      folderCount: folders.length,
      memoryCount: includeMemories ? memories.length : 0,
      skillCount: includeSkills ? skills.length : 0,
    };
  } catch (error) {
    return {
      compiled: null,
      error: error instanceof Error ? error.message : "The reference compiler rejected this preview input.",
      status: "failed",
      withholdingReason: null,
      candidateCount,
      historyCount,
      folderCount: folders.length,
      memoryCount: includeMemories ? memories.length : 0,
      skillCount: includeSkills ? skills.length : 0,
    };
  }
}

function decisionLabel(reason: string): string {
  return reason.replace(/^selected\.|^omitted\.|^replaced\.|^failed\./, "").replaceAll("_", " ");
}

function exportPayload(projectName: string, result: ContextCompilerReferenceResult, format: "json" | "markdown"): string {
  if (!result.compiled) {
    const reason = result.withholdingReason ?? result.error ?? "unknown";
    return format === "json"
      ? JSON.stringify({
          schema: "omnia.context-compiler.preview.v1",
          projectName,
          status: result.status,
          ...(result.status === "withheld" ? { withholdingReason: reason, aggregate: "withheld" } : { error: reason }),
          scope: "renderer-session",
        }, null, 2)
      : `# ${projectName} context compiler preview\n\n- Status: ${result.status}\n- ${result.status === "withheld" ? "Withholding reason" : "Error"}: ${reason}\n- Scope: renderer-session\n`;
  }
  const { snapshot, previewItems, providerMessages, sourceProjections } = result.compiled;
  const data = {
    schema: "omnia.context-compiler.preview.v1",
    scope: "renderer-session",
    projectName,
    status: "reference-only",
    snapshot: {
      id: snapshot.id,
      frozenAt: snapshot.frozenAt,
      tokenizer: snapshot.tokenizer,
      estimatorUncertain: snapshot.estimatorUncertain,
      consumedInputTokens: snapshot.consumedInputTokens,
      availableInputTokens: snapshot.budget.availableInputTokens,
      candidateCount: snapshot.candidateItemIds.length,
      selectedCount: snapshot.selectedItemIds.length,
      omittedCount: previewItems.filter((item) => !item.selected).length,
    },
    decisions: previewItems,
    sourceProjections,
    providerMessages,
    boundary: "Renderer-local reference compilation only; no native context freeze, provider request, file read, retrieval service, durable write, or execution was performed.",
  };
  if (format === "json") return JSON.stringify(data, null, 2);
  return [
    `# ${projectName} context compiler preview`,
    "",
    "> Renderer-local reference compilation only; no native context freeze or provider request was performed.",
    "",
    `- Snapshot: ${snapshot.id}`,
    `- Selected: ${snapshot.selectedItemIds.length} / ${snapshot.candidateItemIds.length}`,
    `- Consumed: ${snapshot.consumedInputTokens.toLocaleString()} / ${snapshot.budget.availableInputTokens.toLocaleString()} input tokens`,
    `- Tokenizer: ${snapshot.tokenizer} (uncertain estimate: ${snapshot.estimatorUncertain ? "yes" : "no"})`,
    "",
    "## Decisions",
    ...previewItems.map((item) => `- ${item.selected ? "Selected" : "Omitted"} · ${item.kind} · ${item.sourceRef} · ${decisionLabel(item.reason)} · ${item.tokenEstimate} tokens`),
    "",
    "## Provider message rehearsal",
    ...providerMessages.map((message, index) => `- ${index + 1}. ${message.role} · ${message.contextItemIds.join(", ")}`),
    "",
    "Native compiler receipt, provider serialization, and durable context revision remain planned.",
  ].join("\n");
}

export function ContextCompilerPreview({
  projectId,
  projectName,
  instructions,
  folders,
  memories,
  skills,
  conversations,
  includeMemories,
  includeSkills,
  budgetTokens,
  contextHealth,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly instructions: string;
  readonly folders: readonly ContextCompilerFolderCandidate[];
  readonly memories: readonly ContextCompilerMemoryCandidate[];
  readonly skills: readonly ContextCompilerSkillCandidate[];
  readonly conversations: readonly ConversationView[];
  readonly includeMemories: boolean;
  readonly includeSkills: boolean;
  readonly budgetTokens: number;
  readonly contextHealth?: ProjectContextHealth;
}) {
  const [view, setView] = useState<ContextCompilerView>("decisions");
  const [filter, setFilter] = useState<ContextCompilerDecisionFilter>("all");
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [baseline, setBaseline] = useState<ContextCompilerBaseline | null>(null);
  const [status, setStatus] = useState("Renderer-local reference; aggregate output is withheld when context is blocked.");
  const result = useMemo(() => buildContextCompilerReference({ projectId, projectName, instructions, folders, memories, skills, conversations, includeMemories, includeSkills, budgetTokens, contextHealth }), [budgetTokens, contextHealth, conversations, folders, includeMemories, includeSkills, instructions, memories, projectId, projectName, skills]);
  const compiled = result.compiled;
  const aggregateWithheld = result.status === "withheld";
  const filteredItems = compiled?.previewItems.filter((item) => filter === "all" || (filter === "selected" ? item.selected : !item.selected)) ?? [];
  const payload = useMemo(() => exportPayload(projectName, result, format), [format, projectName, result]);
  const compilerViews = ["decisions", "messages", "order", "compare"] as const;
  const comparison = baseline && compiled ? compareContextCompilerBaseline(baseline, compiled) : null;

  const moveViewTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? compilerViews.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + compilerViews.length) % compilerViews.length;
    const nextView = compilerViews[nextIndex];
    if (!nextView) return;
    setView(nextView);
    document.getElementById(`context-compiler-tab-${nextView}`)?.focus();
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; no compiler preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(result.status === "withheld"
        ? `Copied the renderer-local ${format.toUpperCase()} withheld-state report.`
        : `Copied the renderer-local ${format.toUpperCase()} compiler preview.`);
    } catch {
      setStatus("Clipboard access was denied; no compiler preview was copied.");
    }
  };

  const download = () => {
    if (typeof URL.createObjectURL !== "function") {
      setStatus("File download is unavailable; no compiler preview was exported.");
      return;
    }
    const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-context-compiler-preview.${format === "json" ? "json" : "md"}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setStatus(result.status === "withheld"
      ? "Downloaded the renderer-local withheld-state report."
      : "Downloaded a renderer-local compiler preview.");
  };

  return (
    <section className="context-compiler-preview" aria-labelledby="context-compiler-preview-title">
      <header className="context-compiler-preview__header">
        <div>
          <span className="eyebrow">Inspectable compiler rehearsal</span>
          <h3 id="context-compiler-preview-title"><WandSparkles size={15} /> Context compiler preview</h3>
          <p>See every reference decision and the provider-message shape before native context compilation is connected.</p>
        </div>
        <span className="context-compiler-preview__badge"><Sparkles size={12} /> {aggregateWithheld ? "Aggregate withheld" : "Reference only"}</span>
      </header>

      <div className="context-compiler-preview__summary" role="status" aria-live="polite">
        <div><strong>{projectName}</strong><small>{aggregateWithheld ? `${result.candidateCount} candidates · aggregate withheld` : `${result.candidateCount} candidates · ${compiled?.snapshot.selectedItemIds.length ?? 0} selected · ${compiled ? result.candidateCount - compiled.snapshot.selectedItemIds.length : 0} omitted`}</small></div>
        <div className="context-compiler-preview__metrics"><span><strong>{aggregateWithheld ? "Withheld" : compiled?.snapshot.consumedInputTokens.toLocaleString() ?? "—"}</strong><small>consumed</small></span><span><strong>{aggregateWithheld ? "Withheld" : compiled?.snapshot.budget.availableInputTokens.toLocaleString() ?? "—"}</strong><small>available</small></span><span><strong>{result.historyCount}</strong><small>history turns</small></span></div>
      </div>

      {compiled ? <>
        <div className="context-compiler-preview__meter" aria-label="Compiled context budget"><span style={{ width: `${Math.min(100, Math.round((compiled.snapshot.consumedInputTokens / Math.max(1, compiled.snapshot.budget.availableInputTokens)) * 100))}%` }} /><strong>{Math.round((compiled.snapshot.consumedInputTokens / Math.max(1, compiled.snapshot.budget.availableInputTokens)) * 100)}% input budget</strong></div>
        <div className="context-compiler-preview__toolbar" role="toolbar" aria-label="Context compiler preview controls">
          <div className="context-compiler-preview__tabs" role="tablist" aria-label="Compiler preview views">
            {compilerViews.map((item, index) => <button key={item} id={`context-compiler-tab-${item}`} type="button" role="tab" title={`Show ${item === "decisions" ? "context admission decisions" : item === "messages" ? "provider message rehearsal" : item === "order" ? "context item ordering" : "baseline comparison"}`} aria-selected={view === item} aria-controls={`context-compiler-panel-${item}`} tabIndex={view === item ? 0 : -1} className={view === item ? "active" : ""} onClick={() => setView(item)} onKeyDown={(event) => moveViewTab(event, index)}>{item === "decisions" ? <><ListChecks size={13} /> Decisions</> : item === "messages" ? <><Braces size={13} /> Provider messages</> : item === "order" ? <><Layers3 size={13} /> Order</> : <><ArrowLeftRight size={13} /> Compare</>}</button>)}
          </div>
          <label className="context-compiler-preview__filter"><Filter size={13} /><span>Filter</span><select aria-label="Compiler decision filter" value={filter} onChange={(event) => setFilter(event.target.value as ContextCompilerDecisionFilter)}><option value="all">All decisions</option><option value="selected">Selected only</option><option value="omitted">Omitted only</option></select></label>
          <button type="button" className="button button--ghost" title="Recompute this renderer-local compiler snapshot" onClick={() => setStatus("Recompiled the current renderer snapshot; no native compiler was called.")}><RefreshCw size={13} /> Recompile preview</button>
          <button type="button" className="button button--ghost" title={baseline ? "Replace the current renderer-session comparison baseline" : "Capture a renderer-session comparison baseline"} onClick={() => { setBaseline(captureContextCompilerBaseline(compiled)); setView("compare"); setStatus("Captured an in-memory comparison baseline for this renderer session only."); }}><Layers3 size={13} /> {baseline ? "Replace baseline" : "Capture baseline"}</button>
        </div>

        {view === "decisions" ? <div id="context-compiler-panel-decisions" className="context-compiler-preview__decisions" role="tabpanel" aria-labelledby="context-compiler-tab-decisions" tabIndex={0} aria-label="Context decision ledger">{filteredItems.map((item) => <article key={item.id} className={`context-compiler-preview__decision context-compiler-preview__decision--${item.selected ? "selected" : "omitted"}`}><span className="context-compiler-preview__decision-icon">{item.selected ? <Check size={13} /> : <ShieldCheck size={13} />}</span><span><strong>{item.kind}</strong><small>{item.sourceRef} · {item.tokenEstimate} tokens · {item.selected ? `selected #${(item.selectionOrder ?? 0) + 1}` : "omitted"}</small></span><em>{decisionLabel(item.reason)}</em></article>)}</div> : null}
        {view === "messages" ? <div id="context-compiler-panel-messages" className="context-compiler-preview__messages" role="tabpanel" aria-labelledby="context-compiler-tab-messages" tabIndex={0} aria-label="Provider message rehearsal">{compiled.providerMessages.map((message, index) => <article key={`${message.role}-${index}`}><header><strong>{index + 1}. {message.role}</strong><span>{message.contextItemIds.length} context items</span></header><p>{message.content}</p><small>{message.contextItemIds.join(" · ")}</small></article>)}</div> : null}
        {view === "order" ? <div id="context-compiler-panel-order" className="context-compiler-preview__order" role="tabpanel" aria-labelledby="context-compiler-tab-order" tabIndex={0} aria-label="Context order projection"><div><strong>Semantic order</strong>{compiled.snapshot.semanticItemIds.map((id, index) => <span key={id}><b>{index + 1}</b>{id}</span>)}</div><div><strong>Adapter order</strong>{compiled.snapshot.adapterItemIds.map((id, index) => <span key={id}><b>{index + 1}</b>{id}</span>)}</div></div> : null}
        {view === "compare" ? <div id="context-compiler-panel-compare" className="context-compiler-preview__compare" role="tabpanel" aria-labelledby="context-compiler-tab-compare" tabIndex={0} aria-label="Context compiler baseline comparison">
          {!baseline || !comparison ? <div className="context-compiler-preview__compare-empty"><ArrowLeftRight size={15} /><span><strong>No comparison baseline</strong><small>Capture the current decision ledger, then change source selections or budget to inspect the renderer-session delta.</small></span></div> : <>
            <div className="context-compiler-preview__compare-summary"><span><small>Baseline</small><strong>{baseline.selectedCount} / {baseline.candidateCount} selected</strong><em>{baseline.consumedInputTokens.toLocaleString()} / {baseline.availableInputTokens.toLocaleString()} tokens</em></span><span><small>Current</small><strong>{compiled.snapshot.selectedItemIds.length} / {compiled.snapshot.candidateItemIds.length} selected</strong><em>{compiled.snapshot.consumedInputTokens.toLocaleString()} / {compiled.snapshot.budget.availableInputTokens.toLocaleString()} tokens</em></span><span className={comparison.consumedTokenDelta === 0 ? "is-neutral" : comparison.consumedTokenDelta > 0 ? "is-increase" : "is-decrease"}><small>Consumed delta</small><strong>{comparison.consumedTokenDelta > 0 ? "+" : ""}{comparison.consumedTokenDelta.toLocaleString()} tokens</strong><em>Available budget {comparison.availableTokenDelta > 0 ? "+" : ""}{comparison.availableTokenDelta.toLocaleString()}</em></span></div>
            <div className="context-compiler-preview__compare-groups">
              <section><h4>Selection changes <small>{comparison.newlySelected.length + comparison.newlyOmitted.length}</small></h4>{comparison.newlySelected.length || comparison.newlyOmitted.length ? <ul>{comparison.newlySelected.map((item) => <li key={`selected-${item.id}`}><strong>Selected</strong><span>{item.kind} · {item.sourceRef}</span></li>)}{comparison.newlyOmitted.map((item) => <li key={`omitted-${item.id}`}><strong>Omitted</strong><span>{item.kind} · {item.sourceRef}</span><em>{decisionLabel(item.reason)}</em></li>)}</ul> : <p>No selection changes.</p>}</section>
              <section><h4>Candidate changes <small>{comparison.addedCandidates.length + comparison.removedCandidates.length}</small></h4>{comparison.addedCandidates.length || comparison.removedCandidates.length ? <ul>{comparison.addedCandidates.map((item) => <li key={`added-${item.id}`}><strong>Added</strong><span>{item.kind} · {item.sourceRef}</span></li>)}{comparison.removedCandidates.map((item) => <li key={`removed-${item.id}`}><strong>Removed</strong><span>{item.kind} · {item.sourceRef}</span></li>)}</ul> : <p>No candidate additions or removals.</p>}</section>
            </div>
            {comparison.changedOmissionReasons.length || comparison.changedTokenEstimates.length ? <div className="context-compiler-preview__compare-details"><strong>Other decision changes</strong>{comparison.changedOmissionReasons.map((change) => <span key={`reason-${change.id}`}>{change.id}: {decisionLabel(change.from)} → {decisionLabel(change.to)}</span>)}{comparison.changedTokenEstimates.map((change) => <span key={`tokens-${change.id}`}>{change.id}: {change.from} → {change.to} tokens</span>)}</div> : null}
            <p className="context-compiler-preview__compare-boundary">Comparison is in memory for this renderer session. It does not create a durable snapshot, prove source freshness, or authorize provider dispatch.</p>
            <button type="button" className="button button--ghost" title="Clear the renderer-session comparison baseline" onClick={() => { setBaseline(null); setStatus("Cleared the renderer-session comparison baseline."); }}>Clear baseline</button>
          </>}
        </div> : null}
      </> : <div className="context-compiler-preview__error" role="alert"><strong>{aggregateWithheld ? "Reference compiler withheld this preview." : "Reference compiler could not compile this preview."}</strong><p>{result.withholdingReason ?? result.error}</p><small>{aggregateWithheld ? "No aggregate budget, context decision ledger, or provider-message projection is exposed until native selection or compaction evidence exists." : "Adjust the budget or source selection. No native request was attempted."}</small></div>}

      <div className="context-compiler-preview__export">
        <span role="status" aria-live="polite">{status}</span>
        <label><span>Export format</span><select aria-label="Context compiler export format" value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
        <button type="button" className="button button--ghost" title="Copy the current compiler preview to the clipboard" onClick={() => void copy()}><Clipboard size={13} /> Copy</button>
        <button type="button" className="button button--secondary" title="Download the current renderer-local compiler preview" onClick={download}><Download size={13} /> Download</button>
      </div>
      <p className="context-compiler-preview__boundary"><Sparkles size={13} /> Preview only · Renderer-local · no file read, retrieval service, native freeze, provider request, durable context revision, or execution.</p>
    </section>
  );
}

export default ContextCompilerPreview;
