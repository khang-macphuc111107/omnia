export type PromptSurfaceKind = "main-chat" | "ide-sidebar" | "browser-sidebar" | "subagent";

export interface PromptCommandExecutionMetric {
  readonly commandId: string;
  readonly commandLabel: string;
  readonly agentId: string;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  readonly durationMs: number;
  readonly status: "completed" | "running" | "failed";
}

export interface PromptAgentTelemetryMetric {
  readonly agentId: string;
  readonly agentLabel: string;
  readonly role: "main" | "submain" | "worker" | "reviewer" | "verifier";
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheTokensIn: number;
  readonly cacheTokensOut: number;
  readonly costTotalUsd: number;
  readonly durationMs: number;
  readonly requestCount: number;
}

export interface PromptTelemetryRecord {
  readonly promptId: string;
  readonly conversationId: string;
  readonly surface: PromptSurfaceKind;
  readonly promptSummary: string;
  readonly promptSentAtIso: string;
  readonly promptFinishedAtIso: string;
  readonly durationMs: number;
  readonly ttftMs: number;
  readonly latencyMs: number;
  readonly tokensPerSecond: number;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheTokensIn: number;
  readonly cacheTokensOut: number;
  readonly cacheHitPercent: number;
  readonly costInUsd: number;
  readonly costOutUsd: number;
  readonly costCacheInUsd: number;
  readonly costCacheOutUsd: number;
  readonly costCacheUsd: number;
  readonly costTotalUsd: number;
  readonly requestCount: number;
  readonly requestsPerMinute: number;
  readonly agentCount: number;
  readonly commands: readonly PromptCommandExecutionMetric[];
  readonly agents: readonly PromptAgentTelemetryMetric[];
}

export interface GlobalPromptTelemetrySummary {
  readonly totalPrompts: number;
  readonly totalRequests: number;
  readonly averageRequestsPerMinute: number;
  readonly totalAgentsInvolved: number;
  readonly totalDurationMs: number;
  readonly averageTtftMs: number;
  readonly averageLatencyMs: number;
  readonly averageTokensPerSecond: number;
  readonly totalTokensIn: number;
  readonly totalTokensOut: number;
  readonly totalCacheTokensIn: number;
  readonly totalCacheTokensOut: number;
  readonly overallCacheHitPercent: number;
  readonly totalCostInUsd: number;
  readonly totalCostOutUsd: number;
  readonly totalCostCacheInUsd: number;
  readonly totalCostCacheOutUsd: number;
  readonly totalCostCacheUsd: number;
  readonly totalCostUsd: number;
  readonly totalCommandsExecuted: number;
  readonly totalCommandDurationMs: number;
  readonly bySurface: Readonly<Record<PromptSurfaceKind, number>>;
}

export interface ModelPricingRate {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
  readonly cacheReadPerMillionUsd: number;
  readonly cacheWritePerMillionUsd: number;
}

const MODEL_PRICING_TABLE: Readonly<Record<string, ModelPricingRate>> = {
  "claude-opus-4-6": {
    inputPerMillionUsd: 5.0,
    outputPerMillionUsd: 25.0,
    cacheReadPerMillionUsd: 0.5,
    cacheWritePerMillionUsd: 6.25,
  },
  "claude-sonnet-4-6": {
    inputPerMillionUsd: 3.0,
    outputPerMillionUsd: 15.0,
    cacheReadPerMillionUsd: 0.3,
    cacheWritePerMillionUsd: 3.75,
  },
  "gpt-5.4": {
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 10.0,
    cacheReadPerMillionUsd: 0.25,
    cacheWritePerMillionUsd: 1.25,
  },
  "gpt-5.3-codex": {
    inputPerMillionUsd: 2.0,
    outputPerMillionUsd: 8.0,
    cacheReadPerMillionUsd: 0.2,
    cacheWritePerMillionUsd: 1.0,
  },
  "gemini-3.1-pro": {
    inputPerMillionUsd: 1.25,
    outputPerMillionUsd: 5.0,
    cacheReadPerMillionUsd: 0.31,
    cacheWritePerMillionUsd: 1.25,
  },
};

const DEFAULT_PRICING_RATE: ModelPricingRate = {
  inputPerMillionUsd: 2.5,
  outputPerMillionUsd: 10.0,
  cacheReadPerMillionUsd: 0.25,
  cacheWritePerMillionUsd: 1.25,
};

export function resolveModelPricingRate(model: string): ModelPricingRate {
  const normalized = model.trim().toLowerCase();
  for (const [key, rate] of Object.entries(MODEL_PRICING_TABLE)) {
    if (normalized.includes(key)) {
      return rate;
    }
  }
  return DEFAULT_PRICING_RATE;
}

