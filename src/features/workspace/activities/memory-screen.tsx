import {
  Archive,
  Bookmark,
  BrainCircuit,
  Check,
  CheckCircle2,
  Clock3,
  Clipboard,
  Database,
  Download,
  Eye,
  FileJson2,
  Filter,
  History,
  Inbox,
  Layers3,
  LockKeyhole,
  Pause,
  Pin,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { lazy, Suspense, useMemo, useState, type ChangeEvent, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { LazyLoadBoundary } from "@/components/lazy-load-boundary";
import type { AppRuntimeInfo } from "@/lib/desktop";

import type { ActivityScreenProps } from "../activity-registry";
import { useWorkspaceStore } from "../store";
import type { MemorySensitivity, MemoryView } from "../types";
import { ScreenHeader } from "../screen-header";

// Learning, draft, diagnostics, and training surfaces are intentionally kept out of
// the initial memory activity chunk. The overview/entries/policies path is the common
// path; these renderer-local workbenches load only when the user opens them.
type MemoryLazySurfaceModule<Props extends object> = { default: ComponentType<Props> };

import MemoryProposalInbox from "../memory-proposal-inbox";

const loadLearningLoopLab = () => import("../learning-loop-lab");
const loadDataIntakeLearningReview = () => import("../data-intake-learning-review");
const loadDataLineageStudio = () => import("../data-lineage-studio");
const loadMemoryDraftStudio = () => import("../memory-draft-studio");
const loadMemoryReviewWorkbench = () => import("../memory-review-workbench");
const loadMemoryLifecycleStudio = () => import("../memory-lifecycle-studio");
const loadMemoryScopeModePreview = () => import("../memory-scope-mode-preview");
const loadMemoryProvenanceRevisionInspector = () => import("../memory-provenance-revision-inspector");
const loadMemoryDiagnosticsPreview = () => import("../memory-diagnostics-preview").then(({ MemoryDiagnosticsPreview }) => ({ default: MemoryDiagnosticsPreview }));
const loadTrainingControlCenter = () => import("../training-control-center");
const loadKnowledgeTreeExplorer = () => import("../knowledge-tree-explorer");

type MemoryTab = "overview" | "proposals" | "entries" | "policies" | "learning" | "lifecycle";
type StatusFilter = "all" | MemoryView["status"];
type ScopeFilter = "all" | string;
type KindFilter = "all" | MemoryView["kind"];
type MemoryExportFormat = "json" | "markdown";
type MemoryImportFormat = "json" | "markdown";
type LocalMemoryState = "paused" | "forgotten";
type MemorySensitivityMode = "exclude" | "review" | "include";

type MemoryPolicyPreview = {
  includeSuggested: boolean;
  confidenceFloor: number;
  showArchived: boolean;
  sensitivityMode: MemorySensitivityMode;
};

type MemoryPolicyHistory = {
  past: MemoryPolicyPreview[];
  present: MemoryPolicyPreview;
  future: MemoryPolicyPreview[];
};

type MemoryPolicyPreset = {
  id: "balanced" | "conservative" | "exploratory";
  label: string;
  description: string;
  policy: MemoryPolicyPreview;
};

const tabs: Array<[MemoryTab, string, typeof Layers3]> = [
  ["overview", "Overview", Layers3],
  ["entries", "Entries", Database],
  ["proposals", "Proposals", Inbox],
  ["policies", "Policies", ShieldCheck],
  ["learning", "Learning log", History],
  ["lifecycle", "Lifecycle", Clock3],
];

const kindLabels: Record<MemoryView["kind"], string> = {
  preference: "Preference",
  workflow: "Workflow",
  "project-fact": "Project fact",
  constraint: "Constraint",
};

const statusLabels: Record<MemoryView["status"], string> = {
  active: "Active",
  suggested: "Suggested",
  paused: "Paused",
  archived: "Archived",
};

const DEFAULT_MEMORY_POLICY: MemoryPolicyPreview = {
  includeSuggested: true,
  confidenceFloor: 0,
  showArchived: false,
  sensitivityMode: "review",
};

const MEMORY_POLICY_PRESETS: readonly MemoryPolicyPreset[] = [
  {
    id: "balanced",
    label: "Balanced",
    description: "Active and suggested entries; sensitive rows stay review-only.",
    policy: DEFAULT_MEMORY_POLICY,
  },
  {
    id: "conservative",
    label: "Conservative",
    description: "Only high-confidence entries; archived rows stay hidden.",
    policy: { includeSuggested: false, confidenceFloor: 0.8, showArchived: false, sensitivityMode: "exclude" },
  },
  {
    id: "exploratory",
    label: "Exploratory",
    description: "Include suggestions, archived rows, and non-secret sensitive rows.",
    policy: { includeSuggested: true, confidenceFloor: 0, showArchived: true, sensitivityMode: "include" },
  },
];

const MEMORY_SENSITIVITY_OPTIONS: readonly { id: MemorySensitivity; label: string; description: string }[] = [
  { id: "normal", label: "Normal", description: "No extra sensitivity marker." },
  { id: "personal", label: "Personal", description: "Personal preference or identity context." },
  { id: "financial", label: "Financial", description: "Money, account, or transaction context." },
  { id: "health", label: "Health", description: "Health-related or wellbeing context." },
  { id: "authentication", label: "Authentication", description: "Always blocked from memory retrieval." },
  { id: "secret", label: "Secret", description: "Always blocked from memory retrieval." },
  { id: "private-key", label: "Private key", description: "Always blocked from memory retrieval." },
];

const MEMORY_SENSITIVITY_LABELS: Record<MemorySensitivity, string> = Object.fromEntries(
  MEMORY_SENSITIVITY_OPTIONS.map((option) => [option.id, option.label]),
) as Record<MemorySensitivity, string>;

const FORBIDDEN_MEMORY_SENSITIVITIES: ReadonlySet<MemorySensitivity> = new Set([
  "authentication",
  "secret",
  "private-key",
]);

const isMemorySensitivity = (value: unknown): value is MemorySensitivity => (
  typeof value === "string" && MEMORY_SENSITIVITY_OPTIONS.some((option) => option.id === value)
);

function memorySensitivityCategories(memory: MemoryView): readonly MemorySensitivity[] {
  const categories = memory.sensitivity?.filter(isMemorySensitivity) ?? [];
  return categories.length > 0 ? categories : ["normal"];
}

function hasElevatedSensitivity(memory: MemoryView): boolean {
  return memorySensitivityCategories(memory).some((category) => category !== "normal");
}

function hasForbiddenSensitivity(memory: MemoryView): boolean {
  return memorySensitivityCategories(memory).some((category) => FORBIDDEN_MEMORY_SENSITIVITIES.has(category));
}

function sensitivitySummary(memory: MemoryView): string {
  return memorySensitivityCategories(memory).map((category) => MEMORY_SENSITIVITY_LABELS[category]).join(" · ");
}

function sensitivityTone(memory: MemoryView): "normal" | "elevated" | "blocked" {
  if (hasForbiddenSensitivity(memory)) return "blocked";
  return hasElevatedSensitivity(memory) ? "elevated" : "normal";
}

const cloneMemoryPolicy = (value: MemoryPolicyPreview): MemoryPolicyPreview => ({ ...value });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumFromLabel<T extends string>(value: unknown, labels: Record<T, string>, fallback: T): T {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  const match = (Object.entries(labels) as Array<[T, string]>).find(([key, label]) => (
    key.toLowerCase() === normalized || label.toLowerCase() === normalized
  ));
  return match?.[0] ?? fallback;
}

function normalizeImportedMemory(value: unknown, index: number): MemoryView | null {
  if (!isRecord(value)) return null;
  const content = typeof value.content === "string" ? value.content.trim() : "";
  if (!content) return null;
  const rawSensitivity = Array.isArray(value.sensitivity)
    ? value.sensitivity
    : typeof value.sensitivity === "string"
      ? [value.sensitivity]
      : ["normal"];
  const sensitivity = rawSensitivity.filter(isMemorySensitivity);
  const confidenceValue = value.confidence;
  const confidence = confidenceValue === null || confidenceValue === undefined
    ? null
    : typeof confidenceValue === "number" && Number.isFinite(confidenceValue)
      ? Math.min(1, Math.max(0, confidenceValue))
      : null;
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : `imported-memory-${index + 1}`,
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : null,
    content,
    scopeLabel: typeof value.scope === "string" && value.scope.trim()
      ? value.scope.trim()
      : typeof value.scopeLabel === "string" && value.scopeLabel.trim()
        ? value.scopeLabel.trim()
        : "Imported",
    kind: enumFromLabel(value.kind, kindLabels, "preference"),
    status: enumFromLabel(value.status, statusLabels, "suggested"),
    origin: value.origin === "explicit" || value.origin === "inferred" || value.origin === "imported"
      ? value.origin
      : "imported",
    confidence,
    sensitivity: sensitivity.length > 0 ? [...new Set(sensitivity)] : ["normal"],
    sourceLabel: typeof value.source === "string" && value.source.trim()
      ? value.source.trim()
      : typeof value.sourceLabel === "string" && value.sourceLabel.trim()
        ? value.sourceLabel.trim()
        : "Portable memory import",
    lastUsedLabel: typeof value.lastUsed === "string"
      ? value.lastUsed
      : typeof value.lastUsedLabel === "string"
        ? value.lastUsedLabel
        : null,
    expiresAt: typeof value.expiresAt === "string" && value.expiresAt.trim() ? value.expiresAt.trim() : null,
  };
}

function parseMemoryImport(payload: string, format: MemoryImportFormat): { entries: MemoryView[]; errors: string[] } {
  const raw = payload.replace(/^\uFEFF/, "").trim();
  if (!raw) return { entries: [], errors: ["Paste a JSON bundle or Markdown memory list before parsing."] };

  if (format === "json") {
    try {
      const parsed: unknown = JSON.parse(raw);
      const values = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.entries)
          ? parsed.entries
          : [];
      const entries = values.map((value, index) => normalizeImportedMemory(value, index)).filter((value): value is MemoryView => value !== null);
      const errors = values.length > entries.length
        ? [`Skipped ${values.length - entries.length} invalid JSON entr${values.length - entries.length === 1 ? "y" : "ies"}.`]
        : [];
      if (values.length === 0) errors.push("JSON must contain an entries array or be an array of memory records.");
      return { entries, errors };
    } catch {
      return { entries: [], errors: ["That JSON payload could not be parsed."] };
    }
  }

  const entries: MemoryView[] = [];
  const errors: string[] = [];
  payload.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">")) return;
    if (!trimmed.startsWith("- ")) {
      errors.push(`Skipped an invalid Markdown entry on line ${index + 1}.`);
      return;
    }
    const generated = trimmed.match(/^- \*\*(.+?)\*\*\s+—\s+(.+?)\s+·\s+(.+?)\s+·\s+(.+?)\s+·\s+(.+?)(?:\s+·\s+(.+))?$/);
    if (!generated) {
      errors.push(`Skipped an invalid Markdown entry on line ${index + 1}.`);
      return;
    }
    const content = generated[1]?.trim();
    if (!content) return;
    const entry = normalizeImportedMemory({
      id: `imported-memory-${index + 1}`,
      content,
      scope: generated?.[2] ?? "Imported",
      kind: generated?.[3] ?? "preference",
      status: generated?.[4] ?? "suggested",
      origin: "imported",
      confidence: generated?.[5]?.toLowerCase() === "explicit"
        ? null
        : generated?.[5]?.endsWith("%")
          ? Number.parseFloat(generated[5]) / 100
          : null,
      sensitivity: generated?.[6]
        ? generated[6].split(/\s*[·,]\s*/).map((value) => value.trim().toLowerCase().replaceAll(" ", "-")).filter(isMemorySensitivity)
        : ["normal"],
      source: "Portable Markdown import",
    }, index);
    if (entry) entries.push(entry); else errors.push(`Skipped an invalid Markdown entry on line ${index + 1}.`);
  });
  if (entries.length === 0) errors.push("Markdown import expects one memory per bullet line.");
  return { entries, errors };
}

