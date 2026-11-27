import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import { Activity, AlertTriangle, Filter, RefreshCw, Sparkles } from 'lucide-solid';
import { api } from '@/api/client';
import {
  activeSessionId,
  openObservabilityTab,
  privacyMask,
  refreshSmartAlerts,
  smartAlerts,
} from '@/state/studio';
import type { ObservabilitySubTab, TelemetryRequestRow, TelemetryWindow } from '@/types';
import { maskText } from '@/utils/privacy';
import {
  type MetricDistribution,
  formatCost6,
  formatMs,
  parseBackendDistribution,
  sparklinePoints,
} from '@/utils/stats';

function DistributionCard(props: {
  title: string;
  dist: MetricDistribution;
  series: number[];
  unit: 'ms' | 'tps' | 'usd';
  accentVar: string;
}) {
  const fmt = (v: number) => {
    if (props.unit === 'usd') return formatCost6(v);
    if (props.unit === 'ms') return formatMs(v);
    return `${v.toFixed(1)} tok/s`;
  };

  const maxBin = () => Math.max(1, ...props.dist.histogram);
  const spark = () => sparklinePoints(props.series.slice(-30), 160, 34, 3);

  return (
    <div class="omnia-surface-panel rounded-lg p-3 space-y-2 min-w-0">
      <div class="flex items-center justify-between gap-2 text-[11.5px]">
        <span class="font-semibold text-[var(--ink-primary)] truncate">{props.title}</span>
        <span class="font-mono-num text-[10.5px] text-[var(--ink-muted)] shrink-0">
          n={props.dist.count}
          {props.dist.outlierCount > 0 ? ` · ${props.dist.outlierCount} out` : ''}
        </span>
      </div>

      <div class="grid grid-cols-4 gap-1.5 text-[11px] font-mono-num">
        <div class="p-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
          <div class="text-[9.5px] text-[var(--ink-muted)]">p50</div>
          <div class="font-bold text-[var(--ink-primary)] truncate">{fmt(props.dist.p50)}</div>
        </div>
        <div class="p-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
          <div class="text-[9.5px] text-[var(--ink-muted)]">p90</div>
          <div class="font-semibold text-[var(--ink-secondary)] truncate">{fmt(props.dist.p90)}</div>
        </div>
        <div class="p-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
          <div class="text-[9.5px] text-[var(--ink-muted)]">p95</div>
          <div class="font-semibold text-[var(--accent-amber)] truncate">{fmt(props.dist.p95)}</div>
        </div>
        <div class="p-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
          <div class="text-[9.5px] text-[var(--ink-muted)]">p99</div>
          <div class="font-semibold text-[var(--status-coral)] truncate">{fmt(props.dist.p99)}</div>
        </div>
      </div>

      <div class="grid grid-cols-5 gap-1 text-[10px] font-mono-num text-[var(--ink-muted)]">
        <span class="truncate">min:{fmt(props.dist.min)}</span>
        <span class="truncate">max:{fmt(props.dist.max)}</span>
        <span class="truncate">μ:{fmt(props.dist.mean)}</span>
        <span class="truncate">σ:{fmt(props.dist.stdDev)}</span>
        <span class="truncate">IQR:{fmt(props.dist.iqr)}</span>
      </div>

      {/* Zero-CDN Inline SVG Histogram + Sparkline */}
      <div class="grid grid-cols-2 gap-2 pt-1">
        <svg viewBox="0 0 120 34" class="w-full h-9 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
          <For each={props.dist.histogram}>
            {(count, idx) => {
              const bh = Math.max(2, (count / maxBin()) * 28);
              const bw = 112 / Math.max(props.dist.histogram.length, 1);
              return (
                <rect
                  x={4 + idx() * bw}
                  y={31 - bh}
                  width={Math.max(2, bw - 2)}
                  height={bh}
                  rx="1"
                  fill={props.accentVar}
                  fill-opacity={count > 0 ? '0.82' : '0.12'}
                />
              );
            }}
          </For>
        </svg>
        <svg viewBox="0 0 160 34" class="w-full h-9 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
          <line x1="0" y1="17" x2="160" y2="17" stroke="var(--border-subtle)" stroke-width="1" stroke-dasharray="2 2" />
          <Show when={spark().length > 0}>
            <polyline fill="none" stroke={props.accentVar} stroke-width="1.8" points={spark()} />
          </Show>
        </svg>
      </div>
    </div>
  );
}

