import { describe, expect, it } from "vitest";

import {
  createBrowserPreviewRuntimeShellPort,
  createBrowserRuntimeDownloadJob,
  createBrowserRuntimeInputBatch,
  createBrowserRuntimeRequestObservation,
  createBrowserRuntimeShellSession,
  createNativeRuntimeShellCapabilityReport,
  transitionBrowserRuntimeDownloadJob,
  transitionBrowserRuntimeShellSession,
  type BrowserRuntimeRequestObservation,
  type BrowserRuntimeShellSession,
  type CreateBrowserRuntimeShellSessionInput,
} from "./omnia-browser-runtime-shell";

const sessionCreatedAt = "2026-10-17T00:00:00.000Z";
const sessionExpiresAt = "2026-10-17T01:00:00.000Z";
const authorizationAcknowledgedAt = "2026-10-16T23:00:00.000Z";
const authorizationExpiresAt = "2026-10-17T02:00:00.000Z";
const inputChannelCreatedAt = "2026-10-17T00:00:00.000Z";
const inputChannelExpiresAt = "2026-10-17T00:30:00.000Z";

const capabilities = [
  "surface-capture",
  "independent-pointer",
  "independent-keyboard",
  "request-metadata",
  "response-body-stream",
  "resumable-downloads",
] as const;

function createSessionInput(overrides: Partial<CreateBrowserRuntimeShellSessionInput> = {}): CreateBrowserRuntimeShellSessionInput {
  return {
    schemaVersion: 1,
    id: "session-1",
    target: {
      kind: "browser-tab",
      targetHandleId: "target-1",
      displayName: "Edge Canary tab",
      browserChannel: "edge-canary",
      tabTargetId: "tab-1",
      origin: "https://example.test",
    },
    executionMode: "visible",
    authorization: {
      id: "authorization-1",
      rightsBasis: "user-owned",
      acknowledgedAt: authorizationAcknowledgedAt,
      expiresAt: authorizationExpiresAt,
      policyVersion: "browser-runtime-v1",
      userPresence: "explicit-session-confirmation",
      credentialsRemainInTarget: true,
      challengeBypassExcluded: true,
      hiddenEndpointMutationExcluded: true,
    },
    requestedCapabilities: [...capabilities],
    grantedCapabilities: [...capabilities],
    surface: {
      width: 1_280,
      height: 720,
      pixelFormat: "rgba8",
      framesPerSecond: 30,
      includeCursor: true,
      includeAudio: false,
    },
    inputChannel: {
      id: "channel-1",
      state: "ready",
      targetSessionId: "session-1",
      isolation: "target-only",
      focusPolicy: "unfocused-when-supported",
      pointer: true,
      keyboard: true,
      automationDisclosure: "always-visible-indicator",
      createdAt: inputChannelCreatedAt,
      expiresAt: inputChannelExpiresAt,
    },
    createdAt: sessionCreatedAt,
    expiresAt: sessionExpiresAt,
    ...overrides,
  };
}

function createSession(overrides: Partial<CreateBrowserRuntimeShellSessionInput> = {}): BrowserRuntimeShellSession {
  return createBrowserRuntimeShellSession(createSessionInput(overrides));
}

function runningSession(): BrowserRuntimeShellSession {
  const requested = createSession();
  const attached = transitionBrowserRuntimeShellSession(requested, { to: "attached", at: "2026-10-17T00:01:00.000Z" });
  return transitionBrowserRuntimeShellSession(attached, { to: "running", at: "2026-10-17T00:02:00.000Z" });
}

function expectRejected(action: () => unknown): void {
  expect(action).toThrow();
}

