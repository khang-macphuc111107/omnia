import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, CircleDot, LoaderCircle, Plus, RefreshCw, Target } from "lucide-react";

import { desktop, isDesktopRuntime, type GoalSummary } from "@/lib/desktop";

type DraftPayload = { title: string; description: string };

function createIdempotencyKey(): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `project-goal:${id}`;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "The native Goal request could not be confirmed.";
}

const STATUS_LABELS: Record<GoalSummary["status"], string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
  cancelled: "Cancelled",
};

export interface NativeProjectGoalsProps {
  projectId: string;
  projectName: string;
}

/** Native-authoritative Project Goal roots; never fabricates saved Goal data in browser preview. */
export function NativeProjectGoals({ projectId, projectName }: NativeProjectGoalsProps) {
  const isDesktop = isDesktopRuntime();
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [loading, setLoading] = useState(isDesktop);
  const [loadError, setLoadError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attempt, setAttempt] = useState<DraftPayload | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setGoals([]);
    setTitle("");
    setDescription("");
    setAttempt(null);
    setIdempotencyKey(createIdempotencyKey());
    setSaving(false);
    setSaveError("");
    setNotice("");
  }, [projectId]);

  useEffect(() => {
    if (!isDesktop) {
      setLoading(false);
      return;
    }

    let current = true;
    setLoading(true);
    setLoadError("");
    void desktop.listGoals({ projectId, includeArchived: false, limit: 50 })
      .then((items) => {
        if (current) setGoals(items.filter((goal) => goal.projectId === projectId));
      })
      .catch((error: unknown) => {
        if (current) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => { current = false; };
  }, [isDesktop, projectId, refreshVersion]);

  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), []);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isDesktop || saving) return;

    const payload = attempt ?? { title: title.trim(), description: description.trim() };
    if (!payload.title) return;
    const requestedProjectId = projectId;

    setAttempt(payload);
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const snapshot = await desktop.createGoal({
        projectId: requestedProjectId,
        title: payload.title,
        ...(payload.description ? { description: payload.description } : {}),
        status: "draft",
        idempotencyKey,
      });
      if (snapshot.integrity !== "valid" || snapshot.executionDisposition !== "preview-only") {
        throw new Error("The native response did not confirm an intact preview-only Goal snapshot.");
      }
      if (projectIdRef.current !== requestedProjectId) return;
      setNotice(`Saved “${snapshot.goal.title}” as a native draft. Goal execution is still preview-only.`);
      setTitle("");
      setDescription("");
      setAttempt(null);
      setIdempotencyKey(createIdempotencyKey());
      refresh();
    } catch (error) {
      if (projectIdRef.current === requestedProjectId) setSaveError(errorMessage(error));
    } finally {
      if (projectIdRef.current === requestedProjectId) setSaving(false);
    }
  }

  function unlockDraft() {
    setAttempt(null);
    setIdempotencyKey(createIdempotencyKey());
    setSaveError("");
  }

  return (
    <section className={`native-project-goals${isDesktop ? "" : " native-project-goals--preview"}`} aria-labelledby="native-project-goals-title">
      <header className="native-project-goals__header">
        <div className="native-project-goals__heading">
          <span className="native-project-goals__icon" aria-hidden="true"><Target size={16} /></span>
          <div>
            <h3 id="native-project-goals-title">Saved project goals</h3>
            {isDesktop ? <p>{projectName} · native records, separate from the planning preview</p> : null}
          </div>
        </div>
        {isDesktop ? <button type="button" className="button button--ghost native-project-goals__refresh" onClick={refresh} disabled={loading} title="Refresh goals from Omnia Core" aria-label="Refresh saved project goals">
          {loading ? <LoaderCircle size={14} className="native-project-goals__spin" /> : <RefreshCw size={14} />}
          <span>Refresh</span>
        </button> : null}
      </header>

      {!isDesktop ? (
        <div className="native-project-goals__boundary" role="status">
          <AlertCircle size={15} />
          <span>Native Goal storage is unavailable in this browser preview. Open desktop to view saved goals.</span>
        </div>
      ) : (
        <>
          <form className="native-project-goals__form" onSubmit={handleCreate}>
            <label className="native-project-goals__title-field">
              <span>New goal</span>
              <input
                value={attempt?.title ?? title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={500}
                disabled={saving || attempt !== null}
                placeholder="e.g. Ship the first reliable release"
                aria-label="New project goal title"
                required
              />
            </label>
            <label className="native-project-goals__description-field">
              <span>Outcome <small>optional</small></span>
              <input
                value={attempt?.description ?? description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={16_000}
                disabled={saving || attempt !== null}
                placeholder="What should be true when this goal is complete?"
                aria-label="New project goal outcome"
              />
            </label>
            <div className="native-project-goals__form-actions">
              <button type="submit" className="button button--primary" disabled={loading || saving || !((attempt?.title ?? title).trim())} title={attempt ? "Retry the exact same request with its original idempotency key" : "Create a native draft Goal for this Project"}>
                {saving ? <LoaderCircle size={14} className="native-project-goals__spin" /> : attempt ? <RefreshCw size={14} /> : <Plus size={14} />}
                {saving ? "Saving…" : attempt ? "Retry same draft" : "Save draft"}
              </button>
              {attempt && !saving ? <button type="button" className="button button--ghost" onClick={unlockDraft} title="Unlock fields and start a new Goal request">Edit draft</button> : null}
            </div>
          </form>

          {notice ? <p className="native-project-goals__notice" role="status"><CheckCircle2 size={14} />{notice}</p> : null}
          {saveError ? <p className="native-project-goals__error" role="alert"><AlertCircle size={14} /><span>{saveError} Retry will reuse the same request key; editing starts a new request.</span></p> : null}

          <div className="native-project-goals__list-heading">
            <strong>Goals in this Project</strong>
            <span>{loading ? "Loading…" : `${goals.length} saved`}</span>
          </div>
          {loadError ? <p className="native-project-goals__error" role="alert"><AlertCircle size={14} /><span>Could not load native Goals: {loadError}</span></p> : null}
          {!loading && !loadError && goals.length === 0 ? (
            <div className="native-project-goals__empty"><CircleDot size={15} /><span>No native Goals saved for this Project yet.</span></div>
          ) : null}
          {goals.length > 0 ? (
            <ul className="native-project-goals__list" aria-label="Saved goals">
              {goals.map((goal) => (
                <li key={goal.id}>
                  <span className={`native-project-goals__status native-project-goals__status--${goal.status}`} title={`Goal status: ${STATUS_LABELS[goal.status]}`}>{STATUS_LABELS[goal.status]}</span>
                  <span className="native-project-goals__goal-title" title={goal.title}>{goal.title}</span>
                  <code title="Native Goal ID">{goal.id}</code>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="native-project-goals__boundary"><CircleDot size={13} /> Saved through Omnia Core. Creating a Goal does not schedule agents or execute tasks.</p>
        </>
      )}
    </section>
  );
}
