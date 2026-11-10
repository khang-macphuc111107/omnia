import { CalendarClock, Clipboard, Download, Info, Redo2, RotateCcw, ShieldCheck, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";

import "../../styles/workspace-export-schedule-preview.css";

export type WorkspaceExportScheduleCadence = "daily" | "weekly" | "monthly";

export type WorkspaceExportScheduleConfig = {
  enabled: boolean;
  profileId: string;
  cadence: WorkspaceExportScheduleCadence;
  interval: number;
  startDate: string;
  localTime: string;
  weekday: number;
  monthDay: number;
  retentionCount: number;
  destinationMode: "ask" | "browser-download" | "custom-label";
  destinationLabel: string;
};

export type WorkspaceExportScheduleProfile = { id: string; name: string };

const WORKSPACE_EXPORT_SCHEDULE_SCHEMA = "omnia.workspace-export-schedule.preview.v1";
const MAX_IMPORT_BYTES = 16 * 1024;

export const INITIAL_WORKSPACE_EXPORT_SCHEDULE: WorkspaceExportScheduleConfig = {
  enabled: false,
  profileId: "safe-handoff",
  cadence: "weekly",
  interval: 1,
  startDate: "2026-09-28",
  localTime: "09:00",
  weekday: 1,
  monthDay: 1,
  retentionCount: 8,
  destinationMode: "ask",
  destinationLabel: "",
};

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function localDayStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function computeNextWorkspaceExportOccurrence(input: {
  config: WorkspaceExportScheduleConfig;
  now: Date;
}): Date | null {
  const { config, now } = input;
  const start = parseLocalDate(config.startDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(config.localTime);
  if (!config.enabled || !start || !timeMatch || !Number.isInteger(config.interval) || config.interval < 1) return null;
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  if (hours > 23 || minutes > 59) return null;
  if (config.cadence === "weekly" && (!Number.isInteger(config.weekday) || config.weekday < 0 || config.weekday > 6)) return null;
  if (config.cadence === "monthly" && (!Number.isInteger(config.monthDay) || config.monthDay < 1 || config.monthDay > 28)) return null;

  const anchor = localDayStart(start);
  const today = localDayStart(now);
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  for (let offset = 0; offset <= 366 * 6; offset += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    if (day < anchor) continue;
    let matches = false;
    if (config.cadence === "daily") {
      const dayOffset = Math.round((day.getTime() - anchor.getTime()) / millisecondsPerDay);
      matches = dayOffset % config.interval === 0;
    } else if (config.cadence === "weekly") {
      if (day.getDay() === config.weekday) {
        const anchorWeek = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
        const dayWeek = new Date(day.getFullYear(), day.getMonth(), day.getDate() - day.getDay());
        const weekOffset = Math.round((dayWeek.getTime() - anchorWeek.getTime()) / (millisecondsPerDay * 7));
        matches = weekOffset >= 0 && weekOffset % config.interval === 0;
      }
    } else {
      const monthOffset = (day.getFullYear() - anchor.getFullYear()) * 12 + day.getMonth() - anchor.getMonth();
      matches = monthOffset >= 0 && monthOffset % config.interval === 0 && day.getDate() === config.monthDay;
    }
    if (!matches) continue;
    const occurrence = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
    if (occurrence.getTime() > now.getTime()) return occurrence;
  }
  return null;
}

function formatOccurrence(value: Date | null): string {
  if (!value) return "No upcoming occurrence in the next six years";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "short",
  }).format(value);
}

function isValidScheduleConfig(value: unknown): value is WorkspaceExportScheduleConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  const allowedKeys = Object.keys(INITIAL_WORKSPACE_EXPORT_SCHEDULE);
  if (Object.keys(config).length !== allowedKeys.length || allowedKeys.some((key) => !Object.hasOwn(config, key))) return false;
  const startDate = typeof config.startDate === "string" ? parseLocalDate(config.startDate) : null;
  const time = typeof config.localTime === "string" ? /^(\d{2}):(\d{2})$/.exec(config.localTime) : null;
  const validTime = Boolean(time && Number(time[1]) <= 23 && Number(time[2]) <= 59);
  const validDestination = config.destinationMode === "ask" || config.destinationMode === "browser-download" || config.destinationMode === "custom-label";
  return typeof config.enabled === "boolean"
    && typeof config.profileId === "string"
    && (config.cadence === "daily" || config.cadence === "weekly" || config.cadence === "monthly")
    && Number.isInteger(config.interval) && Number(config.interval) >= 1 && Number(config.interval) <= 365
    && Boolean(startDate)
    && validTime
    && Number.isInteger(config.weekday) && Number(config.weekday) >= 0 && Number(config.weekday) <= 6
    && Number.isInteger(config.monthDay) && Number(config.monthDay) >= 1 && Number(config.monthDay) <= 28
    && Number.isInteger(config.retentionCount) && Number(config.retentionCount) >= 1 && Number(config.retentionCount) <= 100
    && validDestination
    && typeof config.destinationLabel === "string" && config.destinationLabel.length <= 180;
}

