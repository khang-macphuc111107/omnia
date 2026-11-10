import { Suspense, lazy, useMemo, useState } from "react";

import { LazyLoadBoundary } from "@/components/lazy-load-boundary";

import { useWorkspaceStore } from "./store";

const loadCommandPalette = async () => {
  const module = await import("./command-palette");
  return { default: module.CommandPalette };
};

function CommandPaletteLoadingState() {
  return (
    <div className="modal-scrim command-scrim command-scrim--loading">
      <div className="command-palette-loading" role="status" aria-live="polite">
        <span className="activity-load-progress" aria-hidden="true" />
        <span>Opening commands…</span>
      </div>
    </div>
  );
}

export function CommandPaletteHost() {
  const open = useWorkspaceStore((state) => state.commandPaletteOpen);
  const setOpen = useWorkspaceStore((state) => state.setCommandPaletteOpen);
  const [retryKey, setRetryKey] = useState(0);
  const LazyCommandPalette = useMemo(() => lazy(loadCommandPalette), [retryKey]);
  if (!open) return null;

  return (
    <LazyLoadBoundary
      label="Command palette"
      resetKey={String(retryKey)}
      errorClassName="modal-scrim command-scrim command-scrim--loading"
      onDismiss={() => setOpen(false)}
      onRetry={() => setRetryKey((value) => value + 1)}
    >
      <Suspense fallback={<CommandPaletteLoadingState />}>
        <LazyCommandPalette />
      </Suspense>
    </LazyLoadBoundary>
  );
}
