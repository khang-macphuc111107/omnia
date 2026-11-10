import { describe, expect, it } from "vitest";

import {
  findOmniaCatalogProvider,
  listOmniaCatalogModels,
  mergeOmniaProviderCatalog,
  OMNIA_BUNDLED_PROVIDER_CATALOG,
  validateOmniaProviderCatalog,
} from "./omnia-provider-catalog";

describe("omnia provider catalog", () => {
  it("ships broad static families without treating them as live evidence", () => {
    validateOmniaProviderCatalog(OMNIA_BUNDLED_PROVIDER_CATALOG);
    expect(OMNIA_BUNDLED_PROVIDER_CATALOG.providers.length).toBeGreaterThan(10);
    const models = listOmniaCatalogModels();
    expect(models.every((model) => model.catalogOnly)).toBe(true);
    expect(models.some((model) => model.capabilities.includes("video-generation"))).toBe(true);
    expect(models.some((model) => model.capabilities.includes("speech-to-text"))).toBe(true);
    expect(models.some((model) => model.capabilities.includes("text-to-speech"))).toBe(true);
  });

  it("resolves provider aliases and capability filters", () => {
    expect(findOmniaCatalogProvider("gemini")?.id).toBe("google");
    expect(findOmniaCatalogProvider("local-ollama")?.id).toBe("ollama");
    expect(findOmniaCatalogProvider("unknown-provider")).toBeUndefined();
    expect(listOmniaCatalogModels(OMNIA_BUNDLED_PROVIDER_CATALOG, "embeddings")
      .every((model) => model.capabilities.includes("embeddings"))).toBe(true);
  });

  it("replaces custom entries by id while preserving the catalog contract", () => {
    const custom = {
      id: "custom-lab",
      label: "Custom lab",
      family: "llm" as const,
      aliases: ["lab"],
      transports: ["custom"] as const,
      capabilities: ["chat"] as const,
      models: [{
        id: "lab-model",
        label: "Lab model",
        family: "llm" as const,
        capabilities: ["chat"] as const,
        catalogOnly: true as const,
      }],
      source: "bundled-static" as const,
      revision: "local",
    };
    const merged = mergeOmniaProviderCatalog(OMNIA_BUNDLED_PROVIDER_CATALOG, [custom]);
    expect(findOmniaCatalogProvider("lab", merged)?.label).toBe("Custom lab");
    expect(listOmniaCatalogModels(merged).some((model) => model.id === "lab-model")).toBe(true);
  });
});

