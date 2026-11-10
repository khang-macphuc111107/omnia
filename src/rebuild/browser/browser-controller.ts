import { listen } from "@tauri-apps/api/event";
import { desktop, invokeCore, type NativeCommandError } from "@/lib/desktop";

export type BrowserStatus = "idle" | "attaching" | "ready" | "error" | "unavailable";
export type BrowserAction = "back" | "forward" | "reload" | "focus" | "devtools" | "zoom-in" | "zoom-out" | "zoom-reset";
export type CaptureMode = "page" | "selection";
export interface BrowserBounds { x: number; y: number; width: number; height: number }
export interface BrowserAttachment { leaseId: string; url?: string; zoomPercent?: number }
export interface BrowserCaptureReceipt {
  receiptId: string; tabKey: string; leaseId: string; url: string; title: string;
  mode: CaptureMode; text: string; contentSha256: string; byteSize: number;
  truncated: boolean; capturedAtMs: number; source: "native-dom-text";
}
export interface BrowserTabModel {
  id: string; title: string; url: string; leaseId: string | null; status: BrowserStatus;
  loading: boolean; zoomPercent: number; error: string | null; capture: BrowserCaptureReceipt | null;
}
export interface BrowserNavigation {
  tabKey: string; leaseId: string; url: string; title?: string; loading?: boolean; zoomPercent: number;
}
export interface BrowserPolicyNotice {
  receiptId: string; tabKey: string; leaseId: string; kind: string;
  reason: string; occurredAtMs: number; url?: string; success?: boolean;
}
export interface BrowserShortcut {
  tabKey: string; leaseId: string;
  action: "focus-address" | "new-tab" | "close-tab" | "next-tab" | "previous-tab" | "reload";
}
export interface BrowserNativePort {
  readonly available: boolean;
  subscribe?(handlers: {
    navigation: (payload: BrowserNavigation) => void;
    policy: (payload: BrowserPolicyNotice) => void;
    shortcut: (payload: BrowserShortcut) => void;
  }): Promise<() => void>;
  attach(request: { tabKey: string; url: string; bounds: BrowserBounds }): Promise<BrowserAttachment>;
  update(request: { leaseId: string; bounds: BrowserBounds; visible: boolean }): Promise<void>;
  navigate(request: { leaseId: string; url: string }): Promise<void>;
  action(request: { leaseId: string; action: BrowserAction }): Promise<void>;
  capture(request: { leaseId: string; mode: CaptureMode }): Promise<BrowserCaptureReceipt>;
  release(request: { leaseId: string }): Promise<void>;
}
export interface BrowserSnapshot {
  tabs: readonly BrowserTabModel[]; activeId: string; notice: string | null;
  capturing: boolean; obscured: boolean; cleanupFailures: number;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const candidate = error as Partial<NativeCommandError> | null;
  return typeof candidate?.message === "string" ? candidate.message : "Native browser request failed";
}

export function validBrowserUrl(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  let parsed: URL;
  try { parsed = new URL(raw.trim()); } catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host)
    || host === "0.0.0.0" || host === "[::1]" || host === "[::]"
    || /^\[::ffff:(?:7f[0-9a-f]{2}:|0:0\])/.test(host)) return null;
  return parsed.toString();
}

export function resolveBrowserAddress(raw: string, search: "google" | "bing" = "google"): string | null {
  const text = raw.trim();
  if (!text || text.length > 8192) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return validBrowserUrl(text);
  if (!/\s/.test(text) && (text.includes(".") || text === "localhost")) return validBrowserUrl(`https://${text}`);
  return `${search === "bing" ? "https://www.bing.com/search?q=" : "https://www.google.com/search?q="}${encodeURIComponent(text)}`;
}

export function nativeBrowserAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.__TAURI_INTERNALS__ as { invoke?: unknown; transformCallback?: unknown } | undefined;
  return typeof bridge?.invoke === "function" && typeof bridge.transformCallback === "function";
}

