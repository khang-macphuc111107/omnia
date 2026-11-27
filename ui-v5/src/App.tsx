import { Show, onCleanup, onMount } from 'solid-js';
import { Composer } from '@/components/chat/Composer';
import { QuoteBtwDrawer } from '@/components/chat/QuoteBtwDrawer';
import { Transcript } from '@/components/chat/Transcript';
import { BrowserWorkbench } from '@/components/browser/BrowserWorkbench';
import { IdeWorkbench } from '@/components/ide/IdeWorkbench';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { RewindPreviewModal } from '@/components/shell/RewindPreviewModal';
import { SessionSidebar } from '@/components/shell/SessionSidebar';
import { StatusBar } from '@/components/shell/StatusBar';
import { SteerQueueDrawer } from '@/components/shell/SteerQueueDrawer';
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
  privacyMask,
  setCommandPaletteOpen,
  sidebarOpen,
  themePref,
  togglePrivacyMask,
  topMode,
  workbenchTab,
} from '@/state/studio';

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  if (target.closest('.cm-editor') || target.closest('.xterm')) return true;
  return false;
}

export function App() {
  onMount(() => {
    applyTheme(themePref());
    void hydrateStudioStartup();

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen());
        return;
      }
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'p' &&
        !commandPaletteOpen() &&
        !isEditableElement(e.target)
      ) {
        e.preventDefault();
        togglePrivacyMask();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  return (
    <div class="omnia-shell" data-privacy-masked={privacyMask() ? 'true' : 'false'}>
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
              <Show when={workbenchTab() === 'observability' || workbenchTab() === 'benchmarks'}>
                <ObservabilityView />
              </Show>
              <Show when={workbenchTab() === 'knowledge'}>
                <KnowledgeExtensionsView />
              </Show>
            </div>
            <QuoteBtwDrawer />
            <SteerQueueDrawer />
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
      <RewindPreviewModal />
    </div>
  );
}
