import { type ChangeEvent, type KeyboardEvent, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  Clipboard,
  ClipboardCheck,
  Download,
  FileText,
  ListPlus,
  Plus,
  Quote,
  Redo2,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  importAcademicCitationBundle,
  serializeAcademicCitationBundle,
  serializeAcademicCitationMarkdown,
  type AcademicCitationBundleFormat,
} from "./academic-citation-bundle";

type AcademicTab = "outline" | "plan" | "draft" | "review" | "citations" | "export";
type AcademicLanguage = "Vietnamese" | "English";
type CitationStyle = "IEEE" | "APA 7" | "Chicago";
type AcademicTone = "Evidence-first" | "Socratic" | "Executive";
type AcademicAudience = "CSE / engineering" | "General reader" | "Research supervisor";
type AcademicMethod = "Literature review" | "Experiment" | "Benchmark" | "Case study" | "Mixed methods";
type ExportFormat = "json" | "markdown";
type CitationStatus = "placeholder" | "needs review" | "reviewed in session";

type OutlineItem = { id: string; title: string; level: 1 | 2; done: boolean; note: string };
type CitationItem = { id: string; label: string; status: CitationStatus; text: string };
type ReviewStatus = "open" | "needs evidence" | "ready";
type ReviewItem = { id: string; label: string; category: "Claim" | "Method" | "Limitations" | "Reproducibility"; status: ReviewStatus; note: string };
type ResearchPlan = {
  question: string;
  hypothesis: string;
  method: AcademicMethod;
  independentVariable: string;
  dependentVariable: string;
  controls: string;
  population: string;
  analysis: string;
  risks: string;
};

type AcademicDraft = {
  language: AcademicLanguage;
  style: CitationStyle;
  tone: AcademicTone;
  audience: AcademicAudience;
  title: string;
  abstractText: string;
  outline: OutlineItem[];
  citations: CitationItem[];
  reviewItems: ReviewItem[];
  researchPlan: ResearchPlan;
  format: ExportFormat;
};

const seedOutline: OutlineItem[] = [
  { id: "intro", title: "Motivation and research question", level: 1, done: true, note: "State the gap and the decision this report supports." },
  { id: "method", title: "Method and evidence boundary", level: 1, done: false, note: "Describe sources, assumptions, and what is still planned." },
  { id: "results", title: "Results and limitations", level: 1, done: false, note: "Separate observed results from renderer-only projections." },
  { id: "next", title: "Next steps", level: 2, done: false, note: "Turn open questions into measurable follow-ups." },
];

const citationSeeds: CitationItem[] = [
  { id: "c1", label: "[1] Omnia harness notes", status: "placeholder", text: "Author, A. (2026). Harness architecture notes. Draft source." },
  { id: "c2", label: "[2] Context compiler discussion", status: "needs review", text: "Author, B. (2026). Context compiler discussion. Unverified draft." },
  { id: "c3", label: "[3] Local memory study", status: "placeholder", text: "Author, C. (2026). Local-first memory study. Draft source." },
];

const reviewSeeds: ReviewItem[] = [
  { id: "claim-source", label: "Every major claim has a traceable source", category: "Claim", status: "needs evidence", note: "Attach a citation or mark the sentence as an inference." },
  { id: "observed-inferred", label: "Observed results are separated from interpretation", category: "Claim", status: "open", note: "Use explicit observed / inferred language in the final draft." },
  { id: "method-boundary", label: "Method and evidence boundaries are documented", category: "Method", status: "open", note: "Record what was checked, what was simulated, and what remains planned." },
  { id: "limitations", label: "Limitations and falsifiers are stated", category: "Limitations", status: "open", note: "Name the evidence that could change the conclusion." },
  { id: "reproduction", label: "A reader can reproduce the key steps", category: "Reproducibility", status: "open", note: "Include inputs, assumptions, versions, and a minimal follow-up path." },
];

