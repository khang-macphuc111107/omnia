import { invokeCore } from "@/lib/desktop";
import type { ChatController, ChatSession } from "../chat/chat-controller";

export interface NavigationSnapshot {
  schemaVersion: 1;
  revision: number;
  openIds: string[];
  activeId: string | null;
  updatedAtMs: number;
}

export interface SaveNavigationRequest {
  expectedRevision: number;
  openIds: string[];
  activeId: string | null;
}

/** Unknown responses are validated at the IPC boundary, never trusted via a cast. */
export interface NavigationBridge {
  load: () => Promise<unknown>;
  save: (request: SaveNavigationRequest) => Promise<unknown>;
}

export const nativeNavigationBridge: NavigationBridge = {
  load: () => invokeCore("agent_session_navigation_load"),
  save: (request) => invokeCore("agent_session_navigation_save", { request }),
};

export type SessionTabsPhase = "waiting" | "loading" | "ready" | "saving" | "conflict" | "error" | "cancelled" | "preview";
export interface SessionTabsState {
  openIds: readonly string[];
  activeId: string | null;
  phase: SessionTabsPhase;
  source: "native" | "preview" | "waiting";
  revision: number | null;
  receiptId: string | null;
  updatedAtMs: number | null;
  dirty: boolean;
  conflict: NavigationSnapshot | null;
  error: string | null;
}

type View = { openIds: string[]; activeId: string | null };
type Intent = { kind: "select"; id: string } | { kind: "close"; id: string } | { kind: "move"; id: string; index: number };
const CANCELLED = Symbol("cancelled navigation observation");
const LIMIT = 256;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && new TextEncoder().encode(value).byteLength <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function sameView(a: View, b: View): boolean {
  return a.activeId === b.activeId && a.openIds.length === b.openIds.length
    && a.openIds.every((id, index) => id === b.openIds[index]);
}

function parseSnapshot(value: unknown): NavigationSnapshot {
  if (!object(value) || Object.keys(value).some((key) => !["schemaVersion", "revision", "openIds", "activeId", "updatedAtMs"].includes(key))
    || value.schemaVersion !== 1 || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.updatedAtMs !== "number" || !Number.isSafeInteger(value.updatedAtMs)
    || !Array.isArray(value.openIds) || value.openIds.length > LIMIT || !value.openIds.every(validId)
    || new Set(value.openIds).size !== value.openIds.length
    || (value.activeId !== null && (!validId(value.activeId) || !value.openIds.includes(value.activeId)))
    || (value.revision === 0 ? value.updatedAtMs !== 0 || value.openIds.length !== 0 || value.activeId !== null : value.updatedAtMs <= 0)) {
    throw new Error("The native session tab snapshot is invalid. Reload tabs before saving.");
  }
  return { schemaVersion: 1, revision: value.revision, openIds: [...value.openIds] as string[], activeId: value.activeId as string | null, updatedAtMs: value.updatedAtMs };
}

function parseLoad(value: unknown): { snapshot: NavigationSnapshot; receiptId: string } {
  if (!object(value) || !validId(value.receiptId)) throw new Error("The native session tab receipt is invalid. Reload tabs before saving.");
  return { snapshot: parseSnapshot(value.snapshot), receiptId: value.receiptId };
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (object(cause) && typeof cause.message === "string") return cause.message;
  return "Native session tabs could not be loaded or saved.";
}

function apply(view: View, intent: Intent): View {
  const openIds = [...view.openIds];
  if (intent.kind === "select") {
    if (!openIds.includes(intent.id)) {
      if (openIds.length === LIMIT) return view;
      openIds.push(intent.id);
    }
    return { openIds, activeId: intent.id };
  }
  const index = openIds.indexOf(intent.id);
  if (index < 0) return view;
  if (intent.kind === "close") {
    if (openIds.length <= 1) return view;
    openIds.splice(index, 1);
    return { openIds, activeId: view.activeId === intent.id ? openIds[Math.min(index, openIds.length - 1)] ?? null : view.activeId };
  }
  openIds.splice(index, 1);
  openIds.splice(Math.max(0, Math.min(intent.index, openIds.length)), 0, intent.id);
  return { openIds, activeId: view.activeId };
}

