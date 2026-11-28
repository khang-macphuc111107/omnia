import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import {
  AlertTriangle,
  ArrowUpRight,
  BookMarked,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Edit3,
  Eye,
  GitFork,
  Globe,
  History,
  LayoutPanelLeft,
  Loader2,
  MessageSquareQuote,
  RefreshCw,
  Sparkles,
  Wrench,
} from 'lucide-solid';
import { api } from '@/api/client';
import type { CanvasArtifact } from '@/components/chat/ArtifactCanvasDrawer';
import { DiffCard } from '@/components/chat/DiffCard';
import {
  activeSessionId,
  editAndBranchMessage,
  flashNotice,
  messages,
  openCanvasArtifact,
  openCitationSource,
  openQuoteBtw,
  openRewindPreview,
  openSourcePreview,
  privacyMask,
  refreshResearchSources,
  regenerateAssistantTurn,
  researchSources,
  selectAndLoadSession,
  sendComposerMessage,
  sessions,
  setComposerDraft,
  setResearchDrawerOpen,
  setSessions,
  switchMessageBranch,
} from '@/state/studio';
import type { ChatTurnMessage } from '@/types';
import { handleRichMarkdownClick, renderRichMarkdown } from '@/utils/markdown';
import { maskText } from '@/utils/privacy';

let mermaidModule: typeof import('mermaid').default | null = null;
let mermaidSeq = 0;

function extractCanvasArtifacts(content: string, msgId: string): CanvasArtifact[] {
  const results: CanvasArtifact[] = [];
  const fenceRe = /```([a-zA-Z0-9_+#.-]*)\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = fenceRe.exec(content)) !== null) {
    const rawLang = (match[1] || 'text').toLowerCase();
    const body = match[2].trim();
    if (!body) continue;
    let kind: CanvasArtifact['kind'] | null = null;
    if (rawLang === 'html' || rawLang === 'htm') kind = 'html';
    else if (rawLang === 'svg' || (rawLang === 'xml' && body.includes('<svg'))) kind = 'svg';
    else if (rawLang === 'mermaid' || rawLang === 'mmd') kind = 'mermaid';
    else if (rawLang === 'csv' || rawLang === 'tsv') kind = 'csv';
    else if (rawLang === 'json' && body.length >= 24) kind = 'json';
    else if (rawLang === 'md' || rawLang === 'markdown') kind = 'markdown';
    else if (body.length >= 80) kind = 'code';

    if (kind) {
      idx++;
      results.push({
        id: `${msgId}-art-${idx}`,
        title: `${rawLang.toUpperCase() || kind.toUpperCase()} Artifact #${idx}`,
        kind,
        language: rawLang || kind,
        content: body,
        sourceMsgId: msgId,
      });
    }
  }
  return results;
}

async function hydrateMermaidBlocks(container: HTMLElement): Promise<void> {
  const nodes = container.querySelectorAll<HTMLElement>('.omnia-mermaid[data-mermaid]');
  if (nodes.length === 0) return;
  if (!mermaidModule) {
    const mod = await import('mermaid');
    mermaidModule = mod.default;
    mermaidModule.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: document.documentElement.getAttribute('data-theme') === 'alabaster' ? 'default' : 'dark',
    });
  }
  for (const el of nodes) {
    if (el.dataset.rendered === 'true') continue;
    const raw = decodeURIComponent(el.dataset.mermaid || '');
    if (!raw.trim()) continue;
    try {
      const id = `omnia-mmd-${++mermaidSeq}`;
      const { svg } = await mermaidModule.render(id, raw);
      el.innerHTML = svg;
      el.dataset.rendered = 'true';
    } catch {
      // Keep source code fallback cleanly
    }
  }
}

function RichMessageBody(props: { content: string; streaming?: boolean }) {
  let bodyRef: HTMLDivElement | undefined;
  const html = createMemo(() => renderRichMarkdown(maskText(props.content, privacyMask())));

  createEffect(() => {
    html();
    if (bodyRef && !props.streaming) {
      void hydrateMermaidBlocks(bodyRef);
    }
  });

  return (
    <div
      ref={bodyRef}
      class="omnia-prose"
      onClick={(e) =>
        handleRichMarkdownClick(e, {
          onCitationClick: openCitationSource,
          onNotify: flashNotice,
        })
      }
    >
      <div innerHTML={html()} />
      <Show when={props.streaming}>
        <span class="inline-block w-2 h-4 ml-0.5 align-middle bg-[var(--accent-cyan)] animate-pulse" />
      </Show>
    </div>
  );
}

