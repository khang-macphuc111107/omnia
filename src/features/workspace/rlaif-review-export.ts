export type RlaifExportFormat = "json" | "markdown";
export type RlaifPreference = "prefer-a" | "prefer-b" | "tie" | "abstain";
export type RlaifBlindOrder = "ab" | "ba";
export type RlaifAnnotationRationale = "correctness" | "groundedness" | "instruction-fit" | "clarity" | "safety" | "balanced" | "insufficient-evidence" | "other";
export type RlaifAnnotationConfidence = "low" | "medium" | "high";

export interface RlaifBlindOrderPreview {
  enabled: boolean;
  seed: string;
  assignments: Array<{ comparisonId: string; order: RlaifBlindOrder }>;
  counts: {
    ab: number;
    ba: number;
  };
}

export interface RlaifSwapTestPreview {
  enabled: boolean;
  status: "not-run";
  pairedComparisonIds: string[];
  note: string;
}

export interface RlaifExportComparison {
  id: string;
  preference: RlaifPreference | null;
  rationale?: RlaifAnnotationRationale | null;
  confidence?: RlaifAnnotationConfidence | null;
}

export interface RlaifReviewExportInput {
  algorithm: "DPO" | "PPO" | "GRPO";
  evaluatorRoute: string;
  rewardRecipe: string;
  judgeCount: 1 | 3 | 5;
  agreementThreshold: number;
  disagreementPolicy: "human-review" | "majority" | "abstain";
  blindJudging: boolean;
  blindOrderSeed?: string;
  swapTestEnabled?: boolean;
  holdoutPercent: number;
  comparisons: readonly RlaifExportComparison[];
}

export interface RlaifReviewExportConfig {
  algorithm: RlaifReviewExportInput["algorithm"];
  evaluatorRoute: string;
  rewardRecipe: string;
  judgeCount: RlaifReviewExportInput["judgeCount"];
  agreementThreshold: number;
  disagreementPolicy: RlaifReviewExportInput["disagreementPolicy"];
  blindJudging: boolean;
  blindOrderSeed: string;
  swapTestEnabled: boolean;
  holdoutPercent: number;
}

