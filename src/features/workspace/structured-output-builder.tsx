import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Plus,
  RotateCcw,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  DEFAULT_STRUCTURED_OUTPUT_FIELDS,
  STRUCTURED_OUTPUT_FIELD_TYPES,
  buildStructuredOutputSchema,
  structuredOutputFieldsFromSchema,
  type StructuredOutputField,
  type StructuredOutputFieldType,
} from "./structured-output-builder-contract";

export interface StructuredOutputBuilderProps {
  readonly schemaText: string;
  readonly onApplySchema: (schemaText: string) => void;
}

function cloneFields(fields: readonly StructuredOutputField[]): StructuredOutputField[] {
  return fields.map((field) => ({ ...field }));
}

function createField(index: number): StructuredOutputField {
  return {
    id: `field-${Date.now()}-${index}`,
    name: `field_${index + 1}`,
    type: "string",
    required: false,
    description: "",
    defaultValue: "",
    enumValues: "",
    minimum: "",
    maximum: "",
  };
}

export function StructuredOutputBuilder({ schemaText, onApplySchema }: StructuredOutputBuilderProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("Omnia structured output");
  const [additionalProperties, setAdditionalProperties] = useState(false);
  const [fields, setFields] = useState<StructuredOutputField[]>(() => cloneFields(structuredOutputFieldsFromSchema(schemaText) ?? DEFAULT_STRUCTURED_OUTPUT_FIELDS));
  const [status, setStatus] = useState("Build a schema visually, then apply it to the JSON Schema editor.");

  useEffect(() => {
    const parsed = structuredOutputFieldsFromSchema(schemaText);
    if (!parsed) return;
    setFields(cloneFields(parsed));
    try {
      const schema = JSON.parse(schemaText.replace(/^\uFEFF/, "")) as Record<string, unknown>;
      if (typeof schema.title === "string") setTitle(schema.title);
      if (typeof schema.additionalProperties === "boolean") setAdditionalProperties(schema.additionalProperties);
    } catch {
      // Keep the current builder draft while the schema editor is temporarily invalid.
    }
  }, [schemaText]);

  const result = useMemo(() => buildStructuredOutputSchema(fields, { title, additionalProperties }), [additionalProperties, fields, title]);
  const updateField = (id: string, patch: Partial<StructuredOutputField>) => {
    setFields((current) => current.map((field) => field.id === id ? { ...field, ...patch } : field));
  };
  const moveField = (id: string, direction: -1 | 1) => {
    setFields((current) => {
      const index = current.findIndex((field) => field.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (!moved) return current;
      next.splice(nextIndex, 0, moved);
      return next;
    });
  };
  const addField = () => {
    setFields((current) => [...current, createField(current.length)]);
    setOpen(true);
    setStatus("Added a renderer-local schema field.");
  };
  const reset = () => {
    setTitle("Omnia structured output");
    setAdditionalProperties(false);
    setFields(cloneFields(DEFAULT_STRUCTURED_OUTPUT_FIELDS));
    setStatus("Reset the visual schema builder draft.");
  };
  const apply = () => {
    if (result.issues.length) {
      setOpen(true);
      setStatus(`Fix ${result.issues.length} schema builder issue${result.issues.length === 1 ? "" : "s"} before applying.`);
      return;
    }
    onApplySchema(result.schemaText);
    setStatus("Applied the visual schema to the renderer-local JSON Schema editor.");
  };

  return <section className="structured-io-workbench__builder" aria-label="Structured output schema builder">
    <header className="structured-io-workbench__builder-head">
      <div><strong><WandSparkles size={14} /> Visual schema builder</strong><small>Add typed fields without hand-writing every JSON Schema property.</small></div>
      <div className="structured-io-workbench__builder-actions">
        <button type="button" className="button button--ghost" onClick={addField} title="Add a field to the renderer-local schema draft"><Plus size={13} /> Add field</button>
        <button type="button" className="button button--ghost" onClick={() => setOpen((value) => !value)} aria-expanded={open} title={open ? "Collapse the visual schema builder" : "Open the visual schema builder"}>{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{open ? "Collapse" : "Open builder"}</button>
      </div>
    </header>
    {open ? <>
      <div className="structured-io-workbench__builder-options">
        <label><span>Schema title</span><input aria-label="Structured output schema title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="structured-io-workbench__builder-check"><input type="checkbox" checked={!additionalProperties} onChange={(event) => setAdditionalProperties(!event.target.checked)} /><span>Reject additional properties</span></label>
        <button type="button" className="button button--ghost" onClick={reset} title="Reset the visual builder fields to their defaults"><RotateCcw size={13} /> Reset builder</button>
      </div>
      <div className="structured-io-workbench__builder-rows" role="list" aria-label="Structured output fields">
        {fields.map((field, index) => <article className="structured-io-workbench__builder-row" role="listitem" key={field.id}>
          <div className="structured-io-workbench__builder-row-head"><strong>Field {index + 1}</strong><div className="structured-io-workbench__builder-row-actions">
            <button type="button" className="icon-button" onClick={() => moveField(field.id, -1)} disabled={index === 0} aria-label={`Move ${field.name || `field ${index + 1}`} up`} title="Move this field up"><ArrowUp size={13} /></button>
            <button type="button" className="icon-button" onClick={() => moveField(field.id, 1)} disabled={index === fields.length - 1} aria-label={`Move ${field.name || `field ${index + 1}`} down`} title="Move this field down"><ArrowDown size={13} /></button>
            <button type="button" className="icon-button icon-button--danger" onClick={() => setFields((current) => current.filter((entry) => entry.id !== field.id))} aria-label={`Remove ${field.name || `field ${index + 1}`}`} title="Remove this field from the draft"><Trash2 size={13} /></button>
          </div></div>
          <div className="structured-io-workbench__builder-grid">
            <label><span>Name</span><input aria-label={`Field ${index + 1} name`} value={field.name} onChange={(event) => updateField(field.id, { name: event.target.value })} placeholder="field_name" /></label>
            <label><span>Type</span><select aria-label={`Field ${index + 1} type`} value={field.type} onChange={(event) => updateField(field.id, { type: event.target.value as StructuredOutputFieldType })}>{STRUCTURED_OUTPUT_FIELD_TYPES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
            <label className="structured-io-workbench__builder-check"><input type="checkbox" aria-label={`Field ${index + 1} required`} checked={field.required} onChange={(event) => updateField(field.id, { required: event.target.checked })} /><span>Required</span></label>
            <label><span>Default</span><input aria-label={`Field ${index + 1} default`} value={field.defaultValue} onChange={(event) => updateField(field.id, { defaultValue: event.target.value })} placeholder={field.type === "string" ? "optional text" : "optional JSON value"} /></label>
            <label className="structured-io-workbench__builder-wide"><span>Description</span><input aria-label={`Field ${index + 1} description`} value={field.description} onChange={(event) => updateField(field.id, { description: event.target.value })} placeholder="What this field means" /></label>
            <label className="structured-io-workbench__builder-wide"><span>Enum values <small>comma-separated</small></span><input aria-label={`Field ${index + 1} enum values`} value={field.enumValues} onChange={(event) => updateField(field.id, { enumValues: event.target.value })} placeholder={field.type === "string" ? "draft, ready, done" : "1, 2, 3"} /></label>
            {(field.type === "number" || field.type === "integer") ? <><label><span>Minimum</span><input aria-label={`Field ${index + 1} minimum`} inputMode="decimal" value={field.minimum} onChange={(event) => updateField(field.id, { minimum: event.target.value })} /></label><label><span>Maximum</span><input aria-label={`Field ${index + 1} maximum`} inputMode="decimal" value={field.maximum} onChange={(event) => updateField(field.id, { maximum: event.target.value })} /></label></> : null}
          </div>
        </article>)}
        {!fields.length ? <p className="structured-io-workbench__builder-empty">No fields yet. Add one to start the output contract.</p> : null}
      </div>
      <div className="structured-io-workbench__builder-footer">
        <div className="structured-io-workbench__builder-result"><div><strong>Generated schema preview</strong><small>{result.issues.length ? "Fix the highlighted builder issues before applying." : "Renderer-local JSON Schema draft."}</small></div><pre aria-label="Generated structured output schema"><code>{result.schemaText}</code></pre></div>
        <div className="structured-io-workbench__builder-commit"><div role="status" aria-live="polite" className={result.issues.length ? "structured-io-workbench__builder-status structured-io-workbench__builder-status--warn" : "structured-io-workbench__builder-status"}>{result.issues.length ? <AlertTriangle size={13} /> : <Check size={13} />}{status}</div>{result.issues.length ? <ul>{result.issues.map((entry) => <li key={`${entry.fieldId}-${entry.path}`}><strong>{entry.path}</strong> {entry.message}</li>)}</ul> : null}<button type="button" className="button button--secondary" onClick={apply} disabled={Boolean(result.issues.length)} title="Apply the generated schema to the editor draft"><Check size={13} /> Apply to schema editor</button></div></div>
    </> : <p className="structured-io-workbench__builder-collapsed">Visual builder is ready. Open it to edit fields, constraints, enums, defaults, and required flags.</p>}
  </section>;
}

export default StructuredOutputBuilder;
