/** Ordered view metadata only. Session contents remain native-owned and lazy. */
export interface SessionNavigationSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly openIds: readonly string[];
  readonly activeId: string | null;
  readonly updatedAtMs: number;
}

export interface SessionNavigationLoad {
  readonly snapshot: SessionNavigationSnapshot;
  readonly receiptId: string;
}

export interface SessionNavigationSaveRequest {
  readonly expectedRevision: number;
  readonly openIds: readonly string[];
  readonly activeId: string | null;
}

export interface SessionNavigationSave extends SessionNavigationLoad {
  readonly status: "saved" | "conflict";
}

export interface SessionNavigationPort {
  load(): Promise<SessionNavigationLoad>;
  save(request: SessionNavigationSaveRequest): Promise<SessionNavigationSave>;
}

const MAX_RECEIPT_ID_LENGTH = 256;

/** Receipt IDs are opaque native facts, but the renderer still bounds and
 * rejects malformed values before allowing them to influence reconciliation. */
export function validateSessionNavigationReceiptId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RECEIPT_ID_LENGTH || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Invalid session navigation receipt.");
  }
  return value;
}

type NavigationOperation =
  | { readonly type: "select"; readonly id: string | null }
  | { readonly type: "close"; readonly id: string }
  | { readonly type: "prune"; readonly ids: ReadonlySet<string> };

export const EMPTY_SESSION_NAVIGATION: SessionNavigationSnapshot = Object.freeze({
  schemaVersion: 1, revision: 0, openIds: Object.freeze([]), activeId: null, updatedAtMs: 0,
});

export function validateSessionNavigation(value: SessionNavigationSnapshot): SessionNavigationSnapshot {
  if (!value || Object.keys(value).sort().join(",") !== "activeId,openIds,revision,schemaVersion,updatedAtMs" || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) || value.updatedAtMs < 0 || !Array.isArray(value.openIds) || value.openIds.length > 256) {
    throw new Error("Invalid session navigation snapshot.");
  }
  const ids = new Set<string>();
  for (const id of value.openIds) {
    if (typeof id !== "string" || id.length === 0 || new TextEncoder().encode(id).length > 200 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id) || ids.has(id)) {
      throw new Error("Invalid session navigation ID.");
    }
    ids.add(id);
  }
  if (value.activeId !== null && !ids.has(value.activeId)) throw new Error("Session navigation selection is not open.");
  return Object.freeze({ ...value, openIds: Object.freeze([...value.openIds]) });
}

/** Browser preview keeps the same bounded metadata shape in its own store. */
export function createBrowserSessionNavigationPort(storage: Pick<Storage, "getItem" | "setItem">): SessionNavigationPort {
  const key = "omnia.agent.session-navigation.v1";
  const receiptFor = (revision: number) => revision === 0 ? "browser-session-navigation-empty" : `browser-session-navigation-revision-${revision}`;
  const load = (): SessionNavigationSnapshot => {
    const raw = storage.getItem(key);
    return raw === null ? EMPTY_SESSION_NAVIGATION : validateSessionNavigation(JSON.parse(raw) as SessionNavigationSnapshot);
  };
  return {
    load: async () => {
      const snapshot = load();
      return { snapshot, receiptId: receiptFor(snapshot.revision) };
    },
    save: async (request) => {
      const current = load();
      if (request.expectedRevision !== current.revision) return { status: "conflict", snapshot: current, receiptId: receiptFor(current.revision) };
      const snapshot = validateSessionNavigation({ schemaVersion: 1, revision: current.revision + 1, openIds: [...request.openIds], activeId: request.activeId, updatedAtMs: Date.now() });
      storage.setItem(key, JSON.stringify(snapshot));
      return { status: "saved", snapshot, receiptId: receiptFor(snapshot.revision) };
    },
  };
}

