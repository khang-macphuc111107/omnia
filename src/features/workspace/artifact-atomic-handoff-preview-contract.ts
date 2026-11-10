/**
 * Renderer-local contract for an artifact -> destination handoff.
 *
 * The native artifact/attachment transaction is the authority. This module
 * only freezes the visible source revision, target scope and idempotency
 * material so the UI can rehearse the same checks before a future native
 * bind command exists. The fingerprint is intentionally not a security hash.
 */

export const ARTIFACT_ATOMIC_HANDOFF_SCHEMA = "omnia.artifact-atomic-handoff.preview.v1" as const;
export const ARTIFACT_ATOMIC_HANDOFF_TYPE = "artifact.bind-to-target" as const;

export type ArtifactAtomicTargetKind = "chat-message" | "project-library" | "bridge-plan";
export type ArtifactAtomicCheckState = "pass" | "review" | "blocked";
export type ArtifactAtomicPreflightStatus = "ready" | "review" | "blocked";

export interface ArtifactAtomicTarget {
  readonly kind: ArtifactAtomicTargetKind;
  readonly projectId: string;
  readonly targetId: string;
  readonly conversationId: string;
  readonly branchId: string;
  readonly modelProfileRevisionId: string;
}

export interface ArtifactAtomicHandoffPreview {
  readonly schema: typeof ARTIFACT_ATOMIC_HANDOFF_SCHEMA;
  readonly operationType: typeof ARTIFACT_ATOMIC_HANDOFF_TYPE;
  readonly operationId: string;
  /** Exactly one immutable source artifact revision is staged in this slice. */
  readonly sourceArtifactIds: readonly [string];
  readonly sourceRevision: number;
  readonly target: ArtifactAtomicTarget;
  /** Stable across retries for the same source revision and target intent. */
  readonly idempotencyKey: string;
  readonly phase: "ready";
  readonly outcome: "pending";
  readonly boundary: string;
}

export interface ArtifactAtomicHandoffInput {
  readonly artifactId: string;
  readonly revision: number;
  readonly target: ArtifactAtomicTarget;
  readonly now?: number;
}

export interface ArtifactAtomicPreflightCheck {
  readonly id:
    | "source-identity"
    | "source-revision"
    | "exact-source-set"
    | "project-scope"
    | "target-identity"
    | "chat-scope"
    | "bridge-model"
    | "native-receipt";
  readonly label: string;
  readonly state: ArtifactAtomicCheckState;
  readonly detail: string;
}

export interface ArtifactAtomicPreflight {
  readonly status: ArtifactAtomicPreflightStatus;
  readonly canStagePreview: boolean;
  readonly checks: readonly ArtifactAtomicPreflightCheck[];
  readonly blockingReason: string | null;
  readonly boundary: string;
}

