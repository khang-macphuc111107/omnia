import {
  ArrowDown,
  ArrowUp,
  Command,
  Clipboard,
  CornerDownLeft,
  Download,
  FolderKanban,
  Keyboard,
  List,
  MessageSquareText,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  Redo2,
  Save,
  Search,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { ModalSurface } from "@/components/modal-surface";

import { COMMAND_ACTIVITIES } from "./activity-registry";
import {
  canActivateRendererShortcut,
  getSessionShortcutOverrides,
  isActiveRendererShortcut,
  setSessionShortcutOverrides,
  type ShortcutOverrides,
} from "./keyboard-shortcut-session";

type ShortcutGroup = {
  label: string;
  description: string;
  items: readonly ShortcutItem[];
};

type ShortcutItem = {
  id: string;
  label: string;
  keys: readonly string[];
  icon: typeof Command;
  /**
   * Some editor bindings intentionally share a key because the active
   * editing context decides which action wins. They are not reported as a
   * conflict in this preview.
   */
  allowSharedBinding?: boolean;
};

type ShortcutHistory = { past: ShortcutOverrides[]; present: ShortcutOverrides; future: ShortcutOverrides[] };
const SHORTCUT_EXPORT_SCHEMA = "omnia.keyboard-shortcuts.preview.v1";
const SHORTCUT_IMPORT_LIMIT = 16 * 1024;

type ShortcutPreset = {
  id: string;
  label: string;
  description: string;
  overrides: ShortcutOverrides;
};

const DEFAULT_SHORTCUTS: readonly ShortcutGroup[] = [
  {
    label: "Navigation",
    description: "Jump directly to a primary Omnia surface.",
    items: COMMAND_ACTIVITIES.filter((activity) => activity.shortcut).map((activity) => ({
      id: `activity-${activity.id}`,
      label: `Open ${activity.label}`,
      keys: activity.shortcut?.split("+") ?? [],
      icon: Command,
    })),
  },
  {
    label: "Workspace",
    description: "Move around Omnia without leaving the keyboard.",
    items: [
      { id: "open-commands", label: "Open commands and navigation", keys: ["Ctrl", "K"], icon: Command },
      { id: "new-chat", label: "Start a new Chat", keys: ["Ctrl", "N"], icon: Plus },
      { id: "new-project", label: "Start a new Project", keys: ["Ctrl", "Shift", "P"], icon: FolderKanban },
      { id: "focus-search", label: "Focus Chat / project search", keys: ["Ctrl", "Shift", "F"], icon: Search },
      { id: "focus-composer", label: "Focus the message composer", keys: ["Ctrl", "L"], icon: MessageSquareText },
      { id: "toggle-sidebar", label: "Toggle sidebar", keys: ["Ctrl", "Shift", "B"], icon: PanelLeft },
      { id: "toggle-inspector", label: "Toggle inspector", keys: ["Ctrl", "Shift", "I"], icon: PanelRight },
    ],
  },
  {
    label: "Composer",
    description: "Use the rich drafting controls while writing.",
    items: [
      { id: "continue-list", label: "Continue a Markdown list", keys: ["Enter"], icon: List, allowSharedBinding: true },
      { id: "indent-list", label: "Indent or outdent a list block", keys: ["Tab", "Shift", "Tab"], icon: ArrowDown },
      { id: "send-draft", label: "Send the current draft", keys: ["Enter"], icon: CornerDownLeft, allowSharedBinding: true },
      { id: "move-slash", label: "Move through slash commands", keys: ["↑", "↓"], icon: ArrowUp },
    ],
  },
];

const SHORTCUT_GROUPS = DEFAULT_SHORTCUTS;
const SHORTCUT_ITEMS = SHORTCUT_GROUPS.flatMap((group) => group.items);
const SHORTCUT_IDS = new Set(SHORTCUT_ITEMS.map((item) => item.id));

/**
 * Workflow presets are bounded renderer drafts. They intentionally only
 * target navigation/workspace commands that the session resolver understands;
 * composer/native/OS-global bindings remain reference-only.
 */
const SHORTCUT_PRESETS: readonly ShortcutPreset[] = [
  {
    id: "default",
    label: "Default",
    description: "Omnia's balanced navigation bindings.",
    overrides: {},
  },
  {
    id: "coder",
    label: "Coder",
    description: "Keep search and project navigation close to common IDE chords.",
    overrides: {
      "new-chat": ["Ctrl", "Alt", "N"],
      "new-project": ["Ctrl", "Alt", "P"],
      "focus-search": ["Ctrl", "P"],
      "toggle-sidebar": ["Ctrl", "B"],
      "toggle-inspector": ["Ctrl", "Alt", "I"],
    },
  },
  {
    id: "research",
    label: "Research",
    description: "Prioritize fast Chat search and context inspection.",
    overrides: {
      "new-chat": ["Ctrl", "Alt", "N"],
      "focus-search": ["Ctrl", "F"],
      "focus-composer": ["Ctrl", "Enter"],
      "toggle-inspector": ["Ctrl", "Alt", "I"],
    },
  },
  {
    id: "focus-first",
    label: "Focus-first",
    description: "Make the primary search, composer, and inspector routes easy to reach.",
    overrides: {
      "focus-search": ["Ctrl", "P"],
      "focus-composer": ["Ctrl", "L"],
      "toggle-inspector": ["Ctrl", "Alt", "I"],
      "toggle-sidebar": ["Ctrl", "Alt", "B"],
    },
  },
];

function sameOverrides(left: ShortcutOverrides, right: ShortcutOverrides): boolean {
  const leftIds = Object.keys(left).sort();
  const rightIds = Object.keys(right).sort();
  if (leftIds.length !== rightIds.length || leftIds.some((id, index) => id !== rightIds[index])) return false;
  return leftIds.every((id) => sameShortcut(left[id] ?? [], right[id] ?? []));
}

function parseShortcutImport(source: string): ShortcutOverrides {
  if (source.length > SHORTCUT_IMPORT_LIMIT) throw new Error("Shortcut bundle exceeds 16 KB.");
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error("Shortcut bundle is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Shortcut bundle must be an object.");
  const bundle = parsed as Record<string, unknown>;
  if (Object.keys(bundle).some((key) => !["schema", "overrides", "boundary"].includes(key)) || bundle.schema !== SHORTCUT_EXPORT_SCHEMA) {
    throw new Error("Shortcut bundle schema is unsupported.");
  }
  if (!bundle.overrides || typeof bundle.overrides !== "object" || Array.isArray(bundle.overrides)) {
    throw new Error("Shortcut overrides must be an object.");
  }
  const entries = Object.entries(bundle.overrides);
  if (entries.length > SHORTCUT_ITEMS.length) throw new Error("Shortcut bundle contains too many overrides.");
  const next: ShortcutOverrides = {};
  for (const [id, value] of entries) {
    if (!SHORTCUT_IDS.has(id) || !Array.isArray(value) || value.length < 1 || value.length > 4 ||
      value.some((key) => typeof key !== "string" || key.length < 1 || key.length > 24 || /[<>\r\n]/.test(key))) {
      throw new Error(`Invalid shortcut override: ${id}.`);
    }
    if (isActiveRendererShortcut(id) && !canActivateRendererShortcut(value as string[])) {
      throw new Error(`Shortcut ${id} needs a supported Ctrl/Cmd or Alt chord (reserved browser keys are unavailable).`);
    }
    next[id] = value as string[];
  }
  return next;
}

function exportShortcutBundle(overrides: ShortcutOverrides): string {
  return JSON.stringify({
    schema: SHORTCUT_EXPORT_SCHEMA,
    overrides: Object.fromEntries(Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))),
    boundary: "Supported navigation/workspace bindings apply in this renderer tab; composer, native and OS-global shortcuts are unchanged.",
  }, null, 2);
}

