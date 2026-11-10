import { FolderOpen, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import "./schedules-dialog.css";

import { ModalSurface } from "@/components/modal-surface";
import type { ProviderProfileRecord } from "@/lib/desktop";

import { agentApi, errorMessage } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { readPrefs } from "./prefs";
import { PERMISSION_MODES, type AgentSchedule, type PermissionMode } from "./types";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NEW_SESSION = "__new__";
const pad = (value: number) => String(value).padStart(2, "0");

function dayList(field: string): string | null {
  if (field === "1-5") return "weekday";
  if (field === "0,6" || field === "6,0" || field === "0,6,7" || field === "6,7") return "weekend day";
  if (!/^[0-7](,[0-7])*$/.test(field)) return null;
  const names = [...new Set(field.split(",").map((d) => DAY_NAMES[Number(d) % 7]!))];
  return names.join(", ");
}

/** Human description of common cron shapes; falls back to the raw expression. */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const digits = /^\d+$/;
  if (month === "*" && dom === "*" && dow === "*") {
    if (minute === "*" && hour === "*") return "Every minute";
    const step = minute.match(/^\*\/(\d+)$/);
    if (step && hour === "*") return `Every ${step[1]} minutes`;
    if (digits.test(minute) && hour === "*") return `Every hour at :${pad(Number(minute))}`;
  }
  if (digits.test(minute) && digits.test(hour) && month === "*") {
    const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
    if (dom === "*" && dow === "*") return `Every day at ${time}`;
    if (dom === "*") {
      const days = dayList(dow);
      if (days === "weekday") return `Every weekday at ${time}`;
      if (days === "weekend day") return `Every weekend day at ${time}`;
      if (days) return `Every ${days} at ${time}`;
    }
    if (digits.test(dom) && dow === "*") return `Day ${dom} of every month at ${time}`;
  }
  return `Cron ${cron.trim()}`;
}

