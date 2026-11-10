import { desktop, isDesktopRuntime, type IndexedWorkspaceChunk, type NativeProjectFilePointer, type NativeProjectFilePointerBody, type NativeProjectFilePointerMutation, type NativeProjectFilePointerReceipt, type RetrieveWorkspaceForRunRequest, type RunWorkspaceRetrievalResult, type WorkspaceGrantRecord, type WorkspaceIndexOptions, type WorkspaceIndexSnapshot, type WorkspaceRetrievalOptions, type WorkspaceRetrievalResult } from "@/lib/desktop";

/** Only native picker/grant identities enter this port. No path is an authority. */
export interface ProjectContextService {
  readonly available: boolean;
  /** Adapters for the same native runtime share mutation fences across panel lifetimes. */
  readonly mutationAuthority?: object;
  initialize(): Promise<unknown>;
  pickFiles(projectId: string): Promise<NativeProjectFilePointerMutation[] | null>;
  listPointers(projectId: string): Promise<NativeProjectFilePointer[]>;
  refreshPointer(projectId: string, pointerId: string, revision: number): Promise<NativeProjectFilePointerMutation>;
  readPointer(projectId: string, pointerId: string, revision: number): Promise<NativeProjectFilePointerBody>;
  listPointerReceipts(projectId: string, pointerId: string): Promise<NativeProjectFilePointerReceipt[]>;
  pickFolder(projectId: string): Promise<WorkspaceGrantRecord | null>;
  listGrants(projectId: string): Promise<WorkspaceGrantRecord[]>;
  buildIndex(grantId: string, projectId: string, options: WorkspaceIndexOptions): Promise<WorkspaceIndexSnapshot>;
  retrieve(chunks: IndexedWorkspaceChunk[], query: string, options: WorkspaceRetrievalOptions): Promise<WorkspaceRetrievalResult>;
  retrieveForRun(request: RetrieveWorkspaceForRunRequest): Promise<RunWorkspaceRetrievalResult>;
}

const nativeMutationAuthority = {};

export function nativeProjectContextService(): ProjectContextService {
  const available = isDesktopRuntime() && typeof (window.__TAURI_INTERNALS__ as { invoke?: unknown } | undefined)?.invoke === "function";
  let initialization: Promise<unknown> | null = null;
  return {
    available, mutationAuthority: nativeMutationAuthority,
    initialize() {
      initialization ??= desktop.runtimeInfo().then((info) => desktop.initializeCore(info.appVersion)).catch((error: unknown) => { initialization = null; throw error; });
      return initialization;
    },
    pickFiles: (projectId) => desktop.pickProjectFiles(projectId),
    listPointers: (projectId) => desktop.listProjectFilePointers(projectId),
    refreshPointer: (projectId, pointerId, revision) => desktop.refreshProjectFilePointer(projectId, pointerId, revision),
    readPointer: (projectId, pointerId, revision) => desktop.readProjectFilePointer(projectId, pointerId, revision),
    listPointerReceipts: (projectId, pointerId) => desktop.listProjectFilePointerReceipts(projectId, pointerId),
    pickFolder: (projectId) => desktop.pickWorkspaceFolder(projectId),
    listGrants: (projectId) => desktop.listWorkspaceGrants(projectId),
    buildIndex: (grantId, projectId, options) => desktop.buildWorkspaceIndex(grantId, projectId, options),
    retrieve: (chunks, query, options) => desktop.retrieveWorkspaceChunks(chunks, query, options),
    retrieveForRun: (request) => desktop.retrieveWorkspaceForRun(request),
  };
}