/**
 * Navigation is metadata only. This coordinator cannot delete sessions or send
 * prompts. One transport tail serializes writes and reloads even after a cancel.
 */
export class SessionTabsCoordinator {
  private state: SessionTabsState = { openIds: [], activeId: null, phase: "waiting", source: "waiting", revision: null, receiptId: null, updatedAtMs: null, dirty: false, conflict: null, error: null };
  private listeners = new Set<() => void>();
  private chat: ChatController | null = null;
  private sessions = new Map<string, ChatSession>();
  private createdSessions = new Map<string, ChatSession>();
  private durableIds = new Set<string>();
  private confirmed: NavigationSnapshot | null = null;
  private observedChatActive: string | null = null;
  private intents: Intent[] = [];
  private live = false;
  private generation = 0;
  private loaded = false;
  private started = false;
  private saveInFlight = false;
  private transportTail: Promise<void> | null = null;

  constructor(private readonly bridge: NavigationBridge = nativeNavigationBridge) {}

  getSnapshot = (): SessionTabsState => this.state;
  getSession = (id: string): ChatSession | undefined => this.sessions.get(id);
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activate = (): void => {
    if (this.live) return;
    this.live = true;
    this.generation += 1;
    this.started = false;
  };

  suspend = (): void => {
    this.live = false;
    this.generation += 1;
    this.started = false;
    this.loaded = false;
    this.saveInFlight = false;
    this.intents = [];
  };

  private current(generation: number): boolean { return this.live && generation === this.generation; }
  private view(): View { return { openIds: [...this.state.openIds], activeId: this.state.activeId }; }

  private nativeView(): View {
    const openIds = this.state.openIds.filter((id) => this.persistable(id));
    const activeId = this.state.activeId !== null && openIds.includes(this.state.activeId)
      ? this.state.activeId : this.confirmed?.activeId && openIds.includes(this.confirmed.activeId)
        ? this.confirmed.activeId : openIds[0] ?? null;
    return { openIds, activeId };
  }

  private persistable(id: string): boolean {
    if (id.startsWith("rebuild-nonproject-") || this.sessions.get(id)?.localOnly) return false;
    return this.sessions.has(id) || this.durableIds.has(id);
  }

  private publish(patch: Partial<SessionTabsState> = {}): void {
    if (!this.live) return;
    const previous = this.state;
    const next = { ...previous, ...patch };
    this.state = next;
    next.dirty = next.source === "native" && (!this.confirmed || !sameView(this.nativeView(), this.confirmed));
    if (Object.keys(next).every((key) => Object.is(next[key as keyof SessionTabsState], previous[key as keyof SessionTabsState]))) {
      this.state = previous;
      return;
    }
    for (const listener of this.listeners) listener();
  }

  private ensureVisible(view: View): View {
    const fallback = this.chat?.activeId && this.sessions.has(this.chat.activeId) ? this.chat.activeId : this.sessions.keys().next().value as string | undefined;
    let openIds = view.openIds;
    let activeId = view.activeId;
    if (!openIds.length && fallback) openIds = [fallback];
    if (!activeId || !openIds.includes(activeId) || !this.sessions.has(activeId)) {
      activeId = openIds.find((id) => this.sessions.has(id)) ?? null;
      if (!activeId && fallback && openIds.length < LIMIT) { openIds = [...openIds, fallback]; activeId = fallback; }
    }
    return { openIds, activeId };
  }

