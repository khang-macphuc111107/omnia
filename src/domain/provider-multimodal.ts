import { assertDomain } from "./errors";
import type {
  AttachmentId,
  AttemptId,
  ContextSnapshotId,
  MessageId,
  ModelProfileId,
  ProviderConnectionId,
  RunId,
} from "./ids";
import type { CapabilityConfidence, CapabilitySource } from "./provider";
import {
  assertNonBlank,
  assertSha256,
  assertIsoTimestamp,
  type IsoTimestamp,
} from "./shared";

export type ProviderInputRole = "system" | "developer" | "user" | "assistant" | "tool";
export type ProviderInputAuthority =
  | "system"
  | "developer"
  | "user_instruction"
  | "untrusted_data";
export type ProviderInputModality = "image" | "audio" | "file";
export type ProviderInputDelivery = "inline" | "provider-upload";
export type ProviderInputSupport = "native" | "emulated" | "unsupported" | "unknown";
export type ImageDetail = "auto" | "low" | "high" | "original";

export type AttachmentTransformKind =
  | "extract-text"
  | "ocr-text"
  | "transcript-text"
  | "rasterize-pages";

/**
 * Native storage creates this immutable record when a run/context snapshot is
 * frozen. A renderer-selected attachment ID is not sufficient authorization.
 */
export interface FrozenAttachmentSelection {
  readonly selectionId: string;
  readonly attachmentId: AttachmentId;
  readonly messageId: MessageId;
  readonly runId: RunId;
  readonly contextSnapshotId: ContextSnapshotId;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentSha256: string;
  readonly modality: ProviderInputModality;
  readonly dataClasses: readonly string[];
}

export interface ProviderInputModalityCapability {
  readonly modality: ProviderInputModality;
  readonly support: ProviderInputSupport;
  readonly source: CapabilitySource;
  readonly confidence: CapabilityConfidence;
  readonly allowedMediaTypes: readonly string[];
  readonly allowedRoles: readonly ProviderInputRole[];
  readonly deliveryMethods: readonly ProviderInputDelivery[];
  readonly maxRawBytesPerPart: number;
  readonly imageDetailLevels?: readonly ImageDetail[];
}

/**
 * The capability snapshot is frozen before a billable request. Model-name
 * inference and renderer-authored capability claims must never populate it.
 */
export interface ProviderInputCapabilitySnapshot {
  readonly id: string;
  readonly adapterVersion: string;
  readonly modelDescriptorVersion: string;
  readonly observedAt: IsoTimestamp;
  readonly modalities: readonly ProviderInputModalityCapability[];
  readonly maxBinaryParts: number;
  readonly maxRawBytesTotal: number;
  readonly maxEncodedRequestBytes: number;
}

export interface ProviderInputTextPart {
  readonly type: "input_text";
  readonly text: string;
  readonly authority: ProviderInputAuthority;
  readonly sourceRef: string;
  readonly contentSha256: string;
  readonly derivedFrom?: {
    readonly selectionId: string;
    readonly transform: AttachmentTransformKind;
    readonly transformVersion: string;
    readonly outputContentSha256: string;
  };
}

/**
 * The part references a native-owned frozen selection. It deliberately has no
 * bytes, path, URL, blob descriptor, provider file ID, or base64 field.
 */
export interface ProviderInputAttachmentPart {
  readonly type: "input_attachment";
  readonly selectionId: string;
  readonly delivery: ProviderInputDelivery;
  readonly imageDetail?: ImageDetail;
}

export type ProviderInputPart = ProviderInputTextPart | ProviderInputAttachmentPart;

export interface ProviderInputMessage {
  readonly id: MessageId;
  readonly role: ProviderInputRole;
  readonly content: readonly ProviderInputPart[];
}

export interface CreateProviderMultimodalPlanInput {
  readonly schemaVersion: 1;
  readonly attemptId: AttemptId;
  readonly runId: RunId;
  readonly contextSnapshotId: ContextSnapshotId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly modelProfileId: ModelProfileId;
  readonly capabilitySnapshot: ProviderInputCapabilitySnapshot;
  readonly attachmentSelections: readonly FrozenAttachmentSelection[];
  readonly messages: readonly ProviderInputMessage[];
}

export interface ProviderMultimodalPlan {
  readonly schemaVersion: 1;
  readonly attemptId: AttemptId;
  readonly runId: RunId;
  readonly contextSnapshotId: ContextSnapshotId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly modelProfileId: ModelProfileId;
  readonly capabilitySnapshot: ProviderInputCapabilitySnapshot;
  readonly attachmentSelections: readonly FrozenAttachmentSelection[];
  readonly messages: readonly ProviderInputMessage[];
  readonly binaryPartCount: number;
  readonly rawBinaryBytes: number;
  readonly estimatedEncodedRequestBytes: number;
  readonly dataClasses: readonly string[];
}

