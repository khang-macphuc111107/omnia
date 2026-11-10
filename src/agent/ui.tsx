import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { ModalSurface } from "@/components/modal-surface";

const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

function focusableItems(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter((item) =>
    item.tabIndex >= 0 && !item.closest('[hidden], [inert], [aria-hidden="true"]') &&
    getComputedStyle(item).display !== "none" && getComputedStyle(item).visibility !== "hidden",
  );
}

/** A non-modal floating panel, kept inside the viewport and outside clipping ancestors. */
export function Popover({
  label,
  trigger,
  className = "",
  placement = "up",
  children,
  onOpen,
}: {
  label: string;
  trigger: ReactNode;
  className?: string;
  placement?: "up" | "down";
  children: (close: () => void) => ReactNode;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ position: "fixed", left: 8, top: 8 });
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      if (!button.current || !panel.current) return;
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 8;
      const top = (viewport?.offsetTop ?? 0) + 8;
      const width = Math.max(0, (viewport?.width ?? window.innerWidth) - 16);
      const height = Math.max(0, (viewport?.height ?? window.innerHeight) - 16);
      const anchor = (root.current?.closest(".ag-composer") ?? button.current).getBoundingClientRect();
      const above = Math.max(0, anchor.top - top - 6);
      const below = Math.max(0, top + height - anchor.bottom - 6);
      const desiredHeight = Math.min(panel.current.scrollHeight, height);
      const up = placement === "up" ? above >= desiredHeight || above >= below : below < desiredHeight && above > below;
      const available = Math.min(height, up ? above : below);
      const panelWidth = Math.min(width, Math.max(240, root.current?.closest(".ag-composer") ? anchor.width : panel.current.scrollWidth));
      setPosition({
        position: "fixed", left: Math.max(left, Math.min(placement === "down" ? anchor.right - panelWidth : anchor.left, left + width - panelWidth)),
        top: Math.min(top + height - Math.min(desiredHeight, available), up ? Math.max(top, anchor.top - 6 - Math.min(desiredHeight, available)) : Math.max(top, anchor.bottom + 6)),
        right: "auto", bottom: "auto", width: panelWidth, minWidth: 0, maxWidth: width,
        maxHeight: available, boxSizing: "border-box", overflow: "auto", overflowWrap: "anywhere", zIndex: 1100,
        fontFamily: "var(--font-ui)", color: "var(--text)",
      });
    };
    updatePosition();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    observer?.observe(panel.current!);
    if (root.current) observer?.observe(root.current);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const contains = (target: EventTarget | null) => target instanceof Node &&
      (root.current?.contains(target) || panel.current?.contains(target));
    const onDown = (event: Event) => {
      if (!contains(event.target)) setOpen(false);
    };
    const onFocus = (event: FocusEvent) => {
      if (!contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !contains(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    // Preserve an input's own autofocus, otherwise enter the panel for keyboard use.
    if (panel.current && !panel.current.contains(document.activeElement)) {
      (focusableItems(panel.current)[0] ?? panel.current).focus();
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openPanel = () => {
    onOpen?.();
    setOpen(true);
  };

  return (
    <span className="ag-popover" ref={root} style={{ minWidth: 0, maxWidth: "100%" }}>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label}
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        style={{ maxWidth: "100%" }}
        onClick={() => { if (open) close(); else openPanel(); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) openPanel();
            else if (panel.current) (focusableItems(panel.current)[0] ?? panel.current).focus();
          }
        }}
      >
        {trigger}
      </button>
      {open ? createPortal(
        <div
          ref={panel}
          id={panelId}
          className={`ag-popover__panel ag-popover__panel--${placement}`}
          style={position}
          role="group"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={(event) => {
            const target = event.target as HTMLElement;
            if (event.key === "Tab" && panel.current) {
              const items = focusableItems(panel.current);
              const boundary = event.shiftKey ? items[0] : items.at(-1);
              // The portal is outside a parent dialog's DOM focus trap.
              event.stopPropagation();
              if (target === boundary || target === panel.current) {
                event.preventDefault();
                const scope = button.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
                const sequence = focusableItems(scope).filter((item) => !panel.current?.contains(item));
                const index = sequence.indexOf(button.current!);
                const next = event.shiftKey ? button.current : sequence[index + 1] ?? sequence[0];
                setOpen(false);
                next?.focus();
              }
              return;
            }
            if (!target.matches('[role^="menuitem"]') || !panel.current) return;
            const items = focusableItems(panel.current).filter((item) => item.matches('[role^="menuitem"]'));
            const index = items.indexOf(target);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
              event.key === "ArrowDown" ? (index + 1) % items.length :
                event.key === "ArrowUp" ? (index - 1 + items.length) % items.length : -1;
            if (next < 0) return;
            event.preventDefault();
            items[next]?.focus();
          }}
        >
          <style>{`.ag-popover__panel :is(.ag-menu__item, .ag-btn, .ag-label) { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; } .ag-popover__panel .ag-menu__item > * { min-width: 0; } .ag-popover__panel .ag-input { min-width: 0; max-width: 100%; box-sizing: border-box; }`}</style>
          {children(close)}
        </div>, document.body,
      ) : null}
    </span>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalSurface className="ag-dialog ag-dialog--small ag-confirm-dialog" scrimClassName="ag-scrim" title={title} description={body} onClose={onCancel}>
      <style>{`.ag-confirm-dialog { box-sizing: border-box; min-width: 0; max-width: 100%; max-height: calc(100dvh - 32px); } .ag-confirm-dialog :is(.ag-dialog__title, .ag-muted, .ag-btn) { overflow-wrap: anywhere; white-space: normal; min-width: 0; max-width: 100%; }`}</style>
      <h2 className="ag-dialog__title">{title}</h2>
      <p className="ag-muted">{body}</p>
      <div className="ag-dialog__actions">
        <button type="button" className="ag-btn" onClick={onCancel} data-dialog-initial-focus>
          Cancel
        </button>
        <button type="button" className="ag-btn ag-btn--danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </ModalSurface>
  );
}
