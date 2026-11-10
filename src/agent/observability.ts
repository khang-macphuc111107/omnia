export interface RunMetric { id: string; sessionId: string; goalId?: string; startedAtMs: number; finishedAtMs?: number; inputTokens: number; outputTokens: number; estimatedCostUsd?: number; status: "running" | "completed" | "failed" | "interrupted"; }
export interface MetricSummary { runs: number; completed: number; inputTokens: number; outputTokens: number; tokensPerSecond: number; requestsPerMinute: number; estimatedCostUsd: number; series: { label: string; value: number }[]; }

export function summarizeMetrics(metrics: readonly RunMetric[], now = Date.now()): MetricSummary {
  const completed = metrics.filter((metric) => metric.status === "completed");
  const inputTokens = metrics.reduce((total, metric) => total + Math.max(0, metric.inputTokens), 0);
  const outputTokens = metrics.reduce((total, metric) => total + Math.max(0, metric.outputTokens), 0);
  const durations = completed.reduce((total, metric) => total + Math.max(1, (metric.finishedAtMs ?? now) - metric.startedAtMs), 0);
  const window = Math.max(1, metrics.reduce((min, metric) => Math.min(min, metric.startedAtMs), now));
  const seconds = Math.max(1, durations / 1000);
  return { runs: metrics.length, completed: completed.length, inputTokens, outputTokens, tokensPerSecond: Math.round(((inputTokens + outputTokens) / seconds) * 10) / 10, requestsPerMinute: Math.round((metrics.length / Math.max(1 / 60, (now - window) / 60_000)) * 10) / 10, estimatedCostUsd: Math.round(metrics.reduce((total, metric) => total + (metric.estimatedCostUsd ?? 0), 0) * 1_000_000) / 1_000_000, series: completed.map((metric) => ({ label: new Date(metric.finishedAtMs ?? now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), value: metric.inputTokens + metric.outputTokens })) };
}
