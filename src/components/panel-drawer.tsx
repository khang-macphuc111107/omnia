import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"]):not([role="tabpanel"])';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Focus and keyboard contract for a temporary side-panel drawer.
 *
 * Docked panels remain non-modal. At the narrow breakpoint the panel becomes
 * a modal-like drawer: focus enters the panel, Tab wraps within it, Escape
 * invokes the supplied close command, and focus returns to the opener.
 */
export function usePanelDrawerFocus<T extends HTMLElement>(
  open: boolean,
  modal: boolean,
  onClose: () => void,
  returnFocusId?: string,
) {
  const panelRef = useRef<T>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open || !modal) return;

    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) {
      const first = focusableElements(panel)[0];
      (first ?? panel).focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const opener = openerRef.current;
      const fallback = returnFocusId ? document.getElementById(returnFocusId) : null;
      if (opener?.isConnected && !panelRef.current?.contains(opener)) opener.focus();
      else if (fallback instanceof HTMLElement && fallback.isConnected) fallback.focus();
    };
  }, [modal, open, returnFocusId]);

  return panelRef;
}
