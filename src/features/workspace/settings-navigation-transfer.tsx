import {
  Bookmark,
  Check,
  Clipboard,
  Download,
  FileJson,
  Redo2,
  RotateCcw,
  Undo2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

export type SettingsNavigationItem = {
  id: string;
  label: string;
  description: string;
};

export const SETTINGS_NAVIGATION_PROFILE_SCHEMA = "omnia.settings-navigation-profile.preview.v1" as const;
const MAX_PROFILE_BYTES = 32 * 1024;

type NavigationDraft = {
  defaultCategory: string;
  pinnedCategoryIds: string[];
};

type NavigationHistory = {
  past: NavigationDraft[];
  present: NavigationDraft;
  future: NavigationDraft[];
};

type ImportedNavigationProfile = {
  name: string;
  description: string;
  draft: NavigationDraft;
};

type Props = {
  items: readonly SettingsNavigationItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /**
   * Keep the navigation map available without making the full portability
   * workbench part of the primary Settings reading order.
   *
   * The default remains expanded for the standalone preview/test surface;
   * SettingsScreen opts into the compact disclosure so the category rail and
   * active panel stay visually primary.
   */
  compact?: boolean;
};

function uniqueValidIds(ids: readonly string[], items: readonly SettingsNavigationItem[]): string[] {
  const valid = new Set(items.map((item) => item.id));
  return [...new Set(ids.filter((id) => valid.has(id)))];
}

function createDefaultDraft(items: readonly SettingsNavigationItem[]): NavigationDraft {
  const first = items.find((item) => item.id === "providers")?.id ?? items[0]?.id ?? "";
  return {
    defaultCategory: first,
    pinnedCategoryIds: items.slice(0, 3).map((item) => item.id),
  };
}

function cloneDraft(draft: NavigationDraft): NavigationDraft {
  return { defaultCategory: draft.defaultCategory, pinnedCategoryIds: [...draft.pinnedCategoryIds] };
}

function serializeNavigationProfile(name: string, description: string, draft: NavigationDraft): string {
  return `${JSON.stringify({
    schema: SETTINGS_NAVIGATION_PROFILE_SCHEMA,
    version: 1,
    profile: {
      name: name.trim() || "Omnia settings navigation",
      description: description.trim() || "Renderer-local navigation profile.",
      draft,
    },
    boundary: {
      rendererOnly: true,
      sessionOnly: true,
      noDurableWrite: true,
      noNativeNavigation: true,
    },
  }, null, 2)}\n`;
}

function parseNavigationProfile(
  raw: string,
  items: readonly SettingsNavigationItem[],
): { ok: true; value: ImportedNavigationProfile } | { ok: false; error: string } {
  const source = raw.replace(/^\uFEFF/, "").trim();
  if (!source) return { ok: false, error: "Paste a navigation profile before importing." };
  if (new TextEncoder().encode(source).byteLength > MAX_PROFILE_BYTES) {
    return { ok: false, error: "Navigation profile exceeds the 32 KB preview limit." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, error: "Navigation profile is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Navigation profile must be a JSON object." };
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.schema !== SETTINGS_NAVIGATION_PROFILE_SCHEMA || manifest.version !== 1) {
    return { ok: false, error: "Unsupported Omnia navigation profile schema." };
  }
  if (!manifest.profile || typeof manifest.profile !== "object" || Array.isArray(manifest.profile)) {
    return { ok: false, error: "Navigation profile payload is missing." };
  }
  const profile = manifest.profile as Record<string, unknown>;
  if (typeof profile.name !== "string" || profile.name.trim().length === 0 || profile.name.length > 120) {
    return { ok: false, error: "Navigation profile name is invalid." };
  }
  if (typeof profile.description !== "string" || profile.description.length > 400) {
    return { ok: false, error: "Navigation profile description is invalid." };
  }
  if (!profile.draft || typeof profile.draft !== "object" || Array.isArray(profile.draft)) {
    return { ok: false, error: "Navigation profile draft is missing." };
  }
  const draft = profile.draft as Record<string, unknown>;
  const ids = new Set(items.map((item) => item.id));
  if (typeof draft.defaultCategory !== "string" || !ids.has(draft.defaultCategory)) {
    return { ok: false, error: "Navigation profile default section is not available." };
  }
  if (!Array.isArray(draft.pinnedCategoryIds) || draft.pinnedCategoryIds.some((id) => typeof id !== "string")) {
    return { ok: false, error: "Navigation profile pinned sections are invalid." };
  }
  return {
    ok: true,
    value: {
      name: profile.name.trim(),
      description: profile.description.trim(),
      draft: {
        defaultCategory: draft.defaultCategory,
        pinnedCategoryIds: uniqueValidIds(draft.pinnedCategoryIds as string[], items),
      },
    },
  };
}

function downloadProfile(payload: string, name: string): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-settings-navigation-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile"}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function buildSettingsNavigationProfilePayload(
  name: string,
  description: string,
  draft: NavigationDraft,
): string {
  return serializeNavigationProfile(name, description, draft);
}

