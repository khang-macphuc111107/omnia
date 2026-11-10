import { useEffect, useId, useState } from "react";

import "./session-settings-dialog.css";

import { ModalSurface } from "@/components/modal-surface";

import { agentApi, errorMessage } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { PermissionRulesManager } from "./permission-rules";
import type { AgentSessionSummary, PromptPreset, SystemPromptConfig, SystemPromptMode } from "./types";

export type PromptChoice = "default" | SystemPromptMode;

export const toConfig = (mode: PromptChoice, text: string): SystemPromptConfig | null =>
  mode === "default" || !text.trim() ? null : { mode, text };

/** Mode, text, preset picker and "save as preset": shared by the new-session and session-settings dialogs. */
export function SystemPromptEditor({
  mode,
  text,
  onChange,
  disabled,
  textareaRows = 8,
}: {
  mode: PromptChoice;
  text: string;
  onChange: (mode: PromptChoice, text: string) => void;
  disabled?: boolean;
  textareaRows?: number;
}) {
  const id = useId();
  const [presets, setPresets] = useState<PromptPreset[]>([]);
  const [presetId, setPresetId] = useState("");
  const [naming, setNaming] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    agentApi
      .promptPresets()
      .then((list) => alive && setPresets(list))
      .catch(() => alive && setPresets([]));
    return () => {
      alive = false;
    };
  }, []);

  const load = (value: string) => {
    setPresetId(value);
    const preset = presets.find((entry) => entry.id === value);
    if (preset) onChange(preset.mode, preset.text);
  };

  const savePreset = async () => {
    const config = toConfig(mode, text);
    const name = presetName.trim();
    if (!config || !name) return;
    setError(null);
    try {
      const existing = presets.find((entry) => entry.name === name);
      const list = await agentApi.savePromptPreset({ id: existing?.id, name, ...config });
      setPresets(list);
      setPresetId(list.find((entry) => entry.name === name)?.id ?? "");
      setNaming(false);
      setPresetName("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const removePreset = async () => {
    if (!presetId) return;
    setError(null);
    try {
      setPresets(await agentApi.deletePromptPreset(presetId));
      setPresetId("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <div className="ag-field ag-system-prompt-editor">
      <label className="ag-label" htmlFor={`${id}-mode`}>
        System prompt
      </label>
      <select
        id={`${id}-mode`}
        className="ag-input"
        value={mode}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as PromptChoice, text)}
      >
        <option value="default">Default</option>
        <option value="append">Append to default</option>
        <option value="replace">Replace default</option>
      </select>
      {mode !== "default" ? (
        <textarea
          className="ag-input"
          aria-label="System prompt text"
          rows={textareaRows}
          value={text}
          disabled={disabled}
          placeholder={mode === "replace" ? "Used instead of the built-in prompt" : "Added after the built-in prompt"}
          onChange={(event) => onChange(mode, event.target.value)}
        />
      ) : null}
      <p className="ag-muted">
        Default is the built-in prompt, plus <code>.omnia/system-prompt.md</code> in the project folder if it exists
        (appended). Append or Replace here overrides that file. Plan-mode, memory and skills notes are always added.
      </p>
      <div className="ag-row">
        <select
          className="ag-input"
          aria-label="Prompt preset"
          value={presetId}
          disabled={disabled || presets.length === 0}
          onChange={(event) => load(event.target.value)}
        >
          <option value="">{presets.length === 0 ? "No saved presets" : "Load preset…"}</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
        {presetId ? (
          <button type="button" className="ag-btn" disabled={disabled} onClick={() => void removePreset()}>
            Delete preset
          </button>
        ) : null}
        <button
          type="button"
          className="ag-btn"
          disabled={disabled || !toConfig(mode, text)}
          onClick={() => setNaming((open) => !open)}
        >
          Save as preset
        </button>
      </div>
      {naming ? (
        <div className="ag-row">
          <input
            className="ag-input"
            aria-label="Preset name"
            value={presetName}
            placeholder="Preset name"
            onChange={(event) => setPresetName(event.target.value)}
          />
          <button type="button" className="ag-btn" disabled={!presetName.trim()} onClick={() => void savePreset()}>
            Save preset
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="ag-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SessionSettingsDialog({ session, onClose }: { session: AgentSessionSummary; onClose: () => void }) {
  const id = useId();
  // The form's draft belongs to the snapshot opened here. A live metadata
  // refresh must not silently rebase these fields onto somebody else's edit.
  const [expectedSettingsRevision] = useState(session.settingsRevision);
  const [mode, setMode] = useState<PromptChoice>(session.systemPrompt?.mode ?? "default");
  const [text, setText] = useState(session.systemPrompt?.text ?? "");
  const [fallbackText, setFallbackText] = useState((session.fallbackModels ?? []).join(", "));
  const [budgetText, setBudgetText] = useState(session.tokenBudget ? String(session.tokenBudget) : "");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const budgetRaw = budgetText.trim();
    const tokenBudget = budgetRaw ? Number(budgetRaw) : null;
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
      setError("Token budget must be a positive whole number.");
      return;
    }
    const fallbackModels = fallbackText.split(",").map((entry) => entry.trim()).filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      await useAgentStore.getState().updateSettings(session.id, {
        ...(expectedSettingsRevision === undefined ? {} : { expectedSettingsRevision }),
        systemPrompt: toConfig(mode, text),
        fallbackModels,
        tokenBudget,
      });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  const showPreview = async () => {
    setError(null);
    try {
      setPreview(await agentApi.previewSystemPrompt(session.id));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <ModalSurface
      className="ag-dialog ag-session-settings"
      scrimClassName="ag-scrim ag-session-settings-scrim"
      titleId={`${id}-title`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-title`} className="ag-dialog__title">Session settings</h2>

        <SystemPromptEditor
          mode={mode}
          text={text}
          disabled={busy}
          onChange={(nextMode, nextText) => {
            setMode(nextMode);
            setText(nextText);
          }}
        />

        <div className="ag-field">
          <button type="button" className="ag-btn" onClick={() => void showPreview()}>
            Preview full prompt
          </button>
          {preview !== null ? (
            <pre className="ag-pre" aria-label="Full system prompt" tabIndex={0}>
              {preview}
            </pre>
          ) : (
            <p className="ag-muted">The preview shows the saved settings; save changes first to see them.</p>
          )}
        </div>

        <div className="ag-field">
          <label className="ag-label" htmlFor={`${id}-fallback`}>
            Fallback models (comma-separated)
          </label>
          <input
            id={`${id}-fallback`}
            className="ag-input"
            value={fallbackText}
            disabled={busy}
            placeholder="Tried in order if the model is overloaded or unavailable"
            onChange={(event) => setFallbackText(event.target.value)}
          />
        </div>

        <div className="ag-field">
          <label className="ag-label" htmlFor={`${id}-budget`}>
            Token budget
          </label>
          <input
            id={`${id}-budget`}
            className="ag-input"
            inputMode="numeric"
            value={budgetText}
            disabled={busy}
            placeholder="Optional: total input + output tokens"
            onChange={(event) => setBudgetText(event.target.value)}
          />
          <p className="ag-muted">Used so far: {(session.tokensUsed ?? 0).toLocaleString("en-US")} tokens</p>
        </div>

        <div className="ag-field">
          <h3 className="ag-subtitle">Permission rules</h3>
          <PermissionRulesManager sessionId={session.id} cwd={session.cwd} scopes={["session", "project", "global"]} />
        </div>

        {error ? (
          <p className="ag-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="ag-dialog__actions">
          <button type="button" className="ag-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ag-btn ag-btn--primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </ModalSurface>
  );
}
