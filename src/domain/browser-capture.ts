import { assertDomain } from "./errors";
import type { BranchId, ConversationId, ProfileId, ProjectId } from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";

/**
 * Browser capture is intentionally a native-owned contract. Renderer code may
 * display these records, but it cannot mint an attachment lease, authorization
 * receipt, observation receipt, or completion receipt.
 */

export type BrowserAttachmentState = "active" | "revoked" | "detached" | "expired";
export type BrowserObservationCapability =
  | "network-metadata"
  | "response-body-stream"
  | "typed-page-actions";

export interface BrowserAttachmentLease {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly profileId: ProfileId;
  readonly browserChannel: "edge-canary";
  readonly browserVersion: string;
  readonly profileDisplayName: string;
  readonly tabTargetId: string;
  readonly tabDisplayTitle: string;
  readonly topLevelOrigin: string;
  readonly epoch: string;
  readonly capabilities: readonly BrowserObservationCapability[];
  readonly credentialBoundary: "browser-contained";
  readonly automationDisclosure: "visible";
  readonly state: BrowserAttachmentState;
  readonly attachedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
}

export interface CreateBrowserAttachmentLeaseInput
  extends Omit<BrowserAttachmentLease, "topLevelOrigin" | "capabilities"> {
  readonly topLevelOrigin: string;
  readonly capabilities: readonly BrowserObservationCapability[];
}

export type CaptureRightsBasis =
  | "publicly-available"
  | "user-owned"
  | "licensed-access"
  | "organization-authorized"
  | "other-explicit-authorization";

export interface CaptureDestinationScope {
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly conversationId?: ConversationId;
  readonly branchId?: BranchId;
}

export interface CaptureAuthorizationAssertions {
  readonly browserAuthorizedResponsesOnly: true;
  readonly protectedContentExcluded: true;
  readonly challengeBypassExcluded: true;
  readonly credentialsRemainInBrowser: true;
  readonly hiddenEndpointMutationExcluded: true;
}

export interface CaptureAuthorizationReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly profileId: ProfileId;
  readonly browserAttachmentId: string;
  readonly browserAttachmentEpoch: string;
  readonly tabTargetId: string;
  readonly destination: CaptureDestinationScope;
  readonly rightsBasis: CaptureRightsBasis;
  readonly contentLabel: string;
  readonly allowedOrigins: readonly string[];
  readonly assertions: CaptureAuthorizationAssertions;
  readonly userPresence: "explicit-job-confirmation";
  readonly policyVersion: string;
  readonly acknowledgedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export type CaptureDiscoveryAction =
  | "scroll-forward"
  | "advance-page"
  | "seek-visible-media"
  | "increase-visible-viewer-zoom";

export interface CaptureQuota {
  readonly maxResources: number;
  readonly maxTotalBytes: number;
  readonly maxSingleResourceBytes: number;
  readonly maxDecodedPixels: number;
  readonly maxDurationMs: number;
  readonly maxTraversalSteps: number;
  readonly maxNoProgressSteps: number;
  readonly maxRequestsPerMinute: number;
  readonly maxConcurrentRequests: number;
  readonly maxRedirectsPerRequest: number;
}

export interface CaptureDiscoveryPolicy {
  readonly schemaVersion: 1;
  readonly mode: "manual" | "typed-browser-actions";
  readonly allowedActions: readonly CaptureDiscoveryAction[];
  readonly challengeBehavior: "pause-for-user";
  readonly automationDisclosure: "always-visible";
  readonly arbitraryScriptInjection: "forbidden";
  readonly unobservedEndpointMutation: "forbidden";
  readonly quota: CaptureQuota;
}

export type CaptureProtectionStatus =
  | "clear"
  | "encrypted"
  | "drm"
  | "challenge"
  | "ambiguous";

export type CaptureProtectionSignal =
  | "none-observed"
  | "hls-key"
  | "hls-session-key"
  | "dash-content-protection"
  | "encrypted-media-extension"
  | "container-encryption-box"
  | "browser-challenge"
  | "access-denied"
  | "parser-uncertain";

export interface CaptureProtectionAssessment {
  readonly status: CaptureProtectionStatus;
  readonly signals: readonly CaptureProtectionSignal[];
  readonly assessorVersion: string;
  readonly assessedAt: IsoTimestamp;
}

export type CaptureSourceRole =
  | "primary"
  | "range"
  | "manifest"
  | "initialization"
  | "media-segment"
  | "page"
  | "tile";

export interface CaptureContentRange {
  readonly start: number;
  readonly endInclusive: number;
  readonly total: number;
}

export interface CaptureValidator {
  readonly kind: "strong-etag" | "immutable-content";
  /** Hash of the validator value. The value itself remains inside the broker. */
  readonly valueSha256: string;
  readonly brokerHandleId: string;
}

export interface CaptureManifestAssessment {
  readonly format: "hls" | "dash";
  readonly kind: "hls-media-playlist" | "dash-static-mpd";
  readonly parserVersion: string;
  readonly manifestContentSha256: string;
  readonly finite: true;
  readonly final: true;
}

export type CaptureQualityEvidence =
  | "original-response"
  | "observed-higher-resolution-response"
  | "visible-viewer-zoom";

/**
 * A redacted native-broker receipt. It has no raw URL, request headers, cookie,
 * authorization value, signed URL, response bytes, or debugging socket.
 */
export interface CaptureSourceReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly browserAttachmentId: string;
  readonly browserAttachmentEpoch: string;
  readonly tabTargetId: string;
  readonly observedAt: IsoTimestamp;
  readonly origin: string;
  readonly redirectOrigins: readonly string[];
  readonly method: "GET";
  readonly responseStatus: 200 | 206;
  readonly mediaType: string;
  readonly expectedBytes?: number;
  readonly requestIdentitySha256: string;
  readonly responseMetadataSha256: string;
  readonly brokerReceiptSha256: string;
  readonly brokerResponseHandleId: string;
  readonly resourceIdentitySha256: string;
  readonly resourceGroupSha256: string;
  readonly role: CaptureSourceRole;
  readonly ordinal?: number;
  readonly contentRange?: CaptureContentRange;
  readonly validator?: CaptureValidator;
  readonly manifest?: CaptureManifestAssessment;
  readonly qualityEvidence?: CaptureQualityEvidence;
  readonly protection: CaptureProtectionAssessment;
  readonly secretHandling: "browser-contained";
}

export interface SingleResponseAssembly {
  readonly kind: "single-response";
  readonly sourceId: string;
  readonly outputFilename: string;
}

export interface ByteRangeAssembly {
  readonly kind: "byte-range";
  readonly sourceIds: readonly string[];
  readonly resourceIdentitySha256: string;
  readonly validatorValueSha256: string;
  readonly totalBytes: number;
  readonly outputFilename: string;
}