describe("browser runtime shell session contract", () => {
  it("creates a scoped visible Edge Canary session and freezes its boundary data", () => {
    const session = createSession();

    expect(session.state).toBe("requested");
    expect(session.target.browserChannel).toBe("edge-canary");
    expect(session.inputChannel?.targetSessionId).toBe(session.id);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.target)).toBe(true);
    expect(Object.isFrozen(session.inputChannel)).toBe(true);
  });

  it("fails closed for malformed runtime enums and channel lifetimes", () => {
    expectRejected(() => createSession({ executionMode: "unknown" as never }));
    expectRejected(() => createSession({
      surface: { ...createSessionInput().surface, pixelFormat: "bmp" as never },
    }));
    expectRejected(() => createSession({
      surface: { ...createSessionInput().surface, includeCursor: "yes" as never },
    }));
    expectRejected(() => createSession({
      inputChannel: { ...createSessionInput().inputChannel!, focusPolicy: "global" as never },
    }));
    expectRejected(() => createSession({
      inputChannel: ({
        ...createSessionInput().inputChannel!,
        state: "unavailable",
        unavailableReason: undefined,
      } as unknown) as NonNullable<ReturnType<typeof createSessionInput>["inputChannel"]>,
    }));
    expectRejected(() => createSession({
      inputChannel: { ...createSessionInput().inputChannel!, expiresAt: "2026-10-17T01:01:00.000Z" },
    }));
  });

  it("keeps authorization and lifecycle transitions bounded", () => {
    expectRejected(() => createSession({ expiresAt: "2026-10-17T02:01:00.000Z" }));
    expectRejected(() => createSession({
      executionMode: "headless",
      grantedCapabilities: capabilities.filter((capability) => capability !== "surface-capture"),
    }));

    const attached = transitionBrowserRuntimeShellSession(createSession(), { to: "attached", at: "2026-10-17T00:01:00.000Z" });
    const running = transitionBrowserRuntimeShellSession(attached, { to: "running", at: "2026-10-17T00:02:00.000Z" });
    const paused = transitionBrowserRuntimeShellSession(running, { to: "paused", at: "2026-10-17T00:03:00.000Z" });
    const resumed = transitionBrowserRuntimeShellSession(paused, { to: "running", at: "2026-10-17T00:04:00.000Z" });
    const detached = transitionBrowserRuntimeShellSession(resumed, { to: "detached", at: "2026-10-17T00:05:00.000Z" });

    expect(detached.state).toBe("detached");
    expect(detached.detachedAt).toBe("2026-10-17T00:05:00.000Z");
    expectRejected(() => transitionBrowserRuntimeShellSession(detached, { to: "running", at: "2026-10-17T00:06:00.000Z" }));
  });

  it("rejects raw transport material and unsupported target channels", () => {
    expectRejected(() => createBrowserRuntimeShellSession({ ...createSessionInput(), url: "https://secret.example" } as never));
    expectRejected(() => createBrowserRuntimeShellSession({
      ...createSessionInput(),
      target: { ...createSessionInput().target, browserChannel: "chrome" },
    } as never));
    expectRejected(() => createBrowserRuntimeShellSession({
      ...createSessionInput(),
      authorization: { ...createSessionInput().authorization, challengeBypassExcluded: false } as never,
    }));
  });
});

