import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  HardDrive,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  XCircle,
} from 'lucide-solid';
import { api } from '@/api/client';
import { privacyMask } from '@/state/studio';
import { maskText } from '@/utils/privacy';
import { formatBytes } from '@/utils/stats';

interface CapabilityMatrixRow {
  id: string;
  enabled: boolean;
  readiness: 'ready' | 'degraded' | 'unavailable';
  endpoint: string;
  detailChips: string[];
  remediation: string;
  checkedAtIso: string;
}

interface TransportProbeState {
  reachable: boolean;
  httpStatus: number;
  latencyMs: number | null;
  listener: string;
  schema: string;
  checkedAtIso: string;
  error: string;
}

interface ServiceHealthState {
  reachable: boolean;
  ok: boolean;
  state: string;
  engine: string;
  sqliteBackend: string;
  rustRuntime: string;
  demoMode: boolean;
  tokenBudget: string;
  checkedAtIso: string;
}

const CAPABILITY_REMEDIATION: Record<string, string> = {
  runtime_proxy: 'Start omnia-runtime.exe on loopback or pass --runtime-url to omnia-studio.exe to enable live proxy routing.',
  media_capture: 'Ensure Win32 desktop session is interactive and Chrome/Edge binary is discoverable for isolated CDP.',
  remote_control: 'Pair an authorized device via /api/remote/pair to issue a signed HMAC session lease.',
  connector_gateway: 'Verify local connector config or upstream proxy reachability in Observatory -> Network.',
  sessions: 'Check external SQLite WAL directory permissions and winsqlite3 cooperative lease health.',
  routing: 'Inspect Observatory -> Router Lab to reset tripped circuits or refresh provider candidates.',
  observatory_v5: 'Verify omnia-studio.exe is serving v5 Observatory routes on the bound loopback port.',
};

function remediationForCapability(id: string, enabled: boolean): string {
  if (enabled) return 'Operational — ready for direct loopback invocation.';
  return (
    CAPABILITY_REMEDIATION[id] ??
    `Enable or configure "${id}" in omnia-studio.exe and re-probe GET /api/capabilities.`
  );
}

function normalizeCapabilities(rawList: unknown, checkedAtIso: string): CapabilityMatrixRow[] {
  if (!Array.isArray(rawList)) return [];
  return rawList.map((entry, idx) => {
    const rec = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const id = String(rec.id ?? rec.capability ?? `capability-${idx + 1}`);
    const enabled = Boolean(rec.enabled ?? rec.ready ?? false);
    const statusText = String(rec.status ?? rec.state ?? '').toLowerCase();
    let readiness: CapabilityMatrixRow['readiness'] = enabled ? 'ready' : 'degraded';
    if (statusText === 'unavailable' || statusText === 'error' || statusText === 'blocked') {
      readiness = 'unavailable';
    } else if (statusText === 'degraded' || statusText === 'partial' || statusText === 'disabled') {
      readiness = 'degraded';
    }

    const detailChips: string[] = [];
    if (rec.backend) detailChips.push(`backend:${String(rec.backend)}`);
    if (rec.schema) detailChips.push(`schema:${String(rec.schema)}`);
    if (rec.mode) detailChips.push(`mode:${String(rec.mode)}`);
    if (rec.invariant) detailChips.push(String(rec.invariant));
    if (rec.timeoutMs !== undefined) detailChips.push(`timeout:${String(rec.timeoutMs)}ms`);
    if (rec.erasureReceipts) detailChips.push('erasure-receipts');
    if (Array.isArray(rec.directions)) detailChips.push(`dir:${rec.directions.map(String).join('/')}`);

    return {
      id,
      enabled,
      readiness,
      endpoint: String(rec.endpoint ?? '—'),
      detailChips,
      remediation: rec.remediation ? String(rec.remediation) : remediationForCapability(id, enabled),
      checkedAtIso: rec.checkedAt ? String(rec.checkedAt) : checkedAtIso,
    };
  });
}

