import { REASONING_EFFORTS, type ReasoningEffort } from "./runtime-settings";

export interface ModelRouteCandidate {
  model: string;
  provider: string;
  supportedEfforts?: readonly ReasoningEffort[];
  modalities?: readonly ("text" | "image" | "audio" | "video")[];
}

export interface ModelRouteRequest {
  role?: string;
  effort?: ReasoningEffort | string | null;
  modality?: "text" | "image" | "audio" | "video";
  preferredModels?: readonly string[];
  candidates: readonly ModelRouteCandidate[];
}

export interface ModelRouteResolution {
  candidate: ModelRouteCandidate | null;
  requestedEffort: ReasoningEffort;
  resolvedEffort: ReasoningEffort;
  dynamicWorkflow: boolean;
  downgraded: boolean;
  reason: string;
}

const effortRank = new Map(REASONING_EFFORTS.map((value, index) => [value, index]));

function validEffort(value: unknown): ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.includes(value as ReasoningEffort) ? value as ReasoningEffort : "medium";
}

export function resolveModelRoute(request: ModelRouteRequest): ModelRouteResolution {
  const requested = validEffort(request.effort);
  const dynamicWorkflow = requested === "ultra";
  const desired = dynamicWorkflow ? "max" : requested;
  const ordered = [...request.candidates].sort((a, b) => {
    const ai = request.preferredModels?.indexOf(a.model) ?? -1;
    const bi = request.preferredModels?.indexOf(b.model) ?? -1;
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  const candidate = ordered.find((entry) => !request.modality || !entry.modalities || entry.modalities.includes(request.modality)) ?? null;
  if (!candidate) return { candidate: null, requestedEffort: requested, resolvedEffort: "none", dynamicWorkflow, downgraded: true, reason: "No candidate supports the requested modality." };
  const supported = candidate.supportedEfforts?.length ? [...candidate.supportedEfforts] : REASONING_EFFORTS.filter((effort) => effort !== "ultra");
  const desiredRank = effortRank.get(desired) ?? effortRank.get("medium")!;
  const atOrBelow = supported.filter((effort) => (effortRank.get(effort) ?? 0) <= desiredRank).sort((a, b) => (effortRank.get(b) ?? 0) - (effortRank.get(a) ?? 0));
  const resolved = atOrBelow[0] ?? supported.sort((a, b) => (effortRank.get(a) ?? 0) - (effortRank.get(b) ?? 0))[0] ?? "none";
  return { candidate, requestedEffort: requested, resolvedEffort: resolved, dynamicWorkflow, downgraded: resolved !== desired, reason: resolved === desired ? "Selected preferred compatible route." : `Provider supports ${resolved}; requested ${requested}.` };
}
