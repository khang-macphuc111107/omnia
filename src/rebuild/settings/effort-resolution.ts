import type { ReasoningEffort } from "./settings";

/** The persisted effort choices accepted by Omnia's renderer settings. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const satisfies readonly ReasoningEffort[];
export type RequestedReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type EffectiveReasoningEffort = Exclude<RequestedReasoningEffort, "ultra">;

const EFFECTIVE_EFFORTS = REASONING_EFFORTS.filter((entry): entry is EffectiveReasoningEffort => entry !== "ultra");
const ORDER = new Map<EffectiveReasoningEffort, number>(EFFECTIVE_EFFORTS.map((entry, index) => [entry, index]));
const isRequestedEffort = (value: unknown): value is RequestedReasoningEffort =>
  typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
const isEffectiveEffort = (value: unknown): value is EffectiveReasoningEffort =>
  typeof value === "string" && (EFFECTIVE_EFFORTS as readonly string[]).includes(value);

/**
 * Capability metadata deliberately stays provider-neutral. A native adapter can
 * supply an explicit supported list, a documented maximum, or a reasoning flag.
 * Unknown metadata is never upgraded to a high effort implicitly.
 */
export interface EffortCapabilities {
  supportedEfforts?: readonly string[];
  maxEffort?: string | null;
  reasoning?: boolean | null;
  /** Human-readable source for the receipt (for example `native:openai`). */
  source?: string;
}

export type EffortResolutionStatus = "supported" | "ultra-resolved" | "unsupported" | "invalid";

export interface EffortResolutionEvidence {
  source: "explicit-list" | "max-effort" | "reasoning-flag" | "baseline-none" | "none";
  capabilitySource: string | null;
  supportsRequested: boolean;
  dynamicWorkflow: boolean;
  supportedEfforts: EffectiveReasoningEffort[];
  explanation: string;
}

export interface EffortResolution {
  requested: RequestedReasoningEffort | null;
  effective: EffectiveReasoningEffort | null;
  status: EffortResolutionStatus;
  evidence: EffortResolutionEvidence;
}

function normalizedCapabilities(capabilities: EffortCapabilities | undefined): {
  supported: EffectiveReasoningEffort[];
  source: EffortResolutionEvidence["source"];
  capabilitySource: string | null;
} {
  if (!capabilities) {
    return { supported: [], source: "none", capabilitySource: null };
  }

  const explicit = (capabilities.supportedEfforts ?? []).filter(isEffectiveEffort);
  if (explicit.length > 0) {
    const supported = [...new Set(explicit)].sort((left, right) => ORDER.get(left)! - ORDER.get(right)!);
    return { supported, source: "explicit-list", capabilitySource: capabilities.source?.trim() || null };
  }

  if (isEffectiveEffort(capabilities.maxEffort)) {
    const maximum = ORDER.get(capabilities.maxEffort)!;
    const supported = EFFECTIVE_EFFORTS.filter((entry) => ORDER.get(entry)! <= maximum);
    return { supported, source: "max-effort", capabilitySource: capabilities.source?.trim() || null };
  }

  if (capabilities.reasoning === false) {
    return { supported: ["none"], source: "reasoning-flag", capabilitySource: capabilities.source?.trim() || null };
  }

  // A provider that exposes no reasoning metadata can still accept a no-op
  // effort. We record this as a baseline so callers can distinguish it from a
  // capability assertion supplied by the provider.
  if (capabilities.reasoning === true) {
    return { supported: ["none"], source: "baseline-none", capabilitySource: capabilities.source?.trim() || null };
  }

  return { supported: [], source: "none", capabilitySource: capabilities.source?.trim() || null };
}

/**
 * Resolve a requested effort against model capabilities.
 *
 * `ultra` is a workflow policy: it resolves to the highest explicitly known
 * effort and marks `dynamicWorkflow`. It is never sent to a provider as if it
 * were a native enum. Any unsupported request returns a terminal result with
 * `effective: null`, so a caller must choose a different route or ask the user.
 */
export function resolveReasoningEffort(requested: unknown, capabilities?: EffortCapabilities): EffortResolution {
  const normalized = normalizedCapabilities(capabilities);
  const baseEvidence = (patch: Partial<EffortResolutionEvidence>): EffortResolutionEvidence => ({
    source: normalized.source,
    capabilitySource: normalized.capabilitySource,
    supportsRequested: false,
    dynamicWorkflow: false,
    supportedEfforts: normalized.supported,
    explanation: "No compatible effort capability was advertised by this model.",
    ...patch,
  });

  if (!isRequestedEffort(requested)) {
    return {
      requested: null,
      effective: null,
      status: "invalid",
      evidence: baseEvidence({ source: "none", explanation: "Requested effort is not one of Omnia's eight persisted values." }),
    };
  }

  if (requested === "ultra") {
    const effective = normalized.supported.at(-1) ?? null;
    if (!effective) {
      return {
        requested,
        effective: null,
        status: "unsupported",
        evidence: baseEvidence({ dynamicWorkflow: true, explanation: "Ultra requires at least one explicitly supported effective effort." }),
      };
    }
    return {
      requested,
      effective,
      status: "ultra-resolved",
      evidence: baseEvidence({
        supportsRequested: true,
        dynamicWorkflow: true,
        explanation: `Ultra resolved to the highest advertised effort (${effective}); the provider receives the effective value only.`,
      }),
    };
  }

  if (!normalized.supported.includes(requested)) {
    return {
      requested,
      effective: null,
      status: "unsupported",
      evidence: baseEvidence({ explanation: `The model did not advertise requested effort ${requested}.` }),
    };
  }

  return {
    requested,
    effective: requested,
    status: "supported",
    evidence: baseEvidence({ supportsRequested: true, explanation: `Requested effort ${requested} is advertised by the model.` }),
  };
}

/** Return the highest explicitly supported non-ultra effort, if any. */
export function highestSupportedEffort(capabilities?: EffortCapabilities): EffectiveReasoningEffort | null {
  return normalizedCapabilities(capabilities).supported.at(-1) ?? null;
}
