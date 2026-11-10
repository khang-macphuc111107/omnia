import { Suspense, lazy, useMemo, useState, type ComponentType } from "react";

import { LazyLoadBoundary } from "@/components/lazy-load-boundary";

type HomeSurfaceModule<Props extends object> = {
  default: ComponentType<Props>;
};

function HomeSurfaceLoading({ label }: { readonly label: string }) {
  return (
    <div className="home-screen__surface-loading settings-surface-loading" role="status" aria-live="polite">
      <span className="settings-surface-loading__dot" aria-hidden="true" />
      <span>Loading {label} preview…</span>
    </div>
  );
}

/**
 * Loads optional Home workbenches after the shell has mounted. The boundary
 * only recovers the renderer surface; it does not imply native persistence,
 * provider dispatch, filesystem access, or scheduler execution.
 */
export function HomeLazySurface<Props extends object>({
  label,
  load,
  props,
}: {
  readonly label: string;
  readonly load: () => Promise<HomeSurfaceModule<Props>>;
  readonly props: Props;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const Surface = useMemo(() => lazy(load), [load, retryKey]);

  if (dismissed) return null;

  return (
    <LazyLoadBoundary
      label={label}
      resetKey={`${label}:${retryKey}`}
      onDismiss={() => setDismissed(true)}
      onRetry={() => setRetryKey((value) => value + 1)}
    >
      <Suspense fallback={<HomeSurfaceLoading label={label} />}>
        <Surface {...props} />
      </Suspense>
    </LazyLoadBoundary>
  );
}
