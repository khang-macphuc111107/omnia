import { describe, expect, it } from "vitest";

import {
  createProviderRegistry,
  deserializeProviderRegistry,
  normalizeProviderModel,
  listProviderModelsByOperation,
  modelSupportsOperation,
  removeProviderModel,
  resolveProviderModelForOperation,
  selectProvider,
  serializeProviderRegistry,
  setProviderModelEnabled,
  validateProviderRegistry,
  type ProviderDefinition,
  type ProviderModelCapability,
  type ProviderModel,
} from "./omnia-provider-registry";

function model(id: string, enabled = true): ProviderModel {
  return {
    id,
    label: id,
    capabilities: ["chat"],
    enabled,
  };
}

function provider(id: string, models: readonly ProviderModel[] = [model("model-a")]): ProviderDefinition {
  return {
    id,
    name: id,
    kind: "openai",
    endpoint: {
      baseUrl: "https://api.example.com/v1",
      protocol: "responses",
      auth: "bearer",
    },
    models,
    enabled: true,
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
}

describe("omnia provider registry contract", () => {
  it("rejects provider IDs that collide after normalization", () => {
    const registry = {
      version: 1 as const,
      providers: [provider("provider-a"), provider(" provider-a ")],
    };

    expect(() => validateProviderRegistry(registry)).toThrow(/Provider ids/);
    expect(() => createProviderRegistry(registry.providers)).toThrow(/Provider ids/);
  });

  it("canonicalizes selected model IDs and accepts normalized model operation inputs", () => {
    const registry = createProviderRegistry([
      {
        ...provider(" provider-a ", [model(" model-a "), model("model-b")]),
        selectedModelId: " model-a ",
      },
    ]);

    expect(registry.providers[0]?.id).toBe("provider-a");
    expect(registry.providers[0]?.selectedModelId).toBe("model-a");

    const selected = selectProvider(registry, " provider-a ", " model-a ");
    expect(selected.selectedProviderId).toBe("provider-a");
    expect(selected.providers[0]?.selectedModelId).toBe("model-a");

    const disabled = setProviderModelEnabled(selected, " provider-a ", " model-a ", false);
    expect(disabled.providers[0]?.selectedModelId).toBe("model-b");
    expect(() => selectProvider(disabled, "provider-a", " model-a ")).toThrow(/disabled/i);

    const removed = removeProviderModel(disabled, " provider-a ", " model-b ");
    expect(removed.providers[0]?.models.map((item) => item.id)).toEqual(["model-a"]);
    expect(removed.providers[0]?.selectedModelId).toBeUndefined();
  });

  it("round-trips the canonical registry through JSON", () => {
    const registry = selectProvider(createProviderRegistry([
      {
        ...provider("provider-a", [normalizeProviderModel(model("model-a"))]),
        selectedModelId: " model-a ",
      },
    ]), "provider-a");

    expect(deserializeProviderRegistry(serializeProviderRegistry(registry))).toEqual(registry);
  });

  it("normalizes and routes richer multimodal model profiles", () => {
    const profileCapabilities: ProviderModelCapability[] = [
      { operation: "image-generation", direction: "output", support: "native", outputModalities: ["image"] },
      { operation: "speech-to-text", direction: "input", support: "adapter", inputModalities: ["audio"] },
      { operation: "text-to-speech", direction: "output", support: "preview", outputModalities: ["audio"] },
      { operation: "video-generation", direction: "output", support: "native", outputModalities: ["video"] },
      { operation: "embedding", direction: "output", support: "native", outputModalities: ["embedding"] },
    ];
    const multimodal = normalizeProviderModel({
      ...model("multimodal"),
      modalityProfile: { version: 1, capabilities: profileCapabilities },
    });

    expect(multimodal.modalityProfile?.capabilities).toHaveLength(5);
    expect(modelSupportsOperation(multimodal, "image-generation")).toBe(true);
    expect(modelSupportsOperation(multimodal, "speech-to-text")).toBe(true);
    expect(modelSupportsOperation(multimodal, "text-to-speech")).toBe(false);
    expect(modelSupportsOperation(multimodal, "text-to-speech", { includePreview: true })).toBe(true);
    expect(modelSupportsOperation(multimodal, "chat")).toBe(true);
  });

  it("omits absent modality capability optionals under exact-optional semantics", () => {
    const normalized = normalizeProviderModel({
      ...model("minimal-profile"),
      modalityProfile: {
        version: 1,
        // This simulates an untrusted JSON object that explicitly carries
        // undefined values.  The typed API intentionally rejects that shape
        // under exactOptionalPropertyTypes; normalization must still strip it
        // at the runtime boundary.
        capabilities: [{
          operation: "chat",
          direction: "bidirectional",
          support: "native",
          inputModalities: undefined,
          outputModalities: undefined,
          inputMimeTypes: undefined,
          outputMimeTypes: undefined,
          maxInputBytes: undefined,
          maxOutputBytes: undefined,
          maxDurationSeconds: undefined,
          notes: undefined,
        } as unknown as ProviderModelCapability],
      },
    });

    const capability = normalized.modalityProfile?.capabilities[0];
    expect(capability).toBeDefined();
    expect(Object.hasOwn(capability!, "inputModalities")).toBe(false);
    expect(Object.hasOwn(capability!, "outputModalities")).toBe(false);
    expect(Object.hasOwn(capability!, "inputMimeTypes")).toBe(false);
    expect(Object.hasOwn(capability!, "outputMimeTypes")).toBe(false);
    expect(Object.hasOwn(capability!, "maxInputBytes")).toBe(false);
    expect(Object.hasOwn(capability!, "maxOutputBytes")).toBe(false);
    expect(Object.hasOwn(capability!, "maxDurationSeconds")).toBe(false);
    expect(Object.hasOwn(capability!, "notes")).toBe(false);
  });

  it("rejects malformed or duplicate modality capability entries", () => {
    expect(() => normalizeProviderModel({
      ...model("bad-operation"),
      modalityProfile: {
        version: 1,
        capabilities: [{ operation: "not-real", direction: "output", support: "native" } as never],
      },
    })).toThrow(/modality capability/i);

    expect(() => normalizeProviderModel({
      ...model("duplicate"),
      modalityProfile: {
        version: 1,
        capabilities: [
          { operation: "chat", direction: "input", support: "native" },
          { operation: "chat", direction: "input", support: "adapter" },
        ],
      },
    })).toThrow(/must not contain duplicates/i);

    expect(() => normalizeProviderModel({
      ...model("bad-mime"),
      modalityProfile: {
        version: 1,
        capabilities: [{ operation: "vision", direction: "input", support: "native", inputMimeTypes: ["not a mime"] }],
      },
    })).toThrow(/canonical MIME/i);
  });

  it("keeps unsupported and unknown capabilities out of routes unless explicitly requested", () => {
    const catalog = createProviderRegistry([
      provider("provider-a", [normalizeProviderModel({
        ...model("catalog"),
        modalityProfile: {
          version: 1,
          capabilities: [
            { operation: "image-generation", direction: "output", support: "unsupported" },
            { operation: "video-generation", direction: "output", support: "unknown" },
          ],
        },
      })]),
    ]);

    expect(listProviderModelsByOperation(catalog, "image-generation")).toHaveLength(0);
    expect(listProviderModelsByOperation(catalog, "video-generation")).toHaveLength(0);
    expect(listProviderModelsByOperation(catalog, "video-generation", { includeUnknown: true })).toHaveLength(1);
  });

  it("uses selected provider/model before deterministic registry fallback", () => {
    const selectedModel = normalizeProviderModel({ ...model("selected"), modalityProfile: { version: 1, capabilities: [{ operation: "image-generation", direction: "output", support: "native" }] } });
    const fallbackModel = normalizeProviderModel({ ...model("fallback"), modalityProfile: { version: 1, capabilities: [{ operation: "image-generation", direction: "output", support: "native" }] } });
    const base = createProviderRegistry([
      provider("provider-a", [selectedModel]),
      provider("provider-b", [fallbackModel]),
    ]);
    const selected = selectProvider(base, "provider-a", "selected");
    expect(resolveProviderModelForOperation(selected, "image-generation")?.model.id).toBe("selected");
    expect(resolveProviderModelForOperation(base, "image-generation")?.model.id).toBe("selected");

    const disabled = setProviderModelEnabled(selected, "provider-a", "selected", false);
    expect(resolveProviderModelForOperation(disabled, "image-generation")?.model.id).toBe("fallback");
    expect(listProviderModelsByOperation(disabled, "image-generation", { includeDisabled: true })).toHaveLength(2);
  });
});
