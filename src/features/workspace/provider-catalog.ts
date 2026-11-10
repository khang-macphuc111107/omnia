import type {
  NativeProviderModel,
  ProviderModelRecord,
  ProviderProfileRecord,
} from "@/lib/desktop";

import { modelProfiles as builtInModelProfiles } from "./mock-data";
import type { ModelProfileView, ProviderKind, ProviderView } from "./types";

const autoProfile = builtInModelProfiles.find((profile) => profile.id === "auto")!;

export function providerKindFromType(providerType: string, endpoint = ""): ProviderKind {
  const normalized = providerType.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "openai") return "OpenAI";
  if (normalized === "deepseek") return "OpenAI-compatible";
  if (normalized === "anthropic") return "Anthropic";
  if (normalized === "gemini" || normalized === "google") return "Gemini";
  if (normalized === "azure-openai" || normalized === "azure") return "Azure OpenAI";
  if (normalized === "custom-adapter") return "Custom";
  try {
    const host = new URL(endpoint).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) {
      return "Local";
    }
  } catch {
    // The native layer remains authoritative for URL validity.
  }
  return "OpenAI-compatible";
}

export function providerFromNativeProfile(profile: ProviderProfileRecord): ProviderView {
  // A profile-list response contains durable configuration metadata, not a
  // live health receipt. Keep that distinction visible: an enabled profile
  // with a usable credential is configuration-validated until the explicit
  // connection/model discovery path reports `connected`.
  const state = !profile.enabled
    ? ("degraded" as const)
    : profile.authScheme !== "none" && profile.credentialStatus !== "present"
      ? ("not-configured" as const)
      : ("configuration-validated" as const);
  return {
    id: profile.id,
    name: profile.displayName,
    kind: providerKindFromType(profile.providerType, profile.normalizedBaseUrl),
    providerType: profile.providerType.replaceAll("_", "-"),
    endpoint: profile.normalizedBaseUrl,
    authScheme: profile.authScheme,
    state,
    modelCount: 0,
    enabled: profile.enabled,
    credentialState: profile.authScheme === "none" ? "not-required" : profile.credentialStatus,
    source: "native",
    organizationId: profile.organizationId,
    remoteProjectId: profile.remoteProjectId,
    lastCheckedAt: null,
    latencyMs: null,
    errorMessage: null,
    models: [],
  };
}

export function providerModelRecordFromNativeModel(
  model: NativeProviderModel,
): ProviderModelRecord {
  return {
    id: model.id,
    displayName: model.displayName,
    ...(model.ownedBy ? { ownedBy: model.ownedBy } : {}),
    capabilities: [
      "text",
      ...(model.capabilities.vision === true ? ["vision"] : []),
      ...(model.capabilities.tools === true ? ["tools"] : []),
      ...(model.capabilities.reasoning === true ? ["reasoning"] : []),
    ],
  };
}

export function modelProfileFromProviderModel(
  connection: Pick<ProviderView, "id" | "name">,
  model: ProviderModelRecord,
): ModelProfileView {
  const capabilities = [
    ...(model.capabilities.some((item) => item === "image" || item === "vision") ? ["vision" as const] : []),
    ...(model.capabilities.includes("tools") ? ["tools" as const] : []),
    ...(model.capabilities.some((item) => item === "json" || item === "json-schema") ? ["json" as const] : []),
    ...(model.capabilities.includes("reasoning") ? ["reasoning" as const] : []),
    ...(model.capabilities.includes("audio") ? ["audio" as const] : []),
  ];
  return {
    id: `${connection.id}:${model.id}`,
    connectionId: connection.id,
    displayName: model.displayName,
    providerName: connection.name,
    providerModelId: model.id,
    status: "available",
    capabilities,
    contextLabel: model.contextWindowTokens
      ? `${formatTokenCount(model.contextWindowTokens)} context`
      : "Context not reported",
    speed: capabilities.includes("reasoning") ? "Thorough" : "Balanced",
    favorite: false,
  };
}

export function selectableModelProfiles(providers: ProviderView[]): ModelProfileView[] {
  const profiles = providers
    .filter((provider) => provider.enabled && provider.state !== "error")
    .flatMap((provider) => provider.models);
  const unique = new Map<string, ModelProfileView>();
  for (const profile of profiles) unique.set(profile.id, profile);
  return unique.size > 0 ? [autoProfile, ...unique.values()] : [autoProfile];
}

/** A browser preflight validates configuration shape, not a live connection. */
export function providerStateLabel(provider: Pick<ProviderView, "source" | "state">): string {
  if (provider.source === "preview" && provider.state === "configuration-validated") {
    return "configuration validated (preview)";
  }
  if (provider.source === "demo" && provider.state === "connected") {
    return "demo catalog";
  }
  return provider.state.replaceAll("-", " ");
}

export function hasNativeProviderConnection(provider: Pick<ProviderView, "source" | "state">): boolean {
  return provider.source === "native" && provider.state === "connected";
}

export function resolveAutoModel(providers: ProviderView[]): ModelProfileView | null {
  return (
    providers
      .filter((provider) => provider.enabled && provider.state === "connected")
      .flatMap((provider) => provider.models)
      .find((profile) => profile.status === "available") ?? null
  );
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function formatProviderCheckTime(value: string | null): string {
  if (!value) return "Not checked yet";
  const elapsedMs = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsedMs < 60_000) return "Checked just now";
  if (elapsedMs < 3_600_000) return `Checked ${Math.floor(elapsedMs / 60_000)} min ago`;
  if (elapsedMs < 86_400_000) return `Checked ${Math.floor(elapsedMs / 3_600_000)} h ago`;
  return `Checked ${new Date(value).toLocaleDateString()}`;
}