export interface SegmentedMediaTrack {
  readonly id: string;
  readonly kind: "audio" | "video" | "muxed";
  readonly initializationSourceId?: string;
  readonly segmentSourceIds: readonly string[];
}

export interface SegmentedMediaAssembly {
  readonly kind: "segmented-media";
  readonly format: "hls" | "dash";
  readonly manifestSourceId: string;
  readonly variantIdentitySha256: string;
  readonly tracks: readonly SegmentedMediaTrack[];
  readonly outputMode: "lossless-remux";
  readonly outputFilename: string;
}

export interface PageTilePlacement {
  readonly sourceId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PagedDocumentPage {
  readonly pageNumber: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly layout: "single-raster" | "tiled-raster";
  readonly sourceIds: readonly string[];
  readonly placements?: readonly PageTilePlacement[];
}

export interface PagedDocumentAssembly {
  readonly kind: "paged-document";
  readonly documentIdentitySha256: string;
  readonly pages: readonly PagedDocumentPage[];
  readonly qualityPolicy: "highest-observed-authorized-variant";
  readonly outputMode: "lossless-image-pdf";
  readonly outputFilename: string;
}

export type CaptureAssembly =
  | SingleResponseAssembly
  | ByteRangeAssembly
  | SegmentedMediaAssembly
  | PagedDocumentAssembly;

export interface CreateAuthorizedCapturePlanInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly authorization: CaptureAuthorizationReceipt;
  readonly browserAttachment: BrowserAttachmentLease;
  readonly discoveryPolicy: CaptureDiscoveryPolicy;
  readonly sources: readonly CaptureSourceReceipt[];
  readonly assembly: CaptureAssembly;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface AuthorizedCapturePlan extends CreateAuthorizedCapturePlanInput {
  readonly orderedSourceIds: readonly string[];
  readonly projectedBytes: number;
}

export interface VerifiedCaptureInput {
  readonly sourceId: string;
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly capturedAt: IsoTimestamp;
}

export interface CaptureToolchainReceipt {
  readonly component: "omnia-native-copy" | "omnia-range-assembler" | "omnia-media-remuxer" | "omnia-page-pdf";
  readonly version: string;
  readonly binarySha256: string;
  readonly argumentsSha256: string;
  readonly sandboxed: true;
  readonly networkDisabled: true;
  readonly lossless: true;
}

export interface CreateCaptureCompletionReceiptInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly planId: string;
  readonly planSha256: string;
  readonly authorizationId: string;
  readonly browserAttachmentId: string;
  readonly browserAttachmentEpoch: string;
  readonly orderedInputs: readonly VerifiedCaptureInput[];
  readonly outputBlobId: string;
  readonly outputFilename: string;
  readonly outputMediaType: string;
  readonly outputContentSha256: string;
  readonly outputByteSize: number;
  readonly toolchain: CaptureToolchainReceipt;
  readonly gaps: readonly never[];
  readonly completedAt: IsoTimestamp;
}

export interface CaptureCompletionReceipt extends CreateCaptureCompletionReceiptInput {
  readonly assemblyKind: CaptureAssembly["kind"];
}

const OBSERVATION_CAPABILITIES: ReadonlySet<BrowserObservationCapability> = new Set([
  "network-metadata",
  "response-body-stream",
  "typed-page-actions",
]);
const ATTACHMENT_STATES: ReadonlySet<BrowserAttachmentState> = new Set([
  "active",
  "revoked",
  "detached",
  "expired",
]);
const RIGHTS_BASES: ReadonlySet<CaptureRightsBasis> = new Set([
  "publicly-available",
  "user-owned",
  "licensed-access",
  "organization-authorized",
  "other-explicit-authorization",
]);
const DISCOVERY_ACTIONS: ReadonlySet<CaptureDiscoveryAction> = new Set([
  "scroll-forward",
  "advance-page",
  "seek-visible-media",
  "increase-visible-viewer-zoom",
]);
const SECRET_LIKE_KEY = /(?:^|_)(?:raw_?)?(?:url|uri|headers?|cookies?|authorization|bearer|password|token|signed_?url|debug_?socket)$/i;
const SAFE_SECRET_LIKE_CONTRACT_PATHS: ReadonlySet<string> = new Set([
  // This is a typed, bounded authorization receipt. It is not an HTTP
  // Authorization header, credential, bearer token, or raw request material.
  "capture input.authorization",
]);
const MAX_RESOURCES = 100_000;
const MAX_TOTAL_BYTES = 1024 ** 4;
const MAX_SINGLE_RESOURCE_BYTES = 64 * 1024 ** 3;
const MAX_DECODED_PIXELS = 2_000_000_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_TRAVERSAL_STEPS = 100_000;
const MAX_REQUESTS_PER_MINUTE = 1_200;
const MAX_CONCURRENT_REQUESTS = 16;
const MAX_REDIRECTS = 10;
const MAX_PAGE_DIMENSION = 100_000;

function assertNoSecretLikeKeys(value: unknown, path = "capture input"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretLikeKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    assertDomain(
      SAFE_SECRET_LIKE_CONTRACT_PATHS.has(entryPath) || !SECRET_LIKE_KEY.test(key),
      "permission_denied",
      "Browser capture contracts cannot contain raw request, credential, or debugging material.",
      { path: entryPath },
    );
    assertNoSecretLikeKeys(entry, entryPath);
  }
}

function normalizeOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    assertDomain(false, "invalid_argument", `${label} must be an absolute HTTPS origin.`, {
      label,
    });
  }
  assertDomain(
    parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      (parsed.pathname === "/" || parsed.pathname === "") &&
      parsed.search === "" &&
      parsed.hash === "",
    "invalid_argument",
    `${label} must contain only an HTTPS scheme, host, and optional port.`,
    { label },
  );
  return parsed.origin;
}

function assertTimeAfter(
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

function assertSafeIntegerInRange(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    "invalid_argument",
    `${label} must be a safe integer between ${minimum} and ${maximum}.`,
    { label, value, minimum, maximum },
  );
  return value;
}

function normalizeMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertDomain(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized),
    "invalid_argument",
    "Captured response media type must be canonical and omit parameters.",
    { mediaType: normalized },
  );
  return normalized;
}

function uniqueStrings(values: readonly string[], label: string): readonly string[] {
  const normalized = values.map((value) => assertNonBlank(value, label, 512));
  assertDomain(
    new Set(normalized).size === normalized.length,
    "conflict",
    `${label} values must be unique.`,
  );
  return Object.freeze(normalized);
}

