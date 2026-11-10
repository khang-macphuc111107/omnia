import {
  Check,
  Clipboard,
  Download,
  FileJson2,
  Filter,
  Heart,
  LockKeyhole,
  PackageCheck,
  PackageSearch,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

type PluginCategory = "Developer tools" | "Research" | "Productivity" | "Media" | "Data";
type PluginTrust = "Verified" | "Reviewed" | "Unreviewed";
type PluginStatus = "Available" | "Installed" | "Enabled" | "Blocked";
type ManifestFormat = "json" | "markdown";

export interface PluginConfigField {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly defaultValue: string;
  readonly options?: readonly string[];
}

export interface PluginRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly category: PluginCategory;
  readonly summary: string;
  readonly trust: PluginTrust;
  readonly status: PluginStatus;
  readonly capabilities: readonly string[];
  readonly permissions: readonly string[];
  readonly compatibility: readonly string[];
  readonly config: readonly PluginConfigField[];
  readonly updateAvailable: boolean;
}

interface PluginSnapshot {
  readonly records: PluginRecord[];
  readonly favorites: string[];
  readonly configValues: Record<string, Record<string, string>>;
}

interface PluginHistory {
  readonly past: PluginSnapshot[];
  readonly future: PluginSnapshot[];
}

export const PLUGIN_SEED: readonly PluginRecord[] = [
  {
    id: "plugin-git-workbench",
    name: "Git Workbench",
    version: "0.8.3",
    source: "Omnia catalog",
    category: "Developer tools",
    summary: "Turn branch, diff, and review metadata into a focused project cockpit.",
    trust: "Verified",
    status: "Enabled",
    capabilities: ["branch graph", "diff summary", "review checklist"],
    permissions: ["workspace.read", "git.inspect"],
    compatibility: ["Project mode", "Chat mode", "Windows"],
    config: [
      { key: "defaultView", label: "Default view", description: "The first panel to open for a project.", defaultValue: "Diff summary", options: ["Diff summary", "Branch graph", "Review checklist"] },
      { key: "includeUntracked", label: "Include untracked files", description: "Show untracked paths in the preview index.", defaultValue: "No", options: ["Yes", "No"] },
    ],
    updateAvailable: false,
  },
  {
    id: "plugin-citation-canvas",
    name: "Citation Canvas",
    version: "1.4.0",
    source: "Imported manifest",
    category: "Research",
    summary: "Arrange source notes, claims, and citation anchors before writing a brief.",
    trust: "Reviewed",
    status: "Installed",
    capabilities: ["claim map", "citation anchors", "evidence gaps"],
    permissions: ["network.read", "citation.create"],
    compatibility: ["Research Notebook", "Markdown", "LaTeX"],
    config: [
      { key: "citationStyle", label: "Citation style", description: "Formatting preset for a renderer-only draft.", defaultValue: "IEEE", options: ["IEEE", "APA", "ACM", "Chicago"] },
      { key: "evidenceThreshold", label: "Evidence threshold", description: "Minimum confidence label shown in the canvas.", defaultValue: "Reviewed", options: ["Any", "Reviewed", "Verified"] },
    ],
    updateAvailable: true,
  },
  {
    id: "plugin-command-palette",
    name: "Command Palette Plus",
    version: "0.5.7",
    source: "Local package proposal",
    category: "Productivity",
    summary: "Expose project, chat, artifact, and settings actions through a searchable palette.",
    trust: "Reviewed",
    status: "Available",
    capabilities: ["action index", "shortcut hints", "recent commands"],
    permissions: ["workspace.read", "session.preferences"],
    compatibility: ["Project mode", "Chat mode", "Keyboard navigation"],
    config: [
      { key: "resultLimit", label: "Result limit", description: "Maximum visible preview results.", defaultValue: "12", options: ["8", "12", "20", "40"] },
      { key: "showPlanned", label: "Show planned actions", description: "Keep unavailable action proposals visible.", defaultValue: "Yes", options: ["Yes", "No"] },
    ],
    updateAvailable: false,
  },
  {
    id: "plugin-media-storyboard",
    name: "Media Storyboard",
    version: "0.3.2",
    source: "Future catalog",
    category: "Media",
    summary: "Draft image, video, and audio shot lists with aspect, duration, and handoff notes.",
    trust: "Unreviewed",
    status: "Blocked",
    capabilities: ["shot list", "frame notes", "audio cues"],
    permissions: ["media.generate", "artifact.write"],
    compatibility: ["Media Studio", "Image", "Video", "Audio"],
    config: [
      { key: "defaultMedium", label: "Default medium", description: "Medium shown when a new shot is drafted.", defaultValue: "Video", options: ["Image", "Video", "Audio"] },
      { key: "aspectRatio", label: "Aspect ratio", description: "Composition guide used by the preview canvas.", defaultValue: "16:9", options: ["1:1", "4:3", "16:9", "9:16"] },
    ],
    updateAvailable: true,
  },
  {
    id: "plugin-data-inspector",
    name: "Data Inspector",
    version: "0.6.1",
    source: "Workspace proposal",
    category: "Data",
    summary: "Inspect structured payloads with schema hints, tables, and safe redaction previews.",
    trust: "Unreviewed",
    status: "Available",
    capabilities: ["schema hints", "table view", "redaction preview"],
    permissions: ["workspace.read", "artifact.inspect"],
    compatibility: ["JSON", "CSV", "Python", "Notebook"],
    config: [
      { key: "redaction", label: "Redaction mode", description: "Visible treatment for sensitive-looking values.", defaultValue: "Safe", options: ["Safe", "Strict", "Off (preview only)"] },
      { key: "density", label: "Table density", description: "Rows shown in the renderer preview.", defaultValue: "Comfortable", options: ["Compact", "Comfortable", "Spacious"] },
    ],
    updateAvailable: false,
  },
];