function shortcutSignature(keys: readonly string[]): string {
  return keys.map((key) => key.trim().toLocaleLowerCase()).join("+");
}

function sameShortcut(left: readonly string[], right: readonly string[]): boolean {
  return shortcutSignature(left) === shortcutSignature(right);
}

function keyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key === "Escape") return "Esc";
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function capturedKeys(event: KeyboardEvent): readonly string[] | null {
  const modifier = event.ctrlKey || event.metaKey ? "Ctrl" : null;
  const keys: string[] = [];
  if (modifier) keys.push(modifier);
  if (event.altKey) keys.push("Alt");
  if (event.shiftKey && event.key !== "Shift") keys.push("Shift");
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return null;
  keys.push(keyLabel(event.key));
  return keys;
};

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [history, setHistory] = useState<ShortcutHistory>({ past: [], present: getSessionShortcutOverrides(), future: [] });
  const [importText, setImportText] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState("Navigation and workspace bindings apply within this renderer tab. Composer/native shortcuts remain unchanged.");
  const overrides = history.present;

  useEffect(() => setSessionShortcutOverrides(history.present), [history.present]);

  const setOverrides = (change: (current: ShortcutOverrides) => ShortcutOverrides) => {
    setImportText(null);
    setHistory((current) => {
      const next = change(current.present);
      if (JSON.stringify(next) === JSON.stringify(current.present)) return current;
      return { past: [...current.past, current.present].slice(-20), present: next, future: [] };
    });
  };

  const activePreset = useMemo(
    () => SHORTCUT_PRESETS.find((preset) => sameOverrides(preset.overrides, overrides)) ?? null,
    [overrides],
  );

  const applyPreset = (presetId: string) => {
    const preset = SHORTCUT_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    setOverrides(() => preset.overrides);
    setEditingId(null);
    setStatus(
      `${preset.label} shortcut preset applied in this renderer tab. ` +
      "Undo to restore the previous draft; composer/native/global shortcuts are unchanged.",
    );
  };

  const undoShortcuts = () => {
    setImportText(null);
    setHistory((current) => {
      const previous = current.past.at(-1);
      return previous ? { past: current.past.slice(0, -1), present: previous, future: [current.present, ...current.future] } : current;
    });
    setEditingId(null);
    setStatus("Undid the last shortcut change in this renderer tab.");
  };

  const redoShortcuts = () => {
    setImportText(null);
    setHistory((current) => {
      const next = current.future[0];
      return next ? { past: [...current.past, current.present].slice(-20), present: next, future: current.future.slice(1) } : current;
    });
    setEditingId(null);
    setStatus("Redid the shortcut change in this renderer tab.");
  };

  const copyShortcuts = async () => {
    try {
      await navigator.clipboard.writeText(exportShortcutBundle(overrides));
      setStatus("Copied the renderer-session shortcut bundle; native/global shortcuts are unchanged.");
    } catch { setStatus("Clipboard unavailable; use the JSON field below to copy the bundle."); }
  };

  const downloadShortcuts = () => {
    const url = URL.createObjectURL(new Blob([exportShortcutBundle(overrides)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "omnia-keyboard-shortcuts-preview.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus("Downloaded renderer-session configuration; native/global shortcuts are unchanged.");
  };

  const importShortcuts = (source: string) => {
    try {
      const next = parseShortcutImport(source);
      setOverrides(() => next);
      setEditingId(null);
      setStatus(`Imported ${Object.keys(next).length} override(s); supported renderer commands now use these keys in this tab.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not import shortcut bundle.");
    }
  };

  const changedCount = useMemo(() => Object.keys(overrides).length, [overrides]);

  const keysFor = (item: ShortcutItem) => overrides[item.id] ?? item.keys;

  const conflicts = useMemo(() => {
    const grouped = new Map<string, readonly ShortcutItem[]>();
    for (const item of SHORTCUT_ITEMS) {
      const signature = shortcutSignature(keysFor(item));
      const current = grouped.get(signature) ?? [];
      grouped.set(signature, [...current, item]);
    }
    return new Map(
      [...grouped.entries()].map(([signature, items]) => [
        signature,
        items.filter((item) =>
          items.some(
            (other) =>
              other.id !== item.id &&
              !(item.allowSharedBinding && other.allowSharedBinding),
          ),
        ),
      ]),
    );
  }, [overrides]);

  const conflictFor = (item: ShortcutItem): readonly ShortcutItem[] =>
    (conflicts.get(shortcutSignature(keysFor(item))) ?? []).filter(
      (other) => other.id !== item.id,
    );

  const conflictCount = useMemo(
    () => [...conflicts.values()].filter((items) => items.length > 0).length,
    [conflicts],
  );

  const resetShortcuts = () => {
    setOverrides(() => ({}));
    setEditingId(null);
    setStatus("Renderer shortcuts reset to defaults; native/global shortcuts were unchanged.");
  };

  const clearShortcut = (item: ShortcutItem) => {
    setOverrides((current) => {
      if (!(item.id in current)) return current;
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setEditingId(null);
    setStatus(item.label + " returned to its default; native/global shortcuts were unchanged.");
  };

  const saveShortcut = (item: ShortcutItem, event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setEditingId(null);
      setStatus(item.label + " shortcut editing cancelled.");
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      clearShortcut(item);
      return;
    }
    const next = capturedKeys(event);
    if (!next) return;
    if (isActiveRendererShortcut(item.id) && !canActivateRendererShortcut(next)) {
      setStatus("Choose a supported Ctrl/Cmd or Alt chord; plain keys and reserved browser shortcuts cannot rebind this renderer command.");
      return;
    }
    setOverrides((current) => {
      if (sameShortcut(next, item.keys)) {
        if (!(item.id in current)) return current;
        const withoutOverride = { ...current };
        delete withoutOverride[item.id];
        return withoutOverride;
      }
      return { ...current, [item.id]: next };
    });
    setEditingId(null);
    const nextConflict = SHORTCUT_ITEMS.filter(
      (other) =>
        other.id !== item.id &&
        sameShortcut(next, keysFor(other)) &&
        !(item.allowSharedBinding && other.allowSharedBinding),
    );
    if (nextConflict.length > 0) {
      setStatus(
        item.label +
          " is now " +
          next.join(" + ") +
          " in this renderer tab. Conflict: already used by " +
          nextConflict.map((other) => other.label).join(", ") +
          ".",
      );
    } else {
      setStatus(item.label + " uses " + next.join(" + ") + (isActiveRendererShortcut(item.id)
        ? " in this renderer tab; native/global shortcuts are unchanged."
        : " as a reference only; composer behavior is unchanged."));
    }
  };

  return (
    <ModalSurface
      className="keyboard-shortcuts-dialog"
      ariaLabel="Keyboard shortcuts"
      title="Keyboard shortcuts"
      description="Edit navigation and workspace shortcuts for this tab; composer and native bindings are reference-only."
      onClose={onClose}
    >
      <header className="keyboard-shortcuts-dialog__header">
        <div className="keyboard-shortcuts-dialog__hero">
          <span className="keyboard-shortcuts-dialog__icon" aria-hidden="true">
            <Keyboard size={18} />
          </span>
          <div>
            <span className="eyebrow">Quick reference</span>
            <h2>Keyboard shortcuts</h2>
            <p>Use these shortcuts to move faster through the current renderer preview.</p>
          </div>
        </div>
        <button type="button" className="icon-button" aria-label="Close keyboard shortcuts" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className="keyboard-shortcuts-dialog__toolbar" role="toolbar" aria-label="Shortcut preview actions">
        <span>
          <Keyboard size={13} /> {changedCount ? `${changedCount} customized` : "Using defaults"}
          {conflictCount > 0 ? <b className="keyboard-shortcuts-dialog__conflict-count">{conflictCount} conflict{conflictCount === 1 ? "" : "s"}</b> : null}
        </span>
        <div className="keyboard-shortcuts-dialog__toolbar-actions">
          <label className="keyboard-shortcuts-dialog__preset">
            <span>Preset</span>
            <select
              aria-label="Shortcut preset"
              value={activePreset?.id ?? "custom"}
              onChange={(event) => applyPreset(event.target.value)}
            >
              <option value="custom" disabled>Custom draft</option>
              {SHORTCUT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select>
          </label>
          <button type="button" className="button button--ghost" onClick={undoShortcuts} disabled={!history.past.length}><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redoShortcuts} disabled={!history.future.length}><Redo2 size={13} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={resetShortcuts} disabled={changedCount === 0}><RotateCcw size={13} /> Reset defaults</button>
        </div>
      </div>

      <div className="keyboard-shortcuts-dialog__preset-note" role="note">
        <strong>{activePreset?.label ?? "Custom draft"}</strong>
        <span>{activePreset?.description ?? "Manual changes are kept in this renderer tab until you reset, undo, or close the preview."}</span>
      </div>

      <div className="keyboard-shortcuts-dialog__status" role="status" aria-live="polite">
        {status}
      </div>

      <details className="keyboard-shortcuts-dialog__bundle">
        <summary>Import / export shortcut preview</summary>
        <p>Supported navigation and workspace keys rebind this renderer tab immediately. Composer, native and OS-global shortcuts remain unchanged.</p>
        <div className="keyboard-shortcuts-dialog__bundle-actions">
          <button type="button" className="button button--ghost" onClick={() => void copyShortcuts()}><Clipboard size={13} /> Copy JSON</button>
          <button type="button" className="button button--ghost" onClick={downloadShortcuts}><Download size={13} /> Download JSON</button>
          <label className="button button--ghost keyboard-shortcuts-dialog__file-label"><Upload size={13} /> Open JSON
            <input type="file" accept="application/json,.json" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > SHORTCUT_IMPORT_LIMIT) { setStatus("Shortcut bundle exceeds 16 KB."); return; }
              void file.text().then((source) => { setImportText(source); importShortcuts(source); }).catch(() => setStatus("Could not read shortcut bundle."));
            }} />
          </label>
        </div>
        <label htmlFor="shortcut-preview-json">Shortcut JSON bundle</label>
        <textarea id="shortcut-preview-json" value={importText ?? exportShortcutBundle(overrides)} onChange={(event) => setImportText(event.target.value)} rows={6} spellCheck={false} />
        <button type="button" className="button button--secondary" onClick={() => importShortcuts(importText ?? exportShortcutBundle(overrides))}>Import JSON preview</button>
      </details>

      <div className="keyboard-shortcuts-dialog__groups">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.label} className="keyboard-shortcuts-dialog__group" aria-labelledby={`shortcut-group-${group.label}`}>
            <div className="keyboard-shortcuts-dialog__group-heading">
              <h3 id={`shortcut-group-${group.label}`}>{group.label}</h3>
              <p>{group.description}</p>
            </div>
            <div className="keyboard-shortcuts-dialog__list" role="list">
              {group.items.map((item) => {
                const { label, icon: Icon } = item;
                const keys = keysFor(item);
                const editing = editingId === item.id;
                const itemConflicts = conflictFor(item);
                return (
                <div key={item.id} className={`keyboard-shortcuts-dialog__row${editing ? " keyboard-shortcuts-dialog__row--editing" : ""}${itemConflicts.length ? " keyboard-shortcuts-dialog__row--conflict" : ""}`} role="listitem">
                  <span className="keyboard-shortcuts-dialog__row-icon" aria-hidden="true"><Icon size={14} /></span>
                  <span className="keyboard-shortcuts-dialog__row-label">
                    <span>{label}</span>
                    {itemConflicts.length ? (
                      <small className="keyboard-shortcuts-dialog__conflict-note" role="note">
                        Conflicts with {itemConflicts.map((conflict) => conflict.label).join(", ")}
                      </small>
                    ) : null}
                  </span>
                  <span className="keyboard-shortcuts-dialog__keys" aria-label={`Shortcut: ${keys.join(" plus ")}`}>
                    {keys.map((key, index) => (
                      <span key={`${key}-${index}`}>
                        {index > 0 ? <b aria-hidden="true">+</b> : null}
                        <kbd>{key}</kbd>
                      </span>
                      ))}
                    </span>
                  <button
                    type="button"
                    className="button button--ghost keyboard-shortcuts-dialog__edit"
                    aria-label={`${editing ? "Stop editing" : "Customize"} shortcut for ${label}`}
                    onClick={() => {
                      setEditingId(editing ? null : item.id);
                      setStatus(editing ? "Shortcut editing cancelled." : `Press a key chord for ${label}.`);
                    }}
                    onKeyDown={editing ? (event) => saveShortcut(item, event) : undefined}
                  >
                    {editing ? <Save size={12} /> : null}
                    {editing ? "Press keys…" : "Customize"}
                  </button>
                  {item.id in overrides ? (
                    <button
                      type="button"
                      className="button button--ghost keyboard-shortcuts-dialog__clear"
                      aria-label={"Clear shortcut for " + label}
                      onClick={() => clearShortcut(item)}
                    >
                      <X size={12} />
                      Clear
                    </button>
                  ) : null}
                </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <footer className="keyboard-shortcuts-dialog__footer" role="note">
        <span><Keyboard size={13} /> Renderer-session binding · navigation/workspace only. Composer and native/global shortcut registration remain separately gated.</span>
        <button type="button" className="button button--secondary" onClick={onClose}>Done</button>
      </footer>
    </ModalSurface>
  );
}
