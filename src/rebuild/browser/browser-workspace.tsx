import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, Code2, Globe2, LockKeyhole, Plus, RefreshCw, Search, ShieldCheck, SquareArrowOutUpRight, X, ZoomIn, ZoomOut } from "lucide-react";
import { BrowserSurfaceController, createBrowserNativePort, type BrowserAction, type BrowserCaptureReceipt, type BrowserNativePort, type BrowserShortcut } from "./browser-controller";
import "./browser-workspace.css";

export interface BrowserWorkspaceProps {
  nativePort?: BrowserNativePort;
  compact?: boolean;
  onCapture?: (receipt: BrowserCaptureReceipt) => void;
}

function statusText(controller: BrowserSurfaceController): string {
  const state = controller.getSnapshot();
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  if (!controller.port.available) return "Preview · native surface unavailable";
  if (state.capturing) return "Checking capture receipt…";
  if (state.obscured) return "Native page hidden behind inspector";
  if (active?.status === "attaching") return "Attaching native WebView2 surface…";
  if (active?.status === "ready") return "Native surface ready";
  if (active?.status === "error") return "Native surface error";
  return "Waiting for surface";
}

export function BrowserWorkspace({ nativePort, compact = false, onCapture }: BrowserWorkspaceProps) {
  const controller = useMemo(() => new BrowserSurfaceController(nativePort ?? createBrowserNativePort()), [nativePort]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(state.tabs.find((tab) => tab.id === state.activeId)?.url ?? "");
  const active = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];

  useEffect(() => {
    controller.start();
    let unlisten: (() => void) | undefined;
    void controller.port.subscribe?.({
      navigation: (event) => controller.acceptNavigation(event),
      policy: (event) => controller.acceptPolicy(event),
      shortcut: (event: BrowserShortcut) => {
        if (!controller.ownsShortcut(event)) return;
        if (event.action === "focus-address") addressRef.current?.focus();
        else if (event.action === "reload") void controller.action("reload");
        else if (event.action === "new-tab") controller.addTab();
        else if (event.action === "close-tab") controller.closeTab(controller.getSnapshot().activeId);
        else if (event.action === "next-tab" || event.action === "previous-tab") {
          const tabs = controller.getSnapshot().tabs;
          const index = tabs.findIndex((tab) => tab.id === controller.getSnapshot().activeId);
          const offset = event.action === "next-tab" ? 1 : -1;
          const next = tabs[(index + offset + tabs.length) % tabs.length];
          if (next) controller.activate(next.id);
        }
      },
    }).then((remove) => { unlisten = remove; }).catch(() => undefined);
    return () => { unlisten?.(); controller.dispose(); };
  }, [controller]);

  useEffect(() => {
    setAddress(active?.url ?? "");
  }, [active?.id, active?.url]);

  useEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const scale = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      controller.setBounds({ x: Math.round(Math.max(0, rect.left) * scale), y: Math.round(Math.max(0, rect.top) * scale), width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node); update();
    const visibility = () => controller.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", visibility);
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", visibility); };
  }, [controller]);

  const doAction = (action: BrowserAction) => { void controller.action(action); };
  const navigate = (event: React.FormEvent) => { event.preventDefault(); void controller.navigate(address); };
  const capture = async () => {
    const receipt = await controller.capture("page");
    if (receipt) { onCapture?.(receipt); controller.setObscured(true); }
  };
  const retry = () => controller.retry();

  return (
    <section className={`rb-browser ${compact ? "rb-browser--compact" : ""}`} aria-label="Omnia native browser workspace">
      <header className="rb-browser__header">
        <div className="rb-browser__identity"><Globe2 size={16} aria-hidden="true" /><span>Browser</span><span className={`rb-browser__availability ${controller.port.available ? "is-live" : "is-preview"}`}>{controller.port.available ? "native" : "preview"}</span></div>
        <div className="rb-browser__tabstrip">
        <div className="rb-browser__tabs" role="tablist" aria-label="Browser tabs">
          {state.tabs.map((tab, index) => <button id={`rb-browser-tab-${tab.id}`} key={tab.id} type="button" role="tab" aria-label={tab.title} aria-selected={tab.id === state.activeId} aria-controls={tab.id === state.activeId ? `rb-browser-page-${tab.id}` : undefined} tabIndex={tab.id === state.activeId ? 0 : -1} className={`rb-browser__tab ${tab.id === state.activeId ? "is-active" : ""}`} onClick={() => controller.activate(tab.id)} onKeyDown={(event) => {
            if (event.key === "Delete") { event.preventDefault(); controller.closeTab(tab.id); return; }
            const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? state.tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % state.tabs.length : event.key === "ArrowLeft" ? (index - 1 + state.tabs.length) % state.tabs.length : -1;
            const next = state.tabs[nextIndex];
            if (next) { event.preventDefault(); controller.activate(next.id); document.getElementById(`rb-browser-tab-${next.id}`)?.focus(); }
          }}><span className="rb-browser__tab-dot" />{tab.title}</button>)}
        </div>
        <div className="rb-browser__tab-actions" aria-label="Browser tab actions">
          {state.tabs.map((tab) => <button key={tab.id} type="button" className="rb-browser__tab-close" onClick={() => controller.closeTab(tab.id)} aria-label={`Close ${tab.title}`} title={`Close ${tab.title}`}><X size={12} aria-hidden="true" /></button>)}
        </div>
          <button type="button" className="rb-browser__tab-add" onClick={() => controller.addTab()} aria-label="New browser tab"><Plus size={15} /></button>
        </div>
        <span className="rb-browser__security"><LockKeyhole size={13} aria-hidden="true" /> isolated page</span>
      </header>
      <div className="rb-browser__toolbar">
        <button type="button" className="rb-browser__icon-button" onClick={() => doAction("back")} aria-label="Back"><ArrowLeft size={16} /></button>
        <button type="button" className="rb-browser__icon-button" onClick={() => doAction("forward")} aria-label="Forward"><ArrowRight size={16} /></button>
        <button type="button" className="rb-browser__icon-button" onClick={() => doAction("reload")} aria-label="Reload"><RefreshCw size={15} /></button>
        <form className="rb-browser__address" onSubmit={navigate}><LockKeyhole size={13} aria-hidden="true" /><input ref={addressRef} aria-label="Address" value={address} onChange={(event) => setAddress(event.target.value)} /><button type="submit" aria-label="Navigate"><ArrowRight size={15} /></button></form>
        <button type="button" className="rb-browser__icon-button" onClick={() => doAction("zoom-out")} aria-label="Zoom out"><ZoomOut size={15} /></button><span className="rb-browser__zoom">{active?.zoomPercent ?? 100}%</span><button type="button" className="rb-browser__icon-button" onClick={() => doAction("zoom-in")} aria-label="Zoom in"><ZoomIn size={15} /></button>
        <button type="button" className="rb-browser__tool-button" onClick={() => void capture()}><Search size={14} />Capture</button>
        <button type="button" className="rb-browser__icon-button" onClick={() => doAction("devtools")} aria-label="Open native developer tools"><Code2 size={15} /></button>
      </div>
      <div className="rb-browser__surface-wrap" role="tabpanel" id={`rb-browser-page-${active?.id}`} aria-labelledby={`rb-browser-tab-${active?.id}`}>
        <div ref={surfaceRef} className="rb-browser__surface" data-native-browser-surface>
          <div className="rb-browser__surface-state" aria-live="polite">
            <div className="rb-browser__state-mark"><ShieldCheck size={20} /></div>
            <strong>{controller.port.available ? statusText(controller) : "Native WebView2 surface not connected"}</strong>
            <p>{controller.port.available ? (active?.error ?? "The page is rendered by an isolated native surface owned by Omnia.") : "Run the packaged Omnia desktop to attach a real page. Preview never invents web content."}</p>
            {!controller.port.available && <span className="rb-browser__state-code">browser.control · unavailable in preview</span>}
            {active?.status === "error" && <button type="button" className="rb-browser__retry" onClick={retry}>Retry surface</button>}
          </div>
        </div>
        {state.notice && <div className="rb-browser__notice" role="status">{state.notice}</div>}
      </div>
      {active?.capture && <aside className="rb-browser__capture" aria-label="Captured page text"><div><div><span className="rb-browser__eyebrow">CAPTURE RECEIPT</span><strong>{active.capture.title || active.url}</strong></div><button type="button" onClick={() => controller.setObscured(false)} aria-label="Close capture"><X size={15} /></button></div><p>{active.capture.text || "The page returned no readable text."}</p><footer><span>{active.capture.byteSize.toLocaleString()} bytes</span><span>{active.capture.contentSha256.slice(0, 12)}</span><span>{active.capture.truncated ? "truncated" : "complete"}</span></footer></aside>}
      <footer className="rb-browser__footer"><span>{statusText(controller)}</span><span className="rb-browser__footer-spacer" /><button type="button" onClick={() => doAction("focus")}><SquareArrowOutUpRight size={13} /> Focus page</button><button type="button" onClick={() => doAction("zoom-reset")}><ChevronDown size={13} /> Reset zoom</button></footer>
    </section>
  );
}