const initialResearchPlan: ResearchPlan = {
  question: "How can an evidence-first AI workspace make research decisions easier to review?",
  hypothesis: "Making scope, provenance, and unresolved gaps visible will reduce unsupported conclusions.",
  method: "Mixed methods",
  independentVariable: "Evidence visibility and review prompts",
  dependentVariable: "Reviewer confidence and correction rate",
  controls: "Keep task, source set, and evaluation rubric stable.",
  population: "CSE / engineering research workflows",
  analysis: "Compare review outcomes, summarize disagreement, and report uncertainty.",
  risks: "Renderer preview data is illustrative; no real participants or source retrieval are attached.",
};

const initialDraft: AcademicDraft = {
  language: "Vietnamese",
  style: "IEEE",
  tone: "Evidence-first",
  audience: "CSE / engineering",
  title: "Omnia: a reviewable AI workspace for evidence-first work",
  abstractText: "This draft explores a chat-first workspace that keeps routing, memory, permissions, and evidence visible to the user.",
  outline: seedOutline,
  citations: citationSeeds,
  reviewItems: reviewSeeds,
  researchPlan: initialResearchPlan,
  format: "json",
};

function cloneDraft(draft: AcademicDraft): AcademicDraft {
  return {
    ...draft,
    outline: draft.outline.map((item) => ({ ...item })),
    citations: draft.citations.map((item) => ({ ...item })),
    reviewItems: draft.reviewItems.map((item) => ({ ...item })),
    researchPlan: { ...draft.researchPlan },
  };
}

function markdownExport(draft: AcademicDraft) {
  const citationLines = draft.citations.length === 0
    ? "- No citation placeholders yet."
    : draft.citations.map((citation) => `- ${citation.label} — ${citation.status}: ${citation.text}`).join("\n");
  const reviewLines = draft.reviewItems.length === 0
    ? "- No review gates yet."
    : draft.reviewItems.map((item) => `- [${item.status === "ready" ? "x" : " "}] ${item.category}: ${item.label} — ${item.status}`).join("\n");
  const plan = draft.researchPlan;
  return `# ${draft.title}\n\n- Language: ${draft.language}\n- Citation style: ${draft.style}\n- Tone: ${draft.tone}\n- Audience: ${draft.audience}\n\n## Abstract\n\n${draft.abstractText}\n\n## Research plan\n\n- Research question: ${plan.question}\n- Hypothesis: ${plan.hypothesis}\n- Method: ${plan.method}\n- Independent variable: ${plan.independentVariable}\n- Dependent variable: ${plan.dependentVariable}\n- Controls: ${plan.controls}\n- Population / scope: ${plan.population}\n- Analysis: ${plan.analysis}\n- Risks and limits: ${plan.risks}\n\n## Outline\n\n${draft.outline.map((item) => `${item.level === 2 ? "  -" : "-"} ${item.done ? "[x]" : "[ ]"} ${item.title}`).join("\n")}\n\n## Review gates\n\n${reviewLines}\n\n## Citation review queue\n\n${citationLines}\n\n> Renderer-local academic draft. Citations and claims require human verification.\n`;
}

