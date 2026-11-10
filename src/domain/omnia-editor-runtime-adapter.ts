import {
  commitEditorChange,
  createEditorDocument,
  createEditorHistory,
  deserializeEditorDocument,
  redoEditorChange,
  serializeEditorDocument,
  setEditorSelection,
  undoEditorChange,
  updateEditorBlock,
  type EditorBlock,
  type EditorDocument,
  type EditorFormat,
  type EditorHistory,
  type EditorSelection,
} from "./omnia-editor-model";
import { assertDomain } from "./errors";

/**
 * Renderer-safe editor lifecycle state.
 *
 * This module deliberately owns document/session semantics only. A native
 * implementation can satisfy `EditorPersistenceAdapter` without exposing
 * filesystem paths, IPC handles, or credentials to the renderer.
 */
export type EditorRuntimeMode = "browser-preview" | "native";
export type EditorRuntimeStatus =
  | "closed"
  | "loading"
  | "ready"
  | "dirty"
  | "saving"
  | "error";

export type EditorPersistenceRecord = {
  readonly version: 1;
  readonly document: EditorDocument;
  /** Monotonic adapter-owned revision. New documents start at revision 0. */
  readonly revision: number;
  readonly savedAt: string;
};

export type EditorPersistenceSaveRequest = {
  readonly document: EditorDocument;
  /** The revision the caller last observed. */
  readonly expectedRevision: number;
  readonly idempotencyKey?: string;
};

export interface EditorPersistenceAdapter {
  readonly mode?: EditorRuntimeMode;
  load(documentId: string): Promise<EditorPersistenceRecord | null>;
  save(request: EditorPersistenceSaveRequest): Promise<EditorPersistenceRecord>;
}

/** Alias kept for consumers that call the boundary a runtime adapter. */
export type EditorRuntimePersistenceAdapter = EditorPersistenceAdapter;

export type EditorRuntimeState = {
  readonly version: 1;
  readonly document: EditorDocument;
  readonly history: EditorHistory;
  readonly status: EditorRuntimeStatus;
  /** Local edit revision. It advances for every accepted state transition. */
  readonly revision: number;
  /** Last adapter revision acknowledged by a successful save/load. */
  readonly persistedRevision: number;
  readonly mode: EditorRuntimeMode;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly error?: string;
};

/** Snapshot is a more convenient name for UI/application adapters. */
export type EditorRuntimeSnapshot = EditorRuntimeState;

export type EditorRuntimeChange =
  | { readonly type: "set-title"; readonly title: string }
  | {
      readonly type: "update-block";
      readonly blockId: string;
      readonly patch: Partial<Omit<EditorBlock, "id">>;
    }
  | {
      readonly type: "insert-block";
      readonly block: EditorBlock;
      readonly index?: number;
    }
  | { readonly type: "remove-block"; readonly blockId: string }
  | {
      readonly type: "move-block";
      readonly blockId: string;
      readonly index: number;
    }
  | {
      readonly type: "set-selection";
      readonly selection?: EditorSelection;
    }
  | { readonly type: "replace-document"; readonly document: EditorDocument };

export type EditorRuntimeOptions = {
  readonly mode?: EditorRuntimeMode;
  readonly now?: string;
};

export type OpenEditorRuntimeOptions = EditorRuntimeOptions & {
  readonly createIfMissing?: boolean;
  readonly title?: string;
};

export type PersistEditorRuntimeOptions = {
  readonly idempotencyKey?: string;
  readonly now?: string;
};

export type EditorSaveResult = {
  readonly state: EditorRuntimeState;
  readonly receipt: EditorPersistenceRecord;
};

export type EditorRuntimeEvent = {
  readonly type: "opened" | "changed" | "undone" | "redone" | "saved" | "closed" | "error";
  readonly documentId: string;
  readonly revision: number;
  readonly timestamp: string;
  readonly error?: string;
};

export type EditorRuntimeListener = (event: EditorRuntimeEvent, state: EditorRuntimeState | null) => void;

const EDITOR_RUNTIME_VERSION = 1 as const;
const runtimeStatuses: readonly EditorRuntimeStatus[] = [
  "closed",
  "loading",
  "ready",
  "dirty",
  "saving",
  "error",
];