export interface RlaifReviewExportManifest {
  schema: "omnia.rlaif-review-checkpoint.preview.v1";
  scope: "renderer-session";
  checkpointKey: string;
  config: RlaifReviewExportConfig;
  review: {
    total: number;
    reviewed: number;
    unresolved: number;
    preferA: number;
    preferB: number;
    ties: number;
    abstentions: number;
    reviewedComparisonIds: string[];
    unresolvedComparisonIds: string[];
    annotationComplete: number;
    annotationIncomplete: number;
    annotationCoveragePercent: number;
    annotations: Array<{
      comparisonId: string;
      preference: RlaifPreference | null;
      rationale: RlaifAnnotationRationale | null;
      confidence: RlaifAnnotationConfidence | null;
    }>;
  };
  pairwise: {
    blindOrder: RlaifBlindOrderPreview;
    swapTest: RlaifSwapTestPreview;
  };
  boundary: {
    evaluatorRequest: false;
    preferenceDatasetWrite: false;
    checkpointWrite: false;
    nativeReceipt: false;
  };
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function normalizeBlindSeed(seed: string | undefined): string {
  const normalized = typeof seed === "string" ? seed.trim() : "";
  return normalized || "omnia-rlaif-preview";
}

/**
 * Deterministic renderer-only order rehearsal. This intentionally does not
 * use Math.random so a preview export can be reproduced without implying a
 * runtime assignment or a provider-side experiment.
 */
export function deriveRlaifBlindOrder(seed: string, comparisonId: string): RlaifBlindOrder {
  let hash = 2_166_136_261;
  const input = `${normalizeBlindSeed(seed)}:${comparisonId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 2 === 0 ? "ab" : "ba";
}

export function buildRlaifBlindOrderPreview(
  comparisons: readonly Pick<RlaifExportComparison, "id">[],
  seed = "omnia-rlaif-preview",
  enabled = true,
): RlaifBlindOrderPreview {
  const normalizedSeed = normalizeBlindSeed(seed);
  const assignments = comparisons.map(({ id }) => ({
    comparisonId: id,
    order: enabled ? deriveRlaifBlindOrder(normalizedSeed, id) : "ab" as const,
  }));
  return {
    enabled,
    seed: normalizedSeed,
    assignments,
    counts: {
      ab: assignments.filter(({ order }) => order === "ab").length,
      ba: assignments.filter(({ order }) => order === "ba").length,
    },
  };
}

export function buildRlaifSwapTestPreview(
  comparisons: readonly Pick<RlaifExportComparison, "id">[],
  enabled = true,
): RlaifSwapTestPreview {
  return {
    enabled,
    status: "not-run",
    pairedComparisonIds: enabled ? comparisons.map(({ id }) => id) : [],
    note: enabled
      ? "A paired swapped-order replay is planned but has not run in this renderer preview."
      : "Swap-test rehearsal is disabled for this renderer preview.",
  };
}

export function buildRlaifReviewExport(input: RlaifReviewExportInput): RlaifReviewExportManifest {
  const reviewedComparisonIds = input.comparisons.filter((comparison) => comparison.preference !== null).map((comparison) => comparison.id);
  const unresolvedComparisonIds = input.comparisons.filter((comparison) => comparison.preference === null).map((comparison) => comparison.id);
  const annotations = input.comparisons.map((comparison) => ({
    comparisonId: comparison.id,
    preference: comparison.preference,
    rationale: comparison.rationale ?? null,
    confidence: comparison.confidence ?? null,
  }));
  const annotationComplete = annotations.filter((annotation) => annotation.preference !== null && annotation.rationale !== null && annotation.confidence !== null).length;
  const counts = input.comparisons.reduce((summary, comparison) => {
    if (comparison.preference === null) summary.unresolved += 1;
    else {
      summary.reviewed += 1;
      if (comparison.preference === "prefer-a") summary.preferA += 1;
      if (comparison.preference === "prefer-b") summary.preferB += 1;
      if (comparison.preference === "tie") summary.ties += 1;
      if (comparison.preference === "abstain") summary.abstentions += 1;
    }
    return summary;
  }, { reviewed: 0, unresolved: 0, preferA: 0, preferB: 0, ties: 0, abstentions: 0 });

  const blindOrder = buildRlaifBlindOrderPreview(input.comparisons, input.blindOrderSeed, input.blindJudging);
  const swapTest = buildRlaifSwapTestPreview(input.comparisons, input.swapTestEnabled ?? true);
  const checkpointKey = `preview:rlaif:${counts.reviewed}-${counts.unresolved}:${input.algorithm.toLowerCase()}`;
  return {
    schema: "omnia.rlaif-review-checkpoint.preview.v1",
    scope: "renderer-session",
    checkpointKey,
    config: {
      algorithm: input.algorithm,
      evaluatorRoute: input.evaluatorRoute,
      rewardRecipe: input.rewardRecipe,
      judgeCount: input.judgeCount,
      agreementThreshold: clampPercent(input.agreementThreshold),
      disagreementPolicy: input.disagreementPolicy,
      blindJudging: input.blindJudging,
      blindOrderSeed: blindOrder.seed,
      swapTestEnabled: swapTest.enabled,
      holdoutPercent: clampPercent(input.holdoutPercent),
    },
    review: {
      total: input.comparisons.length,
      ...counts,
      reviewedComparisonIds,
      unresolvedComparisonIds,
      annotationComplete,
      annotationIncomplete: input.comparisons.length - annotationComplete,
      annotationCoveragePercent: input.comparisons.length === 0 ? 0 : Math.round((annotationComplete / input.comparisons.length) * 100),
      annotations,
    },
    pairwise: {
      blindOrder,
      swapTest,
    },
    boundary: {
      evaluatorRequest: false,
      preferenceDatasetWrite: false,
      checkpointWrite: false,
      nativeReceipt: false,
    },
  };
}

export function serializeRlaifReviewExport(manifest: RlaifReviewExportManifest, format: RlaifExportFormat = "json"): string {
  if (format === "json") return JSON.stringify(manifest, null, 2);
  return [
    "# Omnia RLAIF review checkpoint preview",
    "",
    `Checkpoint key: ${manifest.checkpointKey}`,
    `Recipe: ${manifest.config.algorithm}`,
    `Reward rubric: ${manifest.config.rewardRecipe}`,
    `Review progress: ${manifest.review.reviewed}/${manifest.review.total}`,
    `Holdout target: ${manifest.config.holdoutPercent}%`,
    `Blind order: ${manifest.pairwise.blindOrder.enabled ? `${manifest.pairwise.blindOrder.counts.ab} A/B · ${manifest.pairwise.blindOrder.counts.ba} B/A` : "fixed A/B"}`,
    `Swap-test rehearsal: ${manifest.pairwise.swapTest.enabled ? "planned · not run" : "disabled"}`,
    "",
    "> Preview only. No evaluator request, preference dataset write, checkpoint file, or native receipt exists.",
    "",
    "## Review summary",
    "",
    `- Prefer A: ${manifest.review.preferA}`,
    `- Prefer B: ${manifest.review.preferB}`,
    `- Ties: ${manifest.review.ties}`,
    `- Abstentions: ${manifest.review.abstentions}`,
    `- Unresolved: ${manifest.review.unresolved}`,
    `- Annotation coverage: ${manifest.review.annotationComplete}/${manifest.review.total} (${manifest.review.annotationCoveragePercent}%)`,
    "",
    "## Redacted labels",
    "",
    ...manifest.review.annotations.map((annotation) => `- ${annotation.comparisonId}: ${annotation.preference ?? "unresolved"} · rationale=${annotation.rationale ?? "missing"} · confidence=${annotation.confidence ?? "missing"}`),
  ].join("\n");
}

export function validateRlaifReviewExport(input: unknown): RlaifReviewExportManifest {
  if (!input || typeof input !== "object") throw new Error("RLAIF review export must be an object.");
  const candidate = input as Partial<RlaifReviewExportManifest>;
  if (candidate.schema !== "omnia.rlaif-review-checkpoint.preview.v1" || candidate.scope !== "renderer-session") {
    throw new Error("Unsupported RLAIF review export schema or scope.");
  }
  if (!candidate.config || typeof candidate.config !== "object") throw new Error("RLAIF review export config is missing.");
  if (!candidate.review || typeof candidate.review !== "object") throw new Error("RLAIF review export review summary is missing.");
  if (!candidate.pairwise || typeof candidate.pairwise !== "object") throw new Error("RLAIF review export pairwise summary is missing.");
  if (!Array.isArray(candidate.review.annotations)) throw new Error("RLAIF review export annotations are missing.");
  for (const annotation of candidate.review.annotations) {
    if (!annotation || typeof annotation !== "object" || typeof annotation.comparisonId !== "string") throw new Error("RLAIF review export annotation is invalid.");
    if (annotation.preference !== null && !["prefer-a", "prefer-b", "tie", "abstain"].includes(annotation.preference)) throw new Error("RLAIF review export annotation preference is invalid.");
    if (annotation.rationale !== null && !["correctness", "groundedness", "instruction-fit", "clarity", "safety", "balanced", "insufficient-evidence", "other"].includes(annotation.rationale)) throw new Error("RLAIF review export annotation rationale is invalid.");
    if (annotation.confidence !== null && !["low", "medium", "high"].includes(annotation.confidence)) throw new Error("RLAIF review export annotation confidence is invalid.");
  }
  if (!candidate.boundary || typeof candidate.boundary !== "object") throw new Error("RLAIF review export boundary is missing.");
  const boundary = candidate.boundary as Record<string, unknown>;
  for (const field of ["evaluatorRequest", "preferenceDatasetWrite", "checkpointWrite", "nativeReceipt"]) {
    if (boundary[field] !== false) throw new Error(`RLAIF review export boundary.${field} must remain false.`);
  }
  return candidate as RlaifReviewExportManifest;
}
