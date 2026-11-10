import {
  BarChart3,
  BrainCircuit,
  Check,
  Clipboard,
  Download,
  Eye,
  FileJson2,
  FlaskConical,
  Gauge,
  ArrowRight,
  LockKeyhole,
  ListChecks,
  MessageSquareText,
  Plus,
  Redo2,
  RotateCcw,
  Sparkles,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from "lucide-react";
import { useMemo, useState } from "react";

type ExperimentTab = "overview" | "prompt" | "personas" | "compare" | "matrix" | "workshop" | "export";
type ExportFormat = "json" | "markdown";
type PersonaTone = "teal" | "blue" | "amber" | "coral";
type NextActionMode = "draft" | "queue" | "run";

type PromptVariant = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  focus: string;
  tone: PersonaTone;
};

type PersonaPack = {
  id: string;
  name: string;
  style: string;
  authority: string;
  strengths: string[];
  guardrail: string;
  tone: PersonaTone;
};

type RubricDimension = {
  id: string;
  label: string;
  description: string;
  weight: number;
};

type RehearsalScore = {
  overall: number;
  dimensions: Record<string, number>;
  rationale: string;
};

type WorkshopLane = {
  id: string;
  name: string;
  role: string;
  tone: PersonaTone;
  finding: string;
  question: string;
  signal: number;
};

type NextAction = {
  id: string;
  label: string;
  description: string;
  category: string;
  expectedCost: string;
  stopCondition: string;
  defaultMode: NextActionMode;
};

type EnhancementDraft = {
  before: string;
  suggested: string;
  additions: string[];
  cautions: string[];
};

type PromptSuggestion = {
  id: string;
  label: string;
  insert: string;
  reason: string;
};

type ExperimentState = {
  name: string;
  objective: string;
  activeTab: ExperimentTab;
  selectedVariantId: string;
  compareBaselineId: string;
  compareCandidateId: string;
  selectedPersonaId: string;
  variants: PromptVariant[];
  personas: PersonaPack[];
  rubric: RubricDimension[];
  scores: Record<string, RehearsalScore>;
  exportFormat: ExportFormat;
};

const seedVariants: PromptVariant[] = [
  {
    id: "variant-baseline",
    name: "Baseline",
    description: "Short direct instruction with an explicit output shape.",
    prompt: "Answer the request directly. State assumptions, then provide the result with concise next steps.",
    focus: "Clarity",
    tone: "blue",
  },
  {
    id: "variant-evidence",
    name: "Evidence-first",
    description: "Makes sources, uncertainty, and verification boundaries visible.",
    prompt: "Work evidence-first. Separate known facts, assumptions, and open questions. Cite visible sources and never invent a receipt.",
    focus: "Grounding",
    tone: "teal",
  },
  {
    id: "variant-coder",
    name: "Coder loop",
    description: "Optimizes for small, reviewable implementation slices.",
    prompt: "Break the request into a small implementation slice. Show the proposed change, acceptance checks, and a short handoff report.",
    focus: "Execution clarity",
    tone: "amber",
  },
];

const seedPersonas: PersonaPack[] = [
  {
    id: "persona-cse-coach",
    name: "CSE coach",
    style: "Socratic, algorithm-aware, example-driven",
    authority: "Suggests and explains; never executes or grants tools.",
    strengths: ["concepts", "algorithms", "edge cases"],
    guardrail: "Ask before turning a hint into a complete solution.",
    tone: "blue",
  },
  {
    id: "persona-production-engineer",
    name: "Production engineer",
    style: "Incremental, typed, failure-aware",
    authority: "Can draft implementation plans; native writes remain unavailable.",
    strengths: ["interfaces", "reliability", "migration"],
    guardrail: "Prefer reversible changes and explicit evidence boundaries.",
    tone: "teal",
  },
  {
    id: "persona-researcher",
    name: "Evidence researcher",
    style: "Methodical, citation-led, uncertainty-calibrated",
    authority: "Can organize evidence; cannot verify external sources in this preview.",
    strengths: ["sources", "synthesis", "claims"],
    guardrail: "Mark unsupported claims as unknown or planned.",
    tone: "amber",
  },
  {
    id: "persona-reviewer",
    name: "Defensive reviewer",
    style: "Adversarial, precise, contract-focused",
    authority: "Can flag risks and missing proof; cannot approve native execution.",
    strengths: ["security", "contracts", "regressions"],
    guardrail: "Fail closed when identity, scope, or provenance is ambiguous.",
    tone: "coral",
  },
];

const seedRubric: RubricDimension[] = [
  { id: "clarity", label: "Clarity", description: "The instruction gives a useful path without unnecessary ambiguity.", weight: 26 },
  { id: "grounding", label: "Grounding", description: "The pair exposes evidence, assumptions, and uncertainty honestly.", weight: 26 },
  { id: "actionability", label: "Actionability", description: "A coder or researcher can turn the result into a next step.", weight: 24 },
  { id: "boundary", label: "Boundary discipline", description: "The pair does not imply provider, native, or tool authority.", weight: 24 },
];

type PromptDiffLine = { kind: "same" | "added" | "removed"; text: string };

function buildPromptLineDiff(before: string, after: string): PromptDiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  // Keep the renderer responsive when someone pastes a very large prompt.
  if (left.length * right.length > 16_384) {
    return [
      ...left.map((text) => ({ kind: "removed" as const, text })),
      ...right.map((text) => ({ kind: "added" as const, text })),
    ];
  }

  const width = right.length + 1;
  const lcs = new Uint16Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = left[i] === right[j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const diff: PromptDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      diff.push({ kind: "same", text: left[i]! });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      diff.push({ kind: "removed", text: left[i++]! });
    } else {
      diff.push({ kind: "added", text: right[j++]! });
    }
  }
  while (i < left.length) diff.push({ kind: "removed", text: left[i++]! });
  while (j < right.length) diff.push({ kind: "added", text: right[j++]! });
  return diff;
}

