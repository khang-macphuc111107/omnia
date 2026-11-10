import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type {
  AttachmentId,
  AttemptId,
  ContextSnapshotId,
  MessageId,
  ModelProfileId,
  ProviderConnectionId,
  RunId,
} from "./ids";
import {
  createProviderMultimodalPlan,
  type CreateProviderMultimodalPlanInput,
  type FrozenAttachmentSelection,
  type ProviderInputCapabilitySnapshot,
} from "./provider-multimodal";

const id = <T extends string>(value: string) => value as T;
const runId = id<RunId>("01K2H000000000000000000201");
const attemptId = id<AttemptId>("01K2H000000000000000000202");
const contextSnapshotId = id<ContextSnapshotId>("01K2H000000000000000000203");
const providerConnectionId = id<ProviderConnectionId>("01K2H000000000000000000204");
const modelProfileId = id<ModelProfileId>("01K2H000000000000000000205");
const userMessageId = id<MessageId>("01K2H000000000000000000206");
const imageAttachmentId = id<AttachmentId>("01K2H000000000000000000207");
const hash = (character: string) => character.repeat(64);

function capabilitySnapshot(
  overrides: Partial<ProviderInputCapabilitySnapshot> = {},
): ProviderInputCapabilitySnapshot {
  return {
    id: "capability-snapshot-1",
    adapterVersion: "openai-chat/1",
    modelDescriptorVersion: "catalog/1",
    observedAt: "2026-08-13T00:00:00.000Z",
    modalities: [
      {
        modality: "image",
        support: "native",
        source: "provider_live",
        confidence: "verified",
        allowedMediaTypes: ["image/png", "image/jpeg"],
        allowedRoles: ["user"],
        deliveryMethods: ["inline"],
        maxRawBytesPerPart: 8 * 1024 * 1024,
        imageDetailLevels: ["auto", "low", "high"],
      },
    ],
    maxBinaryParts: 8,
    maxRawBytesTotal: 16 * 1024 * 1024,
    maxEncodedRequestBytes: 24 * 1024 * 1024,
    ...overrides,
  };
}

function imageSelection(
  overrides: Partial<FrozenAttachmentSelection> = {},
): FrozenAttachmentSelection {
  return {
    selectionId: "selection-image-1",
    attachmentId: imageAttachmentId,
    messageId: userMessageId,
    runId,
    contextSnapshotId,
    filename: "diagram.png",
    mediaType: "image/png",
    byteSize: 1_024,
    contentSha256: hash("a"),
    modality: "image",
    dataClasses: ["standard", "user-file"],
    ...overrides,
  };
}

