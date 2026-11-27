import { Show, createMemo } from 'solid-js';
import {
  Bell,
  Command,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  Layers,
  ListOrdered,
  MessageSquare,
  Monitor,
  Moon,
  PanelLeft,
  Sun,
  Terminal,
} from 'lucide-solid';
import {
  applyTheme,
  browserChatDrawerOpen,
  health,
  ideChatDrawerOpen,
  openObservabilityTab,
  privacyMask,
  setBrowserChatDrawerOpen,
  setCommandPaletteOpen,
  setIdeChatDrawerOpen,
  setSidebarOpen,
  setSteerDrawerOpen,
  setTopMode,
  sidebarOpen,
  smartAlerts,
  steerDrawerOpen,
  steerQueue,
  themePref,
  togglePrivacyMask,
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

  const criticalAlertCount = createMemo(
    () => smartAlerts.filter((a) => a.severity === 'critical' || a.severity === 'warning').length,
  );

  return (
    <header class="omnia-topbar h-12 px-3 flex items-center justify-between gap-2 select-none overflow-hidden">
      {/* Minimalist Top-Left 3 Primary Mode Switcher ONLY: Chat | IDE | Browser */}
      <div class="flex items-center gap-2 min-w-0">
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

      {/* Right Controls: Telemetry HUD, Alerts, Steer Queue, Privacy Mask (P), Command Palette, Theme Picker */}
      <div class="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          class="hidden xl:flex items-center gap-2 px-2.5 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[11px] font-mono-num whitespace-nowrap cursor-pointer hover:border-[var(--border-accent)]"
          title="Open Lab-Grade Telemetry & Network Observatory"
          onClick={() => openObservabilityTab('telemetry')}
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
            {wsConnected() ? 'WS' : 'HTTP'}
          </span>
        </button>

        <Show when={criticalAlertCount() > 0}>
          <button
            type="button"
            data-testid="topbar-alerts-btn"
            class="omnia-btn px-2 py-1 text-[11px] border-[var(--accent-amber)] text-[var(--accent-amber)] shrink-0"
            title="Inspect Smart Alerts in Observatory"
            onClick={() => openObservabilityTab('telemetry')}
          >
            <Bell class="w-3.5 h-3.5" />
            <span class="font-mono-num">{criticalAlertCount()}</span>
          </button>
        </Show>

        <button
          type="button"
          data-testid="topbar-steer-queue-btn"
          class="omnia-btn px-2 py-1 text-[11px] shrink-0"
          classList={{
            'border-[var(--border-accent)] text-[var(--accent-cyan)]': steerDrawerOpen() || steerQueue.length > 0,
          }}
          title="Additive Steer Queue Drawer (ADDITIVE_INTAKE · token_budget: NULL)"
          onClick={() => setSteerDrawerOpen(!steerDrawerOpen())}
        >
          <ListOrdered class="w-3.5 h-3.5" />
          <Show when={steerQueue.length > 0}>
            <span class="font-mono-num">{steerQueue.length}</span>
          </Show>
        </button>

        <button
          type="button"
          data-testid="privacy-mask-toggle"
          aria-pressed={privacyMask()}
          class="omnia-btn px-2 py-1 text-[11.5px] whitespace-nowrap shrink-0"
          classList={{
            'border-[var(--accent-amber)] text-[var(--accent-amber)] bg-[var(--accent-amber-dim)]': privacyMask(),
          }}
          title="Toggle Global Privacy Mask (Hotkey: P) — masks Public/LAN IPs, MACs, SSIDs, emails, paths & cred hints across all views & exports"
          onClick={togglePrivacyMask}
        >
          <Show when={privacyMask()} fallback={<Eye class="w-3.5 h-3.5 text-[var(--ink-muted)]" />}>
            <EyeOff class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
          </Show>
          <span class="hidden md:inline">{privacyMask() ? 'Masked' : 'Privacy'}</span>
          <kbd class="font-mono-num text-[10px] px-1 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
            P
          </kbd>
        </button>

        <button
          type="button"
          data-testid="command-palette-trigger"
          class="omnia-btn text-[11.5px] whitespace-nowrap shrink-0"
          onClick={() => setCommandPaletteOpen(true)}
          title="Command Palette (Ctrl+K)"
        >
          <Command class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
          <span class="hidden sm:inline">Palette</span>
          <kbd class="font-mono-num text-[10px] px-1 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
            Ctrl+K
          </kbd>
        </button>

        <div class="flex items-center gap-0.5 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded-md p-0.5 shrink-0">
          <select
            aria-label="Studio Theme"
            value={themePref()}
            onChange={(e) => applyTheme(e.currentTarget.value as ThemeId)}
            class="bg-transparent text-[11.5px] font-medium text-[var(--ink-primary)] px-1.5 py-1 outline-none cursor-pointer"
          >
            <option value="obsidian" class="bg-[var(--bg-panel)] text-[var(--ink-primary)]">Obsidian</option>
            <option value="titanium" class="bg-[var(--bg-panel)] text-[var(--ink-primary)]">Titanium</option>
            <option value="alabaster" class="bg-[var(--bg-panel)] text-[var(--ink-primary)]">Alabaster</option>
            <option value="blueprint" class="bg-[var(--bg-panel)] text-[var(--ink-primary)]">Blueprint</option>
            <option value="system" class="bg-[var(--bg-panel)] text-[var(--ink-primary)]">System</option>
          </select>
          <span class="pr-1.5 text-[var(--ink-muted)] pointer-events-none">
            <Show
              when={themePref() === 'alabaster'}
              fallback={
                <Show when={themePref() === 'system'} fallback={<Moon class="w-3.5 h-3.5" />}>
                  <Monitor class="w-3.5 h-3.5" />
                </Show>
              }
            >
              <Sun class="w-3.5 h-3.5" />
            </Show>
          </span>
        </div>

        <Show when={topMode() !== 'chat'}>
          <button
            type="button"
            class="omnia-btn px-2 py-1 text-[11px] shrink-0"
            onClick={() => openObservabilityTab('telemetry')}
            title="Open Observatory & Workbenches"
          >
            <Layers class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
          </button>
        </Show>
      </div>
    </header>
  );
}
