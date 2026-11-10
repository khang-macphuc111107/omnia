import { assertDomain } from "./errors";
import type {
  ApprovalId,
  ApprovalReceiptId,
  AuditEventId,
  CapabilityGrantId,
  CapabilityRequestId,
  ExecutionEnvironmentId,
  ProfileId,
  RunId,
} from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  freezeJson,
  type IsoTimestamp,
  type JsonObject,
  type JsonValue,
} from "./shared";
import { assertOpaqueResourceHandle } from "./resource-handle";

/** Stable effects understood by every Omnia client and executor. */
export type KernelCapability =
  | "pure_compute"
  | "read_app_data"
  | "read_workspace"
  | "write_workspace"
  | "execute_process"
  | "use_network"
  | "external_side_effect"
  | "control_browser"
  | "control_computer"
  | "request_admin"
  | "access_secret_handle";

export type KernelCapabilitySubjectType =
  | "skill-version"
  | "workspace"
  | "provider"
  | "agent"
  | "tool-version"
  | "user";

export type CapabilityDecision = "allow" | "deny" | "require-approval";
export type KernelApprovalChoice = "allow-once" | "allow-run" | "deny";

const KERNEL_CAPABILITIES: ReadonlySet<KernelCapability> = new Set([
  "pure_compute",
  "read_app_data",
  "read_workspace",
  "write_workspace",
  "execute_process",
  "use_network",
  "external_side_effect",
  "control_browser",
  "control_computer",
  "request_admin",
  "access_secret_handle",
]);

const KERNEL_SUBJECT_TYPES: ReadonlySet<KernelCapabilitySubjectType> = new Set([
  "skill-version",
  "workspace",
  "provider",
  "agent",
  "tool-version",
  "user",
]);

function assertKernelCapability(value: KernelCapability, label = "capability"): KernelCapability {
  assertDomain(
    KERNEL_CAPABILITIES.has(value),
    "invalid_argument",
    `${label} is not a recognized kernel capability.`,
    { label },
  );
  return value;
}

function assertKernelSubjectType(
  value: KernelCapabilitySubjectType,
  label = "capability subject type",
): KernelCapabilitySubjectType {
  assertDomain(
    KERNEL_SUBJECT_TYPES.has(value),
    "invalid_argument",
    `${label} is not recognized.`,
    { label },
  );
  return value;
}

function normalizeSha256(value: string, label: string): string {
  return assertSha256(value, label);
}

function normalizeOptionalSha256(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : normalizeSha256(value, label);
}

