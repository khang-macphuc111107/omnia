import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  FileCheck2,
  Filter,
  Info,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
} from "lucide-react";

export type DeliveryEvidenceStatus =
  | "pass"
  | "partial"
  | "blocked"
  | "unknown"
  | "planned";

export type DeliveryEvidenceGroup = "source" | "renderer" | "native" | "release";

export interface DeliveryEvidenceItem {
  readonly id: string;
  readonly title: string;
  readonly group: DeliveryEvidenceGroup;
  readonly status: DeliveryEvidenceStatus;
  readonly summary: string;
  readonly receipt: string;
  readonly source: string;
  readonly coverage: string;
  readonly nextStep: string;
}

const STATUS_LABELS: Record<DeliveryEvidenceStatus, string> = {
  pass: "Recorded pass",
  partial: "Partial",
  blocked: "Blocked",
  unknown: "Unknown",
  planned: "Planned",
};

const GROUP_LABELS: Record<DeliveryEvidenceGroup, string> = {
  source: "Source & spec",
  renderer: "Renderer gates",
  native: "Native boundary",
  release: "Release readiness",
};

/**
 * Evidence intentionally describes a recorded checkpoint, not a live command
 * result. Keeping this fixture in one place makes the distinction visible in
 * the UI and keeps exports deterministic for the preview.
 */
export const DELIVERY_EVIDENCE_ITEMS: readonly DeliveryEvidenceItem[] = Object.freeze([
  {
    id: "spec-contracts",
    title: "Spec and schema validation",
    group: "source",
    status: "pass",
    summary: "Normative documents and schema registries have a recorded validation receipt.",
    receipt: "121 Markdown files · 52 JSON files · 55 requirement rows · 55 capability rows",
    source: "docs/omnia-ultra/tools/validate-spec.ps1",
    coverage: "Contract and registry shape only; it does not prove implementation or runtime behavior.",
    nextStep: "Re-run after the final writer freeze so docs and source stay on the same snapshot.",
  },
  {
    id: "source-ledger",
    title: "Source ledger",
    group: "source",
    status: "partial",
    summary: "The ledger records local hashes and documented sources, but the crosswalk is still incomplete.",
    receipt: "94 sources recorded · 38 local hashes · 47 documented-only URLs",
    source: "docs/omnia-ultra/delivery/source-ledger.json",
    coverage: "Provenance inventory; requirement, capability, test, evidence, and Twin mappings are not complete.",
    nextStep: "Complete the crosswalk and regenerate the ledger on the same frozen source snapshot.",
  },
  {
    id: "project-twin",
    title: "Project Twin projection",
    group: "source",
    status: "partial",
    summary: "A current-tree graph and atlas can be generated, but later edits can make the projection stale.",
    receipt: "Bootstrap/check receipts exist for a frozen snapshot; no live authority is implied.",
    source: "docs/project-twin/manifest.json",
    coverage: "Evidence-linked projection of the named catalog, not the entire requirements registry.",
    nextStep: "Regenerate and check immediately after all writers stop; retain the resulting revision ID.",
  },
  {
    id: "renderer-gates",
    title: "Renderer typecheck and build",
    group: "renderer",
    status: "pass",
    summary: "A recorded renderer checkpoint covers TypeScript and the browser bundle.",
    receipt: "App typecheck and renderer build have recorded passing checkpoints in this continuation.",
    source: "package.json · npm run typecheck:app · npm run build:renderer",
    coverage: "Renderer syntax, types, and bundling; not Tauri packaging or native Rust compilation.",
    nextStep: "Repeat the lightweight gates once concurrent UI writers have stopped.",
  },
  {
    id: "native-runtime",
    title: "Rust, Tauri, and provider runtime",
    group: "native",
    status: "unknown",
    summary: "The current host does not provide a verified native compile or packaged runtime receipt.",
    receipt: "cargo, rustc, rustfmt, and rustup are unavailable on this host.",
    source: "src-tauri/ · native core protocol and storage contracts",
    coverage: "Static source/schema checks only; native compile, close/reopen, concurrency, package, and provider HTTP remain unverified.",
    nextStep: "Run the native gate on a supported Windows toolchain and keep the receipt tied to this source revision.",
  },
  {
    id: "acceptance-coverage",
    title: "Acceptance and capability coverage",
    group: "renderer",
    status: "partial",
    summary: "The ledger separates target status from current proof, but many acceptance rows still need same-snapshot receipts.",
    receipt: "Capability inventory currently reports 11 partial rows and 44 planned rows.",
    source: "docs/omnia-ultra/delivery/capability-ledger.json · acceptance-gates.md",
    coverage: "Inventory and target-state traceability; a targetStatus is not an implementation receipt.",
    nextStep: "Attach focused tests, build receipts, and native evidence per acceptance ID before promotion.",
  },
  {
    id: "release-readiness",
    title: "Packaged release and signing",
    group: "release",
    status: "planned",
    summary: "Omnia remains an unsigned internal/developer preview in this workspace.",
    receipt: "No packaged Windows artifact, signing receipt, migration rehearsal, or rollback receipt is attached here.",
    source: "docs/IMPLEMENTATION_STATUS.md · acceptance-gates.md",
    coverage: "No release artifact or update-channel evidence.",
    nextStep: "Add isolated build, signing, migration, health-check, reconnect, resume, and rollback evidence.",
  },
]);

