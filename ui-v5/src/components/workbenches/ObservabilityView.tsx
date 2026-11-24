import { For, Show, createSignal, onMount } from 'solid-js';
import {
  Activity,
  AlertTriangle,
  Cpu,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Trophy,
} from 'lucide-solid';
import { api } from '@/api/client';

export function ObservabilityView(props: { initialTab?: 'router' | 'stats' | 'credentials' | 'benchmarks' }) {
  const [subTab, setSubTab] = createSignal<'router' | 'stats' | 'credentials' | 'benchmarks'>(props.initialTab ?? 'router');

  // Router Lab state
  const [taskClass, setTaskClass] = createSignal('coding');
  const [tokensEst, setTokensEst] = createSignal(12000);
  const [privacyBoundary, setPrivacyBoundary] = createSignal('standard');
  const [streaming, setStreaming] = createSignal(true);
  const [routerState, setRouterState] = createSignal<Record<string, unknown> | null>(null);
  const [routeDecision, setRouteDecision] = createSignal<Record<string, unknown> | null>(null);

  // omp-stats & traces
  const [spotlight, setSpotlight] = createSignal<Record<string, unknown> | null>(null);
  const [traces, setTraces] = createSignal<Record<string, unknown> | null>(null);

  // Credentials (CredMan - masked only)
  const [credentials, setCredentials] = createSignal<Array<{ target: string; kind: string; label: string; masked_hint: string }>>([]);
  const [credTarget, setCredTarget] = createSignal('');
  const [credKind, setCredKind] = createSignal('api_key');
  const [credLabel, setCredLabel] = createSignal('');
  const [credValue, setCredValue] = createSignal('');

  // Benchmarks Scoreboard
  const [benchmarks, setBenchmarks] = createSignal<Record<string, unknown> | null>(null);

  const loadAll = async () => {
    const [rRes, sRes, tRes, cRes, bRes] = await Promise.all([
      api.getRouterState(),
      api.getSpotlightStats(),
      api.getTraces(),
      api.listCredentials(),
      api.getBenchmarks(),
    ]);
    if (rRes.ok) setRouterState(rRes.data);
    if (sRes.ok) setSpotlight(sRes.data);
    if (tRes.ok) setTraces(tRes.data);
    if (cRes.ok && Array.isArray(cRes.data.credentials)) setCredentials(cRes.data.credentials);
    if (bRes.ok) setBenchmarks(bRes.data);
  };

  onMount(() => {
    void loadAll();
  });

  const handleDecide = async (tripProvider?: string, resetProvider?: string) => {
    const res = await api.decideRoute({
      task_class: taskClass(),
      token_estimate: tokensEst(),
      privacy_boundary: privacyBoundary(),
      streaming: streaming(),
      trip_provider: tripProvider,
      reset_provider: resetProvider,
    });
    if (res.ok) {
      setRouteDecision(res.data);
      const st = await api.getRouterState();
      if (st.ok) setRouterState(st.data);
    }
  };

  const handleSaveCred = async () => {
    if (!credTarget().trim() || !credValue().trim()) return;
    await api.saveCredential(credTarget().trim(), credKind(), credLabel().trim() || credTarget().trim(), credValue());
    setCredValue('');
    const cRes = await api.listCredentials();
    if (cRes.ok && Array.isArray(cRes.data.credentials)) setCredentials(cRes.data.credentials);
  };

  return (
    <div data-testid="observability-workbench" class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
      {/* Sub-Tabs */}
      <div class="px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex items-center justify-between gap-2">
        <div class="omp-segmented text-[12px]">
          <button type="button" aria-pressed={subTab() === 'router'} onClick={() => setSubTab('router')}>
            Router & Quota Lab
          </button>
          <button type="button" aria-pressed={subTab() === 'stats'} onClick={() => setSubTab('stats')}>
            omp-stats Spotlight & Traces
          </button>
          <button type="button" aria-pressed={subTab() === 'credentials'} onClick={() => setSubTab('credentials')}>
            CredMan Vault
          </button>
          <button type="button" aria-pressed={subTab() === 'benchmarks'} onClick={() => setSubTab('benchmarks')}>
            Benchmark Scoreboard
          </button>
        </div>
        <button type="button" class="omnia-btn text-[11px]" onClick={() => void loadAll()}>
          <RefreshCw class="w-3.5 h-3.5" />
          <span>Refresh</span>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-4">
        {/* Router Lab */}
        <Show when={subTab() === 'router'}>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
              <div class="font-bold text-[13.5px] flex items-center gap-2">
                <Cpu class="w-4 h-4 text-[var(--accent-cyan)]" />
                <span>Deterministic Router Decision & Circuit Breakers</span>
              </div>

              <div class="grid grid-cols-2 gap-2.5 text-[12px]">
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

              <div class="flex items-center justify-between">
                <label class="flex items-center gap-2 text-[12px] cursor-pointer">
                  <input type="checkbox" checked={streaming()} onChange={(e) => setStreaming(e.currentTarget.checked)} />
                  <span>Require SSE Streaming</span>
                </label>
                <button type="button" class="omnia-btn omnia-btn-primary text-[12px]" onClick={() => void handleDecide()}>
                  Compute Route
                </button>
              </div>

              <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
                <div class="text-[11px] font-semibold uppercase text-[var(--ink-muted)]">Provider Circuit Breakers & Quota Honesty</div>
                <For each={(routerState()?.candidates as Array<Record<string, unknown>>) ?? []}>
                  {(c) => {
                    const cand = (c.candidate && typeof c.candidate === 'object' ? c.candidate : c) as Record<string, unknown>;
                    const qState = String(c.quota_state ?? c.quotaState ?? 'Unknown');
                    const prov = String(c.providerId ?? c.provider ?? cand.provider_id ?? cand.provider ?? 'provider');
                    const model = String(c.modelId ?? c.model ?? cand.model_id ?? cand.model ?? '');
                    const candId = String(c.candidateId ?? c.id ?? cand.candidate_id ?? prov);
                    const circ = String(c.circuit ?? 'Closed');
                    return (
                      <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between text-[12px]">
                        <div>
                          <div class="font-semibold">{prov} / {model || candId}</div>
                          <div class="text-[11px] font-mono-num flex items-center gap-2">
                            <span
                              classList={{
                                'text-[var(--status-emerald)]': qState === 'Known',
                                'text-[var(--accent-amber)]': qState === 'Stale',
                                'text-[var(--status-coral)]': qState === 'Unknown',
                              }}
                            >
                              Quota: {qState}
                            </span>
                            <span class="text-[var(--ink-muted)]">Circuit: {circ}</span>
                            <span class="text-[var(--ink-muted)]">p95: {String(c.p95_ms ?? c.p95Ms ?? '—')}ms</span>
                          </div>
                        </div>
                        <div class="flex gap-1">
                          <button type="button" class="omnia-btn omnia-btn-danger px-2 py-0.5 text-[10.5px]" onClick={() => void handleDecide(candId)}>
                            <ShieldAlert class="w-3 h-3" />
                            <span>Trip</span>
                          </button>
                          <button type="button" class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={() => void handleDecide(undefined, candId)}>
                            Reset
                          </button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13.5px]">Secret-Redacted RouteDecisionReceipt</div>
              <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-[420px] overflow-auto whitespace-pre-wrap">
                {JSON.stringify(routeDecision() ?? routerState() ?? { notice: 'Press Compute Route to inspect live CandidateScoreBreakdown.' }, null, 2)}
              </pre>
            </div>
          </div>
        </Show>

        {/* omp-stats Spotlight & Traces */}
        <Show when={subTab() === 'stats'}>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13.5px] flex items-center gap-2">
                <Activity class="w-4 h-4 text-[var(--accent-cyan)]" />
                <span>omp-stats Spotlight & KV-Cache Telemetry</span>
              </div>
              <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-[440px] overflow-auto">
                {JSON.stringify(spotlight() ?? { status: 'No live spotlight telemetry yet' }, null, 2)}
              </pre>
            </div>
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13.5px]">Recent Wire & SSE Traces</div>
              <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-[440px] overflow-auto">
                {JSON.stringify(traces() ?? { status: 'No traces recorded' }, null, 2)}
              </pre>
            </div>
          </div>
        </Show>

        {/* CredMan (Masked Secret Hints Only) */}
        <Show when={subTab() === 'credentials'}>
          <div class="max-w-3xl space-y-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
              <div class="flex items-center gap-2 font-bold text-[13.5px]">
                <KeyRound class="w-4 h-4 text-[var(--accent-amber)]" />
                <span>Windows Credential Manager (`omnia:*` — Masked Hints Only, Zero Plaintext Exposure)</span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-4 gap-2 text-[12px]">
                <input type="text" placeholder="Target (e.g. htmustc)" value={credTarget()} onInput={(e) => setCredTarget(e.currentTarget.value)} class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5" />
                <input type="text" placeholder="Label" value={credLabel()} onInput={(e) => setCredLabel(e.currentTarget.value)} class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5" />
                <input type="password" placeholder="Secret value..." value={credValue()} onInput={(e) => setCredValue(e.currentTarget.value)} class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5" />
                <button type="button" class="omnia-btn omnia-btn-primary justify-center" onClick={() => void handleSaveCred()}>
                  <Plus class="w-3.5 h-3.5" />
                  <span>Save Credential</span>
                </button>
              </div>
              <div class="space-y-1.5 pt-2">
                <For each={credentials()}>
                  {(c) => (
                    <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between text-[12px] font-mono-num">
                      <div>
                        <span class="font-bold text-[var(--accent-cyan)]">{c.target}</span> · <span>{c.label}</span> · <span class="text-[var(--ink-muted)]">{c.masked_hint}</span>
                      </div>
                      <button
                        type="button"
                        class="omnia-btn omnia-btn-danger px-2 py-0.5 text-[11px]"
                        onClick={async () => {
                          await api.deleteCredential(c.target);
                          const cRes = await api.listCredentials();
                          if (cRes.ok && Array.isArray(cRes.data.credentials)) setCredentials(cRes.data.credentials);
                        }}
                      >
                        <Trash2 class="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>

        {/* Benchmark Scoreboard */}
        <Show when={subTab() === 'benchmarks'}>
          <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 font-bold text-[13.5px]">
                <Trophy class="w-4 h-4 text-[var(--accent-amber)]" />
                <span>Omnia vs Competitors Coding-Agent Benchmark Scoreboard</span>
              </div>
              <span class="omnia-badge text-[var(--status-emerald)]">Live Scoreboard Feed</span>
            </div>
            <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-[500px] overflow-auto">
              {JSON.stringify(benchmarks() ?? { notice: 'No benchmark runs recorded in D:\\OmniaData\\qa\\ yet.' }, null, 2)}
            </pre>
          </div>
        </Show>
      </div>
    </div>
  );
}