function sameOptionalValue(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function assertRuntimeBoolean(value: boolean, label: string): boolean {
  assertDomain(typeof value === "boolean", "invalid_argument", `${label} must be a boolean.`, {
    label,
  });
  return value;
}

export interface CapabilityConstraint {
  readonly environmentIds?: readonly ExecutionEnvironmentId[];
  readonly resourceHandles?: readonly string[];
  readonly destinations?: readonly string[];
  readonly executableHashes?: readonly string[];
  readonly dataClasses?: readonly string[];
  readonly maximumInvocations?: number;
  readonly allowElevation?: boolean;
  readonly custom?: JsonObject;
}

export interface KernelCapabilityGrant {
  readonly id: CapabilityGrantId;
  readonly profileId: ProfileId;
  readonly subjectType: KernelCapabilitySubjectType;
  readonly subjectId: string;
  /** Versioned subjects are invalidated whenever their content changes. */
  readonly subjectContentHash?: string;
  readonly capability: KernelCapability;
  readonly constraints: CapabilityConstraint;
  readonly policyVersionHash: string;
  readonly grantedAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
}

export interface KernelCapabilityRequest {
  readonly id: CapabilityRequestId;
  /** Authorization must never cross the active local profile boundary. */
  readonly profileId: ProfileId;
  readonly runId: RunId;
  readonly environmentId: ExecutionEnvironmentId;
  readonly subjectType: KernelCapabilitySubjectType;
  readonly subjectId: string;
  readonly subjectContentHash?: string;
  readonly capability: KernelCapability;
  readonly operationType: string;
  readonly operationArgumentsHash: string;
  readonly toolVersionHash: string;
  readonly capabilitySetHash: string;
  readonly resourceHandles: readonly string[];
  readonly destinations: readonly string[];
  readonly executableHash?: string;
  readonly dataClasses: readonly string[];
  readonly requiresElevation: boolean;
  readonly requestedAt: IsoTimestamp;
}

export interface KernelCapabilityEvaluation {
  readonly requestId: CapabilityRequestId;
  readonly decision: CapabilityDecision;
  readonly reasonCode:
    | "safe-builtin"
    | "active-grant"
    | "exact-approval"
    | "approval-required"
    | "approval-consumed"
    | "no-active-grant"
    | "grant-constraint-mismatch"
    | "grant-invocation-limit"
    | "environment-capability-disabled"
    | "elevation-requires-approval"
    | "expired-approval"
    | "approval-scope-mismatch"
    | "denied-by-user";
  readonly matchedGrantId?: CapabilityGrantId;
  readonly matchedApprovalReceiptId?: ApprovalReceiptId;
  readonly evaluatedAt: IsoTimestamp;
  readonly policyVersionHash: string;
}

export interface KernelApprovalRequest {
  readonly id: ApprovalId;
  readonly capabilityRequestId: CapabilityRequestId;
  readonly profileId: ProfileId;
  readonly runId: RunId;
  readonly environmentId: ExecutionEnvironmentId;
  readonly subjectType: KernelCapabilitySubjectType;
  readonly subjectId: string;
  readonly subjectContentHash?: string;
  readonly operationType: string;
  readonly operationArgumentsHash: string;
  readonly toolVersionHash: string;
  readonly capabilitySetHash: string;
  readonly policyVersionHash: string;
  readonly capability: KernelCapability;
  readonly reason: string;
  readonly destinations: readonly string[];
  readonly resourceHandles: readonly string[];
  readonly executableHash?: string;
  readonly dataClasses: readonly string[];
  readonly requiresElevation: boolean;
  readonly proposedArgumentsPreview: JsonObject;
  readonly choices: readonly KernelApprovalChoice[];
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

/** Immutable proof that one exact operation scope was accepted or denied. */
export interface KernelApprovalReceipt {
  readonly id: ApprovalReceiptId;
  readonly requestId: ApprovalId;
  readonly capabilityRequestId: CapabilityRequestId;
  readonly profileId: ProfileId;
  readonly runId: RunId;
  readonly environmentId: ExecutionEnvironmentId;
  readonly subjectType: KernelCapabilitySubjectType;
  readonly subjectId: string;
  readonly subjectContentHash?: string;
  readonly operationType: string;
  readonly operationArgumentsHash: string;
  readonly toolVersionHash: string;
  readonly capabilitySetHash: string;
  readonly capability: KernelCapability;
  readonly resourceHandles: readonly string[];
  readonly destinations: readonly string[];
  readonly executableHash?: string;
  readonly dataClasses: readonly string[];
  readonly requiresElevation: boolean;
  readonly policyVersionHash: string;
  readonly decision: KernelApprovalChoice;
  readonly decidedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly auditEventId: AuditEventId;
}

const SAFE_BUILTIN_CAPABILITIES: ReadonlySet<KernelCapability> = new Set(["pure_compute"]);
const ALWAYS_APPROVAL_CAPABILITIES: ReadonlySet<KernelCapability> = new Set([
  "external_side_effect",
  "control_computer",
  "request_admin",
  "access_secret_handle",
]);

function uniqueNormalized(
  values: readonly string[],
  label: string,
  normalizer: (value: string) => string = (value) => value,
): readonly string[] {
  const normalized = values.map((value) => normalizer(assertNonBlank(value, label, 2_048)));
  assertDomain(new Set(normalized).size === normalized.length, "invalid_argument", `${label} values must be unique.`);
  return Object.freeze(normalized);
}

function normalizeDestination(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\/$/, "");
  assertDomain(
    normalized.length > 0 && normalized !== "*" && !normalized.includes("\n") && !normalized.includes("\r"),
    "invalid_argument",
    "Network destinations must be explicit.",
  );
  return normalized;
}

const APPROVAL_CHOICES: ReadonlySet<KernelApprovalChoice> = new Set([
  "allow-once",
  "allow-run",
  "deny",
]);

function assertOptionalExpiry(createdAt: IsoTimestamp, expiresAt: IsoTimestamp | undefined): void {
  assertIsoTimestamp(createdAt, "creation time");
  if (expiresAt === undefined) return;
  assertIsoTimestamp(expiresAt, "expiry time");
  assertDomain(
    Date.parse(expiresAt) > Date.parse(createdAt),
    "invalid_argument",
    "Expiry must be later than creation time.",
  );
}

function freezeConstraint(constraints: CapabilityConstraint): CapabilityConstraint {
  if (constraints.maximumInvocations !== undefined) {
    assertDomain(
      Number.isSafeInteger(constraints.maximumInvocations) && constraints.maximumInvocations > 0,
      "invalid_argument",
      "Maximum invocations must be a positive safe integer.",
    );
  }
  assertDomain(
    constraints.custom === undefined || Object.keys(constraints.custom).length === 0,
    "unsupported_capability",
    "Custom capability constraints require a registered host-side evaluator.",
  );
  if (constraints.allowElevation !== undefined) {
    assertRuntimeBoolean(constraints.allowElevation, "elevation grant");
  }
  return Object.freeze({
    ...(constraints.environmentIds === undefined
      ? {}
      : {
          environmentIds: uniqueNormalized(
            constraints.environmentIds,
            "environment ID",
          ) as readonly ExecutionEnvironmentId[],
        }),
    ...(constraints.resourceHandles === undefined
      ? {}
      : {
          resourceHandles: uniqueNormalized(
            constraints.resourceHandles,
            "resource handle",
            (value) => assertOpaqueResourceHandle(value),
          ),
        }),
    ...(constraints.destinations === undefined
      ? {}
      : {
          destinations: uniqueNormalized(
            constraints.destinations,
            "destination",
            normalizeDestination,
          ),
        }),
    ...(constraints.executableHashes === undefined
      ? {}
      : {
          executableHashes: uniqueNormalized(
            constraints.executableHashes,
            "executable hash",
            (hash) => assertSha256(hash, "executable hash"),
          ),
        }),
    ...(constraints.dataClasses === undefined
      ? {}
      : { dataClasses: uniqueNormalized(constraints.dataClasses, "data class") }),
    ...(constraints.maximumInvocations === undefined
      ? {}
      : { maximumInvocations: constraints.maximumInvocations }),
    ...(constraints.allowElevation === undefined
      ? {}
      : { allowElevation: constraints.allowElevation }),
    ...(constraints.custom === undefined
      ? {}
      : { custom: freezeJson(constraints.custom) }),
  });
}

export function createKernelCapabilityGrant(
  input: KernelCapabilityGrant,
): KernelCapabilityGrant {
  assertOptionalExpiry(input.grantedAt, input.expiresAt);
  const subjectType = assertKernelSubjectType(input.subjectType);
  const capability = assertKernelCapability(input.capability);
  const policyVersionHash = normalizeSha256(
    input.policyVersionHash,
    "capability policy version hash",
  );
  assertDomain(
    subjectType !== "skill-version" && subjectType !== "tool-version"
      ? true
      : input.subjectContentHash !== undefined,
    "invalid_argument",
    "Versioned capability subjects must bind to an immutable content hash.",
  );
  const subjectContentHash = normalizeOptionalSha256(
    input.subjectContentHash,
    "capability subject content hash",
  );
  if (input.revokedAt !== undefined) {
    assertIsoTimestamp(input.revokedAt, "capability revocation time");
    assertDomain(
      Date.parse(input.revokedAt) >= Date.parse(input.grantedAt),
      "invalid_argument",
      "Capability revocation cannot precede the grant.",
    );
  }
  return Object.freeze({
    ...input,
    subjectType,
    subjectId: assertNonBlank(input.subjectId, "capability subject ID", 256),
    ...(subjectContentHash === undefined ? {} : { subjectContentHash }),
    capability,
    constraints: freezeConstraint(input.constraints),
    policyVersionHash,
  });
}

export function createKernelCapabilityRequest(
  input: KernelCapabilityRequest,
): KernelCapabilityRequest {
  assertIsoTimestamp(input.requestedAt, "capability request time");
  const subjectType = assertKernelSubjectType(input.subjectType);
  const capability = assertKernelCapability(input.capability);
  const operationArgumentsHash = normalizeSha256(
    input.operationArgumentsHash,
    "operation arguments hash",
  );
  const toolVersionHash = normalizeSha256(input.toolVersionHash, "tool version hash");
  const capabilitySetHash = normalizeSha256(input.capabilitySetHash, "capability set hash");
  const subjectContentHash = normalizeOptionalSha256(
    input.subjectContentHash,
    "capability subject content hash",
  );
  assertDomain(
    subjectType !== "skill-version" && subjectType !== "tool-version"
      ? true
      : subjectContentHash !== undefined,
    "invalid_argument",
    "Versioned capability requests must bind to an immutable content hash.",
  );
  const executableHash = normalizeOptionalSha256(input.executableHash, "executable hash");
  const requiresElevation = assertRuntimeBoolean(
    input.requiresElevation,
    "capability request elevation flag",
  );
  if (capability === "pure_compute") {
    assertDomain(
      input.resourceHandles.length === 0 &&
        input.destinations.length === 0 &&
        executableHash === undefined &&
        !requiresElevation,
      "scope_violation",
      "Pure compute cannot carry workspace, network, executable, or elevation authority.",
    );
  }
  return Object.freeze({
    ...input,
    subjectType,
    subjectId: assertNonBlank(input.subjectId, "capability subject ID", 256),
    ...(subjectContentHash === undefined ? {} : { subjectContentHash }),
    capability,
    operationType: assertNonBlank(input.operationType, "operation type", 160),
    operationArgumentsHash,
    toolVersionHash,
    capabilitySetHash,
    resourceHandles: uniqueNormalized(input.resourceHandles, "resource handle", (value) =>
      assertOpaqueResourceHandle(value),
    ),
    destinations: uniqueNormalized(input.destinations, "destination", normalizeDestination),
    ...(executableHash === undefined ? {} : { executableHash }),
    dataClasses: uniqueNormalized(input.dataClasses, "data class"),
    requiresElevation,
  });
}

export function isKernelCapabilityGrantActive(
  grant: KernelCapabilityGrant,
  subjectContentHash: string | undefined,
  now: IsoTimestamp,
): boolean {
  assertIsoTimestamp(now, "capability evaluation time");
  if (Date.parse(grant.grantedAt) > Date.parse(now)) return false;
  if (grant.revokedAt !== undefined) return false;
  if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= Date.parse(now)) return false;
  if (grant.subjectContentHash === undefined) return subjectContentHash === undefined;
  return (
    subjectContentHash !== undefined &&
    assertSha256(subjectContentHash, "capability subject content hash") === grant.subjectContentHash
  );
}

