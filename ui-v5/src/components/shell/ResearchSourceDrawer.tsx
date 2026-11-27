import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import {
  BookOpen,
  Download,
  Eye,
  Globe,
  MessageSquareQuote,
  Pin,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Table2,
  X,
} from 'lucide-solid';
import { api } from '@/api/client';
import {
  activeSessionId,
  flashNotice,
  focusedCitationId,
  openQuoteBtw,
  openSourcePreview,
  privacyMask,
  refreshResearchSources,
  researchDrawerOpen,
  researchProgress,
  researchSources,
  runQuickDeepResearch,
  setFocusedCitationId,
  setResearchDrawerOpen,
} from '@/state/studio';
import type { ResearchSourceRecord } from '@/types';
import { downloadTextFile, maskJson, maskText } from '@/utils/privacy';

type SourceFilterTab = 'all' | 'searched' | 'viewed' | 'extracted' | 'blocked';

export function ResearchSourceDrawer() {
  const [tab, setTab] = createSignal<SourceFilterTab>('all');
  const [queryInput, setQueryInput] = createSignal('');
  const [scope, setScope] = createSignal<'all' | 'web' | 'academic'>('all');
  const [fetchUrlInput, setFetchUrlInput] = createSignal('');
  const [tableColsInput, setTableColsInput] = createSignal('source,claim,grade');
  const [toolOutput, setToolOutput] = createSignal<Record<string, unknown> | null>(null);
  const [busy, setBusy] = createSignal(false);

  createEffect(() => {
    if (researchDrawerOpen()) {
      void refreshResearchSources();
    }
  });

  const counts = createMemo(() => {
    let searched = 0;
    let viewed = 0;
    let extracted = 0;
    let blocked = 0;
    for (const s of researchSources) {
      const st = s.status.toLowerCase();
      if (st === 'searched') searched++;
      else if (st === 'viewed') viewed++;
      else if (st === 'extracted') extracted++;
      else if (st === 'blocked' || st === 'auth_required' || st === 'failed') blocked++;
    }
    return { all: researchSources.length, searched, viewed, extracted, blocked };
  });

  const filteredSources = createMemo(() => {
    const f = tab();
    const list = researchSources.filter((s) => {
      const st = s.status.toLowerCase();
      if (f === 'all') return true;
      if (f === 'blocked') return st === 'blocked' || st === 'auth_required' || st === 'failed';
      return st === f;
    });
    const foc = focusedCitationId();
    if (!foc) return list;
    return [...list].sort((a, b) => (a.citationId === foc ? -1 : b.citationId === foc ? 1 : 0));
  });

  const handleFetchUrl = async () => {
    const raw = fetchUrlInput().trim();
    if (!raw) return;
    setBusy(true);
    const res = await api.fetchResearchUrls([raw], 'local', queryInput().trim());
    if (res.ok) {
      setFetchUrlInput('');
      setToolOutput(res.data);
      await refreshResearchSources();
      flashNotice('Fetched & extracted URL into Research Vault');
    } else {
      setToolOutput({ error: res.error.code, message: res.error.message });
      flashNotice(`Fetch note (${res.error.code}): ${res.error.message}`);
    }
    setBusy(false);
  };

  const handleExtractTable = async () => {
    const q = queryInput().trim() || 'summary';
    const cols = tableColsInput()
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    setBusy(true);
    const res = await api.extractResearchTable(q, cols.length ? cols : ['source', 'excerpt']);
    setToolOutput(res.ok ? res.data : { error: res.error.code, message: res.error.message });
    setBusy(false);
  };

  const handleExportDossier = async (fmt: 'markdown' | 'json') => {
    const res = await api.exportResearchDossier(fmt, activeSessionId());
    const ext = fmt === 'markdown' ? 'md' : 'json';
    const filename = `omnia-research-dossier-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
    if (res.ok && res.text.trim()) {
      downloadTextFile(filename, maskText(res.text, privacyMask()));
      flashNotice(`Exported ${filename}`);
    } else {
      const fallback = maskJson({ exportedAt: new Date().toISOString(), sources: [...researchSources] }, privacyMask());
      downloadTextFile(filename, JSON.stringify(fallback, null, 2));
      flashNotice(`Exported local research ledger (${filename})`);
    }
  };

  const handlePin = async (src: ResearchSourceRecord, targetTier: 'global' | 'atelier') => {
    const res = await api.pinRagSource(src.citationId, targetTier);
    flashNotice(
      res.ok
        ? `Pinned [${src.citationId}] -> ${targetTier.toUpperCase()}`
        : `Pin note (${res.error.code}): ${res.error.message}`,
    );
    await refreshResearchSources();
  };

  return (
    <Show when={researchDrawerOpen()}>
      <aside
        data-testid="research-source-drawer"
        class="w-[410px] max-w-[92vw] shrink-0 h-full border-l border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div class="px-3.5 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <Globe class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
            <div class="min-w-0">
              <div class="text-[12.5px] font-bold truncate">Sources (Searched, Viewed &amp; Extracted)</div>
              <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)]">
                [S###] Local · [G###] Global RAG · Non-Bypass Ledger
              </div>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button
              type="button"
              class="omnia-btn px-1.5 py-1 text-[10.5px]"
              title="Refresh Sources Ledger"
              onClick={() => void refreshResearchSources()}
            >
              <RefreshCw class="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              class="omnia-btn px-1.5 py-1 text-[10.5px]"
              aria-label="Close Sources Ledger"
              onClick={() => setResearchDrawerOpen(false)}
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Live Multi-Stage Research Progress Bar */}
        <Show when={researchProgress.active || researchProgress.stage !== 'idle'}>
          <div class="px-3.5 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] font-mono-num flex items-center justify-between gap-2">
            <span class="flex items-center gap-1.5 text-[var(--accent-cyan)] truncate">
              <Sparkles class="w-3.5 h-3.5 shrink-0" />
              <span class="uppercase font-bold">{researchProgress.stage}</span>
              <span class="text-[var(--ink-secondary)] truncate">{researchProgress.detail}</span>
            </span>
            <span class="text-[var(--status-emerald)] shrink-0">
              S:{researchProgress.searchedCount} · E:{researchProgress.extractedCount}
            </span>
          </div>
        </Show>

        {/* Active Web/Academic Search + URL Fetch + Table Extract Controls */}
        <div class="p-3 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] space-y-2 text-[11.5px]">
          <div class="flex gap-1.5">
            <input
              type="text"
              placeholder="Active Deep Research query (Web + arXiv/OpenAlex/RAG)..."
              value={queryInput()}
              onInput={(e) => setQueryInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runQuickDeepResearch(queryInput(), scope());
              }}
              class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 outline-none"
            />
            <select
              aria-label="Research Scope"
              value={scope()}
              onChange={(e) => setScope(e.currentTarget.value as 'all' | 'web' | 'academic')}
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-1"
            >
              <option value="all">All</option>
              <option value="web">Web</option>
              <option value="academic">Academic</option>
            </select>
            <button
              type="button"
              disabled={busy()}
              class="omnia-btn omnia-btn-primary px-2.5 py-1"
              onClick={() => void runQuickDeepResearch(queryInput(), scope())}
            >
              <Search class="w-3.5 h-3.5" />
            </button>
          </div>

          <div class="flex gap-1.5">
            <input
              type="text"
              placeholder="Fetch & extract URL (https://example.com)..."
              value={fetchUrlInput()}
              onInput={(e) => setFetchUrlInput(e.currentTarget.value)}
              class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 font-mono-num outline-none"
            />
            <button type="button" disabled={busy()} class="omnia-btn px-2 py-1 text-[11px]" onClick={() => void handleFetchUrl()}>
              Fetch
            </button>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-1.5">
            <div class="flex items-center gap-1 flex-1 min-w-[160px]">
              <input
                type="text"
                placeholder="Table columns (csv)"
                value={tableColsInput()}
                onInput={(e) => setTableColsInput(e.currentTarget.value)}
                class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-0.5 text-[10.5px] font-mono-num outline-none"
              />
              <button type="button" disabled={busy()} class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={() => void handleExtractTable()}>
                <Table2 class="w-3 h-3 text-[var(--accent-amber)]" />
                <span>Table</span>
              </button>
            </div>
            <div class="flex items-center gap-1">
              <button type="button" class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={() => void handleExportDossier('markdown')}>
                <Download class="w-3 h-3" />
                <span>MD</span>
              </button>
              <button type="button" class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={() => void handleExportDossier('json')}>
                JSON
              </button>
            </div>
          </div>
        </div>

        {/* PRISMA Filter Tabs */}
        <div class="px-3 py-2 border-b border-[var(--border-subtle)] flex flex-wrap items-center gap-1 text-[10.5px] font-mono-num">
          {(
            [
              { id: 'all', label: `All (${counts().all})` },
              { id: 'searched', label: `Searched (${counts().searched})` },
              { id: 'viewed', label: `Viewed (${counts().viewed})` },
              { id: 'extracted', label: `Extracted (${counts().extracted})` },
              { id: 'blocked', label: `Blocked (${counts().blocked})` },
            ] as const
          ).map((t) => (
            <button
              type="button"
              onClick={() => setTab(t.id)}
              class="px-2 py-0.5 rounded border cursor-pointer"
              classList={{
                'border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--accent-cyan)] font-bold': tab() === t.id,
                'border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--ink-muted)]': tab() !== t.id,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Source Cards List */}
        <div class="flex-1 overflow-y-auto p-3 space-y-2.5">
          <Show
            when={filteredSources().length > 0}
            fallback={
              <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[11.5px] font-mono-num text-[var(--ink-muted)]">
                No research sources in this filter yet. Run a Deep Research query above or click any inline [S###]/[G###] citation chip.
              </div>
            }
          >
            <For each={filteredSources()}>
              {(src) => {
                const isFocused = () => focusedCitationId() === src.citationId;
                const isBlocked = () => ['blocked', 'auth_required', 'failed'].includes(src.status.toLowerCase());
                return (
                  <div
                    class="p-2.5 rounded border bg-[var(--bg-panel)] space-y-1.5 text-[11.5px]"
                    classList={{
                      'border-[var(--accent-cyan)]': isFocused(),
                      'border-[var(--status-coral)]': !isFocused() && isBlocked(),
                      'border-[var(--border-subtle)]': !isFocused() && !isBlocked(),
                    }}
                  >
                    <div class="flex items-center justify-between gap-1.5 font-mono-num">
                      <div class="flex items-center gap-1.5 min-w-0">
                        <span
                          class="omnia-badge font-bold"
                          classList={{
                            'text-[var(--status-emerald)]': src.citationId.startsWith('G'),
                            'text-[var(--accent-cyan)]': !src.citationId.startsWith('G'),
                          }}
                        >
                          [{src.citationId}]
                        </span>
                        <span class="omnia-badge uppercase text-[10px]">{src.status}</span>
                        <Show when={src.evidenceGrade}>
                          <span class="omnia-badge text-[10px] text-[var(--accent-amber)]">{src.evidenceGrade}</span>
                        </Show>
                      </div>
                      <Show when={isFocused()}>
                        <button
                          type="button"
                          class="text-[10px] text-[var(--ink-muted)] cursor-pointer"
                          onClick={() => setFocusedCitationId(null)}
                        >
                          clear focus
                        </button>
                      </Show>
                    </div>

                    <div class="font-semibold text-[var(--ink-primary)] line-clamp-2">
                      {maskText(src.title || src.domain || src.url || src.citationId, privacyMask())}
                    </div>

                    <Show when={src.canonicalUrl || src.url}>
                      <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)] truncate">
                        {maskText(src.canonicalUrl || src.url, privacyMask())}
                      </div>
                    </Show>

                    <Show when={src.blockedReason}>
                      <div class="px-2 py-1 rounded border border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[10.5px] font-mono-num text-[var(--status-coral)] flex items-center gap-1">
                        <ShieldAlert class="w-3 h-3 shrink-0" />
                        <span>{src.blockedReason} (non-bypass enforced)</span>
                      </div>
                    </Show>

                    <Show when={src.excerpt}>
                      <div class="text-[11px] text-[var(--ink-secondary)] line-clamp-3">
                        {maskText(src.excerpt!, privacyMask())}
                      </div>
                    </Show>

                    <div class="flex flex-wrap items-center justify-between gap-1 pt-1 border-t border-[var(--border-subtle)]">
                      <div class="flex items-center gap-1">
                        <button
                          type="button"
                          class="omnia-btn px-1.5 py-0.5 text-[10.5px]"
                          onClick={() =>
                            openSourcePreview({
                              id: src.citationId,
                              name: `${src.citationId}-${(src.title || 'source').slice(0, 28)}.md`,
                              kind: 'markdown',
                              sha256: src.sha256,
                              sourceUrl: src.canonicalUrl || src.url,
                              content:
                                src.content ||
                                `# ${src.title || src.citationId}\n\n- URL: ${src.canonicalUrl || src.url}\n- Status: ${src.status}\n- Grade: ${src.evidenceGrade || 'OBSERVED'}\n\n${src.excerpt || ''}`,
                            })
                          }
                        >
                          <Eye class="w-3 h-3 text-[var(--accent-cyan)]" />
                          <span>Preview</span>
                        </button>
                        <button
                          type="button"
                          class="omnia-btn px-1.5 py-0.5 text-[10.5px]"
                          onClick={() => void handlePin(src, 'global')}
                        >
                          <Pin class="w-3 h-3 text-[var(--status-emerald)]" />
                          <span>Pin Global</span>
                        </button>
                        <button
                          type="button"
                          class="omnia-btn px-1.5 py-0.5 text-[10.5px]"
                          onClick={() => void handlePin(src, 'atelier')}
                        >
                          <BookOpen class="w-3 h-3 text-[var(--accent-amber)]" />
                          <span>Atelier</span>
                        </button>
                      </div>
                      <button
                        type="button"
                        class="omnia-btn px-1.5 py-0.5 text-[10.5px]"
                        onClick={() =>
                          openQuoteBtw({
                            text: src.excerpt || src.title || src.url,
                            sourceLabel: `[${src.citationId}] ${src.title || src.domain || 'Source'}`,
                            surface: 'chat',
                          })
                        }
                      >
                        <MessageSquareQuote class="w-3 h-3 text-[var(--accent-amber)]" />
                        <span>BTW</span>
                      </button>
                    </div>
                  </div>
                );
              }}
            </For>
          </Show>

          <Show when={toolOutput()}>
            <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)]">
              <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)] mb-1">Latest Research / Table Receipt</div>
              <pre class="text-[10.5px] font-mono-num max-h-40 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(maskJson(toolOutput(), privacyMask()), null, 2)}
              </pre>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  );
}