function TurnRow(props: { msg: ChatTurnMessage; index: number; onJumpToMessage?: (msgId: string) => void }) {
  const [thinkingOpen, setThinkingOpen] = createSignal(false);
  const [toolsOpen, setToolsOpen] = createSignal(true);
  const [copied, setCopied] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [editDraft, setEditDraft] = createSignal('');

  const canvasArtifacts = createMemo(() =>
    props.msg.role === 'assistant' && !props.msg.streaming
      ? extractCanvasArtifacts(props.msg.content, props.msg.id)
      : [],
  );

  const branchCount = () => props.msg.branches?.length ?? 0;
  const activeBranchDisplay = () => (props.msg.activeBranchIdx ?? Math.max(0, branchCount() - 1)) + 1;

  const estimatedThinkTokens = createMemo(() =>
    props.msg.thinking ? Math.max(1, Math.ceil(props.msg.thinking.length / 4)) : 0,
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(maskText(props.msg.content, privacyMask()));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      flashNotice('Clipboard access blocked by browser policy');
    }
  };

  const handleForkFromHere = async () => {
    const turn = props.msg.turnIdx ?? props.index;
    const v5Res = await api.forkSessionById(activeSessionId(), turn);
    const res = v5Res.ok && v5Res.data.session ? v5Res : await api.forkSession(activeSessionId(), turn);
    if (res.ok && res.data.session) {
      setSessions([res.data.session, ...sessions]);
      await selectAndLoadSession(res.data.session.id);
      flashNotice(`Forked thread from T${props.index}`);
    } else if (!res.ok) {
      flashNotice(`Fork failed (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleRewindHere = async () => {
    await openRewindPreview(props.msg.turnIdx ?? props.index);
  };

  const handleQuoteBtw = () => {
    const sel = window.getSelection()?.toString().trim();
    const quoteText = sel && sel.length > 0 ? sel : props.msg.content.slice(0, 420);
    openQuoteBtw({
      text: quoteText,
      sourceLabel: props.msg.role === 'user' ? 'User prompt' : `${props.msg.model || 'Assistant'} · T${props.index}`,
      messageId: props.msg.id,
      surface: 'chat',
    });
  };

  return (
    <article data-turn-index={props.index} class="px-4 py-2.5 max-w-4xl mx-auto w-full">
      <Show
        when={props.msg.role === 'user'}
        fallback={
          <div class="group rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-3.5 shadow-[var(--shadow-sm)] min-w-0">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-2 text-[11px] font-mono-num text-[var(--ink-muted)]">
              <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                <span class="font-bold text-[var(--accent-cyan)]">OMNIA</span>
                <Show when={props.msg.model}>
                  <span class="omnia-badge">{props.msg.model}</span>
                </Show>
                <Show when={props.msg.effort}>
                  <span class="omnia-badge text-[var(--accent-amber)]">{props.msg.effort}</span>
                </Show>
                <Show when={props.msg.mode}>
                  <span class="omnia-badge uppercase">{props.msg.mode}</span>
                </Show>
                <Show when={props.msg.epistemicGrade}>
                  <span class="omnia-badge text-[var(--status-emerald)]">{props.msg.epistemicGrade}</span>
                </Show>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Show when={props.msg.durationMs}>
                  <span>{(props.msg.durationMs! / 1000).toFixed(2)}s</span>
                </Show>
                <Show when={props.msg.tokensPerSec}>
                  <span>{props.msg.tokensPerSec!.toFixed(1)} tok/s</span>
                </Show>
                <Show when={props.msg.kvCacheHitRate !== undefined}>
                  <span class="text-[var(--status-emerald)]">
                    KV {(props.msg.kvCacheHitRate! * 100).toFixed(0)}%
                  </span>
                </Show>
                <Show when={props.msg.costUsd !== undefined}>
                  <span>${props.msg.costUsd!.toFixed(6)}</span>
                </Show>
              </div>
            </div>

            {/* Perplexity-Style Top Source Carousel */}
            <Show when={(props.msg.sources ?? []).length > 0}>
              <div data-testid="perplexity-source-carousel" class="mb-3 space-y-1.5">
                <div class="flex items-center gap-1.5 text-[10.5px] font-mono-num text-[var(--ink-muted)]">
                  <Globe class="w-3 h-3 text-[var(--accent-cyan)]" />
                  <span>Cited Sources ({props.msg.sources!.length})</span>
                </div>
                <div class="flex gap-2 overflow-x-auto pb-1">
                  <For each={props.msg.sources}>
                    {(src) => (
                      <button
                        type="button"
                        onClick={() => openCitationSource(src.citationId)}
                        class="shrink-0 w-52 p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:border-[var(--border-accent)] text-left cursor-pointer space-y-1"
                      >
                        <div class="flex items-center justify-between gap-1 text-[10px] font-mono-num">
                          <span class="font-bold text-[var(--accent-cyan)]">[{src.citationId}]</span>
                          <span class="text-[var(--ink-muted)] truncate">{src.domain || src.tier}</span>
                        </div>
                        <div class="text-[11px] font-semibold text-[var(--ink-primary)] line-clamp-2">
                          {maskText(src.title || src.url || src.citationId, privacyMask())}
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Claude-Grade Collapsible Thinking & Tool Timeline Accordion */}
            <Show when={(props.msg.thinking && props.msg.thinking.trim().length > 0) || (props.msg.toolCalls ?? []).length > 0}>
              <div class="mb-3 space-y-2">
                <Show when={props.msg.thinking && props.msg.thinking.trim().length > 0}>
                  <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                    <button
                      type="button"
                      onClick={() => setThinkingOpen(!thinkingOpen())}
                      class="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--ink-secondary)] cursor-pointer"
                    >
                      <span class="flex items-center gap-1.5 min-w-0">
                        <Brain class="w-3.5 h-3.5 text-[var(--accent-amber)] shrink-0" />
                        <span class="truncate">Thought Process</span>
                        <Show when={props.msg.effort}>
                          <span class="omnia-badge text-[10px] font-mono-num text-[var(--accent-amber)]">{props.msg.effort}</span>
                        </Show>
                        <span class="font-mono-num text-[10.5px] text-[var(--ink-muted)]">
                          ~{estimatedThinkTokens()} tok
                          <Show when={props.msg.thinkingDurationMs || props.msg.durationMs}>
                            {' '}· {props.msg.thinkingDurationMs ?? props.msg.durationMs}ms
                          </Show>
                        </span>
                      </span>
                      {thinkingOpen() ? <ChevronDown class="w-3.5 h-3.5 shrink-0" /> : <ChevronRight class="w-3.5 h-3.5 shrink-0" />}
                    </button>
                    <Show when={thinkingOpen()}>
                      <div class="px-3 pb-2.5 pt-1 text-[12px] text-[var(--ink-secondary)] whitespace-pre-wrap border-t border-[var(--border-subtle)] max-h-60 overflow-y-auto font-mono-num">
                        {maskText(props.msg.thinking!, privacyMask())}
                      </div>
                    </Show>
                  </div>
                </Show>

                <Show when={(props.msg.toolCalls ?? []).length > 0}>
                  <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-rail)] overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setToolsOpen(!toolsOpen())}
                      class="w-full flex items-center justify-between px-2.5 py-1.5 text-[11.5px] font-semibold text-[var(--ink-secondary)] cursor-pointer border-b border-[var(--border-subtle)]"
                    >
                      <span class="flex items-center gap-1.5">
                        <Wrench class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
                        <span>Tool Execution Timeline ({props.msg.toolCalls!.length})</span>
                      </span>
                      {toolsOpen() ? <ChevronDown class="w-3.5 h-3.5" /> : <ChevronRight class="w-3.5 h-3.5" />}
                    </button>
                    <Show when={toolsOpen()}>
                      <div class="divide-y divide-[var(--border-subtle)]">
                        <For each={props.msg.toolCalls}>
                          {(tc) => (
                            <div
                              class="px-3 py-2 text-[12px]"
                              classList={{
                                'bg-[var(--omp-tool-pending-bg)]': tc.status === 'running',
                                'bg-[var(--omp-tool-success-bg)]': tc.status === 'completed',
                                'bg-[var(--omp-tool-error-bg)]': tc.status === 'error',
                              }}
                            >
                              <div class="flex items-center justify-between font-mono-num">
                                <span class="flex items-center gap-1.5 font-semibold text-[var(--ink-primary)]">
                                  <Show
                                    when={tc.status === 'running'}
                                    fallback={
                                      tc.status === 'error' ? (
                                        <AlertTriangle class="w-3.5 h-3.5 text-[var(--status-coral)]" />
                                      ) : (
                                        <Check class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                                      )
                                    }
                                  >
                                    <Loader2 class="w-3.5 h-3.5 animate-spin text-[var(--accent-cyan)]" />
                                  </Show>
                                  <span>{tc.name}</span>
                                </span>
                                <Show when={tc.durationMs !== undefined}>
                                  <span class="text-[11px] text-[var(--ink-muted)]">{tc.durationMs}ms</span>
                                </Show>
                              </div>
                              <Show when={tc.arguments}>
                                <div class="mt-1 text-[11px] font-mono-num text-[var(--ink-muted)] truncate">
                                  {maskText(tc.arguments!, privacyMask())}
                                </div>
                              </Show>
                              <Show when={tc.output}>
                                <pre class="mt-1.5 p-2 rounded bg-[var(--bg-code)] border border-[var(--border-subtle)] text-[11px] font-mono-num text-[var(--ink-secondary)] max-h-40 overflow-auto whitespace-pre-wrap">
                                  {maskText(tc.output!, privacyMask())}
                                </pre>
                              </Show>
                              <Show when={tc.diffPatch}>
                                <DiffCard patch={maskText(tc.diffPatch!, privacyMask())} path={tc.diffPath} />
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={props.msg.error}>
              <div class="mb-2 px-3 py-2 rounded border border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[12.5px] text-[var(--status-coral)]">
                {maskText(props.msg.error!, privacyMask())}
              </div>
            </Show>

            <RichMessageBody content={props.msg.content} streaming={props.msg.streaming} />

            {/* Auto-Detected Interactive Canvas / Live Preview Artifact Chips */}
            <Show when={canvasArtifacts().length > 0}>
              <div class="mt-2.5 flex flex-wrap gap-1.5">
                <For each={canvasArtifacts()}>
                  {(art) => (
                    <button
                      type="button"
                      data-testid="open-in-canvas-btn"
                      class="omnia-btn px-2.5 py-1 text-[11px] border-[var(--border-accent)] text-[var(--accent-cyan)]"
                      onClick={() => openCanvasArtifact(art)}
                    >
                      <LayoutPanelLeft class="w-3.5 h-3.5" />
                      <span>Open in Canvas / Preview ({art.title})</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            {/* Perplexity-Style Related Follow-Up Questions */}
            <Show when={(props.msg.relatedQuestions ?? []).length > 0}>
              <div data-testid="related-followups" class="mt-3 pt-2.5 border-t border-[var(--border-subtle)] space-y-1.5">
                <div class="text-[10.5px] font-mono-num uppercase tracking-wider text-[var(--ink-muted)]">
                  Related Follow-Ups
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <For each={props.msg.relatedQuestions}>
                    {(q) => (
                      <button
                        type="button"
                        class="omnia-btn px-2.5 py-1 text-[11.5px] text-left"
                        onClick={() => void sendComposerMessage(q)}
                      >
                        <ArrowUpRight class="w-3 h-3 text-[var(--accent-cyan)] shrink-0" />
                        <span>{q}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* 6-State Epistemic Receipt Badges */}
            <Show when={props.msg.sixStateReceipt && Object.keys(props.msg.sixStateReceipt).length > 0}>
              <div class="mt-2 flex flex-wrap gap-1 text-[10px] font-mono-num">
                <For each={Object.entries(props.msg.sixStateReceipt!)}>
                  {([k, v]) => (
                    <span class="omnia-badge text-[var(--ink-secondary)]">
                      {k}: {String(v)}
                    </span>
                  )}
                </For>
              </div>
            </Show>

            {/* Action bar with ChatGPT Branching, Regenerate, Fork & Canvas */}
            <div class="mt-3 pt-2 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--ink-muted)]">
              <div class="flex flex-wrap items-center gap-1.5">
                <Show when={branchCount() > 1}>
                  <div class="inline-flex items-center gap-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1 py-0.5 font-mono-num text-[10.5px]">
                    <button
                      type="button"
                      class="p-0.5 hover:text-[var(--accent-cyan)] cursor-pointer"
                      title="Previous branch"
                      onClick={() => switchMessageBranch(props.index, -1)}
                    >
                      <ChevronLeft class="w-3 h-3" />
                    </button>
                    <span>
                      {activeBranchDisplay()}/{branchCount()}
                    </span>
                    <button
                      type="button"
                      class="p-0.5 hover:text-[var(--accent-cyan)] cursor-pointer"
                      title="Next branch"
                      onClick={() => switchMessageBranch(props.index, 1)}
                    >
                      <ChevronRight class="w-3 h-3" />
                    </button>
                  </div>
                </Show>

                <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={() => void handleCopy()}>
                  {copied() ? <Check class="w-3 h-3 text-[var(--status-emerald)]" /> : <Copy class="w-3 h-3" />}
                  <span>{copied() ? 'Copied' : 'Copy'}</span>
                </button>
                <button
                  type="button"
                  class="omnia-btn px-2 py-1 text-[11px]"
                  onClick={() => void regenerateAssistantTurn(props.index)}
                  title="Regenerate response & save branch"
                >
                  <RefreshCw class="w-3 h-3 text-[var(--accent-cyan)]" />
                  <span>Regenerate</span>
                </button>
                <button
                  type="button"
                  data-action="quote-btw"
                  class="omnia-btn px-2 py-1 text-[11px]"
                  onClick={handleQuoteBtw}
                >
                  <MessageSquareQuote class="w-3 h-3 text-[var(--accent-amber)]" />
                  <span>Quote + BTW</span>
                </button>
                <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={() => void handleForkFromHere()}>
                  <GitFork class="w-3 h-3" />
                  <span>Fork</span>
                </button>
                <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={() => void handleRewindHere()}>
                  <History class="w-3 h-3" />
                  <span>/rewind</span>
                </button>
                <button
                  type="button"
                  class="omnia-btn px-2 py-1 text-[11px]"
                  onClick={() =>
                    openCanvasArtifact({
                      id: `${props.msg.id}-md`,
                      title: `Turn T${props.index} Markdown`,
                      kind: 'markdown',
                      language: 'markdown',
                      content: props.msg.content,
                      sourceMsgId: props.msg.id,
                    })
                  }
                  title="Open full message in Artifact Canvas"
                >
                  <LayoutPanelLeft class="w-3 h-3 text-[var(--accent-cyan)]" />
                  <span>Canvas</span>
                </button>
                <button
                  type="button"
                  class="omnia-btn px-2 py-1 text-[11px]"
                  onClick={() => {
                    setResearchDrawerOpen(true);
                    void refreshResearchSources();
                  }}
                >
                  <BookMarked class="w-3 h-3 text-[var(--accent-cyan)]" />
                  <span>Sources ({(props.msg.citations ?? []).length || researchSources.length})</span>
                </button>
              </div>
              <Show when={(props.msg.citations ?? []).length > 0}>
                <div class="flex flex-wrap gap-1">
                  <For each={props.msg.citations!.slice(0, 6)}>
                    {(cid) => (
                      <button
                        type="button"
                        class="omnia-citation-chip"
                        onClick={() => openCitationSource(cid)}
                      >
                        [{cid}]
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        }
      >
        {/* User Bubble with Edit & Branch (< 1/N >) */}
        <div class="ml-auto max-w-2xl rounded-lg border border-[var(--omp-user-msg-border)] bg-[var(--omp-user-msg-bg)] px-3.5 py-2.5">
          <div class="flex items-center justify-between gap-2 mb-1 text-[11px] font-mono-num text-[var(--ink-muted)]">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-[var(--ink-primary)]">YOU</span>
              <Show when={branchCount() > 1}>
                <span class="inline-flex items-center gap-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1 text-[10px]">
                  <button
                    type="button"
                    class="cursor-pointer hover:text-[var(--accent-cyan)]"
                    onClick={() => switchMessageBranch(props.index, -1)}
                  >
                    &lt;
                  </button>
                  <span>
                    {activeBranchDisplay()}/{branchCount()}
                  </span>
                  <button
                    type="button"
                    class="cursor-pointer hover:text-[var(--accent-cyan)]"
                    onClick={() => switchMessageBranch(props.index, 1)}
                  >
                    &gt;
                  </button>
                </span>
              </Show>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="text-[11px] text-[var(--ink-muted)] hover:text-[var(--accent-cyan)] cursor-pointer flex items-center gap-1"
                onClick={() => {
                  setEditDraft(props.msg.content);
                  setEditing(!editing());
                }}
              >
                <Edit3 class="w-3 h-3" />
                <span>Edit &amp; Branch</span>
              </button>
              <button
                type="button"
                class="text-[11px] text-[var(--ink-muted)] hover:text-[var(--accent-amber)] cursor-pointer flex items-center gap-1"
                onClick={handleQuoteBtw}
              >
                <MessageSquareQuote class="w-3 h-3" />
                <span>BTW</span>
              </button>
            </div>
          </div>
          <Show when={(props.msg.quotes ?? []).length > 0}>
            <div class="mb-2 space-y-1">
              <For each={props.msg.quotes}>
                {(q) => (
                  <button
                    type="button"
                    class="msg-quote-card w-full text-left px-2.5 py-1.5 rounded border-l-2 border-[var(--accent-amber)] bg-[var(--bg-canvas)] text-[11.5px] cursor-pointer hover:border-[var(--accent-cyan)]"
                    onClick={() => q.originMessageId && props.onJumpToMessage?.(q.originMessageId)}
                    title={q.originMessageId ? 'Jump to origin message' : 'Quoted excerpt'}
                  >
                    <div class="text-[10px] font-mono-num text-[var(--accent-amber)]">
                      {q.sourceLabel || 'Quoted Passage'}
                    </div>
                    <div class="text-[var(--ink-secondary)] line-clamp-2">{maskText(q.text, privacyMask())}</div>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show
            when={editing()}
            fallback={
              <div class="text-[13.5px] whitespace-pre-wrap text-[var(--ink-primary)]">
                {maskText(props.msg.content, privacyMask())}
              </div>
            }
          >
            <div class="space-y-2">
              <textarea
                rows={3}
                value={editDraft()}
                onInput={(e) => setEditDraft(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-accent)] bg-[var(--bg-canvas)] p-2 text-[13px] text-[var(--ink-primary)] outline-none"
              />
              <div class="flex justify-end gap-1.5">
                <button type="button" class="omnia-btn px-2 py-0.5 text-[11px]" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="omnia-btn omnia-btn-primary px-2.5 py-0.5 text-[11px]"
                  onClick={() => {
                    const next = editDraft();
                    setEditing(false);
                    void editAndBranchMessage(props.index, next);
                  }}
                >
                  Save &amp; Branch
                </button>
              </div>
            </div>
          </Show>
          <Show when={(props.msg.attachments ?? []).length > 0}>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <For each={props.msg.attachments}>
                {(att) => (
                  <button
                    type="button"
                    class="omnia-badge font-mono-num cursor-pointer hover:border-[var(--border-accent)]"
                    title="Preview attachment in Universal 17-Format Viewer"
                    onClick={() =>
                      openSourcePreview({
                        id: att.id,
                        name: att.name,
                        mimeType: att.mimeType,
                        sizeBytes: att.sizeBytes,
                        sha256: att.sha256,
                        content: att.encryptedUnresolved
                          ? 'ENCRYPTED_UNRESOLVED (0B) — encrypted archive preview skipped safely.'
                          : `Attachment ${att.name}\nMIME: ${att.mimeType}\nSize: ${att.sizeBytes} bytes\nSHA-256: ${att.sha256}`,
                      })
                    }
                  >
                    <Eye class="w-3 h-3 text-[var(--accent-cyan)]" />
                    <span>
                      {att.name} ({att.encryptedUnresolved ? 'ENCRYPTED_UNRESOLVED' : `${att.sizeBytes}B`})
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </article>
  );
}

const STARTER_CARDS = [
  {
    title: 'Inspect 17-Crate Workspace',
    prompt: 'Analyze the active 17-crate Rust architecture in D:\\Omnia using Graphify traversal and summarize key invariants.',
  },
  {
    title: 'Scientific Derivation & LaTeX',
    prompt: 'Derive the Euler-Lagrange equation from Hamilton principle with clear steps and formatted $$...$$ equations.',
  },
  {
    title: 'Interactive HTML/SVG Canvas Demo',
    prompt: 'Build a self-contained offline SVG + HTML architecture diagram card showing Omnia Studio, Arena, Atelier, and OmniDrive.',
  },
];

export function Transcript(props: { compact?: boolean } = {}) {
  let scrollRef: HTMLDivElement | undefined;

  const virtualizer = createVirtualizer({
    get count() {
      return messages.length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => 220,
    overscan: 6,
  });

  createEffect(() => {
    const len = messages.length;
    if (len > 0 && scrollRef) {
      requestAnimationFrame(() => {
        if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
      });
    }
  });

  return (
    <div class="relative flex-1 min-h-0 flex">
      <div ref={scrollRef} class="flex-1 overflow-y-auto py-4">
        <Show
          when={messages.length > 0}
          fallback={
            <div class="max-w-3xl mx-auto px-4 py-6">
              <div class="flex items-center gap-2.5 mb-2">
                <Sparkles class="w-5 h-5 text-[var(--accent-amber)]" />
                <h1 class="text-lg font-bold tracking-tight">Omnia Flagship Studio</h1>
              </div>
              <p class="text-[13px] text-[var(--ink-secondary)] mb-5">
                Pure-Rust agentic workbench unifying SOLO YOLO execution, Multi-Model Parallel Arena, Live Interactive Artifacts Canvas, Perplexity-grade Deep Research, NotebookLM++ Atelier, and zero-CDN KaTeX/Mermaid rendering.
              </p>
              <div
                class="grid gap-3"
                classList={{
                  'grid-cols-1': Boolean(props.compact),
                  'grid-cols-1 md:grid-cols-3': !props.compact,
                }}
              >
                <For each={STARTER_CARDS}>
                  {(card) => (
                    <button
                      type="button"
                      onClick={() => {
                        setComposerDraft(card.prompt);
                        void sendComposerMessage(card.prompt);
                      }}
                      class="omnia-surface-panel rounded-lg p-3.5 text-left cursor-pointer hover:border-[var(--border-accent)] transition-colors"
                    >
                      <div class="text-[12.5px] font-semibold text-[var(--ink-primary)] mb-1">{card.title}</div>
                      <div class="text-[11.5px] text-[var(--ink-muted)] line-clamp-3">{card.prompt}</div>
                    </button>
                  )}
                </For>
              </div>
            </div>
          }
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            <For each={virtualizer.getVirtualItems()}>
              {(vRow) => {
                const msg = () => messages[vRow.index];
                return (
                  <Show when={msg()}>
                    <div
                      data-index={vRow.index}
                      ref={(el) => queueMicrotask(() => virtualizer.measureElement(el))}
                      style={{
                        position: 'absolute',
                        top: '0',
                        left: '0',
                        width: '100%',
                        transform: `translateY(${vRow.start}px)`,
                      }}
                    >
                      <TurnRow
                        msg={msg()!}
                        index={vRow.index}
                        onJumpToMessage={(msgId) => {
                          const idx = messages.findIndex((x) => x.id === msgId);
                          if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'start' });
                        }}
                      />
                    </div>
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      {/* OMP Floating Conversation Turn Navigation Dots */}
      <Show when={messages.length > 2}>
        <nav
          aria-label="Conversation turn markers"
          class="hidden lg:flex flex-col items-center justify-center gap-1.5 px-2 select-none"
        >
          <For each={messages}>
            {(m, i) => (
              <button
                type="button"
                title={`Jump to T${i()} (${m.role})`}
                onClick={() => virtualizer.scrollToIndex(i(), { align: 'start' })}
                class="w-2.5 h-2.5 rounded-full border cursor-pointer transition-transform hover:scale-125"
                classList={{
                  'bg-[var(--accent-cyan)] border-[var(--accent-cyan)]': m.role === 'assistant',
                  'bg-[var(--accent-amber)] border-[var(--accent-amber)]': m.role === 'user',
                  'bg-[var(--ink-muted)] border-[var(--border-subtle)]': m.role === 'system',
                }}
              />
            )}
          </For>
        </nav>
      </Show>
    </div>
  );
}
