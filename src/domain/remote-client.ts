import { assertDomain } from "./errors";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";

/**
 * Remote clients are presentation/control surfaces, not execution environments.
 * A phone may control a persistent local environment or observe an isolated
 * run, but it cannot influence Auto environment selection merely by being
 * remote.
 */
export type RemoteClientKind = "web" | "cli" | "android";

export type RemoteClientPermission =
  | "projection.read"
  | "run.start"
  | "run.steer"
  | "run.cancel"
  | "approval.read"
  | "approval.respond"
  | "artifact.read"
  | "artifact.write"
  | "environment.request"
  | "environment.control"
  | "terminal.view"
  | "terminal.input"
  | "screen.view"
  | "screen.input"
  | "clipboard.read"
  | "clipboard.write"
  | "file.download"
  | "file.upload";

export type RemoteAuthenticationStrength =
  | "device-key"
  | "device-key-user-verified";

export type RemoteSessionState = "active" | "closed" | "expired" | "revoked";

export type RemoteCommandTargetKind =
  | "profile"
  | "project"
  | "conversation"
  | "environment"
  | "run";

export type RemoteControlSurface = "screen-input" | "terminal-input";

const REMOTE_CLIENT_KINDS: ReadonlySet<RemoteClientKind> = new Set([
  "web",
  "cli",
  "android",
]);

const REMOTE_CLIENT_PERMISSIONS: ReadonlySet<RemoteClientPermission> = new Set([
  "projection.read",
  "run.start",
  "run.steer",
  "run.cancel",
  "approval.read",
  "approval.respond",
  "artifact.read",
  "artifact.write",
  "environment.request",
  "environment.control",
  "terminal.view",
  "terminal.input",
  "screen.view",
  "screen.input",
  "clipboard.read",
  "clipboard.write",
  "file.download",
  "file.upload",
]);

const COMMAND_TARGET_KINDS: ReadonlySet<RemoteCommandTargetKind> = new Set([
  "profile",
  "project",
  "conversation",
  "environment",
  "run",
]);

/**
 * These operations require a fresh user-verification assertion in addition to
 * possession of the device key. Kernel capability and approval evaluation
 * still runs afterward; remote authentication never substitutes for it.
 */
const MINIMUM_USER_VERIFICATION_PERMISSIONS: ReadonlySet<RemoteClientPermission> = new Set([
  "approval.respond",
  "environment.control",
  "terminal.input",
  "screen.input",
  "clipboard.read",
  "clipboard.write",
  "file.upload",
]);

const MAX_SCOPE_IDS = 1_024;
const MIN_SESSION_DURATION_MS = 60_000;
const MAX_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_COMMAND_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1_000;
const MAX_CONTROL_LEASE_MS = 5 * 60 * 1_000;

export interface RemoteRestrictedScope {
  readonly kind: "restricted";
  readonly projectIds: readonly string[];
  readonly conversationIds: readonly string[];
  readonly environmentIds: readonly string[];
}

export type RemoteDeviceGrantScope =
  | { readonly kind: "profile" }
  | RemoteRestrictedScope;

export interface RemoteSessionPolicy {
  readonly maximumConcurrentSessions: number;
  readonly maximumSessionDurationMs: number;
  readonly idleTimeoutMs: number;
  readonly commandLifetimeMs: number;
  readonly maximumClockSkewMs: number;
  readonly userVerificationWindowMs: number;
}

/**
 * One immutable revision of a device grant. Updating permissions or scope
 * creates a new revision/hash and invalidates sessions pinned to the old one.
 */
export interface RemoteDeviceGrant {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly revisionHash: string;
  readonly hostId: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly clientKind: RemoteClientKind;
  readonly displayName: string;
  readonly permissions: readonly RemoteClientPermission[];
  readonly userVerificationPermissions: readonly RemoteClientPermission[];
  readonly scope: RemoteDeviceGrantScope;
  readonly sessionPolicy: RemoteSessionPolicy;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
}

export interface RemoteClientSession {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly hostId: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly grantRevisionHash: string;
  readonly connectionEpoch: number;
  readonly state: RemoteSessionState;
  readonly authenticationStrength: RemoteAuthenticationStrength;
  readonly authenticatedAt: IsoTimestamp;
  readonly userVerifiedAt?: IsoTimestamp;
  readonly lastSeenAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly lastAcceptedCounter: number;
}

