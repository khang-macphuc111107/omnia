import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  Activity,
  Gauge,
  Globe,
  Lock,
  Network,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Square,
  Wifi,
  Zap,
} from 'lucide-solid';
import { api } from '@/api/client';
import {
  type GlobalRadarRegion,
  type PassiveMonitorSample,
  type SpeedtestProfile,
  type SpeedtestStreamMode,
  type TracerouteHop,
  studioV5,
} from '@/lib/studio';
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

function formatBps(bps: number | null | undefined): string {
  const n = Number(bps ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 bps';
  if (n < 1_000) return `${n.toFixed(0)} bps`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)} Kbps`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)} Mbps`;
  return `${(n / 1_000_000_000).toFixed(2)} Gbps`;
}

function normalizeWaveformPoint(w: Record<string, unknown>): SpeedtestWaveformPoint {
  const rawRtt = w.loadedRttMs ?? w.loaded_rtt_ms ?? w.rttMs ?? w.rtt_ms;
  return {
    tMs: Number(w.elapsedMs ?? w.elapsed_ms ?? w.tMs ?? w.t_ms ?? 0),
    phase: String(w.phase ?? 'download'),
    mbps: Number(w.mbps ?? 0),
    rttMs: rawRtt !== undefined && rawRtt !== null && Number.isFinite(Number(rawRtt))
      ? Number(rawRtt)
      : undefined,
  };
}

function inferEndpointCategory(ep: Record<string, unknown>): string {
  const explicit = ep.category ?? ep.group;
  if (explicit) return String(explicit);
  const key = `${String(ep.id ?? '')} ${String(ep.label ?? '')} ${String(ep.host ?? ep.url ?? '')}`.toLowerCase();
  if (key.includes('openai') || key.includes('anthropic') || key.includes('google') || key.includes('hugging')) {
    return 'AI / Model';
  }
  if (key.includes('npm') || key.includes('crates') || key.includes('pypi') || key.includes('github')) {
    return 'Registry / Git';
  }
  if (key.includes('cloudflare')) return 'Edge / CDN';
  return 'Custom / Net';
}

function splitIpv6Cidrs(raw: unknown): { global: string[]; linkLocal: string[] } {
  const list = Array.isArray(raw) ? raw.map(String) : [];
  const global: string[] = [];
  const linkLocal: string[] = [];
  for (const cidr of list) {
    if (cidr.toLowerCase().startsWith('fe80:')) {
      linkLocal.push(cidr);
    } else if (cidr.trim()) {
      global.push(cidr);
    }
  }
  return { global, linkLocal };
}