export interface BuildPromptTelemetryInput {
  readonly promptId: string;
  readonly conversationId: string;
  readonly surface: PromptSurfaceKind;
  readonly promptSummary: string;
  readonly promptSentAtIso: string;
  readonly promptFinishedAtIso: string;
  readonly ttftMs: number;
  readonly latencyMs?: number;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheTokensIn: number;
  readonly cacheTokensOut?: number;
  readonly requestCount?: number;
  readonly agentCount?: number;
  readonly commands?: readonly PromptCommandExecutionMetric[];
  readonly agents?: readonly PromptAgentTelemetryMetric[];
}

export function buildPromptTelemetryRecord(
  input: BuildPromptTelemetryInput,
): PromptTelemetryRecord {
  const sentMs = Date.parse(input.promptSentAtIso);
  const finishedMs = Date.parse(input.promptFinishedAtIso);
  const rawDurationMs =
    Number.isFinite(sentMs) && Number.isFinite(finishedMs) && finishedMs >= sentMs
      ? finishedMs - sentMs
      : Math.max(1, input.latencyMs ?? 1200);
  const durationMs = Math.max(1, rawDurationMs);
  const latencyMs = Math.max(1, input.latencyMs ?? durationMs);
  const ttftMs = Math.max(1, Math.min(latencyMs, input.ttftMs));

  const tokensIn = Math.max(0, Math.floor(input.tokensIn));
  const tokensOut = Math.max(0, Math.floor(input.tokensOut));
  const cacheTokensIn = Math.max(0, Math.floor(input.cacheTokensIn));
  const cacheTokensOut = Math.max(0, Math.floor(input.cacheTokensOut ?? 0));

  const totalPromptContextTokens = tokensIn + cacheTokensIn;
  const cacheHitPercent =
    totalPromptContextTokens > 0
      ? Number(((cacheTokensIn / totalPromptContextTokens) * 100).toFixed(1))
      : 0;

  const generationWindowSec = Math.max(0.05, (latencyMs - ttftMs) / 1000);
  const tokensPerSecond =
    tokensOut > 0 ? Number((tokensOut / generationWindowSec).toFixed(1)) : 0;

  const rate = resolveModelPricingRate(input.model);
  const costInUsd = Number(((tokensIn / 1_000_000) * rate.inputPerMillionUsd).toFixed(6));
  const costOutUsd = Number(((tokensOut / 1_000_000) * rate.outputPerMillionUsd).toFixed(6));
  const costCacheInUsd = Number(
    ((cacheTokensIn / 1_000_000) * rate.cacheReadPerMillionUsd).toFixed(6),
  );
  const costCacheOutUsd = Number(
    ((cacheTokensOut / 1_000_000) * rate.cacheWritePerMillionUsd).toFixed(6),
  );
  const costCacheUsd = Number((costCacheInUsd + costCacheOutUsd).toFixed(6));
  const costTotalUsd = Number((costInUsd + costOutUsd + costCacheUsd).toFixed(6));

  const commands = input.commands ? [...input.commands] : [];
  const agents = input.agents ? [...input.agents] : [];
  const requestCount = Math.max(
    1,
    input.requestCount ?? (agents.reduce((acc, a) => acc + a.requestCount, 0) || 1),
  );
  const agentCount = Math.max(1, input.agentCount ?? (agents.length || 1));
  const requestsPerMinute = Number(((requestCount / (durationMs / 60_000))).toFixed(2));

  return {
    promptId: input.promptId,
    conversationId: input.conversationId,
    surface: input.surface,
    promptSummary: input.promptSummary,
    promptSentAtIso: input.promptSentAtIso,
    promptFinishedAtIso: input.promptFinishedAtIso,
    durationMs,
    ttftMs,
    latencyMs,
    tokensPerSecond,
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    tokensIn,
    tokensOut,
    cacheTokensIn,
    cacheTokensOut,
    cacheHitPercent,
    costInUsd,
    costOutUsd,
    costCacheInUsd,
    costCacheOutUsd,
    costCacheUsd,
    costTotalUsd,
    requestCount,
    requestsPerMinute,
    agentCount,
    commands,
    agents,
  };
}

