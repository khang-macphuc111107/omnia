import { For, Show, createSignal } from 'solid-js';
import {
  Camera,
  Code2,
  Globe,
  Hand,
  MousePointer2,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Terminal,
  XCircle,
} from 'lucide-solid';
import { api } from '@/api/client';
import { Composer } from '@/components/chat/Composer';
import { Transcript } from '@/components/chat/Transcript';
import {
  browserChatDrawerOpen,
  browserState,
  privacyMask,
  setBrowserState,
} from '@/state/studio';
import { maskJson, maskText } from '@/utils/privacy';

type InspectorTab = 'dom' | 'console' | 'obs' | 'remote';

export function BrowserWorkbench() {
  const [urlInput, setUrlInput] = createSignal(browserState.url || 'https://example.com');
  const [typeInput, setTypeInput] = createSignal('');
  const [windows, setWindows] = createSignal<Array<{ hwnd: number; title: string }>>([]);
  const [busy, setBusy] = createSignal(false);
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const [inspectorTab, setInspectorTab] = createSignal<InspectorTab>('dom');
  const [domSnapshot, setDomSnapshot] = createSignal<Record<string, unknown> | null>(null);
  const [obsInfo, setObsInfo] = createSignal<Record<string, unknown> | null>(null);
  const [remoteInfo, setRemoteInfo] = createSignal<Record<string, unknown> | null>(null);
  const [deviceLabel, setDeviceLabel] = createSignal('omnia-peer-device');

  const logLine = (msg: string) => {
    setBrowserState('consoleLogs', (prev) => [...prev.slice(-39), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

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
      logLine(`Launched isolated CDP at ${urlInput()}`);
    } else {
      setBrowserState({ error: `${res.error.code}: ${res.error.message}` });
      logLine(`Launch error: ${res.error.code}`);
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
        screenshotBase64:
          typeof res.data.screenshot_base64 === 'string' ? res.data.screenshot_base64 : browserState.screenshotBase64,
        error: undefined,
      });
      logLine(`Navigated -> ${urlInput()}`);
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
    if (res.ok) {
      if (typeof res.data.screenshot_base64 === 'string') {
        setBrowserState({ screenshotBase64: res.data.screenshot_base64, error: undefined });
      }
      logLine(`CDP click(${x}, ${y})`);
    } else {
      setBrowserState({ error: `${res.error.code}: ${res.error.message}` });
    }
  };

  const handleScreenshot = async () => {
    const res = await api.browserAction('screenshot');
    if (res.ok && typeof res.data.screenshot_base64 === 'string') {
      setBrowserState({ screenshotBase64: res.data.screenshot_base64, error: undefined });
      logLine('Captured CDP frame');
    } else if (!res.ok) {
      setBrowserState({ error: `${res.error.code}: ${res.error.message}` });
    }
  };

  const handleTypeText = async () => {
    const text = typeInput();
    if (!text) return;
    const res = await api.browserAction('type', { text });
    if (res.ok) {
      setTypeInput('');
      setBrowserState({ error: undefined });
      logLine(`Typed ${text.length} chars into focused element`);
    } else {
      setBrowserState({ error: `${res.error.code}: ${res.error.message}` });
    }
  };

  const handleClose = async () => {
    const res = await api.browserAction('close');
    if (res.ok) {
      setBrowserState({ active: false, sessionId: undefined, error: undefined });
      logLine('Closed isolated CDP browser');
    } else {
      setBrowserState({ error: `${res.error.code}: ${res.error.message}` });
    }
  };

  const handleListWindows = async () => {
    const res = await api.listWindows();
    if (res.ok && Array.isArray(res.data.windows)) {
      setWindows(res.data.windows);
      setBrowserState({ error: undefined });
      logLine(`Enumerated ${res.data.windows.length} Win32 top-level windows`);
    } else if (!res.ok) {
      setBrowserState({ error: `${res.error.code}: ${res.error.message}` });
    }
  };

  const openInspector = async (tab: InspectorTab) => {
    setInspectorTab(tab);
    setInspectorOpen(true);
    if (tab === 'dom') {
      const res = await api.browserAction('snapshot');
      setDomSnapshot(res.ok ? res.data : { error: res.error.code, message: res.error.message });
    } else if (tab === 'obs') {
      const [obsRes, capRes, isoRes] = await Promise.all([
        api.getObsStatus(),
        api.getMediaCapabilities(),
        api.getMediaIsolation(),
      ]);
      setObsInfo({
        obs: obsRes.ok ? obsRes.data : obsRes.error,
        capabilities: capRes.ok ? capRes.data : capRes.error,
        isolation: isoRes.ok ? isoRes.data : isoRes.error,
      });
    } else if (tab === 'remote') {
      const res = await api.getRemoteStatus();
      setRemoteInfo(res.ok ? res.data : { error: res.error.code, message: res.error.message });
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
            <span>Isolated CDP (Zero Thorium)</span>
          </div>

          <div class="flex-1 min-w-[200px] flex items-center gap-1.5">
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
            <button type="button" class="omnia-btn text-[11.5px]" title="Refresh Screenshot" onClick={() => void handleScreenshot()}>
              <RefreshCw class="w-3.5 h-3.5" />
            </button>
            <Show when={browserState.active}>
              <button type="button" class="omnia-btn omnia-btn-danger text-[11.5px]" title="Close Browser" onClick={() => void handleClose()}>
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
            <span>{browserState.manualControl ? 'Manual ON' : 'Agent Ctrl'}</span>
          </button>

          <button type="button" class="omnia-btn text-[11.5px]" onClick={() => void handleListWindows()}>
            <Camera class="w-3.5 h-3.5" />
            <span>Win32</span>
          </button>

          <button type="button" class="omnia-btn text-[11.5px]" onClick={() => void openInspector('dom')}>
            <Code2 class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
            <span>DOM</span>
          </button>

          <button type="button" class="omnia-btn text-[11.5px]" onClick={() => void openInspector('obs')}>
            <Radio class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
            <span>OBS v5</span>
          </button>

          <button type="button" class="omnia-btn text-[11.5px]" onClick={() => void openInspector('remote')}>
            <Smartphone class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
            <span>Remote</span>
          </button>
        </div>

        <Show when={browserState.error}>
          <div class="px-3 py-2 bg-[var(--status-coral-dim)] border-b border-[var(--status-coral)] text-[12px] text-[var(--status-coral)] font-mono-num">
            {maskText(browserState.error!, privacyMask())}
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
                    Click <strong>Launch</strong> to start an isolated headless Chrome/Edge session under{' '}
                    <code class="font-mono-num">D:\OmniaData\tmp\omnia-cdp-*</code>. User Thorium browser is strictly untouched.
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

        {/* Collapsible DOM / Console / OBS v5 / Remote Control Inspector Strip */}
        <Show when={inspectorOpen()}>
          <div class="h-44 shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-col">
            <div class="px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] flex items-center justify-between gap-2 text-[11px]">
              <div class="omp-segmented text-[11px]">
                <button type="button" aria-pressed={inspectorTab() === 'dom'} onClick={() => void openInspector('dom')}>
                  DOM Snapshot
                </button>
                <button type="button" aria-pressed={inspectorTab() === 'console'} onClick={() => setInspectorTab('console')}>
                  Console ({browserState.consoleLogs.length})
                </button>
                <button type="button" aria-pressed={inspectorTab() === 'obs'} onClick={() => void openInspector('obs')}>
                  OBS v5 & Media
                </button>
                <button type="button" aria-pressed={inspectorTab() === 'remote'} onClick={() => void openInspector('remote')}>
                  Remote Control
                </button>
              </div>
              <button type="button" class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={() => setInspectorOpen(false)}>
                Hide
              </button>
            </div>

            <div class="flex-1 overflow-auto p-2.5 text-[11px] font-mono-num">
              <Show when={inspectorTab() === 'dom'}>
                <pre class="whitespace-pre-wrap text-[var(--ink-secondary)]">
                  {JSON.stringify(maskJson(domSnapshot() ?? { hint: 'Click DOM to query /api/browser/snapshot' }, privacyMask()), null, 2)}
                </pre>
              </Show>
              <Show when={inspectorTab() === 'console'}>
                <div class="space-y-0.5 text-[var(--ink-secondary)]">
                  <Show when={browserState.consoleLogs.length > 0} fallback={<span class="text-[var(--ink-muted)]">No CDP actions logged yet.</span>}>
                    <For each={browserState.consoleLogs}>{(line) => <div>{maskText(line, privacyMask())}</div>}</For>
                  </Show>
                </div>
              </Show>
              <Show when={inspectorTab() === 'obs'}>
                <pre class="whitespace-pre-wrap text-[var(--ink-secondary)]">
                  {JSON.stringify(maskJson(obsInfo() ?? { status: 'Probing OBS v5 & desktop isolation...' }, privacyMask()), null, 2)}
                </pre>
              </Show>
              <Show when={inspectorTab() === 'remote'}>
                <div class="space-y-2">
                  <div class="flex items-center gap-2">
                    <input
                      type="text"
                      value={deviceLabel()}
                      onInput={(e) => setDeviceLabel(e.currentTarget.value)}
                      class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px]"
                    />
                    <button
                      type="button"
                      class="omnia-btn omnia-btn-primary text-[11px]"
                      onClick={async () => {
                        const r = await api.pairRemote(deviceLabel());
                        setRemoteInfo(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                      }}
                    >
                      Pair Remote Device
                    </button>
                  </div>
                  <pre class="whitespace-pre-wrap text-[var(--ink-secondary)]">
                    {JSON.stringify(maskJson(remoteInfo() ?? { status: 'Inspecting omnia-remote-control...' }, privacyMask()), null, 2)}
                  </pre>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* Type Text + Win32 Capture Strip */}
        <div class="px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center gap-2 text-[12px]">
          <input
            type="text"
            placeholder="Type text into focused element via CDP..."
            value={typeInput()}
            onInput={(e) => setTypeInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleTypeText();
            }}
            class="flex-1 min-w-[200px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 outline-none"
          />
          <button type="button" class="omnia-btn text-[11.5px]" onClick={() => void handleTypeText()}>
            Send Type
          </button>

          <button type="button" class="omnia-btn text-[11.5px]" onClick={() => setInspectorOpen(!inspectorOpen())}>
            <Terminal class="w-3.5 h-3.5" />
            <span>Inspector</span>
          </button>

          <Show when={windows().length > 0}>
            <select
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px] max-w-xs"
              onChange={(e) => {
                const hwnd = Number(e.currentTarget.value);
                if (hwnd) {
                  void api.captureWindow(hwnd).then((r) => {
                    if (r.ok && r.data.image_base64) {
                      setBrowserState({ screenshotBase64: r.data.image_base64, error: undefined });
                      logLine(`Captured Win32 HWND ${hwnd}`);
                    } else if (!r.ok) {
                      setBrowserState({ error: `${r.error.code}: ${r.error.message}` });
                    }
                  });
                }
              }}
            >
              <option value="">Capture Win32 HWND...</option>
              <For each={windows()}>{(w) => <option value={w.hwnd}>{w.title} ({w.hwnd})</option>}</For>
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
