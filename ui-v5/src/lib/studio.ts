import { type ApiError, api } from '@/api/client';

export type StudioApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export const STUDIO_DEFAULT_ORIGIN = 'http://127.0.0.1:8787';

export function resolveStudioOrigin(): string {
  if (
    typeof window !== 'undefined' &&
    window.location?.origin &&
    /^https?:\/\//i.test(window.location.origin)
  ) {
    return window.location.origin.replace(/\/$/, '');
  }
  return STUDIO_DEFAULT_ORIGIN;
}

function buildQuery(
  path: string,
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      qs.set(key, String(value));
    }
  }
  const encoded = qs.toString();
  if (!encoded) return path;
  return path.includes('?') ? `${path}&${encoded}` : `${path}?${encoded}`;
}

// ============================================================================
// Steer #27B — Super Engine & Auto-Proceed Types (`/api/v5/super/*`)
// ============================================================================

export type AutoProceedPolicyMode = 'off' | 'standard' | 'full';
export type SuperWorkflowMode = 'idle' | 'super_plan' | 'super_run' | string;

export interface SuperStatusResponse {
  ok?: boolean;
  mode?: SuperWorkflowMode;
  phase?: string;
  autoProceed?: AutoProceedPolicyMode | string;
  auto_proceed?: AutoProceedPolicyMode | string;
  goalPersistence?: boolean;
  goal_persistence?: boolean;
  auditStreak?: number;
  audit_streak?: number;
  tokenBudget?: null | number;
  token_budget?: null | number;
  activeGoal?: string | null;
  active_goal?: string | null;
  activeRunId?: string | null;
  steers?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface SuperCapabilitiesResponse {
  ok?: boolean;
  crates?: number;
  agentTools?: number | Array<Record<string, unknown>>;
  computerTools?: number | Array<Record<string, unknown>>;
  skills?: Record<string, unknown>;
  mcpServers?: Array<Record<string, unknown>>;
  plugins?: Array<Record<string, unknown>>;
  workflows?: string[];
  lanes?: string[];
  [key: string]: unknown;
}

export interface SuperPlanRequest {
  prompt?: string;
  goal?: string;
  cwd?: string;
  dispatch?: boolean;
}

export interface SuperRunRequest {
  prompt?: string;
  goal?: string;
  cwd?: string;
  steer?: string;
  dispatch?: boolean;
}

export interface SuperAuditRecordRequest {
  reviewer: string;
  round?: number;
  commitSha?: string;
  treeSha?: string;
  findingsCount?: number;
  passed?: boolean;
  notes?: string;
}

// ============================================================================
// Steer #27B — Native Computer Use Types (`/api/v5/computer/*`)
// ============================================================================

export interface ComputerStatusResponse {
  ok?: boolean;
  available?: boolean;
  policy?: string;
  unrestrictedDefault?: boolean;
  killSwitchEngaged?: boolean;
  dpiAware?: boolean;
  uiaReady?: boolean;
  ocrReady?: boolean;
  toolCount?: number;
  tools?: Array<string | Record<string, unknown>>;
  [key: string]: unknown;
}

// ============================================================================
// Steer #28B — Pro Network Lab Types (`/api/v5/network/*`)
// ============================================================================

export type SpeedtestProfile = 'quick' | 'standard' | 'exhaustive';
export type SpeedtestStreamMode = 'multi' | 'single';

export interface GlobalRadarRegion {
  id?: string;
  region?: string;
  label?: string;
  host?: string;
  endpoint?: string;
  rttMs?: number | null;
  rtt_ms?: number | null;
  p50Ms?: number | null;
  p50_ms?: number | null;
  status?: string;
  httpStatus?: number | null;
  error?: string | null;
}

export interface GlobalRadarResponse {
  ok?: boolean;
  provenance?: string;
  observedAtMs?: number;
  observed_at_ms?: number;
  regions?: GlobalRadarRegion[];
  probes?: GlobalRadarRegion[];
  [key: string]: unknown;
}

export interface TracerouteHop {
  hop: number;
  ip?: string | null;
  host?: string | null;
  rttMs?: number | null;
  rtt_ms?: number | null;
  rttsMs?: Array<number | null>;
  rtts_ms?: Array<number | null>;
  timedOut?: boolean;
  timed_out?: boolean;
  raw?: string;
}

export interface TracerouteResponse {
  ok?: boolean;
  target?: string;
  maxHops?: number;
  max_hops?: number;
  reached?: boolean;
  hops?: TracerouteHop[];
  durationMs?: number;
  duration_ms?: number;
  error?: string | null;
  [key: string]: unknown;
}

export interface PassiveMonitorSample {
  timestampMs?: number;
  timestamp_ms?: number;
  pingMs?: number | null;
  ping_ms?: number | null;
  jitterMs?: number | null;
  jitter_ms?: number | null;
  lossPct?: number;
  loss_pct?: number;
  rxBps?: number;
  rx_bps?: number;
  txBps?: number;
  tx_bps?: number;
}

export interface PassiveMonitorResponse {
  ok?: boolean;
  running?: boolean;
  active?: boolean;
  intervalMs?: number;
  interval_ms?: number;
  target?: string;
  capacity?: number;
  sampleCount?: number;
  sample_count?: number;
  samples?: PassiveMonitorSample[];
  [key: string]: unknown;
}

// ============================================================================
// Steer #28B — Observatory Analytics & Smart Alerts (`/api/v5/alerts/*`)
// ============================================================================

export interface ContextEtaSnapshot {
  tokensPerTurn?: number;
  tokens_per_turn?: number;
  tokensPerMin?: number;
  tokens_per_min?: number;
  estSecsTo200k?: number | null;
  est_secs_to_200k?: number | null;
  warnThreshold?: number;
  warn_threshold?: number;
  hardCap?: number;
  hard_cap?: number;
  currentTokens?: number;
  current_tokens?: number;
  fillPct?: number;
  fill_pct?: number;
  compactionEtaTurns?: number | null;
  compaction_eta_turns?: number | null;
}

export interface TrendBucket {
  label?: string;
  tsMs?: number;
  ts_ms?: number;
  tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  cost_usd?: number;
  requests?: number;
  errors?: number;
}

export interface McpToolTelemetryRow {
  tool?: string;
  toolName?: string;
  name?: string;
  server?: string;
  calls?: number;
  count?: number;
  avgLatencyMs?: number;
  avg_latency_ms?: number;
  p95LatencyMs?: number;
  p95_latency_ms?: number;
  tokensSaved?: number;
  tokens_saved?: number;
  costSavedUsd?: number;
  cost_saved_usd?: number;
  errorCount?: number;
  error_count?: number;
  errorRate?: number;
  error_rate?: number;
}

export interface AlertThresholdRules {
  ttftP95WarnMs?: number;
  ttft_p95_warn_ms?: number;
  cacheHitMinPct?: number;
  cache_hit_min_pct?: number;
  bufferbloatWarnMs?: number;
  bufferbloat_warn_ms?: number;
  contextWarnPct?: number;
  context_warn_pct?: number;
  diskFreeWarnPct?: number;
  disk_free_warn_pct?: number;
  errorRateWarnPct?: number;
  error_rate_warn_pct?: number;
  [key: string]: unknown;
}

export interface ObservatorySummaryResponse {
  ok?: boolean;
  activityHeatmap7x24?: number[][];
  activity_heatmap_7x24?: number[][];
  trends24h?: TrendBucket[];
  trends_24h?: TrendBucket[];
  trends30d?: TrendBucket[];
  trends_30d?: TrendBucket[];
  contextEta?: ContextEtaSnapshot;
  context_eta?: ContextEtaSnapshot;
  mcpToolTelemetry?: McpToolTelemetryRow[];
  mcp_tool_telemetry?: McpToolTelemetryRow[];
  alerts?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

// ============================================================================
// Typed Studio v5 Client Wrapper
// ============================================================================

export class StudioV5Client {
  // --- Super Engine (/api/v5/super/*) ---
  getSuperStatus(): Promise<StudioApiResult<SuperStatusResponse>> {
    return api.safeJson<SuperStatusResponse>('/api/v5/super/status');
  }

