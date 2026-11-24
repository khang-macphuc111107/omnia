import { For, Show, createSignal, onMount } from 'solid-js';
import {
  BookOpen,
  CheckCircle2,
  FileText,
  Layers,
  MessageSquareQuote,
  Plus,
  Send,
  Share2,
  Sparkles,
} from 'lucide-solid';
import { api } from '@/api/client';
import { openQuoteBtw } from '@/state/studio';
import type { EffortLevel } from '@/types';
import { renderRichMarkdown } from '@/utils/markdown';

const ARTIFACT_KINDS = [
  { kind: 'audio_overview', label: 'Audio Overview' },
  { kind: 'mind_map', label: 'Mind Map' },
  { kind: 'flashcards', label: 'Flashcards' },
  { kind: 'quiz', label: 'Quiz' },
  { kind: 'slide_deck', label: 'Slide Deck' },
  { kind: 'data_table', label: 'Data Table' },
  { kind: 'infographic', label: 'Infographic' },
  { kind: 'briefing', label: 'Briefing' },
  { kind: 'study_guide', label: 'Study Guide' },
];

export function AtelierView() {
  const [layoutMode, setLayoutMode] = createSignal<'gemini' | 'notebook' | 'ke_nhau'>('ke_nhau');
  const [notebooks, setNotebooks] = createSignal<Array<Record<string, unknown>>>([]);
  const [activeNbId, setActiveNbId] = createSignal<string>('');
  const [sources, setSources] = createSignal<Array<Record<string, unknown>>>([]);
  const [artifacts, setArtifacts] = createSignal<Array<Record<string, unknown>>>([]);
  const [selectedArtifact, setSelectedArtifact] = createSignal<Record<string, unknown> | null>(null);
  const [flashcardFlip, setFlashcardFlip] = createSignal(false);
  const [slideIdx, setSlideIdx] = createSignal(0);

  const [newSourceName, setNewSourceName] = createSignal('');
  const [newSourceText, setNewSourceText] = createSignal('');
  const [shareUrl, setShareUrl] = createSignal('');
  const [askPrompt, setAskPrompt] = createSignal('');
  const [effort, setEffort] = createSignal<EffortLevel>('medium');
  const [qaHistory, setQaHistory] = createSignal<Array<{ q: string; a: string; citations?: string[] }>>([]);
  const [statusMsg, setStatusMsg] = createSignal('');

  const nbIdOf = (nb: Record<string, unknown>): string => String(nb.notebook_id ?? nb.id ?? '');

  const refreshNotebookData = async (nbId: string) => {
    if (!nbId) return;
    const [srcRes, artRes] = await Promise.all([api.listSources(nbId), api.listArtifacts(nbId)]);
    if (srcRes.ok && Array.isArray(srcRes.data.sources)) setSources(srcRes.data.sources);
    if (artRes.ok && Array.isArray(artRes.data.artifacts)) {
      setArtifacts(artRes.data.artifacts);
      if (artRes.data.artifacts.length > 0 && !selectedArtifact()) {
        setSelectedArtifact(artRes.data.artifacts[0]);
      }
    }
  };

  onMount(async () => {
    const res = await api.listNotebooks();
    if (res.ok && Array.isArray(res.data.notebooks) && res.data.notebooks.length > 0) {
      setNotebooks(res.data.notebooks);
      const id = nbIdOf(res.data.notebooks[0]);
      if (id) {
        setActiveNbId(id);
        await refreshNotebookData(id);
      }
    }
  });

  const handleCreateNb = async () => {
    const res = await api.createNotebook(`Atelier ${notebooks().length + 1}`);
    if (res.ok && res.data.notebook) {
      const nb = res.data.notebook as Record<string, unknown>;
      setNotebooks([nb, ...notebooks()]);
      const id = nbIdOf(nb);
      if (id) {
        setActiveNbId(id);
        await refreshNotebookData(id);
      }
    }
  };

  const ensureNotebookId = async (): Promise<string> => {
    if (activeNbId()) return activeNbId();
    await handleCreateNb();
    return activeNbId();
  };

  const handleIngest = async () => {
    if (!newSourceName().trim() || !newSourceText().trim()) return;
    const nbId = await ensureNotebookId();
    if (!nbId) return;
    const res = await api.ingestSource(nbId, newSourceName().trim(), newSourceText());
    if (res.ok) {
      setNewSourceName('');
      setNewSourceText('');
      setStatusMsg('Source indexed into Atelier Notebook');
      await refreshNotebookData(nbId);
    } else {
      setStatusMsg(`Ingest error: ${res.error.message}`);
    }
  };

  const handleImportShare = async () => {
    if (!shareUrl().trim()) return;
    const nbId = await ensureNotebookId();
    if (!nbId) return;
    const res = await api.safeJson('/api/notebooks/import-share', {
      method: 'POST',
      body: JSON.stringify({ notebook_id: nbId, share_url: shareUrl().trim() }),
    });
    if (res.ok) {
      setStatusMsg('Public Gemini share imported');
      await refreshNotebookData(nbId);
    } else {
      // Explicitly surface auth_required / captcha_blocked without bypass
      setStatusMsg(`Import blocked (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleAsk = async () => {
    const q = askPrompt().trim();
    if (!q) return;
    const nbId = await ensureNotebookId();
    if (!nbId) return;
    setAskPrompt('');
    const res = await api.askNotebook(nbId, q, undefined, effort());
    if (res.ok) {
      const inner = (res.data.result && typeof res.data.result === 'object' ? res.data.result : res.data) as Record<string, unknown>;
      const answer = String(inner.answer ?? inner.response_markdown ?? JSON.stringify(inner));
      const citations = Array.isArray(inner.citations) ? inner.citations.map(String) : [];
      setQaHistory([...qaHistory(), { q, a: answer, citations }]);
    } else {
      setQaHistory([...qaHistory(), { q, a: `Error (${res.error.code}): ${res.error.message}` }]);
    }
  };

  const handleGenerateArtifact = async (kind: string, label: string) => {
    const nbId = await ensureNotebookId();
    if (!nbId) return;
    setStatusMsg(`Generating ${label}...`);
    const res = await api.generateArtifact(nbId, kind, label);
    if (res.ok && res.data.artifact) {
      const art = res.data.artifact as Record<string, unknown>;
      setArtifacts([art, ...artifacts()]);
      setSelectedArtifact(art);
      setSlideIdx(0);
      setFlashcardFlip(false);
      setStatusMsg(`Generated ${label}`);
    } else if (!res.ok) {
      setStatusMsg(`Artifact error (${res.error.code}): ${res.error.message}`);
    }
  };

  return (
    <div data-testid="atelier-workbench" class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
      {/* Atelier Header */}
      <div class="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2.5">
          <BookOpen class="w-4 h-4 text-[var(--accent-amber)]" />
          <span class="font-bold text-[13.5px]">Atelier Research Studio</span>
          <select
            value={activeNbId()}
            onChange={(e) => {
              const id = e.currentTarget.value;
              setActiveNbId(id);
              void refreshNotebookData(id);
            }}
            class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[12px]"
          >
            <For each={notebooks()}>
              {(nb) => <option value={nbIdOf(nb)}>{String(nb.title || nbIdOf(nb))}</option>}
            </For>
          </select>
          <button type="button" class="omnia-btn text-[11px]" onClick={() => void handleCreateNb()}>
            <Plus class="w-3.5 h-3.5" />
            <span>New Notebook</span>
          </button>
        </div>

        <div class="flex items-center gap-2">
          <Show when={statusMsg()}>
            <span class="text-[11.5px] font-mono-num text-[var(--accent-cyan)]">{statusMsg()}</span>
          </Show>
          {/* Gemini | Notebook | Ke nhau */}
          <div class="omp-segmented text-[11.5px]">
            {(
              [
                { id: 'gemini', label: 'Gemini' },
                { id: 'notebook', label: 'Notebook' },
                { id: 'ke_nhau', label: 'Kế nhau' },
              ] as const
            ).map((m) => (
              <button
                type="button"
                aria-pressed={layoutMode() === m.id}
                onClick={() => setLayoutMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 3-Column Studio Grid (responsive to Gemini / Notebook / Ke nhau at >=1280px) */}
      <div
        class="flex-1 min-h-0 grid overflow-hidden"
        classList={{
          'grid-cols-1 lg:grid-cols-[minmax(210px,240px)_minmax(260px,1fr)_minmax(240px,295px)]':
            layoutMode() === 'ke_nhau',
          'grid-cols-1': layoutMode() === 'gemini',
          'grid-cols-1 lg:grid-cols-[minmax(220px,260px)_minmax(0,1fr)]': layoutMode() === 'notebook',
        }}
      >
        {/* Sources Column */}
        <Show when={layoutMode() !== 'gemini'}>
          <div class="border-r border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col overflow-hidden">
            <div class="p-3 border-b border-[var(--border-subtle)] text-[12px] font-semibold flex items-center gap-1.5">
              <FileText class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              <span>Sources ({sources().length})</span>
            </div>
            <div class="flex-1 overflow-y-auto p-3 space-y-2">
              <For each={sources()}>
                {(s) => (
                  <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[12px]">
                    <div class="font-semibold truncate">{String(s.title || s.safe_filename || s.filename || s.source_id || s.id)}</div>
                    <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)] mt-0.5">
                      {String(s.source_kind || s.kind || 'document')} · {String(s.chunk_count ?? 1)} chunks
                    </div>
                  </div>
                )}
              </For>

              <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
                <input
                  type="text"
                  placeholder="Source filename (e.g. notes.md)"
                  value={newSourceName()}
                  onInput={(e) => setNewSourceName(e.currentTarget.value)}
                  class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
                />
                <textarea
                  rows={3}
                  placeholder="Paste source text (UTF-8)..."
                  value={newSourceText()}
                  onInput={(e) => setNewSourceText(e.currentTarget.value)}
                  class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px] resize-none"
                />
                <button type="button" class="omnia-btn omnia-btn-primary w-full justify-center text-[11px]" onClick={() => void handleIngest()}>
                  Ingest Source
                </button>
              </div>

              <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
                <input
                  type="text"
                  placeholder="Public Gemini share URL..."
                  value={shareUrl()}
                  onInput={(e) => setShareUrl(e.currentTarget.value)}
                  class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
                />
                <button type="button" class="omnia-btn w-full justify-center text-[11px]" onClick={() => void handleImportShare()}>
                  <Share2 class="w-3 h-3" />
                  <span>Import Public Share</span>
                </button>
              </div>
            </div>
          </div>
        </Show>

        {/* Grounded Q&A Column */}
        <div class="flex flex-col min-h-0 overflow-hidden bg-[var(--bg-canvas)]">
          <div class="px-4 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between text-[12px]">
            <span class="font-semibold text-[var(--ink-secondary)]">Grounded Synthesis & Citations</span>
            <div class="flex items-center gap-1">
              {(
                [
                  { eff: 'low', label: 'Nhanh' },
                  { eff: 'medium', label: 'Tư duy' },
                  { eff: 'max', label: 'Pro' },
                ] as const
              ).map((p) => (
                <button
                  type="button"
                  onClick={() => setEffort(p.eff)}
                  class="px-2 py-0.5 rounded border text-[11px] cursor-pointer"
                  classList={{
                    'bg-[var(--accent-dim)] border-[var(--accent-cyan)] text-[var(--accent-cyan)] font-semibold':
                      effort() === p.eff,
                    'border-[var(--border-subtle)] text-[var(--ink-muted)]': effort() !== p.eff,
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div class="flex-1 overflow-y-auto p-4 space-y-3">
            <For each={qaHistory()}>
              {(turn) => (
                <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
                  <div class="text-[12.5px] font-semibold text-[var(--accent-cyan)]">{turn.q}</div>
                  <div class="omnia-prose text-[13px]" innerHTML={renderRichMarkdown(turn.a)} />
                  <div class="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)]">
                    <button
                      type="button"
                      class="omnia-btn text-[11px]"
                      onClick={() =>
                        openQuoteBtw({
                          text: turn.a.slice(0, 320),
                          sourceLabel: `Notebook ${activeNbId()}`,
                          surface: 'notebook',
                          notebookId: activeNbId(),
                        })
                      }
                    >
                      <MessageSquareQuote class="w-3 h-3 text-[var(--accent-amber)]" />
                      <span>Quote + BTW</span>
                    </button>
                    <Show when={(turn.citations ?? []).length > 0}>
                      <span class="text-[11px] font-mono-num text-[var(--status-emerald)]">
                        {turn.citations!.length} citations
                      </span>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>

          <div class="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] flex gap-2">
            <input
              type="text"
              placeholder="Ask across notebook sources with inline citations..."
              value={askPrompt()}
              onInput={(e) => setAskPrompt(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAsk();
              }}
              class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[13px] outline-none focus:border-[var(--border-accent)]"
            />
            <button type="button" class="omnia-btn omnia-btn-primary text-[12px]" onClick={() => void handleAsk()}>
              <Send class="w-3.5 h-3.5" />
              <span>Ask</span>
            </button>
          </div>
        </div>

        {/* 9 Interactive Studio Artifacts Column */}
        <Show when={layoutMode() === 'ke_nhau'}>
          <div class="border-l border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col overflow-hidden">
            <div class="p-3 border-b border-[var(--border-subtle)] text-[12px] font-semibold flex items-center gap-1.5">
              <Layers class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
              <span>9 Interactive Artifacts</span>
            </div>

            <div class="p-2.5 grid grid-cols-3 gap-1.5 border-b border-[var(--border-subtle)]">
              <For each={ARTIFACT_KINDS}>
                {(a) => (
                  <button
                    type="button"
                    onClick={() => void handleGenerateArtifact(a.kind, a.label)}
                    class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:border-[var(--border-accent)] text-[10.5px] font-medium text-left cursor-pointer"
                  >
                    <Sparkles class="w-3 h-3 text-[var(--accent-amber)] mb-0.5" />
                    <div class="truncate">{a.label}</div>
                  </button>
                )}
              </For>
            </div>

            <div class="flex-1 overflow-y-auto p-3 space-y-2.5">
              <For each={artifacts()}>
                {(art) => (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedArtifact(art);
                      setSlideIdx(0);
                      setFlashcardFlip(false);
                    }}
                    class="w-full p-2 rounded border text-left text-[12px] cursor-pointer"
                    classList={{
                      'bg-[var(--bg-elevated)] border-[var(--border-accent)]': selectedArtifact() === art,
                      'bg-[var(--bg-panel)] border-[var(--border-subtle)]': selectedArtifact() !== art,
                    }}
                  >
                    <div class="flex items-center justify-between">
                      <span class="font-semibold truncate">{String(art.title || art.kind)}</span>
                      <CheckCircle2 class="w-3.5 h-3.5 text-[var(--status-emerald)] shrink-0" />
                    </div>
                    <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)]">{String(art.kind)}</div>
                  </button>
                )}
              </For>

              <Show when={selectedArtifact()}>
                {(art) => (
                  <div class="omnia-surface-panel rounded p-3 space-y-2 text-[12px]">
                    <div class="font-bold text-[var(--accent-cyan)]">{String(art().title || art().kind)}</div>
                    <Show when={art().kind === 'flashcards'}>
                      <button
                        type="button"
                        onClick={() => setFlashcardFlip(!flashcardFlip())}
                        class="w-full p-4 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-center cursor-pointer"
                      >
                        <div class="text-[10px] font-mono-num uppercase text-[var(--accent-amber)] mb-1">
                          {flashcardFlip() ? 'Answer (Click to Flip)' : 'Prompt (Click to Flip)'}
                        </div>
                        <div>{String(art().content_markdown || art().content || 'Flashcard deck generated')}</div>
                      </button>
                    </Show>
                    <Show when={art().kind === 'slide_deck'}>
                      <div class="flex items-center justify-between text-[11px] font-mono-num">
                        <button type="button" class="omnia-btn px-2 py-0.5" onClick={() => setSlideIdx(Math.max(0, slideIdx() - 1))}>Prev</button>
                        <span>Slide {slideIdx() + 1}</span>
                        <button type="button" class="omnia-btn px-2 py-0.5" onClick={() => setSlideIdx(slideIdx() + 1)}>Next</button>
                      </div>
                    </Show>
                    <div
                      class="omnia-prose text-[12px] max-h-60 overflow-y-auto"
                      innerHTML={renderRichMarkdown(String(art().content_markdown || art().body || JSON.stringify(art(), null, 2)))}
                    />
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
