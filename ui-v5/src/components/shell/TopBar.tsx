import { Show, createMemo } from 'solid-js';
import {
  Command,
  Cpu,
  Globe,
  MessageSquare,
  PanelLeft,
  Terminal,
  Sun,
  Moon,
  Monitor,
  Layers,
} from 'lucide-solid';
import {
  applyTheme,
  browserChatDrawerOpen,
  health,
  ideChatDrawerOpen,
  openWorkbench,
  setBrowserChatDrawerOpen,
  setCommandPaletteOpen,
  setIdeChatDrawerOpen,
  setSidebarOpen,
  setTopMode,
  sidebarOpen,
  themePref,
  topMode,
  wsConnected,
} from '@/state/studio';
import type { ThemeId, TopMode } from '@/types';

export function TopBar() {
  const rssMb = createMemo(() => {
    const b = health.workingSetBytes;
    return typeof b === 'number' && b > 0 ? `${(b / (1024 * 1024)).toFixed(0)} MiB` : '—';
  });

  const handleToggleSidebar = () => {
    if (topMode() === 'chat') {
      setSidebarOpen(!sidebarOpen());
    } else if (topMode() === 'ide') {
      setIdeChatDrawerOpen(!ideChatDrawerOpen());
    } else {
      setBrowserChatDrawerOpen(!browserChatDrawerOpen());
    }
  };

  const sidebarActive = () => {
    if (topMode() === 'chat') return sidebarOpen();
    if (topMode() === 'ide') return ideChatDrawerOpen();
    return browserChatDrawerOpen();
  };

  const switchTopMode = (mode: TopMode) => {
    setTopMode(mode);
  };

  return (
    <header class="omnia-topbar h-12 px-3 flex items-center justify-between gap-3 select-none overflow-hidden">
      {/* Minimalist Top-Left 3 Primary Mode Switcher ONLY: Chat | IDE | Browser */}
      <div class="flex items-center gap-2.5 min-w-0">
        <button
          type="button"
          class="omnia-btn px-2 py-1.5 shrink-0"
          classList={{ 'border-[var(--border-accent)] text-[var(--accent-cyan)]': sidebarActive() }}
          aria-label="Toggle Chat & Agent Sidebar"
          title="Toggle Chat & Agent Sidebar"
          onClick={handleToggleSidebar}
        >
          <PanelLeft class="w-4 h-4" />
        </button>

        <nav
          aria-label="Primary Studio Mode"
          class="omp-segmented"
          data-testid="primary-mode-switcher"
        >
          <button
            type="button"
            data-mode="chat"
            aria-pressed={topMode() === 'chat'}
            onClick={() => switchTopMode('chat')}
            class="flex items-center gap-1.5 whitespace-nowrap"
          >
            <MessageSquare class="w-3.5 h-3.5" />
            <span>Chat</span>
          </button>
          <button
            type="button"
            data-mode="ide"
            aria-pressed={topMode() === 'ide'}
            onClick={() => switchTopMode('ide')}
            class="flex items-center gap-1.5 whitespace-nowrap"
          >
            <Terminal class="w-3.5 h-3.5" />
            <span>IDE</span>
          </button>
          <button
            type="button"
            data-mode="browser"
            aria-pressed={topMode() === 'browser'}
            onClick={() => switchTopMode('browser')}
            class="flex items-center gap-1.5 whitespace-nowrap"
          >
            <Globe class="w-3.5 h-3.5" />
            <span>Browser</span>
          </button>
        </nav>
      </div>

      {/* Right Controls: Live Telemetry HUD, Command Palette, Theme Picker */}
      <div class="flex items-center gap-2 shrink-0">
        <div
          class="hidden md:flex items-center gap-2 px-2.5 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[11px] font-mono-num whitespace-nowrap"
          title="Live Rust Studio Telemetry"
        >
          <span
            class="inline-block w-2 h-2 rounded-full"
            classList={{
              'bg-[var(--status-emerald)]': health.ok,
              'bg-[var(--accent-amber)]': !health.ok,
            }}
          />
          <Cpu class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
          <span class="text-[var(--ink-secondary)]">
            {health.crateCount !== null ? `${health.crateCount} crates` : 'Studio'}
          </span>
          <span class="text-[var(--ink-muted)]">|</span>
          <span class="text-[var(--ink-secondary)]">RSS {rssMb()}</span>
          <span class="text-[var(--ink-muted)]">|</span>
          <span classList={{ 'text-[var(--status-emerald)]': wsConnected(), 'text-[var(--ink-muted)]': !wsConnected() }}>
            {wsConnected() ? 'WS LIVE' : 'HTTP'}
          </span>
        </div>

        <button
          type="button"
          class="omnia-btn text-[12px] whitespace-nowrap"
          onClick={() => setCommandPaletteOpen(true)}
          title="Command Palette (Ctrl+K)"
        >
          <Command class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
          <span class="hidden sm:inline">Palette</span>
          <kbd class="font-mono-num text-[10px] px-1 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
            Ctrl+K
          </kbd>
        </button>

        <div class="flex items-center gap-1 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded-md p-0.5 shrink-0">
          <select
            aria-label="Studio Theme"
            value={themePref()}
            onChange={(e) => applyTheme(e.currentTarget.value as ThemeId)}
            class="bg-transparent text-[12px] font-medium text-[var(--ink-primary)] px-2 py-1 outline-none cursor-pointer"
          >
            <option value="obsidian" class="bg-[var(--bg-panel)] text-[var(--ink-primary)]">Obsidian</option>
            <option value="titanium" class="bg-[var(--bg-panel)] text-[var(--ink-primary)]">Titanium (Slate)</option>
            <option value="alabaster" class="bg-[var(--bg-panel)] text-[var(--ink-primary)]">Alabaster</option>
            <option value="blueprint" class="bg-[var(--bg-panel)] text-[var(--ink-primary)]">Deep Sea / Blueprint</option>
            <option value="system" class="bg-[var(--bg-panel)] text-[var(--ink-primary)]">System</option>
          </select>
          <span class="pr-1.5 text-[var(--ink-muted)] pointer-events-none">
            <Show when={themePref() === 'alabaster'} fallback={
              <Show when={themePref() === 'system'} fallback={<Moon class="w-3.5 h-3.5" />}>
                <Monitor class="w-3.5 h-3.5" />
              </Show>
            }>
              <Sun class="w-3.5 h-3.5" />
            </Show>
          </span>
        </div>

        <Show when={topMode() !== 'chat'}>
          <button
            type="button"
            class="omnia-btn text-[11px]"
            onClick={() => openWorkbench('observability')}
            title="Open Workbenches"
          >
            <Layers class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
          </button>
        </Show>
      </div>
    </header>
  );
}
