import {
  Check,
  Copy,
  Grid2X2,
  LockKeyhole,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  DEFAULT_PERMISSION_VALUES,
  PERMISSION_DEFINITIONS,
  PERMISSION_FAMILY_OPTIONS,
  PERMISSION_PRESETS,
  PERMISSION_SCOPES,
  PERMISSION_SCOPE_LABELS,
  permissionValuesEqual,
  projectPermissionDraftContext,
  replacePermissionValues,
  replacePermissionValuesForAllScopes,
  resetAllPermissionPreviews,
  setPermissionScope,
  usePermissionSession,
  type PermissionFamily,
  type PermissionId,
  type PermissionMode,
  type PermissionScope,
} from "./session-permission-contract";

const MODE_OPTIONS: readonly { readonly value: PermissionMode; readonly label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "prompt", label: "Ask every time" },
  { value: "deny", label: "Deny" },
] as const;

function modeClass(mode: PermissionMode): string {
  return `permission-matrix-studio__mode permission-matrix-studio__mode--${mode}`;
}

function valuesDifferAcrossScopes(permissionId: PermissionId, valuesByScope: Readonly<Record<PermissionScope, Record<PermissionId, PermissionMode>>>): boolean {
  const first = valuesByScope[PERMISSION_SCOPES[0]!][permissionId];
  return PERMISSION_SCOPES.some((scope) => valuesByScope[scope][permissionId] !== first);
}

