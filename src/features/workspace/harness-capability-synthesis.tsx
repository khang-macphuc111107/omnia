import {
  ArrowDownToLine,
  ArrowRight,
  BookOpenCheck,
  Check,
  CircleAlert,
  Clipboard,
  GitBranch,
  Layers3,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  HARNESS_EVIDENCE_REFRESH,
  HARNESS_SOURCE_EVIDENCE,
  getHarnessSourceEvidence,
} from "./harness-evidence-register";

export type HarnessSynthesisSource = "DeepSeek Harness" | "OpenAI Codex" | "Claude Code";
export type HarnessSynthesisRecommendation = "Adopt" | "Adapt" | "Defer";
export type HarnessSynthesisDomain =
  | "State & projections"
  | "Authority & tools"
  | "Agents & teams"
  | "Context & memory"
  | "Extensions & delivery";
export type HarnessSynthesisFormat = "json" | "markdown";

export type HarnessSynthesisSourceSignal = {
  readonly source: HarnessSynthesisSource;
  readonly signal: string;
};

export type HarnessCapabilitySynthesis = {
  readonly id: string;
  readonly domain: HarnessSynthesisDomain;
  readonly title: string;
  readonly recommendation: HarnessSynthesisRecommendation;
  readonly summary: string;
  readonly signals: readonly HarnessSynthesisSourceSignal[];
  readonly omniaDecision: string;
  readonly boundary: string;
  readonly nextGate: string;
};