function buildWorkshopLanes(variant: PromptVariant, persona: PersonaPack): WorkshopLane[] {
  const grounded = /evidence|source|assumption|unknown/i.test(variant.prompt);
  const structured = /step|format|output|next/i.test(variant.prompt);
  return [
    {
      id: "lane-cse",
      name: "CSE coach",
      role: "Concepts + edge cases",
      tone: "blue",
      finding: structured
        ? "The draft already gives a useful path; make the expected output shape concrete for learners."
        : "The direction is understandable, but a visible output shape would reduce ambiguity for implementation work.",
      question: "What is the smallest example or counterexample that proves the answer is useful?",
      signal: Math.min(96, 72 + (structured ? 12 : 4) + persona.strengths.length),
    },
    {
      id: "lane-evidence",
      name: "Evidence reviewer",
      role: "Grounding + provenance",
      tone: "teal",
      finding: grounded
        ? "The prompt names evidence and uncertainty; preserve those labels in the final answer."
        : "Add an explicit known / assumption / unknown split before treating the result as grounded.",
      question: "Which claim needs a source, snapshot, or an explicit unknown marker?",
      signal: Math.min(96, 69 + (grounded ? 17 : 3) + persona.strengths.length * 2),
    },
    {
      id: "lane-review",
      name: "Defensive reviewer",
      role: "Boundary + regression risk",
      tone: "coral",
      finding: /native|provider|tool|execute/i.test(variant.prompt)
        ? "Keep authority language explicit; the prompt must not imply execution receipts that are not present."
        : "No direct execution authority is requested; keep that boundary visible when the prompt is reused.",
      question: "What must remain preview-only if this draft is copied into another workflow?",
      signal: Math.min(96, 74 + (persona.guardrail.length % 11)),
    },
  ];
}

function buildNextActions(variant: PromptVariant, persona: PersonaPack): NextAction[] {
  const hasExamples = /example|sample|counterexample/i.test(variant.prompt);
  const hasEvidence = /evidence|source|assumption|unknown/i.test(variant.prompt);
  return [
    {
      id: "add-examples",
      label: hasExamples ? "Tighten examples" : "Add one worked example",
      description: `Give ${persona.name} a concrete input/output pair before broadening the prompt.`,
      category: "Clarity",
      expectedCost: "Local draft · ~2 min",
      stopCondition: "Stop after one example and one counterexample.",
      defaultMode: "draft",
    },
    {
      id: "evidence-check",
      label: hasEvidence ? "Review evidence labels" : "Add an evidence checklist",
      description: "Separate verified facts, assumptions, and unknowns before any future model run.",
      category: "Grounding",
      expectedCost: "Local checklist · 0 provider calls",
      stopCondition: "Stop when every claim has a source or an unknown marker.",
      defaultMode: "draft",
    },
    {
      id: "boundary-audit",
      label: "Run a boundary audit",
      description: "Inspect authority, tools, provider routing, and durable-write language for accidental escalation.",
      category: "Safety",
      expectedCost: "Deterministic rehearsal · ~1 min",
      stopCondition: "Stop on the first unresolved authority claim.",
      defaultMode: "queue",
    },
  ];
}

function buildEnhancementDraft(prompt: string): EnhancementDraft {
  const trimmed = prompt.trim();
  const additions = [
    ...( /assumption|unknown/i.test(trimmed) ? [] : ["State assumptions and unknowns before the result."]),
    ...( /output|format|structure/i.test(trimmed) ? [] : ["Use a concise output structure with explicit next steps."]),
    ...( /evidence|source|receipt|verify/i.test(trimmed) ? [] : ["Do not claim provider, native, or tool execution without evidence."]),
  ];
  const suggested = additions.length === 0 ? trimmed : `${trimmed}${trimmed ? "\n\n" : ""}${additions.join(" ")}`;
  return {
    before: prompt,
    suggested,
    additions,
    cautions: /always|never/i.test(trimmed) ? ["Review absolute wording; keep user intent while allowing necessary exceptions."] : [],
  };
}

function buildPromptSuggestions(prompt: string): PromptSuggestion[] {
  const suggestions: PromptSuggestion[] = [
    { id: "assumptions", label: "State assumptions", insert: "State assumptions and unknowns before the result.", reason: "Makes uncertainty visible." },
    { id: "format", label: "Add output shape", insert: "Return the result as a concise checklist with explicit next steps.", reason: "Keeps the response actionable." },
    { id: "example", label: "Include example", insert: "Include one worked example and one counterexample.", reason: "Exposes edge cases early." },
    { id: "boundary", label: "Mark evidence boundary", insert: "Do not claim provider, native, or tool execution without a visible receipt.", reason: "Prevents accidental authority escalation." },
  ];
  const normalized = prompt.toLowerCase();
  return suggestions.filter((suggestion) => !normalized.includes(suggestion.insert.slice(0, 18).toLowerCase()));
}

const initialState: ExperimentState = {
  name: "Omnia prompt direction lab",
  objective: "Find a prompt/persona pair that is clear, evidence-bound, and useful for CSE work.",
  activeTab: "overview",
  selectedVariantId: seedVariants[1]!.id,
  compareBaselineId: seedVariants[0]!.id,
  compareCandidateId: seedVariants[1]!.id,
  selectedPersonaId: seedPersonas[1]!.id,
  variants: seedVariants,
  personas: seedPersonas,
  rubric: seedRubric,
  scores: {},
  exportFormat: "json",
};

function cloneState(state: ExperimentState): ExperimentState {
  return {
    ...state,
    variants: state.variants.map((item) => ({ ...item })),
    personas: state.personas.map((item) => ({ ...item, strengths: [...item.strengths] })),
    rubric: state.rubric.map((item) => ({ ...item })),
    scores: Object.fromEntries(Object.entries(state.scores).map(([key, value]) => [key, { ...value, dimensions: { ...value.dimensions } }])),
  };
}

function scoreKey(variantId: string, personaId: string): string {
  return `${variantId}::${personaId}`;
}

function deterministicScore(variant: PromptVariant, persona: PersonaPack, rubric: RubricDimension[]): RehearsalScore {
  const promptSignal = Math.min(9, Math.round(variant.prompt.length / 38));
  const pairSignal = (variant.name.length + persona.name.length + persona.strengths.length * 3) % 8;
  const dimensions = Object.fromEntries(rubric.map((dimension, index) => [
    dimension.id,
    Math.max(58, Math.min(96, 70 + promptSignal + pairSignal + ((index * 5 + variant.id.length + persona.id.length) % 7))),
  ]));
  const totalWeight = rubric.reduce((sum, item) => sum + item.weight, 0);
  const overall = Math.round(rubric.reduce((sum, item) => sum + (dimensions[item.id] ?? 0) * item.weight, 0) / totalWeight);
  return {
    overall,
    dimensions,
    rationale: `${variant.focus} prompt paired with ${persona.style.toLowerCase()}; score is a deterministic rehearsal, not model quality evidence.`,
  };
}

