import { assertDomain } from "./errors";
import type { ApprovalId, CapabilityGrantId, ProfileId, RunId } from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  freezeJson,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";
import type { ChatCapability } from "./skill";

export type CapabilitySubjectType = "skill-version" | "workspace" | "provider" | "agent";
export type ApprovalChoice = "allow-once" | "allow-run" | "deny";

export interface CapabilityGrant {
  readonly id: CapabilityGrantId;
  readonly profileId: ProfileId;
  readonly subjectType: CapabilitySubjectType;
  readonly subjectId: string;
  /** Approval is invalidated whenever a versioned subject changes content. */
  readonly subjectContentHash?: string;
  readonly capability: ChatCapability;
  readonly constraints: JsonObject;
  readonly grantedAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
}

export interface ApprovalRequest {
  readonly id: ApprovalId;
  readonly runId: RunId;
  readonly toolCallId: string;
  readonly toolVersionHash: string;
  readonly argumentsHash: string;
  readonly effect: ChatCapability;
  readonly reason: string;
  readonly destination?: string;
  readonly paths: readonly string[];
  readonly dataClasses: readonly string[];
  readonly proposedArgumentsPreview: JsonObject;
  readonly choices: readonly ApprovalChoice[];
  readonly expiresAt: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly decision?: ApprovalChoice;
  readonly decidedAt?: IsoTimestamp;
}

const APPROVAL_CHOICES: ReadonlySet<ApprovalChoice> = new Set([
  "allow-once",
  "allow-run",
  "deny",
]);

function assertValidTimeRange(
  earlier: IsoTimestamp,
  later: IsoTimestamp,
  earlierLabel: string,
  laterLabel: string,
): void {
  assertIsoTimestamp(earlier, earlierLabel);
  assertIsoTimestamp(later, laterLabel);
  assertDomain(
    Date.parse(later) > Date.parse(earlier),
    "invalid_argument",
    `${laterLabel} must be later than ${earlierLabel}.`,
  );
}

export function createCapabilityGrant(input: CapabilityGrant): CapabilityGrant {
  assertNonBlank(input.capability, "capability", 120);
  assertIsoTimestamp(input.grantedAt, "capability grant time");
  assertDomain(
    input.subjectType !== "skill-version" || input.subjectContentHash !== undefined,
    "invalid_argument",
    "Skill capability grants must bind to an immutable content hash.",
  );
  assertDomain(
    input.subjectContentHash === undefined ||
      assertSha256(input.subjectContentHash, "capability subject content hash").length === 64,
    "invalid_argument",
    "Capability subject hash is invalid.",
  );
  if (input.expiresAt !== undefined) {
    assertValidTimeRange(
      input.grantedAt,
      input.expiresAt,
      "capability grant time",
      "capability expiry",
    );
  }
  if (input.revokedAt !== undefined) {
    assertIsoTimestamp(input.revokedAt, "capability revocation time");
    assertDomain(
      Date.parse(input.revokedAt) >= Date.parse(input.grantedAt),
      "invalid_argument",
      "Capability revocation cannot predate the grant.",
    );
  }
  return Object.freeze({
    ...input,
    subjectId: assertNonBlank(input.subjectId, "capability subject ID", 256),
    constraints: freezeJson(input.constraints),
  });
}

export function isCapabilityGrantActive(
  grant: CapabilityGrant,
  subjectContentHash: string | undefined,
  now: IsoTimestamp,
): boolean {
  assertIsoTimestamp(now, "capability evaluation time");
  if (grant.subjectContentHash !== undefined && subjectContentHash !== undefined) {
    assertSha256(subjectContentHash, "capability subject content hash");
  }
  if (grant.revokedAt !== undefined) return false;
  if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= Date.parse(now)) return false;
  if (grant.subjectContentHash !== undefined) {
    return subjectContentHash !== undefined && grant.subjectContentHash === subjectContentHash;
  }
  return true;
}

export function createApprovalRequest(input: ApprovalRequest): ApprovalRequest {
  assertSha256(input.toolVersionHash, "tool version hash");
  assertSha256(input.argumentsHash, "tool arguments hash");
  assertDomain(
    input.choices.length > 0 &&
      input.choices.includes("deny") &&
      new Set(input.choices).size === input.choices.length &&
      input.choices.every((choice) => APPROVAL_CHOICES.has(choice)),
    "invalid_argument",
    "Approval choices must be unique, recognized, and include an explicit deny choice.",
  );
  assertValidTimeRange(
    input.createdAt,
    input.expiresAt,
    "approval creation time",
    "approval expiry",
  );
  assertDomain(
    (input.decision === undefined) === (input.decidedAt === undefined),
    "invalid_argument",
    "Approval decision and decision time must be recorded together.",
  );
  if (input.decision !== undefined && input.decidedAt !== undefined) {
    assertDomain(
      APPROVAL_CHOICES.has(input.decision) && input.choices.includes(input.decision),
      "invalid_argument",
      "The recorded approval decision must be one of the offered choices.",
    );
    assertIsoTimestamp(input.decidedAt, "approval decision time");
    assertDomain(
      Date.parse(input.decidedAt) >= Date.parse(input.createdAt) &&
        Date.parse(input.decidedAt) < Date.parse(input.expiresAt),
      "invalid_argument",
      "Approval decision time must be inside the request validity window.",
    );
  }
  return Object.freeze({
    ...input,
    toolCallId: assertNonBlank(input.toolCallId, "tool call ID", 256),
    reason: assertNonBlank(input.reason, "approval reason", 2_000),
    paths: Object.freeze([...input.paths]),
    dataClasses: Object.freeze([...input.dataClasses]),
    proposedArgumentsPreview: freezeJson(input.proposedArgumentsPreview),
    choices: Object.freeze([...input.choices]),
  });
}

export function decideApproval(
  request: ApprovalRequest,
  decision: ApprovalChoice,
  argumentsHash: string,
  toolVersionHash: string,
  now: IsoTimestamp,
): ApprovalRequest {
  assertIsoTimestamp(now, "approval decision time");
  assertDomain(request.decision === undefined, "conflict", "Approval request has already been decided.");
  assertDomain(Date.parse(now) < Date.parse(request.expiresAt), "invalid_state_transition", "Approval request has expired.");
  assertDomain(request.choices.includes(decision), "invalid_argument", "Approval choice is unavailable.");
  assertDomain(
    request.argumentsHash === assertSha256(argumentsHash, "tool arguments hash") &&
      request.toolVersionHash === assertSha256(toolVersionHash, "tool version hash"),
    "scope_violation",
    "Approval does not apply after material tool or argument changes.",
  );
  return Object.freeze({ ...request, decision, decidedAt: now });
}
