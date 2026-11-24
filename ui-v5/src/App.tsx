import { Show, onCleanup, onMount } from 'solid-js';
import { Composer } from '@/components/chat/Composer';
import { QuoteBtwDrawer } from '@/components/chat/QuoteBtwDrawer';
import { Transcript } from '@/components/chat/Transcript';
import { BrowserWorkbench } from '@/components/browser/BrowserWorkbench';
import { IdeWorkbench } from '@/components/ide/IdeWorkbench';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { SessionSidebar } from '@/components/shell/SessionSidebar';
import { StatusBar } from '@/components/shell/StatusBar';
import { TopBar } from '@/components/shell/TopBar';
import { AtelierView } from '@/components/workbenches/AtelierView';
import { KnowledgeExtensionsView } from '@/components/workbenches/KnowledgeExtensionsView';
import { ObservabilityView } from '@/components/workbenches/ObservabilityView';
import { OmniDriveView } from '@/components/workbenches/OmniDriveView';
import { SwarmView } from '@/components/workbenches/SwarmView';
import {
  applyTheme,
  commandPaletteOpen,
  hydrateStudioStartup,
  setCommandPaletteOpen,
  sidebarOpen,
  themePref,
  topMode,
  workbenchTab,
} from '@/state/studio';

export function App() {
  onMount(() => {
    applyTheme(themePref());
    void hydrateStudioStartup();

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen());
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  return (
    <div class="omnia-shell">
      <TopBar />

      <main class="min-h-0 flex overflow-hidden">
        {/* Chat Mode & Workbenches */}
        <Show when={topMode() === 'chat'}>
          <Show when={sidebarOpen()}>
            <SessionSidebar />
          </Show>

          <div class="flex-1 min-w-0 flex overflow-hidden">
            <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
              <Show when={workbenchTab() === 'chat'}>
                <Transcript />
                <Composer />
              </Show>
              <Show when={workbenchTab() === 'atelier'}>
                <AtelierView />
              </Show>
              <Show when={workbenchTab() === 'omnidrive'}>
                <OmniDriveView />
              </Show>
              <Show when={workbenchTab() === 'swarm'}>
                <SwarmView />
              </Show>
              <Show when={workbenchTab() === 'observability'}>
                <ObservabilityView initialTab="router" />
              </Show>
              <Show when={workbenchTab() === 'benchmarks'}>
                <ObservabilityView initialTab="benchmarks" />
              </Show>
              <Show when={workbenchTab() === 'knowledge'}>
                <KnowledgeExtensionsView />
              </Show>
            </div>
            <QuoteBtwDrawer />
          </div>
        </Show>

        {/* IDE Mode (Trae/VS Code + Collapsible Chat & Agent Sidebar) */}
        <Show when={topMode() === 'ide'}>
          <IdeWorkbench />
        </Show>

        {/* Browser Mode (Isolated CDP + Virtual Cursor + Collapsible Chat & Agent Sidebar) */}
        <Show when={topMode() === 'browser'}>
          <BrowserWorkbench />
        </Show>
      </main>

      <StatusBar />
      <CommandPalette />
    </div>
  );
}
