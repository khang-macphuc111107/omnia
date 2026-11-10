import { describe, expect, it } from "vitest";

import {
  createAuthorizedCapturePlan,
  createBrowserAttachmentLease,
  createCaptureCompletionReceipt,
  type AuthorizedCapturePlan,
  type BrowserAttachmentLease,
  type CaptureAuthorizationReceipt,
  type CaptureDiscoveryPolicy,
  type CaptureSourceReceipt,
  type CreateAuthorizedCapturePlanInput,
} from "./browser-capture";
import { DomainError } from "./errors";
import type {
  BranchId,
  ConversationId,
  ProfileId,
  ProjectId,
} from "./ids";

const id = <T extends string>(value: string) => value as T;
const sha = (character: string) => character.repeat(64);
const attachedAt = "2026-08-13T00:00:00.000Z";
const acknowledgedAt = "2026-08-13T00:01:00.000Z";
const observedAt = "2026-08-13T00:02:00.000Z";
const createdAt = "2026-08-13T00:03:00.000Z";
const completedAt = "2026-08-13T00:04:00.000Z";
const expiresAt = "2026-08-13T01:00:00.000Z";
const profileId = id<ProfileId>("profile_1");
const projectId = id<ProjectId>("project_1");
const conversationId = id<ConversationId>("conversation_1");
const branchId = id<BranchId>("branch_1");

function browserAttachment(): BrowserAttachmentLease {
  return createBrowserAttachmentLease({
    schemaVersion: 1,
    id: "browser_attachment_1",
    profileId,
    browserChannel: "edge-canary",
    browserVersion: "141.0.0.0 canary",
    profileDisplayName: "Default",
    tabTargetId: "tab_1",
    tabDisplayTitle: "Authorized source",
    topLevelOrigin: "https://example.test",
    epoch: "epoch_1",
    capabilities: ["network-metadata", "response-body-stream", "typed-page-actions"],
    credentialBoundary: "browser-contained",
    automationDisclosure: "visible",
    state: "active",
    attachedAt,
    expiresAt,
  });
}

function authorization(): CaptureAuthorizationReceipt {
  return {
    schemaVersion: 1,
    id: "capture_authorization_1",
    profileId,
    browserAttachmentId: "browser_attachment_1",
    browserAttachmentEpoch: "epoch_1",
    tabTargetId: "tab_1",
    destination: { profileId, projectId, conversationId, branchId },
    rightsBasis: "licensed-access",
    contentLabel: "Course material available to the signed-in learner",
    allowedOrigins: ["https://cdn.example.test", "https://example.test"],
    assertions: {
      browserAuthorizedResponsesOnly: true,
      protectedContentExcluded: true,
      challengeBypassExcluded: true,
      credentialsRemainInBrowser: true,
      hiddenEndpointMutationExcluded: true,
    },
    userPresence: "explicit-job-confirmation",
    policyVersion: "capture-policy-v1",
    acknowledgedAt,
    expiresAt,
  };
}

function discoveryPolicy(): CaptureDiscoveryPolicy {
  return {
    schemaVersion: 1,
    mode: "typed-browser-actions",
    allowedActions: ["scroll-forward", "advance-page", "increase-visible-viewer-zoom"],
    challengeBehavior: "pause-for-user",
    automationDisclosure: "always-visible",
    arbitraryScriptInjection: "forbidden",
    unobservedEndpointMutation: "forbidden",
    quota: {
      maxResources: 100,
      maxTotalBytes: 64 * 1024 * 1024,
      maxSingleResourceBytes: 32 * 1024 * 1024,
      maxDecodedPixels: 100_000_000,
      maxDurationMs: 30 * 60 * 1000,
      maxTraversalSteps: 100,
      maxNoProgressSteps: 5,
      maxRequestsPerMinute: 120,
      maxConcurrentRequests: 4,
      maxRedirectsPerRequest: 2,
    },
  };
}

function source(
  idValue: string,
  overrides: Partial<CaptureSourceReceipt> = {},
): CaptureSourceReceipt {
  return {
    schemaVersion: 1,
    id: idValue,
    browserAttachmentId: "browser_attachment_1",
    browserAttachmentEpoch: "epoch_1",
    tabTargetId: "tab_1",
    observedAt,
    origin: "https://cdn.example.test",
    redirectOrigins: [],
    method: "GET",
    responseStatus: 200,
    mediaType: "application/pdf",
    expectedBytes: 12,
    requestIdentitySha256: sha("1"),
    responseMetadataSha256: sha("2"),
    brokerReceiptSha256: sha("3"),
    brokerResponseHandleId: `body_${idValue}`,
    resourceIdentitySha256: sha("4"),
    resourceGroupSha256: sha("5"),
    role: "primary",
    qualityEvidence: "original-response",
    protection: {
      status: "clear",
      signals: ["none-observed"],
      assessorVersion: "protection-v1",
      assessedAt: observedAt,
    },
    secretHandling: "browser-contained",
    ...overrides,
  };
}