async function readMemoryImportFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read memory import file."));
    reader.readAsText(file);
  });
}

function percent(value: number | null): string {
  return value === null ? "Explicit" : `${Math.round(value * 100)}%`;
}

function serializeMemoryPreview(memories: MemoryView[], format: MemoryExportFormat): string {
  if (format === "markdown") {
    const rows = memories.map((memory) => `- **${memory.content}** — ${memory.scopeLabel} · ${kindLabels[memory.kind]} · ${statusLabels[memory.status]} · ${percent(memory.confidence)} · ${sensitivitySummary(memory)}`);
    return [
      "# Omnia memory preview",
      "",
      "> Renderer-local preview. This file is not durable memory and does not trigger retrieval.",
      "",
      ...rows,
    ].join("\n");
  }

  return JSON.stringify({
    schema: "omnia.memory-preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    entries: memories.map((memory) => ({
      id: memory.id,
      title: memory.title ?? null,
      content: memory.content,
      scope: memory.scopeLabel,
      kind: memory.kind,
      status: memory.status,
      origin: memory.origin,
      confidence: memory.confidence,
      sensitivity: [...memorySensitivityCategories(memory)],
      source: memory.sourceLabel,
      lastUsed: memory.lastUsedLabel,
      expiresAt: memory.expiresAt ?? null,
    })),
  }, null, 2);
}

