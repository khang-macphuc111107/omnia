import { useEffect, useState } from "react";
import { ModalSurface } from "@/components/modal-surface";
import { agentApi, errorMessage } from "./agent-api";
import type { AgentServicesStatus } from "./types";
import { BrowserSettingsSection } from "./browser-settings";
import { McpStatus } from "./mcp-status";
import { DownloadJobList } from "./download-jobs";
import { UpstreamCapabilitiesSection } from "./upstream-capabilities-section";
import { PluginConnectionReceipts } from "./plugin-connection-receipts";
import "./services-dialog.css";

/** App-owned automation controls. Merely inspecting status never launches a browser or grants OS access. */
export function ServicesDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [status, setStatus] = useState<AgentServicesStatus | null>(null);
  const [capture, setCapture] = useState(false);
  const [control, setControl] = useState(false);
  const [apps, setApps] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    agentApi.servicesStatus(sessionId).then((value) => { if (alive) setStatus(value); })
      .catch((cause) => { if (alive) setError(errorMessage(cause)); });
    return () => { alive = false; };
  }, [sessionId]);
  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await action(); setStatus(await agentApi.servicesStatus(sessionId)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const allowedApps = apps.split(",").map((app) => app.trim()).filter(Boolean);
  const validApps = allowedApps.length > 0 && allowedApps.every((app) => !/[\\/*?\x00-\x1f]/.test(app));
  return <ModalSurface className="ag-dialog ag-dialog--wide ag-services-dialog" scrimClassName="ag-scrim ag-services-scrim" title="Session services" onClose={onClose}>
    <h2 className="ag-dialog__title">Session services</h2>
    <div className="ag-services-dialog__body" role="region" aria-label="Service settings" tabIndex={0} data-dialog-initial-focus>
    <p className="ag-muted">Browser and download tools run through harness approvals. Browser sessions use an Omnia-owned profile, never your personal browser. Status inspection starts no browser or download.</p>
    {status ? <>
      <p>Dedicated browser: {status.browser.available ? "available (lazy launch)" : "not installed"}</p>
      <BrowserSettingsSection sessionId={sessionId} status={status} busy={busy} act={act} />
      <h3 className="ag-subtitle">Desktop capture and control</h3>
      <p role="status">Capture: {status.computer.capture ? "enabled" : "disabled"} · Control: {status.computer.control ? "enabled" : "disabled"}</p>
      <p className="ag-muted">Capture includes all visible desktop metadata, window titles and monitor screenshots. Control can send OS input to the exact executable names you allow. Access ends on interrupt or revocation; already dispatched actions may have completed.</p>
      <label className="ag-row"><input type="checkbox" checked={capture} disabled={busy || !status.computer.available} onChange={(event) => { setCapture(event.target.checked); if (!event.target.checked) setControl(false); }} />I allow desktop capture, including all visible desktop metadata.</label>
      <label className="ag-row"><input type="checkbox" checked={control} disabled={busy || !capture} onChange={(event) => setControl(event.target.checked)} />I also allow desktop control for the listed applications.</label>
      <label className="ag-label">Allowed executable basenames (comma-separated)
        <input className="ag-input" value={apps} placeholder="notepad.exe, Code.exe" disabled={busy} onChange={(event) => setApps(event.target.value)} />
      </label>
      <div className="ag-row">
        <button type="button" className="ag-btn" disabled={busy || !capture || !status.computer.available || (control && !validApps)} onClick={() => void act(async () => {
          await agentApi.setComputerPermission(sessionId, capture, control, allowedApps);
          setCapture(false); setControl(false);
        })}>Grant selected desktop permissions</button>
        <button type="button" className="ag-btn" disabled={busy} onClick={() => void act(async () => {
          await agentApi.setComputerPermission(sessionId, false, false, []);
          setCapture(false); setControl(false);
        })}>Revoke desktop access</button>
      </div>
      <h3 className="ag-subtitle">Downloads</h3>
      <p className="ag-pre">{status.downloads.destination}</p>
      <DownloadJobList
        jobs={status.downloads.jobs}
        disabled={busy}
        onControl={(jobId, action) => void act(() => agentApi.downloadControl(sessionId, jobId, action))}
        onReveal={(jobId) => void act(() => agentApi.downloadReveal(sessionId, jobId))}
      />
    </> : !error ? <p role="status">Reading service status…</p> : null}
    <McpStatus sessionId={sessionId} />
    <PluginConnectionReceipts sessionId={sessionId} />
    <UpstreamCapabilitiesSection />
    {error ? <p role="alert" className="ag-error">{error}</p> : null}
    </div>
    <div className="ag-dialog__actions">
      <button type="button" className="ag-btn" disabled={busy} onClick={() => void act(async () => undefined)}>Refresh status</button>
      <button type="button" className="ag-btn" onClick={onClose}>Close</button>
    </div>
  </ModalSurface>;
}