function freezeDestination(destination: CaptureDestinationScope): CaptureDestinationScope {
  assertDomain(
    destination.branchId === undefined || destination.conversationId !== undefined,
    "invalid_argument",
    "A browser capture branch destination requires a conversation destination.",
  );
  return Object.freeze({ ...destination });
}

function freezeQuota(quota: CaptureQuota): CaptureQuota {
  const frozen = Object.freeze({
    maxResources: assertSafeIntegerInRange(quota.maxResources, "maxResources", 1, MAX_RESOURCES),
    maxTotalBytes: assertSafeIntegerInRange(quota.maxTotalBytes, "maxTotalBytes", 1, MAX_TOTAL_BYTES),
    maxSingleResourceBytes: assertSafeIntegerInRange(
      quota.maxSingleResourceBytes,
      "maxSingleResourceBytes",
      1,
      MAX_SINGLE_RESOURCE_BYTES,
    ),
    maxDecodedPixels: assertSafeIntegerInRange(
      quota.maxDecodedPixels,
      "maxDecodedPixels",
      1,
      MAX_DECODED_PIXELS,
    ),
    maxDurationMs: assertSafeIntegerInRange(quota.maxDurationMs, "maxDurationMs", 1, MAX_DURATION_MS),
    maxTraversalSteps: assertSafeIntegerInRange(
      quota.maxTraversalSteps,
      "maxTraversalSteps",
      0,
      MAX_TRAVERSAL_STEPS,
    ),
    maxNoProgressSteps: assertSafeIntegerInRange(
      quota.maxNoProgressSteps,
      "maxNoProgressSteps",
      0,
      MAX_TRAVERSAL_STEPS,
    ),
    maxRequestsPerMinute: assertSafeIntegerInRange(
      quota.maxRequestsPerMinute,
      "maxRequestsPerMinute",
      1,
      MAX_REQUESTS_PER_MINUTE,
    ),
    maxConcurrentRequests: assertSafeIntegerInRange(
      quota.maxConcurrentRequests,
      "maxConcurrentRequests",
      1,
      MAX_CONCURRENT_REQUESTS,
    ),
    maxRedirectsPerRequest: assertSafeIntegerInRange(
      quota.maxRedirectsPerRequest,
      "maxRedirectsPerRequest",
      0,
      MAX_REDIRECTS,
    ),
  });
  assertDomain(
    frozen.maxSingleResourceBytes <= frozen.maxTotalBytes,
    "invalid_argument",
    "The single-resource byte limit cannot exceed the total byte limit.",
  );
  assertDomain(
    frozen.maxNoProgressSteps <= frozen.maxTraversalSteps,
    "invalid_argument",
    "The no-progress traversal limit cannot exceed the total traversal limit.",
  );
  return frozen;
}

export function createBrowserAttachmentLease(
  input: CreateBrowserAttachmentLeaseInput,
): BrowserAttachmentLease {
  assertNoSecretLikeKeys(input);
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Browser attachment schema is unsupported.");
  assertDomain(
    input.browserChannel === "edge-canary" &&
      input.credentialBoundary === "browser-contained" &&
      input.automationDisclosure === "visible" &&
      ATTACHMENT_STATES.has(input.state),
    "permission_denied",
    "Browser attachment must use the visible Edge Canary broker with browser-contained credentials.",
  );
  assertTimeAfter(input.attachedAt, input.expiresAt, "browser attachment time", "browser attachment expiry");
  if (input.revokedAt !== undefined) {
    assertIsoTimestamp(input.revokedAt, "browser attachment revocation time");
    assertDomain(
      Date.parse(input.revokedAt) >= Date.parse(input.attachedAt),
      "invalid_argument",
      "Browser attachment revocation cannot predate attachment.",
    );
  }
  assertDomain(
    (input.state === "revoked") === (input.revokedAt !== undefined),
    "invalid_argument",
    "A revoked browser attachment must record its revocation time and only a revoked attachment may do so.",
  );
  const capabilities = uniqueStrings(input.capabilities, "browser observation capability") as readonly BrowserObservationCapability[];
  assertDomain(
    capabilities.every((capability) => OBSERVATION_CAPABILITIES.has(capability)),
    "invalid_argument",
    "Browser attachment includes an unknown observation capability.",
  );
  assertDomain(
    capabilities.includes("network-metadata"),
    "unsupported_capability",
    "Browser capture requires bounded network metadata observation.",
  );
  return Object.freeze({
    ...input,
    id: assertNonBlank(input.id, "browser attachment ID", 256),
    browserVersion: assertNonBlank(input.browserVersion, "browser version", 128),
    profileDisplayName: assertNonBlank(input.profileDisplayName, "browser profile display name", 256),
    tabTargetId: assertNonBlank(input.tabTargetId, "browser tab target ID", 256),
    tabDisplayTitle: assertNonBlank(input.tabDisplayTitle, "browser tab display title", 512),
    topLevelOrigin: normalizeOrigin(input.topLevelOrigin, "top-level browser origin"),
    epoch: assertNonBlank(input.epoch, "browser attachment epoch", 256),
    capabilities,
  });
}

export function revokeBrowserAttachmentLease(
  lease: BrowserAttachmentLease,
  revokedAt: IsoTimestamp,
): BrowserAttachmentLease {
  assertIsoTimestamp(revokedAt, "browser attachment revocation time");
  assertDomain(lease.state === "active", "invalid_state_transition", "Only an active browser attachment can be revoked.");
  assertDomain(
    Date.parse(revokedAt) >= Date.parse(lease.attachedAt),
    "invalid_argument",
    "Browser attachment revocation cannot predate attachment.",
  );
  return Object.freeze({ ...lease, state: "revoked", revokedAt });
}

export function createCaptureDiscoveryPolicy(input: CaptureDiscoveryPolicy): CaptureDiscoveryPolicy {
  assertNoSecretLikeKeys(input);
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Capture discovery schema is unsupported.");
  assertDomain(
    (input.mode === "manual" || input.mode === "typed-browser-actions") &&
      input.challengeBehavior === "pause-for-user" &&
      input.automationDisclosure === "always-visible" &&
      input.arbitraryScriptInjection === "forbidden" &&
      input.unobservedEndpointMutation === "forbidden",
    "permission_denied",
    "Capture discovery must remain visible, typed, and unable to bypass challenges or mutate hidden endpoints.",
  );
  const allowedActions = uniqueStrings(input.allowedActions, "capture discovery action") as readonly CaptureDiscoveryAction[];
  assertDomain(
    allowedActions.every((action) => DISCOVERY_ACTIONS.has(action)),
    "invalid_argument",
    "Capture discovery includes an unknown browser action.",
  );
  assertDomain(
    input.mode === "typed-browser-actions" || allowedActions.length === 0,
    "invalid_argument",
    "Manual discovery cannot carry automated browser actions.",
  );
  assertDomain(
    input.mode === "manual" || allowedActions.length > 0,
    "invalid_argument",
    "Typed browser discovery requires at least one bounded action.",
  );
  return Object.freeze({ ...input, allowedActions, quota: freezeQuota(input.quota) });
}

