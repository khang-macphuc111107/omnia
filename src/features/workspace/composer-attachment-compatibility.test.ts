import { describe, expect, it } from "vitest";

import { resolveRoutedProviderModel } from "./provider-parameters";
import {
  assessComposerAttachmentCompatibility,
  composerAttachmentCompatibilityKind,
  composerAttachmentCompatibilityReason,
  summarizeComposerAttachmentCompatibility,
} from "./composer-attachment-compatibility-contract";
import type { ComposerAttachmentItem } from "./composer-attachments";
import type { ModelProfileView, ProviderView } from "./types";

function provider(
  state: ProviderView["state"] = "connected",
  capabilities: ModelProfileView["capabilities"] = ["vision", "audio"],
): ProviderView {
  const model: ModelProfileView = {
    id: "model_compatibility",
    connectionId: "provider_compatibility",
    displayName: "Multimodal model",
    providerName: "Native provider",
    providerModelId: "multimodal-model",
    status: "available",
    capabilities,
    contextLabel: "128K context",
    speed: "Balanced",
    favorite: false,
  };
  return {
    id: "provider_compatibility",
    name: "Native provider",
    kind: "OpenAI",
    providerType: "openai",
    endpoint: "https://example.com/v1",
    authScheme: "bearer",
    state,
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
}

function attachment(patch: Partial<ComposerAttachmentItem> = {}): ComposerAttachmentItem {
  return {
    id: "attachment_compatibility",
    name: "diagram.png",
    kind: "image",
    mediaType: "image/png",
    sizeLabel: "12 KB",
    state: "ready",
    ...patch,
  };
}

describe("composer attachment compatibility contract", () => {
  it("maps MIME and preview hints to the right modality", () => {
    expect(composerAttachmentCompatibilityKind(attachment())).toBe("image");
    expect(composerAttachmentCompatibilityKind(attachment({ kind: "document", mediaType: "video/webm" }))).toBe("video");
    expect(composerAttachmentCompatibilityKind(attachment({ kind: "document", mediaType: "audio/wav" }))).toBe("audio");
    expect(composerAttachmentCompatibilityKind(attachment({ kind: "code", mediaType: "text/plain" }))).toBe("document");
  });

  it("shows a catalog-compatible image while keeping dispatch gated", () => {
    const route = resolveRoutedProviderModel([provider()], provider().models[0]);
    const rows = assessComposerAttachmentCompatibility([attachment()], route);
    expect(rows[0]).toMatchObject({ status: "compatible", label: "Catalog compatible", capability: "vision" });
    expect(rows[0]?.detail).toMatch(/dispatch remain separately gated/i);
    expect(summarizeComposerAttachmentCompatibility(rows)).toMatchObject({
      total: 1,
      compatible: 1,
      dispatchGated: true,
    });
  });

  it("keeps browser previews explicit and blocks missing capabilities", () => {
    const noVision = provider("connected", ["audio"]);
    const route = resolveRoutedProviderModel([noVision], noVision.models[0]);
    const rows = assessComposerAttachmentCompatibility([
      attachment({ id: "browser_preview", state: "preview" }),
      attachment({ id: "missing_capability" }),
    ], route);
    expect(rows.map((row) => row.status)).toEqual(["preview-only", "blocked"]);
    const summary = summarizeComposerAttachmentCompatibility(rows);
    expect(summary.previewOnly).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(composerAttachmentCompatibilityReason(summary)).toMatch(/browser-preview/i);
  });

  it("requires review for document and video carrier paths", () => {
    const route = resolveRoutedProviderModel([provider()], provider().models[0]);
    const rows = assessComposerAttachmentCompatibility([
      attachment({ id: "document", kind: "document", mediaType: "application/pdf", name: "paper.pdf" }),
      attachment({ id: "video", kind: "document", mediaType: "video/mp4", name: "demo.mp4" }),
    ], route);
    expect(rows.map((row) => row.status)).toEqual(["review", "review"]);
    expect(rows[0]?.detail).toMatch(/carrier plan/i);
    expect(rows[1]?.detail).toMatch(/video carrier/i);
  });

  it("blocks a ready attachment when no provider route exists", () => {
    const rows = assessComposerAttachmentCompatibility([attachment()], null);
    expect(rows[0]).toMatchObject({ status: "blocked", label: "No route" });
  });
});
