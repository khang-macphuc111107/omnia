import {
  BookOpen,
  Check,
  CheckCircle2,
  Clipboard,
  FileText,
  Filter,
  Layers,
  Link2,
  ListChecks,
  Plus,
  Quote,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { CitationGraphPreview } from "./citation-graph-preview";

type NotebookTab = "overview" | "sources" | "notes" | "brief" | "graph";
type SourceKind = "document" | "conversation" | "web";
type SourceKindFilter = "all" | SourceKind;
type SourceStateFilter = "all" | NotebookSource["state"];
type SourceSort = "default" | "title" | "citations";

type NotebookSource = {
  id: string;
  title: string;
  kind: SourceKind;
  origin: string;
  state: "ready" | "review" | "planned";
  trust: "primary" | "workspace" | "preview";
  excerpt: string;
  citations: number;
  updated: string;
  tags: string[];
};

type NotebookNote = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  sourceIds: string[];
  updated: string;
};

const seedSources: NotebookSource[] = [
  {
    id: "source-harness",
    title: "Harness architecture notes",
    kind: "document",
    origin: "Omnia design docs",
    state: "ready",
    trust: "primary",
    excerpt: "A deterministic run harness should freeze intent, context, route, and idempotency before provider dispatch.",
    citations: 8,
    updated: "Updated today",
    tags: ["harness", "architecture", "runs"],
  },
  {
    id: "source-context",
    title: "Context compiler research",
    kind: "document",
    origin: "Research collection",
    state: "ready",
    trust: "primary",
    excerpt: "Every selected evidence item needs scope, revision, hash, reason, and a visible omission record.",
    citations: 6,
    updated: "Updated yesterday",
    tags: ["retrieval", "evidence", "provenance"],
  },
  {
    id: "source-memory-chat",
    title: "Local-first memory discussion",
    kind: "conversation",
    origin: "Research notebook chat",
    state: "review",
    trust: "workspace",
    excerpt: "Memory proposals should stay reviewable and reversible; inferred facts must not silently become active context.",
    citations: 4,
    updated: "Updated 2 days ago",
    tags: ["memory", "review", "policy"],
  },
  {
    id: "source-provider",
    title: "Provider comparison scratchpad",
    kind: "web",
    origin: "Connected source placeholder",
    state: "planned",
    trust: "preview",
    excerpt: "Web retrieval and live source freshness are represented as a planned lane until an approved connector is available.",
    citations: 0,
    updated: "Not retrieved in preview",
    tags: ["providers", "comparison", "planned"],
  },
];

const seedNotes: NotebookNote[] = [
  {
    id: "note-thesis",
    title: "Working thesis",
    body: "Omnia should make every answer inspectable: source selection, route choice, and uncertainty belong in the same user-visible workspace.",
    tags: ["thesis", "product"],
    sourceIds: ["source-harness", "source-context"],
    updated: "Saved in preview",
  },
  {
    id: "note-open-question",
    title: "Open question: source freshness",
    body: "How should a notebook show that a citation became stale while preserving the earlier answer and its original source revision?",
    tags: ["open question", "freshness"],
    sourceIds: ["source-context", "source-provider"],
    updated: "Saved in preview",
  },
];

const firstSource = seedSources[0]!;
const firstNote = seedNotes[0]!;

const notebookTabs: readonly [NotebookTab, string][] = [
  ["overview", "Overview"],
  ["sources", "Sources"],
  ["notes", "Notes"],
  ["brief", "Brief draft"],
  ["graph", "Evidence graph"],
];

const sourceKindLabel: Record<SourceKind, string> = {
  document: "Document",
  conversation: "Conversation",
  web: "Connected source",
};

const sourceStateLabel: Record<NotebookSource["state"], string> = {
  ready: "Ready in preview",
  review: "Needs review",
  planned: "Planned connector",
};