function freezeAuthorization(receipt: CaptureAuthorizationReceipt): CaptureAuthorizationReceipt {
  assertDomain(receipt.schemaVersion === 1, "invalid_argument", "Capture authorization schema is unsupported.");
  assertDomain(
    RIGHTS_BASES.has(receipt.rightsBasis) &&
      receipt.userPresence === "explicit-job-confirmation",
    "permission_denied",
    "Capture authorization requires a recognized rights basis and explicit job confirmation.",
  );
  assertTimeAfter(receipt.acknowledgedAt, receipt.expiresAt, "capture authorization time", "capture authorization expiry");
  const allowedOrigins = Object.freeze(
    [...new Set(receipt.allowedOrigins.map((origin) => normalizeOrigin(origin, "capture allowed origin")))].sort(),
  );
  assertDomain(allowedOrigins.length > 0, "invalid_argument", "Capture authorization requires at least one origin.");
  const assertions = receipt.assertions;
  assertDomain(
    assertions.browserAuthorizedResponsesOnly === true &&
      assertions.protectedContentExcluded === true &&
      assertions.challengeBypassExcluded === true &&
      assertions.credentialsRemainInBrowser === true &&
      assertions.hiddenEndpointMutationExcluded === true,
    "permission_denied",
    "Capture authorization must retain every mandatory safety assertion.",
  );
  return Object.freeze({
    ...receipt,
    id: assertNonBlank(receipt.id, "capture authorization ID", 256),
    browserAttachmentId: assertNonBlank(receipt.browserAttachmentId, "browser attachment ID", 256),
    browserAttachmentEpoch: assertNonBlank(receipt.browserAttachmentEpoch, "browser attachment epoch", 256),
    tabTargetId: assertNonBlank(receipt.tabTargetId, "browser tab target ID", 256),
    destination: freezeDestination(receipt.destination),
    contentLabel: assertNonBlank(receipt.contentLabel, "capture content label", 512),
    allowedOrigins,
    assertions: Object.freeze({ ...assertions }),
    policyVersion: assertNonBlank(receipt.policyVersion, "capture policy version", 128),
  });
}

function freezeProtection(assessment: CaptureProtectionAssessment): CaptureProtectionAssessment {
  assertIsoTimestamp(assessment.assessedAt, "capture protection assessment time");
  const signals = uniqueStrings(assessment.signals, "capture protection signal") as readonly CaptureProtectionSignal[];
  assertDomain(signals.length > 0, "invalid_argument", "Capture protection assessment requires evidence signals.");
  assertDomain(
    assessment.status === "clear" && signals.every((signal) => signal === "none-observed"),
    "permission_denied",
    "Encrypted, DRM-protected, challenged, or ambiguous content cannot enter an authorized capture plan.",
    { protectionStatus: assessment.status, signals },
  );
  return Object.freeze({
    ...assessment,
    signals,
    assessorVersion: assertNonBlank(assessment.assessorVersion, "protection assessor version", 128),
  });
}

function freezeValidator(validator: CaptureValidator): CaptureValidator {
  return Object.freeze({
    ...validator,
    valueSha256: assertSha256(validator.valueSha256, "capture validator hash"),
    brokerHandleId: assertNonBlank(validator.brokerHandleId, "capture validator broker handle", 256),
  });
}

function freezeContentRange(range: CaptureContentRange): CaptureContentRange {
  assertSafeIntegerInRange(range.start, "content range start", 0, Number.MAX_SAFE_INTEGER);
  assertSafeIntegerInRange(range.endInclusive, "content range end", 0, Number.MAX_SAFE_INTEGER);
  assertSafeIntegerInRange(range.total, "content range total", 1, Number.MAX_SAFE_INTEGER);
  assertDomain(
    range.start <= range.endInclusive && range.endInclusive < range.total,
    "invalid_argument",
    "Captured content range must be ordered and remain inside the declared total.",
  );
  return Object.freeze({ ...range });
}

function freezeManifest(manifest: CaptureManifestAssessment): CaptureManifestAssessment {
  assertDomain(
    (manifest.format === "hls" && manifest.kind === "hls-media-playlist") ||
      (manifest.format === "dash" && manifest.kind === "dash-static-mpd"),
    "invalid_argument",
    "Manifest kind does not match its format.",
  );
  assertDomain(
    manifest.finite === true && manifest.final === true,
    "permission_denied",
    "Only finite, final on-demand manifests can enter a frozen capture plan.",
  );
  return Object.freeze({
    ...manifest,
    parserVersion: assertNonBlank(manifest.parserVersion, "manifest parser version", 128),
    manifestContentSha256: assertSha256(manifest.manifestContentSha256, "manifest content hash"),
  });
}

