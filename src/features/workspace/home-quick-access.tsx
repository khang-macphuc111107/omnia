import { useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Brain,
  Boxes,
  BookOpen,
  Download,
  FileUp,
  FolderKanban,
  FolderPlus,
  Library,
  MessageSquareText,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Star,
  Undo2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  buildHomeQuickAccessBundle,
  DEFAULT_HOME_QUICK_ACCESS,
  parseHomeQuickAccessBundle,
  type HomeQuickAccessActionId,
  type HomeQuickAccessItem,
} from "./home-quick-access-contract";

interface QuickActionDefinition {
  readonly id: HomeQuickAccessActionId;
  readonly label: string;
  readonly detail: string;
  readonly icon: LucideIcon;
  readonly tone: "blue" | "green" | "teal" | "amber" | "coral" | "steel";
}

const QUICK_ACTIONS: readonly QuickActionDefinition[] = [
  { id: "new-chat", label: "New chat", detail: "Start a focused conversation", icon: Plus, tone: "blue" },
  { id: "new-project", label: "New project", detail: "Create a scoped workspace", icon: FolderPlus, tone: "green" },
  { id: "workspace-search", label: "Search workspace", detail: "Find chats, projects, sources, and more", icon: Search, tone: "teal" },
  { id: "import-preview", label: "Import preview", detail: "Review a portable bundle", icon: Upload, tone: "amber" },
  { id: "chats", label: "Chats", detail: "Open conversation history", icon: MessageSquareText, tone: "blue" },
  { id: "projects", label: "Projects", detail: "Browse project workspaces", icon: FolderKanban, tone: "green" },
  { id: "work", label: "Background work", detail: "Inspect runs and attention", icon: Activity, tone: "coral" },
  { id: "library", label: "Library", detail: "Browse sources and artifacts", icon: Library, tone: "teal" },
  { id: "memory", label: "Memory Studio", detail: "Review memory candidates", icon: Brain, tone: "amber" },
  { id: "skills", label: "Skills Studio", detail: "Inspect skills and permissions", icon: BookOpen, tone: "coral" },
  { id: "settings", label: "Control Center", detail: "Tune providers and workspace options", icon: Boxes, tone: "steel" },
];

interface QuickAccessHistory {
  readonly past: readonly (readonly HomeQuickAccessItem[])[];
  readonly present: readonly HomeQuickAccessItem[];
  readonly future: readonly (readonly HomeQuickAccessItem[])[];
}

export interface HomeQuickAccessProps {
  readonly metrics?: Partial<Record<HomeQuickAccessActionId, number>>;
  readonly onActivate: (action: HomeQuickAccessActionId) => void;
}

const cloneItems = (items: readonly HomeQuickAccessItem[]) => items.map((item) => ({ ...item }));

