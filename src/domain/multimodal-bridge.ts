import { assertDomain } from "./errors";
import type { IsoTimestamp } from "./shared";
import { assertIsoTimestamp, assertNonBlank, assertSha256 } from "./shared";

/**
 * A resolved bridge mode is never `auto`. `auto` is a request preference and
 * is intentionally absent from this union so a persisted plan cannot remain
 * ambiguous at dispatch time.
 */
export const MULTIMODAL_BRIDGE_MODES = [
  "direct-native",
  "local-transform",
  "specialist-bridge-model",
  "hybrid-ensemble",
  "surrogate-to-primary",
  "human-review",
  "unsupported",
] as const;

export type MultimodalBridgeMode = (typeof MULTIMODAL_BRIDGE_MODES)[number];

export const MULTIMODAL_BRIDGE_REQUEST_MODES = [
  "auto",
  ...MULTIMODAL_BRIDGE_MODES,
  "local-only",
  "direct-only",
  "cheapest",
  "highest-quality",
  "manual",
] as const;

export type MultimodalBridgeRequestMode =
  (typeof MULTIMODAL_BRIDGE_REQUEST_MODES)[number];

export type BridgeDisposition =
  | "ready"
  | "ready-with-degradation"
  | "review-required"
  | "blocked"
  | "failed"
  | "unsupported";

export type BridgeDataBoundary =
  | "local-only"
  | "approved-provider"
  | "mixed"
  | "denied"
  | "review-required";

export type BridgeEgressDecision =
  | "not-required"
  | "approved"
  | "denied"
  | "review-required";

export type BridgeArtifactModality =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "archive"
  | "code"
  | "structured-data"
  | "scientific-artifact";

export type BridgeFidelityProfile =
  | "semantic-and-visual"
  | "semantic-only"
  | "render-required"
  | "model-specific"
  | "unknown";

export type BridgeCapabilitySupport =
  | "documented-native"
  | "model-gated"
  | "adapter-gated"
  | "bridge-required"
  | "unsupported"
  | "unknown";

export type BridgeCapabilityFreshness =
  | "live-probe"
  | "cached-fresh"
  | "cached-stale"
  | "manual"
  | "unknown";

export type BridgeFidelityDimension =
  | "integrity"
  | "content"
  | "structural"
  | "layout"
  | "spatial"
  | "temporal"
  | "semantic"
  | "numeric"
  | "formula"
  | "code"
  | "citation"
  | "accessibility"
  | "provenance";

export type BridgeReasonCode =
  | "native-capability-exact-match"
  | "native-capability-missing"
  | "native-capability-stale"
  | "native-capability-model-mismatch"
  | "native-capability-mime-mismatch"
  | "native-capability-size-limit"
  | "native-capability-not-native"
  | "native-fidelity-insufficient"
  | "provider-egress-approved"
  | "provider-egress-denied"
  | "provider-egress-not-approved"
  | "provider-boundary-local-only"
  | "provider-egress-review-required"
  | "local-transform-approved"
  | "local-transform-disabled"
  | "local-fidelity-sufficient"
  | "local-fidelity-degraded"
  | "local-fidelity-insufficient"
  | "specialist-bridge-approved"
  | "specialist-bridge-unavailable"
  | "specialist-fidelity-insufficient"
  | "hybrid-verification-approved"
  | "surrogate-primary-approved"
  | "human-review-required"
  | "requested-mode-restricts-candidate"
  | "higher-ranked-route-selected"
  | "requested-unsupported"
  | "data-class-not-approved"
  | "policy-denies-all-routes"
  | "capability-replan-required";

export interface BridgeSourceArtifact {
  /** Stable native attachment/artifact ID, never a path or provider file ID. */
  readonly artifactId: string;
  /** Leaf filename only; directory separators are rejected. */
  readonly filename: string;
  readonly mediaType: string;
  readonly modality: BridgeArtifactModality;
  readonly byteSize: number;
  readonly contentSha256: string;
  /** Page/cell/slide/frame/time/region selector, not a filesystem location. */
  readonly sourceSelector: string;
  readonly dataClasses: readonly string[];
}

export interface BridgeCapabilityClaim {
  readonly modality: BridgeArtifactModality;
  readonly supportLevel: BridgeCapabilitySupport;
  readonly modelScope: "all-advertised" | "model-family" | "model-snapshot" | "runtime-profile" | "backend-model" | "none" | "unknown";
  readonly modelSelectors: readonly string[];
  readonly allowedMediaTypes: readonly string[];
  readonly maxBytes: number | null;
  readonly fidelity: BridgeFidelityProfile;
  readonly evidenceIds: readonly string[];
}

export interface BridgeSpecialistRoute {
  readonly providerProfileRevisionId: string;
  readonly operationId: string;
  readonly modelProfileRevisionId: string;
  readonly apiVersion: string;
  readonly supportedModalities: readonly BridgeArtifactModality[];
  readonly fidelity: BridgeFidelityProfile;
  readonly evidenceIds: readonly string[];
}

