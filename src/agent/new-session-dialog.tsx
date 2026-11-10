import { FolderOpen } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import "./new-session-dialog.css";

import { ModalSurface } from "@/components/modal-surface";
import type { ProviderProfileRecord } from "@/lib/desktop";

import { agentApi, errorMessage } from "./agent-api";
import { folderName } from "./format";
import { EffortSelect } from "./effort-select";
import { SystemPromptEditor, toConfig, type PromptChoice } from "./session-settings-dialog";
import { readPrefs, rememberFolder, writePrefs } from "./prefs";
import { PERMISSION_MODES, type CreateSessionInput, type PermissionMode } from "./types";

export function NewSessionDialog({
  onCreate,
  onClose,
}: {
  onCreate: (input: CreateSessionInput) => Promise<void>;
  onClose: () => void;
}) {
  const prefs = readPrefs();
  const [folders, setFolders] = useState<string[]>(prefs.recentFolders);
  const [cwd, setCwd] = useState(prefs.recentFolders[0] ?? "");
  const [profiles, setProfiles] = useState<ProviderProfileRecord[]>([]);
  const [profileId, setProfileId] = useState(prefs.profileId ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(prefs.model ?? "");
  const [mode, setMode] = useState<PermissionMode>((prefs.permissionMode as PermissionMode) ?? "ask_writes");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [fallbackText, setFallbackText] = useState("");
  const [budgetText, setBudgetText] = useState("");
  const [promptMode, setPromptMode] = useState<PromptChoice>("default");
  const [promptText, setPromptText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const listId = useId();
  const folderRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (busy) titleRef.current?.focus();
  }, [busy]);

  useEffect(() => {
    let alive = true;
    agentApi
      .listProfiles()
      .then((list) => {
        if (!alive) return;
        const enabled = list.filter((profile) => profile.enabled);
        setProfiles(enabled);
        setProfileId((current) => (enabled.some((p) => p.id === current) ? current : (enabled[0]?.id ?? "")));
      })
      .catch((cause) => alive && setError(errorMessage(cause)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!profileId) return;
    let alive = true;
    agentApi
      .listModels(profileId)
      .then((list) => alive && setModels(list.map((entry) => entry.id)))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [profileId]);

  const browse = async () => {
    try {
      const picked = await agentApi.pickFolder();
      if (picked) {
        setCwd(picked);
        setFolders(rememberFolder(picked));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const ready = cwd.trim() && profileId && model.trim();

  const submit = async () => {
    if (!ready || submittingRef.current) return;
    const budgetRaw = budgetText.trim();
    const tokenBudget = budgetRaw ? Number(budgetRaw) : null;
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
      setError("Token budget must be a positive whole number.");
      return;
    }
    const fallbackModels = fallbackText.split(",").map((entry) => entry.trim()).filter(Boolean);
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ cwd: cwd.trim(), profileId, model: model.trim(), permissionMode: mode, reasoningEffort, fallbackModels, tokenBudget, systemPrompt: toConfig(promptMode, promptText) });
      rememberFolder(cwd.trim());
      writePrefs({ profileId, model: model.trim(), permissionMode: mode });
      onClose();
    } catch (cause) {
      submittingRef.current = false;
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <ModalSurface
      className="ag-dialog ag-new-session"
      scrimClassName="ag-scrim ag-new-session-scrim"
      titleId={`${listId}-title`}
      initialFocusRef={folderRef}
      onClose={() => { if (!submittingRef.current) onClose(); }}
    >
      <form
        className="ag-new-session__form"
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
            event.preventDefault();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 ref={titleRef} id={`${listId}-title`} tabIndex={-1} className="ag-dialog__title">New session</h2>

        <div className="ag-new-session__body">
        <fieldset className="ag-new-session__fields" disabled={busy} aria-label="Session settings">
        <div className="ag-field">
          <span className="ag-label" id={`${listId}-folder`}>
            Folder
          </span>
          <div className="ag-row">
            <input
              ref={folderRef}
              className="ag-input"
              aria-labelledby={`${listId}-folder`}
              value={cwd}
              placeholder="Choose a folder for the agent to work in"
              onChange={(event) => setCwd(event.target.value)}
            />
            <button type="button" className="ag-btn" onClick={() => void browse()}>
              <FolderOpen size={14} aria-hidden="true" /> Browse
            </button>
          </div>
          {folders.length > 0 ? (
            <ul className="ag-recent" aria-label="Recent folders">
              {folders.slice(0, 4).map((folder) => (
                <li key={folder}>
                  <button type="button" className="ag-link" title={folder} onClick={() => setCwd(folder)}>
                    {folderName(folder)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="ag-field">
          <label className="ag-label" htmlFor={`${listId}-profile`}>
            Provider
          </label>
          <select
            id={`${listId}-profile`}
            className="ag-input"
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
          >
            {profiles.length === 0 ? <option value="">No provider profiles. Add one in Settings.</option> : null}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="ag-field">
          <label className="ag-label" htmlFor={`${listId}-model`}>
            Model
          </label>
          <input
            id={`${listId}-model`}
            className="ag-input"
            list={`${listId}-models`}
            value={model}
            placeholder="Model id"
            onChange={(event) => setModel(event.target.value)}
          />
          <datalist id={`${listId}-models`}>
            {models.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </div>

        <div className="ag-field">
          <label className="ag-label" htmlFor={`${listId}-mode`}>
            Permissions
          </label>
          <select
            id={`${listId}-mode`}
            className="ag-input"
            value={mode}
            onChange={(event) => setMode(event.target.value as PermissionMode)}
          >
            {PERMISSION_MODES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <p className="ag-muted">{PERMISSION_MODES.find((entry) => entry.value === mode)?.description}</p>
        </div>

        <div className="ag-field"><EffortSelect value={reasoningEffort} onChange={setReasoningEffort} disabled={busy} /></div>

        <details className="ag-field" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
          <summary tabIndex={0}>Advanced</summary>
          {advancedOpen ? <>
          <label className="ag-label" htmlFor={`${listId}-fallback`}>
            Fallback models (comma-separated)
          </label>
          <input
            id={`${listId}-fallback`}
            className="ag-input"
            value={fallbackText}
            onChange={(event) => setFallbackText(event.target.value)}
            placeholder="Tried in order if the model is overloaded or unavailable"
            disabled={busy}
          />
          <p className="ag-muted">Same provider only. Switching is always announced in the transcript.</p>
          <label className="ag-label" htmlFor={`${listId}-budget`}>
            Token budget
          </label>
          <input
            id={`${listId}-budget`}
            className="ag-input"
            inputMode="numeric"
            value={budgetText}
            onChange={(event) => setBudgetText(event.target.value)}
            placeholder="Optional: total input + output tokens"
            disabled={busy}
          />
          <SystemPromptEditor
            mode={promptMode}
            text={promptText}
            disabled={busy}
            textareaRows={5}
            onChange={(nextMode, nextText) => {
              setPromptMode(nextMode);
              setPromptText(nextText);
            }}
          />
          </> : null}
        </details>
        </fieldset>

        {error ? (
          <p ref={errorRef} tabIndex={-1} className="ag-error" role="alert">
            {error}
          </p>
        ) : null}
        </div>

        <div className="ag-dialog__actions">
          <button type="button" className="ag-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ag-btn ag-btn--primary" disabled={!ready || busy}>
            Create session
          </button>
        </div>
      </form>
    </ModalSurface>
  );
}
