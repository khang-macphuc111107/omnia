import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import { CheckCircle2, Cpu, Download, Flame, GitPullRequest, ShieldAlert, ShieldCheck, XCircle } from 'lucide-solid';
import { api } from '@/api/client';
import { flashNotice, openObservabilityTab, privacyMask } from '@/state/studio';
import { downloadTextFile, maskJson } from '@/utils/privacy';

interface RouterCapabilityBadge {
  id: string;
  enabled: boolean;
  endpoint: string;
  remediation: string;
}

interface ScoreSegments {
  capability: number;
  privacy: number;
  quota: number;
  latency: number;
  reliability: number;
}

function extractSegments(c: Record<string, unknown>, wf?: Record<string, unknown>): ScoreSegments {
  const wfSegs = wf?.segments && typeof wf.segments === 'object' ? (wf.segments as Record<string, unknown>) : null;
  const b = (wfSegs ?? c.segments ?? c.breakdown ?? c.scoreBreakdown ?? c.score_breakdown ?? {}) as Record<string, unknown>;
  const cap = Number(b.capability ?? b.capabilityScore ?? c.capabilityScore ?? 20);
  const priv = Number(b.privacy ?? b.privacyScore ?? c.privacyScore ?? 20);
  const quota = Number(b.quota ?? b.quotaScore ?? c.quotaScore ?? 20);
  const lat = Number(b.latency ?? b.latencyScore ?? c.latencyScore ?? 20);
  const rel = Number(b.reliability ?? b.reliabilityScore ?? c.reliabilityScore ?? 20);
  const sum = Math.max(1, cap + priv + quota + lat + rel);
  return {
    capability: (cap / sum) * 100,
    privacy: (priv / sum) * 100,
    quota: (quota / sum) * 100,
    latency: (lat / sum) * 100,
    reliability: (rel / sum) * 100,
  };
}

