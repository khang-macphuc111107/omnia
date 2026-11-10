import { useSyncExternalStore } from "react";

import { NARROW_SHELL_MEDIA_QUERY } from "@/design-system/tokens.generated";

/**
 * Returns whether the current surface should present side panels as temporary
 * drawers. The native Windows shell remains at least 800px wide; the same
 * query is also used by the web/remote projection so panel behavior does not
 * drift between clients.
 */
export function isNarrowPanelViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_SHELL_MEDIA_QUERY).matches
    : false;
}

/** Subscribe to the panel breakpoint without coupling callers to a media API. */
export function subscribeToNarrowPanelViewport(listener: (matches: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(NARROW_SHELL_MEDIA_QUERY);
  const onChange = () => listener(media.matches);
  media.addEventListener?.("change", onChange);
  // Older WebView2 builds expose the legacy listener API only.
  if (!media.addEventListener) media.addListener(onChange);
  return () => {
    media.removeEventListener?.("change", onChange);
    if (!media.removeEventListener) media.removeListener(onChange);
  };
}

const subscribeToNarrowPanelStore = (notify: () => void) =>
  subscribeToNarrowPanelViewport(() => notify());

/** Reactive form used by components that change ARIA or focus behavior. */
export function useNarrowPanelViewport(): boolean {
  return useSyncExternalStore(
    subscribeToNarrowPanelStore,
    isNarrowPanelViewport,
    () => false,
  );
}
