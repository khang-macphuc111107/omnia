import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import {
  ArrowRight,
  Blocks,
  Brain,
  CheckCircle2,
  Database,
  Eye,
  Gauge,
  GitBranch,
  Layers,
  Pin,
  Play,
  Plus,
  Plug,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Trash2,
  Wrench,
} from 'lucide-solid';
import { api } from '@/api/client';
import { flashNotice, openCitationSource, openSourcePreview, privacyMask } from '@/state/studio';
import { sha256HexSync } from '@/utils/crypto';
import { maskJson, maskText } from '@/utils/privacy';

type KnowledgeTab = 'memory' | 'rag' | 'skills_vault' | 'extensions';

interface DagStageView {
  stage: string;
  label: string;
  skills: string[];
  purpose: string;
}

const BILINGUAL_SKILL_EXAMPLES = [
  'kiểm chứng bảo mật + sha256',
  'tải xuống đa luồng range hls',
  'nghiên cứu trích dẫn rag',
  'deep think falsify redteam',
  'wcag contrast ui audit',
];

const STARTUP_TOKEN_CEILING = 1000;

function formatStageLabel(stageKey: string, idx: number): string {
  const low = stageKey.toLowerCase();
  if (low.includes('preflight') || idx === 0) return 'Stage 1 · Preflight & Framing';
  if (low.includes('domain') || low.includes('execution') || idx === 1) return 'Stage 2 · Domain Execution';
  if (low.includes('verif') || idx === 2) return 'Stage 3 · Verification Gate';
  if (low.includes('receipt') || low.includes('handoff') || idx === 3) return 'Stage 4 · Receipt & Handoff';
  return stageKey;
}