type FilterValue = "all" | "attention" | DeliveryEvidenceStatus;

function statusIcon(status: DeliveryEvidenceStatus) {
  if (status === "pass") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === "partial") return <Info size={14} aria-hidden="true" />;
  if (status === "blocked" || status === "unknown") return <AlertTriangle size={14} aria-hidden="true" />;
  return <Sparkles size={14} aria-hidden="true" />;
}

function statusLabel(status: DeliveryEvidenceStatus): string {
  return STATUS_LABELS[status];
}

function serializeEvidence(items: readonly DeliveryEvidenceItem[], format: "json" | "markdown"): string {
  const counts = items.reduce<Record<DeliveryEvidenceStatus, number>>(
    (result, item) => {
      result[item.status] += 1;
      return result;
    },
    { pass: 0, partial: 0, blocked: 0, unknown: 0, planned: 0 },
  );
  const payload = {
    schema: "omnia.delivery-evidence.preview.v1",
    scope: "renderer-session",
    snapshot: "recorded-checkpoints-2026-09-19",
    counts,
    items,
    boundary: [
      "Recorded checkpoints are not live command results.",
      "Renderer preview does not create native receipts or release authority.",
      "Unknown is not pass, zero, healthy, or unlimited.",
    ],
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia delivery evidence preview",
    "",
    "> Renderer-session status board. Recorded checkpoints are not live command results.",
    "",
    `- Snapshot label: ${payload.snapshot}`,
    `- Recorded pass: ${counts.pass}`,
    `- Partial: ${counts.partial}`,
    `- Blocked: ${counts.blocked}`,
    `- Unknown: ${counts.unknown}`,
    `- Planned: ${counts.planned}`,
    "",
    ...items.flatMap((item) => [
      `## ${item.title}`,
      `- Status: ${statusLabel(item.status)}`,
      `- Group: ${GROUP_LABELS[item.group]}`,
      `- Receipt: ${item.receipt}`,
      `- Source: ${item.source}`,
      `- Coverage: ${item.coverage}`,
      `- Next: ${item.nextStep}`,
      "",
    ]),
    "## Boundary",
    "- No native write, provider request, package/signing receipt, or durable evidence receipt was created by this preview.",
  ].join("\n");
}

