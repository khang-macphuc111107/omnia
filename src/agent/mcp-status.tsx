import { useEffect, useRef, useState } from "react";
import "./mcp-status.css";
import { agentApi, errorMessage } from "./agent-api";
import type { McpServerStatus } from "./types";

export function McpStatus({ sessionId }: { sessionId: string }) {
  const [servers, setServers] = useState<McpServerStatus[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const restartRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      restoreFocus.current = false;
      const active = document.activeElement;
      if (active === document.body || active === restartRef.current || active === confirmationRef.current) {
        confirmationRef.current?.focus();
      }
    }
  }, [busy]);
  useEffect(() => {
    let alive = true;
    agentApi.mcpStatus(sessionId).then((value) => { if (alive) setServers(value); })
      .catch((cause) => { if (alive) setError(errorMessage(cause)); });
    return () => { alive = false; };
  }, [sessionId]);
  const reload = async () => {
    if (busy || !confirmed) return;
    restoreFocus.current = document.activeElement === restartRef.current;
    setBusy(true);
    setError(null);
    try { setServers(await agentApi.reloadMcp(sessionId)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); setConfirmed(false); }
  };
  return <section className="ag-mcp-status" aria-label="MCP servers">
    <h3 className="ag-subtitle">MCP servers</h3>
    <p className="ag-muted">Status is passive and starts no processes. Servers start on an approved run or your explicit restart below. Changed project configuration requires renewed workspace trust.</p>
    <div className="ag-mcp-status__connections" role="region" aria-label="MCP connection status" tabIndex={0} aria-busy={busy}>
      {servers === null && !error ? <p role="status">Reading MCP status…</p> : null}
      {servers?.length === 0 ? <p>No current MCP connections.</p> : null}
      {servers?.length ? <ul>{servers.map((server) => <li key={server.name}>
        <div className="ag-mcp-status__summary"><strong>{server.name}</strong><span>{server.state}</span><span>{server.toolCount} tools</span></div>
        {server.error ? <p className="ag-error">{server.error}</p> : null}
      </li>)}</ul> : null}
    </div>
    <label className="ag-mcp-status__confirmation"><input ref={confirmationRef} type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /><span>Start or restart the configured MCP server processes now.</span></label>
    <button ref={restartRef} type="button" className="ag-btn ag-mcp-status__restart" disabled={busy || !confirmed} onClick={() => void reload()}>Restart MCP servers</button>
    <p className="ag-mcp-status__progress ag-muted" role="status">{busy ? "Restarting MCP servers…" : ""}</p>
    {error ? <p className="ag-error" role="alert">{error}</p> : null}
  </section>;
}
