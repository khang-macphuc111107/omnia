/** Small presentation helpers; pure and dependency free. */

const SUMMARY_KEYS = ["path", "file_path", "filePath", "command", "pattern", "query", "url", "description"] as const;

export function toolSummary(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.replace(/\s+/g, " ").trim().slice(0, 160);
      }
    }
  }
  return name;
}

export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function relativeTime(thenMs: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  return new Date(thenMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 100_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(count / 1000)}k`;
}

/** Harness default; a run may configure a different compaction threshold. */
export const COMPACTION_THRESHOLD = 0.8;

/** Mirrors compact::context_window_for defaults; run overrides are not on this wire. */
export function contextWindow(model: string): number {
  const id = model.toLowerCase();
  if (id.includes("1m")) return 1_000_000;
  if (id.includes("claude")) return 200_000;
  if (id.includes("gemini")) return 1_000_000;
  if (id.includes("gpt-5")) return 400_000;
  if (id.startsWith("o3") || id.startsWith("o4") || id.includes("/o3") || id.includes("/o4")) return 200_000;
  return 128_000;
}

export interface ContextUsage {
  used: number;
  window: number;
  /** 0..100, one decimal at most. */
  percent: number;
  warn: boolean;
}

/** Estimates context occupancy from the latest usage (input plus cached tokens). */
export function contextUsage(
  usage: { input_tokens: number; cache_read_tokens: number; cache_write_tokens: number },
  model: string,
): ContextUsage {
  const used = Math.max(0, usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens);
  const window = contextWindow(model);
  const percent = Math.min(100, Math.round((used / window) * 1000) / 10);
  return { used, window, percent, warn: used / window >= COMPACTION_THRESHOLD };
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export interface FolderGroup<T> {
  cwd: string;
  name: string;
  sessions: T[];
}

/** Groups by workspace folder; groups ordered by their most recent session. */
export function groupByFolder<T extends { cwd: string; updatedAtMs: number }>(sessions: T[]): FolderGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const session of sessions) {
    const list = groups.get(session.cwd) ?? [];
    list.push(session);
    groups.set(session.cwd, list);
  }
  return [...groups.entries()]
    .map(([cwd, list]) => ({
      cwd,
      name: folderName(cwd),
      sessions: list.sort((a, b) => b.updatedAtMs - a.updatedAtMs),
    }))
    .sort((a, b) => (b.sessions[0]?.updatedAtMs ?? 0) - (a.sessions[0]?.updatedAtMs ?? 0));
}