export function DeliveryEvidenceStatusPreview() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState(DELIVERY_EVIDENCE_ITEMS[0]?.id ?? null);
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [status, setStatus] = useState("Recorded checkpoints are shown as a renderer-local rehearsal.");

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return DELIVERY_EVIDENCE_ITEMS.filter((item) => {
      const matchesQuery = !normalized || [item.title, item.summary, item.receipt, item.source, item.nextStep].join(" ").toLowerCase().includes(normalized);
      const matchesFilter = filter === "all"
        || (filter === "attention" && item.status !== "pass")
        || item.status === filter;
      return matchesQuery && matchesFilter;
    });
  }, [filter, query]);

  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0] ?? null;
  const counts = useMemo(() => DELIVERY_EVIDENCE_ITEMS.reduce<Record<DeliveryEvidenceStatus, number>>(
    (result, item) => {
      result[item.status] += 1;
      return result;
    },
    { pass: 0, partial: 0, blocked: 0, unknown: 0, planned: 0 },
  ), []);
  const payload = useMemo(() => serializeEvidence(visibleItems, format), [format, visibleItems]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-delivery-evidence-preview.${format === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Browser download started; no durable evidence receipt was created.");
  };
  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; no delivery evidence preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied ${format.toUpperCase()} delivery evidence preview; no durable write was made.`);
    } catch {
      setStatus("Clipboard access was denied; nothing was copied.");
    }
  };

  return (
    <section className="delivery-evidence-preview" aria-labelledby="delivery-evidence-preview-heading">
      <header className="delivery-evidence-preview__header">
        <div>
          <span className="eyebrow"><FileCheck2 size={13} /> Delivery · evidence · gates</span>
          <h2 id="delivery-evidence-preview-heading">Delivery evidence status</h2>
          <p>See what is recorded, what is partial, and what still needs a native or release receipt.</p>
        </div>
        <span className="delivery-evidence-preview__badge"><ShieldAlert size={13} /> Preview only</span>
      </header>

      <div className="delivery-evidence-preview__summary" aria-label="Delivery evidence summary">
        <article><CheckCircle2 size={15} /><span>Recorded pass</span><strong>{counts.pass}</strong><small>checkpoint only</small></article>
        <article><Info size={15} /><span>Partial</span><strong>{counts.partial}</strong><small>needs more proof</small></article>
        <article><AlertTriangle size={15} /><span>Unknown</span><strong>{counts.unknown}</strong><small>not verified here</small></article>
        <article><Sparkles size={15} /><span>Planned</span><strong>{counts.planned}</strong><small>future gate</small></article>
      </div>

      <div className="delivery-evidence-preview__toolbar" role="toolbar" aria-label="Delivery evidence filters">
        <label className="delivery-evidence-preview__search"><Search size={14} /><span className="sr-only">Search delivery evidence</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search receipts, sources, or next steps" aria-label="Search delivery evidence" /></label>
        <label><span>Show</span><select value={filter} onChange={(event) => setFilter(event.target.value as FilterValue)} aria-label="Filter delivery evidence"><option value="all">All checks</option><option value="attention">Needs attention</option><option value="pass">Recorded pass</option><option value="partial">Partial</option><option value="blocked">Blocked</option><option value="unknown">Unknown</option><option value="planned">Planned</option></select></label>
        <span
          className="delivery-evidence-preview__result"
          aria-label={`${visibleItems.length} of ${DELIVERY_EVIDENCE_ITEMS.length} checks`}
        >
          <Filter size={13} /> {visibleItems.length} of {DELIVERY_EVIDENCE_ITEMS.length} checks
        </span>
        <button type="button" className="button button--ghost" onClick={() => { setQuery(""); setFilter("all"); setSelectedId(DELIVERY_EVIDENCE_ITEMS[0]?.id ?? null); setStatus("Filters reset; the recorded checkpoint set is unchanged."); }}><RefreshCw size={13} /> Reset view</button>
      </div>

      <div className="delivery-evidence-preview__layout">
        <div className="delivery-evidence-preview__list" role="list" aria-label="Delivery evidence checks">
          {visibleItems.map((item) => (
            <button type="button" role="listitem" key={item.id} className={`delivery-evidence-preview__item${selected?.id === item.id ? " is-selected" : ""}`} onClick={() => setSelectedId(item.id)} aria-pressed={selected?.id === item.id}>
              <span className={`delivery-evidence-preview__status delivery-evidence-preview__status--${item.status}`}>{statusIcon(item.status)} {statusLabel(item.status)}</span>
              <strong>{item.title}</strong>
              <small>{GROUP_LABELS[item.group]} · {item.receipt}</small>
            </button>
          ))}
          {visibleItems.length === 0 ? <div className="delivery-evidence-preview__empty" role="status"><Search size={18} /><strong>No checks match</strong><span>Try a broader search or reset the filter.</span></div> : null}
        </div>

        <aside className="delivery-evidence-preview__detail" aria-label="Selected delivery evidence detail">
          {selected ? (
            <>
              <header><div><span className="eyebrow">{GROUP_LABELS[selected.group]}</span><h3>{selected.title}</h3></div><span className={`delivery-evidence-preview__status delivery-evidence-preview__status--${selected.status}`}>{statusIcon(selected.status)} {statusLabel(selected.status)}</span></header>
              <p>{selected.summary}</p>
              <dl><div><dt>Recorded receipt</dt><dd>{selected.receipt}</dd></div><div><dt>Source</dt><dd>{selected.source}</dd></div><div><dt>Coverage</dt><dd>{selected.coverage}</dd></div><div><dt>Next step</dt><dd>{selected.nextStep}</dd></div></dl>
            </>
          ) : <div className="delivery-evidence-preview__empty"><FileCheck2 size={18} /><strong>Select a check</strong><span>Its receipt and evidence boundary will appear here.</span></div>}
        </aside>
      </div>

      <section className="delivery-evidence-preview__export" aria-label="Delivery evidence export preview">
        <div className="delivery-evidence-preview__export-toolbar"><div><span className="eyebrow">Portable review</span><strong>Export the visible evidence matrix</strong></div><label><span>Format</span><select aria-label="Delivery evidence export format" value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></div>
        <pre tabIndex={0} aria-label={`${format === "json" ? "JSON" : "Markdown"} delivery evidence preview`}><code>{payload}</code></pre>
        <p className="delivery-evidence-preview__status-line" role="status" aria-live="polite">{status}</p>
      </section>

      <p
        className="delivery-evidence-preview__boundary"
        role="note"
        aria-label="Delivery evidence boundary"
      >
        <ShieldAlert size={14} /> Recorded checkpoints are not live command results. This renderer-local surface does not run validators, write source ledgers, regenerate Project Twin, compile Rust, call providers, package, sign, or create durable evidence receipts.
      </p>
    </section>
  );
}

export default DeliveryEvidenceStatusPreview;
