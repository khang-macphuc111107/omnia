import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  AlertTriangle,
  Award,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  Code2,
  Columns2,
  Copy,
  Download,
  Edit3,
  FileCode2,
  GitCompare,
  Layers,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Scale,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Trophy,
  Wand2,
  X,
} from 'lucide-solid';
import { ArtifactCanvasDrawer, type CanvasArtifact } from '@/components/chat/ArtifactCanvasDrawer';
import {
  DEFAULT_MODEL_CATALOG,
  flashNotice,
  modelCatalog,
  privacyMask,
  updateDualModelConfig,
} from '@/state/studio';
import type { EffortLevel } from '@/types';
import { handleRichMarkdownClick, renderRichMarkdown } from '@/utils/markdown';
import { downloadTextFile, maskText } from '@/utils/privacy';
import { formatCost6, formatMs } from '@/utils/stats';

type InspectorTab = 'params' | 'schema' | 'personas' | 'code';
type CodeSnippetLang = 'curl' | 'python-httpx' | 'python-openai' | 'typescript' | 'rust';
type PersonaFocusMode = 'solo' | 'web' | 'academic' | 'code' | 'rag' | 'deep' | 'arena';

interface SchemaValidationInfo {
  provided: boolean;
  valid: boolean;
  error?: string;
}

interface ArenaModelOutput {
  model: string;
  providerId: string;
  wireApi: string;
  status: string;
  ok: boolean;
  text: string;
  thinkingText?: string;
  error?: string;
  ttftMs: number | null;
  totalMs: number | null;
  tokensPerSecond: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  schemaValidation?: SchemaValidationInfo;
}

interface LeaderboardEntry {
  modelId: string;
  elo: number;
  wins: number;
  losses: number;
  ties: number;
  matches: number;
  winRatePct: number;
  avgTtftMs: number | null;
  avgTps: number | null;
  avgCostUsd: number | null;
}

interface StudioPersona {
  id: string;
  name: string;
  icon: string;
  description: string;
  modelId: string;
  effort: EffortLevel;
  temperature: number;
  topP: number;
  systemPrompt: string;
  focusMode: PersonaFocusMode;
  pinnedFiles: string[];
  createdAtMs?: number;
  updatedAtMs?: number;
}

interface ModelCostEstimate {
  modelId: string;
  providerId: string;
  configured: boolean;
  inputPerM: number;
  outputPerM: number;
  estimatedInputCostUsd: number;
  estimatedOutputCostUsd: number;
  estimatedTotalUsd: number;
  contextWindow: number;
  contextFillPct: number;
}

interface StudioEstimateSnapshot {
  source: 'live' | 'local';
  inputTokens: number;
  systemTokens: number;
  promptTokens: number;
  estimatedOutputTokens: number;
  perModel: ModelCostEstimate[];
  totalEstimatedUsd: number;
  schemaCheck: SchemaValidationInfo;
}

interface LexicalDiffToken {
  text: string;
  kind: 'same' | 'a-only' | 'b-only';
}

interface ArenaInterruptedReceipt {
  runId: string;
  cancelledAtIso: string;
  elapsedMs: number;
  models: string[];
  arenaCancelStatus: string;
  routerCancelStatus: string;
  detail: string;
}

function resolveStudioOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin && /^https?:\/\//i.test(window.location.origin)) {
    return window.location.origin.replace(/\/$/, '');
  }
  return 'http://127.0.0.1:4242';
}

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const FOCUS_MODES: PersonaFocusMode[] = ['solo', 'web', 'academic', 'code', 'rag', 'deep', 'arena'];
const PERSONA_ICONS = ['GEM', 'ARC', 'SEC', 'RES', 'DEV', 'SYN', 'OPT', 'LAB'];

const DEFAULT_ARENA_PREFS = ['claude-sonnet-5-5', 'gpt-6.2-sol', 'gemini-4-carbon'];

const LOCAL_MODEL_PRICING: Record<string, { inPerM: number; outPerM: number; ctx: number }> = {
  'claude-sonnet-5-5': { inPerM: 3.0, outPerM: 15.0, ctx: 200000 },
  'claude-opus-5-5': { inPerM: 15.0, outPerM: 75.0, ctx: 200000 },
  'gpt-6.2-sol': { inPerM: 2.5, outPerM: 10.0, ctx: 400000 },
  'gpt-6-luna': { inPerM: 1.5, outPerM: 6.0, ctx: 400000 },
  'gemini-4-carbon': { inPerM: 1.25, outPerM: 5.0, ctx: 1000000 },
  'gemini-3.8-flash': { inPerM: 0.15, outPerM: 0.6, ctx: 1000000 },
};

const PROMPT_PRESETS = [
  {
    label: 'Architecture Tradeoff',
    prompt:
      'Compare SQLite WAL with cooperative leases vs embedded RocksDB for a local-first Windows desktop AI workbench. Include a compact Markdown comparison table, latency complexity, and a concrete recommendation.',
    enableSchema: false,
    schemaKey: '',
  },
  {
    label: 'JSON Extraction',
    prompt:
      'Extract key engineering milestones, risks, and owner modules from this note: "Omnia Studio v5 ships 17 Rust crates with embedded SolidJS UI, parallel arena compare, and offline sandboxed artifact canvas with zero CDN dependencies." Return strict JSON matching the schema.',
    enableSchema: true,
    schemaKey: 'extraction',
  },
  {
    label: 'Interactive HTML Widget',
    prompt:
      'Build a self-contained single-file HTML/CSS/JS interactive token-budget & latency calculator widget (zero external CDNs) inside a ```html code block.',
    enableSchema: false,
    schemaKey: '',
  },
  {
    label: 'Algorithm Proof',
    prompt:
      'Prove the optimal competitive ratio of deterministic ski-rental and write a clean Rust implementation with unit tests and KaTeX equations.',
    enableSchema: false,
    schemaKey: '',
  },
];

const SCHEMA_TEMPLATES: Array<{ key: string; label: string; schema: string }> = [
  {
    key: 'extraction',
    label: 'Extraction',
    schema: JSON.stringify(
      {
        type: 'object',
        required: ['summary', 'entities', 'facts', 'confidence'],
        properties: {
          summary: { type: 'string' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'kind'],
              properties: {
                name: { type: 'string' },
                kind: { type: 'string' },
                role: { type: 'string' },
              },
            },
          },
          facts: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
      null,
      2,
    ),
  },
  {
    key: 'code_audit',
    label: 'Code Audit',
    schema: JSON.stringify(
      {
        type: 'object',
        required: ['verdict', 'risk_score', 'findings'],
        properties: {
          verdict: { type: 'string', enum: ['pass', 'needs_changes', 'critical'] },
          risk_score: { type: 'number', minimum: 0, maximum: 100 },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              required: ['severity', 'title', 'recommendation'],
              properties: {
                severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                title: { type: 'string' },
                location: { type: 'string' },
                recommendation: { type: 'string' },
              },
            },
          },
        },
        additionalProperties: false,
      },
      null,
      2,
    ),
  },
  {
    key: 'comparison_matrix',
    label: 'Comparison Matrix',
    schema: JSON.stringify(
      {
        type: 'object',
        required: ['topic', 'criteria', 'options', 'recommended'],
        properties: {
          topic: { type: 'string' },
          criteria: { type: 'array', items: { type: 'string' } },
          options: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'score', 'pros', 'cons'],
              properties: {
                name: { type: 'string' },
                score: { type: 'number', minimum: 0, maximum: 10 },
                pros: { type: 'array', items: { type: 'string' } },
                cons: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          recommended: { type: 'string' },
        },
        additionalProperties: false,
      },
      null,
      2,
    ),
  },
  {
    key: 'research_synthesis',
    label: 'Research Synthesis',
    schema: JSON.stringify(
      {
        type: 'object',
        required: ['executive_summary', 'claims', 'open_gaps', 'next_steps'],
        properties: {
          executive_summary: { type: 'string' },
          claims: {
            type: 'array',
            items: {
              type: 'object',
              required: ['claim', 'grade'],
              properties: {
                claim: { type: 'string' },
                grade: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
                citations: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          open_gaps: { type: 'array', items: { type: 'string' } },
          next_steps: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      null,
      2,
    ),
  },
];

let arenaMermaidLib: typeof import('mermaid').default | null = null;
let arenaMermaidSeq = 0;

async function hydrateArenaMermaid(container: HTMLElement): Promise<void> {
  const nodes = container.querySelectorAll<HTMLElement>('.omnia-mermaid[data-mermaid]');
  if (nodes.length === 0) return;
  if (!arenaMermaidLib) {
    const mod = await import('mermaid');
    arenaMermaidLib = mod.default;
  }
  const light = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'alabaster';
  arenaMermaidLib.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: light ? 'default' : 'dark',
  });
  for (const el of nodes) {
    if (el.dataset.rendered === 'true') continue;
    const raw = decodeURIComponent(el.dataset.mermaid || '');
    if (!raw.trim()) continue;
    try {
      const id = `omnia-arena-mmd-${++arenaMermaidSeq}`;
      const { svg } = await arenaMermaidLib.render(id, raw);
      el.innerHTML = svg;
      el.dataset.rendered = 'true';
    } catch {
      // Keep clean source fallback
    }
  }
}

async function fetchJsonSafe<T = Record<string, unknown>>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; status: number; code: string; message: string }> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          ok: false,
          status: res.status,
          code: 'invalid_json',
          message: text.slice(0, 180) || res.statusText || 'Invalid JSON response',
        };
      }
    }
    if (!res.ok) {
      const rec = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
      return {
        ok: false,
        status: res.status,
        code: String(rec.error || rec.code || `http_${res.status}`),
        message: String(rec.message || res.statusText || 'Request failed'),
      };
    }
    return { ok: true, data: parsed as T };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      code: isAbort ? 'aborted' : 'network_unreachable',
      message: isAbort ? 'Request cancelled by user' : err instanceof Error ? err.message : 'Network error',
    };
  }
}

function shortModelLabel(spec: string): string {
  const parts = spec.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : spec;
}

function inferProvider(spec: string): string {
  if (spec.includes('/')) return spec.split('/')[0];
  const lower = spec.toLowerCase();
  if (lower.includes('claude')) return 'htmustc-claude';
  if (lower.includes('gemini')) return 'htmustc-gemini';
  return 'htmustc-openai';
}

function lookupLocalPricing(spec: string): { inPerM: number; outPerM: number; ctx: number } {
  const short = shortModelLabel(spec).toLowerCase();
  for (const [k, v] of Object.entries(LOCAL_MODEL_PRICING)) {
    if (short.includes(k) || spec.toLowerCase().includes(k)) return v;
  }
  if (short.includes('opus')) return { inPerM: 15.0, outPerM: 75.0, ctx: 200000 };
  if (short.includes('flash') || short.includes('mini')) return { inPerM: 0.2, outPerM: 0.8, ctx: 400000 };
  return { inPerM: 2.5, outPerM: 10.0, ctx: 200000 };
}

function estimateTokensApprox(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  return Math.max(1, Math.ceil(clean.length / 4));
}

function validateJsonOutputAgainstSchema(rawText: string, schemaObj: Record<string, unknown> | null): SchemaValidationInfo {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { provided: Boolean(schemaObj), valid: false, error: 'Empty output' };
  }
  // Extract fenced ```json block if wrapped
  let candidate = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  if (fenceMatch) candidate = fenceMatch[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      provided: Boolean(schemaObj),
      valid: false,
      error: err instanceof Error ? err.message : 'Invalid JSON',
    };
  }
  if (!schemaObj) return { provided: false, valid: true };
  if (schemaObj.type === 'object') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { provided: true, valid: false, error: 'Expected JSON object' };
    }
    const rec = parsed as Record<string, unknown>;
    if (Array.isArray(schemaObj.required)) {
      const missing = schemaObj.required
        .map(String)
        .filter((k) => !(k in rec) || rec[k] === undefined);
      if (missing.length > 0) {
        return { provided: true, valid: false, error: `Missing required keys: ${missing.join(', ')}` };
      }
    }
  } else if (schemaObj.type === 'array' && !Array.isArray(parsed)) {
    return { provided: true, valid: false, error: 'Expected JSON array' };
  }
  return { provided: true, valid: true };
}