function normalizeRequestRow(raw: Record<string, unknown>, idx: number): TelemetryRequestRow {
  const dur = Number(raw.durationMs ?? raw.duration_ms ?? 0);
  const outTok = Number(raw.outputTokens ?? raw.output_tokens ?? 0);
  const ttft = raw.ttftMs !== undefined && raw.ttftMs !== null
    ? Number(raw.ttftMs)
    : raw.ttft_ms !== undefined && raw.ttft_ms !== null
      ? Number(raw.ttft_ms)
      : null;
  const decodeMs = Math.max(1, dur - (ttft ?? 0));
  const tpot = raw.tpotMs !== undefined && raw.tpotMs !== null
    ? Number(raw.tpotMs)
    : outTok > 0
      ? decodeMs / outTok
      : null;
  const activeTps = Number(
    raw.activeDecodeTps ?? raw.active_decode_tps ?? raw.tokensPerSecond ?? raw.tokens_per_second ?? (outTok > 0 ? (outTok * 1000) / decodeMs : 0),
  );
  const e2eTps = Number(
    raw.e2eTps ?? raw.e2e_tps ?? (dur > 0 && outTok > 0 ? (outTok * 1000) / dur : activeTps),
  );
  return {
    traceId: String(raw.traceId ?? raw.trace_id ?? `trc-${idx}`),
    reqId: String(raw.reqId ?? raw.req_id ?? raw.traceId ?? `req-${idx}`),
    sessionId: String(raw.sessionId ?? raw.session_id ?? 'default'),
    workspace: raw.workspace ? String(raw.workspace) : undefined,
    gitBranch: raw.gitBranch ? String(raw.gitBranch) : undefined,
    role: String(raw.role ?? raw.surface ?? 'main'),
    providerId: String(raw.providerId ?? raw.provider ?? raw.provider_id ?? 'omnia'),
    modelId: String(raw.modelId ?? raw.model ?? raw.model_id ?? 'unknown'),
    wireDialect: String(raw.wireDialect ?? raw.wire_dialect ?? 'auto'),
    reasoningEffort: String(raw.reasoningEffort ?? raw.effort ?? 'max'),
    status: String(raw.status ?? (raw.isError || raw.is_error ? 'error' : 'ok')),
    ttftMs: ttft,
    tpotMs: tpot,
    durationMs: dur,
    activeDecodeTps: activeTps,
    e2eTps,
    stallRetries: Number(raw.stallRetries ?? raw.retries ?? 0),
    hedgeWins: Number(raw.hedgeWins ?? raw.hedge_wins ?? 0),
    inputTokens: Number(raw.inputTokens ?? raw.input_tokens ?? 0),
    outputTokens: outTok,
    reasoningTokens: Number(raw.reasoningTokens ?? raw.reasoning_tokens ?? 0),
    cacheReadTokens: Number(raw.cacheReadTokens ?? raw.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(raw.cacheWriteTokens ?? raw.cache_write_tokens ?? 0),
    prefixHash: raw.prefixHash ? String(raw.prefixHash) : undefined,
    cacheBustReason: raw.cacheBustReason ? String(raw.cacheBustReason) : undefined,
    contextWindowFillPct:
      raw.contextWindowFillPct !== undefined ? Number(raw.contextWindowFillPct) : undefined,
    costUsd: Number(raw.costUsd ?? raw.cost_usd ?? 0),
    kvSavingsUsd: Number(raw.kvSavingsUsd ?? raw.kv_savings_usd ?? 0),
    isError: Boolean(raw.isError ?? raw.is_error),
    isOutlier: Boolean(raw.isOutlier ?? raw.is_outlier),
    errorNote: raw.errorNote ? String(raw.errorNote) : undefined,
    recordedAtMs: Number(raw.recordedAtMs ?? raw.recorded_at_ms ?? Date.now()),
  };
}

export function AiTelemetryPanel(props: { refreshSeq: number }) {
  const [windowSel, setWindowSel] = createSignal<TelemetryWindow>('24h');
  const [modelFilter, setModelFilter] = createSignal('');
  const [roleFilter, setRoleFilter] = createSignal('');
  const [sessionFilter, setSessionFilter] = createSignal('');
  const [outliersOnly, setOutliersOnly] = createSignal(false);
  const [summary, setSummary] = createSignal<Record<string, unknown> | null>(null);
  const [rows, setRows] = createSignal<TelemetryRequestRow[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [loadNote, setLoadNote] = createSignal('');

  const loadTelemetry = async () => {
    setLoading(true);
    const params = {
      window: windowSel(),
      model: modelFilter() || undefined,
      role: roleFilter() || undefined,
      sessionId: sessionFilter() || undefined,
      privacyMask: privacyMask(),
    };
    const [sumRes, reqRes] = await Promise.all([
      api.getTelemetrySummary(params),
      api.getTelemetryRequests({ ...params, limit: 120 }),
      refreshSmartAlerts(),
    ]);

    if (sumRes.ok) {
      const inner =
        sumRes.data.summary && typeof sumRes.data.summary === 'object'
          ? (sumRes.data.summary as Record<string, unknown>)
          : sumRes.data;
      setSummary(inner);
      setLoadNote('');
    } else {
      // Graceful fallback to legacy /api/stats/spotlight
      const fb = await api.getSpotlightStats();
      if (fb.ok) {
        const inner =
          fb.data.summary && typeof fb.data.summary === 'object'
            ? (fb.data.summary as Record<string, unknown>)
            : fb.data;
        setSummary(inner);
      } else {
        setLoadNote(`Telemetry note (${sumRes.error.code}): ${sumRes.error.message}`);
      }
    }

    if (reqRes.ok) {
      const list = (reqRes.data.requests ?? reqRes.data.traces ?? reqRes.data.items) as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(list)) {
        setRows(list.map(normalizeRequestRow));
      }
    } else {
      const trFb = await api.getTraces();
      if (trFb.ok) {
        const list = (trFb.data.traces ?? trFb.data.recentTraces ?? []) as Array<Record<string, unknown>>;
        setRows(list.map(normalizeRequestRow));
      }
    }
    setLoading(false);
  };

  onMount(() => {
    void loadTelemetry();
  });

  createEffect(() => {
    props.refreshSeq;
    windowSel();
    privacyMask();
    void loadTelemetry();
  });

  const uniqueModels = createMemo(() => Array.from(new Set(rows().map((r) => r.modelId).filter(Boolean))).sort());
  const uniqueRoles = createMemo(() => Array.from(new Set(rows().map((r) => r.role).filter(Boolean))).sort());

  const filteredRows = createMemo(() => {
    const m = modelFilter();
    const role = roleFilter();
    const sess = sessionFilter().trim().toLowerCase();
    const onlyOut = outliersOnly();
    return rows().filter((r) => {
      if (m && r.modelId !== m) return false;
      if (role && r.role !== role) return false;
      if (sess && !r.sessionId.toLowerCase().includes(sess)) return false;
      if (onlyOut && !r.isOutlier && !r.isError) return false;
      return true;
    });
  });

  const backendDists = createMemo(() => (summary()?.distributions as Record<string, unknown> | undefined) ?? {});

  const ttftDist = createMemo(() =>
    parseBackendDistribution(
      backendDists().ttftMs,
      filteredRows().map((r) => r.ttftMs).filter((v): v is number => v !== null && v > 0),
    ),
  );
  const tpotDist = createMemo(() =>
    parseBackendDistribution(
      backendDists().tpotMs,
      filteredRows().map((r) => r.tpotMs).filter((v): v is number => v !== null && v > 0),
    ),
  );
  const activeTpsDist = createMemo(() =>
    parseBackendDistribution(
      backendDists().activeDecodeTps,
      filteredRows().map((r) => r.activeDecodeTps).filter((v) => v > 0),
    ),
  );
  const e2eTpsDist = createMemo(() =>
    parseBackendDistribution(
      backendDists().e2eTps,
      filteredRows().map((r) => r.e2eTps).filter((v) => v > 0),
    ),
  );
  const durDist = createMemo(() =>
    parseBackendDistribution(
      backendDists().durationMs,
      filteredRows().map((r) => r.durationMs).filter((v) => v > 0),
    ),
  );
  const costDist = createMemo(() =>
    parseBackendDistribution(
      backendDists().costUsd,
      filteredRows().map((r) => r.costUsd).filter((v) => v >= 0),
    ),
  );

  const totals = createMemo(() => {
    const s = summary();
    const t = (s?.totals && typeof s.totals === 'object' ? (s.totals as Record<string, unknown>) : s) ?? {};
    const totalCost = Number(t.totalCostUsd ?? t.totalCost ?? filteredRows().reduce((a, r) => a + r.costUsd, 0));
    const kvSavings = Number(s?.kvSavingsUsd ?? t.kvSavingsUsd ?? filteredRows().reduce((a, r) => a + r.kvSavingsUsd, 0));
    const cacheRate = Number(t.cacheHitRate ?? t.cacheRate ?? 0);
    const totalReqs = Number(t.totalRequests ?? filteredRows().length);
    const errRate = Number(t.errorRate ?? 0);
    const ctxObj = (s?.contextWindow && typeof s.contextWindow === 'object' ? (s.contextWindow as Record<string, unknown>) : {}) as Record<string, unknown>;
    const fillPct = Number(ctxObj.latestFillPct ?? ctxObj.peakFillPct ?? ctxObj.fillPct ?? ctxObj.fill_pct ?? 0);
    const etaTurns = ctxObj.compactionEtaTurns ?? ctxObj.compaction_eta_turns;
    return { totalCost, kvSavings, cacheRate, totalReqs, errRate, fillPct, etaTurns };
  });

  const cacheTrendPoints = createMemo(() => {
    const rawTrend = summary()?.cacheTrend;
    if (Array.isArray(rawTrend) && rawTrend.length > 0) {
      const vals = rawTrend.map((pt) => {
        if (typeof pt === 'number') return pt;
        const rec = pt as Record<string, unknown>;
        return Number(rec.cacheHitPct ?? rec.hitRate ?? rec.rate ?? 0);
      });
      return sparklinePoints(vals, 260, 48, 4);
    }
    const derived = filteredRows()
      .slice()
      .reverse()
      .map((r) => {
        const denom = r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
        return denom > 0 ? (r.cacheReadTokens / denom) * 100 : 0;
      });
    return sparklinePoints(derived, 260, 48, 4);
  });

  const cacheBustBreakdown = createMemo(() => {
    const raw = summary()?.cacheBustReasons;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.entries(raw as Record<string, unknown>).map(([reason, count]) => ({
        reason,
        count: Number(count ?? 0),
      }));
    }
    const counts = new Map<string, number>();
    for (const r of filteredRows()) {
      if (r.cacheBustReason) counts.set(r.cacheBustReason, (counts.get(r.cacheBustReason) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([reason, count]) => ({ reason, count }));
  });

  return (
    <div data-testid="obs-telemetry-panel" class="space-y-4">
      {/* Smart Alerts Strip */}
      <Show when={smartAlerts.length > 0}>
        <div class="omnia-surface-panel rounded-lg p-3 border-[var(--accent-amber)] space-y-1.5">
          <div class="flex items-center justify-between text-[11.5px] font-semibold">
            <span class="flex items-center gap-1.5 text-[var(--accent-amber)]">
              <AlertTriangle class="w-3.5 h-3.5" />
              <span>Smart Alerts ({smartAlerts.length})</span>
            </span>
            <span class="font-mono-num text-[10.5px] text-[var(--ink-muted)]">Live Rules: TTFT / Cache / Circuit / Bloat / DNS / Disk</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <For each={smartAlerts}>
              {(alert) => (
                <button
                  type="button"
                  onClick={() => alert.targetTab && openObservabilityTab(alert.targetTab as ObservabilitySubTab)}
                  class="px-2.5 py-1 rounded border text-left text-[11.5px] cursor-pointer flex items-center gap-2"
                  classList={{
                    'border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[var(--status-coral)]':
                      alert.severity === 'critical',
                    'border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] text-[var(--accent-amber)]':
                      alert.severity === 'warning',
                    'border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--ink-secondary)]':
                      alert.severity === 'info',
                  }}
                >
                  <span class="font-semibold">{alert.title}</span>
                  <span class="text-[11px] opacity-90">{maskText(alert.detail, privacyMask())}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Filters & Window Controls */}
      <div class="omnia-surface-panel rounded-lg p-3 flex flex-wrap items-center justify-between gap-2 text-[12px]">
        <div class="flex flex-wrap items-center gap-2">
          <div class="omp-segmented text-[11.5px]">
            {(['1h', '24h', '7d', 'all'] as TelemetryWindow[]).map((w) => (
              <button
                type="button"
                aria-pressed={windowSel() === w}
                onClick={() => setWindowSel(w)}
              >
                {w === 'all' ? 'All' : w}
              </button>
            ))}
          </div>

          <div class="flex items-center gap-1.5">
            <Filter class="w-3.5 h-3.5 text-[var(--ink-muted)]" />
            <select
              aria-label="Filter by Model"
              value={modelFilter()}
              onChange={(e) => setModelFilter(e.currentTarget.value)}
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
            >
              <option value="">All Models</option>
              <For each={uniqueModels()}>{(m) => <option value={m}>{m}</option>}</For>
            </select>

            <select
              aria-label="Filter by Role"
              value={roleFilter()}
              onChange={(e) => setRoleFilter(e.currentTarget.value)}
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
            >
              <option value="">All Roles</option>
              <For each={uniqueRoles()}>{(r) => <option value={r}>{r}</option>}</For>
            </select>

            <input
              type="text"
              placeholder={`Session filter (e.g. ${activeSessionId().slice(0, 10)})`}
              value={sessionFilter()}
              onInput={(e) => setSessionFilter(e.currentTarget.value)}
              class="w-40 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px] font-mono-num outline-none"
            />

            <label class="flex items-center gap-1.5 text-[11.5px] cursor-pointer px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
              <input
                type="checkbox"
                checked={outliersOnly()}
                onChange={(e) => setOutliersOnly(e.currentTarget.checked)}
              />
              <span>Outliers / Errors</span>
            </label>
          </div>
        </div>

        <button
          type="button"
          disabled={loading()}
          class="omnia-btn text-[11px]"
          onClick={() => void loadTelemetry()}
        >
          <RefreshCw class="w-3.5 h-3.5" classList={{ 'animate-spin': loading() }} />
          <span>Apply</span>
        </button>
      </div>

      <Show when={loadNote()}>
        <div class="px-3 py-2 rounded border border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] text-[11.5px] font-mono-num text-[var(--accent-amber)]">
          {loadNote()}
        </div>
      </Show>

      {/* Top KPI + Prefix-0 KV Cache Trend + Context Window Fill % */}
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
          <div class="text-[11.5px] font-semibold text-[var(--ink-secondary)] flex items-center justify-between">
            <span>Spend & KV Savings (6-Decimal USD)</span>
            <span class="omnia-badge text-[var(--status-emerald)]">budget: UNBOUNDED</span>
          </div>
          <div class="grid grid-cols-2 gap-2 font-mono-num">
            <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
              <div class="text-[10px] text-[var(--ink-muted)]">Total Spend</div>
              <div class="text-[15px] font-bold text-[var(--ink-primary)]">{formatCost6(totals().totalCost)}</div>
            </div>
            <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
              <div class="text-[10px] text-[var(--ink-muted)]">KV Cache Saved</div>
              <div class="text-[15px] font-bold text-[var(--status-emerald)]">{formatCost6(totals().kvSavings)}</div>
            </div>
          </div>
          <div class="flex items-center justify-between text-[11px] font-mono-num text-[var(--ink-muted)]">
            <span>Requests: {totals().totalReqs}</span>
            <span>Error rate: {(totals().errRate * 100).toFixed(1)}%</span>
          </div>
        </div>

        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
          <div class="text-[11.5px] font-semibold text-[var(--ink-secondary)] flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <Sparkles class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
              <span>Prefix-0 BLAKE3 Cache Hit Trend</span>
            </span>
            <span class="font-mono-num text-[var(--status-emerald)] font-bold">
              {(totals().cacheRate * 100).toFixed(1)}%
            </span>
          </div>
          <svg viewBox="0 0 260 48" class="w-full h-12 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
            <line x1="0" y1="14" x2="260" y2="14" stroke="var(--border-subtle)" stroke-width="1" stroke-dasharray="3 3" />
            <Show when={cacheTrendPoints().length > 0}>
              <polyline fill="none" stroke="var(--status-emerald)" stroke-width="2" points={cacheTrendPoints()} />
            </Show>
          </svg>
          <div class="flex flex-wrap gap-1 text-[10.5px] font-mono-num">
            <Show
              when={cacheBustBreakdown().length > 0}
              fallback={<span class="text-[var(--ink-muted)]">0 prefix cache-bust attributions in window</span>}
            >
              <For each={cacheBustBreakdown()}>
                {(b) => (
                  <span class="omnia-badge text-[var(--accent-amber)]">
                    {b.reason}: {b.count}
                  </span>
                )}
              </For>
            </Show>
          </div>
        </div>

        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
          <div class="text-[11.5px] font-semibold text-[var(--ink-secondary)] flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <Activity class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              <span>Context Window Fill & Compaction ETA</span>
            </span>
            <span class="font-mono-num font-bold text-[var(--accent-cyan)]">
              {totals().fillPct.toFixed(1)}%
            </span>
          </div>
          <div class="w-full h-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-hidden">
            <div
              class="h-full"
              style={{
                width: `${Math.min(100, Math.max(2, totals().fillPct))}%`,
                'background-color':
                  totals().fillPct > 85
                    ? 'var(--status-coral)'
                    : totals().fillPct > 65
                      ? 'var(--accent-amber)'
                      : 'var(--accent-cyan)',
              }}
            />
          </div>
          <div class="flex items-center justify-between text-[11px] font-mono-num text-[var(--ink-muted)]">
            <span>
              Compaction ETA:{' '}
              {totals().etaTurns !== undefined && totals().etaTurns !== null
                ? `~${String(totals().etaTurns)} turns`
                : 'ample headroom'}
            </span>
            <span>Lakeview Anchored</span>
          </div>
        </div>
      </div>

      {/* 6 Distribution Cards: p50/p90/p95/p99/Min/Max/Mean/StdDev/IQR + Histogram + Sparkline */}
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <DistributionCard
          title="TTFT (Time to First Token)"
          dist={ttftDist()}
          series={filteredRows().map((r) => r.ttftMs ?? 0).reverse()}
          unit="ms"
          accentVar="var(--accent-cyan)"
        />
        <DistributionCard
          title="TPOT (Time Per Output Token)"
          dist={tpotDist()}
          series={filteredRows().map((r) => r.tpotMs ?? 0).reverse()}
          unit="ms"
          accentVar="var(--accent-amber)"
        />
        <DistributionCard
          title="Active Decode Throughput"
          dist={activeTpsDist()}
          series={filteredRows().map((r) => r.activeDecodeTps).reverse()}
          unit="tps"
          accentVar="var(--status-emerald)"
        />
        <DistributionCard
          title="End-to-End Throughput"
          dist={e2eTpsDist()}
          series={filteredRows().map((r) => r.e2eTps).reverse()}
          unit="tps"
          accentVar="var(--accent-cyan)"
        />
        <DistributionCard
          title="Turn Request Duration"
          dist={durDist()}
          series={filteredRows().map((r) => r.durationMs).reverse()}
          unit="ms"
          accentVar="var(--accent-amber)"
        />
        <DistributionCard
          title="Per-Request Cost (USD)"
          dist={costDist()}
          series={filteredRows().map((r) => r.costUsd).reverse()}
          unit="usd"
          accentVar="var(--status-emerald)"
        />
      </div>

      {/* Per-Request Waterfall Table */}
      <div class="omnia-surface-panel rounded-lg overflow-hidden">
        <div class="px-3.5 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex items-center justify-between">
          <span class="font-bold text-[12.5px]">Per-Request Wire & SSE Waterfall ({filteredRows().length})</span>
          <span class="text-[11px] font-mono-num text-[var(--ink-muted)]">
            Zero fabricated rows · Real SQLite telemetry
          </span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-[11.5px] font-mono-num">
            <thead>
              <tr class="border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] text-[var(--ink-muted)] text-[10.5px]">
                <th class="px-2.5 py-2">ReqID</th>
                <th class="px-2.5 py-2">Role</th>
                <th class="px-2.5 py-2">Model / Wire</th>
                <th class="px-2.5 py-2">Effort</th>
                <th class="px-2.5 py-2">Status</th>
                <th class="px-2.5 py-2">TTFT</th>
                <th class="px-2.5 py-2">TPOT</th>
                <th class="px-2.5 py-2">Active / E2E TPS</th>
                <th class="px-2.5 py-2">Retry/Hedge</th>
                <th class="px-2.5 py-2">Cost / KV Saved</th>
                <th class="px-2.5 py-2">Prefix-0 / Bust</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--border-subtle)]">
              <Show
                when={filteredRows().length > 0}
                fallback={
                  <tr>
                    <td colspan="11" class="px-4 py-6 text-center text-[var(--ink-muted)]">
                      No requests recorded in the selected window yet. Run a chat turn or benchmark to populate live wire telemetry.
                    </td>
                  </tr>
                }
              >
                <For each={filteredRows().slice(0, 60)}>
                  {(r) => (
                    <tr class="hover:bg-[var(--bg-elevated)]">
                      <td class="px-2.5 py-1.5 text-[var(--accent-cyan)] whitespace-nowrap">
                        {maskText(r.reqId.slice(0, 12), privacyMask())}
                      </td>
                      <td class="px-2.5 py-1.5">{r.role}</td>
                      <td class="px-2.5 py-1.5 max-w-[200px] truncate" title={`${r.modelId} (${r.wireDialect})`}>
                        <span class="text-[var(--ink-primary)]">{r.modelId}</span>
                        <span class="text-[var(--ink-muted)]"> · {r.wireDialect}</span>
                      </td>
                      <td class="px-2.5 py-1.5 uppercase text-[var(--accent-amber)]">{r.reasoningEffort}</td>
                      <td class="px-2.5 py-1.5">
                        <span
                          class="omnia-badge"
                          classList={{
                            'text-[var(--status-emerald)]': !r.isError,
                            'text-[var(--status-coral)]': r.isError,
                          }}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td class="px-2.5 py-1.5">{formatMs(r.ttftMs)}</td>
                      <td class="px-2.5 py-1.5">{formatMs(r.tpotMs)}</td>
                      <td class="px-2.5 py-1.5 whitespace-nowrap">
                        <span class="text-[var(--status-emerald)]">{r.activeDecodeTps.toFixed(1)}</span>
                        <span class="text-[var(--ink-muted)]"> / {r.e2eTps.toFixed(1)}</span>
                      </td>
                      <td class="px-2.5 py-1.5">
                        {r.stallRetries} / {r.hedgeWins}
                      </td>
                      <td class="px-2.5 py-1.5 whitespace-nowrap">
                        <span>{formatCost6(r.costUsd)}</span>
                        <Show when={r.kvSavingsUsd > 0}>
                          <span class="text-[var(--status-emerald)]"> (-{formatCost6(r.kvSavingsUsd)})</span>
                        </Show>
                      </td>
                      <td class="px-2.5 py-1.5 max-w-[160px] truncate">
                        {r.cacheBustReason ? (
                          <span class="text-[var(--accent-amber)]">{r.cacheBustReason}</span>
                        ) : r.prefixHash ? (
                          <span class="text-[var(--status-emerald)]">{r.prefixHash.slice(0, 10)}</span>
                        ) : (
                          <span class="text-[var(--ink-muted)]">invariance ok</span>
                        )}
                      </td>
                    </tr>
                  )}
                </For>
              </Show>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
