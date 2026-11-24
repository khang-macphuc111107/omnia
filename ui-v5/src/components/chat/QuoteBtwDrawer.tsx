import { For, Show, createEffect, createSignal } from 'solid-js';
import { ArrowUpRight, MessageSquareQuote, Send, X } from 'lucide-solid';
import { api } from '@/api/client';
import {
  activeBtwQuote,
  activeBtwThreadId,
  activeSessionId,
  btwDrawerOpen,
  btwThreads,
  modelConfig,
  setActiveBtwThreadId,
  setBtwDrawerOpen,
  setBtwThreads,
  setComposerDraft,
} from '@/state/studio';
import type { BtwThread } from '@/types';
import { renderRichMarkdown } from '@/utils/markdown';

export function QuoteBtwDrawer() {
  const [question, setQuestion] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  const activeThread = () => btwThreads.find((t) => t.id === activeBtwThreadId()) ?? null;

  createEffect(() => {
    if (btwDrawerOpen()) {
      const q = activeBtwQuote();
      if (q) {
        const scopeId = q.surface === 'notebook' ? (q.notebookId || 'nb-default') : activeSessionId();
        void api.listBtw(scopeId, q.surface).then((res) => {
          if (res.ok && Array.isArray(res.data.threads)) {
            setBtwThreads(res.data.threads);
          }
        });
      }
    }
  });

  const handleAsk = async () => {
    const qText = question().trim();
    const quote = activeBtwQuote();
    if (!qText || !quote) return;
    setLoading(true);
    setQuestion('');

    const currentThread = activeThread();
    if (currentThread) {
      const res = await api.appendBtw(currentThread.id, qText, modelConfig.subagentModel);
      if (res.ok && res.data.thread) {
        setBtwThreads(btwThreads.map((t) => (t.id === res.data.thread!.id ? res.data.thread! : t)));
      }
    } else {
      const res = await api.askBtw({
        surface: quote.surface,
        session_id: quote.surface === 'chat' ? activeSessionId() : undefined,
        notebook_id: quote.surface === 'notebook' ? quote.notebookId : undefined,
        quote: {
          text: quote.text,
          source_label: quote.sourceLabel,
          message_id: quote.messageId,
        },
        question: qText,
        model: modelConfig.subagentModel,
        effort: modelConfig.subagentEffort,
      });

      if (res.ok && res.data.thread) {
        setBtwThreads([res.data.thread, ...btwThreads]);
        setActiveBtwThreadId(res.data.thread.id);
      } else {
        // Explicit client-side fallback record when backend returns an error
        const localThread: BtwThread = {
          id: `btw-${Date.now()}`,
          surface: quote.surface,
          session_id: activeSessionId(),
          quote: { text: quote.text, source_label: quote.sourceLabel },
          messages: [
            { id: `bu-${Date.now()}`, role: 'user', content: qText },
            {
              id: `ba-${Date.now() + 1}`,
              role: 'assistant',
              content: res.ok ? String(res.data.answer ?? '') : `Backend status (${res.error.code}): ${res.error.message}`,
              model: modelConfig.subagentModel,
            },
          ],
        };
        setBtwThreads([localThread, ...btwThreads]);
        setActiveBtwThreadId(localThread.id);
      }
    }
    setLoading(false);
  };

  const handlePromote = async (thread: BtwThread) => {
    await api.promoteBtw(thread.id, thread.quote.source_label);
    const summary = thread.messages.map((m) => `**${m.role.toUpperCase()}**: ${m.content}`).join('\n');
    setComposerDraft(`> ${thread.quote.text}\n\n[Promoted BTW]\n${summary}\n`);
    setBtwDrawerOpen(false);
  };

  return (
    <Show when={btwDrawerOpen()}>
      <aside
        data-testid="quote-btw-drawer"
        class="w-96 max-w-[92vw] shrink-0 h-full border-l border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col"
      >
        <div class="p-3 border-b border-[var(--border-subtle)] flex items-center justify-between">
          <div class="flex items-center gap-2 font-semibold text-[13px]">
            <MessageSquareQuote class="w-4 h-4 text-[var(--accent-amber)]" />
            <span>Quote + BTW Side-Thread</span>
          </div>
          <button
            type="button"
            class="omnia-btn px-1.5 py-1"
            onClick={() => setBtwDrawerOpen(false)}
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>

        <Show when={activeBtwQuote()}>
          {(q) => (
            <div class="p-3 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)]">
              <div class="text-[10.5px] font-mono-num uppercase text-[var(--accent-amber)] mb-1">
                {q().surface} quote · {q().sourceLabel || 'selection'}
              </div>
              <blockquote class="text-[12px] text-[var(--ink-secondary)] border-l-2 border-[var(--accent-amber)] pl-2.5 line-clamp-4">
                {q().text}
              </blockquote>
            </div>
          )}
        </Show>

        <div class="flex-1 overflow-y-auto p-3 space-y-2.5">
          <Show when={activeThread()}>
            {(t) => (
              <>
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-mono-num text-[var(--ink-muted)]">Thread {t().id.slice(0, 10)}</span>
                  <button
                    type="button"
                    class="omnia-btn text-[11px]"
                    onClick={() => void handlePromote(t())}
                  >
                    <ArrowUpRight class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                    <span>Promote to Main</span>
                  </button>
                </div>
                <For each={t().messages}>
                  {(m) => (
                    <div
                      class="rounded p-2.5 border text-[12.5px]"
                      classList={{
                        'bg-[var(--omp-user-msg-bg)] border-[var(--omp-user-msg-border)]': m.role === 'user',
                        'bg-[var(--bg-panel)] border-[var(--border-subtle)]': m.role === 'assistant',
                      }}
                    >
                      <div class="text-[10px] font-mono-num text-[var(--ink-muted)] mb-1 uppercase">
                        {m.role} {m.model ? `· ${m.model}` : ''}
                      </div>
                      <div class="omnia-prose text-[12.5px]" innerHTML={renderRichMarkdown(m.content)} />
                    </div>
                  )}
                </For>
              </>
            )}
          </Show>
        </div>

        <div class="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] flex gap-2">
          <input
            type="text"
            placeholder="Ask a side question about this quote..."
            value={question()}
            onInput={(e) => setQuestion(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAsk();
            }}
            class="flex-1 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--border-accent)]"
          />
          <button
            type="button"
            disabled={loading()}
            onClick={() => void handleAsk()}
            class="omnia-btn omnia-btn-primary text-[12px]"
          >
            <Send class="w-3.5 h-3.5" />
          </button>
        </div>
      </aside>
    </Show>
  );
}
