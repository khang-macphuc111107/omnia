import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import {
  Activity,
  Gauge,
  Globe,
  Lock,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Square,
  Wifi,
} from 'lucide-solid';
import { api } from '@/api/client';
import {
  dnsBenchTriggerSeq,
  liveSpeedtestWsEvent,
  privacyMask,
  speedtestTriggerSeq,
} from '@/state/studio';
import type { SpeedtestWaveformPoint } from '@/types';
import { maskSensitiveField, maskText } from '@/utils/privacy';
import { bufferbloatColorVar, formatMbps, formatMs, sparklinePoints } from '@/utils/stats';

function ProvenancePill(props: { state?: string }) {
  const norm = () => String(props.state ?? 'UNAVAILABLE').toUpperCase();
  return (
    <span
      class="omnia-badge font-mono-num text-[10px]"
      classList={{
        'text-[var(--status-emerald)]': norm() === 'LIVE',
        'text-[var(--accent-amber)]': norm() === 'CACHED',
        'text-[var(--ink-muted)]': norm() !== 'LIVE' && norm() !== 'CACHED',
      }}
    >
      {norm()}
    </span>
  );
}

export function NetworkSpeedtestPanel(props: { refreshSeq: number }) {
  const [identity, setIdentity] = createSignal<Record<string, unknown> | null>(null);
  const [dnsReport, setDnsReport] = createSignal<Record<string, unknown> | null>(null);
  const [proxyTls, setProxyTls] = createSignal<Record<string, unknown> | null>(null);
  const [speedtestResult, setSpeedtestResult] = createSignal<Record<string, unknown> | null>(null);
  const [history, setHistory] = createSignal<Array<Record<string, unknown>>>([]);
  const [compareA, setCompareA] = createSignal('');
  const [compareB, setCompareB] = createSignal('');
  const [activeRunId, setActiveRunId] = createSignal<string | null>(null);
  const [runningSpeedtest, setRunningSpeedtest] = createSignal(false);
  const [waveform, setWaveform] = createSignal<SpeedtestWaveformPoint[]>([]);
  const [livePhase, setLivePhase] = createSignal('idle');
  const [busyId, setBusyId] = createSignal(false);
  const [busyDns, setBusyDns] = createSignal(false);
  const [busyProxy, setBusyProxy] = createSignal(false);
  const [note, setNote] = createSignal('');

  let lastSpeedTrigger = speedtestTriggerSeq();
  let lastDnsTrigger = dnsBenchTriggerSeq();

  const loadOverview = async () => {
    const masked = privacyMask();
    const [ovRes, histRes] = await Promise.all([
      api.getNetworkOverview(masked),
      api.getSpeedtestHistory(20, masked),
    ]);
    if (ovRes.ok) {
      const d = ovRes.data;
      if (d.identity && typeof d.identity === 'object') setIdentity(d.identity as Record<string, unknown>);
      if (d.dns && typeof d.dns === 'object') setDnsReport(d.dns as Record<string, unknown>);
      if (d.proxyTls && typeof d.proxyTls === 'object') setProxyTls(d.proxyTls as Record<string, unknown>);
      if (d.lastSpeedtest && typeof d.lastSpeedtest === 'object') {
        setSpeedtestResult(d.lastSpeedtest as Record<string, unknown>);
      }
      setNote('');
    } else {
      setNote(`Network overview unavailable (${ovRes.error.code}): ${ovRes.error.message}`);
    }
    if (histRes.ok) {
      const runs = (histRes.data.runs ?? histRes.data.history ?? []) as Array<Record<string, unknown>>;
      if (Array.isArray(runs)) {
        setHistory(runs);
        if (runs.length >= 2 && !compareA() && !compareB()) {
          setCompareA(String(runs[0].runId ?? runs[0].id ?? ''));
          setCompareB(String(runs[1].runId ?? runs[1].id ?? ''));
        }
      }
    }
  };

  const handleRefreshIdentity = async () => {
    setBusyId(true);
    const res = await api.getNetworkIdentity(true, privacyMask());
    if (res.ok) {
      setIdentity((res.data.identity as Record<string, unknown>) ?? res.data);
      setNote('Identity refreshed');
    } else {
      setNote(`Identity probe error (${res.error.code}): ${res.error.message}`);
    }
    setBusyId(false);
  };

  const handleRunDns = async () => {
    setBusyDns(true);
    const res = await api.runDnsBenchmark(privacyMask());
    if (res.ok) {
      setDnsReport((res.data.dns as Record<string, unknown>) ?? res.data);
      setNote('Multi-resolver DNS benchmark & VPN leak check complete');
    } else {
      setNote(`DNS benchmark error (${res.error.code}): ${res.error.message}`);
    }
    setBusyDns(false);
  };

  const handleRefreshProxyTls = async () => {
    setBusyProxy(true);
    const res = await api.getProxyTls(true, privacyMask());
    if (res.ok) {
      setProxyTls((res.data.proxyTls as Record<string, unknown>) ?? res.data);
      setNote('Proxy/PAC & passive upstream waterfall refreshed');
    } else {
      setNote(`Proxy/TLS probe error (${res.error.code}): ${res.error.message}`);
    }
    setBusyProxy(false);
  };

  const handleStartSpeedtest = async (profile: 'quick' | 'standard') => {
    if (runningSpeedtest()) return;
    setRunningSpeedtest(true);
    setWaveform([]);
    setLivePhase(`starting (${profile})...`);
    const res = await api.startSpeedtest(profile);
    if (res.ok) {
      const rid = String(res.data.runId ?? res.data.run_id ?? `st-${Date.now()}`);
      setActiveRunId(rid);
      if (res.data.result && typeof res.data.result === 'object') {
        setSpeedtestResult(res.data.result as Record<string, unknown>);
        setRunningSpeedtest(false);
        setLivePhase('complete');
        void loadOverview();
      } else {
        setNote(`Live speedtest started (${rid}) — streaming over /ws channel "network"`);
      }
    } else {
      setRunningSpeedtest(false);
      setLivePhase('error');
      setNote(`Speedtest error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleCancelSpeedtest = async () => {
    const rid = activeRunId();
    if (!rid) return;
    const res = await api.cancelSpeedtest(rid);
    setRunningSpeedtest(false);
    setLivePhase('cancelled');
    setNote(res.ok ? `Cancelled speedtest ${rid}` : `Cancel note (${res.error.code}): ${res.error.message}`);
  };

  onMount(() => {
    void loadOverview();
  });

  createEffect(() => {
    props.refreshSeq;
    privacyMask();
    void loadOverview();
  });

  // React to Command Palette Speedtest / DNS triggers
  createEffect(() => {
    const stSeq = speedtestTriggerSeq();
    if (stSeq > lastSpeedTrigger) {
      lastSpeedTrigger = stSeq;
      void handleStartSpeedtest('quick');
    }
  });
  createEffect(() => {
    const dSeq = dnsBenchTriggerSeq();
    if (dSeq > lastDnsTrigger) {
      lastDnsTrigger = dSeq;
      void handleRunDns();
    }
  });

  // Consume live WS speedtest events (`speedtest_sample`, `speedtest_progress`, `speedtest_complete`)
  createEffect(() => {
    const ev = liveSpeedtestWsEvent();
    if (!ev) return;
    const p = ev.payload;
    if (ev.event === 'speedtest_sample' || ev.event === 'speedtest_progress') {
      const phase = String(p.phase ?? 'running');
      setLivePhase(phase);
      const mbps = Number(p.mbps ?? p.throughputMbps ?? 0);
      const rttMs = p.rttMs !== undefined ? Number(p.rttMs) : undefined;
      setWaveform((prev) => [...prev.slice(-79), { tMs: Number(p.tMs ?? Date.now()), phase, mbps, rttMs }]);
    } else if (ev.event === 'speedtest_complete') {
      setRunningSpeedtest(false);
      setLivePhase('complete');
      const resultObj = (p.result && typeof p.result === 'object' ? p.result : p) as Record<string, unknown>;
      setSpeedtestResult(resultObj);
      if (Array.isArray(resultObj.waveform)) {
        setWaveform(
          (resultObj.waveform as Array<Record<string, unknown>>).map((w) => ({
            tMs: Number(w.tMs ?? w.t_ms ?? 0),
            phase: String(w.phase ?? 'download'),
            mbps: Number(w.mbps ?? 0),
            rttMs: w.rttMs !== undefined ? Number(w.rttMs) : undefined,
          })),
        );
      }
      void loadOverview();
    }
  });

  const adapters = createMemo(() => {
    const raw = identity()?.adapters;
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  });

  const resolvers = createMemo(() => {
    const raw = dnsReport()?.resolvers;
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  });

  const endpoints = createMemo(() => {
    const raw = proxyTls()?.endpoints;
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  });

  const waveSvgPoints = createMemo(() => {
    const pts = waveform();
    if (pts.length > 0) return sparklinePoints(pts.map((p) => p.mbps), 360, 74, 5);
    const resWave = speedtestResult()?.waveform;
    if (Array.isArray(resWave) && resWave.length > 0) {
      return sparklinePoints(
        (resWave as Array<Record<string, unknown>>).map((w) => Number(w.mbps ?? 0)),
        360,
        74,
        5,
      );
    }
    return '';
  });

  const speedMetrics = createMemo(() => {
    const s = speedtestResult() ?? {};
    const unloaded = Number(s.unloadedP50Ms ?? s.unloaded_p50_ms ?? (s.unloadedRtt as Record<string, unknown> | undefined)?.p50_ms ?? 0);
    const dlDelta = Number(s.dlBufferbloatDeltaMs ?? s.dl_bufferbloat_delta_ms ?? 0);
    const ulDelta = Number(s.ulBufferbloatDeltaMs ?? s.ul_bufferbloat_delta_ms ?? 0);
    const dlMbps = Number(s.downloadMbps ?? s.download_mbps ?? s.dlMultiMbps ?? 0);
    const ulMbps = Number(s.uploadMbps ?? s.upload_mbps ?? s.ulMultiMbps ?? 0);
    const grade = String(s.bufferbloatGrade ?? s.bufferbloat_grade ?? '—');
    const readiness = (s.workloadReadiness ?? s.workload_readiness ?? {}) as Record<string, unknown>;
    return { unloaded, dlLoaded: unloaded + dlDelta, ulLoaded: unloaded + ulDelta, dlDelta, ulDelta, dlMbps, ulMbps, grade, readiness };
  });

  const histDiff = createMemo(() => {
    const a = history().find((r) => String(r.runId ?? r.id) === compareA());
    const b = history().find((r) => String(r.runId ?? r.id) === compareB());
    if (!a || !b) return null;
    const dlA = Number(a.downloadMbps ?? a.download_mbps ?? 0);
    const dlB = Number(b.downloadMbps ?? b.download_mbps ?? 0);
    const ulA = Number(a.uploadMbps ?? a.upload_mbps ?? 0);
    const ulB = Number(b.uploadMbps ?? b.upload_mbps ?? 0);
    const rttA = Number(a.unloadedP50Ms ?? a.unloaded_p50_ms ?? 0);
    const rttB = Number(b.unloadedP50Ms ?? b.unloaded_p50_ms ?? 0);
    return { dlDelta: dlA - dlB, ulDelta: ulA - ulB, rttDelta: rttA - rttB, gradeA: String(a.bufferbloatGrade ?? a.bufferbloat_grade ?? '—'), gradeB: String(b.bufferbloatGrade ?? b.bufferbloat_grade ?? '—') };
  });

  return (
    <div data-testid="obs-network-panel" class="space-y-4">
      <Show when={note()}>
        <div class="px-3 py-1.5 rounded border border-[var(--border-accent)] bg-[var(--accent-dim)] text-[11.5px] font-mono-num text-[var(--accent-cyan)]">
          {maskText(note(), privacyMask())}
        </div>
      </Show>

      {/* 1. Identity, NICs, VPN, NAT & Fingerprint */}
      <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 font-bold text-[13.5px]">
            <Globe class="w-4 h-4 text-[var(--accent-cyan)]" />
            <span>Network Identity, NICs, VPN/NAT & Fingerprint</span>
            <ProvenancePill state={String(identity()?.provenance ?? 'UNAVAILABLE')} />
          </div>
          <button type="button" disabled={busyId()} class="omnia-btn text-[11px]" onClick={() => void handleRefreshIdentity()}>
            <RefreshCw class="w-3.5 h-3.5" classList={{ 'animate-spin': busyId() }} />
            <span>Probe Identity</span>
          </button>
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-5 gap-2 text-[11.5px] font-mono-num">
          <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
            <div class="text-[10px] text-[var(--ink-muted)]">Public IPv4</div>
            <div class="font-semibold truncate">
              {maskSensitiveField(identity()?.publicIpv4 as string ?? identity()?.public_ipv4 as string, privacyMask())}
            </div>
          </div>
          <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
            <div class="text-[10px] text-[var(--ink-muted)]">ASN / ISP / Colo</div>
            <div class="font-semibold truncate">
              {(() => {
                const geo = (identity()?.geo ?? {}) as Record<string, unknown>;
                const txt = [geo.asn, geo.isp, geo.colo ?? geo.city].filter(Boolean).join(' · ');
                return txt ? maskText(txt, privacyMask()) : '—';
              })()}
            </div>
          </div>
          <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
            <div class="text-[10px] text-[var(--ink-muted)]">VPN / NAT</div>
            <div class="font-semibold truncate">
              {identity()?.vpnActive || identity()?.vpn_active ? 'VPN ACTIVE' : 'Direct'} ·{' '}
              {String(identity()?.natClassification ?? identity()?.nat_classification ?? 'unknown')}
            </div>
          </div>
          <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
            <div class="text-[10px] text-[var(--ink-muted)] flex items-center gap-1">
              <Wifi class="w-3 h-3" />
              <span>Wi-Fi Link</span>
            </div>
            <div class="font-semibold truncate">
              {(() => {
                const w = (identity()?.wifi ?? null) as Record<string, unknown> | null;
                if (!w) return 'Wired / N/A';
                return `${maskSensitiveField(String(w.ssid ?? ''), privacyMask())} (${String(w.signal_pct ?? w.signalPct ?? '?')}%)`;
              })()}
            </div>
          </div>
          <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
            <div class="text-[10px] text-[var(--ink-muted)]">SHA-256 Fingerprint</div>
            <div class="font-semibold text-[var(--accent-cyan)] truncate">
              {String(identity()?.fingerprintSha256 ?? identity()?.fingerprint_sha256 ?? '—').slice(0, 14)}
            </div>
          </div>
        </div>

        <Show when={adapters().length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse text-[11px] font-mono-num">
              <thead>
                <tr class="border-b border-[var(--border-subtle)] text-[var(--ink-muted)]">
                  <th class="py-1.5 pr-3">Adapter</th>
                  <th class="py-1.5 pr-3">Status / Kind</th>
                  <th class="py-1.5 pr-3">IPv4 CIDRs</th>
                  <th class="py-1.5 pr-3">MAC</th>
                  <th class="py-1.5 pr-3">MTU / Speed</th>
                  <th class="py-1.5">VPN Tag</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--border-subtle)]">
                <For each={adapters()}>
                  {(nic) => (
                    <tr>
                      <td class="py-1.5 pr-3 font-semibold text-[var(--ink-primary)]">{String(nic.name ?? 'nic')}</td>
                      <td class="py-1.5 pr-3">{String(nic.status ?? '')} · {String(nic.kind ?? '')}</td>
                      <td class="py-1.5 pr-3">
                        {maskText(
                          Array.isArray(nic.ipv4Cidrs ?? nic.ipv4_cidrs)
                            ? ((nic.ipv4Cidrs ?? nic.ipv4_cidrs) as unknown[]).join(', ')
                            : '—',
                          privacyMask(),
                        )}
                      </td>
                      <td class="py-1.5 pr-3">{maskSensitiveField(String(nic.macAddress ?? nic.mac_address ?? ''), privacyMask())}</td>
                      <td class="py-1.5 pr-3">
                        {String(nic.mtu ?? '—')} / {String(nic.linkSpeedMbps ?? nic.link_speed_mbps ?? '—')}M
                      </td>
                      <td class="py-1.5 text-[var(--accent-amber)]">{String(nic.vpnTag ?? nic.vpn_tag ?? '—')}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>

      {/* 2. On-Demand Cancellable Live-Streamed Speedtest & Bufferbloat (A+..F) */}
      <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 font-bold text-[13.5px]">
            <Gauge class="w-4 h-4 text-[var(--accent-amber)]" />
            <span>On-Demand Speedtest & Bufferbloat Lab</span>
            <ProvenancePill state={String(speedtestResult()?.provenance ?? (runningSpeedtest() ? 'LIVE' : 'UNAVAILABLE'))} />
            <span class="omnia-badge font-mono-num text-[10.5px]">phase: {livePhase()}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="speedtest-start-quick"
              disabled={runningSpeedtest()}
              class="omnia-btn omnia-btn-primary text-[11.5px]"
              onClick={() => void handleStartSpeedtest('quick')}
            >
              <Play class="w-3.5 h-3.5" />
              <span>Run Quick</span>
            </button>
            <button
              type="button"
              disabled={runningSpeedtest()}
              class="omnia-btn text-[11.5px]"
              onClick={() => void handleStartSpeedtest('standard')}
            >
              <Play class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
              <span>Run Standard</span>
            </button>
            <Show when={runningSpeedtest()}>
              <button
                type="button"
                data-testid="speedtest-cancel-btn"
                class="omnia-btn omnia-btn-danger text-[11.5px]"
                onClick={() => void handleCancelSpeedtest()}
              >
                <Square class="w-3.5 h-3.5" />
                <span>Cancel</span>
              </button>
            </Show>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Live SVG Waveform */}
          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-2">
            <div class="flex items-center justify-between text-[11.5px] font-mono-num">
              <span class="text-[var(--ink-secondary)]">Live Throughput Waveform</span>
              <span class="text-[var(--accent-cyan)]">
                DL {formatMbps(speedMetrics().dlMbps)} · UL {formatMbps(speedMetrics().ulMbps)}
              </span>
            </div>
            <svg viewBox="0 0 360 74" class="w-full h-20 rounded bg-[var(--bg-panel)] border border-[var(--border-subtle)]">
              <line x1="0" y1="37" x2="360" y2="37" stroke="var(--border-subtle)" stroke-dasharray="3 3" />
              <Show
                when={waveSvgPoints().length > 0}
                fallback={
                  <text x="180" y="40" text-anchor="middle" fill="var(--ink-muted)" font-size="11">
                    Click Run Quick or Standard (zero auto-run on load)
                  </text>
                }
              >
                <polyline fill="none" stroke="var(--accent-cyan)" stroke-width="2.2" points={waveSvgPoints()} />
              </Show>
            </svg>
          </div>

          {/* Bufferbloat Grade & Unloaded vs Loaded DL/UL Latency Bars */}
          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-2">
            <div class="flex items-center justify-between text-[11.5px]">
              <span class="font-semibold text-[var(--ink-secondary)]">Bufferbloat Grade & Latency</span>
              <span
                class="px-2 py-0.5 rounded font-mono-num font-bold text-[13px] border border-[var(--border-strong)]"
                style={{ color: bufferbloatColorVar(speedMetrics().grade) }}
              >
                Grade {speedMetrics().grade}
              </span>
            </div>
            <div class="space-y-1.5 text-[11px] font-mono-num">
              {[
                { label: 'Unloaded RTT', val: speedMetrics().unloaded, color: 'var(--status-emerald)' },
                { label: `Loaded DL (+${speedMetrics().dlDelta.toFixed(0)}ms)`, val: speedMetrics().dlLoaded, color: 'var(--accent-cyan)' },
                { label: `Loaded UL (+${speedMetrics().ulDelta.toFixed(0)}ms)`, val: speedMetrics().ulLoaded, color: 'var(--accent-amber)' },
              ].map((bar) => {
                const maxMs = Math.max(100, speedMetrics().dlLoaded, speedMetrics().ulLoaded, 1);
                return (
                  <div class="space-y-0.5">
                    <div class="flex justify-between">
                      <span class="text-[var(--ink-muted)]">{bar.label}</span>
                      <span>{formatMs(bar.val)}</span>
                    </div>
                    <div class="w-full h-2 rounded bg-[var(--bg-panel)] overflow-hidden">
                      <div
                        class="h-full"
                        style={{ width: `${Math.min(100, (bar.val / maxMs) * 100)}%`, 'background-color': bar.color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Workload Readiness Scores + Historical Speedtest Diffing */}
          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-2">
            <div class="text-[11.5px] font-semibold text-[var(--ink-secondary)]">Workload Readiness Scores</div>
            <div class="grid grid-cols-2 gap-1.5 text-[11px] font-mono-num">
              {[
                { k: 'ai_sse_streaming', alt: 'aiSseStreaming', label: 'AI SSE Stream' },
                { k: 'git_docker_sync', alt: 'gitDockerSync', label: 'Git / Docker' },
                { k: 'webrtc', alt: 'webrtc', label: 'WebRTC / Call' },
                { k: 'remote_control', alt: 'remoteControl', label: 'Remote Ctrl' },
              ].map((w) => {
                const val = speedMetrics().readiness[w.k] ?? speedMetrics().readiness[w.alt];
                return (
                  <div class="p-1.5 rounded bg-[var(--bg-panel)] border border-[var(--border-subtle)] flex items-center justify-between">
                    <span class="text-[var(--ink-muted)] truncate">{w.label}</span>
                    <span class="font-bold text-[var(--status-emerald)]">{val !== undefined ? String(val) : '—'}</span>
                  </div>
                );
              })}
            </div>

            <Show when={history().length >= 2}>
              <div class="pt-1.5 border-t border-[var(--border-subtle)] space-y-1 text-[10.5px] font-mono-num">
                <div class="text-[var(--ink-muted)]">Historical Speedtest Diff</div>
                <div class="flex gap-1">
                  <select
                    value={compareA()}
                    onChange={(e) => setCompareA(e.currentTarget.value)}
                    class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-1 py-0.5"
                  >
                    <For each={history()}>
                      {(r) => <option value={String(r.runId ?? r.id)}>{String(r.runId ?? r.id).slice(0, 10)}</option>}
                    </For>
                  </select>
                  <span class="self-center">vs</span>
                  <select
                    value={compareB()}
                    onChange={(e) => setCompareB(e.currentTarget.value)}
                    class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-1 py-0.5"
                  >
                    <For each={history()}>
                      {(r) => <option value={String(r.runId ?? r.id)}>{String(r.runId ?? r.id).slice(0, 10)}</option>}
                    </For>
                  </select>
                </div>
                <Show when={histDiff()}>
                  {(d) => (
                    <div class="flex justify-between text-[var(--accent-cyan)]">
                      <span>ΔDL {d().dlDelta >= 0 ? '+' : ''}{d().dlDelta.toFixed(1)}M</span>
                      <span>ΔUL {d().ulDelta >= 0 ? '+' : ''}{d().ulDelta.toFixed(1)}M</span>
                      <span>ΔRTT {d().rttDelta >= 0 ? '+' : ''}{d().rttDelta.toFixed(0)}ms</span>
                    </div>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </div>

      {/* 3. Multi-Resolver DNS Benchmark + VPN Leak Check & 4. Proxy / TLS / Endpoint Waterfall */}
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 font-bold text-[13px]">
              <Server class="w-4 h-4 text-[var(--accent-cyan)]" />
              <span>Multi-Resolver DNS Benchmark & VPN Leak Check</span>
              <ProvenancePill state={String(dnsReport()?.provenance ?? 'UNAVAILABLE')} />
            </div>
            <button type="button" disabled={busyDns()} class="omnia-btn text-[11px]" onClick={() => void handleRunDns()}>
              <Activity class="w-3.5 h-3.5" />
              <span>Run DNS Bench</span>
            </button>
          </div>

          <div
            class="px-3 py-2 rounded border text-[11.5px] font-mono-num flex items-center justify-between gap-2"
            classList={{
              'border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[var(--status-coral)]':
                String(dnsReport()?.leakStatus ?? dnsReport()?.leak_status ?? '') === 'possible_dns_leak',
              'border-[var(--status-emerald)] bg-[var(--status-emerald-dim)] text-[var(--status-emerald)]':
                String(dnsReport()?.leakStatus ?? dnsReport()?.leak_status ?? '') === 'none',
              'border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--ink-secondary)]':
                !['possible_dns_leak', 'none'].includes(String(dnsReport()?.leakStatus ?? dnsReport()?.leak_status ?? '')),
            }}
          >
            <span class="flex items-center gap-1.5">
              {String(dnsReport()?.leakStatus ?? dnsReport()?.leak_status ?? '') === 'possible_dns_leak' ? (
                <ShieldAlert class="w-3.5 h-3.5" />
              ) : (
                <ShieldCheck class="w-3.5 h-3.5" />
              )}
              <span>
                VPN DNS Leak: {String(dnsReport()?.leakStatus ?? dnsReport()?.leak_status ?? 'unverified')}
              </span>
            </span>
            <span>
              Egress: {maskSensitiveField(String(dnsReport()?.dnsEgressIp ?? dnsReport()?.dns_egress_ip ?? ''), privacyMask())}
            </span>
          </div>

          <div class="space-y-1.5 text-[11.5px] font-mono-num">
            <Show
              when={resolvers().length > 0}
              fallback={
                <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                  Click <strong>Run DNS Bench</strong> to benchmark System, 1.1.1.1, 8.8.8.8, 9.9.9.9, and 94.140.14.14.
                </div>
              }
            >
              <For each={resolvers()}>
                {(r) => {
                  const p50 = Number(r.p50Ms ?? r.p50_ms ?? 0);
                  const p95 = Number(r.p95Ms ?? r.p95_ms ?? 0);
                  const widthPct = Math.min(100, Math.max(4, (p50 / 120) * 100));
                  return (
                    <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1">
                      <div class="flex items-center justify-between gap-2">
                        <span class="font-semibold text-[var(--ink-primary)]">
                          {String(r.name ?? r.server ?? 'resolver')}
                        </span>
                        <span class="text-[var(--ink-muted)]">
                          p50:{formatMs(p50)} · p95:{formatMs(p95)} · jit:{formatMs(Number(r.jitterMs ?? r.jitter_ms ?? 0))} · fail:{Number(r.failureRatePct ?? r.failure_rate_pct ?? 0).toFixed(0)}%
                        </span>
                      </div>
                      <div class="w-full h-1.5 rounded bg-[var(--bg-panel)] overflow-hidden">
                        <div class="h-full bg-[var(--accent-cyan)]" style={{ width: `${widthPct}%` }} />
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>

        {/* Proxy / PAC / TLS Chain + Passive Upstream Endpoint Waterfall */}
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 font-bold text-[13px]">
              <Lock class="w-4 h-4 text-[var(--status-emerald)]" />
              <span>Proxy / PAC / TLS Chain & Upstream Waterfall</span>
              <ProvenancePill state={String(proxyTls()?.provenance ?? 'UNAVAILABLE')} />
            </div>
            <button type="button" disabled={busyProxy()} class="omnia-btn text-[11px]" onClick={() => void handleRefreshProxyTls()}>
              <RefreshCw class="w-3.5 h-3.5" classList={{ 'animate-spin': busyProxy() }} />
              <span>Probe TLS</span>
            </button>
          </div>

          <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11px] font-mono-num space-y-1">
            <div class="flex justify-between">
              <span class="text-[var(--ink-muted)]">System Proxy / PAC</span>
              <span class="text-[var(--ink-primary)] truncate max-w-[260px]">
                {maskText(
                  String(
                    (proxyTls()?.systemProxy as Record<string, unknown> | undefined)?.proxyServer ??
                      (proxyTls()?.system_proxy as Record<string, unknown> | undefined)?.proxy_server ??
                      'Direct / None',
                  ),
                  privacyMask(),
                )}
              </span>
            </div>
            <div class="flex justify-between">
              <span class="text-[var(--ink-muted)]">Waterfall Legend</span>
              <span class="space-x-2">
                <span class="text-[var(--accent-cyan)]">■ DNS</span>
                <span class="text-[var(--accent-amber)]">■ TCP</span>
                <span class="text-[var(--status-emerald)]">■ TLS</span>
                <span class="text-[var(--ink-secondary)]">■ TTFB</span>
              </span>
            </div>
          </div>

          <div class="space-y-2 text-[11px] font-mono-num">
            <Show
              when={endpoints().length > 0}
              fallback={
                <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                  Click <strong>Probe TLS</strong> to inspect passive upstream DNS-&gt;TCP-&gt;TLS-&gt;TTFB waterfalls and certificate expiry.
                </div>
              }
            >
              <For each={endpoints()}>
                {(ep) => {
                  const dns = Number(ep.dnsMs ?? ep.dns_ms ?? 0);
                  const tcp = Number(ep.tcpMs ?? ep.tcp_ms ?? 0);
                  const tls = Number(ep.tlsMs ?? ep.tls_ms ?? 0);
                  const ttfb = Number(ep.ttfbMs ?? ep.ttfb_ms ?? 0);
                  const tot = Math.max(1, dns + tcp + tls + ttfb);
                  return (
                    <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1">
                      <div class="flex items-center justify-between gap-2">
                        <span class="font-semibold text-[var(--ink-primary)] truncate">
                          {maskText(String(ep.host ?? ep.url ?? 'endpoint'), privacyMask())}
                        </span>
                        <span class="text-[var(--ink-muted)] shrink-0">
                          HTTP {String(ep.httpStatus ?? ep.http_status ?? '—')} · {formatMs(tot)} ·{' '}
                          {String(ep.tlsVersion ?? ep.tls_version ?? 'TLS')}
                        </span>
                      </div>
                      <div class="w-full h-2 rounded overflow-hidden flex bg-[var(--bg-panel)]">
                        <div style={{ width: `${(dns / tot) * 100}%`, 'background-color': 'var(--accent-cyan)' }} title={`DNS ${dns}ms`} />
                        <div style={{ width: `${(tcp / tot) * 100}%`, 'background-color': 'var(--accent-amber)' }} title={`TCP ${tcp}ms`} />
                        <div style={{ width: `${(tls / tot) * 100}%`, 'background-color': 'var(--status-emerald)' }} title={`TLS ${tls}ms`} />
                        <div style={{ width: `${(ttfb / tot) * 100}%`, 'background-color': 'var(--ink-secondary)' }} title={`TTFB ${ttfb}ms`} />
                      </div>
                      <Show when={ep.mitmCaSuspected || ep.mitm_ca_suspected}>
                        <div class="text-[10.5px] text-[var(--status-coral)]">MITM / Custom Root CA suspected</div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