export interface BridgeCapabilitySnapshot {
  readonly snapshotId: string;
  readonly providerProfileRevisionId: string;
  readonly operationId: string;
  readonly modelProfileRevisionId: string;
  readonly apiVersion: string;
  readonly observedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp | null;
  readonly freshness: BridgeCapabilityFreshness;
  readonly claims: readonly BridgeCapabilityClaim[];
  readonly specialistBridge?: BridgeSpecialistRoute;
}

export interface BridgePolicy {
  readonly revisionId: string;
  readonly dataBoundary: BridgeDataBoundary;
  readonly egressDecision: BridgeEgressDecision;
  readonly allowedDataClasses: readonly string[];
  readonly allowLocalTransforms: boolean;
  readonly allowSpecialistBridge: boolean;
  readonly allowHybridVerification: boolean;
  readonly allowSurrogateToPrimary: boolean;
  readonly allowHumanReview: boolean;
  /** Declared capability of the approved local transform toolchain. */
  readonly localTransformFidelity?: BridgeFidelityProfile;
  readonly approvalReceiptId: string | null;
}

export interface BridgeFidelityRequirement {
  readonly decisiveDimensions: readonly BridgeFidelityDimension[];
  readonly allowDegradation: boolean;
  readonly requireHumanReviewOnAmbiguity: boolean;
}

export interface CreateMultimodalBridgePlanInput {
  readonly schemaVersion: 1;
  readonly requestedMode: MultimodalBridgeRequestMode;
  readonly artifacts: readonly BridgeSourceArtifact[];
  readonly capabilitySnapshot: BridgeCapabilitySnapshot;
  readonly policy: BridgePolicy;
  readonly fidelity: BridgeFidelityRequirement;
  /** Digest of the frozen source manifest, not source bytes or a path. */
  readonly sourceManifestDigest: string;
  readonly now: IsoTimestamp;
}

export interface BridgeRejectedAlternative {
  readonly mode: MultimodalBridgeMode;
  readonly reasonCodes: readonly BridgeReasonCode[];
}

export type BridgeStageKind =
  | "admit"
  | "direct-deliver"
  | "local-transform"
  | "specialist-bridge"
  | "hybrid-verify"
  | "surrogate-package"
  | "primary-deliver"
  | "human-review";

export interface BridgeStagePlan {
  readonly stageId: string;
  readonly kind: BridgeStageKind;
  readonly dependsOn: readonly string[];
  readonly artifactIds: readonly string[];
  readonly boundary: "local-only" | "approved-provider" | "human-review";
  readonly preservesOriginals: true;
  readonly outputIsUntrustedData: true;
  readonly cancellationBoundary: "before-dispatch" | "cooperative" | "reconcile-required" | "human-gate";
}

export interface MultimodalBridgePlan {
  readonly schemaVersion: 1;
  readonly contractRevision: 2;
  readonly requestedMode: MultimodalBridgeRequestMode;
  readonly resolvedMode: MultimodalBridgeMode;
  readonly disposition: BridgeDisposition;
  readonly sourceArtifacts: readonly BridgeSourceArtifact[];
  readonly sourceManifestDigest: string;
  readonly capabilitySnapshotId: string;
  readonly providerProfileRevisionId: string | null;
  readonly operationId: string | null;
  readonly modelProfileRevisionId: string | null;
  readonly apiVersion: string | null;
  /** Explicit bridge destination; never presented as target-model native support. */
  readonly bridgeDestination: BridgeSpecialistRoute | null;
  readonly policyRevisionId: string;
  readonly dataBoundary: BridgeDataBoundary;
  readonly egressDecision: BridgeEgressDecision;
  readonly candidateSetDigest: string;
  readonly selectedReasonCodes: readonly BridgeReasonCode[];
  readonly rejectedAlternatives: readonly BridgeRejectedAlternative[];
  readonly stages: readonly BridgeStagePlan[];
  readonly decisiveFidelityDimensions: readonly BridgeFidelityDimension[];
  readonly fidelityProfile: BridgeFidelityProfile;
  readonly originalsPreserved: true;
  readonly untrustedDataTreatment: "data-not-control";
  readonly providerWirePayload: null;
  readonly createdAt: IsoTimestamp;
}

/**
 * Trusted MIME-to-modality mapping shared by the planning and renderer
 * projection boundaries. Canonical syntax alone is insufficient here: an
 * arbitrary `application/*` value must not be allowed to smuggle a caller
 * supplied modality into a route decision. Image/audio/video families follow
 * the native admission rule; all other modalities are intentionally exact.
 */
