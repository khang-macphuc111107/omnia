import { Redo2, RotateCcw, SlidersHorizontal, Undo2, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { ComposerMode } from "./types";

type ModeControlValue = string | boolean;
type ModeControlValues = Record<string, ModeControlValue>;

interface ModeControlDefinition {
  id: string;
  label: string;
  description: string;
  kind: "select" | "toggle";
  options?: readonly { value: string; label: string }[];
}

interface ModeDefinition {
  label: string;
  eyebrow: string;
  summary: string;
  controls: readonly ModeControlDefinition[];
  defaults: ModeControlValues;
}

const MODE_DEFINITIONS: Record<ComposerMode, ModeDefinition> = {
  ask: {
    label: "Ask",
    eyebrow: "Conversation preset",
    summary: "Shape the answer without changing the prompt or dispatch path.",
    controls: [
      {
        id: "answerStyle",
        label: "Answer style",
        description: "How much explanation the preview should aim for.",
        kind: "select",
        options: [
          { value: "balanced", label: "Balanced" },
          { value: "concise", label: "Concise" },
          { value: "deep", label: "Deep explanation" },
        ],
      },
      {
        id: "responseFormat",
        label: "Response format",
        description: "A presentation hint for the answer surface.",
        kind: "select",
        options: [
          { value: "markdown", label: "Markdown" },
          { value: "plain", label: "Plain text" },
          { value: "structured", label: "Structured outline" },
        ],
      },
      {
        id: "grounding",
        label: "Grounding cue",
        description: "Whether available context should be called out in the preview.",
        kind: "select",
        options: [
          { value: "available", label: "Use available context" },
          { value: "explicit", label: "Call out evidence" },
          { value: "minimal", label: "Keep it lightweight" },
        ],
      },
      {
        id: "directAnswer",
        label: "Lead with the answer",
        description: "Keep the first paragraph outcome-focused.",
        kind: "toggle",
      },
    ],
    defaults: {
      answerStyle: "balanced",
      responseFormat: "markdown",
      grounding: "available",
      directAnswer: true,
    },
  },
  create: {
    label: "Create",
    eyebrow: "Drafting preset",
    summary: "Choose an artifact direction before a native creation flow exists.",
    controls: [
      {
        id: "artifactType",
        label: "Artifact direction",
        description: "The kind of draft the preview is preparing.",
        kind: "select",
        options: [
          { value: "plan", label: "Plan / checklist" },
          { value: "document", label: "Document / brief" },
          { value: "code", label: "Code / implementation" },
          { value: "presentation", label: "Slides / presentation" },
        ],
      },
      {
        id: "draftFlow",
        label: "Draft flow",
        description: "How much structure to shape before the full draft.",
        kind: "select",
        options: [
          { value: "outline-first", label: "Outline first" },
          { value: "first-draft", label: "Jump to first draft" },
          { value: "options", label: "Show multiple directions" },
        ],
      },
      {
        id: "outputFormat",
        label: "Output format",
        description: "The renderer preview format for the draft.",
        kind: "select",
        options: [
          { value: "markdown", label: "Markdown" },
          { value: "rich", label: "Rich document" },
          { value: "json", label: "Structured JSON" },
        ],
      },
      {
        id: "editableDraft",
        label: "Keep as editable draft",
        description: "A native artifact is not created by this preview.",
        kind: "toggle",
      },
    ],
    defaults: {
      artifactType: "document",
      draftFlow: "outline-first",
      outputFormat: "markdown",
      editableDraft: true,
    },
  },
  research: {
    label: "Research",
    eyebrow: "Evidence preset",
    summary: "Set the research depth and how uncertainty should be surfaced.",
    controls: [
      {
        id: "researchDepth",
        label: "Research depth",
        description: "How broad the renderer plan should be.",
        kind: "select",
        options: [
          { value: "quick", label: "Quick scan" },
          { value: "focused", label: "Focused review" },
          { value: "deep", label: "Deep investigation" },
          { value: "comparative", label: "Comparative study" },
        ],
      },
      {
        id: "evidenceStyle",
        label: "Evidence style",
        description: "How the preview should organize claims and sources.",
        kind: "select",
        options: [
          { value: "inline", label: "Inline notes" },
          { value: "ledger", label: "Evidence ledger" },
          { value: "brief", label: "Source-backed brief" },
        ],
      },
      {
        id: "sourceHandling",
        label: "Source handling",
        description: "A cue for the eventual retrieval and review path.",
        kind: "select",
        options: [
          { value: "existing", label: "Use supplied sources" },
          { value: "discover", label: "Discover candidates" },
          { value: "compare", label: "Compare source coverage" },
        ],
      },
      {
        id: "flagUnknowns",
        label: "Flag unknowns and conflicts",
        description: "Keep unresolved claims visible in the preview.",
        kind: "toggle",
      },
    ],
    defaults: {
      researchDepth: "focused",
      evidenceStyle: "ledger",
      sourceHandling: "existing",
      flagUnknowns: true,
    },
  },
  discuss: {
    label: "Discuss",
    eyebrow: "Multi-perspective preset",
    summary: "Stage a bounded debate and synthesis plan before native agent orchestration is connected.",
    controls: [
      {
        id: "rounds",
        label: "Discussion rounds",
        description: "How many perspective passes the preview should stage.",
        kind: "select",
        options: [
          { value: "2", label: "2 rounds" },
          { value: "3", label: "3 rounds" },
          { value: "4", label: "4 rounds" },
          { value: "6", label: "6 rounds" },
        ],
      },
      {
        id: "perspectives",
        label: "Perspective mix",
        description: "Roles to show in the discussion plan.",
        kind: "select",
        options: [
          { value: "pro-con", label: "Pro / con" },
          { value: "specialists", label: "Specialists" },
          { value: "red-team", label: "Builder / red team" },
          { value: "stakeholders", label: "Stakeholders" },
        ],
      },
      {
        id: "synthesis",
        label: "Synthesis",
        description: "How the preview should close the discussion.",
        kind: "select",
        options: [
          { value: "balanced", label: "Balanced synthesis" },
          { value: "decision", label: "Decision brief" },
          { value: "action-plan", label: "Action plan" },
          { value: "open-questions", label: "Open questions" },
        ],
      },
      {
        id: "surfaceDisagreement",
        label: "Keep disagreements visible",
        description: "Do not collapse unresolved claims into a false consensus.",
        kind: "toggle",
      },
    ],
    defaults: {
      rounds: "3",
      perspectives: "specialists",
      synthesis: "decision",
      surfaceDisagreement: true,
    },
  },
};

function cloneDefaults(): Record<ComposerMode, ModeControlValues> {
  return {
    ask: { ...MODE_DEFINITIONS.ask.defaults },
    create: { ...MODE_DEFINITIONS.create.defaults },
    research: { ...MODE_DEFINITIONS.research.defaults },
    discuss: { ...MODE_DEFINITIONS.discuss.defaults },
  };
}

function emptyHistory(): Record<ComposerMode, { undo: ModeControlValues[]; redo: ModeControlValues[] }> {
  return {
    ask: { undo: [], redo: [] },
    create: { undo: [], redo: [] },
    research: { undo: [], redo: [] },
    discuss: { undo: [], redo: [] },
  };
}

export interface ComposerModeControlsPreviewProps {
  mode: ComposerMode;
  onClose?: () => void;
}

/**
 * Renderer-local mode controls. These options intentionally shape the preview
 * only; they are not provider parameters and do not grant native execution.
 */
export function ComposerModeControlsPreview({ mode, onClose }: ComposerModeControlsPreviewProps) {
  const definition = MODE_DEFINITIONS[mode];
  const [values, setValues] = useState<Record<ComposerMode, ModeControlValues>>(cloneDefaults);
  const [history, setHistory] = useState<Record<ComposerMode, { undo: ModeControlValues[]; redo: ModeControlValues[] }>>(emptyHistory);
  const currentValues = values[mode];
  const modeHistory = history[mode];
  const selectedSummary = useMemo(() => {
    const labels = definition.controls.flatMap((control) => {
      const value = currentValues[control.id];
      if (control.kind === "toggle") return value ? [control.label] : [];
      const option = control.options?.find((item) => item.value === value);
      return option ? [option.label] : [];
    });
    return labels.slice(0, 3);
  }, [currentValues, definition.controls]);

  const updateValue = (control: ModeControlDefinition, value: ModeControlValue) => {
    setValues((previous) => {
      setHistory((previousHistory) => ({
        ...previousHistory,
        [mode]: {
          undo: [...previousHistory[mode].undo, { ...previous[mode] }].slice(-20),
          redo: [],
        },
      }));
      return { ...previous, [mode]: { ...previous[mode], [control.id]: value } };
    });
  };

  const resetMode = () => {
    setValues((previous) => {
      setHistory((previousHistory) => ({
        ...previousHistory,
        [mode]: {
          undo: [...previousHistory[mode].undo, { ...previous[mode] }].slice(-20),
          redo: [],
        },
      }));
      return { ...previous, [mode]: { ...definition.defaults } };
    });
  };

  const undoMode = () => {
    const previous = modeHistory.undo.at(-1);
    if (!previous) return;
    setValues((current) => ({ ...current, [mode]: { ...previous } }));
    setHistory((current) => ({
      ...current,
      [mode]: {
        undo: current[mode].undo.slice(0, -1),
        redo: [...current[mode].redo, { ...currentValues }].slice(-20),
      },
    }));
  };

  const redoMode = () => {
    const next = modeHistory.redo.at(-1);
    if (!next) return;
    setValues((current) => ({ ...current, [mode]: { ...next } }));
    setHistory((current) => ({
      ...current,
      [mode]: {
        undo: [...current[mode].undo, { ...currentValues }].slice(-20),
        redo: current[mode].redo.slice(0, -1),
      },
    }));
  };

  return (
    <section className="composer-mode-controls" aria-label={`${definition.label} mode controls`}>
      <header className="composer-mode-controls__header">
        <div className="composer-mode-controls__title">
          <span className="composer-mode-controls__icon" aria-hidden="true"><SlidersHorizontal size={14} /></span>
          <span>
            <span className="eyebrow">{definition.eyebrow}</span>
            <strong>{definition.label} controls</strong>
          </span>
        </div>
        <div className="composer-mode-controls__history" role="group" aria-label={`${definition.label} mode control history`}>
          <button type="button" className="composer-mode-controls__history-button" onClick={undoMode} disabled={!modeHistory.undo.length} aria-label={`Undo ${definition.label} control change`} title="Undo control change"><Undo2 size={13} /></button>
          <button type="button" className="composer-mode-controls__history-button" onClick={redoMode} disabled={!modeHistory.redo.length} aria-label={`Redo ${definition.label} control change`} title="Redo control change"><Redo2 size={13} /></button>
          <button type="button" className="composer-mode-controls__history-button" onClick={resetMode} aria-label={`Reset ${definition.label} controls`} title={`Reset ${definition.label} controls`}><RotateCcw size={13} /></button>
          {onClose ? (
            <button type="button" className="composer-mode-controls__history-button composer-mode-controls__close" onClick={onClose} aria-label="Close mode controls" title="Close mode controls"><X size={13} /></button>
          ) : null}
        </div>
      </header>
      <p className="composer-mode-controls__summary">{definition.summary}</p>
      <div className="composer-mode-controls__chips" aria-label="Selected mode controls">
        {selectedSummary.map((label) => <span key={label}>{label}</span>)}
      </div>
      <div className="composer-mode-controls__fields">
        {definition.controls.map((control) => {
          const value = currentValues[control.id];
          if (control.kind === "toggle") {
            return (
              <label key={control.id} className="composer-mode-controls__toggle">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(event) => updateValue(control, event.target.checked)}
                />
                <span>
                  <strong>{control.label}</strong>
                  <small>{control.description}</small>
                </span>
              </label>
            );
          }
          return (
            <label key={control.id} className="composer-mode-controls__field">
              <span>
                <strong>{control.label}</strong>
                <small>{control.description}</small>
              </span>
              <select
                aria-label={control.label}
                value={typeof value === "string" ? value : ""}
                onChange={(event) => updateValue(control, event.target.value)}
              >
                {control.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          );
        })}
      </div>
      <p className="composer-mode-controls__boundary" role="note">
        Renderer-local preview only · changes stay in this composer session and are not sent as native/provider parameters.
      </p>
    </section>
  );
}
