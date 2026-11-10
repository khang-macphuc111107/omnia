import { Suspense, lazy, useMemo, useState, type ComponentType } from "react";

import { LazyLoadBoundary } from "@/components/lazy-load-boundary";

type SettingsSurfaceModule<Props extends object> = {
  default: ComponentType<Props>;
};

function SurfaceLoading({ label }: { label: string }) {
  return (
    <div className="settings-surface-loading" role="status" aria-live="polite">
      <span className="settings-surface-loading__dot" aria-hidden="true" />
      <span>Loading {label} preview…</span>
    </div>
  );
}

/**
 * Keeps the settings category shell small while each heavyweight workbench
 * owns its own async chunk and retry boundary. The component deliberately
 * exposes no native loading or persistence semantics: it only coordinates a
 * renderer-local preview surface.
 */
export function SettingsNestedLazySurface<Props extends object>({
  label,
  load,
  props,
}: {
  label: string;
  load: () => Promise<SettingsSurfaceModule<Props>>;
  props: Props;
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
      <Suspense fallback={<SurfaceLoading label={label} />}>
        <Surface {...props} />
      </Suspense>
    </LazyLoadBoundary>
  );
}