function freezeSource(
  source: CaptureSourceReceipt,
  plan: CreateAuthorizedCapturePlanInput,
  allowedOrigins: ReadonlySet<string>,
): CaptureSourceReceipt {
  assertDomain(source.schemaVersion === 1, "invalid_argument", "Capture source receipt schema is unsupported.");
  assertDomain(
    source.method === "GET" && (source.responseStatus === 200 || source.responseStatus === 206),
    "permission_denied",
    "Capture source receipts are limited to successful browser-observed GET responses.",
    { sourceId: source.id },
  );
  assertDomain(
    source.browserAttachmentId === plan.browserAttachment.id &&
      source.browserAttachmentEpoch === plan.browserAttachment.epoch &&
      source.tabTargetId === plan.browserAttachment.tabTargetId,
    "scope_violation",
    "Capture source receipt belongs to another browser attachment, epoch, or tab.",
    { sourceId: source.id },
  );
  assertIsoTimestamp(source.observedAt, "capture source observation time");
  assertDomain(
    Date.parse(source.observedAt) >= Date.parse(plan.browserAttachment.attachedAt) &&
      Date.parse(source.observedAt) <= Date.parse(plan.createdAt),
    "scope_violation",
    "Capture source observation falls outside the attached browser session or after plan freeze.",
    { sourceId: source.id },
  );
  const origin = normalizeOrigin(source.origin, "capture source origin");
  const redirectOrigins = Object.freeze(source.redirectOrigins.map((candidate) => normalizeOrigin(candidate, "capture redirect origin")));
  assertDomain(
    allowedOrigins.has(origin) && redirectOrigins.every((candidate) => allowedOrigins.has(candidate)),
    "scope_violation",
    "Capture source or redirect origin is outside the exact authorization scope.",
    { sourceId: source.id, origin },
  );
  assertDomain(
    redirectOrigins.length <= plan.discoveryPolicy.quota.maxRedirectsPerRequest,
    "invalid_argument",
    "Capture source exceeds the redirect limit.",
    { sourceId: source.id },
  );
  if (source.expectedBytes !== undefined) {
    assertSafeIntegerInRange(
      source.expectedBytes,
      "capture expected bytes",
      0,
      plan.discoveryPolicy.quota.maxSingleResourceBytes,
    );
  }
  const contentRange = source.contentRange === undefined ? undefined : freezeContentRange(source.contentRange);
  assertDomain(
    (source.responseStatus === 206) === (contentRange !== undefined),
    "invalid_argument",
    "Only a 206 response may carry a content range, and every 206 response must carry one.",
    { sourceId: source.id },
  );
  if (contentRange !== undefined && source.expectedBytes !== undefined) {
    assertDomain(
      source.expectedBytes === contentRange.endInclusive - contentRange.start + 1,
      "invalid_argument",
      "Captured range length does not match the expected response size.",
      { sourceId: source.id },
    );
  }
  const manifest = source.manifest === undefined ? undefined : freezeManifest(source.manifest);
  assertDomain(
    (source.role === "manifest") === (manifest !== undefined),
    "invalid_argument",
    "Exactly manifest-role sources must carry a manifest assessment.",
    { sourceId: source.id },
  );
  if (source.ordinal !== undefined) {
    assertSafeIntegerInRange(source.ordinal, "capture source ordinal", 0, MAX_RESOURCES - 1);
  }
  assertDomain(
    source.secretHandling === "browser-contained",
    "permission_denied",
    "Capture request credentials must remain inside the browser broker.",
  );
  return Object.freeze({
    ...source,
    id: assertNonBlank(source.id, "capture source ID", 256),
    browserAttachmentId: assertNonBlank(source.browserAttachmentId, "browser attachment ID", 256),
    browserAttachmentEpoch: assertNonBlank(source.browserAttachmentEpoch, "browser attachment epoch", 256),
    tabTargetId: assertNonBlank(source.tabTargetId, "browser tab target ID", 256),
    origin,
    redirectOrigins,
    mediaType: normalizeMediaType(source.mediaType),
    requestIdentitySha256: assertSha256(source.requestIdentitySha256, "capture request identity hash"),
    responseMetadataSha256: assertSha256(source.responseMetadataSha256, "capture response metadata hash"),
    brokerReceiptSha256: assertSha256(source.brokerReceiptSha256, "capture broker receipt hash"),
    brokerResponseHandleId: assertNonBlank(source.brokerResponseHandleId, "capture broker response handle", 256),
    resourceIdentitySha256: assertSha256(source.resourceIdentitySha256, "capture resource identity hash"),
    resourceGroupSha256: assertSha256(source.resourceGroupSha256, "capture resource group hash"),
    ...(contentRange === undefined ? {} : { contentRange }),
    ...(source.validator === undefined ? {} : { validator: freezeValidator(source.validator) }),
    ...(manifest === undefined ? {} : { manifest }),
    protection: freezeProtection(source.protection),
  });
}

function sourceById(
  sources: readonly CaptureSourceReceipt[],
): ReadonlyMap<string, CaptureSourceReceipt> {
  const result = new Map(sources.map((source) => [source.id, source]));
  assertDomain(result.size === sources.length, "conflict", "Capture source IDs must be unique.");
  return result;
}

function requireSource(
  sources: ReadonlyMap<string, CaptureSourceReceipt>,
  id: string,
  role?: CaptureSourceRole,
): CaptureSourceReceipt {
  const source = sources.get(id);
  assertDomain(source !== undefined, "not_found", "Capture assembly references an unknown source.", {
    sourceId: id,
  });
  if (role !== undefined) {
    assertDomain(source.role === role, "invalid_argument", "Capture source has the wrong assembly role.", {
      sourceId: id,
      expectedRole: role,
      actualRole: source.role,
    });
  }
  return source;
}

function assertOrdinalsGapFree(sources: readonly CaptureSourceReceipt[], label: string): void {
  const ordinals = sources.map((source) => source.ordinal);
  assertDomain(
    ordinals.every((ordinal) => ordinal !== undefined),
    "invalid_argument",
    `${label} sources require parser-normalized ordinals.`,
  );
  assertDomain(
    ordinals.every((ordinal, index) => ordinal === index),
    "invalid_argument",
    `${label} source ordinals must be gap-free and begin at zero.`,
    { ordinals },
  );
}

function freezeSingleAssembly(
  assembly: SingleResponseAssembly,
  sources: ReadonlyMap<string, CaptureSourceReceipt>,
): { readonly assembly: SingleResponseAssembly; readonly sourceIds: readonly string[] } {
  const sourceId = assertNonBlank(assembly.sourceId, "single capture source ID", 256);
  const source = requireSource(sources, sourceId, "primary");
  assertDomain(
    source.responseStatus === 200 && source.contentRange === undefined,
    "invalid_argument",
    "A single-response assembly requires one complete 200 response.",
  );
  return Object.freeze({
    assembly: Object.freeze({
      ...assembly,
      sourceId,
      outputFilename: assertNonBlank(assembly.outputFilename, "capture output filename", 512),
    }),
    sourceIds: Object.freeze([sourceId]),
  });
}

function freezeRangeAssembly(
  assembly: ByteRangeAssembly,
  sources: ReadonlyMap<string, CaptureSourceReceipt>,
): { readonly assembly: ByteRangeAssembly; readonly sourceIds: readonly string[] } {
  const sourceIds = uniqueStrings(assembly.sourceIds, "range source ID");
  assertDomain(sourceIds.length > 0, "invalid_argument", "Byte-range assembly requires at least one range.");
  const resourceIdentitySha256 = assertSha256(assembly.resourceIdentitySha256, "range resource identity hash");
  const validatorValueSha256 = assertSha256(assembly.validatorValueSha256, "range validator hash");
  const totalBytes = assertSafeIntegerInRange(assembly.totalBytes, "range total bytes", 1, Number.MAX_SAFE_INTEGER);
  let expectedStart = 0;
  for (const sourceId of sourceIds) {
    const source = requireSource(sources, sourceId, "range");
    assertDomain(
      source.responseStatus === 206 &&
        source.contentRange !== undefined &&
        source.validator?.kind === "strong-etag" &&
        source.resourceIdentitySha256 === resourceIdentitySha256 &&
        source.validator.valueSha256 === validatorValueSha256 &&
        source.contentRange.total === totalBytes,
      "invalid_argument",
      "Every byte range must bind to the same resource, strong validator, and total length.",
      { sourceId },
    );
    assertDomain(
      source.contentRange.start === expectedStart,
      "invalid_argument",
      "Byte ranges must be ordered, non-overlapping, and gap-free.",
      { sourceId, expectedStart, actualStart: source.contentRange.start },
    );
    expectedStart = source.contentRange.endInclusive + 1;
  }
  assertDomain(expectedStart === totalBytes, "invalid_argument", "Byte ranges do not cover the declared resource length.");
  return Object.freeze({
    assembly: Object.freeze({
      ...assembly,
      sourceIds,
      resourceIdentitySha256,
      validatorValueSha256,
      totalBytes,
      outputFilename: assertNonBlank(assembly.outputFilename, "capture output filename", 512),
    }),
    sourceIds,
  });
}

