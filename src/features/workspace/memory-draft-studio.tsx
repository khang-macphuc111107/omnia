import {
  Check,
  Clipboard,
  Download,
  Eye,
  FileJson2,
  RotateCcw,
  Save,
  Undo2,
  Redo2,
  Upload,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import type { MemorySensitivity, MemoryView } from "./types";

export type MemoryDraftValue = {
  title: string;
  content: string;
  scopeLabel: string;
  kind: MemoryView["kind"];
  status: MemoryView["status"];
  origin: MemoryView["origin"];
  confidence: string;
  sourceLabel: string;
  lastUsedLabel: string;
  expiresAt: string;
  sensitivity: MemorySensitivity[];
};

type DraftHistory = {
  past: MemoryDraftValue[];
  present: MemoryDraftValue;
  future: MemoryDraftValue[];
};

type DraftExportFormat = "json" | "markdown";

const MAX_MEMORY_DRAFT_BYTES = 512 * 1024;

export const MEMORY_DRAFT_SENSITIVITY_OPTIONS: readonly {
  id: MemorySensitivity;
  label: string;
  description: string;
  blocked: boolean;
}[] = [
  { id: "normal", label: "Normal", description: "No additional sensitivity marker.", blocked: false },
  { id: "personal", label: "Personal", description: "Personal preference or identity context.", blocked: false },
  { id: "financial", label: "Financial", description: "Money, account, or transaction context.", blocked: false },
  { id: "health", label: "Health", description: "Health-related or wellbeing context.", blocked: false },
  { id: "authentication", label: "Authentication", description: "Credentials and login material are never stored as memory.", blocked: true },
  { id: "secret", label: "Secret", description: "Secrets are always blocked from memory storage and retrieval.", blocked: true },
  { id: "private-key", label: "Private key", description: "Private keys are always blocked from memory storage and retrieval.", blocked: true },
];

const MEMORY_DRAFT_SENSITIVITY_IDS = new Set<MemorySensitivity>(MEMORY_DRAFT_SENSITIVITY_OPTIONS.map((option) => option.id));
const BLOCKED_MEMORY_DRAFT_SENSITIVITIES = new Set<MemorySensitivity>(["authentication", "secret", "private-key"]);

function isMemorySensitivity(value: unknown): value is MemorySensitivity {
  return typeof value === "string" && MEMORY_DRAFT_SENSITIVITY_IDS.has(value as MemorySensitivity);
}

function normalizeSensitivity(value: unknown): MemorySensitivity[] {
  const raw: MemorySensitivity[] = Array.isArray(value)
    ? value.filter(isMemorySensitivity)
    : typeof value === "string" && isMemorySensitivity(value)
      ? [value as MemorySensitivity]
      : ["normal"];
  const unique: MemorySensitivity[] = [...new Set<MemorySensitivity>(raw)];
  if (unique.length === 0 || unique.includes("normal")) return ["normal"];
  return unique;
}

function sensitivityLabel(value: readonly MemorySensitivity[]): string {
  const labels = new Map(MEMORY_DRAFT_SENSITIVITY_OPTIONS.map((option) => [option.id, option.label]));
  return normalizeSensitivity(value).map((item) => labels.get(item) ?? item).join(" · ");
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asMemoryKind(value: unknown, fallback: MemoryDraftValue["kind"]): MemoryDraftValue["kind"] {
  return typeof value === "string" && value in kindLabels ? value as MemoryDraftValue["kind"] : fallback;
}

function asMemoryStatus(value: unknown, fallback: MemoryDraftValue["status"]): MemoryDraftValue["status"] {
  return typeof value === "string" && value in statusLabels ? value as MemoryDraftValue["status"] : fallback;
}

function asMemoryOrigin(value: unknown, fallback: MemoryDraftValue["origin"]): MemoryDraftValue["origin"] {
  return typeof value === "string" && value in originLabels ? value as MemoryDraftValue["origin"] : fallback;
}

export type MemoryDraftStudioProps = {
  initialMemory?: MemoryView | null;
  existingScopes?: readonly string[];
  onClose: () => void;
  onStage: (memory: MemoryView, originalId: string | null) => void;
};

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

const originLabels: Record<MemoryView["origin"], string> = {
  explicit: "Explicit",
  inferred: "Inferred",
  imported: "Imported",
};

const emptyDraft = (): MemoryDraftValue => ({
  title: "",
  content: "",
  scopeLabel: "Global",
  kind: "preference",
  status: "suggested",
  origin: "explicit",
  confidence: "",
  sourceLabel: "Manual draft",
  lastUsedLabel: "",
  expiresAt: "",
  sensitivity: ["normal"],
});

function memoryToDraft(memory: MemoryView): MemoryDraftValue {
  return {
    title: memory.title ?? "",
    content: memory.content,
    scopeLabel: memory.scopeLabel,
    kind: memory.kind,
    status: memory.status,
    origin: memory.origin,
    confidence: memory.confidence === null ? "" : String(memory.confidence),
    sourceLabel: memory.sourceLabel,
    lastUsedLabel: memory.lastUsedLabel ?? "",
    expiresAt: memory.expiresAt ?? "",
    sensitivity: normalizeSensitivity(memory.sensitivity),
  };
}

function cloneDraft(value: MemoryDraftValue): MemoryDraftValue {
  return { ...value, sensitivity: [...value.sensitivity] };
}

export function parseMemoryDraftPayload(raw: string): MemoryDraftValue {
  const normalized = raw.replace(/^\uFEFF/, "").trim();
  if (!normalized) throw new Error("The selected file is empty.");

  let parsed: unknown;
  const markdownMetadata = normalized.match(/<!--\s*omnia\.memory-draft-preview\.v1\s+([^\s]+)\s*-->/i);
  if (markdownMetadata) {
    try {
      parsed = JSON.parse(decodeURIComponent(markdownMetadata[1] ?? "")) as unknown;
    } catch {
      throw new Error("Memory draft Markdown metadata is invalid.");
    }
  } else {
    try {
      parsed = JSON.parse(normalized) as unknown;
    } catch {
      throw new Error("Memory draft import expects an Omnia JSON bundle or portable Markdown file.");
    }
  }

  if (!isRecord(parsed)) throw new Error("Memory draft import expects an object.");
  if (parsed.schema !== "omnia.memory-draft-preview.v1" && !markdownMetadata) {
    throw new Error("This file is not an Omnia memory draft preview bundle.");
  }

  const entry = markdownMetadata ? parsed : parsed.entry;
  if (!isRecord(entry)) throw new Error("The memory draft bundle is missing its entry object.");
  const fallback = emptyDraft();
  return {
    title: asString(entry.title, fallback.title),
    content: asString(entry.content, fallback.content),
    scopeLabel: asString(entry.scopeLabel, fallback.scopeLabel),
    kind: asMemoryKind(entry.kind, fallback.kind),
    status: asMemoryStatus(entry.status, fallback.status),
    origin: asMemoryOrigin(entry.origin, fallback.origin),
    confidence: entry.confidence === null || typeof entry.confidence === "number"
      ? (entry.confidence === null ? "" : String(entry.confidence))
      : asString(entry.confidence, fallback.confidence),
    sourceLabel: asString(entry.sourceLabel, fallback.sourceLabel),
    lastUsedLabel: asString(entry.lastUsedLabel, fallback.lastUsedLabel),
    expiresAt: asString(entry.expiresAt, fallback.expiresAt),
    sensitivity: normalizeSensitivity(entry.sensitivity),
  };
}

function confidenceValue(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toMemoryView(value: MemoryDraftValue, id: string): MemoryView & { sensitivity: MemorySensitivity[] } {
  const confidence = confidenceValue(value.confidence);
  const safeConfidence = confidence === null || !Number.isFinite(confidence)
    ? null
    : Math.min(1, Math.max(0, confidence));
  return {
    id,
    title: value.title.trim() || null,
    content: value.content.trim(),
    scopeLabel: value.scopeLabel.trim(),
    kind: value.kind,
    status: value.status,
    origin: value.origin,
    confidence: safeConfidence,
    sourceLabel: value.sourceLabel.trim(),
    lastUsedLabel: value.lastUsedLabel.trim() || null,
    expiresAt: value.expiresAt.trim() || null,
    sensitivity: normalizeSensitivity(value.sensitivity),
  };
}

function serializeDraft(value: MemoryDraftValue, format: DraftExportFormat): string {
  const preview = toMemoryView(value, "memory-draft-preview");
  const previewSensitivity = normalizeSensitivity(preview.sensitivity);
  if (format === "markdown") {
    const portableMetadata = encodeURIComponent(JSON.stringify({
      title: preview.title,
      content: preview.content,
      scopeLabel: preview.scopeLabel,
      kind: preview.kind,
      status: preview.status,
      origin: preview.origin,
      confidence: preview.confidence,
      sourceLabel: preview.sourceLabel,
      lastUsedLabel: preview.lastUsedLabel,
      expiresAt: preview.expiresAt,
      sensitivity: preview.sensitivity,
    }));
    return [
      "# Omnia memory draft preview",
      "",
      `<!-- omnia.memory-draft-preview.v1 ${portableMetadata} -->`,
      "",
      "> Renderer-local draft. Staging does not write durable memory or trigger retrieval.",
      "",
      `- **${preview.content || "Untitled memory"}** — ${preview.scopeLabel || "Unscoped"} · ${kindLabels[preview.kind]} · ${statusLabels[preview.status]} · ${preview.confidence === null ? "Explicit" : `${Math.round(preview.confidence * 100)}%`}`,
      `- Origin: ${originLabels[preview.origin]}`,
      `- Source: ${preview.sourceLabel || "Unknown"}`,
      `- Sensitivity: ${sensitivityLabel(previewSensitivity)}`,
      `- Expires: ${preview.expiresAt || "No expiry set"}`,
    ].join("\n");
  }

  return JSON.stringify({
    schema: "omnia.memory-draft-preview.v1",
    scope: "renderer-session",
      entry: preview,
    boundary: {
      durableWrite: false,
      providerRequest: false,
      retrievalActivation: false,
    },
  }, null, 2);
}

function downloadDraft(payload: string, format: DraftExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function" || typeof document === "undefined") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-memory-draft-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export default function MemoryDraftStudio({ initialMemory = null, existingScopes = [], onClose, onStage }: MemoryDraftStudioProps) {
  const [history, setHistory] = useState<DraftHistory>(() => ({
    past: [],
    present: initialMemory ? memoryToDraft(initialMemory) : emptyDraft(),
    future: [],
  }));
  const [exportFormat, setExportFormat] = useState<DraftExportFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportStatus, setExportStatus] = useState("Preview is generated locally from this draft.");
  const [status, setStatus] = useState("Nothing has been staged yet.");
  const importInputRef = useRef<HTMLInputElement>(null);

  const draft = history.present;
  const confidence = confidenceValue(draft.confidence);
  const validation = useMemo(() => {
    const errors: string[] = [];
    if (draft.content.trim().length < 3) errors.push("Content needs at least 3 characters.");
    if (draft.content.trim().length > 4000) errors.push("Content is limited to 4,000 characters.");
    if (draft.title.trim().length > 120) errors.push("Title is limited to 120 characters.");
    if (!draft.scopeLabel.trim()) errors.push("Scope is required.");
    if (draft.scopeLabel.trim().length > 120) errors.push("Scope is limited to 120 characters.");
    if (!draft.sourceLabel.trim()) errors.push("Source label is required.");
    if (draft.sourceLabel.trim().length > 160) errors.push("Source label is limited to 160 characters.");
    if (draft.confidence.trim() && (!Number.isFinite(confidence) || confidence! < 0 || confidence! > 1)) {
      errors.push("Confidence must be blank or a number between 0 and 1.");
    }
    if (draft.expiresAt.trim() && Number.isNaN(Date.parse(draft.expiresAt))) errors.push("Expiry must be a valid date or left blank.");
    const sensitivity = normalizeSensitivity(draft.sensitivity);
    if (sensitivity.some((category) => BLOCKED_MEMORY_DRAFT_SENSITIVITIES.has(category))) {
      errors.push("Authentication, secret, and private-key classifications are blocked from staging memory.");
    }
    return errors;
  }, [confidence, draft.content, draft.confidence, draft.expiresAt, draft.scopeLabel, draft.sensitivity, draft.sourceLabel, draft.title]);

  const preview = useMemo(() => toMemoryView(draft, initialMemory?.id ?? "memory-draft-preview"), [draft, initialMemory?.id]);
  const previewSensitivity = normalizeSensitivity(preview.sensitivity);
  const exportPayload = useMemo(() => serializeDraft(draft, exportFormat), [draft, exportFormat]);

  const updateDraft = (patch: Partial<MemoryDraftValue>) => {
    const next = { ...history.present, ...patch };
    if (JSON.stringify(next) === JSON.stringify(history.present)) return;
    setHistory((current) => ({
      past: [...current.past, cloneDraft(current.present)],
      present: cloneDraft(next),
      future: [],
    }));
    setStatus("Draft changed in this renderer session.");
  };

  const replaceDraft = (next: MemoryDraftValue, nextStatus: string) => {
    if (JSON.stringify(next) === JSON.stringify(history.present)) {
      setStatus("Imported draft matches the current preview.");
      return;
    }
    setHistory((current) => ({
      past: [...current.past, cloneDraft(current.present)],
      present: cloneDraft(next),
      future: [],
    }));
    setStatus(nextStatus);
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_MEMORY_DRAFT_BYTES) {
      setStatus("Import rejected: memory draft bundles are limited to 512 KB.");
      return;
    }
    try {
      const next = parseMemoryDraftPayload(await file.text());
      replaceDraft(next, `Imported ${file.name} into the renderer-local draft.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Memory draft import failed safely.");
    }
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return {
        past: current.past.slice(0, -1),
        present: cloneDraft(previous),
        future: [cloneDraft(current.present), ...current.future],
      };
    });
    setStatus("Undid the last memory draft change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return {
        past: [...current.past, cloneDraft(current.present)],
        present: cloneDraft(next),
        future: current.future.slice(1),
      };
    });
    setStatus("Reapplied the next memory draft change.");
  };

  const reset = () => {
    const next = initialMemory ? memoryToDraft(initialMemory) : emptyDraft();
    if (JSON.stringify(next) === JSON.stringify(history.present)) {
      setStatus("Memory draft is already at its default values.");
      return;
    }
    setHistory((current) => ({
      past: [...current.past, cloneDraft(current.present)],
      present: next,
      future: [],
    }));
    setStatus("Memory draft reset; the source entry was not changed.");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (validation.length > 0) {
      setStatus(validation[0] ?? "Fix the draft before staging it.");
      return;
    }
    onStage(toMemoryView(draft, initialMemory?.id ?? "memory-draft-preview"), initialMemory?.id ?? null);
    setStatus(initialMemory ? "Edited copy staged in the renderer preview." : "New memory staged in the renderer preview.");
  };

  const copyExport = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no draft was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`Copied ${exportFormat.toUpperCase()} draft preview.`);
    } catch {
      setExportStatus("Clipboard access was denied; no draft was copied.");
    }
  };

  const downloadExport = () => {
    setExportStatus(downloadDraft(exportPayload, exportFormat)
      ? "Download started; no durable memory was written."
      : "File download is unavailable in this surface.");
  };

  const field = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>, key: keyof MemoryDraftValue) => {
    updateDraft({ [key]: event.target.value } as Partial<MemoryDraftValue>);
  };

  const toggleSensitivity = (category: MemorySensitivity) => {
    const current = normalizeSensitivity(draft.sensitivity);
    const next = category === "normal"
      ? ["normal"]
      : current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current.filter((item) => item !== "normal"), category];
    updateDraft({ sensitivity: normalizeSensitivity(next) });
  };

  return (
    <section id="memory-draft-studio" className="memory-draft-studio" aria-label="Memory draft studio">
      <header className="memory-draft-studio__header">
        <div>
          <span className="eyebrow">Renderer-local draft</span>
          <h3>{initialMemory ? "Edit memory in preview" : "Add a memory draft"}</h3>
          <p>{initialMemory ? "Stage an edited copy while keeping the seeded source entry unchanged." : "Compose a memory entry, inspect its metadata, and stage it for this preview session."}</p>
        </div>
        <div className="memory-draft-studio__header-actions">
          <span className="memory-studio__chip memory-studio__chip--teal">Preview only</span>
          <button type="button" className="button button--ghost" onClick={onClose} aria-label="Close memory draft studio"><X size={14} /> Close</button>
        </div>
      </header>

      <div className="memory-draft-studio__history" role="toolbar" aria-label="Memory draft history">
        <span><strong>{history.past.length + history.future.length}</strong> history steps</span>
        <span className="memory-draft-studio__history-status" role="status" aria-live="polite">{status}</span>
        <div>
          <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo memory draft change"><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo memory draft change"><Redo2 size={13} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset memory draft"><RotateCcw size={13} /> Reset</button>
        </div>
      </div>

      <div className="memory-draft-studio__layout">
        <form className="memory-draft-studio__form" onSubmit={handleSubmit} noValidate>
          <label className="memory-draft-studio__field memory-draft-studio__field--wide">
            <span>Title <small>(optional)</small></span>
            <input value={draft.title} onChange={(event) => field(event, "title")} maxLength={120} placeholder="Short label for this memory" aria-label="Memory title" aria-invalid={validation.some((item) => item.startsWith("Title"))} />
          </label>
          <label className="memory-draft-studio__field memory-draft-studio__field--wide">
            <span>Content <em>required</em></span>
            <textarea value={draft.content} onChange={(event) => field(event, "content")} rows={6} maxLength={4000} placeholder="Example: Prefer concise implementation reports." aria-label="Memory content" aria-invalid={validation.some((item) => item.startsWith("Content"))} />
            <small>{draft.content.length}/4000 characters</small>
          </label>
          <label className="memory-draft-studio__field">
            <span>Scope <em>required</em></span>
            <input list="memory-draft-scope-options" value={draft.scopeLabel} onChange={(event) => field(event, "scopeLabel")} maxLength={120} placeholder="Global or project name" aria-label="Memory scope" />
            <datalist id="memory-draft-scope-options">{existingScopes.map((scope) => <option key={scope} value={scope} />)}</datalist>
          </label>
          <label className="memory-draft-studio__field">
            <span>Kind</span>
            <select value={draft.kind} onChange={(event) => field(event, "kind")} aria-label="Memory kind">
              {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="memory-draft-studio__field">
            <span>Status</span>
            <select value={draft.status} onChange={(event) => field(event, "status")} aria-label="Memory status">
              {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="memory-draft-studio__field">
            <span>Origin</span>
            <select value={draft.origin} onChange={(event) => field(event, "origin")} aria-label="Memory origin">
              {Object.entries(originLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="memory-draft-studio__field">
            <span>Confidence <small>(0–1, optional)</small></span>
            <input type="number" min="0" max="1" step="0.05" value={draft.confidence} onChange={(event) => field(event, "confidence")} placeholder="0.85" aria-label="Memory confidence" aria-invalid={validation.some((item) => item.startsWith("Confidence"))} />
          </label>
          <label className="memory-draft-studio__field memory-draft-studio__field--wide">
            <span>Source label <em>required</em></span>
            <input value={draft.sourceLabel} onChange={(event) => field(event, "sourceLabel")} maxLength={160} placeholder="Manual draft, conversation, or imported bundle" aria-label="Memory source label" />
          </label>
          <label className="memory-draft-studio__field memory-draft-studio__field--wide">
            <span>Last used label <small>(optional)</small></span>
            <input value={draft.lastUsedLabel} onChange={(event) => field(event, "lastUsedLabel")} maxLength={120} placeholder="Not retrieved" aria-label="Memory last used label" />
          </label>
          <label className="memory-draft-studio__field">
            <span>Expiry <small>(optional)</small></span>
            <input type="date" value={draft.expiresAt} onChange={(event) => field(event, "expiresAt")} aria-label="Memory expiry" aria-invalid={validation.some((item) => item.startsWith("Expiry"))} />
          </label>
          <fieldset className="memory-draft-studio__sensitivity">
            <legend>Sensitivity classification</legend>
            <small>Choose the least permissive category that describes this entry. Blocked categories stay visible for review but cannot be staged.</small>
            <div className="memory-draft-studio__sensitivity-grid">
              {MEMORY_DRAFT_SENSITIVITY_OPTIONS.map((option) => (
                <label key={option.id} className={`memory-draft-studio__sensitivity-option${option.blocked ? " memory-draft-studio__sensitivity-option--blocked" : ""}`}>
                  <input
                    type="checkbox"
                    checked={draft.sensitivity.includes(option.id)}
                    onChange={() => toggleSensitivity(option.id)}
                    aria-label={`Memory sensitivity ${option.label}`}
                  />
                  <span><strong>{option.label}</strong><small>{option.description}</small></span>
                </label>
              ))}
            </div>
            <span className="memory-draft-studio__sensitivity-summary" role="status" aria-live="polite">
              Current classification: <strong>{sensitivityLabel(draft.sensitivity)}</strong>
              {normalizeSensitivity(draft.sensitivity).some((category) => BLOCKED_MEMORY_DRAFT_SENSITIVITIES.has(category)) ? " · blocked from staging" : ""}
            </span>
          </fieldset>
          {validation.length > 0 ? <ul className="memory-draft-studio__validation" aria-label="Memory draft validation issues">{validation.map((message) => <li key={message}>{message}</li>)}</ul> : null}
          <div className="memory-draft-studio__form-actions">
            <button type="submit" className="button button--secondary" disabled={validation.length > 0}><Save size={14} /> {initialMemory ? "Stage edited copy" : "Stage in preview"}</button>
            <span>Staging changes this browser preview only.</span>
          </div>
        </form>

        <aside className="memory-draft-studio__preview" aria-label="Memory draft live preview">
          <header><div><span className="eyebrow">Live preview</span><h4>{preview.kind ? kindLabels[preview.kind] : "Memory entry"}</h4></div><Eye size={16} /></header>
          {preview.title ? <strong className="memory-draft-studio__preview-title">{preview.title}</strong> : null}
          <p className="memory-draft-studio__preview-content">{preview.content || "Your memory content will appear here."}</p>
          <dl className="memory-draft-studio__facts"><div><dt>Scope</dt><dd>{preview.scopeLabel || "Unscoped"}</dd></div><div><dt>Status</dt><dd>{statusLabels[preview.status]}</dd></div><div><dt>Origin</dt><dd>{originLabels[preview.origin]}</dd></div><div><dt>Confidence</dt><dd>{preview.confidence === null ? "Explicit" : `${Math.round(preview.confidence * 100)}%`}</dd></div><div><dt>Source</dt><dd>{preview.sourceLabel || "Unknown"}</dd></div><div><dt>Sensitivity</dt><dd>{sensitivityLabel(previewSensitivity)}{previewSensitivity.some((category) => BLOCKED_MEMORY_DRAFT_SENSITIVITIES.has(category)) ? " · blocked" : ""}</dd></div><div><dt>Expiry</dt><dd>{preview.expiresAt || "No expiry"}</dd></div></dl>
          <button type="button" className="button button--ghost" onClick={() => setExportOpen((current) => !current)} aria-expanded={exportOpen} aria-controls="memory-draft-export"><FileJson2 size={14} /> {exportOpen ? "Hide portable preview" : "Preview JSON / Markdown"}</button>
          {exportOpen ? <section id="memory-draft-export" className="memory-draft-studio__export" aria-label="Memory draft portable preview">
            <div className="memory-draft-studio__export-toolbar">
              <label><span>Format</span><select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as DraftExportFormat)} aria-label="Memory draft export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
              <button type="button" className="button button--ghost" onClick={() => importInputRef.current?.click()}><Upload size={13} /> Import JSON</button>
              <input ref={importInputRef} className="memory-draft-studio__import-input" type="file" accept=".json,.md,.markdown,application/json,text/markdown" onChange={(event) => void handleImport(event)} aria-label="Import memory draft JSON or Markdown" />
              <button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button>
              <button type="button" className="button button--ghost" onClick={downloadExport}><Download size={13} /> Download</button>
            </div>
            <span className="memory-draft-studio__export-status" role="status" aria-live="polite">{exportStatus}</span>
            <pre tabIndex={0}><code>{exportPayload}</code></pre>
          </section> : null}
          <p className="memory-studio__boundary"><Check size={14} /> Preview only · no durable write, provider request, retrieval activation, or native approval. Sensitivity is a local classification; blocked categories cannot be staged.</p>
        </aside>
      </div>
    </section>
  );
}
