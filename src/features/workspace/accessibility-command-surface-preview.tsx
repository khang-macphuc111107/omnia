import {
  Accessibility,
  ArrowDown,
  ArrowUp,
  Check,
  Command,
  Contrast,
  CornerDownLeft,
  Eye,
  Focus,
  Keyboard,
  Search,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  Zap,
} from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";

import "@/styles/accessibility-command-surface-preview.css";

type CommandCategory = "Navigation" | "Chat" | "Workspace" | "Display";
type ProfileId = "balanced" | "keyboard-first" | "low-vision" | "low-motion";
type AnnouncementMode = "concise" | "detailed" | "off";

interface SurfaceCommand {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly category: CommandCategory;
  readonly shortcut: string;
}

const COMMANDS: readonly SurfaceCommand[] = [
  { id: "new-chat", label: "Start a new Chat", detail: "Create a fresh conversation", category: "Chat", shortcut: "Ctrl K, N" },
  { id: "search-chat", label: "Search Chats and messages", detail: "Find a conversation or exact message", category: "Chat", shortcut: "Ctrl K" },
  { id: "open-projects", label: "Open Projects", detail: "Browse project workspaces", category: "Navigation", shortcut: "Alt 2" },
  { id: "open-settings", label: "Open Settings", detail: "Configure Omnia for this workspace", category: "Navigation", shortcut: "Ctrl ," },
  { id: "toggle-sidebar", label: "Toggle sidebar", detail: "Show or hide primary navigation", category: "Workspace", shortcut: "Ctrl B" },
  { id: "increase-text", label: "Increase interface text", detail: "Preview a larger reading scale", category: "Display", shortcut: "Ctrl +" },
  { id: "reduce-motion", label: "Reduce interface motion", detail: "Prefer calmer transitions", category: "Display", shortcut: "—" },
  { id: "focus-composer", label: "Focus Chat composer", detail: "Move keyboard focus to the message editor", category: "Chat", shortcut: "Alt Enter" },
];

const CATEGORIES: readonly (CommandCategory | "All")[] = ["All", "Navigation", "Chat", "Workspace", "Display"];

const PROFILE_LABELS: Record<ProfileId, string> = {
  balanced: "Balanced",
  "keyboard-first": "Keyboard first",
  "low-vision": "Low vision",
  "low-motion": "Low motion",
};

function applyProfile(profile: ProfileId) {
  switch (profile) {
    case "keyboard-first":
      return { textScale: 108, highContrast: false, reduceMotion: false, strongFocus: true, announcements: "detailed" as const };
    case "low-vision":
      return { textScale: 120, highContrast: true, reduceMotion: false, strongFocus: true, announcements: "detailed" as const };
    case "low-motion":
      return { textScale: 108, highContrast: false, reduceMotion: true, strongFocus: true, announcements: "concise" as const };
    default:
      return { textScale: 100, highContrast: false, reduceMotion: false, strongFocus: false, announcements: "concise" as const };
  }
}

