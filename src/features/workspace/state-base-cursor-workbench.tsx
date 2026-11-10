import {
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  Clipboard,
  GitBranch,
  GitCompareArrows,
  History,
  Info,
  Layers3,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type {
  RunControlJournalCursor,
  RunControlOperationState,
  StateRevisionEdgeProjection,
  StateRevisionGraphSnapshot,
  StateRevisionProjection,
} from "@/lib/desktop";

import type { RunControlOperationProjection } from "./run-control-projection";

export type StateBaseCursorView = "state-base" | "cursors" | "cas" | "graph";

export interface StateBaseCursorWorkbenchProps {
  /** The latest native projection, when a native resolution/apply receipt exists. */
  operation?: RunControlOperationProjection | null;
  /** A bounded native graph read. No graph is invented when this is absent. */
  graph?: StateRevisionGraphSnapshot | null;
  runtime?: "desktop" | "browser-preview";
  onRefreshGraph?: () => void;
}

function display(value: string | number | null | undefined, fallback = "Unknown"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return typeof value === "number" ? value.toLocaleString() : value;
}

function label(value: string | null | undefined): string {
  return value ? value.replaceAll("-", " ") : "Unknown";
}

function shortId(value: string | null | undefined, fallback = "Unknown"): string {
  if (!value) return fallback;
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function formatTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function cursorIdentity(cursor: RunControlJournalCursor): string {
  return `${cursor.streamKind}:${cursor.streamId}:${cursor.journalEpoch ?? "no-epoch"}:${cursor.sequence}:${cursor.eventId ?? "no-event"}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function copyPreview(value: unknown, setStatus: (message: string) => void): void {
  if (!navigator.clipboard?.writeText) {
    setStatus("Clipboard is unavailable; no preview was copied.");
    return;
  }
  void navigator.clipboard.writeText(safeJson(value)).then(
    () => setStatus("State-base evidence preview copied; no native receipt was created."),
    () => setStatus("Clipboard write failed; no native receipt was created."),
  );
}

function StatusBadge({ tone, children }: { tone: "success" | "warning" | "neutral"; children: ReactNode }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? CircleAlert : CircleHelp;
  return <span className={`state-base-cursor__badge state-base-cursor__badge--${tone}`}><Icon size={13} />{children}</span>;
}

function Fact({ label: factLabel, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return <div className="state-base-cursor__fact"><dt>{factLabel}</dt><dd>{value}</dd>{detail ? <small>{detail}</small> : null}</div>;
}

function CursorRow({ cursor, expected = false }: { cursor: RunControlJournalCursor; expected?: boolean }) {
  return (
    <article className="state-base-cursor__cursor-row">
      <div className="state-base-cursor__cursor-heading">
        <span className="state-base-cursor__cursor-icon"><History size={14} /></span>
        <span><strong>{expected ? "Expected branch cursor" : `${label(cursor.streamKind)} cursor`}</strong><small>{shortId(cursor.streamId)}</small></span>
        <em>seq {cursor.sequence.toLocaleString()}</em>
      </div>
      <dl className="state-base-cursor__cursor-facts">
        <Fact label="Journal epoch" value={<code>{shortId(cursor.journalEpoch, "Not supplied")}</code>} />
        <Fact label="Event" value={<code>{shortId(cursor.eventId, "Not supplied")}</code>} />
        <Fact label="Payload hash" value={<code>{shortId(cursor.payloadHash, "Not supplied")}</code>} />
      </dl>
    </article>
  );
}

function StateBasePanel({ operation }: { operation: RunControlOperationProjection | null }) {
  const nativeBase = operation?.operation.stateBase ?? null;
  if (!nativeBase || !operation) {
    return (
      <div className="state-base-cursor__empty" data-testid="state-base-empty">
        <Layers3 size={25} />
        <strong>No canonical state base is hydrated</strong>
        <p>The renderer will not guess a revision, digest, timestamp, or cursor. A native resolution receipt is required before any durable run-control action can be enabled.</p>
        <StatusBadge tone="neutral">Not hydrated · planned</StatusBadge>
      </div>
    );
  }

  const digest = nativeBase.resolvedStateDigest;
  return (
    <div className="state-base-cursor__panel-grid">
      <section className="state-base-cursor__hero-card">
        <div className="state-base-cursor__hero-heading">
          <span className="state-base-cursor__icon"><ShieldCheck size={17} /></span>
          <div><span className="eyebrow">Native receipt projection</span><h3>Canonical state base</h3><p>Resolved inside the native run-control boundary; values below are read-only.</p></div>
          <StatusBadge tone={operation.durability === "durable" || operation.durability === "replayed" ? "success" : "warning"}>{operation.durability}</StatusBadge>
        </div>
        <dl className="state-base-cursor__facts state-base-cursor__facts--wide">
          <Fact label="Mode" value={label(nativeBase.mode)} />
          <Fact label="Resolution" value={label(nativeBase.resolutionReason)} />
          <Fact label="Revision" value={<code>{shortId(nativeBase.resolvedStateRevisionId)}</code>} />
          <Fact label="Digest" value={<code>{digest.algorithm}:{shortId(digest.value)}</code>} detail={digest.canonicalizationRevision} />
          <Fact label="Resolved at" value={formatTime(nativeBase.resolvedAt)} />
          <Fact label="Context manifest" value={<code>{shortId(nativeBase.contextManifestId, "Not supplied")}</code>} />
        </dl>
      </section>

      <section className="state-base-cursor__lineage-card">
        <header><div><strong>Lineage inputs</strong><small>Immutable selectors carried by the receipt</small></div><GitBranch size={16} /></header>
        <dl className="state-base-cursor__facts">
          <Fact label="Source revision" value={<code>{shortId(nativeBase.sourceStateRevisionId, "Root / none")}</code>} />
          <Fact label="Requested head" value={<code>{shortId(nativeBase.requestedHeadStateRevisionId, "Not supplied")}</code>} />
          <Fact label="Selected deltas" value={nativeBase.selectedDeltaIds.length.toLocaleString()} />
          <Fact label="Operation" value={<code>{shortId(operation.operation.operationId)}</code>} />
        </dl>
        {nativeBase.selectedDeltaIds.length > 0 ? <div className="state-base-cursor__token-list">{nativeBase.selectedDeltaIds.map((id) => <code key={id}>{shortId(id)}</code>)}</div> : <p className="state-base-cursor__muted">No selected deltas were reported by the native receipt.</p>}
      </section>
    </div>
  );
}

function CursorPanel({ operation }: { operation: RunControlOperationProjection | null }) {
  const cursors = operation?.operation.stateBase.resolvedAtCursors ?? [];
  const expected = operation?.operation.expectedBranchCursor ?? null;
  if (cursors.length === 0 && !expected) {
    return <div className="state-base-cursor__empty"><History size={25} /><strong>No cursor provenance is hydrated</strong><p>Cursor values are never inferred from renderer message counts. Native must return stream identity, epoch, sequence, and optional event/hash provenance together.</p><StatusBadge tone="neutral">Unknown · fail closed</StatusBadge></div>;
  }
  const identities = new Set<string>();
  return (
    <div className="state-base-cursor__cursor-panel">
      <div className="state-base-cursor__summary-strip"><span><strong>{cursors.length + (expected ? 1 : 0)}</strong><small>cursor facts</small></span><span><strong>{new Set(cursors.map((item) => item.streamKind)).size}</strong><small>stream kinds</small></span><span><strong>{new Set(cursors.map((item) => item.journalEpoch).filter(Boolean)).size}</strong><small>epochs</small></span></div>
      <div className="state-base-cursor__cursor-list">
        {expected ? <CursorRow cursor={expected} expected /> : null}
        {cursors.map((cursor) => {
          const identity = cursorIdentity(cursor);
          if (identities.has(identity)) return null;
          identities.add(identity);
          return <CursorRow key={identity} cursor={cursor} />;
        })}
      </div>
      <p className="state-base-cursor__boundary"><LockKeyhole size={14} /> Cursor provenance is evidence metadata only in this renderer surface. A cursor does not grant replay, write, provider dispatch, or execution authority.</p>
    </div>
  );
}

function CasPanel({ operation }: { operation: RunControlOperationProjection | null }) {
  const nativeOperation = operation?.operation ?? null;
  if (!nativeOperation) {
    return <div className="state-base-cursor__empty"><GitCompareArrows size={25} /><strong>No branch-head CAS receipt is hydrated</strong><p>Without a native operation receipt, the renderer cannot tell whether a branch head was accepted, stale, conflicted, or already applied.</p><StatusBadge tone="neutral">CAS unknown · planned</StatusBadge></div>;
  }
  const expected = nativeOperation.stateBase.requestedHeadStateRevisionId ?? nativeOperation.expectedBranchCursor?.eventId ?? null;
  const result = nativeOperation.result?.resultStateRevisionId ?? null;
  const status: "success" | "warning" = operation?.status === "applied" || operation?.status === "already-applied" ? "success" : "warning";
  return (
    <div className="state-base-cursor__cas-panel">
      <div className="state-base-cursor__cas-banner"><StatusBadge tone={status}>{label(operation?.status)}</StatusBadge><span>{operation?.diagnostic ?? operation?.blockedReason ?? "Native branch-head compare result is read-only in this preview."}</span></div>
      <div className="state-base-cursor__cas-flow" aria-label="State revision compare and swap flow">
        <article><span>Expected</span><strong><code>{shortId(expected, "No expected head")}</code></strong><small>Caller guard / requested branch head</small></article>
        <GitCompareArrows size={19} aria-hidden="true" />
        <article><span>Observed</span><strong><code>{shortId(nativeOperation.stateBase.resolvedStateRevisionId)}</code></strong><small>Native-resolved state base</small></article>
        <GitCompareArrows size={19} aria-hidden="true" />
        <article><span>Result</span><strong><code>{shortId(result, "No successor")}</code></strong><small>Operation result revision</small></article>
      </div>
      <dl className="state-base-cursor__facts state-base-cursor__facts--wide">
        <Fact label="Operation state" value={label(nativeOperation.operationState as RunControlOperationState)} />
        <Fact label="Idempotency key" value={<code>{shortId(nativeOperation.idempotencyKey)}</code>} />
        <Fact label="Receipt" value={<code>{shortId(nativeOperation.receiptId, "Not supplied")}</code>} />
        <Fact label="Expected conversation version" value={display(nativeOperation.expectedConversationVersion, "Not supplied")} />
      </dl>
      <p className="state-base-cursor__boundary"><ShieldCheck size={14} /> CAS outcome is native-owned. This preview does not retry, rebase, promote, merge, or overwrite a branch head.</p>
    </div>
  );
}

function RevisionStatus({ status }: { status: StateRevisionProjection["status"] }) {
  const tone = status === "accepted" ? "success" : status === "candidate" || status === "outcome-unknown" ? "warning" : "neutral";
  return <StatusBadge tone={tone}>{label(status)}</StatusBadge>;
}

function GraphPanel({ graph, runtime, onRefreshGraph }: { graph: StateRevisionGraphSnapshot | null; runtime: StateBaseCursorWorkbenchProps["runtime"]; onRefreshGraph?: () => void }) {
  if (!graph) {
    return <div className="state-base-cursor__empty"><Waypoints size={25} /><strong>No state-revision graph read is hydrated</strong><p>{runtime === "desktop" ? "A bounded native graph read can populate this view. The current renderer has no graph snapshot to display." : "Browser preview does not call the native graph-read command. A graph is not synthesized from local messages."}</p><StatusBadge tone="neutral">Graph unknown · no native read</StatusBadge>{onRefreshGraph ? <button type="button" className="button button--secondary" onClick={onRefreshGraph}><RefreshCw size={14} /> Request bounded graph read</button> : null}</div>;
  }
  return (
    <div className="state-base-cursor__graph-panel">
      <div className="state-base-cursor__graph-header"><div><span className="eyebrow">Fixed-watermark native projection</span><h3>{shortId(graph.streamId)}</h3><p>{graph.revisions.length} revisions · {graph.edges.length} edges · through sequence {graph.throughBranchSequence.toLocaleString()}</p></div><StatusBadge tone={graph.integrity === "valid" ? "success" : "warning"}>{label(graph.integrity)}</StatusBadge></div>
      <dl className="state-base-cursor__facts state-base-cursor__facts--wide">
        <Fact label="Conversation" value={<code>{shortId(graph.conversationId)}</code>} />
        <Fact label="Branch" value={<code>{shortId(graph.branchId)}</code>} />
        <Fact label="Accepted head" value={<code>{shortId(graph.acceptedHeadStateRevisionId, "No accepted head")}</code>} />
        <Fact label="Watermark" value={`#${graph.throughBranchSequence.toLocaleString()} / #${graph.acceptedHeadBranchSequence.toLocaleString()}`} />
        <Fact label="Pagination" value={`${graph.revisionsHasMore || graph.edgesHasMore ? "More available" : "Complete page"}`} />
        <Fact label="Response bytes" value={graph.responseBytes.toLocaleString()} />
      </dl>
      <div className="state-base-cursor__graph-lists">
        <section><header><strong>Revision facts</strong><small>{graph.revisions.length} on this page</small></header>{graph.revisions.length === 0 ? <p className="state-base-cursor__muted">No revisions in this bounded page.</p> : graph.revisions.map((revision) => <article key={revision.id}><span><strong>#{revision.branchSequence} · {label(revision.kind)}</strong><small><code>{shortId(revision.id)}</code> · {formatTime(revision.createdAtMs)}</small></span><RevisionStatus status={revision.status} /></article>)}</section>
        <section><header><strong>Edge facts</strong><small>{graph.edges.length} on this page</small></header>{graph.edges.length === 0 ? <p className="state-base-cursor__muted">No edges in this bounded page.</p> : graph.edges.map((edge: StateRevisionEdgeProjection) => <article key={edge.id}><span><strong>{label(edge.kind)}</strong><small><code>{shortId(edge.fromStateRevisionId)}</code> → <code>{shortId(edge.toStateRevisionId)}</code></small></span><em>{edge.operationId ? shortId(edge.operationId) : "No operation"}</em></article>)}</section>
      </div>
      <p className="state-base-cursor__boundary"><Info size={14} /> The graph is pinned to the native fixed watermark shown above. Continuation cursors are opaque and cannot be edited or fabricated in this renderer preview.</p>
    </div>
  );
}

export function StateBaseCursorWorkbench({ operation = null, graph = null, runtime = "browser-preview", onRefreshGraph }: StateBaseCursorWorkbenchProps) {
  const [view, setView] = useState<StateBaseCursorView>("state-base");
  const [status, setStatus] = useState("No state-base evidence has been copied.");
  const tabRefs = useRef<Partial<Record<StateBaseCursorView, HTMLButtonElement | null>>>({});
  const tabs: Array<{ id: StateBaseCursorView; label: string; icon: typeof Layers3 }> = [
    { id: "state-base", label: "State base", icon: Layers3 },
    { id: "cursors", label: "Cursors", icon: History },
    { id: "cas", label: "CAS guard", icon: GitCompareArrows },
    { id: "graph", label: "Revision graph", icon: Waypoints },
  ];
  const evidencePayload = useMemo(() => ({
    schema: "omnia.state-base-cursor.preview.v1",
    scope: "renderer-session",
    runtime,
    operation: operation?.operation ?? null,
    graph,
    boundary: "Preview only · renderer-local · no durable write · no native action",
  }), [graph, operation, runtime]);
  const focusTab = (nextView: StateBaseCursorView) => {
    setView(nextView);
    tabRefs.current[nextView]?.focus();
  };
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentView: StateBaseCursorView) => {
    const index = tabs.findIndex((tab) => tab.id === currentView);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    event.preventDefault();
    focusTab(nextTab.id);
  };

  return (
    <section className="state-base-cursor" aria-labelledby="state-base-cursor-title" data-testid="state-base-cursor-workbench">
      <header className="state-base-cursor__header">
        <div><span className="eyebrow">State authority preview</span><h2 id="state-base-cursor-title">State base &amp; cursor workbench</h2><p>Inspect how a run-control operation would bind to an immutable revision, journal cursor, fixed watermark, and branch-head CAS receipt.</p></div>
        <StatusBadge tone={operation ? "success" : "neutral"}>{operation ? "Receipt hydrated" : "Preview only"}</StatusBadge>
      </header>
      <div className="state-base-cursor__toolbar" role="toolbar" aria-label="State base evidence actions">
        <span className="state-base-cursor__toolbar-copy"><LockKeyhole size={14} /><span><strong>{runtime === "desktop" ? "Native projection boundary" : "Browser renderer boundary"}</strong><small>{status}</small></span></span>
        <button type="button" className="button button--secondary" onClick={() => copyPreview(evidencePayload, setStatus)}><Clipboard size={14} /> Copy evidence</button>
        <button type="button" className="button button--ghost" onClick={() => setStatus("Evidence preview reset; no native state changed.")}><RefreshCw size={14} /> Reset notice</button>
      </div>
      <div className="state-base-cursor__tabs" role="tablist" aria-label="State authority preview views">
        {tabs.map(({ id, label: tabLabel, icon: Icon }) => <button key={id} ref={(element) => { tabRefs.current[id] = element; }} type="button" role="tab" id={`state-base-cursor-tab-${id}`} aria-selected={view === id} aria-controls={`state-base-cursor-panel-${id}`} tabIndex={view === id ? 0 : -1} className={view === id ? "state-base-cursor__tab state-base-cursor__tab--active" : "state-base-cursor__tab"} onClick={() => focusTab(id)} onKeyDown={(event) => handleTabKeyDown(event, id)}><Icon size={14} />{tabLabel}</button>)}
      </div>
      <div id={`state-base-cursor-panel-${view}`} className="state-base-cursor__content" role="tabpanel" aria-labelledby={`state-base-cursor-tab-${view}`} tabIndex={0}>
        {view === "state-base" ? <StateBasePanel operation={operation} /> : null}
        {view === "cursors" ? <CursorPanel operation={operation} /> : null}
        {view === "cas" ? <CasPanel operation={operation} /> : null}
        {view === "graph" ? <GraphPanel graph={graph} runtime={runtime} {...(onRefreshGraph ? { onRefreshGraph } : {})} /> : null}
      </div>
      <p className="state-base-cursor__footer"><Info size={14} /> This surface does not prepare state bases, read SQLite, replay cursors, send provider requests, mutate branch heads, or grant execution authority.</p>
    </section>
  );
}

export default StateBaseCursorWorkbench;