function downloadMemoryPreview(payload: string, format: MemoryExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-memory-renderer-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function MemoryKindIcon({ kind }: { readonly kind: MemoryView["kind"] }) {
  return <span className={`memory-studio__kind memory-studio__kind--${kind}`} aria-hidden="true"><BrainCircuit size={16} /></span>;
}

function Boundary({ children }: { readonly children: React.ReactNode }) {
  return <p className="memory-studio__boundary"><LockKeyhole size={14} /><span>{children}</span></p>;
}

function MemorySurfaceLoading({ label }: { readonly label: string }) {
  return (
    <div className="settings-surface-loading memory-studio__surface-loading" role="status" aria-live="polite">
      <span className="settings-surface-loading__dot" aria-hidden="true" />
      <span><strong>{label}</strong><small>Opening this renderer-local workbench…</small></span>
    </div>
  );
}

function MemoryLazySurface<Props extends object>({
  label,
  load,
  props,
}: {
  readonly label: string;
  readonly load: () => Promise<MemoryLazySurfaceModule<Props>>;
  readonly props: Props;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const Surface = useMemo(() => lazy(load), [load, retryKey]);

  if (dismissed) return null;

  return (
    <LazyLoadBoundary
      label={label}
      resetKey={`${label}:${retryKey}`}
      onDismiss={() => setDismissed(true)}
      onRetry={() => setRetryKey((value) => value + 1)}
    >
      <Suspense fallback={<MemorySurfaceLoading label={label} />}>
        <Surface {...props} />
      </Suspense>
    </LazyLoadBoundary>
  );
}

export default function MemoryScreen({ runtime }: Partial<ActivityScreenProps>) {
  const memories = useWorkspaceStore((state) => state.memories);
  const [importedMemories, setImportedMemories] = useState<MemoryView[]>([]);
  const [tab, setTab] = useState<MemoryTab>("overview");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(memories[0]?.id ?? null);
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<Set<string>>(() => new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());
  const [localArchivedIds, setLocalArchivedIds] = useState<Set<string>>(() => new Set());
  const [localMemoryStates, setLocalMemoryStates] = useState<Record<string, LocalMemoryState>>({});
  const [policyHistory, setPolicyHistory] = useState<MemoryPolicyHistory>(() => ({
    past: [],
    present: cloneMemoryPolicy(DEFAULT_MEMORY_POLICY),
    future: [],
  }));
  const [policyHistoryStatus, setPolicyHistoryStatus] = useState("Policy changes stay in this renderer preview.");
  const [notice, setNotice] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<MemoryExportFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportStatus, setExportStatus] = useState("Filtered entries are ready for a renderer-local preview.");
  const [importOpen, setImportOpen] = useState(false);
  const [importFormat, setImportFormat] = useState<MemoryImportFormat>("json");
  const [importDraft, setImportDraft] = useState("");
  const [importPreview, setImportPreview] = useState<MemoryView[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importStatus, setImportStatus] = useState("Paste a JSON bundle or Markdown memory list to preview it here.");
  const [draftOpen, setDraftOpen] = useState(false);
  const [editingMemory, setEditingMemory] = useState<MemoryView | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const diagnosticsRuntime: AppRuntimeInfo = runtime ?? {
    appName: "Omnia",
    appVersion: "0.1.0",
    platform: "web",
    tauri: false,
    debug: true,
  };

  const allMemories = useMemo(() => [...memories, ...importedMemories], [importedMemories, memories]);

  const { includeSuggested, confidenceFloor, showArchived, sensitivityMode } = policyHistory.present;
  const activePreset = MEMORY_POLICY_PRESETS.find((preset) => (
    preset.policy.includeSuggested === includeSuggested
    && preset.policy.confidenceFloor === confidenceFloor
    && preset.policy.showArchived === showArchived
    && preset.policy.sensitivityMode === sensitivityMode
  ))?.id ?? null;

  const scopes = useMemo(() => Array.from(new Set(allMemories.map((memory) => memory.scopeLabel))).sort(), [allMemories]);
  const filteredMemories = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return allMemories
      .filter((memory) => showArchived || memory.status !== "archived")
      .filter((memory) => showArchived || !localArchivedIds.has(memory.id))
      .filter((memory) => includeSuggested || memory.status !== "suggested")
      .filter((memory) => sensitivityMode !== "exclude" || !hasElevatedSensitivity(memory))
      .filter((memory) => scope === "all" || memory.scopeLabel === scope)
      .filter((memory) => kind === "all" || memory.kind === kind)
      .filter((memory) => status === "all" || memory.status === status)
      .filter((memory) => memory.confidence === null || memory.confidence >= confidenceFloor)
      .filter((memory) => !normalized || `${memory.content} ${memory.scopeLabel} ${memory.sourceLabel} ${memory.kind}`.toLowerCase().includes(normalized))
      .sort((left, right) => Number(pinnedIds.has(right.id)) - Number(pinnedIds.has(left.id)));
  }, [allMemories, confidenceFloor, includeSuggested, kind, localArchivedIds, pinnedIds, query, scope, sensitivityMode, showArchived, status]);

  const visibleMemoryIds = useMemo(() => new Set(filteredMemories.map((memory) => memory.id)), [filteredMemories]);
  const selectedVisibleMemoryIds = useMemo(
    () => new Set([...selectedMemoryIds].filter((id) => visibleMemoryIds.has(id))),
    [selectedMemoryIds, visibleMemoryIds],
  );

  const retrievableMemories = useMemo(
    () => filteredMemories.filter((memory) => localMemoryStates[memory.id] === undefined)
      .filter((memory) => !hasForbiddenSensitivity(memory))
      .filter((memory) => sensitivityMode !== "review" || !hasElevatedSensitivity(memory)),
    [filteredMemories, localMemoryStates, sensitivityMode],
  );

  const selected = filteredMemories.find((memory) => memory.id === selectedId)
    ?? allMemories.find((memory) => memory.id === selectedId)
    ?? filteredMemories[0]
    ?? null;

  const activeCount = allMemories.filter((memory) => memory.status === "active" && !localArchivedIds.has(memory.id) && localMemoryStates[memory.id] === undefined).length;
  const suggestedCount = allMemories.filter((memory) => memory.status === "suggested" && localMemoryStates[memory.id] === undefined).length;
  const scopedCount = new Set(allMemories.map((memory) => memory.scopeLabel)).size;
  const confidentCount = allMemories.filter((memory) => memory.confidence !== null && memory.confidence >= 0.8 && localMemoryStates[memory.id] === undefined).length;
  const hiddenByPolicyCount = Math.max(0, allMemories.length - filteredMemories.length);
  const localSuppressedCount = filteredMemories.length - retrievableMemories.length;
  const sensitivityHeldCount = sensitivityMode === "review"
    ? allMemories.filter((memory) => hasElevatedSensitivity(memory) && !hasForbiddenSensitivity(memory)).length
    : 0;
  const forbiddenSensitivityCount = allMemories.filter(hasForbiddenSensitivity).length;

  const announce = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2600);
  };

  const updatePolicy = (patch: Partial<MemoryPolicyPreview>) => {
    const next = { ...policyHistory.present, ...patch };
    if (
      next.includeSuggested === policyHistory.present.includeSuggested
      && next.confidenceFloor === policyHistory.present.confidenceFloor
      && next.showArchived === policyHistory.present.showArchived
      && next.sensitivityMode === policyHistory.present.sensitivityMode
    ) return;
    setPolicyHistory((current) => ({
      past: [...current.past, cloneMemoryPolicy(current.present)],
      present: cloneMemoryPolicy(next),
      future: [],
    }));
    setPolicyHistoryStatus("Memory retrieval policy changed in the renderer preview.");
  };

  const undoPolicy = () => {
    setPolicyHistory((current) => {
      const snapshot = current.past.at(-1);
      if (!snapshot) return current;
      return {
        past: current.past.slice(0, -1),
        present: cloneMemoryPolicy(snapshot),
        future: [cloneMemoryPolicy(current.present), ...current.future],
      };
    });
    setPolicyHistoryStatus("Undid the last memory policy preview change.");
  };

  const redoPolicy = () => {
    setPolicyHistory((current) => {
      const snapshot = current.future[0];
      if (!snapshot) return current;
      return {
        past: [...current.past, cloneMemoryPolicy(current.present)],
        present: cloneMemoryPolicy(snapshot),
        future: current.future.slice(1),
      };
    });
    setPolicyHistoryStatus("Reapplied the next memory policy preview change.");
  };

  const resetPolicy = () => {
    if (
      includeSuggested === DEFAULT_MEMORY_POLICY.includeSuggested
      && confidenceFloor === DEFAULT_MEMORY_POLICY.confidenceFloor
      && showArchived === DEFAULT_MEMORY_POLICY.showArchived
      && sensitivityMode === DEFAULT_MEMORY_POLICY.sensitivityMode
    ) {
      setPolicyHistoryStatus("Memory policy preview is already at its defaults.");
      return;
    }
    setPolicyHistory((current) => ({
      past: [...current.past, cloneMemoryPolicy(current.present)],
      present: cloneMemoryPolicy(DEFAULT_MEMORY_POLICY),
      future: [],
    }));
    setPolicyHistoryStatus("Memory policy preview reset to defaults.");
  };

  const applyPolicyPreset = (preset: MemoryPolicyPreset) => {
    updatePolicy(preset.policy);
    setPolicyHistoryStatus(`${preset.label} memory policy preview selected.`);
  };

  const selectAdjacentTab = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex]![0];
    setTab(nextTab);
    document.getElementById(`memory-studio-tab-${nextTab}`)?.focus();
  };

  const togglePinned = (id: string) => {
    setPinnedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleArchived = (id: string) => {
    setLocalArchivedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    announce("Archive state changed in this renderer preview only.");
  };

  const togglePaused = (id: string) => {
    setLocalMemoryStates((current) => {
      const next = { ...current };
      if (next[id] === "paused") delete next[id];
      else next[id] = "paused";
      return next;
    });
    announce(localMemoryStates[id] === "paused"
      ? "Memory resumed in this renderer preview only."
      : "Memory paused in this renderer preview only.");
  };

  const toggleForgotten = (id: string) => {
    setLocalMemoryStates((current) => {
      const next = { ...current };
      if (next[id] === "forgotten") delete next[id];
      else next[id] = "forgotten";
      return next;
    });
    announce(localMemoryStates[id] === "forgotten"
      ? "Memory content restored in this renderer preview only."
      : "Memory content hidden in this renderer preview only; source records are unchanged.");
  };

const resetFilters = () => {
    setQuery("");
    setScope("all");
    setKind("all");
    setStatus("all");
    updatePolicy({ confidenceFloor: 0, showArchived: false, includeSuggested: true, sensitivityMode: "review" });
  };

  const toggleMemorySelection = (id: string) => {
    setSelectedMemoryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectVisibleMemories = () => {
    setSelectedMemoryIds((current) => new Set([...current, ...visibleMemoryIds]));
    announce(`Selected ${visibleMemoryIds.size} visible memory ${visibleMemoryIds.size === 1 ? "entry" : "entries"} in this renderer preview.`);
  };

  const clearVisibleMemorySelection = () => {
    setSelectedMemoryIds((current) => new Set([...current].filter((id) => !visibleMemoryIds.has(id))));
    announce("Cleared visible memory selection in this renderer preview.");
  };

  const [exportSelectionOnly, setExportSelectionOnly] = useState(false);
  const exportMemories = useMemo(
    () => filteredMemories.filter((memory) => localMemoryStates[memory.id] === undefined)
      .filter((memory) => !exportSelectionOnly || selectedMemoryIds.has(memory.id)),
    [exportSelectionOnly, filteredMemories, localMemoryStates, selectedMemoryIds],
  );
  const exportPayload = useMemo(() => serializeMemoryPreview(exportMemories, exportFormat), [exportFormat, exportMemories]);

  const copyExportPreview = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no memory preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`Copied ${exportMemories.length} renderer-local memory entries as ${exportFormat.toUpperCase()}.`);
    } catch {
      setExportStatus("Clipboard access was denied; no memory preview was copied.");
    }
  };

  const downloadExportPreview = () => {
    setExportStatus(
      downloadMemoryPreview(exportPayload, exportFormat)
        ? `Downloaded ${exportMemories.length} renderer-local memory entries. Durable memory was not changed.`
        : "File download is unavailable in this surface; no memory preview was exported.",
    );
  };

  const openImportPreview = () => {
    setTab("entries");
    setImportOpen(true);
    setImportStatus("Paste a JSON bundle or Markdown memory list to preview it here.");
  };

  const parseImportPreview = () => {
    const parsed = parseMemoryImport(importDraft, importFormat);
    setImportPreview(parsed.entries);
    setImportErrors(parsed.errors);
    setImportStatus(parsed.entries.length > 0
      ? `Parsed ${parsed.entries.length} memory ${parsed.entries.length === 1 ? "entry" : "entries"}; nothing is stored yet.`
      : "No valid memory entries were found; no preview was changed.");
  };

  const stageImportPreview = () => {
    if (importPreview.length === 0) return;
    const usedIds = new Set(allMemories.map((memory) => memory.id));
    const staged = importPreview.map((memory, index) => {
      if (!usedIds.has(memory.id)) {
        usedIds.add(memory.id);
        return memory;
      }
      let id = `${memory.id}-import-${index + 1}`;
      let suffix = index + 1;
      while (usedIds.has(id)) {
        suffix += 1;
        id = `${memory.id}-import-${suffix}`;
      }
      usedIds.add(id);
      return { ...memory, id };
    });
    setImportedMemories((current) => [...current, ...staged]);
    setImportPreview([]);
    setImportStatus(`Staged ${staged.length} imported ${staged.length === 1 ? "entry" : "entries"} in this renderer preview; native memory is unchanged.`);
    announce("Imported memory entries are staged in this renderer preview only.");
  };

  const clearImportPreview = () => {
    setImportDraft("");
    setImportPreview([]);
    setImportErrors([]);
    setImportStatus("Import preview cleared; no durable memory changed.");
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 512_000) {
      setImportStatus("Import is limited to 512 KB; no memory preview was changed.");
      return;
    }
    try {
      const content = await readMemoryImportFile(file);
      const format: MemoryImportFormat = /\.md(?:own)?$/i.test(file.name) ? "markdown" : "json";
      setImportFormat(format);
      setImportDraft(content);
      setImportStatus(`Loaded ${file.name}; parse it to inspect the renderer-local import preview.`);
      setImportErrors([]);
      setImportPreview([]);
    } catch {
      setImportStatus("The memory import file could not be read; no preview was changed.");
    }
  };

  const openMemoryDraft = (memory: MemoryView | null = null) => {
    setEditingMemory(memory);
    setDraftOpen(true);
    setTab("entries");
  };

  const stageMemoryDraft = (memory: MemoryView, originalId: string | null) => {
    const wasEditedImportedEntry = Boolean(originalId && importedMemories.some((entry) => entry.id === originalId));
    const usedIds = new Set([...allMemories.map((entry) => entry.id), ...importedMemories.map((entry) => entry.id)]);
    let stagedId = wasEditedImportedEntry && originalId ? originalId : `memory-draft-${usedIds.size + 1}`;
    while (!wasEditedImportedEntry && usedIds.has(stagedId)) stagedId = `${stagedId}-copy`;
    setImportedMemories((current) => {
      if (wasEditedImportedEntry && originalId) {
        return current.map((entry) => entry.id === originalId ? { ...memory, id: originalId, origin: "imported", sourceLabel: "Memory draft preview" } : entry);
      }
      return [...current, { ...memory, id: stagedId, origin: "imported", sourceLabel: "Memory draft preview" }];
    });
    setSelectedId(stagedId);
    setDraftOpen(false);
    setEditingMemory(null);
    announce(wasEditedImportedEntry ? "Edited memory staged in this renderer preview only." : "Memory draft staged in this renderer preview only.");
  };

  return (
    <div className="screen-scroll">
      <ScreenHeader
        title="Memory Studio"
        action={
          <>
            <button type="button" className="button button--secondary" title="Create a renderer-local memory draft" onClick={() => openMemoryDraft()} aria-expanded={draftOpen} aria-controls="memory-draft-studio">
              <Plus size={16} /> Add memory preview
            </button>
            <button type="button" className="button button--ghost" title="Preview a memory import without durable writes" onClick={openImportPreview} aria-expanded={importOpen} aria-controls="memory-import-preview">
              <Upload size={15} /> Preview import
            </button>
          </>
        }
      />

      <section className="memory-studio" aria-label="Memory studio preview">
        <div className="memory-studio__metrics" role="status" aria-label="Memory summary">
          <div><strong>{activeCount}</strong><span>active</span></div>
          <div><strong>{suggestedCount}</strong><span>suggested</span></div>
          <div><strong>{scopedCount}</strong><span>scopes</span></div>
          <div><strong>{confidentCount}</strong><span>high confidence</span></div>
        </div>

        <nav className="memory-studio__tabs" role="tablist" aria-label="Memory studio views">
          {tabs.map(([id, label, Icon]) => (
            <button
              key={id}
              id={`memory-studio-tab-${id}`}
              type="button"
              role="tab"
              title={`Open Memory Studio ${label} view`}
              aria-selected={tab === id}
              aria-controls={`memory-studio-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
              onKeyDown={(event) => selectAdjacentTab(event, tabs.findIndex(([tabId]) => tabId === id))}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </nav>

        {notice ? <div className="memory-studio__notice" role="status" aria-live="polite"><Check size={14} /> {notice}</div> : null}

        {draftOpen ? (
          <MemoryLazySurface
            key={editingMemory?.id ?? "new-memory-draft"}
            label="Memory draft"
            load={loadMemoryDraftStudio}
            props={{
              initialMemory: editingMemory,
              existingScopes: scopes,
              onClose: () => { setDraftOpen(false); setEditingMemory(null); },
              onStage: stageMemoryDraft,
            }}
          />
        ) : null}

        {diagnosticsOpen ? (
          <MemoryLazySurface
            label="Memory diagnostics"
            load={loadMemoryDiagnosticsPreview}
            props={{
              runtime: diagnosticsRuntime,
              allMemories,
              visibleMemories: filteredMemories,
              retrievableMemories,
              locallySuppressedCount: localSuppressedCount,
              importedCount: importedMemories.length,
              onClose: () => setDiagnosticsOpen(false),
            }}
          />
        ) : null}

        <div id={`memory-studio-panel-${tab}`} role="tabpanel" className="memory-studio__panel" aria-labelledby={`memory-studio-tab-${tab}`} tabIndex={0}>
          {tab === "overview" ? (
            <div className="memory-studio__overview">
              <div className="memory-studio__section-heading"><h3 className="ws-section-label">What would be retrieved next</h3><button type="button" className="button button--ghost" title="Open every visible memory entry" onClick={() => setTab("entries")}>Open all entries <Database size={14} /></button></div>
              <div className="memory-studio__recent-list">
                {retrievableMemories.slice(0, 3).map((memory) => (
                  <button key={memory.id} type="button" className="memory-studio__recent" onClick={() => { setSelectedId(memory.id); setTab("entries"); }}>
                    <MemoryKindIcon kind={memory.kind} /><span><strong>{memory.content}</strong><small>{memory.scopeLabel} · {statusLabels[memory.status]} · {percent(memory.confidence)}</small></span><Bookmark size={14} className={pinnedIds.has(memory.id) ? "is-active" : ""} />
                  </button>
                ))}
              </div>
              <details className="ws-disclosure">
                <summary>How memory is governed</summary>
                <div className="ws-disclosure__body">
                  <div className="memory-studio__overview-grid">
                    <article className="memory-studio__policy-card">
                      <ShieldCheck size={18} />
                      <div><strong>Approval gate</strong><p>Suggested memories remain proposals until a native approval decision exists.</p></div>
                      <span className="memory-studio__chip memory-studio__chip--amber">Required</span>
                    </article>
                    <article className="memory-studio__policy-card">
                      <Eye size={18} />
                      <div><strong>Retrieval visibility</strong><p>Every entry keeps scope, origin, confidence, and source labels visible.</p></div>
                      <span className="memory-studio__chip memory-studio__chip--teal">Inspectable</span>
                    </article>
                    <article className="memory-studio__policy-card">
                      <Archive size={18} />
                      <div><strong>Retention controls</strong><p>Expiry and deletion are designed here; native durable mutation is not enabled.</p></div>
                      <span className="memory-studio__chip">Planned</span>
                    </article>
                  </div>
                </div>
              </details>
            </div>
          ) : null}

          {tab === "proposals" ? (
            <>
              <MemoryLazySurface label="Memory review cockpit" load={loadMemoryReviewWorkbench} props={{}} />
              <MemoryProposalInbox />
              <MemoryLazySurface label="Memory provenance and revision inspector" load={loadMemoryProvenanceRevisionInspector} props={{}} />
            </>
          ) : null}

          {tab === "entries" ? (
            <div className="memory-studio__entries">
              <div className="memory-studio__controls">
                <label className="memory-studio__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search content, scope, or source" aria-label="Search memory entries" /></label>
                <label><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">All scopes</option>{scopes.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                <label><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value as KindFilter)}><option value="all">All kinds</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}><option value="all">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <button type="button" className="button button--ghost" onClick={resetFilters} title="Reset renderer filters"><RotateCcw size={14} /> Reset</button>
                <button type="button" className="button button--secondary" onClick={() => setExportOpen((current) => !current)} aria-expanded={exportOpen} aria-controls="memory-export-preview"><FileJson2 size={14} /> {exportOpen ? "Hide export" : "Preview export"}</button>
              </div>
              <div className="memory-studio__selection-toolbar" role="toolbar" aria-label="Memory entry selection actions">
                <span><strong>{selectedVisibleMemoryIds.size}</strong> selected in this view <small>{selectedMemoryIds.size > selectedVisibleMemoryIds.size ? `· ${selectedMemoryIds.size - selectedVisibleMemoryIds.size} hidden` : ""}</small></span>
                <div>
                  <button type="button" className="button button--ghost" title="Select every memory entry currently visible after filtering" onClick={selectVisibleMemories} disabled={visibleMemoryIds.size === 0}>Select visible</button>
                  <button type="button" className="button button--ghost" title="Clear selection for memory entries currently visible after filtering" onClick={clearVisibleMemorySelection} disabled={selectedVisibleMemoryIds.size === 0}>Clear visible</button>
                </div>
              </div>
              {importOpen ? (
                <section id="memory-import-preview" className="memory-studio__import-preview" aria-label="Memory import preview">
                  <header>
                    <h3 className="ws-section-label">Inspect before staging memory</h3>
                    <div className="memory-studio__import-heading-actions"><span className="memory-studio__chip memory-studio__chip--teal">No durable write</span><button type="button" className="button button--ghost" title="Close the renderer-local memory import preview" onClick={() => setImportOpen(false)}>Close</button></div>
                  </header>
                  <div className="memory-studio__import-toolbar" role="toolbar" aria-label="Memory import preview actions">
                    <label><span>Format</span><select value={importFormat} onChange={(event) => setImportFormat(event.target.value as MemoryImportFormat)} aria-label="Memory import format"><option value="json">JSON bundle</option><option value="markdown">Markdown list</option></select></label>
                    <label className="memory-studio__import-file"><span>File</span><input type="file" accept=".json,.md,.markdown,application/json,text/markdown" aria-label="Choose memory import file" onChange={(event) => void handleImportFile(event)} /></label>
                    <button type="button" className="button button--secondary" title="Validate the memory import payload without storing it" onClick={parseImportPreview}><Eye size={14} /> Parse preview</button>
                    <button type="button" className="button button--ghost" title="Clear the import draft and parsed preview" onClick={clearImportPreview}><RotateCcw size={14} /> Clear</button>
                  </div>
                  <textarea value={importDraft} onChange={(event) => setImportDraft(event.target.value)} rows={7} aria-label="Memory import payload" placeholder={importFormat === "json" ? '{"entries":[{"content":"Prefer concise reports","scope":"Global","kind":"preference"}]}' : "- **Prefer concise reports** — Global · Preference · Suggested · 90%"} />
                  <div className="memory-studio__import-status" role="status" aria-live="polite"><Upload size={14} /> {importStatus}</div>
                  {importErrors.length > 0 ? <ul className="memory-studio__import-errors" aria-label="Memory import warnings">{importErrors.map((error) => <li key={error}>{error}</li>)}</ul> : null}
                  {importPreview.length > 0 ? (
                    <div className="memory-studio__import-result">
                      <div><strong>{importPreview.length} valid {importPreview.length === 1 ? "entry" : "entries"} ready</strong><small>Stage adds them to this renderer session only.</small></div>
                      <button type="button" className="button button--secondary" title="Add parsed entries to this renderer session only" onClick={stageImportPreview}><Check size={14} /> Stage in preview</button>
                    </div>
                  ) : null}
                  <Boundary>Import parsing validates a local preview only. It does not approve, upload, persist, or activate memory; native retrieval remains unavailable.</Boundary>
                </section>
              ) : null}
              {exportOpen ? (
                <section id="memory-export-preview" className="memory-studio__export-preview" aria-label="Memory export preview">
                  <header><h3 className="ws-section-label">{exportMemories.length} exportable entries</h3><span className="memory-studio__chip memory-studio__chip--teal">No durable write</span></header>
                  <div className="memory-studio__export-toolbar" role="toolbar" aria-label="Memory export preview actions">
                    <label><span>Format</span><select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as MemoryExportFormat)} aria-label="Memory export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
                    <label><span>Rows</span><select value={exportSelectionOnly ? "selected" : "filtered"} onChange={(event) => setExportSelectionOnly(event.target.value === "selected")} aria-label="Memory export rows"><option value="filtered">Filtered view</option><option value="selected" disabled={selectedMemoryIds.size === 0}>Selected rows ({selectedMemoryIds.size})</option></select></label>
                    <span className="memory-studio__export-status" role="status" aria-live="polite">{exportStatus}</span>
                    <button type="button" className="button button--ghost" title="Copy the visible memory export preview" onClick={() => void copyExportPreview()}><Clipboard size={14} /> Copy</button>
                    <button type="button" className="button button--secondary" title="Download the visible memory export preview" onClick={downloadExportPreview}><Download size={14} /> Download</button>
                  </div>
                  <pre className="memory-studio__export-code" tabIndex={0}><code>{exportPayload}</code></pre>
                  <Boundary>{exportSelectionOnly ? "This preview serializes only the selected renderer rows." : "This preview serializes only the currently filtered renderer data."} It does not approve, upload, persist, or activate memory.</Boundary>
                </section>
              ) : null}
              <div className="memory-studio__entry-layout">
                <div className="memory-studio__list" role="list" aria-label="Memory entries">
                  {filteredMemories.length === 0 ? <div className="memory-studio__empty"><Filter size={20} /><strong>No entries match</strong><span>Adjust the filters or reset the renderer preview.</span></div> : null}
                  {filteredMemories.map((memory) => (
                    <div key={memory.id} role="listitem" className="memory-studio__entry-row">
                      <input type="checkbox" checked={selectedMemoryIds.has(memory.id)} onChange={() => toggleMemorySelection(memory.id)} aria-label={`Select memory ${memory.content}`} />
                      <button type="button" aria-pressed={memory.id === selected?.id} className={`memory-studio__entry${memory.id === selected?.id ? " memory-studio__entry--selected" : ""}`} onClick={() => setSelectedId(memory.id)}>
                        <MemoryKindIcon kind={memory.kind} />
                        <span className="memory-studio__entry-copy"><strong>{localMemoryStates[memory.id] === "forgotten" ? "Content hidden after local forget" : memory.content}</strong><small>{memory.scopeLabel} · {kindLabels[memory.kind]}</small><span className="memory-studio__badges"><em className={`memory-studio__chip memory-studio__chip--${memory.status}`}>{statusLabels[memory.status]}</em><em className={`memory-studio__chip memory-studio__chip--sensitivity-${sensitivityTone(memory)}`}>{sensitivitySummary(memory)}</em>{localMemoryStates[memory.id] ? <em className="memory-studio__chip memory-studio__chip--amber">{localMemoryStates[memory.id] === "paused" ? "Paused in preview" : "Forgotten in preview"}</em> : null}{memory.confidence !== null ? <em className="memory-studio__chip">{percent(memory.confidence)}</em> : <em className="memory-studio__chip">Explicit</em>}</span></span>
                        <Bookmark size={14} className={pinnedIds.has(memory.id) ? "is-active" : ""} />
                      </button>
                    </div>
                  ))}
                </div>
                <aside className="memory-studio__detail" aria-label="Selected memory details">
                  {selected ? (
                    <>
                      <div className="memory-studio__detail-heading"><h3 className="ws-section-label">{kindLabels[selected.kind]}</h3><MemoryKindIcon kind={selected.kind} /></div>
                      {selected.title ? <strong className="memory-studio__detail-title">{selected.title}</strong> : null}
                      <p className="memory-studio__detail-content">{localMemoryStates[selected.id] === "forgotten" ? "Content hidden after local forget preview." : selected.content}</p>
                      <dl className="memory-studio__facts"><div><dt>Scope</dt><dd>{selected.scopeLabel}</dd></div><div><dt>Status</dt><dd>{localMemoryStates[selected.id] === "paused" ? "Paused in preview" : localMemoryStates[selected.id] === "forgotten" ? "Forgotten in preview" : statusLabels[selected.status]}</dd></div><div><dt>Sensitivity</dt><dd>{sensitivitySummary(selected)}{hasForbiddenSensitivity(selected) ? " · blocked" : sensitivityMode === "review" && hasElevatedSensitivity(selected) ? " · review required" : ""}</dd></div><div><dt>Origin</dt><dd>{selected.origin}</dd></div><div><dt>Confidence</dt><dd>{percent(selected.confidence)}</dd></div><div><dt>Last used</dt><dd>{selected.lastUsedLabel ?? "Not retrieved"}</dd></div><div><dt>Expiry</dt><dd>{selected.expiresAt ?? "No expiry"}</dd></div></dl>
                      <div className="memory-studio__provenance"><div><History size={14} /><span><strong>Provenance</strong><small>{selected.sourceLabel}</small></span></div><span className="memory-studio__chip">Renderer snapshot</span></div>
                      <div className="memory-studio__actions"><button type="button" className="button button--secondary" title={`${pinnedIds.has(selected.id) ? "Remove the local pin from" : "Pin"} ${selected.content}`} onClick={() => togglePinned(selected.id)}><Pin size={14} /> {pinnedIds.has(selected.id) ? "Unpin" : "Pin locally"}</button><button type="button" className="button button--ghost" title={`Open ${selected.content} in the renderer-local memory draft`} onClick={() => openMemoryDraft(selected)}><Plus size={14} /> Edit in preview</button><button type="button" className="button button--ghost" title={`${localArchivedIds.has(selected.id) ? "Restore" : "Archive"} this memory entry in the renderer preview`} onClick={() => toggleArchived(selected.id)}><Archive size={14} /> {localArchivedIds.has(selected.id) ? "Restore local" : "Archive local"}</button><button type="button" className="button button--ghost" onClick={() => togglePaused(selected.id)} disabled={localMemoryStates[selected.id] === "forgotten"} title={localMemoryStates[selected.id] === "forgotten" ? "Restore forgotten content before pausing" : `${localMemoryStates[selected.id] === "paused" ? "Resume" : "Pause"} this memory in the renderer preview`}><>{localMemoryStates[selected.id] === "paused" ? <Play size={14} /> : <Pause size={14} />}</> {localMemoryStates[selected.id] === "paused" ? "Resume in preview" : "Pause in preview"}</button><button type="button" className="button button--ghost" title={`${localMemoryStates[selected.id] === "forgotten" ? "Restore" : "Forget"} this memory in the renderer preview`} onClick={() => toggleForgotten(selected.id)}><>{localMemoryStates[selected.id] === "forgotten" ? <Undo2 size={14} /> : <Trash2 size={14} />}</> {localMemoryStates[selected.id] === "forgotten" ? "Restore forgotten preview" : "Forget in preview"}</button></div>
                      <Boundary>Pause and forget changes are renderer-local and reversible. Forgetting hides content here; the source conversation and any synced copies remain unchanged.</Boundary>
                    </>
                  ) : <div className="memory-studio__empty"><Database size={20} /><strong>Select an entry</strong><span>Its scope and provenance will appear here.</span></div>}
                </aside>
              </div>
            </div>
          ) : null}

          {tab === "policies" ? (
            <div className="memory-studio__policies">
              <MemoryLazySurface label="Memory scope and mode" load={loadMemoryScopeModePreview} props={{}} />
              <div className="memory-studio__section-heading"><h3 className="ws-section-label">Retrieval policy</h3><span className="memory-studio__chip memory-studio__chip--teal">Renderer-local</span></div>
              <div className="memory-studio__policy-history" role="toolbar" aria-label="Memory policy preview history">
                <span className="memory-studio__policy-history-copy"><strong>Reversible policy preview</strong><small>{policyHistoryStatus}</small></span>
                <span className="memory-studio__policy-history-count" aria-label={`${policyHistory.past.length} undo steps and ${policyHistory.future.length} redo steps`}>
                  {policyHistory.past.length + policyHistory.future.length} steps
                </span>
                <span className="memory-studio__policy-history-actions">
                  <button type="button" className="button button--ghost" onClick={undoPolicy} disabled={policyHistory.past.length === 0} aria-label="Undo memory policy preview change" title="Undo memory policy preview change"><Undo2 size={13} /> Undo</button>
                  <button type="button" className="button button--ghost" onClick={redoPolicy} disabled={policyHistory.future.length === 0} aria-label="Redo memory policy preview change" title="Redo memory policy preview change"><Redo2 size={13} /> Redo</button>
                  <button type="button" className="button button--ghost" onClick={resetPolicy} aria-label="Reset memory policy preview" title="Reset memory policy preview to defaults"><RotateCcw size={13} /> Reset</button>
                </span>
              </div>
              <div className="memory-studio__policy-grid">
                <label className="memory-studio__policy-option"><span><strong>Include suggested entries</strong><small>Show proposals in the next context preview.</small></span><input type="checkbox" checked={includeSuggested} onChange={(event) => updatePolicy({ includeSuggested: event.target.checked })} /></label>
                <label className="memory-studio__policy-option"><span><strong>Require high-confidence retrieval</strong><small>Keep low-confidence inferred memories out of the default route.</small></span><input type="checkbox" checked={confidenceFloor >= 0.8} onChange={(event) => updatePolicy({ confidenceFloor: event.target.checked ? 0.8 : 0 })} /></label>
                <label className="memory-studio__policy-option"><span><strong>Show archived entries</strong><small>Expose locally archived rows for inspection.</small></span><input type="checkbox" checked={showArchived} onChange={(event) => updatePolicy({ showArchived: event.target.checked })} /></label>
              </div>
              <div className="memory-studio__sensitivity-policy" aria-label="Memory sensitivity admission preview">
                <div className="memory-studio__sensitivity-policy-copy"><strong>How should elevated memory rows behave?</strong><small>Personal, financial, and health categories stay visible only as a reviewable renderer projection. Authentication, secret, and private-key categories are always blocked by the domain contract.</small></div>
                <label><span>Admission mode</span><select aria-label="Memory sensitivity admission mode" value={sensitivityMode} onChange={(event) => updatePolicy({ sensitivityMode: event.target.value as MemorySensitivityMode })}><option value="exclude">Exclude elevated rows</option><option value="review">Show, hold for review</option><option value="include">Include in preview route</option></select></label>
                <div className="memory-studio__sensitivity-legend" role="status" aria-label="Memory sensitivity policy summary"><span><strong>{sensitivityHeldCount}</strong> review-held</span><span><strong>{forbiddenSensitivityCount}</strong> domain-blocked</span><span><strong>Sensitive preview {sensitivityMode === "include" ? "included" : sensitivityMode === "exclude" ? "excluded" : "held"}</strong></span></div>
              </div>
              <section className="memory-studio__preset-section" aria-label="Memory policy presets">
                <div className="memory-studio__section-heading memory-studio__section-heading--compact">
                  <h3 className="ws-section-label">Quick presets</h3>
                  <span className="memory-studio__chip">Optional</span>
                </div>
                <div className="memory-studio__preset-grid" role="radiogroup" aria-label="Memory policy presets">
                  {MEMORY_POLICY_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={activePreset === preset.id}
                      className={`memory-studio__preset${activePreset === preset.id ? " memory-studio__preset--active" : ""}`}
                      onClick={() => applyPolicyPreset(preset)}
                    >
                      <span className="memory-studio__preset-heading"><strong>{preset.label}</strong>{activePreset === preset.id ? <CheckCircle2 size={14} /> : null}</span>
                      <small>{preset.description}</small>
                    </button>
                  ))}
                </div>
              </section>
              <div className="memory-studio__range"><label htmlFor="memory-confidence"><span>Minimum confidence: <strong>{Math.round(confidenceFloor * 100)}%</strong></span><input id="memory-confidence" type="range" min="0" max="1" step="0.05" value={confidenceFloor} onChange={(event) => updatePolicy({ confidenceFloor: Number(event.target.value) })} /></label><small>Explicit user memories remain visible even when confidence is not reported.</small></div>
              <div className="memory-studio__policy-summary" role="status" aria-label="Memory policy route summary"><span><strong>{retrievableMemories.length}</strong> eligible in preview</span><span><strong>{hiddenByPolicyCount}</strong> filtered by current policy</span><span><strong>{localSuppressedCount}</strong> paused or forgotten locally</span><span>{activePreset ? `${MEMORY_POLICY_PRESETS.find((preset) => preset.id === activePreset)?.label} preset` : "Custom policy"}</span><span>{sensitivityMode === "include" ? "Sensitive preview included" : sensitivityMode === "exclude" ? "Sensitive preview excluded" : "Sensitive preview held"}</span></div>
               <div className="memory-studio__export-row"><div><Download size={16} /><span><strong>Export current memory view</strong><small>Open a renderer-local preview using the active entry filters.</small></span></div><button type="button" className="button button--ghost" onClick={() => { setTab("entries"); setExportOpen(true); }}><FileJson2 size={14} /> Open preview</button></div>
              <Boundary>Policy changes are renderer-local and reversible for this preview session. They do not write durable memory settings or trigger retrieval.</Boundary>
            </div>
          ) : null}

          {tab === "learning" ? (
            <div className="memory-studio__learning">
              <MemoryLazySurface label="LTST Knowledge Tree & Harnesses" load={loadKnowledgeTreeExplorer} props={{}} />
              <MemoryLazySurface label="Learning loop" load={loadLearningLoopLab} props={{}} />
              <MemoryLazySurface label="Data intake review" load={loadDataIntakeLearningReview} props={{}} />
              <MemoryLazySurface label="Data lineage" load={loadDataLineageStudio} props={{}} />
              <MemoryLazySurface label="Training control" load={loadTrainingControlCenter} props={{}} />
            </div>
          ) : null}

          {tab === "lifecycle" ? (
            <MemoryLazySurface label="Memory lifecycle studio" load={loadMemoryLifecycleStudio} props={{}} />
          ) : null}
        </div>

        <footer className="memory-studio__footer">
          <span><LockKeyhole size={13} /> Native storage, approval, expiry, and import/export remain gated behind the desktop bridge.</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setDiagnosticsOpen((current) => !current)}
            aria-expanded={diagnosticsOpen}
            aria-controls="memory-diagnostics-preview"
            title={diagnosticsOpen ? "Hide memory diagnostics" : "Open memory diagnostics"}
          >
            <Download size={14} /> {diagnosticsOpen ? "Hide diagnostics" : "Open diagnostics"}
          </button>
        </footer>
      </section>
    </div>
  );
}
