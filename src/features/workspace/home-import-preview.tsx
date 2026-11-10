import { useRef, useState } from "react";
import {
  CheckCircle2,
  Clipboard,
  FileArchive,
  FileJson,
  FileText,
  Info,
  RotateCcw,
  Sparkles,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";

type ImportKind = "chat-bundle" | "project-bundle" | "portable-markdown" | "run-timeline";

interface ImportKindDefinition {
  readonly label: string;
  readonly description: string;
  readonly accept: string;
  readonly icon: LucideIcon;
}

interface ImportCandidate {
  readonly fileName: string;
  readonly kind: ImportKind;
  readonly format: "JSON" | "Markdown" | "JSONL";
  readonly title: string;
  readonly recordCount: number;
  readonly sizeBytes: number;
  readonly warnings: readonly string[];
  readonly summary: string;
}

export interface HomeImportPreviewProps {
  readonly onClose: () => void;
}

const MAX_IMPORT_BYTES = 512 * 1024;

const IMPORT_KINDS: Record<ImportKind, ImportKindDefinition> = {
  "chat-bundle": {
    label: "Conversation bundle",
    description: "Omnia JSON or a compatible chat export",
    accept: ".json,application/json",
    icon: FileJson,
  },
  "project-bundle": {
    label: "Project bundle",
    description: "Project metadata, instructions, and portable context",
    accept: ".json,application/json",
    icon: FileArchive,
  },
  "portable-markdown": {
    label: "Portable Markdown",
    description: "A readable note or draft from another tool",
    accept: ".md,.markdown,.txt,text/markdown,text/plain",
    icon: FileText,
  },
  "run-timeline": {
    label: "Run timeline",
    description: "JSON/JSONL events for a renderer-only replay preview",
    accept: ".json,.jsonl,application/json,application/x-ndjson",
    icon: FileJson,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(value: unknown, keys: readonly string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function countRecords(value: unknown, kind: ImportKind, rawText: string): number {
  if (kind === "portable-markdown") {
    return rawText.split(/\r?\n/).filter((line) => line.trim()).length;
  }
  if (kind === "run-timeline" && rawText.trim().includes("\n")) {
    return rawText.split(/\r?\n/).filter((line) => line.trim()).length;
  }
  if (Array.isArray(value)) return value.length;
  if (!isRecord(value)) return 1;
  for (const key of ["messages", "conversations", "projects", "events", "entries", "items"]) {
    const records = value[key];
    if (Array.isArray(records)) return records.length;
  }
  return Object.keys(value).length;
}

function titleFromImport(fileName: string, kind: ImportKind, value: unknown, rawText: string): string {
  const fromPayload = firstString(value, ["title", "name", "subject", "label"]);
  if (fromPayload) return fromPayload;
  const heading = rawText.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  if (stem) return stem.replace(/\b\w/g, (letter) => letter.toUpperCase());
  return IMPORT_KINDS[kind].label;
}

function parseImport(file: File, kind: ImportKind, rawText: string): ImportCandidate {
  const definition = IMPORT_KINDS[kind];
  const warnings: string[] = [
    "Renderer-local preview only; no conversations, projects, files, or runs are changed.",
  ];
  let value: unknown = null;
  let format: ImportCandidate["format"] = kind === "portable-markdown" ? "Markdown" : "JSON";

  if (kind === "portable-markdown") {
    warnings.push("Markdown is treated as a portable draft and is not executed or sent to a provider.");
  } else if (kind === "run-timeline" && file.name.toLowerCase().endsWith(".jsonl")) {
    format = "JSONL";
    warnings.push("JSONL lines are summarized as a replay rehearsal; native journal lineage remains unavailable.");
  } else {
    try {
      value = JSON.parse(rawText) as unknown;
      if (!isRecord(value) && !Array.isArray(value)) {
        warnings.push("The JSON root is a scalar; the preview will show it as one record.");
      }
    } catch {
      warnings.push("JSON parsing failed; the file is retained as a text preview and no import is applied.");
    }
  }

  const recordCount = countRecords(value, kind, rawText);
  return {
    fileName: file.name || "untitled import",
    kind,
    format,
    title: titleFromImport(file.name, kind, value, rawText),
    recordCount,
    sizeBytes: file.size,
    warnings,
    summary: `${definition.label} · ${recordCount} visible record${recordCount === 1 ? "" : "s"}`,
  };
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function previewPayload(candidate: ImportCandidate): string {
  return JSON.stringify(
    {
      schema: "omnia.home-import.preview.v1",
      scope: "renderer-session",
      source: candidate.fileName,
      kind: candidate.kind,
      format: candidate.format,
      title: candidate.title,
      visibleRecords: candidate.recordCount,
      sizeBytes: candidate.sizeBytes,
      warnings: candidate.warnings,
      executionDisposition: "preview-only",
      durableWrite: false,
    },
    null,
    2,
  );
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read file"));
    reader.readAsText(file);
  });
}

export function HomeImportPreview({ onClose }: HomeImportPreviewProps) {
  const [kind, setKind] = useState<ImportKind>("chat-bundle");
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null);
  const [status, setStatus] = useState("Choose a file to build a renderer-local import preview.");
  const inputRef = useRef<HTMLInputElement>(null);
  const definition = IMPORT_KINDS[kind];
  const KindIcon = definition.icon;

  const reset = () => {
    setCandidate(null);
    setStatus("Import preview reset; no workspace data was changed.");
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setCandidate(null);
      setStatus("This preview accepts files up to 512 KB; no file was imported.");
      return;
    }
    try {
      const rawText = await readFileText(file);
      if (!rawText.trim()) {
        setCandidate(null);
        setStatus("The selected file is empty; no import preview was created.");
        return;
      }
      const nextCandidate = parseImport(file, kind, rawText);
      setCandidate(nextCandidate);
      setStatus(`Ready to review ${nextCandidate.title} as a ${nextCandidate.format} preview.`);
    } catch {
      setCandidate(null);
      setStatus("The selected file could not be read; no import preview was created.");
    }
  };

  const stagePreview = () => {
    if (!candidate) {
      setStatus("Choose a file before staging an import preview.");
      return;
    }
    setStatus(`Staged ${candidate.title} in this renderer session. No native import or durable write occurred.`);
  };

  const copyPreview = async () => {
    if (!candidate) {
      setStatus("Choose a file before copying its preview.");
      return;
    }
    const payload = previewPayload(candidate);
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus("Copied the renderer-local import preview JSON.");
    } catch {
      setStatus("Clipboard access was denied; no preview was copied.");
    }
  };

  return (
    <section id="home-import-preview" className="home-import-preview" aria-labelledby="home-import-preview-title">
      <header className="home-import-preview__header">
        <div>
          <span className="home-import-preview__eyebrow"><Sparkles size={13} /> Import work · preview</span>
          <h2 id="home-import-preview-title">Bring work into Omnia safely</h2>
          <p>Inspect a portable bundle first, then decide what you want to keep. This surface never writes to the native workspace.</p>
        </div>
        <button type="button" className="button button--ghost" onClick={onClose} aria-label="Close import work preview">
          <X size={15} /> Close
        </button>
      </header>
      <div className="home-import-preview__controls">
        <label>
          <span>Source type</span>
          <select aria-label="Import source type" value={kind} onChange={(event) => { setKind(event.target.value as ImportKind); setCandidate(null); setStatus("Choose a file to build a renderer-local import preview."); }}>
            {(Object.entries(IMPORT_KINDS) as Array<[ImportKind, ImportKindDefinition]>).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
          </select>
          <small>{definition.description}</small>
        </label>
        <div className="home-import-preview__file-picker">
          <input ref={inputRef} type="file" accept={definition.accept} hidden aria-label="Choose import file" onChange={(event) => void handleFile(event.target.files?.[0])} />
          <button type="button" className="button button--secondary" onClick={() => inputRef.current?.click()}>
            <Upload size={15} /> Choose file
          </button>
          <small>{candidate ? `${candidate.fileName} · ${formatBytes(candidate.sizeBytes)}` : "JSON, JSONL, Markdown · max 512 KB"}</small>
        </div>
      </div>
      {candidate ? (
        <article className="home-import-preview__candidate">
          <div className="home-import-preview__candidate-mark"><KindIcon size={19} /></div>
          <div className="home-import-preview__candidate-copy">
            <span className="eyebrow">Candidate ready</span>
            <strong>{candidate.title}</strong>
            <p>{candidate.summary}</p>
            <ul>{candidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </div>
          <span className="home-import-preview__candidate-state"><CheckCircle2 size={14} /> Inspectable</span>
        </article>
      ) : (
        <div className="home-import-preview__empty" role="status"><Info size={16} /><span>Nothing selected yet. Pick a portable file to see its title, record estimate, and boundary notes.</span></div>
      )}
      <div className="home-import-preview__actions">
        <button type="button" className="button button--primary" onClick={stagePreview}><Clipboard size={14} /> Stage preview</button>
        <button type="button" className="button button--ghost" onClick={() => void copyPreview()} disabled={!candidate}><FileJson size={14} /> Copy JSON</button>
        <button type="button" className="button button--ghost" onClick={reset} disabled={!candidate}><RotateCcw size={14} /> Reset</button>
      </div>
      <p className="home-import-preview__status" role="status" aria-live="polite">{status}</p>
      <p className="home-import-preview__boundary">Preview only · Renderer-local · No durable write · No provider request · No native replay, file read, project mutation, or execution.</p>
    </section>
  );
}

export { IMPORT_KINDS, parseImport, previewPayload };
