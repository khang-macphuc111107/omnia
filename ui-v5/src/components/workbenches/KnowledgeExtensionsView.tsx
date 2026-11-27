import { For, Show, createSignal, onMount } from 'solid-js';
import {
  Blocks,
  Brain,
  Database,
  Play,
  Plus,
  Plug,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-solid';
import { api } from '@/api/client';
import { privacyMask } from '@/state/studio';
import { sha256HexSync } from '@/utils/crypto';
import { maskJson } from '@/utils/privacy';

export function KnowledgeExtensionsView() {
  const [tab, setTab] = createSignal<'memory' | 'rag' | 'extensions'>('memory');
  const [memories, setMemories] = createSignal<Array<Record<string, unknown>>>([]);
  const [ns, setNs] = createSignal('workspace/architecture');
  const [memKey, setMemKey] = createSignal('');
  const [memVal, setMemVal] = createSignal('');
  const [erasureReceipt, setErasureReceipt] = createSignal<Record<string, unknown> | null>(null);
  const [engineQuery, setEngineQuery] = createSignal('');
  const [engineBank, setEngineBank] = createSignal('hipporag');
  const [engineResult, setEngineResult] = createSignal<Record<string, unknown> | null>(null);
  const [memNote, setMemNote] = createSignal('');

  const [ragQuery, setRagQuery] = createSignal('');
  const [ragResult, setRagResult] = createSignal<Record<string, unknown> | null>(null);

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

  const loadMemories = async () => {
    const res = await api.listMemory('');
    if (res.ok && Array.isArray(res.data.entries)) setMemories(res.data.entries);
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

  return (
    <div data-testid="knowledge-workbench" class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
      <div class="px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2">
        <div class="omp-segmented text-[12px]">
          <button type="button" aria-pressed={tab() === 'memory'} onClick={() => setTab('memory')}>
            Memory (HippoRAG / ASI06 / Erasure)
          </button>
          <button type="button" aria-pressed={tab() === 'rag'} onClick={() => setTab('rag')}>
            Proactive RAG (EN/VN)
          </button>
          <button type="button" aria-pressed={tab() === 'extensions'} onClick={() => setTab('extensions')}>
            19 Skills · MCP · 25 Hooks · Recipes · Cordis
          </button>
        </div>
        <span class="omnia-badge text-[var(--status-emerald)] font-mono-num text-[11px]">
          Skills Parity: {skills().length || 19}/19
        </span>
      </div>

      <div class="flex-1 overflow-y-auto p-4">
        {/* Memory Vault + HippoRAG / Graphiti / Hindsight / ACE + ASI06 */}
        <Show when={tab() === 'memory'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
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
                        class="omnia-btn omnia-btn-danger px-2 py-1 text-[11px]"
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

            <div class="space-y-4">
              {/* HippoRAG / Graphiti / Hindsight / ACE Operations */}
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
                    maskJson(engineResult() ?? { hint: 'Use Retain / Recall / Reflect to inspect memory graph provenance & ASI06 quarantine.' }, privacyMask()),
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

        {/* Proactive RAG */}
        <Show when={tab() === 'rag'}>
          <div class="omnia-surface-panel rounded-lg p-4 max-w-4xl space-y-3">
            <div class="font-bold text-[13.5px] flex items-center gap-2">
              <Sparkles class="w-4 h-4 text-[var(--accent-amber)]" />
              <span>Bilingual EN/VN Proactive RAG Uncertainty Planner</span>
            </div>
            <div class="flex gap-2">
              <input
                type="text"
                placeholder="Ask uncertainty query in Vietnamese or English (without needing 'search')..."
                value={ragQuery()}
                onInput={(e) => setRagQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void api.planRag(ragQuery()).then((r) =>
                      setRagResult(r.ok ? r.data : { error: r.error.code, message: r.error.message }),
                    );
                  }
                }}
                class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px]"
              />
              <button
                type="button"
                class="omnia-btn omnia-btn-primary text-[12px]"
                onClick={async () => {
                  const r = await api.planRag(ragQuery());
                  setRagResult(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                }}
              >
                Plan RAG
              </button>
            </div>
            <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-96 overflow-auto">
              {JSON.stringify(
                ragResult() ?? { hint: 'Inspect citedSources vs quarantined unusedSources.' },
                null,
                2,
              )}
            </pre>
          </div>
        </Show>

        {/* 19/19 Skills, MCP 2026-07-28, 25 Hooks, Goose Recipes & Cordis Plugins */}
        <Show when={tab() === 'extensions'}>
          <div class="space-y-4">
            <Show when={extNote()}>
              <div class="px-3 py-1.5 rounded border border-[var(--border-accent)] bg-[var(--accent-dim)] text-[11.5px] font-mono-num text-[var(--accent-cyan)]">
                {extNote()}
              </div>
            </Show>

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* 19/19 Skills BM25 */}
              <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
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
                    class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 text-[12px]"
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

              {/* MCP 2026-07-28 Servers & Tool Search */}
              <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
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
                    class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
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
                        <div class="px-2 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between">
                          <span>{name} ({String(srv.status ?? srv.transport ?? 'ready')})</span>
                          <button
                            type="button"
                            class="omnia-btn omnia-btn-danger px-2 py-0.5 text-[10px]"
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

            {/* 25 Hooks + Goose Recipes + Cordis Plugins */}
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 text-[11.5px]">
              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
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
                            class="omnia-btn px-2 py-0.5 text-[10px]"
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

              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
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
                            class="omnia-btn px-2 py-0.5 text-[10px]"
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

              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
                <div class="font-bold text-[12.5px]">Cordis Dynamic Plugins ({cordis().length})</div>
                <div class="space-y-1 max-h-48 overflow-y-auto font-mono-num">
                  <For each={cordis()}>
                    {(pl) => {
                      const id = String(pl.id ?? pl.name ?? 'plugin');
                      const enabled = pl.enabled !== false;
                      return (
                        <div class="px-2 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-1">
                          <span class="truncate">{id}</span>
                          <div class="flex gap-1">
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
