import { desktop, isDesktopRuntime } from "@/lib/desktop";

export interface DiscoveryProfile {
  id: string;
  displayName: string;
  providerType: string;
  enabled: boolean;
  credentialStatus: "present" | "missing" | "locked" | "unknown";
}

export interface DiscoveryModel {
  id: string;
  displayName: string;
  ownedBy: string | null;
  createdAt: number | null;
  capabilities: {
    streaming: boolean;
    tools: boolean | null;
    vision: boolean | null;
    reasoning: boolean | null;
    source: string;
  };
}

/** A catalog is a native projection, never a credential or endpoint snapshot. */
export interface DiscoveryCatalog {
  profileId: string;
  discoveredAt: string;
  models: DiscoveryModel[];
  /** Present when the native gateway persisted this exact catalog. */
  snapshotId?: string;
  snapshotSha256?: string;
}
export interface ModelDiscoveryService {
  available: boolean;
  listProfiles: () => Promise<unknown>;
  listModels: (profileId: string) => Promise<unknown>;
}
export type CatalogStatus = "none" | "available" | "refresh-failed" | "cancelled";
export type DiscoveryErrorKind = "unavailable" | "permission-required" | "authentication" | "rate-limited" | "protocol" | "timeout" | "unknown";
export interface DiscoveryErrorInfo {
  kind: DiscoveryErrorKind;
  message: string;
  retryAfterMs?: number;
  diagnosticId?: string;
}
export interface DiscoveryAttemptMetadata {
  attemptId: string;
  providerProfileId: string;
  modelId: string;
  snapshotId?: string;
  snapshotSha256?: string;
  startedAt: string;
}
export interface ModelDiscoverySnapshot {
  phase: "unavailable" | "idle" | "loading-profiles" | "loading-models" | "ready" | "error" | "cancelled";
  profiles: DiscoveryProfile[];
  selectedProfileId: string;
  catalog: DiscoveryCatalog | null;
  catalogStatus: CatalogStatus;
  activeAttempt: DiscoveryAttemptMetadata | null;
  error: string | null;
  errorInfo: DiscoveryErrorInfo | null;
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native data");
  return value as Record<string, unknown>;
};
const safeText = (value: unknown, limit = 512): string => {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid native text");
  return value.trim();
};
const nullableBoolean = (value: unknown): boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new Error("Invalid capability");
  return value;
};
const optionalSafeText = (value: unknown, limit = 512): string | undefined => value == null ? undefined : safeText(value, limit);
const optionalSha256 = (value: unknown): string | undefined => {
  if (value == null) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) throw new Error("Invalid native snapshot hash");
  return value.toLowerCase();
};
const snapshotId = (value: unknown): string | undefined => {
  const result = optionalSafeText(value, 256);
  if (result && !/^[A-Za-z0-9_.:-]{1,256}$/.test(result)) throw new Error("Invalid native snapshot id");
  return result;
};

function decodeProfiles(value: unknown): DiscoveryProfile[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid native profiles");
  const seen = new Set<string>();
  return value.map((entry) => {
    const row = record(entry); const id = safeText(row.id, 256);
    if (seen.has(id) || typeof row.enabled !== "boolean") throw new Error("Invalid native profile");
    seen.add(id);
    return {
      id, displayName: safeText(row.displayName, 512), providerType: safeText(row.providerType, 128), enabled: row.enabled,
      credentialStatus: (["present", "missing", "locked"].includes(String(row.credentialStatus)) ? row.credentialStatus : "unknown") as DiscoveryProfile["credentialStatus"],
    };
  });
}

