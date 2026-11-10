import { useEffect, useId, useState } from "react";
import { agentApi, errorMessage } from "./agent-api";
import type { PluginConnectionReceipt } from "./types";

const states: Record<PluginConnectionReceipt["state"], string> = {
  configured: "Configuration present",
  disabled: "Disabled",
  workspace_trust_required: "Workspace trust required",
  missing_environment: "Environment values missing",
  invalid_configuration: "Invalid configuration",
};

/** On-demand, native-owned connector evidence. Opening this never connects. */
export function PluginConnectionReceipts({ sessionId }: { sessionId: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [receipts, setReceipts] = useState<PluginConnectionReceipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setReceipts(null);
    setError(null);
    void agentApi.pluginConnectionReceipts(sessionId)
      .then((value) => { if (live) setReceipts(value); })
      .catch((cause) => { if (live) setError(errorMessage(cause)); });
    return () => { live = false; };
  }, [sessionId, open, revision]);
  return <section aria-labelledby={`${id}-title`}>
    <h3 className="ag-subtitle" id={`${id}-title`}>Installed connectors</h3>
    <p className="ag-muted">Inspect plugin MCP configuration, workspace trust and missing environment values. Tool calls still follow the active permission policy. Login is not tested.</p>
    <button type="button" className="ag-btn" aria-expanded={open} aria-controls={`${id}-receipts`} onClick={() => setOpen((value) => !value)}>
      {open ? "Hide connector receipts" : "Inspect installed connectors"}
    </button>
    <div id={`${id}-receipts`} hidden={!open}>
      {open && receipts === null && !error ? <p role="status">Reading connector configuration…</p> : null}
      {error ? <p role="alert" className="ag-error">{error}</p> : null}
      {receipts?.length === 0 ? <p className="ag-muted">No enabled plugin MCP configurations in this session.</p> : null}
      {receipts && receipts.length > 0 ? <ul className="ag-profiles" aria-label="Plugin connector receipts">
        {receipts.map((receipt) => <li key={receipt.receiptId} className="ag-profile">
          <span className="ag-profile__name">{receipt.serverName}</span>
          <span className="ag-profile__meta">{states[receipt.state]} · {receipt.transport} · {receipt.pluginScope} plugin v{receipt.pluginVersion}</span>
          {receipt.endpointOrigin ? <span className="ag-muted">{receipt.endpointOrigin}</span> : null}
          {receipt.missingEnvironment.length > 0 ? <p className="ag-muted">Missing: {receipt.missingEnvironment.join(", ")}</p> : null}
          <details>
            <summary>Configuration receipt</summary>
            <p className="ag-pre">{receipt.receiptId}</p>
            <p className="ag-muted">Configuration SHA-256: <code>{receipt.configurationSha256}</code></p>
            <p className="ag-muted">Snapshot SHA-256: <code>{receipt.configurationSnapshotSha256}</code></p>
            <p className="ag-muted">Workspace trust: {receipt.workspaceTrusted ? "approved snapshot" : "not approved"} · Authentication: not verified</p>
          </details>
        </li>)}
      </ul> : null}
      {open ? <button type="button" className="ag-btn" onClick={() => setRevision((value) => value + 1)}>Refresh connector receipts</button> : null}
    </div>
  </section>;
}