export function HomeQuickAccess({ metrics = {}, onActivate }: HomeQuickAccessProps) {
  const [history, setHistory] = useState<QuickAccessHistory>(() => ({ past: [], present: cloneItems(DEFAULT_HOME_QUICK_ACCESS), future: [] }));
  const [query, setQuery] = useState("");
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [status, setStatus] = useState("Quick Access settings are session-only.");
  const [bundleText, setBundleText] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return history.present
      .filter((item) => item.enabled)
      .filter((item) => {
        if (!normalized) return true;
        const definition = QUICK_ACTIONS.find((action) => action.id === item.id)!;
        return `${definition.label} ${definition.detail} ${definition.id}`.toLocaleLowerCase().includes(normalized);
      });
  }, [history.present, query]);

  const changeItems = (next: HomeQuickAccessItem[], message: string) => {
    setHistory((current) => ({
      past: [...current.past.slice(-19), cloneItems(current.present)],
      present: next,
      future: [],
    }));
    setStatus(message);
  };

  const updateItem = (id: HomeQuickAccessActionId, patch: Partial<HomeQuickAccessItem>, message: string) => {
    changeItems(history.present.map((item) => item.id === id ? { ...item, ...patch } : item), message);
  };

  const moveItem = (id: HomeQuickAccessActionId, direction: -1 | 1) => {
    const index = history.present.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= history.present.length) return;
    const next = cloneItems(history.present);
    [next[index], next[target]] = [next[target]!, next[index]!];
    changeItems(next, `${QUICK_ACTIONS.find((action) => action.id === id)!.label} moved ${direction < 0 ? "up" : "down"}.`);
  };

  const undo = () => {
    if (!history.past.length) return;
    const previous = history.past.at(-1)!;
    setHistory((current) => ({ past: current.past.slice(0, -1), present: cloneItems(previous), future: [cloneItems(current.present), ...current.future] }));
    setStatus("Undid the last Quick Access change in this renderer session.");
  };

  const redo = () => {
    if (!history.future.length) return;
    const next = history.future[0]!;
    setHistory((current) => ({ past: [...current.past, cloneItems(current.present)], present: cloneItems(next), future: current.future.slice(1) }));
    setStatus("Redid the Quick Access change in this renderer session.");
  };

  const reset = () => {
    if (JSON.stringify(history.present) === JSON.stringify(DEFAULT_HOME_QUICK_ACCESS)) {
      setStatus("Quick Access is already at its default layout.");
      return;
    }
    changeItems(cloneItems(DEFAULT_HOME_QUICK_ACCESS), "Quick Access returned to defaults for this renderer session.");
  };

  const exportBundle = async () => {
    const payload = JSON.stringify(buildHomeQuickAccessBundle(history.present), null, 2);
    setBundleText(payload);
    try {
      await navigator.clipboard.writeText(payload);
      setStatus("Copied the Quick Access JSON bundle. Configuration remains session-only.");
    } catch {
      setStatus("Quick Access JSON is ready below; clipboard access is unavailable.");
    }
  };

  const downloadBundle = () => {
    const payload = JSON.stringify(buildHomeQuickAccessBundle(history.present), null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "omnia-home-quick-access-preview.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Downloaded a Quick Access configuration bundle; no app settings were saved.");
  };

  const importBundle = (source = bundleText) => {
    try {
      changeItems(parseHomeQuickAccessBundle(source), "Imported Quick Access settings into this renderer session only.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not import Quick Access configuration.");
    }
  };

  return (
    <section className="home-quick-access" aria-labelledby="home-quick-access-heading">
      <header className="home-quick-access__header">
        <div>
          <span className="home-quick-access__eyebrow"><SlidersHorizontal size={13} /> Quick Access</span>
          <h2 id="home-quick-access-heading">Your workspace, one click away</h2>
          <p>Pin the surfaces and actions you reach for most.</p>
        </div>
        <div className="home-quick-access__header-actions">
          <label className="home-quick-access__search">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Filter Quick Access</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter shortcuts" aria-label="Filter Quick Access shortcuts" title="Filter Quick Access shortcuts" />
            {query ? <button type="button" aria-label="Clear Quick Access filter" title="Clear Quick Access filter" onClick={() => setQuery("")}><X size={13} /></button> : null}
          </label>
          <button type="button" className="button button--secondary home-quick-access__customize" title={customizeOpen ? "Finish customizing Quick Access" : "Customize Quick Access shortcuts"} aria-expanded={customizeOpen} aria-controls="home-quick-access-settings" onClick={() => setCustomizeOpen((open) => !open)}>
            <SlidersHorizontal size={14} /> {customizeOpen ? "Done" : "Customize"}
          </button>
        </div>
      </header>

      {visibleItems.length ? (
        <div className="home-quick-access__grid" aria-label="Quick Access shortcuts">
          {visibleItems.map((item) => {
            const action = QUICK_ACTIONS.find((definition) => definition.id === item.id)!;
            const Icon = action.icon;
            const metric = metrics[item.id];
            return (
              <button key={item.id} type="button" className={`home-quick-access__item home-quick-access__item--${action.tone}`} onClick={() => onActivate(item.id)}>
                <span className="home-quick-access__icon"><Icon size={17} /></span>
                <span className="home-quick-access__copy"><strong>{action.label}</strong><small>{action.detail}</small></span>
                {typeof metric === "number" ? <span className="home-quick-access__metric">{metric}</span> : null}
                {item.favorite ? <Star className="home-quick-access__star" size={13} fill="currentColor" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="home-quick-access__empty" role="status">No shortcuts match this filter. Clear it or enable actions in Customize.</div>
      )}

      {customizeOpen ? (
        <div id="home-quick-access-settings" className="home-quick-access__settings">
          <div className="home-quick-access__toolbar" role="toolbar" aria-label="Quick Access configuration history">
            <span>Customize shortcuts</span>
            <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length}><Undo2 size={13} /> Undo</button>
            <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length}><Redo2 size={13} /> Redo</button>
            <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset defaults</button>
          </div>
          <div className="home-quick-access__manage-list">
            {history.present.map((item, index) => {
              const action = QUICK_ACTIONS.find((definition) => definition.id === item.id)!;
              const Icon = action.icon;
              return (
                <div key={item.id} className="home-quick-access__manage-row">
                  <label><input type="checkbox" checked={item.enabled} onChange={(event) => updateItem(item.id, { enabled: event.target.checked }, `${action.label} ${event.target.checked ? "shown" : "hidden"} in Quick Access.`)} /><Icon size={14} /><span>{action.label}</span></label>
                  <button type="button" className={item.favorite ? "home-quick-access__favorite is-active" : "home-quick-access__favorite"} aria-label={`${item.favorite ? "Unfavorite" : "Favorite"} ${action.label}`} title={`${item.favorite ? "Unfavorite" : "Favorite"} ${action.label}`} aria-pressed={item.favorite} onClick={() => updateItem(item.id, { favorite: !item.favorite }, `${action.label} favorite setting updated for this session.`)}><Star size={14} fill={item.favorite ? "currentColor" : "none"} /></button>
                  <button type="button" className="home-quick-access__move" aria-label={`Move ${action.label} up`} title={`Move ${action.label} up`} onClick={() => moveItem(item.id, -1)} disabled={index === 0}><ArrowUp size={14} /></button>
                  <button type="button" className="home-quick-access__move" aria-label={`Move ${action.label} down`} title={`Move ${action.label} down`} onClick={() => moveItem(item.id, 1)} disabled={index === history.present.length - 1}><ArrowDown size={14} /></button>
                </div>
              );
            })}
          </div>
          <details className="home-quick-access__bundle">
            <summary>Import / export configuration</summary>
            <p>Share the shortcut layout as JSON. Import only changes this renderer session.</p>
            <div className="home-quick-access__bundle-actions">
              <button type="button" className="button button--ghost" onClick={() => void exportBundle()}><Download size={13} /> Copy JSON</button>
              <button type="button" className="button button--ghost" onClick={downloadBundle}><FileUp size={13} /> Download</button>
              <button type="button" className="button button--ghost" onClick={() => fileInput.current?.click()}><Upload size={13} /> Import file</button>
              <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 16 * 1024) { setStatus("Quick Access bundle exceeds the 16 KB import limit."); event.target.value = ""; return; }
                void file.text().then((source) => { setBundleText(source); importBundle(source); }).catch(() => setStatus("Could not read the Quick Access JSON file."));
                event.target.value = "";
              }} />
            </div>
            <label className="home-quick-access__json-label" htmlFor="home-quick-access-json">Quick Access JSON bundle</label>
            <textarea id="home-quick-access-json" rows={5} value={bundleText} onChange={(event) => setBundleText(event.target.value)} spellCheck={false} placeholder="Paste a Quick Access preview bundle" />
            <button type="button" className="button button--secondary" onClick={() => importBundle()}><Upload size={13} /> Validate and import</button>
          </details>
          <p className="home-quick-access__boundary">Renderer-local · Session-only · No durable write. Order and favorites are visual organization only; they do not change permissions or app-wide navigation.</p>
        </div>
      ) : null}
      <p className="home-quick-access__status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}