const EXACT_MEDIA_TYPE_MODALITIES = new Map<string, BridgeArtifactModality>([
  ["application/pdf", "pdf"],
  ["application/msword", "document"],
  ["application/rtf", "document"],
  ["application/vnd.oasis.opendocument.text", "document"],
  ["application/vnd.oasis.opendocument.presentation", "document"],
  ["application/vnd.ms-powerpoint", "document"],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "document",
  ],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "document",
  ],
  ["text/html", "document"],
  ["text/markdown", "document"],
  ["text/plain", "document"],
  ["text/rtf", "document"],
  ["application/vnd.ms-excel", "spreadsheet"],
  ["application/vnd.oasis.opendocument.spreadsheet", "spreadsheet"],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "spreadsheet",
  ],
  ["text/csv", "spreadsheet"],
  ["text/tab-separated-values", "spreadsheet"],
  ["application/gzip", "archive"],
  ["application/vnd.rar", "archive"],
  ["application/x-7z-compressed", "archive"],
  ["application/x-rar-compressed", "archive"],
  ["application/x-tar", "archive"],
  ["application/zip", "archive"],
  ["application/javascript", "code"],
  ["application/sql", "code"],
  ["application/typescript", "code"],
  ["application/x-httpd-php", "code"],
  ["application/x-sh", "code"],
  ["text/css", "code"],
  ["text/javascript", "code"],
  ["text/x-c", "code"],
  ["text/x-c++", "code"],
  ["text/x-csharp", "code"],
  ["text/x-go", "code"],
  ["text/x-java-source", "code"],
  ["text/x-python", "code"],
  ["text/x-rust", "code"],
  ["text/x-sql", "code"],
  ["application/x-hdf5", "scientific-artifact"],
  ["application/x-netcdf", "scientific-artifact"],
  ["chemical/x-pdb", "scientific-artifact"],
  ["application/json", "structured-data"],
  ["application/ld+json", "structured-data"],
  ["application/xml", "structured-data"],
  ["application/yaml", "structured-data"],
  ["application/x-yaml", "structured-data"],
  ["text/xml", "structured-data"],
  ["text/yaml", "structured-data"],
]);

/**
 * Returns the modality trusted for one canonical MIME value, or null when the
 * value is syntactically valid but intentionally unclassified. This is kept
 * exported so renderer projections can apply the same fail-closed registry
 * without duplicating or drifting from the planner's admission rule.
 */
export function bridgeModalityForMediaType(
  mediaType: string,
): BridgeArtifactModality | null {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return EXACT_MEDIA_TYPE_MODALITIES.get(mediaType) ?? null;
}

const LEAF_NAME_PATTERN = /^[^\\/\u0000]+$/;
const SELECTOR_MAX_LENGTH = 512;
const ID_MAX_LENGTH = 512;
const SOURCE_SELECTOR_KINDS = new Set([
  "region",
  "page",
  "sheet",
  "cell",
  "range",
  "slide",
  "frame",
  "time",
  "byte",
  "symbol",
  "member",
]);
const SOURCE_SELECTOR_PAYLOAD_PATTERN = /^[A-Za-z0-9._~:@=,+;()[\]{}%-]+$/;
const SOURCE_SELECTOR_FORBIDDEN_PATTERN = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

function normalizeId(value: string, label: string): string {
  const normalized = assertNonBlank(value, label, ID_MAX_LENGTH);
  assertDomain(
    /^[a-z0-9][a-z0-9._:-]*$/i.test(normalized),
    "invalid_argument",
    `${label} must be an opaque identifier, not a URL, path, or free-form value.`,
    { label },
  );
  return normalized;
}

function normalizeMediaType(value: string): string {
  const normalized = value;
  assertDomain(
    normalized.length <= 255 &&
    normalized === normalized.trim() &&
      normalized === normalized.toLowerCase() &&
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized),
    "invalid_argument",
    "Bridge artifact media type must be a canonical MIME type.",
    { mediaType: value },
  );
  return normalized;
}

/**
 * Source coordinates are native-owned metadata, never a URL or filesystem
 * path. Keep this grammar intentionally identical to the renderer projection
 * and the native Rust validator: only typed coordinate segments are allowed.
 */
function normalizeSourceSelector(value: string): string {
  const selector = assertNonBlank(value, "bridge source selector", SELECTOR_MAX_LENGTH);
  assertDomain(
    !SOURCE_SELECTOR_FORBIDDEN_PATTERN.test(selector),
    "scope_violation",
    "Bridge source selector may not contain control or bidirectional override characters.",
  );
  if (selector === "full") return selector;
  for (const segment of selector.split("/")) {
    const separator = segment.indexOf(":");
    const kind = separator < 0 ? "" : segment.slice(0, separator);
    const payload = separator < 0 ? "" : segment.slice(separator + 1);
    assertDomain(
      SOURCE_SELECTOR_KINDS.has(kind) &&
        payload.length > 0 &&
        SOURCE_SELECTOR_PAYLOAD_PATTERN.test(payload) &&
        /[A-Za-z0-9]/.test(payload),
      "scope_violation",
      "Bridge source selector must use the canonical native coordinate grammar, not a filesystem path or URL.",
      { sourceSelector: selector },
    );
  }
  return selector;
}

function normalizeAllowedMediaType(value: string): string {
  const normalized = value;
  assertDomain(
    normalized.length <= 255 &&
      normalized === normalized.trim() &&
      normalized === normalized.toLowerCase() &&
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*|\*)$/.test(
        normalized,
      ) &&
      normalized !== "*/*",
    "invalid_argument",
    "Bridge capability media type must be exact or a bounded family wildcard.",
    { mediaType: value },
  );
  return normalized;
}

