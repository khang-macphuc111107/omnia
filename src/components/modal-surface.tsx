import { createPortal } from "react-dom";
import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";

const activeModalStack: symbol[] = [];
const MODAL_PORTAL_ID = "omnia-modal-portal";

function getModalPortalHost(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(MODAL_PORTAL_ID);
  if (existing) return existing;

  const host = document.createElement("div");
  host.id = MODAL_PORTAL_ID;
  document.body.appendChild(host);
  return host;
}

function shouldPortalModal(): boolean {
  // Vitest's jsdom tests intentionally clear body contents between cases.
  // Rendering in place there keeps RTL's `screen` queries and React's cleanup
  // deterministic; the browser/desktop renderer always uses the body portal.
  return typeof navigator === "undefined" || !/jsdom/i.test(navigator.userAgent);
}

const focusableSelector = [
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  "area[href]",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "summary",
  "[contenteditable]",
  "[tabindex]",
].join(", ");

function isEditable(element: Element | null): boolean {
  for (let current = element; current; current = current.parentElement) {
    const value = current.getAttribute("contenteditable")?.toLowerCase();
    if (value === "false") return false;
    if (value === "" || value === "true" || value === "plaintext-only") return true;
  }
  return false;
}

function firstSummary(details: Element): Element | undefined {
  return Array.from(details.children).find((child) => child.tagName === "SUMMARY");
}

function tabOrder(element: HTMLElement): number {
  // Explicit tabindex takes precedence, including a negative opt-out. Some
  // implicitly tabbable controls report -1 through the DOM tabIndex getter.
  if (element.hasAttribute("tabindex")) return element.tabIndex;
  if (element.tagName === "SUMMARY") {
    const details = element.parentElement;
    return details?.tagName === "DETAILS" && firstSummary(details) === element ? 0 : -1;
  }
  if (element.matches("audio[controls], video[controls]")) return 0;
  if (element.tabIndex < 0 && isEditable(element) && !isEditable(element.parentElement)) return 0;
  return element.tabIndex;
}

function isFocusable(element: HTMLElement, container: HTMLElement): boolean {
  if (tabOrder(element) < 0 || element.matches(':disabled, input[type="hidden"]')) return false;
  for (let current: HTMLElement | null = element; current && container.contains(current); current = current.parentElement) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (current.tagName === "DETAILS" && !current.hasAttribute("open") && current !== element && !firstSummary(current)?.contains(element)) return false;
  }
  return true;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => isFocusable(element, container))
    .sort((first, second) => {
      const a = tabOrder(first);
      const b = tabOrder(second);
      // Browser order visits positive tabindex first, then zero in DOM order.
      if (a > 0 && b > 0) return a - b;
      if (a > 0) return -1;
      if (b > 0) return 1;
      return 0;
    });
}

export function ModalSurface({
  children,
  className,
  scrimClassName,
  title,
  description,
  titleId,
  descriptionId,
  ariaLabel,
  onClose,
  initialFocusRef,
}: {
  children: ReactNode;
  className: string;
  scrimClassName?: string;
  title?: ReactNode;
  description?: ReactNode;
  titleId?: string;
  descriptionId?: string;
  ariaLabel?: string;
  onClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const generatedTitleId = useId();
  const generatedDescriptionId = useId();
  const resolvedTitleId = titleId ?? generatedTitleId;
  const resolvedDescriptionId = descriptionId ?? generatedDescriptionId;
  const onCloseRef = useRef(onClose);
  const modalIdRef = useRef(Symbol("modal-surface"));

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const modalId = modalIdRef.current;
    activeModalStack.push(modalId);
    const frame = window.requestAnimationFrame(() => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const preferred =
        initialFocusRef?.current ??
        surface.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
        focusableElements(surface)[0] ??
        surface;
      preferred.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      const surface = surfaceRef.current;
      if (!surface || activeModalStack.at(-1) !== modalId) return;
      if (event.key === "Escape") {
        // Nested controls (for example an open popover) get first refusal.
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || event.defaultPrevented) return;

      const focusable = focusableElements(surface);
      if (focusable.length === 0) {
        event.preventDefault();
        surface.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (!surface.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      const stackIndex = activeModalStack.lastIndexOf(modalId);
      if (stackIndex >= 0) activeModalStack.splice(stackIndex, 1);
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected && !returnTarget.hasAttribute("disabled")) {
        returnTarget.focus();
      }
    };
  }, [initialFocusRef]);

  const dismissFromScrim = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.target === event.currentTarget &&
      activeModalStack.at(-1) === modalIdRef.current
    ) {
      onCloseRef.current();
    }
  };

  const surface = (
    <div
      className={["modal-scrim", scrimClassName].filter(Boolean).join(" ")}
      role="presentation"
      style={{
        boxSizing: "border-box",
        overflow: "auto",
        overscrollBehavior: "contain",
      }}
      onMouseDown={dismissFromScrim}
    >
      <section
        ref={surfaceRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={title ? resolvedTitleId : titleId}
        aria-describedby={description ? resolvedDescriptionId : descriptionId}
        tabIndex={-1}
        style={{
          boxSizing: "border-box",
          maxWidth: "calc(100vw - 2 * 26px)",
          maxHeight: "calc(100dvh - 2 * 26px)",
          minWidth: 0,
          minHeight: 0,
          overflow: "auto",
          overscrollBehavior: "contain",
        }}
      >
        {title ? <span id={resolvedTitleId} hidden>{title}</span> : null}
        {description ? <span id={resolvedDescriptionId} hidden>{description}</span> : null}
        {children}
      </section>
    </div>
  );

  // Keep fixed overlays outside transformed/backdrop-filtered surfaces. A
  // ModalSurface can be mounted from a toolbar, composer, or another nested
  // surface; rendering its scrim in-place lets those ancestors become the
  // fixed-position containing block and clip the overlay to their bounds.
  // Portaling to body preserves the visual viewport and makes every modal
  // control hit-testable above the app chrome.
  const portalHost = shouldPortalModal() ? getModalPortalHost() : null;
  return portalHost ? createPortal(surface, portalHost) : surface;
}
