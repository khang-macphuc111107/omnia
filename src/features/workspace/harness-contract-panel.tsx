import { ChevronRight, CircleAlert, Clipboard, Layers3, Network, Search, ShieldCheck, Sparkles, Target, Workflow } from "lucide-react";
import { useMemo, useState } from "react";

import { HarnessCapabilitySynthesisPanel } from "./harness-capability-synthesis";

type HarnessContractCategory = "Workflow" | "Agents" | "Context" | "Tools & MCP" | "Evaluation";
type HarnessContractState = "Partial" | "Preview" | "Planned";
type HarnessContractFormat = "json" | "markdown";

type HarnessContract = {
  readonly id: string;
  readonly category: HarnessContractCategory;
  readonly title: string;
  readonly state: HarnessContractState;
  readonly summary: string;
  readonly authority: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly evidence: string;
  readonly missing: readonly string[];
  readonly next: string;
};

const CONTRACTS: readonly HarnessContract[] = [
  {
    id: "workflow.run-freeze",
    category: "Workflow",
    title: "Run intent and freeze",
    state: "Partial",
    summary: "Freeze intent, route, parameters, context, policy, and idempotency before a provider request.",
    authority: "Native run snapshot and event journal",
    inputs: ["User intent", "Resolved route", "Context manifest", "Policy revision"],
    outputs: ["Run snapshot", "Attempt lineage", "Replay cursor"],
    evidence: "Provider-stream run projection is present; renderer labels the remaining coverage explicitly.",
    missing: ["Complete event vocabulary", "Cross-process replay proof", "Final idempotency receipt"],
    next: "Connect the native snapshot/read contract before showing a dispatch-ready state.",
  },
  {
    id: "agents.identity-lineage",
    category: "Agents",
    title: "Agent identity and lineage",
    state: "Planned",
    summary: "Give every agent a stable identity, parent/child relationship, bounded authority, lease, and handoff lineage.",
    authority: "Supervisor, lease broker, and durable mailbox",
    inputs: ["Role revision", "Parent ceiling", "Task packet", "Context fork"],
    outputs: ["Agent profile receipt", "Child ceiling", "Handoff/checkpoint"],
    evidence: "Agent Mesh is a renderer-local rehearsal of the target graph, mailbox, and lease records.",
    missing: ["Native scheduler", "Lease fencing", "Durable mailbox", "Completion judge"],
    next: "Admit one typed native identity/lease slice before enabling agent actions.",
  },
  {
    id: "context.manifest",
    category: "Context",
    title: "Context manifest and transfer",
    state: "Partial",
    summary: "Make selected sources, revisions, omissions, memory, skills, and compaction decisions inspectable.",
    authority: "Immutable context records and compiler receipt",
    inputs: ["Conversation scope", "Project sources", "Memory policy", "Skill revisions"],
    outputs: ["Source manifest", "Compiled prompt input", "Omission reasons"],
    evidence: "Project Context and context-harness previews expose source/revision and omission vocabulary.",
    missing: ["Native immutable records", "Frozen provider input hash", "Memory/skill delivery receipt"],
    next: "Wire the native compiler receipt into the inspector without inferring authority from UI state.",
  },
  {
    id: "tools.mcp-manifest",
    category: "Tools & MCP",
    title: "Tool and MCP capability manifest",
    state: "Planned",
    summary: "Describe identity, digest, schema, effects, data classes, destinations, limits, tests, and update state.",
    authority: "Capability broker and host-side revalidation",
    inputs: ["Tool manifest", "Argument schema", "Permission scope", "Network policy"],
    outputs: ["Admission decision", "Approval request", "Audit event"],
    evidence: "Extensions & MCP and permission surfaces show catalog metadata only; no tool is granted here.",
    missing: ["Signature verification", "Host revalidation", "Approval binding", "Execution receipt"],
    next: "Keep tool actions preview-only until brokered admission and receipts exist.",
  },
  {
    id: "evaluation.quality-gates",
    category: "Evaluation",
    title: "Evaluation and completion gates",
    state: "Planned",
    summary: "Judge artifacts against acceptance, deterministic checks, failure modes, stop conditions, and evidence coverage.",
    authority: "Independent reviewer/judge and evidence ledger",
    inputs: ["Goal acceptance", "Artifact outputs", "Test receipt", "Open risks"],
    outputs: ["Quality decision", "Repair loop", "Escalation or handoff"],
    evidence: "Catalog profiles carry rubrics and deterministic checks; an end-to-end completion judge is not wired.",
    missing: ["Independent runtime judge", "Same-snapshot evidence", "Promotion receipt"],
    next: "Add a read-only judge projection that cannot promote work without native evidence.",
  },
];

