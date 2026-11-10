import { Check, Copy, Download, ExternalLink, RefreshCw, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { agentApi, errorMessage } from "./agent-api";
import type { ArtifactRequest } from "./agent-store";
import { artifactDocument, artifactSandbox, fenceCode, parseCsv } from "./artifact-preview";
import type { ArtifactContent, ArtifactMeta } from "./types";

import "./artifacts-panel.css";

const Markdown = lazy(() =>
  import("@/features/workspace/markdown").then((module) => ({ default: module.MessageMarkdown })),
);

function CsvTable({ text }: { text: string }) {
  const { rows, hiddenRows } = parseCsv(text);
  const [head, ...body] = rows;
  if (!head) return <p className="ag-muted ag-artifacts__note">Empty table.</p>;
  return (
    <div className="ag-artifacts__table-wrap">
      <table className="ag-artifacts__table">
        <thead><tr>{head.map((cell, i) => <th key={i} scope="col">{cell}</th>)}</tr></thead>
        <tbody>{body.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody>
      </table>
      {hiddenRows > 0 ? <p className="ag-muted ag-artifacts__note">{hiddenRows} more rows not shown. Export to see everything.</p> : null}
    </div>
  );
}

/**
 * html/svg render in a frame served from the dedicated `omnia-artifact` scheme, which carries its own
 * CSP response header (the app CSP forbids inline script). If the preview URL cannot be minted (tests,
 * jsdom) the frame falls back to an equivalent sandboxed `srcdoc`.
 */
function FramePreview({ sessionId, item }: { sessionId: string; item: ArtifactContent }) {
  const { kind, title, id } = item.meta;
  const [src, setSrc] = useState<{ key: string; url: string | null } | null>(null);
  const key = `${sessionId}:${id}:${item.version}`;
  useEffect(() => {
    let stale = false;
    agentApi.artifactPreviewUrl(sessionId, id, item.version)
      .then((url) => { if (!stale) setSrc({ key, url }); })
      .catch(() => { if (!stale) setSrc({ key, url: null }); });
    return () => { stale = true; };
  }, [sessionId, id, item.version, key]);
  if (!src || src.key !== key) return <p className="ag-muted ag-artifacts__note">Loading preview…</p>;
  return (
    <iframe
      key={key}
      className="ag-artifacts__frame"
      title={`Preview of ${title}`}
      sandbox={artifactSandbox(kind as "html" | "svg")}
      referrerPolicy="no-referrer"
      {...(src.url ? { src: src.url } : { srcDoc: artifactDocument(kind as "html" | "svg", item.content) })}
    />
  );
}

function Preview({ sessionId, item }: { sessionId: string; item: ArtifactContent }) {
  const { kind, language } = item.meta;
  switch (kind) {
    case "html":
    case "svg":
      return <FramePreview sessionId={sessionId} item={item} />;
    case "markdown":
      return (
        <div className="ag-artifacts__doc">
          <Suspense fallback={<p className="ag-plain">{item.content}</p>}>
            <Markdown content={item.content} />
          </Suspense>
        </div>
      );
    case "csv":
      return <CsvTable text={item.content} />;
    case "mermaid":
      return (
        <div className="ag-artifacts__doc">
          <p className="ag-muted ag-artifacts__note">Mermaid diagrams are not rendered in this build; showing the source.</p>
          <pre className="ag-pre">{item.content}</pre>
        </div>
      );
    case "code":
      return (
        <div className="ag-artifacts__doc">
          <Suspense fallback={<pre className="ag-pre">{item.content}</pre>}>
            <Markdown content={fenceCode(item.content, language)} />
          </Suspense>
        </div>
      );
  }
}

interface Props {
  sessionId: string;
  /** Latest request from the agent or a transcript card; selects an artifact and refreshes. */
  request: ArtifactRequest | null;
  onClose: () => void;
}

/** Side panel: artifacts of the session with version switcher, Preview/Source tabs and copy/export/open actions. */
export function ArtifactsPanel({ sessionId, request, onClose }: Props) {
  const [list, setList] = useState<ArtifactMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(request?.sessionId === sessionId ? request.id : null);
  const [version, setVersion] = useState<number | null>(null);
  const [item, setItem] = useState<ArtifactContent | null>(null);
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  const handled = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await agentApi.artifactsList(sessionId);
      if (!alive.current) return;
      setList(next);
      setSelected((current) => (current && next.some((a) => a.id === current) ? current : (next[0]?.id ?? null)));
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!request || request.sessionId !== sessionId || handled.current === request.n) return;
    handled.current = request.n;
    if (request.reason !== "deleted") {
      setSelected(request.id);
      setVersion(null);
    }
    void refresh();
  }, [request, sessionId, refresh]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!selected) { setItem(null); return; }
    let stale = false;
    setError(null);
    agentApi.artifactGet(sessionId, selected, version ?? undefined)
      .then((next) => { if (!stale && alive.current) setItem(next); })
      .catch((cause) => { if (!stale && alive.current) { setItem(null); setError(errorMessage(cause)); } });
    return () => { stale = true; };
  }, [sessionId, selected, version, list]);

  const meta = list.find((a) => a.id === selected) ?? null;
  const copy = async () => {
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.content);
      setCopied(true);
      window.setTimeout(() => { if (alive.current) setCopied(false); }, 1500);
    } catch {
      setError("Copy is not available here.");
    }
  };
  const act = async (run: () => Promise<string | null | void>) => {
    setError(null);
    setStatus(null);
    try {
      const result = await run();
      if (result && alive.current) setStatus(`Saved to ${result}`);
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    }
  };
  const browsable = item?.meta.kind === "html" || item?.meta.kind === "svg";

  return (
    <aside className="ag-artifacts" aria-label="Artifacts">
      <header className="ag-artifacts__head">
        <h2 className="ag-subtitle">Artifacts</h2>
        <span className="ag-spacer" />
        <button type="button" className="ag-icon-btn" aria-label="Refresh artifacts" onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" /></button>
        <button type="button" className="ag-icon-btn" aria-label="Close artifacts" onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>

      {list.length === 0 ? (
        <p className="ag-muted ag-artifacts__note">No artifacts yet. When the agent creates a page, document or diagram it appears here.</p>
      ) : (
        <ul className="ag-artifacts__list" aria-label="Artifact list">
          {list.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="ag-artifacts__entry"
                aria-current={entry.id === selected ? "true" : undefined}
                onClick={() => { setSelected(entry.id); setVersion(null); }}
              >
                <span className="ag-artifacts__entry-title" title={entry.title}>{entry.title}</span>
                <span className="ag-muted">{entry.kind} · v{entry.version}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {meta && item ? (
        <>
          <div className="ag-artifacts__bar">
            <label className="ag-artifacts__version">
              <span className="ag-muted">Version</span>
              <select
                className="ag-input"
                aria-label="Version"
                value={item.version}
                onChange={(event) => setVersion(Number(event.target.value))}
              >
                {[...meta.versions].reverse().map((v) => (
                  <option key={v} value={v}>{`v${v}${v === meta.version ? " (latest)" : ""}`}</option>
                ))}
              </select>
            </label>
            <div role="tablist" aria-label="View" className="ag-artifacts__tabs">
              {(["preview", "source"] as const).map((id) => (
                <button key={id} type="button" role="tab" className="ag-btn" aria-selected={tab === id} onClick={() => setTab(id)}>
                  {id === "preview" ? "Preview" : "Source"}
                </button>
              ))}
            </div>
          </div>
          <div className="ag-artifacts__actions">
            <button type="button" className="ag-btn" onClick={() => void copy()}>
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="ag-btn" onClick={() => void act(() => agentApi.artifactExport(sessionId, meta.id, item.version))}>
              <Download size={14} aria-hidden="true" />Export
            </button>
            {browsable ? (
              <button type="button" className="ag-btn" onClick={() => void act(() => agentApi.artifactOpenBrowser(sessionId, meta.id, item.version))}>
                <ExternalLink size={14} aria-hidden="true" />Open in browser
              </button>
            ) : null}
          </div>
          <div className="ag-artifacts__view" role="tabpanel" aria-label={tab === "preview" ? "Preview" : "Source"}>
            {tab === "preview" ? <Preview sessionId={sessionId} item={item} /> : <pre className="ag-pre ag-artifacts__source">{item.content}</pre>}
          </div>
        </>
      ) : null}
      {status ? <p className="ag-muted ag-artifacts__note" role="status">{status}</p> : null}
      {error ? <p className="ag-error" role="alert">{error}</p> : null}
    </aside>
  );
}