function decodeCatalog(value: unknown, expectedProfileId: string): DiscoveryCatalog {
  const data = record(value); const profileId = safeText(data.profileId, 256);
  if (profileId !== expectedProfileId || typeof data.discoveredAt !== "string" || !Number.isFinite(Date.parse(data.discoveredAt)) || !Array.isArray(data.models) || data.models.length > 2_000) throw new Error("Invalid native model catalog");
  const nativeSnapshotId = snapshotId(data.snapshotId);
  const nativeSnapshotSha256 = optionalSha256(data.snapshotSha256);
  if ((nativeSnapshotId && !nativeSnapshotSha256) || (!nativeSnapshotId && nativeSnapshotSha256)) throw new Error("Incomplete native snapshot lineage");
  const seen = new Set<string>();
  const models = data.models.map((entry): DiscoveryModel => {
    const row = record(entry); const id = safeText(row.id); const caps = record(row.capabilities);
    if (seen.has(id) || typeof caps.streaming !== "boolean") throw new Error("Invalid native model");
    seen.add(id);
    if (row.createdAt != null && (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt))) throw new Error("Invalid creation time");
    return {
      id, displayName: safeText(row.displayName), ownedBy: row.ownedBy == null ? null : safeText(row.ownedBy), createdAt: row.createdAt == null ? null : row.createdAt as number,
      capabilities: { streaming: caps.streaming, tools: nullableBoolean(caps.tools), vision: nullableBoolean(caps.vision), reasoning: nullableBoolean(caps.reasoning), source: safeText(caps.source, 128) },
    };
  });
  return { profileId, discoveredAt: data.discoveredAt, models, ...(nativeSnapshotId && nativeSnapshotSha256 ? { snapshotId: nativeSnapshotId, snapshotSha256: nativeSnapshotSha256 } : {}) };
}

const errorKind = (value: unknown): DiscoveryErrorKind => {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const code = typeof row.code === "string" ? row.code.toLowerCase() : "";
  if (code.includes("permission") || code.includes("network_access")) return "permission-required";
  if (code.includes("auth") || code.includes("credential") || code.includes("unauthorized")) return "authentication";
  if (code.includes("rate") || code.includes("quota")) return "rate-limited";
  if (code.includes("timeout") || code.includes("deadline")) return "timeout";
  if (code.includes("protocol") || code.includes("malformed") || code.includes("invalid")) return "protocol";
  if (code.includes("dns") || code.includes("unavailable") || code.includes("connection")) return "unavailable";
  return "unknown";
};
const retryAfter = (value: unknown): number | undefined => {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const candidate = row.retryAfterMs ?? row.retry_after_ms;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return undefined;
  return Math.min(86_400_000, Math.max(0, Math.round(candidate)));
};
const diagnosticId = (value: unknown): string | undefined => {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const candidate = row.diagnosticId ?? row.diagnostic_id;
  return typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate) ? candidate : undefined;
};
function projectError(value: unknown, message: string): DiscoveryErrorInfo {
  const info: DiscoveryErrorInfo = { kind: errorKind(value), message };
  const wait = retryAfter(value); if (wait !== undefined) info.retryAfterMs = wait;
  const id = diagnosticId(value); if (id) info.diagnosticId = id;
  return info;
}

function normalizeAttempt(value: DiscoveryAttemptMetadata): DiscoveryAttemptMetadata {
  const attemptId = safeText(value.attemptId, 256);
  const providerProfileId = safeText(value.providerProfileId, 256);
  const modelId = safeText(value.modelId, 512);
  const startedAt = safeText(value.startedAt, 64);
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error("Invalid attempt timestamp");
  const snapshot = snapshotId(value.snapshotId);
  const hash = optionalSha256(value.snapshotSha256);
  if ((snapshot && !hash) || (!snapshot && hash)) throw new Error("Incomplete attempt snapshot lineage");
  return { attemptId, providerProfileId, modelId, startedAt, ...(snapshot && hash ? { snapshotId: snapshot, snapshotSha256: hash } : {}) };
}

/** Uses native profile IDs only. Credentials and endpoints never enter this state. */
export function nativeModelDiscoveryService(): ModelDiscoveryService {
  return { available: isDesktopRuntime(), listProfiles: () => desktop.listProviderProfiles(), listModels: (id) => desktop.listProviderModels(id) };
}

/** A revision invalidates every previous response, including failed and cancelled IPC. */
export class ModelDiscoveryController {
  private revision = 0;
  private listeners = new Set<() => void>();
  private snapshot: ModelDiscoverySnapshot;