function singlePlanInput(
  overrides: Partial<CreateAuthorizedCapturePlanInput> = {},
): CreateAuthorizedCapturePlanInput {
  return {
    schemaVersion: 1,
    id: "capture_plan_1",
    authorization: authorization(),
    browserAttachment: browserAttachment(),
    discoveryPolicy: discoveryPolicy(),
    sources: [source("source_1")],
    assembly: {
      kind: "single-response",
      sourceId: "source_1",
      outputFilename: "lesson.pdf",
    },
    createdAt,
    expiresAt,
    ...overrides,
  };
}

function completion(plan: AuthorizedCapturePlan) {
  return createCaptureCompletionReceipt(plan, {
    schemaVersion: 1,
    id: "capture_completion_1",
    planId: plan.id,
    planSha256: sha("a"),
    authorizationId: plan.authorization.id,
    browserAttachmentId: plan.browserAttachment.id,
    browserAttachmentEpoch: plan.browserAttachment.epoch,
    orderedInputs: [
      {
        sourceId: "source_1",
        contentSha256: sha("b"),
        byteSize: 12,
        capturedAt: completedAt,
      },
    ],
    outputBlobId: "blob_1",
    outputFilename: "lesson.pdf",
    outputMediaType: "application/pdf",
    outputContentSha256: sha("b"),
    outputByteSize: 12,
    toolchain: {
      component: "omnia-native-copy",
      version: "1.0.0",
      binarySha256: sha("c"),
      argumentsSha256: sha("d"),
      sandboxed: true,
      networkDisabled: true,
      lossless: true,
    },
    gaps: [],
    completedAt,
  });
}