export const HARNESS_CAPABILITY_SYNTHESIS: readonly HarnessCapabilitySynthesis[] = [
  {
    id: "state.event-log-projection",
    domain: "State & projections",
    title: "Durable event log and typed projections",
    recommendation: "Adopt",
    summary: "Keep durable facts separate from live deltas and derive UI state from a cursorable projection.",
    signals: [
      { source: "DeepSeek Harness", signal: "Append-only session log with projection registry and sequence watermarks." },
      { source: "OpenAI Codex", signal: "Thread, turn, item, and completion events expose a typed lifecycle." },
      { source: "Claude Code", signal: "Session resume, compaction, and background progress must survive UI navigation." },
    ],
    omniaDecision: "Use a native event/session log as authority; the renderer consumes immutable snapshots and live deltas.",
    boundary: "The current UI is a renderer projection; no native replay or durable write is implied.",
    nextGate: "Connect a native cursor/read contract and prove replay produces the same visible projection.",
  },
  {
    id: "authority.capability-approval",
    domain: "Authority & tools",
    title: "Capability broker and exact approvals",
    recommendation: "Adapt",
    summary: "Model requests can ask for tools, but only a host-side policy can grant a scoped operation.",
    signals: [
      { source: "DeepSeek Harness", signal: "Capability seams separate service definition, provider, and consumer." },
      { source: "OpenAI Codex", signal: "Approval policy, sandbox mode, network access, and working directory are explicit inputs." },
      { source: "Claude Code", signal: "Deny/ask/allow precedence, sandboxing, and allowed domains are independently evaluated." },
    ],
    omniaDecision: "Freeze operation, arguments, environment, policy revision, and approval identities in an exact receipt.",
    boundary: "Preview controls never grant a provider, tool, terminal, network, or filesystem capability.",
    nextGate: "Implement host revalidation and an auditable admission receipt before any side-effecting dispatch.",
  },
  {
    id: "agents.dag-team-mailbox",
    domain: "Agents & teams",
    title: "Agent DAG, leases, and mailbox",
    recommendation: "Adapt",
    summary: "Parallel work needs durable identity, bounded authority, lease fencing, and conflict-aware handoff.",
    signals: [
      { source: "DeepSeek Harness", signal: "Agent Teams use a durable roster, task board/DAG, mailbox, and deduplicated messages." },
      { source: "OpenAI Codex", signal: "Agent graph and worktree state separate thread identity from execution details." },
      { source: "Claude Code", signal: "Subagents, agent teams, worktrees, background sessions, and bounded concurrency are distinct surfaces." },
    ],
    omniaDecision: "Represent goal, task, agent, run, tool, and process as separate graph entities with typed ownership.",
    boundary: "The current Agent Mesh and handoff previews do not spawn workers, acquire leases, or mutate a task queue.",
    nextGate: "Add a native lease/heartbeat slice, then prove stale-worker rejection and idempotent completion.",
  },
  {
    id: "context.manifest-compaction",
    domain: "Context & memory",
    title: "Context manifest, memory, and compaction",
    recommendation: "Adopt",
    summary: "Every model-visible input needs provenance, omission reasons, and a reproducible context boundary.",
    signals: [
      { source: "DeepSeek Harness", signal: "The model-visible context is reconstructed from logged session events." },
      { source: "OpenAI Codex", signal: "Threads can resume, stream, and bind structured output to an explicit schema." },
      { source: "Claude Code", signal: "Startup instructions, auto-memory, tool results, subagent summaries, and compaction are separate inputs." },
    ],
    omniaDecision: "Compile an immutable source manifest with revisions, memory policy, skills, compaction, and omission reasons.",
    boundary: "Context previews expose planned delivery metadata; they do not inject hidden prompts or alter provider context.",
    nextGate: "Persist a context compiler receipt and verify the provider input hash at dispatch time.",
  },
  {
    id: "extensions.provenance-lifecycle",
    domain: "Extensions & delivery",
    title: "Plugins, MCP, skills, and provenance",
    recommendation: "Adapt",
    summary: "Extensibility should be composable without allowing an extension to widen authority silently.",
    signals: [
      { source: "DeepSeek Harness", signal: "Profiles compose ordered bundles and patch layers with live reload only for suitable lifecycles." },
      { source: "OpenAI Codex", signal: "MCP, plugins, skills, and SDK surfaces are cataloged outside the core lifecycle." },
      { source: "Claude Code", signal: "Plugins bundle commands, agents, skills, hooks, MCP, evaluations, and hash-confirmed updates." },
    ],
    omniaDecision: "Require signed/versioned manifests, capability diffs, dependency/license receipts, and explicit activation scope.",
    boundary: "Catalog and import previews are renderer-local; no extension is installed, executed, or granted here.",
    nextGate: "Add a host-side manifest verifier and capability-diff approval before activation or update.",
  },
  {
    id: "delivery.worktree-conflict",
    domain: "Extensions & delivery",
    title: "Worktree isolation and reconciliation",
    recommendation: "Adapt",
    summary: "Concurrent coding requires isolated changes and a reviewable merge boundary instead of last-writer-wins.",
    signals: [
      { source: "DeepSeek Harness", signal: "Team snapshots describe advisory write scopes; shared-file safety remains a scheduler concern." },
      { source: "OpenAI Codex", signal: "Worktrees, sandboxing, and process boundaries keep changes attributable to a thread." },
      { source: "Claude Code", signal: "Worktree spawn modes and Git workflows support parallel review and cleanup." },
    ],
    omniaDecision: "Use copy-on-write/worktrees or semantic-region leases; overlapping edits enter reconciliation.",
    boundary: "The browser preview never writes to the repository or claims that concurrent agents are synchronized.",
    nextGate: "Add a native patch/effect ledger and deterministic conflict receipt before enabling automated merges.",
  },
  {
    id: "delivery.background-remote",
    domain: "Extensions & delivery",
    title: "Background and remote session lifecycle",
    recommendation: "Defer",
    summary: "Long-running work needs a provider-neutral lifecycle for pause, resume, reconnect, drain, and cancellation.",
    signals: [
      { source: "DeepSeek Harness", signal: "Continuable subagents and durable team messages preserve work beyond one turn." },
      { source: "OpenAI Codex", signal: "Thread resume and streamed turns form a process-neutral app-server boundary." },
      { source: "Claude Code", signal: "Remote Control, background sessions, self-hosted runners, and drain markers are current product surfaces." },
    ],
    omniaDecision: "Model background work as a durable job/session adapter with explicit state transitions and receipts.",
    boundary: "The current Background Work screen only projects renderer data; it does not schedule, reconnect, or cancel native jobs.",
    nextGate: "Define a native job lifecycle and recovery receipt before presenting a dispatch or cancel action as available.",
  },
  {
    id: "quality.evaluation-observability",
    domain: "State & projections",
    title: "Evaluation, telemetry, and evidence gates",
    recommendation: "Adapt",
    summary: "Completion should be judged independently with quality, cost, timing, policy, and artifact evidence.",
    signals: [
      { source: "DeepSeek Harness", signal: "Live extension events and durable session facts are intentionally different observability surfaces." },
      { source: "OpenAI Codex", signal: "App-server tests and SDK events expose request, stream, tool, and completion boundaries." },
      { source: "Claude Code", signal: "Plugin evaluation, OpenTelemetry metadata, and completion hooks make quality inspectable." },
    ],
    omniaDecision: "Correlate prompt, model request, tool, approval, agent, artifact, and outcome in a provider-neutral trace graph.",
    boundary: "Renderer metrics and export previews are evidence hints, not proof of native provider health or task completion.",
    nextGate: "Persist a same-snapshot evidence receipt and block promotion when required checks are missing.",
  },
] as const;

