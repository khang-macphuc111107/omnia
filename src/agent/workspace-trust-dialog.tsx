import { useEffect, useRef, useState } from "react";
import "./workspace-trust-dialog.css";
import { ModalSurface } from "@/components/modal-surface";
import { agentApi, errorMessage } from "./agent-api";
import type { WorkspaceTrust } from "./types";

/** Status inspection is passive. Trust is granted only by the explicit action below. */
export function WorkspaceTrustDialog({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<WorkspaceTrust | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    agentApi.workspaceTrust(cwd).then((value) => { if (alive) setStatus(value); })
      .catch((cause) => { if (alive) setError(errorMessage(cause)); });
    return () => { alive = false; };
  }, [cwd]);
  const change = async (trusted: boolean) => {
    if (!status || busy || (trusted && !reviewed)) return;
    // Keep keyboard focus on an enabled control while the initiating control
    // is disabled or removed by the asynchronous status update.
    closeRef.current?.focus();
    setBusy(true);
    setError(null);
    try {
      setStatus(await agentApi.setWorkspaceTrust(status.cwd, status.fingerprint, trusted));
      setReviewed(false);
    } catch (cause) {
      setError(errorMessage(cause));
      // A changed fingerprint must be reviewed afresh, never retried automatically.
      setStatus(null);
      setReviewed(false);
    } finally { setBusy(false); }
  };
  const refresh = async () => {
    // Keep keyboard focus on an enabled control while the initiating control
    // is disabled or removed by the asynchronous status update.
    closeRef.current?.focus();
    setBusy(true);
    setStatus(null);
    setReviewed(false);
    setError(null);
    try { setStatus(await agentApi.workspaceTrust(cwd)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return (
    <ModalSurface className="ag-dialog ag-workspace-trust" scrimClassName="ag-scrim ag-workspace-trust-scrim" title="Workspace trust" onClose={onClose} initialFocusRef={titleRef}>
      <h2 ref={titleRef} tabIndex={-1} className="ag-dialog__title" onKeyDown={(event) => {
        if (event.key === "Tab" && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          closeRef.current?.focus();
        }
      }}>Workspace trust</h2>
      <div className="ag-workspace-trust__body" tabIndex={0} role="region" aria-label="Workspace configuration review" aria-busy={busy}>
      <p className="ag-muted">Project hooks and MCP configuration can execute commands with your access. Review the files outside Omnia before trusting them. Trusting does not start MCP servers or run a task.</p>
      <p className="ag-pre ag-workspace-trust__path" title={cwd}>{cwd}</p>
      {status ? <>
        <p role="status">{status.trusted ? "Trusted configuration" : "Not trusted — execution is blocked"}</p>
        <ul>{status.sources.map((source) => <li key={source.path}><code title={source.path}>{source.path}</code> ({source.scope})</li>)}</ul>
        <p className="ag-pre">Fingerprint: {status.fingerprint}</p>
        {status.sources.some((source) => source.scope === "project") ? <>
          {!status.trusted ? <label className="ag-row"><input type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => setReviewed(event.target.checked)} />I reviewed these project configuration files and trust their executable hooks and MCP servers.</label> : null}
          <button type="button" className="ag-btn" disabled={busy || (!status.trusted && !reviewed)} onClick={() => void change(!status.trusted)}>
            {status.trusted ? "Revoke workspace trust" : "Trust reviewed configuration"}
          </button>
        </> : <p className="ag-muted">No project executable configuration is present. No project trust grant is needed.</p>}
      </> : !error ? <p role="status">Reading configuration…</p> : null}
      {error ? <p role="alert" className="ag-error">{error}</p> : null}
      </div>
      <div className="ag-dialog__actions">
        <button type="button" className="ag-btn" disabled={busy} onClick={() => void refresh()}>Refresh status</button>
        <button ref={closeRef} type="button" className="ag-btn" onClick={onClose}>Close</button>
      </div>
    </ModalSurface>
  );
}