/**
 * The command body is transported separately. commandHash is recomputed by the
 * host over the canonical type, target and payload before this contract runs.
 */
export interface RemoteCommandEnvelope {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly hostId: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly connectionEpoch: number;
  readonly counter: number;
  readonly commandId: string;
  readonly commandType: string;
  readonly commandHash: string;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

/** Host-owned command metadata. A client never declares its own permission. */
export interface RemoteCommandDescriptor {
  readonly commandType: string;
  readonly permission: RemoteClientPermission;
  readonly allowedTargetKinds: readonly RemoteCommandTargetKind[];
  readonly requiresUserVerification: boolean;
}

/**
 * Scope resolved from durable kernel lineage. Client-supplied parent IDs are
 * not authority and must not be copied into this value without repository
 * verification.
 */
export type RemoteResolvedCommandScope =
  | {
      readonly kind: "profile";
      readonly profileId: string;
    }
  | {
      readonly kind: "project";
      readonly profileId: string;
      readonly projectId: string;
    }
  | {
      readonly kind: "conversation";
      readonly profileId: string;
      readonly conversationId: string;
      readonly projectId?: string;
    }
  | {
      readonly kind: "environment";
      readonly profileId: string;
      readonly environmentId: string;
      readonly projectId?: string;
    }
  | {
      readonly kind: "run";
      readonly profileId: string;
      readonly runId: string;
      readonly conversationId: string;
      readonly projectId?: string;
      readonly environmentId?: string;
    };

export interface AcceptedRemoteCommand {
  readonly sessionId: string;
  readonly connectionEpoch: number;
  readonly counter: number;
  readonly commandId: string;
  readonly commandType: string;
  readonly commandHash: string;
  readonly acceptedAt: IsoTimestamp;
}

export interface AuthorizeRemoteCommandInput {
  readonly grant: RemoteDeviceGrant;
  readonly session: RemoteClientSession;
  readonly envelope: RemoteCommandEnvelope;
  readonly descriptor: RemoteCommandDescriptor;
  readonly resolvedScope: RemoteResolvedCommandScope;
  readonly acceptedCommands: readonly AcceptedRemoteCommand[];
  readonly now: IsoTimestamp;
}

export interface AuthorizedRemoteCommand {
  readonly outcome: "accepted" | "idempotent-replay";
  readonly session: RemoteClientSession;
  readonly command: AcceptedRemoteCommand;
}

export interface RemoteControlLease {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly leaseEpoch: number;
  readonly hostId: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly environmentId: string;
  readonly resourceId: string;
  readonly surface: RemoteControlSurface;
  readonly acquiredAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly releasedAt?: IsoTimestamp;
}

function uniqueNonBlank(values: readonly string[], label: string): readonly string[] {
  assertDomain(
    values.length <= MAX_SCOPE_IDS,
    "invalid_argument",
    `${label} cannot contain more than ${MAX_SCOPE_IDS} entries.`,
  );
  const normalized = values.map((value) => assertNonBlank(value, label, 256));
  assertDomain(
    new Set(normalized).size === normalized.length,
    "invalid_argument",
    `${label} values must be unique.`,
  );
  return Object.freeze(normalized);
}

function normalizePermissions(
  values: readonly RemoteClientPermission[],
  label: string,
  allowEmpty = false,
): readonly RemoteClientPermission[] {
  assertDomain(
    allowEmpty || values.length > 0,
    "invalid_argument",
    `${label} cannot be empty.`,
  );
  const normalized = uniqueNonBlank(values, label) as readonly RemoteClientPermission[];
  assertDomain(
    normalized.every((permission) => REMOTE_CLIENT_PERMISSIONS.has(permission)),
    "invalid_argument",
    `${label} contains an unsupported permission.`,
  );
  return normalized;
}

function normalizeScope(scope: RemoteDeviceGrantScope): RemoteDeviceGrantScope {
  if (scope.kind === "profile") return Object.freeze({ kind: "profile" });
  const projectIds = uniqueNonBlank(scope.projectIds, "remote project scope");
  const conversationIds = uniqueNonBlank(scope.conversationIds, "remote conversation scope");
  const environmentIds = uniqueNonBlank(scope.environmentIds, "remote environment scope");
  assertDomain(
    projectIds.length + conversationIds.length + environmentIds.length > 0,
    "invalid_argument",
    "A restricted remote grant must name at least one durable scope.",
  );
  return Object.freeze({
    kind: "restricted",
    projectIds,
    conversationIds,
    environmentIds,
  });
}

function validateSessionPolicy(policy: RemoteSessionPolicy): RemoteSessionPolicy {
  assertIntegerInRange(policy.maximumConcurrentSessions, "maximum concurrent sessions", 1, 32);
  assertIntegerInRange(
    policy.maximumSessionDurationMs,
    "maximum remote session duration",
    MIN_SESSION_DURATION_MS,
    MAX_SESSION_DURATION_MS,
  );
  assertIntegerInRange(
    policy.idleTimeoutMs,
    "remote session idle timeout",
    MIN_SESSION_DURATION_MS,
    policy.maximumSessionDurationMs,
  );
  assertIntegerInRange(
    policy.commandLifetimeMs,
    "remote command lifetime",
    1_000,
    MAX_COMMAND_LIFETIME_MS,
  );
  assertIntegerInRange(
    policy.maximumClockSkewMs,
    "remote clock skew",
    0,
    MAX_CLOCK_SKEW_MS,
  );
  assertIntegerInRange(
    policy.userVerificationWindowMs,
    "remote user verification window",
    15_000,
    policy.maximumSessionDurationMs,
  );
  return Object.freeze({ ...policy });
}

function assertPermissionDependencies(permissions: ReadonlySet<RemoteClientPermission>): void {
  for (const [dependent, prerequisite] of [
    ["approval.respond", "approval.read"],
    ["terminal.input", "terminal.view"],
    ["screen.input", "screen.view"],
  ] as const) {
    assertDomain(
      !permissions.has(dependent) || permissions.has(prerequisite),
      "invalid_argument",
      `${dependent} requires ${prerequisite}.`,
    );
  }
}

export function createRemoteDeviceGrant(input: RemoteDeviceGrant): RemoteDeviceGrant {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported remote grant version.");
  assertDomain(
    REMOTE_CLIENT_KINDS.has(input.clientKind),
    "invalid_argument",
    "Unsupported remote client kind.",
  );
  assertIntegerInRange(input.revision, "remote grant revision", 1, Number.MAX_SAFE_INTEGER);
  const permissions = normalizePermissions(input.permissions, "remote permission");
  const permissionSet = new Set(permissions);
  assertPermissionDependencies(permissionSet);
  const userVerificationPermissions = normalizePermissions(
    input.userVerificationPermissions,
    "remote user-verification permission",
    true,
  );
  assertDomain(
    userVerificationPermissions.every((permission) => permissionSet.has(permission)),
    "scope_violation",
    "User-verification permissions must be a subset of the device grant.",
  );
  const userVerificationSet = new Set(userVerificationPermissions);
  assertDomain(
    [...MINIMUM_USER_VERIFICATION_PERMISSIONS].every(
      (permission) => !permissionSet.has(permission) || userVerificationSet.has(permission),
    ),
    "permission_denied",
    "High-impact remote permissions must require fresh user verification.",
  );
  assertIsoTimestamp(input.createdAt, "remote grant creation time");
  if (input.expiresAt !== undefined) {
    assertIsoTimestamp(input.expiresAt, "remote grant expiry time");
    assertDomain(
      Date.parse(input.expiresAt) > Date.parse(input.createdAt),
      "invalid_argument",
      "Remote grant expiry must be later than creation.",
    );
  }
  if (input.revokedAt !== undefined) {
    assertIsoTimestamp(input.revokedAt, "remote grant revocation time");
    assertDomain(
      Date.parse(input.revokedAt) >= Date.parse(input.createdAt),
      "invalid_argument",
      "Remote grant revocation cannot precede creation.",
    );
  }
  return Object.freeze({
    ...input,
    id: assertNonBlank(input.id, "remote grant ID", 256),
    revisionHash: assertSha256(input.revisionHash, "remote grant revision hash"),
    hostId: assertNonBlank(input.hostId, "remote host ID", 256),
    profileId: assertNonBlank(input.profileId, "remote profile ID", 256),
    deviceId: assertNonBlank(input.deviceId, "remote device ID", 256),
    displayName: assertNonBlank(input.displayName, "remote device display name", 160),
    permissions,
    userVerificationPermissions,
    scope: normalizeScope(input.scope),
    sessionPolicy: validateSessionPolicy(input.sessionPolicy),
  });
}

export function isRemoteDeviceGrantActive(
  grant: RemoteDeviceGrant,
  now: IsoTimestamp,
): boolean {
  assertIsoTimestamp(now, "remote grant evaluation time");
  if (Date.parse(grant.createdAt) > Date.parse(now)) return false;
  if (grant.revokedAt !== undefined && Date.parse(grant.revokedAt) <= Date.parse(now)) return false;
  return grant.expiresAt === undefined || Date.parse(grant.expiresAt) > Date.parse(now);
}

export interface CreateRemoteClientSessionInput {
  readonly id: string;
  readonly connectionEpoch: number;
  readonly authenticationStrength: RemoteAuthenticationStrength;
  readonly authenticatedAt: IsoTimestamp;
  readonly userVerifiedAt?: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  /** Active sessions read in the same transaction that issues this session. */
  readonly existingSessions: readonly RemoteClientSession[];
}

export function createRemoteClientSession(
  unvalidatedGrant: RemoteDeviceGrant,
  input: CreateRemoteClientSessionInput,
): RemoteClientSession {
  const grant = createRemoteDeviceGrant(unvalidatedGrant);
  assertIsoTimestamp(input.authenticatedAt, "remote authentication time");
  assertIsoTimestamp(input.expiresAt, "remote session expiry time");
  assertDomain(
    isRemoteDeviceGrantActive(grant, input.authenticatedAt),
    "permission_denied",
    "A remote session cannot start from an inactive device grant.",
  );
  const sessionDuration = Date.parse(input.expiresAt) - Date.parse(input.authenticatedAt);
  assertDomain(
    sessionDuration >= MIN_SESSION_DURATION_MS &&
      sessionDuration <= grant.sessionPolicy.maximumSessionDurationMs,
    "invalid_argument",
    "Remote session duration exceeds the device policy.",
  );
  if (grant.expiresAt !== undefined) {
    assertDomain(
      Date.parse(input.expiresAt) <= Date.parse(grant.expiresAt),
      "scope_violation",
      "Remote session cannot outlive its device grant.",
    );
  }
  if (input.authenticationStrength === "device-key-user-verified") {
    assertDomain(
      input.userVerifiedAt !== undefined,
      "invalid_argument",
      "User-verified authentication requires a verification timestamp.",
    );
  } else {
    assertDomain(
      input.userVerifiedAt === undefined,
      "invalid_argument",
      "A device-key-only session cannot claim user verification.",
    );
  }
  if (input.userVerifiedAt !== undefined) {
    assertIsoTimestamp(input.userVerifiedAt, "remote user verification time");
    assertDomain(
      Date.parse(input.userVerifiedAt) <= Date.parse(input.authenticatedAt),
      "invalid_argument",
      "Remote user verification cannot occur after session authentication.",
    );
    assertDomain(
      Date.parse(input.authenticatedAt) - Date.parse(input.userVerifiedAt) <=
        grant.sessionPolicy.userVerificationWindowMs,
      "permission_denied",
      "Remote user verification is too old for session authentication.",
    );
  }
  assertIntegerInRange(input.connectionEpoch, "remote connection epoch", 1, Number.MAX_SAFE_INTEGER);
  assertDomain(
    !input.existingSessions.some((session) => session.id === input.id),
    "conflict",
    "Remote session ID is already in use.",
  );
  const concurrentSessions = input.existingSessions.filter(
    (session) =>
      session.state === "active" &&
      session.hostId === grant.hostId &&
      session.profileId === grant.profileId &&
      session.deviceId === grant.deviceId &&
      Date.parse(session.expiresAt) > Date.parse(input.authenticatedAt),
  ).length;
  assertDomain(
    concurrentSessions < grant.sessionPolicy.maximumConcurrentSessions,
    "permission_denied",
    "Remote device reached its concurrent-session limit.",
  );
  return Object.freeze({
    schemaVersion: 1,
    id: assertNonBlank(input.id, "remote session ID", 256),
    hostId: grant.hostId,
    profileId: grant.profileId,
    deviceId: grant.deviceId,
    grantId: grant.id,
    grantRevision: grant.revision,
    grantRevisionHash: grant.revisionHash,
    connectionEpoch: input.connectionEpoch,
    state: "active",
    authenticationStrength: input.authenticationStrength,
    authenticatedAt: input.authenticatedAt,
    ...(input.userVerifiedAt === undefined ? {} : { userVerifiedAt: input.userVerifiedAt }),
    lastSeenAt: input.authenticatedAt,
    expiresAt: input.expiresAt,
    lastAcceptedCounter: 0,
  });
}

export function reauthenticateRemoteClientSession(
  session: RemoteClientSession,
  now: IsoTimestamp,
): RemoteClientSession {
  assertIsoTimestamp(now, "remote reauthentication time");
  assertDomain(session.state === "active", "invalid_state_transition", "Remote session is not active.");
  assertDomain(
    Date.parse(now) >= Date.parse(session.lastSeenAt) && Date.parse(now) < Date.parse(session.expiresAt),
    "invalid_state_transition",
    "Remote session cannot be reauthenticated outside its active lifetime.",
  );
  return Object.freeze({
    ...session,
    authenticationStrength: "device-key-user-verified",
    userVerifiedAt: now,
    lastSeenAt: now,
  });
}

function assertResolvedScope(scope: RemoteResolvedCommandScope): void {
  assertDomain(COMMAND_TARGET_KINDS.has(scope.kind), "invalid_argument", "Unknown remote target kind.");
  assertNonBlank(scope.profileId, "resolved remote profile ID", 256);
  if ("projectId" in scope && scope.projectId !== undefined) {
    assertNonBlank(scope.projectId, "resolved remote project ID", 256);
  }
  if ("conversationId" in scope) {
    assertNonBlank(scope.conversationId, "resolved remote conversation ID", 256);
  }
  if ("environmentId" in scope && scope.environmentId !== undefined) {
    assertNonBlank(scope.environmentId, "resolved remote environment ID", 256);
  }
  if ("runId" in scope) assertNonBlank(scope.runId, "resolved remote run ID", 256);
}

function grantAllowsResolvedScope(
  grant: RemoteDeviceGrant,
  scope: RemoteResolvedCommandScope,
): boolean {
  if (grant.profileId !== scope.profileId) return false;
  if (grant.scope.kind === "profile") return true;
  if (scope.kind === "profile") return false;
  if (scope.kind === "project") return grant.scope.projectIds.includes(scope.projectId);
  if (scope.kind === "conversation") {
    return (
      grant.scope.conversationIds.includes(scope.conversationId) ||
      (scope.projectId !== undefined && grant.scope.projectIds.includes(scope.projectId))
    );
  }
  if (scope.kind === "environment") {
    return (
      grant.scope.environmentIds.includes(scope.environmentId) ||
      (scope.projectId !== undefined && grant.scope.projectIds.includes(scope.projectId))
    );
  }
  return (
    grant.scope.conversationIds.includes(scope.conversationId) ||
    (scope.projectId !== undefined && grant.scope.projectIds.includes(scope.projectId)) ||
    (scope.environmentId !== undefined && grant.scope.environmentIds.includes(scope.environmentId))
  );
}

function assertActiveSession(
  grant: RemoteDeviceGrant,
  session: RemoteClientSession,
  now: IsoTimestamp,
): void {
  assertDomain(session.schemaVersion === 1, "invalid_argument", "Unsupported remote session version.");
  assertIsoTimestamp(now, "remote command authorization time");
  assertDomain(session.state === "active", "permission_denied", "Remote session is not active.");
  assertDomain(isRemoteDeviceGrantActive(grant, now), "permission_denied", "Remote device grant is inactive.");
  assertDomain(
    session.hostId === grant.hostId &&
      session.profileId === grant.profileId &&
      session.deviceId === grant.deviceId &&
      session.grantId === grant.id &&
      session.grantRevision === grant.revision &&
      session.grantRevisionHash === grant.revisionHash,
    "scope_violation",
    "Remote session is pinned to a different device grant revision.",
  );
  assertDomain(
    Date.parse(now) < Date.parse(session.expiresAt),
    "permission_denied",
    "Remote session has expired.",
  );
  assertDomain(
    Date.parse(now) - Date.parse(session.lastSeenAt) <= grant.sessionPolicy.idleTimeoutMs,
    "permission_denied",
    "Remote session exceeded its idle timeout.",
  );
}

function assertFreshUserVerification(
  grant: RemoteDeviceGrant,
  session: RemoteClientSession,
  now: IsoTimestamp,
): void {
  assertDomain(
    session.authenticationStrength === "device-key-user-verified" &&
      session.userVerifiedAt !== undefined &&
      Date.parse(now) >= Date.parse(session.userVerifiedAt) &&
      Date.parse(now) - Date.parse(session.userVerifiedAt) <=
        grant.sessionPolicy.userVerificationWindowMs,
    "permission_denied",
    "This remote command requires fresh user verification.",
  );
}

export function authorizeRemoteCommand(
  input: AuthorizeRemoteCommandInput,
): AuthorizedRemoteCommand {
  const grant = createRemoteDeviceGrant(input.grant);
  const { session, envelope, descriptor, resolvedScope } = input;
  assertActiveSession(grant, session, input.now);
  assertDomain(envelope.schemaVersion === 1, "invalid_argument", "Unsupported remote command version.");
  assertDomain(
    envelope.sessionId === session.id &&
      envelope.hostId === session.hostId &&
      envelope.profileId === session.profileId &&
      envelope.deviceId === session.deviceId &&
      envelope.connectionEpoch === session.connectionEpoch,
    "scope_violation",
    "Remote command does not belong to the authenticated connection epoch.",
  );
  assertIntegerInRange(envelope.counter, "remote command counter", 1, Number.MAX_SAFE_INTEGER);
  assertIsoTimestamp(envelope.issuedAt, "remote command issue time");
  assertIsoTimestamp(envelope.expiresAt, "remote command expiry time");
  const issueTime = Date.parse(envelope.issuedAt);
  const expiryTime = Date.parse(envelope.expiresAt);
  const now = Date.parse(input.now);
  assertDomain(
    issueTime <= now + grant.sessionPolicy.maximumClockSkewMs,
    "invalid_argument",
    "Remote command issue time is too far in the future.",
  );
  assertDomain(
    expiryTime > issueTime && expiryTime - issueTime <= grant.sessionPolicy.commandLifetimeMs,
    "invalid_argument",
    "Remote command lifetime exceeds the device policy.",
  );
  assertDomain(now < expiryTime, "permission_denied", "Remote command has expired.");
  const commandId = assertNonBlank(envelope.commandId, "remote command ID", 256);
  const commandType = assertNonBlank(envelope.commandType, "remote command type", 160);
  assertDomain(
    /^[a-z][a-z0-9_.-]+$/.test(commandType),
    "invalid_argument",
    "Remote command type must be a stable namespaced identifier.",
  );
  const commandHash = assertSha256(envelope.commandHash, "remote command hash");
  assertDomain(
    descriptor.commandType === commandType,
    "scope_violation",
    "Remote command descriptor does not match the canonical command type.",
  );
  assertDomain(
    REMOTE_CLIENT_PERMISSIONS.has(descriptor.permission),
    "invalid_argument",
    "Remote command descriptor uses an unknown permission.",
  );
  assertDomain(
    descriptor.allowedTargetKinds.length > 0 &&
      new Set(descriptor.allowedTargetKinds).size === descriptor.allowedTargetKinds.length &&
      descriptor.allowedTargetKinds.every((kind) => COMMAND_TARGET_KINDS.has(kind)),
    "invalid_argument",
    "Remote command descriptor contains invalid target kinds.",
  );
  assertResolvedScope(resolvedScope);
  assertDomain(
    descriptor.allowedTargetKinds.includes(resolvedScope.kind),
    "scope_violation",
    "Remote command cannot target this resource kind.",
  );
  assertDomain(
    grant.permissions.includes(descriptor.permission),
    "permission_denied",
    "Remote device grant does not include the command permission.",
  );
  assertDomain(
    grantAllowsResolvedScope(grant, resolvedScope),
    "scope_violation",
    "Remote command target is outside the device grant scope.",
  );
  const needsUserVerification =
    descriptor.requiresUserVerification ||
    grant.userVerificationPermissions.includes(descriptor.permission) ||
    MINIMUM_USER_VERIFICATION_PERMISSIONS.has(descriptor.permission);
  if (needsUserVerification) assertFreshUserVerification(grant, session, input.now);

  const existing = input.acceptedCommands.find((command) => command.commandId === commandId);
  if (existing !== undefined) {
    assertDomain(
      existing.sessionId === session.id &&
        existing.connectionEpoch === session.connectionEpoch &&
        existing.counter === envelope.counter &&
        existing.commandType === commandType &&
        existing.commandHash === commandHash,
      "conflict",
      "Remote command ID was reused for a different canonical operation.",
    );
    return Object.freeze({
      outcome: "idempotent-replay",
      session: Object.freeze({ ...session, lastSeenAt: input.now }),
      command: existing,
    });
  }

  assertDomain(
    envelope.counter === session.lastAcceptedCounter + 1,
    "permission_denied",
    "Remote command counter is stale, duplicated, or out of order.",
  );
  const accepted: AcceptedRemoteCommand = Object.freeze({
    sessionId: session.id,
    connectionEpoch: session.connectionEpoch,
    counter: envelope.counter,
    commandId,
    commandType,
    commandHash,
    acceptedAt: input.now,
  });
  return Object.freeze({
    outcome: "accepted",
    session: Object.freeze({
      ...session,
      lastSeenAt: input.now,
      lastAcceptedCounter: envelope.counter,
    }),
    command: accepted,
  });
}

export interface AcquireRemoteControlLeaseInput {
  readonly id: string;
  readonly session: RemoteClientSession;
  readonly environmentId: string;
  readonly resourceId: string;
  readonly surface: RemoteControlSurface;
  readonly now: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export function isRemoteControlLeaseActive(
  lease: RemoteControlLease,
  now: IsoTimestamp,
): boolean {
  assertIsoTimestamp(now, "remote control lease evaluation time");
  return (
    lease.releasedAt === undefined &&
    Date.parse(lease.acquiredAt) <= Date.parse(now) &&
    Date.parse(lease.expiresAt) > Date.parse(now)
  );
}

/**
 * Only one session may inject input into a terminal or screen resource at a
 * time. Read-only observers do not need this lease and remain independent.
 */
export function acquireRemoteControlLease(
  leases: readonly RemoteControlLease[],
  input: AcquireRemoteControlLeaseInput,
): RemoteControlLease {
  assertIsoTimestamp(input.now, "remote control lease acquisition time");
  assertIsoTimestamp(input.expiresAt, "remote control lease expiry time");
  assertDomain(input.session.state === "active", "permission_denied", "Remote session is not active.");
  assertDomain(
    Date.parse(input.now) < Date.parse(input.session.expiresAt),
    "permission_denied",
    "Remote session expired before control lease acquisition.",
  );
  const duration = Date.parse(input.expiresAt) - Date.parse(input.now);
  assertDomain(
    duration > 0 && duration <= MAX_CONTROL_LEASE_MS,
    "invalid_argument",
    "Remote control lease duration must be positive and bounded.",
  );
  assertDomain(
    Date.parse(input.expiresAt) <= Date.parse(input.session.expiresAt),
    "scope_violation",
    "Remote control lease cannot outlive its session.",
  );
  const environmentId = assertNonBlank(input.environmentId, "control environment ID", 256);
  const resourceId = assertNonBlank(input.resourceId, "control resource ID", 256);
  const conflicting = leases.find(
    (lease) =>
      lease.hostId === input.session.hostId &&
      lease.profileId === input.session.profileId &&
      lease.environmentId === environmentId &&
      lease.resourceId === resourceId &&
      lease.surface === input.surface &&
      isRemoteControlLeaseActive(lease, input.now),
  );
  assertDomain(
    conflicting === undefined,
    "conflict",
    "Another remote session already holds the input-control lease.",
  );
  return Object.freeze({
    schemaVersion: 1,
    id: assertNonBlank(input.id, "remote control lease ID", 256),
    leaseEpoch: 1,
    hostId: input.session.hostId,
    profileId: input.session.profileId,
    sessionId: input.session.id,
    deviceId: input.session.deviceId,
    environmentId,
    resourceId,
    surface: input.surface,
    acquiredAt: input.now,
    expiresAt: input.expiresAt,
  });
}

export function releaseRemoteControlLease(
  lease: RemoteControlLease,
  session: RemoteClientSession,
  now: IsoTimestamp,
): RemoteControlLease {
  assertIsoTimestamp(now, "remote control lease release time");
  assertDomain(
    lease.sessionId === session.id &&
      lease.deviceId === session.deviceId &&
      lease.hostId === session.hostId &&
      lease.profileId === session.profileId,
    "scope_violation",
    "Only the owning remote session may release this control lease.",
  );
  assertDomain(lease.releasedAt === undefined, "invalid_state_transition", "Control lease is already released.");
  assertDomain(
    Date.parse(now) >= Date.parse(lease.acquiredAt),
    "invalid_argument",
    "Control lease cannot be released before acquisition.",
  );
  return Object.freeze({ ...lease, releasedAt: now });
}
