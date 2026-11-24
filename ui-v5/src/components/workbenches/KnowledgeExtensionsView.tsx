import { For, Show, createSignal, onMount } from 'solid-js';
import {
  Blocks,
  Database,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-solid';
import { api } from '@/api/client';
import { sha256HexSync } from '@/utils/crypto';

export function KnowledgeExtensionsView() {
  const [tab, setTab] = createSignal<'memory' | 'rag' | 'extensions'>('memory');
  const [memories, setMemories] = createSignal<Array<Record<string, unknown>>>([]);
  const [ns, setNs] = createSignal('workspace/architecture');
  const [memKey, setMemKey] = createSignal('');
  const [memVal, setMemVal] = createSignal('');
  const [erasureReceipt, setErasureReceipt] = createSignal<Record<string, unknown> | null>(null);

  const [ragQuery, setRagQuery] = createSignal('');
  const [ragResult, setRagResult] = createSignal<Record<string, unknown> | null>(null);

  const [skillQuery, setSkillQuery] = createSignal('');
  const [skills, setSkills] = createSignal<Array<Record<string, unknown>>>([]);
  const [mcpData, setMcpData] = createSignal<Record<string, unknown> | null>(null);
  const [hooksData, setHooksData] = createSignal<Record<string, unknown> | null>(null);
  const [recipesData, setRecipesData] = createSignal<Record<string, unknown> | null>(null);

  const loadMemories = async () => {
    const res = await api.listMemory('');
    if (res.ok && Array.isArray(res.data.entries)) setMemories(res.data.entries);
  };

  const loadExtensions = async () => {
    const [sk, mcp, hk, rc] = await Promise.all([
      api.listSkills(skillQuery()),
      api.listMcp(),
      api.listHooks(),
      api.listRecipes(),
    ]);
    if (sk.ok && Array.isArray(sk.data.skills)) setSkills(sk.data.skills);
    if (mcp.ok) setMcpData(mcp.data);
    if (hk.ok) setHooksData(hk.data);
    if (rc.ok) setRecipesData(rc.data);
  };

  onMount(() => {
    void loadMemories();
    void loadExtensions();
  });

  const handleUpsert = async () => {
    if (!memKey().trim() || !memVal().trim()) return;
    await api.upsertMemory(ns().trim(), memKey().trim(), memVal().trim());
    setMemKey('');
    setMemVal('');
    await loadMemories();
  };

  const handleErase = async (m: Record<string, unknown>) => {
    const k = String(m.key ?? '');
    const n = String(m.namespace ?? ns());
    const v = String(m.value ?? m.content ?? '');
    const digest = sha256HexSync(`${n}:${k}:${v}`);
    const res = await api.eraseMemory(n, k, digest);
    if (res.ok) {
      setErasureReceipt(res.data);
      await loadMemories();
    }
  };

  return (
    <div data-testid="knowledge-workbench" class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
      <div class="px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex items-center justify-between">
        <div class="omp-segmented text-[12px]">
          <button type="button" aria-pressed={tab() === 'memory'} onClick={() => setTab('memory')}>
            Memory Vault & Erasure
          </button>
          <button type="button" aria-pressed={tab() === 'rag'} onClick={() => setTab('rag')}>
            Proactive RAG (EN/VN)
          </button>
          <button type="button" aria-pressed={tab() === 'extensions'} onClick={() => setTab('extensions')}>
            MCP · 19 Skills · Hooks · Recipes
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto p-4">
        <Show when={tab() === 'memory'}>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
              <div class="font-bold text-[13.5px] flex items-center gap-2">
                <Database class="w-4 h-4 text-[var(--accent-cyan)]" />
                <span>Containment-Guarded MemoryGraph Upsert</span>
              </div>
              <div class="grid grid-cols-2 gap-2 text-[12px]">
                <input type="text" placeholder="Namespace" value={ns()} onInput={(e) => setNs(e.currentTarget.value)} class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5" />
                <input type="text" placeholder="Key" value={memKey()} onInput={(e) => setMemKey(e.currentTarget.value)} class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5" />
              </div>
              <textarea rows={3} placeholder="Fact or rule content..." value={memVal()} onInput={(e) => setMemVal(e.currentTarget.value)} class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-[12px]" />
              <button type="button" class="omnia-btn omnia-btn-primary text-[12px]" onClick={() => void handleUpsert()}>
                <Plus class="w-3.5 h-3.5" />
                <span>Upsert Memory</span>
              </button>

              <div class="space-y-1.5 pt-2">
                <For each={memories()}>
                  {(m) => (
                    <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 text-[12px]">
                      <div class="min-w-0">
                        <div class="font-mono-num font-bold text-[var(--accent-amber)]">{String(m.namespace || 'default')}/{String(m.key || m.id)}</div>
                        <div class="text-[var(--ink-secondary)] truncate">{String(m.value || m.content || '')}</div>
                      </div>
                      <button type="button" class="omnia-btn omnia-btn-danger px-2 py-1 text-[11px]" onClick={() => void handleErase(m)}>
                        <Trash2 class="w-3 h-3" />
                        <span>Erase</span>
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </div>

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13.5px]">SHA-256 Cryptographic ErasureReceipt</div>
              <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-96 overflow-auto">
                {JSON.stringify(erasureReceipt() ?? { hint: 'Erase an entry to emit verifiedPlaintextFree receipt.' }, null, 2)}
              </pre>
            </div>
          </div>
        </Show>

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
                class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px]"
              />
              <button
                type="button"
                class="omnia-btn omnia-btn-primary text-[12px]"
                onClick={() => void api.planRag(ragQuery()).then((r) => r.ok && setRagResult(r.data))}
              >
                Plan RAG
              </button>
            </div>
            <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-96 overflow-auto">
              {JSON.stringify(ragResult() ?? { hint: 'Inspect citedSources vs quarantined unusedSources.' }, null, 2)}
            </pre>
          </div>
        </Show>

        <Show when={tab() === 'extensions'}>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
              <div class="font-bold text-[13.5px] flex items-center gap-2">
                <Blocks class="w-4 h-4 text-[var(--accent-cyan)]" />
                <span>Curated Skills ({skills().length})</span>
              </div>
              <div class="flex gap-2">
                <input
                  type="text"
                  placeholder="BM25 EN/VN skill search..."
                  value={skillQuery()}
                  onInput={(e) => setSkillQuery(e.currentTarget.value)}
                  class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 text-[12px]"
                />
                <button type="button" class="omnia-btn text-[12px]" onClick={() => void loadExtensions()}>
                  <Search class="w-3.5 h-3.5" />
                </button>
              </div>
              <div class="space-y-1.5 max-h-96 overflow-y-auto">
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

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13.5px]">MCP Servers · 25 Hooks · Recipes · Cordis</div>
              <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-96 overflow-auto">
                {JSON.stringify({ mcp: mcpData(), hooks: hooksData(), recipes: recipesData() }, null, 2)}
              </pre>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