export function RouterLabPanel(props: { refreshSeq: number }) {
  const [taskClass, setTaskClass] = createSignal('coding');
  const [tokensEst, setTokensEst] = createSignal(12000);
  const [privacyBoundary, setPrivacyBoundary] = createSignal('standard');
  const [streaming, setStreaming] = createSignal(true);
  const [routerState, setRouterState] = createSignal<Record<string, unknown> | null>(null);
  const [routeDecision, setRouteDecision] = createSignal<Record<string, unknown> | null>(null);
  const [statusMsg, setStatusMsg] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [routerCaps, setRouterCaps] = createSignal<RouterCapabilityBadge[]>([]);
  const [capProbeMeta, setCapProbeMeta] = createSignal<{
    transportOk: boolean;
    healthOk: boolean;
    checkedAt: string;
    rttMs: number | null;
  }>({ transportOk: false, healthOk: false, checkedAt: '', rttMs: null });

  const loadCapabilitiesSummary = async () => {
    const t0 = performance.now();
    const checkedAt = new Date().toISOString();
    const [capRes, healthRes] = await Promise.all([
      fetch('/api/capabilities')
        .then(async (r) => ({ ok: r.ok, data: (await r.json().catch(() => ({}))) as Record<string, unknown> }))
        .catch(() => ({ ok: false, data: {} as Record<string, unknown> })),
      api.getHealth(),
    ]);
    const rttMs = Math.round(performance.now() - t0);
    const focusIds = new Set(['routing', 'runtime_proxy', 'observatory_v5', 'steer', 'connector_gateway']);
    const list = Array.isArray(capRes.data.capabilities)
      ? (capRes.data.capabilities as Array<Record<string, unknown>>)
      : [];
    const filtered: RouterCapabilityBadge[] = list
      .filter((c) => focusIds.has(String(c.id ?? '')))
      .map((c) => {
        const id = String(c.id ?? 'capability');
        const enabled = Boolean(c.enabled ?? false);
        return {
          id,
          enabled,
          endpoint: String(c.endpoint ?? '—'),
          remediation: enabled
            ? 'Ready'
            : id === 'runtime_proxy'
              ? 'Launch omnia-runtime.exe or pass --runtime-url'
              : `Check ${id} service configuration`,
        };
      });
    setRouterCaps(filtered);
    setCapProbeMeta({
      transportOk: capRes.ok,
      healthOk: healthRes.ok && Boolean(healthRes.data.ok ?? true),
      checkedAt,
      rttMs,
    });
  };

  const loadState = async () => {
    const [res] = await Promise.all([api.getRouterState(privacyMask()), loadCapabilitiesSummary()]);
    if (res.ok) {
      setRouterState(res.data);
      setStatusMsg('');
    } else {
      setStatusMsg(`Router state error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleCancelReservation = async () => {
    setBusy(true);
    const dec = routeDecision();
    const reservationId = dec?.reservationId ?? dec?.reservation_id ?? dec?.requestId ?? dec?.request_id;
    const fencingToken = dec?.fencingToken ?? dec?.fencing_token;
    const body: Record<string, unknown> = reservationId
      ? {
          reservationId: String(reservationId),
          ...(fencingToken !== undefined ? { fencingToken } : {}),
          note: 'router_lab_manual_cancel',
        }
      : {
          cancelAllActive: true,
          note: 'router_lab_manual_cancel',
        };
    try {
      const res = await fetch('/api/router/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        setRouteDecision(data);
        const count = Number(data.cancelledCount ?? (data.cancelled ? 1 : 0));
        setStatusMsg(`Router cancel complete (${count} reservation(s) released)`);
        await loadState();
      } else {
        setStatusMsg(`Cancel reservation note (HTTP ${res.status}): ${String(data.message ?? res.statusText)}`);
      }
    } catch (err) {
      setStatusMsg(`Cancel reservation unreachable: ${err instanceof Error ? err.message : 'network error'}`);
    }
    setBusy(false);
  };

  onMount(() => {
    void loadState();
  });

  createEffect(() => {
    props.refreshSeq;
    privacyMask();
    void loadState();
  });

  const handleDecide = async () => {
    setBusy(true);
    const res = await api.decideRoute({
      task_class: taskClass(),
      token_estimate: tokensEst(),
      privacy_boundary: privacyBoundary(),
      streaming: streaming(),
      simulate: true,
    });
    if (res.ok) {
      setRouteDecision(res.data);
      setStatusMsg('Computed deterministic RouteDecisionReceipt');
      await loadState();
    } else {
      setStatusMsg(`Route error (${res.error.code}): ${res.error.message}`);
    }
    setBusy(false);
  };

  const handleTrip = async (candId: string) => {
    setBusy(true);
    const res = await api.tripRouterCandidate(candId);
    if (res.ok) {
      setRouteDecision(res.data);
      setStatusMsg(`Circuit tripped for ${candId} (persisted in SQLite)`);
      await loadState();
    } else {
      setStatusMsg(`Trip failed (${res.error.code}): ${res.error.message}`);
    }
    setBusy(false);
  };

  const handleReset = async (candId: string) => {
    setBusy(true);
    const res = await api.resetRouterCandidate(candId);
    if (res.ok) {
      setRouteDecision(res.data);
      setStatusMsg(`Circuit reset for ${candId}`);
      await loadState();
    } else {
      setStatusMsg(`Reset failed (${res.error.code}): ${res.error.message}`);
    }
    setBusy(false);
  };

  const candidates = createMemo(() => {
    const raw = (routeDecision()?.rankedCandidates ??
      routeDecision()?.candidates ??
      routerState()?.candidates ??
      []) as Array<Record<string, unknown>>;
    return Array.isArray(raw) ? raw : [];
  });

  const failoverTimeline = createMemo(() => {
    const raw = (routeDecision()?.failoverTimeline ??
      routerState()?.failoverTimeline ??
      routerState()?.failovers ??
      []) as Array<Record<string, unknown>>;
    return Array.isArray(raw) ? raw : [];
  });

  const waterfallByCandidate = createMemo(() => {
    const raw = (routeDecision()?.scoreWaterfalls ??
      routerState()?.scoreWaterfalls ??
      []) as Array<Record<string, unknown>>;
    const map = new Map<string, Record<string, unknown>>();
    if (Array.isArray(raw)) {
      for (const wf of raw) {
        const cid = String(wf.candidateId ?? wf.candidate_id ?? '');
        if (cid) map.set(cid, wf);
      }
    }
    return map;
  });

  const burnRate = createMemo(() => {
    const raw = (routerState()?.burnRate ?? routeDecision()?.burnRate ?? {}) as Record<string, unknown>;
    const candList = candidates();
    const totalTokPerHour = candList.reduce(
      (acc, c) => acc + Number(c.burnRateTokensPerHour ?? c.burn_rate_tokens_per_hour ?? 0),
      0,
    );
    const derivedTokPerMin = totalTokPerHour / 60;
    const finiteRunways = candList
      .map((c) => c.runwayHours ?? c.runway_hours)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const minRunway = finiteRunways.length > 0 ? Math.min(...finiteRunways) : null;
    return {
      usdPerHour: Number(raw.usdPerHour ?? raw.usd_per_hour ?? 0),
      tokensPerMin: Number(raw.tokensPerMin ?? raw.tokens_per_min ?? derivedTokPerMin),
      tokensPerHour: totalTokPerHour,
      runwayHours: raw.runwayHours ?? raw.runway_hours ?? minRunway,
    };
  });

  const redactedReceipt = createMemo(() =>
    maskJson(
      routeDecision() ?? routerState() ?? { notice: 'Press Compute Route to inspect live CandidateScoreBreakdown.' },
      privacyMask(),
    ),
  );

  const handleDownloadReceipt = () => {
    const filename = `omnia-route-receipt-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    downloadTextFile(filename, JSON.stringify(redactedReceipt(), null, 2));
    flashNotice(`Downloaded ${filename} (redacted, mask=${privacyMask() ? 'ON' : 'OFF'})`);
  };

  return (
    <div data-testid="obs-router-panel" class="space-y-4">
      {/* AUD-25 Router & Provider Capability Readiness Strip */}
      <div
        data-testid="router-capability-readiness"
        class="omnia-surface-panel rounded-lg p-3 flex flex-wrap items-center justify-between gap-2 text-[11.5px] font-mono-num"
      >
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <ShieldCheck class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
          <span class="font-semibold text-[var(--ink-primary)]">Capability Readiness (AUD-25)</span>
          <span
            class="omnia-badge"
            classList={{
              'text-[var(--status-emerald)]': capProbeMeta().transportOk,
              'text-[var(--status-coral)]': !capProbeMeta().transportOk,
            }}
          >
            Transport: {capProbeMeta().transportOk ? `OK (${capProbeMeta().rttMs ?? 0}ms)` : 'UNREACHABLE'}
          </span>
          <span
            class="omnia-badge"
            classList={{
              'text-[var(--status-emerald)]': capProbeMeta().healthOk,
              'text-[var(--accent-amber)]': !capProbeMeta().healthOk,
            }}
          >
            Health: {capProbeMeta().healthOk ? 'ONLINE' : 'DEGRADED'}
          </span>
          <For each={routerCaps()}>
            {(cap) => (
              <span
                title={`${cap.endpoint} — ${cap.remediation}`}
                class="omnia-badge"
                classList={{
                  'text-[var(--status-emerald)]': cap.enabled,
                  'text-[var(--accent-amber)]': !cap.enabled,
                }}
              >
                <Show when={cap.enabled} fallback={<XCircle class="w-3 h-3" />}>
                  <CheckCircle2 class="w-3 h-3" />
                </Show>
                <span>{cap.id}</span>
              </span>
            )}
          </For>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <Show when={capProbeMeta().checkedAt}>
            <span class="text-[10.5px] text-[var(--ink-muted)]">{capProbeMeta().checkedAt.slice(11, 19)} UTC</span>
          </Show>
          <button
            type="button"
            class="omnia-btn !px-2 !py-0.5 text-[10.5px]"
            onClick={() => openObservabilityTab('system')}
          >
            Full Matrix
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Simulator & Circuit Breakers + 5-Segment Score Waterfalls */}
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div class="font-bold text-[13.5px] flex items-center gap-2">
              <Cpu class="w-4 h-4 text-[var(--accent-cyan)]" />
              <span>Deterministic Router, 5-Segment Waterfalls & SQLite Breakers</span>
            </div>
            <Show when={statusMsg()}>
              <span class="text-[11px] font-mono-num text-[var(--accent-cyan)] truncate max-w-[220px]">
                {statusMsg()}
              </span>
            </Show>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-[12px]">
            <label class="space-y-1">
              <span class="text-[var(--ink-muted)]">Task Class</span>
              <select
                value={taskClass()}
                onChange={(e) => setTaskClass(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5"
              >
                <option value="coding">Coding / Rust</option>
                <option value="reasoning">Deep Reasoning</option>
                <option value="vision">Multimodal Vision</option>
                <option value="fast">Fast Triage</option>
              </select>
            </label>
            <label class="space-y-1">
              <span class="text-[var(--ink-muted)]">Privacy Boundary</span>
              <select
                value={privacyBoundary()}
                onChange={(e) => setPrivacyBoundary(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5"
              >
                <option value="standard">Standard</option>
                <option value="strict_local">Strict Local Only</option>
                <option value="enterprise_redacted">Enterprise Redacted</option>
              </select>
            </label>
          </div>

          <label class="block text-[12px] space-y-1">
            <div class="flex justify-between">
              <span class="text-[var(--ink-muted)]">Estimated Context Tokens</span>
              <span class="font-mono-num">{tokensEst().toLocaleString()}</span>
            </div>
            <input
              type="range"
              min="1000"
              max="200000"
              step="1000"
              value={tokensEst()}
              onInput={(e) => setTokensEst(Number(e.currentTarget.value))}
              class="w-full accent-[var(--accent-cyan)]"
            />
          </label>

          <div class="flex flex-wrap items-center justify-between gap-2">
            <label class="flex items-center gap-2 text-[12px] cursor-pointer">
              <input
                type="checkbox"
                checked={streaming()}
                onChange={(e) => setStreaming(e.currentTarget.checked)}
              />
              <span>Require SSE Streaming</span>
            </label>
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="router-cancel-reservation-btn"
                disabled={busy()}
                class="omnia-btn omnia-btn-danger text-[11.5px]"
                onClick={() => void handleCancelReservation()}
              >
                Cancel Reservation
              </button>
              <button
                type="button"
                disabled={busy()}
                class="omnia-btn omnia-btn-primary text-[12px]"
                onClick={() => void handleDecide()}
              >
                Compute Route
              </button>
            </div>
          </div>

          {/* Legend for 5-Segment Score Waterfalls */}
          <div class="pt-2 border-t border-[var(--border-subtle)] space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-mono-num">
              <span class="font-semibold uppercase text-[var(--ink-muted)]">Candidates & 5-Segment Score Waterfalls</span>
              <div class="flex items-center gap-2 text-[10px]">
                <span class="text-[var(--accent-cyan)]">■ Cap</span>
                <span class="text-[var(--status-emerald)]">■ Priv</span>
                <span class="text-[var(--accent-amber)]">■ Quota</span>
                <span class="text-[var(--ink-secondary)]">■ Lat</span>
                <span class="text-[var(--status-coral)]">■ Rel</span>
              </div>
            </div>

            <For each={candidates()}>
              {(c) => {
                const cand = (c.candidate && typeof c.candidate === 'object' ? c.candidate : c) as Record<string, unknown>;
                const qState = String(c.quota_state ?? c.quotaState ?? 'Unknown');
                const prov = String(c.providerId ?? c.provider ?? cand.provider_id ?? cand.provider ?? 'provider');
                const model = String(c.modelId ?? c.model ?? cand.model_id ?? cand.model ?? '');
                const candId = String(c.candidateId ?? c.id ?? cand.candidate_id ?? prov);
                const wf = waterfallByCandidate().get(candId);
                const circ = String(c.circuit ?? (c.circuitOpen ? 'Open' : 'Closed'));
                const totalScore = Number(wf?.totalScore ?? c.totalScore ?? c.total_score ?? c.score ?? 0);
                const segs = extractSegments(c, wf);
                const candBurnHr = Number(c.burnRateTokensPerHour ?? c.burn_rate_tokens_per_hour ?? 0);
                const candRunway = c.runwayHours ?? c.runway_hours;

                return (
                  <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-2 text-[12px]">
                    <div class="flex items-center justify-between gap-2">
                      <div class="min-w-0">
                        <div class="font-semibold truncate">
                          {prov} / {model || candId}{' '}
                          <span class="font-mono-num text-[11px] text-[var(--accent-cyan)]">
                            ({totalScore.toFixed(1)})
                          </span>
                        </div>
                        <div class="text-[11px] font-mono-num flex flex-wrap items-center gap-2">
                          <span
                            classList={{
                              'text-[var(--status-emerald)]': qState === 'Known',
                              'text-[var(--accent-amber)]': qState === 'Stale',
                              'text-[var(--status-coral)]': qState === 'Unknown' || qState === 'Contradictory',
                            }}
                          >
                            Quota: {qState}
                          </span>
                          <span
                            classList={{
                              'text-[var(--status-coral)] font-semibold': circ.toLowerCase() === 'open',
                              'text-[var(--ink-muted)]': circ.toLowerCase() !== 'open',
                            }}
                          >
                            Circuit: {circ}
                          </span>
                          <span class="text-[var(--ink-muted)]">p95: {String(c.p95_ms ?? c.p95Ms ?? '—')}ms</span>
                          <Show when={candBurnHr > 0}>
                            <span class="text-[var(--accent-amber)]">{candBurnHr.toLocaleString()} tok/hr</span>
                          </Show>
                          <Show when={candRunway !== undefined && candRunway !== null}>
                            <span class="text-[var(--status-emerald)]">runway: {String(candRunway)}h</span>
                          </Show>
                        </div>
                      </div>
                      <div class="flex gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={busy()}
                          class="omnia-btn omnia-btn-danger px-2 py-0.5 text-[10.5px]"
                          onClick={() => void handleTrip(candId)}
                        >
                          <ShieldAlert class="w-3 h-3" />
                          <span>Trip</span>
                        </button>
                        <button
                          type="button"
                          disabled={busy()}
                          class="omnia-btn px-2 py-0.5 text-[10.5px]"
                          onClick={() => void handleReset(candId)}
                        >
                          Reset
                        </button>
                      </div>
                    </div>

                    {/* 5-Segment Proportional Score Waterfall Bar */}
                    <div class="w-full h-2 rounded overflow-hidden flex bg-[var(--bg-panel)] border border-[var(--border-subtle)]">
                      <div style={{ width: `${segs.capability}%`, 'background-color': 'var(--accent-cyan)' }} title="Capability" />
                      <div style={{ width: `${segs.privacy}%`, 'background-color': 'var(--status-emerald)' }} title="Privacy" />
                      <div style={{ width: `${segs.quota}%`, 'background-color': 'var(--accent-amber)' }} title="Quota" />
                      <div style={{ width: `${segs.latency}%`, 'background-color': 'var(--ink-secondary)' }} title="Latency" />
                      <div style={{ width: `${segs.reliability}%`, 'background-color': 'var(--status-coral)' }} title="Reliability" />
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>

        {/* Right Column: Burn-Rate / Runway, Failover Timeline & Downloadable Redacted Receipt */}
        <div class="space-y-4">
          <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
            <div class="font-bold text-[13px] flex items-center gap-2">
              <Flame class="w-4 h-4 text-[var(--accent-amber)]" />
              <span>Burn-Rate & Quota Runway Projections</span>
            </div>
            <div class="grid grid-cols-3 gap-2 font-mono-num text-[12px]">
              <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                <div class="text-[10px] text-[var(--ink-muted)]">Burn Rate</div>
                <div class="font-bold text-[var(--ink-primary)]">${burnRate().usdPerHour.toFixed(4)}/hr</div>
              </div>
              <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                <div class="text-[10px] text-[var(--ink-muted)]">Token Rate</div>
                <div class="font-bold text-[var(--accent-cyan)]">{burnRate().tokensPerMin.toFixed(0)} tok/m</div>
              </div>
              <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                <div class="text-[10px] text-[var(--ink-muted)]">Est. Runway</div>
                <div class="font-bold text-[var(--status-emerald)]">
                  {burnRate().runwayHours !== null ? `${String(burnRate().runwayHours)}h` : 'Unbounded'}
                </div>
              </div>
            </div>
          </div>

          <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
            <div class="font-bold text-[13px] flex items-center gap-2">
              <GitPullRequest class="w-4 h-4 text-[var(--accent-cyan)]" />
              <span>Failover Timeline ({failoverTimeline().length})</span>
            </div>
            <Show
              when={failoverTimeline().length > 0}
              fallback={
                <div class="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11.5px] font-mono-num text-[var(--ink-muted)]">
                  No circuit failovers triggered yet. Trip a provider circuit above to observe deterministic fallback transitions.
                </div>
              }
            >
              <div class="space-y-1.5 max-h-36 overflow-y-auto text-[11.5px] font-mono-num">
                <For each={failoverTimeline()}>
                  {(ev) => (
                    <div class="px-2.5 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-2">
                      <span class="text-[var(--accent-amber)]">{String(ev.from ?? ev.candidateId ?? 'candidate')}</span>
                      <span class="text-[var(--ink-muted)]">{String(ev.reason ?? ev.event ?? 'transition')}</span>
                      <span class="text-[var(--status-emerald)]">{String(ev.to ?? ev.state ?? '')}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
            <div class="flex items-center justify-between gap-2">
              <div class="font-bold text-[13px]">Secret-Redacted RouteDecisionReceipt</div>
              <button
                type="button"
                data-testid="download-route-receipt"
                class="omnia-btn text-[11px]"
                onClick={handleDownloadReceipt}
              >
                <Download class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
                <span>Download JSON</span>
              </button>
            </div>
            <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-[290px] overflow-auto whitespace-pre-wrap">
              {JSON.stringify(redactedReceipt(), null, 2)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