describe("browser runtime shell isolated input", () => {
  it("accepts bounded pointer/keyboard batches and rejects scope or event violations", () => {
    const session = runningSession();
    const batch = createBrowserRuntimeInputBatch(session, {
      id: "batch-1",
      channelId: "channel-1",
      sequence: 1,
      actions: [
        { type: "pointer", action: { kind: "move", x: 100, y: 200 } },
        { type: "pointer", action: { kind: "button", x: 100, y: 200, button: "left", pressed: true } },
        { type: "keyboard", action: { kind: "key-down", code: "KeyA", modifiers: ["ctrl"] } },
        { type: "keyboard", action: { kind: "text", text: "hello" } },
      ],
      createdAt: "2026-10-17T00:03:00.000Z",
      expiresAt: "2026-10-17T00:04:00.000Z",
      disclosure: "target-input-indicator-visible",
    });

    expect(batch.targetSessionId).toBe(session.id);
    expect(batch.disclosure).toBe("target-input-indicator-visible");
    expect(Object.isFrozen(batch.actions)).toBe(true);

    expectRejected(() => createBrowserRuntimeInputBatch(session, {
      id: "batch-2",
      targetSessionId: "other-session",
      channelId: "channel-1",
      sequence: 2,
      actions: [{ type: "pointer", action: { kind: "move", x: 1, y: 1 } }],
      createdAt: "2026-10-17T00:03:00.000Z",
      expiresAt: "2026-10-17T00:04:00.000Z",
      disclosure: "target-input-indicator-visible",
    }));
    expectRejected(() => createBrowserRuntimeInputBatch(session, {
      id: "batch-3",
      channelId: "channel-1",
      sequence: 3,
      actions: [{ type: "pointer", action: { kind: "move", x: 1_281, y: 1 } }],
      createdAt: "2026-10-17T00:03:00.000Z",
      expiresAt: "2026-10-17T00:04:00.000Z",
      disclosure: "target-input-indicator-visible",
    }));
    expectRejected(() => createBrowserRuntimeInputBatch(session, {
      id: "batch-4",
      channelId: "channel-1",
      sequence: 4,
      actions: [{ type: "pointer", action: { kind: "unknown", x: 1, y: 1 } } as never],
      createdAt: "2026-10-17T00:03:00.000Z",
      expiresAt: "2026-10-17T00:04:00.000Z",
      disclosure: "target-input-indicator-visible",
    }));
    expectRejected(() => createBrowserRuntimeInputBatch(session, {
      id: "batch-5",
      channelId: "channel-1",
      sequence: 5,
      actions: [{ type: "keyboard", action: { kind: "key-down", code: "KeyA", modifiers: ["fn"] } as never }],
      createdAt: "2026-10-17T00:03:00.000Z",
      expiresAt: "2026-10-17T00:04:00.000Z",
      disclosure: "target-input-indicator-visible",
    }));
    expectRejected(() => createBrowserRuntimeInputBatch(session, {
      id: "batch-6",
      channelId: "channel-1",
      sequence: 6,
      actions: [{ type: "pointer", action: { kind: "move", x: 1, y: 1 } }],
      createdAt: "2026-10-17T00:03:00.000Z",
      expiresAt: "2026-10-17T00:04:00.000Z",
      disclosure: "hidden" as never,
    }));
  });
});

describe("browser runtime shell request observations", () => {
  const observation: BrowserRuntimeRequestObservation = {
    schemaVersion: 1,
    id: "observation-1",
    targetSessionId: "session-1",
    observedAt: "2026-10-17T00:05:00.000Z",
    direction: "response",
    method: "GET",
    origin: "https://example.test",
    responseStatus: 206,
    mediaType: "VIDEO/MP4",
    expectedBytes: 100,
    contentRange: { start: 0, endInclusive: 99, total: 100 },
    requestIdentitySha256: "a".repeat(64),
    metadataSha256: "b".repeat(64),
    responseBodyHandleId: "body-1",
    bodyRetention: "broker-only",
  };

  it("keeps observation metadata bounded and canonical", () => {
    const normalized = createBrowserRuntimeRequestObservation(observation);
    expect(normalized.origin).toBe("https://example.test");
    expect(normalized.mediaType).toBe("video/mp4");
    expect(normalized.requestIdentitySha256).toBe("a".repeat(64));
  });

  it("rejects mutation methods, renderer body retention, and non-origin URLs", () => {
    expectRejected(() => createBrowserRuntimeRequestObservation({ ...observation, method: "POST" } as never));
    expectRejected(() => createBrowserRuntimeRequestObservation({ ...observation, bodyRetention: "renderer" } as never));
    expectRejected(() => createBrowserRuntimeRequestObservation({ ...observation, origin: "https://example.test/path" }));
    expectRejected(() => createBrowserRuntimeRequestObservation({ ...observation, url: "https://secret.example" } as never));
  });
});