function stamp(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function assertRuntimeString(value: string, label: string): string {
  const normalized = value.trim();
  assertDomain(normalized.length > 0, "invalid_argument", `${label} cannot be blank.`, { label });
  return normalized;
}

function cloneDocument(document: EditorDocument): EditorDocument {
  return deserializeEditorDocument(JSON.parse(serializeEditorDocument(document)) as unknown);
}

function cloneHistory(history: EditorHistory): EditorHistory {
  return {
    past: history.past.map(cloneDocument),
    present: cloneDocument(history.present),
    future: history.future.map(cloneDocument),
  };
}

function documentsEqual(left: EditorDocument, right: EditorDocument): boolean {
  return serializeEditorDocument(left) === serializeEditorDocument(right);
}

function validateBlock(block: EditorBlock, existingIds: ReadonlySet<string> = new Set()): EditorBlock {
  assertDomain(isRecord(block), "invalid_argument", "Editor block must be an object.");
  assertDomain(assertRuntimeString(block.id, "Editor block id"), "invalid_argument", "Editor block id cannot be blank.");
  assertDomain(typeof block.text === "string", "invalid_argument", "Editor block text must be a string.");
  assertDomain(!existingIds.has(block.id), "conflict", `Duplicate editor block id: ${block.id}`, {
    blockId: block.id,
  });
  if (block.language !== undefined) assertDomain(typeof block.language === "string", "invalid_argument", "Editor block language must be a string.");
  if (block.checked !== undefined) assertDomain(typeof block.checked === "boolean", "invalid_argument", "Editor checklist state must be boolean.");
  if (block.format !== undefined) {
    assertDomain(isRecord(block.format), "invalid_argument", "Editor block format must be an object.");
    if (block.format.bold !== undefined) assertDomain(typeof block.format.bold === "boolean", "invalid_argument", "Editor bold format must be boolean.");
    if (block.format.italic !== undefined) assertDomain(typeof block.format.italic === "boolean", "invalid_argument", "Editor italic format must be boolean.");
    if (block.format.underline !== undefined) assertDomain(typeof block.format.underline === "boolean", "invalid_argument", "Editor underline format must be boolean.");
    if (block.format.color !== undefined) assertDomain(typeof block.format.color === "string", "invalid_argument", "Editor color format must be a string.");
    if (block.format.fontFamily !== undefined) assertDomain(typeof block.format.fontFamily === "string", "invalid_argument", "Editor font family must be a string.");
    if (block.format.fontSize !== undefined) assertDomain(typeof block.format.fontSize === "number" && Number.isFinite(block.format.fontSize) && block.format.fontSize > 0, "invalid_argument", "Editor font size must be a positive finite number.");
  }
  return {
    id: block.id,
    kind: block.kind,
    text: block.text,
    ...(block.language !== undefined ? { language: block.language } : {}),
    ...(block.format !== undefined ? { format: { ...(block.format as EditorFormat) } } : {}),
    ...(block.checked !== undefined ? { checked: block.checked } : {}),
  };
}

/** Validate and defensively clone a document at the renderer/native boundary. */
export function validateEditorRuntimeDocument(document: EditorDocument): EditorDocument {
  const parsed = deserializeEditorDocument(document);
  assertRuntimeString(parsed.id, "Editor document id");
  assertRuntimeString(parsed.title, "Editor document title");
  const ids = new Set<string>();
  const blocks = parsed.blocks.map((block) => {
    const cloned = validateBlock(block, ids);
    ids.add(cloned.id);
    return cloned;
  });
  if (parsed.selection !== undefined) {
    assertDomain(ids.has(parsed.selection.blockId), "not_found", "Editor selection references an unknown block.", {
      blockId: parsed.selection.blockId,
    });
    const selectedBlock = blocks.find((block) => block.id === parsed.selection?.blockId);
    assertDomain(selectedBlock !== undefined, "not_found", "Editor selection block was not found.");
    assertDomain(parsed.selection.end <= selectedBlock.text.length, "invalid_argument", "Editor selection exceeds block text length.");
  }
  return {
    version: 1,
    id: parsed.id,
    title: parsed.title,
    blocks,
    ...(parsed.selection ? { selection: { ...parsed.selection } } : {}),
    updatedAt: parsed.updatedAt,
  };
}

function normalizeRecord(record: EditorPersistenceRecord): EditorPersistenceRecord {
  assertDomain(record.version === 1, "invalid_argument", "Unsupported editor persistence record version.");
  const document = validateEditorRuntimeDocument(record.document);
  assertDomain(isFiniteInteger(record.revision) && record.revision >= 0, "invalid_argument", "Editor persistence revision must be a non-negative integer.");
  assertDomain(isString(record.savedAt) && record.savedAt.trim().length > 0, "invalid_argument", "Editor persistence timestamp is required.");
  return {
    version: 1,
    document,
    revision: record.revision,
    savedAt: record.savedAt,
  };
}

function normalizeMode(mode: EditorRuntimeMode | undefined): EditorRuntimeMode {
  return mode ?? "browser-preview";
}

function nextRevision(state: EditorRuntimeState): number {
  return state.revision + 1;
}

function stateWith(
  state: EditorRuntimeState,
  patch: Omit<Partial<EditorRuntimeState>, "version" | "history" | "document" | "revision" | "error"> & {
    readonly history?: EditorHistory;
    readonly document?: EditorDocument;
    readonly revision?: number;
    /** Explicit `undefined` clears a previous runtime error. */
    readonly error?: string | undefined;
  },
): EditorRuntimeState {
  const history = patch.history ? cloneHistory(patch.history) : cloneHistory(state.history);
  const document = patch.document ? validateEditorRuntimeDocument(patch.document) : cloneDocument(history.present);
  return {
    version: EDITOR_RUNTIME_VERSION,
    document,
    history,
    status: patch.status ?? state.status,
    revision: patch.revision ?? state.revision,
    persistedRevision: patch.persistedRevision ?? state.persistedRevision,
    mode: patch.mode ?? state.mode,
    openedAt: patch.openedAt ?? state.openedAt,
    updatedAt: patch.updatedAt ?? state.updatedAt,
    ...("error" in patch
      ? patch.error !== undefined
        ? { error: patch.error }
        : {}
      : state.error !== undefined
        ? { error: state.error }
        : {}),
  };
}

function assertOpen(state: EditorRuntimeState): void {
  assertDomain(state.status !== "closed", "invalid_state_transition", "Editor runtime is closed.");
  assertDomain(state.status !== "loading", "invalid_state_transition", "Editor runtime is still loading.");
  assertDomain(state.status !== "saving", "invalid_state_transition", "Editor runtime is saving.");
}

function applyDocumentChange(document: EditorDocument, change: EditorRuntimeChange, updatedAt: string): EditorDocument {
  switch (change.type) {
    case "set-title": {
      const title = change.title.trim() || "Untitled";
      return validateEditorRuntimeDocument({ ...document, title, updatedAt });
    }
    case "update-block":
      return validateEditorRuntimeDocument(updateEditorBlock(document, change.blockId, change.patch, updatedAt));
    case "insert-block": {
      const ids = new Set(document.blocks.map((block) => block.id));
      const block = validateBlock(change.block, ids);
      const index = change.index === undefined ? document.blocks.length : change.index;
      assertDomain(Number.isInteger(index) && index >= 0 && index <= document.blocks.length, "invalid_argument", "Editor block insertion index is out of range.");
      const blocks = [...document.blocks];
      blocks.splice(index, 0, block);
      return validateEditorRuntimeDocument({ ...document, blocks, updatedAt });
    }
    case "remove-block": {
      assertDomain(document.blocks.some((block) => block.id === change.blockId), "not_found", `Unknown editor block: ${change.blockId}`, { blockId: change.blockId });
      const blocks = document.blocks.filter((block) => block.id !== change.blockId);
      const selection = document.selection?.blockId === change.blockId ? undefined : document.selection;
      return validateEditorRuntimeDocument({
        ...document,
        blocks,
        ...(selection ? { selection } : {}),
        updatedAt,
      });
    }
    case "move-block": {
      const currentIndex = document.blocks.findIndex((block) => block.id === change.blockId);
      assertDomain(currentIndex >= 0, "not_found", `Unknown editor block: ${change.blockId}`, { blockId: change.blockId });
      assertDomain(Number.isInteger(change.index) && change.index >= 0 && change.index < document.blocks.length, "invalid_argument", "Editor block move index is out of range.");
      const blocks = [...document.blocks];
      const [block] = blocks.splice(currentIndex, 1);
      assertDomain(block !== undefined, "not_found", `Unknown editor block: ${change.blockId}`, { blockId: change.blockId });
      blocks.splice(change.index, 0, block);
      return validateEditorRuntimeDocument({ ...document, blocks, updatedAt });
    }
    case "set-selection": {
      const selected = setEditorSelection(document, change.selection);
      return validateEditorRuntimeDocument({ ...selected, updatedAt });
    }
    case "replace-document":
      assertDomain(change.document.id === document.id, "conflict", "Replacing an editor document cannot change its id.");
      return validateEditorRuntimeDocument({ ...change.document, updatedAt });
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

/** Create a local runtime around a document that has not been persisted yet. */
export function createEditorRuntime(
  document = createEditorDocument(),
  options: EditorRuntimeOptions = {},
): EditorRuntimeState {
  const now = options.now ?? document.updatedAt ?? stamp();
  const validated = validateEditorRuntimeDocument(document);
  return {
    version: EDITOR_RUNTIME_VERSION,
    document: validated,
    history: createEditorHistory(validated),
    status: "ready",
    revision: 0,
    persistedRevision: 0,
    mode: normalizeMode(options.mode),
    openedAt: now,
    updatedAt: now,
  };
}

/** Open a document from an adapter, optionally creating a new local document. */
export async function openEditorRuntime(
  adapter: EditorPersistenceAdapter,
  documentId: string,
  options: OpenEditorRuntimeOptions = {},
): Promise<EditorRuntimeState> {
  const id = assertRuntimeString(documentId, "Editor document id");
  const loaded = await adapter.load(id);
  if (loaded) {
    const record = normalizeRecord(loaded);
    assertDomain(record.document.id === id, "conflict", "Editor adapter returned a different document id.", {
      requestedId: id,
      returnedId: record.document.id,
    });
    const now = options.now ?? stamp();
    return {
      version: EDITOR_RUNTIME_VERSION,
      document: record.document,
      history: createEditorHistory(record.document),
      status: "ready",
      revision: 0,
      persistedRevision: record.revision,
      mode: normalizeMode(options.mode ?? adapter.mode),
      openedAt: now,
      updatedAt: now,
    };
  }
  assertDomain(options.createIfMissing !== false, "not_found", `Editor document was not found: ${id}`, { documentId: id });
  const now = options.now ?? stamp();
  const created = createEditorDocument(options.title ?? "Untitled", now);
  const withId = validateEditorRuntimeDocument({ ...created, id });
  return {
    version: EDITOR_RUNTIME_VERSION,
    document: withId,
    history: createEditorHistory(withId),
    status: "ready",
    revision: 0,
    persistedRevision: 0,
    mode: normalizeMode(options.mode ?? adapter.mode),
    openedAt: now,
    updatedAt: now,
  };
}

/** Apply one atomic editor operation and record it in the local undo history. */
export function applyEditorRuntimeChange(
  state: EditorRuntimeState,
  change: EditorRuntimeChange,
  updatedAt = stamp(),
): EditorRuntimeState {
  assertOpen(state);
  const nextDocument = applyDocumentChange(state.document, change, updatedAt);
  if (documentsEqual(state.document, nextDocument)) return state;
  const history = commitEditorChange(state.history, nextDocument);
  return stateWith(state, {
    document: nextDocument,
    history,
    status: "dirty",
    revision: nextRevision(state),
    updatedAt,
    error: undefined,
  });
}

/** Undo the latest local editor change. */
export function undoEditorRuntimeChange(state: EditorRuntimeState, updatedAt = stamp()): EditorRuntimeState {
  assertOpen(state);
  const history = undoEditorChange(state.history);
  if (history === state.history) return state;
  return stateWith(state, {
    document: history.present,
    history,
    status: "dirty",
    revision: nextRevision(state),
    updatedAt,
    error: undefined,
  });
}

/** Redo the earliest locally undone editor change. */
export function redoEditorRuntimeChange(state: EditorRuntimeState, updatedAt = stamp()): EditorRuntimeState {
  assertOpen(state);
  const history = redoEditorChange(state.history);
  if (history === state.history) return state;
  return stateWith(state, {
    document: history.present,
    history,
    status: "dirty",
    revision: nextRevision(state),
    updatedAt,
    error: undefined,
  });
}

/** Mark a runtime as closed after checking that unsaved edits are not lost. */
export function closeEditorRuntime(
  state: EditorRuntimeState,
  options: { readonly discardChanges?: boolean; readonly now?: string } = {},
): EditorRuntimeState {
  assertDomain(state.status !== "closed", "invalid_state_transition", "Editor runtime is already closed.");
  assertDomain(options.discardChanges === true || state.status !== "dirty", "invalid_state_transition", "Editor has unsaved changes; save or explicitly discard them before closing.");
  return stateWith(state, {
    status: "closed",
    updatedAt: options.now ?? stamp(),
    error: undefined,
  });
}

/** Persist the current document with optimistic revision checking. */
export async function persistEditorRuntime(
  state: EditorRuntimeState,
  adapter: EditorPersistenceAdapter,
  options: PersistEditorRuntimeOptions = {},
): Promise<EditorSaveResult> {
  assertOpen(state);
  const requestDocument = cloneDocument(state.document);
  const receipt = normalizeRecord(await adapter.save({
    document: requestDocument,
    expectedRevision: state.persistedRevision,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  }));
  assertDomain(receipt.document.id === state.document.id, "conflict", "Editor adapter returned a different document id after save.");
  const updatedAt = options.now ?? receipt.savedAt;
  const savedHistory: EditorHistory = {
    past: state.history.past.map(cloneDocument),
    present: receipt.document,
    future: state.history.future.map(cloneDocument),
  };
  const nextState = stateWith(state, {
    document: receipt.document,
    history: savedHistory,
    status: "ready",
    persistedRevision: receipt.revision,
    updatedAt,
    error: undefined,
  });
  return { state: nextState, receipt };
}

/** Alias used by application adapters that call the operation `save`. */
export const saveEditorRuntime = persistEditorRuntime;

/** Convert runtime state to a portable JSON value. */
export function serializeEditorRuntime(state: EditorRuntimeState): string {
  validateEditorRuntimeState(state);
  return JSON.stringify({
    version: EDITOR_RUNTIME_VERSION,
    document: state.document,
    history: state.history,
    status: state.status,
    revision: state.revision,
    persistedRevision: state.persistedRevision,
    mode: state.mode,
    openedAt: state.openedAt,
    updatedAt: state.updatedAt,
    ...(state.error ? { error: state.error } : {}),
  }, null, 2);
}

function parseHistory(value: unknown): EditorHistory {
  assertDomain(isRecord(value) && Array.isArray(value.past) && value.present !== undefined && Array.isArray(value.future), "invalid_argument", "Invalid editor runtime history.");
  return {
    past: value.past.map((document) => validateEditorRuntimeDocument(deserializeEditorDocument(document))),
    present: validateEditorRuntimeDocument(deserializeEditorDocument(value.present)),
    future: value.future.map((document) => validateEditorRuntimeDocument(deserializeEditorDocument(document))),
  };
}

export function validateEditorRuntimeState(state: EditorRuntimeState): EditorRuntimeState {
  assertDomain(state.version === EDITOR_RUNTIME_VERSION, "invalid_argument", "Unsupported editor runtime version.");
  assertDomain(runtimeStatuses.includes(state.status), "invalid_argument", "Invalid editor runtime status.");
  assertDomain(state.mode === "browser-preview" || state.mode === "native", "invalid_argument", "Invalid editor runtime mode.");
  assertDomain(isFiniteInteger(state.revision) && state.revision >= 0, "invalid_argument", "Editor runtime revision must be a non-negative integer.");
  assertDomain(isFiniteInteger(state.persistedRevision) && state.persistedRevision >= 0, "invalid_argument", "Editor persisted revision must be a non-negative integer.");
  const document = validateEditorRuntimeDocument(state.document);
  const history = cloneHistory(state.history);
  assertDomain(documentsEqual(document, history.present), "conflict", "Editor runtime document must match history present state.");
  assertDomain(isString(state.openedAt) && state.openedAt.trim().length > 0, "invalid_argument", "Editor runtime openedAt is required.");
  assertDomain(isString(state.updatedAt) && state.updatedAt.trim().length > 0, "invalid_argument", "Editor runtime updatedAt is required.");
  if (state.error !== undefined) assertDomain(isString(state.error), "invalid_argument", "Editor runtime error must be a string.");
  return state;
}

/** Hydrate a renderer-safe editor runtime from JSON or an unknown value. */
export function deserializeEditorRuntime(input: string | unknown): EditorRuntimeState {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(isRecord(value), "invalid_argument", "Invalid editor runtime payload.");
  assertDomain(value.version === EDITOR_RUNTIME_VERSION, "invalid_argument", "Unsupported editor runtime version.");
  assertDomain(runtimeStatuses.includes(value.status as EditorRuntimeStatus), "invalid_argument", "Invalid editor runtime status.");
  assertDomain(value.mode === "browser-preview" || value.mode === "native", "invalid_argument", "Invalid editor runtime mode.");
  assertDomain(isFiniteInteger(value.revision) && value.revision >= 0, "invalid_argument", "Invalid editor runtime revision.");
  assertDomain(isFiniteInteger(value.persistedRevision) && value.persistedRevision >= 0, "invalid_argument", "Invalid editor persisted revision.");
  assertDomain(isString(value.openedAt) && value.openedAt.trim().length > 0, "invalid_argument", "Editor runtime openedAt is required.");
  assertDomain(isString(value.updatedAt) && value.updatedAt.trim().length > 0, "invalid_argument", "Editor runtime updatedAt is required.");
  const document = validateEditorRuntimeDocument(deserializeEditorDocument(value.document));
  const history = parseHistory(value.history);
  const state: EditorRuntimeState = {
    version: EDITOR_RUNTIME_VERSION,
    document,
    history,
    status: value.status as EditorRuntimeStatus,
    revision: value.revision,
    persistedRevision: value.persistedRevision,
    mode: value.mode,
    openedAt: value.openedAt,
    updatedAt: value.updatedAt,
    ...(isString(value.error) ? { error: value.error } : {}),
  };
  return validateEditorRuntimeState(state);
}

/**
 * A deterministic in-memory adapter for browser previews, tests, and local
 * application composition. It enforces the same optimistic-concurrency
 * contract a native repository should implement.
 */
export function createMemoryEditorPersistenceAdapter(
  initial: readonly EditorPersistenceRecord[] = [],
  options: { readonly mode?: EditorRuntimeMode; readonly now?: () => string } = {},
): EditorPersistenceAdapter & {
  list(): readonly EditorPersistenceRecord[];
  clear(): void;
} {
  const records = new Map<string, EditorPersistenceRecord>();
  const now = options.now ?? stamp;
  for (const input of initial) {
    const record = normalizeRecord(input);
    assertDomain(!records.has(record.document.id), "conflict", `Duplicate editor document id: ${record.document.id}`);
    records.set(record.document.id, record);
  }
  return {
    mode: options.mode ?? "browser-preview",
    async load(documentId: string): Promise<EditorPersistenceRecord | null> {
      const record = records.get(assertRuntimeString(documentId, "Editor document id"));
      return record ? normalizeRecord(record) : null;
    },
    async save(request: EditorPersistenceSaveRequest): Promise<EditorPersistenceRecord> {
      const document = validateEditorRuntimeDocument(request.document);
      const expectedRevision = request.expectedRevision;
      assertDomain(isFiniteInteger(expectedRevision) && expectedRevision >= 0, "invalid_argument", "Expected editor revision must be a non-negative integer.");
      const current = records.get(document.id);
      const currentRevision = current?.revision ?? 0;
      assertDomain(currentRevision === expectedRevision, "conflict", "Editor document changed outside this runtime.", {
        documentId: document.id,
        expectedRevision,
        actualRevision: currentRevision,
      });
      const record: EditorPersistenceRecord = {
        version: 1,
        document,
        revision: currentRevision + 1,
        savedAt: now(),
      };
      records.set(document.id, record);
      return normalizeRecord(record);
    },
    list(): readonly EditorPersistenceRecord[] {
      return [...records.values()].map(normalizeRecord);
    },
    clear(): void {
      records.clear();
    },
  };
}

/** Alias for callers that use “runtime” rather than “persistence” naming. */
export const createMemoryEditorRuntimeAdapter = createMemoryEditorPersistenceAdapter;

/**
 * Small stateful facade for React/application adapters. It emits only
 * renderer-safe lifecycle events and never performs native work itself.
 */
export class OmniaEditorRuntimeAdapter {
  private readonly listeners = new Set<EditorRuntimeListener>();
  private stateValue: EditorRuntimeState | null = null;

  constructor(private readonly persistence: EditorPersistenceAdapter) {}

  get state(): EditorRuntimeState | null {
    return this.stateValue ? validateEditorRuntimeState(this.stateValue) : null;
  }

  subscribe(listener: EditorRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EditorRuntimeEvent): void {
    for (const listener of this.listeners) listener(event, this.state);
  }

  async open(documentId: string, options: OpenEditorRuntimeOptions = {}): Promise<EditorRuntimeState> {
    const state = await openEditorRuntime(this.persistence, documentId, options);
    this.stateValue = state;
    this.emit({ type: "opened", documentId: state.document.id, revision: state.revision, timestamp: state.updatedAt });
    return state;
  }

  create(document: EditorDocument = createEditorDocument(), options: EditorRuntimeOptions = {}): EditorRuntimeState {
    const state = createEditorRuntime(document, options);
    this.stateValue = state;
    this.emit({ type: "opened", documentId: state.document.id, revision: state.revision, timestamp: state.updatedAt });
    return state;
  }

  apply(change: EditorRuntimeChange, updatedAt?: string): EditorRuntimeState {
    const current = this.requireState();
    try {
      const next = applyEditorRuntimeChange(current, change, updatedAt);
      this.stateValue = next;
      if (next !== current) this.emit({ type: "changed", documentId: next.document.id, revision: next.revision, timestamp: next.updatedAt });
      return next;
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  undo(updatedAt?: string): EditorRuntimeState {
    const current = this.requireState();
    const next = undoEditorRuntimeChange(current, updatedAt);
    this.stateValue = next;
    if (next !== current) this.emit({ type: "undone", documentId: next.document.id, revision: next.revision, timestamp: next.updatedAt });
    return next;
  }

  redo(updatedAt?: string): EditorRuntimeState {
    const current = this.requireState();
    const next = redoEditorRuntimeChange(current, updatedAt);
    this.stateValue = next;
    if (next !== current) this.emit({ type: "redone", documentId: next.document.id, revision: next.revision, timestamp: next.updatedAt });
    return next;
  }

  async save(options: PersistEditorRuntimeOptions = {}): Promise<EditorSaveResult> {
    const current = this.requireState();
    try {
      const result = await persistEditorRuntime(current, this.persistence, options);
      this.stateValue = result.state;
      this.emit({ type: "saved", documentId: result.state.document.id, revision: result.state.revision, timestamp: result.state.updatedAt });
      return result;
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  close(options: { readonly discardChanges?: boolean; readonly now?: string } = {}): EditorRuntimeState {
    const current = this.requireState();
    const next = closeEditorRuntime(current, options);
    this.stateValue = next;
    this.emit({ type: "closed", documentId: next.document.id, revision: next.revision, timestamp: next.updatedAt });
    return next;
  }

  private requireState(): EditorRuntimeState {
    assertDomain(this.stateValue !== null, "invalid_state_transition", "No editor document is open.");
    return this.stateValue;
  }

  private recordError(error: unknown): void {
    const current = this.stateValue;
    if (!current || current.status === "closed") return;
    const message = error instanceof Error ? error.message : String(error);
    this.stateValue = stateWith(current, { status: "error", error: message, updatedAt: stamp() });
    this.emit({ type: "error", documentId: current.document.id, revision: current.revision, timestamp: this.stateValue.updatedAt, error: message });
  }
}

/** Shorter class alias for consumers that prefer controller terminology. */
export const EditorRuntimeController = OmniaEditorRuntimeAdapter;
