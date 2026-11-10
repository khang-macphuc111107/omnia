import { assertDomain } from "./errors";
import type {
  AssistantProfileId,
  ModelProfileId,
  ProfileId,
  ProjectId,
  ProviderConnectionId,
  SkillVersionId,
  WorkspaceGrantId,
} from "./ids";
import { assertNonBlank, assertSha256, type IsoTimestamp, type JsonObject } from "./shared";

export type MemoryMode = "off" | "read-only" | "propose" | "auto-low-risk" | "custom";

export interface ProjectPrivacyPolicy {
  readonly localOnly: boolean;
  readonly memoryMode: MemoryMode;
  readonly allowedProviderConnectionIds: readonly ProviderConnectionId[];
  readonly allowedDataClasses: readonly string[];
  readonly retainRawProviderPayloads: boolean;
}

export interface Project {
  readonly id: ProjectId;
  readonly profileId: ProfileId;
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly icon?: string;
  readonly color?: string;
  readonly defaultProviderConnectionId?: ProviderConnectionId;
  readonly defaultModelProfileId?: ModelProfileId;
  readonly defaultAssistantProfileId?: AssistantProfileId;
  readonly skillVersionIds: readonly SkillVersionId[];
  readonly privacy: ProjectPrivacyPolicy;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly archivedAt?: IsoTimestamp;
  readonly deletedAt?: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface CreateProjectInput {
  readonly id: ProjectId;
  readonly profileId: ProfileId;
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly icon?: string;
  readonly color?: string;
  readonly defaultProviderConnectionId?: ProviderConnectionId;
  readonly defaultModelProfileId?: ModelProfileId;
  readonly defaultAssistantProfileId?: AssistantProfileId;
  readonly skillVersionIds?: readonly SkillVersionId[];
  readonly privacy?: Partial<ProjectPrivacyPolicy>;
  readonly metadata?: JsonObject;
  readonly now: IsoTimestamp;
}

export function createProject(input: CreateProjectInput): Project {
  const allowedProviders = Object.freeze([...(input.privacy?.allowedProviderConnectionIds ?? [])]);
  const privacy: ProjectPrivacyPolicy = Object.freeze({
    localOnly: input.privacy?.localOnly ?? false,
    memoryMode: input.privacy?.memoryMode ?? "propose",
    allowedProviderConnectionIds: allowedProviders,
    allowedDataClasses: Object.freeze([...(input.privacy?.allowedDataClasses ?? ["standard"])]),
    retainRawProviderPayloads: input.privacy?.retainRawProviderPayloads ?? false,
  });
  if (input.defaultProviderConnectionId !== undefined && allowedProviders.length > 0) {
    assertDomain(
      allowedProviders.includes(input.defaultProviderConnectionId),
      "scope_violation",
      "The default provider is excluded by the project privacy policy.",
      { projectId: input.id, providerConnectionId: input.defaultProviderConnectionId },
    );
  }
  return Object.freeze({
    id: input.id,
    profileId: input.profileId,
    name: assertNonBlank(input.name, "project name", 200),
    ...(input.description === undefined ? {} : { description: input.description.trim() }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions.trim() }),
    ...(input.icon === undefined ? {} : { icon: assertNonBlank(input.icon, "project icon", 120) }),
    ...(input.color === undefined ? {} : { color: assertNonBlank(input.color, "project color", 64) }),
    ...(input.defaultProviderConnectionId === undefined
      ? {}
      : { defaultProviderConnectionId: input.defaultProviderConnectionId }),
    ...(input.defaultModelProfileId === undefined
      ? {}
      : { defaultModelProfileId: input.defaultModelProfileId }),
    ...(input.defaultAssistantProfileId === undefined
      ? {}
      : { defaultAssistantProfileId: input.defaultAssistantProfileId }),
    skillVersionIds: Object.freeze([...(input.skillVersionIds ?? [])]),
    privacy,
    createdAt: input.now,
    updatedAt: input.now,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export interface WorkspacePermissions {
  readonly read: true;
  readonly index: boolean;
  readonly watch: boolean;
  readonly followSymlinks: false;
  readonly write: false;
  readonly execute: false;
}

export interface WorkspaceGrant {
  readonly id: WorkspaceGrantId;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  /** Native-owned path/bookmark token, never used as display text. */
  readonly pathRef: string;
  readonly canonicalPathHash: string;
  readonly displayPath: string;
  readonly permissions: WorkspacePermissions;
  readonly ignorePatterns: readonly string[];
  readonly maximumFileBytes: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
}

export interface CreateWorkspaceGrantInput {
  readonly id: WorkspaceGrantId;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly pathRef: string;
  readonly canonicalPathHash: string;
  readonly displayPath: string;
  readonly index?: boolean;
  readonly watch?: boolean;
  readonly ignorePatterns?: readonly string[];
  readonly maximumFileBytes?: number;
  readonly now: IsoTimestamp;
}

export function createWorkspaceGrant(input: CreateWorkspaceGrantInput): WorkspaceGrant {
  const maximumFileBytes = input.maximumFileBytes ?? 25 * 1024 * 1024;
  assertDomain(
    Number.isSafeInteger(maximumFileBytes) && maximumFileBytes > 0,
    "invalid_argument",
    "Workspace maximum file size must be a positive safe integer.",
  );
  return Object.freeze({
    id: input.id,
    profileId: input.profileId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    pathRef: assertNonBlank(input.pathRef, "workspace path reference", 2048),
    canonicalPathHash: assertSha256(input.canonicalPathHash, "canonical path hash"),
    displayPath: assertNonBlank(input.displayPath, "workspace display path", 4096),
    permissions: Object.freeze({
      read: true,
      index: input.index ?? true,
      watch: input.watch ?? true,
      followSymlinks: false,
      write: false,
      execute: false,
    }),
    ignorePatterns: Object.freeze([...(input.ignorePatterns ?? [])]),
    maximumFileBytes,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function revokeWorkspaceGrant(grant: WorkspaceGrant, now: IsoTimestamp): WorkspaceGrant {
  assertDomain(grant.revokedAt === undefined, "conflict", "Workspace grant is already revoked.", {
    grantId: grant.id,
  });
  return Object.freeze({ ...grant, revokedAt: now, updatedAt: now });
}

/**
 * Verifies a canonical path supplied by the native path resolver. Renderer
 * strings must never be passed here as canonical paths.
 */
export function assertPathInsideWorkspace(
  grant: WorkspaceGrant,
  canonicalRoot: string,
  canonicalTarget: string,
): void {
  assertDomain(grant.revokedAt === undefined, "permission_denied", "Workspace grant is revoked.", {
    grantId: grant.id,
  });
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
  const root = normalize(canonicalRoot);
  const target = normalize(canonicalTarget);
  assertDomain(
    target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`),
    "scope_violation",
    "Canonical path escapes the granted workspace root.",
    { grantId: grant.id },
  );
}