const categoryIcons: Record<HarnessContractCategory, typeof Workflow> = {
  Workflow,
  Agents: Network,
  Context: Layers3,
  "Tools & MCP": ShieldCheck,
  Evaluation: Target,
};

const stateClass: Record<HarnessContractState, string> = {
  Partial: "partial",
  Preview: "preview",
  Planned: "planned",
};

function serializeContract(contract: HarnessContract, format: HarnessContractFormat): string {
  if (format === "markdown") {
    return [
      `# ${contract.title}`,
      "",
      `- Category: ${contract.category}`,
      `- State: ${contract.state}`,
      `- Authority: ${contract.authority}`,
      "",
      contract.summary,
      "",
      "## Inputs",
      ...contract.inputs.map((item) => `- ${item}`),
      "",
      "## Outputs",
      ...contract.outputs.map((item) => `- ${item}`),
      "",
      `Evidence: ${contract.evidence}`,
      "",
      "Missing native evidence:",
      ...contract.missing.map((item) => `- ${item}`),
      "",
      `Next: ${contract.next}`,
      "",
      "> Renderer-local contract preview. No native authority, provider dispatch, tool grant, or durable write is created.",
    ].join("\n");
  }
  return JSON.stringify({
    schema: "omnia.harness-contract.preview.v1",
    scope: "renderer-session",
    contract,
    boundary: "No native authority, provider dispatch, tool grant, or durable write",
  }, null, 2);
}

