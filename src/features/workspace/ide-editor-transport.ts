import { EDITOR_SERVER_ORIGIN } from "@/domain/editor-workspace-url";
import { invokeCore, isDesktopRuntime } from "@/lib/desktop";

export interface EditorServerStatus {
  state: "ready" | "starting" | "unavailable" | "error";
  url: string;
  message?: string;
}

export interface EditorWorkspaceFolder { id?: string; name: string; path: string }
export interface EditorWorkspace { workspacePath: string; folders: EditorWorkspaceFolder[] }

/** The fast local preview uses Vite; installed windows use session-guarded IPC. */
export function usesNativeEditorTransport(): boolean {
  if (!isDesktopRuntime()) return false;
  const location = new URL(window.location.href);
  const localPreview = location.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname) && location.port === "1420";
  return !localPreview;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "The editor connection could not be completed.";
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The editor request was cancelled.", "AbortError"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function nativeRequest<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("The editor request was cancelled.", "AbortError");
  try { return await abortable(request(), signal); }
  catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(errorMessage(error));
  }
}

function validateEditorUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("The editor connection returned an invalid address.");
  const url = new URL(value);
  if (url.origin !== EDITOR_SERVER_ORIGIN || url.username || url.password || url.pathname !== "/" || url.hash) {
    throw new Error("The editor connection returned an invalid address.");
  }
  return url.href;
}

export async function readEditorServerStatus(start: boolean, signal?: AbortSignal): Promise<EditorServerStatus> {
  let result: EditorServerStatus;
  if (usesNativeEditorTransport()) {
    result = start
      ? await nativeRequest(() => invokeCore<EditorServerStatus>("editor_server_start"), signal)
      : await nativeRequest(() => invokeCore<EditorServerStatus>("editor_server_status"), signal);
  } else {
    const response = await fetch("/__omnia_ide_server", {
      method: start ? "POST" : "GET", cache: "no-store", signal: signal ?? null,
      ...(start ? { headers: { "x-omnia-workbench": "editor-server-start" } } : {}),
    });
    if (response.status === 404) throw new Error("The editor connection service is unavailable in this build.");
    result = await response.json() as EditorServerStatus;
    if (!response.ok) throw new Error(result.message || "The editor connection could not be checked.");
  }
  if (!result || !["ready", "starting", "unavailable", "error"].includes(result.state)) throw new Error("The editor connection returned an invalid status.");
  return { ...result, url: validateEditorUrl(result.url) };
}

async function workspaceResponse(response: Response): Promise<EditorWorkspace> {
  const result = await response.json() as EditorWorkspace & { error?: string };
  if (!response.ok) throw new Error(result.error || "The workspace connection is unavailable.");
  if (!result || !Array.isArray(result.folders)) throw new Error("The workspace connection returned invalid folders.");
  return result;
}

export function readEditorWorkspace(signal?: AbortSignal): Promise<EditorWorkspace> {
  return usesNativeEditorTransport()
    ? nativeRequest(() => invokeCore<EditorWorkspace>("editor_workspace_get"), signal)
    : fetch("/__omnia_ide_workspace", { signal: signal ?? null }).then(workspaceResponse);
}

/** Native folder selection stays in the operating-system picker. */
export function pickEditorWorkspaceFolder(): Promise<EditorWorkspace> {
  return nativeRequest(() => invokeCore<EditorWorkspace>("editor_workspace_pick"));
}

export function removeEditorWorkspaceFolder(folderId: string): Promise<EditorWorkspace> {
  return nativeRequest(() => invokeCore<EditorWorkspace>("editor_workspace_remove", { folderId }));
}

export function updatePreviewWorkspaceFolders(folders: readonly EditorWorkspaceFolder[]): Promise<EditorWorkspace> {
  return fetch("/__omnia_ide_workspace", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Omnia-Workbench": "workspace-folder-update" }, body: JSON.stringify({ folders }),
  }).then(workspaceResponse);
}

/** Preserve the native connection token while encoding the selected workspace. */
export function connectedEditorUrl(serverUrl: string, workspaceUrl: string): string {
  const result = new URL(validateEditorUrl(serverUrl));
  const selected = new URL(workspaceUrl);
  if (selected.origin !== EDITOR_SERVER_ORIGIN) throw new Error("The selected editor address is invalid.");
  for (const key of ["workspace", "folder"]) {
    const value = selected.searchParams.get(key);
    if (value !== null) result.searchParams.set(key, value);
  }
  return result.href;
}