  /** Updated after React commits; a previous controller callback is never retained. */
  updateController = (chat: ChatController): void => {
    if (!this.live) return;
    const wasNative = this.chat?.native;
    this.chat = chat;
    for (const session of chat.sessions) this.createdSessions.delete(session.id);
    this.sessions = new Map([...chat.sessions, ...this.createdSessions.values()].map((session) => [session.id, session]));
    const externallySelected = this.observedChatActive !== null && chat.activeId !== this.observedChatActive;
    this.observedChatActive = chat.activeId;
    if (wasNative !== undefined && wasNative !== chat.native) {
      this.generation += 1; this.loaded = false; this.started = false; this.saveInFlight = false;
      this.confirmed = null; this.intents = [];
    }
    if (!this.state.openIds.length) this.publish(this.ensureVisible(this.view()));
    if (!chat.native) {
      this.publish({ source: "preview", phase: "preview", revision: null, receiptId: null, updatedAtMs: null, conflict: null, error: null });
      if (externallySelected) this.selectSession(chat.activeId, false);
      return;
    }
    if (externallySelected && this.state.activeId !== chat.activeId) this.selectSession(chat.activeId, false);
    // Chat initializes Omnia Core and authoritative session discovery. Navigation
    // must not race that handshake or persist the bootstrap local placeholder.
    if (!this.started && (chat.status === "ready" || chat.status === "running") && [...this.sessions.values()].some((session) => !session.localOnly)) {
      // Keep explicit tab selections made while Chat was bootstrapping. A
      // user can select a session before native navigation is allowed to
      // load; the first restore must replay that intent over the durable view.
      void this.reload(true);
    } else if (!this.started) {
      this.publish({ source: "native", phase: "waiting", error: chat.error });
    }
  };

  private dispatch<T>(generation: number, action: () => Promise<T>): Promise<T | typeof CANCELLED> {
    let task: Promise<T | typeof CANCELLED>;
    const run = () => this.current(generation) ? action() : CANCELLED;
    try { task = this.transportTail ? this.transportTail.then<T | typeof CANCELLED>(() => run()) : Promise.resolve(run()); }
    catch (cause) { task = Promise.reject(cause); }
    const settled = task.then(() => undefined, () => undefined);
    this.transportTail = settled;
    void settled.then(() => { if (this.transportTail === settled) this.transportTail = null; });
    return task;
  }

  reload = async (preserveIntents = false): Promise<void> => {
    if (!this.live || !this.chat?.native) return;
    const generation = ++this.generation;
    this.started = true; this.loaded = false; this.saveInFlight = false;
    // An explicit recovery reload is authoritative after an outcome-unknown
    // write and must discard local navigation intents. The bootstrap reload
    // above is different: preserve pre-bootstrap user choices for replay.
    if (!preserveIntents) this.intents = [];
    this.publish({ source: "native", phase: "loading", conflict: null, error: null });
    try {
      const value = await this.dispatch(generation, () => this.bridge.load());
      if (!this.current(generation) || value === CANCELLED) return;
      const response = parseLoad(value);
      this.confirmed = response.snapshot;
      this.durableIds = new Set(response.snapshot.openIds);
      let view: View = { openIds: [...response.snapshot.openIds], activeId: response.snapshot.activeId };
      for (const intent of this.intents) view = apply(view, intent);
      this.intents = [];
      view = this.ensureVisible(view);
      this.loaded = true;
      this.publish({ ...view, phase: "ready", revision: response.snapshot.revision, receiptId: response.receiptId, updatedAtMs: response.snapshot.updatedAtMs });
      if (view.activeId && this.chat?.activeId !== view.activeId && this.sessions.has(view.activeId)) this.chat?.selectSession(view.activeId);
      this.flush();
    } catch (cause) {
      if (!this.current(generation)) return;
      this.publish({ phase: "error", error: `${errorText(cause)} Your current tab views are kept. Reload native tabs to recover.` });
    }
  };

  private change(intent: Intent, notifyChat = true): boolean {
    if (!this.live) return false;
    const view = this.ensureVisible(apply(this.view(), intent));
    if (sameView(view, this.view())) {
      // An explicit click is newer intent even when the provisional view
      // already shows it. A delayed restore must not override that choice.
      if (intent.kind === "select" && this.chat?.native && !this.loaded) this.intents.push(intent);
      return false;
    }
    if (this.chat?.native && !this.loaded) this.intents.push(intent);
    this.publish(view);
    if (notifyChat && view.activeId && view.activeId !== this.chat?.activeId && this.sessions.has(view.activeId)) this.chat?.selectSession(view.activeId);
    this.flush();
    return true;
  }

