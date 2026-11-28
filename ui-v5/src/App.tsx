import { Show, onCleanup, onMount } from 'solid-js';
import { Composer } from '@/components/chat/Composer';
import { ArtifactCanvasDrawer } from '@/components/chat/ArtifactCanvasDrawer';
import { QuoteBtwDrawer } from '@/components/chat/QuoteBtwDrawer';
import { Transcript } from '@/components/chat/Transcript';
import { BrowserWorkbench } from '@/components/browser/BrowserWorkbench';
import { IdeWorkbench } from '@/components/ide/IdeWorkbench';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { ResearchSourceDrawer } from '@/components/shell/ResearchSourceDrawer';
import { RewindPreviewModal } from '@/components/shell/RewindPreviewModal';
import { SessionSidebar } from '@/components/shell/SessionSidebar';
import { StatusBar } from '@/components/shell/StatusBar';
import { SteerQueueDrawer } from '@/components/shell/SteerQueueDrawer';
import { TopBar } from '@/components/shell/TopBar';
import { SourcePreviewModal } from '@/components/common/SourcePreviewModal';
import { AIStudioArenaView } from '@/components/workbenches/AIStudioArenaView';
import { AtelierView } from '@/components/workbenches/AtelierView';
import { KnowledgeExtensionsView } from '@/components/workbenches/KnowledgeExtensionsView';
import { MissionLifecycleView } from '@/components/workbenches/MissionLifecycleView';
import { ObservabilityView } from '@/components/workbenches/ObservabilityView';
import { OmniDriveView } from '@/components/workbenches/OmniDriveView';
import { SwarmView } from '@/components/workbenches/SwarmView';
import {
  activeCanvasArtifact,
  activePreviewDoc,
  applyContrastMode,
  applyMotionMode,
  applyTheme,
  canvasDrawerOpen,
  commandPaletteOpen,
  contrastPref,
  hydrateStudioStartup,
  motionPref,
  openObservabilityTab,
  openWorkbench,
  privacyMask,
  refineCanvasArtifact,
  setActivePreviewDoc,
  setCanvasDrawerOpen,
  setCommandPaletteOpen,
  sidebarOpen,
  themePref,
  toggleContrastMode,
  togglePrivacyMask,
  toggleReducedMotion,
  topMode,
  updateCanvasArtifactContent,
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

/**
 * Vietnamese IME (VNI / Telex / Windows MSCTFIME) guard:
 * never intercept global shortcuts while an IME composition session is active.
 */
function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229 || e.key === 'Process';
}

export function App() {
  onMount(() => {
    applyTheme(themePref());
    applyContrastMode(contrastPref());
    applyMotionMode(motionPref());
    void hydrateStudioStartup();

    const onKey = (e: KeyboardEvent) => {
      if (isImeComposing(e)) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen());
        return;
      }

      // IME-safe Alt+Shift+C (WCAG AAA High Contrast) & Alt+Shift+M (Reduced Motion)
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const lower = e.key.toLowerCase();
        if (lower === 'c') {
          e.preventDefault();
          toggleContrastMode();
          return;
        }
        if (lower === 'm') {
          e.preventDefault();
          toggleReducedMotion();
          return;
        }
      }

      // IME-safe Alt+1..8 rapid workbench switching (never clashes with Ctrl/Shift or open palette)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !commandPaletteOpen()) {
        const digit = e.key;
        if (digit === '1') {
          e.preventDefault();
          openWorkbench('chat');
          return;
        }
        if (digit === '2') {
          e.preventDefault();
          openWorkbench('arena');
          return;
        }
        if (digit === '3') {
          e.preventDefault();
          openWorkbench('atelier');
          return;
        }
        if (digit === '4') {
          e.preventDefault();
          openWorkbench('omnidrive');
          return;
        }
        if (digit === '5') {
          e.preventDefault();
          openWorkbench('swarm');
          return;
        }
        if (digit === '6') {
          e.preventDefault();
          openObservabilityTab('telemetry');
          return;
        }
        if (digit === '7') {
          e.preventDefault();
          openWorkbench('knowledge');
          return;
        }
        if (digit === '8') {
          e.preventDefault();
          openWorkbench('lifecycle');
          return;
        }
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
    <div
      class="omnia-shell"
      data-privacy-masked={privacyMask() ? 'true' : 'false'}
      data-contrast={contrastPref()}
      data-motion={motionPref()}
    >
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
              <Show when={workbenchTab() === 'arena'}>
                <AIStudioArenaView />
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
              <Show when={workbenchTab() === 'lifecycle'}>
                <MissionLifecycleView />
              </Show>
            </div>
            <ArtifactCanvasDrawer
              open={canvasDrawerOpen()}
              artifact={activeCanvasArtifact()}
              onClose={() => setCanvasDrawerOpen(false)}
              onUpdateContent={updateCanvasArtifactContent}
              onAskRefine={refineCanvasArtifact}
            />
            <QuoteBtwDrawer />
            <SteerQueueDrawer />
            <ResearchSourceDrawer />
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
      <SourcePreviewModal doc={activePreviewDoc()} onClose={() => setActivePreviewDoc(null)} />
    </div>
  );
}