const sourceIcons: Record<HarnessSynthesisSource, LucideIcon> = {
  "DeepSeek Harness": Layers3,
  "OpenAI Codex": TerminalSquare,
  "Claude Code": BookOpenCheck,
};

const domainIcons: Record<HarnessSynthesisDomain, LucideIcon> = {
  "State & projections": GitBranch,
  "Authority & tools": ShieldCheck,
  "Agents & teams": Network,
  "Context & memory": Layers3,
  "Extensions & delivery": ArrowDownToLine,
};

const recommendationClass: Record<HarnessSynthesisRecommendation, string> = {
  Adopt: "adopt",
  Adapt: "adapt",
  Defer: "defer",
};

export function filterHarnessCapabilitySynthesis({
  query = "",
  domain = "all",
  recommendation = "all",
  source = "all",
}: {
  readonly query?: string;
  readonly domain?: "all" | HarnessSynthesisDomain;
  readonly recommendation?: "all" | HarnessSynthesisRecommendation;
  readonly source?: "all" | HarnessSynthesisSource;
} = {}): HarnessCapabilitySynthesis[] {
  const normalized = query.trim().toLowerCase();
  return HARNESS_CAPABILITY_SYNTHESIS.filter((item) => {
    if (domain !== "all" && item.domain !== domain) return false;
    if (recommendation !== "all" && item.recommendation !== recommendation) return false;
    if (source !== "all" && !item.signals.some((signal) => signal.source === source)) return false;
    if (!normalized) return true;
    const haystack = [item.title, item.domain, item.summary, item.omniaDecision, item.boundary, item.nextGate, ...item.signals.flatMap((signal) => [signal.source, signal.signal])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

export function serializeHarnessCapabilitySynthesis(items: readonly HarnessCapabilitySynthesis[], format: HarnessSynthesisFormat): string {
  if (format === "markdown") {
    return [
      "# Omnia cross-harness capability synthesis",
      "",
      `> Renderer-local research projection refreshed ${HARNESS_EVIDENCE_REFRESH.refreshedAt}. It does not grant authority or claim feature parity.`,
      `> Evidence basis: ${HARNESS_EVIDENCE_REFRESH.basis}.`,
      "",
      "## Evidence register",
      ...HARNESS_SOURCE_EVIDENCE.flatMap((evidence) => [
        `- ${evidence.source}: ${evidence.repository}@${evidence.revision} (${evidence.revisionDate})`,
        `  - Strength: ${evidence.strength}; license: ${evidence.license}`,
        `  - Snapshot: ${evidence.snapshotPath}`,
        `  - Scope: ${evidence.scope}`,
      ]),
      "",
      ...items.flatMap((item) => [
        `## ${item.title}`,
        `- Domain: ${item.domain}`,
        `- Recommendation: ${item.recommendation}`,
        `- Summary: ${item.summary}`,
        "- Source signals:",
        ...item.signals.map((signal) => `  - ${signal.source}: ${signal.signal}`),
        `- Omnia decision: ${item.omniaDecision}`,
        `- Boundary: ${item.boundary}`,
        `- Next gate: ${item.nextGate}`,
        "",
      ]),
    ].join("\n");
  }
  return JSON.stringify({
    schema: "omnia.harness-capability-synthesis.preview.v1",
    scope: "renderer-session",
    refreshedAt: HARNESS_EVIDENCE_REFRESH.refreshedAt,
    evidenceBasis: HARNESS_EVIDENCE_REFRESH.basis,
    evidenceRegister: HARNESS_SOURCE_EVIDENCE,
    sources: ["DeepSeek Harness", "OpenAI Codex", "Claude Code"],
    items,
    boundary: `${HARNESS_EVIDENCE_REFRESH.boundary} No native authority, provider dispatch, tool grant, agent spawn, or durable write.`,
  }, null, 2);
}

export function HarnessCapabilitySynthesisPanel() {
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState<"all" | HarnessSynthesisDomain>("all");
  const [recommendation, setRecommendation] = useState<"all" | HarnessSynthesisRecommendation>("all");
  const [source, setSource] = useState<"all" | HarnessSynthesisSource>("all");
  const [selectedId, setSelectedId] = useState(HARNESS_CAPABILITY_SYNTHESIS[0]?.id ?? "");
  const [format, setFormat] = useState<HarnessSynthesisFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [status, setStatus] = useState("Renderer-local synthesis; upstream research is reference input only.");

  const filtered = useMemo(
    () => filterHarnessCapabilitySynthesis({ query, domain, recommendation, source }),
    [domain, query, recommendation, source],
  );
  const selected = filtered.find((item) => item.id === selectedId) ?? filtered[0] ?? null;
  const payload = serializeHarnessCapabilitySynthesis(filtered, format);
  const adaptedCount = HARNESS_CAPABILITY_SYNTHESIS.filter((item) => item.recommendation === "Adapt").length;

  const copyPayload = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; the synthesis remains renderer-local.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`${format.toUpperCase()} synthesis copied; no durable write was made.`);
    } catch {
      setStatus("Clipboard access was denied; no durable write was made.");
    }
  };

  return (
    <section className="harness-synthesis-panel" aria-labelledby="harness-synthesis-heading">
      <header className="harness-synthesis-panel__header">
        <div className="harness-synthesis-panel__heading">
          <span className="harness-synthesis-panel__mark" aria-hidden="true"><Sparkles size={17} /></span>
          <div>
            <span className="eyebrow"><Layers3 size={13} /> Cross-harness synthesis</span>
            <h2 id="harness-synthesis-heading">Signals into Omnia decisions</h2>
            <p>Compare reusable architecture signals from pinned local snapshots of DeepSeek Harness, OpenAI Codex, and official Claude Code artifacts.</p>
          </div>
        </div>
        <span className="harness-synthesis-panel__badge"><CircleAlert size={13} /> Preview only · refreshed {HARNESS_EVIDENCE_REFRESH.refreshedAt}</span>
      </header>

      <div className="harness-synthesis-panel__metrics" aria-label="Cross-harness synthesis summary">
        <article><Layers3 size={15} /><strong>3</strong><span>reference systems</span></article>
        <article><Check size={15} /><strong>{HARNESS_CAPABILITY_SYNTHESIS.filter((item) => item.recommendation === "Adopt").length}</strong><span>adopt signals</span></article>
        <article><ArrowRight size={15} /><strong>{adaptedCount}</strong><span>adapt decisions</span></article>
        <article><CircleAlert size={15} /><strong>{HARNESS_CAPABILITY_SYNTHESIS.filter((item) => item.recommendation === "Defer").length}</strong><span>deferred runtime</span></article>
      </div>

      <div className="harness-synthesis-panel__toolbar" role="toolbar" aria-label="Cross-harness synthesis filters">
        <label className="harness-synthesis-panel__search"><Search size={14} /><span className="sr-only">Search capability synthesis</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search signals, decisions, or gaps" aria-label="Search capability synthesis" /></label>
        <label><span>Domain</span><select aria-label="Synthesis domain" value={domain} onChange={(event) => setDomain(event.target.value as "all" | HarnessSynthesisDomain)}><option value="all">All domains</option>{(Object.keys(domainIcons) as HarnessSynthesisDomain[]).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label><span>Decision</span><select aria-label="Synthesis recommendation" value={recommendation} onChange={(event) => setRecommendation(event.target.value as "all" | HarnessSynthesisRecommendation)}><option value="all">All decisions</option><option value="Adopt">Adopt</option><option value="Adapt">Adapt</option><option value="Defer">Defer</option></select></label>
        <label><span>Source</span><select aria-label="Synthesis source" value={source} onChange={(event) => setSource(event.target.value as "all" | HarnessSynthesisSource)}><option value="all">All sources</option>{(Object.keys(sourceIcons) as HarnessSynthesisSource[]).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <span className="harness-synthesis-panel__count" role="status" aria-live="polite">{filtered.length} of {HARNESS_CAPABILITY_SYNTHESIS.length} visible</span>
      </div>

      <div className="harness-synthesis-panel__body">
        <div className="harness-synthesis-panel__list" role="list" aria-label="Cross-harness capability signals">
          {filtered.length ? filtered.map((item) => {
            const Icon = domainIcons[item.domain];
            return <div role="listitem" key={item.id}><button type="button" className={`harness-synthesis-card${selected?.id === item.id ? " is-selected" : ""}`} onClick={() => setSelectedId(item.id)} aria-label={`${item.title}. ${item.recommendation}`}>
              <span className="harness-synthesis-card__icon"><Icon size={15} /></span>
              <span className="harness-synthesis-card__copy"><strong>{item.title}</strong><small>{item.domain} · {item.summary}</small></span>
              <span className={`harness-synthesis-card__recommendation harness-synthesis-card__recommendation--${recommendationClass[item.recommendation]}`}>{item.recommendation}</span>
              <ArrowRight size={14} aria-hidden="true" />
            </button></div>;
          }) : <div className="harness-synthesis-panel__empty"><Search size={17} /><strong>No synthesis row matches</strong><span>Adjust the search or source filters.</span></div>}
        </div>

        <aside className="harness-synthesis-panel__detail" aria-label="Selected cross-harness synthesis">
          {selected ? <>
            <div className="harness-synthesis-panel__detail-heading"><div><span className="eyebrow">{selected.domain} · {selected.id}</span><h3>{selected.title}</h3></div><span className={`harness-synthesis-card__recommendation harness-synthesis-card__recommendation--${recommendationClass[selected.recommendation]}`}>{selected.recommendation}</span></div>
            <p className="harness-synthesis-panel__summary">{selected.summary}</p>
            <section className="harness-synthesis-panel__signals"><h4>Observed source signals</h4>{selected.signals.map((signal) => { const SourceIcon = sourceIcons[signal.source]; const evidence = getHarnessSourceEvidence(signal.source); return <div key={signal.source}><span><SourceIcon size={13} />{signal.source}</span><p>{signal.signal}</p><small className="harness-synthesis-panel__evidence-meta">{evidence.strength} · {evidence.revision.slice(0, 12)} · snapshot {evidence.revisionDate}</small></div>; })}</section>
            <section className="harness-synthesis-panel__source-register" aria-label="Selected source evidence register"><h4>Source evidence register</h4>{selected.signals.map((signal) => { const evidence = getHarnessSourceEvidence(signal.source); return <div key={signal.source}><strong>{evidence.repository}</strong><span>{evidence.license} · {evidence.scope}</span><code>{evidence.snapshotPath}@{evidence.revision}</code></div>; })}</section>
            <dl className="harness-synthesis-panel__facts"><div><dt>Omnia decision</dt><dd>{selected.omniaDecision}</dd></div><div><dt>Boundary</dt><dd>{selected.boundary}</dd></div><div><dt>Next gate</dt><dd>{selected.nextGate}</dd></div></dl>
            <div className="harness-synthesis-panel__actions"><button type="button" className="button button--secondary" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="harness-synthesis-export"><Clipboard size={13} /> {exportOpen ? "Hide export" : "Preview synthesis"}</button><span className="harness-synthesis-panel__status" role="status" aria-live="polite">{status}</span></div>
          </> : <div className="harness-synthesis-panel__empty"><CircleAlert size={17} /><strong>Select a synthesis row</strong><span>Its source evidence and Omnia decision appear here.</span></div>}
        </aside>
      </div>

      {exportOpen ? <section id="harness-synthesis-export" className="harness-synthesis-panel__export" aria-label="Cross-harness synthesis export preview"><div className="harness-synthesis-panel__export-toolbar"><label><span>Format</span><select aria-label="Synthesis export format" value={format} onChange={(event) => setFormat(event.target.value as HarnessSynthesisFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyPayload()}><Clipboard size={13} /> Copy</button></div><pre tabIndex={0}>{payload}</pre></section> : null}

      <p className="harness-synthesis-panel__boundary"><ShieldCheck size={14} /><span>{HARNESS_EVIDENCE_REFRESH.boundary} This panel does not spawn agents, grant capabilities, call providers, execute commands, or persist state.</span></p>
    </section>
  );
}

export default HarnessCapabilitySynthesisPanel;
