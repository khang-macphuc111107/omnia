/**
 * Top-level surfaces of the merged shell.
 *
 * The public navigation deliberately has only three modes: Chat, Browser and
 * IDE. Projects, Work and Library remain addressable workspace surfaces for
 * the command palette and in-app links, but are hosted inside Chat rather than
 * competing with the primary mode switcher.
 */
export const WORKSPACE_VIEWS = ["projects", "work", "library", "code", "browser"] as const;

export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];
export type ShellView = "agent" | WorkspaceView;

export interface ShellViewDescriptor {
  id: ShellView;
  label: string;
  /** Alt+digit shortcut handled by the shell. */
  shortcut: string;
  description?: string;
}

/** Internal workspace targets remain available to command palette and deep links. */
export const SECONDARY_SHELL_VIEWS: readonly ShellViewDescriptor[] = [
  { id: "projects", label: "Projects", shortcut: "" },
  { id: "work", label: "Work", shortcut: "" },
  { id: "library", label: "Library", shortcut: "" },
];

/** The only primary modes shown in the persistent top-left navigation. */
export const SHELL_VIEWS: readonly ShellViewDescriptor[] = [
  { id: "agent", label: "Chat", shortcut: "Alt+1" },
  { id: "browser", label: "Browser", shortcut: "Alt+2" },
  { id: "code", label: "IDE", shortcut: "Alt+3" },
];

/**
 * The user-facing shell has three stable surfaces. Projects, work, library,
 * memory and skills are Chat workspace routes and intentionally do not get a
 * second top-level navigation button. Keeping this contract separate from
 * SHELL_VIEWS lets the command palette and existing workspace links continue
 * to address their more granular routes while the chrome stays simple.
 */
export const PRIMARY_SURFACE_VIEWS = [
  { id: "agent", label: "Chat", shortcut: "Alt+1", description: "Conversations, projects and agent sessions" },
  { id: "browser", label: "Browser", shortcut: "Alt+2", description: "Web research and browser workbench" },
  { id: "code", label: "IDE", shortcut: "Alt+3", description: "Code, terminal and editor workbench" },
] as const satisfies readonly ShellViewDescriptor[];

export type PrimarySurfaceView = (typeof PRIMARY_SURFACE_VIEWS)[number]["id"];

/** Resolve any internal route to one of the three visible shell surfaces. */
export function primarySurfaceForView(view: ShellView): PrimarySurfaceView {
  if (view === "browser") return "browser";
  if (view === "code") return "code";
  return "agent";
}

/** Resolve a primary button click to the canonical route for that surface. */
export function shellViewForPrimarySurface(view: PrimarySurfaceView): ShellView {
  return view;
}

export function isWorkspaceView(view: ShellView): view is WorkspaceView {
  return view !== "agent";
}

export function shellViewLabel(view: ShellView): string {
  if (view === "agent") return "Chat";
  if (view === "code") return "IDE";
  if (view === "browser") return "Browser";
  return SECONDARY_SHELL_VIEWS.find((entry) => entry.id === view)?.label ?? view;
}
