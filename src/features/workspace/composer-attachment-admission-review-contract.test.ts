import { describe, expect, it } from "vitest";

import { resolveRoutedProviderModel } from "./provider-parameters";
import {
  reviewComposerAttachmentAdmission,
  serializeAttachmentAdmissionReview,
  summarizeAttachmentAdmission,
} from "./composer-attachment-admission-review-contract";
import type { ComposerAttachmentItem } from "./composer-attachments";
import type { ModelProfileView, ProviderView } from "./types";

function route(capabilities: ModelProfileView["capabilities"] = ["vision"]) {
  const model: ModelProfileView = {
    id: "model_admission_review",
    connectionId: "provider_admission_review",
    displayName: "Vision model",
    providerName: "Native provider",
    providerModelId: "vision-model",
    status: "available",
    capabilities,
    contextLabel: "128K context",
    speed: "Balanced",
    favorite: false,
  };
  const provider: ProviderView = {
    id: "provider_admission_review",
    name: "Native provider",
    kind: "OpenAI",
    providerType: "openai",
    endpoint: "https://example.com/v1",
    authScheme: "bearer",
    state: "connected",
    modelCount: 1,
    enabled: true,
    credentialState: "present",
    source: "native",
    organizationId: null,
    remoteProjectId: null,
    lastCheckedAt: null,
    latencyMs: null,
    errorMessage: null,
    models: [model],
  };
  return resolveRoutedProviderModel([provider], model);
}

function attachment(overrides: Partial<ComposerAttachmentItem> = {}): ComposerAttachmentItem {
  return {
    id: "attachment_admission_review",
    name: "diagram.png",
    kind: "image",
    mediaType: "image/png",
    sizeLabel: "2 KB",
    state: "ready",
    ...overrides,
  };
}

describe("composer attachment admission review contract", () => {
  it("keeps a ready vision item planned until frozen native dispatch evidence exists", () => {
    const [review] = reviewComposerAttachmentAdmission([attachment()], route());
    expect(review?.decision).toBe("planned");
    expect(review?.gates.map((gate) => gate.status)).toEqual(["pass", "pass", "pass", "planned", "planned"]);
    expect(review?.boundary).toMatch(/No file bytes/i);
  });

  it("blocks browser previews before route or carrier review", () => {
    const [review] = reviewComposerAttachmentAdmission([attachment({ state: "preview" })], route());
    expect(review?.decision).toBe("blocked");
    expect(review?.gates.find((gate) => gate.id === "extraction")?.status).toBe("blocked");
  });

  it("blocks a modality when the selected model lacks the required capability", () => {
    const [review] = reviewComposerAttachmentAdmission([attachment()], route([]));
    expect(review?.decision).toBe("blocked");
    expect(review?.gates.find((gate) => gate.id === "modality")?.detail).toMatch(/vision capability/i);
  });

  it("summarizes review decisions and keeps dispatch gated", () => {
    const reviews = reviewComposerAttachmentAdmission([
      attachment(),
      attachment({ id: "attachment_admission_preview", state: "preview" }),
    ], route());
    expect(summarizeAttachmentAdmission(reviews)).toMatchObject({ total: 2, planned: 1, blocked: 1, dispatchGated: true });
  });

  it("serializes a content-free JSON and Markdown report", () => {
    const reviews = reviewComposerAttachmentAdmission([attachment()], route());
    const json = serializeAttachmentAdmissionReview(reviews, "json");
    const markdown = serializeAttachmentAdmissionReview(reviews, "markdown");
    expect(JSON.parse(json)).toMatchObject({ schema: "omnia.composer.attachment-admission.preview.v1", scope: "renderer-session" });
    expect(json).not.toMatch(/blob:|https:\/\/example\.com/);
    expect(markdown).toContain("# Attachment admission review");
  });
});
