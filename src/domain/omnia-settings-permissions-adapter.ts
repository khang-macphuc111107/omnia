import {
  createPermissionPolicy,
  deserializePermissionPolicy,
  evaluatePermission,
  type PermissionCapability,
  type PermissionEffect,
  type PermissionPolicy,
  type PermissionScope,
} from "./omnia-permission-policy";

export type OmniaSettingsScope = "profile" | "project" | "workspace" | "session";

/** JSON-compatible settings values; functions, handles, paths and secrets are excluded. */
export type OmniaSettingsValue =
  | string
  | number
  | boolean
  | null
  | readonly OmniaSettingsValue[]
  | { readonly [key: string]: OmniaSettingsValue };

export type OmniaSettingsValues = Readonly<Record<string, OmniaSettingsValue>>;

export type OmniaSettingsDocument = {
  readonly version: 1;
  readonly id: string;
  readonly scope: OmniaSettingsScope;
  readonly revision: number;
  readonly updatedAt: string;
  readonly values: OmniaSettingsValues;
};

export type OmniaSettingsPermissionsSnapshot = {
  readonly version: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly settings: OmniaSettingsDocument;
  readonly permissions: PermissionPolicy;
};

export type SettingsPermissionsErrorKind =
  | "unavailable"
  | "revision-conflict"
  | "invalid-snapshot"
  | "persistence-failure";

export class SettingsPermissionsError extends Error {
  public readonly kind: SettingsPermissionsErrorKind;
  public readonly retryable: boolean;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    kind: SettingsPermissionsErrorKind,
    message: string,
    options: { readonly retryable?: boolean; readonly details?: Readonly<Record<string, unknown>>; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SettingsPermissionsError";
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === "unavailable" || kind === "revision-conflict");
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export interface SettingsPermissionsLoadRequest {
  readonly minimumRevision?: number;
}

export type SettingsPermissionsLoadResponse =
  | { readonly status: "empty"; readonly receiptId?: string }
  | { readonly status: "loaded"; readonly snapshot: string | unknown; readonly revision: number; readonly receiptId?: string };

export type SettingsPermissionsSaveRequest = {
  readonly snapshot: string;
  readonly expectedRevision?: number;
};

export type SettingsPermissionsSaveResponse =
  | { readonly status: "saved"; readonly revision: number; readonly receiptId?: string }
  | { readonly status: "conflict"; readonly currentRevision: number | null; readonly expectedRevision: number | null; readonly receiptId?: string };

export interface SettingsPermissionsPort {
  readonly backend?: "native" | "memory" | "custom";
  readonly durable?: boolean;
  readonly load: (request?: SettingsPermissionsLoadRequest) => Promise<SettingsPermissionsLoadResponse>;
  readonly save: (request: SettingsPermissionsSaveRequest) => Promise<SettingsPermissionsSaveResponse>;
}

export type SettingsPermissionsLoadResult =
  | { readonly status: "empty"; readonly backend: string; readonly durable: boolean; readonly receiptId?: string }
  | { readonly status: "loaded"; readonly snapshot: OmniaSettingsPermissionsSnapshot; readonly revision: number; readonly backend: string; readonly durable: boolean; readonly receiptId?: string };

export type SettingsPermissionsSaveResult = {
  readonly status: "saved";
  readonly revision: number;
  readonly backend: string;
  readonly durable: boolean;
  readonly receiptId?: string;
};

function now(): string { return new Date().toISOString(); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new SettingsPermissionsError("invalid-snapshot", `${label} must be a positive integer.`, { retryable: false });
  return value;
}

function assertTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new SettingsPermissionsError("invalid-snapshot", `${label} must be an ISO timestamp.`, { retryable: false });
  return value;
}

function assertSafeKey(key: string): string {
  if (!key.trim() || key === "__proto__" || key === "prototype" || key === "constructor" || /[\u0000-\u001f]/.test(key)) throw new SettingsPermissionsError("invalid-snapshot", "Settings keys must be safe, non-empty strings.", { retryable: false, details: { key } });
  return key;
}

function cloneValue(value: unknown, path = "value"): OmniaSettingsValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SettingsPermissionsError("invalid-snapshot", `Setting ${path} must be finite.`, { retryable: false });
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => cloneValue(item, `${path}[${index}]`));
  if (isRecord(value)) {
    const result: Record<string, OmniaSettingsValue> = {};
    for (const [key, child] of Object.entries(value)) result[assertSafeKey(key)] = cloneValue(child, `${path}.${key}`);
    return result;
  }
  throw new SettingsPermissionsError("invalid-snapshot", `Setting ${path} is not JSON-compatible.`, { retryable: false });
}