export default function AccessibilityCommandSurfacePreview() {
  const [profile, setProfile] = useState<ProfileId>("balanced");
  const [textScale, setTextScale] = useState(100);
  const [highContrast, setHighContrast] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [strongFocus, setStrongFocus] = useState(false);
  const [announcements, setAnnouncements] = useState<AnnouncementMode>("concise");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [status, setStatus] = useState("Preview controls are local to this panel.");

  const visibleCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return COMMANDS.filter((command) => {
      const categoryMatch = category === "All" || command.category === category;
      const queryMatch = !normalized || `${command.label} ${command.detail} ${command.category} ${command.shortcut}`.toLowerCase().includes(normalized);
      return categoryMatch && queryMatch;
    });
  }, [category, query]);

  const selectProfile = (next: ProfileId) => {
    const settings = applyProfile(next);
    setProfile(next);
    setTextScale(settings.textScale);
    setHighContrast(settings.highContrast);
    setReduceMotion(settings.reduceMotion);
    setStrongFocus(settings.strongFocus);
    setAnnouncements(settings.announcements);
    setStatus(`${PROFILE_LABELS[next]} profile applied to this renderer preview.`);
  };

  const updateCustomSetting = (message: string) => {
    setProfile("balanced");
    setStatus(`${message} · renderer preview only.`);
  };

  return (
    <section className="accessibility-command-surface" aria-labelledby="accessibility-command-surface-title">
      <header className="accessibility-command-surface__header">
        <div className="accessibility-command-surface__title">
          <span className="accessibility-command-surface__eyebrow"><Accessibility size={14} /> Omnia interaction design</span>
          <h2 id="accessibility-command-surface-title">Accessibility &amp; Command Surface</h2>
          <p>Tune keyboard access, readable controls, and command discovery, then inspect the result in a live sample.</p>
        </div>
        <span className="accessibility-command-surface__badge">Preview only</span>
      </header>

      <div className="accessibility-command-surface__profile-row">
        <div className="accessibility-command-surface__section-label"><Sparkles size={15} /><span><strong>Starting profile</strong><small>Choose a baseline, then adjust each control independently.</small></span></div>
        <label className="accessibility-command-surface__select-label">
          <span className="sr-only">Accessibility profile</span>
          <select aria-label="Accessibility profile" value={profile} onChange={(event) => selectProfile(event.target.value as ProfileId)}>
            {Object.entries(PROFILE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      <div className="accessibility-command-surface__grid">
        <section className="accessibility-command-surface__card accessibility-command-surface__controls" aria-labelledby="accessibility-controls-title">
          <div className="accessibility-command-surface__card-heading">
            <div className="accessibility-command-surface__icon"><SlidersHorizontal size={16} /></div>
            <div><h3 id="accessibility-controls-title">Comfort &amp; access</h3><p>Adjust the visual and assistive presentation.</p></div>
          </div>

          <label className="accessibility-command-surface__range-row" htmlFor="accessibility-text-scale">
            <span className="accessibility-command-surface__setting-copy"><span><Eye size={14} /> Interface text scale</span><small>Scales this preview's labels and reading sample.</small></span>
            <span className="accessibility-command-surface__range-control"><input id="accessibility-text-scale" type="range" min="90" max="130" step="5" value={textScale} aria-describedby="accessibility-text-scale-value" onChange={(event) => { setTextScale(Number(event.target.value)); updateCustomSetting("Text scale updated"); }} /><span id="accessibility-text-scale-value" className="accessibility-command-surface__range-value">{textScale}%</span></span>
          </label>

          <label className="accessibility-command-surface__setting-row" htmlFor="accessibility-high-contrast">
            <span className="accessibility-command-surface__setting-copy"><span><Contrast size={14} /> Strong contrast preview</span><small>Emphasize control boundaries and important text.</small></span>
            <input id="accessibility-high-contrast" className="accessibility-command-surface__switch" type="checkbox" checked={highContrast} onChange={(event) => { setHighContrast(event.target.checked); updateCustomSetting(event.target.checked ? "Strong contrast enabled" : "Strong contrast disabled"); }} />
          </label>

          <label className="accessibility-command-surface__setting-row" htmlFor="accessibility-strong-focus">
            <span className="accessibility-command-surface__setting-copy"><span><Focus size={14} /> High-visibility focus ring</span><small>Make the keyboard focus target easier to track.</small></span>
            <input id="accessibility-strong-focus" className="accessibility-command-surface__switch" type="checkbox" checked={strongFocus} onChange={(event) => { setStrongFocus(event.target.checked); updateCustomSetting(event.target.checked ? "High-visibility focus enabled" : "High-visibility focus disabled"); }} />
          </label>

          <label className="accessibility-command-surface__setting-row" htmlFor="accessibility-reduce-motion">
            <span className="accessibility-command-surface__setting-copy"><span><Zap size={14} /> Reduce motion</span><small>Use calm transitions in the sample surface.</small></span>
            <input id="accessibility-reduce-motion" className="accessibility-command-surface__switch" type="checkbox" checked={reduceMotion} onChange={(event) => { setReduceMotion(event.target.checked); updateCustomSetting(event.target.checked ? "Reduced motion enabled" : "Reduced motion disabled"); }} />
          </label>

          <label className="accessibility-command-surface__setting-row" htmlFor="accessibility-announcement-mode">
            <span className="accessibility-command-surface__setting-copy"><span><Volume2 size={14} /> Status announcements</span><small>Controls the sample feedback detail level.</small></span>
            <select id="accessibility-announcement-mode" value={announcements} onChange={(event) => { setAnnouncements(event.target.value as AnnouncementMode); updateCustomSetting("Announcement preference updated"); }}>
              <option value="concise">Concise</option><option value="detailed">Detailed</option><option value="off">Off in preview</option>
            </select>
          </label>
          <p className="accessibility-command-surface__note"><Keyboard size={13} /> Browser and desktop assistive settings are not changed by these preview controls.</p>
        </section>

        <section className="accessibility-command-surface__card accessibility-command-surface__commands" aria-labelledby="command-discovery-title">
          <div className="accessibility-command-surface__card-heading">
            <div className="accessibility-command-surface__icon accessibility-command-surface__icon--teal"><Command size={16} /></div>
            <div><h3 id="command-discovery-title">Command discovery</h3><p>Search visible actions by name, area, or shortcut.</p></div>
            <kbd>Ctrl K</kbd>
          </div>
          <label className="accessibility-command-surface__search"><Search size={15} aria-hidden="true" /><span className="sr-only">Find a command</span><input type="search" placeholder="Find an action…" aria-label="Find a command" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>/</kbd></label>
          <div className="accessibility-command-surface__categories" role="tablist" aria-label="Command categories">
            {CATEGORIES.map((item) => <button key={item} type="button" role="tab" aria-selected={category === item} onClick={() => setCategory(item)}>{item}</button>)}
          </div>
          <div className="accessibility-command-surface__command-list" role="list" aria-label="Available preview commands">
            {visibleCommands.map((command) => <div className="accessibility-command-surface__command-item" key={command.id} role="listitem">
              <button className="accessibility-command-surface__command" type="button" onClick={() => setStatus(`“${command.label}” selected · no navigation or native command executed.`)}>
                <span className="accessibility-command-surface__command-icon"><CornerDownLeft size={14} /></span>
                <span className="accessibility-command-surface__command-copy"><strong>{command.label}</strong><small>{command.detail}</small></span>
                <kbd>{command.shortcut}</kbd>
              </button>
            </div>)}
            {visibleCommands.length === 0 ? <p className="accessibility-command-surface__empty" role="status">No commands match. Try another phrase or category.</p> : null}
          </div>
        </section>

        <section className={`accessibility-command-surface__card accessibility-command-surface__live${highContrast ? " is-high-contrast" : ""}${strongFocus ? " is-strong-focus" : ""}${reduceMotion ? " is-reduced-motion" : ""}`} aria-labelledby="accessibility-live-preview-title" style={{ "--accessibility-text-scale": `${textScale}%` } as CSSProperties}>
          <div className="accessibility-command-surface__card-heading">
            <div className="accessibility-command-surface__icon accessibility-command-surface__icon--amber"><Eye size={16} /></div>
            <div><h3 id="accessibility-live-preview-title">Live interaction sample</h3><p>Keyboard path, visible focus, and announcement feedback.</p></div>
          </div>
          <div className="accessibility-command-surface__sample-window">
            <div className="accessibility-command-surface__sample-topline"><span><i /> Omnia Chat</span><kbd>Alt 1</kbd></div>
            <div className="accessibility-command-surface__sample-body">
              <span className="accessibility-command-surface__sample-eyebrow">Current conversation</span>
              <strong>Plan the next focused change</strong>
              <p>Keep the interface clear, keyboard-friendly, and easy to scan.</p>
              <button type="button" className="accessibility-command-surface__sample-action" onClick={() => setStatus("Sample action focused and activated locally; no message was sent.")}><Check size={14} /> Review next step <span>Enter</span></button>
              <label className="accessibility-command-surface__sample-input"><span className="sr-only">Sample Chat message</span><input placeholder="Write a message…" aria-label="Sample Chat message" onFocus={() => setStatus("Sample composer focused.")} /><kbd>Alt Enter</kbd></label>
            </div>
          </div>
          <div className="accessibility-command-surface__keyboard-hint"><ArrowUp size={13} /><ArrowDown size={13} /><span>Move through actions</span><CornerDownLeft size={13} /><span>Activate</span><span className="accessibility-command-surface__focus-dot" />{strongFocus ? "Focus ring emphasized" : "Focus ring preview"}</div>
        </section>
      </div>

      <p className="accessibility-command-surface__status" role="status" aria-live={announcements === "off" ? "off" : "polite"} aria-atomic="true">{announcements === "detailed" ? `${status} Settings remain temporary and renderer-local.` : status}</p>
      <p className="accessibility-command-surface__boundary">Renderer-local preview · no OS setting, persisted preference, command dispatch, provider request, or native receipt is changed.</p>
    </section>
  );
}