export function HarnessContractPanel() {
  const [category, setCategory] = useState<"all" | HarnessContractCategory>("all");
  const [state, setState] = useState<"all" | HarnessContractState>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(CONTRACTS[0]?.id ?? "");
  const [format, setFormat] = useState<HarnessContractFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [status, setStatus] = useState("Renderer-local contract map; native harness authority is not connected.");

  const filteredContracts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return CONTRACTS.filter((contract) => {
      const haystack = `${contract.title} ${contract.category} ${contract.summary} ${contract.authority} ${contract.missing.join(" ")}`.toLowerCase();
      return (!normalized || haystack.includes(normalized)) && (category === "all" || contract.category === category) && (state === "all" || contract.state === state);
    });
  }, [category, query, state]);

  const selected = filteredContracts.find((contract) => contract.id === selectedId) ?? filteredContracts[0] ?? null;
  const payload = selected ? serializeContract(selected, format) : "No contract matches the current filters.";

  const copyContract = async () => {
    if (!selected || !navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; no contract preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied ${selected.title} as ${format.toUpperCase()}; no durable write was made.`);
    } catch {
      setStatus("Clipboard access was denied; the contract remains renderer-local.");
    }
  };

  return (
    <section className="harness-contract-panel" aria-labelledby="harness-contract-panel-heading">
      <header className="harness-contract-panel__header">
        <div className="harness-contract-panel__heading">
          <span className="harness-contract-panel__mark" aria-hidden="true"><Network size={17} /></span>
          <div>
            <span className="eyebrow"><Sparkles size={13} /> Harness contract map</span>
            <h2 id="harness-contract-panel-heading">Make the harness boundary inspectable</h2>
            <p>Compare workflow, agent, context, tool, and evaluation contracts before any native authority is admitted.</p>
          </div>
        </div>
        <span className="harness-contract-panel__badge"><CircleAlert size={13} /> Preview only</span>
      </header>

      <div className="harness-contract-panel__metrics" aria-label="Harness contract summary">
        <article><Workflow size={15} /><strong>{CONTRACTS.length}</strong><span>contract slices</span></article>
        <article><ShieldCheck size={15} /><strong>{CONTRACTS.filter((contract) => contract.state === "Partial").length}</strong><span>partial evidence</span></article>
        <article><Target size={15} /><strong>{CONTRACTS.filter((contract) => contract.state === "Planned").length}</strong><span>planned authority</span></article>
        <article><CircleAlert size={15} /><strong>0</strong><span>native grants here</span></article>
      </div>

      <div className="harness-contract-panel__toolbar" role="toolbar" aria-label="Harness contract filters">
        <label className="harness-contract-panel__search"><Search size={14} /><span className="sr-only">Search harness contracts</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search contracts, evidence, or gaps" aria-label="Search harness contracts" /></label>
        <label><span>Domain</span><select aria-label="Harness contract domain" value={category} onChange={(event) => setCategory(event.target.value as "all" | HarnessContractCategory)}><option value="all">All domains</option>{(Object.keys(categoryIcons) as HarnessContractCategory[]).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label><span>Evidence</span><select aria-label="Harness contract evidence state" value={state} onChange={(event) => setState(event.target.value as "all" | HarnessContractState)}><option value="all">All states</option><option value="Partial">Partial</option><option value="Preview">Preview</option><option value="Planned">Planned</option></select></label>
        <span className="harness-contract-panel__count" role="status" aria-live="polite">{filteredContracts.length} of {CONTRACTS.length} visible</span>
      </div>

      <div className="harness-contract-panel__body">
        <div className="harness-contract-panel__list" role="list" aria-label="Harness contract slices">
          {filteredContracts.length ? filteredContracts.map((contract) => {
            const Icon = categoryIcons[contract.category];
            return <div role="listitem" key={contract.id} className="harness-contract-card__item"><button type="button" className={`harness-contract-card${selected?.id === contract.id ? " is-selected" : ""}`} onClick={() => setSelectedId(contract.id)} aria-label={`${contract.title}. ${contract.state}`}>
              <span className="harness-contract-card__icon"><Icon size={15} /></span>
              <span className="harness-contract-card__copy"><strong>{contract.title}</strong><small>{contract.category} · {contract.summary}</small></span>
              <span className={`harness-contract-card__state harness-contract-card__state--${stateClass[contract.state]}`}>{contract.state}</span>
              <ChevronRight size={14} aria-hidden="true" />
            </button></div>;
          }) : <div className="harness-contract-panel__empty"><Search size={17} /><strong>No contract matches</strong><span>Adjust the search or evidence filters.</span></div>}
        </div>

        <aside className="harness-contract-panel__detail" aria-label="Selected harness contract">
          {selected ? <>
            <div className="harness-contract-panel__detail-heading"><div><span className="eyebrow">{selected.category} · {selected.id}</span><h3>{selected.title}</h3></div><span className={`harness-contract-card__state harness-contract-card__state--${stateClass[selected.state]}`}>{selected.state}</span></div>
            <p className="harness-contract-panel__summary">{selected.summary}</p>
            <dl className="harness-contract-panel__facts"><div><dt>Authority</dt><dd>{selected.authority}</dd></div><div><dt>Evidence</dt><dd>{selected.evidence}</dd></div><div><dt>Next</dt><dd>{selected.next}</dd></div></dl>
            <div className="harness-contract-panel__columns"><section><h4>Inputs</h4><ul>{selected.inputs.map((item) => <li key={item}>{item}</li>)}</ul></section><section><h4>Outputs</h4><ul>{selected.outputs.map((item) => <li key={item}>{item}</li>)}</ul></section></div>
            <section className="harness-contract-panel__gaps"><h4><CircleAlert size={14} /> Missing native evidence</h4><ul>{selected.missing.map((item) => <li key={item}>{item}</li>)}</ul></section>
            <div className="harness-contract-panel__actions"><button type="button" className="button button--secondary" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="harness-contract-export"><Clipboard size={13} /> {exportOpen ? "Hide export" : "Preview contract"}</button><span className="harness-contract-panel__status" role="status" aria-live="polite">{status}</span></div>
          </> : <div className="harness-contract-panel__empty"><Target size={17} /><strong>Select a contract</strong><span>Its authority boundary and evidence gaps appear here.</span></div>}
        </aside>
      </div>

      {exportOpen && selected ? <section id="harness-contract-export" className="harness-contract-panel__export" aria-label="Selected harness contract export preview"><div className="harness-contract-panel__export-toolbar"><label><span>Format</span><select aria-label="Harness contract export format" value={format} onChange={(event) => setFormat(event.target.value as HarnessContractFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyContract()}><Clipboard size={13} /> Copy</button></div><pre tabIndex={0}>{payload}</pre></section> : null}

      <HarnessCapabilitySynthesisPanel />

      <p className="harness-contract-panel__boundary"><ShieldCheck size={14} /><span>Renderer-local contract map. It does not spawn agents, send mailbox messages, acquire leases, grant tools, call providers, execute commands, read the filesystem, or persist state.</span></p>
    </section>
  );
}

export default HarnessContractPanel;
