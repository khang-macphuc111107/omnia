import {
  Check,
  ChevronRight,
  CircleOff,
  Eye,
  FileText,
  FolderKanban,
  Globe2,
  History,
  LockKeyhole,
  MessageSquareText,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Undo2,
  UserRound,
  Redo2,
} from "lucide-react";
import { useMemo, useState } from "react";

export type MemoryScopeId = "global" | "profile" | "project" | "conversation";
export type MemoryModeId = "off" | "read-only" | "propose" | "auto-low-risk" | "custom";

type ScopeOption = {
  readonly id: MemoryScopeId;
  readonly label: string;
  readonly description: string;
  readonly examples: string;
};

type ModeOption = {
  readonly id: MemoryModeId;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
};

type ScopeModeState = {
  readonly scope: MemoryScopeId;
  readonly mode: MemoryModeId;
  readonly autoApproveThreshold: number;
  readonly includeSensitive: boolean;
  readonly includeArchived: boolean;
  readonly allowImported: boolean;
};

type ScopeModeHistory = {
  readonly past: ScopeModeState[];
  readonly present: ScopeModeState;
  readonly future: ScopeModeState[];
};

export const MEMORY_SCOPE_OPTIONS: readonly ScopeOption[] = [
  {
    id: "global",
    label: "Global",
    description: "Use across every project and conversation in this Omnia profile.",
    examples: "Writing preferences · accessibility defaults",
  },
  {
    id: "profile",
    label: "Profile",
    description: "Keep a preference tied to one user profile or workspace identity.",
    examples: "Language · response style · working hours",
  },
  {
    id: "project",
    label: "Project",
    description: "Limit recall to the selected project and its linked chats.",
    examples: "Architecture decisions · repo conventions",
  },
  {
    id: "conversation",
    label: "Conversation",
    description: "Keep a note inside one chat or task until its retention ends.",
    examples: "Temporary constraints · current task context",
  },
] as const;

export const MEMORY_MODE_OPTIONS: readonly ModeOption[] = [
  {
    id: "off",
    label: "Off",
    description: "Do not propose or retrieve memory for this scope.",
    detail: "No memory route is selected in this preview.",
  },
  {
    id: "read-only",
    label: "Read-only",
    description: "Allow existing approved entries to be considered, never propose new ones.",
    detail: "Retrieval can inspect approved rows; capture stays disabled.",
  },
  {
    id: "propose",
    label: "Propose",
    description: "Show candidates for review before they can become approved memory.",
    detail: "Suggested rows wait in the proposal inbox for a human decision.",
  },
  {
    id: "auto-low-risk",
    label: "Auto · low risk",
    description: "Allow low-risk preferences to be accepted automatically; sensitive items still wait.",
    detail: "The risk threshold is illustrative until a native policy evaluator exists.",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Tune retrieval and proposal behavior with the controls below.",
    detail: "Custom controls are renderer-session settings only.",
  },
] as const;

const DEFAULT_STATE: ScopeModeState = {
  scope: "project",
  mode: "propose",
  autoApproveThreshold: 0.8,
  includeSensitive: false,
  includeArchived: false,
  allowImported: true,
};

const scopeIcons: Record<MemoryScopeId, typeof Globe2> = {
  global: Globe2,
  profile: UserRound,
  project: FolderKanban,
  conversation: MessageSquareText,
};

const modeIcons: Record<MemoryModeId, typeof Globe2> = {
  off: CircleOff,
  "read-only": Eye,
  propose: ShieldCheck,
  "auto-low-risk": Check,
  custom: Settings2,
};

function cloneState(value: ScopeModeState): ScopeModeState {
  return { ...value };
}

function scopeOption(id: MemoryScopeId): ScopeOption {
  return MEMORY_SCOPE_OPTIONS.find((option) => option.id === id) ?? MEMORY_SCOPE_OPTIONS[0]!;
}

function modeOption(id: MemoryModeId): ModeOption {
  return MEMORY_MODE_OPTIONS.find((option) => option.id === id) ?? MEMORY_MODE_OPTIONS[2]!;
}

function stateEqual(left: ScopeModeState, right: ScopeModeState): boolean {
  return left.scope === right.scope
    && left.mode === right.mode
    && left.autoApproveThreshold === right.autoApproveThreshold
    && left.includeSensitive === right.includeSensitive
    && left.includeArchived === right.includeArchived
    && left.allowImported === right.allowImported;
}

