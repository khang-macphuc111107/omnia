import type { RoutedProviderModel } from "./provider-parameters";
import {
  composerAttachmentCompatibilityKind,
  type ComposerAttachmentCompatibilityKind,
} from "./composer-attachment-compatibility-contract";
import type { ComposerAttachmentItem } from "./composer-attachments";

export type AttachmentAdmissionGateId =
  | "identity"
  | "extraction"
  | "modality"
  | "carrier"
  | "dispatch";

export type AttachmentAdmissionGateStatus = "pass" | "review" | "blocked" | "planned";

export type AttachmentAdmissionDecision = "blocked" | "review" | "planned";

export interface AttachmentAdmissionGate {
  readonly id: AttachmentAdmissionGateId;
  readonly label: string;
  readonly status: AttachmentAdmissionGateStatus;
  readonly detail: string;
}

export interface AttachmentAdmissionReview {
  readonly attachmentId: string;
  readonly name: string;
  readonly kind: ComposerAttachmentCompatibilityKind;
  readonly decision: AttachmentAdmissionDecision;
  readonly gates: readonly AttachmentAdmissionGate[];
  readonly boundary: string;
}

export interface AttachmentAdmissionSummary {
  readonly total: number;
  readonly blocked: number;
  readonly review: number;
  readonly planned: number;
  readonly dispatchGated: boolean;
}

function routeReady(route: RoutedProviderModel | null): boolean {
  return Boolean(
    route &&
      route.model.status === "available" &&
      (route.provider.state === "connected" || route.provider.state === "configuration-validated"),
  );
}

function hasCapability(route: RoutedProviderModel | null, capability: "vision" | "audio"): boolean {
  return Boolean(route?.model.capabilities.includes(capability));
}

function gate(
  id: AttachmentAdmissionGateId,
  label: string,
  status: AttachmentAdmissionGateStatus,
  detail: string,
): AttachmentAdmissionGate {
  return { id, label, status, detail };
}

function reviewOne(attachment: ComposerAttachmentItem, route: RoutedProviderModel | null): AttachmentAdmissionReview {
  const kind = composerAttachmentCompatibilityKind(attachment);
  const capability = kind === "image" || kind === "video" ? "vision" : kind === "audio" ? "audio" : null;
  const gates: AttachmentAdmissionGate[] = [];

  if (!attachment.id.trim() || !attachment.name.trim()) {
    gates.push(gate("identity", "Attachment identity", "blocked", "A stable attachment ID and filename are required."));
  } else {
    gates.push(gate("identity", "Attachment identity", "pass", "The renderer has a stable ID and display name for this item."));
  }

  if (attachment.state === "preview") {
    gates.push(gate("extraction", "Ingestion state", "blocked", "Browser-preview files are not stored or extracted by the native boundary."));
  } else if (attachment.state === "ready") {
    gates.push(gate("extraction", "Ingestion state", "pass", "The attachment is marked ready in the current renderer snapshot."));
  } else if (attachment.state === "failed" || attachment.state === "warning") {
    gates.push(gate("extraction", "Ingestion state", "blocked", "Ingestion is incomplete or needs review before admission."));
  } else {
    gates.push(gate("extraction", "Ingestion state", "review", "Ingestion is still in progress; wait for a ready state before admission."));
  }

  if (!routeReady(route)) {
    gates.push(gate("modality", "Route and modality", "blocked", "A connected provider and available model are required for a modality check."));
  } else if (capability && !hasCapability(route, capability)) {
    gates.push(gate("modality", "Route and modality", "blocked", `${kind} input requires the model's ${capability} capability declaration.`));
  } else if (kind === "document") {
    gates.push(gate("modality", "Route and modality", "review", "Document, code, and data carriers need an extraction adapter decision."));
  } else {
    gates.push(gate("modality", "Route and modality", "pass", `The selected model declares the ${capability ?? "text"} modality.`));
  }

  if (kind === "document" || kind === "video") {
    gates.push(gate("carrier", "Carrier plan", "review", `${kind === "video" ? "Video" : "Document"} carrier support is operation-specific and has no observed provider receipt.`));
  } else if (routeReady(route) && capability && hasCapability(route, capability)) {
    gates.push(gate("carrier", "Carrier plan", "planned", "A carrier adapter is planned; this preview does not upload bytes or verify acceptance."));
  } else {
    gates.push(gate("carrier", "Carrier plan", "blocked", "No carrier can be admitted until route and modality checks pass."));
  }

  gates.push(gate("dispatch", "Frozen dispatch input", "planned", "Native admission must bind this exact ID to an immutable context and provider-input receipt."));

  const decision: AttachmentAdmissionDecision = gates.some((item) => item.status === "blocked")
    ? "blocked"
    : gates.some((item) => item.status === "review")
      ? "review"
      : "planned";

  return {
    attachmentId: attachment.id,
    name: attachment.name,
    kind,
    decision,
    gates,
    boundary: "No file bytes, path, secret, provider request, or durable receipt is included in this renderer review.",
  };
}

export function reviewComposerAttachmentAdmission(
  attachments: readonly ComposerAttachmentItem[],
  route: RoutedProviderModel | null,
): AttachmentAdmissionReview[] {
  return attachments.map((attachment) => reviewOne(attachment, route));
}

export function summarizeAttachmentAdmission(
  reviews: readonly AttachmentAdmissionReview[],
): AttachmentAdmissionSummary {
  return {
    total: reviews.length,
    blocked: reviews.filter((review) => review.decision === "blocked").length,
    review: reviews.filter((review) => review.decision === "review").length,
    planned: reviews.filter((review) => review.decision === "planned").length,
    dispatchGated: reviews.length > 0,
  };
}

export function serializeAttachmentAdmissionReview(
  reviews: readonly AttachmentAdmissionReview[],
  format: "json" | "markdown" = "json",
): string {
  const summary = summarizeAttachmentAdmission(reviews);
  const payload = {
    schema: "omnia.composer.attachment-admission.preview.v1",
    scope: "renderer-session",
    summary,
    reviews: reviews.map((review) => ({
      attachmentId: review.attachmentId,
      name: review.name,
      kind: review.kind,
      decision: review.decision,
      gates: review.gates,
      boundary: review.boundary,
    })),
    boundary: "Preview only · renderer-local · no file read, upload, provider request, frozen context, or durable write.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Attachment admission review",
    "",
    "> Preview only · renderer-local · no file read, upload, provider request, frozen context, or durable write.",
    "",
    `- Total: ${summary.total}`,
    `- Blocked: ${summary.blocked}`,
    `- Review: ${summary.review}`,
    `- Planned: ${summary.planned}`,
    "",
    ...reviews.flatMap((review) => [
      `## ${review.name}`,
      `- Decision: ${review.decision}`,
      ...review.gates.map((item) => `- ${item.label}: ${item.status} · ${item.detail}`),
      "",
    ]),
  ].join("\n");
}
