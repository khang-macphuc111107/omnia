import type { PublicDownloadJob } from "./types";

export type DownloadAction = "pause" | "resume" | "cancel";

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Errors that retrying cannot fix: the request itself is unacceptable. */
const PERMANENT_ERROR_CODES = new Set(["invalidRequest", "drmProtected", "unsupported", "parse"]);

const ERROR_MESSAGES: Record<string, string> = {
  invalidRequest: "This download was rejected: only public http(s) addresses are allowed (loopback, private network and non-http(s) URLs are blocked). Start a new download with a different URL.",
  drmProtected: "This content is DRM-protected and cannot be downloaded.",
  unsupported: "This kind of download is not supported.",
  parse: "The playlist or manifest could not be read. Start a new download from a fresh capture.",
};

export function isPermanentDownloadError(code: string | null | undefined): boolean {
  return !!code && PERMANENT_ERROR_CODES.has(code);
}

function jobName({ job }: PublicDownloadJob): string {
  const fromPath = job.outputPath?.split(/[\\/]/).pop();
  return job.spec?.fileName || fromPath || job.id;
}

/** Shared job list (progress + pause/resume/cancel + show in folder) for the Downloads panel and Services dialog. */
export function DownloadJobList({ jobs, disabled, onControl, onReveal }: {
  jobs: PublicDownloadJob[];
  disabled: boolean;
  onControl: (jobId: string, action: DownloadAction) => void;
  onReveal: (jobId: string) => void;
}) {
  if (!jobs.length) return <p className="ag-muted">No downloads in this session.</p>;
  return <ul className="ag-dl-list">{jobs.map((entry) => {
    const { job, reauthorizationRequired } = entry;
    const progress = job.progress;
    const total = progress?.total ?? null;
    const percent = progress && total ? Math.min(100, Math.round((progress.downloaded / total) * 100)) : null;
    return <li key={job.id} className="ag-dl-job">
      <p className="ag-dl-job__head"><span className="ag-dl-job__name" title={jobName(entry)}>{jobName(entry)}</span> <span className="ag-muted">{job.status}{job.errorCode ? ` · ${job.errorCode}` : ""}</span></p>
      {progress && job.status !== "completed" ? <>
        {percent !== null ? <progress className="ag-dl-bar" max={100} value={percent} aria-label={`Progress of ${jobName(entry)}`} /> : null}
        <p className="ag-muted">
          {formatBytes(progress.downloaded)}{total ? ` / ${formatBytes(total)}` : ""}
          {job.status === "downloading" && progress.speedBps > 0 ? ` · ${formatBytes(progress.speedBps)}/s` : ""}
        </p>
      </> : null}
      {job.outputPath && job.status === "completed" ? <p className="ag-pre">{job.outputPath}</p> : null}
      {job.error ? <p className="ag-error">{(job.errorCode && ERROR_MESSAGES[job.errorCode]) || job.error}</p> : null}
      {entry.muxSkipped && entry.muxHint ? <p className="ag-muted" role="note">{entry.muxHint}</p> : null}
      {reauthorizationRequired ? <p className="ag-muted">Restored job: capture the request again and start a new download. Resume is disabled.</p> : null}
      <div className="ag-row">
        {job.status === "downloading" || job.status === "queued" ? <button type="button" className="ag-btn" disabled={disabled} onClick={() => onControl(job.id, "pause")}>Pause</button> : null}
        {(job.status === "paused" || job.status === "failed") && !isPermanentDownloadError(job.errorCode) ? <button type="button" className="ag-btn" disabled={disabled || reauthorizationRequired} onClick={() => onControl(job.id, "resume")}>Resume</button> : null}
        {!["completed", "cancelled"].includes(job.status) ? <button type="button" className="ag-btn" disabled={disabled} onClick={() => onControl(job.id, "cancel")}>Cancel download</button> : null}
        {job.status === "completed" && job.outputPath ? <button type="button" className="ag-btn" disabled={disabled} onClick={() => onReveal(job.id)}>Show in folder</button> : null}
      </div>
    </li>;
  })}</ul>;
}