  getSuperCapabilities(): Promise<StudioApiResult<SuperCapabilitiesResponse>> {
    return api.safeJson<SuperCapabilitiesResponse>('/api/v5/super/capabilities');
  }

  startSuperPlan(req: SuperPlanRequest = {}): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/super/plan', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  startSuperRun(req: SuperRunRequest = {}): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/super/run', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  cancelSuperRun(req: { runId?: string; reason?: string } = {}): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/super/cancel', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  getSuperProceed(): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/super/proceed');
  }

  setSuperProceed(
    policy: AutoProceedPolicyMode,
    reason?: string,
  ): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/super/proceed', {
      method: 'POST',
      body: JSON.stringify({ policy, mode: policy, reason }),
    });
  }

  recordSuperAudit(req: SuperAuditRecordRequest): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/super/record-audit', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  completeSuperRun(
    req: { runId?: string; summary?: string } = {},
  ): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/super/complete', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  // --- Computer Use (/api/v5/computer/*) ---
  getComputerStatus(): Promise<StudioApiResult<ComputerStatusResponse>> {
    return api.safeJson<ComputerStatusResponse>('/api/v5/computer/status');
  }

  dispatchComputerTool(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/computer/dispatch', {
      method: 'POST',
      body: JSON.stringify({ tool, arguments: args }),
    });
  }

  // --- Pro Network Lab (/api/v5/network/*) ---
  async getNetworkSnapshot(
    opts: {
      privacyMask?: boolean;
      customDns?: string;
      customHost?: string;
      force?: boolean;
    } = {},
  ): Promise<StudioApiResult<Record<string, unknown>>> {
    const query = {
      privacy_mask: opts.privacyMask,
      customDns: opts.customDns?.trim() || undefined,
      customHost: opts.customHost?.trim() || undefined,
      force: opts.force || undefined,
    };
    const snap = await api.safeJson<Record<string, unknown>>(
      buildQuery('/api/v5/network/snapshot', query),
    );
    if (snap.ok) return snap;
    return api.safeJson<Record<string, unknown>>(buildQuery('/api/v5/network/overview', query));
  }

  runDnsBenchmark(
    opts: {
      privacyMask?: boolean;
      customDns?: string;
      queryDomain?: string;
    } = {},
  ): Promise<StudioApiResult<Record<string, unknown>>> {
    const customDns = opts.customDns?.trim() || undefined;
    const queryDomain = opts.queryDomain?.trim() || undefined;
    return api.safeJson<Record<string, unknown>>(
      buildQuery('/api/v5/network/dns/benchmark', {
        privacy_mask: opts.privacyMask,
        customDns,
        queryDomain,
      }),
      {
        method: 'POST',
        body: JSON.stringify({
          privacy_mask: Boolean(opts.privacyMask),
          customDns,
          custom_dns_ip: customDns,
          queryDomain,
          query_domain: queryDomain,
        }),
      },
    );
  }

  probeProxyTls(
    opts: {
      force?: boolean;
      privacyMask?: boolean;
      customHost?: string;
    } = {},
  ): Promise<StudioApiResult<Record<string, unknown>>> {
    const customHost = opts.customHost?.trim() || undefined;
    return api.safeJson<Record<string, unknown>>(
      buildQuery('/api/v5/network/proxy-tls', {
        force: opts.force,
        privacy_mask: opts.privacyMask,
        customHost,
      }),
      {
        method: 'POST',
        body: JSON.stringify({
          force: Boolean(opts.force),
          privacy_mask: Boolean(opts.privacyMask),
          customHost,
          custom_host: customHost,
        }),
      },
    );
  }

  probeCustomTlsHost(
    host: string,
    privacyMask = false,
  ): Promise<StudioApiResult<Record<string, unknown>>> {
    const clean = host.trim();
    return api.safeJson<Record<string, unknown>>(
      buildQuery('/api/v5/network/tls-probe', { privacy_mask: privacyMask }),
      {
        method: 'POST',
        body: JSON.stringify({ host: clean, target: clean, privacy_mask: privacyMask }),
      },
    );
  }

  async startProSpeedtest(opts: {
    profile: SpeedtestProfile;
    streamMode?: SpeedtestStreamMode;
    privacyMask?: boolean;
  }): Promise<StudioApiResult<Record<string, unknown>>> {
    const streamMode = opts.streamMode ?? 'multi';
    const path = buildQuery('/api/v5/network/speedtest/start', {
      profile: opts.profile,
      streamMode,
      privacy_mask: opts.privacyMask,
    });
    const res = await api.safeJson<Record<string, unknown>>(path, {
      method: 'POST',
      body: JSON.stringify({
        profile: opts.profile,
        streamMode,
        stream_mode: streamMode,
        privacy_mask: Boolean(opts.privacyMask),
      }),
    });
    if (res.ok || res.error.status !== 404) return res;
    return api.safeJson<Record<string, unknown>>(
      buildQuery('/api/v5/network/speedtest', {
        profile: opts.profile,
        streamMode,
        privacy_mask: opts.privacyMask,
      }),
      {
        method: 'POST',
        body: JSON.stringify({
          profile: opts.profile,
          streamMode,
          stream_mode: streamMode,
        }),
      },
    );
  }

  getGlobalLatencyRadar(privacyMask = false): Promise<StudioApiResult<GlobalRadarResponse>> {
    return api.safeJson<GlobalRadarResponse>(
      buildQuery('/api/v5/network/radar', { privacy_mask: privacyMask }),
    );
  }

  runBoundedTraceroute(
    target: string,
    maxHops = 12,
    privacyMask = false,
  ): Promise<StudioApiResult<TracerouteResponse>> {
    const clampedHops = Math.max(1, Math.min(12, Math.round(maxHops)));
    const cleanTarget = target.trim();
    return api.safeJson<TracerouteResponse>(
      buildQuery('/api/v5/network/traceroute', { privacy_mask: privacyMask }),
      {
        method: 'POST',
        body: JSON.stringify({
          target: cleanTarget,
          host: cleanTarget,
          maxHops: clampedHops,
          max_hops: clampedHops,
          privacy_mask: privacyMask,
        }),
      },
    );
  }

  getPassiveMonitor(privacyMask = false): Promise<StudioApiResult<PassiveMonitorResponse>> {
    return api.safeJson<PassiveMonitorResponse>(
      buildQuery('/api/v5/network/monitor', { privacy_mask: privacyMask }),
    );
  }

  setPassiveMonitor(
    action: 'start' | 'stop' | 'reset',
    opts: { intervalMs?: number; target?: string; privacyMask?: boolean } = {},
  ): Promise<StudioApiResult<PassiveMonitorResponse>> {
    return api.safeJson<PassiveMonitorResponse>(
      buildQuery('/api/v5/network/monitor', { privacy_mask: opts.privacyMask }),
      {
        method: 'POST',
        body: JSON.stringify({
          action,
          enabled: action === 'start',
          intervalMs: opts.intervalMs,
          interval_ms: opts.intervalMs,
          target: opts.target?.trim() || undefined,
        }),
      },
    );
  }

  // --- Observatory Summary & Smart Alerts (/api/v5/observatory/summary, /api/v5/alerts/*) ---
  getObservatorySummary(
    opts: { window?: string; privacyMask?: boolean } = {},
  ): Promise<StudioApiResult<ObservatorySummaryResponse>> {
    return api.safeJson<ObservatorySummaryResponse>(
      buildQuery('/api/v5/observatory/summary', {
        window: opts.window ?? '24h',
        privacy_mask: opts.privacyMask,
      }),
    );
  }

  listSmartAlerts(privacyMask = false): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>(
      buildQuery('/api/v5/alerts', { privacy_mask: privacyMask }),
    );
  }

  ackSmartAlert(alertId: string, acked = true): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/alerts/ack', {
      method: 'POST',
      body: JSON.stringify({
        alertId,
        alert_id: alertId,
        id: alertId,
        acked,
        acknowledged: acked,
      }),
    });
  }

  getAlertRules(): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/alerts/rules');
  }

  saveAlertRules(rules: AlertThresholdRules): Promise<StudioApiResult<Record<string, unknown>>> {
    return api.safeJson<Record<string, unknown>>('/api/v5/alerts/rules', {
      method: 'POST',
      body: JSON.stringify({ rules, ...rules }),
    });
  }
}

export const studioV5 = new StudioV5Client();