export function AcademicStudioPreview() {
  const [tab, setTab] = useState<AcademicTab>("outline");
  const [draft, setDraft] = useState<AcademicDraft>(() => cloneDraft(initialDraft));
  const [history, setHistory] = useState<AcademicDraft[]>([]);
  const [future, setFuture] = useState<AcademicDraft[]>([]);
  const [status, setStatus] = useState("Draft exists only in this renderer session.");
  const [customSection, setCustomSection] = useState("");
  const [citationLabel, setCitationLabel] = useState("");
  const [citationText, setCitationText] = useState("");
  const [citationBundleFormat, setCitationBundleFormat] = useState<AcademicCitationBundleFormat>("json");
  const [citationBundleImport, setCitationBundleImport] = useState("");
  const [citationBundleStatus, setCitationBundleStatus] = useState("Paste a JSON bundle or portable Markdown to import citation placeholders.");
  const citationBundleFileRef = useRef<HTMLInputElement>(null);
  const tabs: AcademicTab[] = ["outline", "plan", "draft", "review", "citations", "export"];

  const planFields: Array<{ key: keyof ResearchPlan; label: string; placeholder: string; multiline?: boolean }> = [
    { key: "question", label: "Research question", placeholder: "What decision or phenomenon are you investigating?", multiline: true },
    { key: "hypothesis", label: "Hypothesis / expected answer", placeholder: "State a falsifiable expectation.", multiline: true },
    { key: "independentVariable", label: "Independent variable", placeholder: "What changes or conditions are compared?" },
    { key: "dependentVariable", label: "Dependent variable", placeholder: "What outcome will be observed?" },
    { key: "controls", label: "Controls / assumptions", placeholder: "What stays fixed or must be declared?", multiline: true },
    { key: "population", label: "Population / scope", placeholder: "Who, what corpus, or what system is in scope?" },
    { key: "analysis", label: "Analysis plan", placeholder: "How will observations become evidence?", multiline: true },
    { key: "risks", label: "Risks and limits", placeholder: "What could invalidate the interpretation?", multiline: true },
  ];

  const planCompletion = planFields.filter(({ key }) => draft.researchPlan[key].trim()).length;

  const exportPayload = useMemo(() => {
    const data = {
      schema: "omnia.academic-studio.preview.v1",
      scope: "renderer-session",
      title: draft.title,
      language: draft.language,
      citationStyle: draft.style,
      tone: draft.tone,
      audience: draft.audience,
      abstract: draft.abstractText,
      outline: draft.outline,
      researchPlan: draft.researchPlan,
      reviewItems: draft.reviewItems,
      citations: draft.citations,
    };
    return draft.format === "json" ? JSON.stringify(data, null, 2) : markdownExport(draft);
  }, [draft]);

  const citationBundlePayload = useMemo(() => {
    const input = {
      title: draft.title,
      citationStyle: draft.style,
      citations: draft.citations,
    };
    return citationBundleFormat === "json"
      ? serializeAcademicCitationBundle(input)
      : serializeAcademicCitationMarkdown(input);
  }, [citationBundleFormat, draft.citations, draft.style, draft.title]);

  const updateDraft = (updater: (current: AcademicDraft) => AcademicDraft, message?: string) => {
    setDraft((current) => {
      const next = updater(current);
      if (next === current) return current;
      setHistory((entries) => [...entries.slice(-19), cloneDraft(current)]);
      setFuture([]);
      return next;
    });
    if (message) setStatus(message);
  };

  const undo = () => {
    setDraft((current) => {
      const previous = history[history.length - 1];
      if (!previous) return current;
      setHistory((entries) => entries.slice(0, -1));
      setFuture((entries) => [...entries, cloneDraft(current)]);
      return cloneDraft(previous);
    });
    if (history.length > 0) setStatus("Undid the last academic draft action.");
  };

  const redo = () => {
    setDraft((current) => {
      const next = future[future.length - 1];
      if (!next) return current;
      setFuture((entries) => entries.slice(0, -1));
      setHistory((entries) => [...entries, cloneDraft(current)]);
      return cloneDraft(next);
    });
    if (future.length > 0) setStatus("Redid the academic draft action.");
  };

  const toggle = (id: string) => {
    updateDraft((current) => ({
      ...current,
      outline: current.outline.map((item) => item.id === id ? { ...item, done: !item.done } : item),
    }), "Updated section progress in the renderer preview.");
  };

  const moveSection = (id: string, direction: -1 | 1) => {
    updateDraft((current) => {
      const index = current.outline.findIndex((item) => item.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.outline.length) return current;
      const outline = [...current.outline];
      const currentItem = outline[index];
      const nextItem = outline[nextIndex];
      if (!currentItem || !nextItem) return current;
      outline[index] = nextItem;
      outline[nextIndex] = currentItem;
      return { ...current, outline };
    }, "Reordered the outline in the renderer preview.");
  };

  const removeSection = (id: string) => {
    updateDraft((current) => ({ ...current, outline: current.outline.filter((item) => item.id !== id) }), "Removed a renderer-local outline section.");
  };

  const addSection = () => {
    const trimmed = customSection.trim();
    if (!trimmed) return;
    updateDraft((current) => ({
      ...current,
      outline: [...current.outline, { id: `section-${Date.now()}`, title: trimmed, level: 1, done: false, note: "New renderer-local section." }],
    }), "Added a renderer-local outline section.");
    setCustomSection("");
  };

  const setAllProgress = (done: boolean) => {
    updateDraft((current) => ({ ...current, outline: current.outline.map((item) => ({ ...item, done })) }), done ? "Marked every outline section as drafted." : "Cleared outline progress.");
  };

  const setAllReviewReady = (ready: boolean) => {
    updateDraft((current) => ({
      ...current,
      reviewItems: current.reviewItems.map((item) => ({ ...item, status: ready ? "ready" : "open" })),
    }), ready ? "Marked every review gate ready in the renderer preview." : "Reopened every review gate.");
  };

  const addCitation = () => {
    const label = citationLabel.trim();
    const text = citationText.trim();
    if (!label || !text) {
      setStatus("Add both a citation label and citation text before adding an entry.");
      return;
    }
    updateDraft((current) => ({
      ...current,
      citations: [...current.citations, { id: `citation-${Date.now()}`, label, text, status: "placeholder" }],
    }), "Added a renderer-local citation placeholder.");
    setCitationLabel("");
    setCitationText("");
  };

  const importCitationBundle = () => {
    const raw = citationBundleImport.trim();
    if (!raw) {
      setCitationBundleStatus("Paste a JSON bundle or portable Markdown before importing.");
      return;
    }
    const result = importAcademicCitationBundle(raw);
    if (!result.ok) {
      setCitationBundleStatus(`Import rejected: ${result.errors[0] ?? "invalid citation bundle"}`);
      return;
    }
    const importedStyle: CitationStyle = result.bundle.citationStyle === "APA 7" || result.bundle.citationStyle === "Chicago"
      ? result.bundle.citationStyle
      : "IEEE";
    updateDraft((current) => ({
      ...current,
      style: importedStyle,
      citations: result.bundle.citations.map((citation) => ({ ...citation })),
    }), `Imported ${result.bundle.citations.length} citation entr${result.bundle.citations.length === 1 ? "y" : "ies"} into the renderer preview.`);
    setCitationBundleStatus(`Imported ${result.bundle.citations.length} citation entr${result.bundle.citations.length === 1 ? "y" : "ies"} from ${result.source === "json" ? "JSON" : result.source === "markdown" ? "portable Markdown" : "plain Markdown"}.`);
    setCitationBundleImport("");
  };

  const importCitationBundleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const raw = await file.text();
      setCitationBundleImport(raw);
      const result = importAcademicCitationBundle(raw);
      if (!result.ok) {
        setCitationBundleStatus(`Import rejected: ${result.errors[0] ?? "invalid citation bundle"}`);
        return;
      }
      const importedStyle: CitationStyle = result.bundle.citationStyle === "APA 7" || result.bundle.citationStyle === "Chicago"
        ? result.bundle.citationStyle
        : "IEEE";
      updateDraft((current) => ({ ...current, style: importedStyle, citations: result.bundle.citations.map((citation) => ({ ...citation })) }), `Imported ${result.bundle.citations.length} citation entr${result.bundle.citations.length === 1 ? "y" : "ies"} from file into the renderer preview.`);
      setCitationBundleStatus(`Imported ${result.bundle.citations.length} citation entr${result.bundle.citations.length === 1 ? "y" : "ies"} from ${file.name}.`);
      setCitationBundleImport("");
    } catch {
      setCitationBundleStatus("The selected citation bundle could not be read; no citations were changed.");
    }
  };

  const copyCitationBundle = async () => {
    if (!navigator.clipboard?.writeText) {
      setCitationBundleStatus("Clipboard unavailable; no citation bundle was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(citationBundlePayload);
      setCitationBundleStatus(`Copied the renderer-local ${citationBundleFormat.toUpperCase()} citation bundle.`);
    } catch {
      setCitationBundleStatus("Clipboard access was denied; no citation bundle was copied.");
    }
  };

  const downloadCitationBundle = () => {
    const url = URL.createObjectURL(new Blob([citationBundlePayload], { type: citationBundleFormat === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-academic-citations.${citationBundleFormat === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setCitationBundleStatus(`Started a browser download of the renderer-local ${citationBundleFormat.toUpperCase()} citation bundle.`);
  };

  const removeCitation = (id: string) => {
    updateDraft((current) => ({ ...current, citations: current.citations.filter((item) => item.id !== id) }), "Removed a renderer-local citation placeholder.");
  };

  const resetDraft = () => {
    updateDraft(() => cloneDraft(initialDraft), "Academic draft preview reset.");
    setCustomSection("");
    setCitationLabel("");
    setCitationText("");
    setCitationBundleImport("");
    setCitationBundleStatus("Paste a JSON bundle or portable Markdown to import citation placeholders.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; no draft was copied."); return; }
    try { await navigator.clipboard.writeText(exportPayload); setStatus(`Copied ${draft.format.toUpperCase()} academic draft preview.`); } catch { setStatus("Clipboard access was denied; no draft was copied."); }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([exportPayload], { type: draft.format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `omnia-academic-draft-preview.${draft.format === "json" ? "json" : "md"}`; anchor.click(); URL.revokeObjectURL(url); setStatus("Downloaded a renderer-local academic draft.");
  };

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[nextIndex] ?? "outline");
  };

  return <section className="academic-studio" aria-labelledby="academic-studio-heading">
    <header className="academic-studio__header">
      <div><span className="eyebrow">Writing · reports · citations</span><h2 id="academic-studio-heading">Academic Studio</h2><p>Build a Vietnamese or English report outline, keep citations reviewable, and export a portable draft.</p></div>
      <div className="academic-studio__header-actions">
        <span className="academic-studio__badge"><Sparkles size={13} /> Renderer-local draft</span>
        <div className="academic-studio__history" role="group" aria-label="Academic draft history">
          <button type="button" className="button button--ghost" onClick={undo} disabled={history.length === 0} aria-label="Undo academic draft action" title="Undo"><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={future.length === 0} aria-label="Redo academic draft action" title="Redo"><Redo2 size={13} /> Redo</button>
        </div>
      </div>
    </header>
    <div className="academic-studio__controls">
      <label><span>Language</span><select value={draft.language} onChange={(event) => updateDraft((current) => ({ ...current, language: event.target.value as AcademicLanguage }))}><option>Vietnamese</option><option>English</option></select></label>
      <label><span>Citation style</span><select value={draft.style} onChange={(event) => updateDraft((current) => ({ ...current, style: event.target.value as CitationStyle }))}><option>IEEE</option><option>APA 7</option><option>Chicago</option></select></label>
      <label><span>Tone</span><select value={draft.tone} onChange={(event) => updateDraft((current) => ({ ...current, tone: event.target.value as AcademicTone }))}><option>Evidence-first</option><option>Socratic</option><option>Executive</option></select></label>
      <label><span>Audience</span><select value={draft.audience} onChange={(event) => updateDraft((current) => ({ ...current, audience: event.target.value as AcademicAudience }))}><option>CSE / engineering</option><option>General reader</option><option>Research supervisor</option></select></label>
      <label className="academic-studio__title"><span>Working title</span><input value={draft.title} onChange={(event) => updateDraft((current) => ({ ...current, title: event.target.value }))} /></label>
      <button type="button" className="button button--ghost" onClick={resetDraft}><RotateCcw size={13} /> Reset draft</button>
    </div>
    <nav className="academic-studio__tabs" role="tablist" aria-label="Academic studio views">{tabs.map((entry, index) => <button key={entry} type="button" role="tab" id={`academic-tab-${entry}`} aria-controls={`academic-panel-${entry}`} aria-selected={tab === entry} tabIndex={tab === entry ? 0 : -1} className={tab === entry ? "is-active" : ""} onClick={() => setTab(entry)} onKeyDown={(event) => moveTab(event, index)}>{entry === "outline" ? <ListPlus size={14} /> : entry === "plan" ? <BookOpen size={14} /> : entry === "draft" ? <FileText size={14} /> : entry === "review" ? <ClipboardCheck size={14} /> : entry === "citations" ? <Quote size={14} /> : <Download size={14} />}{entry === "plan" ? "Research plan" : entry.charAt(0).toUpperCase() + entry.slice(1)}</button>)}</nav>
    {tab === "outline" ? <div id="academic-panel-outline" role="tabpanel" tabIndex={0} aria-labelledby="academic-tab-outline" className="academic-studio__layout"><div className="academic-studio__card"><div className="academic-studio__card-heading"><div><span className="eyebrow">Structure</span><h3>Report outline</h3></div><span>{draft.outline.filter((item) => item.done).length}/{draft.outline.length} drafted</span></div><div className="academic-studio__outline-actions" role="group" aria-label="Outline progress actions"><button type="button" className="button button--ghost" onClick={() => setAllProgress(true)}>Mark all drafted</button><button type="button" className="button button--ghost" onClick={() => setAllProgress(false)}>Clear progress</button></div><div className="academic-studio__outline">{draft.outline.map((item, index) => <article key={item.id} className={`academic-studio__outline-item academic-studio__outline-item--level-${item.level}`}><button type="button" className="academic-studio__outline-toggle" aria-pressed={item.done} onClick={() => toggle(item.id)}><span className={item.done ? "is-done" : ""}>{item.done ? <Check size={14} /> : <span />}</span><strong>{item.title}</strong><small>{item.note}</small></button><div className="academic-studio__outline-item-actions" role="group" aria-label={`Actions for ${item.title}`}><button type="button" className="button button--ghost" onClick={() => moveSection(item.id, -1)} disabled={index === 0} aria-label={`Move ${item.title} up`} title="Move up"><ArrowUp size={13} /></button><button type="button" className="button button--ghost" onClick={() => moveSection(item.id, 1)} disabled={index === draft.outline.length - 1} aria-label={`Move ${item.title} down`} title="Move down"><ArrowDown size={13} /></button><button type="button" className="button button--ghost" onClick={() => removeSection(item.id)} aria-label={`Remove ${item.title}`} title="Remove"><Trash2 size={13} /></button></div></article>)}</div><div className="academic-studio__add"><input aria-label="New outline section" placeholder="Add a section" value={customSection} onChange={(event) => setCustomSection(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addSection(); }} /><button type="button" className="button button--secondary" onClick={addSection}><Plus size={13} /> Add section</button></div></div><aside className="academic-studio__card academic-studio__brief"><span className="eyebrow">Briefing prompts</span><h3>Keep the argument honest</h3><ul><li>What is observed versus inferred?</li><li>Which source needs a human check?</li><li>What would falsify the claim?</li></ul><p><BookOpen size={14} /> Draft assistance is structural only; no source was fetched or verified.</p></aside></div> : null}
    {tab === "plan" ? <div id="academic-panel-plan" role="tabpanel" tabIndex={0} aria-labelledby="academic-tab-plan" className="academic-studio__plan"><section className="academic-studio__card"><div className="academic-studio__card-heading"><div><span className="eyebrow">Question → method → evidence</span><h3>Research plan</h3></div><span>{planCompletion}/{planFields.length} fields shaped</span></div><div className="academic-studio__plan-method"><label><span>Method</span><select aria-label="Research method" value={draft.researchPlan.method} onChange={(event) => updateDraft((current) => ({ ...current, researchPlan: { ...current.researchPlan, method: event.target.value as AcademicMethod } }), "Updated the renderer-local research method.")}><option>Literature review</option><option>Experiment</option><option>Benchmark</option><option>Case study</option><option>Mixed methods</option></select></label><div className="academic-studio__plan-meter" aria-label={`Research plan completeness ${planCompletion} of ${planFields.length}`}><span>Plan completeness</span><strong>{Math.round((planCompletion / planFields.length) * 100)}%</strong><div><span style={{ width: `${Math.round((planCompletion / planFields.length) * 100)}%` }} /></div></div></div><div className="academic-studio__plan-grid">{planFields.map(({ key, label, placeholder, multiline }) => <label key={key}><span>{label}</span>{multiline ? <textarea aria-label={label} rows={key === "question" || key === "hypothesis" ? 3 : 2} placeholder={placeholder} value={draft.researchPlan[key]} onChange={(event) => updateDraft((current) => ({ ...current, researchPlan: { ...current.researchPlan, [key]: event.target.value } }), `Updated the renderer-local ${label.toLowerCase()}.`)} /> : <input aria-label={label} placeholder={placeholder} value={draft.researchPlan[key]} onChange={(event) => updateDraft((current) => ({ ...current, researchPlan: { ...current.researchPlan, [key]: event.target.value } }), `Updated the renderer-local ${label.toLowerCase()}.`)} />}</label>)}</div></section><aside className="academic-studio__card academic-studio__plan-brief"><span className="eyebrow">Planning cues</span><h3>Make the next check measurable</h3><ul><li>State what would count as supporting or contradicting evidence.</li><li>Keep assumptions separate from observed results.</li><li>Record the smallest follow-up that could change the conclusion.</li></ul><div className="academic-studio__plan-facts"><span><strong>{draft.researchPlan.method}</strong><small>method rehearsal</small></span><span><strong>{draft.citations.length}</strong><small>citation placeholders</small></span><span><strong>{draft.reviewItems.filter((item) => item.status === "ready").length}</strong><small>review gates ready</small></span></div><p className="academic-studio__boundary"><BookOpen size={14} /> Structure only: no study was run, no participant data was collected, and no source was independently verified.</p></aside></div> : null}
    {tab === "draft" ? <div id="academic-panel-draft" role="tabpanel" tabIndex={0} aria-labelledby="academic-tab-draft" className="academic-studio__card academic-studio__draft"><label><span>Abstract / executive summary</span><textarea value={draft.abstractText} onChange={(event) => updateDraft((current) => ({ ...current, abstractText: event.target.value }))} rows={7} /></label><div className="academic-studio__draft-preview"><span className="eyebrow">Rendered heading</span><h3>{draft.title}</h3><p>{draft.abstractText}</p><div className="academic-studio__draft-meta"><span>{draft.language}</span><span>{draft.style}</span><span>{draft.tone}</span><span>{draft.audience}</span><span>{draft.outline.length} sections</span><span>{draft.abstractText.trim() ? `${draft.abstractText.trim().split(/\s+/).length} words` : "0 words"}</span></div></div></div> : null}
    {tab === "review" ? <div id="academic-panel-review" role="tabpanel" tabIndex={0} aria-labelledby="academic-tab-review" className="academic-studio__card academic-studio__review"><div className="academic-studio__card-heading"><div><span className="eyebrow">Evidence gates</span><h3>Argument review checklist</h3></div><span>{draft.reviewItems.filter((item) => item.status === "ready").length}/{draft.reviewItems.length} ready</span></div><div className="academic-studio__outline-actions" role="group" aria-label="Review gate actions"><button type="button" className="button button--ghost" onClick={() => setAllReviewReady(true)}>Mark all ready</button><button type="button" className="button button--ghost" onClick={() => setAllReviewReady(false)}>Reopen all</button></div><div className="academic-studio__review-list">{draft.reviewItems.map((item) => <article key={item.id} className="academic-studio__review-item"><div><span className="academic-studio__review-category">{item.category}</span><strong>{item.label}</strong><p>{item.note}</p></div><select aria-label={`Review status for ${item.label}`} value={item.status} onChange={(event) => updateDraft((current) => ({ ...current, reviewItems: current.reviewItems.map((entry) => entry.id === item.id ? { ...entry, status: event.target.value as ReviewStatus } : entry) }))}><option value="open">open</option><option value="needs evidence">needs evidence</option><option value="ready">ready</option></select></article>)}</div><p className="academic-studio__boundary"><ClipboardCheck size={14} /> Review status is a writing aid only; it is not a plagiarism scan, peer review, or source verification.</p></div> : null}
    {tab === "citations" ? <div id="academic-panel-citations" role="tabpanel" tabIndex={0} aria-labelledby="academic-tab-citations" className="academic-studio__card">
      <div className="academic-studio__card-heading"><div><span className="eyebrow">Evidence placeholders</span><h3>Citation review queue</h3></div><span>{draft.citations.length} entries</span></div>
      <div className="academic-studio__citation-add" aria-label="Add citation placeholder"><label><span>Label</span><input aria-label="Citation label" placeholder="[4] Paper or source label" value={citationLabel} onChange={(event) => setCitationLabel(event.target.value)} /></label><label><span>Reference text</span><input aria-label="Citation text" placeholder="Author, year, title..." value={citationText} onChange={(event) => setCitationText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addCitation(); }} /></label><button type="button" className="button button--secondary" onClick={addCitation}><Plus size={13} /> Add citation</button></div>
      <div className="academic-studio__citations">{draft.citations.map((citation) => <article key={citation.id}><div><strong>{citation.label}</strong><p>{citation.text}</p></div><div className="academic-studio__citation-actions"><select aria-label={`Status for ${citation.label}`} value={citation.status} onChange={(event) => updateDraft((current) => ({ ...current, citations: current.citations.map((item) => item.id === citation.id ? { ...item, status: event.target.value as CitationStatus } : item) }))}><option value="placeholder">placeholder</option><option value="needs review">needs review</option><option value="reviewed in session">reviewed in session</option></select><button type="button" className="button button--ghost" onClick={() => removeCitation(citation.id)} aria-label={`Remove ${citation.label}`} title="Remove citation"><Trash2 size={13} /></button></div></article>)}</div>
      <section className="academic-studio__citation-bundle" aria-label="Citation bundle preview"><div className="academic-studio__card-heading"><div><span className="eyebrow">Portable evidence map</span><h3>Citation bundle</h3></div><span>Renderer-local</span></div><div className="academic-studio__citation-bundle-toolbar"><label><span>Format</span><select aria-label="Citation bundle format" value={citationBundleFormat} onChange={(event) => setCitationBundleFormat(event.target.value as AcademicCitationBundleFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyCitationBundle()}><Clipboard size={13} /> Copy bundle</button><button type="button" className="button button--secondary" onClick={downloadCitationBundle}><Download size={13} /> Download bundle</button></div><pre tabIndex={0}><code>{citationBundlePayload}</code></pre><div className="academic-studio__citation-import"><label><span>Paste bundle to import</span><textarea aria-label="Citation bundle import" rows={5} value={citationBundleImport} onChange={(event) => setCitationBundleImport(event.target.value)} placeholder="Paste Omnia JSON, portable Markdown, or a simple Markdown list..." /></label><div className="academic-studio__citation-import-actions"><button type="button" className="button button--secondary" onClick={importCitationBundle}>Import citations</button><button type="button" className="button button--ghost" onClick={() => citationBundleFileRef.current?.click()}>Import file</button><input ref={citationBundleFileRef} className="sr-only" type="file" accept="application/json,text/markdown,text/plain,.json,.md,.markdown,.txt" aria-label="Import citation bundle file" onChange={(event) => void importCitationBundleFile(event)} /><span role="status" aria-live="polite">{citationBundleStatus}</span></div></div></section>
      <p className="academic-studio__boundary"><Quote size={14} /> No URL was fetched and no citation has been independently verified. Bundle copy/download/import stays in this renderer session.</p>
    </div> : null}
    {tab === "export" ? <div id="academic-panel-export" role="tabpanel" tabIndex={0} aria-labelledby="academic-tab-export"><section className="academic-studio__card academic-studio__export" role="region" aria-label="Academic draft export preview"><div className="academic-studio__export-toolbar"><label><span>Format</span><select aria-label="Academic export format" value={draft.format} onChange={(event) => updateDraft((current) => ({ ...current, format: event.target.value as ExportFormat }))}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span role="status" aria-live="polite">{status}</span><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></div><pre tabIndex={0}><code>{exportPayload}</code></pre></section></div> : null}
    <p className="academic-studio__boundary"><BookOpen size={14} /> Preview only: no provider call, file write, plagiarism check, citation verification, or durable document storage occurs here.</p>
  </section>;
}

export default AcademicStudioPreview;
