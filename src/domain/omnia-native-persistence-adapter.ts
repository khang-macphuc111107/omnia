import { deserializeOmniaAppState, serializeOmniaAppState, type OmniaAppState } from "./omnia-app-state";
import {
  deserializeOmniaTransferBundle,
  serializeOmniaTransferBundle,
  type OmniaTransferBundle,
} from "./omnia-data-transfer";

/**
 * The adapter is intentionally narrower than the native store itself.  A
 * native implementation owns SQLite/filesystem policy; this module owns the
 * renderer-facing validation and serialization boundary only.
 */
export type OmniaPersistenceBackend = "native" | "memory" | "custom";

export type OmniaPersistenceErrorKind =
  | "unavailable"
  | "revision-conflict"
  | "invalid-snapshot"
  | "invalid-transfer"
  | "persistence-failure";

export class OmniaPersistenceError extends Error {
  public readonly kind: OmniaPersistenceErrorKind;
  public readonly retryable: boolean;
  public readonly details: Readonly<Record<string, unknown>>;
  public readonly cause?: unknown;

  public constructor(
    kind: OmniaPersistenceErrorKind,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "OmniaPersistenceError";
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === "unavailable" || kind === "revision-conflict");
    this.details = Object.freeze({ ...(options.details ?? {}) });
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isOmniaPersistenceError(error: unknown): error is OmniaPersistenceError {
  return error instanceof OmniaPersistenceError;
}

export interface OmniaPersistenceHealth {
  readonly status: "available" | "unavailable";
  readonly backend: OmniaPersistenceBackend;
  /** False for browser/session adapters; true only when the port says it is durable. */
  readonly durable: boolean;
  readonly schemaVersion: number;
  readonly profileId?: string;
}

export interface NativeLoadSnapshotRequest {
  /** Optional native watermark. It is a hint, never an authority grant. */
  readonly minimumRevision?: number;
}

export type NativeLoadSnapshotResponse =
  | {
      readonly status: "empty";
      readonly receiptId?: string;
    }
  | {
      readonly status: "loaded";
      readonly snapshot: string | unknown;
      readonly revision: number;
      readonly receiptId?: string;
    };

export interface NativeSaveSnapshotRequest {
  /** Serialized JSON is the only payload crossing this boundary. */
  readonly snapshot: string;
  /** Compare-and-swap against the native snapshot revision when supplied. */
  readonly expectedRevision?: number;
}

export type NativeSaveSnapshotResponse =
  | {
      readonly status: "saved";
      readonly revision: number;
      readonly receiptId?: string;
    }
  | {
      readonly status: "conflict";
      readonly currentRevision: number | null;
      readonly expectedRevision: number | null;
      readonly receiptId?: string;
    };

export interface NativeExportBundleRequest {
  readonly bundle: string;
}

export interface NativeExportBundleResponse {
  readonly status: "exported";
  readonly bundle: string | unknown;
  readonly receiptId?: string;
}

export interface NativeImportBundleRequest {
  readonly bundle: string;
}

export interface NativeImportBundleResponse {
  readonly status: "imported";
  readonly bundle: string | unknown;
  readonly receiptId?: string;
}

/**
 * Low-level port implemented by Tauri/native code or by a browser test
 * double. It deliberately deals in serialized JSON so native code cannot
 * retain renderer object references.
 */
export interface OmniaNativePersistencePort {
  readonly backend?: OmniaPersistenceBackend;
  readonly durable?: boolean;
  readonly loadSnapshot: (
    request?: NativeLoadSnapshotRequest,
  ) => Promise<NativeLoadSnapshotResponse>;
  readonly saveSnapshot: (
    request: NativeSaveSnapshotRequest,
  ) => Promise<NativeSaveSnapshotResponse>;
  readonly exportBundle?: (
    request: NativeExportBundleRequest,
  ) => Promise<NativeExportBundleResponse>;
  readonly importBundle?: (
    request: NativeImportBundleRequest,
  ) => Promise<NativeImportBundleResponse>;
  readonly health?: () => Promise<OmniaPersistenceHealth>;
}

export type OmniaPersistenceLoadResult =
  | {
      readonly status: "empty";
      readonly backend: OmniaPersistenceBackend;
      readonly durable: boolean;
      readonly receiptId?: string;
    }
  | {
      readonly status: "loaded";
      readonly state: OmniaAppState;
      readonly revision: number;
      readonly backend: OmniaPersistenceBackend;
      readonly durable: boolean;
      readonly receiptId?: string;
    };

export interface OmniaPersistenceSaveResult {
  readonly status: "saved";
  readonly revision: number;
  readonly backend: OmniaPersistenceBackend;
  readonly durable: boolean;
  readonly receiptId?: string;
}

export interface OmniaPersistenceTransferResult {
  readonly bundle: OmniaTransferBundle;
  readonly backend: OmniaPersistenceBackend;
  readonly durable: boolean;
  readonly receiptId?: string;
}

export interface SaveOmniaAppStateOptions {
  readonly expectedRevision?: number;
}

function backendOf(port: OmniaNativePersistencePort): OmniaPersistenceBackend {
  return port.backend ?? "custom";
}

function durableOf(port: OmniaNativePersistencePort): boolean {
  return port.durable ?? false;
}

function validRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new OmniaPersistenceError("persistence-failure", `${label} is not a valid revision.`, {
      retryable: false,
    });
  }
  return value;
}

