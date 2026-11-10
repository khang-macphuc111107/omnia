export type ContextEstimateStatus = "heuristic" | "unknown" | "withheld";

export interface ContextEstimateView {
  readonly status: ContextEstimateStatus;
  readonly tokens: number | null;
  readonly source: "renderer-heuristic" | "not-available";
  readonly reason: string;
}

export interface ContextEstimateInput {
  readonly estimatedTokens: number | null;
  readonly projectHealth?: "not-compiled" | "ready" | "indexing" | "over-budget" | "missing-access";
  readonly reason?: string;
}

/**
 * Normalize renderer-only token estimates into an explicit evidence state.
 * Provider tokenizers and native context revisions remain authoritative; this
 * helper deliberately never invents either one.
 */
export function buildContextEstimate({ estimatedTokens, projectHealth, reason }: ContextEstimateInput): ContextEstimateView {
  if (projectHealth === "missing-access") {
    return Object.freeze({
      status: "withheld",
      tokens: null,
      source: "not-available",
      reason: reason ?? "Context access is blocked; the renderer withholds the aggregate estimate.",
    });
  }

  if (projectHealth === "over-budget") {
    return Object.freeze({
      status: "withheld",
      tokens: null,
      source: "not-available",
      reason: reason ?? "Context is over the preview budget; aggregate admission is withheld until native selection or compaction evidence exists.",
    });
  }

  if (estimatedTokens === null || !Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
    return Object.freeze({
      status: "unknown",
      tokens: null,
      source: "not-available",
      reason: reason ?? "No renderer estimate was provided for this context snapshot.",
    });
  }

  return Object.freeze({
    status: "heuristic",
    tokens: Math.max(0, Math.round(estimatedTokens)),
    source: "renderer-heuristic",
    reason: reason ?? "Deterministic renderer estimate; not provider tokenizer output.",
  });
}

export function contextEstimateLabel(estimate: ContextEstimateView): string {
  if (estimate.status === "withheld") return "Withheld";
  if (estimate.status === "unknown") return "Unknown";
  return "Heuristic";
}

export function contextEstimateInline(estimate: ContextEstimateView, budgetTokens?: number): string {
  if (estimate.tokens === null) return `${contextEstimateLabel(estimate)} — ${estimate.reason}`;
  const budget = budgetTokens === undefined
    ? ""
    : ` · ${estimate.tokens <= budgetTokens ? "within" : "over"} preview budget`;
  return `~${estimate.tokens.toLocaleString()} tokens · ${contextEstimateLabel(estimate)}${budget}`;
}
