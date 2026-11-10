import { ChevronDown, CircleAlert, Copy, LockKeyhole, RotateCcw, Route, ShieldCheck, Undo2, Redo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { selectableModelProfiles } from "./provider-catalog";
import {
  ROLE_ROUTING_EFFORTS,
  ROLE_ROUTING_PRECEDENCE,
  ROLE_ROUTING_ROLES,
  availableRoleRouteIds,
  cloneRoleRoutingState,
  createDefaultRoleRoutingState,
  roleRouteReadiness,
  serializeRoleRoutingPreview,
  type RoleRouteChoice,
  type RoleRoutingMode,
  type RoleRoutingRoleId,
  type RoleRoutingState,
} from "./role-routing-preview-contract";
import type { ProviderView } from "./types";

type RoleRoutingHistory = {
  past: RoleRoutingState[];
  present: RoleRoutingState;
  future: RoleRoutingState[];
};

function initialRoleRoutingState(modelProfileId: string, availableIds: ReadonlySet<string>): RoleRoutingState {
  const defaults = createDefaultRoleRoutingState();
  if (modelProfileId !== "auto" && availableIds.has(modelProfileId)) {
    return { ...defaults, main: { ...defaults.main, mode: "explicit", modelProfileId } };
  }
  return defaults;
}

function readinessLabel(readiness: ReturnType<typeof roleRouteReadiness>): string {
  if (readiness === "auto") return "Inherited automatic route";
  if (readiness === "ready") return "Preview route is available";
  if (readiness === "needs-candidates") return "Choose at least one candidate";
  return "Selected route is unavailable";
}

export function RoleRoutingPreview({
  providers,
  modelProfileId,
  onModelProfileChange,
}: {
  readonly providers: ProviderView[];
  readonly modelProfileId: string;
  readonly onModelProfileChange: (profileId: string) => void;
}) {
  const profiles = useMemo(() => selectableModelProfiles(providers), [providers]);
  const availableIds = useMemo(
    () => new Set(availableRoleRouteIds(profiles, new Set(providers.filter((provider) => provider.enabled && provider.state === "connected").map((provider) => provider.id)))),
    [profiles, providers],
  );
  const modelOptions = useMemo(() => profiles.filter((profile) => profile.id !== "auto"), [profiles]);
  const initial = useMemo(() => initialRoleRoutingState(modelProfileId, availableIds), [availableIds, modelProfileId]);
  const [history, setHistory] = useState<RoleRoutingHistory>(() => ({ past: [], present: initial, future: [] }));
  const [status, setStatus] = useState("Role assignments stay in this renderer preview.");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // A main-role pool is itself a deliberate override. The shared model
    // selector falls back to `auto` as its summary value, but must not erase
    // that role-local pool when the parent echoes the value back.
    if (history.present.main.mode === "pool" && modelProfileId === "auto") return;
    const nextMain: RoleRouteChoice = modelProfileId === "auto"
      ? { ...history.present.main, mode: "auto", modelProfileId: null, candidateProfileIds: [] }
      : { ...history.present.main, mode: "explicit", modelProfileId, candidateProfileIds: [] };
    const current = history.present.main;
    if (current.mode === nextMain.mode && current.modelProfileId === nextMain.modelProfileId && current.candidateProfileIds.length === nextMain.candidateProfileIds.length) return;
    setHistory((currentHistory) => ({
      ...currentHistory,
      present: { ...currentHistory.present, main: nextMain },
    }));
  }, [modelProfileId]);

  const updateRole = (roleId: RoleRoutingRoleId, patch: Partial<RoleRouteChoice>, message = "Role routing changed in the renderer preview.") => {
    setHistory((current) => {
      const next = cloneRoleRoutingState(current.present);
      const currentRoute = next[roleId];
      const updatedRoute: RoleRouteChoice = { ...currentRoute, ...patch };
      return { past: [...current.past, cloneRoleRoutingState(current.present)], present: { ...next, [roleId]: updatedRoute }, future: [] };
    });
    setStatus(message);
  };

  const changeMode = (roleId: RoleRoutingRoleId, mode: RoleRoutingMode) => {
    const firstAvailable = [...availableIds][0] ?? null;
    const patch: Partial<RoleRouteChoice> = mode === "auto"
      ? { mode, modelProfileId: null, candidateProfileIds: [] }
      : mode === "explicit"
        ? { mode, modelProfileId: availableIds.has(modelProfileId) ? modelProfileId : firstAvailable, candidateProfileIds: [] }
        : { mode, modelProfileId: null, candidateProfileIds: firstAvailable ? [firstAvailable] : [] };
    updateRole(roleId, patch, `${ROLE_ROUTING_ROLES.find((role) => role.id === roleId)?.label ?? roleId} route changed in the renderer preview.`);
    if (roleId === "main") {
      onModelProfileChange(mode === "explicit" ? (patch.modelProfileId ?? "auto") : "auto");
    }
  };

  const changeExplicitModel = (roleId: RoleRoutingRoleId, nextModelProfileId: string) => {
    updateRole(roleId, { mode: "explicit", modelProfileId: nextModelProfileId, candidateProfileIds: [] });
    if (roleId === "main") onModelProfileChange(nextModelProfileId);
  };

  const togglePoolCandidate = (roleId: RoleRoutingRoleId, candidateId: string) => {
    const route = history.present[roleId];
    const candidateProfileIds = route.candidateProfileIds.includes(candidateId)
      ? route.candidateProfileIds.filter((id) => id !== candidateId)
      : [...route.candidateProfileIds, candidateId];
    updateRole(roleId, { mode: "pool", modelProfileId: null, candidateProfileIds });
    if (roleId === "main") onModelProfileChange("auto");
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: cloneRoleRoutingState(previous), future: [cloneRoleRoutingState(current.present), ...current.future] };
    });
    setStatus("Undid the last role routing preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, cloneRoleRoutingState(current.present)], present: cloneRoleRoutingState(next), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next role routing preview change.");
  };

  const reset = () => {
    setHistory((current) => ({ past: [...current.past, cloneRoleRoutingState(current.present)], present: createDefaultRoleRoutingState(), future: [] }));
    onModelProfileChange("auto");
    setStatus("Role routing preview reset to automatic defaults.");
  };

  const copyPreview = async () => {
    const payload = serializeRoleRoutingPreview(history.present, profiles);
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; no role routing preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setStatus("Copied the renderer-local role routing preview.");
    } catch {
      setStatus("Clipboard access was denied; no role routing preview was copied.");
    }
  };

  return (
    <section className="role-routing-preview" aria-labelledby="role-routing-preview-title">
      <header className="role-routing-preview__header">
        <span className="role-routing-preview__icon"><Route size={16} /></span>
        <span><span className="eyebrow">Renderer-local policy</span><h3 id="role-routing-preview-title">Role routing assignments</h3><p>Preview which model, pool, and effort each bounded role would inherit before a task is dispatched.</p></span>
        <span className="role-routing-preview__badge"><CircleAlert size={12} /> Preview only</span>
      </header>

      <div className="role-routing-preview__precedence" aria-label="Role routing precedence">
        <span><strong>Precedence</strong><small>Higher-priority request and task choices can override this role default.</small></span>
        <ol>{ROLE_ROUTING_PRECEDENCE.map((item) => <li key={item}>{item}</li>)}</ol>
      </div>

      <div className="role-routing-preview__history" role="toolbar" aria-label="Role routing preview history">
        <span><strong>Reversible role policy draft</strong><small>{status}</small></span>
        <span className="role-routing-preview__history-count">{history.past.length + history.future.length} steps</span>
        <span className="role-routing-preview__history-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length} aria-label="Undo role routing change"><Undo2 size={12} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length} aria-label="Redo role routing change"><Redo2 size={12} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset role routing preview"><RotateCcw size={12} /> Reset</button>
        </span>
      </div>

      <div className="role-routing-preview__roles" role="list" aria-label="Role route overrides">
        {ROLE_ROUTING_ROLES.map((role) => {
          const route = history.present[role.id];
          const readiness = roleRouteReadiness(route, availableIds);
          return (
            <article key={role.id} className={`role-routing-preview__role role-routing-preview__role--${readiness}`} role="listitem">
              <div className="role-routing-preview__role-heading">
                <div><strong>{role.label}</strong><small>{role.description}</small></div>
                <span className="role-routing-preview__readiness"><span aria-hidden="true" className="role-routing-preview__readiness-dot" />{readinessLabel(readiness)}</span>
              </div>
              <div className="role-routing-preview__role-controls">
                <label><span>Mode</span><select value={route.mode} onChange={(event) => changeMode(role.id, event.target.value as RoleRoutingMode)} aria-label={`${role.label} routing mode`}><option value="auto">Auto</option><option value="explicit">Explicit model</option><option value="pool">Candidate pool</option></select></label>
                {route.mode === "explicit" ? (
                  <label><span>Model</span><select value={route.modelProfileId ?? ""} onChange={(event) => changeExplicitModel(role.id, event.target.value)} aria-label={`${role.label} model route`}><option value="">Select model</option>{modelOptions.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}{profile.status !== "available" ? ` · ${profile.status}` : ""}</option>)}</select></label>
                ) : route.mode === "pool" ? (
                  <fieldset><legend>Candidate pool</legend>{modelOptions.map((profile) => <label key={profile.id}><input type="checkbox" checked={route.candidateProfileIds.includes(profile.id)} onChange={() => togglePoolCandidate(role.id, profile.id)} disabled={!availableIds.has(profile.id)} /> <span>{profile.displayName}</span></label>)}{modelOptions.length === 0 ? <small>No model candidates are reported.</small> : null}</fieldset>
                ) : <div className="role-routing-preview__inherited"><ChevronDown size={13} /> Uses the automatic route selected above.</div>}
                <label><span>Effort</span><select value={route.effort} onChange={(event) => updateRole(role.id, { effort: event.target.value as RoleRouteChoice["effort"] })} aria-label={`${role.label} effort`} >{ROLE_ROUTING_EFFORTS.map((effort) => <option key={effort.value} value={effort.value}>{effort.label}</option>)}</select></label>
              </div>
            </article>
          );
        })}
      </div>

      <div className="role-routing-preview__export">
        <span><strong>Portable role override preview</strong><small>Copy the visible role map for review. It contains no credentials, grants, agent instances, or native writes.</small></span>
        <button type="button" className="button button--secondary" onClick={() => void copyPreview()}><Copy size={13} /> {copied ? "Copied" : "Copy JSON"}</button>
      </div>
      <p className="role-routing-preview__boundary"><LockKeyhole size={13} /> Renderer-only role overrides. They do not create a route decision, provider request, approval receipt, sandbox, secret lookup, or durable policy.</p>
      <p className="role-routing-preview__availability"><ShieldCheck size={13} /> {availableIds.size} connected, available model route{availableIds.size === 1 ? "" : "s"} reported; unavailable candidates remain blocked.</p>
    </section>
  );
}

export default RoleRoutingPreview;
