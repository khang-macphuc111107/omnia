import {
  createSettingsPermissionsSnapshot,
  normalizeSettingsPermissionsSnapshot,
  OmniaSettingsPermissionsAdapter,
  updateSettingsPermissionsSnapshot,
  type OmniaSettingsPermissionsSnapshot,
  type SettingsPermissionsLoadResult,
  type OmniaSettingsValues,
} from "../domain/omnia-settings-permissions-adapter";

/**
 * Small host-agnostic settings runtime.
 *
 * The settings control surface is allowed to keep local editing history, but
 * the running application still needs one authoritative way to observe a
 * newer native profile.  This runtime provides that boundary without making
 * the renderer restart: it can reload manually, poll a durable adapter, and
 * receive revision hints from another Omnia window through BroadcastChannel.
 *
 * Broadcast messages intentionally contain only a revision.  The snapshot
 * remains on the persistence boundary, so settings values (which may include
 * sensitive local configuration) are never copied into a browser message.
 */

export type OmniaSettingsHotReloadSource =
  | "initial"
  | "manual"
  | "poll"
  | "broadcast"
  | "save";

export type OmniaSettingsHotReloadEvent =
  | {
      readonly type: "snapshot";
      readonly source: OmniaSettingsHotReloadSource;
      readonly snapshot: OmniaSettingsPermissionsSnapshot;
      readonly revision: number;
    }
  | {
      readonly type: "unchanged";
      readonly source: OmniaSettingsHotReloadSource;
      readonly revision: number | null;
    }
  | {
      readonly type: "error";
      readonly source: OmniaSettingsHotReloadSource;
      readonly error: unknown;
      readonly retryable: boolean;
    };

export type OmniaSettingsHotReloadListener = (
  event: OmniaSettingsHotReloadEvent,
) => void;

export type OmniaSettingsHotReloadOptions = {
  readonly adapter: OmniaSettingsPermissionsAdapter;
  /** Optional local snapshot used while the first durable load is pending. */
  readonly initialSnapshot?: OmniaSettingsPermissionsSnapshot;
  /** Polling is opt-in; zero keeps the runtime event-driven/manual-only. */
  readonly pollIntervalMs?: number;
  /** Separate channel names allow profiles/tests to isolate their windows. */
  readonly channelName?: string;
};

type SettingsHotReloadMessage = {
  readonly kind: "omnia-settings-revision";
  readonly sender: string;
  readonly revision: number;
};

type SettingsHotReloadChannel = {
  postMessage: (message: SettingsHotReloadMessage) => void;
  close: () => void;
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<SettingsHotReloadMessage>) => void,
  ) => void;
  removeEventListener: (
    type: "message",
    listener: (event: MessageEvent<SettingsHotReloadMessage>) => void,
  ) => void;
};

type SettingsHotReloadTimer = ReturnType<typeof globalThis.setTimeout>;

const DEFAULT_CHANNEL_NAME = "omnia.settings.permissions";
const DEFAULT_POLL_INTERVAL_MS = 0;
const MIN_POLL_INTERVAL_MS = 250;

function normalizePollInterval(value: number | undefined): number {
  if (value === undefined || value === 0) return DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Settings hot-reload polling interval must be finite and non-negative.");
  }
  return Math.max(MIN_POLL_INTERVAL_MS, Math.floor(value));
}