function normalizeArenaOutput(raw: Record<string, unknown>, idx: number): ArenaModelOutput {
  const rawSv = (raw.schemaValidation ?? raw.schema_validation) as Record<string, unknown> | undefined;
  let schemaValidation: SchemaValidationInfo | undefined;
  if (rawSv && typeof rawSv === 'object') {
    schemaValidation = {
      provided: Boolean(rawSv.provided ?? true),
      valid: Boolean(rawSv.valid),
      error: rawSv.error ? String(rawSv.error) : undefined,
    };
  }
  const numOrNull = (val: unknown): number | null => {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  };
  const model = String(raw.model ?? raw.modelId ?? raw.model_id ?? `model-${idx + 1}`);
  const status = String(raw.status ?? (raw.ok ? 'ok' : 'error'));
  return {
    model,
    providerId: String(raw.providerId ?? raw.provider_id ?? inferProvider(model)),
    wireApi: String(raw.wireApi ?? raw.wire_api ?? 'responses'),
    status,
    ok: Boolean(raw.ok ?? (status === 'ok' || status === 'completed')),
    text: String(raw.text ?? raw.content ?? raw.output ?? ''),
    thinkingText: raw.thinkingText
      ? String(raw.thinkingText)
      : raw.thinking_text
        ? String(raw.thinking_text)
        : undefined,
    error: raw.error ? String(raw.error) : undefined,
    ttftMs: numOrNull(raw.ttftMs ?? raw.ttft_ms),
    totalMs: numOrNull(raw.totalMs ?? raw.total_ms ?? raw.durationMs ?? raw.duration_ms),
    tokensPerSecond: numOrNull(raw.tokensPerSecond ?? raw.tokens_per_second ?? raw.tps),
    inputTokens: Number(raw.inputTokens ?? raw.input_tokens ?? 0) || 0,
    outputTokens: Number(raw.outputTokens ?? raw.output_tokens ?? 0) || 0,
    cachedTokens: Number(raw.cachedTokens ?? raw.cached_tokens ?? 0) || 0,
    costUsd: Number(raw.costUsd ?? raw.cost_usd ?? 0) || 0,
    schemaValidation,
  };
}

function normalizeLeaderboard(rawList: unknown): LeaderboardEntry[] {
  if (!Array.isArray(rawList)) return [];
  return rawList.map((entry) => {
    const r = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const numOrNull = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const wins = Number(r.wins ?? 0) || 0;
    const losses = Number(r.losses ?? 0) || 0;
    const ties = Number(r.ties ?? 0) || 0;
    const matches = Number(r.matches ?? wins + losses + ties) || 0;
    const computedRate = matches > 0 ? ((wins + ties * 0.5) / matches) * 100 : 0;
    return {
      modelId: String(r.modelId ?? r.model_id ?? r.model ?? 'unknown'),
      elo: Number(r.elo ?? 1500) || 1500,
      wins,
      losses,
      ties,
      matches,
      winRatePct: Number(r.winRatePct ?? r.win_rate_pct ?? computedRate) || 0,
      avgTtftMs: numOrNull(r.avgTtftMs ?? r.avg_ttft_ms),
      avgTps: numOrNull(r.avgTps ?? r.avg_tps),
      avgCostUsd: numOrNull(r.avgCostUsd ?? r.avg_cost_usd),
    };
  });
}

function normalizePersonas(rawList: unknown): StudioPersona[] {
  if (!Array.isArray(rawList)) return [];
  return rawList.map((entry, idx) => {
    const r = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const eff = String(r.effort ?? 'max') as EffortLevel;
    const focus = String(r.focusMode ?? r.focus_mode ?? 'solo') as PersonaFocusMode;
    return {
      id: String(r.id ?? `persona-${idx}`),
      name: String(r.name ?? 'Unnamed Gem'),
      icon: String(r.icon ?? 'GEM'),
      description: String(r.description ?? ''),
      modelId: String(r.modelId ?? r.model_id ?? 'htmustc-claude/claude-sonnet-5-5'),
      effort: EFFORT_LEVELS.includes(eff) ? eff : 'max',
      temperature: Number.isFinite(Number(r.temperature)) ? Number(r.temperature) : 0.7,
      topP: Number.isFinite(Number(r.topP ?? r.top_p)) ? Number(r.topP ?? r.top_p) : 0.95,
      systemPrompt: String(r.systemPrompt ?? r.system_prompt ?? ''),
      focusMode: FOCUS_MODES.includes(focus) ? focus : 'solo',
      pinnedFiles: Array.isArray(r.pinnedFiles ?? r.pinned_files)
        ? ((r.pinnedFiles ?? r.pinned_files) as unknown[]).map(String)
        : [],
      createdAtMs: Number(r.createdAtMs ?? r.created_at_ms ?? Date.now()) || Date.now(),
      updatedAtMs: Number(r.updatedAtMs ?? r.updated_at_ms ?? Date.now()) || Date.now(),
    };
  });
}

function computeLexicalWordDiff(
  textA: string,
  textB: string,
): { leftTokens: LexicalDiffToken[]; rightTokens: LexicalDiffToken[]; similarityPct: number; uniqueA: number; uniqueB: number } {
  const wordsA = textA.trim() ? textA.trim().split(/\s+/).slice(0, 420) : [];
  const wordsB = textB.trim() ? textB.trim().split(/\s+/).slice(0, 420) : [];
  const m = wordsA.length;
  const n = wordsB.length;
  if (m === 0 && n === 0) {
    return { leftTokens: [], rightTokens: [], similarityPct: 100, uniqueA: 0, uniqueB: 0 };
  }

  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = wordsA[i] === wordsB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const leftTokens: LexicalDiffToken[] = [];
  const rightTokens: LexicalDiffToken[] = [];
  let i = 0;
  let j = 0;
  let shared = 0;
  let uniqueA = 0;
  let uniqueB = 0;
  while (i < m && j < n) {
    if (wordsA[i] === wordsB[j]) {
      leftTokens.push({ text: wordsA[i], kind: 'same' });
      rightTokens.push({ text: wordsB[j], kind: 'same' });
      shared++;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      leftTokens.push({ text: wordsA[i], kind: 'a-only' });
      uniqueA++;
      i++;
    } else {
      rightTokens.push({ text: wordsB[j], kind: 'b-only' });
      uniqueB++;
      j++;
    }
  }
  while (i < m) {
    leftTokens.push({ text: wordsA[i], kind: 'a-only' });
    uniqueA++;
    i++;
  }
  while (j < n) {
    rightTokens.push({ text: wordsB[j], kind: 'b-only' });
    uniqueB++;
    j++;
  }
  const denom = shared + uniqueA + uniqueB;
  const similarityPct = denom > 0 ? Math.round((shared / denom) * 100) : 100;
  return { leftTokens, rightTokens, similarityPct, uniqueA, uniqueB };
}

function extractCanvasArtifactFromAnswer(model: string, text: string, schemaEnabled: boolean): CanvasArtifact {
  const title = `Arena · ${shortModelLabel(model)}`;
  const fence = text.match(/```([a-zA-Z0-9_+#.-]*)\s*\n([\s\S]*?)```/);
  if (fence) {
    const lang = (fence[1] || '').toLowerCase();
    const body = fence[2].trim();
    if (lang === 'html' || lang === 'htm') {
      return { id: `arena-art-${Date.now()}`, title, kind: 'html', language: 'html', content: body };
    }
    if (lang === 'svg') {
      return { id: `arena-art-${Date.now()}`, title, kind: 'svg', language: 'svg', content: body };
    }
    if (lang === 'mermaid') {
      return { id: `arena-art-${Date.now()}`, title, kind: 'mermaid', language: 'mermaid', content: body };
    }
    if (lang === 'csv') {
      return { id: `arena-art-${Date.now()}`, title, kind: 'csv', language: 'csv', content: body };
    }
    if (lang === 'json') {
      return { id: `arena-art-${Date.now()}`, title, kind: 'json', language: 'json', content: body };
    }
    if (lang && lang !== 'markdown' && lang !== 'md') {
      return { id: `arena-art-${Date.now()}`, title, kind: 'code', language: lang, content: body };
    }
  }
  if (schemaEnabled) {
    try {
      JSON.parse(text.trim());
      return { id: `arena-art-${Date.now()}`, title, kind: 'json', language: 'json', content: text.trim() };
    } catch {
      // Fall through to markdown
    }
  }
  return { id: `arena-art-${Date.now()}`, title, kind: 'markdown', content: text };
}

