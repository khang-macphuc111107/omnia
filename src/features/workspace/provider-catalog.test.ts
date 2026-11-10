import { describe, expect, it } from "vitest";

import {
  modelProfileFromProviderModel,
  providerFromNativeProfile,
  providerKindFromType,
  providerModelRecordFromNativeModel,
  selectableModelProfiles,
} from "./provider-catalog";
import type { ProviderProfileRecord } from "@/lib/desktop";
import type { ProviderView } from "./types";

describe("provider catalog", () => {
  const nativeProfile = (overrides: Partial<ProviderProfileRecord> = {}): ProviderProfileRecord => ({
    id: "provider_native_0123456789abcdef0123456789abcdef",
    providerType: "openai_compatible",
    displayName: "Native lab",
    normalizedBaseUrl: "https://api.example.com/v1",
    authScheme: "bearer",
    organizationId: null,
    remoteProjectId: null,
    credentialStatus: "present",
    localNetworkGrant: false,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  });

  it("keeps native profile hydration at configuration-validated until a live receipt exists", () => {
    expect(providerFromNativeProfile(nativeProfile()).state).toBe("configuration-validated");
    expect(providerFromNativeProfile(nativeProfile({ authScheme: "none" })).state).toBe("configuration-validated");
    expect(providerFromNativeProfile(nativeProfile({ credentialStatus: "missing" })).state).toBe("not-configured");
    expect(providerFromNativeProfile(nativeProfile({ enabled: false })).state).toBe("degraded");
  });

  it("classifies native provider types and loopback compatible endpoints", () => {
    expect(providerKindFromType("anthropic")).toBe("Anthropic");
    expect(providerKindFromType("azure_openai")).toBe("Azure OpenAI");
    expect(providerKindFromType("deepseek")).toBe("OpenAI-compatible");
    expect(providerKindFromType("openai_compatible", "http://127.0.0.1:1234/v1")).toBe("Local");
  });

  it("normalizes provider capabilities into a selectable model profile", () => {
    const profile = modelProfileFromProviderModel(
      { id: "provider-1", name: "Lab" },
      {
        id: "reasoner",
        displayName: "Reasoner",
        contextWindowTokens: 200000,
        capabilities: ["text", "vision", "tools", "reasoning", "json-schema"],
      },
    );
    expect(profile.contextLabel).toBe("200K context");
    expect(profile.capabilities).toEqual(["vision", "tools", "json", "reasoning"]);
  });

  it("renders badges only for capabilities the native catalog explicitly confirms", () => {
    const record = providerModelRecordFromNativeModel({
      id: "omnia-smoke-model",
      displayName: "Omnia smoke model",
      ownedBy: "omnia-local-smoke",
      createdAt: null,
      capabilities: {
        streaming: true,
        tools: null,
        vision: false,
        reasoning: null,
        source: "unknown",
      },
    });

    expect(record.capabilities).toEqual(["text"]);
    expect(
      modelProfileFromProviderModel({ id: "local", name: "Local runtime" }, record)
        .capabilities,
    ).toEqual([]);
  });

  it("preserves an explicitly confirmed native capability", () => {
    const record = providerModelRecordFromNativeModel({
      id: "declared-tools-model",
      displayName: "Declared tools model",
      ownedBy: null,
      createdAt: null,
      capabilities: {
        streaming: true,
        tools: true,
        vision: null,
        reasoning: false,
        source: "provider_live",
      },
    });

    expect(record.capabilities).toEqual(["text", "tools"]);
  });

  it("excludes disabled connections but retains the automatic route", () => {
    const provider: ProviderView = {
      id: "provider-1",
      name: "Lab",
      kind: "OpenAI-compatible",
      providerType: "openai_compatible",
      endpoint: "https://example.com/v1",
      authScheme: "bearer",
      state: "connected",
      modelCount: 1,
      enabled: false,
      credentialState: "present",
      source: "preview",
      organizationId: null,
      remoteProjectId: null,
      lastCheckedAt: null,
      latencyMs: null,
      errorMessage: null,
      models: [
        {
          id: "provider-1:model",
          connectionId: "provider-1",
          displayName: "Model",
          providerName: "Lab",
          providerModelId: "model",
          status: "available",
          capabilities: [],
          contextLabel: "Context not reported",
          speed: "Balanced",
          favorite: false,
        },
      ],
    };
    expect(selectableModelProfiles([provider]).map((model) => model.id)).toEqual(["auto"]);
  });
});
