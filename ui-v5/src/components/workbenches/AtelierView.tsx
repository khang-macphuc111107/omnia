import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import {
  BookOpen,
  CheckCircle2,
  FileText,
  Layers,
  MessageSquareQuote,
  Mic,
  Plus,
  RefreshCw,
  Send,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-solid';
import { api } from '@/api/client';
import { openQuoteBtw, privacyMask } from '@/state/studio';
import type { EffortLevel } from '@/types';
import { renderRichMarkdown } from '@/utils/markdown';
import { maskText } from '@/utils/privacy';

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

function extractSlides(art: Record<string, unknown>): string[] {
  if (Array.isArray(art.slides) && art.slides.length > 0) {
    return art.slides.map((s) => (typeof s === 'string' ? s : JSON.stringify(s, null, 2)));
  }
  const md = String(art.content_markdown ?? art.body ?? art.content ?? '');
  const byRule = md.split(/\n---+\n/).map((s) => s.trim()).filter(Boolean);
  if (byRule.length > 1) return byRule;
  const byHeading = md.split(/(?=^##\s)/m).map((s) => s.trim()).filter(Boolean);
  return byHeading.length > 0 ? byHeading : [md || 'Slide deck generated'];
}

function extractFlashcards(art: Record<string, unknown>): Array<{ q: string; a: string }> {
  if (Array.isArray(art.cards) && art.cards.length > 0) {
    return (art.cards as Array<Record<string, unknown>>).map((c) => ({
      q: String(c.question ?? c.front ?? c.prompt ?? 'Question'),
      a: String(c.answer ?? c.back ?? 'Answer'),
    }));
  }
  const md = String(art.content_markdown ?? art.body ?? art.content ?? '');
  const pairs: Array<{ q: string; a: string }> = [];
  const blocks = md.split(/\n\s*\n/).filter(Boolean);
  for (let i = 0; i < blocks.length; i += 2) {
    pairs.push({
      q: blocks[i],
      a: blocks[i + 1] ?? 'Review cited notebook source passages for the grounded explanation.',
    });
  }
  return pairs.length > 0 ? pairs : [{ q: 'Prompt', a: md || 'Flashcard generated' }];
}

export function AtelierView() {
  const [layoutMode, setLayoutMode] = createSignal<'gemini' | 'notebook' | 'ke_nhau'>('ke_nhau');
  const [notebooks, setNotebooks] = createSignal<Array<Record<string, unknown>>>([]);
  const [activeNbId, setActiveNbId] = createSignal<string>('');
  const [sources, setSources] = createSignal<Array<Record<string, unknown>>>([]);
  const [artifacts, setArtifacts] = createSignal<Array<Record<string, unknown>>>([]);
  const [selectedArtifact, setSelectedArtifact] = createSignal<Record<string, unknown> | null>(null);
  const [flashcardIdx, setFlashcardIdx] = createSignal(0);
  const [flashcardFlip, setFlashcardFlip] = createSignal(false);
  const [slideIdx, setSlideIdx] = createSignal(0);

  const [newSourceName, setNewSourceName] = createSignal('');
  const [newSourceText, setNewSourceText] = createSignal('');
  const [audioPath, setAudioPath] = createSignal('');
  const [shareUrl, setShareUrl] = createSignal('');
  const [shareGateState, setShareGateState] = createSignal<'idle' | 'ok' | 'auth_required' | 'captcha_blocked' | 'error'>('idle');
  const [askPrompt, setAskPrompt] = createSignal('');
  const [effort, setEffort] = createSignal<EffortLevel>('max');
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
    } else if (!res.ok) {
      setStatusMsg(`Create error (${res.error.code}): ${res.error.message}`);
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
      setStatusMsg(`Ingest error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleDeleteSource = async (sourceId: string) => {
    if (!activeNbId()) return;
    const res = await api.deleteSource(activeNbId(), sourceId);
    if (res.ok) {
      setStatusMsg(`Deleted source ${sourceId.slice(0, 10)}`);
      await refreshNotebookData(activeNbId());
    } else {
      setStatusMsg(`Delete error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleTranscribe = async () => {
    if (!audioPath().trim()) return;
    const nbId = await ensureNotebookId();
    if (!nbId) return;
    setStatusMsg('Running Whisper audio transcription...');
    const res = await api.transcribeAudio(nbId, audioPath().trim());
    if (res.ok) {
      setAudioPath('');
      setStatusMsg('Audio transcribed & ingested');
      await refreshNotebookData(nbId);
    } else {
      setStatusMsg(`Whisper (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleReconcileSync = async () => {
    const nbId = activeNbId();
    if (!nbId) return;
    const res = await api.reconcileNotebookSync(nbId);
    setStatusMsg(res.ok ? 'Notebook tombstones reconciled' : `Sync error (${res.error.code}): ${res.error.message}`);
    await refreshNotebookData(nbId);
  };

  const handleImportShare = async () => {
    if (!shareUrl().trim()) return;
    const nbId = await ensureNotebookId();
    if (!nbId) return;
    const res = await api.safeJson<Record<string, unknown>>('/api/notebooks/import-share', {
      method: 'POST',
      body: JSON.stringify({ notebook_id: nbId, share_url: shareUrl().trim() }),
    });
    if (res.ok) {
      const gate = String(res.data.state ?? res.data.status ?? '');
      if (gate === 'auth_required' || gate === 'captcha_blocked') {
        setShareGateState(gate);
        setStatusMsg(`Import halted honestly (${gate}) — never bypassing auth/CAPTCHA`);
      } else {
        setShareGateState('ok');
        setStatusMsg('Public Gemini share imported');
        await refreshNotebookData(nbId);
      }
    } else {
      const code = res.error.code;
      setShareGateState(code === 'auth_required' || code === 'captcha_blocked' ? code : 'error');
      setStatusMsg(`Import blocked (${code}): ${res.error.message}`);
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
      const inner = (res.data.result && typeof res.data.result === 'object' ? res.data.result : res.data) as Record<
        string,
        unknown
      >;
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
      setFlashcardIdx(0);
      setFlashcardFlip(false);
      setStatusMsg(`Generated ${label}`);
    } else if (!res.ok) {
      setStatusMsg(`Artifact error (${res.error.code}): ${res.error.message}`);
    }
  };

  const activeSlides = createMemo(() => (selectedArtifact() ? extractSlides(selectedArtifact()!) : []));
  const activeCards = createMemo(() => (selectedArtifact() ? extractFlashcards(selectedArtifact()!) : []));

  return (
    <div data-testid="atelier-workbench" class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
      {/* Atelier Header */}
      <div class="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-2">
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
          <button type="button" class="omnia-btn text-[11px]" onClick={() => void handleReconcileSync()} title="Reconcile Sync Tombstones">
            <RefreshCw class="w-3 h-3" />
            <span>Sync</span>
          </button>
        </div>

        <div class="flex items-center gap-2">
          <Show when={statusMsg()}>
            <span class="text-[11.5px] font-mono-num text-[var(--accent-cyan)]">{statusMsg()}</span>
          </Show>
          <div class="omp-segmented text-[11.5px]">
            {(
              [
                { id: 'gemini', label: 'Gemini' },
                { id: 'notebook', label: 'Notebook' },
                { id: 'ke_nhau', label: 'Kế nhau' },
              ] as const
            ).map((m) => (
              <button type="button" aria-pressed={layoutMode() === m.id} onClick={() => setLayoutMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 3-Column Studio Grid */}
      <div
        class="flex-1 min-h-0 grid overflow-hidden"
        classList={{
          'grid-cols-1 lg:grid-cols-[minmax(210px,250px)_minmax(260px,1fr)_minmax(240px,305px)]':
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
                {(s) => {
                  const sid = String(s.source_id ?? s.id ?? '');
                  return (
                    <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[12px] flex items-start justify-between gap-1.5">
                      <div class="min-w-0">
                        <div class="font-semibold truncate">
                          {maskText(String(s.title || s.safe_filename || s.filename || sid), privacyMask())}
                        </div>
                        <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)] mt-0.5">
                          {String(s.source_kind || s.kind || 'document')} · {String(s.chunk_count ?? 1)} chunks
                        </div>
                      </div>
                      <Show when={sid}>
                        <button
                          type="button"
                          class="p-1 text-[var(--ink-muted)] hover:text-[var(--status-coral)] cursor-pointer"
                          title="Delete source"
                          onClick={() => void handleDeleteSource(sid)}
                        >
                          <Trash2 class="w-3 h-3" />
                        </button>
                      </Show>
                    </div>
                  );
                }}
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

              {/* Whisper Audio Transcribe */}
              <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
                <input
                  type="text"
                  placeholder="Audio path for Whisper transcribe..."
                  value={audioPath()}
                  onInput={(e) => setAudioPath(e.currentTarget.value)}
                  class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
                />
                <button type="button" class="omnia-btn w-full justify-center text-[11px]" onClick={() => void handleTranscribe()}>
                  <Mic class="w-3 h-3 text-[var(--accent-cyan)]" />
                  <span>Whisper Transcribe</span>
                </button>
              </div>

              {/* Public Gemini Share Import (Non-Bypassing) */}
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
                <Show when={shareGateState() === 'auth_required' || shareGateState() === 'captcha_blocked'}>
                  <div class="px-2 py-1 rounded border border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] text-[10.5px] font-mono-num text-[var(--accent-amber)]">
                    Gate: {shareGateState()} (non-bypass enforced)
                  </div>
                </Show>
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
                  { eff: 'high', label: 'Deep' },
                  { eff: 'max', label: 'Pro Max' },
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
                  <div class="omnia-prose text-[13px]" innerHTML={renderRichMarkdown(maskText(turn.a, privacyMask()))} />
                  <Show when={(turn.citations ?? []).length > 0}>
                    <div class="flex flex-wrap gap-1 pt-1">
                      <For each={turn.citations}>
                        {(cit, idx) => (
                          <button
                            type="button"
                            class="omnia-badge text-[var(--status-emerald)] cursor-pointer hover:border-[var(--border-accent)]"
                            onClick={() =>
                              openQuoteBtw({
                                text: cit,
                                sourceLabel: `Citation [${idx() + 1}]`,
                                surface: 'notebook',
                                notebookId: activeNbId(),
                              })
                            }
                          >
                            [{idx() + 1}] {cit.slice(0, 36)}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
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
                    <span class="text-[11px] font-mono-num text-[var(--ink-muted)]">
                      {(turn.citations ?? []).length} citations
                    </span>
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
                      setFlashcardIdx(0);
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
                      <div class="space-y-1.5">
                        <div class="flex items-center justify-between text-[10.5px] font-mono-num">
                          <button
                            type="button"
                            class="omnia-btn px-2 py-0.5"
                            onClick={() => {
                              setFlashcardIdx((i) => Math.max(0, i - 1));
                              setFlashcardFlip(false);
                            }}
                          >
                            Prev
                          </button>
                          <span>
                            Card {Math.min(flashcardIdx() + 1, activeCards().length)} / {activeCards().length}
                          </span>
                          <button
                            type="button"
                            class="omnia-btn px-2 py-0.5"
                            onClick={() => {
                              setFlashcardIdx((i) => Math.min(activeCards().length - 1, i + 1));
                              setFlashcardFlip(false);
                            }}
                          >
                            Next
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => setFlashcardFlip(!flashcardFlip())}
                          class="w-full p-3.5 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-left cursor-pointer"
                        >
                          <div class="text-[10px] font-mono-num uppercase text-[var(--accent-amber)] mb-1">
                            {flashcardFlip() ? 'Answer (Click to Flip)' : 'Prompt (Click to Flip)'}
                          </div>
                          <div class="text-[12px]">
                            {flashcardFlip()
                              ? activeCards()[flashcardIdx()]?.a
                              : activeCards()[flashcardIdx()]?.q}
                          </div>
                        </button>
                      </div>
                    </Show>

                    <Show when={art().kind === 'slide_deck'}>
                      <div class="space-y-1.5">
                        <div class="flex items-center justify-between text-[11px] font-mono-num">
                          <button
                            type="button"
                            class="omnia-btn px-2 py-0.5"
                            onClick={() => setSlideIdx((i) => Math.max(0, i - 1))}
                          >
                            Prev
                          </button>
                          <span>
                            Slide {Math.min(slideIdx() + 1, activeSlides().length)} / {activeSlides().length}
                          </span>
                          <button
                            type="button"
                            class="omnia-btn px-2 py-0.5"
                            onClick={() => setSlideIdx((i) => Math.min(activeSlides().length - 1, i + 1))}
                          >
                            Next
                          </button>
                        </div>
                        <div
                          class="omnia-prose text-[12px] p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]"
                          innerHTML={renderRichMarkdown(activeSlides()[slideIdx()] ?? '')}
                        />
                      </div>
                    </Show>

                    <Show when={art().kind !== 'flashcards' && art().kind !== 'slide_deck'}>
                      <div
                        class="omnia-prose text-[12px] max-h-60 overflow-y-auto"
                        innerHTML={renderRichMarkdown(
                          String(art().content_markdown || art().body || JSON.stringify(art(), null, 2)),
                        )}
                      />
                    </Show>
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