export function createBrowserNativePort(): BrowserNativePort {
  const available = nativeBrowserAvailable();
  async function call<T>(command: string, request: Record<string, unknown>): Promise<T> {
    if (!available) throw new Error("Native browser is unavailable in this preview");
    const runtime = await desktop.runtimeInfo();
    await desktop.initializeCore(runtime.appVersion);
    return invokeCore<T>(command, request);
  }
  return {
    available,
    async subscribe(handlers) {
      if (!available) return () => undefined;
      const removers: (() => void)[] = [];
      try {
        removers.push(await listen<BrowserNavigation>("omnia-browser-surface-navigation", (event) => handlers.navigation(event.payload)));
        removers.push(await listen<BrowserPolicyNotice>("omnia-browser-surface-policy", (event) => handlers.policy(event.payload)));
        removers.push(await listen<BrowserShortcut>("omnia-native-browser-shortcut", (event) => handlers.shortcut(event.payload)));
      } catch (error) { removers.forEach((remove) => remove()); throw error; }
      return () => removers.forEach((remove) => remove());
    },
    attach: (request) => call<BrowserAttachment>("browser_surface_attach", request),
    update: (request) => call<void>("browser_surface_update", request),
    navigate: (request) => call<void>("browser_surface_navigate", request),
    action: (request) => call<void>("browser_surface_action", request),
    capture: (request) => call<BrowserCaptureReceipt>("browser_surface_capture", request),
    release: (request) => call<void>("browser_surface_release", request),
  };
}

export function emptyBrowserTab(id: string, url = "https://example.com/"): BrowserTabModel {
  return { id, title: "New page", url, leaseId: null, status: "idle", loading: false, zoomPercent: 100, error: null, capture: null };
}

export function boundsFromRect(rect: Pick<DOMRect, "left" | "top" | "width" | "height">, scale = 1): BrowserBounds {
  if (![rect.left, rect.top, rect.width, rect.height, scale].every(Number.isFinite) || scale <= 0) throw new Error("Browser geometry must be finite");
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  return { x: Math.round(left * scale), y: Math.round(top * scale), width: Math.max(1, Math.round((rect.width - (left - rect.left)) * scale)), height: Math.max(1, Math.round((rect.height - (top - rect.top)) * scale)) };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, onLate?: (value: T) => void): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error("Native browser request timed out; the surface was retired")); }, timeoutMs);
  });
  void promise.then((value) => { if (expired) onLate?.(value); }, () => undefined);
  try { return await Promise.race([promise, timed]); } finally { clearTimeout(timer); }
}

function cleanTitle(title: string): string { return title.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 512); }

/** One renderer-owned lifecycle. Native leases never escape this controller. */
export class BrowserSurfaceController {
  private snapshot: BrowserSnapshot = { tabs: [emptyBrowserTab("browser-tab-1")], activeId: "browser-tab-1", notice: null, capturing: false, obscured: false, cleanupFailures: 0 };
  private listeners = new Set<() => void>();
  private versions = new Map<string, number>();
  private sequence = 1;
  private epoch = 0;
  private live = false;
  private bounds: BrowserBounds | null = null;
  private visible = true;
  private serial: Promise<void> = Promise.resolve();
  private syncQueued = false;
  readonly port: BrowserNativePort;
  readonly timeoutMs: number;

