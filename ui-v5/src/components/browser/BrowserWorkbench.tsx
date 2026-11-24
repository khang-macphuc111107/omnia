import { For, Show, createSignal } from 'solid-js';
import {
  Camera,
  Globe,
  Hand,
  MousePointer2,
  Play,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-solid';
import { api } from '@/api/client';
import { Composer } from '@/components/chat/Composer';
import { Transcript } from '@/components/chat/Transcript';
import {
  browserChatDrawerOpen,
  browserState,
  setBrowserState,
} from '@/state/studio';

export function BrowserWorkbench() {
  const [urlInput, setUrlInput] = createSignal(browserState.url || 'https://example.com');
  const [typeInput, setTypeInput] = createSignal('');
  const [windows, setWindows] = createSignal<Array<{ hwnd: number; title: string }>>([]);
  const [busy, setBusy] = createSignal(false);

  const handleLaunch = async () => {
    setBusy(true);
    const res = await api.browserAction('launch', { url: urlInput() });
    if (res.ok) {
      setBrowserState({
        active: true,
        sessionId: String(res.data.session_id ?? 'cdp-1'),
        url: String(res.data.url ?? urlInput()),
        screenshotBase64: typeof res.data.screenshot_base64 === 'string' ? res.data.screenshot_base64 : undefined,
        error: undefined,
      });
    } else {
      setBrowserState({ error: `${res.error.code}: ${res.error.message}` });
    }
    setBusy(false);
  };

  const handleNavigate = async () => {
    setBusy(true);
    const res = await api.browserAction('navigate', { url: urlInput() });
    if (res.ok) {
      setBrowserState({
        url: String(res.data.url ?? urlInput()),
        title: typeof res.data.title === 'string' ? res.data.title : undefined,
        screenshotBase64: typeof res.data.screenshot_base64 === 'string' ? res.data.screenshot_base64 : browserState.screenshotBase64,
        error: undefined,
      });
    } else {
      setBrowserState({ error: `${res.error.code}: ${res.error.message}` });
    }
    setBusy(false);
  };

  const handleCanvasClick = async (e: MouseEvent) => {
    const img = e.currentTarget as HTMLElement;
    const rect = img.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1280);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 800);
    setBrowserState({ cursorX: x, cursorY: y, cursorLabel: `click(${x}, ${y})` });
    const res = await api.browserAction('click', { x, y });
    if (res.ok && typeof res.data.screenshot_base64 === 'string') {
      setBrowserState({ screenshotBase64: res.data.screenshot_base64 });
    }
  };

  const handleScreenshot = async () => {
    const res = await api.browserAction('screenshot');
    if (res.ok && typeof res.data.screenshot_base64 === 'string') {
      setBrowserState({ screenshotBase64: res.data.screenshot_base64, error: undefined });
    }
  };

  const handleClose = async () => {
    await api.browserAction('close');
    setBrowserState({ active: false, sessionId: undefined });
  };

  const handleListWindows = async () => {
    const res = await api.listWindows();
    if (res.ok && Array.isArray(res.data.windows)) {
      setWindows(res.data.windows);
    }
  };

  return (
    <div data-testid="browser-workbench" class="flex-1 min-h-0 flex overflow-hidden bg-[var(--bg-canvas)]">
      {/* Main Isolated CDP Browser Viewport */}
      <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Top Browser Control Bar */}
        <div class="px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center gap-2">
          <div class="omnia-badge text-[var(--status-emerald)]">
            <ShieldCheck class="w-3.5 h-3.5" />
            <span>Isolated CDP (Temp Profile · Zero Thorium)</span>
          </div>

          <div class="flex-1 min-w-[220px] flex items-center gap-1.5">
            <input
              type="text"
              value={urlInput()}
              onInput={(e) => setUrlInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleNavigate();
              }}
              class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 text-[12.5px] font-mono-num outline-none focus:border-[var(--border-accent)]"
            />
            <button type="button" disabled={busy()} class="omnia-btn omnia-btn-primary text-[11.5px]" onClick={() => void handleLaunch()}>
              <Play class="w-3.5 h-3.5" />
              <span>Launch</span>
            </button>
            <button type="button" disabled={busy()} class="omnia-btn text-[11.5px]" onClick={() => void handleNavigate()}>
              <Globe class="w-3.5 h-3.5" />
              <span>Go</span>
            </button>
            <button type="button" class="omnia-btn text-[11.5px]" onClick={() => void handleScreenshot()}>
              <RefreshCw class="w-3.5 h-3.5" />
            </button>
            <Show when={browserState.active}>
              <button type="button" class="omnia-btn omnia-btn-danger text-[11.5px]" onClick={() => void handleClose()}>
                <XCircle class="w-3.5 h-3.5" />
              </button>
            </Show>
          </div>

          <button
            type="button"
            class="omnia-btn text-[11.5px]"
            classList={{ 'border-[var(--accent-amber)] text-[var(--accent-amber)]': browserState.manualControl }}
            onClick={() => setBrowserState({ manualControl: !browserState.manualControl })}
          >
            <Hand class="w-3.5 h-3.5" />
            <span>{browserState.manualControl ? 'Manual Takeover ON' : 'Agent Control'}</span>
          </button>

          <button type="button" class="omnia-btn text-[11.5px]" onClick={() => void handleListWindows()}>
            <Camera class="w-3.5 h-3.5" />
            <span>Win32 Windows</span>
          </button>
        </div>

        <Show when={browserState.error}>
          <div class="px-3 py-2 bg-[var(--status-coral-dim)] border-b border-[var(--status-coral)] text-[12px] text-[var(--status-coral)] font-mono-num">
            {browserState.error}
          </div>
        </Show>

        {/* Live Browser Frame + Virtual Cursor Overlay */}
        <div class="flex-1 min-h-0 relative bg-[var(--bg-canvas)] flex items-center justify-center p-4 overflow-auto">
          <div
            onClick={(e) => void handleCanvasClick(e)}
            class="relative w-full max-w-5xl aspect-[16/10] rounded-lg border border-[var(--border-strong)] bg-[var(--bg-panel)] overflow-hidden cursor-crosshair shadow-[var(--shadow-md)]"
          >
            <Show
              when={browserState.screenshotBase64}
              fallback={
                <div class="w-full h-full flex flex-col items-center justify-center text-center p-6 gap-2">
                  <Globe class="w-10 h-10 text-[var(--accent-cyan)] opacity-70" />
                  <div class="text-[14px] font-semibold">Isolated CDP Viewport Ready</div>
                  <div class="text-[12px] text-[var(--ink-muted)] max-w-md">
                    Click <strong>Launch</strong> to start an isolated headless Chrome/Edge session under <code class="font-mono-num">D:\OmniaData\tmp\omnia-cdp-*</code>. User Thorium browser is strictly untouched.
                  </div>
                </div>
              }
            >
              {(b64) => (
                <img
                  src={`data:image/png;base64,${b64()}`}
                  alt="Isolated CDP Frame"
                  class="w-full h-full object-contain select-none"
                />
              )}
            </Show>

            {/* Virtual Cursor & Action Coordinate Overlay */}
            <div
              class="pointer-events-none absolute flex items-center gap-1 transition-all duration-150"
              style={{
                left: `${Math.min(Math.max((browserState.cursorX / 1280) * 100, 2), 95)}%`,
                top: `${Math.min(Math.max((browserState.cursorY / 800) * 100, 2), 95)}%`,
              }}
            >
              <MousePointer2 class="w-5 h-5 text-[var(--accent-amber)] drop-shadow" />
              <Show when={browserState.cursorLabel}>
                <span class="px-1.5 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--accent-amber)] text-[10px] font-mono-num text-[var(--accent-amber)]">
                  {browserState.cursorLabel}
                </span>
              </Show>
            </div>
          </div>
        </div>

        {/* Type Text + Win32 Capture Strip */}
        <div class="px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center gap-2 text-[12px]">
          <input
            type="text"
            placeholder="Type text into focused element via CDP..."
            value={typeInput()}
            onInput={(e) => setTypeInput(e.currentTarget.value)}
            class="flex-1 min-w-[200px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 outline-none"
          />
          <button
            type="button"
            class="omnia-btn text-[11.5px]"
            onClick={() => void api.browserAction('type', { text: typeInput() })}
          >
            Send Type
          </button>

          <Show when={windows().length > 0}>
            <select
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px] max-w-xs"
              onChange={(e) => {
                const hwnd = Number(e.currentTarget.value);
                if (hwnd) {
                  void api.captureWindow(hwnd).then((r) => {
                    if (r.ok && r.data.image_base64) {
                      setBrowserState({ screenshotBase64: r.data.image_base64 });
                    }
                  });
                }
              }}
            >
              <option value="">Capture Win32 HWND...</option>
              <For each={windows()}>
                {(w) => <option value={w.hwnd}>{w.title} ({w.hwnd})</option>}
              </For>
            </select>
          </Show>
        </div>
      </div>

      {/* Collapsible Chat & Agent Sidebar inside Browser Mode */}
      <Show when={browserChatDrawerOpen()}>
        <div
          data-testid="browser-chat-sidebar"
          class="w-96 shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col min-h-0"
        >
          <div class="px-3 py-2 border-b border-[var(--border-subtle)] text-[11.5px] font-semibold">
            Browser Agent Sidebar
          </div>
          <Transcript compact={true} />
          <Composer />
        </div>
      </Show>
    </div>
  );
}