function normalizeSettings(input: unknown): OmniaSettingsDocument {
  if (!isRecord(input) || input.version !== 1 || typeof input.id !== "string" || !input.id.trim() || (input.scope !== "profile" && input.scope !== "project" && input.scope !== "workspace" && input.scope !== "session") || !isRecord(input.values)) {
    throw new SettingsPermissionsError("invalid-snapshot", "Invalid Omnia settings document.", { retryable: false });
  }
  const values: Record<string, OmniaSettingsValue> = {};
  for (const [key, value] of Object.entries(input.values)) values[assertSafeKey(key)] = cloneValue(value, key);
  return { version: 1, id: input.id.trim(), scope: input.scope, revision: assertRevision(input.revision, "Settings revision"), updatedAt: assertTimestamp(input.updatedAt, "Settings timestamp"), values };
}

export function normalizeSettingsPermissionsSnapshot(input: unknown): OmniaSettingsPermissionsSnapshot {
  let value: unknown;
  try { value = typeof input === "string" ? JSON.parse(input) as unknown : input; } catch (cause) { throw new SettingsPermissionsError("invalid-snapshot", "Settings snapshot is not valid JSON.", { retryable: false, cause }); }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.settings)) throw new SettingsPermissionsError("invalid-snapshot", "Invalid Omnia settings/permissions snapshot.", { retryable: false });
  let permissions: PermissionPolicy;
  try { permissions = deserializePermissionPolicy(value.permissions); } catch (cause) { throw new SettingsPermissionsError("invalid-snapshot", "Invalid permission policy in settings snapshot.", { retryable: false, cause }); }
  const settings = normalizeSettings(value.settings);
  const revision = assertRevision(value.revision, "Snapshot revision");
  if (revision < settings.revision || revision < permissions.revision) throw new SettingsPermissionsError("invalid-snapshot", "Snapshot revision must cover nested revisions.", { retryable: false });
  return { version: 1, revision, updatedAt: assertTimestamp(value.updatedAt, "Snapshot timestamp"), settings, permissions };
}

export function serializeSettingsPermissionsSnapshot(snapshot: OmniaSettingsPermissionsSnapshot): string {
  return JSON.stringify(normalizeSettingsPermissionsSnapshot(snapshot), null, 2);
}

export function createSettingsPermissionsSnapshot(options: {
  readonly id?: string;
  readonly scope?: OmniaSettingsScope;
  readonly values?: OmniaSettingsValues;
  readonly permissions?: PermissionPolicy;
  readonly now?: string;
} = {}): OmniaSettingsPermissionsSnapshot {
  const timestamp = options.now ?? now();
  const settings = normalizeSettings({ version: 1, id: options.id ?? "settings", scope: options.scope ?? "profile", revision: 1, updatedAt: timestamp, values: options.values ?? {} });
  const permissions = options.permissions ?? createPermissionPolicy();
  return { version: 1, revision: Math.max(settings.revision, permissions.revision), updatedAt: timestamp, settings, permissions };
}

export function updateSettingsPermissionsSnapshot(
  snapshot: OmniaSettingsPermissionsSnapshot,
  patch: { readonly values?: OmniaSettingsValues; readonly permissions?: PermissionPolicy },
  updatedAt = now(),
): OmniaSettingsPermissionsSnapshot {
  const current = normalizeSettingsPermissionsSnapshot(snapshot);
  const settings = patch.values === undefined ? current.settings : normalizeSettings({ ...current.settings, values: patch.values, revision: current.settings.revision + 1, updatedAt });
  const permissions = patch.permissions === undefined ? current.permissions : deserializePermissionPolicy(patch.permissions);
  return normalizeSettingsPermissionsSnapshot({
    version: 1,
    revision: Math.max(current.revision + 1, settings.revision, permissions.revision),
    updatedAt,
    settings,
    permissions,
  });
}

function wrapPortError(error: unknown, action: string): SettingsPermissionsError {
  if (error instanceof SettingsPermissionsError) return error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  const unavailable = code === "native_unavailable" || code === "storage_unavailable" || code === "web_preview";
  return new SettingsPermissionsError(unavailable ? "unavailable" : "persistence-failure", unavailable ? `Settings persistence is unavailable while attempting to ${action}.` : `Settings persistence failed while attempting to ${action}.`, { retryable: unavailable, ...(code ? { details: { code } } : {}), cause: error });
}