  constructor(port: BrowserNativePort, timeoutMs = 15_000) { this.port = port; this.timeoutMs = timeoutMs; }
  getSnapshot = (): BrowserSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private commit(patch: Partial<BrowserSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach((listener) => listener()); }
  private tab(id: string) { return this.snapshot.tabs.find((tab) => tab.id === id); }
  private patchTab(id: string, patch: Partial<BrowserTabModel>) { this.commit({ tabs: this.snapshot.tabs.map((tab) => tab.id === id ? { ...tab, ...patch } : tab) }); }
  private bump(id: string) { this.versions.set(id, (this.versions.get(id) ?? 0) + 1); }
  private current(id: string, version: number, epoch: number) { return this.live && this.epoch === epoch && this.versions.get(id) === version && !!this.tab(id); }
  private dispatch<T>(job: () => Promise<T>): Promise<T> { const result = this.serial.then(job); this.serial = result.then(() => undefined, () => undefined); return result; }
  private async retire(leaseId: string) {
    try { await within(this.port.release({ leaseId }), this.timeoutMs); }
    catch { this.commit({ cleanupFailures: this.snapshot.cleanupFailures + 1, notice: "A native surface could not confirm cleanup. Retry cleanup or restart Omnia before opening more pages." }); }
  }
  start() { this.live = true; this.epoch++; this.scheduleSync(); }
  dispose() {
    this.live = false; this.epoch++;
    const leases = this.snapshot.tabs.flatMap((tab) => tab.leaseId ? [tab.leaseId] : []);
    this.snapshot.tabs.forEach((tab) => this.bump(tab.id));
    this.commit({ tabs: this.snapshot.tabs.map((tab) => ({ ...tab, leaseId: null, status: "idle", loading: false })), capturing: false });
    leases.forEach((lease) => { void this.dispatch(() => this.retire(lease)); });
  }
  setBounds(bounds: BrowserBounds | null) { this.bounds = bounds; this.scheduleSync(); }
  setVisible(visible: boolean) { this.visible = visible; this.scheduleSync(); }
  setObscured(obscured: boolean) { this.commit({ obscured }); this.scheduleSync(); }
  setNotice(notice: string | null) { this.commit({ notice }); }
  activate(id: string) {
    if (!this.tab(id)) return;
    const old = this.tab(this.snapshot.activeId); if (old) this.bump(old.id);
    this.commit({ activeId: id, notice: null, obscured: false }); this.scheduleSync();
  }
  addTab(url = "https://example.com/"): string | null {
    if (this.snapshot.tabs.length >= 32) { this.setNotice("The native browser supports at most 32 tabs. Close a tab first."); return null; }
    const safe = validBrowserUrl(url); if (!safe) return null;
    const id = `browser-tab-${++this.sequence}`;
    this.versions.set(id, 0);
    this.commit({ tabs: [...this.snapshot.tabs, emptyBrowserTab(id, safe)], activeId: id, notice: null, obscured: false }); this.scheduleSync(); return id;
  }
  closeTab(id: string) {
    const tab = this.tab(id); if (!tab) return;
    this.bump(id);
    const remaining = this.snapshot.tabs.filter((item) => item.id !== id);
    if (!remaining.length) { const nextId = `browser-tab-${++this.sequence}`; remaining.push(emptyBrowserTab(nextId)); this.versions.set(nextId, 0); }
    this.commit({ tabs: remaining, activeId: this.snapshot.activeId === id ? remaining[remaining.length - 1]!.id : this.snapshot.activeId, obscured: false });
    if (tab.leaseId) void this.dispatch(() => this.retire(tab.leaseId!));
    this.scheduleSync();
  }
  retry() {
    const tab = this.tab(this.snapshot.activeId); if (!tab) return;
    this.bump(tab.id);
    if (tab.leaseId) void this.dispatch(() => this.retire(tab.leaseId!));
    this.patchTab(tab.id, { leaseId: null, status: "idle", error: null }); this.scheduleSync();
  }
  private scheduleSync() {
    if (!this.live || this.syncQueued) return;
    this.syncQueued = true;
    void this.dispatch(async () => { this.syncQueued = false; if (this.live) await this.sync(); }).catch((error: unknown) => this.setNotice(errorMessage(error)));
  }
  private async sync() {
    const epoch = this.epoch;
    const active = this.snapshot.activeId;
    const region = this.bounds;
    if (!region) return;
    for (const tab of this.snapshot.tabs) {
      if (tab.leaseId && (tab.id !== active || !this.visible || this.snapshot.obscured)) {
        await within(this.port.update({ leaseId: tab.leaseId, bounds: region, visible: false }), this.timeoutMs);
      }
    }
    if (!this.live || epoch !== this.epoch) return;
    let tab = this.tab(this.snapshot.activeId); if (!tab) return;
    if (!this.port.available) { this.patchTab(tab.id, { status: "unavailable" }); return; }
    if (!this.visible || this.snapshot.obscured) return;
    if (!tab.leaseId) {
      if (tab.status === "error") return;
      const id = tab.id;
      if (!this.versions.has(id)) this.versions.set(id, 0);
      const version = this.versions.get(id)!;
      this.patchTab(id, { status: "attaching", loading: true, error: null });
      try {
        const attached = await within(this.port.attach({ tabKey: id, url: tab.url, bounds: region }), this.timeoutMs, (late) => { void this.retire(late.leaseId); });
        if (!/^[a-f0-9]{32}$/i.test(attached.leaseId)) throw new Error("Native browser returned an invalid surface lease");
        if (!this.current(id, version, epoch)) { await this.retire(attached.leaseId); this.scheduleSync(); return; }
        this.patchTab(id, { leaseId: attached.leaseId, url: validBrowserUrl(attached.url ?? tab.url) ?? tab.url, zoomPercent: attached.zoomPercent ?? 100, status: "ready", loading: false });
        tab = this.tab(id)!;
      } catch (error) {
        if (this.current(id, version, epoch)) this.patchTab(id, { status: "error", loading: false, error: errorMessage(error) });
        return;
      }
    }
    if (!tab.leaseId || epoch !== this.epoch || !this.live) return;
    const show = this.snapshot.activeId === tab.id && this.visible && !this.snapshot.obscured;
    try { await within(this.port.update({ leaseId: tab.leaseId, bounds: this.bounds ?? region, visible: show }), this.timeoutMs); }
    catch (error) { this.patchTab(tab.id, { status: "error", error: errorMessage(error) }); }
    if (this.snapshot.activeId !== tab.id) this.scheduleSync();
  }
  async navigate(raw: string, search: "google" | "bing" = "google"): Promise<boolean> {
    const url = resolveBrowserAddress(raw, search);
    if (!url) { this.setNotice("Use an HTTP or HTTPS address without credentials or local hosts, or enter a web search."); return false; }
    const id = this.snapshot.activeId;
    this.bump(id);
    this.patchTab(id, { url, capture: null, loading: this.port.available, error: null });
    const epoch = this.epoch;
    const version = this.versions.get(id)!;
    if (!this.port.available) { this.patchTab(id, { status: "unavailable", loading: false }); this.setNotice("Preview mode: web navigation requires the Omnia native desktop surface."); return false; }
    return this.dispatch(async () => {
      if (!this.current(id, version, epoch)) return false;
      const tab = this.tab(id)!;
      if (!tab.leaseId) { this.patchTab(id, { status: "idle" }); this.scheduleSync(); return true; }
      try { await within(this.port.navigate({ leaseId: tab.leaseId, url }), this.timeoutMs); return true; }
      catch (error) { if (this.current(id, version, epoch)) this.patchTab(id, { status: "error", loading: false, error: errorMessage(error) }); return false; }
    });
  }
  async action(action: BrowserAction): Promise<boolean> {
    const tab = this.tab(this.snapshot.activeId);
    if (!tab?.leaseId || !this.port.available || tab.status !== "ready") { this.setNotice("This control requires an attached native browser surface."); return false; }
    const leaseId = tab.leaseId;
    const epoch = this.epoch;
    return this.dispatch(async () => {
      if (!this.live || epoch !== this.epoch || this.tab(tab.id)?.leaseId !== leaseId || this.snapshot.activeId !== tab.id) return false;
      try { await within(this.port.action({ leaseId, action }), this.timeoutMs); return true; }
      catch (error) { this.setNotice(errorMessage(error)); return false; }
    });
  }
  acceptNavigation(event: BrowserNavigation) {
    const tab = this.tab(event.tabKey);
    const url = validBrowserUrl(event.url);
    if (!tab || !tab.leaseId || tab.leaseId !== event.leaseId || !url || !this.live) return;
    if (tab.url !== url || event.loading === true) this.bump(tab.id);
    this.patchTab(tab.id, {
      url, title: typeof event.title === "string" && cleanTitle(event.title) ? cleanTitle(event.title) : tab.title,
      loading: typeof event.loading === "boolean" ? event.loading : tab.loading,
      zoomPercent: Number.isFinite(event.zoomPercent) ? Math.max(25, Math.min(500, event.zoomPercent)) : tab.zoomPercent,
      capture: tab.url === url && event.loading !== true ? tab.capture : null,
    });
  }
  acceptPolicy(event: BrowserPolicyNotice) {
    const tab = this.tab(event.tabKey);
    if (!tab?.leaseId || tab.leaseId !== event.leaseId || !this.live || typeof event.reason !== "string") return;
    this.setNotice(`${cleanTitle(event.reason)} · ${event.receiptId.slice(0, 64)}`);
  }
  ownsShortcut(event: BrowserShortcut) { const tab = this.tab(this.snapshot.activeId); return this.live && tab?.id === event.tabKey && tab.leaseId === event.leaseId && !!tab.leaseId; }
  async capture(mode: CaptureMode): Promise<BrowserCaptureReceipt | null> {
    const tab = this.tab(this.snapshot.activeId);
    if (!this.port.available) { this.setNotice("Capture requires an attached native browser surface."); return null; }
    if (!tab?.leaseId || !this.bounds || this.snapshot.obscured) { this.setNotice("Capture requires a visible native page. Close the capture inspector first."); return null; }
    if (this.snapshot.capturing) return null;
    const id = tab.id, lease = tab.leaseId, url = tab.url, version = this.versions.get(id)!, epoch = this.epoch, started = Date.now();
    this.commit({ capturing: true });
    try {
      return await this.dispatch(async () => {
        if (!this.current(id, version, epoch) || this.snapshot.activeId !== id) return null;
        await within(this.port.update({ leaseId: lease, bounds: this.bounds!, visible: true }), this.timeoutMs);
        const receipt = await within(this.port.capture({ leaseId: lease, mode }), this.timeoutMs);
        if (!this.current(id, version, epoch) || this.snapshot.activeId !== id || this.tab(id)?.leaseId !== lease || this.tab(id)?.url !== url) return null;
        await validateCaptureReceipt(receipt, { id, lease, url, mode, started });
        if (!this.current(id, version, epoch) || this.snapshot.activeId !== id) return null;
        this.patchTab(id, { capture: receipt }); return receipt;
      });
    } catch (error) { if (this.live && epoch === this.epoch) this.setNotice(errorMessage(error)); return null; }
    finally { if (this.live && epoch === this.epoch) this.commit({ capturing: false }); }
  }
}

export async function validateCaptureReceipt(receipt: BrowserCaptureReceipt, expected: { id: string; lease: string; url: string; mode: CaptureMode; started: number }) {
  if (!receipt || receipt.tabKey !== expected.id || receipt.leaseId !== expected.lease || receipt.url !== expected.url
    || receipt.mode !== expected.mode || receipt.source !== "native-dom-text" || !/^browser_capture_[a-f0-9]{32}$/i.test(receipt.receiptId)
    || typeof receipt.text !== "string" || !/^[a-f0-9]{64}$/i.test(receipt.contentSha256)
    || !Number.isFinite(receipt.capturedAtMs) || receipt.capturedAtMs < expected.started - 30_000 || receipt.capturedAtMs > Date.now() + 30_000) throw new Error("The capture receipt does not match the active native document");
  const bytes = new TextEncoder().encode(receipt.text);
  if (bytes.byteLength !== receipt.byteSize || bytes.byteLength > 262_144) throw new Error("The capture receipt has an invalid byte count");
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 verification is unavailable; capture was not accepted");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== receipt.contentSha256.toLowerCase()) throw new Error("The capture receipt hash does not match its content");
}
