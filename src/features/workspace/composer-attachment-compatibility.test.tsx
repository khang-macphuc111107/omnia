import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { resolveRoutedProviderModel } from "./provider-parameters";
import { ComposerAttachmentCompatibility } from "./composer-attachment-compatibility";
import type { ComposerAttachmentItem } from "./composer-attachments";
import type { ModelProfileView, ProviderView } from "./types";

function route() {
  const model: ModelProfileView = {
    id: "model_compatibility_ui",
    connectionId: "provider_compatibility_ui",
    displayName: "Vision model",
    providerName: "Native provider",
    providerModelId: "vision-model",
    status: "available",
    capabilities: ["vision"],
    contextLabel: "128K context",
    speed: "Balanced",
    favorite: false,
  };
  const provider: ProviderView = {
    id: "provider_compatibility_ui",
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
    id: "attachment_ui",
    name: "diagram.png",
    kind: "image",
    mediaType: "image/png",
    sizeLabel: "12 KB",
    state: "ready",
    ...overrides,
  };
}

describe("composer attachment compatibility preview", () => {
  it("shows selected route and catalog-compatible image signals", () => {
    render(<ComposerAttachmentCompatibility attachments={[attachment()]} route={route()} />);

    expect(screen.getByRole("region", { name: "Attachment compatibility preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Compatibility preview" })).toBeInTheDocument();
    expect(screen.getByText("Native provider · Vision model")).toBeInTheDocument();
    expect(screen.getByText("Catalog compatible")).toBeInTheDocument();
    expect(screen.getByText(/upload, carrier planning, and dispatch remain gated/i)).toBeInTheDocument();
  });

  it("keeps browser previews visibly separate from route compatibility", () => {
    render(
      <ComposerAttachmentCompatibility
        attachments={[attachment({ state: "preview", previewUrl: "blob:preview", previewType: "image" })]}
        route={route()}
      />,
    );

    expect(screen.getAllByText("Preview only").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/cannot be uploaded or sent/i)).toBeInTheDocument();
  });

  it("renders a blocked no-route state without inventing provider evidence", () => {
    render(<ComposerAttachmentCompatibility attachments={[attachment()]} route={null} />);

    expect(screen.getByText("No provider model selected")).toBeInTheDocument();
    expect(screen.getByText("No route")).toBeInTheDocument();
    expect(screen.getByText(/Choose a provider model/i)).toBeInTheDocument();
  });
});
