/** Pointer boundary for temporary shell drawers. Keyboard dismissal lives with the focused drawer. */
export function PanelScrim({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return (
    <div
      className="panel-drawer-scrim"
      data-panel-scrim="true"
      aria-hidden="true"
      role="presentation"
      onPointerDown={onClose}
    />
  );
}
