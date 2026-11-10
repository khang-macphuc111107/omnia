import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ComposerAttachmentAdmissionReview } from "./composer-attachment-admission-review";
import { resolveRoutedProviderModel } from "./provider-parameters";
import type { ComposerAttachmentItem } from "./composer-attachments";
import type { ModelProfileView, ProviderView } from "./types";

function route() {
  const model: ModelProfileView = {
    id: "model_admission_component",
    connectionId: "provider_admission_component",
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
    id: "provider_admission_component",
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
    id: "attachment_admission_component",
    name: "diagram.png",
    kind: "image",
    mediaType: "image/png",
    sizeLabel: "2 KB",
    state: "ready",
    ...overrides,
  };
}

describe("ComposerAttachmentAdmissionReview", () => {
  it("shows gate detail and a clear preview boundary", () => {
    render(<ComposerAttachmentAdmissionReview attachments={[attachment()]} route={route()} />);
    expect(screen.getByRole("region", { name: "Attachment admission review" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Admission review" })).toBeInTheDocument();
    expect(screen.getByText("Frozen dispatch input")).toBeInTheDocument();
    expect(screen.getByText(/Native admission, carrier upload, provider acceptance, and dispatch remain gated/i)).toBeInTheDocument();
  });

  it("switches the selected record and changes report format", () => {
    render(<ComposerAttachmentAdmissionReview attachments={[attachment(), attachment({ id: "attachment_second", name: "notes.md", kind: "document", mediaType: "text/markdown" })]} route={route()} />);
    fireEvent.click(screen.getByRole("button", { name: /Attachment 2/i }));
    expect(screen.getAllByText("document · Needs review").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("combobox", { name: "Attachment admission report format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("combobox", { name: "Attachment admission report format" })).toHaveValue("markdown");
  });

  it("keeps copy fail-closed when clipboard is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(<ComposerAttachmentAdmissionReview attachments={[attachment()]} route={route()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText(/Clipboard access is unavailable/i)).toBeInTheDocument();
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
  });
});