function serializeExperiment(state: ExperimentState): string {
  const selectedVariant = state.variants.find((item) => item.id === state.selectedVariantId);
  const selectedPersona = state.personas.find((item) => item.id === state.selectedPersonaId);
  const workshop = selectedVariant && selectedPersona
    ? { lanes: buildWorkshopLanes(selectedVariant, selectedPersona), nextActions: buildNextActions(selectedVariant, selectedPersona) }
    : { lanes: [], nextActions: [] };
  const payload = {
    schema: "omnia.prompt-persona-experiment.preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    experiment: {
      name: state.name,
      objective: state.objective,
      selectedVariantId: state.selectedVariantId,
      selectedPersonaId: state.selectedPersonaId,
    },
    variants: state.variants,
    personas: state.personas,
    rubric: state.rubric,
    scores: state.scores,
    workshop,
    boundary: {
      providerRequests: false,
      modelTraining: false,
      nativePromptInjection: false,
      durableWrite: false,
    },
  };
  if (state.exportFormat === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia prompt/persona experiment preview",
    "",
    `Experiment: ${state.name}`,
    `Objective: ${state.objective}`,
    "",
    "> Preview only. No provider request, model training, native prompt injection, or durable write was performed.",
    "",
    `- Selected prompt: ${selectedVariant?.name ?? "Unknown"}`,
    `- Selected persona: ${selectedPersona?.name ?? "Unknown"}`,
    `- Prompt variants: ${state.variants.length}`,
    `- Persona packs: ${state.personas.length}`,
    `- Rehearsed pairs: ${Object.keys(state.scores).length}`,
    `- Workshop lanes: ${workshop.lanes.length}`,
    "",
    "## Selected prompt",
    "",
    selectedVariant?.prompt ?? "No prompt selected",
    "",
    "## Selected persona",
    "",
    selectedPersona ? `${selectedPersona.name} — ${selectedPersona.style}\nGuardrail: ${selectedPersona.guardrail}` : "No persona selected",
    "",
    "## Workshop next actions",
    "",
    ...workshop.nextActions.map((action) => `- ${action.label} (${action.category}) — ${action.stopCondition}`),
  ].join("\n");
}

