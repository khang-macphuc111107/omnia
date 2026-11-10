import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invokeCore } from "@/lib/desktop";

interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface SurfaceLease {
  leaseId: string;
}
interface SurfaceSnapshot {
  bounds: SurfaceBounds;
  visible: boolean;
}

const overlaySelector = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[role="menu"]',
  '[role="listbox"]',
  ".ide-tools-menu",
  ".ag-popover__panel",
  "[data-native-surface-overlay]",
].join(",");

function elementIsVisible(element: Element): boolean {
  if (!element.isConnected) return false;
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hasAttribute("hidden") ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    )
      return false;
    const style = window.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0"
    )
      return false;
    if (current.tagName === "DETAILS" && !current.hasAttribute("open"))
      return false;
  }
  return true;
}

function hasVisibleOverlay(): boolean {
  return Array.from(document.querySelectorAll(overlaySelector)).some(
    (element) => {
      if (!elementIsVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },
  );
}

/** Match WebView2's physical client coordinates, including display scale and CSS zoom. */
export function nativeEditorBounds(element: HTMLElement): SurfaceBounds | null {
  const rect = element.getBoundingClientRect();
  if (
    ![
      rect.left,
      rect.top,
      rect.right,
      rect.bottom,
      rect.width,
      rect.height,
    ].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null;
  const viewportWidth =
    document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight =
    document.documentElement.clientHeight || window.innerHeight;
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.right);
  const bottom = Math.min(viewportHeight, rect.bottom);
  if (right <= left || bottom <= top) return null;
  const ratio =
    Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  const x = Math.round(left * ratio);
  const y = Math.round(top * ratio);
  return {
    x,
    y,
    width: Math.max(1, Math.round(right * ratio) - x),
    height: Math.max(1, Math.round(bottom * ratio) - y),
  };
}

function surfaceError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return typeof error === "string"
    ? error
    : "The editor view could not open. Retry the connection.";
}

function timedSurfaceRequest<T>(
  request: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const clear = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      clear();
      reject(new DOMException("The editor view was detached.", "AbortError"));
    };
    const timeout = setTimeout(() => {
      clear();
      reject(
        new Error("The editor view did not respond. Retry the connection."),
      );
    }, 30_000);
    signal.addEventListener("abort", abort, { once: true });
    request.then(
      (value) => {
        clear();
        resolve(value);
      },
      (reason) => {
        clear();
        reject(reason);
      },
    );
    if (signal.aborted) abort();
  });
}

