import { Show, createSignal, onMount } from 'solid-js';
import { Activity, AlertTriangle, Cpu, Globe, HardDrive, KeyRound, RefreshCw, Trophy } from 'lucide-solid';
import { AiTelemetryPanel } from '@/components/workbenches/obs/AiTelemetryPanel';
import { BenchmarkScoreboardPanel } from '@/components/workbenches/obs/BenchmarkScoreboardPanel';
import { NetworkSpeedtestPanel } from '@/components/workbenches/obs/NetworkSpeedtestPanel';
import { RouterLabPanel } from '@/components/workbenches/obs/RouterLabPanel';
import { SystemHardwarePanel } from '@/components/workbenches/obs/SystemHardwarePanel';
import { VaultDiffExportPanel } from '@/components/workbenches/obs/VaultDiffExportPanel';
import { studioV5 } from '@/lib/studio';
import { obsSubTab, refreshSmartAlerts, setObsSubTab, smartAlerts } from '@/state/studio';
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
  const [superModeLabel, setSuperModeLabel] = createSignal('');

  const probeObservatoryStatus = async () => {
    void refreshSmartAlerts();
    const res = await studioV5.getSuperStatus();
    if (res.ok && res.data.mode) {
      const mode = String(res.data.mode);
      const proceed = String(res.data.autoProceed ?? res.data.auto_proceed ?? '');
      setSuperModeLabel(proceed ? `${mode} · ${proceed}` : mode);
    }
  };

  onMount(() => {
    void probeObservatoryStatus();
  });

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

        <div class="flex flex-wrap items-center gap-1.5 shrink-0">
          <Show when={superModeLabel()}>
            <span class="omnia-badge font-mono-num text-[10.5px] text-[var(--accent-cyan)]">
              Super: {superModeLabel()}
            </span>
          </Show>
          <Show when={smartAlerts.length > 0}>
            <button
              type="button"
              data-testid="obs-alerts-pill"
              onClick={() => setObsSubTab('telemetry')}
              class="omnia-badge font-mono-num text-[10.5px] text-[var(--accent-amber)] cursor-pointer inline-flex items-center gap-1"
              title="Jump to Smart Alerts & Threshold Rules"
            >
              <AlertTriangle class="w-3 h-3" />
              <span>{smartAlerts.length} Alert{smartAlerts.length === 1 ? '' : 's'}</span>
            </button>
          </Show>
          <button
            type="button"
            class="omnia-btn text-[11px] shrink-0"
            onClick={() => {
              setRefreshSeq((n) => n + 1);
              void probeObservatoryStatus();
            }}
          >
            <RefreshCw class="w-3.5 h-3.5" />
            <span>Refresh All</span>
          </button>
        </div>
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
