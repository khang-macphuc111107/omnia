import {
  BrainCircuit,
  Check,
  Clipboard,
  Download,
  Filter,
  FlaskConical,
  LockKeyhole,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

export type SpecialistCatalogTab = "roles" | "personas";

type Lifecycle = "enabled" | "draft" | "planned";
type Evidence = "current" | "planned";
type LifecycleFilter = "all" | Lifecycle;

export interface SpecialistRolePreview {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly expertise: readonly string[];
  readonly input: string;
  readonly output: string;
  readonly ceiling: string;
  readonly evaluation: string;
  readonly lifecycle: Lifecycle;
  readonly evidence: Evidence;
  readonly budget: string;
}

export interface SpecialistPersonaPreview {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly style: string;
  readonly language: string;
  readonly workflow: string;
  readonly lifecycle: Lifecycle;
  readonly evidence: Evidence;
}

export const specialistRolePreviewCatalog: readonly SpecialistRolePreview[] = [
  {
    id: "role.goal-architect",
    name: "Goal Architect",
    category: "Orchestration",
    description: "Turns an ambiguous objective into an evidence-bound goal and task graph.",
    expertise: ["requirements", "planning", "task graphs", "acceptance criteria"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.evidence-researcher",
    name: "Evidence-First Researcher",
    category: "Research",
    description: "Finds, compares, and synthesizes sources with claim-level provenance.",
    expertise: ["literature search", "source ledger", "uncertainty", "synthesis"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.competitive-programming-coach",
    name: "Competitive Programming Coach",
    category: "Computer science",
    description: "Explains algorithms, edge cases, complexity, and contest strategy.",
    expertise: ["algorithms", "data structures", "complexity", "problem solving"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.mathematics-proof-checker",
    name: "Mathematics Proof Checker",
    category: "Mathematics",
    description: "Checks definitions, inference steps, counterexamples, and proof gaps.",
    expertise: ["formal reasoning", "proof review", "counterexamples", "notation"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.physics-modeler",
    name: "Physics Modeler",
    category: "Science",
    description: "Translates phenomena into assumptions, equations, simulations, and limits.",
    expertise: ["dimensional analysis", "mechanics", "simulation", "uncertainty"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.production-rust-engineer",
    name: "Production Rust Engineer",
    category: "Software",
    description: "Designs and reviews robust Rust systems with explicit ownership and failure paths.",
    expertise: ["Rust", "APIs", "concurrency", "observability"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.multimodal-evaluator",
    name: "Multimodal Evaluator",
    category: "AI / evaluation",
    description: "Reviews image, audio, video, and document outputs for fidelity and grounding.",
    expertise: ["multimodal", "fidelity", "grounding", "error taxonomy"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.defensive-security-reviewer",
    name: "Defensive Security Reviewer",
    category: "Cyber defense",
    description: "Reviews supplied systems for defensive weaknesses and safer remediation.",
    expertise: ["threat modeling", "secure design", "dependency risk", "incident triage"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.accessible-product-designer",
    name: "Accessible Product Designer",
    category: "Design",
    description: "Turns technical requirements into modern, keyboard-friendly product flows.",
    expertise: ["interaction design", "accessibility", "design tokens", "UX writing"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.artifact-render-verifier",
    name: "Artifact Render Verifier",
    category: "Quality",
    description: "Checks whether generated documents, diagrams, and data artifacts render faithfully.",
    expertise: ["visual QA", "documents", "diagrams", "release evidence"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.ml-systems-architect",
    name: "ML Systems Architect",
    category: "AI / systems",
    description: "Maps model, data, evaluation, and serving concerns into an observable AI system design.",
    expertise: ["model routing", "evaluation", "data contracts", "observability"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.data-engineer",
    name: "Data Pipeline Engineer",
    category: "Data",
    description: "Designs reliable ingestion, transformation, lineage, and quality checks for user-owned datasets.",
    expertise: ["schemas", "lineage", "quality checks", "batch and stream"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.financial-modeler",
    name: "Financial Modeler",
    category: "Finance",
    description: "Builds transparent scenario models with assumptions, sensitivities, and uncertainty made explicit.",
    expertise: ["scenario analysis", "cash flow", "sensitivity", "risk framing"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.chemistry-lab-planner",
    name: "Chemistry Lab Planner",
    category: "Chemistry",
    description: "Turns a chemistry question into a literature-aware, safety-first experiment planning brief.",
    expertise: ["stoichiometry", "material compatibility", "controls", "hazard review"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.academic-editor",
    name: "Academic Editor",
    category: "Research & writing",
    description: "Shapes technical work into clear bilingual reports while preserving claims, citations, and limitations.",
    expertise: ["technical writing", "citation hygiene", "structure", "Vietnamese / English"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.product-systems-strategist",
    name: "Product Systems Strategist",
    category: "Product",
    description: "Connects user needs, information architecture, interaction flows, and measurable product outcomes.",
    expertise: ["product discovery", "information architecture", "UX flows", "prioritization"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.devops-release-engineer",
    name: "DevOps Release Engineer",
    category: "Delivery",
    description: "Designs reproducible build, CI, evidence, and rollback flows around a concrete release target.",
    expertise: ["CI/CD", "release gates", "artifact receipts", "rollback"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.frontend-interface-engineer",
    name: "Frontend Interface Engineer",
    category: "Software",
    description: "Builds polished, accessible interfaces with resilient states, component contracts, and responsive behavior.",
    expertise: ["React", "design systems", "state modeling", "accessibility"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.data-privacy-steward",
    name: "Data & Privacy Steward",
    category: "Governance",
    description: "Makes data collection, retention, redaction, and export choices legible before a workflow is enabled.",
    expertise: ["data minimization", "redaction", "retention", "consent surfaces"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.knowledge-librarian",
    name: "Knowledge Librarian",
    category: "Research",
    description: "Organizes sources, notes, concepts, and evidence edges into a navigable research workspace.",
    expertise: ["taxonomy", "citation graph", "deduplication", "knowledge capture"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "enabled",
    evidence: "current",
    budget: "24 calls",
  },
  {
    id: "role.quantitative-finance-researcher",
    name: "Quantitative Finance Researcher",
    category: "Finance",
    description: "Explores quantitative finance hypotheses with explicit assumptions, backtest limits, and uncertainty.",
    expertise: ["time series", "factor research", "backtest design", "risk metrics"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "planned",
    evidence: "planned",
    budget: "24 calls",
  },
  {
    id: "role.biomedical-literature-synthesizer",
    name: "Biomedical Literature Synthesizer",
    category: "Science",
    description: "Structures biomedical evidence reviews with study quality, disagreement, and uncertainty visible.",
    expertise: ["systematic review", "study quality", "evidence grading", "uncertainty"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "planned",
    evidence: "planned",
    budget: "24 calls",
  },
  {
    id: "role.hardware-systems-engineer",
    name: "Hardware Systems Engineer",
    category: "Engineering",
    description: "Reviews hardware/software boundaries, interfaces, timing, and resource budgets for embedded systems.",
    expertise: ["embedded systems", "interfaces", "timing", "resource budgets"],
    input: "Task input",
    output: "Task output",
    ceiling: "Bounded operation",
    evaluation: "Verified",
    lifecycle: "draft",
    evidence: "planned",
    budget: "24 calls",
  },
];

export const specialistPersonaPreviewCatalog: readonly SpecialistPersonaPreview[] = [
  { id: "persona.evidence-first-researcher", name: "Evidence-first", description: "Leads with sources, confidence, and explicit unknowns.", style: "Concise", language: "Vietnamese / English", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.socratic-tutor", name: "Socratic tutor", description: "Uses focused questions to help the user discover the reasoning.", style: "Concise", language: "User-selected", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.proof-first-mathematician", name: "Proof-first mathematician", description: "Puts definitions, invariants, and proof obligations before intuition.", style: "Concise", language: "Vietnamese / English", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.production-engineer", name: "Production engineer", description: "Keeps implementation practical, observable, and reversible.", style: "Concise", language: "Vietnamese / English", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.accessible-product-designer", name: "Accessible product designer", description: "Balances visual polish with keyboard, contrast, and content clarity.", style: "Concise", language: "Vietnamese / English", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.defensive-security-reviewer", name: "Defensive security reviewer", description: "Makes risk and authorization boundaries visible without escalating capability.", style: "Concise", language: "Vietnamese / English", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.pair-programmer", name: "Pair programmer", description: "Works in small reversible increments and keeps assumptions visible while coding.", style: "Concise", language: "User-selected", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.research-principal", name: "Research principal", description: "Keeps questions, evidence, uncertainty, and next experiments connected in one thread.", style: "Concise", language: "Vietnamese / English", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.quant-analyst", name: "Quant analyst", description: "Separates signal, assumptions, benchmarks, and risk before drawing a conclusion.", style: "Concise", language: "Vietnamese / English", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.lab-scientist", name: "Lab scientist", description: "Frames experiments around controls, measurement quality, safety, and reproducible notes.", style: "Concise", language: "User-selected", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.systems-operator", name: "Systems operator", description: "Makes state, health, evidence, and rollback options visible during operational work.", style: "Concise", language: "Vietnamese / English", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.bilingual-editor", name: "Bilingual technical editor", description: "Preserves technical meaning while adapting reports for Vietnamese and English readers.", style: "Concise", language: "Vietnamese / English", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.product-discovery", name: "Product discovery lead", description: "Turns rough ideas into testable flows, decisions, and staged scope without losing the user goal.", style: "Concise", language: "User-selected", workflow: "Structured", lifecycle: "enabled", evidence: "current" },
  { id: "persona.autonomy-sandbox", name: "Autonomy sandbox", description: "Explores future agent coordination patterns while keeping every capability explicitly planned.", style: "Concise", language: "Vietnamese / English", workflow: "Structured", lifecycle: "planned", evidence: "current" },
];

function Boundary({ children }: { readonly children: ReactNode }) {
  return <p className="specialist-catalog__boundary"><LockKeyhole size={14} /><span>{children}</span></p>;
}

function statusClass(value: Lifecycle | Evidence): string {
  return value === "enabled" || value === "current" ? "specialist-catalog__chip--teal" : "specialist-catalog__chip--amber";
}

function serializeSelection(
  roles: readonly SpecialistRolePreview[],
  personas: readonly SpecialistPersonaPreview[],
  selectedRoleIds: ReadonlySet<string>,
  selectedPersonaIds: ReadonlySet<string>,
  format: "json" | "markdown",
): string {
  const selectedRoles = roles.filter((role) => selectedRoleIds.has(role.id));
  const selectedPersonas = personas.filter((persona) => selectedPersonaIds.has(persona.id));
  if (format === "markdown") {
    return [
      "# Omnia specialist selection preview",
      "",
      "> Renderer-local shortlist. Role/persona resolution, native grants, and provider dispatch are not performed.",
      "",
      "## Roles",
      ...selectedRoles.map((role) => `- **${role.name}** (${role.category}) — ${role.description}`),
      "",
      "## Personas",
      ...selectedPersonas.map((persona) => `- **${persona.name}** — ${persona.description}`),
    ].join("\n");
  }
  return JSON.stringify({
    schema: "omnia.specialist-selection-preview.v1",
    scope: "renderer-session",
    roles: selectedRoles.map(({ id, name, category, lifecycle, evidence }) => ({ id, name, category, lifecycle, evidence })),
    personas: selectedPersonas.map(({ id, name, lifecycle, evidence }) => ({ id, name, lifecycle, evidence })),
    nativeResolution: "planned",
  }, null, 2);
}

function downloadSelection(payload: string, format: "json" | "markdown"): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-specialist-selection-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export default function SpecialistCatalogPreview() {
  const [tab, setTab] = useState<SpecialistCatalogTab>("roles");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [evidence, setEvidence] = useState<"all" | Evidence>("all");
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>("all");
  const [selectedId, setSelectedId] = useState(specialistRolePreviewCatalog[0]?.id ?? null);
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(() => new Set());
  const [selectedPersonaIds, setSelectedPersonaIds] = useState<Set<string>>(() => new Set());
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [status, setStatus] = useState("Selection is renderer-local and reversible.");

  const categories = useMemo(
    () => Array.from(new Set(specialistRolePreviewCatalog.map((role) => role.category))).sort(),
    [],
  );
  const roles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return specialistRolePreviewCatalog.filter((role) => {
      const haystack = `${role.name} ${role.category} ${role.description} ${role.expertise.join(" ")}`.toLowerCase();
      return (!normalized || haystack.includes(normalized)) && (category === "all" || role.category === category) && (evidence === "all" || role.evidence === evidence) && (lifecycle === "all" || role.lifecycle === lifecycle);
    });
  }, [category, evidence, lifecycle, query]);
  const personas = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return specialistPersonaPreviewCatalog.filter((persona) => {
      const haystack = `${persona.name} ${persona.description} ${persona.style} ${persona.workflow}`.toLowerCase();
      return (!normalized || haystack.includes(normalized)) && (evidence === "all" || persona.evidence === evidence) && (lifecycle === "all" || persona.lifecycle === lifecycle);
    });
  }, [evidence, lifecycle, query]);
  const selectedRole = specialistRolePreviewCatalog.find((role) => role.id === selectedId) ?? roles[0] ?? null;
  const selectedPersona = specialistPersonaPreviewCatalog.find((persona) => persona.id === selectedId) ?? personas[0] ?? null;
  const payload = useMemo(() => serializeSelection(specialistRolePreviewCatalog, specialistPersonaPreviewCatalog, selectedRoleIds, selectedPersonaIds, format), [format, selectedPersonaIds, selectedRoleIds]);

  const resetFilters = () => {
    setQuery("");
    setCategory("all");
    setEvidence("all");
    setLifecycle("all");
  };

  const toggleRole = (id: string) => {
    setSelectedRoleIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      setStatus(`${next.size} role${next.size === 1 ? "" : "s"} shortlisted in this preview.`);
      return next;
    });
  };

  const togglePersona = (id: string) => {
    setSelectedPersonaIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      setStatus(`${next.size} persona${next.size === 1 ? "" : "s"} shortlisted in this preview.`);
      return next;
    });
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; no specialist selection was copied."); return; }
    try { await navigator.clipboard.writeText(payload); setStatus(`Copied ${format.toUpperCase()} specialist selection preview.`); } catch { setStatus("Clipboard access was denied; no specialist selection was copied."); }
  };

  return (
    <section className="specialist-catalog" aria-label="Specialist catalog explorer">
      <header className="specialist-catalog__header">
        <div className="specialist-catalog__hero"><span className="specialist-catalog__hero-icon"><BrainCircuit size={22} /></span><div><span className="eyebrow">Specialist harness</span><h3>Explore roles and personas</h3><p>Search the seeded catalog, compare contracts, and build a renderer-local shortlist.</p></div></div>
        <span className="specialist-catalog__status"><Sparkles size={13} /> Preview only</span>
      </header>

      <div className="specialist-catalog__metrics" role="status" aria-label="Specialist catalog summary">
        <article><Users size={14} /><strong>{specialistRolePreviewCatalog.length}</strong><small>catalog roles</small></article>
        <article><Sparkles size={14} /><strong>{specialistPersonaPreviewCatalog.length}</strong><small>catalog personas</small></article>
        <article><ShieldCheck size={14} /><strong>100 / 40</strong><small>roadmap floor</small></article>
        <article><FlaskConical size={14} /><strong>{selectedRoleIds.size + selectedPersonaIds.size}</strong><small>shortlisted</small></article>
      </div>

      <div className="specialist-catalog__tabs" role="tablist" aria-label="Specialist catalog type">
        <button type="button" role="tab" aria-selected={tab === "roles"} onClick={() => { setTab("roles"); setQuery(""); setCategory("all"); setLifecycle("all"); setSelectedId(roles[0]?.id ?? null); }}><Users size={14} /> Role profiles</button>
        <button type="button" role="tab" aria-selected={tab === "personas"} onClick={() => { setTab("personas"); setQuery(""); setCategory("all"); setLifecycle("all"); setSelectedId(personas[0]?.id ?? null); }}><Sparkles size={14} /> Persona packs</button>
      </div>

      <div className="specialist-catalog__controls">
        <label className="specialist-catalog__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search roles, domains, tags" aria-label="Search specialist catalog" />{query ? <button type="button" aria-label="Clear specialist search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
        {tab === "roles" ? <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Specialist category"><option value="all">All categories</option>{categories.map((value) => <option key={value} value={value}>{value}</option>)}</select></label> : null}
        <label><span>Evidence</span><select value={evidence} onChange={(event) => setEvidence(event.target.value as "all" | Evidence)} aria-label="Specialist evidence"><option value="all">All evidence</option><option value="current">Current</option><option value="planned">Planned</option></select></label>
        <label><span>Lifecycle</span><select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as LifecycleFilter)} aria-label="Specialist lifecycle"><option value="all">All lifecycle</option><option value="enabled">Enabled</option><option value="draft">Draft</option><option value="planned">Planned</option></select></label>
        <button type="button" className="button button--ghost" onClick={resetFilters}><Filter size={14} /> Reset</button>
      </div>

      <div className="specialist-catalog__body">
        <div className="specialist-catalog__list" role="list" aria-label={tab === "roles" ? "Specialist role profiles" : "Specialist persona packs"}>
          {tab === "roles" ? roles.map((role) => <article key={role.id} role="listitem" className={`specialist-catalog__card${role.id === selectedId ? " is-selected" : ""}`}><button type="button" className="specialist-catalog__card-main" onClick={() => setSelectedId(role.id)}><span className="specialist-catalog__card-icon"><BrainCircuit size={16} /></span><span><strong>{role.name}</strong><small>{role.category} · {role.expertise.slice(0, 2).join(" · ")}</small><em><i className={`specialist-catalog__chip ${statusClass(role.evidence)}`}>{role.evidence}</i><i className="specialist-catalog__chip">{role.lifecycle}</i></em></span></button><button type="button" className={`specialist-catalog__shortlist${selectedRoleIds.has(role.id) ? " is-active" : ""}`} aria-label={`${selectedRoleIds.has(role.id) ? "Remove" : "Add"} ${role.name} shortlist`} onClick={() => toggleRole(role.id)}>{selectedRoleIds.has(role.id) ? <Check size={13} /> : <span>+</span>}</button></article>) : personas.map((persona) => <article key={persona.id} role="listitem" className={`specialist-catalog__card${persona.id === selectedId ? " is-selected" : ""}`}><button type="button" className="specialist-catalog__card-main" onClick={() => setSelectedId(persona.id)}><span className="specialist-catalog__card-icon"><Sparkles size={16} /></span><span><strong>{persona.name}</strong><small>{persona.style}</small><em><i className={`specialist-catalog__chip ${statusClass(persona.evidence)}`}>{persona.evidence}</i><i className="specialist-catalog__chip">{persona.lifecycle}</i></em></span></button><button type="button" className={`specialist-catalog__shortlist${selectedPersonaIds.has(persona.id) ? " is-active" : ""}`} aria-label={`${selectedPersonaIds.has(persona.id) ? "Remove" : "Add"} ${persona.name} shortlist`} onClick={() => togglePersona(persona.id)}>{selectedPersonaIds.has(persona.id) ? <Check size={13} /> : <span>+</span>}</button></article>)}
          {((tab === "roles" && roles.length === 0) || (tab === "personas" && personas.length === 0)) ? <div className="specialist-catalog__empty"><Search size={18} /><strong>No catalog entries match</strong><span>Reset filters or search another domain.</span></div> : null}
        </div>

        <aside className="specialist-catalog__detail" aria-label="Selected specialist details">
          {tab === "roles" && selectedRole ? <>
            <header><div><span className="eyebrow">Role profile</span><h4>{selectedRole.name}</h4><small>{selectedRole.id}</small></div><span className={`specialist-catalog__chip ${statusClass(selectedRole.evidence)}`}>{selectedRole.evidence}</span></header>
            <p>{selectedRole.description}</p>
            <div className="specialist-catalog__facts"><div><span>Category</span><strong>{selectedRole.category}</strong></div><div><span>Budget</span><strong>{selectedRole.budget}</strong></div><div><span>Input</span><strong>{selectedRole.input}</strong></div><div><span>Output</span><strong>{selectedRole.output}</strong></div></div>
            <div className="specialist-catalog__detail-section"><span className="eyebrow">Expertise tags</span><div className="specialist-catalog__chips">{selectedRole.expertise.map((tag) => <span key={tag} className="specialist-catalog__chip">{tag}</span>)}</div></div>
            <div className="specialist-catalog__detail-section"><span className="eyebrow">Authority ceiling</span><p>{selectedRole.ceiling}</p><span className="specialist-catalog__evaluation"><Check size={13} /> Evaluation: {selectedRole.evaluation}</span></div>
            <button type="button" className={selectedRoleIds.has(selectedRole.id) ? "button button--secondary" : "button button--primary"} onClick={() => toggleRole(selectedRole.id)}>{selectedRoleIds.has(selectedRole.id) ? <Check size={14} /> : <span>+</span>} {selectedRoleIds.has(selectedRole.id) ? "Shortlisted" : "Add to shortlist"}</button>
          </> : null}
          {tab === "personas" && selectedPersona ? <>
            <header><div><span className="eyebrow">Persona pack</span><h4>{selectedPersona.name}</h4><small>{selectedPersona.id}</small></div><span className={`specialist-catalog__chip ${statusClass(selectedPersona.evidence)}`}>{selectedPersona.evidence}</span></header>
            <p>{selectedPersona.description}</p>
            <div className="specialist-catalog__facts"><div><span>Style</span><strong>{selectedPersona.style}</strong></div><div><span>Language</span><strong>{selectedPersona.language}</strong></div><div><span>Workflow</span><strong>{selectedPersona.workflow}</strong></div><div><span>Authority</span><strong>None granted</strong></div></div>
            <button type="button" className={selectedPersonaIds.has(selectedPersona.id) ? "button button--secondary" : "button button--primary"} onClick={() => togglePersona(selectedPersona.id)}>{selectedPersonaIds.has(selectedPersona.id) ? <Check size={14} /> : <span>+</span>} {selectedPersonaIds.has(selectedPersona.id) ? "Shortlisted" : "Add to shortlist"}</button>
          </> : <div className="specialist-catalog__empty"><Search size={18} /><strong>Select a catalog entry</strong><span>Its contract and evidence will appear here.</span></div>}
        </aside>
      </div>

      <div className="specialist-catalog__export">
        <div><strong>{selectedRoleIds.size + selectedPersonaIds.size} shortlisted</strong><small>{status}</small></div>
        <button type="button" className="button button--ghost" onClick={() => { setSelectedRoleIds(new Set()); setSelectedPersonaIds(new Set()); setStatus("Shortlist reset to empty; no native resolution was changed."); }}><RotateCcw size={13} /> Reset shortlist</button>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="specialist-selection-preview"><Clipboard size={13} /> {exportOpen ? "Hide export" : "Preview selection"}</button>
      </div>
      {exportOpen ? <section id="specialist-selection-preview" className="specialist-catalog__export-preview" aria-label="Specialist selection preview"><header><div><span className="eyebrow">Renderer-local selection</span><h4>Role/persona shortlist</h4></div><span className="specialist-catalog__chip specialist-catalog__chip--teal">No native resolution</span></header><div className="specialist-catalog__export-toolbar"><label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")} aria-label="Specialist selection format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span role="status" aria-live="polite">{status}</span><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={() => setStatus(downloadSelection(payload, format) ? "Browser download started; native catalog was not changed." : "Download unavailable; no selection was exported.")}><Download size={13} /> Download</button></div><pre><code>{payload}</code></pre><Boundary>Role/persona selection is a renderer-session preview. Native profile resolution, child ceilings, grants, receipts, provider dispatch, and durable persistence remain planned.</Boundary></section> : null}
      <Boundary>Roles define bounded operational contracts; personas shape presentation only. This explorer reads a seeded catalog snapshot and does not grant tools, secrets, permissions, or execution authority.</Boundary>
    </section>
  );
}
