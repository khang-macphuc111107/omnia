import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import { Cpu, Database, HardDrive, Network, RefreshCw } from 'lucide-solid';
import { api } from '@/api/client';
import { privacyMask } from '@/state/studio';
import { maskText } from '@/utils/privacy';
import { formatBytes } from '@/utils/stats';

export function SystemHardwarePanel(props: { refreshSeq: number }) {
  const [snapshot, setSnapshot] = createSignal<Record<string, unknown> | null>(null);
  const [nvidia, setNvidia] = createSignal<Record<string, unknown> | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [note, setNote] = createSignal('');

  const loadSystem = async () => {
    setLoading(true);
    const [sysRes, nvRes] = await Promise.all([
      api.getSystemSnapshot(privacyMask()),
      api.getNvidiaHardware(),
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

  const host = createMemo(() => {
    const s = snapshot() ?? {};
    return ((s.host && typeof s.host === 'object' ? s.host : s) as Record<string, unknown>);
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
    const w = snapshot()?.sqliteWal ?? snapshot()?.walFiles ?? snapshot()?.sqlite_wal;
    return Array.isArray(w) ? (w as Array<Record<string, unknown>>) : [];
  });

  const ports = createMemo(() => {
    const p = host().listeningPorts ?? host().listening_ports ?? snapshot()?.listeningPorts;
    return Array.isArray(p) ? (p as Array<Record<string, unknown>>) : [];
  });

  return (
    <div data-testid="obs-system-panel" class="space-y-4">
      <div class="flex items-center justify-between gap-2">
        <div class="font-bold text-[13.5px] flex items-center gap-2">
          <Cpu class="w-4 h-4 text-[var(--accent-cyan)]" />
          <span>Host Hardware, Disks (C:/D:), Omnia RSS, SQLite WAL & Listening Ports</span>
        </div>
        <button type="button" disabled={loading()} class="omnia-btn text-[11px]" onClick={() => void loadSystem()}>
          <RefreshCw class="w-3.5 h-3.5" classList={{ 'animate-spin': loading() }} />
          <span>Refresh Host</span>
        </button>
      </div>

      <Show when={note()}>
        <div class="px-3 py-1.5 rounded border border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] text-[11.5px] font-mono-num text-[var(--accent-amber)]">
          {note()}
        </div>
      </Show>

      {/* CPU / RAM / GPU Cards */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px] font-mono-num">
        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-1.5">
          <div class="text-[11px] text-[var(--ink-muted)]">CPU & Load</div>
          <div class="font-bold text-[13.5px] text-[var(--ink-primary)] truncate">
            {String(host().cpuModel ?? host().cpu_model ?? host().cpuBrand ?? 'Windows x64 Host')}
          </div>
          <div class="text-[11.5px] text-[var(--accent-cyan)]">
            Cores: {String(host().logicalCores ?? host().logical_cores ?? '—')} · Load:{' '}
            {host().cpuLoadPct !== undefined || host().cpu_load_pct !== undefined
              ? `${Number(host().cpuLoadPct ?? host().cpu_load_pct).toFixed(1)}%`
              : '—'}
          </div>
        </div>

        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-1.5">
          <div class="text-[11px] text-[var(--ink-muted)]">System Memory (RAM)</div>
          <div class="font-bold text-[13.5px] text-[var(--ink-primary)]">
            {formatBytes(Number(host().usedMemoryBytes ?? host().used_memory_bytes ?? 0))} /{' '}
            {formatBytes(Number(host().totalMemoryBytes ?? host().total_memory_bytes ?? 0))}
          </div>
          <div class="w-full h-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-hidden">
            <div
              class="h-full bg-[var(--accent-cyan)]"
              style={{
                width: `${Math.min(
                  100,
                  (Number(host().usedMemoryBytes ?? host().used_memory_bytes ?? 0) /
                    Math.max(1, Number(host().totalMemoryBytes ?? host().total_memory_bytes ?? 1))) *
                    100,
                )}%`,
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
                nvidia()?.name ??
                'Integrated / Probed',
            )}
          </div>
          <div class="text-[11.5px] text-[var(--status-emerald)]">
            VRAM: {String(host().vramMb ?? host().vram_mb ?? nvidia()?.vramMb ?? '—')} MiB
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
                      {maskText(String(pt.localAddress ?? pt.local_address ?? '127.0.0.1'), privacyMask())}:
                      <strong class="text-[var(--accent-cyan)]">{String(pt.port ?? pt.localPort ?? '')}</strong>
                    </span>
                    <span class="text-[var(--ink-muted)]">
                      {String(pt.process ?? pt.processName ?? 'pid')} ({String(pt.pid ?? '—')})
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
