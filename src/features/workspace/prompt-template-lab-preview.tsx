import { Check, CircleAlert, Copy, FlaskConical, LockKeyhole, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { resolvePromptTemplate, type PromptTemplate, type PromptTemplateExample, type PromptVariable, type PromptVariableValue } from "./prompt-template-contract";

type LabCase = PromptTemplateExample;
type CaseResult = {
  missing: string[];
  warnings: string[];
  resolvedPrompt: string;
  expectedPrefixMatches: boolean | null;
};

let caseSequence = 0;

const labTemplates: PromptTemplate[] = [
  {
    id: "lab-code-review",
    name: "Evidence-first code review",
    description: "Check required inputs, supported language values, and the prompt produced by each example.",
    tags: ["engineering", "review"],
    body: "Review this {{language}} excerpt for {{focus}}.\n\nCode:\n{{code}}\n\nReturn evidence-backed findings and open questions separately.",
    variables: [
      { id: "language", name: "language", label: "Language", type: "choice", required: true, defaultValue: "typescript", options: [{ label: "TypeScript", value: "typescript" }, { label: "Python", value: "python" }, { label: "Rust", value: "rust" }] },
      { id: "focus", name: "focus", label: "Review focus", type: "choice", required: true, defaultValue: "correctness", options: [{ label: "Correctness", value: "correctness" }, { label: "Security", value: "security" }, { label: "Accessibility", value: "accessibility" }] },
      { id: "code", name: "code", label: "Code excerpt", type: "long-text", required: true, validation: { minLength: 1, maxLength: 10000 } },
    ],
    examples: [
      { id: "lab-review-happy", label: "Complete TypeScript sample", values: { language: "typescript", focus: "accessibility", code: "<button onClick={save}>Save</button>" }, expectedPrefix: "Review this typescript excerpt", note: "All required inputs are present and use declared choices." },
      { id: "lab-review-missing", label: "Missing code excerpt", values: { language: "rust", focus: "security" }, note: "Expected to surface the missing required code field." },
      { id: "lab-review-invalid", label: "Unsupported language value", values: { language: "brainfuck", focus: "correctness", code: "fn main() {}" }, note: "Expected to surface a choice-validation warning." },
    ],
    version: "1.0.0",
    versions: [{ version: "1.0.0", createdAt: "2026-09-24T00:00:00.000Z", changeNote: "Renderer lab sample", body: "Review this {{language}} excerpt for {{focus}}.\n\nCode:\n{{code}}\n\nReturn evidence-backed findings and open questions separately.", variableIds: ["language", "focus", "code"] }],
    archived: false,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  },
  {
    id: "lab-research-synthesis",
    name: "Research synthesis",
    description: "Exercise a source-scoped synthesis prompt with an evidence-first and an executive example.",
    tags: ["research", "academic"],
    body: "Synthesize {{question}} using only {{sourceScope}}. Tone: {{tone}}.\n\nSeparate evidence, interpretation, and limitations.",
    variables: [
      { id: "question", name: "question", label: "Research question", type: "long-text", required: true, validation: { minLength: 8, maxLength: 1200 } },
      { id: "source-scope", name: "sourceScope", label: "Visible source scope", type: "context-ref", required: true },
      { id: "tone", name: "tone", label: "Tone", type: "choice", required: true, defaultValue: "evidence-first", options: [{ label: "Evidence first", value: "evidence-first" }, { label: "Executive", value: "executive" }] },
    ],
    examples: [
      { id: "lab-research-evidence", label: "Evidence map", values: { question: "What evidence supports this design decision?", sourceScope: "visible-notebook-sources", tone: "evidence-first" }, expectedPrefix: "Synthesize What evidence", note: "Keeps the visible source boundary explicit." },
      { id: "lab-research-executive", label: "Executive summary", values: { question: "Which options are most promising?", sourceScope: "attached-report-preview", tone: "executive" }, note: "Exercises an alternative tone and source scope." },
    ],
    version: "1.0.0",
    versions: [{ version: "1.0.0", createdAt: "2026-09-24T00:00:00.000Z", changeNote: "Renderer lab sample", body: "Synthesize {{question}} using only {{sourceScope}}. Tone: {{tone}}.\n\nSeparate evidence, interpretation, and limitations.", variableIds: ["question", "source-scope", "tone"] }],
    archived: false,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  },
];

function cloneCases(template: PromptTemplate): LabCase[] {
  return template.examples.map((example) => ({ ...example, values: { ...example.values } }));
}

function newCase(template: PromptTemplate): LabCase {
  const values = Object.fromEntries(template.variables.map((variable) => [variable.name, variable.defaultValue ?? (variable.type === "boolean" ? false : "")])) as Record<string, PromptVariableValue>;
  return { id: `case-${Date.now()}-${++caseSequence}`, label: "Untitled example", values, note: "Renderer-local example case." };
}

function evaluateCase(template: PromptTemplate, example: LabCase): CaseResult {
  const resolution = resolvePromptTemplate(template, example.values);
  const validChoiceWarnings = new Set(
    template.variables
      .filter((variable) => variable.type === "choice" && variable.options?.some((option) => option.value === example.values[variable.name]))
      .map((variable) => `${variable.label} is not a listed choice.`),
  );
  const expectedPrefixMatches = example.expectedPrefix ? resolution.resolvedPrompt.startsWith(example.expectedPrefix) : null;
  const warnings = resolution.warnings.filter((warning) => !validChoiceWarnings.has(warning));
  if (expectedPrefixMatches === false) warnings.push("Resolved prompt did not match the expected prefix.");
  return { missing: resolution.missingVariableIds, warnings: [...new Set(warnings)], resolvedPrompt: resolution.resolvedPrompt, expectedPrefixMatches };
}

function caseState(result: CaseResult | undefined): "not-run" | "passed" | "review" {
  if (!result) return "not-run";
  return result.missing.length === 0 && result.warnings.length === 0 ? "passed" : "review";
}

function renderVariableInput(variable: PromptVariable, current: PromptVariableValue | undefined, onChange: (value: PromptVariableValue) => void) {
  const value = current ?? "";
  if (variable.type === "long-text") return <textarea rows={4} value={typeof value === "string" ? value : String(value)} onChange={(event) => onChange(event.target.value)} />;
  if (variable.type === "choice") return <select value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}><option value="">Select…</option>{(variable.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  if (variable.type === "boolean") return <label className="prompt-template-lab__check"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} /> {value === true ? "True" : "False"}</label>;
  return <input type={variable.type === "date" ? "date" : variable.type === "number" ? "number" : "text"} value={String(value)} onChange={(event) => onChange(variable.type === "number" ? (event.target.value === "" ? "" : Number(event.target.value)) : event.target.value)} />;
}

export default function PromptTemplateLabPreview() {
  const [templateId, setTemplateId] = useState(labTemplates[0]!.id);
  const template = labTemplates.find((item) => item.id === templateId)!;
  const [casesByTemplate, setCasesByTemplate] = useState<Record<string, LabCase[]>>(() => Object.fromEntries(labTemplates.map((item) => [item.id, cloneCases(item)])));
  const [selectedCaseId, setSelectedCaseId] = useState(labTemplates[0]!.examples[0]!.id);
  const [results, setResults] = useState<Record<string, CaseResult>>({});
  const cases = casesByTemplate[template.id] ?? [];
  const selectedCase = cases.find((item) => item.id === selectedCaseId) ?? cases[0];
  const selectedResult = selectedCase ? results[`${template.id}:${selectedCase.id}`] : undefined;
  const coverage = useMemo(() => template.variables.map((variable) => ({ variable, count: cases.filter((item) => item.values[variable.name] !== undefined && item.values[variable.name] !== "").length })), [cases, template.variables]);
  const updateCase = (caseId: string, transform: (example: LabCase) => LabCase) => {
    setCasesByTemplate((current) => ({ ...current, [template.id]: (current[template.id] ?? []).map((item) => item.id === caseId ? transform(item) : item) }));
    setResults((current) => { const next = { ...current }; delete next[`${template.id}:${caseId}`]; return next; });
  };
  const runOne = (example: LabCase) => setResults((current) => ({ ...current, [`${template.id}:${example.id}`]: evaluateCase(template, example) }));
  const runAll = () => setResults((current) => ({ ...current, ...Object.fromEntries(cases.map((item) => [`${template.id}:${item.id}`, evaluateCase(template, item)])) }));
  const addCase = () => {
    const example = newCase(template);
    setCasesByTemplate((current) => ({ ...current, [template.id]: [...(current[template.id] ?? []), example] }));
    setSelectedCaseId(example.id);
  };
  const duplicateCase = () => {
    if (!selectedCase) return;
    const example = { ...selectedCase, id: `case-${Date.now()}-${++caseSequence}`, label: `${selectedCase.label} copy`, values: { ...selectedCase.values } };
    setCasesByTemplate((current) => ({ ...current, [template.id]: [...(current[template.id] ?? []), example] }));
    setSelectedCaseId(example.id);
  };
  const removeCase = () => {
    if (!selectedCase || cases.length <= 1) return;
    const nextCases = cases.filter((item) => item.id !== selectedCase.id);
    setCasesByTemplate((current) => ({ ...current, [template.id]: nextCases }));
    setSelectedCaseId(nextCases[0]!.id);
    setResults((current) => { const next = { ...current }; delete next[`${template.id}:${selectedCase.id}`]; return next; });
  };
  const resetCases = () => {
    const reset = cloneCases(template);
    setCasesByTemplate((current) => ({ ...current, [template.id]: reset }));
    setSelectedCaseId(reset[0]?.id ?? "");
    setResults((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${template.id}:`))));
  };
  const changeTemplate = (nextId: string) => {
    const next = labTemplates.find((item) => item.id === nextId)!;
    setTemplateId(nextId);
    setSelectedCaseId((casesByTemplate[nextId] ?? next.examples)[0]?.id ?? "");
  };
  const summary = cases.reduce((counts, item) => { const state = caseState(results[`${template.id}:${item.id}`]); if (state === "passed") counts.passed += 1; else if (state === "review") counts.review += 1; return counts; }, { passed: 0, review: 0 });

  return <section className="prompt-template-lab" aria-labelledby="prompt-template-lab-title">
    <header className="prompt-template-lab__header">
      <div><span className="prompt-template-lab__eyebrow"><FlaskConical size={14} /> Example-case workbench</span><h2 id="prompt-template-lab-title">Prompt Template Lab</h2><p>Exercise template examples, inspect resolved prompts, and see which typed inputs your cases cover.</p></div>
      <span className="prompt-template-lab__badge"><LockKeyhole size={13} /> Preview only</span>
    </header>
    <div className="prompt-template-lab__boundary" role="note">Deterministic renderer rehearsal only · No provider request · No model-quality claim · No durable write</div>
    <div className="prompt-template-lab__toolbar">
      <label><span>Template sample</span><select value={template.id} onChange={(event) => changeTemplate(event.target.value)}>{labTemplates.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <div className="prompt-template-lab__toolbar-actions"><button type="button" className="button button--primary" onClick={runAll}><Play size={14} /> Check all cases</button><button type="button" className="button button--secondary" onClick={resetCases}><RotateCcw size={14} /> Reset examples</button></div>
    </div>
    <div className="prompt-template-lab__summary" aria-label="Example check summary"><span><strong>{cases.length}</strong><small>cases</small></span><span><strong>{summary.passed}</strong><small>clear</small></span><span><strong>{summary.review}</strong><small>need review</small></span><span><strong>{coverage.filter((item) => item.count > 0).length}/{coverage.length}</strong><small>variables covered</small></span></div>
    <div className="prompt-template-lab__grid">
      <aside className="prompt-template-lab__case-list" aria-label="Example cases">
        <div className="prompt-template-lab__section-head"><div><span>SCENARIOS</span><strong>{cases.length} examples</strong></div><button type="button" className="button button--compact" onClick={addCase}><Plus size={13} /> Add</button></div>
        {cases.map((example) => {
          const state = caseState(results[`${template.id}:${example.id}`]);
          return <button type="button" key={example.id} className={`prompt-template-lab__case ${selectedCase?.id === example.id ? "is-selected" : ""}`} aria-pressed={selectedCase?.id === example.id} onClick={() => setSelectedCaseId(example.id)}><span><strong>{example.label}</strong><small>{example.note ?? "Example values for this template."}</small></span><em className={`is-${state}`}>{state === "passed" ? <Check size={12} /> : state === "review" ? <CircleAlert size={12} /> : "—"}</em></button>;
        })}
        <section className="prompt-template-lab__coverage" aria-label="Variable coverage"><div className="prompt-template-lab__section-head"><div><span>INPUT COVERAGE</span><strong>Cases with a value</strong></div></div>{coverage.map(({ variable, count }) => <div className="prompt-template-lab__coverage-row" key={variable.id}><span><strong>{variable.label}</strong><small>{variable.type}{variable.required ? " · required" : " · optional"}</small></span><span>{count}/{cases.length}</span></div>)}</section>
      </aside>
      <section className="prompt-template-lab__editor">
        {selectedCase ? <>
          <div className="prompt-template-lab__section-head"><div><span>SELECTED EXAMPLE</span><strong>{selectedCase.label}</strong></div><div className="prompt-template-lab__case-actions"><button type="button" className="button button--compact" onClick={duplicateCase}><Copy size={13} /> Duplicate</button><button type="button" className="button button--compact" onClick={removeCase} disabled={cases.length <= 1}><Trash2 size={13} /> Remove</button></div></div>
          <label className="prompt-template-lab__name-field"><span>Case name</span><input value={selectedCase.label} onChange={(event) => updateCase(selectedCase.id, (item) => ({ ...item, label: event.target.value }))} /></label>
          <div className="prompt-template-lab__fields">{template.variables.map((variable) => <label className="prompt-template-lab__field" key={variable.id}><span>{variable.label}<small>{variable.type}{variable.required ? " · required" : " · optional"}</small></span>{renderVariableInput(variable, selectedCase.values[variable.name], (value) => updateCase(selectedCase.id, (item) => ({ ...item, values: { ...item.values, [variable.name]: value } })))}</label>)}</div>
          <div className="prompt-template-lab__run-row"><span>Checks required values, variable types, and optional expected prefix.</span><button type="button" className="button button--primary" onClick={() => runOne(selectedCase)}><Play size={14} /> Check selected</button></div>
          {selectedResult ? <section className="prompt-template-lab__result" aria-label="Resolved example result"><div className="prompt-template-lab__result-head"><strong>{caseState(selectedResult) === "passed" ? <><Check size={14} /> Case checks passed</> : <><CircleAlert size={14} /> Review this case</>}</strong>{selectedResult.expectedPrefixMatches !== null && <small>Expected prefix {selectedResult.expectedPrefixMatches ? "matches" : "does not match"}</small>}</div><pre>{selectedResult.resolvedPrompt}</pre>{selectedResult.warnings.length > 0 && <div className="prompt-template-lab__warnings" role="status">{selectedResult.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}</section> : <div className="prompt-template-lab__result-empty"><FlaskConical size={15} /> Run a case to inspect its deterministic validation and resolved-text preview.</div>}
        </> : <div className="prompt-template-lab__result-empty">Add an example case to begin.</div>}
      </section>
    </div>
    <p className="prompt-template-lab__footer"><LockKeyhole size={12} /> Outputs are string substitution and contract-validation previews; no LLM is called and no benchmark is produced.</p>
  </section>;
}