function normalizeArtifact(artifact: BridgeSourceArtifact): BridgeSourceArtifact {
  const filename = assertNonBlank(artifact.filename, "bridge artifact filename", 512);
  assertDomain(LEAF_NAME_PATTERN.test(filename), "invalid_argument", "Bridge artifact filename must be a leaf name without a path.", { filename });
  const sourceSelector = normalizeSourceSelector(artifact.sourceSelector);
  assertDomain(Number.isSafeInteger(artifact.byteSize) && artifact.byteSize >= 0, "invalid_argument", "Bridge artifact byte size must be a non-negative safe integer.", { artifactId: artifact.artifactId });
  const mediaType = normalizeMediaType(artifact.mediaType);
  const trustedModality = bridgeModalityForMediaType(mediaType);
  assertDomain(
    trustedModality !== null,
    "invalid_argument",
    "Bridge artifact media type is not mapped to a trusted native modality.",
    { artifactId: artifact.artifactId, mediaType },
  );
  assertDomain(
    trustedModality === artifact.modality,
    "invalid_argument",
    "Bridge artifact modality does not match its canonical media type.",
    {
      artifactId: artifact.artifactId,
      mediaType,
      declaredModality: artifact.modality,
      trustedModality,
    },
  );
  const dataClasses = Object.freeze(
    [...new Set(artifact.dataClasses.map((value) => assertNonBlank(value, "bridge data class", ID_MAX_LENGTH)))].sort(),
  );
  assertDomain(dataClasses.length > 0, "invalid_argument", "Every bridge artifact requires at least one data class.", { artifactId: artifact.artifactId });
  return Object.freeze({
    ...artifact,
    artifactId: normalizeId(artifact.artifactId, "bridge artifact ID"),
    filename,
    mediaType,
    contentSha256: assertSha256(artifact.contentSha256, "bridge artifact content hash"),
    sourceSelector,
    dataClasses,
  });
}

function normalizeClaim(claim: BridgeCapabilityClaim): BridgeCapabilityClaim {
  const allowedMediaTypes = Object.freeze(
    [...new Set(claim.allowedMediaTypes.map(normalizeAllowedMediaType))].sort(),
  );
  const modelSelectors = Object.freeze(claim.modelSelectors.map((value) => normalizeId(value, "capability model selector")));
  const evidenceIds = Object.freeze(claim.evidenceIds.map((value) => normalizeId(value, "capability evidence ID")));
  assertDomain(evidenceIds.length > 0, "invalid_argument", "Every bridge capability claim requires evidence.", { modality: claim.modality });
  assertDomain(
    allowedMediaTypes.length > 0 ||
      claim.supportLevel === "unsupported" ||
      claim.supportLevel === "unknown",
    "invalid_argument",
    "A usable bridge capability claim requires at least one media type.",
    { modality: claim.modality },
  );
  assertDomain(claim.maxBytes === null || (Number.isSafeInteger(claim.maxBytes) && claim.maxBytes >= 0), "invalid_argument", "Capability maxBytes must be null or a non-negative safe integer.", { modality: claim.modality });
  return Object.freeze({ ...claim, allowedMediaTypes, modelSelectors, evidenceIds });
}

function normalizeSnapshot(snapshot: BridgeCapabilitySnapshot): BridgeCapabilitySnapshot {
  assertIsoTimestamp(snapshot.observedAt, "bridge capability observedAt");
  if (snapshot.expiresAt !== null) assertIsoTimestamp(snapshot.expiresAt, "bridge capability expiresAt");
  const claims = Object.freeze(snapshot.claims.map(normalizeClaim));
  assertDomain(new Set(claims.map((claim) => claim.modality)).size === claims.length, "conflict", "A bridge capability snapshot cannot declare duplicate modality claims.");
  const specialistBridge =
    snapshot.specialistBridge === undefined
      ? undefined
      : Object.freeze({
          ...snapshot.specialistBridge,
          providerProfileRevisionId: normalizeId(
            snapshot.specialistBridge.providerProfileRevisionId,
            "specialist provider profile revision ID",
          ),
          operationId: normalizeId(
            snapshot.specialistBridge.operationId,
            "specialist operation ID",
          ),
          modelProfileRevisionId: normalizeId(
            snapshot.specialistBridge.modelProfileRevisionId,
            "specialist model profile revision ID",
          ),
          apiVersion: normalizeId(
            snapshot.specialistBridge.apiVersion,
            "specialist API version",
          ),
          supportedModalities: Object.freeze([
            ...new Set(snapshot.specialistBridge.supportedModalities),
          ]),
          evidenceIds: Object.freeze(
            snapshot.specialistBridge.evidenceIds.map((value) =>
              normalizeId(value, "specialist evidence ID"),
            ),
          ),
        });
  if (specialistBridge !== undefined) {
    assertDomain(
      specialistBridge.supportedModalities.length > 0 &&
        specialistBridge.evidenceIds.length > 0,
      "invalid_argument",
      "A specialist bridge route requires modalities and evidence.",
    );
  }
  return Object.freeze({
    ...snapshot,
    snapshotId: normalizeId(snapshot.snapshotId, "bridge capability snapshot ID"),
    providerProfileRevisionId: normalizeId(snapshot.providerProfileRevisionId, "provider profile revision ID"),
    operationId: normalizeId(snapshot.operationId, "bridge operation ID"),
    modelProfileRevisionId: normalizeId(snapshot.modelProfileRevisionId, "model profile revision ID"),
    apiVersion: normalizeId(snapshot.apiVersion, "bridge API version"),
    claims,
    ...(specialistBridge === undefined ? {} : { specialistBridge }),
  });
}