function freezeSegmentedAssembly(
  assembly: SegmentedMediaAssembly,
  sources: ReadonlyMap<string, CaptureSourceReceipt>,
): { readonly assembly: SegmentedMediaAssembly; readonly sourceIds: readonly string[] } {
  const manifestSourceId = assertNonBlank(assembly.manifestSourceId, "manifest source ID", 256);
  const manifest = requireSource(sources, manifestSourceId, "manifest");
  assertDomain(
    manifest.manifest?.format === assembly.format,
    "invalid_argument",
    "Segmented assembly format does not match the frozen manifest assessment.",
  );
  assertDomain(assembly.tracks.length > 0 && assembly.tracks.length <= 3, "invalid_argument", "Segmented media requires one to three tracks.");
  const trackIds = new Set<string>();
  const ordered = [manifestSourceId];
  const usedSources = new Set(ordered);
  const tracks = Object.freeze(
    assembly.tracks.map((track) => {
      const id = assertNonBlank(track.id, "media track ID", 256);
      assertDomain(!trackIds.has(id), "conflict", "Segmented media track IDs must be unique.");
      trackIds.add(id);
      const segmentSourceIds = uniqueStrings(track.segmentSourceIds, "media segment source ID");
      assertDomain(segmentSourceIds.length > 0, "invalid_argument", "Every media track requires at least one segment.");
      const segmentSources = segmentSourceIds.map((sourceId) => requireSource(sources, sourceId, "media-segment"));
      assertOrdinalsGapFree(segmentSources, `Track ${id}`);
      const initializationSourceId =
        track.initializationSourceId === undefined
          ? undefined
          : assertNonBlank(track.initializationSourceId, "initialization source ID", 256);
      const ids = initializationSourceId === undefined
        ? segmentSourceIds
        : [initializationSourceId, ...segmentSourceIds];
      if (initializationSourceId !== undefined) requireSource(sources, initializationSourceId, "initialization");
      for (const sourceId of ids) {
        assertDomain(!usedSources.has(sourceId), "conflict", "A segmented source cannot be reused across tracks.", { sourceId });
        usedSources.add(sourceId);
        ordered.push(sourceId);
      }
      return Object.freeze({ ...track, id, ...(initializationSourceId === undefined ? {} : { initializationSourceId }), segmentSourceIds });
    }),
  );
  return Object.freeze({
    assembly: Object.freeze({
      ...assembly,
      manifestSourceId,
      variantIdentitySha256: assertSha256(assembly.variantIdentitySha256, "media variant identity hash"),
      tracks,
      outputFilename: assertNonBlank(assembly.outputFilename, "capture output filename", 512),
    }),
    sourceIds: Object.freeze(ordered),
  });
}

function rectanglesOverlap(left: PageTilePlacement, right: PageTilePlacement): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

function freezePage(
  page: PagedDocumentPage,
  sources: ReadonlyMap<string, CaptureSourceReceipt>,
  documentIdentitySha256: string,
): PagedDocumentPage {
  const pageNumber = assertSafeIntegerInRange(page.pageNumber, "page number", 1, MAX_RESOURCES);
  const pixelWidth = assertSafeIntegerInRange(page.pixelWidth, "page pixel width", 1, MAX_PAGE_DIMENSION);
  const pixelHeight = assertSafeIntegerInRange(page.pixelHeight, "page pixel height", 1, MAX_PAGE_DIMENSION);
  const pixelArea = pixelWidth * pixelHeight;
  assertDomain(Number.isSafeInteger(pixelArea), "invalid_argument", "Page pixel area exceeds the safe integer range.");
  const sourceIds = uniqueStrings(page.sourceIds, "page source ID");
  assertDomain(sourceIds.length > 0, "invalid_argument", "Every document page requires at least one source.");
  const pageSources = sourceIds.map((sourceId) => requireSource(sources, sourceId));
  assertDomain(
    pageSources.every(
      (source) =>
        source.resourceGroupSha256 === documentIdentitySha256 &&
        source.qualityEvidence !== undefined,
    ),
    "scope_violation",
    "Document page sources must belong to the document and carry observed quality evidence.",
    { pageNumber },
  );
  if (page.layout === "single-raster") {
    assertDomain(
      sourceIds.length === 1 && pageSources[0]?.role === "page" && page.placements === undefined,
      "invalid_argument",
      "A single-raster page requires exactly one page source and no tile placements.",
      { pageNumber },
    );
    return Object.freeze({ ...page, pageNumber, pixelWidth, pixelHeight, sourceIds });
  }
  const placements = page.placements;
  assertDomain(
    placements !== undefined && placements.length === sourceIds.length,
    "invalid_argument",
    "A tiled page requires exactly one placement for every tile source.",
    { pageNumber },
  );
  assertDomain(
    pageSources.every((source) => source.role === "tile"),
    "invalid_argument",
    "A tiled page can reference only tile-role sources.",
    { pageNumber },
  );
  const frozenPlacements = Object.freeze(
    placements.map((placement) => {
      const sourceId = assertNonBlank(placement.sourceId, "tile placement source ID", 256);
      assertDomain(sourceIds.includes(sourceId), "scope_violation", "Tile placement references a source outside its page.", { pageNumber, sourceId });
      const x = assertSafeIntegerInRange(placement.x, "tile x", 0, pixelWidth - 1);
      const y = assertSafeIntegerInRange(placement.y, "tile y", 0, pixelHeight - 1);
      const width = assertSafeIntegerInRange(placement.width, "tile width", 1, pixelWidth);
      const height = assertSafeIntegerInRange(placement.height, "tile height", 1, pixelHeight);
      assertDomain(x + width <= pixelWidth && y + height <= pixelHeight, "invalid_argument", "Tile placement exceeds the page canvas.", { pageNumber, sourceId });
      return Object.freeze({ sourceId, x, y, width, height });
    }),
  );
  assertDomain(
    new Set(frozenPlacements.map((placement) => placement.sourceId)).size === sourceIds.length,
    "conflict",
    "Every tile source must have exactly one placement.",
    { pageNumber },
  );
  for (let left = 0; left < frozenPlacements.length; left += 1) {
    for (let right = left + 1; right < frozenPlacements.length; right += 1) {
      const leftPlacement = frozenPlacements[left];
      const rightPlacement = frozenPlacements[right];
      if (leftPlacement === undefined || rightPlacement === undefined) continue;
      assertDomain(!rectanglesOverlap(leftPlacement, rightPlacement), "invalid_argument", "Tile placements cannot overlap.", { pageNumber });
    }
  }
  const coveredArea = frozenPlacements.reduce((sum, placement) => sum + placement.width * placement.height, 0);
  assertDomain(coveredArea === pixelArea, "invalid_argument", "Tile placements must cover the entire page without gaps.", { pageNumber, coveredArea, pixelArea });
  return Object.freeze({ ...page, pageNumber, pixelWidth, pixelHeight, sourceIds, placements: frozenPlacements });
}