function validOptionalRevision(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return validRevision(value, label);
}

function assertResponseObject(value: unknown, action: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OmniaPersistenceError("persistence-failure", `Native persistence returned an invalid response while attempting to ${action}.`, {
      retryable: false,
    });
  }
}

function serializeStateAtBoundary(state: OmniaAppState): string {
  try {
    // Round-tripping through the strict deserializer both validates the
    // composition root and detaches every nested object from caller-owned
    // references before the payload is handed to a native port.
    return serializeOmniaAppState(deserializeOmniaAppState(serializeOmniaAppState(state)));
  } catch (error) {
    if (error instanceof OmniaPersistenceError) throw error;
    throw new OmniaPersistenceError("invalid-snapshot", "The Omnia app state is malformed.", {
      retryable: false,
      cause: error,
    });
  }
}

function deserializeStateAtBoundary(input: string | unknown): OmniaAppState {
  try {
    // The second serialization keeps the result detached even when a custom
    // port returns an object instead of the preferred JSON string.
    return deserializeOmniaAppState(
      serializeOmniaAppState(deserializeOmniaAppState(input)),
    );
  } catch (error) {
    if (error instanceof OmniaPersistenceError) throw error;
    throw new OmniaPersistenceError("invalid-snapshot", "The native app-state snapshot is malformed.", {
      retryable: false,
      cause: error,
    });
  }
}

function serializeTransferAtBoundary(bundle: OmniaTransferBundle): string {
  try {
    return serializeOmniaTransferBundle(deserializeOmniaTransferBundle(serializeOmniaTransferBundle(bundle)));
  } catch (error) {
    if (error instanceof OmniaPersistenceError) throw error;
    throw new OmniaPersistenceError("invalid-transfer", "The Omnia transfer bundle is malformed.", {
      retryable: false,
      cause: error,
    });
  }
}

function deserializeTransferAtBoundary(input: string | unknown): OmniaTransferBundle {
  try {
    return deserializeOmniaTransferBundle(
      serializeOmniaTransferBundle(deserializeOmniaTransferBundle(input)),
    );
  } catch (error) {
    if (error instanceof OmniaPersistenceError) throw error;
    throw new OmniaPersistenceError("invalid-transfer", "The native transfer bundle is malformed.", {
      retryable: false,
      cause: error,
    });
  }
}

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && code.length <= 128 ? code : undefined;
}

function wrapPortError(error: unknown, action: string): OmniaPersistenceError {
  if (error instanceof OmniaPersistenceError) return error;
  const code = safeErrorCode(error);
  const unavailableCodes = new Set([
    "core_not_initialized",
    "native_unavailable",
    "storage_unavailable",
    "command_not_found",
    "web_preview",
  ]);
  const kind = code !== undefined && unavailableCodes.has(code)
    ? "unavailable"
    : "persistence-failure";
  return new OmniaPersistenceError(
    kind,
    kind === "unavailable"
      ? `Native persistence is unavailable while attempting to ${action}.`
      : `Native persistence failed while attempting to ${action}.`,
    {
      retryable: kind === "unavailable",
      ...(code === undefined ? {} : { details: { code } }),
      cause: error,
    },
  );
}

/**
 * Validating adapter shared by Tauri and browser preview. It does not import
 * the desktop invoke wrapper, which keeps the domain boundary testable and
 * avoids making browser builds depend on a native runtime.
 */
export class OmniaNativePersistenceAdapter {
  public readonly backend: OmniaPersistenceBackend;
  public readonly durable: boolean;

  public constructor(private readonly port: OmniaNativePersistencePort) {
    this.backend = backendOf(port);
    this.durable = durableOf(port);
  }

