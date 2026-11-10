import {
  AlertTriangle,
  Braces,
  Check,
  Clipboard,
  Download,
  FileJson2,
  Redo2,
  RotateCcw,
  Search,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  DEFAULT_STRUCTURED_BLOCK_CONFIG,
  STRUCTURED_BLOCK_FORMATS,
  buildStructuredBlockPreview,
  sourceLinesForStructuredBlock,
  type StructuredBlockChannel,
  type StructuredBlockConfig,
  type StructuredBlockSourceKind,
  type StructuredBlockStreamState,
} from "./structured-io-block";
import { StructuredOutputBuilder } from "./structured-output-builder";

type StructuredMode = "json" | "json-schema";
type ExportFormat = "json" | "markdown";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface StructuredDraft {
  readonly mode: StructuredMode;
  readonly schemaText: string;
  readonly sampleText: string;
  readonly blockConfig?: StructuredBlockConfig;
}

interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly level: "error" | "warning";
}

interface ParsedJson {
  readonly value?: JsonValue;
  readonly error?: string;
}

interface DraftHistory {
  readonly past: StructuredDraft[];
  readonly present: StructuredDraft;
  readonly future: StructuredDraft[];
}

const DEFAULT_SCHEMA = `{
  "type": "object",
  "required": ["answer", "confidence"],
  "properties": {
    "answer": { "type": "string" },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "additionalProperties": false
}`;

const DEFAULT_SAMPLE = `{
  "answer": "Concise result",
  "confidence": 0.84
}`;

const INITIAL_DRAFT: StructuredDraft = {
  mode: "json-schema",
  schemaText: DEFAULT_SCHEMA,
  sampleText: DEFAULT_SAMPLE,
  blockConfig: DEFAULT_STRUCTURED_BLOCK_CONFIG,
};

const PRESETS: readonly { readonly id: string; readonly label: string; readonly detail: string; readonly draft: StructuredDraft }[] = [
  {
    id: "answer-card",
    label: "Answer card",
    detail: "A compact answer with confidence and citations.",
    draft: INITIAL_DRAFT,
  },
  {
    id: "task-plan",
    label: "Task plan",
    detail: "A typed list of implementation steps and owners.",
    draft: {
      mode: "json-schema",
      schemaText: `{
  "type": "object",
  "required": ["goal", "steps"],
  "properties": {
    "goal": { "type": "string", "minLength": 1 },
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["title", "status"],
        "properties": {
          "title": { "type": "string" },
          "status": { "enum": ["planned", "active", "done"] }
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}`,
      sampleText: `{
  "goal": "Ship structured I/O preview",
  "steps": [
    { "title": "Shape the contract", "status": "done" },
    { "title": "Connect native admission", "status": "planned" }
  ]
}`,
    },
  },
  {
    id: "json-only",
    label: "JSON only",
    detail: "Quick payload rehearsal without a schema contract.",
    draft: {
      mode: "json",
      schemaText: "",
      sampleText: `{
  "event": "run.completed",
  "attempt": 1,
  "tags": ["preview", "renderer-local"]
}`,
    },
  },
];

const SOURCE_KINDS: readonly { readonly id: StructuredBlockSourceKind; readonly label: string }[] = [
  { id: "prompt", label: "Prompt" },
  { id: "assistant", label: "Assistant" },
  { id: "tool-input", label: "Tool input" },
  { id: "tool-output", label: "Tool output" },
  { id: "command", label: "Command" },
  { id: "stdout", label: "stdout" },
  { id: "stderr", label: "stderr" },
  { id: "build-log", label: "Build log" },
  { id: "test-log", label: "Test log" },
  { id: "trace", label: "Trace" },
  { id: "artifact", label: "Artifact" },
  { id: "request", label: "Request" },
  { id: "response", label: "Response" },
];

const CHANNELS: readonly { readonly id: StructuredBlockChannel; readonly label: string }[] = [
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "stdout", label: "stdout" },
  { id: "stderr", label: "stderr" },
  { id: "system", label: "System" },
  { id: "tool", label: "Tool" },
  { id: "trace", label: "Trace" },
  { id: "mixed", label: "Mixed" },
];

