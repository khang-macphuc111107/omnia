import { describe, expect, it } from "vitest";

import {
  createOmniaMediaRuntimeAdapter,
  type MediaRuntimePort,
} from "./omnia-media-runtime-adapter";
import { createOmniaRuntimeController } from "../runtime/omnia-runtime-controller";

const now = "2026-10-17T00:00:00.000Z";
const later = "2026-10-17T00:01:00.000Z";

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    modality: "image" as const,
    operation: "text-to-image" as const,
    prompt: "A technical illustration of a compiler pipeline",
    providerProfileRevisionId: "provider:v1",
    modelProfileRevisionId: "model:v1",
    capabilitySnapshotRevisionId: "capabilities:v1",
    promptRevisionId: "prompt:v1",
    parameters: { aspectRatio: "16:9", width: 1280, height: 720 },
    authority: { policyRevisionId: "policy:v1", watermarkAuthorization: "not-applicable" as const },
    idempotencyKey: "idem:1",
    createdAt: now,
    ...overrides,
  };
}

describe("Omnia media runtime adapter", () => {
  it("creates a durable job and maps it to the shared media queue", () => {
    const controller = createOmniaRuntimeController({ now: () => now });
    const adapter = createOmniaMediaRuntimeAdapter({ controller, now: () => now });

    const record = adapter.create(createInput());

    expect(record.job.status).toBe("queued");
    expect(record.queueItemId).toMatch(/^media_/);
    expect(controller.getSnapshot().media.items[0]).toMatchObject({
      id: record.queueItemId,
      kind: "image",
      prompt: "A technical illustration of a compiler pipeline",
      status: "queued",
      progress: 0,
    });
    expect(adapter.inspect(record.job.jobId)).toEqual(record);
  });

  it("keeps native actions explicitly unavailable in browser/runtime preview", async () => {
    const adapter = createOmniaMediaRuntimeAdapter({ now: () => now });
    const record = adapter.create(createInput());

    await expect(adapter.inspectCapabilities()).resolves.toEqual({
      status: "unavailable",
      reason: "Media capability inspection is not connected to a native runtime.",
    });
    await expect(adapter.dispatch(record.job.jobId)).resolves.toMatchObject({
      ok: false,
      code: "media_runtime_unavailable",
    });
    await expect(adapter.cancel(record.job.jobId)).resolves.toMatchObject({
      ok: false,
      code: "media_runtime_unavailable",
    });
    await expect(adapter.reconcile(record.job.jobId)).resolves.toMatchObject({
      ok: false,
      code: "media_runtime_unavailable",
    });
  });

  it("projects local lifecycle changes into queue state without provider acceptance", () => {
    const controller = createOmniaRuntimeController({ now: () => now });
    const adapter = createOmniaMediaRuntimeAdapter({ controller, now: () => now });
    const record = adapter.create(createInput());

    const running = adapter.transition(record.job.jobId, "generating", { updatedAt: later, progress: 0.4 });
    expect(running.ok).toBe(true);
    if (!running.ok) return;
    expect(running.value.job.providerAcceptance).toBe("not-sent");
    expect(controller.getSnapshot().media.items[0]).toMatchObject({ status: "running", progress: 0.4 });

    expect(adapter.transition(record.job.jobId, "post-processing", { updatedAt: later, progress: 0.8 }).ok).toBe(true);
    const cancelled = adapter.transition(record.job.jobId, "failed", { updatedAt: later, error: "preview failure" });
    expect(cancelled.ok).toBe(true);
    expect(controller.getSnapshot().media.items[0]).toMatchObject({ status: "failed", error: "preview failure" });
  });

  it("accepts a native dispatch receipt through an injected port", async () => {
    const port: MediaRuntimePort = {
      dispatch: async () => ({ ok: true, value: { providerJobHandle: "provider-job-1", acceptedAt: later } }),
    };
    const adapter = createOmniaMediaRuntimeAdapter({ port, now: () => now });
    const record = adapter.create(createInput());

    const dispatched = await adapter.dispatch(record.job.jobId);
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) return;
    expect(dispatched.value.job.status).toBe("accepted");
    expect(dispatched.value.job.providerAcceptance).toBe("accepted");
    expect(dispatched.value.job.providerJobHandle).toBe("provider-job-1");
  });

  it("serializes and imports adapter records without exposing provider bytes", () => {
    const adapter = createOmniaMediaRuntimeAdapter({ now: () => now });
    const record = adapter.create(createInput());
    const encoded = adapter.serialize();
    expect(encoded).toContain(record.job.jobId);
    expect(encoded).not.toContain("provider-job");

    const restored = createOmniaMediaRuntimeAdapter({ now: () => now });
    expect(restored.import(encoded)).toEqual({ ok: true, value: 1 });
    expect(restored.inspect(record.job.jobId)).toEqual(record);
  });
});