function valuesFit(requested: readonly string[], allowed: readonly string[] | undefined): boolean {
  // A missing grant constraint is not an ambient wildcard. Both sides must
  // explicitly agree that this scope dimension is empty, otherwise grants
  // cannot accidentally authorize an omitted/unstated resource.
  if (allowed === undefined) return requested.length === 0;
  const allowedSet = new Set(allowed);
  return requested.every((value) => allowedSet.has(value));
}

function grantMatchesRequest(
  grant: KernelCapabilityGrant,
  request: KernelCapabilityRequest,
): boolean {
  const constraints = grant.constraints;
  if (grant.capability !== request.capability) return false;
  if (grant.subjectType !== request.subjectType || grant.subjectId !== request.subjectId) return false;
  if (!sameOptionalValue(grant.subjectContentHash, request.subjectContentHash)) return false;
  if (
    constraints.environmentIds === undefined ||
    !constraints.environmentIds.includes(request.environmentId)
  ) {
    return false;
  }
  if (!valuesFit(request.resourceHandles, constraints.resourceHandles)) return false;
  if (!valuesFit(request.destinations, constraints.destinations)) return false;
  if (!valuesFit(request.dataClasses, constraints.dataClasses)) return false;
  if (constraints.executableHashes !== undefined) {
    if (request.executableHash === undefined || !constraints.executableHashes.includes(request.executableHash)) {
      return false;
    }
  } else if (request.executableHash !== undefined) {
    // Do not let a request silently introduce an executable scope that the
    // grant never constrained and therefore never reviewed.
    return false;
  }
  if (request.requiresElevation && constraints.allowElevation !== true) return false;
  return true;
}