const STREAM_STATES: readonly { readonly id: StructuredBlockStreamState; readonly label: string }[] = [
  { id: "complete", label: "Complete" },
  { id: "streaming", label: "Streaming" },
  { id: "truncated", label: "Truncated" },
  { id: "interrupted", label: "Interrupted" },
  { id: "malformed", label: "Malformed" },
];

function parseJson(text: string): ParsedJson {
  try {
    return { value: JSON.parse(text.replace(/^\uFEFF/, "")) as JsonValue };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid JSON." };
  }
}

function valueType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function formatPath(path: string, key: string | number): string {
  return typeof key === "number" ? `${path}[${key}]` : `${path}.${key}`;
}

function validateAgainstSchema(value: JsonValue, schema: JsonValue, path = "$", issues: ValidationIssue[] = []): ValidationIssue[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    issues.push({ path, message: "Schema node must be an object.", level: "error" });
    return issues;
  }

  const schemaRecord = schema as { [key: string]: JsonValue };
  const expectedType = schemaRecord.type;
  if (typeof expectedType === "string") {
    const actualType = valueType(value);
    const typeMatches = expectedType === "integer" ? actualType === "number" && Number.isInteger(value) : actualType === expectedType;
    if (!typeMatches) {
      issues.push({ path, message: `Expected ${expectedType}; received ${actualType}.`, level: "error" });
      return issues;
    }
  }

  const enumValues = schemaRecord.enum;
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    issues.push({ path, message: "Value is not included in the enum.", level: "error" });
  }

  if (typeof value === "string") {
    if (typeof schemaRecord.minLength === "number" && value.length < schemaRecord.minLength) issues.push({ path, message: `String must contain at least ${schemaRecord.minLength} characters.`, level: "error" });
    if (typeof schemaRecord.maxLength === "number" && value.length > schemaRecord.maxLength) issues.push({ path, message: `String must contain at most ${schemaRecord.maxLength} characters.`, level: "error" });
  }
  if (typeof value === "number") {
    if (typeof schemaRecord.minimum === "number" && value < schemaRecord.minimum) issues.push({ path, message: `Number must be at least ${schemaRecord.minimum}.`, level: "error" });
    if (typeof schemaRecord.maximum === "number" && value > schemaRecord.maximum) issues.push({ path, message: `Number must be at most ${schemaRecord.maximum}.`, level: "error" });
  }

  if (Array.isArray(value)) {
    if (typeof schemaRecord.minItems === "number" && value.length < schemaRecord.minItems) issues.push({ path, message: `Array must contain at least ${schemaRecord.minItems} items.`, level: "error" });
    const itemSchema = schemaRecord.items;
    if (itemSchema !== undefined) value.forEach((item, index) => validateAgainstSchema(item, itemSchema, formatPath(path, index), issues));
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const properties = schemaRecord.properties;
    const required = schemaRecord.required;
    const record = value as { [key: string]: JsonValue };
    if (Array.isArray(required)) {
      required.forEach((key) => {
        if (typeof key === "string" && !(key in record)) issues.push({ path, message: `Missing required property \"${key}\".`, level: "error" });
      });
    }
    if (properties !== undefined && typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
      const propertyMap = properties as { [key: string]: JsonValue };
      Object.entries(propertyMap).forEach(([key, childSchema]) => {
        if (key in record) validateAgainstSchema(record[key]!, childSchema, formatPath(path, key), issues);
      });
    }
    if (schemaRecord.additionalProperties === false && properties !== undefined && typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
      const propertyMap = properties as { [key: string]: JsonValue };
      Object.keys(record).forEach((key) => {
        if (!(key in propertyMap)) issues.push({ path: formatPath(path, key), message: "Additional property is not allowed.", level: "error" });
      });
    }
  }
  return issues;
}

function cloneDraft(draft: StructuredDraft): StructuredDraft {
  return { ...draft };
}

