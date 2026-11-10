import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element.closest("[hidden], [inert]")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

/** Shell-owned modal boundary. It traps only while open and restores its opener. */
export function useModalBoundary(
  ref: RefObject<HTMLDivElement | null>,
  open: boolean,
  dismiss: () => void,
) {
  useEffect(() => {
    const container = ref.current;
    if (!open || !container) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFirst = () => (focusableElements(container)[0] ?? container).focus();
    focusFirst();
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !container.contains(event.target)) focusFirst();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusableElements(container);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); container.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      if (opener?.isConnected) opener.focus();
    };
  }, [ref, open, dismiss]);
}