function scheduleExportPayload(config: WorkspaceExportScheduleConfig): string {
  return JSON.stringify({ schema: WORKSPACE_EXPORT_SCHEDULE_SCHEMA, config }, null, 2);
}

type ScheduleHistory = { past: WorkspaceExportScheduleConfig[]; present: WorkspaceExportScheduleConfig; future: WorkspaceExportScheduleConfig[] };

export function WorkspaceExportSchedulePreview({ profiles }: { profiles: readonly WorkspaceExportScheduleProfile[] }) {
  const [history, setHistory] = useState<ScheduleHistory>(() => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return { past: [], present: { ...INITIAL_WORKSPACE_EXPORT_SCHEDULE, startDate: today }, future: [] };
  });
  const [importText, setImportText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [status, setStatus] = useState("");
  const config = history.present;
  const exportPayload = useMemo(() => scheduleExportPayload(config), [config]);
  const profileId = profiles.some((profile) => profile.id === config.profileId) ? config.profileId : profiles[0]?.id ?? "";
  const occurrence = useMemo(() => computeNextWorkspaceExportOccurrence({ config: { ...config, profileId }, now: new Date() }), [config, profileId]);
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Local system timezone", []);
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const commit = (next: WorkspaceExportScheduleConfig) => setHistory((current) => ({
    past: [...current.past, current.present].slice(-30),
    present: next,
    future: [],
  }));
  const update = (patch: Partial<WorkspaceExportScheduleConfig>) => commit({ ...config, ...patch });
  const undo = () => setHistory((current) => {
    const previous = current.past.at(-1);
    return previous ? { past: current.past.slice(0, -1), present: previous, future: [current.present, ...current.future] } : current;
  });
  const redo = () => setHistory((current) => {
    const next = current.future[0];
    return next ? { past: [...current.past, current.present].slice(-30), present: next, future: current.future.slice(1) } : current;
  });
  const reset = () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    commit({ ...INITIAL_WORKSPACE_EXPORT_SCHEDULE, profileId: profiles[0]?.id ?? INITIAL_WORKSPACE_EXPORT_SCHEDULE.profileId, startDate: today });
    setStatus("Schedule draft reset to defaults for this session.");
  };
  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; no schedule draft was copied."); return; }
    try { await navigator.clipboard.writeText(exportPayload); setStatus("Copied renderer-local schedule JSON preview."); }
    catch { setStatus("Clipboard access was denied; no schedule draft was copied."); }
  };
  const downloadExport = () => {
    const url = URL.createObjectURL(new Blob([exportPayload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "omnia-export-schedule-preview.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Started a browser download of the renderer-local schedule preview.");
  };
  const importSchedule = () => {
    if (new Blob([importText]).size > MAX_IMPORT_BYTES) { setStatus("Import rejected: JSON exceeds the 16 KB limit."); return; }
    try {
      const parsed: unknown = JSON.parse(importText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
      const bundle = parsed as Record<string, unknown>;
      const importedConfig = bundle.config;
      if (Object.keys(bundle).length !== 2 || !Object.hasOwn(bundle, "schema") || !Object.hasOwn(bundle, "config") ||
          bundle.schema !== WORKSPACE_EXPORT_SCHEDULE_SCHEMA || !isValidScheduleConfig(importedConfig)) throw new Error("invalid schedule");
      if (!profiles.some((profile) => profile.id === importedConfig.profileId)) throw new Error("unknown profile");
      commit({ ...importedConfig });
      setStatus("Imported schedule draft into this renderer session; no scheduler or file was created.");
    } catch {
      setStatus("Import rejected: expected a valid Omnia schedule JSON preview and an available profile.");
    }
  };
  const scheduleDescription = config.cadence === "daily"
    ? `Every ${config.interval} day${config.interval === 1 ? "" : "s"}`
    : config.cadence === "weekly"
      ? `Every ${config.interval} week${config.interval === 1 ? "" : "s"} on ${WEEKDAY_LABELS[config.weekday]}`
      : `Every ${config.interval} month${config.interval === 1 ? "" : "s"} on day ${config.monthDay}`;

  return (
    <section className="workspace-export-schedule" aria-label="Scheduled export preview">
      <header className="workspace-export-schedule__header">
        <div>
          <span className="eyebrow">Recurring export · configuration preview</span>
          <h3>Schedule an export</h3>
          <p>Shape a future schedule and see its next occurrence. The native scheduler and automatic export are not connected.</p>
        </div>
        <span className="workspace-export-schedule__badge"><CalendarClock size={14} /> {config.enabled ? "Draft enabled" : "Paused"}</span>
      </header>

      <div className="workspace-export-schedule__boundary" role="note">
        <ShieldCheck size={15} /> Preview only · renderer-local · no timer, background task, automatic export, file write, or native schedule is created. Download below exports only this configuration draft.
      </div>

      <div className="workspace-export-schedule__draft-tools" aria-label="Schedule draft controls">
        <div className="workspace-export-schedule__draft-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length} aria-label="Undo schedule change"><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length} aria-label="Redo schedule change"><Redo2 size={13} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset defaults</button>
          <button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy JSON</button>
          <button type="button" className="button button--ghost" onClick={downloadExport}><Download size={13} /> Download JSON</button>
          <button type="button" className="button button--secondary" onClick={() => setImportOpen((open) => !open)}>{importOpen ? "Close import" : "Import JSON"}</button>
        </div>
        {importOpen ? <div className="workspace-export-schedule__import">
          <label><span>Paste schedule configuration JSON · max 16 KB</span><textarea aria-label="Schedule JSON import" rows={5} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={`Paste ${WORKSPACE_EXPORT_SCHEDULE_SCHEMA} here`} /></label>
          <button type="button" className="button button--secondary" onClick={importSchedule}>Review and apply to draft</button>
        </div> : null}
        <pre className="workspace-export-schedule__payload" aria-label="Schedule JSON export preview">{exportPayload}</pre>
        <p className="workspace-export-schedule__status" role="status" aria-live="polite">{status || "Undo/redo, reset, import, and export affect only this renderer-session draft."}</p>
      </div>

      <label className="workspace-export-schedule__toggle">
        <input type="checkbox" checked={config.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        <span><strong>Enable schedule draft</strong><small>Enabling changes only this visible preview state for this session.</small></span>
      </label>

      <div className="workspace-export-schedule__fields">
        <label><span>Export profile</span><select aria-label="Scheduled export profile" value={profileId} onChange={(event) => update({ profileId: event.target.value })} disabled={!profiles.length}>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          {!profiles.length ? <option value="">No profiles available</option> : null}
        </select></label>
        <label><span>Cadence</span><select aria-label="Export schedule cadence" value={config.cadence} onChange={(event) => update({ cadence: event.target.value as WorkspaceExportScheduleCadence })}>
          <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
        </select></label>
        <label><span>Repeat every</span><span className="workspace-export-schedule__inline-input"><input aria-label="Export schedule interval" type="number" min={1} max={365} value={config.interval} onChange={(event) => update({ interval: Math.max(1, Math.min(365, Number(event.target.value) || 1)) })} /><small>{config.cadence === "daily" ? "day(s)" : config.cadence === "weekly" ? "week(s)" : "month(s)"}</small></span></label>
        {config.cadence === "weekly" ? <label><span>Day of week</span><select aria-label="Export schedule weekday" value={config.weekday} onChange={(event) => update({ weekday: Number(event.target.value) })}>{WEEKDAY_LABELS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label> : null}
        {config.cadence === "monthly" ? <label><span>Day of month</span><select aria-label="Export schedule month day" value={config.monthDay} onChange={(event) => update({ monthDay: Number(event.target.value) })}>{Array.from({ length: 28 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day}</option>)}</select></label> : null}
        <label><span>Start date</span><input aria-label="Export schedule start date" type="date" value={config.startDate} onChange={(event) => update({ startDate: event.target.value })} /></label>
        <label><span>Local run time</span><input aria-label="Export schedule time" type="time" value={config.localTime} onChange={(event) => update({ localTime: event.target.value })} /></label>
        <label><span>Retain last</span><span className="workspace-export-schedule__inline-input"><input aria-label="Export retention count" type="number" min={1} max={100} value={config.retentionCount} onChange={(event) => update({ retentionCount: Math.max(1, Math.min(100, Number(event.target.value) || 1)) })} /><small>exports · planned</small></span></label>
        <label><span>Planned destination</span><select aria-label="Export schedule destination mode" value={config.destinationMode} onChange={(event) => update({ destinationMode: event.target.value as WorkspaceExportScheduleConfig["destinationMode"] })}>
          <option value="ask">Ask when manually exporting</option><option value="browser-download">Browser download (manual only)</option><option value="custom-label">Custom label / path note</option>
        </select></label>
        {config.destinationMode === "custom-label" ? <label className="workspace-export-schedule__wide"><span>Destination label · note only</span><input aria-label="Export destination label" value={config.destinationLabel} maxLength={180} onChange={(event) => update({ destinationLabel: event.target.value })} placeholder="e.g. D:\\Omnia backups · no folder access" /></label> : null}
      </div>

      <div className="workspace-export-schedule__next" aria-label="Next export schedule occurrence">
        <div><span className="eyebrow">Next occurrence preview</span><strong>{config.enabled ? formatOccurrence(occurrence) : "Paused · no occurrence preview"}</strong><small>{scheduleDescription} · {timezone} · profile: {selectedProfile?.name ?? "not selected"}</small></div>
        <span className="workspace-export-schedule__next-icon"><CalendarClock size={17} /></span>
      </div>

      <p className="workspace-export-schedule__note"><Info size={14} /> Retention and destination are descriptive draft values only. No old export is deleted, no path is read or written, and the next occurrence is a local calculation.</p>
    </section>
  );
}

export default WorkspaceExportSchedulePreview;