function exportPayload(draft: StructuredDraft, issues: readonly ValidationIssue[], format: ExportFormat, blockPreview: ReturnType<typeof buildStructuredBlockPreview>): string {
  const payload = {
    schema: "omnia.structured-io.preview.v1",
    scope: "renderer-session",
    mode: draft.mode,
    schemaText: draft.schemaText,
    sampleText: draft.sampleText,
    validation: {
      status: issues.some((issue) => issue.level === "error") ? "invalid" : "valid-preview",
      issueCount: issues.length,
    },
    structuredBlock: blockPreview,
    native: "not-connected",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return `# Structured I/O preview\n\n- Mode: ${draft.mode}\n- Validation: ${payload.validation.status}\n- Issues: ${issues.length}\n- Detected block: ${blockPreview.format}${blockPreview.language ? ` (${blockPreview.language})` : ""}\n- Channel: ${blockPreview.channel} · Stream: ${blockPreview.streamState}\n- Source hash: ${blockPreview.sourceHash}\n\n## Schema\n\n\`\`\`json\n${draft.schemaText || "(not supplied)"}\n\`\`\`\n\n## Sample payload\n\n\`\`\`json\n${draft.sampleText}\n\`\`\`\n\nRenderer-local rehearsal; no provider request, native schema admission, durable write, or execution was created.\n`;
}

function downloadText(text: string, format: ExportFormat): boolean {
  if (typeof URL === "undefined" || typeof document === "undefined") return false;
  const objectUrl = URL.createObjectURL(new Blob([text], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `omnia-structured-io-preview.${format === "json" ? "json" : "md"}`;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
  return true;
}

export function StructuredIoWorkbench() {
  const [history, setHistory] = useState<DraftHistory>({ past: [], present: cloneDraft(INITIAL_DRAFT), future: [] });
  const [status, setStatus] = useState("Draft is ready for renderer-local validation.");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [copied, setCopied] = useState(false);
  const [sourceView, setSourceView] = useState<"raw" | "normalized">("normalized");
  const [lineSearch, setLineSearch] = useState("");
  const draft = history.present;
  const blockConfig = draft.blockConfig ?? DEFAULT_STRUCTURED_BLOCK_CONFIG;
  const parsedSchema = useMemo(() => (draft.mode === "json-schema" ? parseJson(draft.schemaText) : { value: {} as JsonValue }), [draft.mode, draft.schemaText]);
  const parsedSample = useMemo(() => parseJson(draft.sampleText), [draft.sampleText]);
  const issues = useMemo<ValidationIssue[]>(() => {
    const next: ValidationIssue[] = [];
    if (parsedSample.error) next.push({ path: "$", message: `Payload JSON: ${parsedSample.error}`, level: "error" });
    if (draft.mode === "json-schema") {
      if (parsedSchema.error) next.push({ path: "$schema", message: `Schema JSON: ${parsedSchema.error}`, level: "error" });
      else if (parsedSchema.value !== undefined && parsedSample.value !== undefined) validateAgainstSchema(parsedSample.value, parsedSchema.value, "$", next);
    }
    return next;
  }, [draft.mode, parsedSample, parsedSchema]);
  const hasErrors = issues.some((issue) => issue.level === "error");
  const validationLabel = hasErrors ? "Needs review" : "Valid preview";
  const blockPreview = useMemo(() => buildStructuredBlockPreview(draft.sampleText, blockConfig), [blockConfig, draft.sampleText]);
  const sourceLines = useMemo(() => sourceLinesForStructuredBlock(draft.sampleText, sourceView), [draft.sampleText, sourceView]);
  const visibleSourceLines = useMemo(() => {
    const query = lineSearch.trim().toLocaleLowerCase();
    return sourceLines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => !query || entry.line.toLocaleLowerCase().includes(query));
  }, [lineSearch, sourceLines]);
  const payload = useMemo(() => exportPayload(draft, issues, exportFormat, blockPreview), [blockPreview, draft, exportFormat, issues]);

  const commitDraft = (next: StructuredDraft, message: string) => {
    setHistory((current) => ({ past: [...current.past, current.present].slice(-20), present: cloneDraft(next), future: [] }));
    setStatus(message);
    setCopied(false);
  };
  const updateDraft = (patch: Partial<StructuredDraft>, message: string) => commitDraft({ ...draft, ...patch }, message);
  const updateBlockConfig = (patch: Partial<StructuredBlockConfig>, message: string) => updateDraft({ blockConfig: { ...blockConfig, ...patch } }, message);
  const undo = () => setHistory((current) => {
    const previous = current.past.at(-1);
    if (!previous) return current;
    setStatus("Undid the last structured I/O preview change.");
    return { past: current.past.slice(0, -1), present: cloneDraft(previous), future: [current.present, ...current.future] };
  });
  const redo = () => setHistory((current) => {
    const next = current.future[0];
    if (!next) return current;
    setStatus("Redid the structured I/O preview change.");
    return { past: [...current.past, current.present], present: cloneDraft(next), future: current.future.slice(1) };
  });
  const reset = () => commitDraft(INITIAL_DRAFT, "Reset the structured I/O draft to its default preview.");
  const validate = () => setStatus(hasErrors ? `Validation found ${issues.length} issue${issues.length === 1 ? "" : "s"}.` : "Structured payload matches the preview contract.");
  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; no structured I/O export was copied."); return; }
    try { await navigator.clipboard.writeText(payload); setCopied(true); setStatus(`Copied ${exportFormat.toUpperCase()} structured I/O preview.`); } catch { setStatus("Clipboard access was denied; nothing was copied."); }
  };
  const loadPreset = (preset: (typeof PRESETS)[number]) => commitDraft({ ...preset.draft, blockConfig }, `Loaded the ${preset.label} structured I/O preset.`);

  return <section className="structured-io-workbench" aria-label="Structured I/O workbench">
    <header className="structured-io-workbench__header">
      <div className="structured-io-workbench__title"><span className="structured-io-workbench__icon"><Braces size={17} /></span><span><span className="eyebrow">Payload rehearsal</span><h2>Structured I/O</h2><p>Shape JSON and JSON Schema contracts before a future native/provider admission path is connected.</p></span></div>
      <span className={`structured-io-workbench__status structured-io-workbench__status--${hasErrors ? "warn" : "good"}`}>{hasErrors ? <AlertTriangle size={13} /> : <Check size={13} />}{validationLabel}</span>
    </header>

    <div className="structured-io-workbench__toolbar" role="toolbar" aria-label="Structured I/O history and validation controls">
      <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo structured I/O change" title="Undo the last Structured I/O edit"><Undo2 size={13} /> Undo</button>
      <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo structured I/O change" title="Redo the last Structured I/O edit"><Redo2 size={13} /> Redo</button>
      <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset structured I/O draft" title="Reset this renderer-local draft to its default"><RotateCcw size={13} /> Reset</button>
      <span className="structured-io-workbench__toolbar-status" role="status" aria-live="polite">{status}</span>
    </div>

    <div className="structured-io-workbench__presets" aria-label="Structured I/O presets">
      <div className="structured-io-workbench__section-heading"><span><strong>Start from a contract</strong><small>Presets remain in this renderer session.</small></span><Sparkles size={15} /></div>
      <div className="structured-io-workbench__preset-grid">{PRESETS.map((preset) => <button key={preset.id} type="button" className="structured-io-workbench__preset" onClick={() => loadPreset(preset)} title={`Load the ${preset.label} Structured I/O preset`}><span><strong>{preset.label}</strong><small>{preset.detail}</small></span><FileJson2 size={14} /></button>)}</div>
    </div>

    <div className="structured-io-workbench__controls">
      <label><span>Contract mode</span><select aria-label="Structured I/O contract mode" value={draft.mode} onChange={(event) => updateDraft({ mode: event.target.value as StructuredMode }, "Changed the structured contract mode.")}><option value="json-schema">JSON Schema + payload</option><option value="json">JSON payload only</option></select><small>{draft.mode === "json-schema" ? "Validate the sample against a JSON Schema subset." : "Parse and format JSON without a schema requirement."}</small></label>
      <div className="structured-io-workbench__metric"><span>Validation</span><strong>{validationLabel}</strong><small>{issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"} to review` : "No local issues detected"}</small></div>
    </div>

    {draft.mode === "json-schema" ? <StructuredOutputBuilder schemaText={draft.schemaText} onApplySchema={(schemaText) => updateDraft({ schemaText }, "Applied the visual schema builder draft.")} /> : null}

    <div className="structured-io-workbench__editors">
      {draft.mode === "json-schema" ? <label className="structured-io-workbench__editor"><span><strong>JSON Schema</strong><small>Draft contract · renderer-local</small></span><textarea aria-label="Structured I/O JSON Schema" value={draft.schemaText} onChange={(event) => updateDraft({ schemaText: event.target.value }, "Updated the local JSON Schema draft.")} spellCheck={false} rows={13} /></label> : <div className="structured-io-workbench__editor structured-io-workbench__editor--empty"><span><strong>JSON Schema</strong><small>Not required in JSON-only mode.</small></span><p>Switch to JSON Schema mode when the payload needs required fields, type checks, bounds, enums, or additional-property guards.</p></div>}
      <label className="structured-io-workbench__editor"><span><strong>Sample payload</strong><small>What the model would return · preview only</small></span><textarea aria-label="Structured I/O sample payload" value={draft.sampleText} onChange={(event) => updateDraft({ sampleText: event.target.value }, "Updated the local sample payload.")} spellCheck={false} rows={13} /></label>
    </div>

    <section className="structured-io-workbench__block" aria-label="Structured block metadata preview">
      <div className="structured-io-workbench__section-heading"><span><strong>Typed block renderer</strong><small>Format and channel are derived metadata around the exact source text.</small></span><Braces size={15} /></div>
      <div className="structured-io-workbench__block-controls">
        <label><span>Source kind</span><select aria-label="Structured block source kind" value={blockConfig.sourceKind} onChange={(event) => updateBlockConfig({ sourceKind: event.target.value as StructuredBlockSourceKind }, "Updated the source kind preview.")}>{SOURCE_KINDS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
        <label><span>Channel</span><select aria-label="Structured block channel" value={blockConfig.channel} onChange={(event) => updateBlockConfig({ channel: event.target.value as StructuredBlockChannel }, "Updated the channel preview.")}>{CHANNELS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
        <label><span>Stream state</span><select aria-label="Structured block stream state" value={blockConfig.streamState} onChange={(event) => updateBlockConfig({ streamState: event.target.value as StructuredBlockStreamState }, "Updated the stream state preview.")}>{STREAM_STATES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
        <label><span>Format override</span><select aria-label="Structured block format override" value={blockConfig.formatOverride} onChange={(event) => updateBlockConfig({ formatOverride: event.target.value as StructuredBlockConfig["formatOverride"] }, "Updated the format detection preview.")}><option value="auto">Auto-detect</option>{STRUCTURED_BLOCK_FORMATS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
        <label><span>Language hint</span><input aria-label="Structured block language hint" value={blockConfig.language} placeholder="auto" onChange={(event) => updateBlockConfig({ language: event.target.value }, "Updated the language hint preview.")} /></label>
      </div>
      <div className="structured-io-workbench__block-summary" role="group" aria-label="Structured block summary">
        <span><small>Detected</small><strong>{blockPreview.format}{blockPreview.language ? ` · ${blockPreview.language}` : ""}</strong><em>{blockPreview.detectionConfidence === null ? "explicit override" : `${Math.round(blockPreview.detectionConfidence * 100)}% confidence`}</em></span>
        <span><small>Source hash</small><strong className="structured-io-workbench__mono">{blockPreview.sourceHash}</strong><em>preview hash · not a native receipt</em></span>
        <span><small>Shape</small><strong>{blockPreview.lineCount} lines · {blockPreview.byteCount.toLocaleString()} bytes</strong><em>{blockPreview.channel} · {blockPreview.streamState}</em></span>
      </div>
    </section>

    <section className="structured-io-workbench__source" aria-label="Structured source inspector">
      <header><div><strong>Source inspector</strong><small>Raw source remains available beside a normalized derived view.</small></div><div className="structured-io-workbench__source-tools"><label><span>View</span><select aria-label="Structured source view" value={sourceView} onChange={(event) => setSourceView(event.target.value as "raw" | "normalized")}><option value="normalized">Normalized</option><option value="raw">Raw</option></select></label><label className="structured-io-workbench__search"><span>Find in source</span><Search size={13} /><input aria-label="Find in structured source" value={lineSearch} placeholder="Search lines" onChange={(event) => setLineSearch(event.target.value)} /></label></div></header>
      <div className="structured-io-workbench__source-meta"><span>{visibleSourceLines.length} visible line{visibleSourceLines.length === 1 ? "" : "s"}</span><span>{sourceView === "normalized" ? "CRLF/BOM normalized for preview" : "Exact textarea source"}</span><span>Jump-to-source: renderer-local</span></div>
      {visibleSourceLines.length ? <ol className="structured-io-workbench__source-lines" aria-label={`${sourceView} source lines`}>{visibleSourceLines.map((entry) => <li key={entry.number}><span aria-label={`Line ${entry.number}`}>{entry.number}</span><code>{entry.line || " "}</code></li>)}</ol> : <p className="structured-io-workbench__source-empty">No lines match this search.</p>}
    </section>

    <div className="structured-io-workbench__validation" role="region" aria-label="Structured I/O validation results">
      <div className="structured-io-workbench__validation-head"><div><strong>Validation rehearsal</strong><small>Subset checks: types, required fields, bounds, enums, arrays, and additional properties.</small></div><button type="button" className="button button--secondary" onClick={validate} title="Run renderer-local validation against the current draft"><Check size={13} /> Validate draft</button></div>
      {issues.length ? <ul>{issues.map((issue, index) => <li key={`${issue.path}-${index}`} className={`structured-io-workbench__issue structured-io-workbench__issue--${issue.level}`}><AlertTriangle size={13} /><span><strong>{issue.path}</strong><small>{issue.message}</small></span></li>)}</ul> : <p className="structured-io-workbench__valid"><Check size={14} /> Payload is valid for this renderer-local contract.</p>}
    </div>

    <div className="structured-io-workbench__export-actions"><span className="structured-io-workbench__export-label">Portable preview</span><button type="button" className="button button--ghost" onClick={() => setExportOpen((open) => !open)} aria-expanded={exportOpen} aria-controls="structured-io-export" title="Show or hide the renderer-local export preview"><FileJson2 size={13} /> {exportOpen ? "Hide export" : "Preview export"}</button></div>
    {exportOpen ? <section id="structured-io-export" className="structured-io-workbench__export" aria-label="Structured I/O export preview"><header><div><strong>Structured I/O bundle</strong><small>No file is written by this preview.</small></div><div className="structured-io-workbench__export-tools"><label><span>Format</span><select aria-label="Structured I/O export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyExport()} title="Copy the current export preview to the clipboard"><Clipboard size={13} /> {copied ? "Copied" : "Copy"}</button><button type="button" className="button button--secondary" onClick={() => setStatus(downloadText(payload, exportFormat) ? "Downloaded a renderer-local structured I/O preview." : "Download is unavailable in this preview environment.")} title="Download the renderer-local export preview"><Download size={13} /> Download</button></div></header><pre role="region" aria-label={`${exportFormat === "json" ? "JSON" : "Markdown"} structured I/O export preview`}><code>{payload}</code></pre></section> : null}

    <p className="structured-io-workbench__boundary"><Sparkles size={13} /> Preview only · Renderer-local · No provider request, native schema admission, durable write, tool execution, or model training was created.</p>
  </section>;
}

export default StructuredIoWorkbench;
