import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { Command, Contrast, Search, Sparkles } from 'lucide-solid';
import {
  activeSessionId,
  applyTheme,
  commandPaletteOpen,
  compactActiveSession,
  composerDraft,
  contrastPref,
  exportActiveSession,
  flashNotice,
  messages,
  modelCatalog,
  modelConfig,
  motionPref,
  openObservabilityTab,
  openQuoteBtw,
  openRewindPreview,
  openWorkbench,
  privacyMask,
  refreshResearchSources,
  researchDrawerOpen,
  researchSources,
  selectAndLoadSession,
  selectStudioPersona,
  sessions,
  setCommandPaletteOpen,
  setComposerDraft,
  setResearchDrawerOpen,
  setSteerDrawerOpen,
  setTopMode,
  steerDrawerOpen,
  studioPersonas,
  toggleCanvasDrawer,
  toggleContrastMode,
  togglePrivacyMask,
  toggleReducedMotion,
  topMode,
  triggerDnsBenchmark,
  triggerQuickSpeedtest,
  triggerV5Export,
  updateDualModelConfig,
  workbenchTab,
  workspaceTree,
} from '@/state/studio';
import type { CommandAction } from '@/types';
import { LATEX_15_TEMPLATES } from '@/utils/markdown';

export type PaletteScopeId =
  | 'all'
  | 'commands'
  | 'chats'
  | 'workbenches'
  | 'messages'
  | 'files'
  | 'memory'
  | 'skills'
  | 'library'
  | 'providers'
  | 'models';

export interface PaletteScopeDef {
  id: PaletteScopeId;
  label: string;
  prefix: string;
  hint: string;
}

/**
 * 11-Scope Power-User Command Palette with 10 single-character power prefixes
 * (`> @ # ? ~ % & ! : ^`) plus `All` default scope.
 */
export const PALETTE_SCOPES: PaletteScopeDef[] = [
  { id: 'all', label: 'All', prefix: '', hint: 'Search across all 11 Omnia scopes' },
  { id: 'commands', label: 'Commands', prefix: '>', hint: 'Modes, session actions, accessibility & hotkeys' },
  { id: 'chats', label: 'Chats', prefix: '@', hint: 'Jump directly to SQLite conversation sessions' },
  { id: 'workbenches', label: 'Workbenches', prefix: '#', hint: 'Switch Chat, Arena, Atelier, OmniDrive, Swarm, Lifecycle' },
  { id: 'messages', label: 'Messages', prefix: '?', hint: 'Search turns inside the active conversation' },
  { id: 'files', label: 'Files', prefix: '~', hint: 'Jump to loaded workspace files in IDE mode' },
  { id: 'memory', label: 'Memory', prefix: '%', hint: 'Memory Vault, Persistent RAG & Deep Research sources' },
  { id: 'skills', label: 'Skills', prefix: '&', hint: '1,001-Skill Vault, Bilingual DAG & Gems/Personas' },
  { id: 'library', label: 'Library', prefix: '!', hint: 'LaTeX templates, Canvas drawer & session/observatory exports' },
  { id: 'providers', label: 'Providers', prefix: ':', hint: 'Observatory, Capability Matrix, Router Lab, DNS & Speedtest' },
  { id: 'models', label: 'Models', prefix: '^', hint: 'Switch active frontier model & WCAG themes' },
];

const PREFIX_TO_SCOPE = new Map<string, PaletteScopeId>(
  PALETTE_SCOPES.filter((s) => s.prefix).map((s) => [s.prefix, s.id]),
);

export interface ScopedCommandAction extends CommandAction {
  scope: Exclude<PaletteScopeId, 'all'>;
}

/**
 * Parse optional leading single-char scope prefix (`> @ # ? ~ % & ! : ^`).
 * Explicit prefix in query overrides the manual chip scope; otherwise falls back to manual scope.
 */