function createSenderId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && "randomUUID" in cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `omnia-settings-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cloneSnapshot(
  snapshot: OmniaSettingsPermissionsSnapshot,
): OmniaSettingsPermissionsSnapshot {
  return normalizeSettingsPermissionsSnapshot(snapshot);
}

function retryableError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "retryable" in error &&
      (error as { retryable?: unknown }).retryable === true,
  );
}

function channelFactory(name: string): SettingsHotReloadChannel | null {
  if (typeof globalThis.BroadcastChannel !== "function") return null;
  return new globalThis.BroadcastChannel(name) as unknown as SettingsHotReloadChannel;
}

export class OmniaSettingsHotReloadRuntime {
  private readonly adapter: OmniaSettingsPermissionsAdapter;
  private readonly pollIntervalMs: number;
  private readonly channelName: string;
  private readonly senderId = createSenderId();
  private readonly listeners = new Set<OmniaSettingsHotReloadListener>();
  private currentSnapshot: OmniaSettingsPermissionsSnapshot | null;
  private channel: SettingsHotReloadChannel | null = null;
  private pollTimer: SettingsHotReloadTimer | null = null;
  private reloadPromise: Promise<OmniaSettingsPermissionsSnapshot | null> | null = null;
  private startPromise: Promise<OmniaSettingsPermissionsSnapshot | null> | null = null;
  private running = false;
  private disposed = false;

  public constructor(options: OmniaSettingsHotReloadOptions) {
    this.adapter = options.adapter;
    this.pollIntervalMs = normalizePollInterval(options.pollIntervalMs);
    this.channelName = options.channelName?.trim() || DEFAULT_CHANNEL_NAME;
    this.currentSnapshot = options.initialSnapshot
      ? cloneSnapshot(options.initialSnapshot)
      : null;
  }

  public get snapshot(): OmniaSettingsPermissionsSnapshot | null {
    return this.currentSnapshot === null ? null : cloneSnapshot(this.currentSnapshot);
  }

  public get revision(): number | null {
    return this.currentSnapshot?.revision ?? null;
  }

  public get isRunning(): boolean {
    return this.running && !this.disposed;
  }

  public subscribe(listener: OmniaSettingsHotReloadListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Starts the runtime once. Concurrent callers share the same initial load.
   * A failed durable load does not discard an explicitly supplied snapshot;
   * callers receive the error through the event stream and can retry later.
   */
  public start(): Promise<OmniaSettingsPermissionsSnapshot | null> {
    if (this.disposed) return Promise.reject(new Error("Settings hot-reload runtime is disposed."));
    if (this.startPromise !== null) return this.startPromise;

    this.running = true;
    this.installChannel();
    const initial = this.currentSnapshot;
    if (initial !== null) this.emit({
      type: "snapshot",
      source: "initial",
      snapshot: cloneSnapshot(initial),
      revision: initial.revision,
    });

    const promise = this.reload("initial").then((snapshot) => {
      this.schedulePoll();
      return snapshot;
    });
    this.startPromise = promise;
    void promise.then(
      () => {
        if (this.startPromise === promise) this.startPromise = null;
      },
      () => {
        if (this.startPromise === promise) this.startPromise = null;
      },
    );
    return promise;
  }

  /** Stops polling and cross-window notifications; the runtime can restart. */
  public stop(): void {
    if (this.disposed) return;
    this.running = false;
    this.clearPoll();
    this.closeChannel();
  }

  /** Permanently releases timers/listeners and rejects future starts. */
  public dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.listeners.clear();
  }

  /** Loads the latest durable snapshot and emits only when its revision changes. */
  public reload(
    source: Exclude<OmniaSettingsHotReloadSource, "save"> = "manual",
  ): Promise<OmniaSettingsPermissionsSnapshot | null> {
    if (this.disposed) return Promise.reject(new Error("Settings hot-reload runtime is disposed."));
    if (this.reloadPromise !== null) return this.reloadPromise;

    const promise = this.loadLatest(source);
    this.reloadPromise = promise;
    void promise.then(
      () => {
        if (this.reloadPromise === promise) this.reloadPromise = null;
      },
      () => {
        if (this.reloadPromise === promise) this.reloadPromise = null;
      },
    );
    return promise;
  }

  /**
   * Applies a settings/permission patch without restarting the host.
   * Compare-and-swap is retained at the adapter boundary; callers can reload
   * and present a conflict UI instead of silently overwriting another window.
   */
  public async update(
    patch: {
      readonly values?: OmniaSettingsValues;
      readonly permissions?: OmniaSettingsPermissionsSnapshot["permissions"];
    },
    updatedAt?: string,
  ): Promise<OmniaSettingsPermissionsSnapshot> {
    if (this.disposed) throw new Error("Settings hot-reload runtime is disposed.");
    const base = this.currentSnapshot ?? createSettingsPermissionsSnapshot();
    const next = updateSettingsPermissionsSnapshot(base, {
      ...(patch.values === undefined ? {} : { values: patch.values }),
      ...(patch.permissions === undefined ? {} : { permissions: patch.permissions }),
    }, updatedAt);
    const result = await this.adapter.save(next, base.revision);
    const saved = cloneSnapshot({ ...next, revision: result.revision });
    this.currentSnapshot = saved;
    this.emit({ type: "snapshot", source: "save", snapshot: cloneSnapshot(saved), revision: saved.revision });
    this.broadcast(saved.revision);
    this.schedulePoll();
    return cloneSnapshot(saved);
  }

  private async loadLatest(
    source: Exclude<OmniaSettingsHotReloadSource, "save">,
  ): Promise<OmniaSettingsPermissionsSnapshot | null> {
    let result: SettingsPermissionsLoadResult;
    try {
      result = await this.adapter.load();
    } catch (error) {
      this.emit({ type: "error", source, error, retryable: retryableError(error) });
      throw error;
    }

    if (result.status === "empty") {
      this.emit({ type: "unchanged", source, revision: this.currentSnapshot?.revision ?? null });
      return this.snapshot;
    }

    const incoming = cloneSnapshot(result.snapshot);
    const currentRevision = this.currentSnapshot?.revision ?? 0;
    if (incoming.revision <= currentRevision) {
      this.emit({ type: "unchanged", source, revision: currentRevision || null });
      return this.snapshot;
    }

    this.currentSnapshot = incoming;
    this.emit({ type: "snapshot", source, snapshot: cloneSnapshot(incoming), revision: incoming.revision });
    this.schedulePoll();
    return this.snapshot;
  }

  private emit(event: OmniaSettingsHotReloadEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener failures must not stop persistence or the polling loop.
      }
    }
  }

  private installChannel(): void {
    if (this.channel !== null || this.disposed) return;
    const channel = channelFactory(this.channelName);
    if (channel === null) return;
    const onMessage = (event: MessageEvent<SettingsHotReloadMessage>) => {
      const message = event.data;
      if (
        !message ||
        message.kind !== "omnia-settings-revision" ||
        message.sender === this.senderId ||
        !Number.isSafeInteger(message.revision) ||
        message.revision <= (this.currentSnapshot?.revision ?? 0)
      ) return;
      void this.reload("broadcast").catch(() => undefined);
    };
    channel.addEventListener("message", onMessage);
    this.channel = {
      postMessage: (message) => channel.postMessage(message),
      close: () => {
        channel.removeEventListener("message", onMessage);
        channel.close();
      },
      addEventListener: channel.addEventListener.bind(channel),
      removeEventListener: channel.removeEventListener.bind(channel),
    };
  }

  private closeChannel(): void {
    this.channel?.close();
    this.channel = null;
  }

  private broadcast(revision: number): void {
    this.channel?.postMessage({ kind: "omnia-settings-revision", sender: this.senderId, revision });
  }

  private schedulePoll(): void {
    if (!this.running || this.pollIntervalMs <= 0 || this.pollTimer !== null || this.disposed) return;
    this.pollTimer = globalThis.setTimeout(() => {
      this.pollTimer = null;
      void this.reload("poll").catch(() => undefined).finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  private clearPoll(): void {
    if (this.pollTimer === null) return;
    globalThis.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}