function buildCodeSnippet(
  lang: CodeSnippetLang,
  opts: {
    models: string[];
    prompt: string;
    systemPrompt: string;
    effort: EffortLevel;
    temperature: number;
    topP: number;
    maxTokens: number;
    stopSequences: string[];
    schemaEnabled: boolean;
    schemaObject: Record<string, unknown> | null;
  },
): string {
  const primaryModel = opts.models[0] || 'htmustc-claude/claude-sonnet-5-5';
  const payload: Record<string, unknown> = {
    prompt: opts.prompt || 'Explain cooperative process leases in SQLite WAL.',
    models: opts.models,
    effort: opts.effort,
    temperature: opts.temperature,
    topP: opts.topP,
    maxTokens: opts.maxTokens,
    live: true,
  };
  if (opts.systemPrompt.trim()) payload.systemPrompt = opts.systemPrompt.trim();
  if (opts.stopSequences.length > 0) payload.stopSequences = opts.stopSequences;
  if (opts.schemaEnabled && opts.schemaObject) payload.jsonSchema = opts.schemaObject;

  const origin = resolveStudioOrigin();
  const arenaCompareUrl = `${origin}/api/v5/arena/compare`;
  const openaiBaseUrl = `${origin}/v1`;
  const jsonBody = JSON.stringify(payload, null, 2);

  if (lang === 'curl') {
    const escaped = jsonBody.replace(/'/g, "'\\''");
    return [
      '# Omnia Studio v5 Parallel Arena API (loopback)',
      `curl -sS -X POST "${arenaCompareUrl}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d '${escaped}'`,
    ].join('\n');
  }

  if (lang === 'python-httpx') {
    return [
      'import json',
      'import httpx',
      '',
      `payload = json.loads(${JSON.stringify(jsonBody)})`,
      '',
      'with httpx.Client(timeout=120.0) as client:',
      '    resp = client.post(',
      `        "${arenaCompareUrl}",`,
      '        json=payload,',
      '    )',
      '    resp.raise_for_status()',
      '    data = resp.json()',
      '    for item in data.get("results", []):',
      '        print(f"=== {item[\'model\']} ({item.get(\'ttftMs\')}ms, ${item.get(\'costUsd\', 0):.6f}) ===")',
      '        print(item.get("text") or item.get("error"))',
    ].join('\n');
  }

  if (lang === 'python-openai') {
    const msgs: Array<{ role: string; content: string }> = [];
    if (opts.systemPrompt.trim()) msgs.push({ role: 'system', content: opts.systemPrompt.trim() });
    msgs.push({ role: 'user', content: opts.prompt || 'Explain cooperative process leases in SQLite WAL.' });
    const lines = [
      'import os',
      'from openai import OpenAI',
      '',
      'client = OpenAI(',
      `    base_url=os.environ.get("OMNIA_BASE_URL", "${openaiBaseUrl}"),`,
      '    api_key=os.environ.get("OMNIA_API_KEY", ""),',
      ')',
      '',
      'response = client.chat.completions.create(',
      `    model=${JSON.stringify(primaryModel)},`,
      `    messages=${JSON.stringify(msgs, null, 4)},`,
      `    temperature=${opts.temperature},`,
      `    top_p=${opts.topP},`,
      `    max_tokens=${opts.maxTokens},`,
      `    reasoning_effort=${JSON.stringify(opts.effort)},`,
    ];
    if (opts.stopSequences.length > 0) {
      lines.push(`    stop=${JSON.stringify(opts.stopSequences)},`);
    }
    if (opts.schemaEnabled && opts.schemaObject) {
      lines.push(
        `    response_format={"type": "json_schema", "json_schema": {"name": "omnia_structured", "strict": True, "schema": ${JSON.stringify(opts.schemaObject)}}},`,
      );
    }
    lines.push(')', 'print(response.choices[0].message.content)');
    return lines.join('\n');
  }

  if (lang === 'typescript') {
    return [
      `const payload = ${jsonBody};`,
      '',
      `const res = await fetch("${arenaCompareUrl}", {`,
      '  method: "POST",',
      '  headers: { "Content-Type": "application/json" },',
      '  body: JSON.stringify(payload),',
      '});',
      'if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);',
      'const data = await res.json();',
      'for (const r of data.results ?? []) {',
      '  console.log(`[${r.model}] TTFT=${r.ttftMs}ms cost=$${Number(r.costUsd ?? 0).toFixed(6)}`);',
      '  console.log(r.text || r.error);',
      '}',
    ].join('\n');
  }

  // Rust (reqwest)
  return [
    'use reqwest::Client;',
    'use serde_json::{json, Value};',
    '',
    '#[tokio::main]',
    'async fn main() -> Result<(), Box<dyn std::error::Error>> {',
    '    let client = Client::new();',
    `    let payload: Value = serde_json::from_str(r##"${jsonBody}"##)?;`,
    '    let resp: Value = client',
    `        .post("${arenaCompareUrl}")`,
    '        .json(&payload)',
    '        .send()',
    '        .await?',
    '        .error_for_status()?',
    '        .json()',
    '        .await?;',
    '    if let Some(results) = resp["results"].as_array() {',
    '        for r in results {',
    '            println!("=== {} (cost=${:.6}) ===", r["model"], r["costUsd"].as_f64().unwrap_or(0.0));',
    '            println!("{}", r["text"].as_str().or(r["error"].as_str()).unwrap_or(""));',
    '        }',
    '    }',
    '    Ok(())',
    '}',
  ].join('\n');
}

function ArenaMarkdownCard(props: { text: string }) {
  let hostRef: HTMLDivElement | undefined;
  const html = createMemo(() => renderRichMarkdown(maskText(props.text, privacyMask())));

  createEffect(() => {
    html();
    if (hostRef) {
      queueMicrotask(() => {
        if (hostRef) void hydrateArenaMermaid(hostRef);
      });
    }
  });

  return (
    <div
      ref={hostRef}
      class="omnia-prose text-[13px] min-w-0"
      onClick={(e) => handleRichMarkdownClick(e, { onNotify: flashNotice })}
      innerHTML={html()}
    />
  );
}

export function AIStudioArenaView() {
  const catalogEntries = createMemo(() => (modelCatalog.length > 0 ? modelCatalog : DEFAULT_MODEL_CATALOG));

  const initialDefaultModels = () => {
    const list = catalogEntries();
    const resolved: string[] = [];
    for (const pref of DEFAULT_ARENA_PREFS) {
      const match = list.find((m) => m.spec.toLowerCase().includes(pref.toLowerCase()));
      if (match && !resolved.includes(match.spec)) resolved.push(match.spec);
    }
    if (resolved.length < 2) {
      for (const m of list) {
        if (!resolved.includes(m.spec)) resolved.push(m.spec);
        if (resolved.length >= 3) break;
      }
    }
    return resolved.slice(0, 4);
  };

  // Arena core state
  const [selectedModels, setSelectedModels] = createSignal<string[]>(initialDefaultModels());
  const [customModelInput, setCustomModelInput] = createSignal('');
  const [prompt, setPrompt] = createSignal('');
  const [effort, setEffort] = createSignal<EffortLevel>('max');
  const [running, setRunning] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const [runElapsedMs, setRunElapsedMs] = createSignal(0);
  const [activeRunId, setActiveRunId] = createSignal<string>('');
  const [interruptedReceipt, setInterruptedReceipt] = createSignal<ArenaInterruptedReceipt | null>(null);
  const [results, setResults] = createSignal<ArenaModelOutput[]>([]);
  const [votedWinner, setVotedWinner] = createSignal<string | null>(null);
  const [voting, setVoting] = createSignal(false);
  const [arenaError, setArenaError] = createSignal('');
  const [expandedThinking, setExpandedThinking] = createSignal<Record<string, boolean>>({});
  const [copiedModel, setCopiedModel] = createSignal<string | null>(null);

  // Side-by-side lexical diff state
  const [diffOpen, setDiffOpen] = createSignal(false);
  const [diffModelA, setDiffModelA] = createSignal('');
  const [diffModelB, setDiffModelB] = createSignal('');

  // Leaderboard state
  const [leaderboard, setLeaderboard] = createSignal<LeaderboardEntry[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = createSignal(false);

  // Right Inspector — Parameter Lab + JSON Schema + Get Code + Personas
  const [inspectorTab, setInspectorTab] = createSignal<InspectorTab>('params');
  const [systemPrompt, setSystemPrompt] = createSignal('');
  const [temperature, setTemperature] = createSignal(0.7);
  const [topP, setTopP] = createSignal(0.95);
  const [maxTokens, setMaxTokens] = createSignal(4096);
  const [stopSequences, setStopSequences] = createSignal<string[]>([]);
  const [stopSeqDraft, setStopSeqDraft] = createSignal('');

  // Structured Output JSON Schema
  const [schemaEnabled, setSchemaEnabled] = createSignal(false);
  const [schemaText, setSchemaText] = createSignal(SCHEMA_TEMPLATES[0].schema);

  // Live pre-send estimate
  const [liveEstimate, setLiveEstimate] = createSignal<StudioEstimateSnapshot | null>(null);

  // Get Code state & modal
  const [codeLang, setCodeLang] = createSignal<CodeSnippetLang>('curl');
  const [codeModalOpen, setCodeModalOpen] = createSignal(false);
  const [copiedCode, setCopiedCode] = createSignal(false);

  // Personas / Gems CRUD
  const [personas, setPersonas] = createSignal<StudioPersona[]>([]);
  const [personasLoading, setPersonasLoading] = createSignal(false);
  const [activePersonaId, setActivePersonaId] = createSignal<string | null>(null);
  const [editingPersonaId, setEditingPersonaId] = createSignal<string | null>(null);
  const [pName, setPName] = createSignal('');
  const [pIcon, setPIcon] = createSignal('GEM');
  const [pDesc, setPDesc] = createSignal('');
  const [pModel, setPModel] = createSignal('htmustc-claude/claude-sonnet-5-5');
  const [pEffort, setPEffort] = createSignal<EffortLevel>('max');
  const [pTemp, setPTemp] = createSignal(0.7);
  const [pTopP, setPTopP] = createSignal(0.95);
  const [pFocus, setPFocus] = createSignal<PersonaFocusMode>('solo');
  const [pSystem, setPSystem] = createSignal('');
  const [savingPersona, setSavingPersona] = createSignal(false);

  // Embedded Artifact Canvas Drawer for 1-click "Open in Canvas" from Arena answers
  const [canvasArtifact, setCanvasArtifact] = createSignal<CanvasArtifact | null>(null);
  const [canvasOpen, setCanvasOpen] = createSignal(false);

  let runTimer: ReturnType<typeof setInterval> | null = null;
  let estimateTimer: ReturnType<typeof setTimeout> | null = null;
  let arenaAbortController: AbortController | null = null;
  let runStartedAtPerf = 0;

  const parsedSchema = createMemo<{ valid: boolean; obj: Record<string, unknown> | null; error?: string }>(() => {
    const raw = schemaText().trim();
    if (!raw) return { valid: false, obj: null, error: 'Schema cannot be empty' };
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { valid: false, obj: null, error: 'Root schema must be a JSON object' };
      }
      return { valid: true, obj: parsed as Record<string, unknown> };
    } catch (err) {
      return { valid: false, obj: null, error: err instanceof Error ? err.message : 'Invalid JSON' };
    }
  });

  // Instant deterministic local token & 6-decimal USD estimator
  const localEstimate = createMemo<StudioEstimateSnapshot>(() => {
    const sysTokens = estimateTokensApprox(systemPrompt());
    const prmTokens = estimateTokensApprox(prompt());
    const schTokens = schemaEnabled() ? estimateTokensApprox(schemaText()) : 0;
    const inTokens = sysTokens + prmTokens + schTokens;
    const estOut = Math.min(maxTokens(), Math.max(256, Math.round(inTokens * 1.4 + 384)));

    const perModel: ModelCostEstimate[] = selectedModels().map((m) => {
      const p = lookupLocalPricing(m);
      const inCost = (inTokens / 1_000_000) * p.inPerM;
      const outCost = (estOut / 1_000_000) * p.outPerM;
      return {
        modelId: m,
        providerId: inferProvider(m),
        configured: true,
        inputPerM: p.inPerM,
        outputPerM: p.outPerM,
        estimatedInputCostUsd: inCost,
        estimatedOutputCostUsd: outCost,
        estimatedTotalUsd: inCost + outCost,
        contextWindow: p.ctx,
        contextFillPct: p.ctx > 0 ? Math.min(100, (inTokens / p.ctx) * 100) : 0,
      };
    });
    const totalEstimatedUsd = perModel.reduce((acc, item) => acc + item.estimatedTotalUsd, 0);
    const sc = parsedSchema();
    return {
      source: 'local',
      inputTokens: inTokens,
      systemTokens: sysTokens,
      promptTokens: prmTokens,
      estimatedOutputTokens: estOut,
      perModel,
      totalEstimatedUsd,
      schemaCheck: {
        provided: schemaEnabled(),
        valid: !schemaEnabled() || sc.valid,
        error: schemaEnabled() && !sc.valid ? sc.error : undefined,
      },
    };
  });

  const activeEstimate = createMemo<StudioEstimateSnapshot>(() => liveEstimate() ?? localEstimate());

  const loadLeaderboard = async () => {
    setLeaderboardLoading(true);
    const res = await fetchJsonSafe<Record<string, unknown>>('/api/v5/arena/leaderboard');
    if (res.ok) {
      setLeaderboard(normalizeLeaderboard(res.data.leaderboard ?? res.data.entries ?? res.data.items));
    }
    setLeaderboardLoading(false);
  };

  const loadPersonas = async () => {
    setPersonasLoading(true);
    const res = await fetchJsonSafe<Record<string, unknown>>('/api/v5/studio/personas');
    if (res.ok) {
      setPersonas(normalizePersonas(res.data.personas ?? res.data.items ?? res.data.gems));
    }
    setPersonasLoading(false);
  };

  onMount(() => {
    void loadLeaderboard();
    void loadPersonas();
  });

  onCleanup(() => {
    if (runTimer) clearInterval(runTimer);
    if (estimateTimer) clearTimeout(estimateTimer);
    if (arenaAbortController) {
      arenaAbortController.abort();
      arenaAbortController = null;
    }
  });

  // Debounced optional backend sync to POST /api/v5/studio/estimate
  createEffect(() => {
    const pText = prompt();
    const sText = systemPrompt();
    const mods = [...selectedModels()];
    const maxTok = maxTokens();
    const useSchema = schemaEnabled();
    const sc = parsedSchema();
    setLiveEstimate(null);

    if (estimateTimer) clearTimeout(estimateTimer);
    if (!pText.trim() && !sText.trim()) return;

    estimateTimer = setTimeout(() => {
      void fetchJsonSafe<Record<string, unknown>>('/api/v5/studio/estimate', {
        method: 'POST',
        body: JSON.stringify({
          prompt: pText,
          systemPrompt: sText || undefined,
          models: mods,
          maxTokens: maxTok,
          jsonSchema: useSchema && sc.valid ? sc.obj : undefined,
        }),
      }).then((res) => {
        if (!res.ok) return;
        const d = res.data;
        const rawPer = Array.isArray(d.perModel ?? d.per_model)
          ? ((d.perModel ?? d.per_model) as Array<Record<string, unknown>>)
          : [];
        const perModel: ModelCostEstimate[] = rawPer.map((item) => {
          const mid = String(item.modelId ?? item.model_id ?? '');
          const fallbackP = lookupLocalPricing(mid);
          return {
            modelId: mid,
            providerId: String(item.providerId ?? item.provider_id ?? inferProvider(mid)),
            configured: Boolean(item.configured ?? true),
            inputPerM: Number(item.inputPerM ?? item.input_per_m ?? fallbackP.inPerM) || fallbackP.inPerM,
            outputPerM: Number(item.outputPerM ?? item.output_per_m ?? fallbackP.outPerM) || fallbackP.outPerM,
            estimatedInputCostUsd: Number(item.estimatedInputCostUsd ?? item.estimated_input_cost_usd ?? 0) || 0,
            estimatedOutputCostUsd: Number(item.estimatedOutputCostUsd ?? item.estimated_output_cost_usd ?? 0) || 0,
            estimatedTotalUsd: Number(item.estimatedTotalUsd ?? item.estimated_total_usd ?? 0) || 0,
            contextWindow: Number(item.contextWindow ?? item.context_window ?? fallbackP.ctx) || fallbackP.ctx,
            contextFillPct: Number(item.contextFillPct ?? item.context_fill_pct ?? 0) || 0,
          };
        });
        const rawSc = (d.schemaCheck ?? d.schema_check ?? {}) as Record<string, unknown>;
        setLiveEstimate({
          source: 'live',
          inputTokens: Number(d.inputTokens ?? d.input_tokens ?? localEstimate().inputTokens) || 0,
          systemTokens: Number(d.systemTokens ?? d.system_tokens ?? localEstimate().systemTokens) || 0,
          promptTokens: Number(d.promptTokens ?? d.prompt_tokens ?? localEstimate().promptTokens) || 0,
          estimatedOutputTokens:
            Number(d.estimatedOutputTokens ?? d.estimated_output_tokens ?? localEstimate().estimatedOutputTokens) || 0,
          perModel: perModel.length > 0 ? perModel : localEstimate().perModel,
          totalEstimatedUsd:
            Number(d.totalEstimatedUsd ?? d.total_estimated_usd ?? localEstimate().totalEstimatedUsd) || 0,
          schemaCheck: {
            provided: Boolean(rawSc.provided ?? useSchema),
            valid: Boolean(rawSc.valid ?? (!useSchema || sc.valid)),
            error: rawSc.error ? String(rawSc.error) : undefined,
          },
        });
      });
    }, 320);
  });

  const toggleModelSelection = (spec: string) => {
    const cur = selectedModels();
    if (cur.includes(spec)) {
      if (cur.length <= 2) {
        flashNotice('Select at least 2 models for Parallel Arena comparison');
        return;
      }
      setSelectedModels(cur.filter((m) => m !== spec));
    } else {
      if (cur.length >= 4) {
        flashNotice('Parallel Arena supports up to 4 models simultaneously');
        return;
      }
      setSelectedModels([...cur, spec]);
    }
  };

  const addCustomModel = () => {
    const clean = customModelInput().trim();
    if (!clean) return;
    const cur = selectedModels();
    if (cur.includes(clean)) {
      setCustomModelInput('');
      return;
    }
    if (cur.length >= 4) {
      flashNotice('Deselect a model first (max 4 in Parallel Arena)');
      return;
    }
    setSelectedModels([...cur, clean]);
    setCustomModelInput('');
  };

  const addStopSequence = () => {
    const pieces = stopSeqDraft()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (pieces.length === 0) return;
    const next = [...stopSequences()];
    for (const p of pieces) {
      if (!next.includes(p) && next.length < 8) next.push(p);
    }
    setStopSequences(next);
    setStopSeqDraft('');
  };

  const cancelParallelArena = async () => {
    if (!running() || cancelling()) return;
    setCancelling(true);
    const runId = activeRunId() || `arena-${Date.now()}`;
    const models = [...selectedModels()];
    const elapsedMs = runStartedAtPerf > 0 ? Math.round(performance.now() - runStartedAtPerf) : runElapsedMs();

    if (arenaAbortController) {
      arenaAbortController.abort();
      arenaAbortController = null;
    }
    if (runTimer) {
      clearInterval(runTimer);
      runTimer = null;
    }
    setRunElapsedMs(elapsedMs);
    setRunning(false);

    const [arenaRes, routerRes] = await Promise.all([
      fetchJsonSafe<Record<string, unknown>>('/api/v5/arena/cancel', {
        method: 'POST',
        body: JSON.stringify({ runId, run_id: runId, models, note: 'user_cancelled' }),
      }),
      fetchJsonSafe<Record<string, unknown>>('/api/router/cancel', {
        method: 'POST',
        body: JSON.stringify({
          reservationId: runId,
          requestId: runId,
          runId,
          cancelAllActive: true,
          note: 'arena_user_cancelled',
        }),
      }),
    ]);

    const arenaReceiptObj =
      arenaRes.ok && arenaRes.data.receipt && typeof arenaRes.data.receipt === 'object'
        ? (arenaRes.data.receipt as Record<string, unknown>)
        : null;
    const arenaCancelText = arenaRes.ok
      ? String(arenaReceiptObj?.status ?? (arenaRes.data.cancelled ? 'cancelled' : 'acknowledged'))
      : `${arenaRes.code} (${arenaRes.status})`;
    const routerCancelText = routerRes.ok
      ? `${routerRes.data.cancelled ? 'cancelled' : 'clear'} (${Number(routerRes.data.cancelledCount ?? 0)})`
      : `${routerRes.code} (${routerRes.status})`;

    const receipt: ArenaInterruptedReceipt = {
      runId,
      cancelledAtIso: new Date().toISOString(),
      elapsedMs,
      models,
      arenaCancelStatus: arenaCancelText,
      routerCancelStatus: routerCancelText,
      detail:
        arenaRes.ok || routerRes.ok
          ? 'In-flight browser fetch aborted and backend Arena + Router reservation cancellation dispatched cleanly.'
          : 'In-flight browser fetch aborted locally; backend cancel endpoints reported offline or unconfigured.',
    };
    setInterruptedReceipt(receipt);
    setArenaError('');
    setCancelling(false);
    flashNotice(`Cancelled Arena run ${runId.slice(0, 14)} after ${formatMs(elapsedMs)}`);
  };

  const runParallelArena = async () => {
    const cleanPrompt = prompt().trim();
    if (!cleanPrompt) {
      flashNotice('Enter a prompt to run the Parallel Arena');
      return;
    }
    const models = selectedModels();
    if (models.length < 2) {
      flashNotice('Choose 2-4 models before launching Parallel Arena');
      return;
    }
    if (schemaEnabled() && !parsedSchema().valid) {
      flashNotice(`Fix JSON schema error first: ${parsedSchema().error}`);
      setInspectorTab('schema');
      return;
    }

    if (arenaAbortController) {
      arenaAbortController.abort();
    }
    const controller = new AbortController();
    arenaAbortController = controller;
    const clientRunId = `arena-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    setActiveRunId(clientRunId);
    setRunning(true);
    setCancelling(false);
    setArenaError('');
    setInterruptedReceipt(null);
    setVotedWinner(null);
    setRunElapsedMs(0);
    const started = performance.now();
    runStartedAtPerf = started;
    if (runTimer) clearInterval(runTimer);
    runTimer = setInterval(() => setRunElapsedMs(Math.round(performance.now() - started)), 80);

    const payload: Record<string, unknown> = {
      runId: clientRunId,
      run_id: clientRunId,
      requestId: clientRunId,
      prompt: cleanPrompt,
      models,
      effort: effort(),
      temperature: temperature(),
      topP: topP(),
      maxTokens: maxTokens(),
      live: true,
    };
    if (systemPrompt().trim()) payload.systemPrompt = systemPrompt().trim();
    if (stopSequences().length > 0) payload.stopSequences = stopSequences();
    if (schemaEnabled() && parsedSchema().obj) payload.jsonSchema = parsedSchema().obj;

    const res = await fetchJsonSafe<Record<string, unknown>>('/api/v5/arena/compare', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (arenaAbortController === controller) {
      arenaAbortController = null;
    }
    if (runTimer) {
      clearInterval(runTimer);
      runTimer = null;
    }
    setRunElapsedMs(Math.round(performance.now() - started));
    setRunning(false);

    if (!res.ok) {
      if (res.code === 'aborted') {
        if (!interruptedReceipt()) {
          setInterruptedReceipt({
            runId: clientRunId,
            cancelledAtIso: new Date().toISOString(),
            elapsedMs: Math.round(performance.now() - started),
            models,
            arenaCancelStatus: 'aborted',
            routerCancelStatus: 'requested',
            detail: 'Parallel Arena comparison was interrupted before completion.',
          });
        }
        return;
      }
      setArenaError(`Arena API error (${res.code}): ${res.message}`);
      return;
    }

    const d = res.data;
    setActiveRunId(String(d.runId ?? d.run_id ?? clientRunId));
    const rawResults = (d.results ?? d.outputs ?? []) as Array<Record<string, unknown>>;
    const normalized = Array.isArray(rawResults)
      ? rawResults.map((item, idx) => {
          const out = normalizeArenaOutput(item, idx);
          if (schemaEnabled() && !out.schemaValidation && out.ok && out.text.trim()) {
            out.schemaValidation = validateJsonOutputAgainstSchema(out.text, parsedSchema().obj);
          }
          return out;
        })
      : [];
    setResults(normalized);

    if (normalized.length >= 2) {
      setDiffModelA(normalized[0].model);
      setDiffModelB(normalized[1].model);
    }

    if (Array.isArray(d.leaderboard)) {
      setLeaderboard(normalizeLeaderboard(d.leaderboard));
    } else {
      void loadLeaderboard();
    }
    flashNotice(`Parallel Arena finished (${normalized.length} models in ${formatMs(runElapsedMs())})`);
  };

  const castWinnerVote = async (winnerModel: string, isTie = false) => {
    const current = results();
    if (current.length < 2 || voting()) return;
    setVoting(true);
    let latestLeaderboard: LeaderboardEntry[] | null = null;

    if (isTie) {
      const res = await fetchJsonSafe<Record<string, unknown>>('/api/v5/arena/vote', {
        method: 'POST',
        body: JSON.stringify({
          runId: activeRunId() || undefined,
          modelA: current[0].model,
          modelB: current[1].model,
          winner: 'tie',
        }),
      });
      if (res.ok && Array.isArray(res.data.leaderboard)) {
        latestLeaderboard = normalizeLeaderboard(res.data.leaderboard);
      }
      setVotedWinner('__tie__');
    } else {
      const opponents = current.filter((r) => r.model !== winnerModel);
      for (const opp of opponents) {
        const res = await fetchJsonSafe<Record<string, unknown>>('/api/v5/arena/vote', {
          method: 'POST',
          body: JSON.stringify({
            runId: activeRunId() || undefined,
            modelA: winnerModel,
            modelB: opp.model,
            winner: winnerModel,
          }),
        });
        if (res.ok && Array.isArray(res.data.leaderboard)) {
          latestLeaderboard = normalizeLeaderboard(res.data.leaderboard);
        }
      }
      setVotedWinner(winnerModel);
    }

    if (latestLeaderboard) {
      setLeaderboard(latestLeaderboard);
    } else {
      await loadLeaderboard();
    }
    setVoting(false);
    flashNotice(isTie ? 'Recorded Arena tie vote (Elo updated)' : `Voted ${shortModelLabel(winnerModel)} as Arena winner`);
  };

  const openResultInCanvas = (item: ArenaModelOutput) => {
    const art = extractCanvasArtifactFromAnswer(item.model, item.text || item.error || '', schemaEnabled());
    setCanvasArtifact(art);
    setCanvasOpen(true);
  };

  const copyResultText = async (item: ArenaModelOutput) => {
    try {
      await navigator.clipboard.writeText(maskText(item.text || item.error || '', privacyMask()));
      setCopiedModel(item.model);
      setTimeout(() => setCopiedModel(null), 1500);
      flashNotice(`Copied ${shortModelLabel(item.model)} answer`);
    } catch {
      flashNotice('Clipboard unavailable');
    }
  };

  // Persona CRUD helpers
  const resetPersonaForm = () => {
    setEditingPersonaId(null);
    setPName('');
    setPIcon('GEM');
    setPDesc('');
    setPModel(selectedModels()[0] || 'htmustc-claude/claude-sonnet-5-5');
    setPEffort('max');
    setPTemp(0.7);
    setPTopP(0.95);
    setPFocus('solo');
    setPSystem('');
  };

  const startEditPersona = (p: StudioPersona) => {
    setEditingPersonaId(p.id);
    setPName(p.name);
    setPIcon(p.icon || 'GEM');
    setPDesc(p.description);
    setPModel(p.modelId);
    setPEffort(p.effort);
    setPTemp(p.temperature);
    setPTopP(p.topP);
    setPFocus(p.focusMode);
    setPSystem(p.systemPrompt);
    setInspectorTab('personas');
  };

  const applyPersona = (p: StudioPersona) => {
    setActivePersonaId(p.id);
    setSystemPrompt(p.systemPrompt);
    setEffort(p.effort);
    setTemperature(p.temperature);
    setTopP(p.topP);
    const cur = selectedModels();
    if (p.modelId && !cur.includes(p.modelId)) {
      const next = [p.modelId, ...cur.slice(0, 3)];
      setSelectedModels(next.slice(0, 4));
    }
    void updateDualModelConfig({ mainModel: p.modelId, mainEffort: p.effort });
    flashNotice(`Applied Gem "${p.name}" (${shortModelLabel(p.modelId)}, effort=${p.effort}, T=${p.temperature})`);
  };

  const savePersona = async () => {
    const cleanName = pName().trim();
    if (!cleanName) {
      flashNotice('Enter a Gem / Persona name');
      return;
    }
    setSavingPersona(true);
    const body = {
      id: editingPersonaId() || undefined,
      name: cleanName,
      icon: pIcon() || 'GEM',
      description: pDesc().trim(),
      modelId: pModel(),
      effort: pEffort(),
      temperature: pTemp(),
      topP: pTopP(),
      systemPrompt: pSystem(),
      focusMode: pFocus(),
      pinnedFiles: [],
    };
    const res = await fetchJsonSafe<Record<string, unknown>>('/api/v5/studio/personas', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setSavingPersona(false);
    if (!res.ok) {
      flashNotice(`Save persona failed (${res.code}): ${res.message}`);
      return;
    }
    await loadPersonas();
    flashNotice(editingPersonaId() ? `Updated Gem "${cleanName}"` : `Created Gem "${cleanName}"`);
    resetPersonaForm();
  };

  const deletePersona = async (p: StudioPersona) => {
    let res = await fetchJsonSafe<Record<string, unknown>>(
      `/api/v5/studio/personas/${encodeURIComponent(p.id)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      res = await fetchJsonSafe<Record<string, unknown>>('/api/v5/studio/personas/delete', {
        method: 'POST',
        body: JSON.stringify({ id: p.id }),
      });
    }
    if (!res.ok) {
      flashNotice(`Delete persona failed (${res.code}): ${res.message}`);
      return;
    }
    if (activePersonaId() === p.id) setActivePersonaId(null);
    if (editingPersonaId() === p.id) resetPersonaForm();
    await loadPersonas();
    flashNotice(`Deleted Gem "${p.name}"`);
  };

  const activeSnippet = createMemo(() =>
    buildCodeSnippet(codeLang(), {
      models: selectedModels(),
      prompt: prompt(),
      systemPrompt: systemPrompt(),
      effort: effort(),
      temperature: temperature(),
      topP: topP(),
      maxTokens: maxTokens(),
      stopSequences: stopSequences(),
      schemaEnabled: schemaEnabled(),
      schemaObject: parsedSchema().obj,
    }),
  );

  const copyActiveSnippet = async () => {
    try {
      await navigator.clipboard.writeText(activeSnippet());
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1500);
      flashNotice(`Copied ${codeLang()} snippet`);
    } catch {
      flashNotice('Clipboard unavailable');
    }
  };

  const downloadActiveSnippet = () => {
    const extMap: Record<CodeSnippetLang, string> = {
      curl: 'sh',
      'python-httpx': 'py',
      'python-openai': 'py',
      typescript: 'ts',
      rust: 'rs',
    };
    const ext = extMap[codeLang()];
    downloadTextFile(`omnia-arena-snippet.${ext}`, activeSnippet(), 'text/plain;charset=utf-8');
    flashNotice(`Saved omnia-arena-snippet.${ext}`);
  };

  const diffComputation = createMemo(() => {
    const list = results();
    const a = list.find((r) => r.model === diffModelA()) ?? list[0];
    const b = list.find((r) => r.model === diffModelB()) ?? list[1];
    if (!a || !b) return null;
    return {
      a,
      b,
      ...computeLexicalWordDiff(a.text || a.error || '', b.text || b.error || ''),
    };
  });

  const activePersonaObj = createMemo(() => personas().find((p) => p.id === activePersonaId()) ?? null);

  const renderCodePanelBody = () => (
    <div class="flex flex-col gap-2 min-w-0">
      <div class="flex flex-wrap items-center justify-between gap-1.5 min-w-0">
        <div class="omp-segmented flex-wrap">
          {(
            [
              ['curl', 'curl'],
              ['python-httpx', 'Py httpx'],
              ['python-openai', 'Py openai'],
              ['typescript', 'TS fetch'],
              ['rust', 'Rust'],
            ] as Array<[CodeSnippetLang, string]>
          ).map(([id, label]) => (
            <button
              type="button"
              aria-pressed={codeLang() === id}
              onClick={() => setCodeLang(id)}
              class="!px-2 !py-0.5 !text-[11px]"
            >
              {label}
            </button>
          ))}
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={() => void copyActiveSnippet()}>
            <Show when={copiedCode()} fallback={<Copy class="w-3 h-3" />}>
              <Check class="w-3 h-3 text-[var(--status-emerald)]" />
            </Show>
            <span>{copiedCode() ? 'Copied' : 'Copy'}</span>
          </button>
          <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={downloadActiveSnippet}>
            <Download class="w-3 h-3" />
            <span>Save</span>
          </button>
        </div>
      </div>
      <pre class="m-0 p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num text-[var(--ink-primary)] overflow-x-auto max-h-[380px] leading-relaxed">
        <code>{activeSnippet()}</code>
      </pre>
      <div class="text-[11px] text-[var(--ink-muted)] font-mono-num">
        Reflects active prompt, system instructions, {selectedModels().length} model(s), effort={effort()}, T=
        {temperature().toFixed(2)}, topP={topP().toFixed(2)}
        {schemaEnabled() ? ', structured JSON schema ON' : ''}.
      </div>
    </div>
  );

  return (
    <div data-testid="ai-studio-arena-view" class="flex-1 min-h-0 min-w-0 flex overflow-hidden bg-[var(--bg-canvas)]">
      <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
        {/* Workbench Top Bar */}
        <header class="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2 min-w-0">
          <div class="flex items-center gap-2 min-w-0 flex-wrap">
            <Scale class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
            <h2 class="text-[14px] font-bold text-[var(--ink-primary)] m-0">AI Studio &amp; Parallel Arena</h2>
            <span class="omnia-badge font-mono-num text-[var(--accent-cyan)]">
              {selectedModels().length} models · {effort()}
            </span>
            <Show when={activePersonaObj()}>
              {(p) => (
                <span class="omnia-badge text-[var(--accent-amber)]">
                  [{p().icon}] {p().name}
                </span>
              )}
            </Show>
            <Show when={schemaEnabled()}>
              <span
                class="omnia-badge font-mono-num"
                classList={{
                  'text-[var(--status-emerald)]': parsedSchema().valid,
                  'text-[var(--status-coral)]': !parsedSchema().valid,
                }}
              >
                {parsedSchema().valid ? 'JSON SCHEMA ON' : 'JSON SCHEMA ERR'}
              </span>
            </Show>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              type="button"
              data-testid="arena-diff-toggle"
              disabled={results().length < 2}
              onClick={() => setDiffOpen((v) => !v)}
              class="omnia-btn text-[11.5px]"
              classList={{
                'border-[var(--accent-cyan)] text-[var(--accent-cyan)]': diffOpen(),
              }}
            >
              <GitCompare class="w-3.5 h-3.5" />
              <span>Side-by-Side Diff</span>
            </button>
            <button
              type="button"
              data-testid="arena-get-code-btn"
              onClick={() => setCodeModalOpen(true)}
              class="omnia-btn text-[11.5px]"
            >
              <Code2 class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              <span>Get Code</span>
            </button>
            <button
              type="button"
              class="omnia-btn text-[11.5px]"
              onClick={() => {
                void loadLeaderboard();
                void loadPersonas();
              }}
            >
              <RefreshCw class="w-3.5 h-3.5" />
              <span>Sync</span>
            </button>
          </div>
        </header>

        {/* Master Responsive Split: Left Arena + Right Parameter Lab Inspector */}
        <div class="flex-1 min-h-0 min-w-0 flex flex-col xl:flex-row overflow-y-auto xl:overflow-hidden">
          {/* LEFT / MAIN AREA — Live Multi-Model Parallel Arena */}
          <section class="flex-1 min-w-0 xl:min-h-0 xl:overflow-y-auto p-3.5 space-y-3.5">
            {/* Model Selector Chips (2-4 models) + Prompt Composer */}
            <div class="omnia-surface-panel rounded-lg p-3 space-y-3 min-w-0">
              <div class="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <div class="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--ink-secondary)]">
                  <Layers class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
                  <span>Select 2–4 Models for Parallel Arena</span>
                </div>
                <div class="flex items-center gap-1.5 min-w-0">
                  <input
                    type="text"
                    value={customModelInput()}
                    onInput={(e) => setCustomModelInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCustomModel();
                      }
                    }}
                    placeholder="Add custom provider/model..."
                    class="w-44 max-w-full bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] font-mono-num text-[var(--ink-primary)] outline-none focus:border-[var(--border-accent)]"
                  />
                  <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={addCustomModel}>
                    <Plus class="w-3 h-3" />
                    <span>Add</span>
                  </button>
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                <For each={catalogEntries()}>
                  {(entry) => {
                    const selected = () => selectedModels().includes(entry.spec);
                    return (
                      <button
                        type="button"
                        data-testid={`arena-model-chip-${shortModelLabel(entry.spec)}`}
                        aria-pressed={selected()}
                        onClick={() => toggleModelSelection(entry.spec)}
                        class="px-2.5 py-1 rounded border text-[11.5px] font-mono-num inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                        classList={{
                          'border-[var(--accent-cyan)] bg-[var(--accent-dim)] text-[var(--ink-primary)] font-semibold':
                            selected(),
                          'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--ink-secondary)] hover:border-[var(--border-strong)]':
                            !selected(),
                        }}
                      >
                        <Show when={selected()}>
                          <Check class="w-3 h-3 text-[var(--accent-cyan)] shrink-0" />
                        </Show>
                        <span>{entry.name}</span>
                        <span class="text-[10px] text-[var(--ink-muted)]">{shortModelLabel(entry.spec)}</span>
                      </button>
                    );
                  }}
                </For>
                <For each={selectedModels().filter((m) => !catalogEntries().some((e) => e.spec === m))}>
                  {(customSpec) => (
                    <button
                      type="button"
                      aria-pressed="true"
                      onClick={() => toggleModelSelection(customSpec)}
                      class="px-2.5 py-1 rounded border border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] text-[11.5px] font-mono-num text-[var(--accent-amber)] inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span>{customSpec}</span>
                      <X class="w-3 h-3" />
                    </button>
                  )}
                </For>
              </div>

              {/* Prompt Presets */}
              <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                <span class="text-[10.5px] font-mono-num uppercase text-[var(--ink-muted)]">Presets:</span>
                <For each={PROMPT_PRESETS}>
                  {(preset) => (
                    <button
                      type="button"
                      onClick={() => {
                        setPrompt(preset.prompt);
                        if (preset.enableSchema) {
                          const tpl = SCHEMA_TEMPLATES.find((t) => t.key === preset.schemaKey);
                          if (tpl) setSchemaText(tpl.schema);
                          setSchemaEnabled(true);
                        }
                      }}
                      class="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:border-[var(--border-accent)] text-[11px] text-[var(--ink-secondary)] cursor-pointer"
                    >
                      {preset.label}
                    </button>
                  )}
                </For>
              </div>

              {/* Prompt Textarea */}
              <textarea
                data-testid="arena-prompt-input"
                rows={4}
                value={prompt()}
                onInput={(e) => setPrompt(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void runParallelArena();
                  }
                }}
                placeholder="Enter a prompt to race 2-4 frontier models in parallel (Ctrl+Enter to run)..."
                class="w-full min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded-md p-2.5 text-[13px] text-[var(--ink-primary)] outline-none focus:border-[var(--border-accent)] resize-y leading-relaxed"
              />

              {/* Effort + Run Controls + Instant Cost Readout */}
              <div class="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <div class="flex flex-wrap items-center gap-2 min-w-0">
                  <span class="text-[11px] font-mono-num text-[var(--ink-muted)]">Effort</span>
                  <div class="omp-segmented flex-wrap">
                    <For each={EFFORT_LEVELS}>
                      {(lvl) => (
                        <button
                          type="button"
                          aria-pressed={effort() === lvl}
                          onClick={() => setEffort(lvl)}
                          class="!px-2 !py-0.5 !text-[11px] font-mono-num"
                        >
                          {lvl}
                        </button>
                      )}
                    </For>
                  </div>
                  <span class="omnia-badge font-mono-num text-[var(--ink-secondary)]">
                    ~{activeEstimate().inputTokens} in · Est. {formatCost6(activeEstimate().totalEstimatedUsd)}
                  </span>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <Show when={results().length > 0 || interruptedReceipt() !== null}>
                    <button
                      type="button"
                      class="omnia-btn text-[11.5px]"
                      onClick={() => {
                        setResults([]);
                        setVotedWinner(null);
                        setInterruptedReceipt(null);
                        setDiffOpen(false);
                      }}
                    >
                      Clear
                    </button>
                  </Show>
                  <Show when={running()}>
                    <button
                      type="button"
                      data-testid="arena-cancel-btn"
                      disabled={cancelling()}
                      onClick={() => void cancelParallelArena()}
                      class="omnia-btn omnia-btn-danger text-[12px]"
                    >
                      <Square class="w-3.5 h-3.5" />
                      <span>{cancelling() ? 'Cancelling...' : 'Cancel Run'}</span>
                    </button>
                  </Show>
                  <button
                    type="button"
                    data-testid="arena-run-btn"
                    disabled={running() || !prompt().trim()}
                    onClick={() => void runParallelArena()}
                    class="omnia-btn omnia-btn-primary text-[12px]"
                  >
                    <Show when={running()} fallback={<Play class="w-3.5 h-3.5" />}>
                      <Loader2 class="w-3.5 h-3.5 animate-spin" />
                    </Show>
                    <span>
                      {running()
                        ? `Running ${selectedModels().length} models (${formatMs(runElapsedMs())})...`
                        : `Run Parallel Arena (${selectedModels().length})`}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <Show when={interruptedReceipt()}>
              {(rec) => (
                <div
                  data-testid="arena-interrupted-receipt"
                  role="status"
                  class="p-3 rounded-lg border border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] text-[12px] space-y-1.5 min-w-0"
                >
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex items-center gap-2 font-semibold text-[var(--accent-amber)]">
                      <Square class="w-3.5 h-3.5 shrink-0" />
                      <span>Arena Run Interrupted (AUD-24 Cancellation Receipt)</span>
                    </div>
                    <button
                      type="button"
                      aria-label="Dismiss interrupted receipt"
                      class="omnia-btn !px-1.5 !py-0.5 text-[10.5px]"
                      onClick={() => setInterruptedReceipt(null)}
                    >
                      <X class="w-3 h-3" />
                    </button>
                  </div>
                  <div class="text-[11.5px] text-[var(--ink-primary)]">{rec().detail}</div>
                  <div class="flex flex-wrap items-center gap-1.5 text-[11px] font-mono-num">
                    <span class="omnia-badge">runId: {rec().runId}</span>
                    <span class="omnia-badge">elapsed: {formatMs(rec().elapsedMs)}</span>
                    <span class="omnia-badge">arena/cancel: {rec().arenaCancelStatus}</span>
                    <span class="omnia-badge">router/cancel: {rec().routerCancelStatus}</span>
                    <span class="omnia-badge">models: {rec().models.map(shortModelLabel).join(', ')}</span>
                    <span class="omnia-badge">at: {rec().cancelledAtIso}</span>
                  </div>
                </div>
              )}
            </Show>

            <Show when={arenaError()}>
              <div class="p-3 rounded-lg border border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[12px] text-[var(--status-coral)] flex items-start gap-2">
                <AlertTriangle class="w-4 h-4 shrink-0 mt-0.5" />
                <span class="font-mono-num break-words min-w-0">{arenaError()}</span>
              </div>
            </Show>

            {/* Side-by-Side Lexical Diff Panel */}
            <Show when={diffOpen() && diffComputation()}>
              {(diff) => (
                <div data-testid="arena-lexical-diff" class="omnia-surface-panel rounded-lg p-3 space-y-2.5 min-w-0">
                  <div class="flex flex-wrap items-center justify-between gap-2 min-w-0">
                    <div class="flex flex-wrap items-center gap-2 min-w-0">
                      <GitCompare class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
                      <span class="font-semibold text-[12.5px]">Side-by-Side Lexical Diff</span>
                      <select
                        value={diff().a.model}
                        onChange={(e) => setDiffModelA(e.currentTarget.value)}
                        class="bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2 py-0.5 text-[11px] font-mono-num text-[var(--ink-primary)]"
                      >
                        <For each={results()}>
                          {(r) => <option value={r.model}>{shortModelLabel(r.model)}</option>}
                        </For>
                      </select>
                      <span class="text-[11px] font-mono-num text-[var(--ink-muted)]">vs</span>
                      <select
                        value={diff().b.model}
                        onChange={(e) => setDiffModelB(e.currentTarget.value)}
                        class="bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2 py-0.5 text-[11px] font-mono-num text-[var(--ink-primary)]"
                      >
                        <For each={results()}>
                          {(r) => <option value={r.model}>{shortModelLabel(r.model)}</option>}
                        </For>
                      </select>
                    </div>
                    <div class="flex flex-wrap items-center gap-1.5 text-[11px] font-mono-num">
                      <span class="omnia-badge text-[var(--accent-cyan)]">Similarity {diff().similarityPct}%</span>
                      <span class="omnia-badge text-[var(--status-coral)]">A-only: {diff().uniqueA}w</span>
                      <span class="omnia-badge text-[var(--status-emerald)]">B-only: {diff().uniqueB}w</span>
                      <button type="button" class="omnia-btn px-1.5 py-0.5" onClick={() => setDiffOpen(false)}>
                        <X class="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5 min-w-0">
                    <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] p-2.5 min-w-0 max-h-64 overflow-y-auto">
                      <div class="text-[10.5px] font-mono-num text-[var(--status-coral)] mb-1.5 font-semibold">
                        Model A · {shortModelLabel(diff().a.model)} ({formatMs(diff().a.ttftMs)} TTFT ·{' '}
                        {formatCost6(diff().a.costUsd)})
                      </div>
                      <div class="text-[12px] leading-relaxed break-words">
                        <For each={diff().leftTokens}>
                          {(tok) => (
                            <>
                              <span
                                class="rounded px-0.5"
                                classList={{
                                  'bg-[var(--status-coral-dim)] text-[var(--status-coral)] font-semibold':
                                    tok.kind === 'a-only',
                                  'text-[var(--ink-secondary)]': tok.kind === 'same',
                                }}
                              >
                                {tok.text}
                              </span>{' '}
                            </>
                          )}
                        </For>
                      </div>
                    </div>
                    <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] p-2.5 min-w-0 max-h-64 overflow-y-auto">
                      <div class="text-[10.5px] font-mono-num text-[var(--status-emerald)] mb-1.5 font-semibold">
                        Model B · {shortModelLabel(diff().b.model)} ({formatMs(diff().b.ttftMs)} TTFT ·{' '}
                        {formatCost6(diff().b.costUsd)})
                      </div>
                      <div class="text-[12px] leading-relaxed break-words">
                        <For each={diff().rightTokens}>
                          {(tok) => (
                            <>
                              <span
                                class="rounded px-0.5"
                                classList={{
                                  'bg-[var(--status-emerald-dim)] text-[var(--status-emerald)] font-semibold':
                                    tok.kind === 'b-only',
                                  'text-[var(--ink-secondary)]': tok.kind === 'same',
                                }}
                              >
                                {tok.text}
                              </span>{' '}
                            </>
                          )}
                        </For>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </Show>

            {/* Side-by-Side Responsive Output Cards */}
            <Show
              when={results().length > 0}
              fallback={
                <div class="omnia-surface-panel rounded-lg p-5 text-center space-y-2">
                  <div class="inline-flex items-center justify-center w-9 h-9 rounded-full bg-[var(--accent-dim)] text-[var(--accent-cyan)]">
                    <Columns2 class="w-4 h-4" />
                  </div>
                  <div class="text-[13px] font-semibold text-[var(--ink-primary)]">
                    Ready to Race {selectedModels().length} Models in Parallel
                  </div>
                  <div class="text-[12px] text-[var(--ink-muted)] max-w-xl mx-auto">
                    Compare Markdown/LaTeX quality, TTFT, tok/s, cached tokens, 6-decimal USD cost, and strict JSON
                    schema conformance side-by-side. Vote a winner to update the persistent SQLite Elo leaderboard.
                  </div>
                </div>
              }
            >
              <div class="space-y-2 min-w-0">
                <div class="flex flex-wrap items-center justify-between gap-2 min-w-0">
                  <div class="text-[11.5px] font-mono-num text-[var(--ink-muted)]">
                    Run {activeRunId().slice(0, 12)} · {results().length} parallel outputs
                  </div>
                  <Show when={results().length === 2}>
                    <button
                      type="button"
                      disabled={voting()}
                      onClick={() => void castWinnerVote('tie', true)}
                      class="omnia-btn px-2 py-0.5 text-[11px]"
                      classList={{
                        'border-[var(--accent-amber)] text-[var(--accent-amber)]': votedWinner() === '__tie__',
                      }}
                    >
                      <Scale class="w-3 h-3" />
                      <span>{votedWinner() === '__tie__' ? 'Tie Recorded' : 'Vote Tie'}</span>
                    </button>
                  </Show>
                </div>

                <div
                  class="grid grid-cols-1 md:grid-cols-2 gap-3 min-w-0"
                  classList={{
                    'xl:grid-cols-3': results().length === 3,
                    'xl:grid-cols-2': results().length !== 3,
                  }}
                >
                  <For each={results()}>
                    {(item) => {
                      const isWinner = () => votedWinner() === item.model;
                      const thinkingShown = () => Boolean(expandedThinking()[item.model]);
                      return (
                        <article
                          data-testid={`arena-card-${shortModelLabel(item.model)}`}
                          class="omnia-surface-panel rounded-lg flex flex-col min-w-0 overflow-hidden"
                          classList={{
                            'border-[var(--status-emerald)]': isWinner(),
                          }}
                        >
                          {/* Model Header */}
                          <div class="px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex flex-wrap items-center justify-between gap-1.5 min-w-0">
                            <div class="flex items-center gap-1.5 min-w-0">
                              <Bot class="w-3.5 h-3.5 text-[var(--accent-cyan)] shrink-0" />
                              <span class="font-semibold text-[12.5px] text-[var(--ink-primary)] truncate">
                                {shortModelLabel(item.model)}
                              </span>
                              <span class="omnia-badge text-[10px] font-mono-num shrink-0">{item.providerId}</span>
                            </div>
                            <div class="flex items-center gap-1 shrink-0">
                              <span
                                class="omnia-badge font-mono-num text-[10px]"
                                classList={{
                                  'text-[var(--status-emerald)]': item.ok,
                                  'text-[var(--accent-amber)]':
                                    !item.ok && item.status.toLowerCase().includes('unconfigured'),
                                  'text-[var(--status-coral)]':
                                    !item.ok && !item.status.toLowerCase().includes('unconfigured'),
                                }}
                              >
                                {item.status.toUpperCase()}
                              </span>
                              <Show when={item.schemaValidation && item.schemaValidation.provided}>
                                <span
                                  title={item.schemaValidation?.error || 'Matches JSON schema'}
                                  class="omnia-badge font-mono-num text-[10px]"
                                  classList={{
                                    'text-[var(--status-emerald)]': item.schemaValidation?.valid,
                                    'text-[var(--status-coral)]': !item.schemaValidation?.valid,
                                  }}
                                >
                                  {item.schemaValidation?.valid ? 'VALID JSON' : 'JSON ERR'}
                                </span>
                              </Show>
                            </div>
                          </div>

                          {/* Metrics Strip */}
                          <div class="px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] font-mono-num text-[var(--ink-muted)] min-w-0">
                            <span>
                              TTFT <strong class="text-[var(--ink-primary)]">{formatMs(item.ttftMs)}</strong>
                            </span>
                            <span>
                              Total <strong class="text-[var(--ink-primary)]">{formatMs(item.totalMs)}</strong>
                            </span>
                            <span>
                              <strong class="text-[var(--accent-cyan)]">
                                {item.tokensPerSecond !== null ? `${item.tokensPerSecond.toFixed(1)} tok/s` : '—'}
                              </strong>
                            </span>
                            <span>
                              In/Out/Cache{' '}
                              <strong class="text-[var(--ink-secondary)]">
                                {item.inputTokens}/{item.outputTokens}/{item.cachedTokens}
                              </strong>
                            </span>
                            <span>
                              <strong class="text-[var(--accent-amber)]">{formatCost6(item.costUsd)}</strong>
                            </span>
                          </div>

                          {/* Schema Validation Detail when invalid */}
                          <Show when={item.schemaValidation && item.schemaValidation.provided && !item.schemaValidation.valid}>
                            <div class="px-3 py-1.5 border-b border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[11px] font-mono-num text-[var(--status-coral)]">
                              Schema error: {item.schemaValidation?.error || 'Output failed JSON schema validation'}
                            </div>
                          </Show>

                          {/* Optional Thinking Trace */}
                          <Show when={item.thinkingText && item.thinkingText.trim().length > 0}>
                            <div class="px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-code)]">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedThinking((prev) => ({ ...prev, [item.model]: !prev[item.model] }))
                                }
                                class="text-[11px] font-mono-num text-[var(--accent-amber)] cursor-pointer hover:underline"
                              >
                                {thinkingShown() ? 'Hide reasoning trace' : 'Show reasoning trace'} (
                                {item.thinkingText!.length} chars)
                              </button>
                              <Show when={thinkingShown()}>
                                <pre class="mt-1.5 mb-0 text-[11px] font-mono-num text-[var(--ink-secondary)] whitespace-pre-wrap max-h-40 overflow-y-auto">
                                  {maskText(item.thinkingText!, privacyMask())}
                                </pre>
                              </Show>
                            </div>
                          </Show>

                          {/* Answer Body or Honest Diagnostic Card */}
                          <div class="flex-1 p-3 overflow-y-auto max-h-[420px] min-w-0">
                            <Show
                              when={item.ok && item.text.trim().length > 0}
                              fallback={
                                <div class="rounded border border-[var(--border-strong)] bg-[var(--bg-code)] p-3 space-y-1.5 text-[12px]">
                                  <div class="flex items-center gap-1.5 font-semibold text-[var(--accent-amber)]">
                                    <AlertTriangle class="w-3.5 h-3.5 shrink-0" />
                                    <span>Provider Status: {item.status}</span>
                                  </div>
                                  <p class="m-0 text-[var(--ink-secondary)] font-mono-num text-[11.5px] break-words">
                                    {item.error ||
                                      item.text ||
                                      'Provider credentials are not configured for live execution (no synthetic answer fabricated).'}
                                  </p>
                                </div>
                              }
                            >
                              <ArenaMarkdownCard text={item.text} />
                            </Show>
                          </div>

                          {/* Card Footer Actions */}
                          <div class="px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-wrap items-center justify-between gap-1.5 min-w-0">
                            <div class="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                class="omnia-btn px-2 py-1 text-[11px]"
                                onClick={() => void copyResultText(item)}
                              >
                                <Show when={copiedModel() === item.model} fallback={<Copy class="w-3 h-3" />}>
                                  <Check class="w-3 h-3 text-[var(--status-emerald)]" />
                                </Show>
                                <span>{copiedModel() === item.model ? 'Copied' : 'Copy'}</span>
                              </button>
                              <button
                                type="button"
                                class="omnia-btn px-2 py-1 text-[11px]"
                                disabled={!item.text.trim()}
                                onClick={() => openResultInCanvas(item)}
                              >
                                <FileCode2 class="w-3 h-3 text-[var(--accent-cyan)]" />
                                <span>Open in Canvas</span>
                              </button>
                            </div>
                            <button
                              type="button"
                              disabled={voting()}
                              onClick={() => void castWinnerVote(item.model)}
                              class="omnia-btn px-2.5 py-1 text-[11px]"
                              classList={{
                                'omnia-btn-primary': isWinner(),
                              }}
                            >
                              <Award class="w-3.5 h-3.5" />
                              <span>{isWinner() ? 'Winner Voted' : 'Vote Winner'}</span>
                            </button>
                          </div>
                        </article>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>

            {/* Persistent Elo & Win-Rate Leaderboard */}
            <div data-testid="arena-leaderboard" class="omnia-surface-panel rounded-lg overflow-hidden min-w-0">
              <div class="px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex flex-wrap items-center justify-between gap-2 min-w-0">
                <div class="flex items-center gap-2 min-w-0">
                  <Trophy class="w-4 h-4 text-[var(--accent-amber)] shrink-0" />
                  <span class="font-semibold text-[12.5px] text-[var(--ink-primary)]">
                    Persistent Elo &amp; Win-Rate Leaderboard
                  </span>
                  <span class="omnia-badge font-mono-num">Base 1500 · K=32</span>
                </div>
                <button
                  type="button"
                  class="omnia-btn px-2 py-0.5 text-[11px]"
                  disabled={leaderboardLoading()}
                  onClick={() => void loadLeaderboard()}
                >
                  <RefreshCw class="w-3 h-3" classList={{ 'animate-spin': leaderboardLoading() }} />
                  <span>Refresh</span>
                </button>
              </div>
              <div class="overflow-x-auto min-w-0">
                <Show
                  when={leaderboard().length > 0}
                  fallback={
                    <div class="p-3.5 text-[12px] text-[var(--ink-muted)]">
                      No Arena votes recorded yet. Run a parallel comparison and click <strong>Vote Winner</strong> to
                      populate persistent Elo rankings.
                    </div>
                  }
                >
                  <table class="w-full border-collapse text-[11.5px] font-mono-num">
                    <thead>
                      <tr class="bg-[var(--bg-rail)] text-[var(--ink-muted)] text-left">
                        <th class="px-3 py-1.5 border-b border-[var(--border-subtle)]">#</th>
                        <th class="px-3 py-1.5 border-b border-[var(--border-subtle)]">Model</th>
                        <th class="px-3 py-1.5 border-b border-[var(--border-subtle)]">Elo</th>
                        <th class="px-3 py-1.5 border-b border-[var(--border-subtle)]">W / L / T</th>
                        <th class="px-3 py-1.5 border-b border-[var(--border-subtle)]">Win Rate</th>
                        <th class="px-3 py-1.5 border-b border-[var(--border-subtle)]">Avg TTFT</th>
                        <th class="px-3 py-1.5 border-b border-[var(--border-subtle)]">Avg Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={leaderboard()}>
                        {(row, idx) => (
                          <tr class="hover:bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] last:border-b-0">
                            <td class="px-3 py-1.5 text-[var(--ink-muted)]">#{idx() + 1}</td>
                            <td class="px-3 py-1.5 text-[var(--ink-primary)] font-semibold">{row.modelId}</td>
                            <td class="px-3 py-1.5 text-[var(--accent-amber)] font-bold">{Math.round(row.elo)}</td>
                            <td class="px-3 py-1.5 text-[var(--ink-secondary)]">
                              {row.wins} / {row.losses} / {row.ties}
                            </td>
                            <td class="px-3 py-1.5 min-w-[120px]">
                              <div class="flex items-center gap-2">
                                <div class="flex-1 h-1.5 rounded bg-[var(--bg-canvas)] overflow-hidden border border-[var(--border-subtle)]">
                                  <div
                                    class="h-full bg-[var(--status-emerald)]"
                                    style={{ width: `${Math.max(0, Math.min(100, row.winRatePct))}%` }}
                                  />
                                </div>
                                <span class="text-[var(--ink-primary)] w-11 text-right">
                                  {row.winRatePct.toFixed(1)}%
                                </span>
                              </div>
                            </td>
                            <td class="px-3 py-1.5 text-[var(--ink-secondary)]">{formatMs(row.avgTtftMs)}</td>
                            <td class="px-3 py-1.5 text-[var(--ink-secondary)]">
                              {row.avgCostUsd !== null ? formatCost6(row.avgCostUsd) : '—'}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </div>
            </div>
          </section>

          {/* RIGHT INSPECTOR — Parameter Lab + Structured Output + Gems/Personas + Get Code */}
          <aside
            data-testid="arena-right-inspector"
            class="w-full xl:w-[390px] 2xl:w-[420px] shrink-0 border-t xl:border-t-0 xl:border-l border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col min-w-0 xl:min-h-0"
          >
            {/* Inspector Sub-Tabs */}
            <div class="p-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] min-w-0">
              <div class="omp-segmented w-full flex flex-wrap justify-between">
                <button
                  type="button"
                  aria-pressed={inspectorTab() === 'params'}
                  onClick={() => setInspectorTab('params')}
                  class="flex-1 !px-2 !py-1 !text-[11px] inline-flex items-center justify-center gap-1"
                >
                  <SlidersHorizontal class="w-3 h-3" />
                  <span>Params</span>
                </button>
                <button
                  type="button"
                  aria-pressed={inspectorTab() === 'schema'}
                  onClick={() => setInspectorTab('schema')}
                  class="flex-1 !px-2 !py-1 !text-[11px] inline-flex items-center justify-center gap-1"
                >
                  <Braces class="w-3 h-3" />
                  <span>Schema</span>
                </button>
                <button
                  type="button"
                  aria-pressed={inspectorTab() === 'personas'}
                  onClick={() => setInspectorTab('personas')}
                  class="flex-1 !px-2 !py-1 !text-[11px] inline-flex items-center justify-center gap-1"
                >
                  <Sparkles class="w-3 h-3" />
                  <span>Gems ({personas().length})</span>
                </button>
                <button
                  type="button"
                  aria-pressed={inspectorTab() === 'code'}
                  onClick={() => setInspectorTab('code')}
                  class="flex-1 !px-2 !py-1 !text-[11px] inline-flex items-center justify-center gap-1"
                >
                  <Terminal class="w-3 h-3" />
                  <span>Code</span>
                </button>
              </div>
            </div>

            <div class="flex-1 min-w-0 xl:min-h-0 xl:overflow-y-auto p-3 space-y-3">
              {/* TAB 1: Parameter Lab + Pre-Send Cost Estimator */}
              <Show when={inspectorTab() === 'params'}>
                <div class="omnia-surface-panel rounded-lg p-3 space-y-3 min-w-0">
                  <div class="flex items-center justify-between gap-2">
                    <label class="text-[11.5px] font-semibold text-[var(--ink-primary)]" for="arena-sys-prompt">
                      System Instructions
                    </label>
                    <div class="flex items-center gap-1.5 text-[10.5px] font-mono-num text-[var(--ink-muted)]">
                      <span>~{estimateTokensApprox(systemPrompt())} tok</span>
                      <Show when={systemPrompt().length > 0}>
                        <button
                          type="button"
                          class="text-[var(--accent-cyan)] hover:underline cursor-pointer"
                          onClick={() => setSystemPrompt('')}
                        >
                          Clear
                        </button>
                      </Show>
                    </div>
                  </div>
                  <textarea
                    id="arena-sys-prompt"
                    rows={4}
                    value={systemPrompt()}
                    onInput={(e) => setSystemPrompt(e.currentTarget.value)}
                    placeholder="Define tone, constraints, formatting rules, or specialist persona instructions..."
                    class="w-full min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded p-2 text-[12px] text-[var(--ink-primary)] outline-none focus:border-[var(--border-accent)] resize-y"
                  />

                  {/* Temperature */}
                  <div class="space-y-1">
                    <div class="flex items-center justify-between text-[11.5px]">
                      <span class="text-[var(--ink-secondary)]">Temperature</span>
                      <span class="font-mono-num text-[var(--accent-cyan)] font-semibold">
                        {temperature().toFixed(2)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.05"
                      value={temperature()}
                      onInput={(e) => setTemperature(Number(e.currentTarget.value))}
                      class="w-full accent-[var(--accent-cyan)]"
                    />
                  </div>

                  {/* Top-P */}
                  <div class="space-y-1">
                    <div class="flex items-center justify-between text-[11.5px]">
                      <span class="text-[var(--ink-secondary)]">Top-P</span>
                      <span class="font-mono-num text-[var(--accent-cyan)] font-semibold">{topP().toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={topP()}
                      onInput={(e) => setTopP(Number(e.currentTarget.value))}
                      class="w-full accent-[var(--accent-cyan)]"
                    />
                  </div>

                  {/* Max Output Tokens */}
                  <div class="space-y-1">
                    <div class="flex items-center justify-between gap-2 text-[11.5px]">
                      <span class="text-[var(--ink-secondary)]">Max Output Tokens</span>
                      <input
                        type="number"
                        min={256}
                        max={65536}
                        step={256}
                        value={maxTokens()}
                        onInput={(e) => {
                          const v = Number(e.currentTarget.value);
                          if (Number.isFinite(v)) setMaxTokens(Math.max(256, Math.min(65536, v)));
                        }}
                        class="w-24 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2 py-0.5 text-right text-[11.5px] font-mono-num text-[var(--ink-primary)]"
                      />
                    </div>
                    <input
                      type="range"
                      min="256"
                      max="65536"
                      step="256"
                      value={maxTokens()}
                      onInput={(e) => setMaxTokens(Number(e.currentTarget.value))}
                      class="w-full accent-[var(--accent-cyan)]"
                    />
                  </div>

                  {/* Stop Sequences */}
                  <div class="space-y-1.5">
                    <div class="text-[11.5px] text-[var(--ink-secondary)]">Stop Sequences</div>
                    <div class="flex items-center gap-1.5 min-w-0">
                      <input
                        type="text"
                        value={stopSeqDraft()}
                        onInput={(e) => setStopSeqDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addStopSequence();
                          }
                        }}
                        placeholder="e.g. END_JSON, ###"
                        class="flex-1 min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11.5px] font-mono-num text-[var(--ink-primary)] outline-none focus:border-[var(--border-accent)]"
                      />
                      <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={addStopSequence}>
                        Add
                      </button>
                    </div>
                    <Show when={stopSequences().length > 0}>
                      <div class="flex flex-wrap gap-1">
                        <For each={stopSequences()}>
                          {(seq) => (
                            <span class="omnia-badge font-mono-num">
                              <span>{seq}</span>
                              <button
                                type="button"
                                class="cursor-pointer hover:text-[var(--status-coral)]"
                                onClick={() => setStopSequences(stopSequences().filter((s) => s !== seq))}
                              >
                                <X class="w-3 h-3" />
                              </button>
                            </span>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>

                {/* Live Pre-Send Token & 6-Decimal USD Estimator */}
                <div data-testid="arena-cost-estimator" class="omnia-surface-panel rounded-lg p-3 space-y-2.5 min-w-0">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-[12px] font-semibold text-[var(--ink-primary)]">
                      Pre-Send Token &amp; Cost Estimator
                    </span>
                    <span
                      class="omnia-badge font-mono-num text-[10px]"
                      classList={{
                        'text-[var(--status-emerald)]': activeEstimate().source === 'live',
                        'text-[var(--accent-cyan)]': activeEstimate().source === 'local',
                      }}
                    >
                      {activeEstimate().source === 'live' ? 'LIVE API' : 'LOCAL EST.'}
                    </span>
                  </div>
                  <div class="grid grid-cols-3 gap-1.5 text-center font-mono-num">
                    <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-1.5">
                      <div class="text-[10px] text-[var(--ink-muted)]">Input Tok</div>
                      <div class="text-[12.5px] font-bold text-[var(--ink-primary)]">
                        {activeEstimate().inputTokens}
                      </div>
                    </div>
                    <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-1.5">
                      <div class="text-[10px] text-[var(--ink-muted)]">Est. Out</div>
                      <div class="text-[12.5px] font-bold text-[var(--ink-primary)]">
                        {activeEstimate().estimatedOutputTokens}
                      </div>
                    </div>
                    <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-1.5">
                      <div class="text-[10px] text-[var(--ink-muted)]">Total USD</div>
                      <div class="text-[12.5px] font-bold text-[var(--accent-amber)]">
                        {formatCost6(activeEstimate().totalEstimatedUsd)}
                      </div>
                    </div>
                  </div>
                  <div class="space-y-1.5">
                    <For each={activeEstimate().perModel}>
                      {(m) => (
                        <div class="px-2 py-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 text-[11px] font-mono-num min-w-0">
                          <div class="min-w-0 truncate">
                            <span class="text-[var(--ink-primary)] font-semibold">{shortModelLabel(m.modelId)}</span>
                            <span class="text-[var(--ink-muted)] ml-1.5">
                              {m.contextFillPct.toFixed(2)}% ctx
                            </span>
                          </div>
                          <span class="text-[var(--accent-amber)] shrink-0">
                            {formatCost6(m.estimatedTotalUsd)}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* TAB 2: JSON Structured Output Schema Editor */}
              <Show when={inspectorTab() === 'schema'}>
                <div class="omnia-surface-panel rounded-lg p-3 space-y-2.5 min-w-0">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-[12px] font-semibold text-[var(--ink-primary)]">JSON Structured Output</span>
                    <button
                      type="button"
                      data-testid="arena-schema-toggle"
                      aria-pressed={schemaEnabled()}
                      onClick={() => setSchemaEnabled((v) => !v)}
                      class="omnia-btn px-2.5 py-1 text-[11px] font-mono-num"
                      classList={{
                        'omnia-btn-primary': schemaEnabled(),
                      }}
                    >
                      {schemaEnabled() ? 'ON' : 'OFF'}
                    </button>
                  </div>

                  <div class="flex flex-wrap items-center gap-1">
                    <For each={SCHEMA_TEMPLATES}>
                      {(tpl) => (
                        <button
                          type="button"
                          onClick={() => {
                            setSchemaText(tpl.schema);
                            setSchemaEnabled(true);
                          }}
                          class="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:border-[var(--border-accent)] text-[11px] text-[var(--ink-secondary)] cursor-pointer"
                        >
                          {tpl.label}
                        </button>
                      )}
                    </For>
                  </div>

                  <div class="flex items-center justify-between gap-2 text-[11px] font-mono-num">
                    <Show
                      when={parsedSchema().valid}
                      fallback={
                        <span class="text-[var(--status-coral)] flex items-center gap-1 min-w-0 truncate">
                          <AlertTriangle class="w-3.5 h-3.5 shrink-0" />
                          <span class="truncate">{parsedSchema().error}</span>
                        </span>
                      }
                    >
                      <span class="text-[var(--status-emerald)] flex items-center gap-1">
                        <CheckCircle2 class="w-3.5 h-3.5 shrink-0" />
                        <span>Valid JSON Schema</span>
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="text-[var(--accent-cyan)] hover:underline cursor-pointer shrink-0"
                      onClick={() => {
                        if (parsedSchema().obj) {
                          setSchemaText(JSON.stringify(parsedSchema().obj, null, 2));
                        }
                      }}
                    >
                      Format
                    </button>
                  </div>

                  <textarea
                    data-testid="arena-schema-editor"
                    rows={14}
                    spellcheck={false}
                    value={schemaText()}
                    onInput={(e) => setSchemaText(e.currentTarget.value)}
                    class="w-full min-w-0 bg-[var(--bg-code)] border border-[var(--border-subtle)] rounded p-2.5 text-[11.5px] font-mono-num text-[var(--ink-primary)] outline-none focus:border-[var(--border-accent)] resize-y leading-relaxed"
                  />
                </div>
              </Show>

              {/* TAB 3: Omnia Gems / Personas CRUD */}
              <Show when={inspectorTab() === 'personas'}>
                <div class="space-y-3 min-w-0">
                  <div class="omnia-surface-panel rounded-lg p-3 space-y-2 min-w-0">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-[12px] font-semibold text-[var(--ink-primary)]">Omnia Gems / Personas</span>
                      <button
                        type="button"
                        class="omnia-btn px-2 py-0.5 text-[10.5px]"
                        disabled={personasLoading()}
                        onClick={() => void loadPersonas()}
                      >
                        <RefreshCw class="w-3 h-3" classList={{ 'animate-spin': personasLoading() }} />
                      </button>
                    </div>
                    <Show
                      when={personas().length > 0}
                      fallback={
                        <div class="text-[11.5px] text-[var(--ink-muted)]">
                          No personas loaded yet. Create your first specialist Gem below.
                        </div>
                      }
                    >
                      <div class="space-y-2 max-h-64 overflow-y-auto pr-0.5">
                        <For each={personas()}>
                          {(p) => (
                            <div
                              class="rounded border p-2.5 bg-[var(--bg-canvas)] space-y-1.5 min-w-0"
                              classList={{
                                'border-[var(--accent-cyan)]': activePersonaId() === p.id,
                                'border-[var(--border-subtle)]': activePersonaId() !== p.id,
                              }}
                            >
                              <div class="flex items-start justify-between gap-2 min-w-0">
                                <div class="min-w-0">
                                  <div class="flex items-center gap-1.5 min-w-0">
                                    <span class="omnia-badge text-[10px] font-mono-num text-[var(--accent-amber)] shrink-0">
                                      {p.icon}
                                    </span>
                                    <span class="font-semibold text-[12px] text-[var(--ink-primary)] truncate">
                                      {p.name}
                                    </span>
                                  </div>
                                  <Show when={p.description}>
                                    <div class="text-[11px] text-[var(--ink-muted)] mt-0.5 line-clamp-2">
                                      {p.description}
                                    </div>
                                  </Show>
                                </div>
                                <div class="flex items-center gap-1 shrink-0">
                                  <button
                                    type="button"
                                    title="Apply Gem to Arena"
                                    class="omnia-btn omnia-btn-primary px-2 py-0.5 text-[10.5px]"
                                    onClick={() => applyPersona(p)}
                                  >
                                    <Wand2 class="w-3 h-3" />
                                    <span>Apply</span>
                                  </button>
                                  <button
                                    type="button"
                                    title="Edit Gem"
                                    class="omnia-btn px-1.5 py-0.5"
                                    onClick={() => startEditPersona(p)}
                                  >
                                    <Edit3 class="w-3 h-3" />
                                  </button>
                                  <button
                                    type="button"
                                    title="Delete Gem"
                                    class="omnia-btn omnia-btn-danger px-1.5 py-0.5"
                                    onClick={() => void deletePersona(p)}
                                  >
                                    <Trash2 class="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                              <div class="flex flex-wrap items-center gap-1 text-[10px] font-mono-num text-[var(--ink-muted)]">
                                <span class="omnia-badge">{shortModelLabel(p.modelId)}</span>
                                <span class="omnia-badge">{p.effort}</span>
                                <span class="omnia-badge">T={p.temperature.toFixed(2)}</span>
                                <span class="omnia-badge uppercase">{p.focusMode}</span>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>

                  {/* Create / Edit Gem Form */}
                  <div class="omnia-surface-panel rounded-lg p-3 space-y-2 min-w-0">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-[12px] font-semibold text-[var(--ink-primary)]">
                        {editingPersonaId() ? 'Edit Gem / Persona' : 'Create New Gem'}
                      </span>
                      <Show when={editingPersonaId()}>
                        <button
                          type="button"
                          class="text-[11px] text-[var(--accent-cyan)] hover:underline cursor-pointer"
                          onClick={resetPersonaForm}
                        >
                          Cancel Edit
                        </button>
                      </Show>
                    </div>

                    <div class="grid grid-cols-3 gap-1.5 min-w-0">
                      <input
                        type="text"
                        value={pName()}
                        onInput={(e) => setPName(e.currentTarget.value)}
                        placeholder="Gem name..."
                        class="col-span-2 min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11.5px] text-[var(--ink-primary)] outline-none focus:border-[var(--border-accent)]"
                      />
                      <select
                        value={pIcon()}
                        onChange={(e) => setPIcon(e.currentTarget.value)}
                        class="min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-1.5 py-1 text-[11px] font-mono-num text-[var(--ink-primary)]"
                      >
                        <For each={PERSONA_ICONS}>{(ic) => <option value={ic}>{ic}</option>}</For>
                      </select>
                    </div>

                    <input
                      type="text"
                      value={pDesc()}
                      onInput={(e) => setPDesc(e.currentTarget.value)}
                      placeholder="Short specialty description..."
                      class="w-full min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11.5px] text-[var(--ink-primary)] outline-none focus:border-[var(--border-accent)]"
                    />

                    <div class="grid grid-cols-2 gap-1.5 min-w-0">
                      <select
                        value={pModel()}
                        onChange={(e) => setPModel(e.currentTarget.value)}
                        class="min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-1.5 py-1 text-[11px] font-mono-num text-[var(--ink-primary)]"
                      >
                        <For each={catalogEntries()}>
                          {(m) => <option value={m.spec}>{m.name}</option>}
                        </For>
                      </select>
                      <select
                        value={pEffort()}
                        onChange={(e) => setPEffort(e.currentTarget.value as EffortLevel)}
                        class="min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-1.5 py-1 text-[11px] font-mono-num text-[var(--ink-primary)]"
                      >
                        <For each={EFFORT_LEVELS}>{(e) => <option value={e}>effort: {e}</option>}</For>
                      </select>
                    </div>

                    <div class="grid grid-cols-2 gap-1.5 min-w-0">
                      <label class="flex items-center justify-between gap-1 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] font-mono-num">
                        <span class="text-[var(--ink-muted)]">Temp</span>
                        <input
                          type="number"
                          min="0"
                          max="2"
                          step="0.05"
                          value={pTemp()}
                          onInput={(e) => setPTemp(Number(e.currentTarget.value))}
                          class="w-14 bg-transparent text-right text-[var(--ink-primary)] outline-none"
                        />
                      </label>
                      <select
                        value={pFocus()}
                        onChange={(e) => setPFocus(e.currentTarget.value as PersonaFocusMode)}
                        class="min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-1.5 py-1 text-[11px] font-mono-num text-[var(--ink-primary)]"
                      >
                        <For each={FOCUS_MODES}>{(f) => <option value={f}>focus: {f}</option>}</For>
                      </select>
                    </div>

                    <textarea
                      rows={4}
                      value={pSystem()}
                      onInput={(e) => setPSystem(e.currentTarget.value)}
                      placeholder="System instructions for this specialist Gem..."
                      class="w-full min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded p-2 text-[11.5px] text-[var(--ink-primary)] outline-none focus:border-[var(--border-accent)] resize-y"
                    />

                    <button
                      type="button"
                      disabled={savingPersona() || !pName().trim()}
                      onClick={() => void savePersona()}
                      class="omnia-btn omnia-btn-primary w-full justify-center text-[11.5px]"
                    >
                      <Save class="w-3.5 h-3.5" />
                      <span>{savingPersona() ? 'Saving...' : editingPersonaId() ? 'Update Gem' : 'Save Gem'}</span>
                    </button>
                  </div>
                </div>
              </Show>

              {/* TAB 4: Get Code Inspector Tab */}
              <Show when={inspectorTab() === 'code'}>
                <div class="omnia-surface-panel rounded-lg p-3 min-w-0">{renderCodePanelBody()}</div>
              </Show>
            </div>
          </aside>
        </div>
      </div>

      {/* Integrated Artifact Canvas Drawer for opening Arena answers directly */}
      <ArtifactCanvasDrawer
        open={canvasOpen()}
        artifact={canvasArtifact()}
        onClose={() => setCanvasOpen(false)}
        onUpdateContent={(nextContent, label) => {
          const cur = canvasArtifact();
          if (!cur) return;
          const prevVersions =
            cur.versions && cur.versions.length > 0
              ? cur.versions
              : [{ label: 'Initial', content: cur.content, ts: Date.now() - 1000 }];
          setCanvasArtifact({
            ...cur,
            content: nextContent,
            versions: [...prevVersions, { label: label || `Edit v${prevVersions.length + 1}`, content: nextContent, ts: Date.now() }],
          });
        }}
        onAskRefine={(instruction, currentContent) => {
          setPrompt(
            `Refine the following ${canvasArtifact()?.kind || 'artifact'} according to this instruction: ${instruction}\n\n\`\`\`${canvasArtifact()?.language || canvasArtifact()?.kind || ''}\n${currentContent}\n\`\`\``,
          );
          setCanvasOpen(false);
          flashNotice('Loaded Canvas refinement prompt into Arena — press Run Parallel Arena');
        }}
      />

      {/* 1-Click "Get Code" Modal */}
      <Show when={codeModalOpen()}>
        <div
          data-testid="arena-get-code-modal"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCodeModalOpen(false);
          }}
        >
          <div class="omnia-surface-panel rounded-lg w-full max-w-3xl max-h-[86vh] flex flex-col overflow-hidden shadow-[var(--shadow-md)]">
            <div class="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <Code2 class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
                <span class="font-semibold text-[13px] text-[var(--ink-primary)] truncate">
                  Get Code — Live AI Studio Request Snippets
                </span>
              </div>
              <button type="button" class="omnia-btn px-1.5 py-1" onClick={() => setCodeModalOpen(false)}>
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
            <div class="p-4 overflow-y-auto min-w-0">{renderCodePanelBody()}</div>
          </div>
        </div>
      </Show>
    </div>
  );
}
