import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { MessageSquarePlus, Send, Trash2 } from 'lucide-solid';
import { FileDiff, parsePatchFiles } from '@pierre/diffs';
import { composerDraft, flashNotice, setComposerDraft, themePref } from '@/state/studio';

interface AnnotatedDiffLine {
  index: number;
  raw: string;
  kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx';
  oldLine: number | null;
  newLine: number | null;
  anchor: string;
}

interface InlineDiffComment {
  id: string;
  lineIndex: number;
  anchor: string;
  lineText: string;
  comment: string;
}

function parseAnnotatedPatchLines(patch: string): AnnotatedDiffLine[] {
  const lines = patch.split(/\r?\n/);
  const out: AnnotatedDiffLine[] = [];
  let oldNum = 0;
  let newNum = 0;
  let inHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const hunkMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
    if (hunkMatch) {
      oldNum = Number(hunkMatch[1]);
      newNum = Number(hunkMatch[2]);
      inHunk = true;
      out.push({
        index: i,
        raw,
        kind: 'hunk',
        oldLine: null,
        newLine: null,
        anchor: `Hunk -${oldNum}/+${newNum}`,
      });
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      out.push({ index: i, raw, kind: 'meta', oldLine: null, newLine: null, anchor: `L${i + 1}` });
      continue;
    }
    if (raw.startsWith('+')) {
      const n = inHunk ? newNum++ : i + 1;
      out.push({ index: i, raw, kind: 'add', oldLine: null, newLine: n, anchor: `+L${n}` });
      continue;
    }
    if (raw.startsWith('-')) {
      const o = inHunk ? oldNum++ : i + 1;
      out.push({ index: i, raw, kind: 'del', oldLine: o, newLine: null, anchor: `-L${o}` });
      continue;
    }
    const o = inHunk ? oldNum++ : null;
    const n = inHunk ? newNum++ : i + 1;
    out.push({ index: i, raw, kind: 'ctx', oldLine: o, newLine: n, anchor: `L${n ?? i + 1}` });
  }
  return out;
}

