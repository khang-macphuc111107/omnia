import { describe, expect, it } from "vitest";

import {
  preflightProviderParameters,
  resolveRoutedProviderModel,
  supportsProviderParameter,
} from "./provider-parameters";
import type {
  ModelProfileView,
  ParameterSettings,
  ProviderKind,
  ProviderView,
} from "./types";

const defaultParameters: ParameterSettings = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  minP: 0,
  maxOutputTokens: 4096,
  reasoningEffort: "medium",
  reasoningBudgetTokens: null,
  frequencyPenalty: 0,
  presencePenalty: 0,
  seed: null,
  stopSequences: "",
  streaming: true,
  jsonMode: false,
  jsonSchema: "",
  logprobs: false,
  topLogprobs: 0,
  parallelToolCalls: true,
  promptCaching: true,
  toolChoice: "auto",
  serviceTier: "auto",
  timeoutMs: 120000,
  maxRetries: 2,
  providerExtensions: "{}",
};

function model(
  providerId: string,
  capabilities: ModelProfileView["capabilities"] = [],
): ModelProfileView {
  return {
    id: `${providerId}:model`,
    connectionId: providerId,
    displayName: "Model",
    providerName: "Provider",
    providerModelId: "model",
    status: "available",
    capabilities,
    contextLabel: "128K context",
    speed: "Balanced",
    favorite: false,
  };
}

function provider(
  id: string,
  providerType: string,
  kind: ProviderKind,
  capabilities: ModelProfileView["capabilities"] = [],
): ProviderView {
  const routedModel = model(id, capabilities);
  return {
    id,
    name: `${kind} test`,
    kind,
    providerType,
    endpoint: kind === "Local" ? "http://127.0.0.1:11434/v1" : "https://example.com/v1",
    authScheme: kind === "Local" ? "none" : "bearer",
    state: "connected",
    modelCount: 1,
    enabled: true,
    credentialState: kind === "Local" ? "not-required" : "present",
    source: "native",
    organizationId: null,
    remoteProjectId: null,
    lastCheckedAt: null,
    latencyMs: null,
    errorMessage: null,
    models: [routedModel],
  };
}

