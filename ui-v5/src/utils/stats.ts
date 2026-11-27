/**
 * Deterministic statistical distribution helpers (p50/p90/p95/p99/Min/Max/Mean/StdDev/IQR/Outliers)
 * and formatting helpers for Omnia Lab-Grade Telemetry & Network Observatory.
 * Zero external charting libraries or CDN dependencies.
 */

export interface MetricDistribution {
  count: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  stdDev: number;
  iqr: number;
  outlierCount: number;
  histogram: number[];
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export function computeDistribution(values: number[], bins = 12): MetricDistribution {
  const finite = values.filter((v) => Number.isFinite(v));
  const n = finite.length;
  if (n === 0) {
    return {
      count: 0,
      min: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      max: 0,
      mean: 0,
      stdDev: 0,
      iqr: 0,
      outlierCount: 0,
      histogram: new Array<number>(bins).fill(0),
    };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / n;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = Math.max(0, q3 - q1);
  const hiFence = q3 + 1.5 * iqr;
  const loFence = q1 - 1.5 * iqr;
  const outlierCount = sorted.filter((v) => v > hiFence || v < loFence).length;

  const min = sorted[0];
  const max = sorted[n - 1];
  const span = max - min;
  const histogram = new Array<number>(bins).fill(0);
  for (const v of sorted) {
    const idx = span <= 1e-9 ? 0 : Math.min(bins - 1, Math.floor(((v - min) / span) * bins));
    histogram[idx]++;
  }

  return {
    count: n,
    min,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max,
    mean,
    stdDev,
    iqr,
    outlierCount,
    histogram,
  };
}

export function parseBackendDistribution(raw: unknown, fallbackValues: number[]): MetricDistribution {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const count = Number(r.count ?? r.n ?? fallbackValues.length);
    if (count > 0 || r.p50 !== undefined) {
      const fb = computeDistribution(fallbackValues);
      return {
        count: Number.isFinite(count) ? count : fb.count,
        min: Number(r.min ?? fb.min),
        p50: Number(r.p50 ?? fb.p50),
        p90: Number(r.p90 ?? fb.p90),
        p95: Number(r.p95 ?? fb.p95),
        p99: Number(r.p99 ?? fb.p99),
        max: Number(r.max ?? fb.max),
        mean: Number(r.mean ?? fb.mean),
        stdDev: Number(r.stdDev ?? r.std_dev ?? fb.stdDev),
        iqr: Number(r.iqr ?? fb.iqr),
        outlierCount: Number(r.outlierCount ?? r.outlier_count ?? fb.outlierCount),
        histogram: Array.isArray(r.histogram) ? r.histogram.map(Number) : fb.histogram,
      };
    }
  }
  return computeDistribution(fallbackValues);
}

export function sparklinePoints(values: number[], width: number, height: number, pad = 3): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1e-6);
  return values
    .map((v, i) => {
      const x = values.length === 1 ? width / 2 : pad + (i / (values.length - 1)) * (width - pad * 2);
      const y = height - pad - ((v - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function formatCost6(usd: number | null | undefined): string {
  const n = Number(usd ?? 0);
  if (!Number.isFinite(n)) return '$0.000000';
  return `$${n.toFixed(6)}`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
  const n = Number(ms);
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${n.toFixed(n < 10 ? 1 : 0)}ms`;
}

export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatMbps(mbps: number | null | undefined): string {
  if (mbps === null || mbps === undefined || !Number.isFinite(Number(mbps))) return '—';
  return `${Number(mbps).toFixed(1)} Mbps`;
}

export function bufferbloatColorVar(grade: string | null | undefined): string {
  const g = (grade ?? '').toUpperCase();
  if (g === 'A+' || g === 'A') return 'var(--status-emerald)';
  if (g === 'B') return 'var(--accent-cyan)';
  if (g === 'C') return 'var(--accent-amber)';
  if (g === 'D' || g === 'F') return 'var(--status-coral)';
  return 'var(--ink-muted)';
}
