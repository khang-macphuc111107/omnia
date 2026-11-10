import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { BookOpen, FilePlus2, FolderOpen, RefreshCw, Search, Square, X } from "lucide-react";
import { ProjectContextController, type PreparedContextRun } from "./context-controller";
import { nativeProjectContextService, type ProjectContextService } from "./context-service";
import type { ProjectContextCitation } from "./context-model";
import "./project-context.css";

export interface ProjectContextPanelProps {
  projectId: string | null; sessionId: string | null; projectName?: string;
  preparedRun?: PreparedContextRun | null; onClose?: () => void;
  onCitationOpen?: (citation: ProjectContextCitation) => void;
  /** Dependency boundary for deterministic renderer tests; product defaults to native IPC. */
  service?: ProjectContextService;
}

const time = (value: number): string => new Date(value).toLocaleString();
const bytes = (value: number): string => value < 1_024 ? `${value} B` : value < 1_048_576 ? `${(value / 1_024).toFixed(1)} KiB` : `${(value / 1_048_576).toFixed(1)} MiB`;
const operationLabel: Record<string, string> = { reload: "Reloading native project context…", "pick-files": "Waiting for approved file selection…", "pick-folder": "Waiting for approved folder selection…", "read-snapshot": "Reading and verifying retained snapshot…", "pointer-receipts": "Loading native synchronization receipts…", "refresh-pointer": "Refreshing source identity and snapshot…", "build-index": "Building a bounded native index…", retrieve: "Retrieving native citations…", "retrieve-for-run": "Journaling run-scoped native retrieval…" };