function sourceMatches(source: NotebookSource, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${source.title} ${source.kind} ${source.origin} ${source.excerpt} ${source.tags.join(" ")}`
    .toLowerCase()
    .includes(normalized);
}

function ResearchMetric({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: "blue" | "green" | "amber" | "violet";
}) {
  return (
    <article className={`research-notebook__metric research-notebook__metric--${tone}`}>
      <span className="research-notebook__metric-icon">{icon}</span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </article>
  );
}

function SourceCard({
  source,
  selected,
  onSelect,
}: {
  source: NotebookSource;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={selected ? "research-notebook__source-card research-notebook__source-card--selected" : "research-notebook__source-card"}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="research-notebook__source-icon" aria-hidden="true">
        {source.kind === "conversation" ? <Quote size={16} /> : source.kind === "web" ? <Link2 size={16} /> : <FileText size={16} />}
      </span>
      <span className="research-notebook__source-main">
        <span className="research-notebook__source-title-row">
          <strong>{source.title}</strong>
          <small>{sourceKindLabel[source.kind]}</small>
        </span>
        <span className="research-notebook__source-origin">{source.origin}</span>
        <span className="research-notebook__source-excerpt">{source.excerpt}</span>
        <span className="research-notebook__source-footer">
          <small className={`research-notebook__state research-notebook__state--${source.state}`}>{sourceStateLabel[source.state]}</small>
          <small>{source.citations} citation{source.citations === 1 ? "" : "s"}</small>
        </span>
      </span>
    </button>
  );
}

export function ResearchNotebookPreview() {
  const [tab, setTab] = useState<NotebookTab>("overview");
  const [query, setQuery] = useState("");
  const [sourceKindFilter, setSourceKindFilter] = useState<SourceKindFilter>("all");
  const [sourceStateFilter, setSourceStateFilter] = useState<SourceStateFilter>("all");
  const [sourceSort, setSourceSort] = useState<SourceSort>("default");
  const [selectedSourceId, setSelectedSourceId] = useState(firstSource.id);
  const [selectedNoteId, setSelectedNoteId] = useState(firstNote.id);
  const [notes, setNotes] = useState(seedNotes);
  const [briefReady, setBriefReady] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("Notebook is a renderer-local preview.");
  const tabRefs = useRef<Partial<Record<NotebookTab, HTMLButtonElement | null>>>({});

  const filteredSources = useMemo(() => {
    const matches = seedSources.filter((source) => (
      sourceMatches(source, query)
      && (sourceKindFilter === "all" || source.kind === sourceKindFilter)
      && (sourceStateFilter === "all" || source.state === sourceStateFilter)
    ));
    if (sourceSort === "title") return matches.sort((left, right) => left.title.localeCompare(right.title));
    if (sourceSort === "citations") return matches.sort((left, right) => right.citations - left.citations || left.title.localeCompare(right.title));
    return matches;
  }, [query, sourceKindFilter, sourceStateFilter, sourceSort]);
  const selectedSource = seedSources.find((source) => source.id === selectedSourceId) ?? firstSource;
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? firstNote;
  const exportPayload = useMemo(() => JSON.stringify({
    format: "omnia.research-notebook.preview.v1",
    scope: "renderer-session",
    title: "Omnia research notebook",
    question: "How can Omnia make research inspectable without hiding uncertainty?",
    sources: seedSources.map(({ id, title, kind, origin, state, citations, tags }) => ({ id, title, kind, origin, state, citations, tags })),
    notes: notes.map(({ id, title, body, tags, sourceIds }) => ({ id, title, body, tags, sourceIds })),
    nativeWrite: "planned",
    retrieval: "not-run-in-preview",
  }, null, 2), [notes]);

  const updateNote = (patch: Partial<NotebookNote>) => {
    if (!selectedNote) return;
    setNotes((current) => current.map((note) => note.id === selectedNote.id ? { ...note, ...patch, updated: "Edited in preview" } : note));
  };

  const addNote = () => {
    const id = `note-preview-${Date.now()}`;
    const note: NotebookNote = {
      id,
      title: "Untitled note",
      body: "Capture a claim, question, or counterexample here.",
      tags: ["draft"],
      sourceIds: [selectedSource.id],
      updated: "Created in preview",
    };
    setNotes((current) => [...current, note]);
    setSelectedNoteId(id);
    setTab("notes");
    setStatus("Added a renderer-local note; nothing was written to disk.");
  };

  const moveNotebookTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const key = event.key;
    const targetIndex = key === "ArrowRight"
      ? (index + 1) % notebookTabs.length
      : key === "ArrowLeft"
        ? (index - 1 + notebookTabs.length) % notebookTabs.length
        : key === "Home"
          ? 0
          : key === "End"
            ? notebookTabs.length - 1
            : null;
    if (targetIndex === null) return;
    event.preventDefault();
    const target = notebookTabs[targetIndex]?.[0];
    if (!target) return;
    setTab(target);
    window.requestAnimationFrame(() => tabRefs.current[target]?.focus());
  };

  const clearSourceFilters = () => {
    setQuery("");
    setSourceKindFilter("all");
    setSourceStateFilter("all");
    setSourceSort("default");
  };

  const linkSelectedSource = () => {
    if (!selectedNote) return;
    if (selectedNote.sourceIds.includes(selectedSource.id)) {
      setStatus(`${selectedSource.title} is already linked to this note.`);
      return;
    }
    updateNote({ sourceIds: [...selectedNote.sourceIds, selectedSource.id] });
    setStatus(`Linked ${selectedSource.title} in this renderer-local note.`);
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable in this preview.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setCopied(true);
      setStatus("Notebook JSON preview copied.");
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setStatus("Clipboard access is unavailable in this preview.");
    }
  };

  return (
    <section className="research-notebook-preview" aria-label="Research notebook preview">
      <header className="research-notebook__header">
        <div className="research-notebook__title-block">
          <span className="eyebrow"><BookOpen size={14} /> Research canvas</span>
          <h2>Research notebook</h2>
          <p>Collect sources, map claims, and draft a grounded brief without losing provenance.</p>
        </div>
        <div className="research-notebook__header-actions">
          <span className="research-notebook__boundary-badge"><Sparkles size={12} /> Renderer preview</span>
          <button type="button" className="button button--secondary" title={exportOpen ? "Hide the notebook export preview" : "Preview the renderer-local notebook export"} onClick={() => setExportOpen((open) => !open)}>
            {exportOpen ? <X size={14} /> : <Clipboard size={14} />} {exportOpen ? "Hide export" : "Export preview"}
          </button>
          <button type="button" className="button button--primary" title="Create a new renderer-local research note" onClick={addNote}><Plus size={14} /> New note</button>
        </div>
      </header>

      <div className="research-notebook__boundary" role="note">
        <ShieldCheck size={15} />
        <span><strong>No retrieval or file access is running here.</strong> Sources, notes, citations, and synthesis are editable preview state; native connectors, durable writes, and provider requests remain planned.</span>
      </div>

      <div className="research-notebook__metrics" aria-label="Research notebook summary">
        <ResearchMetric icon={<Layers size={17} />} label="Sources" value={String(seedSources.length)} detail="4 in this canvas" tone="blue" />
        <ResearchMetric icon={<ListChecks size={17} />} label="Claims" value="3" detail="2 supported · 1 open" tone="green" />
        <ResearchMetric icon={<Target size={17} />} label="Questions" value="2" detail="Need follow-up" tone="amber" />
        <ResearchMetric icon={<CheckCircle2 size={17} />} label="Coverage" value="72%" detail="Heuristic preview" tone="violet" />
      </div>

      <nav className="research-notebook__tabs" role="tablist" aria-label="Research notebook views" aria-orientation="horizontal">
        {notebookTabs.map(([value, label], index) => (
          <button
            key={value}
            type="button"
            id={`research-notebook-tab-${value}`}
            role="tab"
            title={`Open the ${value === "overview" ? "notebook overview" : value === "sources" ? "source list" : value === "notes" ? "notes and claims" : value === "brief" ? "brief draft" : "evidence graph"} view`}
            aria-selected={tab === value}
            aria-controls={`research-notebook-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            className={tab === value ? "active" : ""}
            ref={(element) => { tabRefs.current[value] = element; }}
            onClick={() => setTab(value)}
            onKeyDown={(event) => moveNotebookTab(event, index)}
          >
            {label}
            {value === "sources" ? <small>{seedSources.length}</small> : null}
            {value === "notes" ? <small>{notes.length}</small> : null}
            {value === "graph" ? <small>10</small> : null}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="research-notebook__panel research-notebook__overview" id="research-notebook-panel-overview" role="tabpanel" tabIndex={0} aria-label="Research notebook overview">
          <article className="research-notebook__question-card">
            <div className="research-notebook__section-heading"><span><Target size={15} /><strong>Research question</strong></span><small>Working scope</small></div>
            <h3>How can Omnia make research inspectable without hiding uncertainty?</h3>
            <p>Use the notebook as a visible bridge between source material, claims, open questions, and the next chat turn.</p>
            <div className="research-notebook__claim-list">
              <div><CheckCircle2 size={15} /><span><strong>Supported:</strong> provenance should survive retrieval, summarization, and export.</span></div>
              <div><CheckCircle2 size={15} /><span><strong>Supported:</strong> uncertain or stale evidence must remain visible.</span></div>
              <div><span className="research-notebook__claim-dot" /><span><strong>Open:</strong> how much source detail should be promoted into a provider context?</span></div>
            </div>
            <button type="button" className="button button--secondary" title="Open the research brief synthesis preview" onClick={() => setTab("brief")}><Sparkles size={14} /> Draft a synthesis</button>
            <button type="button" className="button button--ghost" title="Open the evidence graph preview" onClick={() => setTab("graph")}><Link2 size={14} /> Map evidence graph</button>
          </article>
          <aside className="research-notebook__evidence-card">
            <div className="research-notebook__section-heading"><span><ShieldCheck size={15} /><strong>Evidence coverage</strong></span><small>Preview heuristic</small></div>
            {[
              ["Source identity", 100],
              ["Claim support", 72],
              ["Freshness checks", 44],
              ["Contradiction review", 28],
            ].map(([label, value]) => (
              <div className="research-notebook__coverage-row" key={label as string}>
                <span><small>{label}</small><strong>{value}%</strong></span>
                <span className="research-notebook__coverage-track"><span style={{ width: `${value}%` }} /></span>
              </div>
            ))}
            <p className="research-notebook__muted">Coverage is a renderer estimate, not proof that a provider retrieved or verified a source.</p>
          </aside>
        </div>
      ) : null}

      {tab === "sources" ? (
        <div className="research-notebook__panel research-notebook__sources-panel" id="research-notebook-panel-sources" role="tabpanel" tabIndex={0} aria-label="Notebook sources">
          <div className="research-notebook__sources-list">
            <div className="research-notebook__search-row">
              <label className="research-notebook__search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sources or tags" aria-label="Search notebook sources" />{query ? <button type="button" aria-label="Clear source search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
              <button type="button" className="button button--ghost" title="Rehearse source intake; file and URL connectors are unavailable in this preview" onClick={() => setStatus("Source intake is preview-only; no file or URL picker was opened.")}><Filter size={13} /> Add source</button>
            </div>
            <div className="research-notebook__source-filters" aria-label="Notebook source filters">
              <label className="research-notebook__source-filter"><span>Type</span><select aria-label="Filter notebook sources by type" value={sourceKindFilter} onChange={(event) => setSourceKindFilter(event.target.value as SourceKindFilter)}><option value="all">All types</option><option value="document">Documents</option><option value="conversation">Conversations</option><option value="web">Connected sources</option></select></label>
              <label className="research-notebook__source-filter"><span>Evidence state</span><select aria-label="Filter notebook sources by evidence state" value={sourceStateFilter} onChange={(event) => setSourceStateFilter(event.target.value as SourceStateFilter)}><option value="all">All states</option><option value="ready">Ready in preview</option><option value="review">Needs review</option><option value="planned">Planned connector</option></select></label>
              <label className="research-notebook__source-filter"><span>Sort</span><select aria-label="Sort notebook sources by" value={sourceSort} onChange={(event) => setSourceSort(event.target.value as SourceSort)}><option value="default">Notebook order</option><option value="title">Title A–Z</option><option value="citations">Most citation anchors</option></select></label>
              {(query || sourceKindFilter !== "all" || sourceStateFilter !== "all" || sourceSort !== "default") ? <button type="button" className="button button--ghost" title="Clear source search, type, state, and sort filters" onClick={clearSourceFilters}>Reset source view</button> : null}
            </div>
            <div className="research-notebook__source-count" role="status">{filteredSources.length} of {seedSources.length} sources visible</div>
            {filteredSources.map((source) => <SourceCard key={source.id} source={source} selected={source.id === selectedSource.id} onSelect={() => setSelectedSourceId(source.id)} />)}
            {filteredSources.length === 0 ? <div className="research-notebook__empty"><Search size={21} /><strong>No matching sources</strong><span>Try a title, source kind, or tag.</span></div> : null}
          </div>
          <aside className="research-notebook__source-detail">
            <div className="research-notebook__section-heading"><span><FileText size={15} /><strong>Source detail</strong></span><small>{sourceKindLabel[selectedSource.kind]}</small></div>
            <h3>{selectedSource.title}</h3>
            <p className="research-notebook__source-detail-origin">{selectedSource.origin} · {selectedSource.updated}</p>
            <div className="research-notebook__detail-status"><span className={`research-notebook__state research-notebook__state--${selectedSource.state}`}>{sourceStateLabel[selectedSource.state]}</span><span>{selectedSource.citations} citation anchors</span></div>
            <blockquote><Quote size={14} />{selectedSource.excerpt}</blockquote>
            <div className="research-notebook__tag-list">{selectedSource.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
            <dl className="research-notebook__detail-facts">
              <div><dt>Trust tier</dt><dd>{selectedSource.trust}</dd></div>
              <div><dt>Retrieval</dt><dd>{selectedSource.state === "planned" ? "Not run" : "Not run in preview"}</dd></div>
              <div><dt>Stable citation</dt><dd>{selectedSource.citations > 0 ? "Preview anchors" : "Planned"}</dd></div>
            </dl>
            <button type="button" className="button button--secondary" title="Pin this source in the renderer-local notebook preview" onClick={() => setStatus(`Selected ${selectedSource.title}; source pinning remains renderer-local.`)}><Link2 size={14} /> Pin source in preview</button>
          </aside>
        </div>
      ) : null}

      {tab === "notes" ? (
        <div className="research-notebook__panel research-notebook__notes-panel" id="research-notebook-panel-notes" role="tabpanel" tabIndex={0} aria-label="Notebook notes">
          <div className="research-notebook__notes-list">
            <div className="research-notebook__search-row"><div className="research-notebook__section-heading"><span><ListChecks size={15} /><strong>Notes and claims</strong></span><small>Editable preview</small></div><button type="button" className="button button--ghost" title="Create a new renderer-local research note" onClick={addNote}><Plus size={13} /> New note</button></div>
            {notes.map((note) => <button type="button" key={note.id} title={`Select note: ${note.title}`} className={note.id === selectedNote?.id ? "research-notebook__note-card research-notebook__note-card--selected" : "research-notebook__note-card"} aria-pressed={note.id === selectedNote?.id} onClick={() => setSelectedNoteId(note.id)}><span className="research-notebook__note-card-title"><strong>{note.title}</strong><small>{note.updated}</small></span><span>{note.body}</span><span className="research-notebook__tag-list">{note.tags.map((tag) => <small key={tag}>#{tag}</small>)}</span></button>)}
          </div>
          {selectedNote ? (
            <aside className="research-notebook__note-editor">
              <div className="research-notebook__section-heading"><span><BookOpen size={15} /><strong>Edit note</strong></span><small>Renderer-local</small></div>
              <label><span>Title</span><input value={selectedNote.title} onChange={(event) => updateNote({ title: event.target.value })} /></label>
              <label><span>Body</span><textarea value={selectedNote.body} onChange={(event) => updateNote({ body: event.target.value })} rows={7} /></label>
              <label><span>Tags</span><input aria-label="Note tags" value={selectedNote.tags.join(", ")} onChange={(event) => updateNote({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} placeholder="thesis, follow-up, review" /></label>
              <div className="research-notebook__linked-sources"><strong>Linked sources</strong><span>{selectedNote.sourceIds.map((sourceId) => seedSources.find((source) => source.id === sourceId)?.title).filter(Boolean).join(" · ") || "No sources linked yet"}</span><button type="button" className="button button--ghost" title="Link the selected source to this note in the renderer preview" onClick={linkSelectedSource}>Link selected source</button></div>
              <small className="research-notebook__muted">Edits stay in this renderer session and are not written to memory or project files.</small>
            </aside>
          ) : null}
        </div>
      ) : null}

      {tab === "brief" ? (
        <div className="research-notebook__panel research-notebook__brief-panel" id="research-notebook-panel-brief" role="tabpanel" tabIndex={0} aria-label="Notebook brief draft">
          <div className="research-notebook__brief-main">
            <div className="research-notebook__section-heading"><span><Sparkles size={15} /><strong>Grounded brief draft</strong></span><small>{briefReady ? "Drafted in preview" : "Not drafted"}</small></div>
            {!briefReady ? (
              <div className="research-notebook__brief-empty"><Sparkles size={26} /><h3>Turn the notebook into a working synthesis</h3><p>This deterministic preview will combine the selected claims and show where evidence is missing.</p><button type="button" className="button button--primary" title="Draft a deterministic synthesis preview without a provider request" onClick={() => { setBriefReady(true); setStatus("Drafted a deterministic synthesis preview; no provider request was sent."); }}><Sparkles size={14} /> Draft synthesis preview</button></div>
            ) : (
              <>
                <div className="research-notebook__brief-callout"><strong>Thesis</strong><p>Omnia's research surface should make source provenance, uncertainty, and next actions visible in one continuous loop.</p></div>
                <h3>What the sources support</h3>
                <ul className="research-notebook__brief-list"><li>Freeze source identity and context scope before a grounded answer.</li><li>Keep stale, missing, and planned sources visible instead of smoothing them away.</li><li>Let users turn a claim into a note, a follow-up question, or a chat handoff.</li></ul>
                <h3>Open questions</h3>
                <ul className="research-notebook__brief-list research-notebook__brief-list--open"><li>Which source revision should a future run pin?</li><li>How should contradictory claims be compared without rewriting history?</li></ul>
              </>
            )}
          </div>
          <aside className="research-notebook__brief-side"><div className="research-notebook__section-heading"><span><Quote size={15} /><strong>Citation trail</strong></span><small>{briefReady ? "3 anchors" : "Preview"}</small></div><div className="research-notebook__citation-row"><span>[1]</span><span>Harness architecture notes</span><small>8 anchors</small></div><div className="research-notebook__citation-row"><span>[2]</span><span>Context compiler research</span><small>6 anchors</small></div><div className="research-notebook__citation-row research-notebook__citation-row--planned"><span>[3]</span><span>Connected source freshness</span><small>Planned</small></div><p className="research-notebook__muted">These are local citation labels, not provider-verified citations.</p></aside>
        </div>
      ) : null}

      {tab === "graph" ? (
        <div className="research-notebook__panel research-notebook__graph-panel" id="research-notebook-panel-graph" role="tabpanel" tabIndex={0} aria-label="Notebook evidence graph">
          <CitationGraphPreview />
        </div>
      ) : null}

      {exportOpen ? <section className="research-notebook__export" aria-label="Research notebook export preview"><header><div><span className="eyebrow">Renderer-local export</span><h3>Notebook JSON bundle</h3><p>No file was written; browser download and durable export remain planned.</p></div><div><button type="button" className="button button--secondary" title="Copy the renderer-local notebook export" onClick={() => void copyExport()}>{copied ? <Check size={13} /> : <Clipboard size={13} />} {copied ? "Copied" : "Copy"}</button><button type="button" className="button button--ghost" title="Close the notebook export preview" onClick={() => setExportOpen(false)} aria-label="Close notebook export"><X size={14} /></button></div></header><pre aria-label="Notebook JSON export payload" tabIndex={0}>{exportPayload}</pre></section> : null}

      <footer className="research-notebook__status" role="status" aria-live="polite"><span>{status}</span><span>Preview only · no durable write</span></footer>
    </section>
  );
}