function freezePagedAssembly(
  assembly: PagedDocumentAssembly,
  sources: ReadonlyMap<string, CaptureSourceReceipt>,
  quota: CaptureQuota,
): { readonly assembly: PagedDocumentAssembly; readonly sourceIds: readonly string[]; readonly decodedPixels: number } {
  const documentIdentitySha256 = assertSha256(assembly.documentIdentitySha256, "document identity hash");
  assertDomain(assembly.pages.length > 0, "invalid_argument", "Paged document assembly requires at least one page.");
  const pages = Object.freeze(assembly.pages.map((page) => freezePage(page, sources, documentIdentitySha256)));
  assertDomain(
    pages.every((page, index) => page.pageNumber === index + 1),
    "invalid_argument",
    "Document page numbers must be gap-free and begin at one.",
  );
  const decodedPixels = pages.reduce((sum, page) => sum + page.pixelWidth * page.pixelHeight, 0);
  assertDomain(decodedPixels <= quota.maxDecodedPixels, "invalid_argument", "Paged document exceeds the decoded-pixel budget.", { decodedPixels, limit: quota.maxDecodedPixels });
  const sourceIds = Object.freeze(pages.flatMap((page) => page.sourceIds));
  assertDomain(new Set(sourceIds).size === sourceIds.length, "conflict", "A page or tile source cannot be reused across document pages.");
  return Object.freeze({
    assembly: Object.freeze({
      ...assembly,
      documentIdentitySha256,
      pages,
      outputFilename: assertNonBlank(assembly.outputFilename, "capture output filename", 512),
    }),
    sourceIds,
    decodedPixels,
  });
}

function freezeAssembly(
  assembly: CaptureAssembly,
  sources: ReadonlyMap<string, CaptureSourceReceipt>,
  quota: CaptureQuota,
): { readonly assembly: CaptureAssembly; readonly sourceIds: readonly string[]; readonly decodedPixels: number } {
  switch (assembly.kind) {
    case "single-response": {
      const result = freezeSingleAssembly(assembly, sources);
      return Object.freeze({ ...result, decodedPixels: 0 });
    }
    case "byte-range": {
      const result = freezeRangeAssembly(assembly, sources);
      return Object.freeze({ ...result, decodedPixels: 0 });
    }
    case "segmented-media": {
      assertDomain(
        assembly.outputMode === "lossless-remux" &&
          (assembly.format === "hls" || assembly.format === "dash"),
        "permission_denied",
        "Segmented capture supports only HLS/DASH lossless remux plans.",
      );
      const result = freezeSegmentedAssembly(assembly, sources);
      return Object.freeze({ ...result, decodedPixels: 0 });
    }
    case "paged-document":
      assertDomain(
        assembly.qualityPolicy === "highest-observed-authorized-variant" &&
          assembly.outputMode === "lossless-image-pdf",
        "permission_denied",
        "Paged capture supports only the highest observed authorized variant and lossless image-PDF assembly.",
      );
      return freezePagedAssembly(assembly, sources, quota);
  }
}

export function createAuthorizedCapturePlan(
  input: CreateAuthorizedCapturePlanInput,
): AuthorizedCapturePlan {
  assertNoSecretLikeKeys(input);
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Authorized capture plan schema is unsupported.");
  assertTimeAfter(input.createdAt, input.expiresAt, "capture plan creation time", "capture plan expiry");
  const browserAttachment = createBrowserAttachmentLease(input.browserAttachment);
  assertDomain(browserAttachment.state === "active", "permission_denied", "Browser attachment is not active.");
  assertDomain(
    Date.parse(input.createdAt) >= Date.parse(browserAttachment.attachedAt) &&
      Date.parse(input.createdAt) < Date.parse(browserAttachment.expiresAt),
    "permission_denied",
    "Capture plan was not created inside the active browser attachment lease.",
  );
  const authorization = freezeAuthorization(input.authorization);
  assertDomain(
    authorization.profileId === browserAttachment.profileId &&
      authorization.destination.profileId === authorization.profileId &&
      authorization.browserAttachmentId === browserAttachment.id &&
      authorization.browserAttachmentEpoch === browserAttachment.epoch &&
      authorization.tabTargetId === browserAttachment.tabTargetId,
    "scope_violation",
    "Capture authorization does not bind to the exact profile, browser attachment, epoch, and tab.",
  );
  assertDomain(
    Date.parse(input.createdAt) >= Date.parse(authorization.acknowledgedAt) &&
      Date.parse(input.createdAt) < Date.parse(authorization.expiresAt) &&
      Date.parse(input.expiresAt) <= Date.parse(authorization.expiresAt) &&
      Date.parse(input.expiresAt) <= Date.parse(browserAttachment.expiresAt),
    "permission_denied",
    "Capture plan lifetime exceeds its browser attachment or authorization lease.",
  );
  assertDomain(
    authorization.allowedOrigins.includes(browserAttachment.topLevelOrigin),
    "scope_violation",
    "Capture authorization must include the attached tab's top-level origin.",
  );
  const discoveryPolicy = createCaptureDiscoveryPolicy(input.discoveryPolicy);
  assertDomain(
    discoveryPolicy.mode !== "typed-browser-actions" ||
      browserAttachment.capabilities.includes("typed-page-actions"),
    "unsupported_capability",
    "The browser attachment does not support typed discovery actions.",
  );
  assertDomain(
    browserAttachment.capabilities.includes("response-body-stream"),
    "unsupported_capability",
    "The browser attachment does not support bounded response-body streaming.",
  );
  assertDomain(
    input.sources.length > 0 && input.sources.length <= discoveryPolicy.quota.maxResources,
    "invalid_argument",
    "Capture plan must contain a bounded nonempty source set.",
  );
  const allowedOrigins = new Set(authorization.allowedOrigins);
  const sources = Object.freeze(input.sources.map((source) => freezeSource(source, input, allowedOrigins)));
  const sourceMap = sourceById(sources);
  const frozenAssembly = freezeAssembly(input.assembly, sourceMap, discoveryPolicy.quota);
  assertDomain(
    frozenAssembly.sourceIds.length === sources.length &&
      frozenAssembly.sourceIds.every((sourceId) => sourceMap.has(sourceId)),
    "scope_violation",
    "A frozen capture plan cannot carry unreferenced or omitted source receipts.",
  );
  let projectedBytes = 0;
  for (const source of sources) {
    const reservation = source.expectedBytes ?? discoveryPolicy.quota.maxSingleResourceBytes;
    projectedBytes += reservation;
    assertDomain(Number.isSafeInteger(projectedBytes), "invalid_argument", "Projected capture size exceeds the safe integer range.");
  }
  assertDomain(
    projectedBytes <= discoveryPolicy.quota.maxTotalBytes,
    "invalid_argument",
    "Capture plan exceeds the total byte budget.",
    { projectedBytes, limit: discoveryPolicy.quota.maxTotalBytes },
  );
  return Object.freeze({
    ...input,
    id: assertNonBlank(input.id, "capture plan ID", 256),
    authorization,
    browserAttachment,
    discoveryPolicy,
    sources,
    assembly: frozenAssembly.assembly,
    orderedSourceIds: frozenAssembly.sourceIds,
    projectedBytes,
  });
}