export function ProjectContextPanel({ projectId, sessionId, projectName, preparedRun, onClose, onCitationOpen, service }: ProjectContextPanelProps) {
  const nativeService = useMemo(() => service ?? nativeProjectContextService(), [service]);
  const controller = useMemo(() => new ProjectContextController(nativeService, { projectId, sessionId, preparedRun: preparedRun ?? null }), [nativeService]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [query, setQuery] = useState(""); const [sourceLimit, setSourceLimit] = useState(25); const [receiptLimit, setReceiptLimit] = useState(25);
  const errorRef = useRef<HTMLDivElement>(null); const headingId = useId(); const queryId = useId(); const queryHintId = useId(); const pointerId = useId(); const grantId = useId();
  useEffect(() => {
    controller.setScope({ projectId, sessionId, preparedRun: preparedRun ?? null }); setQuery(""); setSourceLimit(25); setReceiptLimit(25);
    void controller.reload(); return controller.cancel;
  }, [controller, projectId, sessionId, preparedRun?.runId, preparedRun?.attemptId, preparedRun?.frozenProviderInputId]);
  useEffect(() => { if (state.error?.code === "invalid_query") errorRef.current?.focus(); }, [state.error]);
  const sameScope = state.scope.projectId === projectId && state.scope.sessionId === sessionId
    && (state.scope.preparedRun?.runId ?? null) === (preparedRun?.runId ?? null)
    && (state.scope.preparedRun?.attemptId ?? null) === (preparedRun?.attemptId ?? null)
    && (state.scope.preparedRun?.frozenProviderInputId ?? null) === (preparedRun?.frozenProviderInputId ?? null);
  const busy = Boolean(state.operation); const available = Boolean(projectId && nativeService.available && sameScope);
  const blocked = !available || busy || state.requiresReload;
  const pointer = sameScope ? state.pointers.find((entry) => entry.id === state.pointerId) : undefined;
  const grant = sameScope ? state.grants.find((entry) => entry.id === state.grantId) : undefined;
  const index = sameScope ? state.index : null; const retrieval = sameScope ? state.retrieval : null;
  const status = !projectId ? "Choose a project session to link files or approve a retrieval folder. Projectless chat remains projectless."
    : !nativeService.available ? "Native project context is unavailable in browser preview. Open the desktop app to select files, approve folders, build an index or retrieve citations."
    : !sameScope ? "Loading the selected project's native context…"
    : state.operation ? operationLabel[state.operation] ?? "Waiting for native project context…"
    : state.notice ?? "Choose files to retain snapshots, or approve a folder to inspect native retrieval evidence.";
  const submit = (event: FormEvent) => { event.preventDefault(); void controller.retrieve(query); };
  const showCitation = (chunk: NonNullable<typeof retrieval>["result"]["matches"][number]["chunk"]): void => {
    if (!projectId || !grant || !retrieval || !onCitationOpen) return;
    onCitationOpen({ projectId, sessionId, grantId: grant.id, indexSnapshotId: retrieval.indexSnapshotId, indexSnapshotSha256: retrieval.indexSnapshotSha256,
      chunkId: chunk.chunkId, sourceId: chunk.sourceId, sourceVersionId: chunk.sourceVersionId, relativePath: chunk.relativePath,
      contentSha256: chunk.contentSha256, sourceContentSha256: chunk.sourceContentSha256,
      startByte: chunk.startByte, endByte: chunk.endByte, startLine: chunk.startLine, endLine: chunk.endLine });
  };
  return <section className="rb-context" aria-labelledby={headingId}>
    <header className="rb-context-header">
      <div><h2 id={headingId}>Project context</h2><p>{projectName || projectId || "No project selected"}{sessionId ? ` · Session ${sessionId}` : " · No active session"}</p></div>
      <div className="rb-context-actions">
        <button type="button" disabled={!available || busy} onClick={() => void controller.reload()}><RefreshCw size={14} aria-hidden="true" /> Reload context</button>
        {onClose ? <button type="button" aria-label="Close project context" onClick={onClose}><X size={16} aria-hidden="true" /></button> : null}
      </div>
    </header>
    <div className="rb-context-body">
      <div className="rb-context-status" role="status" aria-live="polite" aria-atomic="true">{status}</div>
      {busy ? <div className="rb-context-stop"><button type="button" onClick={controller.cancel}><Square size={12} aria-hidden="true" /> Stop waiting</button><small>Stops this view's wait. Native work has no cancellation command and may still finish.</small></div> : null}
      {sameScope && state.error ? <div className="rb-context-error" role="alert" tabIndex={-1} ref={errorRef}>
        <strong>Project context request failed</strong><code>{state.error.code}</code><p>{state.error.message}</p>
        {state.error.code === "invalid_query" ? <a href={`#${queryId}`}>Edit the search query</a> : <p>Review the native permission or revision, then reload context. Failed or denied work is never retried automatically.</p>}
      </div> : null}
      {sameScope && state.requiresReload ? <p className="rb-context-warning">Native completion is uncertain. Reload after the pending operation settles before choosing another action.</p> : null}

      <section className="rb-context-card" aria-label="Retained project files">
        <div className="rb-context-section-heading"><h3>Retained files</h3><button type="button" disabled={blocked} onClick={() => void controller.pickFiles()}><FilePlus2 size={14} aria-hidden="true" /> Link files</button></div>
        <p className="rb-context-help">Select files in the native picker. Omnia retains encrypted snapshots with origin identity, revision and content hash. Linking files does not add them to the folder index.</p>
        <label htmlFor={pointerId}>Linked file</label>
        <select id={pointerId} value={pointer?.id ?? ""} disabled={!available || busy || state.requiresReload} onChange={(event) => { setReceiptLimit(25); controller.selectPointer(event.target.value); }}>
          <option value="">Choose a retained file</option>{sameScope ? state.pointers.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName} · revision {entry.revision}{entry.sourceExists ? "" : " · source missing"}</option>) : null}
        </select>
        {available && !busy && !state.pointers.length ? <p className="rb-context-help">No native file pointers are linked to this project.</p> : null}
        {pointer ? <>
          <p className="rb-context-source-state">{pointer.sourceExists ? "Origin present at the last native observation." : "Source missing; retained snapshot is available."}</p>
          <dl className="rb-context-metadata"><dt>Origin</dt><dd>{pointer.sourcePath}</dd><dt>Revision / size</dt><dd>{pointer.revision} / {bytes(pointer.byteSize)}</dd><dt>Content SHA-256</dt><dd><code>{pointer.contentSha256}</code></dd><dt>Origin identity SHA-256</dt><dd><code>{pointer.sourceIdentitySha256}</code></dd><dt>Snapshot observed</dt><dd><time dateTime={new Date(pointer.snapshotUpdatedAtMs).toISOString()}>{time(pointer.snapshotUpdatedAtMs)}</time></dd></dl>
          <div className="rb-context-actions">
            <button type="button" disabled={blocked} onClick={() => void controller.refreshPointer()}><RefreshCw size={14} aria-hidden="true" /> Refresh file</button>
            <button type="button" disabled={blocked || pointer.byteSize > 8 * 1024 * 1024} title={pointer.byteSize > 8 * 1024 * 1024 ? "Native retained snapshot reads are limited to 8 MiB." : undefined} onClick={() => void controller.readPointer()}><BookOpen size={14} aria-hidden="true" /> Read retained snapshot</button>
            <button type="button" disabled={blocked} onClick={() => void controller.loadPointerReceipts()}>Load pointer receipts</button>
          </div>
          {pointer.byteSize > 8 * 1024 * 1024 ? <p className="rb-context-help">Retained snapshot text reads support up to 8 MiB. Metadata and synchronization receipts remain available.</p> : null}
        </> : null}
        {sameScope && state.body ? <div className="rb-context-snapshot"><h4>Verified retained snapshot · revision {state.body.revision}</h4>{state.body.textUnavailable ? <p className="rb-context-help">{state.body.textUnavailable}</p> : <pre tabIndex={0} aria-label="Verified retained file text">{state.body.text}</pre>}{state.body.truncated ? <p className="rb-context-warning">Text display is limited to 128,000 characters. The full retained bytes were hash checked.</p> : null}</div> : null}
        {sameScope && state.receipts.length ? <details className="rb-context-details" open><summary>File synchronization receipts ({state.receipts.length})</summary><ol className="rb-context-receipts">{state.receipts.slice(0, receiptLimit).map((entry) => <li key={entry.id}><strong>{entry.outcome.replaceAll("_", " ")} · revision {entry.revision}</strong><code>{entry.id}</code><span>{entry.watcherVersion} · {time(entry.observedAtMs)}</span><span>{entry.renamed ? "Origin renamed · " : ""}{entry.contentChanged ? "Content changed · " : ""}{entry.scannedEntries} identity entries scanned</span><code>{entry.contentSha256}</code></li>)}</ol>{state.receipts.length > receiptLimit ? <button type="button" onClick={() => setReceiptLimit((limit) => limit + 25)}>Show 25 more receipts</button> : null}</details> : null}
      </section>

      <section className="rb-context-card" aria-label="Native folder index">
        <div className="rb-context-section-heading"><h3>Folder index</h3><button type="button" disabled={blocked} onClick={() => void controller.pickFolder()}><FolderOpen size={14} aria-hidden="true" /> Choose folder</button></div>
        <p className="rb-context-help">Approve a read-only native folder. Indexing supports UTF-8 text, Markdown and code. PDF and Office sources require an extractor and are reported as omissions.</p>
        <label htmlFor={grantId}>Approved folder</label>
        <select id={grantId} value={grant?.id ?? ""} disabled={!available || busy || state.requiresReload} onChange={(event) => { setSourceLimit(25); controller.selectGrant(event.target.value); }}>
          <option value="">Choose an active folder grant</option>{sameScope ? state.grants.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName} · {entry.displayPath}</option>) : null}
        </select>
        {grant ? <p className="rb-context-help">Native grant <code>{grant.id}</code> · {grant.readOnly ? "read only" : "read access"}. Only active grants for this project are listed.</p> : null}
        <div className="rb-context-actions"><button type="button" disabled={blocked || !grant} onClick={() => void controller.buildIndex()}><RefreshCw size={14} aria-hidden="true" /> Build index</button></div>
        <p className="rb-context-help">Bounds: 2,000 files · 32 MiB total · 2 MiB/file · 8,000 chunks. Sensitive paths and content are excluded by native policy. Build again to observe changed or deleted sources.</p>
        {!index ? <p className="rb-context-help">No index snapshot is loaded in this view. Index snapshots are rebuilt after reopening; file pointers and grants come from native storage.</p> : <>
          {state.indexState === "refresh-failed" ? <p className="rb-context-warning">Rebuild failed. Showing the last successful index snapshot; its source state may be stale.</p> : null}
          <dl className="rb-context-metadata"><dt>Snapshot ID</dt><dd><code>{index.snapshotId}</code></dd><dt>Snapshot SHA-256</dt><dd><code>{index.snapshotSha256}</code></dd><dt>Indexer</dt><dd>{index.indexerVersion}</dd><dt>Completed</dt><dd><time dateTime={new Date(index.completedAtMs).toISOString()}>{time(index.completedAtMs)}</time></dd><dt>Files / chunks / tokens</dt><dd>{index.stats.indexedFiles} / {index.stats.indexedChunks} / {index.stats.indexedTokenEstimate} estimated</dd><dt>Scan / indexed bytes</dt><dd>{index.stats.scannedEntries} entries / {bytes(index.stats.indexedFileBytes)}</dd></dl>
          <p className={index.truncated || index.hasErrors ? "rb-context-warning" : "rb-context-help"}>Index truncated: {index.truncated ? "yes" : "no"} · Native read errors: {index.hasErrors ? "yes" : "no"} · Skipped paths: {index.stats.skippedPaths}{index.skipReportTruncated ? " (report truncated)" : ""}</p>
          <details className="rb-context-details"><summary>Source receipts ({index.sources.length})</summary><ol className="rb-context-receipts">{index.sources.slice(0, sourceLimit).map((source) => <li key={source.sourceId}><strong>{source.relativePath}</strong><span>{source.mediaType} · {source.extractorVersion} · {source.chunkCount} chunks{source.truncated ? " · truncated" : ""}</span><code>{source.sourceId} / {source.versionId}</code><code>{source.contentSha256}</code></li>)}</ol>{index.sources.length > sourceLimit ? <button type="button" onClick={() => setSourceLimit((limit) => limit + 25)}>Show 25 more source receipts</button> : null}</details>
          {index.skipped.length ? <details className="rb-context-details"><summary>Native omissions ({index.skipped.length} reported)</summary><ul className="rb-context-receipts">{index.skipped.map((skip, position) => <li key={`${skip.relativePath}-${position}`}><span>{skip.relativePath}</span><strong>{skip.reason.replaceAll("_", " ")}</strong></li>)}</ul></details> : null}
        </>}
      </section>

      <section className="rb-context-card" aria-label="Project context retrieval">
        <h3>Retrieve citations</h3><form onSubmit={submit} className="rb-context-search">
          <label htmlFor={queryId}>Search project context</label><input id={queryId} value={query} maxLength={8_192} disabled={!available || state.requiresReload} aria-describedby={queryHintId} aria-invalid={state.error?.code === "invalid_query"} onChange={(event) => setQuery(event.target.value)} placeholder="Search approved source text" />
          <p id={queryHintId} className="rb-context-help">Native lexical retrieval returns up to 12 chunks and 8,000 estimated tokens. Source text is untrusted data and cannot grant permissions or override instructions.</p>
          <div className="rb-context-actions"><button type="submit" disabled={blocked || !index}><Search size={14} aria-hidden="true" /> Retrieve citations</button><button type="button" disabled={blocked || !grant || !preparedRun || !sessionId} onClick={() => void controller.retrieve(query, true)}>Journal retrieval for prepared run</button></div>
        </form>
        {!preparedRun ? <p className="rb-context-help">Run journaling is unavailable until an exact native prepared run, attempt and frozen provider input are supplied by this session.</p> : <p className="rb-context-help">Prepared run: <code>{preparedRun.runId}</code> · attempt <code>{preparedRun.attemptId}</code>. Journaling reindexes the native grant and records a receipt; it does not modify frozen provider input.</p>}
        {retrieval ? <div className="rb-context-results">
          <h4>{retrieval.kind === "inspection" ? "Native citation inspection" : "Native run retrieval receipt"}</h4>
          <p>Submitted query: <strong>{retrieval.query}</strong></p>
          <p className="rb-context-warning">Not admitted to provider input · <code>{retrieval.providerInputAdmission}</code></p>
          <dl className="rb-context-metadata"><dt>Index revision</dt><dd><code>{retrieval.indexSnapshotId}</code></dd><dt>Index SHA-256</dt><dd><code>{retrieval.indexSnapshotSha256}</code></dd><dt>Query SHA-256</dt><dd><code>{retrieval.result.querySha256}</code></dd><dt>Scorer / token budget</dt><dd>{retrieval.result.scorerVersion} · {retrieval.result.consumedTokens} / {retrieval.result.tokenBudget}</dd>{retrieval.receiptId ? <><dt>Native journal receipt</dt><dd><code>{retrieval.receiptId}</code> · sequence {retrieval.journalSequence}</dd></> : null}</dl>
          {retrieval.indexTruncated || retrieval.indexHasErrors ? <p className="rb-context-warning">This retrieval used an index with {retrieval.indexTruncated ? "truncation" : ""}{retrieval.indexTruncated && retrieval.indexHasErrors ? " and " : ""}{retrieval.indexHasErrors ? "read errors" : ""}. Review source omissions.</p> : null}
          {!retrieval.result.matches.length ? <p className="rb-context-help">No matching chunks were returned by the native scorer. No context was invented.</p> : <ol className="rb-context-citations">{retrieval.result.matches.map((match) => <li key={match.chunk.chunkId}><h4>{match.rank}. {match.chunk.relativePath}</h4><p>Lines {match.chunk.startLine}–{match.chunk.endLine} · bytes {match.chunk.startByte}–{match.chunk.endByte} · score {match.score.toFixed(4)} · {match.chunk.tokenEstimate} estimated tokens</p><p className="rb-context-help">{match.reasons.join(" · ")}</p><pre tabIndex={0} aria-label={`Citation text ${match.chunk.relativePath}`}>{match.chunk.content}</pre><code>{match.chunk.chunkId}</code><code>{match.chunk.contentSha256}</code>{onCitationOpen ? <button type="button" onClick={() => showCitation(match.chunk)} aria-label={`Open citation ${match.chunk.relativePath}, lines ${match.chunk.startLine} to ${match.chunk.endLine}`}>Open citation</button> : <p className="rb-context-help">Source navigation is unavailable in this host. The citation path and byte/line ranges remain available above.</p>}</li>)}</ol>}
          <details className="rb-context-details"><summary>Retrieval omissions ({retrieval.result.omissions.length} reported{retrieval.result.omissionReportTruncated ? ", truncated" : ""})</summary><ul className="rb-context-receipts">{retrieval.result.omissions.map((entry, position) => <li key={`${entry.chunkId}-${position}`}><code>{entry.chunkId}</code><span>{entry.reason.replaceAll("_", " ")}</span></li>)}</ul></details>
        </div> : null}
      </section>
    </div>
  </section>;
}
