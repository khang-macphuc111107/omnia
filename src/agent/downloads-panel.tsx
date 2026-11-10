import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { agentApi, errorMessage } from "./agent-api";
import { DownloadJobList, formatBytes, type DownloadAction } from "./download-jobs";
import type { MediaEntry, PublicDownloadJob } from "./types";

export const DOWNLOADS_REFRESH_MS = 3000;

function groupByPage(entries: MediaEntry[]): { key: string; title: string; entries: MediaEntry[] }[] {
  const groups = new Map<string, { key: string; title: string; entries: MediaEntry[] }>();
  for (const entry of entries) {
    const key = entry.pageUrl ?? "";
    const group = groups.get(key) ?? { key, title: entry.pageTitle || entry.pageUrl || "Unknown page", entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** IDM-style download manager for the active session: add a link, pick detected media, manage jobs. */
export function DownloadsPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [jobs, setJobs] = useState<PublicDownloadJob[]>([]);
  const [media, setMedia] = useState<MediaEntry[]>([]);
  const [url, setUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [status, entries] = await Promise.all([agentApi.servicesStatus(sessionId), agentApi.mediaList(sessionId)]);
      if (!alive.current) return;
      setJobs(status.downloads.jobs);
      setMedia(entries);
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), DOWNLOADS_REFRESH_MS);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [refresh]);

  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await action(); await refresh(); }
    catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { if (alive.current) setBusy(false); }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const link = url.trim();
    if (!link) return;
    void act(async () => {
      const name = fileName.trim();
      await agentApi.downloadStart(sessionId, name ? { url: link, fileName: name } : { url: link });
      setUrl("");
      setFileName("");
    });
  };

  const groups = groupByPage(media);
  return <aside className="ag-downloads" aria-label="Downloads">
    <header className="ag-downloads__head">
      <h2 className="ag-subtitle">Downloads</h2>
      <span className="ag-spacer" />
      <button type="button" className="ag-btn" onClick={() => void refresh()}>Refresh</button>
      <button type="button" className="ag-icon-btn" aria-label="Close downloads" onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </header>
    <form className="ag-dl-add" onSubmit={submit}>
      <input className="ag-input" aria-label="Download URL" placeholder="Paste a link and press Enter" value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} />
      <input className="ag-input" aria-label="File name (optional)" placeholder="File name (optional)" value={fileName} disabled={busy} onChange={(event) => setFileName(event.target.value)} />
      <button type="submit" className="ag-btn ag-btn--primary" disabled={busy || !url.trim()}>Download</button>
    </form>
    {error ? <p role="alert" className="ag-error">{error}</p> : null}

    <h3 className="ag-subtitle">Detected in browser</h3>
    {!groups.length ? <p className="ag-muted">Nothing detected yet. Resources seen by the agent browser appear here.</p> : null}
    {groups.map((group) => <section key={group.key} className="ag-dl-group" aria-label={group.title}>
      <p className="ag-dl-group__title" title={group.key}>{group.title}</p>
      <ul className="ag-dl-list">{group.entries.map((entry) => <li key={entry.id} className="ag-dl-media">
        <span className="ag-dl-media__name" title={entry.url}>{entry.name}</span>
        <span className="ag-dl-badge">{entry.kind}</span>
        <span className="ag-muted">{formatBytes(entry.size)}</span>
        {entry.drmProtected ? <span className="ag-muted">Protected</span>
          : entry.kind === "blob" ? <span className="ag-muted">Unsupported</span>
          : <button type="button" className="ag-btn" disabled={busy} aria-label={`Download ${entry.name}`} onClick={() => void act(() => agentApi.downloadStart(sessionId, { capturedRequestId: entry.id, kind: entry.kind === "hls" || entry.kind === "dash" ? entry.kind : "http" }))}>Download</button>}
      </li>)}</ul>
    </section>)}

    <h3 className="ag-subtitle">Jobs</h3>
    <DownloadJobList
      jobs={jobs}
      disabled={busy}
      onControl={(jobId: string, action: DownloadAction) => void act(() => agentApi.downloadControl(sessionId, jobId, action))}
      onReveal={(jobId) => void act(() => agentApi.downloadReveal(sessionId, jobId))}
    />
  </aside>;
}