const MAX_MESSAGES = 2_000;
const MAX_PARTS_PER_MESSAGE = 1_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_FILENAME_BYTES = 512;
const MAX_MEDIA_TYPE_BYTES = 255;
const JSON_FRAMING_BYTES_PER_PART = 1_024;
const UPLOAD_REFERENCE_ESTIMATE_BYTES = 1_024;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertPositiveBound(value: number, label: string): void {
  assertDomain(
    Number.isSafeInteger(value) && value > 0,
    "invalid_argument",
    `${label} must be a positive safe integer.`,
    { label, value },
  );
}

function normalizeMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertDomain(
    normalized.length > 0 &&
      normalized.length <= MAX_MEDIA_TYPE_BYTES &&
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized),
    "invalid_argument",
    "Attachment media type must be a canonical MIME type without parameters.",
    { mediaType: normalized },
  );
  return normalized;
}

function normalizeAllowedMediaType(value: string): string {
  const normalized = value;
  const validWildcard =
    normalized.length <= MAX_MEDIA_TYPE_BYTES &&
    normalized === normalized.trim() &&
    normalized === normalized.toLowerCase() &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/\*$/.test(normalized) &&
    normalized !== "*/*";
  assertDomain(
    validWildcard ||
      (normalized.length <= MAX_MEDIA_TYPE_BYTES &&
        normalized === normalized.trim() &&
        normalized === normalized.toLowerCase() &&
        /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
          normalized,
        )),
    "invalid_argument",
    "Capability media types must be exact MIME types or bounded family wildcards.",
    { mediaType: normalized },
  );
  return normalized;
}

function mediaTypeAllowed(mediaType: string, allowed: readonly string[]): boolean {
  const [family] = mediaType.split("/");
  return allowed.some(
    (candidate) => candidate === mediaType || candidate === `${family}/*`,
  );
}

function inferModality(mediaType: string): ProviderInputModality {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  return "file";
}

function base64EncodedBytes(rawBytes: number): number {
  const groups = Math.ceil(rawBytes / 3);
  const encoded = groups * 4;
  assertDomain(
    Number.isSafeInteger(encoded),
    "invalid_argument",
    "Attachment size cannot be represented safely.",
    { rawBytes },
  );
  return encoded;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  assertDomain(
    Number.isSafeInteger(result),
    "invalid_argument",
    `${label} exceeds the safe integer range.`,
    { left, right },
  );
  return result;
}

function freezeCapability(
  capability: ProviderInputModalityCapability,
): ProviderInputModalityCapability {
  assertPositiveBound(capability.maxRawBytesPerPart, "maxRawBytesPerPart");
  const allowedMediaTypes = Object.freeze(
    [...new Set(capability.allowedMediaTypes.map(normalizeAllowedMediaType))].sort(),
  );
  const allowedRoles = Object.freeze([...new Set(capability.allowedRoles)]);
  const deliveryMethods = Object.freeze([...new Set(capability.deliveryMethods)]);
  const imageDetailLevels =
    capability.imageDetailLevels === undefined
      ? undefined
      : Object.freeze([...new Set(capability.imageDetailLevels)]);

  assertDomain(
    capability.modality === "image" || imageDetailLevels === undefined,
    "invalid_argument",
    "Only image capabilities may declare image detail levels.",
    { modality: capability.modality },
  );
  assertDomain(
    capability.support !== "native" ||
      (allowedMediaTypes.length > 0 &&
        allowedRoles.length > 0 &&
        deliveryMethods.length > 0),
    "invalid_argument",
    "Native modality support requires explicit media type, role, and delivery constraints.",
    { modality: capability.modality },
  );
  return Object.freeze({
    ...capability,
    allowedMediaTypes,
    allowedRoles,
    deliveryMethods,
    ...(imageDetailLevels === undefined ? {} : { imageDetailLevels }),
  });
}