describe("authorized browser capture", () => {
  it("freezes an opaque single-response plan and a complete lossless receipt", () => {
    const plan = createAuthorizedCapturePlan(singlePlanInput());
    expect(plan.assembly.kind).toBe("single-response");
    expect(plan.orderedSourceIds).toEqual(["source_1"]);
    expect(plan.projectedBytes).toBe(12);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.sources)).toBe(true);

    const receipt = completion(plan);
    expect(receipt.assemblyKind).toBe("single-response");
    expect(receipt.outputContentSha256).toBe(sha("b"));
    expect(receipt.gaps).toEqual([]);
  });

  it("rejects raw URLs, headers, cookies, tokens, or debugging material even through untyped IPC", () => {
    const input = singlePlanInput() as unknown as Record<string, unknown>;
    input.rawUrl = "https://example.test/file?signature=secret";
    expect(() => createAuthorizedCapturePlan(input as unknown as CreateAuthorizedCapturePlanInput)).toThrowError(DomainError);

    const nested = singlePlanInput() as unknown as { sources: Array<Record<string, unknown>> };
    nested.sources[0] = { ...nested.sources[0], headers: { authorization: "Bearer secret" } };
    expect(() => createAuthorizedCapturePlan(nested as unknown as CreateAuthorizedCapturePlanInput)).toThrowError(DomainError);
  });

  it("rejects non-Edge, hidden, credential-exporting, or inactive browser attachments", () => {
    const valid = browserAttachment();
    expect(() => createBrowserAttachmentLease({
      ...valid,
      browserChannel: "edge" as "edge-canary",
    })).toThrowError(DomainError);
    expect(() => createBrowserAttachmentLease({
      ...valid,
      credentialBoundary: "renderer-readable" as "browser-contained",
    })).toThrowError(DomainError);
    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      browserAttachment: { ...valid, state: "detached" },
    }))).toThrowError(DomainError);
  });

  it("rejects challenge bypass, arbitrary script injection, and hidden endpoint mutation", () => {
    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      discoveryPolicy: {
        ...discoveryPolicy(),
        challengeBehavior: "solve-automatically" as "pause-for-user",
      },
    }))).toThrowError(DomainError);
    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      discoveryPolicy: {
        ...discoveryPolicy(),
        arbitraryScriptInjection: "allowed" as "forbidden",
      },
    }))).toThrowError(DomainError);
    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      authorization: {
        ...authorization(),
        assertions: {
          ...authorization().assertions,
          hiddenEndpointMutationExcluded: false as true,
        },
      },
    }))).toThrowError(DomainError);
  });

  it("rejects DRM, encrypted, challenged, and ambiguous resources before byte capture", () => {
    for (const status of ["drm", "encrypted", "challenge", "ambiguous"] as const) {
      expect(() => createAuthorizedCapturePlan(singlePlanInput({
        sources: [source("source_1", {
          protection: {
            status,
            signals: [status === "drm" ? "dash-content-protection" : status === "encrypted" ? "hls-key" : status === "challenge" ? "browser-challenge" : "parser-uncertain"],
            assessorVersion: "protection-v1",
            assessedAt: observedAt,
          },
        })],
      }))).toThrowError(DomainError);
    }
  });

  it("binds every source to the exact tab epoch and authorized redirect origins", () => {
    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      sources: [source("source_1", { browserAttachmentEpoch: "stale_epoch" })],
    }))).toThrowError(DomainError);
    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      sources: [source("source_1", { redirectOrigins: ["https://evil.test"] })],
    }))).toThrowError(DomainError);
    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      sources: [source("source_1", { method: "POST" as "GET" })],
    }))).toThrowError(DomainError);
  });

  it("requires a strong stable validator and gap-free coverage for byte-range merge", () => {
    const ranges = [
      source("range_1", {
        responseStatus: 206,
        role: "range",
        expectedBytes: 5,
        contentRange: { start: 0, endInclusive: 4, total: 10 },
        validator: { kind: "strong-etag", valueSha256: sha("e"), brokerHandleId: "validator_1" },
        resourceIdentitySha256: sha("f"),
      }),
      source("range_2", {
        responseStatus: 206,
        role: "range",
        expectedBytes: 5,
        contentRange: { start: 5, endInclusive: 9, total: 10 },
        validator: { kind: "strong-etag", valueSha256: sha("e"), brokerHandleId: "validator_2" },
        resourceIdentitySha256: sha("f"),
      }),
    ];
    const plan = createAuthorizedCapturePlan(singlePlanInput({
      sources: ranges,
      assembly: {
        kind: "byte-range",
        sourceIds: ["range_1", "range_2"],
        resourceIdentitySha256: sha("f"),
        validatorValueSha256: sha("e"),
        totalBytes: 10,
        outputFilename: "archive.zip",
      },
    }));
    expect(plan.orderedSourceIds).toEqual(["range_1", "range_2"]);

    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      sources: [ranges[0]!, { ...ranges[1]!, contentRange: { start: 6, endInclusive: 9, total: 10 }, expectedBytes: 4 }],
      assembly: {
        kind: "byte-range",
        sourceIds: ["range_1", "range_2"],
        resourceIdentitySha256: sha("f"),
        validatorValueSha256: sha("e"),
        totalBytes: 10,
        outputFilename: "archive.zip",
      },
    }))).toThrowError(DomainError);

    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      sources: [
        { ...ranges[0]!, validator: undefined } as unknown as CaptureSourceReceipt,
        ranges[1]!,
      ],
      assembly: {
        kind: "byte-range",
        sourceIds: ["range_1", "range_2"],
        resourceIdentitySha256: sha("f"),
        validatorValueSha256: sha("e"),
        totalBytes: 10,
        outputFilename: "archive.zip",
      },
    }))).toThrowError(DomainError);
  });

  it("accepts only finite final HLS/DASH manifests and gap-free parser ordinals", () => {
    const manifest = source("manifest_1", {
      role: "manifest",
      mediaType: "application/vnd.apple.mpegurl",
      manifest: {
        format: "hls",
        kind: "hls-media-playlist",
        parserVersion: "hls-parser-v1",
        manifestContentSha256: sha("6"),
        finite: true,
        final: true,
      },
    });
    const segmentOne = source("segment_1", {
      role: "media-segment",
      mediaType: "video/mp2t",
      ordinal: 0,
      resourceIdentitySha256: sha("7"),
    });
    const segmentTwo = source("segment_2", {
      role: "media-segment",
      mediaType: "video/mp2t",
      ordinal: 1,
      resourceIdentitySha256: sha("8"),
    });
    const plan = createAuthorizedCapturePlan(singlePlanInput({
      sources: [manifest, segmentOne, segmentTwo],
      assembly: {
        kind: "segmented-media",
        format: "hls",
        manifestSourceId: "manifest_1",
        variantIdentitySha256: sha("9"),
        tracks: [{ id: "muxed", kind: "muxed", segmentSourceIds: ["segment_1", "segment_2"] }],
        outputMode: "lossless-remux",
        outputFilename: "lecture.mp4",
      },
    }));
    expect(plan.orderedSourceIds).toEqual(["manifest_1", "segment_1", "segment_2"]);

    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      sources: [manifest, segmentOne, { ...segmentTwo, ordinal: 2 }],
      assembly: {
        kind: "segmented-media",
        format: "hls",
        manifestSourceId: "manifest_1",
        variantIdentitySha256: sha("9"),
        tracks: [{ id: "muxed", kind: "muxed", segmentSourceIds: ["segment_1", "segment_2"] }],
        outputMode: "lossless-remux",
        outputFilename: "lecture.mp4",
      },
    }))).toThrowError(DomainError);

    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      sources: [{
        ...manifest,
        manifest: { ...manifest.manifest!, final: false as true },
      }, segmentOne, segmentTwo],
      assembly: {
        kind: "segmented-media",
        format: "hls",
        manifestSourceId: "manifest_1",
        variantIdentitySha256: sha("9"),
        tracks: [{ id: "muxed", kind: "muxed", segmentSourceIds: ["segment_1", "segment_2"] }],
        outputMode: "lossless-remux",
        outputFilename: "lecture.mp4",
      },
    }))).toThrowError(DomainError);
  });

  it("validates page ordering, highest-observed evidence, and exact non-overlapping tile coverage", () => {
    const documentHash = sha("a");
    const tiles = [
      source("tile_1", { role: "tile", resourceGroupSha256: documentHash, qualityEvidence: "visible-viewer-zoom" }),
      source("tile_2", { role: "tile", resourceGroupSha256: documentHash, qualityEvidence: "visible-viewer-zoom" }),
    ];
    const plan = createAuthorizedCapturePlan(singlePlanInput({
      sources: tiles,
      assembly: {
        kind: "paged-document",
        documentIdentitySha256: documentHash,
        pages: [{
          pageNumber: 1,
          pixelWidth: 200,
          pixelHeight: 100,
          layout: "tiled-raster",
          sourceIds: ["tile_1", "tile_2"],
          placements: [
            { sourceId: "tile_1", x: 0, y: 0, width: 100, height: 100 },
            { sourceId: "tile_2", x: 100, y: 0, width: 100, height: 100 },
          ],
        }],
        qualityPolicy: "highest-observed-authorized-variant",
        outputMode: "lossless-image-pdf",
        outputFilename: "viewer-export.pdf",
      },
    }));
    expect(plan.orderedSourceIds).toEqual(["tile_1", "tile_2"]);

    expect(() => createAuthorizedCapturePlan(singlePlanInput({
      sources: tiles,
      assembly: {
        kind: "paged-document",
        documentIdentitySha256: documentHash,
        pages: [{
          pageNumber: 1,
          pixelWidth: 200,
          pixelHeight: 100,
          layout: "tiled-raster",
          sourceIds: ["tile_1", "tile_2"],
          placements: [
            { sourceId: "tile_1", x: 0, y: 0, width: 120, height: 100 },
            { sourceId: "tile_2", x: 100, y: 0, width: 100, height: 100 },
          ],
        }],
        qualityPolicy: "highest-observed-authorized-variant",
        outputMode: "lossless-image-pdf",
        outputFilename: "viewer-export.pdf",
      },
    }))).toThrowError(DomainError);
  });

  it("rejects completion with reordered inputs, unresolved gaps, wrong toolchain, or lossy transforms", () => {
    const plan = createAuthorizedCapturePlan(singlePlanInput());
    expect(() => createCaptureCompletionReceipt(plan, {
      ...completion(plan),
      id: "another_receipt",
      gaps: ["missing" as never],
    })).toThrowError(DomainError);
    expect(() => createCaptureCompletionReceipt(plan, {
      ...completion(plan),
      id: "another_receipt",
      toolchain: {
        ...completion(plan).toolchain,
        component: "omnia-media-remuxer",
      },
    })).toThrowError(DomainError);
    expect(() => createCaptureCompletionReceipt(plan, {
      ...completion(plan),
      id: "another_receipt",
      toolchain: {
        ...completion(plan).toolchain,
        lossless: false as true,
      },
    })).toThrowError(DomainError);
  });
});