  constructor(private service: ModelDiscoveryService, preferredProfileId = "") {
    this.snapshot = { phase: service.available ? "idle" : "unavailable", profiles: [], selectedProfileId: preferredProfileId, catalog: null, catalogStatus: "none", activeAttempt: null, error: null, errorInfo: null };
  }
  getSnapshot = (): ModelDiscoverySnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ModelDiscoverySnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }

  /** Keep run lineage visible while a catalog refresh is loading or fails. */
  setActiveAttempt = (attempt: DiscoveryAttemptMetadata | null): void => {
    if (attempt === null) { this.update({ activeAttempt: null }); return; }
    try { this.update({ activeAttempt: normalizeAttempt(attempt) }); } catch { this.update({ activeAttempt: null, error: "The active attempt metadata was invalid.", errorInfo: projectError(undefined, "The active attempt metadata was invalid.") }); }
  };
  setActiveAttemptMetadata = this.setActiveAttempt;

  refreshProfiles = async (): Promise<void> => {
    if (!this.service.available) return;
    const revision = ++this.revision;
    this.update({ phase: "loading-profiles", error: null, errorInfo: null });
    try {
      const profiles = decodeProfiles(await this.service.listProfiles());
      if (revision !== this.revision) return;
      const selectedProfileId = profiles.some((profile) => profile.id === this.snapshot.selectedProfileId && profile.enabled) ? this.snapshot.selectedProfileId : "";
      this.update({ phase: "idle", profiles, selectedProfileId });
    } catch (error) {
      if (revision !== this.revision) return;
      const info = projectError(error, "Provider profiles could not be loaded. Check the provider configuration and native permissions, then retry.");
      this.update({ phase: "error", profiles: [], selectedProfileId: "", error: info.message, errorInfo: info });
    }
  };

  selectProfile = (profileId: string): void => {
    ++this.revision;
    if (!this.service.available) return;
    if (profileId === "") { this.update({ phase: "idle", selectedProfileId: "", catalog: null, catalogStatus: "none", error: null, errorInfo: null }); return; }
    const profile = this.snapshot.profiles.find((entry) => entry.id === profileId && entry.enabled);
    if (!profile) { this.update({ phase: "error", selectedProfileId: "", catalog: null, catalogStatus: "none", error: "Select an enabled provider profile before discovering models.", errorInfo: projectError(undefined, "Select an enabled provider profile before discovering models.") }); return; }
    const sameProfile = this.snapshot.selectedProfileId === profileId;
    this.update({ phase: "idle", selectedProfileId: profileId, ...(sameProfile ? {} : { catalog: null, catalogStatus: "none" }), error: null, errorInfo: null });
  };

  refreshModels = async (): Promise<void> => {
    if (!this.service.available) return;
    const profileId = this.snapshot.selectedProfileId;
    if (!this.snapshot.profiles.some((entry) => entry.id === profileId && entry.enabled)) {
      this.update({ phase: "error", error: "Select an enabled provider profile before discovering models.", errorInfo: projectError(undefined, "Select an enabled provider profile before discovering models.") }); return;
    }
    const revision = ++this.revision;
    this.update({ phase: "loading-models", error: null, errorInfo: null });
    try {
      const catalog = decodeCatalog(await this.service.listModels(profileId), profileId);
      if (revision !== this.revision) return;
      this.update({ phase: "ready", catalog, catalogStatus: "available" });
    } catch (error) {
      if (revision !== this.revision) return;
      const info = projectError(error, "Model discovery failed. Check the provider connection, permissions and native credential status, then retry.");
      this.update({ phase: "error", catalogStatus: "refresh-failed", error: info.message, errorInfo: info });
    }
  };

  /** Native IPC has no abort command: this cancels UI acceptance only. */
  cancel = (): void => {
    ++this.revision;
    if (this.service.available) this.update({ phase: "cancelled", catalogStatus: this.snapshot.catalog ? "cancelled" : "none", error: null, errorInfo: null });
  };
}