function expectedToolchainComponent(kind: CaptureAssembly["kind"]): CaptureToolchainReceipt["component"] {
  switch (kind) {
    case "single-response":
      return "omnia-native-copy";
    case "byte-range":
      return "omnia-range-assembler";
    case "segmented-media":
      return "omnia-media-remuxer";
    case "paged-document":
      return "omnia-page-pdf";
  }
}

export function createCaptureCompletionReceipt(
  plan: AuthorizedCapturePlan,
  input: CreateCaptureCompletionReceiptInput,
): CaptureCompletionReceipt {
  assertNoSecretLikeKeys(input);
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Capture completion schema is unsupported.");
  assertDomain(
    input.planId === plan.id &&
      input.authorizationId === plan.authorization.id &&
      input.browserAttachmentId === plan.browserAttachment.id &&
      input.browserAttachmentEpoch === plan.browserAttachment.epoch,
    "scope_violation",
    "Capture completion receipt does not bind to the exact plan, authorization, browser attachment, and epoch.",
  );
  assertIsoTimestamp(input.completedAt, "capture completion time");
  assertDomain(
    Date.parse(input.completedAt) >= Date.parse(plan.createdAt) &&
      Date.parse(input.completedAt) <= Date.parse(plan.expiresAt),
    "permission_denied",
    "Capture completion falls outside the authorized plan lifetime.",
  );
  assertDomain(input.gaps.length === 0, "invalid_argument", "A complete capture receipt cannot contain unresolved gaps.");
  assertDomain(
    input.orderedInputs.length === plan.orderedSourceIds.length &&
      input.orderedInputs.every((candidate, index) => candidate.sourceId === plan.orderedSourceIds[index]),
    "scope_violation",
    "Capture completion inputs must exactly match the frozen plan order.",
  );
  const orderedInputs = Object.freeze(
    input.orderedInputs.map((candidate) => {
      assertIsoTimestamp(candidate.capturedAt, "capture input time");
      assertDomain(
        Date.parse(candidate.capturedAt) >= Date.parse(plan.createdAt) &&
          Date.parse(candidate.capturedAt) <= Date.parse(input.completedAt),
        "scope_violation",
        "Captured input timestamp falls outside the plan execution window.",
        { sourceId: candidate.sourceId },
      );
      assertSafeIntegerInRange(candidate.byteSize, "captured input bytes", 0, plan.discoveryPolicy.quota.maxSingleResourceBytes);
      return Object.freeze({
        ...candidate,
        sourceId: assertNonBlank(candidate.sourceId, "capture input source ID", 256),
        contentSha256: assertSha256(candidate.contentSha256, "capture input content hash"),
      });
    }),
  );
  const inputBytes = orderedInputs.reduce((sum, candidate) => sum + candidate.byteSize, 0);
  assertDomain(inputBytes <= plan.discoveryPolicy.quota.maxTotalBytes, "invalid_argument", "Verified capture inputs exceed the frozen byte budget.");
  const outputByteSize = assertSafeIntegerInRange(input.outputByteSize, "capture output bytes", 0, plan.discoveryPolicy.quota.maxTotalBytes);
  const expectedComponent = expectedToolchainComponent(plan.assembly.kind);
  assertDomain(
    input.toolchain.component === expectedComponent &&
      input.toolchain.sandboxed === true &&
      input.toolchain.networkDisabled === true &&
      input.toolchain.lossless === true,
    "permission_denied",
    "Capture output was not produced by the frozen lossless, sandboxed, network-disabled toolchain.",
    { expectedComponent, actualComponent: input.toolchain.component },
  );
  const toolchain = Object.freeze({
    ...input.toolchain,
    version: assertNonBlank(input.toolchain.version, "capture toolchain version", 128),
    binarySha256: assertSha256(input.toolchain.binarySha256, "capture toolchain binary hash"),
    argumentsSha256: assertSha256(input.toolchain.argumentsSha256, "capture toolchain arguments hash"),
  });
  const outputContentSha256 = assertSha256(input.outputContentSha256, "capture output content hash");
  if (plan.assembly.kind === "single-response") {
    const source = orderedInputs[0];
    assertDomain(
      source !== undefined && source.contentSha256 === outputContentSha256 && source.byteSize === outputByteSize,
      "invalid_argument",
      "Identity-copy output must exactly match the captured source bytes.",
    );
  }
  if (plan.assembly.kind === "byte-range") {
    assertDomain(outputByteSize === plan.assembly.totalBytes, "invalid_argument", "Assembled byte-range output length is incorrect.");
  }
  return Object.freeze({
    ...input,
    id: assertNonBlank(input.id, "capture completion receipt ID", 256),
    planSha256: assertSha256(input.planSha256, "capture plan hash"),
    orderedInputs,
    outputBlobId: assertNonBlank(input.outputBlobId, "capture output blob ID", 256),
    outputFilename: assertNonBlank(input.outputFilename, "capture output filename", 512),
    outputMediaType: normalizeMediaType(input.outputMediaType),
    outputContentSha256,
    outputByteSize,
    toolchain,
    gaps: Object.freeze([]),
    assemblyKind: plan.assembly.kind,
  });
}
