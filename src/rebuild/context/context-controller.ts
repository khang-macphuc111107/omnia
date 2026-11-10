import type { NativeProjectFilePointer, NativeProjectFilePointerReceipt, WorkspaceGrantRecord, WorkspaceIndexSnapshot, WorkspaceRetrievalResult } from "@/lib/desktop";
import { CONTEXT_INDEX_OPTIONS, CONTEXT_RETRIEVAL_OPTIONS, ContextError, bool, contextFailure, decodeGrant, decodeGrants, decodeIndex, decodeMutation, decodeMutations, decodePointerBody, decodePointerReceipts, decodePointers, decodeRetrieval, decodeStats, hash, integer, record, scopeMismatch, text, validQuery, type ContextFailure, type RetainedPointerBody } from "./context-model";
import type { ProjectContextService } from "./context-service";

export interface PreparedContextRun { runId: string; attemptId: string; frozenProviderInputId: string }
export interface ProjectContextScope { projectId: string | null; sessionId: string | null; preparedRun?: PreparedContextRun | null }
export type ContextPhase = "unavailable" | "no-project" | "idle" | "loading" | "working" | "ready" | "error" | "cancelled";
export interface ContextRetrievalReceipt {
  kind: "inspection" | "run-receipt"; query: string; result: WorkspaceRetrievalResult;
  indexSnapshotId: string; indexSnapshotSha256: string; indexTruncated: boolean; indexHasErrors: boolean;
  receiptId: string | null; runId: string | null; attemptId: string | null; journalSequence: number | null;
  providerInputAdmission: "not_admitted";
}
export interface ProjectContextSnapshot {
  scope: ProjectContextScope; phase: ContextPhase; operation: string | null;
  pointers: NativeProjectFilePointer[]; pointerId: string | null; receipts: NativeProjectFilePointerReceipt[]; body: RetainedPointerBody | null;
  grants: WorkspaceGrantRecord[]; grantId: string | null; index: WorkspaceIndexSnapshot | null;
  indexState: "none" | "current" | "refresh-failed"; retrieval: ContextRetrievalReceipt | null;
  requiresReload: boolean; error: ContextFailure | null; notice: string | null;
}
interface Pending { generation: number; operation: string; projectId: string; mutation: boolean; mutationId: symbol }
interface MutationLedger { mutations: Map<symbol, string>; uncertainProjects: Set<string>; epochs: Map<string, symbol> }
// This survives panel/controller recreation within one renderer runtime. Native restart reconciliation remains a native contract.
const mutationLedgers = new WeakMap<object, MutationLedger>();
function mutationLedger(service: ProjectContextService): MutationLedger {
  const authority = service.mutationAuthority ?? service;
  let ledger = mutationLedgers.get(authority);
  if (!ledger) { ledger = { mutations: new Map(), uncertainProjects: new Set(), epochs: new Map() }; mutationLedgers.set(authority, ledger); }
  return ledger;
}
const scopeKey = (scope: ProjectContextScope): string => JSON.stringify([scope.projectId, scope.sessionId, scope.preparedRun?.runId ?? null, scope.preparedRun?.attemptId ?? null, scope.preparedRun?.frozenProviderInputId ?? null]);
function initial(service: ProjectContextService, scope: ProjectContextScope, requiresReload = false): ProjectContextSnapshot {
  return { scope: { ...scope, preparedRun: scope.preparedRun ? { ...scope.preparedRun } : null }, phase: !scope.projectId ? "no-project" : service.available ? "idle" : "unavailable",
    operation: null, pointers: [], pointerId: null, receipts: [], body: null, grants: [], grantId: null, index: null, indexState: "none", retrieval: null, requiresReload, error: null, notice: null };
}

