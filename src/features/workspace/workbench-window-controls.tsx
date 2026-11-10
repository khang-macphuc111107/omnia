import { Maximize2, Minus, X } from "lucide-react";
import { useState, type MouseEvent } from "react";

import { isDesktopRuntime } from "@/lib/desktop";

import "./workbench-window-controls.css";

type WindowAction = "minimize" | "toggleMaximize" | "close";

interface WorkbenchWindowControlsProps {
  className?: string;
}

/** Native controls for surfaces that intentionally bypass Omnia's TitleBar. */
export function WorkbenchWindowControls({ className = "" }: WorkbenchWindowControlsProps) {
  const [pendingAction, setPendingAction] = useState<WindowAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  // An ordinary browser already owns its OS window controls. Never show
  // renderer buttons that silently do nothing in the standalone web preview.
  if (!isDesktopRuntime()) return null;

  const runAction = async (event: MouseEvent<HTMLButtonElement>, action: WindowAction) => {
    event.stopPropagation();
    if (pendingAction) return;
    setPendingAction(action);
    setError(null);
    try {
      // Keep the native client out of browser startup and resolve the current
      // Tauri window only when the user actually invokes a window action.
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow()[action]();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Window action failed: ${message}`);
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div
      className={`workbench-window-controls ${className}`.trim()}
      data-testid="workbench-window-controls"
      role="group"
      aria-label="Window controls"
      aria-busy={pendingAction !== null}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="workbench-window-controls__button"
        aria-label="Minimize"
        title="Minimize window"
        disabled={pendingAction !== null}
        onClick={(event) => void runAction(event, "minimize")}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="workbench-window-controls__button"
        aria-label="Maximize or restore"
        title="Maximize or restore window"
        disabled={pendingAction !== null}
        onClick={(event) => void runAction(event, "toggleMaximize")}
      >
        <Maximize2 size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="workbench-window-controls__button workbench-window-controls__button--close"
        aria-label="Close"
        title="Close window"
        disabled={pendingAction !== null}
        onClick={(event) => void runAction(event, "close")}
      >
        <X size={16} aria-hidden="true" />
      </button>
      {error ? (
        <div className="workbench-window-controls__error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            aria-label="Dismiss window control error"
            onClick={() => setError(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