function freezeCapabilitySnapshot(
  snapshot: ProviderInputCapabilitySnapshot,
): ProviderInputCapabilitySnapshot {
  const id = assertNonBlank(snapshot.id, "capability snapshot ID", MAX_IDENTIFIER_BYTES);
  const adapterVersion = assertNonBlank(
    snapshot.adapterVersion,
    "adapter version",
    MAX_IDENTIFIER_BYTES,
  );
  const modelDescriptorVersion = assertNonBlank(
    snapshot.modelDescriptorVersion,
    "model descriptor version",
    MAX_IDENTIFIER_BYTES,
  );
  assertIsoTimestamp(snapshot.observedAt, "capability observedAt");
  assertPositiveBound(snapshot.maxBinaryParts, "maxBinaryParts");
  assertPositiveBound(snapshot.maxRawBytesTotal, "maxRawBytesTotal");
  assertPositiveBound(snapshot.maxEncodedRequestBytes, "maxEncodedRequestBytes");
  const modalities = Object.freeze(snapshot.modalities.map(freezeCapability));
  assertDomain(
    new Set(modalities.map((capability) => capability.modality)).size === modalities.length,
    "invalid_argument",
    "A capability snapshot cannot declare the same modality twice.",
  );
  return Object.freeze({
    ...snapshot,
    id,
    adapterVersion,
    modelDescriptorVersion,
    modalities,
  });
}

function freezeSelection(
  selection: FrozenAttachmentSelection,
  input: CreateProviderMultimodalPlanInput,
): FrozenAttachmentSelection {
  const selectionId = assertNonBlank(
    selection.selectionId,
    "attachment selection ID",
    MAX_IDENTIFIER_BYTES,
  );
  assertDomain(
    selection.runId === input.runId &&
      selection.contextSnapshotId === input.contextSnapshotId,
    "scope_violation",
    "Attachment selection belongs to another frozen run or context snapshot.",
    { selectionId },
  );
  assertDomain(
    Number.isSafeInteger(selection.byteSize) && selection.byteSize >= 0,
    "invalid_argument",
    "Attachment byte size must be a non-negative safe integer.",
    { selectionId, byteSize: selection.byteSize },
  );
  const mediaType = normalizeMediaType(selection.mediaType);
  assertDomain(
    inferModality(mediaType) === selection.modality,
    "invalid_argument",
    "Attachment modality does not match its canonical media type.",
    { selectionId, modality: selection.modality, mediaType },
  );
  const dataClasses = Object.freeze(
    [...new Set(selection.dataClasses.map((value) =>
      assertNonBlank(value, "attachment data class", MAX_IDENTIFIER_BYTES),
    ))].sort(),
  );
  assertDomain(
    dataClasses.length > 0,
    "invalid_argument",
    "A frozen attachment selection requires at least one data class.",
    { selectionId },
  );
  return Object.freeze({
    ...selection,
    selectionId,
    filename: assertNonBlank(selection.filename, "attachment filename", MAX_FILENAME_BYTES),
    mediaType,
    contentSha256: assertSha256(selection.contentSha256, "attachment content hash"),
    dataClasses,
  });
}

function freezeTextPart(
  part: ProviderInputTextPart,
  selections: ReadonlyMap<string, FrozenAttachmentSelection>,
): ProviderInputTextPart {
  assertDomain(
    !part.text.includes("\0"),
    "invalid_argument",
    "Provider input text contains a null character.",
  );
  const sourceRef = assertNonBlank(part.sourceRef, "provider input source reference", 2_048);
  const contentSha256 = assertSha256(part.contentSha256, "provider input text hash");
  const derivedFrom =
    part.derivedFrom === undefined
      ? undefined
      : Object.freeze({
          selectionId: assertNonBlank(
            part.derivedFrom.selectionId,
            "derived attachment selection ID",
            MAX_IDENTIFIER_BYTES,
          ),
          transform: part.derivedFrom.transform,
          transformVersion: assertNonBlank(
            part.derivedFrom.transformVersion,
            "attachment transform version",
            MAX_IDENTIFIER_BYTES,
          ),
          outputContentSha256: assertSha256(
            part.derivedFrom.outputContentSha256,
            "attachment transform output hash",
          ),
        });
  if (derivedFrom !== undefined) {
    assertDomain(
      selections.has(derivedFrom.selectionId),
      "scope_violation",
      "Derived provider text references an attachment outside the frozen selection.",
      { selectionId: derivedFrom.selectionId },
    );
    assertDomain(
      part.authority === "untrusted_data",
      "scope_violation",
      "Attachment-derived text must remain untrusted data.",
      { selectionId: derivedFrom.selectionId, authority: part.authority },
    );
    assertDomain(
      derivedFrom.outputContentSha256 === contentSha256,
      "invalid_argument",
      "Derived text hash must match the recorded transform output hash.",
      { selectionId: derivedFrom.selectionId },
    );
  }
  return Object.freeze({
    ...part,
    sourceRef,
    contentSha256,
    ...(derivedFrom === undefined ? {} : { derivedFrom }),
  });
}