function RadialSpeedGauge(props: {
  label: string;
  mbps: number;
  subLabel?: string;
  accentVar: string;
}) {
  const maxScale = () => {
    const v = Math.max(0, props.mbps);
    if (v <= 100) return 100;
    if (v <= 250) return 250;
    if (v <= 500) return 500;
    if (v <= 1000) return 1000;
    return Math.ceil(v / 500) * 500;
  };
  const ratio = () => Math.max(0, Math.min(1, props.mbps / maxScale()));
  const radius = 44;
  const arcLen = Math.PI * radius; // 180-degree semi-circle
  const dashOffset = () => arcLen * (1 - ratio());

  return (
    <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-col items-center">
      <svg
        viewBox="0 0 120 74"
        class="w-32 h-20"
        role="img"
        aria-label={`${props.label} ${props.mbps.toFixed(1)} Mbps`}
      >
        <title>
          {props.label}: {props.mbps.toFixed(1)} Mbps (scale 0-{maxScale()} Mbps)
        </title>
        <path
          d="M 16 62 A 44 44 0 0 1 104 62"
          fill="none"
          stroke="var(--border-strong)"
          stroke-width="8"
          stroke-linecap="round"
        />
        <path
          d="M 16 62 A 44 44 0 0 1 104 62"
          fill="none"
          stroke={props.accentVar}
          stroke-width="8"
          stroke-linecap="round"
          stroke-dasharray={`${arcLen.toFixed(2)} ${arcLen.toFixed(2)}`}
          stroke-dashoffset={dashOffset().toFixed(2)}
        />
        <text
          x="60"
          y="48"
          text-anchor="middle"
          fill="var(--ink-primary)"
          font-size="14"
          font-weight="700"
          class="font-mono-num"
        >
          {props.mbps > 0 ? props.mbps.toFixed(1) : '—'}
        </text>
        <text x="60" y="62" text-anchor="middle" fill="var(--ink-muted)" font-size="8.5" class="font-mono-num">
          Mbps · /{maxScale()}
        </text>
      </svg>
      <div class="text-[11px] font-semibold text-[var(--ink-primary)] -mt-1">{props.label}</div>
      <Show when={props.subLabel}>
        <div class="text-[10px] font-mono-num text-[var(--ink-muted)] truncate max-w-full">{props.subLabel}</div>
      </Show>
    </div>
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
  const [streamMode, setStreamMode] = createSignal<SpeedtestStreamMode>('multi');
  const [waveform, setWaveform] = createSignal<SpeedtestWaveformPoint[]>([]);
  const [livePhase, setLivePhase] = createSignal('idle');
  const [busyId, setBusyId] = createSignal(false);
  const [busyDns, setBusyDns] = createSignal(false);
  const [busyProxy, setBusyProxy] = createSignal(false);
  const [note, setNote] = createSignal('');

  // Custom DNS, Custom Waterfall Host, Custom TLS Probe (Vietnamese IME-safe inputs)
  const [customDnsInput, setCustomDnsInput] = createSignal('');
  const [customHostInput, setCustomHostInput] = createSignal('');
  const [customTlsHostInput, setCustomTlsHostInput] = createSignal('');
  const [busyCustomTls, setBusyCustomTls] = createSignal(false);
  const [customTlsResult, setCustomTlsResult] = createSignal<Record<string, unknown> | null>(null);

  // 6-Region Global Latency Radar
  const [radarRegions, setRadarRegions] = createSignal<GlobalRadarRegion[]>([]);
  const [radarProvenance, setRadarProvenance] = createSignal('UNAVAILABLE');
  const [busyRadar, setBusyRadar] = createSignal(false);

  // Bounded 12-Hop Traceroute
  const [traceTarget, setTraceTarget] = createSignal('1.1.1.1');
  const [traceMaxHops, setTraceMaxHops] = createSignal(12);
  const [traceResult, setTraceResult] = createSignal<{
    target: string;
    reached: boolean;
    durationMs: number;
    hops: TracerouteHop[];
    error?: string;
  } | null>(null);
  const [busyTrace, setBusyTrace] = createSignal(false);

  // Passive Background Monitor (120-sample ring buffer)
  const [monitorRunning, setMonitorRunning] = createSignal(false);
  const [monitorSamples, setMonitorSamples] = createSignal<PassiveMonitorSample[]>([]);
  const [monitorCapacity, setMonitorCapacity] = createSignal(120);
  const [busyMonitor, setBusyMonitor] = createSignal(false);
  let monitorPollTimer: ReturnType<typeof setInterval> | null = null;

  let lastSpeedTrigger = speedtestTriggerSeq();
  let lastDnsTrigger = dnsBenchTriggerSeq();

  const applyMonitorPayload = (data: Record<string, unknown>) => {
    const running = Boolean(data.running ?? data.active ?? false);
    setMonitorRunning(running);
    const cap = Number(data.capacity ?? 120);
    if (Number.isFinite(cap) && cap > 0) setMonitorCapacity(cap);
    const rawSamples = data.samples;
    if (Array.isArray(rawSamples)) {
      setMonitorSamples(rawSamples as PassiveMonitorSample[]);
    }
  };

  const refreshMonitor = async () => {
    const res = await studioV5.getPassiveMonitor(privacyMask());
    if (res.ok) {
      applyMonitorPayload(res.data as Record<string, unknown>);
    }
  };

  const loadOverview = async () => {
    const masked = privacyMask();
    const [ovRes, histRes, monRes] = await Promise.all([
      studioV5.getNetworkSnapshot({
        privacyMask: masked,
        customDns: customDnsInput() || undefined,
        customHost: customHostInput() || undefined,
      }),
      api.getSpeedtestHistory(20, masked),
      studioV5.getPassiveMonitor(masked),
    ]);
    if (ovRes.ok) {
      const d = ovRes.data;
      if (d.identity && typeof d.identity === 'object') setIdentity(d.identity as Record<string, unknown>);
      if (d.dns && typeof d.dns === 'object') setDnsReport(d.dns as Record<string, unknown>);
      if (d.proxyTls && typeof d.proxyTls === 'object') setProxyTls(d.proxyTls as Record<string, unknown>);
      const latest = d.latestSpeedtest ?? d.lastSpeedtest;
      if (latest && typeof latest === 'object') {
        const latestObj = latest as Record<string, unknown>;
        setSpeedtestResult(latestObj);
        if (Array.isArray(latestObj.waveform) && waveform().length === 0) {
          setWaveform(
            (latestObj.waveform as Array<Record<string, unknown>>).map(normalizeWaveformPoint),
          );
        }
      }
      if (!histRes.ok && Array.isArray(d.recentSpeedtests)) {
        setHistory(d.recentSpeedtests as Array<Record<string, unknown>>);
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
    if (monRes.ok) {
      applyMonitorPayload(monRes.data as Record<string, unknown>);
    }
  };

  const handleRefreshIdentity = async () => {
    setBusyId(true);
    const res = await api.getNetworkIdentity(true, privacyMask());
    if (res.ok) {
      setIdentity((res.data.identity as Record<string, unknown>) ?? res.data);
      setNote('Identity, Wi-Fi RF, VPN/CGNAT & STUN NAT refreshed');
    } else {
      setNote(`Identity probe error (${res.error.code}): ${res.error.message}`);
    }
    setBusyId(false);
  };

  const handleRunDns = async () => {
    setBusyDns(true);
    const res = await studioV5.runDnsBenchmark({
      privacyMask: privacyMask(),
      customDns: customDnsInput() || undefined,
    });
    if (res.ok) {
      setDnsReport((res.data.dns as Record<string, unknown>) ?? res.data);
      setNote('Multi-resolver DNS benchmark, DNSSEC/EDNS0/AAAA & leak check complete');
    } else {
      setNote(`DNS benchmark error (${res.error.code}): ${res.error.message}`);
    }
    setBusyDns(false);
  };

  const handleRefreshProxyTls = async () => {
    setBusyProxy(true);
    const res = await studioV5.probeProxyTls({
      force: true,
      privacyMask: privacyMask(),
      customHost: customHostInput() || undefined,
    });
    if (res.ok) {
      setProxyTls((res.data.proxyTls as Record<string, unknown>) ?? res.data);
      setNote('Proxy/PAC, loopback PID listeners & 9-endpoint TLS waterfall refreshed');
    } else {
      setNote(`Proxy/TLS probe error (${res.error.code}): ${res.error.message}`);
    }
    setBusyProxy(false);
  };

  const handleCustomTlsProbe = async () => {
    const host = customTlsHostInput().trim();
    if (!host) {
      setNote('Enter a hostname (e.g. api.github.com) for TLS inspection');
      return;
    }
    setBusyCustomTls(true);
    const res = await studioV5.probeCustomTlsHost(host, privacyMask());
    if (res.ok) {
      const payload = (res.data.probe ?? res.data.endpoint ?? res.data.tls ?? res.data) as Record<string, unknown>;
      setCustomTlsResult(payload);
      setNote(`TLS inspection complete for ${host}`);
    } else {
      setNote(`Custom TLS probe note (${res.error.code}): ${res.error.message}`);
    }
    setBusyCustomTls(false);
  };

  const handleStartSpeedtest = async (profile: SpeedtestProfile) => {
    if (runningSpeedtest()) return;
    setRunningSpeedtest(true);
    setWaveform([]);
    setLivePhase(`starting (${profile} · ${streamMode()})...`);
    const res = await studioV5.startProSpeedtest({
      profile,
      streamMode: streamMode(),
      privacyMask: privacyMask(),
    });
    if (res.ok) {
      const rid = String(res.data.runId ?? res.data.run_id ?? `st-${Date.now()}`);
      setActiveRunId(rid);
      if (res.data.result && typeof res.data.result === 'object') {
        const resultObj = res.data.result as Record<string, unknown>;
        setSpeedtestResult(resultObj);
        if (Array.isArray(resultObj.waveform)) {
          setWaveform(
            (resultObj.waveform as Array<Record<string, unknown>>).map(normalizeWaveformPoint),
          );
        }
        setRunningSpeedtest(false);
        setLivePhase('complete');
        void loadOverview();
      } else {
        setNote(`Live ${profile} (${streamMode()}) speedtest started (${rid}) — streaming on /ws "network"`);
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

  const handleRunRadar = async () => {
    setBusyRadar(true);
    const res = await studioV5.getGlobalLatencyRadar(privacyMask());
    if (res.ok) {
      const list = res.data.regions ?? res.data.probes ?? [];
      setRadarRegions(Array.isArray(list) ? list : []);
      setRadarProvenance(String(res.data.provenance ?? (list.length > 0 ? 'LIVE' : 'UNAVAILABLE')));
      setNote(`6-Region Global Latency Radar complete (${list.length} regions)`);
    } else {
      setNote(`Global Radar note (${res.error.code}): ${res.error.message}`);
    }
    setBusyRadar(false);
  };

  const handleRunTraceroute = async () => {
    const target = traceTarget().trim();
    if (!target) {
      setNote('Enter a valid IP or hostname for bounded traceroute');
      return;
    }
    setBusyTrace(true);
    const res = await studioV5.runBoundedTraceroute(target, traceMaxHops(), privacyMask());
    if (res.ok) {
      setTraceResult({
        target: String(res.data.target ?? target),
        reached: Boolean(res.data.reached ?? false),
        durationMs: Number(res.data.durationMs ?? res.data.duration_ms ?? 0),
        hops: Array.isArray(res.data.hops) ? res.data.hops : [],
        error: res.data.error ? String(res.data.error) : undefined,
      });
      setNote(`Bounded traceroute to ${target} finished`);
    } else {
      setNote(`Traceroute error (${res.error.code}): ${res.error.message}`);
    }
    setBusyTrace(false);
  };

  const handleToggleMonitor = async (action: 'start' | 'stop') => {
    setBusyMonitor(true);
    const res = await studioV5.setPassiveMonitor(action, {
      intervalMs: 3000,
      privacyMask: privacyMask(),
    });
    if (res.ok) {
      applyMonitorPayload(res.data as Record<string, unknown>);
      setNote(action === 'start' ? 'Passive network monitor started (120-sample ring)' : 'Passive network monitor stopped');
    } else {
      setNote(`Passive monitor note (${res.error.code}): ${res.error.message}`);
    }
    setBusyMonitor(false);
  };

  onMount(() => {
    void loadOverview();
  });

  createEffect(() => {
    props.refreshSeq;
    privacyMask();
    void loadOverview();
  });

  createEffect(() => {
    if (monitorPollTimer) {
      clearInterval(monitorPollTimer);
      monitorPollTimer = null;
    }
    if (monitorRunning()) {
      monitorPollTimer = setInterval(() => {
        void refreshMonitor();
      }, 4000);
    }
  });

  onCleanup(() => {
    if (monitorPollTimer) {
      clearInterval(monitorPollTimer);
      monitorPollTimer = null;
    }
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
      const sample = (p.sample && typeof p.sample === 'object' ? p.sample : {}) as Record<string, unknown>;
      const mbps = Number(p.currentMbps ?? sample.mbps ?? p.mbps ?? p.throughputMbps ?? 0);
      const rttRaw = p.currentRttMs ?? sample.loadedRttMs ?? sample.loaded_rtt_ms ?? p.rttMs;
      const rttMs = rttRaw !== undefined && rttRaw !== null ? Number(rttRaw) : undefined;
      setWaveform((prev) => [
        ...prev.slice(-119),
        {
          tMs: Number(sample.elapsedMs ?? sample.elapsed_ms ?? p.elapsedMs ?? p.tMs ?? p.timestampMs ?? Date.now()),
          phase,
          mbps,
          rttMs,
        },
      ]);
    } else if (ev.event === 'speedtest_complete') {
      setRunningSpeedtest(false);
      setLivePhase('complete');
      const resultObj = (p.result && typeof p.result === 'object' ? p.result : p) as Record<string, unknown>;
      setSpeedtestResult(resultObj);
      if (Array.isArray(resultObj.waveform)) {
        // Fixed Steer #28B bug: map backend `elapsedMs` / `loadedRttMs` before legacy `tMs` / `rttMs`
        setWaveform(
          (resultObj.waveform as Array<Record<string, unknown>>).map(normalizeWaveformPoint),
        );
      }
      void loadOverview();
    }
  });

  const adapters = createMemo(() => {
    const raw = identity()?.adapters;
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  });

  const wifiInfo = createMemo(() => {
    const w = identity()?.wifi;
    return w && typeof w === 'object' ? (w as Record<string, unknown>) : null;
  });

  const stunInfo = createMemo(() => {
    const st = identity()?.stun;
    return st && typeof st === 'object' ? (st as Record<string, unknown>) : null;
  });

  const vpnTags = createMemo(() => {
    const raw = identity()?.vpnTags ?? identity()?.vpn_tags;
    return Array.isArray(raw) ? raw.map(String) : [];
  });

  const resolvers = createMemo(() => {
    const raw = dnsReport()?.resolvers;
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  });

  const nxdomainHijack = createMemo(() => {
    const raw = dnsReport()?.nxdomainHijack ?? dnsReport()?.nxdomain_hijack;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  });

  const envProxies = createMemo(() => {
    const raw = proxyTls()?.envProxies ?? proxyTls()?.env_proxies;
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  });

  const localProxyPorts = createMemo(() => {
    const raw = proxyTls()?.localProxyPorts ?? proxyTls()?.local_proxy_ports;
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  });

  const endpoints = createMemo(() => {
    const raw = proxyTls()?.endpoints;
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  });

  const activeWaveformPoints = createMemo<SpeedtestWaveformPoint[]>(() => {
    const pts = waveform();
    if (pts.length > 0) return pts;
    const resWave = speedtestResult()?.waveform;
    if (Array.isArray(resWave) && resWave.length > 0) {
      return (resWave as Array<Record<string, unknown>>).map(normalizeWaveformPoint);
    }
    return [];
  });

  const waveSvgPoints = createMemo(() => {
    const pts = activeWaveformPoints();
    if (pts.length === 0) return '';
    return sparklinePoints(pts.map((p) => p.mbps), 360, 78, 5);
  });

  const waveRttSvgPoints = createMemo(() => {
    const pts = activeWaveformPoints()
      .map((p) => p.rttMs)
      .filter((v): v is number => v !== undefined && Number.isFinite(v) && v > 0);
    if (pts.length < 2) return '';
    return sparklinePoints(pts, 360, 78, 5);
  });

  const speedMetrics = createMemo(() => {
    const s = speedtestResult() ?? {};
    const unloadedObj = (s.unloaded ?? s.unloadedRtt ?? {}) as Record<string, unknown>;
    const unloaded = Number(s.unloadedP50Ms ?? s.unloaded_p50_ms ?? unloadedObj.p50Ms ?? unloadedObj.p50_ms ?? 0);
    const dlDelta = Number(s.dlBufferbloatDeltaMs ?? s.dl_bufferbloat_delta_ms ?? s.dlBloatMs ?? s.dl_bloat_ms ?? 0);
    const ulDelta = Number(s.ulBufferbloatDeltaMs ?? s.ul_bufferbloat_delta_ms ?? s.ulBloatMs ?? s.ul_bloat_ms ?? 0);
    const multiDl = Number(s.multiStreamDlMbps ?? s.multi_stream_dl_mbps ?? s.downloadMbps ?? s.download_mbps ?? 0);
    const singleDl = Number(s.singleStreamDlMbps ?? s.single_stream_dl_mbps ?? 0);
    const multiUl = Number(s.multiStreamUlMbps ?? s.multi_stream_ul_mbps ?? s.uploadMbps ?? s.upload_mbps ?? 0);
    const singleUl = Number(s.singleStreamUlMbps ?? s.single_stream_ul_mbps ?? 0);
    const dlMbps = Number(s.downloadMbps ?? s.download_mbps ?? multiDl);
    const ulMbps = Number(s.uploadMbps ?? s.upload_mbps ?? multiUl);
    const sustainedDl = s.sustainedDlMbps ?? s.sustained_dl_mbps;
    const sustainedUl = s.sustainedUlMbps ?? s.sustained_ul_mbps;
    const dlCvPct = s.dlCvPct ?? s.dl_cv_pct;
    const ulCvPct = s.ulCvPct ?? s.ul_cv_pct;
    const ipv4Ping = s.ipv4PingMs ?? s.ipv4_ping_ms;
    const ipv6Ping = s.ipv6PingMs ?? s.ipv6_ping_ms;
    const grade = String(s.bufferbloatGrade ?? s.bufferbloat_grade ?? '—');
    const readiness = (s.workloadReadiness ?? s.workload_readiness ?? {}) as Record<string, unknown>;
    return {
      unloaded,
      dlLoaded: unloaded + dlDelta,
      ulLoaded: unloaded + ulDelta,
      dlDelta,
      ulDelta,
      dlMbps,
      ulMbps,
      multiDl,
      singleDl,
      multiUl,
      singleUl,
      sustainedDl: sustainedDl !== undefined && sustainedDl !== null ? Number(sustainedDl) : null,
      sustainedUl: sustainedUl !== undefined && sustainedUl !== null ? Number(sustainedUl) : null,
      dlCvPct: dlCvPct !== undefined && dlCvPct !== null ? Number(dlCvPct) : null,
      ulCvPct: ulCvPct !== undefined && ulCvPct !== null ? Number(ulCvPct) : null,
      ipv4Ping: ipv4Ping !== undefined && ipv4Ping !== null ? Number(ipv4Ping) : null,
      ipv6Ping: ipv6Ping !== undefined && ipv6Ping !== null ? Number(ipv6Ping) : null,
      grade,
      readiness,
    };
  });

  const systemDnsServers = createMemo(() => {
    const raw = dnsReport()?.systemDnsServers ?? dnsReport()?.system_dns_servers;
    return Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  });

  const dnsProvenance = createMemo(() => {
    const d = dnsReport();
    if (!d) return 'UNAVAILABLE';
    if (d.provenance) return String(d.provenance);
    if (resolvers().length > 0 || systemDnsServers().length > 0 || d.observedAtMs) return 'LIVE';
    return 'UNAVAILABLE';
  });

  const proxyProvenance = createMemo(() => {
    const p = proxyTls();
    if (!p) return 'UNAVAILABLE';
    if (p.provenance) return String(p.provenance);
    if (endpoints().length > 0 || p.systemProxy || p.observedAtMs) return 'LIVE';
    return 'UNAVAILABLE';
  });

  const histDiff = createMemo(() => {
    const a = history().find((r) => String(r.runId ?? r.id) === compareA());
    const b = history().find((r) => String(r.runId ?? r.id) === compareB());
    if (!a || !b) return null;
    const dlA = Number(a.downloadMbps ?? a.download_mbps ?? 0);
    const dlB = Number(b.downloadMbps ?? b.download_mbps ?? 0);
    const ulA = Number(a.uploadMbps ?? a.upload_mbps ?? 0);
    const ulB = Number(b.uploadMbps ?? b.upload_mbps ?? 0);
    const rttA = Number(a.unloadedP50Ms ?? a.unloaded_p50_ms ?? (a.unloaded as Record<string, unknown> | undefined)?.p50Ms ?? 0);
    const rttB = Number(b.unloadedP50Ms ?? b.unloaded_p50_ms ?? (b.unloaded as Record<string, unknown> | undefined)?.p50Ms ?? 0);
    const bloatA = Number(a.worstBufferbloatDeltaMs ?? a.dlBufferbloatDeltaMs ?? a.dl_bufferbloat_delta_ms ?? 0);
    const bloatB = Number(b.worstBufferbloatDeltaMs ?? b.dlBufferbloatDeltaMs ?? b.dl_bufferbloat_delta_ms ?? 0);
    return {
      dlDelta: dlA - dlB,
      ulDelta: ulA - ulB,
      rttDelta: rttA - rttB,
      bloatDelta: bloatA - bloatB,
      gradeA: String(a.bufferbloatGrade ?? a.bufferbloat_grade ?? '—'),
      gradeB: String(b.bufferbloatGrade ?? b.bufferbloat_grade ?? '—'),
    };
  });

  const monitorPingSpark = createMemo(() => {
    const vals = monitorSamples()
      .map((s) => Number(s.pingMs ?? s.ping_ms ?? 0))
      .filter((v) => Number.isFinite(v) && v >= 0);
    return vals.length >= 2 ? sparklinePoints(vals, 220, 40, 3) : '';
  });

  const monitorThroughputSpark = createMemo(() => {
    const vals = monitorSamples().map((s) => Number(s.rxBps ?? s.rx_bps ?? 0) + Number(s.txBps ?? s.tx_bps ?? 0));
    return vals.length >= 2 ? sparklinePoints(vals, 220, 40, 3) : '';
  });

  const latestMonitorSample = createMemo(() => {
    const list = monitorSamples();
    return list.length > 0 ? list[list.length - 1] : null;
  });

  return (
    <div data-testid="obs-network-panel" class="space-y-4 min-w-0">
      <Show when={note()}>
        <div class="px-3 py-1.5 rounded border border-[var(--border-accent)] bg-[var(--accent-dim)] text-[11.5px] font-mono-num text-[var(--accent-cyan)]">
          {maskText(note(), privacyMask())}
        </div>
      </Show>

      {/* 1. Identity, IPv4/IPv6, PTR, Network Type, Wi-Fi RF, VPN/Split-Tunnel/CGNAT/STUN & NICs */}
      <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2 font-bold text-[13.5px]">
            <Globe class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
            <span>Network Identity, Wi-Fi RF, VPN/CGNAT, STUN NAT &amp; NICs</span>
            <ProvenancePill state={String(identity()?.provenance ?? 'UNAVAILABLE')} />
            <Show when={identity()?.networkType ?? identity()?.network_type}>
              <span class="omnia-badge font-mono-num text-[10px] text-[var(--accent-amber)]">
                {String(identity()?.networkType ?? identity()?.network_type)}
              </span>
            </Show>
          </div>
          <button type="button" disabled={busyId()} class="omnia-btn text-[11px]" onClick={() => void handleRefreshIdentity()}>
            <RefreshCw class="w-3.5 h-3.5" classList={{ 'animate-spin': busyId() }} />
            <span>Probe Identity</span>
          </button>
        </div>

        {/* Core Identity KPI Strip */}
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 text-[11.5px] font-mono-num">
          <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] min-w-0">
            <div class="text-[10px] text-[var(--ink-muted)] flex items-center justify-between gap-1">
              <span>Public IPv4 / IPv6</span>
              <span
                class="text-[9.5px] font-semibold"
                classList={{
                  'text-[var(--status-emerald)]': Boolean(identity()?.ipv6Reachable ?? identity()?.ipv6_reachable),
                  'text-[var(--ink-muted)]': !Boolean(identity()?.ipv6Reachable ?? identity()?.ipv6_reachable),
                }}
              >
                {identity()?.ipv6Reachable ?? identity()?.ipv6_reachable ? 'IPv6 OK' : 'IPv4-only'}
              </span>
            </div>
            <div class="font-semibold truncate">
              {maskSensitiveField(
                (identity()?.publicIpv4 ?? identity()?.public_ipv4) as string | undefined,
                privacyMask(),
              )}
            </div>
            <Show when={identity()?.publicIpv6 ?? identity()?.public_ipv6}>
              <div class="text-[10px] text-[var(--ink-secondary)] truncate">
                v6: {maskSensitiveField(String(identity()?.publicIpv6 ?? identity()?.public_ipv6), privacyMask())}
              </div>
            </Show>
          </div>

          <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] min-w-0">
            <div class="text-[10px] text-[var(--ink-muted)]">ASN / ISP / Colo &amp; PTR</div>
            <div class="font-semibold truncate">
              {(() => {
                const geo = (identity()?.geo ?? {}) as Record<string, unknown>;
                const txt = [geo.asn, geo.isp, geo.colo ?? geo.city].filter(Boolean).join(' · ');
                return txt ? maskText(txt, privacyMask()) : '—';
              })()}
            </div>
            <div class="text-[10px] text-[var(--ink-secondary)] truncate">
              PTR: {maskText(String(identity()?.ptr ?? identity()?.reverseDnsPtr ?? identity()?.reverse_dns_ptr ?? '—'), privacyMask())}
            </div>
          </div>

          <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] min-w-0">
            <div class="text-[10px] text-[var(--ink-muted)]">VPN / Split-Tunnel / CGNAT</div>
            <div class="font-semibold truncate">
              {identity()?.vpnActive || identity()?.vpn_active ? 'VPN ACTIVE' : 'Direct'} ·{' '}
              {String(identity()?.splitTunnelMode ?? identity()?.split_tunnel_mode ?? 'NONE')}
            </div>
            <div class="text-[10px] text-[var(--ink-secondary)] truncate">
              Class: {String(identity()?.localIpClass ?? identity()?.local_ip_class ?? '—')}
              <Show when={identity()?.warpActive || identity()?.warp_active || identity()?.warpStatus || identity()?.warp_status}>
                {' · '}WARP:{String(identity()?.warpStatus ?? identity()?.warp_status ?? 'ON')}
              </Show>
            </div>
          </div>

          <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] min-w-0">
            <div class="text-[10px] text-[var(--ink-muted)]">RFC 5389 STUN NAT</div>
            <div class="font-semibold truncate">
              {String(
                stunInfo()?.natMappingBehavior ??
                  stunInfo()?.nat_mapping_behavior ??
                  identity()?.natClassification ??
                  identity()?.nat_classification ??
                  'unknown',
              )}
            </div>
            <div class="text-[10px] text-[var(--ink-secondary)] truncate">
              {stunInfo()?.mappedIp ?? stunInfo()?.mapped_ip
                ? `${maskSensitiveField(String(stunInfo()?.mappedIp ?? stunInfo()?.mapped_ip), privacyMask())}:${String(stunInfo()?.mappedPort ?? stunInfo()?.mapped_port ?? '')} (${formatMs(Number(stunInfo()?.rttMs ?? stunInfo()?.rtt_ms ?? 0))})`
                : String(stunInfo()?.server ?? 'Unprobed')}
            </div>
          </div>

          <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] min-w-0">
            <div class="text-[10px] text-[var(--ink-muted)]">SHA-256 Fingerprint</div>
            <div class="font-semibold text-[var(--accent-cyan)] truncate">
              {String(identity()?.fingerprintSha256 ?? identity()?.fingerprint_sha256 ?? '—').slice(0, 16)}
            </div>
            <div class="text-[10px] text-[var(--ink-muted)] truncate">
              NAT: {String(identity()?.natClassification ?? identity()?.nat_classification ?? '—')}
            </div>
          </div>
        </div>

        {/* Dedicated Wi-Fi RF Card + VPN / Split-Tunnel / CGNAT / STUN Detail Card */}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 text-[11px] font-mono-num">
          <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1.5 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="font-semibold text-[var(--ink-primary)] flex items-center gap-1.5">
                <Wifi class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
                <span>Wi-Fi RF Telemetry</span>
              </span>
              <span class="text-[10px] text-[var(--ink-muted)]">
                {wifiInfo() ? String(wifiInfo()?.state ?? 'connected') : 'Wired / No WLAN'}
              </span>
            </div>
            <Show
              when={wifiInfo()}
              fallback={
                <div class="text-[var(--ink-muted)]">
                  Active link is wired Ethernet or WLAN telemetry is unavailable on this host.
                </div>
              }
            >
              {(w) => (
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  <div>
                    <div class="text-[9.5px] text-[var(--ink-muted)]">SSID / BSSID</div>
                    <div class="truncate text-[var(--ink-primary)]">
                      {maskSensitiveField(String(w().ssid ?? ''), privacyMask())}
                    </div>
                    <div class="text-[10px] text-[var(--ink-muted)] truncate">
                      {maskSensitiveField(String(w().bssid ?? '—'), privacyMask())}
                    </div>
                  </div>
                  <div>
                    <div class="text-[9.5px] text-[var(--ink-muted)]">Signal / RSSI</div>
                    <div class="text-[var(--status-emerald)] font-semibold">
                      {String(w().signalPct ?? w().signal_pct ?? '—')}%
                      <Show when={w().rssiDbm ?? w().rssi_dbm}>
                        {' · '}{String(w().rssiDbm ?? w().rssi_dbm)} dBm
                      </Show>
                    </div>
                    <div class="text-[10px] text-[var(--ink-muted)] truncate">
                      RX {String(w().rxMbps ?? w().rx_mbps ?? '—')} / TX {String(w().txMbps ?? w().tx_mbps ?? '—')}M
                    </div>
                  </div>
                  <div>
                    <div class="text-[9.5px] text-[var(--ink-muted)]">PHY / Band / Ch</div>
                    <div class="text-[var(--accent-cyan)] truncate">
                      {String(w().radioPhy ?? w().radio_phy ?? w().phy ?? '—')}
                    </div>
                    <div class="text-[10px] text-[var(--ink-muted)] truncate">
                      {String(w().band ?? '—')} · ch {String(w().channel ?? '—')}
                    </div>
                  </div>
                  <div>
                    <div class="text-[9.5px] text-[var(--ink-muted)]">Auth / Cipher</div>
                    <div class="truncate text-[var(--ink-primary)]">
                      {String(w().authCipher ?? w().auth_cipher ?? w().auth ?? w().authentication ?? '—')}
                    </div>
                    <Show when={w().cipher}>
                      <div class="text-[10px] text-[var(--ink-muted)] truncate">
                        {String(w().cipher)}
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </Show>
          </div>

          <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1.5 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="font-semibold text-[var(--ink-primary)] flex items-center gap-1.5">
                <ShieldCheck class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                <span>VPN Split-Tunnel, CGNAT, WARP &amp; STUN Evidence</span>
              </span>
              <Show when={stunInfo()?.status}>
                <ProvenancePill state={String(stunInfo()?.status)} />
              </Show>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <span class="omnia-badge text-[10px] text-[var(--accent-cyan)]">
                Split: {String(identity()?.splitTunnelMode ?? identity()?.split_tunnel_mode ?? 'NONE')}
              </span>
              <span class="omnia-badge text-[10px] text-[var(--ink-secondary)]">
                IP Class: {String(identity()?.localIpClass ?? identity()?.local_ip_class ?? '—')}
              </span>
              <For each={vpnTags()}>
                {(tag) => <span class="omnia-badge text-[10px] text-[var(--accent-amber)]">{tag}</span>}
              </For>
            </div>
            <div class="text-[10.5px] text-[var(--ink-secondary)] space-y-0.5">
              <Show when={identity()?.splitTunnelReason ?? identity()?.split_tunnel_reason}>
                <div class="truncate">
                  Split reason: {maskText(String(identity()?.splitTunnelReason ?? identity()?.split_tunnel_reason), privacyMask())}
                </div>
              </Show>
              <Show when={identity()?.cgnatEvidence ?? identity()?.cgnat_evidence}>
                <div class="truncate text-[var(--accent-amber)]">
                  CGNAT: {maskText(String(identity()?.cgnatEvidence ?? identity()?.cgnat_evidence), privacyMask())}
                </div>
              </Show>
              <Show when={stunInfo()}>
                {(st) => (
                  <div class="truncate text-[var(--ink-muted)]">
                    STUN: {String(st().server ?? '—')} · attr {String(st().attribute ?? '—')} · RTT{' '}
                    {st().rttMs ?? st().rtt_ms ? formatMs(Number(st().rttMs ?? st().rtt_ms)) : '—'}
                    {st().error ? ` · ${String(st().error)}` : ''}
                  </div>
                )}
              </Show>
            </div>
          </div>
        </div>

        {/* Full Adapters / NICs Inventory with IPv6 Global/Link-Local, Gateways, DNS & Live RX/TX */}
        <Show when={adapters().length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse text-[11px] font-mono-num">
              <thead>
                <tr class="border-b border-[var(--border-subtle)] text-[var(--ink-muted)]">
                  <th class="py-1.5 pr-3">Adapter</th>
                  <th class="py-1.5 pr-3">Status / Kind</th>
                  <th class="py-1.5 pr-3">IPv4 / IPv6 (Global vs Link-Local)</th>
                  <th class="py-1.5 pr-3">Gateways &amp; DNS</th>
                  <th class="py-1.5 pr-3">MAC / MTU</th>
                  <th class="py-1.5 pr-3">Live RX / TX</th>
                  <th class="py-1.5">VPN</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--border-subtle)]">
                <For each={adapters()}>
                  {(nic) => {
                    const v4 = Array.isArray(nic.ipv4Cidrs ?? nic.ipv4_cidrs)
                      ? ((nic.ipv4Cidrs ?? nic.ipv4_cidrs) as unknown[]).map(String)
                      : [];
                    const explicitGlobal = nic.ipv6Global ?? nic.ipv6_global;
                    const explicitLinkLocal = nic.ipv6LinkLocal ?? nic.ipv6_link_local;
                    const fallbackV6 = splitIpv6Cidrs(nic.ipv6Cidrs ?? nic.ipv6_cidrs);
                    const v6 = {
                      global: Array.isArray(explicitGlobal) ? explicitGlobal.map(String) : fallbackV6.global,
                      linkLocal: Array.isArray(explicitLinkLocal) ? explicitLinkLocal.map(String) : fallbackV6.linkLocal,
                    };
                    const gws = Array.isArray(nic.gateways) ? (nic.gateways as unknown[]).map(String) : [];
                    const dnsList = Array.isArray(nic.dnsServers ?? nic.dns_servers)
                      ? ((nic.dnsServers ?? nic.dns_servers) as unknown[]).map(String)
                      : [];
                    const rxBps = nic.rxBps ?? nic.rx_bps;
                    const txBps = nic.txBps ?? nic.tx_bps;
                    return (
                      <tr>
                        <td class="py-1.5 pr-3 font-semibold text-[var(--ink-primary)] whitespace-nowrap">
                          {String(nic.name ?? 'nic')}
                        </td>
                        <td class="py-1.5 pr-3 whitespace-nowrap">
                          {String(nic.status ?? '')} · {String(nic.kind ?? '')}
                        </td>
                        <td class="py-1.5 pr-3 space-y-0.5 max-w-[260px]">
                          <div class="truncate">{v4.length ? maskText(v4.join(', '), privacyMask()) : '—'}</div>
                          <Show when={v6.global.length > 0}>
                            <div class="text-[10px] text-[var(--status-emerald)] truncate">
                              GUA: {maskText(v6.global.join(', '), privacyMask())}
                            </div>
                          </Show>
                          <Show when={v6.linkLocal.length > 0}>
                            <div class="text-[10px] text-[var(--ink-muted)] truncate">
                              LL: {maskText(v6.linkLocal.join(', '), privacyMask())}
                            </div>
                          </Show>
                        </td>
                        <td class="py-1.5 pr-3 space-y-0.5 max-w-[200px]">
                          <div class="truncate text-[var(--ink-secondary)]">
                            GW: {gws.length ? maskText(gws.join(', '), privacyMask()) : '—'}
                          </div>
                          <div class="truncate text-[10px] text-[var(--ink-muted)]">
                            DNS: {dnsList.length ? maskText(dnsList.join(', '), privacyMask()) : '—'}
                          </div>
                        </td>
                        <td class="py-1.5 pr-3 whitespace-nowrap">
                          <div>{maskSensitiveField(String(nic.macAddress ?? nic.mac_address ?? ''), privacyMask())}</div>
                          <div class="text-[10px] text-[var(--ink-muted)]">
                            MTU {String(nic.mtu ?? '—')} · {String(nic.linkSpeedMbps ?? nic.link_speed_mbps ?? '—')}M
                          </div>
                        </td>
                        <td class="py-1.5 pr-3 whitespace-nowrap">
                          <Show
                            when={rxBps !== undefined || txBps !== undefined}
                            fallback={<span class="text-[var(--ink-muted)]">—</span>}
                          >
                            <div class="text-[var(--accent-cyan)]">↓ {formatBps(Number(rxBps ?? 0))}</div>
                            <div class="text-[var(--accent-amber)] text-[10px]">↑ {formatBps(Number(txBps ?? 0))}</div>
                          </Show>
                        </td>
                        <td class="py-1.5 text-[var(--accent-amber)] whitespace-nowrap">
                          {String(nic.vpnTag ?? nic.vpn_tag ?? '—')}
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>

      {/* 2. Pro Speedtest, Pure-SVG Radial Gauges, Multi/Single Stream, Bufferbloat & 5-Workload Readiness */}
      <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2 font-bold text-[13.5px]">
            <Gauge class="w-4 h-4 text-[var(--accent-amber)] shrink-0" />
            <span>Pro Speedtest, Radial Gauges &amp; Bufferbloat Lab</span>
            <ProvenancePill state={String(speedtestResult()?.provenance ?? (runningSpeedtest() ? 'LIVE' : 'UNAVAILABLE'))} />
            <span class="omnia-badge font-mono-num text-[10.5px]">phase: {livePhase()}</span>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <div class="omp-segmented text-[11px]" data-testid="speedtest-stream-toggle">
              <button
                type="button"
                aria-pressed={streamMode() === 'multi'}
                disabled={runningSpeedtest()}
                onClick={() => setStreamMode('multi')}
              >
                Multi-Stream
              </button>
              <button
                type="button"
                aria-pressed={streamMode() === 'single'}
                disabled={runningSpeedtest()}
                onClick={() => setStreamMode('single')}
              >
                Single-Stream
              </button>
            </div>
            <button
              type="button"
              data-testid="speedtest-start-quick"
              disabled={runningSpeedtest()}
              class="omnia-btn omnia-btn-primary text-[11px]"
              onClick={() => void handleStartSpeedtest('quick')}
            >
              <Play class="w-3.5 h-3.5" />
              <span>Quick</span>
            </button>
            <button
              type="button"
              data-testid="speedtest-start-standard"
              disabled={runningSpeedtest()}
              class="omnia-btn text-[11px]"
              onClick={() => void handleStartSpeedtest('standard')}
            >
              <Play class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
              <span>Standard</span>
            </button>
            <button
              type="button"
              data-testid="speedtest-start-exhaustive"
              disabled={runningSpeedtest()}
              class="omnia-btn text-[11px]"
              onClick={() => void handleStartSpeedtest('exhaustive')}
            >
              <Zap class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
              <span>Exhaustive</span>
            </button>
            <Show when={runningSpeedtest()}>
              <button
                type="button"
                data-testid="speedtest-cancel-btn"
                class="omnia-btn omnia-btn-danger text-[11px]"
                onClick={() => void handleCancelSpeedtest()}
              >
                <Square class="w-3.5 h-3.5" />
                <span>Cancel</span>
              </button>
            </Show>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Pure-SVG Radial DL/UL Gauges + Stream & CV Telemetry */}
          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-2.5 min-w-0">
            <div class="grid grid-cols-2 gap-2">
              <RadialSpeedGauge
                label="Download"
                mbps={speedMetrics().dlMbps}
                subLabel={`Multi ${speedMetrics().multiDl.toFixed(1)} · 1x ${speedMetrics().singleDl.toFixed(1)}`}
                accentVar="var(--accent-cyan)"
              />
              <RadialSpeedGauge
                label="Upload"
                mbps={speedMetrics().ulMbps}
                subLabel={`Multi ${speedMetrics().multiUl.toFixed(1)} · 1x ${speedMetrics().singleUl.toFixed(1)}`}
                accentVar="var(--accent-amber)"
              />
            </div>

            <div class="grid grid-cols-2 gap-1.5 text-[10.5px] font-mono-num">
              <div class="p-1.5 rounded bg-[var(--bg-panel)] border border-[var(--border-subtle)]">
                <div class="text-[9.5px] text-[var(--ink-muted)]">Sustained / CV%</div>
                <div class="truncate">
                  DL {speedMetrics().sustainedDl !== null ? `${speedMetrics().sustainedDl!.toFixed(1)}M` : '—'}
                  {speedMetrics().dlCvPct !== null ? ` (${speedMetrics().dlCvPct!.toFixed(1)}%)` : ''}
                </div>
                <div class="truncate text-[var(--ink-secondary)]">
                  UL {speedMetrics().sustainedUl !== null ? `${speedMetrics().sustainedUl!.toFixed(1)}M` : '—'}
                  {speedMetrics().ulCvPct !== null ? ` (${speedMetrics().ulCvPct!.toFixed(1)}%)` : ''}
                </div>
              </div>
              <div class="p-1.5 rounded bg-[var(--bg-panel)] border border-[var(--border-subtle)]">
                <div class="text-[9.5px] text-[var(--ink-muted)]">IPv4 vs IPv6 Ping</div>
                <div class="truncate">v4: {formatMs(speedMetrics().ipv4Ping ?? speedMetrics().unloaded)}</div>
                <div class="truncate text-[var(--ink-secondary)]">
                  v6: {speedMetrics().ipv6Ping !== null ? formatMs(speedMetrics().ipv6Ping) : '—'}
                </div>
              </div>
            </div>

            <div class="space-y-1">
              <div class="flex items-center justify-between text-[10.5px] font-mono-num">
                <span class="text-[var(--ink-muted)]">Live Throughput &amp; Loaded RTT Waveform</span>
                <span class="text-[var(--accent-cyan)]">{activeWaveformPoints().length} pts</span>
              </div>
              <svg viewBox="0 0 360 78" class="w-full h-20 rounded bg-[var(--bg-panel)] border border-[var(--border-subtle)]">
                <line x1="0" y1="39" x2="360" y2="39" stroke="var(--border-subtle)" stroke-dasharray="3 3" />
                <Show
                  when={waveSvgPoints().length > 0}
                  fallback={
                    <text x="180" y="42" text-anchor="middle" fill="var(--ink-muted)" font-size="11">
                      Click Quick, Standard, or Exhaustive (zero auto-run on load)
                    </text>
                  }
                >
                  <Show when={waveRttSvgPoints().length > 0}>
                    <polyline
                      fill="none"
                      stroke="var(--accent-amber)"
                      stroke-width="1.3"
                      stroke-dasharray="3 2"
                      points={waveRttSvgPoints()}
                    />
                  </Show>
                  <polyline fill="none" stroke="var(--accent-cyan)" stroke-width="2.2" points={waveSvgPoints()} />
                </Show>
              </svg>
            </div>
          </div>

          {/* Bufferbloat Grade & Unloaded vs Loaded DL/UL Latency Bars */}
          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-2.5 min-w-0">
            <div class="flex items-center justify-between text-[11.5px]">
              <span class="font-semibold text-[var(--ink-secondary)]">Bufferbloat Grade &amp; Latency</span>
              <span
                class="px-2 py-0.5 rounded font-mono-num font-bold text-[13px] border border-[var(--border-strong)]"
                style={{ color: bufferbloatColorVar(speedMetrics().grade) }}
              >
                Grade {speedMetrics().grade}
              </span>
            </div>
            <div class="space-y-2 text-[11px] font-mono-num">
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

            <Show when={history().length >= 2}>
              <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1.5 text-[10.5px] font-mono-num">
                <div class="text-[var(--ink-muted)] font-semibold">Inline A-vs-B Speedtest History Diff</div>
                <div class="flex gap-1">
                  <select
                    aria-label="Speedtest Run A"
                    value={compareA()}
                    onChange={(e) => setCompareA(e.currentTarget.value)}
                    class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-1.5 py-0.5"
                  >
                    <For each={history()}>
                      {(r) => (
                        <option value={String(r.runId ?? r.id)}>
                          {String(r.runId ?? r.id).slice(0, 10)} ({Number(r.downloadMbps ?? r.download_mbps ?? 0).toFixed(0)}M)
                        </option>
                      )}
                    </For>
                  </select>
                  <span class="self-center text-[var(--ink-muted)]">vs</span>
                  <select
                    aria-label="Speedtest Run B"
                    value={compareB()}
                    onChange={(e) => setCompareB(e.currentTarget.value)}
                    class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-1.5 py-0.5"
                  >
                    <For each={history()}>
                      {(r) => (
                        <option value={String(r.runId ?? r.id)}>
                          {String(r.runId ?? r.id).slice(0, 10)} ({Number(r.downloadMbps ?? r.download_mbps ?? 0).toFixed(0)}M)
                        </option>
                      )}
                    </For>
                  </select>
                </div>
                <Show when={histDiff()}>
                  {(d) => (
                    <div class="grid grid-cols-2 gap-1 text-[var(--accent-cyan)]">
                      <span>ΔDL {d().dlDelta >= 0 ? '+' : ''}{d().dlDelta.toFixed(1)}M</span>
                      <span>ΔUL {d().ulDelta >= 0 ? '+' : ''}{d().ulDelta.toFixed(1)}M</span>
                      <span>ΔRTT {d().rttDelta >= 0 ? '+' : ''}{d().rttDelta.toFixed(0)}ms</span>
                      <span>ΔBloat {d().bloatDelta >= 0 ? '+' : ''}{d().bloatDelta.toFixed(0)}ms ({d().gradeA}/{d().gradeB})</span>
                    </div>
                  )}
                </Show>
              </div>
            </Show>
          </div>

          {/* 5-Workload Readiness Scores */}
          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-2 min-w-0">
            <div class="text-[11.5px] font-semibold text-[var(--ink-secondary)]">5-Workload Readiness</div>
            <div class="space-y-1.5 text-[11px] font-mono-num">
              {[
                { keys: ['coding_ai', 'codingAi', 'ai_sse_streaming', 'aiSseStreaming'], label: 'Coding / AI' },
                { keys: ['streaming_4k', 'streaming4k', 'video_4k'], label: '4K Streaming' },
                { keys: ['video_calls', 'videoCalls', 'webrtc'], label: 'Video Calls' },
                { keys: ['gaming', 'remote_control', 'remoteControl'], label: 'Gaming / Remote' },
                { keys: ['large_sync', 'largeSync', 'git_docker_sync', 'gitDockerSync'], label: 'Large Sync' },
              ].map((w) => {
                const rd = speedMetrics().readiness;
                const rawVal = w.keys.map((k) => rd[k]).find((v) => v !== undefined && v !== null);
                const obj = rawVal && typeof rawVal === 'object' ? (rawVal as Record<string, unknown>) : null;
                const scoreNum = obj ? Number(obj.score ?? 0) : typeof rawVal === 'number' ? rawVal : null;
                const displayVal = obj
                  ? `${String(obj.score ?? '—')} (${String(obj.rating ?? '')})`
                  : rawVal !== undefined && rawVal !== null
                    ? String(rawVal)
                    : '—';
                return (
                  <div class="p-1.5 rounded bg-[var(--bg-panel)] border border-[var(--border-subtle)] flex items-center justify-between gap-2">
                    <span class="text-[var(--ink-muted)] truncate">{w.label}</span>
                    <span
                      class="font-bold shrink-0"
                      classList={{
                        'text-[var(--status-emerald)]': scoreNum === null || scoreNum >= 75,
                        'text-[var(--accent-amber)]': scoreNum !== null && scoreNum >= 45 && scoreNum < 75,
                        'text-[var(--status-coral)]': scoreNum !== null && scoreNum < 45,
                      }}
                    >
                      {displayVal}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 3. 6-Region Global Latency Radar, Bounded 12-Hop Traceroute & Passive Background Monitor */}
      <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* 6-Region Global Latency Radar */}
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 font-bold text-[12.5px]">
              <Globe class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
              <span>6-Region Latency Radar</span>
              <ProvenancePill state={radarProvenance()} />
            </div>
            <button
              type="button"
              data-testid="network-radar-run"
              disabled={busyRadar()}
              class="omnia-btn text-[11px]"
              onClick={() => void handleRunRadar()}
            >
              <RefreshCw class="w-3.5 h-3.5" classList={{ 'animate-spin': busyRadar() }} />
              <span>Scan</span>
            </button>
          </div>
          <Show
            when={radarRegions().length > 0}
            fallback={
              <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11px] font-mono-num text-[var(--ink-muted)]">
                Click <strong>Scan</strong> to measure RTT across US-East, US-West, EU-Central, Asia-SG, Asia-JP &amp; Oceania.
              </div>
            }
          >
            <div class="space-y-1.5 text-[11px] font-mono-num">
              <For each={radarRegions()}>
                {(reg) => {
                  const rtt = Number(reg.rttMs ?? reg.rtt_ms ?? reg.p50Ms ?? reg.p50_ms ?? 0);
                  const pct = Math.min(100, Math.max(4, (rtt / 320) * 100));
                  return (
                    <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1">
                      <div class="flex items-center justify-between gap-2">
                        <span class="font-semibold text-[var(--ink-primary)] truncate">
                          {String(reg.label ?? reg.region ?? reg.id ?? 'region')}
                        </span>
                        <span
                          class="shrink-0"
                          classList={{
                            'text-[var(--status-emerald)]': rtt > 0 && rtt < 80,
                            'text-[var(--accent-amber)]': rtt >= 80 && rtt < 180,
                            'text-[var(--status-coral)]': rtt >= 180 || rtt <= 0,
                          }}
                        >
                          {rtt > 0 ? formatMs(rtt) : String(reg.status ?? 'timeout')}
                        </span>
                      </div>
                      <div class="w-full h-1.5 rounded bg-[var(--bg-panel)] overflow-hidden">
                        <div class="h-full bg-[var(--accent-cyan)]" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>

        {/* Bounded 12-Hop Traceroute */}
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 font-bold text-[12.5px]">
              <Network class="w-4 h-4 text-[var(--accent-amber)] shrink-0" />
              <span>Bounded Traceroute (≤12 Hops)</span>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 text-[11px] font-mono-num">
            <input
              type="text"
              aria-label="Traceroute target host"
              value={traceTarget()}
              onInput={(e) => setTraceTarget(e.currentTarget.value)}
              placeholder="1.1.1.1 or github.com"
              class="flex-1 min-w-[120px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[var(--ink-primary)]"
            />
            <select
              aria-label="Max hops"
              value={String(traceMaxHops())}
              onChange={(e) => setTraceMaxHops(Number(e.currentTarget.value) || 12)}
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-1"
            >
              <option value="6">6 hops</option>
              <option value="8">8 hops</option>
              <option value="12">12 hops</option>
            </select>
            <button
              type="button"
              data-testid="network-traceroute-run"
              disabled={busyTrace()}
              class="omnia-btn text-[11px]"
              onClick={() => void handleRunTraceroute()}
            >
              <Play class="w-3 h-3" />
              <span>Trace</span>
            </button>
          </div>
          <Show
            when={traceResult()}
            fallback={
              <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11px] font-mono-num text-[var(--ink-muted)]">
                Run bounded ICMP traceroute (strict hostname/IP validation, max 12 hops).
              </div>
            }
          >
            {(tr) => (
              <div class="space-y-1.5 text-[10.5px] font-mono-num max-h-56 overflow-y-auto">
                <div class="flex items-center justify-between text-[var(--ink-muted)]">
                  <span>
                    Target: <strong class="text-[var(--ink-primary)]">{maskText(tr().target, privacyMask())}</strong>
                  </span>
                  <span>
                    {tr().reached ? 'REACHED' : 'BOUNDED'} · {formatMs(tr().durationMs)}
                  </span>
                </div>
                <Show when={tr().error}>
                  <div class="text-[var(--status-coral)]">{tr().error}</div>
                </Show>
                <For each={tr().hops}>
                  {(hop) => {
                    const rtt = hop.rttMs ?? hop.rtt_ms;
                    const timedOut = Boolean(hop.timedOut ?? hop.timed_out);
                    return (
                      <div class="px-2 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-2">
                        <span class="truncate">
                          <span class="text-[var(--accent-cyan)] mr-1.5">#{hop.hop}</span>
                          {timedOut ? '*' : maskText(String(hop.ip ?? hop.host ?? hop.raw ?? '*'), privacyMask())}
                        </span>
                        <span class="shrink-0 text-[var(--ink-secondary)]">
                          {timedOut ? 'timeout' : rtt !== undefined && rtt !== null ? formatMs(Number(rtt)) : '—'}
                        </span>
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </Show>
        </div>

        {/* Passive Background Monitor (120-Sample Ring) */}
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 font-bold text-[12.5px]">
              <Activity class="w-4 h-4 text-[var(--status-emerald)] shrink-0" />
              <span>Passive Monitor</span>
              <span
                class="omnia-badge font-mono-num text-[10px]"
                classList={{
                  'text-[var(--status-emerald)]': monitorRunning(),
                  'text-[var(--ink-muted)]': !monitorRunning(),
                }}
              >
                {monitorRunning() ? 'RUNNING' : 'IDLE'}
              </span>
            </div>
            <div class="flex items-center gap-1">
              <Show
                when={!monitorRunning()}
                fallback={
                  <button
                    type="button"
                    data-testid="network-monitor-stop"
                    disabled={busyMonitor()}
                    class="omnia-btn omnia-btn-danger text-[10.5px]"
                    onClick={() => void handleToggleMonitor('stop')}
                  >
                    <Square class="w-3 h-3" />
                    <span>Stop</span>
                  </button>
                }
              >
                <button
                  type="button"
                  data-testid="network-monitor-start"
                  disabled={busyMonitor()}
                  class="omnia-btn text-[10.5px]"
                  onClick={() => void handleToggleMonitor('start')}
                >
                  <Play class="w-3 h-3 text-[var(--status-emerald)]" />
                  <span>Start</span>
                </button>
              </Show>
              <button
                type="button"
                class="omnia-btn text-[10.5px]"
                onClick={() => void refreshMonitor()}
                title="Refresh monitor ring"
              >
                <RefreshCw class="w-3 h-3" />
              </button>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-1.5 text-[10.5px] font-mono-num">
            <div class="p-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
              <div class="text-[9.5px] text-[var(--ink-muted)]">Ping / Jitter</div>
              <div class="font-semibold text-[var(--accent-cyan)] truncate">
                {latestMonitorSample()
                  ? `${formatMs(Number(latestMonitorSample()?.pingMs ?? latestMonitorSample()?.ping_ms ?? 0))} / ${formatMs(Number(latestMonitorSample()?.jitterMs ?? latestMonitorSample()?.jitter_ms ?? 0))}`
                  : '—'}
              </div>
            </div>
            <div class="p-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
              <div class="text-[9.5px] text-[var(--ink-muted)]">Loss %</div>
              <div class="font-semibold text-[var(--ink-primary)]">
                {latestMonitorSample()
                  ? `${Number(latestMonitorSample()?.lossPct ?? latestMonitorSample()?.loss_pct ?? 0).toFixed(1)}%`
                  : '—'}
              </div>
            </div>
            <div class="p-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
              <div class="text-[9.5px] text-[var(--ink-muted)]">Ring Samples</div>
              <div class="font-semibold text-[var(--status-emerald)]">
                {monitorSamples().length}/{monitorCapacity()}
              </div>
            </div>
          </div>

          <div class="space-y-1.5 text-[10px] font-mono-num">
            <div class="flex justify-between text-[var(--ink-muted)]">
              <span>Ping Rolling Sparkline</span>
              <span>
                RX {formatBps(Number(latestMonitorSample()?.rxBps ?? latestMonitorSample()?.rx_bps ?? 0))} · TX{' '}
                {formatBps(Number(latestMonitorSample()?.txBps ?? latestMonitorSample()?.tx_bps ?? 0))}
              </span>
            </div>
            <svg viewBox="0 0 220 40" class="w-full h-10 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
              <Show
                when={monitorPingSpark().length > 0}
                fallback={
                  <text x="110" y="23" text-anchor="middle" fill="var(--ink-muted)" font-size="9.5">
                    Start Passive Monitor to collect rolling ping/throughput
                  </text>
                }
              >
                <polyline fill="none" stroke="var(--accent-cyan)" stroke-width="1.8" points={monitorPingSpark()} />
                <Show when={monitorThroughputSpark().length > 0}>
                  <polyline
                    fill="none"
                    stroke="var(--status-emerald)"
                    stroke-width="1.2"
                    stroke-dasharray="3 2"
                    points={monitorThroughputSpark()}
                  />
                </Show>
              </Show>
            </svg>
          </div>
        </div>
      </div>

      {/* 4. DNS Deep Lab & 5. Proxy / PAC / Loopback PID Listeners / 9-Endpoint Waterfall / Custom TLS */}
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* DNS Deep Lab */}
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2 font-bold text-[13px]">
              <Server class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
              <span>DNS Deep Lab (DoH/DoT, DNSSEC, EDNS0 &amp; Leak)</span>
              <ProvenancePill state={dnsProvenance()} />
            </div>
            <button type="button" disabled={busyDns()} class="omnia-btn text-[11px]" onClick={() => void handleRunDns()}>
              <Activity class="w-3.5 h-3.5" />
              <span>Run DNS Bench</span>
            </button>
          </div>

          {/* Custom DNS IP Input + DoH/DoT OS Audit */}
          <div class="flex flex-wrap items-center gap-2 text-[11px] font-mono-num">
            <input
              type="text"
              aria-label="Custom DNS resolver IP"
              value={customDnsInput()}
              onInput={(e) => setCustomDnsInput(e.currentTarget.value)}
              placeholder="Custom DNS IP (e.g. 208.67.222.222)"
              class="flex-1 min-w-[180px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[var(--ink-primary)]"
            />
            <span class="omnia-badge text-[10px] text-[var(--accent-cyan)]">
              DoH:{' '}
              {String(
                dnsReport()?.dohStatus ??
                  dnsReport()?.doh_status ??
                  (dnsReport()?.dohEnabled ?? dnsReport()?.doh_enabled ? 'ON' : 'OS/Audit'),
              )}
            </span>
            <span class="omnia-badge text-[10px] text-[var(--ink-secondary)]">
              DoT:{' '}
              {String(
                dnsReport()?.dotStatus ??
                  dnsReport()?.dot_status ??
                  (dnsReport()?.dotEnabled ?? dnsReport()?.dot_enabled ? 'ON' : 'OS/Audit'),
              )}
            </span>
          </div>

          <div
            class="px-3 py-2 rounded border text-[11.5px] font-mono-num flex flex-wrap items-center justify-between gap-2"
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

          {/* NXDOMAIN Hijack Warning Badge */}
          <Show when={nxdomainHijack()}>
            {(nx) => {
              const hijacked = Boolean(nx().hijacked);
              return (
                <div
                  class="px-3 py-1.5 rounded border text-[11px] font-mono-num flex flex-wrap items-center justify-between gap-2"
                  classList={{
                    'border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[var(--status-coral)]': hijacked,
                    'border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--status-emerald)]': !hijacked,
                  }}
                >
                  <span class="font-semibold">
                    {hijacked ? 'NXDOMAIN HIJACK DETECTED' : 'NXDOMAIN Integrity Clean'}
                  </span>
                  <span class="text-[10.5px] truncate">
                    {hijacked
                      ? `Resolvers: ${((nx().hijackingResolvers ?? nx().hijacking_resolvers ?? []) as unknown[]).map(String).join(', ')}`
                      : `Probed: ${String(nx().probedDomain ?? nx().probed_domain ?? 'random.invalid')}`}
                  </span>
                </div>
              );
            }}
          </Show>

          <Show when={systemDnsServers().length > 0}>
            <div class="flex flex-wrap items-center gap-1.5 text-[11px] font-mono-num">
              <span class="text-[var(--ink-muted)]">System DNS:</span>
              <For each={systemDnsServers()}>
                {(srv) => <span class="omnia-badge text-[var(--accent-cyan)]">{maskText(srv, privacyMask())}</span>}
              </For>
              <Show when={dnsReport()?.hostsOverrideCount !== undefined}>
                <span class="text-[var(--ink-muted)]">
                  · hosts overrides: {String(dnsReport()?.hostsOverrideCount)}
                </span>
              </Show>
            </div>
          </Show>

          <div class="space-y-1.5 text-[11px] font-mono-num">
            <Show
              when={resolvers().length > 0}
              fallback={
                <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                  Click <strong>Run DNS Bench</strong> to benchmark System, 1.1.1.1, 8.8.8.8, 9.9.9.9, 94.140.14.14, OpenDNS (208.67.222.222) &amp; custom DNS.
                </div>
              }
            >
              <For each={resolvers()}>
                {(r) => {
                  const p50 = Number(r.p50Ms ?? r.p50_ms ?? 0);
                  const p95 = Number(r.p95Ms ?? r.p95_ms ?? 0);
                  const uncached = r.uncachedMs ?? r.uncached_ms;
                  const cached = r.cachedMs ?? r.cached_ms;
                  const dnssecAd = Boolean(r.dnssecAd ?? r.dnssec_ad ?? false);
                  const edns0 = Boolean(r.edns0 ?? r.edns0Supported ?? r.edns0_supported ?? false);
                  const aaaaList = r.aaaaAnswers ?? r.aaaa_answers;
                  const aaaaOk = Boolean(r.aaaaSupported ?? r.aaaa_supported ?? (Array.isArray(aaaaList) && aaaaList.length > 0));
                  const hijacked = Boolean(r.hijackDetected ?? r.hijack_detected ?? false);
                  const widthPct = Math.min(100, Math.max(4, (p50 / 120) * 100));
                  return (
                    <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <span class="font-semibold text-[var(--ink-primary)]">
                          {String(r.name ?? r.server ?? 'resolver')}
                          <span class="text-[10px] text-[var(--ink-muted)] ml-1.5">({String(r.server ?? '')})</span>
                        </span>
                        <span class="text-[var(--ink-muted)]">
                          p50:{formatMs(p50)} · p95:{formatMs(p95)} · jit:{formatMs(Number(r.jitterMs ?? r.jitter_ms ?? 0))} · fail:{Number(r.failureRatePct ?? r.failure_rate_pct ?? 0).toFixed(0)}%
                        </span>
                      </div>
                      <div class="flex flex-wrap items-center gap-1.5 text-[10px]">
                        <Show when={uncached !== undefined || cached !== undefined}>
                          <span class="text-[var(--ink-secondary)]">
                            uncached:{uncached !== undefined && uncached !== null ? formatMs(Number(uncached)) : '—'} · cached:{cached !== undefined && cached !== null ? formatMs(Number(cached)) : '—'}
                          </span>
                        </Show>
                        <Show when={dnssecAd}>
                          <span class="omnia-badge text-[var(--status-emerald)]">DNSSEC AD</span>
                        </Show>
                        <Show when={edns0}>
                          <span class="omnia-badge text-[var(--accent-cyan)]">EDNS0</span>
                        </Show>
                        <Show when={aaaaOk}>
                          <span class="omnia-badge text-[var(--ink-secondary)]">AAAA</span>
                        </Show>
                        <Show when={hijacked}>
                          <span class="omnia-badge text-[var(--status-coral)]">HIJACK</span>
                        </Show>
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

        {/* Proxy, PAC, Loopback PID Listeners, 9-Endpoint Categorized Waterfall & Custom TLS Probe */}
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2 font-bold text-[13px]">
              <Lock class="w-4 h-4 text-[var(--status-emerald)] shrink-0" />
              <span>Proxy, PAC, PID Listeners &amp; 9-Endpoint TLS Waterfall</span>
              <ProvenancePill state={proxyProvenance()} />
            </div>
            <button type="button" disabled={busyProxy()} class="omnia-btn text-[11px]" onClick={() => void handleRefreshProxyTls()}>
              <RefreshCw class="w-3.5 h-3.5" classList={{ 'animate-spin': busyProxy() }} />
              <span>Probe Waterfall</span>
            </button>
          </div>

          {/* Custom Waterfall Host & Custom TLS Probe Inputs */}
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono-num">
            <input
              type="text"
              aria-label="Custom waterfall host"
              value={customHostInput()}
              onInput={(e) => setCustomHostInput(e.currentTarget.value)}
              placeholder="Custom waterfall host (optional)"
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[var(--ink-primary)]"
            />
            <div class="flex gap-1.5">
              <input
                type="text"
                aria-label="Custom TLS probe host"
                value={customTlsHostInput()}
                onInput={(e) => setCustomTlsHostInput(e.currentTarget.value)}
                placeholder="TLS host probe (e.g. api.openai.com)"
                class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[var(--ink-primary)]"
              />
              <button
                type="button"
                data-testid="network-custom-tls-btn"
                disabled={busyCustomTls()}
                class="omnia-btn text-[10.5px] shrink-0"
                onClick={() => void handleCustomTlsProbe()}
              >
                <Lock class="w-3 h-3" />
                <span>TLS</span>
              </button>
            </div>
          </div>

          <Show when={customTlsResult()}>
            {(ct) => (
              <div class="p-2.5 rounded border border-[var(--border-accent)] bg-[var(--bg-canvas)] text-[10.5px] font-mono-num space-y-1">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-semibold text-[var(--accent-cyan)]">
                    Custom TLS: {maskText(String(ct().host ?? customTlsHostInput()), privacyMask())}
                  </span>
                  <span>
                    {String(ct().tlsVersion ?? ct().tls_version ?? 'TLS')} · ALPN:{String(ct().alpn ?? '—')} · Chain:{String(ct().chainDepth ?? ct().chain_depth ?? '—')}
                  </span>
                </div>
                <div class="text-[var(--ink-secondary)] truncate">
                  Issuer: {String(ct().certIssuer ?? ct().cert_issuer ?? '—')}
                  <Show when={ct().rootIssuer ?? ct().root_issuer}>
                    {' · '}Root: {String(ct().rootIssuer ?? ct().root_issuer)}
                  </Show>
                  {' · '}Days left: {String(ct().certDaysRemaining ?? ct().cert_days_remaining ?? '—')}
                </div>
                <Show when={ct().leafSha256 ?? ct().leaf_sha256}>
                  <div class="text-[10px] text-[var(--ink-muted)] truncate">
                    Leaf SHA-256: {String(ct().leafSha256 ?? ct().leaf_sha256)}
                  </div>
                </Show>
              </div>
            )}
          </Show>

          {/* System Proxy / PAC Reachability / Env Proxies / Direct-vs-Proxy Overhead */}
          <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11px] font-mono-num space-y-1.5">
            <div class="flex flex-wrap justify-between gap-2">
              <span class="text-[var(--ink-muted)]">System Proxy / PAC</span>
              <span class="text-[var(--ink-primary)] truncate max-w-[280px]">
                {(() => {
                  const sp = ((proxyTls()?.systemProxy ?? proxyTls()?.system_proxy ?? {}) as Record<string, unknown>);
                  const val =
                    sp.ieProxyServer ??
                    sp.winhttpProxy ??
                    sp.pacUrl ??
                    sp.proxyServer ??
                    sp.proxy_server ??
                    (sp.autoDetect ? 'Auto-Detect (WPAD)' : 'Direct / None');
                  return maskText(String(val), privacyMask());
                })()}
              </span>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2 text-[10.5px]">
              <span class="text-[var(--ink-muted)]">
                PAC Probe:{' '}
                {proxyTls()?.pacReachable !== undefined || proxyTls()?.pac_reachable !== undefined
                  ? `${proxyTls()?.pacReachable ?? proxyTls()?.pac_reachable ? 'REACHABLE' : 'UNREACHABLE'} (${String(proxyTls()?.pacBytes ?? proxyTls()?.pac_bytes ?? 0)} B)`
                  : 'None'}
              </span>
              <span class="text-[var(--accent-amber)]">
                Proxy Overhead:{' '}
                {proxyTls()?.proxyOverheadMs !== undefined || proxyTls()?.proxy_overhead_ms !== undefined
                  ? formatMs(Number(proxyTls()?.proxyOverheadMs ?? proxyTls()?.proxy_overhead_ms))
                  : '—'}
              </span>
            </div>
            <Show when={envProxies().length > 0}>
              <div class="flex flex-wrap gap-1">
                <For each={envProxies()}>
                  {(ep) => (
                    <span class="omnia-badge text-[10px] text-[var(--accent-cyan)]">
                      {String(ep.name ?? 'ENV')}: {maskText(String(ep.valueMasked ?? ep.value_masked ?? ''), privacyMask())}
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <div class="flex justify-between text-[10.5px]">
              <span class="text-[var(--ink-muted)]">Waterfall Legend</span>
              <span class="space-x-2">
                <span class="text-[var(--accent-cyan)]">■ DNS</span>
                <span class="text-[var(--accent-amber)]">■ TCP</span>
                <span class="text-[var(--status-emerald)]">■ TLS</span>
                <span class="text-[var(--ink-secondary)]">■ TTFB</span>
              </span>
            </div>
          </div>

          {/* Loopback PID Proxy Listeners */}
          <Show when={localProxyPorts().length > 0}>
            <div class="overflow-x-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
              <table class="w-full text-left border-collapse text-[10.5px] font-mono-num">
                <thead>
                  <tr class="border-b border-[var(--border-subtle)] text-[var(--ink-muted)]">
                    <th class="py-1 px-2">Port</th>
                    <th class="py-1 px-2">PID / Process</th>
                    <th class="py-1 px-2">Tool</th>
                    <th class="py-1 px-2">Risk</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-[var(--border-subtle)]">
                  <For each={localProxyPorts().filter((p) => p.listening !== false)}>
                    {(lp) => (
                      <tr>
                        <td class="py-1 px-2 text-[var(--accent-cyan)] font-semibold">:{String(lp.port ?? '')}</td>
                        <td class="py-1 px-2 truncate">
                          {String(lp.processName ?? lp.process_name ?? lp.label ?? 'listener')}
                          {lp.pid ? ` (${String(lp.pid)})` : ''}
                        </td>
                        <td class="py-1 px-2 text-[var(--ink-secondary)]">
                          {String(lp.suspectedTool ?? lp.suspected_tool ?? lp.label ?? '—')}
                        </td>
                        <td class="py-1 px-2">
                          <span
                            class="omnia-badge text-[9.5px]"
                            classList={{
                              'text-[var(--status-coral)]': String(lp.risk ?? '').toLowerCase() === 'high',
                              'text-[var(--accent-amber)]': String(lp.risk ?? '').toLowerCase() === 'medium',
                              'text-[var(--status-emerald)]': !['high', 'medium'].includes(String(lp.risk ?? '').toLowerCase()),
                            }}
                          >
                            {String(lp.risk ?? 'low').toUpperCase()}
                          </span>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>

          {/* 9-Endpoint Categorized Waterfall */}
          <div class="space-y-2 text-[11px] font-mono-num">
            <Show
              when={endpoints().length > 0}
              fallback={
                <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                  Click <strong>Probe Waterfall</strong> to inspect Cloudflare, GitHub, npm, crates.io, PyPI, HuggingFace, Google APIs, OpenAI &amp; Anthropic.
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
                  const httpVer = String(ep.httpVersion ?? ep.http_version ?? '');
                  const resolvedIp = ep.resolvedIp ?? ep.resolved_ip;
                  const issuer = ep.certIssuer ?? ep.cert_issuer;
                  const rootIssuer = ep.rootIssuer ?? ep.root_issuer;
                  const daysLeft = ep.certDaysRemaining ?? ep.cert_days_remaining;
                  const alpn = ep.alpn;
                  const chainDepth = ep.chainDepth ?? ep.chain_depth;
                  const leafSha = ep.leafSha256 ?? ep.leaf_sha256;
                  return (
                    <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1">
                      <div class="flex flex-wrap items-center justify-between gap-1.5">
                        <span class="font-semibold text-[var(--ink-primary)] truncate flex items-center gap-1.5">
                          <span class="omnia-badge text-[9px] text-[var(--accent-cyan)]">
                            {inferEndpointCategory(ep)}
                          </span>
                          <span>{maskText(String(ep.label ?? ep.host ?? ep.url ?? 'endpoint'), privacyMask())}</span>
                        </span>
                        <span class="text-[var(--ink-muted)] shrink-0">
                          HTTP {String(ep.httpStatus ?? ep.http_status ?? '—')}
                          {httpVer ? ` (${httpVer})` : ''} · {formatMs(tot)} ·{' '}
                          {String(ep.tlsVersion ?? ep.tls_version ?? 'TLS')}
                        </span>
                      </div>
                      <div class="w-full h-2 rounded overflow-hidden flex bg-[var(--bg-panel)]">
                        <div style={{ width: `${(dns / tot) * 100}%`, 'background-color': 'var(--accent-cyan)' }} title={`DNS ${dns}ms`} />
                        <div style={{ width: `${(tcp / tot) * 100}%`, 'background-color': 'var(--accent-amber)' }} title={`TCP ${tcp}ms`} />
                        <div style={{ width: `${(tls / tot) * 100}%`, 'background-color': 'var(--status-emerald)' }} title={`TLS ${tls}ms`} />
                        <div style={{ width: `${(ttfb / tot) * 100}%`, 'background-color': 'var(--ink-secondary)' }} title={`TTFB ${ttfb}ms`} />
                      </div>
                      <div class="flex flex-wrap items-center justify-between gap-1 text-[10px] text-[var(--ink-muted)]">
                        <span class="truncate">
                          {resolvedIp ? `IP ${maskSensitiveField(String(resolvedIp), privacyMask())}` : ''}
                          {alpn ? ` · ALPN ${String(alpn)}` : ''}
                          {chainDepth !== undefined && chainDepth !== null ? ` · chain:${String(chainDepth)}` : ''}
                        </span>
                        <span class="truncate">
                          {issuer ? `${String(issuer)}` : ''}
                          {rootIssuer && String(rootIssuer) !== String(issuer ?? '') ? ` -> ${String(rootIssuer)}` : ''}
                          {daysLeft !== undefined && daysLeft !== null ? ` (${String(daysLeft)}d)` : ''}
                        </span>
                      </div>
                      <Show when={leafSha}>
                        <div class="text-[9.5px] text-[var(--ink-muted)] truncate">
                          Leaf SHA-256: {String(leafSha).slice(0, 32)}
                        </div>
                      </Show>
                      <Show when={ep.mitmCaSuspected || ep.mitm_ca_suspected}>
                        <div class="text-[10.5px] text-[var(--status-coral)]">
                          MITM / Custom Root CA suspected{ep.mitmCaReason ?? ep.mitm_ca_reason ? `: ${String(ep.mitmCaReason ?? ep.mitm_ca_reason)}` : ''}
                        </div>
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