export function PermissionMatrixStudio({ projectId }: { readonly projectId?: string | null | undefined }) {
  const context = projectPermissionDraftContext(projectId);
  const history = usePermissionSession(context);
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState<PermissionFamily | "all">("all");
  const [highRiskOnly, setHighRiskOnly] = useState(false);
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [status, setStatus] = useState("Matrix ready. Every cell is a renderer-local draft.");

  const visibleDefinitions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return PERMISSION_DEFINITIONS.filter((definition) => {
      const matchesQuery = !normalizedQuery || `${definition.label} ${definition.family} ${definition.description}`.toLowerCase().includes(normalizedQuery);
      const matchesFamily = family === "all" || definition.family === family;
      const matchesRisk = !highRiskOnly || definition.risk === "high";
      const matchesDifferences = !differencesOnly || valuesDifferAcrossScopes(definition.id, history.valuesByScope);
      return matchesQuery && matchesFamily && matchesRisk && matchesDifferences;
    });
  }, [differencesOnly, family, highRiskOnly, history.valuesByScope, query]);

  const metrics = useMemo(() => {
    const customCells = PERMISSION_SCOPES.reduce((total, scope) => total + PERMISSION_DEFINITIONS.filter((definition) => history.valuesByScope[scope][definition.id] !== DEFAULT_PERMISSION_VALUES[definition.id]).length, 0);
    const highRiskAllows = PERMISSION_SCOPES.reduce((total, scope) => total + PERMISSION_DEFINITIONS.filter((definition) => definition.risk === "high" && history.valuesByScope[scope][definition.id] === "allow").length, 0);
    const splitRows = PERMISSION_DEFINITIONS.filter((definition) => valuesDifferAcrossScopes(definition.id, history.valuesByScope)).length;
    return { customCells, highRiskAllows, splitRows };
  }, [history.valuesByScope]);

  const activeScope = history.activeScope;
  const activePreset = PERMISSION_PRESETS.find((preset) => permissionValuesEqual(preset.values, history.valuesByScope[activeScope]));

  const updateCell = (scope: PermissionScope, permissionId: PermissionId, mode: PermissionMode) => {
    const values = history.valuesByScope[scope];
    replacePermissionValues({ ...values, [permissionId]: mode }, scope, context);
    setStatus(`${PERMISSION_SCOPE_LABELS[scope]} · ${permissionId} set to ${mode}. Renderer-local preview only.`);
  };

  const selectScope = (scope: PermissionScope) => {
    setPermissionScope(scope, context);
    setStatus(`${PERMISSION_SCOPE_LABELS[scope]} selected. Its undo/redo history remains isolated.`);
  };

  const applyPresetEverywhere = (presetId: string) => {
    const preset = PERMISSION_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    replacePermissionValuesForAllScopes(preset.values, context);
    setStatus(`${preset.label} applied to every scope as a renderer-only matrix draft.`);
  };

  const copyActiveScope = () => {
    replacePermissionValuesForAllScopes(history.valuesByScope[activeScope], context);
    setStatus(`${PERMISSION_SCOPE_LABELS[activeScope]} copied to every scope. Native permissions remain unchanged.`);
  };

  const resetAll = () => {
    resetAllPermissionPreviews(context);
    setStatus("Every matrix cell reset to balanced defaults in this renderer session.");
  };

  return (
    <section className="permission-matrix-studio" aria-labelledby="permission-matrix-studio-title">
      <header className="permission-matrix-studio__header">
        <span className="permission-matrix-studio__icon"><Grid2X2 size={18} /></span>
        <div>
          <span className="eyebrow">Cross-scope preview</span>
          <h2 id="permission-matrix-studio-title">Permission Matrix Studio</h2>
          <p>Compare and shape capability modes across session, chat, project, and workspace drafts in one view.</p>
        </div>
        <span className="permission-matrix-studio__status"><ShieldCheck size={13} /> Renderer-local</span>
      </header>

      <div className="permission-matrix-studio__metrics" aria-label="Permission matrix summary">
        <article><strong>{visibleDefinitions.length}/{PERMISSION_DEFINITIONS.length}</strong><span>Rows visible</span></article>
        <article><strong>{metrics.splitRows}</strong><span>Split rows</span></article>
        <article><strong>{metrics.customCells}</strong><span>Non-default cells</span></article>
        <article><strong>{metrics.highRiskAllows}</strong><span>High-risk allows</span></article>
      </div>

      <section className="permission-matrix-studio__actions" aria-labelledby="permission-matrix-actions-title">
        <div className="permission-matrix-studio__section-heading">
          <div><span className="eyebrow">Matrix actions</span><h3 id="permission-matrix-actions-title">Stage a starting shape</h3></div>
          <SlidersHorizontal size={16} />
        </div>
        <div className="permission-matrix-studio__preset-row">
          {PERMISSION_PRESETS.map((preset) => (
            <button type="button" className={`button button--ghost permission-matrix-studio__preset permission-matrix-studio__preset--${preset.tone}`} key={preset.id} onClick={() => applyPresetEverywhere(preset.id)}>
              {activePreset?.id === preset.id ? <Check size={13} /> : <ShieldAlert size={13} />}
              Apply {preset.label} to every scope
            </button>
          ))}
          <button type="button" className="button button--secondary" onClick={copyActiveScope} aria-label={`Copy ${PERMISSION_SCOPE_LABELS[activeScope]} to all scopes`}>
            <Copy size={13} /> Copy {PERMISSION_SCOPE_LABELS[activeScope]} to all
          </button>
          <button type="button" className="button button--ghost" onClick={resetAll} disabled={metrics.customCells === 0}>
            <RotateCcw size={13} /> Reset matrix
          </button>
        </div>
        <p className="permission-matrix-studio__boundary"><LockKeyhole size={13} /> These actions update renderer-local preview rows in this session only. They do not grant native authority, call a provider, change OS permissions, or persist policy.</p>
      </section>

      <div className="permission-matrix-studio__toolbar" role="toolbar" aria-label="Permission matrix filters">
        <label className="permission-matrix-studio__search"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Capability, family, description" aria-label="Search permission matrix" /></label>
        <label><span>Family</span><select value={family} onChange={(event) => setFamily(event.target.value as PermissionFamily | "all")} aria-label="Filter matrix family">{PERMISSION_FAMILY_OPTIONS.map((option) => <option value={option} key={option}>{option === "all" ? "All families" : option}</option>)}</select></label>
        <label className="permission-matrix-studio__check"><input type="checkbox" checked={highRiskOnly} onChange={(event) => setHighRiskOnly(event.target.checked)} aria-label="High-risk only" /><span>High-risk only</span></label>
        <label className="permission-matrix-studio__check"><input type="checkbox" checked={differencesOnly} onChange={(event) => setDifferencesOnly(event.target.checked)} aria-label="Only show differences" /><span>Only show differences</span></label>
      </div>

      <div className="permission-matrix-studio__table-wrap">
        <div className="permission-matrix-studio__table" role="table" aria-label="Permission scope matrix">
          <div className="permission-matrix-studio__row permission-matrix-studio__row--header" role="row">
            <div className="permission-matrix-studio__capability-head" role="columnheader">Capability</div>
            {PERMISSION_SCOPES.map((scope) => {
              const counts = { allow: 0, prompt: 0, deny: 0 };
              PERMISSION_DEFINITIONS.forEach((definition) => { counts[history.valuesByScope[scope][definition.id]] += 1; });
              return <button type="button" className={scope === activeScope ? "permission-matrix-studio__scope-head is-active" : "permission-matrix-studio__scope-head"} aria-label={`Select ${PERMISSION_SCOPE_LABELS[scope]} permission scope`} aria-pressed={scope === activeScope} key={scope} onClick={() => selectScope(scope)}><strong>{PERMISSION_SCOPE_LABELS[scope]}</strong><small>{counts.allow} allow · {counts.prompt} ask · {counts.deny} deny</small></button>;
            })}
          </div>
          {visibleDefinitions.map((definition) => {
            const Icon = definition.icon;
            const split = valuesDifferAcrossScopes(definition.id, history.valuesByScope);
            return <div className={split ? "permission-matrix-studio__row is-split" : "permission-matrix-studio__row"} role="row" key={definition.id}>
              <div className="permission-matrix-studio__capability" role="rowheader">
                <span className="permission-matrix-studio__capability-icon"><Icon size={14} /></span>
                <span><strong>{definition.label}</strong><small>{definition.family} · {definition.risk} risk</small></span>
              </div>
              {PERMISSION_SCOPES.map((scope) => <label className={`permission-matrix-studio__cell ${modeClass(history.valuesByScope[scope][definition.id])}`} key={scope} role="cell">
                <span className="sr-only">{PERMISSION_SCOPE_LABELS[scope]}</span>
                <select value={history.valuesByScope[scope][definition.id]} onChange={(event) => updateCell(scope, definition.id, event.target.value as PermissionMode)} aria-label={`${definition.label} in ${PERMISSION_SCOPE_LABELS[scope]}`}>
                  {MODE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                </select>
              </label>)}
            </div>;
          })}
        </div>
        {!visibleDefinitions.length ? <div className="permission-matrix-studio__empty"><Grid2X2 size={20} /><strong>No matrix rows match these filters.</strong><span>Clear search or turn off the difference/high-risk filters.</span></div> : null}
      </div>

      <p className="permission-matrix-studio__status-line" role="status"><span aria-hidden="true" />{status}</p>
      <p className="permission-matrix-studio__footer"><LockKeyhole size={13} /> Active scope: <strong>{PERMISSION_SCOPE_LABELS[activeScope]}</strong>. Matrix edits are reversible through the Permission Control Center undo/redo history; native runtime status is not asserted here.</p>
    </section>
  );
}
