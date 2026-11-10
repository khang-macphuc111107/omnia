import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

import { useAgentStore } from "./agent-store";
import { SPLIT_DEFAULT_RATIO, clampRatioForWidth } from "./split";

const KEY_STEP = 0.02;

/** Draggable (and keyboard-operable) divider between the two panes. Ratio persists on release. */
export function SplitDivider({ host }: { host: RefObject<HTMLElement | null> }) {
  const ratio = useAgentStore((s) => s.split.ratio);
  const dragging = useRef(false);

  const apply = (value: number, persist: boolean) => {
    const width = host.current?.getBoundingClientRect().width ?? 0;
    useAgentStore.getState().setSplitRatio(clampRatioForWidth(value, width), persist);
  };

  const fromPointer = (event: PointerEvent) => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return (event.clientX - rect.left) / rect.width;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") apply(ratio - KEY_STEP, true);
    else if (event.key === "ArrowRight") apply(ratio + KEY_STEP, true);
    else if (event.key === "Home") apply(0, true);
    else if (event.key === "End") apply(1, true);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className="ag-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      aria-valuemin={25}
      aria-valuemax={75}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDoubleClick={() => apply(SPLIT_DEFAULT_RATIO, true)}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const next = fromPointer(event);
        if (next !== null) apply(next, false);
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        const next = fromPointer(event);
        apply(next ?? ratio, true);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    />
  );
}
