import { describe, expect, it } from "vitest";

import {
  endpointBuilderPresets,
  endpointRoutePreview,
  normalizeEndpointBaseUrl,
  validateEndpointBuilder,
  type EndpointBuilderInput,
} from "./provider-endpoint-builder";

const baseInput: EndpointBuilderInput = {
  name: "Demo endpoint",
  protocolFamily: "openai-responses",
  apiVersion: "v1",
  baseUrl: "https://api.example.test/v1/",
  transport: "sse",
  authScheme: "bearer",
  modelHint: "gpt-demo",
  operations: ["responses", "stream-content", "models"],
};

describe("provider endpoint builder contract", () => {
  it("normalizes and validates a safe remote endpoint without treating it as live evidence", () => {
    expect(normalizeEndpointBaseUrl(" https://api.example.test/v1/// ")).toBe("https://api.example.test/v1");
    const result = validateEndpointBuilder(baseInput);
    expect(result.normalizedBaseUrl).toBe("https://api.example.test/v1");
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("fails closed for credential-bearing or insecure remote URLs", () => {
    const credentialUrl = validateEndpointBuilder({ ...baseInput, baseUrl: "https://user:secret@example.test/v1" });
    expect(credentialUrl.valid).toBe(false);
    expect(credentialUrl.issues.some((issue) => issue.field === "baseUrl" && issue.severity === "error")).toBe(true);

    const insecureRemote = validateEndpointBuilder({ ...baseInput, baseUrl: "http://api.example.test/v1" });
    expect(insecureRemote.valid).toBe(false);
  });

  it("allows explicit local HTTP and previews protocol-aware routes", () => {
    const local = validateEndpointBuilder({ ...baseInput, baseUrl: "http://127.0.0.1:11434/" });
    expect(local.valid).toBe(true);

    const routes = endpointRoutePreview({
      ...baseInput,
      protocolFamily: "google-gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
      operations: ["generate-content", "stream-content", "models"],
      modelHint: "gemini-demo",
    });
    expect(routes.map((route) => route.path)).toEqual([
      "/models/gemini-demo:generateContent",
      "/models/gemini-demo:streamGenerateContent",
      "/models",
    ]);
    expect(routes[1]?.stream).toBe(true);
    expect(routes[0]?.absoluteUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-demo:generateContent");
  });

  it("keeps the preset catalog provider-neutral and operation-scoped", () => {
    expect(endpointBuilderPresets.length).toBeGreaterThanOrEqual(6);
    expect(endpointBuilderPresets.map((preset) => preset.id)).toEqual(expect.arrayContaining(["openai-responses", "anthropic-messages", "google-gemini", "ollama-local", "custom-adapter"]));
    expect(endpointBuilderPresets.every((preset) => preset.operations.length > 0)).toBe(true);
  });
});