export function SystemHardwarePanel(props: { refreshSeq: number }) {
  const [snapshot, setSnapshot] = createSignal<Record<string, unknown> | null>(null);
  const [nvidia, setNvidia] = createSignal<Record<string, unknown> | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [note, setNote] = createSignal('');

  // AUD-25 Studio Capability Matrix state (Transport Reachability vs Service Health vs Capabilities)
  const [capRows, setCapRows] = createSignal<CapabilityMatrixRow[]>([]);
  const [capFilter, setCapFilter] = createSignal<'all' | 'ready' | 'attention'>('all');
  const [capSearch, setCapSearch] = createSignal('');
  const [transportProbe, setTransportProbe] = createSignal<TransportProbeState>({
    reachable: false,
    httpStatus: 0,
    latencyMs: null,
    listener: typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:4242',
    schema: 'omnia.capabilities.v1',
    checkedAtIso: '',
    error: '',
  });
  const [serviceHealth, setServiceHealth] = createSignal<ServiceHealthState>({
    reachable: false,
    ok: false,
    state: 'probing',
    engine: 'Omnia Full Native Rust',
    sqliteBackend: 'winsqlite3.dll',
    rustRuntime: 'unknown',
    demoMode: false,
    tokenBudget: 'NULL (unbounded)',
    checkedAtIso: '',
  });

  const probeCapabilitiesAndHealth = async () => {
    const t0 = performance.now();
    const checkedAtIso = new Date().toISOString();
    const [capFetch, healthRes] = await Promise.all([
      fetch('/api/capabilities')
        .then(async (res) => {
          const latencyMs = Math.round(performance.now() - t0);
          const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          return { ok: res.ok, status: res.status, latencyMs, data, error: res.ok ? '' : res.statusText };
        })
        .catch((err) => ({
          ok: false,
          status: 0,
          latencyMs: Math.round(performance.now() - t0),
          data: {} as Record<string, unknown>,
          error: err instanceof Error ? err.message : 'Loopback transport unreachable',
        })),
      api.getHealth(),
    ]);

    setTransportProbe({
      reachable: capFetch.ok,
      httpStatus: capFetch.status,
      latencyMs: capFetch.latencyMs,
      listener: String(
        capFetch.data.listener ?? (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:4242'),
      ),
      schema: String(capFetch.data.schema ?? 'omnia.capabilities.v1'),
      checkedAtIso,
      error: capFetch.error,
    });

    if (capFetch.ok) {
      setCapRows(normalizeCapabilities(capFetch.data.capabilities, checkedAtIso));
    } else {
      setCapRows([]);
    }

    if (healthRes.ok) {
      const h = healthRes.data;
      setServiceHealth({
        reachable: true,
        ok: Boolean(h.ok ?? true),
        state: String(h.state ?? (h.ok ? 'online' : 'degraded')),
        engine: String(h.engine ?? 'Omnia Full Native Rust'),
        sqliteBackend: String(h.sqliteBackend ?? 'winsqlite3.dll'),
        rustRuntime: String(h.rustRuntime ?? (h.runtimeOnline ? 'configured' : 'unconfigured')),
        demoMode: Boolean(h.demoMode ?? false),
        tokenBudget: h.tokenBudget === null || h.tokenBudget === undefined ? 'NULL (unbounded)' : String(h.tokenBudget),
        checkedAtIso,
      });
    } else {
      setServiceHealth({
        reachable: false,
        ok: false,
        state: `unreachable (${healthRes.error.code})`,
        engine: 'Unknown',
        sqliteBackend: 'Unknown',
        rustRuntime: 'unreachable',
        demoMode: false,
        tokenBudget: 'NULL (unbounded)',
        checkedAtIso,
      });
    }
  };

  const loadSystem = async () => {
    setLoading(true);
    const [sysRes, nvRes] = await Promise.all([
      api.getSystemSnapshot(privacyMask()),
      api.getNvidiaHardware(),
      probeCapabilitiesAndHealth(),
    ]);
    if (sysRes.ok) {
      setSnapshot(sysRes.data);
      setNote('');
    } else {
      setNote(`Host snapshot note (${sysRes.error.code}): ${sysRes.error.message}`);
    }
    if (nvRes.ok) setNvidia(nvRes.data);
    setLoading(false);
  };

  onMount(() => {
    void loadSystem();
  });

  createEffect(() => {
    props.refreshSeq;
    privacyMask();
    void loadSystem();
  });

  const filteredCapabilities = createMemo(() => {
    const q = capSearch().trim().toLowerCase();
    const flt = capFilter();
    return capRows().filter((row) => {
      if (flt === 'ready' && row.readiness !== 'ready') return false;
      if (flt === 'attention' && row.readiness === 'ready') return false;
      if (!q) return true;
      return (
        row.id.toLowerCase().includes(q) ||
        row.endpoint.toLowerCase().includes(q) ||
        row.remediation.toLowerCase().includes(q) ||
        row.detailChips.some((c) => c.toLowerCase().includes(q))
      );
    });
  });

  const readyCapCount = createMemo(() => capRows().filter((c) => c.readiness === 'ready').length);
  const attentionCapCount = createMemo(() => capRows().filter((c) => c.readiness !== 'ready').length);

  const host = createMemo(() => {
    const s = snapshot() ?? {};
    return ((s.host && typeof s.host === 'object' ? s.host : s) as Record<string, unknown>);
  });

  const hardware = createMemo(() => {
    const h = host();
    return ((h.hardware && typeof h.hardware === 'object' ? h.hardware : h) as Record<string, unknown>);
  });

  const ramMetrics = createMemo(() => {
    const h = host();
    const hw = hardware();
    const total = Number(
      hw.total_ram_bytes ?? hw.totalRamBytes ?? h.totalMemoryBytes ?? h.total_memory_bytes ?? 0,
    );
    const avail = Number(
      hw.available_ram_bytes ?? hw.availableRamBytes ?? h.availableMemoryBytes ?? h.available_memory_bytes ?? NaN,
    );
    const explicitUsed = Number(h.usedMemoryBytes ?? h.used_memory_bytes ?? NaN);
    const used = Number.isFinite(explicitUsed)
      ? explicitUsed
      : Number.isFinite(avail) && total > 0
        ? Math.max(0, total - avail)
        : 0;
    const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
    return { total, used, avail: Number.isFinite(avail) ? avail : Math.max(0, total - used), pct };
  });

  const cpuCores = createMemo(() => {
    const h = host();
    const hw = hardware();
    return hw.logical_cpus ?? hw.logicalCpus ?? h.logicalCores ?? h.logical_cores ?? null;
  });

  const vramMb = createMemo(() => {
    const h = host();
    const hw = hardware();
    const nv = nvidia() ?? {};
    const raw = hw.total_vram_mb ?? hw.totalVramMb ?? h.vramMb ?? h.vram_mb ?? nv.vramMb ?? nv.totalVramMb;
    return raw !== undefined && raw !== null ? Number(raw) : null;
  });

  const disks = createMemo(() => {
    const d = host().disks ?? snapshot()?.disks;
    return Array.isArray(d) ? (d as Array<Record<string, unknown>>) : [];
  });

  const processes = createMemo(() => {
    const p = host().omniaProcesses ?? host().omnia_processes ?? snapshot()?.omniaProcesses;
    return Array.isArray(p) ? (p as Array<Record<string, unknown>>) : [];
  });

  const walFiles = createMemo(() => {
    const s = snapshot();
    const sq = s?.sqlite && typeof s.sqlite === 'object' ? (s.sqlite as Record<string, unknown>) : null;
    const w = sq?.files ?? s?.sqliteWal ?? s?.walFiles ?? s?.sqlite_wal;
    return Array.isArray(w) ? (w as Array<Record<string, unknown>>) : [];
  });

  const ports = createMemo(() => {
    const p = host().listeningPorts ?? host().listening_ports ?? snapshot()?.listeningPorts;
    return Array.isArray(p) ? (p as Array<Record<string, unknown>>) : [];
  });

  return (
    <div data-testid="obs-system-panel" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="font-bold text-[13.5px] flex items-center gap-2">
          <Cpu class="w-4 h-4 text-[var(--accent-cyan)]" />
          <span>Studio Capability Matrix (AUD-25), Host Hardware, SQLite WAL &amp; Ports</span>
        </div>
        <button type="button" disabled={loading()} class="omnia-btn text-[11px]" onClick={() => void loadSystem()}>
          <RefreshCw class="w-3.5 h-3.5" classList={{ 'animate-spin': loading() }} />
          <span>Refresh Matrix &amp; Host</span>
        </button>
      </div>

      {/* AUD-25 Dedicated Studio Capability Matrix (Transport Reachability vs Service Health vs Per-Capability Readiness) */}
      <section data-testid="studio-capability-matrix" class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 font-bold text-[13px] text-[var(--ink-primary)]">
            <ShieldCheck class="w-4 h-4 text-[var(--status-emerald)] shrink-0" />
            <span>Studio Capability Matrix</span>
            <span class="omnia-badge font-mono-num text-[var(--accent-cyan)]">{transportProbe().schema}</span>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 text-[11px] font-mono-num">
            <span class="omnia-badge text-[var(--status-emerald)]">
              Ready {readyCapCount()}/{capRows().length}
            </span>
            <Show when={attentionCapCount() > 0}>
              <span class="omnia-badge text-[var(--accent-amber)]">Attention {attentionCapCount()}</span>
            </Show>
            <Show when={transportProbe().checkedAtIso}>
              <span class="text-[var(--ink-muted)]">Probed {transportProbe().checkedAtIso.slice(11, 19)} UTC</span>
            </Show>
          </div>
        </div>

        {/* Separated Plane 1 (Transport Reachability) vs Plane 2 (Service Health) */}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11.5px] font-mono-num">
          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-1.5 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[var(--ink-muted)] uppercase text-[10.5px] font-semibold">
                1. Transport Reachability (GET /api/capabilities)
              </span>
              <span
                class="omnia-badge"
                classList={{
                  'text-[var(--status-emerald)]': transportProbe().reachable,
                  'text-[var(--status-coral)]': !transportProbe().reachable,
                }}
              >
                {transportProbe().reachable ? `HTTP ${transportProbe().httpStatus} REACHABLE` : 'UNREACHABLE'}
              </span>
            </div>
            <div class="text-[var(--ink-primary)] truncate">
              Listener: <strong>{maskText(transportProbe().listener, privacyMask())}</strong>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-[var(--ink-secondary)]">
              <span>RTT: {transportProbe().latencyMs !== null ? `${transportProbe().latencyMs}ms` : '—'}</span>
              <span>·</span>
              <span>Timestamp: {transportProbe().checkedAtIso || '—'}</span>
            </div>
            <Show when={transportProbe().error}>
              <div class="text-[var(--status-coral)]">
                Remediation: Start omnia-studio.exe on loopback and verify bound Host/Origin port ({transportProbe().error}).
              </div>
            </Show>
          </div>

          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-1.5 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[var(--ink-muted)] uppercase text-[10.5px] font-semibold">
                2. Service Health (GET /api/health)
              </span>
              <span
                class="omnia-badge"
                classList={{
                  'text-[var(--status-emerald)]': serviceHealth().reachable && serviceHealth().ok,
                  'text-[var(--accent-amber)]': serviceHealth().reachable && !serviceHealth().ok,
                  'text-[var(--status-coral)]': !serviceHealth().reachable,
                }}
              >
                <Activity class="w-3 h-3" />
                <span>{serviceHealth().state.toUpperCase()}</span>
              </span>
            </div>
            <div class="text-[var(--ink-primary)] truncate">
              {serviceHealth().engine} · SQLite: <strong>{serviceHealth().sqliteBackend}</strong>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-[var(--ink-secondary)]">
              <span>Runtime Proxy: {serviceHealth().rustRuntime}</span>
              <span>·</span>
              <span>Demo Mode: {serviceHealth().demoMode ? 'true' : 'false'}</span>
              <span>·</span>
              <span>Token Budget: {serviceHealth().tokenBudget}</span>
            </div>
          </div>
        </div>

        {/* Plane 3: Per-Capability Readiness Table with Search, Facet Filter, Timestamps & Remediation */}
        <div class="space-y-2 min-w-0">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 flex-1 min-w-[200px]">
              <Search class="w-3.5 h-3.5 text-[var(--ink-muted)] shrink-0" />
              <input
                type="text"
                aria-label="Filter capabilities"
                value={capSearch()}
                onInput={(e) => setCapSearch(e.currentTarget.value)}
                placeholder="Filter capabilities by id, endpoint, schema, or remediation..."
                class="w-full max-w-md bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11.5px] font-mono-num text-[var(--ink-primary)]"
              />
            </div>
            <div class="omp-segmented text-[11px]">
              <button type="button" aria-pressed={capFilter() === 'all'} onClick={() => setCapFilter('all')}>
                All ({capRows().length})
              </button>
              <button type="button" aria-pressed={capFilter() === 'ready'} onClick={() => setCapFilter('ready')}>
                Ready ({readyCapCount()})
              </button>
              <button
                type="button"
                aria-pressed={capFilter() === 'attention'}
                onClick={() => setCapFilter('attention')}
              >
                Needs Attention ({attentionCapCount()})
              </button>
            </div>
          </div>

          <Show
            when={filteredCapabilities().length > 0}
            fallback={
              <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[11.5px] font-mono-num text-[var(--ink-muted)]">
                {capRows().length === 0
                  ? 'No capability entries loaded. Verify GET /api/capabilities is reachable on the active Studio listener.'
                  : 'No capabilities match the current filter.'}
              </div>
            }
          >
            <div class="overflow-x-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
              <table class="w-full text-left border-collapse text-[11.5px] font-mono-num">
                <thead>
                  <tr class="border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] text-[var(--ink-muted)]">
                    <th class="py-1.5 px-2.5">Capability</th>
                    <th class="py-1.5 px-2.5">Readiness</th>
                    <th class="py-1.5 px-2.5">Endpoint &amp; Contract</th>
                    <th class="py-1.5 px-2.5">Checked</th>
                    <th class="py-1.5 px-2.5">Remediation / Status Note</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-[var(--border-subtle)]">
                  <For each={filteredCapabilities()}>
                    {(cap) => (
                      <tr class="hover:bg-[var(--bg-elevated)]">
                        <td class="py-1.5 px-2.5 font-semibold text-[var(--ink-primary)] whitespace-nowrap">
                          {cap.id}
                        </td>
                        <td class="py-1.5 px-2.5 whitespace-nowrap">
                          <span
                            class="omnia-badge"
                            classList={{
                              'text-[var(--status-emerald)]': cap.readiness === 'ready',
                              'text-[var(--accent-amber)]': cap.readiness === 'degraded',
                              'text-[var(--status-coral)]': cap.readiness === 'unavailable',
                            }}
                          >
                            <Show when={cap.readiness === 'ready'}>
                              <CheckCircle2 class="w-3 h-3" />
                            </Show>
                            <Show when={cap.readiness === 'degraded'}>
                              <AlertTriangle class="w-3 h-3" />
                            </Show>
                            <Show when={cap.readiness === 'unavailable'}>
                              <XCircle class="w-3 h-3" />
                            </Show>
                            <span>{cap.readiness.toUpperCase()}</span>
                          </span>
                        </td>
                        <td class="py-1.5 px-2.5">
                          <div class="text-[var(--accent-cyan)]">{cap.endpoint}</div>
                          <Show when={cap.detailChips.length > 0}>
                            <div class="flex flex-wrap gap-1 mt-0.5">
                              <For each={cap.detailChips}>
                                {(chip) => <span class="text-[10px] text-[var(--ink-muted)]">[{chip}]</span>}
                              </For>
                            </div>
                          </Show>
                        </td>
                        <td class="py-1.5 px-2.5 text-[var(--ink-muted)] whitespace-nowrap">
                          {cap.checkedAtIso ? cap.checkedAtIso.slice(11, 19) : '—'}
                        </td>
                        <td class="py-1.5 px-2.5 text-[var(--ink-secondary)] min-w-[200px]">{cap.remediation}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </div>
      </section>

      <Show when={note()}>
        <div class="px-3 py-1.5 rounded border border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] text-[11.5px] font-mono-num text-[var(--accent-amber)]">
          {note()}
        </div>
      </Show>

      {/* CPU / RAM / GPU Cards */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px] font-mono-num">
        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-1.5">
          <div class="text-[11px] text-[var(--ink-muted)] flex items-center justify-between">
            <span>CPU &amp; Load</span>
            <Show when={hardware().tier}>
              <span class="omnia-badge text-[10px] text-[var(--accent-cyan)]">{String(hardware().tier)}</span>
            </Show>
          </div>
          <div class="font-bold text-[13.5px] text-[var(--ink-primary)] truncate">
            {String(host().cpuModel ?? host().cpu_model ?? host().cpuBrand ?? 'Windows x64 Host')}
          </div>
          <div class="text-[11.5px] text-[var(--accent-cyan)]">
            Cores: {cpuCores() !== null ? String(cpuCores()) : '—'} · Load:{' '}
            {host().cpuLoadPct !== undefined && host().cpuLoadPct !== null
              ? `${Number(host().cpuLoadPct).toFixed(1)}%`
              : host().cpu_load_pct !== undefined && host().cpu_load_pct !== null
                ? `${Number(host().cpu_load_pct).toFixed(1)}%`
                : '—'}
          </div>
        </div>

        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-1.5">
          <div class="text-[11px] text-[var(--ink-muted)] flex items-center justify-between">
            <span>System Memory (RAM)</span>
            <span>{ramMetrics().pct.toFixed(0)}%</span>
          </div>
          <div class="font-bold text-[13.5px] text-[var(--ink-primary)]">
            {formatBytes(ramMetrics().used)} / {formatBytes(ramMetrics().total)}
          </div>
          <div class="w-full h-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-hidden">
            <div
              class="h-full bg-[var(--accent-cyan)]"
              style={{
                width: `${ramMetrics().pct}%`,
              }}
            />
          </div>
        </div>

        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-1.5">
          <div class="text-[11px] text-[var(--ink-muted)]">GPU / VRAM (NVIDIA / WDDM)</div>
          <div class="font-bold text-[13.5px] text-[var(--ink-primary)] truncate">
            {String(
              host().gpuName ??
                host().gpu_name ??
                (nvidia()?.gpu as Record<string, unknown> | undefined)?.name ??
                nvidia()?.gpuName ??
                nvidia()?.name ??
                (vramMb() ? 'Discrete / WDDM GPU' : 'Integrated / Probed'),
            )}
          </div>
          <div class="text-[11.5px] text-[var(--status-emerald)]">
            VRAM: {vramMb() !== null ? `${vramMb()} MiB` : '—'}
            <Show when={hardware().usable_aux_vram_mb !== undefined}>
              {' · '}Aux safe: {String(hardware().usable_aux_vram_mb)} MiB
            </Show>
          </div>
        </div>
      </div>

      {/* Disks C: / D: + Omnia Processes */}
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
          <div class="font-bold text-[12.5px] flex items-center gap-2">
            <HardDrive class="w-4 h-4 text-[var(--accent-amber)]" />
            <span>Storage Volumes (C: / D:)</span>
          </div>
          <Show
            when={disks().length > 0}
            fallback={<div class="text-[11.5px] font-mono-num text-[var(--ink-muted)]">No volume metrics returned yet.</div>}
          >
            <div class="space-y-2 text-[11.5px] font-mono-num">
              <For each={disks()}>
                {(dk) => {
                  const total = Math.max(1, Number(dk.totalBytes ?? dk.total_bytes ?? 1));
                  const free = Number(dk.freeBytes ?? dk.free_bytes ?? 0);
                  const usedPct = Math.max(0, Math.min(100, ((total - free) / total) * 100));
                  return (
                    <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1">
                      <div class="flex justify-between">
                        <span class="font-bold text-[var(--ink-primary)]">{String(dk.mount ?? dk.drive ?? 'Drive')}</span>
                        <span class={usedPct > 90 ? 'text-[var(--status-coral)]' : 'text-[var(--status-emerald)]'}>
                          {formatBytes(free)} free / {formatBytes(total)} ({usedPct.toFixed(1)}% used)
                        </span>
                      </div>
                      <div class="w-full h-2 rounded bg-[var(--bg-panel)] overflow-hidden">
                        <div
                          class="h-full"
                          style={{
                            width: `${usedPct}%`,
                            'background-color': usedPct > 90 ? 'var(--status-coral)' : 'var(--accent-amber)',
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

        <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
          <div class="font-bold text-[12.5px] flex items-center gap-2">
            <Cpu class="w-4 h-4 text-[var(--status-emerald)]" />
            <span>Active `omnia-*` Process RSS ({processes().length})</span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse text-[11.5px] font-mono-num">
              <thead>
                <tr class="border-b border-[var(--border-subtle)] text-[var(--ink-muted)]">
                  <th class="py-1 pr-3">Process</th>
                  <th class="py-1 pr-3">PID</th>
                  <th class="py-1">Working Set RSS</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--border-subtle)]">
                <For each={processes()}>
                  {(p) => (
                    <tr>
                      <td class="py-1.5 pr-3 text-[var(--ink-primary)]">{String(p.name ?? 'omnia')}</td>
                      <td class="py-1.5 pr-3 text-[var(--ink-muted)]">{String(p.pid ?? '—')}</td>
                      <td class="py-1.5 text-[var(--status-emerald)]">
                        {formatBytes(Number(p.rssBytes ?? p.rss_bytes ?? p.workingSetBytes ?? 0))}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* SQLite WAL Sizes + Listening Local Ports */}
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
          <div class="font-bold text-[12.5px] flex items-center gap-2">
            <Database class="w-4 h-4 text-[var(--accent-cyan)]" />
            <span>SQLite WAL Store Footprint ({walFiles().length})</span>
          </div>
          <div class="space-y-1 text-[11.5px] font-mono-num max-h-52 overflow-y-auto">
            <Show
              when={walFiles().length > 0}
              fallback={<div class="text-[var(--ink-muted)]">WAL inventory loads when external SQLite stores are active.</div>}
            >
              <For each={walFiles()}>
                {(w) => (
                  <div class="px-2.5 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex justify-between gap-2">
                    <span class="truncate">{maskText(String(w.name ?? w.path ?? 'db'), privacyMask())}</span>
                    <span class="text-[var(--accent-cyan)] shrink-0">
                      DB {formatBytes(Number(w.dbBytes ?? w.sizeBytes ?? 0))} · WAL {formatBytes(Number(w.walBytes ?? 0))}
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>

        <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
          <div class="font-bold text-[12.5px] flex items-center gap-2">
            <Network class="w-4 h-4 text-[var(--accent-amber)]" />
            <span>Local Listening Dev Ports ({ports().length})</span>
          </div>
          <div class="space-y-1 text-[11.5px] font-mono-num max-h-52 overflow-y-auto">
            <Show
              when={ports().length > 0}
              fallback={<div class="text-[var(--ink-muted)]">No listening port rows returned.</div>}
            >
              <For each={ports().slice(0, 30)}>
                {(pt) => (
                  <div class="px-2.5 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex justify-between gap-2">
                    <span>
                      {maskText(String(pt.bindAddr ?? pt.bind_addr ?? pt.localAddress ?? pt.local_address ?? '127.0.0.1'), privacyMask())}:
                      <strong class="text-[var(--accent-cyan)]">{String(pt.port ?? pt.localPort ?? '')}</strong>
                    </span>
                    <span class="text-[var(--ink-muted)]">
                      {String(pt.processName ?? pt.process_name ?? pt.process ?? 'pid')} ({String(pt.pid ?? '—')})
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