export const ARTIFACT_ATOMIC_HANDOFF_BOUNDARY =
  "Renderer-local atomic handoff rehearsal only; no native artifact bind, durable revision, provider bridge, filesystem write, or receipt was created.";

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required for an artifact handoff preview.`);
  return normalized;
}

/** A small deterministic fingerprint; it is not a security or authority hash. */
export function fingerprintArtifactAtomicIntent(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildArtifactAtomicIdempotencyKey(input: {
  readonly artifactId: string;
  readonly revision: number;
  readonly target: ArtifactAtomicTarget;
}): string {
  const artifactId = requireText(input.artifactId, "Artifact id");
  const revision = Number.isSafeInteger(input.revision) && input.revision > 0 ? input.revision : 0;
  const target = input.target;
  const canonical = [
    artifactId,
    String(revision),
    target.kind,
    target.projectId.trim(),
    target.targetId.trim(),
    target.conversationId.trim(),
    target.branchId.trim(),
    target.modelProfileRevisionId.trim(),
  ].join("\u001f");
  return `artifact-bind-key-${fingerprintArtifactAtomicIntent(canonical).slice(-8)}`;
}

export function createArtifactAtomicHandoffPreview(
  input: ArtifactAtomicHandoffInput,
): ArtifactAtomicHandoffPreview {
  const artifactId = requireText(input.artifactId, "Artifact id");
  const now = Number.isFinite(input.now) ? Math.max(0, Math.trunc(input.now!)) : Date.now();
  const sourceRevision = Number.isSafeInteger(input.revision) ? Math.trunc(input.revision) : 0;
  const target: ArtifactAtomicTarget = Object.freeze({
    kind: input.target.kind,
    projectId: input.target.projectId.trim(),
    targetId: input.target.targetId.trim(),
    conversationId: input.target.conversationId.trim(),
    branchId: input.target.branchId.trim(),
    modelProfileRevisionId: input.target.modelProfileRevisionId.trim(),
  });
  const intentHash = fingerprintArtifactAtomicIntent(
    `${artifactId}\u001f${sourceRevision}\u001f${buildArtifactAtomicIdempotencyKey({ artifactId, revision: sourceRevision, target })}`,
  );
  return {
    schema: ARTIFACT_ATOMIC_HANDOFF_SCHEMA,
    operationType: ARTIFACT_ATOMIC_HANDOFF_TYPE,
    operationId: `artifact-bind-op-${now.toString(36)}-${intentHash.slice(-8)}`,
    sourceArtifactIds: [artifactId],
    sourceRevision,
    target,
    idempotencyKey: buildArtifactAtomicIdempotencyKey({ artifactId, revision: sourceRevision, target }),
    phase: "ready",
    outcome: "pending",
    boundary: ARTIFACT_ATOMIC_HANDOFF_BOUNDARY,
  };
}

function check(
  id: ArtifactAtomicPreflightCheck["id"],
  label: string,
  state: ArtifactAtomicCheckState,
  detail: string,
): ArtifactAtomicPreflightCheck {
  return { id, label, state, detail };
}

/**
 * Checks only visible intent. Missing host/native facts remain review or
 * blocked; they are never promoted to a successful native admission.
 */
export function evaluateArtifactAtomicHandoffPreflight(
  operation: ArtifactAtomicHandoffPreview,
): ArtifactAtomicPreflight {
  const target = operation.target;
  const artifactId = operation.sourceArtifactIds[0] ?? "";
  const checks: ArtifactAtomicPreflightCheck[] = [];
  const sourceKnown = artifactId.trim().length > 0;
  checks.push(check(
    "source-identity",
    "Source artifact identity",
    sourceKnown ? "pass" : "blocked",
    sourceKnown ? `Frozen source ${artifactId}.` : "Choose one artifact before staging the handoff.",
  ));

  const revisionKnown = Number.isSafeInteger(operation.sourceRevision) && operation.sourceRevision > 0;
  checks.push(check(
    "source-revision",
    "Source revision",
    revisionKnown ? "pass" : "blocked",
    revisionKnown ? `Revision v${operation.sourceRevision} is selected.` : "Select a positive immutable revision.",
  ));

  checks.push(check(
    "exact-source-set",
    "Exact source set",
    sourceKnown ? "pass" : "blocked",
    sourceKnown ? "Exactly one source artifact is staged; no hidden attachments are included." : "The source set is empty.",
  ));

  const projectKnown = target.projectId.trim().length > 0;
  checks.push(check(
    "project-scope",
    "Project scope",
    projectKnown ? "pass" : "blocked",
    projectKnown ? `Target remains inside Project ${target.projectId}.` : "Project scope is required before staging.",
  ));

  const targetKnown = target.targetId.trim().length > 0;
  checks.push(check(
    "target-identity",
    "Destination identity",
    targetKnown ? "pass" : "blocked",
    targetKnown ? `Destination ${target.targetId} is explicit.` : "Destination identity is required before staging.",
  ));

  if (target.kind === "chat-message") {
    const chatScopeKnown = target.conversationId.trim().length > 0 && target.branchId.trim().length > 0;
    checks.push(check(
      "chat-scope",
      "Chat and branch scope",
      chatScopeKnown ? "pass" : "blocked",
      chatScopeKnown
        ? `Chat ${target.conversationId} · branch ${target.branchId}.`
        : "Chat and branch identities are required for a message bind.",
    ));
  } else {
    checks.push(check(
      "chat-scope",
      "Chat and branch scope",
      "pass",
      "No chat bind was selected for this destination.",
    ));
  }

  if (target.kind === "bridge-plan") {
    const modelKnown = target.modelProfileRevisionId.trim().length > 0;
    checks.push(check(
      "bridge-model",
      "Bridge model revision",
      modelKnown ? "pass" : "blocked",
      modelKnown ? `Bridge target ${target.modelProfileRevisionId} is explicit.` : "A model-profile revision is required for a bridge plan.",
    ));
  } else {
    checks.push(check(
      "bridge-model",
      "Bridge model revision",
      "pass",
      "No provider/model bridge is requested by this destination.",
    ));
  }

  checks.push(check(
    "native-receipt",
    "Native atomic receipt",
    "review",
    "Native bind authority is not exposed by this renderer preview; a future command must create the durable receipt.",
  ));

  const blocking = checks.find((item) => item.state === "blocked");
  const status: ArtifactAtomicPreflightStatus = blocking ? "blocked" : "review";
  return {
    status,
    canStagePreview: !blocking,
    checks,
    blockingReason: blocking?.detail ?? null,
    boundary: ARTIFACT_ATOMIC_HANDOFF_BOUNDARY,
  };
}

export function serializeArtifactAtomicHandoffPreview(
  operation: ArtifactAtomicHandoffPreview,
  preflight: ArtifactAtomicPreflight,
): string {
  return JSON.stringify({ operation, preflight }, null, 2);
}
