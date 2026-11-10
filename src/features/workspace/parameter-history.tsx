import {
  AlertTriangle,
  Check,
  Download,
  FileJson,
  History,
  Redo2,
  RotateCcw,
  Undo2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";

import {
  PARAMETER_SETTINGS_FIELDS,
  PARAMETER_SETTINGS_GROUPS,
  importParameterSettings,
  resetParameterGroup,
  serializeParameterSettings,
  type ParameterSettingsScope,
  type ParameterSettingsGroupId,
  type ParameterSettingKey,
} from "./parameter-settings-contract";
import { useWorkspaceStore } from "./store";
import type { ParameterSettings } from "./types";

const parameterFields = PARAMETER_SETTINGS_FIELDS;
const parameterKeys = parameterFields.map((field) => field.key);
const parameterLabels = Object.fromEntries(
  parameterFields.map((field) => [field.key, field.label]),
) as Record<ParameterSettingKey, string>;

export function ParameterHistoryControls() {
  const parameters = useWorkspaceStore((state) => state.parameters);
  const undoCount = useWorkspaceStore((state) => state.parameterUndoStack.length);
  const redoCount = useWorkspaceStore((state) => state.parameterRedoStack.length);
  const undoParameterChange = useWorkspaceStore((state) => state.undoParameterChange);
  const redoParameterChange = useWorkspaceStore((state) => state.redoParameterChange);
  const resetParameter = useWorkspaceStore((state) => state.resetParameter);
  const resetParameters = useWorkspaceStore((state) => state.resetParameters);
  const replaceParameters = useWorkspaceStore((state) => state.replaceParameters);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [resetKey, setResetKey] = useState<keyof ParameterSettings>("temperature");
  const [resetGroup, setResetGroup] = useState<ParameterSettingsGroupId>("sampling");
  const [exportScope, setExportScope] = useState<ParameterSettingsScope>("chat");
  const [exportName, setExportName] = useState("");
  const [status, setStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const exportParameters = () => {
    const trimmedName = exportName.trim();
    const payload = serializeParameterSettings(parameters, {
      scope: exportScope,
      name: trimmedName || null,
    });
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const fileStem = trimmedName
      ? trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)
      : "settings";
    anchor.download = `omnia-${exportScope}-${fileStem || "settings"}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus({
      tone: "success",
      message: `${exportScope.charAt(0).toUpperCase()}${exportScope.slice(1)} settings exported as JSON${trimmedName ? ` · ${trimmedName}` : ""}.`,
    });
  };

  const importParameters = async (file: File) => {
    try {
      const result = importParameterSettings(await file.text(), parameters);
      if (!result.ok) {
        throw new Error(result.errors.join(" ") || "Settings could not be imported.");
      }
      if (result.changedKeys.length === 0) {
        const warning = result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
        setStatus({ tone: "success", message: `Settings already match the current preview.${warning}` });
        return;
      }
      replaceParameters(result.parameters);
      const warning = result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
      setStatus({
        tone: "success",
        message: `${result.changedKeys.length} settings imported.${warning}`,
      });
    } catch (error) {
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Settings could not be imported.",
      });
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  return (
    <section className="parameter-history-card" data-testid="parameter-history-controls">
      <header className="parameter-history-card__header">
        <div>
          <span className="inspector-section__icon inspector-section__icon--blue">
            <History size={15} />
          </span>
          <span>
            <strong>Parameter history</strong>
            <small>Renderer preview · changes stay reversible</small>
          </span>
        </div>
        <span className="parameter-history-count" aria-label={`${undoCount} undo steps and ${redoCount} redo steps`}>
          {undoCount + redoCount}
        </span>
      </header>

      <div className="parameter-history-export-options">
        <label htmlFor="parameter-export-scope">
          <span>
            <strong>Export scope</strong>
            <small>Choose where this preset is intended to apply</small>
          </span>
          <select
            id="parameter-export-scope"
            value={exportScope}
            onChange={(event) => setExportScope(event.target.value as ParameterSettingsScope)}
          >
            <option value="chat">Chat</option>
            <option value="project">Project</option>
            <option value="profile">Profile</option>
          </select>
        </label>
        <label htmlFor="parameter-export-name">
          <span>
            <strong>Preset name</strong>
            <small>Optional label for the exported JSON file</small>
          </span>
          <input
            id="parameter-export-name"
            aria-label="Preset export name"
            value={exportName}
            onChange={(event) => setExportName(event.target.value)}
            placeholder="e.g. Research balanced"
            maxLength={80}
          />
        </label>
      </div>

      <div className="parameter-history-toolbar" role="group" aria-label="Parameter history actions">
        <button
          type="button"
          className="button button--secondary"
          disabled={undoCount === 0}
          onClick={undoParameterChange}
          title={undoCount === 0 ? "No parameter changes to undo" : "Undo the latest parameter change"}
        >
          <Undo2 size={14} /> Undo
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={redoCount === 0}
          onClick={redoParameterChange}
          title={redoCount === 0 ? "No parameter changes to redo" : "Redo the latest parameter change"}
        >
          <Redo2 size={14} /> Redo
        </button>
        <button type="button" className="button button--secondary" onClick={exportParameters}>
          <Download size={14} /> Export
        </button>
        <button type="button" className="button button--secondary" onClick={() => importInputRef.current?.click()}>
          <Upload size={14} /> Import
        </button>
        <input
          ref={importInputRef}
          className="sr-only"
          type="file"
          accept="application/json,.json"
          aria-label="Import parameter settings JSON"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importParameters(file);
          }}
        />
      </div>

      <div className="parameter-history-reset">
        <label htmlFor="parameter-reset-key">
          <span>
            <strong>Reset one option</strong>
            <small>Restore the selected value to its default</small>
          </span>
          <select
            id="parameter-reset-key"
            value={resetKey}
            onChange={(event) => setResetKey(event.target.value as keyof ParameterSettings)}
          >
            {parameterKeys.map((key) => <option key={key} value={key}>{parameterLabels[key]}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            resetParameter(resetKey);
            setStatus({ tone: "success", message: `${parameterLabels[resetKey]} reset to its default.` });
          }}
        >
          <RotateCcw size={13} /> Reset option
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            resetParameters();
            setStatus({ tone: "success", message: "All parameter overrides reset to defaults." });
          }}
        >
          <RotateCcw size={13} /> Reset all
        </button>
      </div>

      <div className="parameter-history-group-reset">
        <label htmlFor="parameter-reset-group">
          <span>
            <strong>Reset a group</strong>
            <small>Restore every option in the selected group</small>
          </span>
          <select
            id="parameter-reset-group"
            value={resetGroup}
            onChange={(event) => setResetGroup(event.target.value as ParameterSettingsGroupId)}
          >
            {PARAMETER_SETTINGS_GROUPS.map((group) => (
              <option key={group.id} value={group.id}>{group.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            replaceParameters(resetParameterGroup(parameters, resetGroup));
            const groupLabel = PARAMETER_SETTINGS_GROUPS.find((group) => group.id === resetGroup)?.label ?? resetGroup;
            setStatus({ tone: "success", message: `${groupLabel} settings reset to defaults.` });
          }}
        >
          <RotateCcw size={13} /> Reset group
        </button>
      </div>

      {status ? (
        <div className={`parameter-history-status parameter-history-status--${status.tone}`} role={status.tone === "error" ? "alert" : "status"}>
          {status.tone === "error" ? <AlertTriangle size={13} /> : <Check size={13} />}
          <span>{status.message}</span>
        </div>
      ) : (
        <p className="parameter-history-hint"><FileJson size={13} /> Import accepts an Omnia JSON export or a plain parameter object.</p>
      )}
    </section>
  );
}