export function createKernelApprovalRequest(
  input: KernelApprovalRequest,
): KernelApprovalRequest {
  assertOptionalExpiry(input.createdAt, input.expiresAt);
  const subjectType = assertKernelSubjectType(input.subjectType, "approval subject type");
  const subjectContentHash = normalizeOptionalSha256(
    input.subjectContentHash,
    "approval subject content hash",
  );
  assertDomain(
    subjectType !== "skill-version" && subjectType !== "tool-version"
      ? true
      : subjectContentHash !== undefined,
    "invalid_argument",
    "Versioned approval subjects must bind to an immutable content hash.",
  );
  const operationArgumentsHash = normalizeSha256(
    input.operationArgumentsHash,
    "operation arguments hash",
  );
  const toolVersionHash = normalizeSha256(input.toolVersionHash, "tool version hash");
  const capabilitySetHash = normalizeSha256(input.capabilitySetHash, "capability set hash");
  const policyVersionHash = normalizeSha256(
    input.policyVersionHash,
    "approval policy version hash",
  );
  const executableHash = normalizeOptionalSha256(input.executableHash, "executable hash");
  const capability = assertKernelCapability(input.capability, "approval capability");
  const requiresElevation = assertRuntimeBoolean(
    input.requiresElevation,
    "approval elevation flag",
  );
  assertDomain(
    input.choices.length > 0 && input.choices.includes("deny"),
    "invalid_argument",
    "Approval requests must provide an explicit deny choice.",
  );
  assertDomain(
    new Set(input.choices).size === input.choices.length,
    "invalid_argument",
    "Approval choices must be unique.",
  );
  assertDomain(
    input.choices.every((choice) => APPROVAL_CHOICES.has(choice)),
    "invalid_argument",
    "Approval choices contain an unsupported decision.",
  );
  return Object.freeze({
    ...input,
    subjectType,
    subjectId: assertNonBlank(input.subjectId, "approval subject ID", 256),
    ...(subjectContentHash === undefined ? {} : { subjectContentHash }),
    operationType: assertNonBlank(input.operationType, "operation type", 160),
    operationArgumentsHash,
    toolVersionHash,
    capabilitySetHash,
    policyVersionHash,
    capability,
    reason: assertNonBlank(input.reason, "approval reason", 2_000),
    destinations: uniqueNormalized(input.destinations, "destination", normalizeDestination),
    resourceHandles: uniqueNormalized(input.resourceHandles, "resource handle", (value) =>
      assertOpaqueResourceHandle(value),
    ),
    ...(executableHash === undefined ? {} : { executableHash }),
    dataClasses: uniqueNormalized(input.dataClasses, "data class"),
    requiresElevation,
    proposedArgumentsPreview: freezeJson(input.proposedArgumentsPreview),
    choices: Object.freeze([...input.choices]),
  });
}