  selectSession = (id: string, notifyChat = true): void => {
    if (!this.sessions.has(id) || !validId(id)) return;
    if (this.state.openIds.length >= LIMIT && !this.state.openIds.includes(id)) {
      this.publish({ error: "Up to 256 conversation tabs can be open. Close a tab before opening another." });
      return;
    }
    this.change({ kind: "select", id }, notifyChat);
  };

  closeSession = (id: string): boolean => this.change({ kind: "close", id });
  moveSession = (id: string, index: number): void => {
    if (Number.isSafeInteger(index)) this.change({ kind: "move", id, index }, false);
  };

  createSession = async (cwd?: string): Promise<ChatSession> => {
    if (!this.chat || !this.live) throw new Error("Conversation tabs are not mounted.");
    const generation = this.generation;
    const session = await this.chat.createSession(cwd);
    if (!this.current(generation)) return session;
    this.createdSessions.set(session.id, session);
    this.sessions.set(session.id, session);
    this.selectSession(session.id, false);
    return session;
  };

  private flush(): void {
    if (!this.live || !this.chat?.native || !this.loaded || !this.confirmed || this.saveInFlight
      || !["ready", "saving"].includes(this.state.phase)) return;
    const desired = this.nativeView();
    if (sameView(desired, this.confirmed)) return;
    const request: SaveNavigationRequest = { expectedRevision: this.confirmed.revision, openIds: [...desired.openIds], activeId: desired.activeId };
    const generation = this.generation;
    this.saveInFlight = true;
    this.publish({ phase: "saving", error: null });
    void this.dispatch(generation, () => this.bridge.save(request)).then((value) => {
      if (!this.current(generation) || value === CANCELLED) return;
      if (!object(value) || (value.status !== "saved" && value.status !== "conflict")) throw new Error("Native session tab save returned an invalid acknowledgement.");
      const response = parseLoad(value);
      if (value.status === "saved" && (response.snapshot.revision !== request.expectedRevision + 1 || !sameView(response.snapshot, request))) {
        throw new Error("The native tab save acknowledgement does not match the requested revision or views.");
      }
      if (value.status === "conflict" && response.snapshot.revision === request.expectedRevision) throw new Error("The native tab conflict returned an unchanged revision.");
      this.confirmed = response.snapshot;
      this.durableIds = new Set(response.snapshot.openIds);
      this.saveInFlight = false;
      this.publish({ phase: value.status === "conflict" ? "conflict" : "ready", revision: response.snapshot.revision, receiptId: response.receiptId, updatedAtMs: response.snapshot.updatedAtMs, conflict: value.status === "conflict" ? response.snapshot : null });
      if (value.status === "saved") this.flush();
    }).catch((cause: unknown) => {
      if (!this.current(generation)) return;
      this.saveInFlight = false;
      this.loaded = false;
      this.publish({ phase: "error", error: `${errorText(cause)} The save outcome is unconfirmed. Reload native tabs before saving again.` });
    });
  }

  useSavedTabs = (): void => {
    if (!this.live || this.state.phase !== "conflict" || !this.confirmed) return;
    const view = this.ensureVisible({ openIds: [...this.confirmed.openIds], activeId: this.confirmed.activeId });
    this.publish({ ...view, phase: "ready", conflict: null, error: null });
    if (view.activeId && this.sessions.has(view.activeId) && this.chat?.activeId !== view.activeId) this.chat?.selectSession(view.activeId);
    this.flush();
  };

  saveCurrentTabs = (): void => {
    if (!this.live || this.state.phase !== "conflict" || !this.loaded) return;
    this.publish({ phase: "ready", conflict: null, error: null });
    this.flush();
  };

  cancelPending = (): void => {
    if (!this.live || !["loading", "saving"].includes(this.state.phase)) return;
    this.generation += 1;
    this.loaded = false; this.saveInFlight = false; this.intents = [];
    this.publish({ phase: "cancelled", error: "Stopped waiting for native tabs. A dispatched save may still finish; reload native tabs to confirm its outcome." });
  };
}