function capabilityFor(
  snapshot: ProviderInputCapabilitySnapshot,
  modality: ProviderInputModality,
): ProviderInputModalityCapability {
  const capability = snapshot.modalities.find((candidate) => candidate.modality === modality);
  assertDomain(
    capability !== undefined && capability.support === "native",
    "unsupported_capability",
    "The frozen model capability snapshot does not prove native support for this input modality.",
    {
      modality,
      support: capability?.support ?? "missing",
      capabilitySnapshotId: snapshot.id,
    },
  );
  return capability;
}

function freezeAttachmentPart(
  part: ProviderInputAttachmentPart,
  message: ProviderInputMessage,
  selections: ReadonlyMap<string, FrozenAttachmentSelection>,
  snapshot: ProviderInputCapabilitySnapshot,
): {
  readonly part: ProviderInputAttachmentPart;
  readonly selection: FrozenAttachmentSelection;
  readonly estimatedEncodedBytes: number;
} {
  const selectionId = assertNonBlank(
    part.selectionId,
    "attachment selection ID",
    MAX_IDENTIFIER_BYTES,
  );
  const selection = selections.get(selectionId);
  assertDomain(
    selection !== undefined,
    "scope_violation",
    "Provider input references an attachment outside the frozen selection.",
    { selectionId },
  );
  assertDomain(
    selection.messageId === message.id,
    "scope_violation",
    "Provider input attachment is not bound to the message that references it.",
    { selectionId, messageId: message.id },
  );
  assertDomain(
    message.role === "user",
    "unsupported_capability",
    "Binary provider input is allowed only on a user message.",
    { selectionId, role: message.role },
  );
  const capability = capabilityFor(snapshot, selection.modality);
  assertDomain(
    capability.allowedRoles.includes(message.role),
    "unsupported_capability",
    "The frozen provider capability does not allow this role for the modality.",
    { selectionId, role: message.role, modality: selection.modality },
  );
  assertDomain(
    capability.deliveryMethods.includes(part.delivery),
    "unsupported_capability",
    "The frozen provider capability does not allow the selected delivery method.",
    { selectionId, delivery: part.delivery, modality: selection.modality },
  );
  assertDomain(
    mediaTypeAllowed(selection.mediaType, capability.allowedMediaTypes),
    "unsupported_capability",
    "The frozen provider capability does not allow the attachment media type.",
    { selectionId, mediaType: selection.mediaType, modality: selection.modality },
  );
  assertDomain(
    selection.byteSize <= capability.maxRawBytesPerPart,
    "unsupported_capability",
    "The attachment exceeds the provider modality per-part limit.",
    {
      selectionId,
      byteSize: selection.byteSize,
      limit: capability.maxRawBytesPerPart,
    },
  );
  if (part.imageDetail !== undefined) {
    assertDomain(
      selection.modality === "image",
      "invalid_argument",
      "Image detail can be set only for an image attachment.",
      { selectionId, modality: selection.modality },
    );
    assertDomain(
      capability.imageDetailLevels?.includes(part.imageDetail) === true,
      "unsupported_capability",
      "The frozen provider capability does not allow the requested image detail.",
      { selectionId, imageDetail: part.imageDetail },
    );
  }
  const estimatedPayloadBytes =
    part.delivery === "inline"
      ? base64EncodedBytes(selection.byteSize)
      : UPLOAD_REFERENCE_ESTIMATE_BYTES;
  return Object.freeze({
    part: Object.freeze({ ...part, selectionId }),
    selection,
    estimatedEncodedBytes: checkedAdd(
      estimatedPayloadBytes,
      JSON_FRAMING_BYTES_PER_PART,
      "Estimated encoded request size",
    ),
  });
}

/**
 * Builds an immutable, byte-free provider input plan. Native adapter code may
 * resolve the referenced encrypted blobs only after this plan and route policy
 * pass. This function deliberately cannot produce a provider wire payload.
 */