export interface DecideApprovalInput {
  readonly id: ApprovalReceiptId;
  readonly decision: KernelApprovalChoice;
  readonly operationArgumentsHash: string;
  readonly toolVersionHash: string;
  readonly capabilitySetHash: string;
  readonly environmentId: ExecutionEnvironmentId;
  readonly policyVersionHash: string;
  readonly auditEventId: AuditEventId;
  readonly now: IsoTimestamp;
}

export function decideKernelApproval(
  request: KernelApprovalRequest,
  input: DecideApprovalInput,
): KernelApprovalReceipt {
  assertIsoTimestamp(input.now, "approval decision time");
  assertDomain(
    Date.parse(input.now) >= Date.parse(request.createdAt),
    "invalid_state_transition",
    "Approval cannot be decided before it was created.",
  );
  assertDomain(
    Date.parse(input.now) < Date.parse(request.expiresAt),
    "invalid_state_transition",
    "Approval request has expired.",
  );
  assertDomain(request.choices.includes(input.decision), "invalid_argument", "Approval choice is unavailable.");
  assertDomain(
    request.environmentId === input.environmentId &&
      request.operationArgumentsHash === assertSha256(input.operationArgumentsHash, "operation arguments hash") &&
      request.toolVersionHash === assertSha256(input.toolVersionHash, "tool version hash") &&
      request.capabilitySetHash === assertSha256(input.capabilitySetHash, "capability set hash") &&
      request.policyVersionHash ===
        assertSha256(input.policyVersionHash, "approval policy version hash"),
    "scope_violation",
    "Approval does not apply after a material operation, tool, capability, or environment change.",
  );
  return Object.freeze({
    id: input.id,
    requestId: request.id,
    capabilityRequestId: request.capabilityRequestId,
    profileId: request.profileId,
    runId: request.runId,
    environmentId: request.environmentId,
    subjectType: request.subjectType,
    subjectId: request.subjectId,
    ...(request.subjectContentHash === undefined
      ? {}
      : { subjectContentHash: request.subjectContentHash }),
    operationType: request.operationType,
    operationArgumentsHash: request.operationArgumentsHash,
    toolVersionHash: request.toolVersionHash,
    capabilitySetHash: request.capabilitySetHash,
    capability: request.capability,
    resourceHandles: Object.freeze([...request.resourceHandles]),
    destinations: Object.freeze([...request.destinations]),
    ...(request.executableHash === undefined ? {} : { executableHash: request.executableHash }),
    dataClasses: Object.freeze([...request.dataClasses]),
    requiresElevation: request.requiresElevation,
    policyVersionHash: request.policyVersionHash,
    decision: input.decision,
    decidedAt: input.now,
    expiresAt: request.expiresAt,
    auditEventId: input.auditEventId,
  });
}