function describeSchedule(schedule: AgentSchedule): string {
  if (schedule.cron) return describeCron(schedule.cron);
  const minutes = schedule.intervalMinutes ?? 0;
  if (minutes % 1440 === 0 && minutes > 0) return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0 && minutes > 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

interface Draft {
  id?: string | undefined;
  name: string;
  target: string;
  cwd: string;
  profileId: string;
  model: string;
  permissionMode: PermissionMode;
  prompt: string;
  kind: "cron" | "interval";
  cron: string;
  interval: string;
  enabled: boolean;
}

function blankDraft(sessionId: string | null): Draft {
  const prefs = readPrefs();
  return {
    name: "",
    target: sessionId ?? NEW_SESSION,
    cwd: prefs.recentFolders[0] ?? "",
    profileId: prefs.profileId ?? "",
    model: prefs.model ?? "",
    permissionMode: (prefs.permissionMode as PermissionMode) ?? "ask_writes",
    prompt: "",
    kind: "cron",
    cron: "0 9 * * 1-5",
    interval: "60",
    enabled: true,
  };
}

function draftOf(schedule: AgentSchedule): Draft {
  return {
    ...blankDraft(null),
    id: schedule.id,
    name: schedule.name,
    target: schedule.sessionId ?? NEW_SESSION,
    cwd: schedule.newSession?.cwd ?? "",
    profileId: schedule.newSession?.profileId ?? "",
    model: schedule.newSession?.model ?? "",
    permissionMode: schedule.newSession?.permissionMode ?? "ask_writes",
    prompt: schedule.prompt,
    kind: schedule.cron ? "cron" : "interval",
    cron: schedule.cron ?? "0 9 * * 1-5",
    interval: String(schedule.intervalMinutes ?? 60),
    enabled: schedule.enabled,
  };
}

function scheduleOf(draft: Draft): Omit<AgentSchedule, "id"> & { id?: string | undefined } {
  const base = {
    id: draft.id,
    name: draft.name.trim(),
    prompt: draft.prompt,
    enabled: draft.enabled,
  };
  const target =
    draft.target === NEW_SESSION
      ? {
          sessionId: null,
          newSession: {
            cwd: draft.cwd.trim(),
            profileId: draft.profileId,
            model: draft.model.trim(),
            permissionMode: draft.permissionMode,
          },
        }
      : { sessionId: draft.target, newSession: null };
  const timing =
    draft.kind === "cron"
      ? { cron: draft.cron.trim(), intervalMinutes: null }
      : { cron: null, intervalMinutes: Number(draft.interval) };
  return { ...base, ...target, ...timing };
}

function ScheduleForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Draft;
  onSaved: (list: AgentSchedule[]) => void;
  onCancel: () => void;
}) {
  const sessions = useAgentStore((s) => s.sessions);
  const [draft, setDraft] = useState<Draft>(initial);
  const [profiles, setProfiles] = useState<ProviderProfileRecord[]>([]);
  const [preview, setPreview] = useState<number[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true });
  }, []);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const isNew = draft.target === NEW_SESSION;

  useEffect(() => {
    if (!isNew) return;
    let alive = true;
    agentApi
      .listProfiles()
      .then((list) => {
        if (!alive) return;
        const enabled = list.filter((p) => p.enabled);
        setProfiles(enabled);
        setDraft((d) => (enabled.some((p) => p.id === d.profileId) ? d : { ...d, profileId: enabled[0]?.id ?? "" }));
      })
      .catch((cause) => alive && setError(errorMessage(cause)));
    return () => {
      alive = false;
    };
  }, [isNew]);

  useEffect(() => {
    if (draft.kind !== "cron") return;
    let alive = true;
    const timer = window.setTimeout(() => {
      agentApi
        .previewSchedule(draft.cron.trim())
        .then((runs) => alive && (setPreview(runs), setPreviewError(null)))
        .catch((cause) => alive && (setPreview(null), setPreviewError(errorMessage(cause))));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [draft.kind, draft.cron]);

  const browse = async () => {
    try {
      const picked = await agentApi.pickFolder();
      if (picked) set("cwd", picked);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const intervalOk = Number.isInteger(Number(draft.interval)) && Number(draft.interval) >= 1;
  const targetOk = !isNew || (draft.cwd.trim() && draft.profileId && draft.model.trim());
  const timingOk = draft.kind === "cron" ? draft.cron.trim() && !previewError : intervalOk;
  const ready = draft.name.trim() && draft.prompt.trim() && targetOk && timingOk;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await agentApi.saveSchedule(scheduleOf(draft)));
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <form
      className="ag-schedules__form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="ag-schedules__body">
        <div className="ag-field">
          <label className="ag-label" htmlFor={`${id}-name`}>Name</label>
          <input ref={nameRef} id={`${id}-name`} className="ag-input" value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </div>

        <div className="ag-field">
          <label className="ag-label" htmlFor={`${id}-target`}>Run in</label>
          <select id={`${id}-target`} className="ag-input" value={draft.target} onChange={(e) => set("target", e.target.value)}>
            <option value={NEW_SESSION}>New session in folder…</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.title || "Untitled"}</option>
            ))}
          </select>
        </div>

        {isNew ? (
          <>
            <div className="ag-field">
              <label className="ag-label" htmlFor={`${id}-cwd`}>Folder</label>
              <div className="ag-row">
                <input id={`${id}-cwd`} className="ag-input" value={draft.cwd} placeholder="Folder for the new session" onChange={(e) => set("cwd", e.target.value)} />
                <button type="button" className="ag-btn" onClick={() => void browse()}>
                  <FolderOpen size={14} aria-hidden="true" /> Browse
                </button>
              </div>
            </div>
            <div className="ag-field">
              <label className="ag-label" htmlFor={`${id}-profile`}>Provider</label>
              <select id={`${id}-profile`} className="ag-input" value={draft.profileId} onChange={(e) => set("profileId", e.target.value)}>
                {profiles.length === 0 ? <option value="">No provider profiles</option> : null}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </select>
            </div>
            <div className="ag-field">
              <label className="ag-label" htmlFor={`${id}-model`}>Model</label>
              <input id={`${id}-model`} className="ag-input" value={draft.model} placeholder="Model id" onChange={(e) => set("model", e.target.value)} />
            </div>
            <div className="ag-field">
              <label className="ag-label" htmlFor={`${id}-mode`}>Permissions</label>
              <select id={`${id}-mode`} className="ag-input" value={draft.permissionMode} onChange={(e) => set("permissionMode", e.target.value as PermissionMode)}>
                {PERMISSION_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <p className="ag-muted">Unattended runs cannot answer approval prompts; pick a mode that will not need them.</p>
            </div>
          </>
        ) : null}

        <div className="ag-field">
          <label className="ag-label" htmlFor={`${id}-prompt`}>Prompt</label>
          <textarea id={`${id}-prompt`} className="ag-input" rows={4} value={draft.prompt} onChange={(e) => set("prompt", e.target.value)} />
        </div>

        <div className="ag-field">
          <label className="ag-label" htmlFor={`${id}-kind`}>Repeat</label>
          <select id={`${id}-kind`} className="ag-input" value={draft.kind} onChange={(e) => set("kind", e.target.value as Draft["kind"])}>
            <option value="cron">On a cron schedule</option>
            <option value="interval">Every N minutes</option>
          </select>
        </div>

        {draft.kind === "cron" ? (
          <div className="ag-field">
            <label className="ag-label" htmlFor={`${id}-cron`}>Cron (minute hour day month weekday, local time)</label>
            <input id={`${id}-cron`} className="ag-input" value={draft.cron} spellCheck={false} onChange={(e) => set("cron", e.target.value)} />
            {previewError ? (
              <p className="ag-error" role="alert">{previewError}</p>
            ) : preview ? (
              <div className="ag-muted" aria-label="Next runs">
                <div>{describeCron(draft.cron)}</div>
                <ul className="ag-sched__preview">
                  {preview.map((ms) => (
                    <li key={ms}>{when(ms)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="ag-field">
            <label className="ag-label" htmlFor={`${id}-interval`}>Minutes between runs</label>
            <input id={`${id}-interval`} className="ag-input" inputMode="numeric" value={draft.interval} onChange={(e) => set("interval", e.target.value)} />
          </div>
        )}

        <label className="ag-row">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Enabled
        </label>

        {error ? <p className="ag-error" role="alert">{error}</p> : null}
      </div>

      <div className="ag-dialog__actions">
        <button type="button" className="ag-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="ag-btn ag-btn--primary" disabled={!ready || busy}>Save schedule</button>
      </div>
    </form>
  );
}

function ScheduleRow({
  schedule,
  onToggle,
  onRun,
  onEdit,
  onDelete,
}: {
  schedule: AgentSchedule;
  onToggle: () => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const status = schedule.lastStatus;
  return (
    <li className="ag-sched__row">
      <input
        type="checkbox"
        aria-label={`Enable ${schedule.name}`}
        checked={schedule.enabled}
        onChange={onToggle}
      />
      <div className="ag-sched__main">
        <button type="button" className="ag-link ag-sched__name" data-schedule-edit={schedule.id} onClick={onEdit}>{schedule.name}</button>
        <span className="ag-muted">
          {describeSchedule(schedule)}
          {schedule.enabled && schedule.nextRunAt ? ` · next ${when(schedule.nextRunAt)}` : ""}
        </span>
        {status ? (
          <span className="ag-muted">
            Last: {status}
            {schedule.lastRunAt ? ` · ${when(schedule.lastRunAt)}` : ""}
            {schedule.lastMessage ? ` · ${schedule.lastMessage}` : ""}
          </span>
        ) : null}
      </div>
      <button type="button" className="ag-btn" aria-label={`Run ${schedule.name} now`} disabled={status === "running"} onClick={onRun}>
        <Play size={14} aria-hidden="true" /> Run now
      </button>
      <button type="button" className="ag-btn ag-btn--ghost" aria-label={`Delete ${schedule.name}`} onClick={onDelete}>
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

/** Scheduled agent tasks: list, edit and run recurring prompts. Opened from the command palette. */
export function SchedulesDialog({ onClose }: { onClose: () => void }) {
  const activeId = useAgentStore((s) => s.activeId);
  const [schedules, setSchedules] = useState<AgentSchedule[] | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const returnFocusId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-schedule-edit]");
      const target = Array.from(buttons ?? []).find((button) => button.dataset.scheduleEdit === returnFocusId.current);
      (target ?? listRef.current?.querySelector<HTMLButtonElement>("[data-schedule-new]"))?.focus({ preventScroll: true });
    }
    wasEditing.current = editing !== null;
  }, [editing]);

  const refresh = useCallback(async () => {
    try {
      setSchedules(await agentApi.schedules());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const attempt = async (action: () => Promise<unknown>) => {
    try {
      setError(null);
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    }
    await refresh();
  };

  const toggle = (schedule: AgentSchedule) =>
    attempt(async () => setSchedules(await agentApi.saveSchedule({ ...schedule, enabled: !schedule.enabled })));

  const active = (schedules ?? []).filter((s) => s.enabled);
  const paused = (schedules ?? []).filter((s) => !s.enabled);
  const group = (title: string, list: AgentSchedule[]) =>
    list.length === 0 ? null : (
      <section aria-label={title}>
        <h3 className="ag-subtitle">{title}</h3>
        <ul className="ag-sched__list">
          {list.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              onToggle={() => void toggle(schedule)}
              onRun={() => void attempt(() => agentApi.runScheduleNow(schedule.id))}
              onEdit={() => { returnFocusId.current = schedule.id; setEditing(draftOf(schedule)); }}
              onDelete={() => setPendingDelete(schedule)}
            />
          ))}
        </ul>
      </section>
    );

  const title = editing ? (editing.id ? "Edit schedule" : "New schedule") : "Scheduled tasks";
  return (
    <>
      <ModalSurface
        className="ag-dialog ag-dialog--wide ag-schedules"
        scrimClassName="ag-scrim ag-schedules-scrim"
        title={title}
        onClose={() => editing ? setEditing(null) : onClose()}
      >
        <h2 className="ag-dialog__title">{title}</h2>
        {editing ? (
          <ScheduleForm
            initial={editing}
            onCancel={() => setEditing(null)}
            onSaved={(list) => {
              setSchedules(list);
              setEditing(null);
            }}
          />
        ) : (
          <div className="ag-schedules__list-view" ref={listRef}>
            <div className="ag-schedules__body">
              <p className="ag-muted">Schedules run only while Omnia is open. A run missed while it was closed happens once at the next start.</p>
              {error ? <p className="ag-error" role="alert">{error}</p> : null}
              {schedules && schedules.length === 0 ? <p className="ag-muted">No scheduled tasks yet.</p> : null}
              {group("Active", active)}
              {group("Paused", paused)}
            </div>
            <div className="ag-dialog__actions">
              <button type="button" className="ag-btn" onClick={onClose}>Close</button>
              <button type="button" className="ag-btn ag-btn--primary" data-schedule-new onClick={() => { returnFocusId.current = null; setEditing(blankDraft(activeId)); }}>New schedule</button>
            </div>
          </div>
        )}
      </ModalSurface>
      {pendingDelete ? (
        <ModalSurface
          className="ag-dialog ag-schedules ag-schedules--confirm"
          scrimClassName="ag-scrim ag-schedules-scrim"
          title="Delete schedule?"
          onClose={() => setPendingDelete(null)}
        >
          <h2 className="ag-dialog__title">Delete schedule?</h2>
          <div className="ag-schedules__body">
            <p className="ag-muted">"{pendingDelete.name}" will stop running. Sessions it already created are kept.</p>
          </div>
          <div className="ag-dialog__actions">
            <button type="button" className="ag-btn" data-dialog-initial-focus onClick={() => setPendingDelete(null)}>Cancel</button>
            <button type="button" className="ag-btn ag-btn--danger" onClick={() => {
              const target = pendingDelete;
              setPendingDelete(null);
              void attempt(async () => setSchedules(await agentApi.deleteSchedule(target.id)));
            }}>Delete</button>
          </div>
        </ModalSurface>
      ) : null}
    </>
  );
}