  public async health(): Promise<OmniaPersistenceHealth> {
    if (this.port.health === undefined) {
      return {
        status: "available",
        backend: this.backend,
        durable: this.durable,
        schemaVersion: 1,
      };
    }
    try {
      const health = await this.port.health();
      if (health.backend !== this.backend || health.durable !== this.durable) {
        throw new OmniaPersistenceError("persistence-failure", "Persistence health metadata disagrees with the port.", {
          retryable: false,
        });
      }
      return health;
    } catch (error) {
      throw wrapPortError(error, "check persistence health");
    }
  }

  public async loadSnapshot(request: NativeLoadSnapshotRequest = {}): Promise<OmniaPersistenceLoadResult> {
    validOptionalRevision(request.minimumRevision, "minimum revision");
    let response: NativeLoadSnapshotResponse;
    try {
      response = await this.port.loadSnapshot(request);
    } catch (error) {
      throw wrapPortError(error, "load the app-state snapshot");
    }
    assertResponseObject(response, "load the app-state snapshot");
    if (response.status === "empty") {
      return {
        status: "empty",
        backend: this.backend,
        durable: this.durable,
        ...(response.receiptId === undefined ? {} : { receiptId: response.receiptId }),
      };
    }
    if (response.status !== "loaded") {
      throw new OmniaPersistenceError("persistence-failure", "Native persistence returned an unknown load status.", {
        retryable: false,
      });
    }
    const state = deserializeStateAtBoundary(response.snapshot);
    const revision = validRevision(response.revision, "native snapshot revision");
    if (state.revision !== revision) {
      throw new OmniaPersistenceError("persistence-failure", "Native snapshot revision does not match its payload.", {
        retryable: false,
        details: { payloadRevision: state.revision, responseRevision: revision },
      });
    }
    if (request.minimumRevision !== undefined && revision < request.minimumRevision) {
      throw new OmniaPersistenceError("revision-conflict", "Native snapshot is older than the requested revision.", {
        details: { minimumRevision: request.minimumRevision, actualRevision: revision },
      });
    }
    return {
      status: "loaded",
      state,
      revision,
      backend: this.backend,
      durable: this.durable,
      ...(response.receiptId === undefined ? {} : { receiptId: response.receiptId }),
    };
  }

