import { Suspense, lazy, useMemo, useState } from "react";

import { LazyLoadBoundary } from "@/components/lazy-load-boundary";

import { useWorkspaceOverlayStore } from "./overlay-store";

const loadGlobalDialogs = async () => {
  const module = await import("./dialogs");
  return { default: module.GlobalDialogs };
};

function DialogLoadingState() {
  return (
    <div className="modal-scrim dialog-scrim--loading">
      <div className="dialog-loading-state" role="status" aria-live="polite">
        <span className="activity-load-progress" aria-hidden="true" />
        <span>Opening dialog…</span>
      </div>
    </div>
  );
}

export function GlobalDialogsHost() {
  const overlay = useWorkspaceOverlayStore((state) => state.activeOverlay);
  const closeOverlay = useWorkspaceOverlayStore((state) => state.closeOverlay);
  const [retryKey, setRetryKey] = useState(0);
  const LazyGlobalDialogs = useMemo(() => lazy(loadGlobalDialogs), [retryKey]);
  if (!overlay) return null;

  return (
    <LazyLoadBoundary
      label="Dialog"
      resetKey={`${overlay.kind}:${retryKey}`}
      errorClassName="modal-scrim dialog-scrim--loading"
      onDismiss={closeOverlay}
      onRetry={() => setRetryKey((value) => value + 1)}
    >
      <Suspense fallback={<DialogLoadingState />}>
        <LazyGlobalDialogs />
      </Suspense>
    </LazyLoadBoundary>
  );
}