function downloadExperiment(payload: string, format: ExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-prompt-persona-experiment.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

const toneClass = (tone: PersonaTone) => `prompt-experiment__tone prompt-experiment__tone--${tone}`;

function invalidateVariantScores(state: ExperimentState, variantId: string): void {
  for (const key of Object.keys(state.scores)) {
    if (key.startsWith(`${variantId}::`)) delete state.scores[key];
  }
}

function invalidatePersonaScores(state: ExperimentState, personaId: string): void {
  for (const key of Object.keys(state.scores)) {
    if (key.endsWith(`::${personaId}`)) delete state.scores[key];
  }
}

export default function PromptExperimentStudio() {
  const [state, setState] = useState<ExperimentState>(() => cloneState(initialState));
  const [history, setHistory] = useState<ExperimentState[]>([]);
  const [future, setFuture] = useState<ExperimentState[]>([]);
  const [status, setStatus] = useState("Renderer-local prompt experiment ready.");
  const [exportOpen, setExportOpen] = useState(false);
  const [enhancement, setEnhancement] = useState<EnhancementDraft | null>(null);
  const [workshopPrepared, setWorkshopPrepared] = useState(false);
  const [nextActionModes, setNextActionModes] = useState<Record<string, NextActionMode>>({});

  const selectedVariant = state.variants.find((item) => item.id === state.selectedVariantId) ?? state.variants[0];
  const compareBaseline = state.variants.find((item) => item.id === state.compareBaselineId) ?? state.variants[0];
  const compareCandidate = state.variants.find((item) => item.id === state.compareCandidateId) ?? state.variants[1] ?? state.variants[0];
  const selectedPersona = state.personas.find((item) => item.id === state.selectedPersonaId) ?? state.personas[0];
  const selectedScore = selectedVariant && selectedPersona ? state.scores[scoreKey(selectedVariant.id, selectedPersona.id)] : undefined;
  const promptSuggestions = selectedVariant ? buildPromptSuggestions(selectedVariant.prompt) : [];
  const promptDiff = compareBaseline && compareCandidate
    ? buildPromptLineDiff(compareBaseline.prompt, compareCandidate.prompt)
    : [];
  const changedLineCount = promptDiff.filter((line) => line.kind !== "same").length;
  const estimatedTokenDelta = compareBaseline && compareCandidate
    ? Math.round((compareCandidate.prompt.length - compareBaseline.prompt.length) / 4)
    : 0;
  const workshopLanes = selectedVariant && selectedPersona ? buildWorkshopLanes(selectedVariant, selectedPersona) : [];
  const nextActions = selectedVariant && selectedPersona ? buildNextActions(selectedVariant, selectedPersona) : [];
  const exportPayload = useMemo(() => serializeExperiment(state), [state]);

  const update = (mutator: (draft: ExperimentState) => void, message: string) => {
    setState((current) => {
      const next = cloneState(current);
      mutator(next);
      setHistory((entries) => [...entries.slice(-19), cloneState(current)]);
      setFuture([]);
      return next;
    });
    setStatus(message);
  };

  const rehearsePair = (variantId = state.selectedVariantId, personaId = state.selectedPersonaId) => {
    const variant = state.variants.find((item) => item.id === variantId);
    const persona = state.personas.find((item) => item.id === personaId);
    if (!variant || !persona) return;
    update((draft) => {
      draft.scores[scoreKey(variant.id, persona.id)] = deterministicScore(variant, persona, draft.rubric);
    }, `Prepared a deterministic rehearsal for ${variant.name} × ${persona.name}; no model was called.`);
  };

  const rehearseMatrix = () => update((draft) => {
    for (const variant of draft.variants) {
      for (const persona of draft.personas) {
        draft.scores[scoreKey(variant.id, persona.id)] = deterministicScore(variant, persona, draft.rubric);
      }
    }
  }, `Prepared ${state.variants.length * state.personas.length} deterministic prompt/persona pairs; no provider request was made.`);

  const openEnhancement = () => {
    if (!selectedVariant) return;
    setEnhancement(buildEnhancementDraft(selectedVariant.prompt));
    setStatus("Prepared a local semantic enhancement diff; no model or provider was called.");
  };

  const applyEnhancement = () => {
    if (!selectedVariant || !enhancement) return;
    update((draft) => {
      const item = draft.variants.find((entry) => entry.id === selectedVariant.id);
      if (item) {
        item.prompt = enhancement.suggested;
        invalidateVariantScores(draft, item.id);
      }
    }, "Applied the semantic enhancement to the renderer-local prompt draft.");
    setEnhancement(null);
  };

  const applyPromptSuggestion = (suggestion: PromptSuggestion) => {
    if (!selectedVariant) return;
    update((draft) => {
      const item = draft.variants.find((entry) => entry.id === selectedVariant.id);
      if (item) {
        item.prompt = `${item.prompt.trim()}${item.prompt.trim() ? "\n\n" : ""}${suggestion.insert}`;
        invalidateVariantScores(draft, item.id);
      }
    }, `Inserted the local suggestion “${suggestion.label}” into the prompt draft.`);
  };

  const prepareWorkshop = () => {
    if (!selectedVariant || !selectedPersona) return;
    setWorkshopPrepared(true);
    setStatus(`Prepared ${workshopLanes.length} deterministic workshop lanes for ${selectedVariant.name} × ${selectedPersona.name}; no model was called.`);
  };

  const stageNextAction = (action: NextAction) => {
    const mode = nextActionModes[action.id] ?? action.defaultMode;
    setStatus(`Staged “${action.label}” as ${mode}; budget and stop condition remain visible, with no queue or run started.`);
  };

  const duplicateVariant = () => {
    if (!selectedVariant) return;
    const id = `variant-custom-${Date.now()}`;
    update((draft) => {
      draft.variants.push({ ...selectedVariant, id, name: `${selectedVariant.name} copy`, description: "Custom renderer-local variant.", tone: "coral" });
      draft.selectedVariantId = id;
    }, "Duplicated the selected prompt variant in this renderer session.");
  };

  const removeVariant = () => {
    if (!selectedVariant || state.variants.length <= 1) return;
    update((draft) => {
      draft.variants = draft.variants.filter((item) => item.id !== selectedVariant.id);
      draft.selectedVariantId = draft.variants[0]!.id;
      for (const key of Object.keys(draft.scores)) if (key.startsWith(`${selectedVariant.id}::`)) delete draft.scores[key];
    }, "Removed the selected prompt variant from this renderer session.");
  };

  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((entries) => entries.slice(0, -1));
    setFuture((entries) => [...entries, cloneState(state)]);
    setState(cloneState(previous));
    setStatus("Undid the last prompt experiment preview change.");
  };

  const redo = () => {
    const next = future[future.length - 1];
    if (!next) return;
    setFuture((entries) => entries.slice(0, -1));
    setHistory((entries) => [...entries, cloneState(state)]);
    setState(cloneState(next));
    setStatus("Redid the prompt experiment preview change.");
  };

  const reset = () => {
    setHistory((entries) => [...entries.slice(-19), cloneState(state)]);
    setFuture([]);
    setState(cloneState(initialState));
    setEnhancement(null);
    setWorkshopPrepared(false);
    setNextActionModes({});
    setStatus("Reset the prompt/persona experiment preview.");
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; the experiment remains renderer-local.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`${state.exportFormat.toUpperCase()} preview copied; no durable write was made.`);
    } catch {
      setStatus("Clipboard write was unavailable; no durable export was created.");
    }
  };

  const tabs: Array<{ id: ExperimentTab; label: string; icon: typeof BarChart3 }> = [
    { id: "overview", label: "Overview", icon: BarChart3 },
    { id: "prompt", label: "Prompt variants", icon: FlaskConical },
    { id: "personas", label: "Persona packs", icon: BrainCircuit },
    { id: "compare", label: "Prompt compare", icon: ArrowRight },
    { id: "matrix", label: "Pair matrix", icon: Gauge },
    { id: "workshop", label: "Prompt Workshop", icon: MessageSquareText },
    { id: "export", label: "Export", icon: FileJson2 },
  ];

  return (
    <section className="prompt-experiment" aria-labelledby="prompt-experiment-title">
      <header className="prompt-experiment__header">
        <div className="prompt-experiment__title">
          <span className="eyebrow"><Sparkles size={14} /> Prompt intelligence lab</span>
          <h2 id="prompt-experiment-title">Prompt / Persona Experiment Studio</h2>
          <p>Compose prompt directions and persona packs, then compare deterministic rehearsal signals before a future native route is connected.</p>
        </div>
        <div className="prompt-experiment__header-actions">
          <span className="prompt-experiment__badge"><Eye size={13} /> Preview only</span>
          <button type="button" className="button button--secondary" onClick={undo} disabled={!history.length} aria-label="Undo prompt experiment preview change"><Undo2 size={14} /> Undo</button>
          <button type="button" className="button button--secondary" onClick={redo} disabled={!future.length} aria-label="Redo prompt experiment preview change"><Redo2 size={14} /> Redo</button>
          <button type="button" className="button button--secondary" onClick={reset}><RotateCcw size={14} /> Reset</button>
        </div>
      </header>

      <div className="prompt-experiment__boundary" role="note"><LockKeyhole size={14} /> Renderer-local rehearsal. No provider request, model training, native prompt injection, tool execution, or durable write is performed.</div>

      <div className="prompt-experiment__controls" aria-label="Prompt experiment controls">
        <label><span>Experiment name</span><input value={state.name} onChange={(event) => update((draft) => { draft.name = event.target.value; }, "Updated the renderer-local experiment name.")} /></label>
        <label className="prompt-experiment__objective"><span>Objective</span><input value={state.objective} onChange={(event) => update((draft) => { draft.objective = event.target.value; }, "Updated the renderer-local experiment objective.")} /></label>
        <button type="button" className="button button--primary" onClick={() => rehearsePair()} disabled={!selectedVariant || !selectedPersona}><FlaskConical size={14} /> Rehearse selected pair</button>
      </div>

      <div className="prompt-experiment__metrics" role="status" aria-label="Prompt experiment summary">
        <span><strong>{state.variants.length}</strong><small>prompt variants</small></span>
        <span><strong>{state.personas.length}</strong><small>persona packs</small></span>
        <span><strong>{Object.keys(state.scores).length}</strong><small>rehearsed pairs</small></span>
        <span><strong>{selectedScore ? `${selectedScore.overall}/100` : "—"}</strong><small>selected signal</small></span>
      </div>

      <nav className="prompt-experiment__tabs" role="tablist" aria-label="Prompt experiment views">
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} id={`prompt-experiment-tab-${id}`} type="button" role="tab" aria-selected={state.activeTab === id} aria-controls={`prompt-experiment-panel-${id}`} className={state.activeTab === id ? "is-active" : ""} onClick={() => update((draft) => { draft.activeTab = id; }, `Opened ${label} view.`)}><Icon size={14} /> {label}</button>)}
      </nav>

      <div className="prompt-experiment__body">
        {state.activeTab === "overview" ? (
          <div id="prompt-experiment-panel-overview" role="tabpanel" aria-labelledby="prompt-experiment-tab-overview" className="prompt-experiment__overview">
            <article className="prompt-experiment__card">
              <div className="prompt-experiment__card-heading"><span><FlaskConical size={14} /> Selected prompt direction</span><span className={toneClass(selectedVariant?.tone ?? "blue")}>{selectedVariant?.focus ?? "Unknown"}</span></div>
              {selectedVariant ? <><h3>{selectedVariant.name}</h3><p>{selectedVariant.description}</p><pre className="prompt-experiment__prompt-preview">{selectedVariant.prompt}</pre></> : <p>No prompt variant selected.</p>}
              <div className="prompt-experiment__action-row"><button type="button" className="button button--primary" onClick={() => rehearsePair()} disabled={!selectedVariant || !selectedPersona}><FlaskConical size={14} /> Prepare pair rehearsal</button><button type="button" className="button button--secondary" onClick={() => update((draft) => { draft.activeTab = "matrix"; }, "Opened pair matrix.")}><BarChart3 size={14} /> Open matrix</button></div>
            </article>
            <article className="prompt-experiment__card">
              <div className="prompt-experiment__card-heading"><span><BrainCircuit size={14} /> Selected persona pack</span><span className={toneClass(selectedPersona?.tone ?? "teal")}>{selectedPersona?.strengths.length ?? 0} strengths</span></div>
              {selectedPersona ? <><h3>{selectedPersona.name}</h3><p>{selectedPersona.style}</p><dl className="prompt-experiment__facts"><div><dt>Authority ceiling</dt><dd>{selectedPersona.authority}</dd></div><div><dt>Guardrail</dt><dd>{selectedPersona.guardrail}</dd></div></dl></> : <p>No persona selected.</p>}
            </article>
          </div>
        ) : null}

        {state.activeTab === "prompt" ? (
          <div id="prompt-experiment-panel-prompt" role="tabpanel" aria-labelledby="prompt-experiment-tab-prompt" className="prompt-experiment__split">
            <div className="prompt-experiment__list" role="list" aria-label="Prompt variant list">
              <div className="prompt-experiment__list-heading"><span><strong>Prompt variants</strong><small>Choose a direction, then edit the draft.</small></span><button type="button" className="button button--ghost" onClick={duplicateVariant} disabled={!selectedVariant}><Plus size={13} /> Duplicate</button></div>
              {state.variants.map((variant) => <button key={variant.id} type="button" role="listitem" className={`prompt-experiment__list-row ${variant.id === state.selectedVariantId ? "is-selected" : ""}`} onClick={() => { setEnhancement(null); update((draft) => { draft.selectedVariantId = variant.id; }, `Selected prompt variant ${variant.name}.`); }}><span><strong>{variant.name}</strong><small>{variant.description}</small></span><em className={toneClass(variant.tone)}>{variant.focus}</em></button>)}
            </div>
            <article className="prompt-experiment__card prompt-experiment__editor">
              <div className="prompt-experiment__card-heading"><span><SlidersHorizontal size={14} /> Prompt editor</span><div className="prompt-experiment__heading-actions"><button type="button" className="button button--secondary" onClick={openEnhancement} disabled={!selectedVariant}><Sparkles size={13} /> Enhance</button><button type="button" className="button button--ghost" onClick={removeVariant} disabled={state.variants.length <= 1 || !selectedVariant}><Trash2 size={13} /> Remove</button></div></div>
              {selectedVariant ? <><div className="prompt-experiment__field-grid"><label><span>Variant name</span><input value={selectedVariant.name} onChange={(event) => update((draft) => { const item = draft.variants.find((entry) => entry.id === selectedVariant.id); if (item) { item.name = event.target.value; invalidateVariantScores(draft, item.id); } }, "Updated the prompt variant name.")} /></label><label><span>Focus label</span><input value={selectedVariant.focus} onChange={(event) => update((draft) => { const item = draft.variants.find((entry) => entry.id === selectedVariant.id); if (item) { item.focus = event.target.value; invalidateVariantScores(draft, item.id); } }, "Updated the prompt variant focus.")} /></label></div><label><span>Description</span><input value={selectedVariant.description} onChange={(event) => update((draft) => { const item = draft.variants.find((entry) => entry.id === selectedVariant.id); if (item) { item.description = event.target.value; invalidateVariantScores(draft, item.id); } }, "Updated the prompt variant description.")} /></label><label><span>Tone</span><select value={selectedVariant.tone} onChange={(event) => update((draft) => { const item = draft.variants.find((entry) => entry.id === selectedVariant.id); if (item) { item.tone = event.target.value as PersonaTone; invalidateVariantScores(draft, item.id); } }, "Updated the prompt variant tone.")}><option value="blue">Blue / clarity</option><option value="teal">Teal / grounded</option><option value="amber">Amber / exploratory</option><option value="coral">Coral / custom</option></select></label><label><span>Instruction draft</span><textarea rows={9} value={selectedVariant.prompt} onChange={(event) => { setEnhancement(null); update((draft) => { const item = draft.variants.find((entry) => entry.id === selectedVariant.id); if (item) { item.prompt = event.target.value; invalidateVariantScores(draft, item.id); } }, "Updated the renderer-local prompt draft."); }} /></label>{promptSuggestions.length ? <div className="prompt-experiment__suggestions" aria-label="Local prompt suggestions"><div><strong>Local suggestions</strong><small>Click to append; nothing is sent automatically.</small></div><div>{promptSuggestions.map((suggestion) => <button key={suggestion.id} type="button" className="prompt-experiment__suggestion" title={suggestion.reason} onClick={() => applyPromptSuggestion(suggestion)}><Plus size={12} /> {suggestion.label}</button>)}</div></div> : null}<p className="prompt-experiment__hint"><LockKeyhole size={13} /> This text is an editable draft only. It is not injected into a provider request. Editing a variant clears its prior rehearsal signals until you rehearse it again.</p></> : null}
            </article>
            {enhancement ? <section className="prompt-experiment__enhance" aria-label="Prompt enhancement semantic diff"><div className="prompt-experiment__card-heading"><span><Sparkles size={14} /> Semantic enhancement diff</span><span className="prompt-experiment__badge">Renderer-local</span></div><div className="prompt-experiment__diff-grid"><div><span>Before</span><pre>{enhancement.before}</pre></div><ArrowRight size={16} aria-hidden="true" /><div><span>Suggested</span><pre>{enhancement.suggested}</pre></div></div>{enhancement.additions.length ? <div className="prompt-experiment__change-list"><strong>Suggested additions</strong>{enhancement.additions.map((addition) => <span key={addition}><Check size={13} /> {addition}</span>)}</div> : <p className="prompt-experiment__hint"><Check size={13} /> No automatic additions were needed; the draft already names the core constraints.</p>}{enhancement.cautions.map((caution) => <p className="prompt-experiment__hint" key={caution}><LockKeyhole size={13} /> {caution}</p>)}<div className="prompt-experiment__action-row"><button type="button" className="button button--primary" onClick={applyEnhancement}><Check size={14} /> Apply to draft</button><button type="button" className="button button--ghost" onClick={() => setEnhancement(null)}>Dismiss</button></div><p className="prompt-experiment__hint"><LockKeyhole size={13} /> Enhance preserves intent heuristically in this preview; no model critique, provider request, or automatic send occurred.</p></section> : null}
          </div>
        ) : null}

        {state.activeTab === "personas" ? (
          <div id="prompt-experiment-panel-personas" role="tabpanel" aria-labelledby="prompt-experiment-tab-personas" className="prompt-experiment__persona-grid">
            {state.personas.map((persona) => <button key={persona.id} type="button" className={`prompt-experiment__persona ${persona.id === state.selectedPersonaId ? "is-selected" : ""}`} onClick={() => update((draft) => { draft.selectedPersonaId = persona.id; }, `Selected persona pack ${persona.name}.`)}><span className={`prompt-experiment__persona-icon ${toneClass(persona.tone)}`}><BrainCircuit size={17} /></span><span><strong>{persona.name}</strong><small>{persona.style}</small><small>{persona.strengths.join(" · ")}</small></span><em>{persona.id === state.selectedPersonaId ? <Check size={13} /> : "Select"}</em></button>)}
            {selectedPersona ? <article className="prompt-experiment__card prompt-experiment__persona-detail"><div className="prompt-experiment__card-heading"><span><BrainCircuit size={14} /> Persona contract</span><span className={toneClass(selectedPersona.tone)}>Renderer draft</span></div><div className="prompt-experiment__persona-fields"><label><span>Persona name</span><input value={selectedPersona.name} onChange={(event) => update((draft) => { const item = draft.personas.find((entry) => entry.id === selectedPersona.id); if (item) { item.name = event.target.value; invalidatePersonaScores(draft, item.id); } }, "Updated the persona pack name.")} /></label><label><span>Style</span><input value={selectedPersona.style} onChange={(event) => update((draft) => { const item = draft.personas.find((entry) => entry.id === selectedPersona.id); if (item) { item.style = event.target.value; invalidatePersonaScores(draft, item.id); } }, "Updated the persona pack style.")} /></label><label><span>Strengths</span><input value={selectedPersona.strengths.join(", ")} onChange={(event) => update((draft) => { const item = draft.personas.find((entry) => entry.id === selectedPersona.id); if (item) { item.strengths = event.target.value.split(",").map((value) => value.trim()).filter(Boolean); invalidatePersonaScores(draft, item.id); } }, "Updated the persona strengths.")} /></label><label><span>Tone</span><select value={selectedPersona.tone} onChange={(event) => update((draft) => { const item = draft.personas.find((entry) => entry.id === selectedPersona.id); if (item) { item.tone = event.target.value as PersonaTone; invalidatePersonaScores(draft, item.id); } }, "Updated the persona pack tone.")}><option value="blue">Blue / clarity</option><option value="teal">Teal / grounded</option><option value="amber">Amber / exploratory</option><option value="coral">Coral / defensive</option></select></label></div><label><span>Authority ceiling</span><textarea rows={3} value={selectedPersona.authority} onChange={(event) => update((draft) => { const item = draft.personas.find((entry) => entry.id === selectedPersona.id); if (item) { item.authority = event.target.value; invalidatePersonaScores(draft, item.id); } }, "Updated the persona authority ceiling.")} /></label><label><span>Guardrail</span><textarea rows={3} value={selectedPersona.guardrail} onChange={(event) => update((draft) => { const item = draft.personas.find((entry) => entry.id === selectedPersona.id); if (item) { item.guardrail = event.target.value; invalidatePersonaScores(draft, item.id); } }, "Updated the persona guardrail.")} /></label><p className="prompt-experiment__hint"><LockKeyhole size={13} /> Persona resolution, trust, permission grants, and provider injection remain planned. Editing a persona clears its prior rehearsal signals until you rehearse it again.</p></article> : null}
          </div>
        ) : null}

        {state.activeTab === "compare" ? (
          <div id="prompt-experiment-panel-compare" role="tabpanel" aria-labelledby="prompt-experiment-tab-compare" className="prompt-experiment__compare">
            <div className="prompt-experiment__matrix-toolbar">
              <span><strong>Prompt variant comparison</strong><small>Inspect exact line changes before choosing which draft to continue editing.</small></span>
              <span className="prompt-experiment__badge"><LockKeyhole size={12} /> Local diff · no model call</span>
            </div>
            <div className="prompt-experiment__compare-selectors">
              <label><span>Baseline</span><select aria-label="Baseline prompt variant" value={compareBaseline?.id ?? ""} onChange={(event) => update((draft) => { draft.compareBaselineId = event.target.value; }, "Changed the prompt comparison baseline.")}>{state.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}</select></label>
              <ArrowRight size={16} aria-hidden="true" />
              <label><span>Challenger</span><select aria-label="Challenger prompt variant" value={compareCandidate?.id ?? ""} onChange={(event) => update((draft) => { draft.compareCandidateId = event.target.value; }, "Changed the prompt comparison challenger.")}>{state.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}</select></label>
              <button type="button" className="button button--secondary" onClick={() => update((draft) => { [draft.compareBaselineId, draft.compareCandidateId] = [draft.compareCandidateId, draft.compareBaselineId]; }, "Swapped the compared prompt variants.")} disabled={!compareBaseline || !compareCandidate || compareBaseline.id === compareCandidate.id}>Swap sides</button>
            </div>
            {compareBaseline && compareCandidate ? <>
              <div className="prompt-experiment__compare-summary" aria-label="Prompt comparison summary">
                <span><strong>{changedLineCount}</strong><small>changed lines</small></span>
                <span><strong>{compareBaseline.prompt.length}</strong><small>baseline characters</small></span>
                <span><strong>{compareCandidate.prompt.length}</strong><small>challenger characters</small></span>
                <span><strong>{estimatedTokenDelta > 0 ? "+" : ""}{estimatedTokenDelta}</strong><small>rough token delta · chars ÷ 4</small></span>
              </div>
              <div className="prompt-experiment__compare-columns">
                <article className="prompt-experiment__compare-card"><header><div><strong>{compareBaseline.name}</strong><small>{compareBaseline.focus} · baseline</small></div><button type="button" className="button button--ghost" onClick={() => update((draft) => { draft.selectedVariantId = compareBaseline.id; draft.activeTab = "prompt"; }, `Opened ${compareBaseline.name} in the prompt editor.`)}>Edit baseline</button></header><pre>{compareBaseline.prompt || "(empty prompt)"}</pre></article>
                <article className="prompt-experiment__compare-card"><header><div><strong>{compareCandidate.name}</strong><small>{compareCandidate.focus} · challenger</small></div><button type="button" className="button button--ghost" onClick={() => update((draft) => { draft.selectedVariantId = compareCandidate.id; draft.activeTab = "prompt"; }, `Opened ${compareCandidate.name} in the prompt editor.`)}>Edit challenger</button></header><pre>{compareCandidate.prompt || "(empty prompt)"}</pre></article>
              </div>
              <section className="prompt-experiment__diff" aria-label="Prompt line diff">
                <div className="prompt-experiment__card-heading"><span><SlidersHorizontal size={14} /> Line-by-line diff</span><small>− baseline · + challenger</small></div>
                {compareBaseline.id === compareCandidate.id ? <p className="prompt-experiment__score-empty">Choose two different variants to see the changes between them.</p> : changedLineCount === 0 ? <p className="prompt-experiment__score-empty"><Check size={13} /> These prompt drafts are identical.</p> : <pre>{promptDiff.map((line, index) => <span key={`${index}-${line.kind}`} className={`prompt-experiment__diff-line prompt-experiment__diff-line--${line.kind}`}><b>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</b>{line.text || " "}{"\n"}</span>)}</pre>}
              </section>
              <p className="prompt-experiment__hint"><LockKeyhole size={13} /> The token figure is a rough character-based estimate, not tokenizer output. This comparison never changes a prompt or rehearsal score by itself.</p>
            </> : <p className="prompt-experiment__score-empty">Add at least one prompt variant to compare drafts.</p>}
          </div>
        ) : null}

        {state.activeTab === "matrix" ? (
          <div id="prompt-experiment-panel-matrix" role="tabpanel" aria-labelledby="prompt-experiment-tab-matrix" className="prompt-experiment__matrix-wrap"><div className="prompt-experiment__matrix-toolbar"><span><strong>Pair matrix</strong><small>Deterministic rehearsal signals only; no live quality, cost, or latency data.</small></span><button type="button" className="button button--primary" onClick={rehearseMatrix}><FlaskConical size={14} /> Rehearse all pairs</button></div><div className="prompt-experiment__matrix" role="table" aria-label="Prompt persona pair matrix"><div className="prompt-experiment__matrix-row prompt-experiment__matrix-row--header" role="row"><span role="columnheader">Prompt / persona</span>{state.personas.map((persona) => <span key={persona.id} role="columnheader">{persona.name}</span>)}</div>{state.variants.map((variant) => <div key={variant.id} className="prompt-experiment__matrix-row" role="row"><span role="rowheader"><strong>{variant.name}</strong><small>{variant.focus}</small></span>{state.personas.map((persona) => { const score = state.scores[scoreKey(variant.id, persona.id)]; return <button key={persona.id} type="button" role="cell" className={variant.id === state.selectedVariantId && persona.id === state.selectedPersonaId ? "is-selected" : ""} onClick={() => { update((draft) => { draft.selectedVariantId = variant.id; draft.selectedPersonaId = persona.id; }, `Selected ${variant.name} × ${persona.name}.`); }}><strong>{score ? `${score.overall}/100` : "—"}</strong><small>{score ? "Rehearsed" : "Not run"}</small></button>; })}</div>)}</div>{selectedScore ? <section className="prompt-experiment__score-detail" aria-label="Selected rehearsal score"><header><div><span className="eyebrow"><Gauge size={13} /> Selected pair signal</span><h3>{selectedVariant?.name ?? "Unknown"} × {selectedPersona?.name ?? "Unknown"}</h3></div><strong>{selectedScore.overall}/100</strong></header><div className="prompt-experiment__score-bars">{state.rubric.map((dimension) => <div key={dimension.id}><div><span>{dimension.label}</span><strong>{selectedScore.dimensions[dimension.id] ?? 0}/100 · {dimension.weight}% weight</strong></div><span className="prompt-experiment__score-track"><i style={{ width: `${selectedScore.dimensions[dimension.id] ?? 0}%` }} /></span></div>)}</div><p>{selectedScore.rationale}</p><small className="prompt-experiment__score-boundary"><LockKeyhole size={12} /> Rehearsal signal only; no model output, benchmark, or provider evidence is present.</small></section> : <p className="prompt-experiment__score-empty"><Gauge size={13} /> Rehearse a pair to inspect its transparent dimension breakdown.</p>}<p className="prompt-experiment__hint"><Gauge size={13} /> Scores are transparent heuristics to help choose what to inspect next. They are not benchmark results or model evaluation evidence.</p></div>
        ) : null}

        {state.activeTab === "workshop" ? (
          <div id="prompt-experiment-panel-workshop" role="tabpanel" aria-labelledby="prompt-experiment-tab-workshop" className="prompt-experiment__workshop">
            <div className="prompt-experiment__matrix-toolbar"><span><strong><MessageSquareText size={14} /> Prompt Workshop</strong><small>Discuss one prompt/persona pair with deterministic reviewer lanes before a future model-backed workshop exists.</small></span><button type="button" className="button button--primary" onClick={prepareWorkshop} disabled={!selectedVariant || !selectedPersona}><MessageSquareText size={14} /> Prepare workshop rehearsal</button></div>
            <p className="prompt-experiment__boundary"><LockKeyhole size={14} /> {workshopPrepared ? "Workshop lanes are prepared in this renderer session." : "No workshop lane has run yet."} Reviewers are synthetic projections; no model, agent, provider, queue, or run was started.</p>
            <div className="prompt-experiment__workshop-context"><div><span>Prompt direction</span><strong>{selectedVariant?.name ?? "Unknown"}</strong><small>{selectedVariant?.focus ?? "No prompt selected"}</small></div><div><span>Persona pack</span><strong>{selectedPersona?.name ?? "Unknown"}</strong><small>{selectedPersona?.style ?? "No persona selected"}</small></div><div><span>Revision posture</span><strong>Preserve intent</strong><small>Semantic suggestions require explicit apply.</small></div></div>
            <div className="prompt-experiment__workshop-lanes" aria-label="Prompt workshop reviewer lanes">{workshopLanes.map((lane) => <article key={lane.id} className="prompt-experiment__workshop-lane"><div className="prompt-experiment__card-heading"><span><span className={`prompt-experiment__persona-icon ${toneClass(lane.tone)}`}><BrainCircuit size={14} /></span><strong>{lane.name}</strong></span><span className={toneClass(lane.tone)}>{lane.signal}/100 signal</span></div><small>{lane.role}</small><p>{lane.finding}</p><div className="prompt-experiment__workshop-question"><span>Counter-question</span><strong>{lane.question}</strong></div></article>)}</div>
            <section className="prompt-experiment__next-actions" aria-label="Prompt workshop next actions"><div className="prompt-experiment__list-heading"><span><strong><ListChecks size={14} /> Suggested next actions</strong><small>Every mode is staged only; budgets and stop conditions stay visible.</small></span><span className="prompt-experiment__badge">{nextActions.length} suggestions</span></div>{nextActions.map((action) => { const mode = nextActionModes[action.id] ?? action.defaultMode; return <article key={action.id} className="prompt-experiment__next-action"><div><span className="prompt-experiment__tone prompt-experiment__tone--blue">{action.category}</span><h3>{action.label}</h3><p>{action.description}</p></div><div className="prompt-experiment__next-action-controls"><label><span>Mode</span><select aria-label={`${action.label} mode`} value={mode} onChange={(event) => setNextActionModes((current) => ({ ...current, [action.id]: event.target.value as NextActionMode }))}><option value="draft">Draft only</option><option value="queue">Queue preview</option><option value="run">Run preview</option></select></label><button type="button" className="button button--secondary" aria-label={`Stage ${action.label} preview`} onClick={() => stageNextAction(action)}><ArrowRight size={13} /> Stage</button></div><dl className="prompt-experiment__facts"><div><dt>Expected cost</dt><dd>{action.expectedCost}</dd></div><div><dt>Stop condition</dt><dd>{action.stopCondition}</dd></div></dl></article>; })}</section>
            <p className="prompt-experiment__hint"><LockKeyhole size={13} /> Queue and run modes are labels for a future native operation. This preview never creates a queue item, spends budget, calls a provider, or mutates a project.</p>
          </div>
        ) : null}

        {state.activeTab === "export" ? (
          <div id="prompt-experiment-panel-export" role="tabpanel" aria-labelledby="prompt-experiment-tab-export" className="prompt-experiment__export"><div className="prompt-experiment__export-toolbar"><label><span>Format</span><select value={state.exportFormat} onChange={(event) => update((draft) => { draft.exportFormat = event.target.value as ExportFormat; }, `Selected ${event.target.value.toUpperCase()} export preview.`)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--secondary" onClick={() => void copyExport()}><Clipboard size={14} /> Copy</button><button type="button" className="button button--secondary" onClick={() => setStatus(downloadExperiment(exportPayload, state.exportFormat) ? "Browser download started; no native export receipt was created." : "Browser download is unavailable in this preview environment.")}><Download size={14} /> Download</button><button type="button" className="button button--secondary" aria-expanded={exportOpen} aria-controls="prompt-experiment-export-drawer" onClick={() => setExportOpen((open) => !open)}><Eye size={14} /> {exportOpen ? "Hide preview" : "Preview export"}</button></div><pre aria-label={`${state.exportFormat === "json" ? "JSON" : "Markdown"} prompt experiment export preview`}>{exportPayload}</pre><p className="prompt-experiment__hint"><FileJson2 size={13} /> Export contains renderer-visible drafts and synthetic scores only; credentials, provider payloads, and native receipts are excluded.</p></div>
        ) : null}
      </div>

      {exportOpen ? <section id="prompt-experiment-export-drawer" className="prompt-experiment__export prompt-experiment__export--drawer" aria-label="Quick prompt experiment export preview"><div className="prompt-experiment__card-heading"><span><FileJson2 size={14} /> Quick export preview</span><button type="button" className="button button--ghost" onClick={() => setExportOpen(false)}>Close</button></div><pre>{exportPayload}</pre></section> : null}
      <p className="prompt-experiment__status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}