/** A generation invalidates every prior IPC completion, including errors and local hash work. */
export class ProjectContextController {
  private generation = 0;
  private pending: Pending | null = null;
  private ledger: MutationLedger;
  private listeners = new Set<() => void>();
  private snapshot: ProjectContextSnapshot;
  constructor(private service: ProjectContextService, scope: ProjectContextScope) {
    this.ledger = mutationLedger(service);
    this.snapshot = initial(service, scope, Boolean(scope.projectId && (this.ledger.uncertainProjects.has(scope.projectId) || this.activeMutation(scope.projectId))));
  }
  getSnapshot = (): ProjectContextSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<ProjectContextSnapshot>): void { this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach((listener) => listener()); }
  private current(ticket: Pending): boolean { return this.pending === ticket && this.generation === ticket.generation; }
  private activeMutation(projectId: string): boolean { return [...this.ledger.mutations.values()].includes(projectId); }
  private fail(error: unknown): void { this.update({ phase: "error", operation: null, error: contextFailure(error), notice: null }); }
  private begin(operation: string, mutation: boolean, reload = false): Pending | null {
    const projectId = this.snapshot.scope.projectId;
    if (!projectId || !this.service.available) return null;
    if (this.pending) return null;
    if (!reload && (this.snapshot.requiresReload || this.ledger.uncertainProjects.has(projectId) || this.activeMutation(projectId))) {
      this.update({ requiresReload: true }); this.fail(new ContextError("reload_required", "Reload project context after the native operation settles. It may have completed after you stopped waiting.")); return null;
    }
    if (!projectId.trim() || projectId.length > 256 || /[\u0000-\u001f\u007f]/.test(projectId)) { this.fail(new ContextError("invalid_project", "Choose a valid native project before linking context.")); return null; }
    const ticket: Pending = { generation: ++this.generation, operation, projectId, mutation, mutationId: Symbol(operation) };
    this.pending = ticket; this.update({ phase: reload ? "loading" : "working", operation, error: null, notice: null }); return ticket;
  }
  private async execute<T>(operation: string, task: (projectId: string) => Promise<T>, apply: (value: T) => Partial<ProjectContextSnapshot>, mutation = false, reload = false): Promise<void> {
    const ticket = this.begin(operation, mutation, reload); if (!ticket) return;
    let dispatched = false;
    try {
      await this.service.initialize(); if (!this.current(ticket)) return;
      if (!reload && (this.ledger.uncertainProjects.has(ticket.projectId) || this.activeMutation(ticket.projectId))) {
        this.update({ requiresReload: true });
        throw new ContextError("reload_required", "Another native mutation began while context was initializing. Reload after it settles before another action.");
      }
      dispatched = true;
      if (mutation) { this.ledger.mutations.set(ticket.mutationId, ticket.projectId); this.ledger.epochs.set(ticket.projectId, ticket.mutationId); }
      const value = await task(ticket.projectId);
      if (mutation) this.ledger.mutations.delete(ticket.mutationId);
      if (!this.current(ticket)) return;
      const patch = apply(value); this.pending = null;
      this.update({ phase: "ready", operation: null, error: null, ...patch });
    } catch (error: unknown) {
      this.ledger.mutations.delete(ticket.mutationId);
      if (!this.current(ticket)) return;
      this.pending = null; const failure = contextFailure(error);
      // A multi-file ingest can commit a prefix before failing. Never silently replay an unknown mutation.
      const definitelyUnaccepted = /permission|denied|forbidden|revision_conflict|project_not_found|invalid_project/.test(failure.code);
      if (mutation && dispatched && (operation === "pick-files" || !definitelyUnaccepted)) this.ledger.uncertainProjects.add(ticket.projectId);
      this.update({ phase: "error", operation: null, error: failure, notice: null,
        requiresReload: this.snapshot.requiresReload || this.ledger.uncertainProjects.has(ticket.projectId) || this.activeMutation(ticket.projectId),
        ...(operation === "build-index" && this.snapshot.index ? { indexState: "refresh-failed" as const } : {}) });
    } finally { this.ledger.mutations.delete(ticket.mutationId); }
  }
  setScope = (scope: ProjectContextScope): void => {
    if (scopeKey(scope) === scopeKey(this.snapshot.scope)) return;
    this.cancel(); this.generation += 1;
    this.snapshot = initial(this.service, scope, Boolean(scope.projectId && (this.ledger.uncertainProjects.has(scope.projectId) || this.activeMutation(scope.projectId))));
    this.listeners.forEach((listener) => listener());
  };
  cancel = (): void => {
    const pending = this.pending; if (!pending) return;
    this.generation += 1; this.pending = null;
    const mayMutate = pending.mutation && this.ledger.mutations.has(pending.mutationId);
    if (mayMutate) this.ledger.uncertainProjects.add(pending.projectId);
    this.update({ phase: "cancelled", operation: null, error: null, requiresReload: this.snapshot.requiresReload || mayMutate,
      notice: mayMutate ? "Stopped waiting. The native operation may still finish; reload receipts before another action." : "Stopped waiting. A native request may still finish; its late result will be ignored." });
  };
  reload = async (): Promise<void> => {
    await this.execute("reload", async (projectId) => {
      const mutationAtReadStart = this.activeMutation(projectId); const mutationEpoch = this.ledger.epochs.get(projectId);
      const [pointers, grants] = await Promise.all([this.service.listPointers(projectId), this.service.listGrants(projectId)]);
      return { pointers: decodePointers(pointers, projectId), grants: decodeGrants(grants, projectId), mutationAtReadStart, mutationEpoch };
    }, ({ pointers, grants, mutationAtReadStart, mutationEpoch }) => {
      const projectId = this.snapshot.scope.projectId!;
      const unsettled = mutationAtReadStart || this.activeMutation(projectId) || mutationEpoch !== this.ledger.epochs.get(projectId);
      if (unsettled) this.ledger.uncertainProjects.add(projectId); else this.ledger.uncertainProjects.delete(projectId);
      const priorPointer = this.snapshot.pointers.find((entry) => entry.id === this.snapshot.pointerId);
      const selectedPointer = pointers.find((entry) => entry.id === this.snapshot.pointerId);
      const samePointer = selectedPointer && priorPointer && selectedPointer.revision === priorPointer.revision && selectedPointer.contentSha256 === priorPointer.contentSha256;
      const priorGrant = this.snapshot.grants.find((entry) => entry.id === this.snapshot.grantId);
      const selectedGrant = grants.find((entry) => entry.id === this.snapshot.grantId);
      const sameGrant = selectedGrant && priorGrant && selectedGrant.updatedAtMs === priorGrant.updatedAtMs && selectedGrant.projectId === priorGrant.projectId;
      return { pointers, grants, pointerId: selectedPointer?.id ?? null, grantId: selectedGrant?.id ?? null,
        body: samePointer ? this.snapshot.body : null, receipts: samePointer ? this.snapshot.receipts : [],
        index: sameGrant ? this.snapshot.index : null, indexState: sameGrant ? this.snapshot.indexState : "none", retrieval: sameGrant ? this.snapshot.retrieval : null,
        requiresReload: unsettled, notice: unsettled ? "A native mutation overlapped this reload. Reload again after it settles; no operation will be replayed." : "Native project pointers and active folder grants reloaded. Rebuild the index to check changed files." };
    }, false, true);
  };
  pickFiles = async (): Promise<void> => {
    await this.execute("pick-files", async (projectId) => { const result = await this.service.pickFiles(projectId); return result === null ? null : decodeMutations(result, projectId); }, (mutations) => {
      if (!mutations?.length) return { notice: "File selection cancelled. Existing pointers are unchanged." };
      const pointers = new Map(this.snapshot.pointers.map((pointer) => [pointer.id, pointer])); mutations.forEach((mutation) => pointers.set(mutation.pointer.id, mutation.pointer));
      const selected = mutations[0]!;
      return { pointers: [...pointers.values()], pointerId: selected.pointer.id, receipts: [selected.receipt], body: null, notice: `${mutations.length} native file pointer receipt${mutations.length === 1 ? "" : "s"} received.` };
    }, true);
  };
  pickFolder = async (): Promise<void> => {
    await this.execute("pick-folder", async (projectId) => { const result = await this.service.pickFolder(projectId); return result === null ? null : decodeGrant(result, projectId); }, (grant) => {
      if (!grant) return { notice: "Folder selection cancelled. Existing grants are unchanged." };
      if (grant.revokedAtMs !== null) throw new ContextError("grant_revoked", "The selected folder grant was revoked. Choose the folder again.");
      return { grants: [...this.snapshot.grants.filter((entry) => entry.id !== grant.id), grant], grantId: grant.id, index: null, indexState: "none", retrieval: null, notice: "Read-only native folder approval received. Build an index explicitly to read supported files." };
    }, true);
  };
  selectPointer = (id: string): void => {
    if (id && !this.snapshot.pointers.some((entry) => entry.id === id)) { this.fail(new ContextError("pointer_unavailable", "Reload the native pointer list before selecting this file.")); return; }
    this.cancel(); this.generation += 1; this.update({ pointerId: id || null, receipts: [], body: null, error: null, notice: null, phase: "ready" });
  };
  selectGrant = (id: string): void => {
    if (id && !this.snapshot.grants.some((entry) => entry.id === id && entry.revokedAtMs === null)) { this.fail(new ContextError("grant_unavailable", "Choose an active folder grant from the native list.")); return; }
    this.cancel(); this.generation += 1; this.update({ grantId: id || null, index: null, indexState: "none", retrieval: null, error: null, notice: null, phase: "ready" });
  };
  private pointer(): NativeProjectFilePointer | null {
    const pointer = this.snapshot.pointers.find((entry) => entry.id === this.snapshot.pointerId);
    if (!pointer) { this.fail(new ContextError("pointer_required", "Choose a linked file first.")); return null; } return pointer;
  }
  readPointer = async (): Promise<void> => {
    const pointer = this.pointer(); if (!pointer) return;
    await this.execute("read-snapshot", async (projectId) => decodePointerBody(await this.service.readPointer(projectId, pointer.id, pointer.revision), pointer), (body) => ({ body, notice: "Retained snapshot bytes verified against the native pointer SHA-256 receipt." }));
  };
  loadPointerReceipts = async (): Promise<void> => {
    const pointer = this.pointer(); if (!pointer) return;
    await this.execute("pointer-receipts", async (projectId) => decodePointerReceipts(await this.service.listPointerReceipts(projectId, pointer.id), pointer), (receipts) => ({ receipts, notice: `${receipts.length} immutable native synchronization receipt${receipts.length === 1 ? "" : "s"} loaded.` }));
  };
  refreshPointer = async (): Promise<void> => {
    const pointer = this.pointer(); if (!pointer) return;
    await this.execute("refresh-pointer", async (projectId) => decodeMutation(await this.service.refreshPointer(projectId, pointer.id, pointer.revision), projectId, pointer), (mutation) => ({
      pointers: this.snapshot.pointers.map((entry) => entry.id === pointer.id ? mutation.pointer : entry), body: null,
      receipts: [mutation.receipt, ...this.snapshot.receipts.filter((entry) => entry.id !== mutation.receipt.id)],
      notice: mutation.pointer.sourceExists ? `File synchronization: ${mutation.receipt.outcome}.` : "Source missing; the last verified native snapshot is retained and remains readable." }), true);
  };
  buildIndex = async (): Promise<void> => {
    const grantId = this.snapshot.grantId;
    if (!grantId) { this.fail(new ContextError("grant_required", "Choose an approved folder before building its index.")); return; }
    await this.execute("build-index", async (projectId) => decodeIndex(await this.service.buildIndex(grantId, projectId, { ...CONTEXT_INDEX_OPTIONS }), projectId, grantId), (index) => ({ index, indexState: "current", retrieval: null,
      notice: `Native index snapshot received: ${index.stats.indexedFiles} files, ${index.stats.indexedChunks} chunks. This snapshot is held in this panel; it does not prove persistent index storage.` }));
  };
  retrieve = async (rawQuery: string, forRun = false): Promise<void> => {
    let query: string; try { query = validQuery(rawQuery); } catch (error) { this.fail(error); return; }
    const { grantId, index, scope } = this.snapshot;
    if (!grantId) { this.fail(new ContextError("grant_required", "Choose an approved folder before retrieval.")); return; }
    if (!forRun && !index) { this.fail(new ContextError("index_required", "Build a native index before inspecting citations.")); return; }
    const prepared = scope.preparedRun;
    if (forRun && (!prepared || !scope.sessionId)) { this.fail(new ContextError("prepared_run_required", "Root must provide the exact native prepared run, attempt and frozen input IDs before journaling retrieval.")); return; }
    if (forRun) {
      try { text(prepared!.runId, 256); text(prepared!.attemptId, 256); text(prepared!.frozenProviderInputId, 256); } catch (error) { this.fail(error); return; }
    }
    await this.execute(forRun ? "retrieve-for-run" : "retrieve", async (projectId): Promise<ContextRetrievalReceipt> => {
      if (!forRun) {
        const result = await decodeRetrieval(await this.service.retrieve(index!.chunks, query, { ...CONTEXT_RETRIEVAL_OPTIONS }), projectId, grantId, query, index!);
        return { kind: "inspection", query, result, indexSnapshotId: index!.snapshotId, indexSnapshotSha256: index!.snapshotSha256,
          indexTruncated: index!.truncated, indexHasErrors: index!.hasErrors, receiptId: null, runId: null, attemptId: null, journalSequence: null, providerInputAdmission: "not_admitted" };
      }
      const response = record(await this.service.retrieveForRun({ ...prepared!, grantId, query, indexOptions: { ...CONTEXT_INDEX_OPTIONS }, retrievalOptions: { ...CONTEXT_RETRIEVAL_OPTIONS } }));
      const event = record(response.journalEvent);
      if (event.runId !== prepared!.runId || event.attemptId !== prepared!.attemptId || event.frozenProviderInputId !== prepared!.frozenProviderInputId || event.eventType !== "context.retrieval_receipt" || event.schemaVersion !== 1) scopeMismatch();
      if (response.providerInputAdmission !== "not_admitted") throw new ContextError("invalid_native_response", "The retrieval contract cannot admit context to frozen provider input.");
      decodeStats(response.indexStats);
      return { kind: "run-receipt", query, result: await decodeRetrieval(response.retrieval, projectId, grantId, query),
        indexSnapshotId: text(response.indexSnapshotId, 256), indexSnapshotSha256: hash(response.indexSnapshotSha256),
        indexTruncated: bool(response.indexTruncated), indexHasErrors: bool(response.indexHasErrors), receiptId: text(event.id, 256),
        runId: prepared!.runId, attemptId: prepared!.attemptId, journalSequence: integer(event.sequence, Number.MAX_SAFE_INTEGER, 1), providerInputAdmission: "not_admitted" };
    }, (retrieval) => ({ retrieval, notice: retrieval.kind === "inspection" ? "Native citation inspection complete. No run was modified and no provider input was admitted." : "Native run-scoped retrieval receipt journaled. Frozen provider input remains unchanged; admission is not_admitted." }), forRun);
  };
}
