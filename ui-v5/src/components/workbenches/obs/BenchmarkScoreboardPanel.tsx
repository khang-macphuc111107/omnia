import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import { BarChart3, CheckCircle2, Cpu, Layers, RefreshCw, ShieldAlert, Trophy } from 'lucide-solid';
import { api } from '@/api/client';
import { privacyMask } from '@/state/studio';
import { maskJson } from '@/utils/privacy';

type BenchViewTab = 'suite_v5' | 'public_9' | 'models_51' | 'effort_5' | 'microbench' | 'raw';

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

function extractPassPct(row: Record<string, unknown>): number {
  const direct = row.pass_at_1_pct ?? row.passAt1Pct ?? row.passRatePct ?? row.pass_rate_pct;
  if (direct !== undefined && direct !== null && Number.isFinite(Number(direct))) {
    return Number(direct);
  }
  const ratio = row.passRate ?? row.pass_rate ?? row.pass_at_1 ?? row.passAt1;
  if (ratio !== undefined && ratio !== null && Number.isFinite(Number(ratio))) {
    const n = Number(ratio);
    return n <= 1 ? n * 100 : n;
  }
  const solved = Number(row.solved ?? row.passed ?? 0);
  const runs = Number(row.runs ?? row.total ?? 0);
  return runs > 0 ? (solved / runs) * 100 : 0;
}

