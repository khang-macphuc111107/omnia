import { Show, createSignal } from 'solid-js';
import { Activity, Cpu, Globe, HardDrive, KeyRound, RefreshCw, Trophy } from 'lucide-solid';
import { AiTelemetryPanel } from '@/components/workbenches/obs/AiTelemetryPanel';
import { BenchmarkScoreboardPanel } from '@/components/workbenches/obs/BenchmarkScoreboardPanel';
import { NetworkSpeedtestPanel } from '@/components/workbenches/obs/NetworkSpeedtestPanel';
import { RouterLabPanel } from '@/components/workbenches/obs/RouterLabPanel';
import { SystemHardwarePanel } from '@/components/workbenches/obs/SystemHardwarePanel';
import { VaultDiffExportPanel } from '@/components/workbenches/obs/VaultDiffExportPanel';
import { obsSubTab, setObsSubTab } from '@/state/studio';
import type { ObservabilitySubTab } from '@/types';

const SUB_TABS: Array<{ id: ObservabilitySubTab; label: string; icon: () => any }> = [
  { id: 'telemetry', label: 'AI Telemetry', icon: () => <Activity class="w-3.5 h-3.5" /> },
  { id: 'router', label: 'Router Lab', icon: () => <Cpu class="w-3.5 h-3.5" /> },
  { id: 'network', label: 'Network & Speedtest', icon: () => <Globe class="w-3.5 h-3.5" /> },
  { id: 'system', label: 'Hardware & WAL', icon: () => <HardDrive class="w-3.5 h-3.5" /> },
  { id: 'benchmarks', label: 'Benchmarks v5', icon: () => <Trophy class="w-3.5 h-3.5" /> },
  { id: 'vault', label: 'Vault, Diffs & Export', icon: () => <KeyRound class="w-3.5 h-3.5" /> },
];

export function ObservabilityView() {
  const [refreshSeq, setRefreshSeq] = createSignal(0);

  return (
    <div
      data-testid="observability-workbench"
      class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]"
    >
      {/* Responsive Lab-Grade Sub-Tab Bar */}
      <div class="px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2">
        <div class="omp-segmented text-[11.5px] flex-wrap" data-testid="obs-subtab-bar">
          {SUB_TABS.map((t) => (
            <button
              type="button"
              data-obs-tab={t.id}
              aria-pressed={obsSubTab() === t.id}
              onClick={() => setObsSubTab(t.id)}
              class="flex items-center gap-1.5 whitespace-nowrap"
            >
              {t.icon()}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          class="omnia-btn text-[11px] shrink-0"
          onClick={() => setRefreshSeq((n) => n + 1)}
        >
          <RefreshCw class="w-3.5 h-3.5" />
          <span>Refresh All</span>
        </button>
      </div>

      {/* Active Observatory Panel */}
      <div class="flex-1 overflow-y-auto p-4">
        <Show when={obsSubTab() === 'telemetry'}>
          <AiTelemetryPanel refreshSeq={refreshSeq()} />
        </Show>
        <Show when={obsSubTab() === 'router'}>
          <RouterLabPanel refreshSeq={refreshSeq()} />
        </Show>
        <Show when={obsSubTab() === 'network'}>
          <NetworkSpeedtestPanel refreshSeq={refreshSeq()} />
        </Show>
        <Show when={obsSubTab() === 'system'}>
          <SystemHardwarePanel refreshSeq={refreshSeq()} />
        </Show>
        <Show when={obsSubTab() === 'benchmarks'}>
          <BenchmarkScoreboardPanel refreshSeq={refreshSeq()} />
        </Show>
        <Show when={obsSubTab() === 'vault'}>
          <VaultDiffExportPanel refreshSeq={refreshSeq()} />
        </Show>
      </div>
    </div>
  );
}