function receiptMatchesRequest(
  receipt: KernelApprovalReceipt,
  request: KernelCapabilityRequest,
): boolean {
  return (
    receipt.capabilityRequestId === request.id &&
    receipt.profileId === request.profileId &&
    receipt.runId === request.runId &&
    receipt.environmentId === request.environmentId &&
    receipt.subjectType === request.subjectType &&
    receipt.subjectId === request.subjectId &&
    sameOptionalValue(receipt.subjectContentHash, request.subjectContentHash) &&
    receipt.operationType === request.operationType &&
    receipt.operationArgumentsHash === request.operationArgumentsHash &&
    receipt.toolVersionHash === request.toolVersionHash &&
    receipt.capabilitySetHash === request.capabilitySetHash &&
    receipt.capability === request.capability &&
    receipt.resourceHandles.length === request.resourceHandles.length &&
    receipt.resourceHandles.every((handle, index) => handle === request.resourceHandles[index]) &&
    receipt.destinations.length === request.destinations.length &&
    receipt.destinations.every((destination, index) => destination === request.destinations[index]) &&
    sameOptionalValue(receipt.executableHash, request.executableHash) &&
    receipt.dataClasses.length === request.dataClasses.length &&
    receipt.dataClasses.every((dataClass, index) => dataClass === request.dataClasses[index]) &&
    receipt.requiresElevation === request.requiresElevation
  );
}

function assertKernelApprovalReceipt(receipt: KernelApprovalReceipt): void {
  assertKernelSubjectType(receipt.subjectType, "approval receipt subject type");
  assertNonBlank(receipt.subjectId, "approval receipt subject ID", 256);
  normalizeOptionalSha256(receipt.subjectContentHash, "approval receipt subject content hash");
  assertKernelCapability(receipt.capability, "approval receipt capability");
  assertNonBlank(receipt.operationType, "approval receipt operation type", 160);
  normalizeSha256(receipt.operationArgumentsHash, "approval receipt operation arguments hash");
  normalizeSha256(receipt.toolVersionHash, "approval receipt tool version hash");
  normalizeSha256(receipt.capabilitySetHash, "approval receipt capability set hash");
  normalizeSha256(receipt.policyVersionHash, "approval receipt policy version hash");
  normalizeOptionalSha256(receipt.executableHash, "approval receipt executable hash");
  uniqueNormalized(receipt.resourceHandles, "approval receipt resource handle", (value) =>
    assertOpaqueResourceHandle(value),
  );
  uniqueNormalized(receipt.destinations, "approval receipt destination", normalizeDestination);
  uniqueNormalized(receipt.dataClasses, "approval receipt data class");
  assertRuntimeBoolean(receipt.requiresElevation, "approval receipt elevation flag");
  assertIsoTimestamp(receipt.decidedAt, "approval receipt decision time");
  assertIsoTimestamp(receipt.expiresAt, "approval receipt expiry time");
  assertDomain(
    Date.parse(receipt.expiresAt) > Date.parse(receipt.decidedAt),
    "invalid_argument",
    "Approval receipt expiry must be later than its decision time.",
  );
  assertDomain(
    APPROVAL_CHOICES.has(receipt.decision),
    "invalid_argument",
    "Approval receipt contains an unsupported decision.",
  );
}

export interface EvaluateCapabilityInput {
  readonly request: KernelCapabilityRequest;
  readonly environmentCapabilities: readonly KernelCapability[];
  readonly grants: readonly KernelCapabilityGrant[];
  readonly approvalReceipts: readonly KernelApprovalReceipt[];
  /** Allow-once receipts are reserved atomically before an operation starts. */
  readonly consumedApprovalReceiptIds?: readonly ApprovalReceiptId[];
  /** Durable invocation counts keyed by grant ID, read in the policy transaction. */
  readonly grantInvocationCounts?: Readonly<Record<string, number>>;
  readonly policyVersionHash: string;
  readonly now: IsoTimestamp;
}