describe("provider parameter preflight", () => {
  it("uses the concrete routed model for Auto instead of asserting every capability", () => {
    const openAi = provider("openai-provider", "openai", "OpenAI", []);
    const auto: ModelProfileView = {
      ...model("unused", ["reasoning", "json"]),
      id: "auto",
      connectionId: null,
    };

    const route = resolveRoutedProviderModel([openAi], auto);

    expect(route?.model.id).toBe("openai-provider:model");
    expect(supportsProviderParameter(route, "reasoning")).toBe(false);
    expect(supportsProviderParameter(route, "json")).toBe(false);
  });

  it("fails closed when an explicit model belongs to a stale or non-runnable provider route", () => {
    const configurationOnly = provider("configuration-only", "openai", "OpenAI");
    configurationOnly.state = "configuration-validated";
    expect(resolveRoutedProviderModel([configurationOnly], configurationOnly.models[0])).toBeNull();

    const disabled = provider("disabled", "openai", "OpenAI");
    disabled.enabled = false;
    expect(resolveRoutedProviderModel([disabled], disabled.models[0])).toBeNull();

    const degradedModelProvider = provider("degraded-model", "openai", "OpenAI");
    degradedModelProvider.models = [
      { ...degradedModelProvider.models[0]!, status: "degraded" },
    ];
    expect(resolveRoutedProviderModel([degradedModelProvider], degradedModelProvider.models[0])).toBeNull();

    const refreshedProvider = provider("refreshed", "openai", "OpenAI");
    const staleModel = { ...refreshedProvider.models[0]!, id: "refreshed:stale" };
    expect(resolveRoutedProviderModel([refreshedProvider], staleModel)).toBeNull();
  });

  it("does not send Top K to OpenAI-compatible adapters", () => {
    const connection = provider("openai-provider", "openai_compatible", "OpenAI-compatible", ["json"]);
    const route = resolveRoutedProviderModel([connection], connection.models[0]);
    expect(route).not.toBeNull();

    const result = preflightProviderParameters(defaultParameters, route!);

    expect(result.errors).toEqual([]);
    expect(result.parameters).not.toHaveProperty("topK");
  });

  it("routes DeepSeek through the OpenAI-compatible parameter family", () => {
    const connection = provider("deepseek-provider", "deepseek", "OpenAI-compatible", ["json"]);
    const route = resolveRoutedProviderModel([connection], connection.models[0]);
    expect(route?.family).toBe("openai-chat");

    const result = preflightProviderParameters(defaultParameters, route!);
    expect(result.errors).toEqual([]);
    expect(result.parameters).not.toHaveProperty("topK");
  });

  it("rejects an explicitly changed Top K for OpenAI instead of silently dropping it", () => {
    const connection = provider("openai-provider", "openai", "OpenAI");
    const route = resolveRoutedProviderModel([connection], connection.models[0]);

    const result = preflightProviderParameters({ ...defaultParameters, topK: 64 }, route!);

    expect(result.errors.join(" ")).toContain("Top K");
    expect(result.parameters).not.toHaveProperty("topK");
  });

  it.each([
    ["openai", "OpenAI"],
    ["anthropic", "Anthropic"],
    ["gemini", "Gemini"],
  ] as const)("rejects Seed for %s before dispatch", (providerType, kind) => {
    const connection = provider(`${providerType}-provider`, providerType, kind);
    const route = resolveRoutedProviderModel([connection], connection.models[0]);

    const result = preflightProviderParameters({ ...defaultParameters, seed: 42 }, route!);

    expect(result.errors.join(" ")).toContain("Seed");
    expect(result.parameters).not.toHaveProperty("seed");
  });

  it("keeps Responses-only OpenAI routes from sending Chat Completions stop fields", () => {
    const connection = provider("openai-provider", "openai", "OpenAI");
    const route = resolveRoutedProviderModel([connection], connection.models[0]);

    const result = preflightProviderParameters(
      { ...defaultParameters, stopSequences: "DONE" },
      route!,
    );

    expect(result.errors.join(" ")).toContain("Stop sequences");
    expect(result.parameters).not.toHaveProperty("stop");
  });

  it("sends reasoning only when the routed model advertises it", () => {
    const plain = provider("plain", "openai", "OpenAI");
    const reasoning = provider("reasoning", "openai", "OpenAI", ["reasoning"]);

    const plainResult = preflightProviderParameters(
      { ...defaultParameters, reasoningEffort: "high" },
      resolveRoutedProviderModel([plain], plain.models[0])!,
    );
    const reasoningResult = preflightProviderParameters(
      { ...defaultParameters, reasoningEffort: "high" },
      resolveRoutedProviderModel([reasoning], reasoning.models[0])!,
    );

    expect(plainResult.errors.join(" ")).toContain("Reasoning effort");
    expect(plainResult.parameters).not.toHaveProperty("reasoningEffort");
    expect(reasoningResult.errors).toEqual([]);
    expect(reasoningResult.parameters.reasoningEffort).toBe("high");
  });

  it("rejects Anthropic JSON mode even if stale metadata claims JSON support", () => {
    const connection = provider("anthropic-provider", "anthropic", "Anthropic", ["json"]);
    const route = resolveRoutedProviderModel([connection], connection.models[0]);

    const result = preflightProviderParameters({ ...defaultParameters, jsonMode: true }, route!);

    expect(result.errors.join(" ")).toContain("JSON response");
    expect(result.parameters).not.toHaveProperty("jsonMode");
  });

  it("blocks JSON schema because the native preview cannot translate it yet", () => {
    const connection = provider("openai-provider", "openai", "OpenAI", ["json"]);
    const route = resolveRoutedProviderModel([connection], connection.models[0]);

    const result = preflightProviderParameters(
      { ...defaultParameters, jsonSchema: '{"type":"object"}' },
      route!,
    );

    expect(result.errors.join(" ")).toContain("JSON schema");
    expect(result.parameters).not.toHaveProperty("native");
  });
});