function normalizePolicy(policy: BridgePolicy): BridgePolicy {
  const allowedDataClasses = Object.freeze([...new Set(policy.allowedDataClasses.map((value) => normalizeId(value, "allowed data class")))].sort());
  if (policy.approvalReceiptId !== null) normalizeId(policy.approvalReceiptId, "approval receipt ID");
  assertDomain(
    policy.egressDecision !== "approved" || policy.approvalReceiptId !== null,
    "permission_denied",
    "Approved provider egress requires an approval receipt reference.",
  );
  assertDomain(
    policy.dataBoundary !== "denied" || policy.egressDecision !== "approved",
    "invalid_argument",
    "A denied data boundary cannot approve provider egress.",
  );
  return Object.freeze({ ...policy, revisionId: normalizeId(policy.revisionId, "bridge policy revision ID"), allowedDataClasses });
}

function normalizeFidelity(requirement: BridgeFidelityRequirement): BridgeFidelityRequirement {
  const decisiveDimensions = Object.freeze([...new Set(requirement.decisiveDimensions)]);
  assertDomain(decisiveDimensions.length > 0, "invalid_argument", "Bridge fidelity requires at least one decisive dimension.");
  return Object.freeze({ ...requirement, decisiveDimensions });
}

function mediaTypeAllowed(mediaType: string, allowed: readonly string[]): boolean {
  const [family] = mediaType.split("/");
  return allowed.some((candidate) => candidate === mediaType || candidate === `${family}/*`);
}

function snapshotIsStale(snapshot: BridgeCapabilitySnapshot, now: IsoTimestamp): boolean {
  const expired = snapshot.expiresAt !== null && Date.parse(snapshot.expiresAt) <= Date.parse(now);
  return expired || snapshot.freshness === "cached-stale" || snapshot.freshness === "unknown";
}

function claimMatchesModel(claim: BridgeCapabilityClaim, modelProfileRevisionId: string): boolean {
  if (claim.modelScope === "all-advertised") return true;
  if (claim.modelScope === "none" || claim.modelScope === "unknown") return false;
  return claim.modelSelectors.includes(modelProfileRevisionId);
}

function claimsForArtifacts(snapshot: BridgeCapabilitySnapshot, artifacts: readonly BridgeSourceArtifact[], now: IsoTimestamp): { claims: readonly BridgeCapabilityClaim[]; reasonCodes: readonly BridgeReasonCode[] } {
  const reasons: BridgeReasonCode[] = [];
  const stale = snapshotIsStale(snapshot, now);
  if (stale) reasons.push("native-capability-stale");
  const claims: BridgeCapabilityClaim[] = [];
  for (const artifact of artifacts) {
    const claim = snapshot.claims.find((candidate) => candidate.modality === artifact.modality);
    if (claim === undefined) {
      reasons.push("native-capability-missing");
      continue;
    }
    claims.push(claim);
    if (!claimMatchesModel(claim, snapshot.modelProfileRevisionId)) {
      reasons.push("native-capability-model-mismatch");
    }
    if (!mediaTypeAllowed(artifact.mediaType, claim.allowedMediaTypes)) {
      reasons.push("native-capability-mime-mismatch");
    }
    if (claim.maxBytes !== null && artifact.byteSize > claim.maxBytes) {
      reasons.push("native-capability-size-limit");
    }
    if (
      claim.supportLevel !== "documented-native" &&
      claim.supportLevel !== "model-gated"
    ) {
      reasons.push("native-capability-not-native");
    }
  }
  return {
    claims: Object.freeze(claims),
    reasonCodes: Object.freeze([...new Set(reasons)]),
  };
}

function providerAllowed(policy: BridgePolicy, artifacts: readonly BridgeSourceArtifact[]): BridgeReasonCode | null {
  if (policy.egressDecision === "denied") return "provider-egress-denied";
  if (policy.egressDecision === "review-required") return "provider-egress-review-required";
  if (policy.egressDecision !== "approved") return "provider-egress-not-approved";
  if (policy.dataBoundary === "local-only") return "provider-boundary-local-only";
  const approved = new Set(policy.allowedDataClasses);
  if (artifacts.some((artifact) => artifact.dataClasses.some((dataClass) => !approved.has(dataClass)))) return "data-class-not-approved";
  return null;
}