export default function SettingsNavigationTransfer({ items, activeId, onSelect, compact = false }: Props) {
  const initialDraft = useMemo(() => createDefaultDraft(items), [items]);
  const [history, setHistory] = useState<NavigationHistory>(() => ({
    past: [],
    present: initialDraft,
    future: [],
  }));
  const [profileName, setProfileName] = useState("My Omnia navigation");
  const [profileDescription, setProfileDescription] = useState("A compact settings map for this renderer session.");
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [status, setStatus] = useState("Choose a section or prepare a portable navigation profile.");
  const [compactOpen, setCompactOpen] = useState(!compact);
  const importRef = useRef<HTMLInputElement>(null);
  const compactBodyRef = useRef<HTMLDivElement>(null);
  const draft = history.present;
  const payload = useMemo(() => serializeNavigationProfile(profileName, profileDescription, draft), [draft, profileDescription, profileName]);
  const pinnedItems = items.filter((item) => draft.pinnedCategoryIds.includes(item.id));
  const compactJumpItems = useMemo(() => {
    if (!compact) return [];
    const activeItem = items.find((item) => item.id === activeId);
    // The compact control is the primary settings jump affordance. Keep it
    // as one bounded select, but expose every section so a user never has to
    // customize pins before a destination becomes selectable.
    return activeItem
      ? [activeItem, ...items.filter((item) => item.id !== activeItem.id)]
      : [...items];
  }, [activeId, compact, items]);
  const compactJumpValue = compactJumpItems.some((item) => item.id === activeId)
    ? activeId
    : compactJumpItems[0]?.id ?? "";
  const parsedImport = useMemo(() => (importText ? parseNavigationProfile(importText, items) : null), [importText, items]);

  const commit = (nextDraft: NavigationDraft, nextStatus?: string) => {
    setHistory((current) => ({
      past: [...current.past, cloneDraft(current.present)].slice(-20),
      present: cloneDraft(nextDraft),
      future: [],
    }));
    setImportError("");
    if (nextStatus) setStatus(nextStatus);
  };

  const togglePinned = (id: string) => {
    const pinned = draft.pinnedCategoryIds.includes(id)
      ? draft.pinnedCategoryIds.filter((candidate) => candidate !== id)
      : [...draft.pinnedCategoryIds, id];
    commit({ ...draft, pinnedCategoryIds: pinned }, `${pinned.includes(id) ? "Pinned" : "Unpinned"} ${items.find((item) => item.id === id)?.label ?? "section"}.`);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: cloneDraft(previous), future: [cloneDraft(current.present), ...current.future] };
    });
    setStatus("Undid the last navigation profile change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, cloneDraft(current.present)], present: cloneDraft(next), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next navigation profile change.");
  };

  const reset = () => {
    setHistory({ past: [], present: createDefaultDraft(items), future: [] });
    setImportText("");
    setImportError("");
    setStatus("Reset navigation pins and default section to their preview defaults.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; no profile was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus("Copied the renderer-local navigation profile.");
    } catch {
      setStatus("Clipboard write failed; no profile was copied.");
    }
  };

  const importProfile = () => {
    const result = parseNavigationProfile(importText, items);
    if (!result.ok) {
      setImportError(result.error);
      setStatus("Navigation profile is waiting for a valid import.");
      return;
    }
    setHistory((current) => ({
      past: [...current.past, cloneDraft(current.present)].slice(-20),
      present: cloneDraft(result.value.draft),
      future: [],
    }));
    setImportError("");
    setStatus(`Imported “${result.value.name}” into this renderer session.`);
    onSelect(result.value.draft.defaultCategory);
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_PROFILE_BYTES) {
      setImportError("Navigation profile exceeds the 32 KB preview limit.");
      setStatus("The selected profile is too large; no file contents were read.");
      if (importRef.current) importRef.current.value = "";
      return;
    }
    try {
      const text = await file.text();
      setImportText(text);
      setImportError("");
      setStatus(`Loaded ${file.name}; review the import before applying it.`);
    } catch {
      setImportError("The selected file could not be read.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const expanded = !compact || compactOpen;

  const toggleCompactMap = () => {
    const nextOpen = !compactOpen;
    setCompactOpen(nextOpen);
    if (!nextOpen) return;
    window.requestAnimationFrame(() => {
      const body = compactBodyRef.current;
      if (!body) return;
      body.focus({ preventScroll: true });
    });
  };

  return (
    <section
      className={`settings-navigation-transfer${compact ? " settings-navigation-transfer--compact" : ""}`}
      aria-labelledby="settings-navigation-transfer-title"
    >
      <header className="settings-navigation-transfer__header">
        <div>
          <span className="eyebrow">Navigate faster · carry your map</span>
          <h2 id="settings-navigation-transfer-title">{compact ? "Navigation map" : "Settings navigation & portability"}</h2>
          <p>{compact ? "Pin high-use sections or open the full import/export map when you need it." : "Pin high-use sections, choose a default landing surface, and move this navigation map between Omnia renderer previews."}</p>
        </div>
        <div className="settings-navigation-transfer__header-actions">
          <span className="settings-preview-chip"><Bookmark size={13} /> Renderer-local</span>
          {compact ? (
            <button
              type="button"
              className="button button--ghost settings-navigation-transfer__toggle"
              aria-expanded={expanded}
              aria-controls="settings-navigation-transfer-body"
              title={`${expanded ? "Hide" : "Open"} the renderer-local navigation map editor`}
              onClick={toggleCompactMap}
            >
              {expanded ? "Hide map" : "Customize map"}
            </button>
          ) : null}
        </div>
      </header>

      <div className="settings-navigation-transfer__quick" role="toolbar" aria-label={compact ? "Quick settings navigation" : "Pinned settings navigation"}>
        {compact ? (
          <label className="settings-navigation-transfer__quick-select">
            <span className="settings-navigation-transfer__label">Quick jump</span>
            <select
              aria-label="Jump to a settings section"
              title="Jump to a settings section"
              value={compactJumpValue}
              onChange={(event) => onSelect(event.target.value)}
              disabled={compactJumpItems.length === 0}
            >
              {compactJumpItems.length > 0 ? compactJumpItems.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              )) : <option value="">No pinned sections</option>}
            </select>
          </label>
        ) : (
          <>
            <span className="settings-navigation-transfer__label">Pinned</span>
            {pinnedItems.length > 0 ? pinnedItems.map((item) => (
              <button key={item.id} type="button" className={activeId === item.id ? "is-active" : ""} title={`Open pinned settings section: ${item.label}`} aria-pressed={activeId === item.id} onClick={() => onSelect(item.id)}>
                <span>{item.label}</span>
              </button>
            )) : <span className="settings-navigation-transfer__empty">No pinned sections yet</span>}
          </>
        )}
        {!compact ? (
          <button
            type="button"
            className="button button--ghost settings-navigation-transfer__manage"
            title="Focus the pinned settings section controls"
            onClick={() => document.getElementById("settings-navigation-pins")?.focus()}
          >
            Manage pins
          </button>
        ) : null}
      </div>

      {expanded ? <div ref={compactBodyRef} className="settings-navigation-transfer__body" id="settings-navigation-transfer-body" tabIndex={-1}>
        <section className="settings-navigation-transfer__pins" id="settings-navigation-pins" tabIndex={-1} aria-labelledby="settings-navigation-pins-title">
          <div className="settings-navigation-transfer__section-heading">
            <div><span className="eyebrow">Personal map</span><h3 id="settings-navigation-pins-title">Choose pinned sections</h3></div>
            <span>{draft.pinnedCategoryIds.length} pinned</span>
          </div>
          <div className="settings-navigation-transfer__pin-grid">
            {items.map((item) => {
              const checked = draft.pinnedCategoryIds.includes(item.id);
              return (
                <label key={item.id} className={checked ? "is-pinned" : ""}>
                  <input type="checkbox" checked={checked} onChange={() => togglePinned(item.id)} />
                  <span><strong>{item.label}</strong><small>{item.description}</small></span>
                  {checked ? <Check size={14} aria-hidden="true" /> : null}
                </label>
              );
            })}
          </div>
          <div className="settings-navigation-transfer__default">
            <label htmlFor="settings-navigation-default"><span>Default opening section</span><small>Used when this profile is applied in the current preview.</small></label>
            <select id="settings-navigation-default" value={draft.defaultCategory} onChange={(event) => { const id = event.target.value; commit({ ...draft, defaultCategory: id }, `Default opening section set to ${items.find((item) => item.id === id)?.label ?? id}.`); }}>
              {items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <button type="button" className="button button--secondary" onClick={() => onSelect(draft.defaultCategory)}>Open default</button>
          </div>
        </section>

        <section className="settings-navigation-transfer__portable" aria-labelledby="settings-navigation-portable-title">
          <div className="settings-navigation-transfer__section-heading">
            <div><span className="eyebrow">Portable profile</span><h3 id="settings-navigation-portable-title">Export / import map</h3></div>
            <span>JSON · 32 KB limit</span>
          </div>
          <div className="settings-navigation-transfer__profile-fields">
            <label><span>Profile name</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={120} /></label>
            <label><span>Description</span><input value={profileDescription} onChange={(event) => setProfileDescription(event.target.value)} maxLength={400} /></label>
          </div>
          <pre className="settings-navigation-transfer__payload" aria-label="Navigation profile preview"><code>{payload}</code></pre>
          <div className="settings-navigation-transfer__actions">
            <button type="button" className="button button--ghost" title="Copy the renderer-local navigation profile JSON" onClick={() => void copy()}><Clipboard size={13} /> Copy JSON</button>
            <button type="button" className="button button--secondary" title="Download the renderer-local navigation profile JSON" onClick={() => setStatus(downloadProfile(payload, profileName) ? "Browser download started for the renderer-local navigation profile; no app setting was persisted." : "Browser download is unavailable; no profile file was written.")}><Download size={13} /> Download JSON</button>
            <button type="button" className="button button--ghost" title="Choose a navigation profile JSON file to preview" onClick={() => importRef.current?.click()}><Upload size={13} /> Choose file</button>
            <input ref={importRef} className="sr-only" type="file" accept="application/json,.json" aria-label="Choose navigation profile JSON" onChange={(event) => void loadFile(event.currentTarget.files?.[0])} />
          </div>
          <label className="settings-navigation-transfer__import-input"><span>Paste a profile to stage</span><textarea rows={5} value={importText} onChange={(event) => { setImportText(event.target.value); setImportError(""); }} placeholder="Paste an Omnia settings-navigation profile JSON…" /></label>
          <div className="settings-navigation-transfer__import-actions">
            <button type="button" className="button button--secondary" onClick={importProfile} disabled={!parsedImport?.ok}><FileJson size={13} /> Apply imported map</button>
            <button type="button" className="button button--ghost" onClick={() => { setImportText(""); setImportError(""); }}>Clear</button>
            <span role="status" aria-live="polite">
              {importError || (parsedImport?.ok ? `Ready to import “${parsedImport.value.name}”.` : parsedImport && !parsedImport.ok ? parsedImport.error : status)}
            </span>
          </div>
          <p className="settings-navigation-transfer__boundary">Preview only · session-only · no durable write. Import changes the navigation draft and opens its default section; it does not restore settings, secrets, provider data, or native policy.</p>
        </section>
      </div> : null}

      {expanded ? <footer className="settings-navigation-transfer__footer">
        <span role="status" aria-live="polite">{status}</span>
        <div className="settings-navigation-transfer__footer-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo navigation change"><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo navigation change"><Redo2 size={13} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset map</button>
        </div>
      </footer> : null}
    </section>
  );
}
