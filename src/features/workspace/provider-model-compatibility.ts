import type { ModelProfileView, ProviderView } from "./types";

export type CompatibilityCapability = "tools" | "json" | "reasoning" | "vision" | "audio";
export type CompatibilityMode = "strict" | "advisory";
export type CompatibilityStatus = "compatible" | "review" | "blocked";

export type CompatibilityRule = {
  readonly id: CompatibilityCapability;
  readonly label: string;
  readonly detail: string;
};

export type ModelCompatibilityRow = {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly providerSource: ProviderView["source"];
  readonly providerState: ProviderView["state"];
  readonly model: ModelProfileView;
  readonly statuses: Record<CompatibilityCapability, CompatibilityStatus>;
  readonly compatibleCount: number;
  readonly reviewCount: number;
  readonly blockedCount: number;
};

export const compatibilityRules: readonly CompatibilityRule[] = [
  { id: "tools", label: "Tools", detail: "Function/tool calls can be requested only when the model catalog declares tool support." },
  { id: "json", label: "Structured JSON", detail: "Structured output intent requires a JSON or schema capability declaration." },
  { id: "reasoning", label: "Reasoning", detail: "Reasoning controls should remain hidden unless the selected model declares reasoning support." },
  { id: "vision", label: "Vision", detail: "Image attachments require a vision-capable model and a compatible provider operation." },
  { id: "audio", label: "Audio", detail: "Audio input/output remains model and adapter scoped; catalog support is not a dispatch receipt." },
];

function providerIsObserved(provider: ProviderView): boolean {
  return provider.source === "native" && provider.state === "connected";
}

function providerShapeIsReady(provider: ProviderView): boolean {
  return provider.state === "connected" || provider.state === "configuration-validated";
}

export function evaluateModelCompatibility(
  provider: ProviderView,
  model: ModelProfileView,
  mode: CompatibilityMode,
): Record<CompatibilityCapability, CompatibilityStatus> {
  return Object.fromEntries(
    compatibilityRules.map(({ id }) => {
      const declared = model.capabilities.includes(id);
      if (!declared) return [id, mode === "strict" ? "blocked" : "review"];
      if (!providerIsObserved(provider) || !providerShapeIsReady(provider) || model.status !== "available") {
        return [id, "review"];
      }
      return [id, "compatible"];
    }),
  ) as Record<CompatibilityCapability, CompatibilityStatus>;
}

export function buildCompatibilityRows(
  providers: readonly ProviderView[],
  mode: CompatibilityMode,
): ModelCompatibilityRow[] {
  return providers.flatMap((provider) => provider.models.map((model) => {
    const statuses = evaluateModelCompatibility(provider, model, mode);
    const values = Object.values(statuses);
    return {
      id: `${provider.id}:${model.id}`,
      providerId: provider.id,
      providerName: provider.name,
      providerSource: provider.source,
      providerState: provider.state,
      model,
      statuses,
      compatibleCount: values.filter((value) => value === "compatible").length,
      reviewCount: values.filter((value) => value === "review").length,
      blockedCount: values.filter((value) => value === "blocked").length,
    };
  }));
}

export function compatibilityStatusLabel(status: CompatibilityStatus): string {
  if (status === "compatible") return "Compatible";
  if (status === "blocked") return "Blocked by catalog";
  return "Review evidence";
}

export function exportCompatibilityJson(rows: readonly ModelCompatibilityRow[], mode: CompatibilityMode): string {
  return JSON.stringify({
    format: "omnia.provider-model-compatibility.preview.v1",
    mode,
    rows: rows.map((row) => ({
      id: row.id,
      provider: row.providerName,
      providerState: row.providerState,
      providerSource: row.providerSource,
      model: row.model.displayName,
      providerModelId: row.model.providerModelId,
      capabilities: row.model.capabilities,
      statuses: row.statuses,
    })),
    boundary: [
      "Preview only",
      "Renderer-local",
      "No provider request",
      "No endpoint probe",
      "No credential lookup",
      "No native route decision",
      "No durable write",
    ],
  }, null, 2);
}
