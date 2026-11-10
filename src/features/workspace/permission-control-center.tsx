import {
  ArrowRightLeft,
  AlertTriangle,
  Check,
  Copy,
  Download,
  History,
  LockKeyhole,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Undo2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_PERMISSION_VALUES as DEFAULT_VALUES,
  PERMISSION_DEFINITIONS,
  PERMISSION_FAMILY_OPTIONS as FAMILY_OPTIONS,
  PERMISSION_IDS,
  PERMISSION_PRESETS as PRESETS,
  PERMISSION_SCOPES,
  PERMISSION_SCOPE_LABELS as SCOPE_LABELS,
  modeLabel,
  permissionHistoryDiffs,
  parsePermissionPreview,
  permissionValuesEqual as valuesEqual,
  permissionPresetLabel,
  permissionModeCounts,
  permissionScopeExpansions,
  permissionValuesForScope,
  replacePermissionValuesForAllScopes,
  replacePermissionValues,
  resetAllPermissionPreviews,
  resetPermissionPreview,
  setPermissionScope,
  serializePermissionPreview,
  undoPermissionPreview,
  redoPermissionPreview,
  usePermissionSession,
  projectPermissionDraftContext,
  type PermissionFamily,
  type PermissionDiffEntry,
  type PermissionId,
  type PermissionMode,
  type PermissionPreset,
  type PermissionScope,
  type PermissionValues,
} from "./session-permission-contract";

function readPermissionFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("The permission preview file could not be read."));
    reader.readAsText(file);
  });
}