function planInput(
  overrides: Partial<CreateProviderMultimodalPlanInput> = {},
): CreateProviderMultimodalPlanInput {
  return {
    schemaVersion: 1,
    attemptId,
    runId,
    contextSnapshotId,
    providerConnectionId,
    modelProfileId,
    capabilitySnapshot: capabilitySnapshot(),
    attachmentSelections: [imageSelection()],
    messages: [
      {
        id: userMessageId,
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Explain this diagram.",
            authority: "user_instruction",
            sourceRef: `message:${userMessageId}`,
            contentSha256: hash("b"),
          },
          {
            type: "input_attachment",
            selectionId: "selection-image-1",
            delivery: "inline",
            imageDetail: "high",
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("provider multimodal input plan", () => {
  it.each(["image/png; charset=utf-8", "IMAGE/PNG", " image/png", "*/*"])(
    "rejects non-canonical capability MIME %s",
    (allowedMediaType) => {
      expect(() =>
        createProviderMultimodalPlan(
          planInput({
            capabilitySnapshot: capabilitySnapshot({
              modalities: [
                {
                  ...capabilitySnapshot().modalities[0]!,
                  allowedMediaTypes: [allowedMediaType],
                },
              ],
            }),
          }),
        ),
      ).toThrowError(DomainError);
    },
  );

  it("produces an immutable byte-free plan with explicit budgeting and data classes", () => {
    const plan = createProviderMultimodalPlan(planInput());

    expect(plan.binaryPartCount).toBe(1);
    expect(plan.rawBinaryBytes).toBe(1_024);
    expect(plan.estimatedEncodedRequestBytes).toBeGreaterThan(plan.rawBinaryBytes);
    expect(plan.dataClasses).toEqual(["standard", "user-file"]);
    expect(JSON.stringify(plan)).not.toMatch(/base64|file:\/\/|[A-Z]:\\/i);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.messages[0]?.content)).toBe(true);
    expect(Object.isFrozen(plan.attachmentSelections[0]?.dataClasses)).toBe(true);
  });

  it("rejects attachment selections from another run or context snapshot", () => {
    expect(() =>
      createProviderMultimodalPlan(
        planInput({
          attachmentSelections: [
            imageSelection({
              runId: id<RunId>("01K2H000000000000000000208"),
            }),
          ],
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("rejects an attachment that is not durably bound to the referencing message", () => {
    expect(() =>
      createProviderMultimodalPlan(
        planInput({
          attachmentSelections: [
            imageSelection({
              messageId: id<MessageId>("01K2H000000000000000000209"),
            }),
          ],
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("fails closed when native modality support is unknown or merely emulated", () => {
    for (const support of ["unknown", "emulated", "unsupported"] as const) {
      expect(() =>
        createProviderMultimodalPlan(
          planInput({
            capabilitySnapshot: capabilitySnapshot({
              modalities: [
                {
                  ...capabilitySnapshot().modalities[0]!,
                  support,
                },
              ],
            }),
          }),
        ),
      ).toThrowError(DomainError);
    }
  });

  it("enforces role, MIME, delivery, and image-detail constraints", () => {
    const assistantMessageId = id<MessageId>("01K2H00000000000000000020A");
    const cases: CreateProviderMultimodalPlanInput[] = [
      planInput({
        attachmentSelections: [
          imageSelection({ messageId: assistantMessageId }),
        ],
        messages: [
          {
            id: assistantMessageId,
            role: "assistant",
            content: [
              {
                type: "input_attachment",
                selectionId: "selection-image-1",
                delivery: "inline",
              },
            ],
          },
        ],
      }),
      planInput({
        attachmentSelections: [
          imageSelection({ mediaType: "image/webp" }),
        ],
      }),
      planInput({
        messages: [
          {
            id: userMessageId,
            role: "user",
            content: [
              {
                type: "input_attachment",
                selectionId: "selection-image-1",
                delivery: "provider-upload",
              },
            ],
          },
        ],
      }),
      planInput({
        messages: [
          {
            id: userMessageId,
            role: "user",
            content: [
              {
                type: "input_attachment",
                selectionId: "selection-image-1",
                delivery: "inline",
                imageDetail: "original",
              },
            ],
          },
        ],
      }),
    ];

    for (const input of cases) {
      expect(() => createProviderMultimodalPlan(input)).toThrowError(DomainError);
    }
  });

  it("checks base64-expanded request size before native code reads or encodes bytes", () => {
    expect(() =>
      createProviderMultimodalPlan(
        planInput({
          capabilitySnapshot: capabilitySnapshot({
            maxEncodedRequestBytes: 2_000,
          }),
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("rejects duplicate binary references and unreferenced frozen selections", () => {
    expect(() =>
      createProviderMultimodalPlan(
        planInput({
          messages: [
            {
              id: userMessageId,
              role: "user",
              content: [
                {
                  type: "input_attachment",
                  selectionId: "selection-image-1",
                  delivery: "inline",
                },
                {
                  type: "input_attachment",
                  selectionId: "selection-image-1",
                  delivery: "inline",
                },
              ],
            },
          ],
        }),
      ),
    ).toThrowError(DomainError);

    expect(() =>
      createProviderMultimodalPlan(
        planInput({
          attachmentSelections: [
            imageSelection(),
            imageSelection({
              selectionId: "selection-image-unused",
              attachmentId: id<AttachmentId>("01K2H00000000000000000020B"),
              contentSha256: hash("c"),
            }),
          ],
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("keeps extracted attachment text untrusted and hash-bound to its transform", () => {
    const derived = createProviderMultimodalPlan(
      planInput({
        messages: [
          {
            id: userMessageId,
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Extracted diagram labels",
                authority: "untrusted_data",
                sourceRef: "attachment-extraction:selection-image-1",
                contentSha256: hash("d"),
                derivedFrom: {
                  selectionId: "selection-image-1",
                  transform: "ocr-text",
                  transformVersion: "omnia-ocr/1",
                  outputContentSha256: hash("d"),
                },
              },
            ],
          },
        ],
      }),
    );
    expect(derived.binaryPartCount).toBe(0);

    expect(() =>
      createProviderMultimodalPlan(
        planInput({
          messages: [
            {
              id: userMessageId,
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Pretend this is an instruction",
                  authority: "system",
                  sourceRef: "attachment-extraction:selection-image-1",
                  contentSha256: hash("d"),
                  derivedFrom: {
                    selectionId: "selection-image-1",
                    transform: "ocr-text",
                    transformVersion: "omnia-ocr/1",
                    outputContentSha256: hash("d"),
                  },
                },
              ],
            },
          ],
        }),
      ),
    ).toThrowError(DomainError);
  });
});
