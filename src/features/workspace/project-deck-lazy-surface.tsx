import { useEffect, useState, type ComponentType, type ReactNode } from "react";

import { LazyLoadBoundary } from "@/components/lazy-load-boundary";

type ProjectDeckSurfaceModule<Props extends object> = {
  default: ComponentType<Props>;
};

function ProjectDeckSurfaceLoading({ label, loadingContent }: { label: string; loadingContent?: ReactNode }) {
  return (
    <div className="project-control-deck__lazy-loading" role="status" aria-live="polite">
      <span className="activity-load-progress" aria-hidden="true" />
      <div>
        <span className="eyebrow">On-demand renderer surface</span>
        {loadingContent ?? <><strong>Loading {label}</strong><small>This optional project workbench is loading without changing the active preview.</small></>}
      </div>
    </div>
  );
}

/**
 * Resolve optional project workbenches from an effect instead of creating a
 * fresh React.lazy resource during render.  This keeps the renderer boundary
 * deterministic when a tab is switched while another on-demand module is
 * still settling (notably in embedded WebViews and Vitest's dynamic-import
 * queue).  The loaded component remains renderer-local; this helper does not
 * imply native persistence, provider dispatch, or filesystem access.
 */
function ProjectDeckSurfaceLoader<Props extends object>({
  label,
  load,
  props,
  loadingContent,
}: {
  label: string;
  load: () => Promise<ProjectDeckSurfaceModule<Props>>;
  props: Props;
  loadingContent?: ReactNode;
}) {
  const [surface, setSurface] = useState<ComponentType<Props> | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    setSurface(null);
    setLoadError(null);

    void load()
      .then((module) => {
        if (active) setSurface(() => module.default);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error : new Error("Project workbench could not be loaded."));
      });

    return () => {
      active = false;
    };
  }, [load]);

  if (loadError) throw loadError;
  if (!surface) return <ProjectDeckSurfaceLoading label={label} loadingContent={loadingContent} />;

  const Surface = surface;
  return <Surface {...props} />;
}

/**
 * Loads heavyweight project workbenches only after the user opens their tab.
 * The boundary deliberately describes renderer-local recovery; it does not
 * imply that the native project, provider, or filesystem layers are active.
 */
export function ProjectDeckLazySurface<Props extends object>({
  label,
  load,
  props,
  loadingContent,
}: {
  label: string;
  load: () => Promise<ProjectDeckSurfaceModule<Props>>;
  props: Props;
  loadingContent?: ReactNode;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <LazyLoadBoundary
      label={label}
      resetKey={`${label}:${retryKey}`}
      onDismiss={() => setDismissed(true)}
      onRetry={() => setRetryKey((value) => value + 1)}
    >
      <ProjectDeckSurfaceLoader
        key={`${label}:${retryKey}`}
        label={label}
        load={load}
        props={props}
        loadingContent={loadingContent}
      />
    </LazyLoadBoundary>
  );
}