function downloadText(filename: string, text: string, type: string) {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function PermissionControlCenter({ projectId }: { readonly projectId?: string | null | undefined }) {
  const context = projectPermissionDraftContext(projectId);
  const isProjectDraft = Boolean(projectId);
  const history = usePermissionSession(context);
  const scope = history.activeScope;
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState<PermissionFamily | "all">("all");
  const [modeFilter, setModeFilter] = useState<PermissionMode | "all">("all");
  const [reviewFilter, setReviewFilter] = useState<"pending" | "high-risk" | "all">("high-risk");
  const [reviewedKeys, setReviewedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [status, setStatus] = useState(isProjectDraft
    ? "Project permission draft ready. Changes stay in this renderer session."
    : "Permission preview ready. Changes stay in this renderer session.");
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (projectId) {
      setPermissionScope("project", context);
      setStatus("Project permission draft ready. Changes stay in this renderer session.");
      return;
    }
    setStatus("Permission preview ready. Changes stay in this renderer session.");
  }, [context, projectId]);

  const present = history.present;
  const activePreset = useMemo(
    () => PRESETS.find((preset) => valuesEqual(preset.values, present)),
    [present],
  );
  const allowAllPreset = useMemo(
    () => PRESETS.find((preset) => preset.id === "allow-all") ?? PRESETS[0]!,
    [],
  );
  const allowAllHighRiskCount = useMemo(
    () => PERMISSION_DEFINITIONS.filter((definition) => definition.risk === "high").length,
    [],
  );
  const isAllowAllActive = valuesEqual(allowAllPreset.values, present);
  const isAllowAllActiveEverywhere = Object.values(history.valuesByScope).every((values) => valuesEqual(values, allowAllPreset.values));
  const counts = useMemo(() => ({
    allow: PERMISSION_IDS.filter((id) => present[id] === "allow").length,
    prompt: PERMISSION_IDS.filter((id) => present[id] === "prompt").length,
    deny: PERMISSION_IDS.filter((id) => present[id] === "deny").length,
  }), [present]);

  const visibleDefinitions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return PERMISSION_DEFINITIONS.filter((definition) => {
      const matchesQuery = !normalized || `${definition.label} ${definition.family} ${definition.description}`.toLowerCase().includes(normalized);
      const matchesFamily = family === "all" || definition.family === family;
      const matchesMode = modeFilter === "all" || present[definition.id] === modeFilter;
      return matchesQuery && matchesFamily && matchesMode;
    });
  }, [family, modeFilter, present, query]);

  const scopeSummaries = useMemo(() => PERMISSION_SCOPES.map((scopeId) => {
    const values = history.valuesByScope[scopeId];
    const scopeCounts = permissionModeCounts(values);
    const scopeHistory = history.historyByScope[scopeId];
    return {
      scope: scopeId,
      label: SCOPE_LABELS[scopeId],
      counts: scopeCounts,
      undoCount: scopeHistory.past.length,
      redoCount: scopeHistory.future.length,
    };
  }), [history.historyByScope, history.valuesByScope]);

  const scopeExpansions = useMemo(
    () => permissionScopeExpansions(history.valuesByScope),
    [history.valuesByScope],
  );
  const activeScopeExpansions = useMemo(
    () => scopeExpansions.filter((expansion) => expansion.scope === scope),
    [scope, scopeExpansions],
  );
  const historyDiffs = useMemo(
    () => permissionHistoryDiffs(history.historyByScope[scope], present),
    [history.historyByScope, present, scope],
  );
  const latestHistoryDiff = historyDiffs.at(-1)?.diff ?? null;
  const latestHistoryRevision = historyDiffs.at(-1)?.revision ?? 0;
  const reviewEntries = useMemo(() => {
    if (!latestHistoryDiff) return [] as readonly PermissionDiffEntry[];
    return [...latestHistoryDiff.entries].sort((left, right) => {
      const riskRank = (risk: PermissionDiffEntry["risk"]) => risk === "high" ? 0 : risk === "medium" ? 1 : 2;
      const directionRank = (direction: PermissionDiffEntry["direction"]) => direction === "increase" ? 0 : 1;
      return riskRank(left.risk) - riskRank(right.risk)
        || directionRank(left.direction) - directionRank(right.direction)
        || left.label.localeCompare(right.label);
    });
  }, [latestHistoryDiff]);
  const reviewKey = (entry: PermissionDiffEntry) => `${scope}:${latestHistoryRevision}:${entry.permissionId}`;
  const pendingReviewEntries = useMemo(
    () => reviewEntries.filter((entry) => !reviewedKeys.has(reviewKey(entry))),
    [latestHistoryRevision, reviewEntries, reviewedKeys, scope],
  );
  const visibleReviewEntries = useMemo(() => reviewEntries.filter((entry) => {
    if (reviewFilter === "pending") return !reviewedKeys.has(reviewKey(entry));
    if (reviewFilter === "high-risk") return entry.risk === "high";
    return true;
  }), [reviewEntries, reviewFilter, reviewedKeys, scope, latestHistoryRevision]);

  useEffect(() => {
    setReviewedKeys(new Set());
  }, [scope, latestHistoryRevision]);
  const historyDiffGroups = useMemo(() => {
    if (!latestHistoryDiff) return [] as readonly { label: string; tone: "added" | "removed" | "changed"; entries: readonly PermissionDiffEntry[] }[];
    return [
      { label: "Added", tone: "added" as const, entries: latestHistoryDiff.added },
      { label: "Removed", tone: "removed" as const, entries: latestHistoryDiff.removed },
      { label: "Changed", tone: "changed" as const, entries: latestHistoryDiff.changed },
    ].filter((group) => group.entries.length > 0);
  }, [latestHistoryDiff]);

  const serializedPreview = useMemo(() => {
    return serializePermissionPreview(scope, present, format);
  }, [format, present, scope]);

  const commit = (next: PermissionValues, nextStatus: string) => {
    if (valuesEqual(next, present)) {
      setStatus("That permission preview already matches the current values.");
      return;
    }
    replacePermissionValues(next, undefined, context);
    setStatus(nextStatus);
  };

  const updatePermission = (id: PermissionId, value: PermissionMode) => {
    const definition = PERMISSION_DEFINITIONS.find((item) => item.id === id);
    commit({ ...present, [id]: value }, `${definition?.label ?? id} set to ${modeLabel(value)} in the renderer preview.`);
  };

  const applyPreset = (preset: PermissionPreset) => commit(preset.values, `${preset.label} applied to ${SCOPE_LABELS[scope]} as a renderer-only preview.`);

  const applyPresetToAllScopes = (preset: PermissionPreset) => {
    if (valuesEqual(preset.values, present) && Object.values(history.valuesByScope).every((values) => valuesEqual(values, preset.values))) {
      setStatus(`${preset.label} is already active in every renderer preview scope.`);
      return;
    }
    replacePermissionValuesForAllScopes(preset.values, context);
    setStatus(`${preset.label} applied to every permission scope as a renderer-only preview. Each scope keeps an undo entry.`);
  };

  const undo = () => {
    if (history.past.length === 0) return;
    undoPermissionPreview(context);
    setStatus("Undid one permission preview change. No native grant was changed.");
  };

  const redo = () => {
    if (history.future.length === 0) return;
    redoPermissionPreview(context);
    setStatus("Redid one permission preview change. No native grant was changed.");
  };

  const reset = () => {
    resetPermissionPreview(context);
    setStatus("Permission preview reset to the balanced defaults.");
  };

  const resetAll = () => {
    resetAllPermissionPreviews(context);
    setStatus("All permission scopes reset to balanced defaults in the renderer preview.");
  };

  const allScopesAtDefault = Object.values(history.valuesByScope).every((values) => valuesEqual(values, DEFAULT_VALUES));

  const copyPreview = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; the permission preview remains visible and no native export was created.");
      return;
    }
    try {
      await navigator.clipboard.writeText(serializedPreview);
      setStatus(`${format.toUpperCase()} permission preview copied. It is still renderer-local.`);
    } catch {
      setStatus("Clipboard write failed; no durable permission export was created.");
    }
  };

  const exportPreview = () => {
    const extension = format === "json" ? "json" : "md";
    setStatus(downloadText(`omnia-permissions-${projectId ? `${projectId}-` : ""}${scope}.${extension}`, serializedPreview, format === "json" ? "application/json" : "text/markdown")
      ? `${format.toUpperCase()} permission preview download started; native policy is unchanged.`
      : "Browser download is unavailable; the preview remains renderer-local.");
  };

  const importPreview = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parsePermissionPreview(await readPermissionFile(file));
      if (!parsed) throw new Error("This is not an Omnia permission preview JSON file.");
      const targetScope = parsed.permissionScope;
      const currentTarget = permissionValuesForScope(targetScope, context);
      setPermissionScope(targetScope, context);
      if (valuesEqual(parsed.values, currentTarget)) {
        setStatus(`${SCOPE_LABELS[targetScope]} already matches the imported permission preview.`);
        return;
      }
      replacePermissionValues(parsed.values, targetScope, context);
      setStatus(`Permission preview JSON imported into ${SCOPE_LABELS[targetScope]}. Native permissions remain unchanged.`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Permission preview import failed.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  return (
    <section className="permission-center" aria-labelledby="permission-center-title">
      <header className="permission-center__header">
        <span className="permission-center__icon"><ShieldCheck size={19} /></span>
        <div>
          <span className="eyebrow">{isProjectDraft ? "Project-scoped renderer draft" : "Capability policy studio"}</span>
          <h2 id="permission-center-title">Permission Control Center</h2>
          <p>{isProjectDraft
            ? "Shape this Project’s isolated preview profile. It is separate from other Projects and remains session-only."
            : "Shape a detailed permission profile before native approval, leases, and execution receipts are connected."}</p>
        </div>
        <span className="permission-center__status"><Sparkles size={13} /> {isProjectDraft ? "Project draft · session-only" : "Preview only"}</span>
      </header>

      <div className="permission-center__metrics" aria-label="Permission preview summary">
        <article><strong>{counts.allow}</strong><span>Allowed in preview</span></article>
        <article><strong>{counts.prompt}</strong><span>Prompt on use</span></article>
        <article><strong>{counts.deny}</strong><span>Denied in preview</span></article>
        <article><strong>{SCOPE_LABELS[scope]}</strong><span>Selected scope</span></article>
      </div>

      <section className="permission-center__allow-all" aria-labelledby="permission-allow-all-title">
        <div className="permission-center__allow-all-copy">
          <div className="permission-center__section-heading">
            <div><span className="eyebrow">Explicit preview shortcut</span><h3 id="permission-allow-all-title">Allow all capabilities</h3></div>
            <ShieldAlert size={17} />
          </div>
          <p>Stage every capability as <strong>Allow</strong> for quick UI exploration. This is intentionally visible and reversible; it does not grant native authority.</p>
        </div>
        <div className="permission-center__allow-all-stats" aria-label="Allow all preview summary">
          <span><strong>{PERMISSION_IDS.length}</strong><small>capabilities</small></span>
          <span><strong>{allowAllHighRiskCount}</strong><small>high-risk rows</small></span>
          <span><strong>{isAllowAllActiveEverywhere ? "All" : isAllowAllActive ? "Active" : "Ready"}</strong><small>scope state</small></span>
        </div>
        <div className="permission-center__allow-all-actions" role="toolbar" aria-label="Allow all preview actions">
          <button type="button" className="button button--secondary" onClick={() => applyPreset(allowAllPreset)} aria-pressed={isAllowAllActive}>
            <ShieldAlert size={13} /> Allow all in {SCOPE_LABELS[scope]}
          </button>
          <button type="button" className="button button--ghost" onClick={() => applyPresetToAllScopes(allowAllPreset)} aria-pressed={isAllowAllActiveEverywhere}>
            <ShieldAlert size={13} /> Allow all in every scope
          </button>
          <button type="button" className="button button--ghost" onClick={reset} disabled={valuesEqual(present, DEFAULT_VALUES)}>
            <RotateCcw size={13} /> Reset active scope
          </button>
        </div>
        <p className="permission-center__allow-all-boundary"><LockKeyhole size={13} /> Preview only · renderer-local · no native grant, provider request, OS permission change, or durable policy write.</p>
      </section>

      <section className="permission-center__scope-matrix" aria-labelledby="permission-scope-matrix-title">
        <div className="permission-center__scope-heading">
          <div><span className="eyebrow">Independent renderer drafts</span><h3 id="permission-scope-matrix-title">Scope matrix</h3></div>
          <small>Switching scope keeps its own undo and redo history.</small>
        </div>
        <div className="permission-center__scope-grid" role="list" aria-label="Permission scope drafts">
          {scopeSummaries.map((summary) => (
            <button
              type="button"
              key={summary.scope}
              className={summary.scope === scope ? "permission-scope-card is-active" : "permission-scope-card"}
              aria-pressed={summary.scope === scope}
              onClick={() => {
                setPermissionScope(summary.scope, context);
                setStatus(`${summary.label} selected. Its renderer-local undo history is preserved.`);
              }}
            >
              <span className="permission-scope-card__top"><strong>{summary.label}</strong><em>{summary.scope === scope ? "Editing" : "Draft"}</em></span>
              <span className="permission-scope-card__counts"><span><b>{summary.counts.allow}</b> allow</span><span><b>{summary.counts.prompt}</b> ask</span><span><b>{summary.counts.deny}</b> deny</span></span>
              <small>{summary.undoCount} undo · {summary.redoCount} redo available</small>
            </button>
          ))}
        </div>
      </section>

      <section className="permission-center__expansion-review" aria-labelledby="permission-expansion-review-title">
        <div className="permission-center__scope-heading">
          <div>
            <span className="eyebrow">Review only</span>
            <h3 id="permission-expansion-review-title">Scope-expansion review</h3>
          </div>
          <small>{scopeExpansions.length} proposed increase{scopeExpansions.length === 1 ? "" : "s"} across adjacent drafts</small>
        </div>
        {activeScopeExpansions.length > 0 ? (
          <div className="permission-center__expansion-list" role="list" aria-label={`${SCOPE_LABELS[scope]} permission scope expansions`}>
            {activeScopeExpansions.map((expansion) => {
              const definition = PERMISSION_DEFINITIONS.find((item) => item.id === expansion.permissionId);
              return (
                <div className="permission-expansion-row" key={`${expansion.scope}-${expansion.permissionId}`} role="listitem">
                  <strong>{definition?.label ?? expansion.permissionId}</strong>
                  <span>{SCOPE_LABELS[expansion.parentScope]}: {modeLabel(expansion.parentMode)}</span>
                  <span aria-hidden="true">→</span>
                  <em>{modeLabel(expansion.mode)}</em>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="permission-center__expansion-empty">No more-permissive value is proposed by {SCOPE_LABELS[scope]} compared with its immediate preview parent.</p>
        )}
        <p className="permission-center__expansion-boundary"><LockKeyhole size={13} /> This is a renderer-local review signal, not an effective policy calculation or approval. Native policy must still reject scope widening, expired grants, provider refusal, and OS-denied operations.</p>
      </section>

      <section className="permission-center__history-review" aria-labelledby="permission-history-review-title">
        <div className="permission-center__scope-heading">
          <div>
            <span className="eyebrow">Audit trail preview</span>
            <h3 id="permission-history-review-title"><History size={15} aria-hidden="true" /> Permission history diff</h3>
          </div>
          <small>{historyDiffs.length} renderer revision{historyDiffs.length === 1 ? "" : "s"} · {history.future.length} redo step{history.future.length === 1 ? "" : "s"}</small>
        </div>
        {latestHistoryDiff && latestHistoryDiff.changedCount > 0 ? (
          <>
            <div className="permission-center__history-summary" aria-label="Latest permission history diff summary">
              <span><strong>{latestHistoryDiff.added.length}</strong><small>added</small></span>
              <span><strong>{latestHistoryDiff.removed.length}</strong><small>removed</small></span>
              <span><strong>{latestHistoryDiff.changed.length}</strong><small>mode changes</small></span>
              <span className={latestHistoryDiff.highRiskIncreases.length > 0 ? "is-warning" : ""}><strong>{latestHistoryDiff.highRiskIncreases.length}</strong><small>high-risk increases</small></span>
            </div>
            <div className="permission-center__history-groups" role="list" aria-label="Latest permission history diff">
              {historyDiffGroups.map((group) => (
                <div className={`permission-history-group permission-history-group--${group.tone}`} key={group.label} role="listitem">
                  <h4>{group.label}</h4>
                  <div className="permission-history-group__rows">
                    {group.entries.map((entry) => <PermissionDiffRow entry={entry} key={entry.permissionId} />)}
                  </div>
                </div>
              ))}
            </div>
            {latestHistoryDiff.highRiskIncreases.length > 0 ? (
              <p className="permission-center__history-warning"><ShieldAlert size={14} /> High-risk increases need individual review before any future native promotion. This checkbox-free preview does not confirm a grant or approval.</p>
            ) : null}
          </>
        ) : (
          <p className="permission-center__history-empty"><History size={14} /> No permission changes are recorded for {SCOPE_LABELS[scope]} yet. Undo/redo remains renderer-local.</p>
        )}
        <p className="permission-center__history-boundary"><ArrowRightLeft size={13} /> The diff compares session snapshots only. It does not read native policy, persist an audit record, or authorize execution.</p>
      </section>

      <section className="permission-center__review-queue" aria-labelledby="permission-review-queue-title">
        <div className="permission-center__scope-heading">
          <div>
            <span className="eyebrow">Renderer-session checklist · revision {latestHistoryRevision || "—"}</span>
            <h3 id="permission-review-queue-title"><ShieldAlert size={15} aria-hidden="true" /> Permission review queue</h3>
          </div>
          <small>{pendingReviewEntries.length} pending · {reviewEntries.length} changes in latest revision</small>
        </div>
        <div className="permission-center__review-controls" role="toolbar" aria-label="Permission review queue filters">
          <button type="button" className={reviewFilter === "pending" ? "is-active" : ""} aria-pressed={reviewFilter === "pending"} onClick={() => setReviewFilter("pending")}>Pending review</button>
          <button type="button" className={reviewFilter === "high-risk" ? "is-active" : ""} aria-pressed={reviewFilter === "high-risk"} onClick={() => setReviewFilter("high-risk")}>High risk</button>
          <button type="button" className={reviewFilter === "all" ? "is-active" : ""} aria-pressed={reviewFilter === "all"} onClick={() => setReviewFilter("all")}>All changes</button>
        </div>
        {visibleReviewEntries.length ? (
          <div className="permission-center__review-list" role="list" aria-label="Permission changes to review">
            {visibleReviewEntries.map((entry) => {
              const reviewed = reviewedKeys.has(reviewKey(entry));
              return (
                <article className={`permission-review-row${reviewed ? " is-reviewed" : ""}`} key={reviewKey(entry)} role="listitem">
                  <span className={`permission-review-row__risk permission-risk--${entry.risk}`}>{entry.risk} risk</span>
                  <span className="permission-review-row__copy"><strong>{entry.label}</strong><small>{entry.family} · {modeLabel(entry.before)} → {modeLabel(entry.after)} · {entry.direction}</small></span>
                  <button type="button" className="button button--ghost" aria-pressed={reviewed} aria-label={`${reviewed ? "Reopen" : "Mark reviewed"}: ${entry.label}`} onClick={() => setReviewedKeys((current) => {
                    const next = new Set(current);
                    if (reviewed) next.delete(reviewKey(entry));
                    else next.add(reviewKey(entry));
                    return next;
                  })}>{reviewed ? <><RotateCcw size={13} /> Reopen</> : <><Check size={13} /> Mark reviewed</>}</button>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="permission-center__review-empty">{reviewEntries.length === 0
            ? `No changes to review for ${SCOPE_LABELS[scope]} yet. Edit a permission to create a renderer-session review checklist.`
            : reviewFilter === "high-risk"
              ? "No high-risk changes appear in the latest revision."
              : "Every change in the latest revision has been marked reviewed in this renderer session."}</p>
        )}
        <p className="permission-center__review-boundary"><LockKeyhole size={13} /> Review marks are temporary UI checklist state. They are not approval, a durable audit event, or a native grant; new permission edits replace this queue with the latest revision.</p>
      </section>

      <section className="permission-center__presets" aria-labelledby="permission-presets-title">
        <div className="permission-center__section-heading"><div><span className="eyebrow">Fast starting points</span><h3 id="permission-presets-title">Permission presets</h3></div><LockKeyhole size={17} /></div>
        <div className="permission-center__preset-grid">
          {PRESETS.map((preset) => {
            const isActive = activePreset?.id === preset.id;
            return (
              <article key={preset.id} className={`permission-preset-card permission-preset-card--${preset.tone}${isActive ? " is-active" : ""}`}>
                <button type="button" className={`permission-preset permission-preset--${preset.tone}`} onClick={() => applyPreset(preset)} aria-label={`Apply ${preset.label} preset`} aria-pressed={isActive}>
                  <span><strong>{preset.label}</strong><small>{preset.description}</small></span>
                  <span className="permission-preset__check" aria-hidden="true">{isActive ? <Check size={14} /> : null}</span>
                </button>
                <button type="button" className="permission-preset__all" onClick={() => applyPresetToAllScopes(preset)} aria-label={`Apply ${preset.label} preset to all permission scopes`}>
                  All scopes
                </button>
              </article>
            );
          })}
        </div>
        <p className="permission-center__preset-note"><AlertTriangle size={14} /> <span><strong>{activePreset?.label ?? permissionPresetLabel(present)}</strong> is active for {SCOPE_LABELS[scope]}. Presets and “All scopes” only change renderer-local rows; they never bypass native policy, provider refusal, OS permissions, or the renderer sandbox.</span></p>
      </section>

      <div className="permission-center__toolbar" role="toolbar" aria-label="Permission preview controls">
        <label className="permission-center__search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search capabilities" aria-label="Search permission capabilities" /></label>
        <label><span>Scope</span><select value={scope} onChange={(event) => { setPermissionScope(event.target.value as PermissionScope); setStatus("Permission scope changed in the renderer preview."); }} aria-label="Permission preview scope">{Object.entries(SCOPE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label><span>Family</span><select value={family} onChange={(event) => setFamily(event.target.value as PermissionFamily | "all")} aria-label="Filter permission family">{FAMILY_OPTIONS.map((value) => <option value={value} key={value}>{value === "all" ? "All families" : value}</option>)}</select></label>
        <label><span>Mode</span><select value={modeFilter} onChange={(event) => setModeFilter(event.target.value as PermissionMode | "all")} aria-label="Filter permission mode"><option value="all">All modes</option><option value="allow">Allow</option><option value="prompt">Ask every time</option><option value="deny">Deny</option></select></label>
        <div className="permission-center__history" aria-label="Permission preview history">
          <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo permission preview change"><Undo2 size={14} /></button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo permission preview change"><Redo2 size={14} /></button>
          <button type="button" className="button button--ghost" onClick={reset} disabled={valuesEqual(present, DEFAULT_VALUES)}><RotateCcw size={14} /> Reset</button>
          <button type="button" className="button button--ghost" onClick={resetAll} disabled={allScopesAtDefault}><RotateCcw size={14} /> Reset all</button>
        </div>
      </div>

      <div className="permission-center__list" role="list" aria-label="Permission capabilities">
        {visibleDefinitions.map((definition) => {
          const Icon = definition.icon;
          return <article className="permission-row" key={definition.id} role="listitem">
            <span className="permission-row__icon"><Icon size={16} /></span>
            <span className="permission-row__copy"><strong>{definition.label}</strong><small>{definition.description}</small><span><em>{definition.family}</em><em className={`permission-risk permission-risk--${definition.risk}`}>{definition.risk} risk</em></span></span>
            <label className="permission-row__mode"><span>Mode</span><select value={present[definition.id]} onChange={(event) => updatePermission(definition.id, event.target.value as PermissionMode)} aria-label={`${definition.label} permission mode`}><option value="allow">Allow</option><option value="prompt">Ask every time</option><option value="deny">Deny</option></select></label>
          </article>;
        })}
        {visibleDefinitions.length === 0 ? <div className="permission-center__empty"><Search size={16} /><strong>No matching capabilities</strong><span>Try a different search, family, or mode filter.</span></div> : null}
      </div>

      <div className="permission-center__footer-grid">
        <aside className="permission-center__boundary"><ShieldCheck size={16} /><div><strong>Renderer-local boundary</strong><p>These controls do not grant access, read files, call providers, execute commands, or persist policy. Native approval and fail-closed checks remain planned.</p></div></aside>
        <aside className="permission-center__export"><div><strong>Portable policy preview</strong><p>{isProjectDraft ? "Inspect or move this Project-scoped, session-only policy draft as JSON or Markdown." : "Inspect or move this session-only policy draft as JSON or Markdown."}</p></div><div className="permission-center__export-actions"><label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")} aria-label="Permission preview export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyPreview()}><Copy size={13} /> Copy</button><button type="button" className="button button--ghost" onClick={exportPreview}><Download size={13} /> Download</button><button type="button" className="button button--ghost" onClick={() => importRef.current?.click()}><Upload size={13} /> Import JSON</button><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importPreview(event.target.files?.[0])} aria-label="Import permission preview JSON" /></div><pre aria-label="Permission preview export">{serializedPreview}</pre></aside>
      </div>
      <p className="permission-center__status-line" role="status"><InfoIcon /> {status}</p>
    </section>
  );
}

function InfoIcon() {
  return <span aria-hidden="true" className="permission-center__status-dot" />;
}

function PermissionDiffRow({ entry }: { readonly entry: PermissionDiffEntry }) {
  const DirectionIcon = entry.direction === "increase" ? Plus : entry.direction === "decrease" ? Minus : ArrowRightLeft;
  return (
    <div className="permission-history-row" role="listitem">
      <span className="permission-history-row__icon" aria-hidden="true"><DirectionIcon size={12} /></span>
      <span className="permission-history-row__copy"><strong>{entry.label}</strong><small>{entry.family} · {entry.risk} risk</small></span>
      <span className="permission-history-row__modes"><del>{modeLabel(entry.before)}</del><span aria-hidden="true">→</span><b>{modeLabel(entry.after)}</b></span>
    </div>
  );
}