/** Trusted-host policy decision. Model output is only an input and never authority. */
export function evaluateKernelCapability(
  input: EvaluateCapabilityInput,
): KernelCapabilityEvaluation {
  assertIsoTimestamp(input.now, "capability evaluation time");
  // Policy entry points are persistence/IPC trust boundaries. Re-run the
  // constructors here so a deserialized or forged object cannot bypass the
  // runtime invariants enforced when requests and grants are first created.
  const request = createKernelCapabilityRequest(input.request);
  const grants = input.grants.map((grant) => createKernelCapabilityGrant(grant));
  assertDomain(
    Date.parse(request.requestedAt) <= Date.parse(input.now),
    "invalid_argument",
    "A capability request cannot be evaluated before it was created.",
  );
  const policyVersionHash = assertSha256(input.policyVersionHash, "capability policy version hash");
  const consumedApprovalReceiptIds = new Set(input.consumedApprovalReceiptIds ?? []);
  assertDomain(
    consumedApprovalReceiptIds.size === (input.consumedApprovalReceiptIds?.length ?? 0),
    "invalid_argument",
    "Consumed approval receipt IDs must be unique.",
  );
  for (const [grantId, invocationCount] of Object.entries(input.grantInvocationCounts ?? {})) {
    assertDomain(
      Number.isSafeInteger(invocationCount) && invocationCount >= 0,
      "invalid_argument",
      "Grant invocation counts must be non-negative safe integers.",
      { grantId, invocationCount },
    );
  }
  const environmentCapabilities = uniqueNormalized(
    input.environmentCapabilities,
    "environment capability",
    (capability) => assertKernelCapability(capability as KernelCapability),
  ) as readonly KernelCapability[];
  for (const receipt of input.approvalReceipts) {
    assertKernelApprovalReceipt(receipt);
  }
  if (!environmentCapabilities.includes(request.capability)) {
    return Object.freeze({
      requestId: request.id,
      decision: "deny",
      reasonCode: "environment-capability-disabled",
      evaluatedAt: input.now,
      policyVersionHash,
    });
  }

  const relevantReceipts = input.approvalReceipts.filter((receipt) => {
    return receiptMatchesRequest(receipt, request);
  });
  const deniedReceipt = relevantReceipts.find(
    (receipt) =>
      receipt.decision === "deny" &&
      receipt.policyVersionHash === policyVersionHash &&
      Date.parse(receipt.decidedAt) <= Date.parse(input.now) &&
      Date.parse(receipt.expiresAt) > Date.parse(input.now),
  );
  if (deniedReceipt !== undefined) {
    return Object.freeze({
      requestId: request.id,
      decision: "deny",
      reasonCode: "denied-by-user",
      matchedApprovalReceiptId: deniedReceipt.id,
      evaluatedAt: input.now,
      policyVersionHash,
    });
  }
  const exactApproval = relevantReceipts.find(
    (receipt) =>
      receipt.decision !== "deny" &&
      receipt.policyVersionHash === policyVersionHash &&
      Date.parse(receipt.decidedAt) <= Date.parse(input.now) &&
      (receipt.decision === "allow-run" || !consumedApprovalReceiptIds.has(receipt.id)) &&
      Date.parse(receipt.expiresAt) > Date.parse(input.now),
  );
  if (exactApproval !== undefined) {
    return Object.freeze({
      requestId: request.id,
      decision: "allow",
      reasonCode: "exact-approval",
      matchedApprovalReceiptId: exactApproval.id,
      evaluatedAt: input.now,
      policyVersionHash,
    });
  }

  const activeGrants = grants.filter(
    (grant) =>
      grant.profileId === request.profileId &&
      grant.policyVersionHash === policyVersionHash &&
      isKernelCapabilityGrantActive(grant, request.subjectContentHash, input.now) &&
      grant.subjectType === request.subjectType &&
      grant.subjectId === request.subjectId &&
      grant.capability === request.capability,
  );
  const constraintMatchingGrants = activeGrants.filter((grant) =>
    grantMatchesRequest(grant, request),
  );
  const matchingGrant = constraintMatchingGrants.find((grant) => {
    const maximumInvocations = grant.constraints.maximumInvocations;
    if (maximumInvocations === undefined) return true;
    return (input.grantInvocationCounts?.[grant.id] ?? 0) < maximumInvocations;
  });

  if (request.requiresElevation || ALWAYS_APPROVAL_CAPABILITIES.has(request.capability)) {
    const approvalReason = relevantReceipts.some(
      (receipt) => receipt.decision === "allow-once" && consumedApprovalReceiptIds.has(receipt.id),
    )
      ? "approval-consumed"
      : relevantReceipts.some(
            (receipt) =>
              receipt.decision !== "deny" &&
              Date.parse(receipt.expiresAt) <= Date.parse(input.now),
          )
        ? "expired-approval"
        : relevantReceipts.some(
              (receipt) =>
                receipt.decision !== "deny" && receipt.policyVersionHash !== policyVersionHash,
            )
          ? "approval-scope-mismatch"
          : request.requiresElevation
            ? "elevation-requires-approval"
            : "approval-required";
    return Object.freeze({
      requestId: request.id,
      decision: "require-approval",
      reasonCode: approvalReason,
      ...(matchingGrant === undefined ? {} : { matchedGrantId: matchingGrant.id }),
      evaluatedAt: input.now,
      policyVersionHash,
    });
  }
  if (SAFE_BUILTIN_CAPABILITIES.has(request.capability)) {
    return Object.freeze({
      requestId: request.id,
      decision: "allow",
      reasonCode: "safe-builtin",
      evaluatedAt: input.now,
      policyVersionHash,
    });
  }
  if (matchingGrant !== undefined) {
    return Object.freeze({
      requestId: request.id,
      decision: "allow",
      reasonCode: "active-grant",
      matchedGrantId: matchingGrant.id,
      evaluatedAt: input.now,
      policyVersionHash,
    });
  }
  return Object.freeze({
    requestId: request.id,
    decision: "deny",
    reasonCode:
      activeGrants.length === 0
        ? "no-active-grant"
        : constraintMatchingGrants.length > 0
          ? "grant-invocation-limit"
          : "grant-constraint-mismatch",
    evaluatedAt: input.now,
    policyVersionHash,
  });
}

