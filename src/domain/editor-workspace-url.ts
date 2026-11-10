export const EDITOR_SERVER_ORIGIN = "http://127.0.0.1:1430";

/** VS Code's web server expects an absolute path in a single query value. */
export function editorWorkspaceUrl(target: { workspacePath?: string | null; folderPath?: string | null }): string {
  const workspace = target.workspacePath?.trim();
  const folder = target.folderPath?.trim();
  const selected = workspace || folder;
  const url = new URL(EDITOR_SERVER_ORIGIN);
  if (!selected) return url.href;
  const normalized = selected.replaceAll("\\", "/").replace(/^([A-Z]):/, (drive) => drive.toLowerCase());
  url.searchParams.set(workspace ? "workspace" : "folder", normalized.startsWith("/") ? normalized : `/${normalized}`);
  return url.href;
}
