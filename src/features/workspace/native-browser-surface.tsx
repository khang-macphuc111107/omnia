import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeCore } from "@/lib/desktop";
import { nativeEditorBounds } from "./native-vscode-surface";

export type NativeBrowserAction = "back" | "forward" | "reload" | "focus" | "devtools" | "zoom-in" | "zoom-out" | "zoom-reset";
export type NativeBrowserShortcutAction = "focus-address" | "new-tab" | "close-tab" | "next-tab" | "previous-tab" | "reload";
const NATIVE_SHORTCUT_ACTIONS = new Set<unknown>(["focus-address", "new-tab", "close-tab", "next-tab", "previous-tab", "reload"]);
export interface NativeBrowserCaptureReceipt {
  receiptId: string;
  tabKey: string;
  leaseId: string;
  url: string;
  title: string;
  mode: "page" | "selection";
  text: string;
  contentSha256: string;
  byteSize: number;
  truncated: boolean;
  capturedAtMs: number;
  source: "native-dom-text";
}
export interface NativeBrowserController {
  action: (action: NativeBrowserAction) => Promise<void>;
  capture?: (mode: "page" | "selection") => Promise<NativeBrowserCaptureReceipt>;
}
export interface NativeBrowserPolicyNotice {
  receiptId: string;
  tabKey: string;
  leaseId: string;
  kind: "new-window-denied" | "download-denied" | "download-finished";
  url?: string;
  success?: boolean;
  reason: string;
  occurredAtMs: number;
}
interface SurfaceBounds { x: number; y: number; width: number; height: number }
interface SurfaceSnapshot { bounds: SurfaceBounds; visible: boolean }
interface NavigationEvent { tabKey: string; leaseId: string; url: string; title?: string; loading?: boolean; zoomPercent?: number }
interface ShortcutEvent { tabKey: string; leaseId: string; label: string; epoch: number; action: NativeBrowserShortcutAction }
const NATIVE_REQUEST_TIMEOUT_MS = 30_000;

function timedBrowserRequest<T>(request: Promise<T>, signal: AbortSignal, onLateResult?: (result: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const clear = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const stop = (reason: Error) => {
      if (settled) return;
      settled = true;
      clear();
      reject(reason);
    };
    const abort = () => stop(new DOMException("The browser page was detached.", "AbortError"));
    const timeout = setTimeout(() => stop(new Error("The browser page did not respond. Retry the page.")), NATIVE_REQUEST_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    request.then((result) => {
      if (settled) { onLateResult?.(result); return; }
      settled = true;
      clear();
      resolve(result);
    }, (reason) => {
      if (settled) return;
      settled = true;
      clear();
      reject(reason);
    });
    if (signal.aborted) abort();
  });
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "The browser page could not open. Try again.";
}

function elementVisible(element: Element): boolean {
  if (!element.isConnected) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.matches('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
    if (current.tagName === "DETAILS" && !current.hasAttribute("open")) return false;
  }
  return true;
}

function overlayVisible(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"], .ag-popover__panel, [data-native-surface-overlay]'))
    .some((element) => elementVisible(element) && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
}

export function validNativeBrowserUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch { return false; }
}