export class OmniaSettingsPermissionsAdapter {
  public readonly backend: string;
  public readonly durable: boolean;

  public constructor(private readonly port: SettingsPermissionsPort) {
    this.backend = port.backend ?? "custom";
    this.durable = port.durable ?? false;
  }

  public async load(request: SettingsPermissionsLoadRequest = {}): Promise<SettingsPermissionsLoadResult> {
    if (request.minimumRevision !== undefined) assertRevision(request.minimumRevision, "Minimum revision");
    let response: SettingsPermissionsLoadResponse;
    try { response = await this.port.load(request); } catch (error) { throw wrapPortError(error, "load settings"); }
    if (response.status === "empty") return { status: "empty", backend: this.backend, durable: this.durable, ...(response.receiptId ? { receiptId: response.receiptId } : {}) };
    const snapshot = normalizeSettingsPermissionsSnapshot(response.snapshot);
    if (snapshot.revision !== response.revision) throw new SettingsPermissionsError("persistence-failure", "Native settings revision disagrees with the snapshot.", { retryable: false });
    if (request.minimumRevision !== undefined && response.revision < request.minimumRevision) throw new SettingsPermissionsError("revision-conflict", "Native settings are older than the requested revision.", { details: { minimumRevision: request.minimumRevision, revision: response.revision } });
    return { status: "loaded", snapshot, revision: response.revision, backend: this.backend, durable: this.durable, ...(response.receiptId ? { receiptId: response.receiptId } : {}) };
  }

  public async save(snapshot: OmniaSettingsPermissionsSnapshot, expectedRevision?: number): Promise<SettingsPermissionsSaveResult> {
    const normalized = normalizeSettingsPermissionsSnapshot(snapshot);
    if (expectedRevision !== undefined) assertRevision(expectedRevision, "Expected revision");
    let response: SettingsPermissionsSaveResponse;
    try { response = await this.port.save({ snapshot: serializeSettingsPermissionsSnapshot(normalized), ...(expectedRevision === undefined ? {} : { expectedRevision }) }); } catch (error) { throw wrapPortError(error, "save settings"); }
    if (response.status === "conflict") throw new SettingsPermissionsError("revision-conflict", "Settings changed before this save completed.", { details: { currentRevision: response.currentRevision, expectedRevision: response.expectedRevision } });
    if (response.revision < normalized.revision) throw new SettingsPermissionsError("persistence-failure", "Native settings revision regressed after save.", { retryable: false });
    return { status: "saved", revision: response.revision, backend: this.backend, durable: this.durable, ...(response.receiptId ? { receiptId: response.receiptId } : {}) };
  }

  public evaluate(snapshot: OmniaSettingsPermissionsSnapshot, capability: PermissionCapability, scope: PermissionScope): PermissionEffect {
    return evaluatePermission(normalizeSettingsPermissionsSnapshot(snapshot).permissions, capability, scope);
  }
}

export class InMemorySettingsPermissionsPort implements SettingsPermissionsPort {
  public readonly backend = "memory" as const;
  public readonly durable = false;
  private stored: string | null;
  private revision = 0;

  public constructor(initial?: OmniaSettingsPermissionsSnapshot) {
    this.stored = initial === undefined ? null : serializeSettingsPermissionsSnapshot(initial);
    this.revision = initial?.revision ?? 0;
  }

  public async load(request: SettingsPermissionsLoadRequest = {}): Promise<SettingsPermissionsLoadResponse> {
    if (this.stored === null) return { status: "empty" };
    if (request.minimumRevision !== undefined && this.revision < request.minimumRevision) return { status: "loaded", snapshot: this.stored, revision: this.revision };
    return { status: "loaded", snapshot: this.stored, revision: this.revision };
  }

  public async save(request: SettingsPermissionsSaveRequest): Promise<SettingsPermissionsSaveResponse> {
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.revision) return { status: "conflict", currentRevision: this.revision || null, expectedRevision: request.expectedRevision };
    const snapshot = normalizeSettingsPermissionsSnapshot(request.snapshot);
    this.stored = serializeSettingsPermissionsSnapshot(snapshot);
    this.revision = snapshot.revision;
    return { status: "saved", revision: this.revision };
  }
}

export function createInMemorySettingsPermissionsAdapter(initial?: OmniaSettingsPermissionsSnapshot): OmniaSettingsPermissionsAdapter {
  return new OmniaSettingsPermissionsAdapter(new InMemorySettingsPermissionsPort(initial));
}
