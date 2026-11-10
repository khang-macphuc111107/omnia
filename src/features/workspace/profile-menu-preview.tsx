import {
  Check,
  ChevronRight,
  Download,
  Keyboard,
  LockKeyhole,
  LogOut,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";

import { selectableModelProfiles } from "./provider-catalog";
import { useWorkspaceStore } from "./store";

const LazyKeyboardShortcutsDialog = lazy(() =>
  import("./keyboard-shortcuts-dialog").then((module) => ({ default: module.KeyboardShortcutsDialog })),
);

const PROFILE_NAME = "Khang";
const PROFILE_EMAIL = "Personal workspace";
const COLOR_THEME_STORAGE_KEY = "omnia.sovereign.palette.v1";
const COLOR_THEMES = [
  { id: "vscode-dark", label: "VS Code Dark+" },
  { id: "dark", label: "Dark" },
  { id: "tokyo-night", label: "Tokyo Night" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
] as const;

type ColorThemeId = (typeof COLOR_THEMES)[number]["id"];

function readColorTheme(): ColorThemeId {
  try {
    const saved = globalThis.localStorage?.getItem(COLOR_THEME_STORAGE_KEY);
    if (COLOR_THEMES.some((theme) => theme.id === saved)) return saved as ColorThemeId;
  } catch {
    // Restricted storage falls back to the original default palette.
  }
  return "vscode-dark";
}

function preferenceForColorTheme(theme: ColorThemeId): "system" | "light" | "dark" {
  if (theme === "system") return "system";
  if (theme === "light") return "light";
  return "dark";
}

function applyColorThemeAttribute(theme: ColorThemeId) {
  if (typeof document !== "undefined") {
    if (theme === "system") {
      delete document.documentElement.dataset.swPalette;
    } else {
      document.documentElement.dataset.swPalette = theme;
    }
  }
  try {
    globalThis.localStorage?.setItem(COLOR_THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

export function ProfileMenuPreview() {
  const activeActivity = useWorkspaceStore((state) => state.activeActivity);
  const setActivity = useWorkspaceStore((state) => state.setActivity);
  const theme = useWorkspaceStore((state) => state.theme);
  const setTheme = useWorkspaceStore((state) => state.setTheme);
  const providers = useWorkspaceStore((state) => state.providers);
  const modelProfileId = useWorkspaceStore((state) => state.modelProfileId);
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [colorTheme, setColorTheme] = useState<ColorThemeId>(readColorTheme);
  const [status, setStatus] = useState("Renderer-local session controls only.");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const profiles = useMemo(() => selectableModelProfiles(providers), [providers]);
  const activeModel = profiles.find((profile) => profile.id === modelProfileId) ?? profiles[0];
  const selectedColorTheme: ColorThemeId =
    theme === "dark" && (colorTheme === "vscode-dark" || colorTheme === "tokyo-night")
      ? colorTheme
      : theme;

  useEffect(() => {
    applyColorThemeAttribute(selectedColorTheme);
  }, [selectedColorTheme]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("[data-profile-menu-focus]")?.focus());
  }, [open]);

  const closeAndFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openSettings = () => {
    setActivity("settings");
    setStatus("Settings opened. Category selection remains in the Settings workspace.");
    closeAndFocus();
  };

  const toggleLock = () => {
    setLocked((current) => {
      const next = !current;
      setStatus(next ? "Session lock preview enabled for this renderer session." : "Session lock preview disabled.");
      return next;
    });
  };

  const selectColorTheme = (nextTheme: ColorThemeId) => {
    setColorTheme(nextTheme);
    setTheme(preferenceForColorTheme(nextTheme));
    applyColorThemeAttribute(nextTheme);
    setStatus((COLOR_THEMES.find((option) => option.id === nextTheme)?.label ?? nextTheme) + " theme selected.");
  };

  const openShortcuts = () => {
    setStatus("Keyboard shortcuts opened.");
    setOpen(false);
    setShortcutsOpen(true);
  };

  const openDownloads = () => {
    if (typeof window !== "undefined") {
      (window as Window & { __OMNIA_PENDING_WORKBENCH__?: string }).__OMNIA_PENDING_WORKBENCH__ = "idm-downloader";
      window.dispatchEvent(
        new CustomEvent("omnia:open-sovereign-workbench", { detail: { workbenchId: "idm-downloader" } }),
      );
    }
    setStatus("Ultra IDM+ downloads opened.");
    setActivity("library");
    closeAndFocus();
  };

  return (
    <div className="profile-menu-preview">
      <button
        ref={triggerRef}
        type="button"
        className={open ? "avatar-button avatar-button--active" : "avatar-button"}
        aria-label={PROFILE_NAME + " profile menu"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={PROFILE_NAME + " · " + PROFILE_EMAIL}
        onClick={() => setOpen((current) => !current)}
      >
        KH
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} className="profile-menu" role="menu" aria-label="Profile menu">
          <header className="profile-menu__header">
            <span className="profile-menu__avatar" aria-hidden="true">KH</span>
            <span>
              <strong>{PROFILE_NAME}</strong>
              <small>{PROFILE_EMAIL}</small>
            </span>
          </header>

          <div className="profile-menu__model" aria-label="Current model profile">
            <span className="profile-menu__model-icon"><Sparkles size={14} aria-hidden="true" /></span>
            <span>
              <small>Current model</small>
              <strong>{activeModel?.displayName ?? "Auto route"}</strong>
              <em>{activeModel?.providerName ?? "Provider selected at run time"}</em>
            </span>
            <span className="profile-menu__model-state">{activeModel?.status === "available" ? "Ready" : "Unknown"}</span>
          </div>

          <div className="profile-menu__section-label">Color theme</div>
          <div className="profile-menu__themes" role="group" aria-label="Color theme">
            {COLOR_THEMES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={selectedColorTheme === id}
                aria-label={label}
                data-color-theme={id}
                className={selectedColorTheme === id ? "profile-menu__theme profile-menu__theme--active" : "profile-menu__theme"}
                title={"Use " + label + " theme"}
                onClick={() => selectColorTheme(id)}
              >
                <span aria-hidden="true" />
                {label}
                {selectedColorTheme === id ? <Check size={12} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>

          <div className="profile-menu__section-label">Workspace</div>
          <button type="button" role="menuitem" data-profile-menu-focus className="profile-menu__item" title="Open Settings and provider controls" onClick={openSettings}>
            <Settings2 size={15} aria-hidden="true" />
            <span><strong>Settings &amp; providers</strong><small>Appearance, routing, permissions, diagnostics</small></span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          <button type="button" role="menuitem" className="profile-menu__item" title="Profile preferences are planned for the next renderer phase" onClick={() => { setStatus("Profile preferences are ready to customize in the next profile phase."); }}>
            <SlidersHorizontal size={15} aria-hidden="true" />
            <span><strong>Profile preferences</strong><small>Generation defaults and personal presets</small></span>
            <span className="profile-menu__planned">Planned</span>
          </button>
          <button type="button" role="menuitem" className="profile-menu__item" title="Open the Privacy & memory preview in Settings" onClick={() => { setStatus("Privacy & memory preview is available in Settings."); openSettings(); }}>
            <ShieldCheck size={15} aria-hidden="true" />
            <span><strong>Privacy &amp; memory</strong><small>Review renderer-safe retention and memory proposals</small></span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>

          <div className="profile-menu__section-label">Quick actions</div>
          <button type="button" role="menuitem" className="profile-menu__item" title="Open the keyboard shortcuts reference" onClick={openShortcuts}>
            <Keyboard size={15} aria-hidden="true" />
            <span><strong>Keyboard shortcuts</strong><small>View and customize available shortcuts</small></span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          <button type="button" role="menuitem" className="profile-menu__item" title="Open Ultra IDM+ downloads" onClick={openDownloads}>
            <Download size={15} aria-hidden="true" />
            <span><strong>Downloads (Ultra IDM+)</strong><small>Open the local download manager</small></span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>

          <div className="profile-menu__section-label">Session</div>
          <button type="button" role="menuitemcheckbox" aria-checked={locked} className="profile-menu__item" title={locked ? "Unlock this renderer-local session preview" : "Lock this renderer-local session preview"} onClick={toggleLock}>
            <LockKeyhole size={15} aria-hidden="true" />
            <span><strong>Lock session</strong><small>Keep the local preview state behind an explicit action</small></span>
            <span className={locked ? "profile-menu__check profile-menu__check--active" : "profile-menu__check"}>{locked ? <Check size={13} aria-hidden="true" /> : ""}</span>
          </button>
          <button type="button" role="menuitem" className="profile-menu__item profile-menu__item--muted" disabled title="Native account sign-out is not available in the renderer preview.">
            <LogOut size={15} aria-hidden="true" />
            <span><strong>Sign out</strong><small>Native account boundary is unavailable</small></span>
            <span className="profile-menu__planned">Unavailable</span>
          </button>

          <footer className="profile-menu__footer">
            <span className={activeActivity === "settings" ? "profile-menu__footer-dot profile-menu__footer-dot--active" : "profile-menu__footer-dot"} aria-hidden="true" />
            <span role="status" aria-live="polite">{status}</span>
          </footer>
        </div>
      ) : null}
      {shortcutsOpen ? (
        <Suspense fallback={null}>
          <LazyKeyboardShortcutsDialog onClose={() => setShortcutsOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