export function createProviderMultimodalPlan(
  input: CreateProviderMultimodalPlanInput,
): ProviderMultimodalPlan {
  assertDomain(
    input.schemaVersion === 1,
    "invalid_argument",
    "Provider multimodal input schema version is unsupported.",
  );
  assertDomain(
    input.messages.length > 0 && input.messages.length <= MAX_MESSAGES,
    "invalid_argument",
    "Provider input must contain a bounded nonempty message list.",
  );
  const capabilitySnapshot = freezeCapabilitySnapshot(input.capabilitySnapshot);
  const attachmentSelections = Object.freeze(
    input.attachmentSelections.map((selection) => freezeSelection(selection, input)),
  );
  const selectionMap = new Map(
    attachmentSelections.map((selection) => [selection.selectionId, selection]),
  );
  assertDomain(
    selectionMap.size === attachmentSelections.length,
    "conflict",
    "Frozen attachment selection IDs must be unique.",
  );

  const messageIds = new Set<MessageId>();
  const referencedSelectionIds = new Set<string>();
  const binarySelectionIds = new Set<string>();
  let binaryPartCount = 0;
  let rawBinaryBytes = 0;
  let estimatedEncodedRequestBytes = 0;
  let textBytes = 0;

  const messages = Object.freeze(
    input.messages.map((message) => {
      assertDomain(
        !messageIds.has(message.id),
        "conflict",
        "Provider input message IDs must be unique.",
        { messageId: message.id },
      );
      messageIds.add(message.id);
      assertDomain(
        message.content.length > 0 && message.content.length <= MAX_PARTS_PER_MESSAGE,
        "invalid_argument",
        "Every provider input message must contain a bounded nonempty part list.",
        { messageId: message.id },
      );
      const content = Object.freeze(
        message.content.map((part) => {
          if (part.type === "input_text") {
            const frozen = freezeTextPart(part, selectionMap);
            const bytes = byteLength(frozen.text);
            textBytes = checkedAdd(textBytes, bytes, "Provider input text");
            estimatedEncodedRequestBytes = checkedAdd(
              estimatedEncodedRequestBytes,
              checkedAdd(bytes, JSON_FRAMING_BYTES_PER_PART, "Text part estimate"),
              "Estimated encoded request size",
            );
            if (frozen.derivedFrom !== undefined) {
              referencedSelectionIds.add(frozen.derivedFrom.selectionId);
            }
            return frozen;
          }
          const resolved = freezeAttachmentPart(
            part,
            message,
            selectionMap,
            capabilitySnapshot,
          );
          assertDomain(
            !binarySelectionIds.has(resolved.selection.selectionId),
            "conflict",
            "A frozen attachment may appear as a binary provider part only once.",
            { selectionId: resolved.selection.selectionId },
          );
          binarySelectionIds.add(resolved.selection.selectionId);
          referencedSelectionIds.add(resolved.selection.selectionId);
          binaryPartCount += 1;
          rawBinaryBytes = checkedAdd(
            rawBinaryBytes,
            resolved.selection.byteSize,
            "Raw provider binary input",
          );
          estimatedEncodedRequestBytes = checkedAdd(
            estimatedEncodedRequestBytes,
            resolved.estimatedEncodedBytes,
            "Estimated encoded request size",
          );
          return resolved.part;
        }),
      );
      return Object.freeze({ ...message, content });
    }),
  );

  assertDomain(
    textBytes <= MAX_TEXT_BYTES,
    "invalid_argument",
    "Provider input text exceeds the request safety limit.",
    { textBytes, limit: MAX_TEXT_BYTES },
  );
  assertDomain(
    binaryPartCount <= capabilitySnapshot.maxBinaryParts,
    "unsupported_capability",
    "Provider input exceeds the frozen binary-part limit.",
    { binaryPartCount, limit: capabilitySnapshot.maxBinaryParts },
  );
  assertDomain(
    rawBinaryBytes <= capabilitySnapshot.maxRawBytesTotal,
    "unsupported_capability",
    "Provider input exceeds the frozen raw-binary limit.",
    { rawBinaryBytes, limit: capabilitySnapshot.maxRawBytesTotal },
  );
  assertDomain(
    estimatedEncodedRequestBytes <= capabilitySnapshot.maxEncodedRequestBytes,
    "unsupported_capability",
    "Provider input exceeds the frozen encoded-request limit.",
    {
      estimatedEncodedRequestBytes,
      limit: capabilitySnapshot.maxEncodedRequestBytes,
    },
  );
  const unusedSelections = attachmentSelections
    .filter((selection) => !referencedSelectionIds.has(selection.selectionId))
    .map((selection) => selection.selectionId);
  assertDomain(
    unusedSelections.length === 0,
    "scope_violation",
    "A provider input plan cannot carry unreferenced attachment selections.",
    { selectionIds: unusedSelections },
  );

  const dataClasses = Object.freeze(
    [...new Set(attachmentSelections.flatMap((selection) => selection.dataClasses))].sort(),
  );
  return Object.freeze({
    schemaVersion: 1,
    attemptId: input.attemptId,
    runId: input.runId,
    contextSnapshotId: input.contextSnapshotId,
    providerConnectionId: input.providerConnectionId,
    modelProfileId: input.modelProfileId,
    capabilitySnapshot,
    attachmentSelections,
    messages,
    binaryPartCount,
    rawBinaryBytes,
    estimatedEncodedRequestBytes,
    dataClasses,
  });
}