export function aggregateGlobalPromptTelemetry(
  records: readonly PromptTelemetryRecord[],
): GlobalPromptTelemetrySummary {
  const bySurface: Record<PromptSurfaceKind, number> = {
    "main-chat": 0,
    "ide-sidebar": 0,
    "browser-sidebar": 0,
    subagent: 0,
  };

  if (records.length === 0) {
    return {
      totalPrompts: 0,
      totalRequests: 0,
      averageRequestsPerMinute: 0,
      totalAgentsInvolved: 0,
      totalDurationMs: 0,
      averageTtftMs: 0,
      averageLatencyMs: 0,
      averageTokensPerSecond: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCacheTokensIn: 0,
      totalCacheTokensOut: 0,
      overallCacheHitPercent: 0,
      totalCostInUsd: 0,
      totalCostOutUsd: 0,
      totalCostCacheInUsd: 0,
      totalCostCacheOutUsd: 0,
      totalCostCacheUsd: 0,
      totalCostUsd: 0,
      totalCommandsExecuted: 0,
      totalCommandDurationMs: 0,
      bySurface,
    };
  }

  let totalRequests = 0;
  let totalAgentsInvolved = 0;
  let totalDurationMs = 0;
  let sumTtftMs = 0;
  let sumLatencyMs = 0;
  let sumTokPerSec = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCacheTokensIn = 0;
  let totalCacheTokensOut = 0;
  let totalCostInUsd = 0;
  let totalCostOutUsd = 0;
  let totalCostCacheInUsd = 0;
  let totalCostCacheOutUsd = 0;
  let totalCostCacheUsd = 0;
  let totalCostUsd = 0;
  let totalCommandsExecuted = 0;
  let totalCommandDurationMs = 0;

  for (const record of records) {
    bySurface[record.surface] = (bySurface[record.surface] ?? 0) + 1;
    totalRequests += record.requestCount;
    totalAgentsInvolved += record.agentCount;
    totalDurationMs += record.durationMs;
    sumTtftMs += record.ttftMs;
    sumLatencyMs += record.latencyMs;
    sumTokPerSec += record.tokensPerSecond;
    totalTokensIn += record.tokensIn;
    totalTokensOut += record.tokensOut;
    totalCacheTokensIn += record.cacheTokensIn;
    totalCacheTokensOut += record.cacheTokensOut;
    totalCostInUsd += record.costInUsd;
    totalCostOutUsd += record.costOutUsd;
    totalCostCacheInUsd += record.costCacheInUsd;
    totalCostCacheOutUsd += record.costCacheOutUsd;
    totalCostCacheUsd += record.costCacheUsd;
    totalCostUsd += record.costTotalUsd;
    totalCommandsExecuted += record.commands.length;
    for (const cmd of record.commands) {
      totalCommandDurationMs += cmd.durationMs;
    }
  }

  const count = records.length;
  const totalContextTokens = totalTokensIn + totalCacheTokensIn;
  const overallCacheHitPercent =
    totalContextTokens > 0
      ? Number(((totalCacheTokensIn / totalContextTokens) * 100).toFixed(1))
      : 0;
  const averageRequestsPerMinute =
    totalDurationMs > 0
      ? Number(((totalRequests / (totalDurationMs / 60_000))).toFixed(2))
      : 0;

  return {
    totalPrompts: count,
    totalRequests,
    averageRequestsPerMinute,
    totalAgentsInvolved,
    totalDurationMs,
    averageTtftMs: Math.round(sumTtftMs / count),
    averageLatencyMs: Math.round(sumLatencyMs / count),
    averageTokensPerSecond: Number((sumTokPerSec / count).toFixed(1)),
    totalTokensIn,
    totalTokensOut,
    totalCacheTokensIn,
    totalCacheTokensOut,
    overallCacheHitPercent,
    totalCostInUsd: Number(totalCostInUsd.toFixed(6)),
    totalCostOutUsd: Number(totalCostOutUsd.toFixed(6)),
    totalCostCacheInUsd: Number(totalCostCacheInUsd.toFixed(6)),
    totalCostCacheOutUsd: Number(totalCostCacheOutUsd.toFixed(6)),
    totalCostCacheUsd: Number(totalCostCacheUsd.toFixed(6)),
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    totalCommandsExecuted,
    totalCommandDurationMs,
    bySurface,
  };
}

export function formatDetailedPromptTimestamp(iso: string): string {
  const trimmed = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(trimmed)) {
    const normalized = trimmed.replace("T", " ").replace(/Z$/i, " UTC");
    return normalized;
  }
  return trimmed;
}

export function formatTelemetryUsd(amountUsd: number): string {
  if (amountUsd === 0) return "$0.0000";
  if (amountUsd < 0.01) return `$${amountUsd.toFixed(4)}`;
  return `$${amountUsd.toFixed(3)}`;
}

export function formatTelemetryDurationMs(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1000).toFixed(2)}s`;
}