  public async saveSnapshot(
    state: OmniaAppState,
    options: SaveOmniaAppStateOptions = {},
  ): Promise<OmniaPersistenceSaveResult> {
    const snapshot = serializeStateAtBoundary(state);
    const expectedRevision = validOptionalRevision(options.expectedRevision, "expected revision");
    let response: NativeSaveSnapshotResponse;
    try {
      response = await this.port.saveSnapshot({
        snapshot,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
    } catch (error) {
      throw wrapPortError(error, "save the app-state snapshot");
    }
    assertResponseObject(response, "save the app-state snapshot");
    if (response.status === "conflict") {
      const currentRevision = response.currentRevision === null
        ? null
        : validRevision(response.currentRevision, "current revision");
      const conflictExpected = response.expectedRevision === null
        ? undefined
        : validRevision(response.expectedRevision, "conflict expected revision");
      throw new OmniaPersistenceError("revision-conflict", "Native persistence rejected a stale app-state write.", {
        details: {
          currentRevision,
          ...(conflictExpected === undefined ? {} : { expectedRevision: conflictExpected }),
        },
      });
    }
    if (response.status !== "saved") {
      throw new OmniaPersistenceError("persistence-failure", "Native persistence returned an unknown save status.", {
        retryable: false,
      });
    }
    const revision = validRevision(response.revision, "saved revision");
    const payloadRevision = deserializeOmniaAppState(snapshot).revision;
    if (revision !== payloadRevision) {
      throw new OmniaPersistenceError("persistence-failure", "Native persistence acknowledged a different revision than the payload.", {
        retryable: false,
        details: { payloadRevision, responseRevision: revision },
      });
    }
    return {
      status: "saved",
      revision,
      backend: this.backend,
      durable: this.durable,
      ...(response.receiptId === undefined ? {} : { receiptId: response.receiptId }),
    };
  }

  public async exportTransferBundle(bundle: OmniaTransferBundle): Promise<OmniaPersistenceTransferResult> {
    if (this.port.exportBundle === undefined) {
      throw new OmniaPersistenceError("unavailable", "Transfer export is not available on this persistence port.", {
        retryable: false,
      });
    }
    const serialized = serializeTransferAtBoundary(bundle);
    let response: NativeExportBundleResponse;
    try {
      response = await this.port.exportBundle({ bundle: serialized });
    } catch (error) {
      throw wrapPortError(error, "export a transfer bundle");
    }
    assertResponseObject(response, "export a transfer bundle");
    if (response.status !== "exported") {
      throw new OmniaPersistenceError("persistence-failure", "Native persistence returned an unknown export status.", {
        retryable: false,
      });
    }
    const exported = deserializeTransferAtBoundary(response.bundle);
    return {
      bundle: exported,
      backend: this.backend,
      durable: this.durable,
      ...(response.receiptId === undefined ? {} : { receiptId: response.receiptId }),
    };
  }

  public async importTransferBundle(input: string | unknown): Promise<OmniaPersistenceTransferResult> {
    if (this.port.importBundle === undefined) {
      throw new OmniaPersistenceError("unavailable", "Transfer import is not available on this persistence port.", {
        retryable: false,
      });
    }
    const bundle = deserializeTransferAtBoundary(input);
    let response: NativeImportBundleResponse;
    try {
      response = await this.port.importBundle({ bundle: serializeOmniaTransferBundle(bundle) });
    } catch (error) {
      throw wrapPortError(error, "import a transfer bundle");
    }
    assertResponseObject(response, "import a transfer bundle");
    if (response.status !== "imported") {
      throw new OmniaPersistenceError("persistence-failure", "Native persistence returned an unknown import status.", {
        retryable: false,
      });
    }
    return {
      bundle: deserializeTransferAtBoundary(response.bundle),
      backend: this.backend,
      durable: this.durable,
      ...(response.receiptId === undefined ? {} : { receiptId: response.receiptId }),
    };
  }
}

export interface InMemoryOmniaPersistencePortOptions {
  readonly initialSnapshot?: unknown;
}

/**
 * Deterministic browser-preview/test port. It intentionally reports
 * `durable: false`: passing tests here cannot be used as evidence of native
 * SQLite persistence.
 */
export class InMemoryOmniaPersistencePort implements OmniaNativePersistencePort {
  public readonly backend = "memory" as const;
  public readonly durable = false;

  private snapshot: string | null = null;
  private revision: number | null = null;
  private receiptSequence = 0;

  public constructor(options: InMemoryOmniaPersistencePortOptions = {}) {
    if (options.initialSnapshot !== undefined) {
      const state = deserializeStateAtBoundary(options.initialSnapshot);
      this.snapshot = serializeOmniaAppState(state);
      this.revision = state.revision;
    }
  }

  private receipt(prefix: string): string {
    this.receiptSequence += 1;
    return `memory:${prefix}:${this.receiptSequence}`;
  }

  public async loadSnapshot(_request: NativeLoadSnapshotRequest = {}): Promise<NativeLoadSnapshotResponse> {
    if (this.snapshot === null || this.revision === null) {
      return { status: "empty", receiptId: this.receipt("load") };
    }
    return {
      status: "loaded",
      snapshot: this.snapshot,
      revision: this.revision,
      receiptId: this.receipt("load"),
    };
  }

  public async saveSnapshot(request: NativeSaveSnapshotRequest): Promise<NativeSaveSnapshotResponse> {
    const state = deserializeStateAtBoundary(request.snapshot);
    const expectedRevision = request.expectedRevision;
    if (expectedRevision !== undefined) validRevision(expectedRevision, "expected revision");
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return {
        status: "conflict",
        currentRevision: this.revision,
        expectedRevision,
        receiptId: this.receipt("conflict"),
      };
    }
    this.snapshot = serializeOmniaAppState(state);
    this.revision = state.revision;
    return {
      status: "saved",
      revision: state.revision,
      receiptId: this.receipt("save"),
    };
  }

  public async exportBundle(request: NativeExportBundleRequest): Promise<NativeExportBundleResponse> {
    const bundle = deserializeTransferAtBoundary(request.bundle);
    return {
      status: "exported",
      bundle: serializeOmniaTransferBundle(bundle),
      receiptId: this.receipt("export"),
    };
  }

  public async importBundle(request: NativeImportBundleRequest): Promise<NativeImportBundleResponse> {
    const bundle = deserializeTransferAtBoundary(request.bundle);
    return {
      status: "imported",
      bundle: serializeOmniaTransferBundle(bundle),
      receiptId: this.receipt("import"),
    };
  }

  public async health(): Promise<OmniaPersistenceHealth> {
    return {
      status: "available",
      backend: this.backend,
      durable: this.durable,
      schemaVersion: 1,
    };
  }
}

export function createOmniaNativePersistenceAdapter(
  port: OmniaNativePersistencePort,
): OmniaNativePersistenceAdapter {
  return new OmniaNativePersistenceAdapter(port);
}

export function createInMemoryOmniaPersistenceAdapter(
  options: InMemoryOmniaPersistencePortOptions = {},
): OmniaNativePersistenceAdapter {
  return new OmniaNativePersistenceAdapter(new InMemoryOmniaPersistencePort(options));
}