/** An isolated top-level browser document. Only typed management commands cross into native code. */
export function NativeBrowserSurface({ tabKey, url, active, onController, onNavigation, onShortcut, onPolicyNotice }: {
  tabKey: string;
  url: string;
  active: boolean;
  onController: (tabKey: string, controller: NativeBrowserController | null) => void;
  /**
   * Receives native page lifecycle updates. `loading` is optional because
   * title-only events do not carry a lifecycle transition.
   */
  onNavigation: (tabKey: string, url: string, title?: string, loading?: boolean, zoomPercent?: number) => void;
  onPolicyNotice?: (notice: NativeBrowserPolicyNotice) => void;
  onShortcut?: (tabKey: string, action: NativeBrowserShortcutAction) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const urlRef = useRef(url);
  const previousUrl = useRef(url);
  const syncRef = useRef<(() => void) | null>(null);
  const focusRef = useRef<(() => void) | null>(null);
  const onShortcutRef = useRef(onShortcut);
  const onPolicyNoticeRef = useRef(onPolicyNotice);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<"waiting" | "connecting" | "attached" | "error">("waiting");
  const [error, setError] = useState("");

  useLayoutEffect(() => { activeRef.current = active; syncRef.current?.(); }, [active]);
  useLayoutEffect(() => { onShortcutRef.current = onShortcut; }, [onShortcut]);
  useLayoutEffect(() => { onPolicyNoticeRef.current = onPolicyNotice; }, [onPolicyNotice]);
  useLayoutEffect(() => {
    const changed = previousUrl.current !== url;
    previousUrl.current = url;
    urlRef.current = url;
    if (changed && phase === "error") setAttempt((current) => current + 1);
    else syncRef.current?.();
  }, [url, phase]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let failed = false;
    let attaching = false;
    let lease: string | null = null;
    let lastBounds: SurfaceBounds | null = null;
    let lastSnapshot = "";
    let currentUrl = "";
    let initialUrl = "";
    let pendingNavigation: NavigationEvent | null = null;
    let queue = Promise.resolve();
    const unlisteners = new Set<() => void>();
    let listening = false;
    const released = new Set<string>();
    const requests = new AbortController();
    setError("");
    setPhase("waiting");

    function release(leaseId: string): void {
      if (released.has(leaseId)) return;
      released.add(leaseId);
      void invokeCore("browser_surface_release", { leaseId }).catch(() => undefined);
    }

    function fail(reason: unknown): void {
      if (disposed || failed) return;
      failed = true;
      requests.abort();
      unlisteners.forEach((stop) => stop());
      unlisteners.clear();
      setError(errorMessage(reason));
      setPhase("error");
      if (lease) release(lease);
      lease = null;
    }

    function snapshot(): SurfaceSnapshot {
      const bounds = nativeEditorBounds(element!);
      if (bounds) lastBounds = bounds;
      return {
        bounds: lastBounds ?? { x: 0, y: 0, width: 1, height: 1 },
        visible: Boolean(bounds && activeRef.current && document.visibilityState !== "hidden" && elementVisible(element!) && !overlayVisible()),
      };
    }

    function serial(operation: () => Promise<void>): Promise<void> {
      const pending = queue.then(async () => { if (!disposed && !failed) await operation(); });
      queue = pending.catch(fail);
      return pending;
    }

    async function update(): Promise<void> {
      if (!lease || disposed || failed) return;
      const next = snapshot();
      const signature = JSON.stringify(next);
      if (signature !== lastSnapshot) {
        await timedBrowserRequest(invokeCore("browser_surface_update", { leaseId: lease, ...next }), requests.signal);
        if (disposed || failed) return;
        lastSnapshot = signature;
      }
      const desiredUrl = urlRef.current;
      if (currentUrl !== desiredUrl) {
        if (!validNativeBrowserUrl(desiredUrl)) throw new Error("Enter an HTTP or HTTPS page address.");
        currentUrl = desiredUrl;
        await timedBrowserRequest(invokeCore("browser_surface_navigate", { leaseId: lease, url: desiredUrl }), requests.signal);
      }
      if (!disposed && !failed) setPhase("attached");
    }

    async function attach(bounds: SurfaceBounds): Promise<void> {
      attaching = true;
      setPhase("connecting");
      try {
        initialUrl = urlRef.current;
        if (!validNativeBrowserUrl(initialUrl)) throw new Error("Enter an HTTP or HTTPS page address.");
        currentUrl = initialUrl;
        const result = await timedBrowserRequest(invokeCore<{ leaseId: string; url?: string; zoomPercent?: number }>("browser_surface_attach", { tabKey, url: initialUrl, bounds }), requests.signal, (late) => {
          if (late && typeof late.leaseId === "string" && late.leaseId) release(late.leaseId);
        });
        if (!result || typeof result.leaseId !== "string" || !result.leaseId) throw new Error("The page returned an invalid connection.");
        if (result.zoomPercent !== undefined && (!Number.isInteger(result.zoomPercent) || result.zoomPercent < 25 || result.zoomPercent > 500)) {
          throw new Error("The page returned an invalid zoom level.");
        }
        if (disposed || failed) { release(result.leaseId); return; }
        lease = result.leaseId;
        const attachedZoom = result.zoomPercent;
        if (urlRef.current === initialUrl) {
          if (pendingNavigation) {
            // A navigation event may arrive before the attach acknowledgement.
            // Preserve its authoritative route/lifecycle fields while filling
            // the persisted zoom only when the event did not carry one.
            applyNavigation(attachedZoom !== undefined && pendingNavigation.zoomPercent === undefined
              ? { ...pendingNavigation, zoomPercent: attachedZoom }
              : pendingNavigation);
          } else if (validNativeBrowserUrl(result.url) && result.url !== initialUrl) {
            applyNavigation({
              tabKey,
              leaseId: lease,
              url: result.url,
              ...(attachedZoom !== undefined ? { zoomPercent: attachedZoom } : {}),
            });
          } else if (attachedZoom !== undefined) {
            // Reattachments often return the same URL. Emit the attach-time
            // zoom so the browser chrome cannot drift from the native WebView.
            onNavigation(tabKey, initialUrl, undefined, undefined, attachedZoom);
          }
        }
        pendingNavigation = null;
        // Native creation is hidden; observe the latest route and overlays before showing it.
        await serial(update);
      } catch (reason) { fail(reason); }
      finally { attaching = false; }
    }

    function sync(): void {
      if (disposed || failed) return;
      const next = snapshot();
      if (lease) { void serial(update).catch(fail); return; }
      if (listening && !attaching && next.visible) void attach(next.bounds);
    }

    const controller: NativeBrowserController = {
      action: (action) => serial(async () => {
        if (!lease) throw new Error("The page is still opening. Try again shortly.");
        if (action === "focus" && !snapshot().visible) return;
        await timedBrowserRequest(invokeCore("browser_surface_action", { leaseId: lease, action }), requests.signal);
      }),
      capture: async (mode) => {
        if (!lease || !snapshot().visible) throw new Error("Select this page before capturing its text.");
        const expectedLease = lease;
        const receipt = await timedBrowserRequest(invokeCore<NativeBrowserCaptureReceipt>("browser_surface_capture", { leaseId: expectedLease, mode }), requests.signal);
        if (disposed || failed || lease !== expectedLease || !receipt || receipt.leaseId !== expectedLease || receipt.tabKey !== tabKey
          || receipt.mode !== mode || receipt.source !== "native-dom-text" || !validNativeBrowserUrl(receipt.url)
          || typeof receipt.text !== "string" || typeof receipt.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.contentSha256)
          || typeof receipt.byteSize !== "number" || receipt.byteSize < 0 || receipt.byteSize > 262144
          || typeof receipt.receiptId !== "string" || !receipt.receiptId.startsWith("browser_capture_")
          || !Number.isSafeInteger(receipt.capturedAtMs) || receipt.capturedAtMs <= 0 || typeof receipt.truncated !== "boolean") {
          throw new Error("The page returned an invalid text capture receipt.");
        }
        return receipt;
      },
    };
    const focus = () => { void controller.action("focus").catch(fail); };
    focusRef.current = focus;
    onController(tabKey, controller);
    syncRef.current = sync;
    function applyNavigation(navigation: NavigationEvent): void {
      if (navigation.leaseId !== lease) return;
      currentUrl = navigation.url;
      urlRef.current = navigation.url;
      const title = typeof navigation.title === "string" ? navigation.title.slice(0, 200) : undefined;
      const loading = typeof navigation.loading === "boolean" ? navigation.loading : undefined;
      const zoomPercent = Number.isInteger(navigation.zoomPercent) && navigation.zoomPercent! >= 25 && navigation.zoomPercent! <= 500
        ? navigation.zoomPercent
        : undefined;
      // Keep title-only events backwards compatible for consumers that use the
      // callback as a small navigation signal; append optional lifecycle facts
      // only when native actually supplied them.
      if (zoomPercent !== undefined) onNavigation(tabKey, navigation.url, title, loading, zoomPercent);
      else if (loading !== undefined) onNavigation(tabKey, navigation.url, title, loading);
      else onNavigation(tabKey, navigation.url, title);
    }
    // Listen before creating the document so its first navigation is not missed.
    const retainListener = (stop: () => void) => {
      if (disposed || failed) { stop(); return; }
      unlisteners.add(stop);
    };
    void Promise.all([listen<NavigationEvent>("omnia-browser-surface-navigation", (event) => {
      const navigation = event.payload;
      if (disposed || failed || !navigation || navigation.tabKey !== tabKey || typeof navigation.leaseId !== "string" || (lease && navigation.leaseId !== lease) || !validNativeBrowserUrl(navigation.url)) return;
      if (!lease) { if (attaching) pendingNavigation = navigation; return; }
      applyNavigation(navigation);
    }).then(retainListener), listen<NativeBrowserPolicyNotice>("omnia-browser-surface-policy", (event) => {
      const notice = event.payload;
      if (disposed || failed || !notice || notice.tabKey !== tabKey || notice.leaseId !== lease
        || (notice.kind !== "new-window-denied" && notice.kind !== "download-denied" && notice.kind !== "download-finished")
        || typeof notice.reason !== "string" || notice.reason.length > 1024
        || typeof notice.receiptId !== "string" || !notice.receiptId.startsWith("browser_policy_")
        || !Number.isSafeInteger(notice.occurredAtMs) || notice.occurredAtMs <= 0
        || (notice.success !== undefined && typeof notice.success !== "boolean")
        || (notice.url != null && !validNativeBrowserUrl(notice.url))) return;
      onPolicyNoticeRef.current?.(notice);
    }).then(retainListener), listen<ShortcutEvent>("omnia-native-browser-shortcut", (event) => {
      const shortcut = event.payload;
      if (disposed || failed || !lease || !shortcut || shortcut.tabKey !== tabKey || shortcut.leaseId !== lease
        || typeof shortcut.label !== "string" || !shortcut.label.startsWith("omnia-browser-")
        || !Number.isSafeInteger(shortcut.epoch) || shortcut.epoch < 0 || !NATIVE_SHORTCUT_ACTIONS.has(shortcut.action)
        || !activeRef.current || !snapshot().visible) return;
      onShortcutRef.current?.(tabKey, shortcut.action);
    }).then(retainListener)]).then(() => {
      if (disposed || failed) return;
      listening = true;
      sync();
    }).catch(fail);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) resize?.observe(ancestor);
    const mutations = new MutationObserver(sync);
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "aria-modal", "role", "open", "class", "style", "data-native-surface-overlay"] });
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    document.addEventListener("visibilitychange", sync);
    document.addEventListener("transitionend", sync, true);
    document.addEventListener("animationend", sync, true);
    window.visualViewport?.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("scroll", sync);
    return () => {
      disposed = true;
      requests.abort();
      resize?.disconnect();
      mutations.disconnect();
      unlisteners.forEach((stop) => stop());
      unlisteners.clear();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      document.removeEventListener("visibilitychange", sync);
      document.removeEventListener("transitionend", sync, true);
      document.removeEventListener("animationend", sync, true);
      window.visualViewport?.removeEventListener("resize", sync);
      window.visualViewport?.removeEventListener("scroll", sync);
      onController(tabKey, null);
      if (syncRef.current === sync) syncRef.current = null;
      if (focusRef.current === focus) focusRef.current = null;
      if (lease) release(lease);
    };
  }, [tabKey, attempt, onController, onNavigation]);

  return <div className="native-browser-surface" data-testid={`native-browser-surface-${tabKey}`}>
    <div className="native-browser-surface__access"><button type="button" disabled={phase !== "attached" || !active} onClick={() => focusRef.current?.()}>Focus page</button></div>
    <div ref={host} className="native-browser-surface__viewport" data-testid={`native-browser-viewport-${tabKey}`} role="region" aria-label="Browser page">
      {phase !== "attached" ? <div className="native-browser-surface__status" role="status" aria-live="polite">
        <h2>{phase === "error" ? "The page could not open" : "Opening page"}</h2>
        <p>{phase === "error" ? error : "Connecting to this page."}</p>
        {phase === "error" ? <button type="button" onClick={() => setAttempt((current) => current + 1)}>Retry page</button> : null}
      </div> : null}
    </div>
  </div>;

}
