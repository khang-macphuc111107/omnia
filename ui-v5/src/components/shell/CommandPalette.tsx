import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { Command, Search } from 'lucide-solid';
import {
  applyTheme,
  commandPaletteOpen,
  openWorkbench,
  setCommandPaletteOpen,
  setComposerDraft,
  setTopMode,
  composerDraft,
} from '@/state/studio';
import type { CommandAction } from '@/types';
import { LATEX_15_TEMPLATES } from '@/utils/markdown';

/**
 * Contiguous substring match in title, group, or keywords ALWAYS ranks strictly above
 * non-contiguous subsequence matches, even at the end of a long keyword list.
 */
export function scoreCommandMatch(action: CommandAction, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 100;

  const title = action.title.toLowerCase();
  const group = action.group.toLowerCase();
  const keywords = action.keywords.toLowerCase();

  // Contiguous matches (tier >= 1000)
  const titleIdx = title.indexOf(q);
  if (titleIdx === 0) return 3000;
  if (titleIdx > 0) return 2400 - Math.min(titleIdx, 200);
  if (group.includes(q)) return 1800;
  const kwIdx = keywords.indexOf(q);
  if (kwIdx >= 0) return 1500 - Math.min(kwIdx, 400);

  // Non-contiguous subsequence match (strictly below 1000)
  const haystack = `${title} ${group} ${keywords}`;
  let qi = 0;
  for (let i = 0; i < haystack.length && qi < q.length; i++) {
    if (haystack[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 400;
  return -1;
}

export function CommandPalette() {
  const [query, setQuery] = createSignal('');
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const allCommands = createMemo<CommandAction[]>(() => {
    const base: CommandAction[] = [
      { id: 'mode-chat', title: 'Switch to Chat Mode', group: 'Mode', keywords: 'chat conversation agent', shortcut: '1', run: () => setTopMode('chat') },
      { id: 'mode-ide', title: 'Switch to IDE Mode', group: 'Mode', keywords: 'ide editor codemirror terminal lsp', shortcut: '2', run: () => setTopMode('ide') },
      { id: 'mode-browser', title: 'Switch to Isolated CDP Browser', group: 'Mode', keywords: 'browser cdp virtual cursor chrome', shortcut: '3', run: () => setTopMode('browser') },
      { id: 'wb-atelier', title: 'Open Atelier Notebook Studio', group: 'Workbench', keywords: 'gemini notebook ke nhau artifacts btw', run: () => openWorkbench('atelier') },
      { id: 'wb-omnidrive', title: 'Open OmniDrive Pro Downloader', group: 'Workbench', keywords: 'download chunks hls dash ffmpeg drive', run: () => openWorkbench('omnidrive') },
      { id: 'wb-swarm', title: 'Open Peer-Mesh Swarm & Graphify', group: 'Workbench', keywords: 'peer mesh graphify traversal ast', run: () => openWorkbench('swarm') },
      { id: 'wb-obs', title: 'Open Router Lab, Stats & Credentials', group: 'Workbench', keywords: 'router quota circuit breaker spotlight traces stats credman', run: () => openWorkbench('observability') },
      { id: 'wb-know', title: 'Open Memory Vault, RAG & MCP/Skills', group: 'Workbench', keywords: 'memory vault erasure rag mcp skills hooks recipes', run: () => openWorkbench('knowledge') },
      { id: 'wb-bench', title: 'Open Coding Agent Benchmark Scoreboard', group: 'Workbench', keywords: 'benchmark scoreboard pass@1 axis omp codex', run: () => openWorkbench('benchmarks') },
      { id: 'theme-obsidian', title: 'Theme: Obsidian Atelier', group: 'Theme', keywords: 'dark obsidian default', run: () => applyTheme('obsidian') },
      { id: 'theme-titanium', title: 'Theme: Titanium (OMP Slate)', group: 'Theme', keywords: 'titanium slate omp gray', run: () => applyTheme('titanium') },
      { id: 'theme-alabaster', title: 'Theme: Alabaster Editorial', group: 'Theme', keywords: 'light alabaster porcelain paper', run: () => applyTheme('alabaster') },
      { id: 'theme-blueprint', title: 'Theme: Deep Sea / Midnight Blueprint', group: 'Theme', keywords: 'navy blueprint nord deep sea', run: () => applyTheme('blueprint') },
    ];

    const templates: CommandAction[] = LATEX_15_TEMPLATES.map((t) => ({
      id: `tpl-${t.id}`,
      title: `Insert ${t.category}: ${t.title}`,
      group: 'LaTeX Template',
      keywords: `${t.category} latex formula math physics chemistry ${t.title}`,
      run: () => {
        const snippet = t.displayMode ? `$$${t.latex}$$` : `$${t.latex}$`;
        setComposerDraft(`${composerDraft()}${composerDraft() ? ' ' : ''}${snippet} `);
        setTopMode('chat');
      },
    }));

    return [...base, ...templates];
  });

  const ranked = createMemo(() => {
    const q = query();
    return allCommands()
      .map((cmd) => ({ cmd, score: scoreCommandMatch(cmd, q) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 14)
      .map((x) => x.cmd);
  });

  createEffect(() => {
    if (commandPaletteOpen()) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef?.focus(), 0);
    }
  });

  const executeSelected = () => {
    const list = ranked();
    const target = list[selectedIndex()] ?? list[0];
    if (target) {
      target.run();
      setCommandPaletteOpen(false);
    }
  };

  return (
    <Show when={commandPaletteOpen()}>
      <div
        class="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[12vh] px-4"
        onClick={() => setCommandPaletteOpen(false)}
      >
        <div
          class="w-full max-w-xl rounded-lg border border-[var(--border-strong)] bg-[var(--bg-panel)] shadow-[var(--shadow-md)] overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
            <Search class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Jump to mode, workbench, theme, or LaTeX formula..."
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setSelectedIndex(0);
              }}
              onKeyDown={(e) => {
                const len = ranked().length;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelectedIndex((i) => (len ? (i + 1) % len : 0));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelectedIndex((i) => (len ? (i - 1 + len) % len : 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  executeSelected();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setCommandPaletteOpen(false);
                }
              }}
              class="w-full bg-transparent text-[13.5px] text-[var(--ink-primary)] placeholder-[var(--ink-muted)] outline-none"
            />
            <kbd class="font-mono-num text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
              ESC
            </kbd>
          </div>

          <div class="max-h-80 overflow-y-auto p-1.5 space-y-0.5">
            <For each={ranked()}>
              {(cmd, idx) => (
                <button
                  type="button"
                  onClick={() => {
                    cmd.run();
                    setCommandPaletteOpen(false);
                  }}
                  onMouseEnter={() => setSelectedIndex(idx())}
                  class="w-full flex items-center justify-between px-3 py-2 rounded text-left text-[12.5px] cursor-pointer"
                  classList={{
                    'bg-[var(--bg-interactive)] text-[var(--ink-primary)] border border-[var(--border-accent)]':
                      selectedIndex() === idx(),
                    'text-[var(--ink-secondary)] border border-transparent': selectedIndex() !== idx(),
                  }}
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <Command class="w-3.5 h-3.5 text-[var(--ink-muted)] shrink-0" />
                    <span class="truncate font-medium">{cmd.title}</span>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <span class="text-[11px] px-1.5 py-0.5 rounded bg-[var(--bg-canvas)] text-[var(--ink-muted)] border border-[var(--border-subtle)]">
                      {cmd.group}
                    </span>
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}
