import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { Command, Search } from 'lucide-solid';
import {
  activeSessionId,
  applyTheme,
  commandPaletteOpen,
  compactActiveSession,
  composerDraft,
  exportActiveSession,
  messages,
  openObservabilityTab,
  openQuoteBtw,
  openRewindPreview,
  openWorkbench,
  privacyMask,
  setCommandPaletteOpen,
  setComposerDraft,
  setSteerDrawerOpen,
  setTopMode,
  steerDrawerOpen,
  togglePrivacyMask,
  triggerDnsBenchmark,
  triggerQuickSpeedtest,
  triggerV5Export,
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
      // Modes
      { id: 'mode-chat', title: 'Switch to Chat Mode', group: 'Mode', keywords: 'chat conversation agent', shortcut: '1', run: () => setTopMode('chat') },
      { id: 'mode-ide', title: 'Switch to IDE Mode', group: 'Mode', keywords: 'ide editor codemirror terminal lsp dap git', shortcut: '2', run: () => setTopMode('ide') },
      { id: 'mode-browser', title: 'Switch to Isolated CDP Browser', group: 'Mode', keywords: 'browser cdp virtual cursor chrome obs remote', shortcut: '3', run: () => setTopMode('browser') },

      // Workbenches
      { id: 'wb-atelier', title: 'Open Atelier Notebook Studio', group: 'Workbench', keywords: 'gemini notebook ke nhau artifacts btw citations whisper', run: () => openWorkbench('atelier') },
      { id: 'wb-omnidrive', title: 'Open OmniDrive Pro Downloader', group: 'Workbench', keywords: 'download chunks hls dash ffmpeg drive wal sha256', run: () => openWorkbench('omnidrive') },
      { id: 'wb-swarm', title: 'Open Peer-Mesh Swarm & Graphify', group: 'Workbench', keywords: 'peer mesh graphify traversal ast disjoint paths', run: () => openWorkbench('swarm') },
      { id: 'wb-know', title: 'Open Memory Vault, RAG & MCP/Skills', group: 'Workbench', keywords: 'memory vault erasure rag mcp skills hooks recipes cordis hipporag', run: () => openWorkbench('knowledge') },

      // Observability Sub-Tabs
      { id: 'obs-telemetry', title: 'Observatory: AI Telemetry & Percentiles', group: 'Observability', keywords: 'telemetry percentiles p50 p95 p99 ttft tpot tps waterfall kv cache alerts', run: () => openObservabilityTab('telemetry') },
      { id: 'obs-router', title: 'Observatory: Router Lab & Circuit Breakers', group: 'Observability', keywords: 'router quota circuit breaker trip reset waterfall burn rate runway failover receipt', run: () => openObservabilityTab('router') },
      { id: 'obs-network', title: 'Observatory: Network, IP, DNS, Proxy & Speedtest', group: 'Observability', keywords: 'network ip nic vpn dns leak proxy tls waterfall speedtest bufferbloat', run: () => openObservabilityTab('network') },
      { id: 'obs-system', title: 'Observatory: Host Hardware, Disk, WAL & Ports', group: 'Observability', keywords: 'hardware cpu ram gpu vram nvidia disk rss sqlite wal ports', run: () => openObservabilityTab('system') },
      { id: 'obs-bench', title: 'Observatory: Live Benchmark Scoreboard (v5)', group: 'Observability', keywords: 'benchmark scoreboard suite v5 public suites 51 models effort sweep microbench', run: () => openObservabilityTab('benchmarks') },
      { id: 'obs-vault', title: 'Observatory: CredMan Vault, Diffs & Exports', group: 'Observability', keywords: 'credman credentials vault side by side diff compare export json csv markdown', run: () => openObservabilityTab('vault') },

      // Global Actions & Privacy & Speedtest
      {
        id: 'act-privacy',
        title: `Toggle Global Privacy Mask (currently ${privacyMask() ? 'ON' : 'OFF'})`,
        group: 'Privacy',
        keywords: 'privacy mask redact ip mac ssid email path credentials',
        shortcut: 'P',
        run: () => togglePrivacyMask(),
      },
      {
        id: 'act-speedtest',
        title: 'Run On-Demand Speedtest & Bufferbloat Probe',
        group: 'Network',
        keywords: 'speedtest bufferbloat latency throughput download upload',
        run: () => triggerQuickSpeedtest(),
      },
      {
        id: 'act-dns-bench',
        title: 'Run Multi-Resolver DNS Benchmark & VPN Leak Check',
        group: 'Network',
        keywords: 'dns benchmark resolver cloudflare google quad9 adguard vpn leak',
        run: () => triggerDnsBenchmark(),
      },
      {
        id: 'act-steer-drawer',
        title: 'Toggle Additive Steer Queue Drawer (ADDITIVE_INTAKE)',
        group: 'Session',
        keywords: 'steer queue additive intake token budget null drawer',
        run: () => {
          setTopMode('chat');
          setSteerDrawerOpen(!steerDrawerOpen());
        },
      },
      {
        id: 'act-rewind-preview',
        title: 'Preview /rewind Checkpoint Diff Before Rewinding',
        group: 'Session',
        keywords: 'rewind checkpoint diff preview turn rollback',
        run: () => void openRewindPreview(Math.max(messages.length - 2, 0)),
      },
      {
        id: 'act-compact',
        title: 'Compact Active Session Context (/compact)',
        group: 'Session',
        keywords: 'compact context lakeview anchored compaction',
        run: () => void compactActiveSession(),
      },
      {
        id: 'act-btw',
        title: 'Open Interactive /btw Quote Side-Thread',
        group: 'Session',
        keywords: 'btw quote side thread',
        run: () => {
          setTopMode('chat');
          openQuoteBtw({
            text: messages[messages.length - 1]?.content.slice(0, 320) || `Session ${activeSessionId()} context`,
            sourceLabel: 'Command Palette /btw',
            surface: 'chat',
          });
        },
      },

      // One-Click Exports
      { id: 'exp-json', title: 'Export Observatory Data as JSON', group: 'Export', keywords: 'export download json telemetry', run: () => void triggerV5Export('json') },
      { id: 'exp-csv', title: 'Export Observatory Data as CSV', group: 'Export', keywords: 'export download csv spreadsheet', run: () => void triggerV5Export('csv') },
      { id: 'exp-md', title: 'Export Markdown Executive Report', group: 'Export', keywords: 'export download markdown executive report', run: () => void triggerV5Export('markdown') },
      { id: 'exp-diag', title: 'Export Redacted Diagnostic Snapshot', group: 'Export', keywords: 'export diagnostic snapshot redacted privacy mask', run: () => void triggerV5Export('diagnostic') },
      { id: 'exp-sess-md', title: 'Export Active Chat Session (Markdown)', group: 'Export', keywords: 'export session chat markdown', run: () => exportActiveSession('markdown') },

      // Themes (4 WCAG calibrated + System)
      { id: 'theme-obsidian', title: 'Theme: Obsidian Atelier', group: 'Theme', keywords: 'dark obsidian default', run: () => applyTheme('obsidian') },
      { id: 'theme-titanium', title: 'Theme: Titanium (OMP Slate)', group: 'Theme', keywords: 'titanium slate omp gray', run: () => applyTheme('titanium') },
      { id: 'theme-alabaster', title: 'Theme: Alabaster Editorial', group: 'Theme', keywords: 'light alabaster porcelain paper', run: () => applyTheme('alabaster') },
      { id: 'theme-blueprint', title: 'Theme: Deep Sea / Midnight Blueprint', group: 'Theme', keywords: 'navy blueprint nord deep sea', run: () => applyTheme('blueprint') },
      { id: 'theme-system', title: 'Theme: Follow System Preference', group: 'Theme', keywords: 'system auto light dark', run: () => applyTheme('system') },
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
      .slice(0, 16)
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
        data-testid="command-palette-overlay"
        class="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[10vh] px-4"
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
              data-testid="command-palette-input"
              aria-label="Command Palette"
              type="text"
              placeholder="Jump to mode, workbench, Observatory tab, Privacy Mask, Speedtest, Export, theme, or LaTeX..."
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

          <div class="max-h-96 overflow-y-auto p-1.5 space-y-0.5">
            <For each={ranked()}>
              {(cmd, idx) => (
                <button
                  type="button"
                  data-command-id={cmd.id}
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
                  <div class="flex items-center gap-1.5 shrink-0">
                    <Show when={cmd.shortcut}>
                      <kbd class="font-mono-num text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-canvas)] text-[var(--accent-cyan)] border border-[var(--border-subtle)]">
                        {cmd.shortcut}
                      </kbd>
                    </Show>
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