export type AuditActorType = "user" | "harness" | "policy" | "tool" | "system";
export type AuditOutcome = "proposed" | "allowed" | "denied" | "succeeded" | "failed" | "cancelled";

export interface AuditEvent {
  readonly schemaVersion: 1;
  readonly id: AuditEventId;
  readonly sequence: number;
  readonly previousEventHash?: string;
  readonly eventHash: string;
  readonly occurredAt: IsoTimestamp;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly runId?: RunId;
  readonly environmentId?: ExecutionEnvironmentId;
  readonly capabilityRequestId?: CapabilityRequestId;
  readonly approvalReceiptId?: ApprovalReceiptId;
  readonly operationArgumentsHash?: string;
  readonly details: JsonObject;
}

export interface AppendAuditEventInput {
  readonly id: AuditEventId;
  readonly eventHash: string;
  readonly occurredAt: IsoTimestamp;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly runId?: RunId;
  readonly environmentId?: ExecutionEnvironmentId;
  readonly capabilityRequestId?: CapabilityRequestId;
  readonly approvalReceiptId?: ApprovalReceiptId;
  readonly operationArgumentsHash?: string;
  readonly details: JsonObject;
}

/**
 * Appends to a hash-linked journal. The caller computes eventHash over the
 * canonical event envelope plus previousEventHash; this function enforces the
 * immutable linkage and monotonic ordering at the domain boundary.
 */
export function appendAuditEvent(
  journal: readonly AuditEvent[],
  input: AppendAuditEventInput,
): readonly AuditEvent[] {
  assertIsoTimestamp(input.occurredAt, "audit event time");
  const eventHash = assertSha256(input.eventHash, "audit event hash");
  const previous = journal.at(-1);
  assertDomain(
    !journal.some((event) => event.id === input.id || event.eventHash === eventHash),
    "conflict",
    "Audit event ID and hash must be unique.",
  );
  if (previous !== undefined) {
    assertDomain(
      Date.parse(input.occurredAt) >= Date.parse(previous.occurredAt),
      "invalid_argument",
      "Audit event time cannot move backwards.",
    );
  }
  if (input.operationArgumentsHash !== undefined) {
    assertSha256(input.operationArgumentsHash, "audit operation arguments hash");
  }
  const event: AuditEvent = Object.freeze({
    schemaVersion: 1,
    id: input.id,
    sequence: previous === undefined ? 1 : previous.sequence + 1,
    ...(previous === undefined ? {} : { previousEventHash: previous.eventHash }),
    eventHash,
    occurredAt: input.occurredAt,
    actorType: input.actorType,
    actorId: assertNonBlank(input.actorId, "audit actor ID", 256),
    action: assertNonBlank(input.action, "audit action", 256),
    outcome: input.outcome,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
    ...(input.capabilityRequestId === undefined
      ? {}
      : { capabilityRequestId: input.capabilityRequestId }),
    ...(input.approvalReceiptId === undefined
      ? {}
      : { approvalReceiptId: input.approvalReceiptId }),
    ...(input.operationArgumentsHash === undefined
      ? {}
      : { operationArgumentsHash: input.operationArgumentsHash }),
    details: freezeJson(input.details),
  });
  return Object.freeze([...journal, event]);
}

export function redactAuditValue(value: JsonValue, secretKeys: readonly string[]): JsonValue {
  const deniedKeys = new Set(secretKeys.map((key) => key.toLowerCase()));
  const walk = (candidate: JsonValue): JsonValue => {
    if (Array.isArray(candidate)) return Object.freeze(candidate.map((entry) => walk(entry)));
    if (candidate !== null && typeof candidate === "object") {
      return Object.freeze(
        Object.fromEntries(
          Object.entries(candidate).map(([key, entry]) => [
            key,
            deniedKeys.has(key.toLowerCase()) ? "[REDACTED]" : walk(entry),
          ]),
        ),
      );
    }
    return candidate;
  };
  return walk(value);
}