const CATEGORY_OPTIONS: readonly (PluginCategory | "all")[] = ["all", "Developer tools", "Research", "Productivity", "Media", "Data"];
const STATUS_OPTIONS: readonly (PluginStatus | "all")[] = ["all", "Available", "Installed", "Enabled", "Blocked"];
const TRUST_OPTIONS: readonly (PluginTrust | "all")[] = ["all", "Verified", "Reviewed", "Unreviewed"];

const statusTone: Record<PluginStatus, string> = {
  Available: "plugin-catalog__chip plugin-catalog__chip--blue",
  Installed: "plugin-catalog__chip plugin-catalog__chip--teal",
  Enabled: "plugin-catalog__chip plugin-catalog__chip--green",
  Blocked: "plugin-catalog__chip plugin-catalog__chip--red",
};

const trustTone: Record<PluginTrust, string> = {
  Verified: "plugin-catalog__chip plugin-catalog__chip--green",
  Reviewed: "plugin-catalog__chip plugin-catalog__chip--blue",
  Unreviewed: "plugin-catalog__chip plugin-catalog__chip--amber",
};

function cloneSnapshot(snapshot: PluginSnapshot): PluginSnapshot {
  return {
    records: snapshot.records.map((record) => ({
      ...record,
      capabilities: [...record.capabilities],
      permissions: [...record.permissions],
      compatibility: [...record.compatibility],
      config: record.config.map((field) => field.options
        ? { ...field, options: [...field.options] }
        : { ...field }),
    })),
    favorites: [...snapshot.favorites],
    configValues: Object.fromEntries(Object.entries(snapshot.configValues).map(([id, values]) => [id, { ...values }])),
  };
}

function createInitialSnapshot(): PluginSnapshot {
  return {
    records: PLUGIN_SEED.map((record) => ({
      ...record,
      capabilities: [...record.capabilities],
      permissions: [...record.permissions],
      compatibility: [...record.compatibility],
      config: record.config.map((field) => field.options
        ? { ...field, options: [...field.options] }
        : { ...field }),
    })),
    favorites: ["plugin-git-workbench", "plugin-citation-canvas"],
    configValues: Object.fromEntries(PLUGIN_SEED.map((record) => [record.id, Object.fromEntries(record.config.map((field) => [field.key, field.defaultValue]))])),
  };
}

