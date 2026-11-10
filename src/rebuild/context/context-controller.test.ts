import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectContextController } from "./context-controller";
import { CONTENT_HASH, GRANT, PROJECT, SESSION, contextService, deferred, grant, indexSnapshot, pointer, preparedRun, receipt, retrieval, runRetrieval } from "./__tests__/context-fixtures";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
const scope = { projectId: PROJECT, sessionId: SESSION };

describe("project context native controller", () => {
  it("does not invoke native commands in preview or for a projectless session", async () => {
    const service = contextService(false); const controller = new ProjectContextController(service, scope);
    await controller.reload(); await controller.pickFiles(); await controller.pickFolder();
    expect(controller.getSnapshot().phase).toBe("unavailable"); expect(service.initialize).not.toHaveBeenCalled();
    const projectless = new ProjectContextController(contextService(), { projectId: null, sessionId: SESSION });
    await projectless.reload(); expect(projectless.getSnapshot().phase).toBe("no-project");
  });

  it("loads approved pointer/grant IDs, reads a verified retained snapshot and lists native receipts", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, scope);
    await controller.reload(); controller.selectPointer("pointer-a"); await controller.readPointer(); await controller.loadPointerReceipts();
    expect(service.listPointers).toHaveBeenCalledWith(PROJECT); expect(service.listGrants).toHaveBeenCalledWith(PROJECT);
    expect(service.readPointer).toHaveBeenCalledWith(PROJECT, "pointer-a", 1);
    expect(controller.getSnapshot().body).toMatchObject({ text: "hello", contentSha256: CONTENT_HASH, revision: 1 });
    expect(controller.getSnapshot().receipts[0]?.id).toBe("receipt-a");
  });

  it("uses native file/folder pickers and handles user cancellation without inventing items", async () => {
    const service = contextService(); service.listPointers = vi.fn().mockResolvedValue([]); service.listGrants = vi.fn().mockResolvedValue([]);
    const controller = new ProjectContextController(service, scope); await controller.reload(); await controller.pickFiles(); await controller.pickFolder();
    expect(service.pickFiles).toHaveBeenCalledWith(PROJECT); expect(service.pickFolder).toHaveBeenCalledWith(PROJECT);
    expect(controller.getSnapshot().pointers).toHaveLength(1); expect(controller.getSnapshot().grants).toHaveLength(1);
    service.pickFiles = vi.fn().mockResolvedValue(null); await controller.pickFiles();
    expect(controller.getSnapshot().notice).toMatch(/cancelled/i); expect(controller.getSnapshot().pointers).toHaveLength(1);
  });

  it("keeps source-missing pointer snapshots readable and refreshes with the current revision CAS", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, scope);
    await controller.reload(); controller.selectPointer("pointer-a"); await controller.refreshPointer();
    expect(service.refreshPointer).toHaveBeenCalledWith(PROJECT, "pointer-a", 1);
    expect(controller.getSnapshot().pointers[0]).toMatchObject({ revision: 2, sourceExists: false });
    service.readPointer = vi.fn().mockResolvedValue({ pointerId: "pointer-a", revision: 2, contentSha256: CONTENT_HASH, byteSize: 5, encoding: "base64", content: "aGVsbG8=" });
    await controller.readPointer(); expect(controller.getSnapshot().body?.text).toBe("hello");
    expect(controller.getSnapshot().receipts[0]?.outcome).toBe("source_missing");
  });

  it("drops late project responses including errors after a scope change", async () => {
    const service = contextService(); const late = deferred<ReturnType<typeof pointer>[]>();
    service.listPointers = vi.fn().mockImplementationOnce(() => late.promise).mockResolvedValue([]);
    const controller = new ProjectContextController(service, scope); const first = controller.reload();
    await vi.waitFor(() => expect(service.listPointers).toHaveBeenCalledOnce());
    controller.setScope({ projectId: "project-b", sessionId: "session-b" });
    service.listGrants = vi.fn().mockResolvedValue([]); await controller.reload();
    late.resolve([pointer()]); await first;
    expect(controller.getSnapshot().scope.projectId).toBe("project-b"); expect(controller.getSnapshot().pointers).toEqual([]);
    expect(controller.getSnapshot().error).toBeNull();
  });

  it("stops waiting, ignores late mutation success and requires an authoritative reload", async () => {
    const service = contextService(); const late = deferred<{ pointer: ReturnType<typeof pointer>; receipt: ReturnType<typeof receipt> }[]>();
    service.pickFiles = vi.fn().mockReturnValue(late.promise); const controller = new ProjectContextController(service, scope);
    await controller.reload(); const picking = controller.pickFiles(); await vi.waitFor(() => expect(service.pickFiles).toHaveBeenCalledOnce());
    controller.cancel(); expect(controller.getSnapshot().phase).toBe("cancelled"); expect(controller.getSnapshot().requiresReload).toBe(true);
    await controller.pickFiles(); expect(service.pickFiles).toHaveBeenCalledOnce();
    late.resolve([{ pointer: pointer({ id: "late-pointer" }), receipt: receipt({ pointerId: "late-pointer" }) }]); await picking;
    expect(controller.getSnapshot().pointers.some((entry) => entry.id === "late-pointer")).toBe(false);
    await controller.reload(); expect(controller.getSnapshot().requiresReload).toBe(false);
  });

  it("retains the mutation fence when a cancelled view reopens through the same native authority", async () => {
    const authority = {}; const service = Object.assign(contextService(), { mutationAuthority: authority });
    const late = deferred<{ pointer: ReturnType<typeof pointer>; receipt: ReturnType<typeof receipt> }[]>();
    service.pickFiles = vi.fn().mockReturnValue(late.promise); const first = new ProjectContextController(service, scope);
    await first.reload(); const picking = first.pickFiles(); await vi.waitFor(() => expect(service.pickFiles).toHaveBeenCalledOnce()); first.cancel();
    const reopened = new ProjectContextController({ ...service }, scope);
    expect(reopened.getSnapshot().requiresReload).toBe(true); await reopened.reload();
    expect(reopened.getSnapshot().requiresReload).toBe(true); await reopened.pickFiles(); expect(service.pickFiles).toHaveBeenCalledOnce();
    late.resolve([{ pointer: pointer(), receipt: receipt() }]); await picking;
    await reopened.pickFiles(); expect(service.pickFiles).toHaveBeenCalledOnce();
    await reopened.reload(); expect(reopened.getSnapshot().requiresReload).toBe(false);
  });

  it("does not reconcile from a reload that began before the pending mutation settled", async () => {
    const service = contextService(); const late = deferred<{ pointer: ReturnType<typeof pointer>; receipt: ReturnType<typeof receipt> }[]>();
    service.pickFiles = vi.fn().mockReturnValue(late.promise); const controller = new ProjectContextController(service, scope);
    await controller.reload(); const picking = controller.pickFiles(); await vi.waitFor(() => expect(service.pickFiles).toHaveBeenCalledOnce()); controller.cancel();
    const listed = deferred<ReturnType<typeof pointer>[]>(); service.listPointers = vi.fn().mockReturnValueOnce(listed.promise).mockResolvedValue([pointer()]);
    const reloading = controller.reload(); await vi.waitFor(() => expect(service.listPointers).toHaveBeenCalledOnce());
    late.resolve([{ pointer: pointer(), receipt: receipt() }]); await picking; listed.resolve([pointer()]); await reloading;
    expect(controller.getSnapshot().requiresReload).toBe(true); await controller.pickFiles(); expect(service.pickFiles).toHaveBeenCalledOnce();
    await controller.reload(); expect(controller.getSnapshot().requiresReload).toBe(false);
  });

  it("invalidates reconciliation when another controller mutates during its native list read", async () => {
    const service = contextService(); const first = new ProjectContextController(service, scope); await first.reload();
    const listed = deferred<ReturnType<typeof pointer>[]>(); service.listPointers = vi.fn().mockReturnValueOnce(listed.promise).mockResolvedValue([pointer()]);
    const reopened = new ProjectContextController(service, scope); const reloading = reopened.reload();
    await vi.waitFor(() => expect(service.listPointers).toHaveBeenCalledOnce()); await first.pickFiles(); listed.resolve([pointer()]); await reloading;
    expect(reopened.getSnapshot().requiresReload).toBe(true); await reopened.pickFiles(); expect(service.pickFiles).toHaveBeenCalledOnce();
    await reopened.reload(); expect(reopened.getSnapshot().requiresReload).toBe(false);
  });

  it("rechecks the shared fence after initialization before dispatching concurrent mutations", async () => {
    const service = contextService(); const initialization = deferred<unknown>(); service.initialize = vi.fn().mockReturnValue(initialization.promise);
    const first = new ProjectContextController(service, scope); const second = new ProjectContextController(service, scope);
    const firstPick = first.pickFiles(); const secondPick = second.pickFiles(); initialization.resolve(undefined); await Promise.all([firstPick, secondPick]);
    expect(service.pickFiles).toHaveBeenCalledOnce(); expect(second.getSnapshot().requiresReload).toBe(true);
    expect(second.getSnapshot().error?.code).toBe("reload_required"); await second.reload(); expect(second.getSnapshot().requiresReload).toBe(false);
  });

  it("surfaces denied and conflict errors without retrying or losing last good data", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, scope); await controller.reload();
    service.pickFiles = vi.fn().mockRejectedValue({ code: "permission_denied", message: "Access was denied" }); await controller.pickFiles();
    expect(controller.getSnapshot().error?.code).toBe("permission_denied"); expect(service.pickFiles).toHaveBeenCalledOnce();
    await controller.reload();
    controller.selectPointer("pointer-a"); service.refreshPointer = vi.fn().mockRejectedValue({ code: "pointer_revision_conflict", message: "Reload the pointer" });
    await controller.refreshPointer(); expect(controller.getSnapshot().error?.code).toBe("pointer_revision_conflict");
    expect(controller.getSnapshot().pointers[0]?.revision).toBe(1);
  });

  it("rejects cross-project pointers, mismatched body hashes and stale body revisions", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, scope);
    service.listPointers = vi.fn().mockResolvedValue([pointer({ projectId: "wrong-project" })]); await controller.reload();
    expect(controller.getSnapshot().error?.code).toBe("scope_mismatch"); expect(controller.getSnapshot().pointers).toEqual([]);
    service.listPointers = vi.fn().mockResolvedValue([pointer()]); await controller.reload(); controller.selectPointer("pointer-a");
    service.readPointer = vi.fn().mockResolvedValue({ pointerId: "pointer-a", revision: 1, contentSha256: CONTENT_HASH, byteSize: 5, encoding: "base64", content: "d29ybGQ=" });
    await controller.readPointer(); expect(controller.getSnapshot().body).toBeNull(); expect(controller.getSnapshot().error?.code).toBe("snapshot_integrity");
    service.readPointer = vi.fn().mockResolvedValue({ pointerId: "pointer-a", revision: 2, contentSha256: CONTENT_HASH, byteSize: 5, encoding: "base64", content: "aGVsbG8=" });
    await controller.readPointer(); expect(controller.getSnapshot().error?.code).toBe("stale_revision");
  });

  it("builds only the selected approved grant and retrieves bounded native citation results", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, scope); await controller.reload(); controller.selectGrant(GRANT);
    await controller.buildIndex(); expect(service.buildIndex).toHaveBeenCalledWith(GRANT, PROJECT, expect.objectContaining({ maxFiles: 2_000, includeUnknownText: false }));
    await controller.retrieve(" hello "); expect(service.retrieve).toHaveBeenCalledWith(indexSnapshot().chunks, "hello", expect.objectContaining({ tokenBudget: 8_000, maxResults: 12 }));
    expect(controller.getSnapshot().retrieval).toMatchObject({ kind: "inspection", providerInputAdmission: "not_admitted", indexSnapshotId: "index-a", query: "hello" });
    expect(controller.getSnapshot().retrieval?.result.matches[0]?.chunk.relativePath).toBe("hello.txt");
  });

  it("preserves the last successful index after failed rebuild and clears it when a grant changes", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, scope); await controller.reload(); controller.selectGrant(GRANT); await controller.buildIndex();
    service.buildIndex = vi.fn().mockRejectedValue({ code: "permission_denied", message: "Folder is no longer accessible" }); await controller.buildIndex();
    expect(controller.getSnapshot().index?.snapshotId).toBe("index-a"); expect(controller.getSnapshot().indexState).toBe("refresh-failed");
    service.listGrants = vi.fn().mockResolvedValue([grant({ revokedAtMs: 30 })]); await controller.reload();
    expect(controller.getSnapshot().index).toBeNull(); expect(controller.getSnapshot().grantId).toBeNull();
  });

  it("requires exact prepared IDs for run receipts and never claims provider admission", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, scope); await controller.reload(); controller.selectGrant(GRANT);
    await controller.retrieve("hello", true); expect(service.retrieveForRun).not.toHaveBeenCalled();
    controller.setScope({ ...scope, preparedRun }); await controller.reload(); controller.selectGrant(GRANT); await controller.retrieve("hello", true);
    expect(service.retrieveForRun).toHaveBeenCalledWith({ ...preparedRun, grantId: GRANT, query: "hello", indexOptions: expect.any(Object), retrievalOptions: expect.objectContaining({ maxResults: 12 }) });
    expect(controller.getSnapshot().retrieval).toMatchObject({ kind: "run-receipt", receiptId: "event-a", providerInputAdmission: "not_admitted" });
    const bad = runRetrieval(); bad.journalEvent.attemptId = "wrong-attempt"; service.retrieveForRun = vi.fn().mockResolvedValue(bad);
    await controller.retrieve("hello", true); expect(controller.getSnapshot().error?.code).toBe("scope_mismatch");
  });

  it("rejects malformed, overbudget and cross-grant retrieval data and invalid queries", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, scope); await controller.reload(); controller.selectGrant(GRANT); await controller.buildIndex();
    await controller.retrieve("  "); await controller.retrieve("x".repeat(8_193)); expect(service.retrieve).not.toHaveBeenCalled();
    const bad = retrieval(); bad.matches[0]!.chunk.grantId = "wrong-grant"; service.retrieve = vi.fn().mockResolvedValue(bad);
    await controller.retrieve("hello"); expect(controller.getSnapshot().error?.code).toBe("scope_mismatch");
    const over = retrieval(); over.consumedTokens = 8_001; service.retrieve = vi.fn().mockResolvedValue(over);
    await controller.retrieve("hello"); expect(controller.getSnapshot().error?.code).toBe("invalid_native_response");
    expect(controller.getSnapshot().retrieval).toBeNull();
  });

  it("requires reload after a multi-file picker reports failure because a prefix may have committed", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, scope); await controller.reload();
    service.pickFiles = vi.fn().mockRejectedValue({ code: "permission_denied", message: "Second selected file was denied after the first ingest" });
    await controller.pickFiles(); expect(controller.getSnapshot().requiresReload).toBe(true);
    await controller.pickFiles(); expect(service.pickFiles).toHaveBeenCalledOnce();
    await controller.reload(); expect(controller.getSnapshot().requiresReload).toBe(false);
  });

  it("ignores a late denied error after changing scope and a late body after selecting another pointer", async () => {
    const service = contextService(); const late = deferred<ReturnType<typeof pointer>[]>();
    service.listPointers = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue([]);
    const controller = new ProjectContextController(service, scope); const loading = controller.reload(); await vi.waitFor(() => expect(service.listPointers).toHaveBeenCalledOnce());
    controller.setScope({ projectId: "project-b", sessionId: "session-b" }); service.listGrants = vi.fn().mockResolvedValue([]); await controller.reload();
    late.reject({ code: "permission_denied", message: "Old project permission changed" }); await loading;
    expect(controller.getSnapshot().error).toBeNull(); expect(controller.getSnapshot().scope.projectId).toBe("project-b");
    controller.setScope(scope); service.listPointers = vi.fn().mockResolvedValue([pointer(), pointer({ id: "pointer-b" })]); await controller.reload();
    controller.selectPointer("pointer-a"); const body = deferred<Awaited<ReturnType<typeof service.readPointer>>>(); service.readPointer = vi.fn().mockReturnValue(body.promise);
    const reading = controller.readPointer(); await vi.waitFor(() => expect(service.readPointer).toHaveBeenCalledOnce()); controller.selectPointer("pointer-b");
    body.resolve({ pointerId: "pointer-a", revision: 1, contentSha256: CONTENT_HASH, byteSize: 5, encoding: "base64", content: "aGVsbG8=" }); await reading;
    expect(controller.getSnapshot().pointerId).toBe("pointer-b"); expect(controller.getSnapshot().body).toBeNull();
  });

  it("keeps prior authoritative lists after a failed reload and rehydrates new controllers from native state", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, scope); await controller.reload();
    service.listGrants = vi.fn().mockRejectedValue({ code: "storage_locked", message: "Grant store is locked" }); await controller.reload();
    expect(controller.getSnapshot().pointers).toHaveLength(1); expect(controller.getSnapshot().grants).toHaveLength(1); expect(controller.getSnapshot().error?.code).toBe("storage_locked");
    service.listGrants = vi.fn().mockResolvedValue([grant()]); const reopened = new ProjectContextController(service, scope); await reopened.reload();
    expect(reopened.getSnapshot().pointers[0]?.id).toBe("pointer-a"); expect(reopened.getSnapshot().grants[0]?.id).toBe(GRANT); expect(reopened.getSnapshot().index).toBeNull();
  });

  it("invalidates cancelled run journaling and requires settled native receipts before another run request", async () => {
    const service = contextService(); const controller = new ProjectContextController(service, { ...scope, preparedRun }); await controller.reload(); controller.selectGrant(GRANT);
    const late = deferred<ReturnType<typeof runRetrieval>>(); service.retrieveForRun = vi.fn().mockReturnValue(late.promise);
    const retrieving = controller.retrieve("hello", true); await vi.waitFor(() => expect(service.retrieveForRun).toHaveBeenCalledOnce()); controller.cancel();
    expect(controller.getSnapshot().requiresReload).toBe(true); await controller.reload(); expect(controller.getSnapshot().requiresReload).toBe(true);
    late.resolve(runRetrieval()); await retrieving; expect(controller.getSnapshot().retrieval).toBeNull(); await controller.reload();
    expect(controller.getSnapshot().requiresReload).toBe(false);
  });
});