export function DiffCard(props: { patch: string; path?: string }) {
  let hostRef: HTMLDivElement | undefined;
  const [fallbackMode, setFallbackMode] = createSignal(false);
  const [reviewMode, setReviewMode] = createSignal(false);
  const [activeLineIdx, setActiveLineIdx] = createSignal<number | null>(null);
  const [draftComment, setDraftComment] = createSignal('');
  const [comments, setComments] = createSignal<InlineDiffComment[]>([]);

  const annotatedLines = createMemo(() => parseAnnotatedPatchLines(props.patch || ''));
  const showInteractiveLines = () => fallbackMode() || reviewMode();

  const commentsForLine = (lineIndex: number) =>
    comments().filter((c) => c.lineIndex === lineIndex);

  const addLineComment = (line: AnnotatedDiffLine) => {
    const body = draftComment().trim();
    if (!body) return;
    const entry: InlineDiffComment = {
      id: `dc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      lineIndex: line.index,
      anchor: line.anchor,
      lineText: line.raw,
      comment: body,
    };
    setComments((prev) => [...prev, entry]);
    setDraftComment('');
    setActiveLineIdx(null);
  };

  const removeComment = (id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
  };

  const sendCommentsToComposer = () => {
    const list = comments();
    if (list.length === 0) return;
    const targetPath = props.path || 'patch diff';
    const block = [
      `Diff review comments for \`${targetPath}\`:`,
      ...list.map((c) => {
        const snippet = c.lineText.trim().slice(0, 120);
        return `- [${c.anchor}] \`${snippet || '(blank line)'}\`: ${c.comment}`;
      }),
    ].join('\n');
    const existing = composerDraft().trim();
    setComposerDraft(existing ? `${existing}\n\n${block}\n` : `${block}\n`);
    flashNotice(`Added ${list.length} diff review comment${list.length === 1 ? '' : 's'} to Composer`);
  };

  createEffect(() => {
    const patch = props.patch;
    const theme = themePref();
    if (!hostRef || !patch) return;

    let instance: FileDiff | null = null;
    try {
      const parsed = parsePatchFiles(patch);
      const firstFile = parsed?.[0]?.files?.[0];
      if (!firstFile) {
        setFallbackMode(true);
        return;
      }
      setFallbackMode(false);
      hostRef.innerHTML = '';
      instance = new FileDiff({
        theme: theme === 'alabaster' ? 'github-light' : 'github-dark',
        diffStyle: 'unified',
        overflow: 'wrap',
        disableFileHeader: false,
      });
      instance.render({
        fileDiff: firstFile,
        fileContainer: hostRef,
      });
    } catch {
      setFallbackMode(true);
    }

    onCleanup(() => {
      try {
        instance?.cleanUp();
      } catch {
        // ignore cleanup error
      }
    });
  });

  return (
    <div
      data-testid="diff-card"
      class="mt-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] overflow-hidden"
    >
      <div class="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] font-mono-num text-[var(--ink-secondary)]">
        <span class="truncate">{props.path || 'patch diff'}</span>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            data-testid="diff-inline-review-toggle"
            aria-pressed={showInteractiveLines()}
            onClick={() => setReviewMode(!reviewMode())}
            class="px-2 py-0.5 rounded border text-[10.5px] cursor-pointer inline-flex items-center gap-1"
            classList={{
              'border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--accent-cyan)] font-semibold':
                showInteractiveLines(),
              'border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]':
                !showInteractiveLines(),
            }}
            title="Click any diff line to attach PR-style inline review comments"
          >
            <MessageSquarePlus class="w-3 h-3" />
            <span>
              Inline Review{comments().length > 0 ? ` (${comments().length})` : ''}
            </span>
          </button>
          <Show when={comments().length > 0}>
            <button
              type="button"
              data-testid="diff-send-comments-btn"
              onClick={sendCommentsToComposer}
              class="omnia-btn omnia-btn-primary px-2 py-0.5 text-[10.5px]"
              title="Send all inline diff review comments to the Chat Composer"
            >
              <Send class="w-3 h-3" />
              <span>Send {comments().length} to Composer</span>
            </button>
          </Show>
          <span class="text-[var(--ink-muted)]">@pierre/diffs</span>
        </div>
      </div>

      <div
        ref={hostRef}
        class="text-xs overflow-x-auto"
        classList={{ hidden: showInteractiveLines() }}
      />

      <Show when={showInteractiveLines()}>
        <div
          data-testid="diff-interactive-lines"
          class="text-[11.5px] font-mono-num overflow-x-auto leading-relaxed divide-y divide-[var(--border-subtle)]/20"
        >
          <div class="px-2.5 py-1 text-[10px] text-[var(--ink-muted)] bg-[var(--bg-panel)] flex items-center justify-between">
            <span>Click any diff line to add an inline PR review comment.</span>
            <span>{annotatedLines().length} lines</span>
          </div>
          <For each={annotatedLines()}>
            {(line) => {
              const lineComments = () => commentsForLine(line.index);
              const isCommenting = () => activeLineIdx() === line.index;
              const isCommentable = line.kind !== 'meta';
              return (
                <div>
                  <div
                    role={isCommentable ? 'button' : undefined}
                    tabIndex={isCommentable ? 0 : undefined}
                    onClick={() => {
                      if (!isCommentable) return;
                      if (activeLineIdx() === line.index) {
                        setActiveLineIdx(null);
                      } else {
                        setActiveLineIdx(line.index);
                        setDraftComment('');
                      }
                    }}
                    onKeyDown={(e) => {
                      if (!isCommentable) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActiveLineIdx(activeLineIdx() === line.index ? null : line.index);
                      }
                    }}
                    class="group flex items-start gap-2 px-2 py-0.5 whitespace-pre-wrap break-all"
                    classList={{
                      'cursor-pointer hover:brightness-110': isCommentable,
                      'text-[var(--status-emerald)] bg-[var(--status-emerald-dim)]': line.kind === 'add',
                      'text-[var(--status-coral)] bg-[var(--status-coral-dim)]': line.kind === 'del',
                      'text-[var(--accent-cyan)] bg-[var(--bg-panel)]/70': line.kind === 'hunk',
                      'text-[var(--ink-muted)] bg-[var(--bg-panel)]/40': line.kind === 'meta',
                      'text-[var(--ink-secondary)]': line.kind === 'ctx',
                    }}
                  >
                    <span class="w-8 shrink-0 text-right select-none text-[10px] text-[var(--ink-muted)]">
                      {line.oldLine ?? ''}
                    </span>
                    <span class="w-8 shrink-0 text-right select-none text-[10px] text-[var(--ink-muted)]">
                      {line.newLine ?? ''}
                    </span>
                    <span class="w-4 shrink-0 select-none text-[10px] text-[var(--accent-cyan)] opacity-40 group-hover:opacity-100">
                      {isCommentable ? '+' : ''}
                    </span>
                    <span class="flex-1 min-w-0">{line.raw || ' '}</span>
                    <Show when={lineComments().length > 0}>
                      <span class="omnia-badge text-[9.5px] text-[var(--accent-amber)] shrink-0">
                        {lineComments().length} note{lineComments().length === 1 ? '' : 's'}
                      </span>
                    </Show>
                  </div>

                  <Show when={lineComments().length > 0}>
                    <div class="px-6 py-1.5 space-y-1 bg-[var(--bg-panel)] border-t border-[var(--border-subtle)]">
                      <For each={lineComments()}>
                        {(c) => (
                          <div class="flex items-start justify-between gap-2 px-2.5 py-1.5 rounded border border-[var(--border-accent)] bg-[var(--bg-elevated)] text-[11px] font-sans">
                            <div class="min-w-0">
                              <span class="font-mono-num text-[10px] text-[var(--accent-cyan)] mr-1.5">
                                [{c.anchor}]
                              </span>
                              <span class="text-[var(--ink-primary)] whitespace-pre-wrap break-words">
                                {c.comment}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeComment(c.id)}
                              class="text-[var(--ink-muted)] hover:text-[var(--status-coral)] cursor-pointer shrink-0 p-0.5"
                              title="Remove inline comment"
                            >
                              <Trash2 class="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={isCommenting()}>
                    <div class="px-6 py-2 bg-[var(--bg-elevated)] border-t border-[var(--border-accent)] flex flex-col gap-1.5 font-sans">
                      <div class="text-[10.5px] font-mono-num text-[var(--accent-cyan)]">
                        Comment on {props.path || 'patch'} [{line.anchor}]
                      </div>
                      <textarea
                        rows={2}
                        value={draftComment()}
                        placeholder="Write PR review comment (Ctrl+Enter to save)..."
                        onInput={(e) => setDraftComment(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                            e.preventDefault();
                            addLineComment(line);
                          } else if (e.key === 'Escape') {
                            setActiveLineIdx(null);
                          }
                        }}
                        class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px] text-[var(--ink-primary)] outline-none"
                      />
                      <div class="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          class="omnia-btn px-2 py-0.5 text-[10.5px]"
                          onClick={() => setActiveLineIdx(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          class="omnia-btn omnia-btn-primary px-2 py-0.5 text-[10.5px]"
                          onClick={() => addLineComment(line)}
                        >
                          Add Comment
                        </button>
                      </div>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