export function KnowledgeExtensionsView() {
  const [tab, setTab] = createSignal<KnowledgeTab>('memory');

  // Memory Vault
  const [memories, setMemories] = createSignal<Array<Record<string, unknown>>>([]);
  const [ns, setNs] = createSignal('workspace/architecture');
  const [memKey, setMemKey] = createSignal('');
  const [memVal, setMemVal] = createSignal('');
  const [erasureReceipt, setErasureReceipt] = createSignal<Record<string, unknown> | null>(null);
  const [engineQuery, setEngineQuery] = createSignal('');
  const [engineBank, setEngineBank] = createSignal('hipporag');
  const [engineResult, setEngineResult] = createSignal<Record<string, unknown> | null>(null);
  const [memNote, setMemNote] = createSignal('');

  // Persistent Local + Global RAG Explorer
  const [ragQuery, setRagQuery] = createSignal('');
  const [ragScopeFilter, setRagScopeFilter] = createSignal<'local_global' | 'local' | 'global'>('local_global');
  const [ragTopK, setRagTopK] = createSignal(8);
  const [ragResult, setRagResult] = createSignal<Record<string, unknown> | null>(null);
  const [ragSources, setRagSources] = createSignal<Array<Record<string, unknown>>>([]);
  const [ragStatus, setRagStatus] = createSignal('');
  const [showIngestForm, setShowIngestForm] = createSignal(false);
  const [ingestUrl, setIngestUrl] = createSignal('https://docs.example.org/spec');
  const [ingestTitle, setIngestTitle] = createSignal('');
  const [ingestTier, setIngestTier] = createSignal<'local' | 'global'>('local');
  const [ingestBody, setIngestBody] = createSignal('');

  // Hot/Cold 1,001-Skill Vault, <1,000 tok Startup Budget Gauge, Bilingual VN-EN DAG, 24 Pipelines, Doctor & Codifier
  const [dagQuery, setDagQuery] = createSignal('kiểm chứng bảo mật + rust build');
  const [dagResult, setDagResult] = createSignal<Record<string, unknown> | null>(null);
  const [routeMatches, setRouteMatches] = createSignal<Array<Record<string, unknown>>>([]);
  const [vaultQuery, setVaultQuery] = createSignal('');
  const [vaultTierFilter, setVaultTierFilter] = createSignal<'all' | 'hot' | 'cold'>('all');
  const [vaultItems, setVaultItems] = createSignal<Array<Record<string, unknown>>>([]);
  const [vaultTotal, setVaultTotal] = createSignal<number>(0);
  const [pipelines, setPipelines] = createSignal<Array<Record<string, unknown>>>([]);
  const [pipelineFilter, setPipelineFilter] = createSignal('');
  const [doctorResult, setDoctorResult] = createSignal<Record<string, unknown> | null>(null);
  const [codifySlug, setCodifySlug] = createSignal('');
  const [codifyDesc, setCodifyDesc] = createSignal('Use when ');
  const [codifyCategory, setCodifyCategory] = createSignal('engineering');
  const [codifyBody, setCodifyBody] = createSignal('');
  const [codifyResult, setCodifyResult] = createSignal<Record<string, unknown> | null>(null);
  const [vaultNote, setVaultNote] = createSignal('');

  // 22/22 Curated Skills, MCP, Hooks, Recipes, Cordis
  const [skillQuery, setSkillQuery] = createSignal('');
  const [skills, setSkills] = createSignal<Array<Record<string, unknown>>>([]);
  const [mcpServers, setMcpServers] = createSignal<Array<Record<string, unknown>>>([]);
  const [mcpName, setMcpName] = createSignal('');
  const [mcpEndpoint, setMcpEndpoint] = createSignal('');
  const [mcpToolQuery, setMcpToolQuery] = createSignal('');
  const [hooks, setHooks] = createSignal<Array<Record<string, unknown>>>([]);
  const [recipes, setRecipes] = createSignal<Array<Record<string, unknown>>>([]);
  const [cordis, setCordis] = createSignal<Array<Record<string, unknown>>>([]);
  const [extPreview, setExtPreview] = createSignal<Record<string, unknown> | null>(null);
  const [extNote, setExtNote] = createSignal('');

  const ragStats = createMemo(() => {
    const list = ragSources();
    let local = 0;
    let global = 0;
    let extracted = 0;
    let blocked = 0;
    for (const s of list) {
      const tier = String(s.tier ?? 'local').toLowerCase();
      if (tier === 'global') global += 1;
      else local += 1;
      const st = String(s.stage ?? s.status ?? 'extracted').toLowerCase();
      if (st === 'extracted') extracted += 1;
      if (st === 'blocked' || st === 'auth_required') blocked += 1;
    }
    return { total: list.length, local, global, extracted, blocked };
  });

  const ragHits = createMemo(() => {
    const r = ragResult();
    if (!r || r.error) return [];
    const list = (r.hits ?? r.results ?? r.chunks ?? []) as Array<Record<string, unknown>>;
    return Array.isArray(list) ? list : [];
  });

  const startupBudget = createMemo(() => {
    const d = doctorResult();
    const docObj = (d && typeof d.report === 'object' ? (d.report as Record<string, unknown>) : d) ?? {};
    const activeSkillsCount = Number(
      docObj.totalSkills ?? docObj.total_skills ?? skills().length ?? 22,
    );
    const coldCount = Number(
      docObj.coldVaultCount ?? docObj.cold_vault_count ?? (vaultTotal() || 1001),
    );
    const estimatedTok = Number(
      docObj.startupTokensEst ??
        docObj.startup_tokens_est ??
        skills().reduce((acc, sk) => acc + Math.max(12, Number(sk.frontmatter_tokens ?? sk.frontmatterTokens ?? 32)), 0),
    );
    const merkle = String(docObj.merkleRootSha256 ?? docObj.merkle_root_sha256 ?? '');
    const pct = Math.min(100, (estimatedTok / STARTUP_TOKEN_CEILING) * 100);
    return {
      activeSkillsCount,
      coldCount,
      estimatedTok,
      pct,
      underBudget: estimatedTok <= STARTUP_TOKEN_CEILING,
      merkle,
      findingsCount: Array.isArray(docObj.findings) ? docObj.findings.length : 0,
    };
  });

  const parsedDagStages = createMemo<DagStageView[]>(() => {
    const r = dagResult();
    if (!r || r.error) return [];
    const inner = (r.dag && typeof r.dag === 'object' ? (r.dag as Record<string, unknown>) : r) as Record<
      string,
      unknown
    >;
    const raw = inner.stages;
    if (!Array.isArray(raw)) return [];
    return (raw as Array<Record<string, unknown>>).map((s, idx) => {
      const key = String(s.stage ?? s.id ?? `stage_${idx + 1}`);
      return {
        stage: key,
        label: formatStageLabel(key, idx),
        skills: Array.isArray(s.skills) ? (s.skills as unknown[]).map(String) : [],
        purpose: String(s.purpose ?? s.description ?? ''),
      };
    });
  });

  const filteredVaultItems = createMemo(() => {
    const tf = vaultTierFilter();
    return vaultItems().filter((item) => {
      const isHot = String(item.tier ?? item.mount ?? (item.hot ? 'hot' : 'cold')).toLowerCase() === 'hot';
      if (tf === 'hot') return isHot;
      if (tf === 'cold') return !isHot;
      return true;
    });
  });

  const filteredPipelines = createMemo(() => {
    const q = pipelineFilter().trim().toLowerCase();
    if (!q) return pipelines();
    return pipelines().filter((p) => {
      const hay = `${String(p.id ?? '')} ${String(p.title ?? p.name ?? '')} ${String(p.category ?? '')} ${String(p.description ?? '')}`.toLowerCase();
      return hay.includes(q);
    });
  });

  const loadMemories = async () => {
    const res = await api.listMemory('');
    if (res.ok && Array.isArray(res.data.entries)) setMemories(res.data.entries);
  };

  const loadRagSources = async () => {
    const tierParam = ragScopeFilter() === 'local_global' ? '' : ragScopeFilter();
    let res = await api.safeJson<Record<string, unknown>>(
      tierParam ? `/api/v5/rag/sources?tier=${encodeURIComponent(tierParam)}` : '/api/v5/rag/sources',
    );
    if (!res.ok) {
      res = await api.listResearchSources(tierParam);
    }
    if (res.ok) {
      const list = (res.data.sources ?? res.data.items ?? []) as Array<Record<string, unknown>>;
      if (Array.isArray(list)) setRagSources(list);
    }
  };

  const loadSkillVaultData = async () => {
    const [vRes, pRes, dRes] = await Promise.all([
      api.searchSkillVault(vaultQuery(), 40),
      api.listSkillPipelines(),
      api.runSkillDoctor(),
    ]);
    if (vRes.ok) {
      const rawCold = (vRes.data.vaultMatches ?? vRes.data.entries ?? vRes.data.skills ?? vRes.data.items ?? vRes.data.results ?? []) as Array<
        Record<string, unknown>
      >;
      const rawHot = (vRes.data.matches ?? vRes.data.activeSkills ?? []) as Array<Record<string, unknown>>;
      const combined: Array<Record<string, unknown>> = [];
      for (const h of rawHot) {
        const sk = (h.skill && typeof h.skill === 'object' ? (h.skill as Record<string, unknown>) : h);
        combined.push({ ...sk, tier: 'hot', score: h.score });
      }
      for (const c of rawCold) {
        const entry = (c.entry && typeof c.entry === 'object' ? (c.entry as Record<string, unknown>) : c);
        combined.push({ ...entry, tier: entry.tier ?? 'cold', score: c.score });
      }
      setVaultItems(combined);
      setVaultTotal(
        Number(vRes.data.vaultTotal ?? vRes.data.totalCount ?? vRes.data.total ?? combined.length),
      );
    }
    if (pRes.ok) {
      const list = (pRes.data.pipelines ?? pRes.data.items ?? []) as Array<Record<string, unknown>>;
      setPipelines(Array.isArray(list) ? list : []);
    }
    if (dRes.ok) {
      setDoctorResult(dRes.data);
    }
  };

  const loadExtensions = async () => {
    const [sk, mcp, hk, rc, cd] = await Promise.all([
      api.listSkills(skillQuery()),
      api.listMcp(),
      api.listHooks(),
      api.listRecipes(),
      api.listCordis(),
    ]);
    if (sk.ok && Array.isArray(sk.data.skills)) setSkills(sk.data.skills);
    if (mcp.ok) {
      const list = (mcp.data.servers ?? mcp.data.items ?? []) as Array<Record<string, unknown>>;
      setMcpServers(Array.isArray(list) ? list : []);
    }
    if (hk.ok) {
      const list = (hk.data.hooks ?? hk.data.events ?? hk.data.items ?? []) as Array<Record<string, unknown>>;
      setHooks(Array.isArray(list) ? list : []);
    }
    if (rc.ok) {
      const list = (rc.data.recipes ?? rc.data.items ?? []) as Array<Record<string, unknown>>;
      setRecipes(Array.isArray(list) ? list : []);
    }
    if (cd.ok) {
      const list = (cd.data.plugins ?? cd.data.items ?? []) as Array<Record<string, unknown>>;
      setCordis(Array.isArray(list) ? list : []);
    }
  };

  onMount(() => {
    void loadMemories();
    void loadExtensions();
  });

  const switchTab = (next: KnowledgeTab) => {
    setTab(next);
    if (next === 'rag') void loadRagSources();
    if (next === 'skills_vault') {
      void loadSkillVaultData();
      if (!dagResult() && dagQuery().trim()) void handleComposeDag();
    }
  };

  const handleUpsert = async () => {
    if (!memKey().trim() || !memVal().trim()) return;
    const res = await api.upsertMemory(ns().trim(), memKey().trim(), memVal().trim());
    if (res.ok) {
      setMemKey('');
      setMemVal('');
      setMemNote('Memory entry persisted');
      await loadMemories();
    } else {
      setMemNote(`Upsert error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleErase = async (m: Record<string, unknown>) => {
    const k = String(m.key ?? '');
    const n = String(m.namespace ?? ns());
    const v = String(m.value ?? m.content ?? '');
    const digest = sha256HexSync(`${n}:${k}:${v}`);
    const res = await api.eraseMemory(n, k, digest);
    if (res.ok) {
      setErasureReceipt(res.data);
      setMemNote(`Cryptographically erased ${n}/${k}`);
      await loadMemories();
    } else {
      setMemNote(`Erase error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleMemoryOp = async (op: 'retain' | 'recall' | 'reflect') => {
    const q = engineQuery().trim();
    if (!q) return;
    const res =
      op === 'retain'
        ? await api.retainMemory(engineBank(), q, [engineBank()])
        : op === 'recall'
          ? await api.recallMemory(q, 8)
          : await api.reflectMemory(q);
    setEngineResult(res.ok ? res.data : { error: res.error.code, message: res.error.message });
    setMemNote(res.ok ? `Memory ${op} (${engineBank()}) OK` : `${op} error (${res.error.code})`);
  };

  const handlePersistentRagQuery = async () => {
    const q = ragQuery().trim();
    if (!q) return;
    const res = await api.queryPersistentRag(q, ragScopeFilter(), ragTopK());
    setRagResult(res.ok ? res.data : { error: res.error.code, message: res.error.message });
    setRagStatus(res.ok ? `Queried Persistent RAG (${ragScopeFilter()}, top-${ragTopK()})` : `RAG error (${res.error.code})`);
    void loadRagSources();
  };

  const handleProactiveRagPlan = async () => {
    const q = ragQuery().trim();
    if (!q) return;
    const res = await api.planRag(q);
    setRagResult(res.ok ? res.data : { error: res.error.code, message: res.error.message });
    setRagStatus(res.ok ? 'Computed Bilingual Proactive RAG plan' : `Plan error (${res.error.code})`);
  };

  const handleIngestRagDoc = async () => {
    if (!ingestBody().trim()) return;
    const res = await api.ingestResearchDoc({
      url: ingestUrl().trim() || 'https://docs.example.org/note',
      title: ingestTitle().trim() || 'Manual Research Note',
      content: ingestBody().trim(),
      contentType: 'text/markdown',
      tier: ingestTier(),
      queryOrigin: 'knowledge_workbench',
    });
    if (res.ok) {
      setIngestTitle('');
      setIngestBody('');
      setShowIngestForm(false);
      setRagStatus(`Ingested into ${ingestTier().toUpperCase()} RAG vault`);
      await loadRagSources();
    } else {
      setRagStatus(`Ingest error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleComposeDag = async (overrideQuery?: string) => {
    const q = (overrideQuery ?? dagQuery()).trim();
    if (!q) return;
    const [routeRes, dagRes] = await Promise.all([api.routeSkillsBilingual(q, 6), api.composeSkillDag(q)]);
    if (routeRes.ok) {
      const m = (routeRes.data.matches ?? routeRes.data.skills ?? routeRes.data.results ?? []) as Array<
        Record<string, unknown>
      >;
      setRouteMatches(Array.isArray(m) ? m : []);
    }
    if (dagRes.ok) {
      setDagResult(dagRes.data);
      setVaultNote(`Composed 4-stage bilingual DAG for "${q.slice(0, 44)}"`);
    } else {
      setDagResult({ error: dagRes.error.code, message: dagRes.error.message });
      setVaultNote(`DAG error (${dagRes.error.code})`);
    }
  };

  const handleCodifySkill = async (dryRun: boolean) => {
    if (!codifySlug().trim() || !codifyDesc().trim() || !codifyBody().trim()) return;
    const res = await api.safeJson<Record<string, unknown>>('/api/v5/skills/codify', {
      method: 'POST',
      body: JSON.stringify({
        slug: codifySlug().trim(),
        description: codifyDesc().trim(),
        category: codifyCategory().trim() || 'engineering',
        body: codifyBody().trim(),
        bodyMd: codifyBody().trim(),
        body_md: codifyBody().trim(),
        dryRun,
        dry_run: dryRun,
      }),
    });
    setCodifyResult(res.ok ? res.data : { error: res.error.code, message: res.error.message });
    setVaultNote(res.ok ? `Skill ${codifySlug()} (${dryRun ? 'dry-run validated' : 'codified'})` : `Codify (${res.error.code})`);
    if (res.ok && !dryRun) {
      void loadSkillVaultData();
      void loadExtensions();
    }
  };

  const activeSkillCount = createMemo(() => skills().length || 22);

  return (
    <div data-testid="knowledge-workbench" class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
      <div class="px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2">
        <div class="omp-segmented flex-wrap text-[12px]">
          <button type="button" aria-pressed={tab() === 'memory'} onClick={() => switchTab('memory')}>
            Memory (HippoRAG / ASI06)
          </button>
          <button type="button" aria-pressed={tab() === 'rag'} onClick={() => switchTab('rag')}>
            Persistent RAG (Local+Global)
          </button>
          <button type="button" aria-pressed={tab() === 'skills_vault'} onClick={() => switchTab('skills_vault')}>
            1,001-Skill Vault & 4-Stage DAG
          </button>
          <button type="button" aria-pressed={tab() === 'extensions'} onClick={() => switchTab('extensions')}>
            {activeSkillCount()} Skills · MCP · 25 Hooks · Recipes · Cordis
          </button>
        </div>
        <span class="omnia-badge text-[var(--status-emerald)] font-mono-num text-[11px]">
          Skills Parity: {activeSkillCount()}/{Math.max(activeSkillCount(), 22)}
        </span>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto p-4">
        {/* TAB 1: Memory Vault + HippoRAG / Graphiti / Hindsight / ACE + ASI06 */}
        <Show when={tab() === 'memory'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
              <div class="flex items-center justify-between gap-2">
                <div class="font-bold text-[13.5px] flex items-center gap-2">
                  <Database class="w-4 h-4 text-[var(--accent-cyan)]" />
                  <span>Containment-Guarded MemoryGraph</span>
                </div>
                <span class="omnia-badge text-[var(--accent-amber)] text-[10.5px]">
                  <ShieldAlert class="w-3 h-3" />
                  <span>ASI06 Guard Active</span>
                </span>
              </div>

              <div class="grid grid-cols-2 gap-2 text-[12px]">
                <input
                  type="text"
                  placeholder="Namespace"
                  value={ns()}
                  onInput={(e) => setNs(e.currentTarget.value)}
                  class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5"
                />
                <input
                  type="text"
                  placeholder="Key"
                  value={memKey()}
                  onInput={(e) => setMemKey(e.currentTarget.value)}
                  class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5"
                />
              </div>
              <textarea
                rows={2}
                placeholder="Fact or rule content..."
                value={memVal()}
                onInput={(e) => setMemVal(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-[12px]"
              />
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] font-mono-num text-[var(--accent-cyan)]">{memNote()}</span>
                <button type="button" class="omnia-btn omnia-btn-primary text-[12px]" onClick={() => void handleUpsert()}>
                  <Plus class="w-3.5 h-3.5" />
                  <span>Upsert Memory</span>
                </button>
              </div>

              <div class="space-y-1.5 pt-2 max-h-60 overflow-y-auto">
                <For each={memories()}>
                  {(m) => (
                    <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 text-[12px]">
                      <div class="min-w-0">
                        <div class="font-mono-num font-bold text-[var(--accent-amber)]">
                          {String(m.namespace || 'default')}/{String(m.key || m.id)}
                        </div>
                        <div class="text-[var(--ink-secondary)] truncate">{String(m.value || m.content || '')}</div>
                      </div>
                      <button
                        type="button"
                        class="omnia-btn omnia-btn-danger px-2 py-1 text-[11px] shrink-0"
                        onClick={() => void handleErase(m)}
                      >
                        <Trash2 class="w-3 h-3" />
                        <span>Erase</span>
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </div>

            <div class="space-y-4 min-w-0">
              <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
                <div class="font-bold text-[13px] flex items-center gap-2">
                  <Brain class="w-4 h-4 text-[var(--accent-amber)]" />
                  <span>HippoRAG · Graphiti · Hindsight · ACE Memory Engine</span>
                </div>
                <div class="flex flex-wrap gap-2 text-[12px]">
                  <select
                    value={engineBank()}
                    onChange={(e) => setEngineBank(e.currentTarget.value)}
                    class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
                  >
                    <option value="hipporag">HippoRAG (PPR)</option>
                    <option value="graphiti">Graphiti (Temporal)</option>
                    <option value="hindsight">Hindsight (Reflect)</option>
                    <option value="ace">ACE Playbook</option>
                  </select>
                  <input
                    type="text"
                    placeholder="Fact to retain or query to recall/reflect..."
                    value={engineQuery()}
                    onInput={(e) => setEngineQuery(e.currentTarget.value)}
                    class="flex-1 min-w-[160px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1"
                  />
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <button type="button" class="omnia-btn text-[11px]" onClick={() => void handleMemoryOp('retain')}>
                    Retain
                  </button>
                  <button type="button" class="omnia-btn omnia-btn-primary text-[11px]" onClick={() => void handleMemoryOp('recall')}>
                    Recall
                  </button>
                  <button type="button" class="omnia-btn text-[11px]" onClick={() => void handleMemoryOp('reflect')}>
                    Reflect
                  </button>
                </div>
                <pre class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-40 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(
                    maskJson(
                      engineResult() ?? { hint: 'Use Retain / Recall / Reflect to inspect memory graph provenance & ASI06 quarantine.' },
                      privacyMask(),
                    ),
                    null,
                    2,
                  )}
                </pre>
              </div>

              <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
                <div class="font-bold text-[13px]">SHA-256 Cryptographic ErasureReceipt</div>
                <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-44 overflow-auto">
                  {JSON.stringify(
                    erasureReceipt() ?? { hint: 'Erase an entry to emit verifiedPlaintextFree receipt.' },
                    null,
                    2,
                  )}
                </pre>
              </div>
            </div>
          </div>
        </Show>

        {/* TAB 2: Persistent Local + Global RAG Browser ([S###]/[G###] + SHA-256 Provenance) & Proactive Planner */}
        <Show when={tab() === 'rag'}>
          <div class="space-y-4">
            {/* KPI Strip */}
            <div class="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-[11.5px]">
              <div class="omnia-surface-panel rounded-lg p-2.5">
                <div class="text-[10px] uppercase text-[var(--ink-muted)]">Indexed Sources</div>
                <div class="text-[16px] font-bold font-mono-num">{ragStats().total}</div>
              </div>
              <div class="omnia-surface-panel rounded-lg p-2.5">
                <div class="text-[10px] uppercase text-[var(--ink-muted)]">Local [S###]</div>
                <div class="text-[16px] font-bold font-mono-num text-[var(--accent-cyan)]">{ragStats().local}</div>
              </div>
              <div class="omnia-surface-panel rounded-lg p-2.5">
                <div class="text-[10px] uppercase text-[var(--ink-muted)]">Global [G###]</div>
                <div class="text-[16px] font-bold font-mono-num text-[var(--status-emerald)]">{ragStats().global}</div>
              </div>
              <div class="omnia-surface-panel rounded-lg p-2.5">
                <div class="text-[10px] uppercase text-[var(--ink-muted)]">Extracted</div>
                <div class="text-[16px] font-bold font-mono-num text-[var(--status-emerald)]">{ragStats().extracted}</div>
              </div>
              <div class="omnia-surface-panel rounded-lg p-2.5">
                <div class="text-[10px] uppercase text-[var(--ink-muted)]">Blocked / Auth</div>
                <div class="text-[16px] font-bold font-mono-num text-[var(--accent-amber)]">{ragStats().blocked}</div>
              </div>
            </div>

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* Left: Hybrid BM25+RRF Query & Proactive RAG Planner */}
              <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="font-bold text-[13.5px] flex items-center gap-2">
                    <Sparkles class="w-4 h-4 text-[var(--accent-amber)]" />
                    <span>Persistent Local + Global RAG & Proactive Planner</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <select
                      value={ragScopeFilter()}
                      onChange={(e) => {
                        setRagScopeFilter(e.currentTarget.value as 'local_global' | 'local' | 'global');
                        void loadRagSources();
                      }}
                      class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
                    >
                      <option value="local_global">Local + Global</option>
                      <option value="local">Local [S###] Only</option>
                      <option value="global">Global [G###] Only</option>
                    </select>
                    <select
                      value={ragTopK()}
                      onChange={(e) => setRagTopK(Number(e.currentTarget.value))}
                      class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px] font-mono-num"
                    >
                      <option value={4}>Top 4</option>
                      <option value={8}>Top 8</option>
                      <option value={16}>Top 16</option>
                    </select>
                  </div>
                </div>

                <div class="flex flex-wrap gap-2">
                  <input
                    type="text"
                    placeholder="Query Persistent BM25+RRF RAG or uncertainty prompt (VN / EN)..."
                    value={ragQuery()}
                    onInput={(e) => setRagQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handlePersistentRagQuery();
                    }}
                    class="flex-1 min-w-[180px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12px]"
                  />
                  <button
                    type="button"
                    data-testid="rag-query-btn"
                    class="omnia-btn omnia-btn-primary text-[12px]"
                    onClick={() => void handlePersistentRagQuery()}
                  >
                    <Search class="w-3.5 h-3.5" />
                    <span>Query RAG</span>
                  </button>
                  <button type="button" class="omnia-btn text-[12px]" onClick={() => void handleProactiveRagPlan()}>
                    Plan Proactive
                  </button>
                </div>

                <Show when={ragStatus()}>
                  <div class="text-[11px] font-mono-num text-[var(--accent-cyan)]">{ragStatus()}</div>
                </Show>

                <Show when={ragHits().length > 0}>
                  <div class="space-y-2 max-h-72 overflow-y-auto">
                    <For each={ragHits()}>
                      {(hit) => {
                        const cid = String(hit.citationId ?? hit.citation_id ?? 'S001');
                        const isGlobal = cid.startsWith('G') || String(hit.tier ?? '') === 'global';
                        const rrf = Number(hit.rrfScore ?? hit.rrf_score ?? hit.score ?? 0);
                        const bm25 = Number(hit.bm25Score ?? hit.bm25_score ?? 0);
                        return (
                          <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-1 text-[11.5px]">
                            <div class="flex flex-wrap items-center justify-between gap-1.5">
                              <div class="flex items-center gap-1.5 min-w-0">
                                <button
                                  type="button"
                                  class="omnia-citation-chip"
                                  classList={{ 'omnia-cit-global': isGlobal }}
                                  onClick={() => openCitationSource(cid)}
                                >
                                  [{cid}]
                                </button>
                                <span class="font-semibold truncate">
                                  {maskText(String(hit.title ?? hit.heading ?? cid), privacyMask())}
                                </span>
                              </div>
                              <span class="omnia-badge text-[10px] font-mono-num text-[var(--status-emerald)]">
                                RRF {rrf.toFixed(3)} · BM25 {bm25.toFixed(2)}
                              </span>
                            </div>
                            <div class="text-[var(--ink-secondary)] line-clamp-2">
                              {maskText(String(hit.snippet ?? hit.excerpt ?? ''), privacyMask())}
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>

                <pre class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-56 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(
                    maskJson(
                      ragResult() ?? { hint: 'Query Local [S###] + Global [G###] SQLite WAL RAG or inspect citedSources vs unusedSources.' },
                      privacyMask(),
                    ),
                    null,
                    2,
                  )}
                </pre>
              </div>

              {/* Right: Indexed Persistent RAG Corpus + Ingest Form */}
              <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-bold text-[13px] flex items-center gap-2">
                    <Database class="w-4 h-4 text-[var(--accent-cyan)]" />
                    <span>Persistent Corpus Sources ({ragSources().length})</span>
                  </span>
                  <div class="flex gap-1.5">
                    <button
                      type="button"
                      class="omnia-btn text-[11px]"
                      onClick={() => setShowIngestForm(!showIngestForm())}
                    >
                      <Plus class="w-3 h-3" />
                      <span>Ingest Note</span>
                    </button>
                    <button type="button" class="omnia-btn text-[11px]" onClick={() => void loadRagSources()}>
                      <RefreshCw class="w-3 h-3" />
                      <span>Refresh</span>
                    </button>
                  </div>
                </div>

                <Show when={showIngestForm()}>
                  <div class="p-3 rounded border border-[var(--border-accent)] bg-[var(--bg-canvas)] space-y-2 text-[11.5px]">
                    <div class="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-1.5">
                      <input
                        type="text"
                        placeholder="Canonical URL (https://docs.example.org/...)"
                        value={ingestUrl()}
                        onInput={(e) => setIngestUrl(e.currentTarget.value)}
                        class="rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1 font-mono-num"
                      />
                      <input
                        type="text"
                        placeholder="Source title..."
                        value={ingestTitle()}
                        onInput={(e) => setIngestTitle(e.currentTarget.value)}
                        class="rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1"
                      />
                      <select
                        value={ingestTier()}
                        onChange={(e) => setIngestTier(e.currentTarget.value as 'local' | 'global')}
                        class="rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1"
                      >
                        <option value="local">Local [S###]</option>
                        <option value="global">Global [G###]</option>
                      </select>
                    </div>
                    <textarea
                      rows={3}
                      placeholder="Markdown / text content to index with SHA-256 provenance..."
                      value={ingestBody()}
                      onInput={(e) => setIngestBody(e.currentTarget.value)}
                      class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-2 font-mono-num"
                    />
                    <button type="button" class="omnia-btn omnia-btn-primary text-[11px]" onClick={() => void handleIngestRagDoc()}>
                      Index Into Persistent RAG
                    </button>
                  </div>
                </Show>

                <div class="space-y-2 max-h-[440px] overflow-y-auto">
                  <Show
                    when={ragSources().length > 0}
                    fallback={
                      <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[12px] text-[var(--ink-muted)]">
                        No persistent sources indexed yet. Run Deep Research (`/research`) or click Ingest Note to populate Local `[S###]` and Global `[G###]` chunks.
                      </div>
                    }
                  >
                    <For each={ragSources()}>
                      {(src) => {
                        const cid = String(src.citationId ?? src.citation_id ?? src.id ?? 'S001');
                        const tier = String(src.tier ?? (cid.startsWith('G') ? 'global' : 'local'));
                        const isGlobal = tier === 'global' || cid.startsWith('G');
                        const title = String(src.title ?? src.canonicalUrl ?? src.url ?? cid);
                        const sha = String(src.sha256Hex ?? src.sha256_hex ?? src.sha256 ?? '');
                        const stage = String(src.stage ?? src.status ?? 'extracted');
                        const excerpt = String(src.markdownExcerpt ?? src.markdown_excerpt ?? src.excerpt ?? src.snippet ?? '');
                        return (
                          <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-1.5 text-[11.5px]">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                              <div class="flex items-center gap-1.5 min-w-0">
                                <button
                                  type="button"
                                  class="omnia-citation-chip"
                                  classList={{ 'omnia-cit-global': isGlobal }}
                                  onClick={() => openCitationSource(cid)}
                                >
                                  [{cid}]
                                </button>
                                <span class="font-semibold truncate">{maskText(title, privacyMask())}</span>
                              </div>
                              <div class="flex flex-wrap gap-1 font-mono-num text-[9.5px]">
                                <span class="omnia-badge uppercase">{tier}</span>
                                <span
                                  class="omnia-badge"
                                  classList={{
                                    'text-[var(--status-emerald)]': stage === 'extracted',
                                    'text-[var(--accent-amber)]': stage === 'blocked' || stage === 'auth_required',
                                  }}
                                >
                                  {stage}
                                </span>
                                <Show when={sha}>
                                  <span class="omnia-badge text-[var(--status-emerald)]">
                                    <ShieldCheck class="w-2.5 h-2.5" />
                                    sha256:{sha.slice(0, 10)}
                                  </span>
                                </Show>
                              </div>
                            </div>
                            <Show when={excerpt}>
                              <div class="text-[var(--ink-secondary)] line-clamp-2">{maskText(excerpt, privacyMask())}</div>
                            </Show>
                            <div class="flex flex-wrap gap-1.5 pt-1">
                              <button
                                type="button"
                                class="omnia-btn px-2 py-0.5 text-[10.5px]"
                                onClick={() =>
                                  openSourcePreview({
                                    id: cid,
                                    name: `${cid}-${title.slice(0, 32)}.md`,
                                    kind: 'markdown',
                                    content: String(src.content ?? excerpt ?? title),
                                    sourceUrl: src.canonicalUrl ? String(src.canonicalUrl) : src.url ? String(src.url) : undefined,
                                    sha256: sha || undefined,
                                  })
                                }
                              >
                                <Eye class="w-3 h-3" />
                                <span>Preview</span>
                              </button>
                              <button
                                type="button"
                                class="omnia-btn px-2 py-0.5 text-[10.5px]"
                                onClick={async () => {
                                  const r = await api.pinRagSource(cid, 'global');
                                  flashNotice(r.ok ? `Pinned [${cid}] -> Global RAG` : `Pin (${r.error.code})`);
                                  void loadRagSources();
                                }}
                              >
                                <Pin class="w-3 h-3 text-[var(--accent-cyan)]" />
                                <span>Pin Global</span>
                              </button>
                              <button
                                type="button"
                                class="omnia-btn px-2 py-0.5 text-[10.5px]"
                                onClick={async () => {
                                  const r = await api.pinRagSource(cid, 'atelier');
                                  flashNotice(r.ok ? `Pinned [${cid}] -> Atelier Notebook` : `Pin (${r.error.code})`);
                                }}
                              >
                                <Pin class="w-3 h-3 text-[var(--accent-amber)]" />
                                <span>Pin Atelier</span>
                              </button>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* TAB 3: Hot/Cold 1,001-Skill Vault, <1,000 tok Startup Budget Gauge, 4-Stage DAG Composer, 24 Pipelines, Doctor & Codifier */}
        <Show when={tab() === 'skills_vault'}>
          <div data-testid="skill-vault-panel" class="space-y-4">
            {/* <1,000 tok Startup Budget Gauge & Merkle Attestation Strip */}
            <div data-testid="startup-token-budget-gauge" class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <div class="flex flex-wrap items-center gap-2 font-bold">
                  <Gauge class="w-4 h-4 text-[var(--accent-cyan)]" />
                  <span>Zero-Bloat Startup Token Budget Gauge (&lt;1,000 tok Ceiling)</span>
                  <span
                    class="omnia-badge font-mono-num text-[10.5px]"
                    classList={{
                      'text-[var(--status-emerald)]': startupBudget().underBudget,
                      'text-[var(--status-coral)]': !startupBudget().underBudget,
                    }}
                  >
                    {startupBudget().estimatedTok} / {STARTUP_TOKEN_CEILING} tok
                  </span>
                </div>
                <div class="flex flex-wrap items-center gap-2 text-[11px] font-mono-num">
                  <span class="omnia-badge text-[var(--status-emerald)]">Hot Active: {startupBudget().activeSkillsCount}</span>
                  <span class="omnia-badge text-[var(--accent-amber)]">Cold Vault: {startupBudget().coldCount} (0 startup tok)</span>
                  <Show when={startupBudget().merkle}>
                    <span class="omnia-badge text-[var(--accent-cyan)]">
                      Merkle: {startupBudget().merkle.slice(0, 12)}
                    </span>
                  </Show>
                </div>
              </div>
              <div class="w-full h-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-hidden">
                <div
                  class="h-full"
                  style={{
                    width: `${startupBudget().pct}%`,
                    'background-color':
                      startupBudget().estimatedTok > STARTUP_TOKEN_CEILING
                        ? 'var(--status-coral)'
                        : startupBudget().estimatedTok > 800
                          ? 'var(--accent-amber)'
                          : 'var(--status-emerald)',
                  }}
                />
              </div>
            </div>

            <Show when={vaultNote()}>
              <div class="px-3 py-1.5 rounded border border-[var(--border-accent)] bg-[var(--accent-dim)] text-[11.5px] font-mono-num text-[var(--accent-cyan)]">
                {vaultNote()}
              </div>
            </Show>

            {/* 4-Stage Execution DAG Composer (Full Width Visual Pipeline) */}
            <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="font-bold text-[13px] flex items-center gap-2">
                  <GitBranch class="w-4 h-4 text-[var(--accent-cyan)]" />
                  <span>Bilingual VN-EN BM25 Router & 4-Stage Execution DAG Composer</span>
                </div>
                <div class="flex flex-wrap gap-1">
                  <For each={BILINGUAL_SKILL_EXAMPLES}>
                    {(ex) => (
                      <button
                        type="button"
                        class="omnia-btn px-2 py-0.5 text-[10px]"
                        onClick={() => {
                          setDagQuery(ex);
                          void handleComposeDag(ex);
                        }}
                      >
                        {ex}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <div class="flex flex-wrap gap-2">
                <input
                  type="text"
                  placeholder="Query in Vietnamese or English (e.g. 'kiểm chứng bảo mật rust + wcag contrast')..."
                  value={dagQuery()}
                  onInput={(e) => setDagQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleComposeDag();
                  }}
                  class="flex-1 min-w-[220px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-[12px]"
                />
                <button
                  type="button"
                  data-testid="compose-skill-dag-btn"
                  class="omnia-btn omnia-btn-primary text-[12px]"
                  onClick={() => void handleComposeDag()}
                >
                  Compose 4-Stage DAG
                </button>
              </div>

              <Show when={routeMatches().length > 0}>
                <div class="flex flex-wrap items-center gap-1.5 text-[11px] font-mono-num">
                  <span class="text-[var(--ink-muted)]">BM25 Top Matches:</span>
                  <For each={routeMatches()}>
                    {(m) => {
                      const sk = (m.skill && typeof m.skill === 'object' ? (m.skill as Record<string, unknown>) : m);
                      return (
                        <span class="omnia-badge text-[var(--accent-cyan)]">
                          {String(sk.name ?? sk.slug ?? m.slug ?? m.id)} ({Number(m.score ?? 0).toFixed(2)})
                        </span>
                      );
                    }}
                  </For>
                </div>
              </Show>

              {/* Visual 4-Stage DAG Cards */}
              <Show
                when={parsedDagStages().length > 0}
                fallback={
                  <pre class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-40 overflow-auto whitespace-pre-wrap">
                    {JSON.stringify(
                      dagResult() ?? {
                        hint: 'Enter a Vietnamese or English query to compose stage_1_preflight -> stage_2_execution -> stage_3_verification -> stage_4_receipt_handoff.',
                      },
                      null,
                      2,
                    )}
                  </pre>
                }
              >
                <div data-testid="skill-dag-stages" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2.5">
                  <For each={parsedDagStages()}>
                    {(st, idx) => (
                      <div class="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-2 flex flex-col justify-between min-w-0">
                        <div class="space-y-1.5">
                          <div class="flex items-center justify-between gap-1">
                            <span class="text-[11px] font-bold text-[var(--accent-cyan)] truncate">{st.label}</span>
                            <Show when={idx() < parsedDagStages().length - 1}>
                              <ArrowRight class="w-3.5 h-3.5 text-[var(--ink-muted)] shrink-0" />
                            </Show>
                          </div>
                          <div class="text-[10px] font-mono-num text-[var(--ink-muted)] truncate">{st.stage}</div>
                          <div class="flex flex-wrap gap-1 pt-0.5">
                            <For each={st.skills}>
                              {(sName) => (
                                <span class="omnia-badge text-[10px] font-mono-num text-[var(--status-emerald)]">
                                  {sName}
                                </span>
                              )}
                            </For>
                          </div>
                        </div>
                        <div class="text-[11px] text-[var(--ink-secondary)] pt-1 border-t border-[var(--border-subtle)]">
                          {st.purpose}
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            {/* Hot/Cold 1,001-Skill Vault Browser + 24 Pipelines + Doctor + Codifier */}
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-bold text-[13px] flex items-center gap-2">
                    <Layers class="w-4 h-4 text-[var(--accent-amber)]" />
                    <span>Hot / Cold 1,001-Skill Vault ({vaultTotal() || vaultItems().length})</span>
                  </span>
                  <div class="flex items-center gap-1.5">
                    <select
                      value={vaultTierFilter()}
                      onChange={(e) => setVaultTierFilter(e.currentTarget.value as 'all' | 'hot' | 'cold')}
                      class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-0.5 text-[11px]"
                    >
                      <option value="all">Hot + Cold</option>
                      <option value="hot">Hot Active</option>
                      <option value="cold">Cold Vault (0 tok)</option>
                    </select>
                    <button type="button" class="omnia-btn text-[11px]" onClick={() => void loadSkillVaultData()}>
                      <RefreshCw class="w-3 h-3" />
                      <span>Sync</span>
                    </button>
                  </div>
                </div>
                <div class="flex gap-2">
                  <input
                    type="text"
                    placeholder="Bilingual VN-EN search across 1,001-skill vault (e.g. 'chunked transfer', 'bảo mật')..."
                    value={vaultQuery()}
                    onInput={(e) => setVaultQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void loadSkillVaultData();
                    }}
                    class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 text-[12px]"
                  />
                  <button type="button" class="omnia-btn text-[12px]" onClick={() => void loadSkillVaultData()}>
                    <Search class="w-3.5 h-3.5" />
                  </button>
                </div>
                <div class="space-y-1.5 max-h-64 overflow-y-auto text-[11.5px]">
                  <For each={filteredVaultItems()}>
                    {(item) => {
                      const tier = String(item.tier ?? item.mount ?? (item.hot ? 'hot' : 'cold')).toLowerCase();
                      const slug = String(item.slug ?? item.name ?? item.id ?? 'skill');
                      const desc = String(item.focus ?? item.focus_en ?? item.description ?? item.description_vi ?? item.summary ?? '');
                      const cat = String(item.category ?? item.categoryId ?? '');
                      return (
                        <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-start justify-between gap-2">
                          <div class="min-w-0 space-y-0.5">
                            <div class="flex flex-wrap items-center gap-1.5">
                              <span class="font-semibold text-[var(--accent-cyan)] truncate">{slug}</span>
                              <Show when={cat}>
                                <span class="text-[10px] font-mono-num text-[var(--ink-muted)]">[{cat}]</span>
                              </Show>
                            </div>
                            <div class="text-[11px] text-[var(--ink-muted)] line-clamp-2">{desc}</div>
                          </div>
                          <span
                            class="omnia-badge text-[10px] font-mono-num uppercase shrink-0"
                            classList={{
                              'text-[var(--status-emerald)]': tier === 'hot',
                              'text-[var(--ink-muted)]': tier !== 'hot',
                            }}
                          >
                            {tier === 'hot' ? 'HOT' : 'COLD · 0 tok'}
                          </span>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>

              {/* 24 Pre-Wired Rust-Native Pipelines */}
              <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 min-w-0 text-[11.5px]">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-bold text-[13px]">24 Pre-Wired Rust-Native Pipelines ({filteredPipelines().length})</span>
                  <input
                    type="text"
                    placeholder="Filter pipelines..."
                    value={pipelineFilter()}
                    onInput={(e) => setPipelineFilter(e.currentTarget.value)}
                    class="w-40 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-0.5 text-[11px]"
                  />
                </div>
                <div class="space-y-1.5 max-h-64 overflow-y-auto font-mono-num">
                  <For each={filteredPipelines()}>
                    {(p) => {
                      const title = String(p.title ?? p.name ?? p.id ?? 'pipeline');
                      const stageSkills = Array.isArray(p.stages)
                        ? (p.stages as Array<Record<string, unknown>>)
                            .flatMap((s) => (Array.isArray(s.skills) ? (s.skills as unknown[]).map(String) : []))
                        : Array.isArray(p.skills)
                          ? (p.skills as unknown[]).map(String)
                          : [];
                      return (
                        <button
                          type="button"
                          class="w-full text-left p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:border-[var(--border-accent)] cursor-pointer space-y-0.5"
                          onClick={() => {
                            if (Array.isArray(p.stages) && p.stages.length > 0) {
                              setDagResult({ query: title, stages: p.stages });
                              setDagQuery(title);
                              setVaultNote(`Loaded pipeline "${title}" into 4-Stage DAG viewer`);
                            } else {
                              setDagQuery(title);
                              void handleComposeDag(title);
                            }
                          }}
                        >
                          <div class="flex items-center justify-between gap-2">
                            <span class="font-semibold text-[var(--accent-cyan)] truncate">{title}</span>
                            <Show when={p.category}>
                              <span class="omnia-badge text-[9.5px]">{String(p.category)}</span>
                            </Show>
                          </div>
                          <div class="text-[10.5px] text-[var(--ink-muted)] truncate">
                            {stageSkills.length > 0 ? stageSkills.join(' -> ') : String(p.description ?? '')}
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </div>
            </div>

            {/* Skill Doctor + Quality-Gated Skill Codifier */}
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 text-[11.5px]">
              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold text-[12.5px] flex items-center gap-1.5">
                    <Stethoscope class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                    <span>Skill Doctor & SHA-256 Merkle Attestation</span>
                  </span>
                  <button
                    type="button"
                    class="omnia-btn px-2 py-0.5 text-[10.5px]"
                    onClick={async () => {
                      const r = await api.runSkillDoctor();
                      setDoctorResult(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                      setVaultNote(r.ok ? 'Skill Doctor completed' : `Doctor (${r.error.code})`);
                    }}
                  >
                    Run Doctor
                  </button>
                </div>
                <div class="flex flex-wrap gap-1.5 text-[10.5px] font-mono-num">
                  <span class="omnia-badge text-[var(--status-emerald)]">
                    <CheckCircle2 class="w-3 h-3" />
                    Findings: {startupBudget().findingsCount}
                  </span>
                  <span class="omnia-badge">Startup Est: {startupBudget().estimatedTok} tok</span>
                </div>
                <pre class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10.5px] font-mono-num max-h-44 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(
                    doctorResult() ?? { status: 'Click Run Doctor to audit SKILL.md token ceilings & SHA-256 Merkle root.' },
                    null,
                    2,
                  )}
                </pre>
              </div>

              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 min-w-0">
                <div class="font-bold text-[12.5px] flex items-center gap-1.5">
                  <Wrench class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
                  <span>Quality-Gated Skill Codifier (`Use when...` + &lt;110/&lt;3500 tok)</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  <input
                    type="text"
                    placeholder="skill-slug (lowercase kebab-case)"
                    value={codifySlug()}
                    onInput={(e) => setCodifySlug(e.currentTarget.value)}
                    class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
                  />
                  <input
                    type="text"
                    placeholder="Category (e.g. engineering)"
                    value={codifyCategory()}
                    onInput={(e) => setCodifyCategory(e.currentTarget.value)}
                    class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
                  />
                </div>
                <input
                  type="text"
                  placeholder="Use when ... (EN/VN trigger description)"
                  value={codifyDesc()}
                  onInput={(e) => setCodifyDesc(e.currentTarget.value)}
                  class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
                />
                <textarea
                  rows={2}
                  placeholder="SKILL.md 5-phase instructions..."
                  value={codifyBody()}
                  onInput={(e) => setCodifyBody(e.currentTarget.value)}
                  class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
                />
                <div class="flex gap-1.5">
                  <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={() => void handleCodifySkill(true)}>
                    Dry-Run Validate
                  </button>
                  <button
                    type="button"
                    class="omnia-btn omnia-btn-primary px-2 py-1 text-[11px]"
                    onClick={() => void handleCodifySkill(false)}
                  >
                    Codify Skill
                  </button>
                </div>
                <Show when={codifyResult()}>
                  <pre class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10px] font-mono-num max-h-24 overflow-auto whitespace-pre-wrap">
                    {JSON.stringify(codifyResult(), null, 2)}
                  </pre>
                </Show>
              </div>
            </div>
          </div>
        </Show>

        {/* TAB 4: Curated Skills, MCP 2026-07-28, 25 Hooks, Goose Recipes & Cordis Plugins */}
        <Show when={tab() === 'extensions'}>
          <div class="space-y-4">
            <Show when={extNote()}>
              <div class="px-3 py-1.5 rounded border border-[var(--border-accent)] bg-[var(--accent-dim)] text-[11.5px] font-mono-num text-[var(--accent-cyan)]">
                {extNote()}
              </div>
            </Show>

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
                <div class="font-bold text-[13px] flex items-center justify-between gap-2">
                  <span class="flex items-center gap-2">
                    <Blocks class="w-4 h-4 text-[var(--accent-cyan)]" />
                    <span>Curated Skills ({skills().length})</span>
                  </span>
                  <span class="text-[11px] font-mono-num text-[var(--status-emerald)]">BM25 EN/VN</span>
                </div>
                <div class="flex gap-2">
                  <input
                    type="text"
                    placeholder="BM25 EN/VN skill search..."
                    value={skillQuery()}
                    onInput={(e) => setSkillQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void loadExtensions();
                    }}
                    class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 text-[12px]"
                  />
                  <button type="button" class="omnia-btn text-[12px]" onClick={() => void loadExtensions()}>
                    <Search class="w-3.5 h-3.5" />
                  </button>
                </div>
                <div class="space-y-1.5 max-h-64 overflow-y-auto">
                  <For each={skills()}>
                    {(sk) => (
                      <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[12px]">
                        <div class="font-semibold text-[var(--accent-cyan)]">{String(sk.name || sk.id)}</div>
                        <div class="text-[11px] text-[var(--ink-muted)]">{String(sk.description || '')}</div>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 min-w-0">
                <div class="font-bold text-[13px] flex items-center gap-2">
                  <Plug class="w-4 h-4 text-[var(--accent-amber)]" />
                  <span>MCP 2026-07-28 Servers ({mcpServers().length}) & Tool Search</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-1.5 text-[11.5px]">
                  <input
                    type="text"
                    placeholder="Server name"
                    value={mcpName()}
                    onInput={(e) => setMcpName(e.currentTarget.value)}
                    class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
                  />
                  <input
                    type="text"
                    placeholder="stdio cmd or http://127.0.0.1:..."
                    value={mcpEndpoint()}
                    onInput={(e) => setMcpEndpoint(e.currentTarget.value)}
                    class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
                  />
                  <button
                    type="button"
                    class="omnia-btn omnia-btn-primary text-[11px]"
                    onClick={async () => {
                      if (!mcpName().trim() || !mcpEndpoint().trim()) return;
                      const transport = mcpEndpoint().startsWith('http') ? 'streamable_http' : 'stdio';
                      const r = await api.connectMcp(mcpName().trim(), transport, mcpEndpoint().trim());
                      setExtNote(r.ok ? `Connected MCP ${mcpName()}` : `MCP (${r.error.code}): ${r.error.message}`);
                      await loadExtensions();
                    }}
                  >
                    Connect
                  </button>
                </div>
                <div class="flex gap-1.5 text-[11.5px]">
                  <input
                    type="text"
                    placeholder="Search MCP tools..."
                    value={mcpToolQuery()}
                    onInput={(e) => setMcpToolQuery(e.currentTarget.value)}
                    class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
                  />
                  <button
                    type="button"
                    class="omnia-btn text-[11px]"
                    onClick={async () => {
                      const r = await api.searchMcpTools(mcpToolQuery());
                      setExtPreview(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                    }}
                  >
                    Search Tools
                  </button>
                </div>
                <div class="space-y-1 max-h-32 overflow-y-auto text-[11.5px] font-mono-num">
                  <For each={mcpServers()}>
                    {(srv) => {
                      const name = String(srv.name ?? srv.id ?? 'server');
                      return (
                        <div class="px-2 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-2">
                          <span class="truncate">{name} ({String(srv.status ?? srv.transport ?? 'ready')})</span>
                          <button
                            type="button"
                            class="omnia-btn omnia-btn-danger px-2 py-0.5 text-[10px] shrink-0"
                            onClick={async () => {
                              const r = await api.disconnectMcp(name);
                              setExtNote(r.ok ? `Disconnected ${name}` : `Disconnect (${r.error.code})`);
                              await loadExtensions();
                            }}
                          >
                            Disconnect
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 text-[11.5px]">
              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 min-w-0">
                <div class="font-bold text-[12.5px]">25 Lifecycle Hooks ({hooks().length})</div>
                <div class="space-y-1 max-h-48 overflow-y-auto font-mono-num">
                  <For each={hooks()}>
                    {(hk) => {
                      const id = String(hk.id ?? hk.name ?? hk.event ?? 'hook');
                      const enabled = hk.enabled !== false;
                      return (
                        <div class="px-2 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-2">
                          <span class="truncate">{id}</span>
                          <button
                            type="button"
                            class="omnia-btn px-2 py-0.5 text-[10px] shrink-0"
                            onClick={async () => {
                              const r = await api.toggleHook(id, !enabled);
                              setExtNote(r.ok ? `Hook ${id} -> ${!enabled ? 'ON' : 'OFF'}` : `Hook (${r.error.code})`);
                              await loadExtensions();
                            }}
                          >
                            {enabled ? 'ON' : 'OFF'}
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>

              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 min-w-0">
                <div class="font-bold text-[12.5px]">Goose Recipes ({recipes().length})</div>
                <div class="space-y-1 max-h-48 overflow-y-auto font-mono-num">
                  <For each={recipes()}>
                    {(rc) => {
                      const name = String(rc.name ?? rc.id ?? rc.title ?? 'recipe');
                      return (
                        <div class="px-2 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-2">
                          <span class="truncate">{name}</span>
                          <button
                            type="button"
                            class="omnia-btn px-2 py-0.5 text-[10px] shrink-0"
                            onClick={async () => {
                              const r = await api.renderRecipe(name);
                              setExtPreview(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                              setExtNote(`Rendered recipe ${name}`);
                            }}
                          >
                            <Play class="w-3 h-3" />
                            <span>Render</span>
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>

              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 min-w-0">
                <div class="font-bold text-[12.5px]">Cordis Dynamic Plugins ({cordis().length})</div>
                <div class="space-y-1 max-h-48 overflow-y-auto font-mono-num">
                  <For each={cordis()}>
                    {(pl) => {
                      const id = String(pl.id ?? pl.name ?? 'plugin');
                      const enabled = pl.enabled !== false;
                      return (
                        <div class="px-2 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-1">
                          <span class="truncate">{id}</span>
                          <div class="flex gap-1 shrink-0">
                            <button
                              type="button"
                              class="omnia-btn px-1.5 py-0.5 text-[10px]"
                              onClick={async () => {
                                const r = await api.toggleCordis(id, !enabled);
                                setExtNote(r.ok ? `Cordis ${id} -> ${!enabled ? 'ON' : 'OFF'}` : `Cordis (${r.error.code})`);
                                await loadExtensions();
                              }}
                            >
                              {enabled ? 'ON' : 'OFF'}
                            </button>
                            <button
                              type="button"
                              class="omnia-btn px-1.5 py-0.5 text-[10px]"
                              title="Rollback plugin"
                              onClick={async () => {
                                const r = await api.rollbackCordis(id);
                                setExtNote(r.ok ? `Rolled back ${id}` : `Rollback (${r.error.code})`);
                                await loadExtensions();
                              }}
                            >
                              <RotateCcw class="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>
            </div>

            <Show when={extPreview()}>
              <div class="omnia-surface-panel rounded-lg p-3.5">
                <div class="font-semibold text-[12px] mb-1.5">Extension / Recipe / Tool Output</div>
                <pre class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-48 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(extPreview(), null, 2)}
                </pre>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