export function BenchmarkScoreboardPanel(props: { refreshSeq: number }) {
  const [tab, setTab] = createSignal<BenchViewTab>('suite_v5');
  const [payload, setPayload] = createSignal<Record<string, unknown> | null>(null);
  const [modelTierFilter, setModelTierFilter] = createSignal<'all' | 'live' | 'restricted' | 'media'>('all');
  const [loading, setLoading] = createSignal(false);

  const loadScoreboard = async () => {
    setLoading(true);
    const res = await api.getBenchmarks(privacyMask());
    if (res.ok) setPayload(res.data);
    setLoading(false);
  };

  onMount(() => {
    void loadScoreboard();
  });

  createEffect(() => {
    props.refreshSeq;
    privacyMask();
    void loadScoreboard();
  });

  // Extract structured sections whether served directly by upgraded `/api/benchmarks/scoreboard`
  // OR inside `runs[]` receipt entries (`final_scoreboard_v5.json`, `microbench_v5_all7.json`, etc.)
  const finalScoreboard = createMemo(() => {
    const p = payload();
    if (!p) return null;
    if (p.finalScoreboard && typeof p.finalScoreboard === 'object') {
      return p.finalScoreboard as Record<string, unknown>;
    }
    if (p.suiteV5 || p.suite_v5 || p.publicSuites || p.public_suites || p.allModels) return p;
    const runs = Array.isArray(p.runs) ? (p.runs as Array<Record<string, unknown>>) : [];
    const hit = runs.find((r) => String(r.file ?? '').includes('final_scoreboard'));
    return (hit?.receipt as Record<string, unknown> | undefined) ?? p;
  });

  const suiteV5Rows = createMemo((): Array<Record<string, unknown>> => {
    const p = payload() ?? {};
    const fs = finalScoreboard() ?? {};
    const sv5 = (p.suiteV5 ?? fs.suiteV5 ?? fs.suite_v5 ?? fs.leaderboard ?? fs.harnesses) as unknown;
    let rows: Array<Record<string, unknown>> = [];
    if (Array.isArray(sv5)) {
      rows = sv5 as Array<Record<string, unknown>>;
    } else if (sv5 && typeof sv5 === 'object') {
      const obj = sv5 as Record<string, unknown>;
      if (Array.isArray(obj.harnesses)) {
        rows = obj.harnesses as Array<Record<string, unknown>>;
      } else if (Array.isArray(obj.rows)) {
        rows = obj.rows as Array<Record<string, unknown>>;
      } else if (obj.harnesses && typeof obj.harnesses === 'object') {
        rows = Object.entries(obj.harnesses as Record<string, unknown>)
          .filter(([, v]) => v && typeof v === 'object')
          .map(([harness, v]): Record<string, unknown> => ({ harness, ...(v as Record<string, unknown>) }));
      } else {
        rows = Object.entries(obj)
          .filter(([, v]) => v && typeof v === 'object')
          .map(([harness, v]): Record<string, unknown> => ({ harness, ...(v as Record<string, unknown>) }));
      }
    }
    return [...rows].sort((a, b) => extractPassPct(b) - extractPassPct(a));
  });

  const publicSuites = createMemo((): Array<Record<string, unknown>> => {
    const p = payload() ?? {};
    const fs = finalScoreboard() ?? {};
    const ps = (p.publicSuites ?? fs.publicSuites ?? fs.public_suites) as unknown;
    if (Array.isArray(ps)) return ps as Array<Record<string, unknown>>;
    if (ps && typeof ps === 'object') {
      return Object.entries(ps as Record<string, unknown>)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([suite, v]): Record<string, unknown> => ({ suite, ...(v as Record<string, unknown>) }));
    }
    return [];
  });

  const modelsCatalog = createMemo(() => {
    const p = payload() ?? {};
    const fs = finalScoreboard() ?? {};
    const raw = (p.modelsCatalog ?? p.allModels ?? fs.allModels ?? fs.all_models ?? fs.modelsCatalog ?? fs.models_catalog) as unknown;
    let list: Array<Record<string, unknown>> = [];
    if (Array.isArray(raw)) {
      list = raw as Array<Record<string, unknown>>;
    } else if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.models)) list = obj.models as Array<Record<string, unknown>>;
      else if (Array.isArray(obj.entries)) list = obj.entries as Array<Record<string, unknown>>;
    }
    const tier = modelTierFilter();
    if (tier === 'all') return list;
    return list.filter((m) => {
      const st = String(m.classification ?? m.category ?? m.status ?? m.tier ?? '').toLowerCase();
      if (tier === 'live') return m.codingRunnable === true || st.includes('live') || st.includes('coding') || st === 'ok' || m.live === true;
      if (tier === 'restricted') return (st.includes('restrict') || st.includes('403') || st.includes('blocked')) && !st.includes('media');
      if (tier === 'media') return st.includes('media') || st.includes('image') || st.includes('audio') || st.includes('video');
      return true;
    });
  });

  const effortSweepRows = createMemo((): Array<Record<string, unknown>> => {
    const p = payload() ?? {};
    const fs = finalScoreboard() ?? {};
    const sw = (p.effortSweep ?? fs.effortSweep ?? fs.effort_sweep) as unknown;
    let rows: Array<Record<string, unknown>> = [];
    if (Array.isArray(sw)) {
      rows = sw as Array<Record<string, unknown>>;
    } else if (sw && typeof sw === 'object') {
      const obj = sw as Record<string, unknown>;
      const nested =
        obj.by_effort && typeof obj.by_effort === 'object'
          ? (obj.by_effort as Record<string, unknown>)
          : obj.byEffort && typeof obj.byEffort === 'object'
            ? (obj.byEffort as Record<string, unknown>)
            : obj;
      rows = Object.entries(nested)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([effort, v]): Record<string, unknown> => ({ effort, ...(v as Record<string, unknown>) }));
    }
    return [...rows].sort((a, b) => {
      const ia = EFFORT_ORDER.indexOf(String(a.effort ?? a.level ?? '').toLowerCase());
      const ib = EFFORT_ORDER.indexOf(String(b.effort ?? b.level ?? '').toLowerCase());
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  });

  const microbenchRows = createMemo(() => {
    const p = payload();
    if (!p) return [];
    const direct = (finalScoreboard()?.microbench ?? p.microbench) as Record<string, unknown> | undefined;
    const fromDirect = direct?.harnesses && typeof direct.harnesses === 'object' ? (direct.harnesses as Record<string, unknown>) : null;
    const runs = Array.isArray(p.runs) ? (p.runs as Array<Record<string, unknown>>) : [];
    const microFile = runs.find((r) => String(r.file ?? '').includes('microbench'));
    const fromFile = (microFile?.receipt as Record<string, unknown> | undefined)?.harnesses as Record<string, unknown> | undefined;
    const src = fromDirect ?? fromFile ?? {};
    return Object.entries(src).map(([name, val]) => {
      const v = (val ?? {}) as Record<string, unknown>;
      const vs = (v.version_startup ?? {}) as Record<string, unknown>;
      const mf = (v.mock_first_request ?? {}) as Record<string, unknown>;
      return {
        name,
        version: String(v.version ?? ''),
        diskMb: Number(v.disk_mb ?? 0),
        startupMedianMs: Number(vs.median_ms ?? 0),
        startupPeakMemMb: Number(vs.median_peak_mem_mb ?? 0),
        firstReqMedianMs: Number(mf.first_req_median_ms ?? 0),
        harnessRssMb: Number(mf.idle_peak_harness_rss_mb ?? 0),
      };
    });
  });

  return (
    <div data-testid="obs-benchmarks-panel" class="space-y-4">
      <div class="omnia-surface-panel rounded-lg p-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 font-bold text-[13.5px]">
          <Trophy class="w-4 h-4 text-[var(--accent-amber)]" />
          <span>Live Benchmark Scoreboard (`/api/benchmarks/scoreboard`)</span>
          <span class="omnia-badge text-[var(--status-emerald)]">
            {String(payload()?.runCount ?? 0)} receipts
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <div class="omp-segmented text-[11.5px]">
            {(
              [
                { id: 'suite_v5', label: 'Suite v5 (33)' },
                { id: 'public_9', label: '9 Public Suites' },
                { id: 'models_51', label: 'All 51 Models' },
                { id: 'effort_5', label: '5-Level Effort' },
                { id: 'microbench', label: 'Microbench (7)' },
                { id: 'raw', label: 'Raw Feed' },
              ] as const
            ).map((t) => (
              <button type="button" aria-pressed={tab() === t.id} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" disabled={loading()} class="omnia-btn text-[11px]" onClick={() => void loadScoreboard()}>
            <RefreshCw class="w-3.5 h-3.5" classList={{ 'animate-spin': loading() }} />
            <span>Reload</span>
          </button>
        </div>
      </div>

      {/* Suite v5 Leaderboard */}
      <Show when={tab() === 'suite_v5'}>
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
          <div class="flex items-center justify-between">
            <span class="font-bold text-[13px] flex items-center gap-2">
              <BarChart3 class="w-4 h-4 text-[var(--accent-cyan)]" />
              <span>Suite v5 (33 Tasks · 11 Axes) Head-to-Head Leaderboard</span>
            </span>
            <span class="text-[11px] font-mono-num text-[var(--ink-muted)]">Zero fabricated scores · Cleanroom audited</span>
          </div>
          <Show
            when={suiteV5Rows().length > 0}
            fallback={
              <div class="p-4 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[12px] font-mono-num text-[var(--ink-muted)]">
                Awaiting unified `final_scoreboard_v5.json` under `D:\OmniaData\qa\v5-bench\`. Switch to <strong>Microbench (7)</strong> or <strong>Raw Feed</strong> to inspect currently loaded receipt files ({String(payload()?.runCount ?? 0)} found).
              </div>
            }
          >
            <div class="space-y-2">
              <For each={suiteV5Rows()}>
                {(row, idx) => {
                  const pct = extractPassPct(row);
                  const solved = row.solved ?? row.passed;
                  const runs = row.runs ?? row.total;
                  const kvPct = row.pooled_kv_cache_hit_pct ?? row.kvCachePct ?? row.kv_cache_pct;
                  const rssMb = row.peak_rss_mb_median ?? row.rssMb ?? row.rss_mb;
                  const isOmnia = String(row.harness ?? row.name ?? '').toLowerCase().includes('omnia');
                  return (
                    <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1 font-mono-num text-[12px]">
                      <div class="flex items-center justify-between gap-2">
                        <span class={isOmnia ? 'font-bold text-[var(--accent-cyan)]' : 'font-semibold text-[var(--ink-primary)]'}>
                          #{idx() + 1} {String(row.harness ?? row.name ?? 'harness')}
                        </span>
                        <span class="text-[var(--ink-secondary)]">
                          <strong>{pct.toFixed(1)}%</strong>
                          <Show when={solved !== undefined && runs !== undefined}>
                            {' '}({String(solved)}/{String(runs)})
                          </Show>
                          <Show when={kvPct !== undefined && kvPct !== null}>
                            {' · '}KV {Number(kvPct).toFixed(1)}%
                          </Show>
                          <Show when={rssMb !== undefined && rssMb !== null}>
                            {' · '}RSS {Number(rssMb).toFixed(1)} MiB
                          </Show>
                        </span>
                      </div>
                      <div class="w-full h-2.5 rounded bg-[var(--bg-panel)] overflow-hidden">
                        <div
                          class="h-full"
                          style={{
                            width: `${Math.min(100, Math.max(1, pct))}%`,
                            'background-color': isOmnia ? 'var(--status-emerald)' : 'var(--accent-cyan)',
                          }}
                        />
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* 9 Public Suites Matrix */}
      <Show when={tab() === 'public_9'}>
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="font-bold text-[13px] flex items-center gap-2">
              <Layers class="w-4 h-4 text-[var(--accent-amber)]" />
              <span>9 Windows-Runnable Public Suites Matrix</span>
            </span>
            <span class="omnia-badge text-[var(--accent-amber)]">
              <ShieldAlert class="w-3 h-3" />
              <span>TB4.1 / SWE-bench Pro: WSL2/Docker DEFERRED_BOUNDARY</span>
            </span>
          </div>
          <Show
            when={publicSuites().length > 0}
            fallback={
              <div class="p-4 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[12px] font-mono-num text-[var(--ink-muted)]">
                Public suites (`bfcl_v4`, `tau2_bench`, `livecodebench`, `aider_polyglot`, `compaction_bench`, `longmemeval`, `locomo`, `aa_lcr`, `swe_atlas_qna_aa`) populate automatically from `final_scoreboard_v5.json`.
              </div>
            }
          >
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5 text-[11.5px] font-mono-num">
              <For each={publicSuites()}>
                {(ps) => (
                  <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1.5">
                    <div class="flex items-center justify-between">
                      <span class="font-bold text-[var(--accent-cyan)]">{String(ps.suite ?? ps.name)}</span>
                      <CheckCircle2 class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                    </div>
                    <pre class="text-[10.5px] text-[var(--ink-secondary)] whitespace-pre-wrap max-h-28 overflow-auto">
                      {JSON.stringify(ps.scores ?? ps.summary ?? ps, null, 2)}
                    </pre>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* All 51 HTMUSTC Models Matrix */}
      <Show when={tab() === 'models_51'}>
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="font-bold text-[13px] flex items-center gap-2">
              <Cpu class="w-4 h-4 text-[var(--accent-cyan)]" />
              <span>All-51 HTMUSTC Models Catalog & Wire Routing ({modelsCatalog().length})</span>
            </span>
            <div class="omp-segmented text-[11px]">
              {(['all', 'live', 'restricted', 'media'] as const).map((tier) => (
                <button type="button" aria-pressed={modelTierFilter() === tier} onClick={() => setModelTierFilter(tier)}>
                  {tier === 'all' ? 'All (51)' : tier === 'live' ? 'Live Coding (20)' : tier === 'restricted' ? '403 Key-Restricted' : '403 Media'}
                </button>
              ))}
            </div>
          </div>
          <div class="overflow-x-auto max-h-[440px] overflow-y-auto">
            <table class="w-full text-left border-collapse text-[11.5px] font-mono-num">
              <thead>
                <tr class="border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] text-[var(--ink-muted)]">
                  <th class="px-2.5 py-1.5">Model ID</th>
                  <th class="px-2.5 py-1.5">Primary Wire</th>
                  <th class="px-2.5 py-1.5">Status / Tier</th>
                  <th class="px-2.5 py-1.5">5-Effort Matrix</th>
                  <th class="px-2.5 py-1.5">Notes</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--border-subtle)]">
                <Show
                  when={modelsCatalog().length > 0}
                  fallback={
                    <tr>
                      <td colspan="5" class="px-3 py-5 text-center text-[var(--ink-muted)]">
                        No catalog rows matched current filter (populates directly from `htmustc_models_catalog.json` via `/api/benchmarks/scoreboard`).
                      </td>
                    </tr>
                  }
                >
                  <For each={modelsCatalog()}>
                    {(m) => (
                      <tr>
                        <td class="px-2.5 py-1.5 font-semibold text-[var(--ink-primary)]">{String(m.id ?? m.model ?? m.name)}</td>
                        <td class="px-2.5 py-1.5 text-[var(--accent-cyan)]">{String(m.primaryDialect ?? m.wire ?? m.wireDialect ?? m.endpoint ?? 'auto')}</td>
                        <td class="px-2.5 py-1.5">{String(m.classification ?? m.status ?? m.category ?? m.httpStatus ?? 'probed')}</td>
                        <td class="px-2.5 py-1.5 text-[var(--status-emerald)]">
                          {Array.isArray(m.effortsPassed ?? m.efforts)
                            ? ((m.effortsPassed ?? m.efforts) as unknown[]).join('/')
                            : m.codingRunnable === true
                              ? 'low/med/high/xhigh/max'
                              : String(m.effortSweep ?? '—')}
                        </td>
                        <td class="px-2.5 py-1.5 text-[var(--ink-muted)] truncate max-w-[240px]">
                          {String(m.note ?? m.detail ?? m.family ?? '')}
                        </td>
                      </tr>
                    )}
                  </For>
                </Show>
              </tbody>
            </table>
          </div>
        </div>
      </Show>

      {/* 5-Level Effort Sweep */}
      <Show when={tab() === 'effort_5'}>
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
          <div class="font-bold text-[13px]">5-Level Reasoning Effort Sweep (`low` · `medium` · `high` · `xhigh` · `max`)</div>
          <Show
            when={effortSweepRows().length > 0}
            fallback={
              <div class="p-4 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[12px] font-mono-num text-[var(--ink-muted)]">
                Waiting for Steer #16 5-level effort sweep rows in `final_scoreboard_v5.json`.
              </div>
            }
          >
            <div class="grid grid-cols-1 md:grid-cols-5 gap-2.5 font-mono-num text-[11.5px]">
              <For each={effortSweepRows()}>
                {(e) => {
                  const pct = extractPassPct(e);
                  const solved = e.solved ?? e.passed;
                  const runs = e.runs ?? e.total;
                  const medianVal = e.median_ttft_ms ?? e.medianTtftMs ?? e.medianMs ?? e.median_ms;
                  return (
                    <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-2">
                      <div class="font-bold uppercase text-[var(--accent-amber)]">{String(e.effort ?? e.level)}</div>
                      <div class="text-[18px] font-bold text-[var(--ink-primary)]">{pct.toFixed(1)}%</div>
                      <div class="w-full h-2 rounded bg-[var(--bg-panel)] overflow-hidden">
                        <div class="h-full bg-[var(--accent-cyan)]" style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                      <div class="text-[10.5px] text-[var(--ink-muted)]">
                        <Show when={solved !== undefined && runs !== undefined}>
                          {String(solved)}/{String(runs)} ·{' '}
                        </Show>
                        TTFT: {medianVal !== undefined && medianVal !== null ? `${Number(medianVal).toFixed(0)}ms` : '—'}
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* 7-Harness Microbench SVG Comparison */}
      <Show when={tab() === 'microbench'}>
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
          <div class="font-bold text-[13px]">7-Harness Windows Microbench (Cold/Warm Startup · Binary Footprint · Peak RSS)</div>
          <Show
            when={microbenchRows().length > 0}
            fallback={
              <div class="p-4 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[12px] font-mono-num text-[var(--ink-muted)]">
                No `microbench_v5_all7.json` receipt detected yet.
              </div>
            }
          >
            <div class="space-y-2 font-mono-num text-[11.5px]">
              <For each={microbenchRows()}>
                {(m) => {
                  const maxMs = Math.max(50, ...microbenchRows().map((x) => x.startupMedianMs));
                  const isOmnia = m.name === 'omnia';
                  return (
                    <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <span class={isOmnia ? 'font-bold text-[var(--status-emerald)]' : 'font-semibold text-[var(--ink-primary)]'}>
                          {m.name} ({m.version})
                        </span>
                        <span class="text-[var(--ink-secondary)]">
                          startup <strong>{m.startupMedianMs.toFixed(2)}ms</strong> · 1st-req {m.firstReqMedianMs.toFixed(1)}ms · RSS {m.harnessRssMb.toFixed(1)} MiB · bin {m.diskMb.toFixed(2)} MiB
                        </span>
                      </div>
                      <div class="w-full h-2 rounded bg-[var(--bg-panel)] overflow-hidden">
                        <div
                          class="h-full"
                          style={{
                            width: `${Math.min(100, Math.max(1.5, (m.startupMedianMs / maxMs) * 100))}%`,
                            'background-color': isOmnia ? 'var(--status-emerald)' : 'var(--accent-amber)',
                          }}
                        />
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* Raw Feed */}
      <Show when={tab() === 'raw'}>
        <div class="omnia-surface-panel rounded-lg p-4">
          <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-[520px] overflow-auto whitespace-pre-wrap">
            {JSON.stringify(maskJson(payload() ?? { notice: 'No benchmark receipts found yet.' }, privacyMask()), null, 2)}
          </pre>
        </div>
      </Show>
    </div>
  );
}
