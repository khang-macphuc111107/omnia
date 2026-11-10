import { Maximize2, Minus, PanelLeft, X } from "lucide-react";
import { isDesktopRuntime } from "@/lib/desktop";

import { useWorkspaceStore } from "./store";
import { WorkspaceModeSwitcher } from "./workspace-mode-switcher";

// Window controls are native-only. Keep the Tauri window client out of the
// browser/chat startup graph and fetch it only after a desktop control is
// invoked. Browser preview controls are explicitly disabled so a visible
// button never looks actionable while doing nothing in the renderer preview.
async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function TitleBar() {
  const desktopRuntime = isDesktopRuntime();
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const sidebarOpen = useWorkspaceStore((state) => state.sidebarOpen);
  const activeActivity = useWorkspaceStore((state) => state.activeActivity);
  // The object sidebar is intentionally mounted only for Chat and Projects.
  // Keep the title-bar control honest on context-only surfaces (Settings,
  // Library, Code, Browser) so aria-controls never points at a missing node.
  const objectSidebarAvailable = activeActivity === "chats" || activeActivity === "projects";

  const minimize = async () => {
    if (isDesktopRuntime()) await (await currentWindow()).minimize();
  };
  const maximize = async () => {
    if (isDesktopRuntime()) await (await currentWindow()).toggleMaximize();
  };
  const close = async () => {
    if (isDesktopRuntime()) await (await currentWindow()).close();
  };

  return (
    <header className="title-bar title-bar--review" data-tauri-drag-region="deep">
      <div className="title-bar__navigation" data-tauri-drag-region="deep">
        <button
          type="button"
          id="sidebar-toggle"
          className="icon-button icon-button--small title-bar__sidebar-toggle"
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
          aria-expanded={objectSidebarAvailable ? sidebarOpen : undefined}
          onClick={toggleSidebar}
        >
          <PanelLeft size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="title-bar__center">
        <WorkspaceModeSwitcher />
      </div>
      <div className="title-bar__actions">
        <div className="window-controls" role="group" aria-label="Window controls">
          <button
            type="button"
            aria-label="Minimize"
            title={desktopRuntime ? "Minimize window" : "Minimize window (desktop app only)"}
            onClick={() => void minimize()}
            disabled={!desktopRuntime}
          >
            <Minus size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Maximize or restore"
            title={desktopRuntime ? "Maximize or restore window" : "Maximize or restore window (desktop app only)"}
            onClick={() => void maximize()}
            disabled={!desktopRuntime}
          >
            <Maximize2 size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control--close"
            aria-label="Close"
            title={desktopRuntime ? "Close window" : "Close window (desktop app only)"}
            onClick={() => void close()}
            disabled={!desktopRuntime}
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}