/** A DOM layout host for the isolated native editor; vendor content receives no app IPC. */
export function NativeVscodeSurface({
  folderId = null,
  revision,
  active,
  reconnect = false,
  reconnectEpoch,
  onError,
}: {
  folderId?: string | null;
  revision: string;
  active: boolean;
  reconnect?: boolean;
  /** A reconnect request is consumed once for this epoch. */
  reconnectEpoch?: number;
  /** Reports a native child failure to the health/status owner. */
  onError?: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const syncRef = useRef<(() => void) | null>(null);
  const focusRef = useRef<(() => void) | null>(null);
  // StrictMode and a quick workspace change can retire one effect while its
  // native attach is still running. Let that attachment release before the
  // next effect asks the single native editor to attach again.
  const pendingAttachRef = useRef<Promise<void> | null>(null);
  const reconnectEpochRef = useRef<number | null>(null);
  const retryRequestedRef = useRef(false);
  const onErrorRef = useRef(onError);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<
    "waiting" | "connecting" | "attached" | "error"
  >("waiting");
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useLayoutEffect(() => {
    activeRef.current = active;
    syncRef.current?.();
  }, [active]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let failed = false;
    let attaching = false;
    let updating = false;
    let lease: string | null = null;
    let desired: SurfaceSnapshot | null = null;
    let lastBounds: SurfaceBounds | null = null;
    let lastSignature = "";
    const released = new Map<string, Promise<void>>();
    const controller = new AbortController();
    setError("");
    setPhase("waiting");

    function release(leaseId: string): Promise<void> {
      const previous = released.get(leaseId);
      if (previous) return previous;
      // A late update cannot re-show a released native lease.
      const pending = invokeCore("editor_surface_release", { leaseId }).then(
        () => undefined,
        () => undefined,
      );
      released.set(leaseId, pending);
      return pending;
    }

    function fail(reason: unknown): void {
      if (disposed || failed) return;
      failed = true;
      const message = surfaceError(reason);
      setError(message);
      setPhase("error");
      onErrorRef.current?.(message);
      if (lease) void release(lease);
      lease = null;
    }

    function snapshot(): SurfaceSnapshot {
      const bounds = nativeEditorBounds(element!);
      if (bounds) lastBounds = bounds;
      return {
        bounds: lastBounds ?? { x: 0, y: 0, width: 1, height: 1 },
        visible: Boolean(
          bounds &&
          activeRef.current &&
          document.visibilityState !== "hidden" &&
          elementIsVisible(element!) &&
          !hasVisibleOverlay(),
        ),
      };
    }

    async function flush(): Promise<void> {
      if (updating || !lease || failed || disposed) return;
      updating = true;
      try {
        while (desired && lease && !failed && !disposed) {
          const next = desired;
          desired = null;
          const signature = JSON.stringify(next);
          if (signature === lastSignature) continue;
          await timedSurfaceRequest(
            invokeCore("editor_surface_update", { leaseId: lease, ...next }),
            controller.signal,
          );
          if (disposed || failed) return;
          lastSignature = signature;
          setPhase("attached");
        }
      } catch (reason) {
        fail(reason);
      } finally {
        updating = false;
      }
    }

    async function attach(bounds: SurfaceBounds): Promise<void> {
      attaching = true;
      setPhase("connecting");
      try {
        if (pendingAttachRef.current)
          await timedSurfaceRequest(
            pendingAttachRef.current,
            controller.signal,
          );
        if (disposed || failed) return;
        const requestedRetry = retryRequestedRef.current;
        retryRequestedRef.current = false;
        const requestedEpochReconnect =
          reconnect &&
          reconnectEpoch !== undefined &&
          reconnectEpochRef.current !== reconnectEpoch;
        if (requestedEpochReconnect)
          reconnectEpochRef.current = reconnectEpoch!;
        const pending = invokeCore<SurfaceLease>("editor_surface_attach", {
          folderId,
          bounds,
          reconnect: requestedRetry || requestedEpochReconnect,
        });
        const retired = pending.then(
          async (result) => {
            if (
              (disposed || failed) &&
              typeof result?.leaseId === "string" &&
              result.leaseId
            )
              await release(result.leaseId);
          },
          () => undefined,
        );
        pendingAttachRef.current = retired;
        void retired.then(() => {
          if (pendingAttachRef.current === retired)
            pendingAttachRef.current = null;
        });
        const result = await timedSurfaceRequest(pending, controller.signal);
        if (!result || typeof result.leaseId !== "string" || !result.leaseId)
          throw new Error("The editor view returned an invalid connection.");
        if (disposed || failed) {
          void release(result.leaseId);
          return;
        }
        lease = result.leaseId;
        // Native attach is hidden. Recheck overlays after the asynchronous
        // operation before allowing that separate native surface to appear.
        desired = snapshot();
        await flush();
      } catch (reason) {
        fail(reason);
      } finally {
        attaching = false;
      }
    }

    function sync(): void {
      if (disposed || failed) return;
      desired = snapshot();
      if (lease) {
        void flush();
        return;
      }
      if (!attaching && desired.visible) void attach(desired.bounds);
    }

    function focus(): void {
      if (!lease || disposed || failed || !snapshot().visible) return;
      void timedSurfaceRequest(
        invokeCore("editor_surface_focus", { leaseId: lease }),
        controller.signal,
      ).catch(fail);
    }

    syncRef.current = sync;
    focusRef.current = focus;
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    // Ancestor size changes can move the editor even when its own size stays fixed.
    for (
      let ancestor: Element | null = element;
      ancestor;
      ancestor = ancestor.parentElement
    )
      resize?.observe(ancestor);
    const mutations = new MutationObserver(sync);
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "hidden",
        "inert",
        "aria-hidden",
        "aria-modal",
        "role",
        "open",
        "class",
        "style",
        "data-native-surface-overlay",
      ],
    });
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    document.addEventListener("visibilitychange", sync);
    document.addEventListener("transitionend", sync, true);
    document.addEventListener("animationend", sync, true);
    window.visualViewport?.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("scroll", sync);
    sync();

    return () => {
      disposed = true;
      controller.abort();
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      document.removeEventListener("visibilitychange", sync);
      document.removeEventListener("transitionend", sync, true);
      document.removeEventListener("animationend", sync, true);
      window.visualViewport?.removeEventListener("resize", sync);
      window.visualViewport?.removeEventListener("scroll", sync);
      if (syncRef.current === sync) syncRef.current = null;
      if (focusRef.current === focus) focusRef.current = null;
      if (lease) void release(lease);
    };
  }, [folderId, revision, attempt, reconnect, reconnectEpoch]);

  return (
    <div
      className="native-vscode-surface"
      data-testid="native-vscode-surface"
      hidden={!active}
      inert={!active}
    >
      <div className="native-vscode-surface__access">
        <button
          type="button"
          disabled={phase !== "attached" || !active}
          onClick={() => focusRef.current?.()}
        >
          Focus editor
        </button>
      </div>
      <div
        ref={host}
        className="native-vscode-surface__viewport"
        data-testid="native-vscode-viewport"
        role="region"
        aria-label="VS Code editor"
      >
        {phase !== "attached" ? (
          <div
            className="embedded-vscode-stage__status"
            role="status"
            aria-live="polite"
          >
            <h2>
              {phase === "error"
                ? "The editor view could not open"
                : "Opening VS Code"}
            </h2>
            <p>
              {phase === "error"
                ? error
                : "Connecting the editor to this workspace."}
            </p>
            {phase === "error" ? (
              <button
                type="button"
                onClick={() => {
                  retryRequestedRef.current = true;
                  setAttempt((current) => current + 1);
                }}
              >
                Retry editor view
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