function evaluateFidelity(profile: BridgeFidelityProfile, requirement: BridgeFidelityRequirement): "ready" | "degraded" | "insufficient" {
  const visualDimensions = new Set<BridgeFidelityDimension>(["layout", "spatial", "temporal", "accessibility"]);
  const requiresVisual = requirement.decisiveDimensions.some((dimension) => visualDimensions.has(dimension));
  if (profile === "semantic-and-visual" || profile === "render-required") return "ready";
  if (!requiresVisual) return "ready";
  return requirement.allowDegradation ? "degraded" : "insufficient";
}

function fingerprint(parts: readonly string[]): string {
  // This is a deterministic routing fingerprint, not a security/integrity hash.
  let hash = 2166136261;
  for (const part of parts.join("|").normalize("NFKC")) {
    hash ^= part.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `route-fp-v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stage(stageId: string, kind: BridgeStageKind, artifactIds: readonly string[], boundary: BridgeStagePlan["boundary"], dependsOn: readonly string[] = [], cancellationBoundary: BridgeStagePlan["cancellationBoundary"] = "before-dispatch"): BridgeStagePlan {
  return Object.freeze({
    stageId,
    kind,
    dependsOn: Object.freeze([...dependsOn]),
    artifactIds: Object.freeze([...artifactIds]),
    boundary,
    preservesOriginals: true,
    outputIsUntrustedData: true,
    cancellationBoundary,
  });
}

function candidateStages(mode: MultimodalBridgeMode, artifacts: readonly BridgeSourceArtifact[], planKey: string): readonly BridgeStagePlan[] {
  const artifactIds = artifacts.map((artifact) => artifact.artifactId);
  const admit = stage(`${planKey}-admit`, "admit", artifactIds, "local-only");
  switch (mode) {
    case "direct-native":
      return Object.freeze([admit, stage(`${planKey}-direct-deliver`, "direct-deliver", artifactIds, "approved-provider", [admit.stageId], "reconcile-required")]);
    case "local-transform":
      return Object.freeze([admit, stage(`${planKey}-local-transform`, "local-transform", artifactIds, "local-only", [admit.stageId], "cooperative")]);
    case "specialist-bridge-model":
      return Object.freeze([admit, stage(`${planKey}-specialist-bridge`, "specialist-bridge", artifactIds, "approved-provider", [admit.stageId], "reconcile-required")]);
    case "hybrid-ensemble":
      return Object.freeze([admit, stage(`${planKey}-local-transform`, "local-transform", artifactIds, "local-only", [admit.stageId], "cooperative"), stage(`${planKey}-hybrid-verify`, "hybrid-verify", artifactIds, "approved-provider", [`${planKey}-local-transform`], "reconcile-required")]);
    case "surrogate-to-primary":
      return Object.freeze([
        admit,
        stage(
          `${planKey}-local-transform`,
          "local-transform",
          artifactIds,
          "local-only",
          [admit.stageId],
          "cooperative",
        ),
        stage(
          `${planKey}-surrogate-package`,
          "surrogate-package",
          artifactIds,
          "local-only",
          [`${planKey}-local-transform`],
          "before-dispatch",
        ),
        stage(
          `${planKey}-primary-deliver`,
          "primary-deliver",
          artifactIds,
          "approved-provider",
          [`${planKey}-surrogate-package`],
          "reconcile-required",
        ),
      ]);
    case "human-review":
      return Object.freeze([admit, stage(`${planKey}-human-review`, "human-review", artifactIds, "human-review", [admit.stageId], "human-gate")]);
    case "unsupported":
      return Object.freeze([admit]);
  }
}

function explicitModeAllowed(requestedMode: MultimodalBridgeRequestMode, mode: MultimodalBridgeMode): boolean {
  if (requestedMode === "auto" || requestedMode === "cheapest" || requestedMode === "highest-quality") return true;
  if (requestedMode === "local-only") return mode === "local-transform" || mode === "surrogate-to-primary";
  if (requestedMode === "direct-only") return mode === "direct-native";
  if (requestedMode === "manual") return mode === "human-review";
  return requestedMode === mode;
}

function routeDisposition(mode: MultimodalBridgeMode, fidelityResult: "ready" | "degraded" | "insufficient", requirement: BridgeFidelityRequirement): BridgeDisposition {
  if (mode === "unsupported") return "unsupported";
  if (mode === "human-review") return "review-required";
  if (fidelityResult === "degraded") return requirement.allowDegradation ? "ready-with-degradation" : "review-required";
  if (fidelityResult === "insufficient") return "review-required";
  return "ready";
}

/**
 * Resolves a concrete, byte-free multimodal bridge plan. The planner only
 * reasons over immutable metadata and capability/policy snapshots; native
 * storage and provider adapters remain responsible for reading bytes after a
 * fresh authority check. Artifact-derived text is always untrusted data.
 */
export function createMultimodalBridgePlan(input: CreateMultimodalBridgePlanInput): MultimodalBridgePlan {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported multimodal bridge plan schema version.");
  assertIsoTimestamp(input.now, "bridge plan now");
  const artifacts = Object.freeze(input.artifacts.map(normalizeArtifact));
  assertDomain(artifacts.length > 0, "invalid_argument", "A multimodal bridge plan requires at least one source artifact.");
  assertDomain(new Set(artifacts.map((artifact) => artifact.artifactId)).size === artifacts.length, "conflict", "Bridge source artifact IDs must be unique.");
  const snapshot = normalizeSnapshot(input.capabilitySnapshot);
  const policy = normalizePolicy(input.policy);
  const fidelity = normalizeFidelity(input.fidelity);
  const sourceManifestDigest = assertSha256(input.sourceManifestDigest, "bridge source manifest digest");
  const nativeResult = claimsForArtifacts(snapshot, artifacts, input.now);
  const stale = snapshotIsStale(snapshot, input.now);
  const nativeAvailable =
    nativeResult.claims.length === artifacts.length &&
    nativeResult.reasonCodes.length === 0 &&
    !stale &&
    nativeResult.claims.every(
      (claim) =>
        claim.supportLevel === "documented-native" ||
        claim.supportLevel === "model-gated",
    );
  const providerBlock = providerAllowed(policy, artifacts);
  const localTransformFidelity = policy.localTransformFidelity ?? "semantic-only";
  const localFidelityResult = evaluateFidelity(localTransformFidelity, fidelity);
  const specialist = snapshot.specialistBridge;
  const specialistAvailable =
    specialist !== undefined &&
    !stale &&
    artifacts.every((artifact) =>
      specialist.supportedModalities.includes(artifact.modality),
    );
  const specialistFidelityResult =
    specialist === undefined
      ? "insufficient"
      : evaluateFidelity(specialist.fidelity, fidelity);
  const localAvailable =
    policy.allowLocalTransforms &&
    policy.dataBoundary !== "denied" &&
    policy.dataBoundary !== "review-required";
  const candidates: Array<{ mode: MultimodalBridgeMode; reasonCodes: readonly BridgeReasonCode[]; fidelityResult: "ready" | "degraded" | "insufficient" }> = [];
  const add = (mode: MultimodalBridgeMode, reasonCodes: readonly BridgeReasonCode[], fidelityResult: "ready" | "degraded" | "insufficient") => {
    if (explicitModeAllowed(input.requestedMode, mode)) candidates.push({ mode, reasonCodes: Object.freeze([...reasonCodes]), fidelityResult });
  };
  const nativeFidelityResult = nativeResult.claims.reduce<
    "ready" | "degraded" | "insufficient"
  >((current, claim) => {
    const next = evaluateFidelity(claim.fidelity, fidelity);
    if (current === "insufficient" || next === "insufficient") return "insufficient";
    if (current === "degraded" || next === "degraded") return "degraded";
    return "ready";
  }, "ready");
  if (
    nativeAvailable &&
    nativeFidelityResult !== "insufficient" &&
    providerBlock === null
  ) {
    add(
      "direct-native",
      ["native-capability-exact-match", "provider-egress-approved"],
      nativeFidelityResult,
    );
  }
  if (localAvailable && localFidelityResult !== "insufficient") add("local-transform", ["local-transform-approved", localFidelityResult === "degraded" ? "local-fidelity-degraded" : "local-fidelity-sufficient"], localFidelityResult);
  if (
    specialistAvailable &&
    specialistFidelityResult !== "insufficient" &&
    policy.allowSpecialistBridge &&
    providerBlock === null
  ) {
    add(
      "specialist-bridge-model",
      ["specialist-bridge-approved", "provider-egress-approved"],
      specialistFidelityResult,
    );
  }
  if (
    localAvailable &&
    specialistAvailable &&
    policy.allowHybridVerification &&
    providerBlock === null
  ) {
    add("hybrid-ensemble", ["hybrid-verification-approved", "provider-egress-approved"], "ready");
  }
  if (localAvailable && policy.allowSurrogateToPrimary && providerBlock === null) add("surrogate-to-primary", ["surrogate-primary-approved", "local-transform-approved", "provider-egress-approved"], localFidelityResult);
  if (
    policy.allowHumanReview &&
    (fidelity.requireHumanReviewOnAmbiguity || candidates.length === 0)
  ) {
    add(
      "human-review",
      ["human-review-required"],
      "degraded",
    );
  }

  const modeOrder: readonly MultimodalBridgeMode[] =
    input.requestedMode === "cheapest"
      ? ["local-transform", "surrogate-to-primary", "direct-native", "specialist-bridge-model", "hybrid-ensemble", "human-review", "unsupported"]
      : input.requestedMode === "highest-quality"
        ? ["hybrid-ensemble", "direct-native", "specialist-bridge-model", "local-transform", "surrogate-to-primary", "human-review", "unsupported"]
        : ["direct-native", "hybrid-ensemble", "specialist-bridge-model", "local-transform", "surrogate-to-primary", "human-review", "unsupported"];
  candidates.sort((left, right) => modeOrder.indexOf(left.mode) - modeOrder.indexOf(right.mode));
  const selected = candidates[0];
  const rejectedAlternatives: BridgeRejectedAlternative[] = [];
  for (const mode of MULTIMODAL_BRIDGE_MODES) {
    if (selected?.mode === mode) continue;
    const candidate = candidates.find((entry) => entry.mode === mode);
    if (candidate !== undefined) {
      rejectedAlternatives.push({
        mode,
        reasonCodes: Object.freeze(["higher-ranked-route-selected"]),
      });
    }
    else {
      const reasons: BridgeReasonCode[] = [];
      if (mode === "direct-native") {
        reasons.push(
          ...nativeResult.reasonCodes,
          ...(nativeFidelityResult === "insufficient"
            ? (["native-fidelity-insufficient"] satisfies BridgeReasonCode[])
            : []),
          ...(providerBlock === null ? [] : [providerBlock]),
        );
      }
      if (mode === "local-transform" || mode === "surrogate-to-primary") {
        const localReasons: BridgeReasonCode[] = localAvailable
          ? localFidelityResult === "insufficient"
            ? ["local-fidelity-insufficient"]
            : []
          : ["local-transform-disabled"];
        reasons.push(...localReasons);
      }
      if (mode === "specialist-bridge-model" || mode === "hybrid-ensemble") {
        const specialistReasons: BridgeReasonCode[] = specialistAvailable
          ? specialistFidelityResult === "insufficient"
            ? ["specialist-fidelity-insufficient"]
            : []
          : stale
            ? ["native-capability-stale"]
            : ["specialist-bridge-unavailable"];
        reasons.push(
          ...specialistReasons,
          ...(providerBlock === null ? [] : [providerBlock]),
        );
      }
      if (mode === "human-review" && !policy.allowHumanReview) reasons.push("human-review-required");
      if (!explicitModeAllowed(input.requestedMode, mode)) reasons.push("requested-mode-restricts-candidate");
      if (reasons.length === 0) reasons.push("capability-replan-required");
      rejectedAlternatives.push({ mode, reasonCodes: Object.freeze([...new Set(reasons)]) });
    }
  }
  const resolvedMode: MultimodalBridgeMode = selected?.mode ?? "unsupported";
  const selectedReasonCodes: readonly BridgeReasonCode[] = Object.freeze(
    selected?.reasonCodes.length
      ? [...selected.reasonCodes]
      : input.requestedMode === "unsupported"
        ? ["requested-unsupported"]
        : ([
            "policy-denies-all-routes",
            ...(providerBlock === null ? [] : [providerBlock]),
          ] satisfies BridgeReasonCode[]),
  );
  const disposition = routeDisposition(resolvedMode, selected?.fidelityResult ?? "insufficient", fidelity);
  const providerRoute = resolvedMode === "direct-native" || resolvedMode === "specialist-bridge-model" || resolvedMode === "hybrid-ensemble" || resolvedMode === "surrogate-to-primary";
  const candidateSetDigest = fingerprint([
    input.requestedMode,
    snapshot.snapshotId,
    snapshot.operationId,
    snapshot.modelProfileRevisionId,
    policy.revisionId,
    sourceManifestDigest,
    ...rejectedAlternatives.flatMap((alternative) => [alternative.mode, ...alternative.reasonCodes]),
  ]);
  const stages = candidateStages(resolvedMode, artifacts, candidateSetDigest);
  const usesSpecialist =
    resolvedMode === "specialist-bridge-model" ||
    resolvedMode === "hybrid-ensemble";
  return Object.freeze({
    schemaVersion: 1,
    contractRevision: 2,
    requestedMode: input.requestedMode,
    resolvedMode,
    disposition,
    sourceArtifacts: artifacts,
    sourceManifestDigest,
    capabilitySnapshotId: snapshot.snapshotId,
    providerProfileRevisionId: providerRoute ? snapshot.providerProfileRevisionId : null,
    operationId: providerRoute ? snapshot.operationId : null,
    modelProfileRevisionId: providerRoute ? snapshot.modelProfileRevisionId : null,
    apiVersion: providerRoute ? snapshot.apiVersion : null,
    bridgeDestination:
      usesSpecialist && specialist !== undefined ? specialist : null,
    policyRevisionId: policy.revisionId,
    dataBoundary: providerRoute ? (policy.dataBoundary === "local-only" ? "mixed" : policy.dataBoundary) : "local-only",
    egressDecision: providerRoute ? policy.egressDecision : "not-required",
    candidateSetDigest,
    selectedReasonCodes,
    rejectedAlternatives: Object.freeze(rejectedAlternatives.map((alternative) => Object.freeze({ ...alternative }))),
    stages,
    decisiveFidelityDimensions: fidelity.decisiveDimensions,
    fidelityProfile:
      resolvedMode === "direct-native"
        ? nativeResult.claims[0]?.fidelity ?? "unknown"
        : usesSpecialist
          ? specialist?.fidelity ?? "unknown"
          : localTransformFidelity,
    originalsPreserved: true,
    untrustedDataTreatment: "data-not-control",
    providerWirePayload: null,
    createdAt: input.now,
  });
}