describe("browser runtime shell downloads and capability ports", () => {
  it("enforces a plain output filename and monotonic resumable progress", () => {
    expectRejected(() => createBrowserRuntimeDownloadJob({
      schemaVersion: 1,
      id: "download-unsafe",
      targetSessionId: "session-1",
      assembly: "single-response",
      sourceObservationIds: ["observation-1"],
      outputFilename: "..\\secret.bin",
      outputMediaType: "application/octet-stream",
      expectedBytes: 100,
      createdAt: sessionCreatedAt,
    }));

    let job = createBrowserRuntimeDownloadJob({
      schemaVersion: 1,
      id: "download-1",
      targetSessionId: "session-1",
      assembly: "byte-range",
      sourceObservationIds: ["observation-1", "observation-2"],
      outputFilename: "clip.bin",
      outputMediaType: "APPLICATION/OCTET-STREAM",
      expectedBytes: 100,
      createdAt: sessionCreatedAt,
    });
    job = transitionBrowserRuntimeDownloadJob(job, { to: "running", at: "2026-10-17T00:01:00.000Z", downloadedBytes: 40 });
    expect(job.progress).toBe(0.4);
    expectRejected(() => transitionBrowserRuntimeDownloadJob(job, { to: "paused", at: "2026-10-17T00:02:00.000Z", downloadedBytes: 39 }));
    job = transitionBrowserRuntimeDownloadJob(job, { to: "paused", at: "2026-10-17T00:02:00.000Z", downloadedBytes: 60 });
    job = transitionBrowserRuntimeDownloadJob(job, { to: "running", at: "2026-10-17T00:03:00.000Z", downloadedBytes: 100 });
    job = transitionBrowserRuntimeDownloadJob(job, {
      to: "completed",
      at: "2026-10-17T00:04:00.000Z",
      downloadedBytes: 100,
      outputContentSha256: "c".repeat(64),
      outputBlobId: "blob-1",
    });

    expect(job.state).toBe("completed");
    expect(job.progress).toBe(1);
    expect(job.outputContentSha256).toBe("c".repeat(64));
    expect(job.outputBlobId).toBe("blob-1");
  });

  it("requires complete terminal evidence and keeps browser preview unavailable", () => {
    const job = createBrowserRuntimeDownloadJob({
      schemaVersion: 1,
      id: "download-2",
      targetSessionId: "session-1",
      assembly: "single-response",
      sourceObservationIds: ["observation-1"],
      outputFilename: "clip.bin",
      outputMediaType: "application/octet-stream",
      expectedBytes: 100,
      createdAt: sessionCreatedAt,
    });
    const running = transitionBrowserRuntimeDownloadJob(job, { to: "running", at: "2026-10-17T00:01:00.000Z", downloadedBytes: 10 });
    expectRejected(() => transitionBrowserRuntimeDownloadJob(running, {
      to: "completed",
      at: "2026-10-17T00:02:00.000Z",
      downloadedBytes: 10,
      outputContentSha256: "d".repeat(64),
      outputBlobId: "blob-2",
    }));
    expectRejected(() => transitionBrowserRuntimeDownloadJob(running, {
      to: "completed",
      at: "2026-10-17T00:02:00.000Z",
      downloadedBytes: 100,
      outputContentSha256: "not-a-hash",
      outputBlobId: "blob-2",
    }));

    const preview = createBrowserPreviewRuntimeShellPort();
    expect(preview.kind).toBe("browser-preview");
    expect(preview.capabilities).toHaveLength(6);
    expect(preview.capabilities.every((capability) => capability.supported === false)).toBe(true);
    expect(createNativeRuntimeShellCapabilityReport(["surface-capture"]).capabilities.find((capability) => capability.capability === "surface-capture")?.supported).toBe(true);
  });
});
