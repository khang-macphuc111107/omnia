import { Code2, Globe, MessageSquare, Settings, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { PRIMARY_SURFACE_VIEWS, primarySurfaceForView, type ShellView, type PrimarySurfaceView } from "./shell-view";

import "./activity-rail.css";

const ICONS: Record<PrimarySurfaceView, LucideIcon> = {
  agent: MessageSquare,
  code: Code2,
  browser: Globe,
};

interface RailHint {
  anchor: HTMLButtonElement;
  label: string;
  shortcut: string;
}

function RailTooltip({ hint, id, onEnter, onLeave }: {
  hint: RailHint;
  id: string;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!panel.current) return;
    const anchor = hint.anchor.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 8;
    const top = (viewport?.offsetTop ?? 0) + 8;
    const right = left + (viewport?.width ?? window.innerWidth) - 16;
    const bottom = top + (viewport?.height ?? window.innerHeight) - 16;
    const bounds = panel.current.getBoundingClientRect();
    // The primary nav is horizontal, so keep hints below the button. The
    // viewport clamps the panel for narrow windows and right-to-left layouts.
    setPosition({
      left: Math.max(left, Math.min(anchor.left + (anchor.width - bounds.width) / 2, right - bounds.width)),
      top: Math.max(top, Math.min(anchor.bottom + 8, bottom - bounds.height)),
    });
  }, [hint]);

  return createPortal(
    <div ref={panel} id={id} role="tooltip" className="ag-rail__tooltip" style={position}
      onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <span>{hint.label}</span><kbd>{hint.shortcut}</kbd>
    </div>,
    document.body,
  );
}

export interface ActivityRailProps {
  view: ShellView;
  onNavigate: (view: ShellView) => void;
  /** Opens the Settings dialog; the only Settings entry point besides Ctrl+, and the palette. */
  onOpenSettings: () => void;
}

/**
 * The stable shell navigation. Internal Chat routes (projects, work, library,
 * memory and skills) intentionally share the Chat button so the top-level
 * chrome stays predictable while those routes remain addressable.
 */
export function ActivityRail({ view, onNavigate, onOpenSettings }: ActivityRailProps) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [hint, setHint] = useState<RailHint | null>(null);
  const hintId = useId();
  const hovered = useRef(false);
  const focused = useRef<HTMLButtonElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHide = useCallback(() => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);
  const dismissHint = useCallback(() => {
    cancelHide();
    setHint(null);
  }, [cancelHide]);
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => {
      if (!hovered.current && !focused.current) setHint(null);
      hideTimer.current = null;
    }, 120);
  };
  const showHint = (anchor: HTMLButtonElement, label: string, shortcut: string) => {
    cancelHide();
    setHint({ anchor, label, shortcut });
  };
  useEffect(() => cancelHide, [cancelHide]);
  useEffect(() => {
    if (!hint) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        dismissHint();
      }
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", dismissHint);
    document.addEventListener("scroll", dismissHint, true);
    window.visualViewport?.addEventListener("resize", dismissHint);
    window.visualViewport?.addEventListener("scroll", dismissHint);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", dismissHint);
      document.removeEventListener("scroll", dismissHint, true);
      window.visualViewport?.removeEventListener("resize", dismissHint);
      window.visualViewport?.removeEventListener("scroll", dismissHint);
    };
  }, [hint, dismissHint]);
  const primaryView = primarySurfaceForView(view);
  const activeIndex = Math.max(0, PRIMARY_SURFACE_VIEWS.findIndex((entry) => entry.id === primaryView));
  // Roving tabindex: one tab stop, which follows arrow-key focus and resets to the active surface.
  const [focusIndex, setFocusIndex] = useState(activeIndex);
  useEffect(() => setFocusIndex(activeIndex), [activeIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = PRIMARY_SURFACE_VIEWS.length;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % count;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    buttons.current[next]?.focus();
  };

  return (
    <nav className="ag-rail" aria-label="Primary" data-tauri-drag-region>
      {PRIMARY_SURFACE_VIEWS.map((entry, index) => {
        const Icon = ICONS[entry.id];
        const active = entry.id === primaryView;
        return (
          <button
            key={entry.id}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            className={`ag-rail__btn${active ? " ag-rail__btn--active" : ""}`}
            aria-label={entry.label}
            aria-keyshortcuts={entry.shortcut}
            aria-describedby={hint?.anchor === buttons.current[index] ? hintId : undefined}
            aria-current={active ? "page" : undefined}
            tabIndex={index === focusIndex ? 0 : -1}
            onFocus={(event) => {
              focused.current = event.currentTarget;
              setFocusIndex(index);
              showHint(event.currentTarget, entry.label, entry.shortcut);
            }}
            onBlur={() => { focused.current = null; scheduleHide(); }}
            onMouseEnter={(event) => {
              hovered.current = true;
              showHint(event.currentTarget, entry.label, entry.shortcut);
            }}
            onMouseLeave={() => { hovered.current = false; scheduleHide(); }}
            onClick={() => { dismissHint(); onNavigate(entry.id); }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className="ag-rail__label">{entry.label}</span>
          </button>
        );
      })}
      <span className="ag-rail__spacer" data-tauri-drag-region />
      <button
        type="button"
        className="ag-rail__btn ag-rail__settings"
        aria-label="Settings"
        aria-keyshortcuts="Control+,"
        aria-describedby={hint?.label === "Settings" ? hintId : undefined}
        onFocus={(event) => {
          focused.current = event.currentTarget;
          showHint(event.currentTarget, "Settings", "Ctrl+,");
        }}
        onBlur={() => { focused.current = null; scheduleHide(); }}
        onMouseEnter={(event) => {
          hovered.current = true;
          showHint(event.currentTarget, "Settings", "Ctrl+,");
        }}
        onMouseLeave={() => { hovered.current = false; scheduleHide(); }}
        onClick={() => { dismissHint(); onOpenSettings(); }}
      >
        <Settings size={18} strokeWidth={1.75} aria-hidden="true" />
        <span className="ag-rail__label">Settings</span>
      </button>
      {hint ? <RailTooltip hint={hint} id={hintId}
        onEnter={() => { hovered.current = true; cancelHide(); }}
        onLeave={() => { hovered.current = false; scheduleHide(); }} /> : null}
    </nav>
  );
}