function apply(snapshot: SessionNavigationSnapshot, operations: readonly NavigationOperation[]): SessionNavigationSnapshot {
  let openIds = [...snapshot.openIds];
  let activeId = snapshot.activeId;
  for (const op of operations) {
    if (op.type === "select") {
      activeId = op.id;
      if (op.id !== null && !openIds.includes(op.id)) openIds = [...openIds, op.id].slice(-256);
    } else if (op.type === "close") {
      const index = openIds.indexOf(op.id);
      openIds = openIds.filter((id) => id !== op.id);
      if (activeId === op.id) activeId = openIds[index - 1] ?? openIds[index] ?? null;
    } else {
      openIds = openIds.filter((id) => op.ids.has(id));
      if (activeId !== null && !op.ids.has(activeId)) activeId = null;
    }
  }
  return validateSessionNavigation({ ...snapshot, openIds, activeId });
}

/**
 * Serializes CAS writes and rebases pending user operations after a conflict.
 * A delayed hydration never replaces clicks made while it was in flight.
 * Failed loads cannot trigger a first-write overwrite; pending edits remain
 * local until a successful load establishes the native revision.
 */
export class SessionNavigationClient {
  private base = EMPTY_SESSION_NAVIGATION;
  private pending: NavigationOperation[] = [];
  private loaded = false;
  private starting: Promise<void> | null = null;
  private saving: Promise<void> | null = null;
  private readonly listeners = new Set<(snapshot: SessionNavigationSnapshot) => void>();

  constructor(private readonly port: SessionNavigationPort, private readonly onError: (error: unknown) => void = () => undefined) {}

  get snapshot(): SessionNavigationSnapshot { return apply(this.base, this.pending); }

  subscribe(listener: (snapshot: SessionNavigationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void { const snapshot = this.snapshot; this.listeners.forEach((listener) => listener(snapshot)); }

  start(): Promise<void> {
    if (this.loaded) return this.flush();
    if (this.starting) return this.starting;
    this.starting = this.port.load().then((response) => {
      this.base = validateSessionNavigation(response.snapshot);
      validateSessionNavigationReceiptId(response.receiptId);
      this.loaded = true;
      this.emit();
    }).finally(() => { this.starting = null; });
    return this.starting.then(() => this.flush());
  }

  select(id: string | null): void { this.enqueue({ type: "select", id }); }
  close(id: string): void { this.enqueue({ type: "close", id }); }
  prune(ids: ReadonlySet<string>): void { this.enqueue({ type: "prune", ids: new Set(ids) }); }

  private enqueue(operation: NavigationOperation): void {
    const before = this.snapshot;
    const after = apply(before, [operation]);
    // A no-op before hydration still records intent (e.g. the home view or a
    // deleted session) so old durable state cannot resurrect it after load.
    if (this.loaded && before.activeId === after.activeId && before.openIds.join("\u0000") === after.openIds.join("\u0000")) return;
    this.pending.push(operation);
    this.emit();
    if (this.loaded) void this.flush().catch(this.onError);
  }

  flush(): Promise<void> {
    if (!this.loaded) return Promise.resolve();
    if (this.saving) return this.saving;
    this.saving = (async () => {
      let conflicts = 0;
      while (this.pending.length > 0) {
        const count = this.pending.length;
        const desired = this.snapshot;
        const response = await this.port.save({ expectedRevision: this.base.revision, openIds: desired.openIds, activeId: desired.activeId });
        const snapshot = validateSessionNavigation(response.snapshot);
        validateSessionNavigationReceiptId(response.receiptId);
        if (response.status === "saved") {
          if (snapshot.revision !== this.base.revision + 1 || snapshot.activeId !== desired.activeId || snapshot.openIds.join("\u0000") !== desired.openIds.join("\u0000")) {
            throw new Error("Native navigation receipt does not match the saved tab list.");
          }
          this.pending.splice(0, count);
          conflicts = 0;
        } else {
          if (response.status !== "conflict" || snapshot.revision < this.base.revision) throw new Error("Invalid native navigation conflict receipt.");
          conflicts += 1;
        }
        this.base = snapshot;
        this.emit();
        if (conflicts >= 3) throw new Error("Session tabs changed in another window. Local tabs are retained; retry after the other window finishes.");
      }
    })().finally(() => { this.saving = null; });
    return this.saving;
  }
}