export function parseScopedQuery(
  rawQuery: string,
  manualScope: PaletteScopeId,
): { scope: PaletteScopeId; term: string; fromPrefix: boolean } {
  const trimmedStart = rawQuery.trimStart();
  if (trimmedStart.length > 0) {
    const first = trimmedStart[0];
    const matched = PREFIX_TO_SCOPE.get(first);
    if (matched) {
      return {
        scope: matched,
        term: trimmedStart.slice(1).trim(),
        fromPrefix: true,
      };
    }
  }
  return { scope: manualScope, term: rawQuery.trim(), fromPrefix: false };
}

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
  const [manualScope, setManualScope] = createSignal<PaletteScopeId>('all');
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const parsedQuery = createMemo(() => parseScopedQuery(query(), manualScope()));
  const activeScopeDef = createMemo(
    () => PALETTE_SCOPES.find((s) => s.id === parsedQuery().scope) ?? PALETTE_SCOPES[0],
  );

  const cycleScope = (delta: number) => {
    const curScope = parsedQuery().scope;
    const idx = PALETTE_SCOPES.findIndex((s) => s.id === curScope);
    const nextIdx = (idx + delta + PALETTE_SCOPES.length) % PALETTE_SCOPES.length;
    const next = PALETTE_SCOPES[nextIdx];
    setManualScope(next.id);
    if (parsedQuery().fromPrefix) {
      const stripped = parsedQuery().term;
      setQuery(next.prefix ? `${next.prefix} ${stripped}`.trimEnd() : stripped);
    }
    setSelectedIndex(0);
  };

  const selectScopeChip = (scopeId: PaletteScopeId) => {
    setManualScope(scopeId);
    if (parsedQuery().fromPrefix) {
      setQuery(parsedQuery().term);
    }
    setSelectedIndex(0);
    inputRef?.focus();
  };

  const allCommands = createMemo<ScopedCommandAction[]>(() => {
    const base: ScopedCommandAction[] = [
      // Modes (commands)
      { id: 'mode-chat', scope: 'commands', title: 'Switch to Chat Mode', group: 'Mode', keywords: 'chat conversation agent', shortcut: 'Alt+1', run: () => setTopMode('chat') },
      { id: 'mode-ide', scope: 'commands', title: 'Switch to IDE Mode', group: 'Mode', keywords: 'ide editor codemirror terminal lsp dap git', run: () => setTopMode('ide') },
      { id: 'mode-browser', scope: 'commands', title: 'Switch to Isolated CDP Browser', group: 'Mode', keywords: 'browser cdp virtual cursor chrome obs remote', run: () => setTopMode('browser') },

      // Workbenches (#)
      { id: 'wb-chat', scope: 'workbenches', title: 'Open Chat Transcript & Composer', group: 'Workbench', keywords: 'chat transcript composer solo', shortcut: 'Alt+1', run: () => openWorkbench('chat') },
      { id: 'wb-arena', scope: 'workbenches', title: 'Open AI Studio & Multi-Model Arena (Gems, Elo, Get Code)', group: 'Workbench', keywords: 'ai studio arena compare models elo gems personas structured output json schema get code', shortcut: 'Alt+2', run: () => openWorkbench('arena') },
      { id: 'wb-atelier', scope: 'workbenches', title: 'Open Atelier Notebook Studio', group: 'Workbench', keywords: 'gemini notebook ke nhau artifacts btw citations whisper', shortcut: 'Alt+3', run: () => openWorkbench('atelier') },
      { id: 'wb-omnidrive', scope: 'workbenches', title: 'Open OmniDrive Pro Downloader', group: 'Workbench', keywords: 'download chunks hls dash ffmpeg drive wal sha256', shortcut: 'Alt+4', run: () => openWorkbench('omnidrive') },
      { id: 'wb-swarm', scope: 'workbenches', title: 'Open Peer-Mesh Swarm & Graphify', group: 'Workbench', keywords: 'peer mesh graphify traversal ast disjoint paths poll leases', shortcut: 'Alt+5', run: () => openWorkbench('swarm') },
      { id: 'wb-obs', scope: 'workbenches', title: 'Open Observatory, Telemetry & Capability Matrix', group: 'Workbench', keywords: 'observatory telemetry capability matrix health hardware', shortcut: 'Alt+6', run: () => openObservabilityTab('telemetry') },
      { id: 'wb-know', scope: 'workbenches', title: 'Open Memory Vault, RAG & MCP/Skills', group: 'Workbench', keywords: 'memory vault erasure rag mcp skills hooks recipes cordis hipporag', shortcut: 'Alt+7', run: () => openWorkbench('knowledge') },
      { id: 'wb-lifecycle', scope: 'workbenches', title: 'Open Mission Lifecycle OS (12 Artifacts & DoD)', group: 'Workbench', keywords: 'mission lifecycle goal spec blueprint plan todo progress dod handoff', shortcut: 'Alt+8', run: () => openWorkbench('lifecycle') },
      { id: 'act-protocol-studio', scope: 'workbenches', title: 'Open Protocol Studio (Batch EF2, Handoff & Media Box)', group: 'Workbench', keywords: 'batch planner ef2 handoff media box tree cookie jaccard drift', run: () => openWorkbench('omnidrive') },

      // Memory & Research (%)
      {
        id: 'act-sources-drawer',
        scope: 'memory',
        title: 'Toggle Deep Research & Sources Ledger Drawer',
        group: 'Research',
        keywords: 'deep research sources ledger searched viewed extracted citations prisma',
        run: () => {
          setTopMode('chat');
          const next = !researchDrawerOpen();
          setResearchDrawerOpen(next);
          if (next) void refreshResearchSources();
        },
      },
      { id: 'act-deep-think', scope: 'memory', title: 'Open Deep Think Falsification & Red-Team Lab', group: 'Research', keywords: 'deep think falsification redteam hypothesis branches', run: () => openWorkbench('lifecycle') },
      { id: 'act-learn-lessons', scope: 'memory', title: 'Open Auto-Learn, Lessons & Gap Radar', group: 'Research', keywords: 'learn lessons gap radar crystallize auto-learn', run: () => openWorkbench('lifecycle') },

      // Skills (&)
      { id: 'act-skill-vault', scope: 'skills', title: 'Open 1,001-Skill Vault & Bilingual DAG Composer', group: 'Skills', keywords: '1001 skill vault bilingual dag bm25 pipelines doctor codify', run: () => openWorkbench('knowledge') },

      // Library / Canvas (!)
      {
        id: 'act-canvas-drawer',
        scope: 'library',
        title: 'Toggle Artifact Canvas & Live Preview Drawer',
        group: 'Canvas',
        keywords: 'canvas artifact live preview html svg mermaid code split diff',
        run: () => {
          setTopMode('chat');
          toggleCanvasDrawer();
        },
      },

      // Providers & Observatory (:)
      { id: 'obs-telemetry', scope: 'providers', title: 'Observatory: AI Telemetry & Percentiles', group: 'Observability', keywords: 'telemetry percentiles p50 p95 p99 ttft tpot tps waterfall kv cache alerts', run: () => openObservabilityTab('telemetry') },
      { id: 'obs-router', scope: 'providers', title: 'Observatory: Router Lab, Circuit Breakers & Reservation Cancel', group: 'Observability', keywords: 'router quota circuit breaker trip reset cancel waterfall burn rate runway failover receipt', run: () => openObservabilityTab('router') },
      { id: 'obs-network', scope: 'providers', title: 'Observatory: Network, IP, DNS, Proxy & Speedtest', group: 'Observability', keywords: 'network ip nic vpn dns leak proxy tls waterfall speedtest bufferbloat', run: () => openObservabilityTab('network') },
      { id: 'obs-system', scope: 'providers', title: 'Observatory: Studio Capability Matrix (AUD-25) & Host Hardware', group: 'Observability', keywords: 'capability matrix aud-25 health readiness hardware cpu ram gpu vram nvidia disk rss sqlite wal ports', run: () => openObservabilityTab('system') },
      { id: 'obs-bench', scope: 'providers', title: 'Observatory: Live Benchmark Scoreboard (v5)', group: 'Observability', keywords: 'benchmark scoreboard suite v5 public suites 51 models effort sweep microbench', run: () => openObservabilityTab('benchmarks') },
      { id: 'obs-vault', scope: 'providers', title: 'Observatory: CredMan Vault, Diffs & Exports', group: 'Observability', keywords: 'credman credentials vault side by side diff compare export json csv markdown', run: () => openObservabilityTab('vault') },
      {
        id: 'act-speedtest',
        scope: 'providers',
        title: 'Run On-Demand Speedtest & Bufferbloat Probe',
        group: 'Network',
        keywords: 'speedtest bufferbloat latency throughput download upload',
        run: () => triggerQuickSpeedtest(),
      },
      {
        id: 'act-dns-bench',
        scope: 'providers',
        title: 'Run Multi-Resolver DNS Benchmark & VPN Leak Check',
        group: 'Network',
        keywords: 'dns benchmark resolver cloudflare google quad9 adguard vpn leak',
        run: () => triggerDnsBenchmark(),
      },

      // Global Commands, Accessibility & Session Actions (>)
      {
        id: 'act-contrast-aaa',
        scope: 'commands',
        title: `Accessibility: High Contrast WCAG AAA (currently ${contrastPref() === 'more' ? 'ON' : 'OFF'})`,
        group: 'Accessibility',
        keywords: 'accessibility contrast high contrast aaa forced colors visibility',
        shortcut: 'Alt+Shift+C',
        run: () => toggleContrastMode(),
      },
      {
        id: 'act-reduced-motion',
        scope: 'commands',
        title: `Accessibility: Reduced Motion Kill-Switch (currently ${motionPref() === 'reduced' ? 'ON' : 'SYSTEM'})`,
        group: 'Accessibility',
        keywords: 'accessibility reduced motion animations disable calm',
        shortcut: 'Alt+Shift+M',
        run: () => toggleReducedMotion(),
      },
      {
        id: 'act-privacy',
        scope: 'commands',
        title: `Toggle Global Privacy Mask (currently ${privacyMask() ? 'ON' : 'OFF'})`,
        group: 'Privacy',
        keywords: 'privacy mask redact ip mac ssid email path credentials',
        shortcut: 'P',
        run: () => togglePrivacyMask(),
      },
      {
        id: 'act-steer-drawer',
        scope: 'commands',
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
        scope: 'commands',
        title: 'Preview /rewind Checkpoint Diff Before Rewinding',
        group: 'Session',
        keywords: 'rewind checkpoint diff preview turn rollback',
        run: () => void openRewindPreview(Math.max(messages.length - 2, 0)),
      },
      {
        id: 'act-compact',
        scope: 'commands',
        title: 'Compact Active Session Context (/compact)',
        group: 'Session',
        keywords: 'compact context lakeview anchored compaction',
        run: () => void compactActiveSession(),
      },
      {
        id: 'act-btw',
        scope: 'commands',
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

      // One-Click Exports (!)
      { id: 'exp-json', scope: 'library', title: 'Export Observatory Data as JSON', group: 'Export', keywords: 'export download json telemetry', run: () => void triggerV5Export('json') },
      { id: 'exp-csv', scope: 'library', title: 'Export Observatory Data as CSV', group: 'Export', keywords: 'export download csv spreadsheet', run: () => void triggerV5Export('csv') },
      { id: 'exp-md', scope: 'library', title: 'Export Markdown Executive Report', group: 'Export', keywords: 'export download markdown executive report', run: () => void triggerV5Export('markdown') },
      { id: 'exp-diag', scope: 'library', title: 'Export Redacted Diagnostic Snapshot', group: 'Export', keywords: 'export diagnostic snapshot redacted privacy mask', run: () => void triggerV5Export('diagnostic') },
      { id: 'exp-sess-md', scope: 'library', title: 'Export Active Chat Session (Markdown)', group: 'Export', keywords: 'export session chat markdown', run: () => exportActiveSession('markdown') },

      // Themes (^)
      { id: 'theme-obsidian', scope: 'models', title: 'Theme: Obsidian Atelier', group: 'Theme', keywords: 'dark obsidian default theme', run: () => applyTheme('obsidian') },
      { id: 'theme-titanium', scope: 'models', title: 'Theme: Titanium (OMP Slate)', group: 'Theme', keywords: 'titanium slate omp gray theme', run: () => applyTheme('titanium') },
      { id: 'theme-alabaster', scope: 'models', title: 'Theme: Alabaster Editorial', group: 'Theme', keywords: 'light alabaster porcelain paper theme', run: () => applyTheme('alabaster') },
      { id: 'theme-blueprint', scope: 'models', title: 'Theme: Deep Sea / Midnight Blueprint', group: 'Theme', keywords: 'navy blueprint nord deep sea theme', run: () => applyTheme('blueprint') },
      { id: 'theme-system', scope: 'models', title: 'Theme: Follow System Preference', group: 'Theme', keywords: 'system auto light dark theme', run: () => applyTheme('system') },
    ];

    // Live SQLite Sessions (@)
    const sessionItems: ScopedCommandAction[] = sessions.slice(0, 24).map((s) => ({
      id: `chat-${s.id}`,
      scope: 'chats',
      title: s.title || s.id,
      group: s.id === activeSessionId() ? 'Active Chat' : 'Chat Session',
      keywords: `chat session ${s.id} ${s.title || ''} ${s.model || ''} ${s.project_name || ''}`,
      run: () => {
        openWorkbench('chat');
        void selectAndLoadSession(s.id);
      },
    }));

    // Live Active Conversation Messages (?)
    const messageItems: ScopedCommandAction[] = messages.slice(-30).map((m, i) => {
      const snippet = m.content.replace(/\s+/g, ' ').trim().slice(0, 88) || '(empty turn)';
      const turnNum = m.turnIdx ?? i;
      return {
        id: `msg-${m.id}`,
        scope: 'messages',
        title: `T${turnNum} [${m.role}]: ${snippet}`,
        group: 'Message',
        keywords: `message turn ${m.role} ${m.model || ''} ${m.content.slice(0, 240)}`,
        run: () => {
          openWorkbench('chat');
          setTimeout(() => {
            const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(m.id)}"]`);
            if (el) el.scrollIntoView({ block: 'center' });
          }, 30);
          flashNotice(`Jumped to turn T${turnNum}`);
        },
      };
    });

    // Live Workspace Files (~)
    const fileItems: ScopedCommandAction[] = workspaceTree
      .filter((entry) => entry.kind === 'file')
      .slice(0, 40)
      .map((entry) => ({
        id: `file-${entry.relativePath || entry.path}`,
        scope: 'files',
        title: entry.relativePath || entry.name,
        group: 'File',
        keywords: `file ide ${entry.name} ${entry.relativePath} ${entry.path}`,
        run: () => {
          setTopMode('ide');
          flashNotice(`Opened IDE view for ${entry.name}`);
        },
      }));

    // Live Research Sources (%)
    const researchItems: ScopedCommandAction[] = researchSources.slice(0, 20).map((src) => ({
      id: `src-${src.citationId}`,
      scope: 'memory',
      title: `[${src.citationId}] ${src.title || src.url || 'Research Source'}`,
      group: `Source (${src.status})`,
      keywords: `source citation research ${src.citationId} ${src.domain || ''} ${src.title || ''} ${src.url}`,
      run: () => {
        setTopMode('chat');
        setResearchDrawerOpen(true);
      },
    }));

    // Live Studio Personas / Gems (&)
    const personaItems: ScopedCommandAction[] = studioPersonas.map((p) => ({
      id: `gem-${p.id}`,
      scope: 'skills',
      title: `Activate Gem: ${p.name} (${p.effort})`,
      group: 'Gem / Persona',
      keywords: `gem persona specialist ${p.name} ${p.description} ${p.modelId} ${p.focusMode}`,
      run: () => {
        selectStudioPersona(p.id);
        openWorkbench('chat');
      },
    }));

    // Live Frontier Models (^)
    const modelItems: ScopedCommandAction[] = modelCatalog.map((m) => ({
      id: `mdl-${m.spec}`,
      scope: 'models',
      title: `Use Model: ${m.name} (${m.spec})${modelConfig.mainModel === m.spec ? ' [ACTIVE]' : ''}`,
      group: m.provider,
      keywords: `model provider ${m.spec} ${m.name} ${m.provider}`,
      run: () => {
        void updateDualModelConfig({ mainModel: m.spec, mainEffort: m.defaultEffort || 'max' });
        flashNotice(`Main model switched to ${m.name}`);
      },
    }));

    // LaTeX 15 Templates (!)
    const templates: ScopedCommandAction[] = LATEX_15_TEMPLATES.map((t) => ({
      id: `tpl-${t.id}`,
      scope: 'library',
      title: `Insert ${t.category}: ${t.title}`,
      group: 'LaTeX Template',
      keywords: `${t.category} latex formula math physics chemistry ${t.title}`,
      run: () => {
        const snippet = t.displayMode ? `$$${t.latex}$$` : `$${t.latex}$`;
        setComposerDraft(`${composerDraft()}${composerDraft() ? ' ' : ''}${snippet} `);
        setTopMode('chat');
      },
    }));

    return [
      ...base,
      ...sessionItems,
      ...messageItems,
      ...fileItems,
      ...researchItems,
      ...personaItems,
      ...modelItems,
      ...templates,
    ];
  });

  const ranked = createMemo(() => {
    const { scope, term } = parsedQuery();
    const scopedPool = scope === 'all' ? allCommands() : allCommands().filter((c) => c.scope === scope);
    return scopedPool
      .map((cmd) => ({ cmd, score: scoreCommandMatch(cmd, term) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 18)
      .map((x) => x.cmd);
  });

  createEffect(() => {
    if (commandPaletteOpen()) {
      setQuery('');
      setManualScope('all');
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

  const activeDescendantId = () => {
    const item = ranked()[selectedIndex()];
    return item ? `palette-opt-${item.id}` : undefined;
  };

  return (
    <Show when={commandPaletteOpen()}>
      <div
        data-testid="command-palette-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Universal 11-Scope Command Palette"
        class="fixed inset-0 z-50 bg-black/70 flex items-start justify-center pt-[8vh] px-4"
        onClick={() => setCommandPaletteOpen(false)}
      >
        <div
          class="w-full max-w-2xl rounded-lg border border-[var(--border-strong)] bg-[var(--bg-panel)] shadow-[var(--shadow-md)] overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Breadcrumb & Quick Accessibility Controls */}
          <div class="px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-num text-[var(--ink-muted)]">
            <div class="truncate min-w-0">
              Location: <span class="text-[var(--ink-secondary)]">{topMode().toUpperCase()}</span> /{' '}
              <span class="text-[var(--accent-cyan)]">{workbenchTab()}</span> /{' '}
              <span class="text-[var(--ink-secondary)]">{activeSessionId().slice(0, 18)}</span>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                data-testid="palette-contrast-toggle"
                aria-pressed={contrastPref() === 'more'}
                onClick={() => toggleContrastMode()}
                class="omnia-btn !px-2 !py-0.5 !text-[10.5px]"
                classList={{
                  'border-[var(--accent-cyan)] text-[var(--accent-cyan)]': contrastPref() === 'more',
                }}
                title="Toggle WCAG AAA High Contrast (Alt+Shift+C)"
              >
                <Contrast class="w-3 h-3" />
                <span>AAA {contrastPref() === 'more' ? 'ON' : 'OFF'}</span>
              </button>
              <button
                type="button"
                data-testid="palette-motion-toggle"
                aria-pressed={motionPref() === 'reduced'}
                onClick={() => toggleReducedMotion()}
                class="omnia-btn !px-2 !py-0.5 !text-[10.5px]"
                classList={{
                  'border-[var(--accent-amber)] text-[var(--accent-amber)]': motionPref() === 'reduced',
                }}
                title="Toggle Reduced Motion (Alt+Shift+M)"
              >
                <Sparkles class="w-3 h-3" />
                <span>Motion {motionPref() === 'reduced' ? 'REDUCED' : 'AUTO'}</span>
              </button>
            </div>
          </div>

          {/* Search Input */}
          <div class="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
            <Search class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
            <Show when={activeScopeDef().prefix}>
              <span
                data-testid="command-palette-active-prefix"
                class="font-mono-num text-[11px] font-bold px-1.5 py-0.5 rounded bg-[var(--accent-dim)] text-[var(--accent-cyan)] border border-[var(--border-accent)] shrink-0"
              >
                {activeScopeDef().prefix} {activeScopeDef().label}
              </span>
            </Show>
            <input
              ref={inputRef}
              data-testid="command-palette-input"
              aria-label="Command Palette"
              aria-autocomplete="list"
              aria-controls="omnia-palette-listbox"
              aria-activedescendant={activeDescendantId()}
              type="text"
              placeholder={activeScopeDef().hint}
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setSelectedIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return;
                const len = ranked().length;
                if (e.altKey && e.key === 'ArrowRight') {
                  e.preventDefault();
                  cycleScope(1);
                } else if (e.altKey && e.key === 'ArrowLeft') {
                  e.preventDefault();
                  cycleScope(-1);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelectedIndex((i) => (len ? (i + 1) % len : 0));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelectedIndex((i) => (len ? (i - 1 + len) % len : 0));
                } else if (e.key === 'PageDown') {
                  e.preventDefault();
                  setSelectedIndex((i) => (len ? Math.min(len - 1, i + 5) : 0));
                } else if (e.key === 'PageUp') {
                  e.preventDefault();
                  setSelectedIndex((i) => (len ? Math.max(0, i - 5) : 0));
                } else if (e.key === 'Home' && e.ctrlKey) {
                  e.preventDefault();
                  setSelectedIndex(0);
                } else if (e.key === 'End' && e.ctrlKey) {
                  e.preventDefault();
                  setSelectedIndex(Math.max(0, len - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  executeSelected();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setCommandPaletteOpen(false);
                }
              }}
              class="w-full min-w-0 bg-transparent text-[13.5px] text-[var(--ink-primary)] placeholder-[var(--ink-muted)] outline-none"
            />
            <kbd class="font-mono-num text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-muted)] shrink-0">
              ESC
            </kbd>
          </div>

          {/* 11-Scope Interactive Prefix Strip */}
          <div
            data-testid="command-palette-scopes"
            class="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex flex-wrap items-center gap-1"
          >
            <For each={PALETTE_SCOPES}>
              {(sc) => {
                const isActive = () => parsedQuery().scope === sc.id;
                return (
                  <button
                    type="button"
                    data-testid={`palette-scope-${sc.id}`}
                    aria-pressed={isActive()}
                    onClick={() => selectScopeChip(sc.id)}
                    class="px-1.5 py-0.5 rounded text-[11px] font-mono-num border cursor-pointer inline-flex items-center gap-1"
                    classList={{
                      'bg-[var(--accent-dim)] text-[var(--accent-cyan)] border-[var(--border-accent)] font-semibold':
                        isActive(),
                      'bg-[var(--bg-panel)] text-[var(--ink-muted)] border-[var(--border-subtle)] hover:text-[var(--ink-primary)]':
                        !isActive(),
                    }}
                  >
                    <Show when={sc.prefix}>
                      <span class="font-bold text-[var(--accent-amber)]">{sc.prefix}</span>
                    </Show>
                    <span>{sc.label}</span>
                  </button>
                );
              }}
            </For>
          </div>

          {/* Results Listbox */}
          <div
            id="omnia-palette-listbox"
            role="listbox"
            aria-label="Matching commands"
            class="max-h-96 overflow-y-auto p-1.5 space-y-0.5"
          >
            <Show
              when={ranked().length > 0}
              fallback={
                <div class="px-3 py-6 text-center text-[12px] text-[var(--ink-muted)] font-mono-num">
                  No matches in scope <strong>{activeScopeDef().label}</strong>. Press{' '}
                  <kbd class="px-1 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                    Alt+Left/Right
                  </kbd>{' '}
                  to cycle scopes.
                </div>
              }
            >
              <For each={ranked()}>
                {(cmd, idx) => (
                  <button
                    id={`palette-opt-${cmd.id}`}
                    type="button"
                    role="option"
                    aria-selected={selectedIndex() === idx()}
                    data-command-id={cmd.id}
                    onClick={() => {
                      cmd.run();
                      setCommandPaletteOpen(false);
                    }}
                    onMouseEnter={() => setSelectedIndex(idx())}
                    class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded text-left text-[12.5px] cursor-pointer min-w-0"
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
            </Show>
          </div>

          {/* Keyboard Ergonomics Footer */}
          <div class="px-3 py-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-mono-num text-[var(--ink-muted)]">
            <span>Prefixes: &gt; @ # ? ~ % &amp; ! : ^</span>
            <span>Alt+Left/Right scope · PgUp/PgDn ±5 · Alt+1..8 workbenches</span>
          </div>
        </div>
      </div>
    </Show>
  );
}
