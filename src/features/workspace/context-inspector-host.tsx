import { Suspense, lazy } from "react";

import { useWorkspaceStore } from "./store";

const LazyContextInspectorPanel = lazy(async () => {
  const module = await import("./inspector");
  return { default: module.ContextInspectorPanel };
});

function ContextInspectorLoadingState() {
  return (
    <aside
      id="context-inspector"
      className="context-inspector context-inspector--loading"
      aria-label="Opening context and run inspector"
      role="status"
      aria-live="polite"
    >
      <span className="activity-load-progress" aria-hidden="true" />
      <span>Opening inspector…</span>
    </aside>
  );
}

export function ContextInspectorHost() {
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen);
  if (!inspectorOpen) return null;

  return (
    <Suspense fallback={<ContextInspectorLoadingState />}>
      <LazyContextInspectorPanel />
    </Suspense>
  );
}