export function serializePluginManifest(snapshot: PluginSnapshot, format: ManifestFormat): string {
  const payload = {
    schema: "omnia.plugin-catalog-preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    plugins: snapshot.records.map((record) => ({
      id: record.id,
      name: record.name,
      version: record.version,
      source: record.source,
      category: record.category,
      status: record.status,
      trust: record.trust,
      capabilities: record.capabilities,
      permissions: record.permissions,
      compatibility: record.compatibility,
      updateAvailable: record.updateAvailable,
      favorite: snapshot.favorites.includes(record.id),
      config: snapshot.configValues[record.id] ?? {},
    })),
  };
  if (format === "markdown") {
    return [
      "# Omnia plugin catalog preview",
      "",
      "> Renderer-local catalog snapshot. Package installation, process loading, permission grants, and provider injection are not performed.",
      "",
      ...snapshot.records.map((record) => `- **${record.name}** v${record.version} · ${record.category} · ${record.status} · ${record.trust}`),
    ].join("\n");
  }
  return JSON.stringify(payload, null, 2);
}

function downloadManifest(payload: string, format: ManifestFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-plugin-catalog-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function Boundary({ children }: { readonly children: ReactNode }) {
  return <p className="plugin-catalog__boundary"><LockKeyhole size={14} /><span>{children}</span></p>;
}

function Metric({ icon, value, label }: { readonly icon: ReactNode; readonly value: string; readonly label: string }) {
  return <div className="plugin-catalog__metric"><span>{icon}</span><strong>{value}</strong><small>{label}</small></div>;
}

function actionFor(record: PluginRecord): { readonly label: string; readonly target?: PluginStatus; readonly kind: "install" | "enable" | "pause" | "review" } {
  if (record.status === "Available") return { label: "Install in preview", target: "Installed", kind: "install" };
  if (record.status === "Installed" && record.trust === "Unreviewed") return { label: "Review in preview", kind: "review" };
  if (record.status === "Installed") return { label: "Enable in preview", target: "Enabled", kind: "enable" };
  if (record.status === "Enabled") return { label: "Pause in preview", target: "Installed", kind: "pause" };
  return { label: "Review policy", kind: "review" };
}

export function PluginCatalogPreview() {
  const [snapshot, setSnapshot] = useState<PluginSnapshot>(createInitialSnapshot);
  const [history, setHistory] = useState<PluginHistory>({ past: [], future: [] });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PluginCategory | "all">("all");
  const [status, setStatus] = useState<PluginStatus | "all">("all");
  const [trust, setTrust] = useState<PluginTrust | "all">("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(PLUGIN_SEED[0]?.id ?? "");
  const [manifestOpen, setManifestOpen] = useState(false);
  const [manifestFormat, setManifestFormat] = useState<ManifestFormat>("json");
  const [notice, setNotice] = useState("Catalog is a renderer-local preview; no plugin process is running.");

  const records = snapshot.records;
  const selected = records.find((record) => record.id === selectedId) ?? records[0] ?? null;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return records.filter((record) => {
      const haystack = `${record.name} ${record.summary} ${record.source} ${record.category} ${record.capabilities.join(" ")} ${record.permissions.join(" ")}`.toLowerCase();
      return (!normalized || haystack.includes(normalized)) && (category === "all" || record.category === category) && (status === "all" || record.status === status) && (trust === "all" || record.trust === trust) && (!favoritesOnly || snapshot.favorites.includes(record.id));
    });
  }, [category, favoritesOnly, query, records, snapshot.favorites, status, trust]);
  const enabledCount = records.filter((record) => record.status === "Enabled").length;
  const updateCount = records.filter((record) => record.updateAvailable).length;
  const favoriteCount = snapshot.favorites.length;
  const manifestPayload = useMemo(() => serializePluginManifest(snapshot, manifestFormat), [manifestFormat, snapshot]);

  const announce = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? "Catalog is a renderer-local preview; no plugin process is running." : current), 2600);
  };

  const commit = (next: PluginSnapshot, message: string) => {
    setHistory((current) => ({ past: [...current.past, cloneSnapshot(snapshot)], future: [] }));
    setSnapshot(cloneSnapshot(next));
    announce(message);
  };

  const updateSelected = (updater: (record: PluginRecord) => PluginRecord, message: string) => {
    if (!selected) return;
    commit({ ...snapshot, records: records.map((record) => record.id === selected.id ? updater(record) : record) }, message);
  };

  const runAction = () => {
    if (!selected) return;
    const action = actionFor(selected);
    if (action.kind === "review") {
      announce(`${selected.name}: review is a local policy rehearsal; native trust and installation remain unchanged.`);
      return;
    }
    updateSelected((record) => ({ ...record, status: action.target ?? record.status }), `${selected.name}: ${action.target} is visible in preview only; no package was installed or loaded.`);
  };

  const toggleFavorite = () => {
    if (!selected) return;
    const favorites = snapshot.favorites.includes(selected.id) ? snapshot.favorites.filter((id) => id !== selected.id) : [...snapshot.favorites, selected.id];
    commit({ ...snapshot, favorites }, `${selected.name} ${favorites.includes(selected.id) ? "added to" : "removed from"} renderer-local favorites.`);
  };

  const setConfig = (key: string, value: string) => {
    if (!selected) return;
    commit({ ...snapshot, configValues: { ...snapshot.configValues, [selected.id]: { ...(snapshot.configValues[selected.id] ?? {}), [key]: value } } }, `${selected.name} · ${key} updated in the renderer preview.`);
  };

  const undo = () => {
    const previous = history.past[history.past.length - 1];
    if (!previous) return;
    setHistory((current) => ({ past: current.past.slice(0, -1), future: [cloneSnapshot(snapshot), ...current.future] }));
    setSnapshot(cloneSnapshot(previous));
    announce("Undid the last plugin catalog preview change.");
  };

  const redo = () => {
    const next = history.future[0];
    if (!next) return;
    setHistory((current) => ({ past: [...current.past, cloneSnapshot(snapshot)], future: current.future.slice(1) }));
    setSnapshot(cloneSnapshot(next));
    announce("Reapplied the next plugin catalog preview change.");
  };

  const reset = () => {
    commit(createInitialSnapshot(), "Reset plugin catalog, favorites, and config to seeded preview defaults.");
  };

  const copyManifest = async () => {
    if (!navigator.clipboard?.writeText) {
      announce("Clipboard is unavailable; manifest was not copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(manifestPayload);
      announce(`${manifestFormat.toUpperCase()} plugin manifest copied from the renderer preview.`);
    } catch {
      announce("Clipboard write failed; manifest was not copied.");
    }
  };

  return (
    <section className="plugin-catalog" aria-label="Plugin catalog preview">
      <header className="plugin-catalog__header">
        <span className="plugin-catalog__hero"><PackageSearch size={24} /></span>
        <div><span className="eyebrow">Composable extension layer</span><h2>Plugin Catalog</h2><p>Discover focused add-ons, inspect their declared effects, and rehearse configuration before native activation.</p></div>
        <span className="plugin-catalog__status"><Sparkles size={13} /> Preview only</span>
      </header>

      <div className="plugin-catalog__metrics" role="status" aria-label="Plugin catalog summary">
        <Metric icon={<PackageCheck size={14} />} value={`${records.length}`} label="catalog plugins" />
        <Metric icon={<Play size={14} />} value={`${enabledCount}`} label="enabled in preview" />
        <Metric icon={<Heart size={14} />} value={`${favoriteCount}`} label="favorites" />
        <Metric icon={<Sparkles size={14} />} value={`${updateCount}`} label="updates proposed" />
      </div>

      <div className="plugin-catalog__toolbar" role="toolbar" aria-label="Plugin catalog preview actions">
        <span><strong>Reversible catalog rehearsal</strong><small>{history.past.length} undo · {history.future.length} redo</small></span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length} aria-label="Undo plugin catalog preview change"><RotateCcw size={13} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length} aria-label="Redo plugin catalog preview change"><RotateCcw size={13} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset plugin catalog preview"><RotateCcw size={13} /> Reset</button>
        <button type="button" className="button button--secondary" onClick={() => setManifestOpen((current) => !current)} aria-expanded={manifestOpen} aria-controls="plugin-catalog-manifest"><FileJson2 size={13} /> {manifestOpen ? "Hide manifest" : "Preview manifest"}</button>
      </div>

      {notice ? <div className="plugin-catalog__notice" role="status" aria-live="polite"><Check size={14} /> {notice}</div> : null}

      {manifestOpen ? <section id="plugin-catalog-manifest" className="plugin-catalog__manifest" aria-label="Plugin catalog manifest preview">
        <header><div><span className="eyebrow">Renderer-local manifest</span><h3>Catalog snapshot · no native loading</h3></div><span className="plugin-catalog__chip plugin-catalog__chip--amber">Preview</span></header>
        <div className="plugin-catalog__manifest-toolbar" role="toolbar" aria-label="Plugin manifest actions">
          <label><span>Format</span><select value={manifestFormat} onChange={(event) => setManifestFormat(event.target.value as ManifestFormat)} aria-label="Plugin manifest format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
          <button type="button" className="button button--ghost" onClick={() => void copyManifest()}><Clipboard size={13} /> Copy</button>
          <button type="button" className="button button--secondary" onClick={() => { if (downloadManifest(manifestPayload, manifestFormat)) announce(`${manifestFormat.toUpperCase()} plugin manifest download started in the browser.`); else announce("Browser download is unavailable; manifest was not written."); }}><Download size={13} /> Download</button>
        </div>
        <pre className="plugin-catalog__manifest-code" tabIndex={0}><code>{manifestPayload}</code></pre>
        <Boundary>Export is a browser download/copy preview. It does not install packages, write workspace files, or create a native plugin receipt.</Boundary>
      </section> : null}

      <div className="plugin-catalog__filters">
        <label className="plugin-catalog__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins, capabilities, permissions" aria-label="Search plugins" />{query ? <button type="button" aria-label="Clear plugin search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
        <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value as PluginCategory | "all")} aria-label="Plugin category"><option value="all">All categories</option>{CATEGORY_OPTIONS.slice(1).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as PluginStatus | "all")} aria-label="Plugin status"><option value="all">All statuses</option>{STATUS_OPTIONS.slice(1).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <label><span>Trust</span><select value={trust} onChange={(event) => setTrust(event.target.value as PluginTrust | "all")} aria-label="Plugin trust"><option value="all">All trust</option>{TRUST_OPTIONS.slice(1).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <label className="plugin-catalog__toggle"><input type="checkbox" checked={favoritesOnly} onChange={(event) => setFavoritesOnly(event.target.checked)} /><span><Heart size={13} /> Favorites only</span></label>
        <button type="button" className="button button--ghost" onClick={() => { setQuery(""); setCategory("all"); setStatus("all"); setTrust("all"); setFavoritesOnly(false); }}><Filter size={14} /> Reset filters</button>
      </div>

      <div className="plugin-catalog__layout">
        <div className="plugin-catalog__list" role="list" aria-label="Plugin catalog">
          {filtered.length === 0 ? <div className="plugin-catalog__empty"><Search size={22} /><strong>No plugin matches</strong><span>Adjust the query or reset filters.</span></div> : null}
          {filtered.map((record) => <button key={record.id} type="button" role="listitem" aria-pressed={record.id === selected?.id} className={`plugin-catalog__card${record.id === selected?.id ? " plugin-catalog__card--selected" : ""}`} onClick={() => setSelectedId(record.id)}><span className="plugin-catalog__card-icon"><PackageSearch size={17} /></span><span className="plugin-catalog__card-copy"><strong>{record.name}</strong><small>{record.category} · v{record.version} · {record.source}</small><span><em className={statusTone[record.status]}>{record.status}</em><em className={trustTone[record.trust]}>{record.trust}</em>{record.updateAvailable ? <em className="plugin-catalog__chip plugin-catalog__chip--amber">Update</em> : null}</span></span><span className="plugin-catalog__card-favorite" aria-label={snapshot.favorites.includes(record.id) ? "Favorite plugin" : "Not a favorite plugin"}>{snapshot.favorites.includes(record.id) ? <Star size={14} fill="currentColor" /> : <Star size={14} />}</span></button>)}
        </div>

        <aside className="plugin-catalog__detail" aria-label="Selected plugin details">
          {selected ? <>
            <div className="plugin-catalog__detail-heading"><div><span className="eyebrow">Selected plugin</span><h3>{selected.name}</h3><small>{selected.category} · v{selected.version} · {selected.source}</small></div><span className={statusTone[selected.status]}>{selected.status}</span></div>
            <p className="plugin-catalog__summary">{selected.summary}</p>
            <div className="plugin-catalog__actions"><button type="button" className={actionFor(selected).kind === "review" ? "button button--secondary" : "button button--primary"} onClick={runAction}>{actionFor(selected).kind === "enable" ? <Play size={14} /> : actionFor(selected).kind === "pause" ? <Pause size={14} /> : actionFor(selected).kind === "review" ? <ShieldCheck size={14} /> : <PackageCheck size={14} />} {actionFor(selected).label}</button><button type="button" className="button button--ghost" onClick={toggleFavorite} aria-pressed={snapshot.favorites.includes(selected.id)}><Heart size={14} fill={snapshot.favorites.includes(selected.id) ? "currentColor" : "none"} /> {snapshot.favorites.includes(selected.id) ? "Favorited" : "Add favorite"}</button></div>
            <div className="plugin-catalog__facts"><div><span>Trust</span><strong>{selected.trust}</strong></div><div><span>Capabilities</span><strong>{selected.capabilities.length}</strong></div><div><span>Permissions</span><strong>{selected.permissions.length}</strong></div><div><span>Compatibility</span><strong>{selected.compatibility.length}</strong></div></div>
            <div className="plugin-catalog__section"><span className="eyebrow">Declared capabilities</span><div className="plugin-catalog__chips">{selected.capabilities.map((capability) => <span key={capability} className="plugin-catalog__chip"><Sparkles size={11} /> {capability}</span>)}</div></div>
            <div className="plugin-catalog__section"><span className="eyebrow">Requested permissions</span><div className="plugin-catalog__chips">{selected.permissions.map((permission) => <span key={permission} className="plugin-catalog__chip"><ShieldCheck size={11} /> {permission}</span>)}</div></div>
            <div className="plugin-catalog__section"><span className="eyebrow">Compatibility</span><div className="plugin-catalog__chips">{selected.compatibility.map((item) => <span key={item} className="plugin-catalog__chip plugin-catalog__chip--blue">{item}</span>)}</div></div>
            <div className="plugin-catalog__config"><div className="plugin-catalog__section-heading"><div><span className="eyebrow">Configuration rehearsal</span><h3>Shape defaults before activation</h3></div><SlidersHorizontal size={18} /></div>{selected.config.map((field) => <label key={field.key}><span>{field.label}<small>{field.description}</small></span><select value={snapshot.configValues[selected.id]?.[field.key] ?? field.defaultValue} onChange={(event) => setConfig(field.key, event.target.value)} aria-label={field.label}>{(field.options ?? [field.defaultValue]).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>)}<Boundary>Configuration values stay in this renderer session. They are not passed to a plugin process, provider request, filesystem write, or native permission evaluator.</Boundary></div>
            {selected.trust === "Unreviewed" ? <div className="plugin-catalog__review-note"><ShieldCheck size={14} /><span>Review is required before native activation. This preview can inspect the manifest, but it cannot grant trust.</span></div> : null}
          </> : <div className="plugin-catalog__empty"><PackageSearch size={22} /><strong>Select a plugin</strong><span>Its manifest and configuration preview will appear here.</span></div>}
        </aside>
      </div>
      <Boundary>Renderer preview only · renderer-local design preview. Discovery metadata, lifecycle buttons, favorites, and config values do not install packages, start processes, grant permissions, invoke providers, or create durable state.</Boundary>
    </section>
  );
}

export default PluginCatalogPreview;
