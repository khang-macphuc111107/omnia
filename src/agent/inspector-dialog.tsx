import { useCallback, useEffect, useRef, useState } from "react";
import "./inspector-dialog.css";
import { ModalSurface } from "@/components/modal-surface";
import { agentApi, errorMessage } from "./agent-api";
import type { InspectorExchange, InspectorList } from "./types";

type Tab = "request" | "response" | "headers";

/** Pretty-print JSON; SSE or truncated bodies fall back to the raw text. */
export function prettyBody(text: string): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function headersText(exchange: InspectorExchange): string {
  const lines = (title: string, rows: InspectorExchange["requestHeaders"]) =>
    [title, ...(rows.length ? rows.map((row) => `${row.name}: ${row.value}`) : ["(none)"])].join("\n");
  return `${exchange.url}\n\n${lines("Request headers", exchange.requestHeaders)}\n\n${lines("Response headers", exchange.responseHeaders)}`;
}

function tabText(exchange: InspectorExchange, tab: Tab): string {
  if (tab === "request") return prettyBody(exchange.requestBody);
  if (tab === "response") return prettyBody(exchange.responseBody);
  return headersText(exchange);
}

const time = (ms: number) => new Date(ms).toLocaleTimeString();
const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** Local, in-memory view of the raw (redacted) provider traffic of one session. */
export function InspectorDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [list, setList] = useState<InspectorList | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<InspectorExchange | null>(null);
  const [tab, setTab] = useState<Tab>("request");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await agentApi.inspectorList(sessionId);
      setList(next);
      setError(null);
      setSelected((current) => current ?? next.exchanges[0]?.id ?? null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (selected === null) { setDetail(null); return; }
    let alive = true;
    agentApi.inspectorGet(sessionId, selected)
      .then((value) => { if (alive) setDetail(value); })
      .catch((cause) => { if (alive) setError(errorMessage(cause)); });
    return () => { alive = false; };
  }, [sessionId, selected]);

  const clear = async () => {
    try {
      await agentApi.inspectorClear(sessionId);
      setSelected(null);
      setDetail(null);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const copy = async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(tabText(detail, tab));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const stats = list?.stats;
  const tabs: Array<[Tab, string]> = [["request", "Request"], ["response", "Response"], ["headers", "Headers"]];

  return <ModalSurface className="ag-dialog ag-dialog--inspector" scrimClassName="ag-scrim ag-inspector-scrim" title="Inspect requests" onClose={onClose} initialFocusRef={closeRef}>
    <h2 className="ag-dialog__title">Inspect requests</h2>
    <p className="ag-muted">Raw provider traffic for this session, kept in memory only (last 50). Credentials are redacted; nothing is saved or sent anywhere.</p>
    {stats ? <p className="ag-muted" role="status">
      {stats.requests} requests · {stats.errors} errors · {stats.retries} retries · {stats.fallbacks} fallbacks · avg {stats.averageLatencyMs} ms
    </p> : null}
    {error ? <p role="alert" className="ag-error">{error}</p> : null}
    <div className="ag-inspector">
      <ul className="ag-inspector__list" aria-label="Exchanges">
        {list?.exchanges.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="ag-inspector__item"
              aria-current={entry.id === selected ? "true" : undefined}
              onClick={() => { setSelected(entry.id); setCopied(false); }}
            >
              <span>{entry.model || entry.provider}</span>
              <span className="ag-muted">
                {time(entry.startedAtMs)} · {entry.status ?? (entry.error ? "failed" : "pending")}
                {entry.durationMs !== null ? ` · ${entry.durationMs} ms` : ""} · {kb(entry.requestBytes)}/{kb(entry.responseBytes)}
              </span>
            </button>
          </li>
        ))}
        {list && list.exchanges.length === 0 ? <li className="ag-muted">No requests recorded yet.</li> : null}
      </ul>
      <div className="ag-inspector__detail">
        <div className="ag-row" role="tablist" aria-label="Exchange sections">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" className="ag-btn" aria-selected={tab === id} onClick={() => { setTab(id); setCopied(false); }}>{label}</button>
          ))}
          <button type="button" className="ag-btn" disabled={!detail} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
          <button type="button" className="ag-btn" disabled={!list?.exchanges.length} onClick={() => void clear()}>Clear</button>
        </div>
        {detail?.error ? <p role="alert" className="ag-error">{detail.error}</p> : null}
        <pre className="ag-pre ag-inspector__pre" aria-label={`${tab} content`} tabIndex={0}>
          {detail ? tabText(detail, tab) : "Select a request."}
        </pre>
        {detail && ((tab === "request" && detail.requestTruncated) || (tab === "response" && detail.responseTruncated))
          ? <p className="ag-muted">Truncated to 256 KB.</p> : null}
      </div>
    </div>
    <div className="ag-row ag-inspector__actions">
      <button ref={closeRef} type="button" className="ag-btn" onClick={onClose}>Close</button>
      <button type="button" className="ag-btn" onClick={() => void refresh()}>Refresh</button>
    </div>
  </ModalSurface>;
}