function effectiveRows(state: ScopeModeState): string[] {
  if (state.mode === "off") return ["No memory retrieval", "No memory proposals", "No scope write route"];
  if (state.mode === "read-only") return ["Approved entries only", "No new proposals", "No scope write route"];
  if (state.mode === "propose") return ["Approved + suggested entries", "Human approval required", "Proposal inbox route"];
  if (state.mode === "auto-low-risk") return ["Approved + low-risk candidates", `Auto-approve ≥ ${Math.round(state.autoApproveThreshold * 100)}%`, "Sensitive items stay gated"];
  return [
    state.includeArchived ? "Archived rows included" : "Archived rows hidden",
    state.includeSensitive ? "Sensitive candidates visible" : "Sensitive candidates gated",
    state.allowImported ? "Imported previews allowed" : "Imported previews excluded",
  ];
}

export default function MemoryScopeModePreview() {
  const [history, setHistory] = useState<ScopeModeHistory>(() => ({
    past: [],
    present: cloneState(DEFAULT_STATE),
    future: [],
  }));
  const [notice, setNotice] = useState("Scope and mode changes stay in this renderer preview.");
  const current = history.present;
  const scope = scopeOption(current.scope);
  const mode = modeOption(current.mode);
  const ScopeIcon = scopeIcons[current.scope];
  const ModeIcon = modeIcons[current.mode];
  const effective = useMemo(() => effectiveRows(current), [current]);

  const commit = (patch: Partial<ScopeModeState>, message: string) => {
    const next = { ...current, ...patch };
    if (stateEqual(next, current)) return;
    setHistory((value) => ({
      past: [...value.past, cloneState(value.present)],
      present: cloneState(next),
      future: [],
    }));
    setNotice(message);
  };

  const undo = () => {
    setHistory((value) => {
      const previous = value.past.at(-1);
      if (!previous) return value;
      return {
        past: value.past.slice(0, -1),
        present: cloneState(previous),
        future: [cloneState(value.present), ...value.future],
      };
    });
    setNotice("Undid the last scope/mode preview change.");
  };

  const redo = () => {
    setHistory((value) => {
      const next = value.future[0];
      if (!next) return value;
      return {
        past: [...value.past, cloneState(value.present)],
        present: cloneState(next),
        future: value.future.slice(1),
      };
    });
    setNotice("Reapplied the next scope/mode preview change.");
  };

  const reset = () => {
    if (stateEqual(current, DEFAULT_STATE)) {
      setNotice("Scope and mode preview is already at its defaults.");
      return;
    }
    setHistory((value) => ({
      past: [...value.past, cloneState(value.present)],
      present: cloneState(DEFAULT_STATE),
      future: [],
    }));
    setNotice("Scope and mode preview reset to defaults.");
  };

  return (
    <section className="memory-scope-mode" aria-label="Memory scope and mode preview">
      <header className="memory-scope-mode__header">
        <div>
          <span className="eyebrow">Scope routing preview</span>
          <h3>Choose where memory lives and how it behaves</h3>
          <p>Separate the audience of a memory from the approval posture that controls recall and proposals.</p>
        </div>
        <span className="memory-scope-mode__status"><LockKeyhole size={13} /> Preview only</span>
      </header>

      <div className="memory-scope-mode__history" role="toolbar" aria-label="Memory scope and mode history">
        <span><History size={14} /><strong>{notice}</strong></span>
        <span className="memory-scope-mode__history-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo scope and mode preview change"><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo scope and mode preview change"><Redo2 size={13} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset scope and mode preview"><RotateCcw size={13} /> Reset</button>
        </span>
      </div>

      <div className="memory-scope-mode__layout">
        <div className="memory-scope-mode__choices">
          <fieldset>
            <legend><span className="eyebrow">1 · Scope</span><strong>Who should receive this memory?</strong></legend>
            <div className="memory-scope-mode__scope-grid" role="radiogroup" aria-label="Memory scope options">
              {MEMORY_SCOPE_OPTIONS.map((option) => {
                const Icon = scopeIcons[option.id];
                const selected = option.id === current.scope;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-label={`${option.label} scope`}
                    aria-checked={selected}
                    className={`memory-scope-mode__scope-card${selected ? " is-selected" : ""}`}
                    onClick={() => commit({ scope: option.id }, `${option.label} scope selected in preview.`)}
                  >
                    <span className="memory-scope-mode__choice-icon"><Icon size={16} /></span>
                    <span><strong>{option.label}</strong><small>{option.description}</small><em>{option.examples}</em></span>
                    {selected ? <Check size={14} className="memory-scope-mode__selected-mark" /> : <ChevronRight size={14} className="memory-scope-mode__chevron" />}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend><span className="eyebrow">2 · Mode</span><strong>What may Omnia do in that scope?</strong></legend>
            <div className="memory-scope-mode__mode-grid" role="radiogroup" aria-label="Memory mode options">
              {MEMORY_MODE_OPTIONS.map((option) => {
                const Icon = modeIcons[option.id];
                const selected = option.id === current.mode;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-label={`${option.label} mode`}
                    aria-checked={selected}
                    className={`memory-scope-mode__mode-card${selected ? " is-selected" : ""}`}
                    onClick={() => commit({ mode: option.id }, `${option.label} mode selected in preview.`)}
                  >
                    <span className="memory-scope-mode__choice-icon"><Icon size={16} /></span>
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    {selected ? <Check size={14} className="memory-scope-mode__selected-mark" /> : null}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {current.mode === "custom" || current.mode === "auto-low-risk" ? (
            <fieldset className="memory-scope-mode__custom" aria-label="Memory custom mode controls">
              <legend><span className="eyebrow">3 · Guardrails</span><strong>Adjust the preview knobs</strong></legend>
              {current.mode === "auto-low-risk" ? (
                <label className="memory-scope-mode__range">
                  <span><strong>Auto-approve threshold</strong><output>{Math.round(current.autoApproveThreshold * 100)}%</output></span>
                  <input type="range" min="0.5" max="1" step="0.05" value={current.autoApproveThreshold} onChange={(event) => commit({ autoApproveThreshold: Number(event.target.value) }, "Auto-approve threshold changed in preview.")} aria-label="Auto-approve threshold" />
                  <small>Illustrative only: native risk scoring is not connected.</small>
                </label>
              ) : null}
              <label className="memory-scope-mode__toggle"><span><strong>Show sensitive candidates</strong><small>Keep sensitive proposals visible for manual review.</small></span><input type="checkbox" checked={current.includeSensitive} onChange={(event) => commit({ includeSensitive: event.target.checked }, "Sensitive candidate visibility changed in preview.")} /></label>
              <label className="memory-scope-mode__toggle"><span><strong>Include archived entries</strong><small>Expose archived rows in this scope preview.</small></span><input type="checkbox" checked={current.includeArchived} onChange={(event) => commit({ includeArchived: event.target.checked }, "Archived entry visibility changed in preview.")} /></label>
              <label className="memory-scope-mode__toggle"><span><strong>Allow imported previews</strong><small>Include renderer-local imported entries in the candidate set.</small></span><input type="checkbox" checked={current.allowImported} onChange={(event) => commit({ allowImported: event.target.checked }, "Imported preview visibility changed in preview.")} /></label>
            </fieldset>
          ) : null}
        </div>

        <aside className="memory-scope-mode__summary" aria-label="Effective memory scope and mode summary">
          <div className="memory-scope-mode__summary-heading"><span className="memory-scope-mode__summary-icon"><ScopeIcon size={17} /></span><div><span className="eyebrow">Current preview</span><h4>{scope.label} · {mode.label}</h4></div></div>
          <p>{scope.description}</p>
          <div className="memory-scope-mode__summary-mode"><ModeIcon size={14} /><span><strong>{mode.label}</strong><small>{mode.detail}</small></span></div>
          <div className="memory-scope-mode__effective" role="list" aria-label="Effective preview behavior">
            {effective.map((item) => <div key={item} role="listitem"><Check size={13} /><span>{item}</span></div>)}
          </div>
          <div className="memory-scope-mode__target"><FileText size={14} /><span><strong>Target key</strong><code>preview:{current.scope}:{current.mode}</code></span></div>
          <p className="memory-scope-mode__boundary"><LockKeyhole size={14} /><span>Renderer-local draft only. This does not write durable policy, alter native retrieval, approve a proposal, inject provider context, or grant filesystem/process access.</span></p>
        </aside>
      </div>
    </section>
  );
}
