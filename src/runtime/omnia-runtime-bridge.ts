import {
  desktop,
  type AppRuntimeInfo,
  type NativeCommandError,
  type RunStreamEvent,
} from "@/lib/desktop";
import { OMNIA_PROTOCOL_VERSION, type CoreRuntimeInfo } from "@/lib/core-protocol";
import {
  createOmniaRuntimeController,
  type OmniaRuntimeController,
  type OmniaRuntimeEvent,
  type OmniaRuntimeOptions,
} from "@/runtime/omnia-runtime-controller";

/** A cleanup function returned by a renderer or native event subscription. */
export type RuntimeUnsubscribe = () => void | Promise<void>;

export type RuntimeMode = "browser" | "desktop";

export type RuntimeBridgeStatus =
  | "idle"
  | "initializing"
  | "ready"
  | "failed"
  | "disposed";

export type RuntimeBridgeErrorCode =
  | "runtime_info_failed"
  | "core_initialize_failed"
  | "run_event_subscription_failed"
  | "disposed";

export type RuntimeBridgeError = {
  readonly code: RuntimeBridgeErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** A redacted diagnostic handle, when supplied by native infrastructure. */
  readonly diagnosticId?: string;
};

export type RuntimeBridgeSnapshot = {
  readonly mode: RuntimeMode;
  readonly status: RuntimeBridgeStatus;
  /** Increments whenever a new lifecycle is started or the bridge is disposed. */
  readonly lifecycleEpoch: number;
  readonly runtimeInfo: AppRuntimeInfo | null;
  readonly core: CoreRuntimeInfo | null;
  readonly error: RuntimeBridgeError | null;
};

export type RuntimeBridgeListener = (snapshot: RuntimeBridgeSnapshot) => void;
export type RuntimeRunEventListener = (event: RunStreamEvent) => void;

/**
 * Capability resolution is intentionally tri-state. Before negotiation there
 * is no authoritative capability list, so callers must not mistake an
 * unknown capability for a denied one.
 */
export type RuntimeCapabilityState = "available" | "unavailable" | "unknown";

/**
 * The minimum infrastructure surface required by the renderer composition
 * root.  The default implementation delegates to the existing desktop facade;
 * tests and browser-specific hosts can inject an in-memory implementation.
 *
 * Keeping this port small is intentional: app state, persistence, and domain
 * mutations remain owned by OmniaRuntimeController rather than by the runtime
 * transport itself.
 */
export interface RendererRuntimePort {
  runtimeInfo(): Promise<AppRuntimeInfo>;
  initializeCore(appVersion: string): Promise<CoreRuntimeInfo>;
  onRunEvent(listener: RuntimeRunEventListener): Promise<RuntimeUnsubscribe>;
}

export type OmniaRuntimeBridgeOptions = {
  readonly port?: RendererRuntimePort;
  readonly controller?: OmniaRuntimeController;
  readonly controllerOptions?: OmniaRuntimeOptions;
};

export type BrowserPreviewRuntimePortOptions = {
  readonly appVersion?: string;
  readonly debug?: boolean;
};

export type BrowserPreviewRuntimePort = RendererRuntimePort & {
  /** Emits a renderer-local preview event to active subscribers. */
  emitRunEvent(event: RunStreamEvent): void;
};

export type RuntimeBridgeInitialization = {
  readonly snapshot: RuntimeBridgeSnapshot;
  readonly controller: OmniaRuntimeController;
};

function defaultPort(): RendererRuntimePort {
  return {
    runtimeInfo: () => desktop.runtimeInfo(),
    initializeCore: (appVersion) => desktop.initializeCore(appVersion),
    onRunEvent: (listener) => desktop.onRunEvent(listener),
  };
}

function modeFromRuntimeInfo(info: AppRuntimeInfo | null): RuntimeMode {
  return info?.tauri === true ? "desktop" : "browser";
}

function messageFromUnknown(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return fallback;
}

function nativeDiagnosticId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("diagnosticId" in error)) return undefined;
  const diagnosticId = (error as Partial<NativeCommandError>).diagnosticId;
  return typeof diagnosticId === "string" && diagnosticId.length > 0 ? diagnosticId : undefined;
}

function bridgeError(
  code: RuntimeBridgeErrorCode,
  error: unknown,
  fallback: string,
): RuntimeBridgeError {
  const diagnosticId = nativeDiagnosticId(error);
  return {
    code,
    message: messageFromUnknown(error, fallback),
    retryable: code !== "disposed" && (typeof error !== "object" || error === null || !("retryable" in error)
      ? true
      : (error as Partial<NativeCommandError>).retryable !== false),
    ...(diagnosticId === undefined ? {} : { diagnosticId }),
  };
}

function cloneSnapshot(snapshot: RuntimeBridgeSnapshot): RuntimeBridgeSnapshot {
  return {
    ...snapshot,
    runtimeInfo: snapshot.runtimeInfo === null ? null : { ...snapshot.runtimeInfo },
    core: snapshot.core === null
      ? null
      : {
          ...snapshot.core,
          serverInfo: { ...snapshot.core.serverInfo },
          capabilities: [...snapshot.core.capabilities],
          unavailableCapabilities: [...snapshot.core.unavailableCapabilities],
        },
    error: snapshot.error === null ? null : { ...snapshot.error },
  };
}

/**
 * Renderer-side runtime composition boundary.
 *
 * It has three deliberately separate responsibilities:
 *
 * - negotiate browser-preview or Tauri runtime capability;
 * - expose the pure app-state controller to the renderer;
 * - guard long-lived run-event subscriptions with a lifecycle epoch.
 *
 * It never writes browser state to native storage and never turns browser
 * preview into a claim of durable persistence or provider execution.
 */
export class OmniaRuntimeBridge {
  private readonly port: RendererRuntimePort;
  private readonly controller: OmniaRuntimeController;
  private readonly listeners = new Set<RuntimeBridgeListener>();
  private readonly subscriptions = new Set<RuntimeUnsubscribe>();
  private snapshot: RuntimeBridgeSnapshot = {
    mode: "browser",
    status: "idle",
    lifecycleEpoch: 0,
    runtimeInfo: null,
    core: null,
    error: null,
  };
  private initialization: Promise<RuntimeBridgeInitialization> | null = null;

  public constructor(options: OmniaRuntimeBridgeOptions = {}) {
    this.port = options.port ?? defaultPort();
    this.controller = options.controller ?? createOmniaRuntimeController(options.controllerOptions);
  }

  public getController(): OmniaRuntimeController {
    return this.controller;
  }

  public getSnapshot(): RuntimeBridgeSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  /** Returns true only after a successful runtime negotiation. */
  public isReady(): boolean {
    return this.snapshot.status === "ready";
  }

  /** Whether the bridge is currently backed by the Tauri/native host. */
  public isDesktop(): boolean {
    return this.snapshot.status === "ready" && this.snapshot.mode === "desktop";
  }

  /** Whether the bridge is currently backed by the renderer-only preview. */
  public isBrowserPreview(): boolean {
    return this.snapshot.status === "ready" && this.snapshot.mode === "browser";
  }

  /**
   * Resolves one negotiated core capability without exposing mutable arrays.
   * Unknown is returned until `initialize()` succeeds, which keeps preview
   * UI from presenting an optimistic permission or execution claim.
   */
  public getCapabilityState(capability: string): RuntimeCapabilityState {
    const normalized = capability.trim();
    if (normalized.length === 0 || this.snapshot.core === null || this.snapshot.status !== "ready") {
      return "unknown";
    }
    if (this.snapshot.core.capabilities.includes(normalized)) return "available";
    if (this.snapshot.core.unavailableCapabilities.includes(normalized)) return "unavailable";
    return "unknown";
  }

  public hasCapability(capability: string): boolean {
    return this.getCapabilityState(capability) === "available";
  }

  /** Returns a defensive copy of the negotiated available capability list. */
  public getCapabilities(): readonly string[] {
    return this.snapshot.core === null || this.snapshot.status !== "ready"
      ? []
      : [...this.snapshot.core.capabilities];
  }

  /** Returns a defensive copy of the negotiated unavailable capability list. */
  public getUnavailableCapabilities(): readonly string[] {
    return this.snapshot.core === null || this.snapshot.status !== "ready"
      ? []
      : [...this.snapshot.core.unavailableCapabilities];
  }

  public subscribe(listener: RuntimeBridgeListener): RuntimeUnsubscribe {
    if (this.snapshot.status === "disposed") return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeState(listener: (event: OmniaRuntimeEvent) => void): RuntimeUnsubscribe {
    if (this.snapshot.status === "disposed") return () => undefined;
    return this.controller.subscribe(listener);
  }

  /**
   * Initializes runtime negotiation once. Concurrent callers share one
   * promise, while a failed initialization can be retried by a later caller.
   */
  public initialize(appVersion?: string): Promise<RuntimeBridgeInitialization> {
    if (this.snapshot.status === "disposed") {
      return Promise.reject(this.disposedError());
    }
    if (this.initialization !== null) return this.initialization;

    const lifecycleEpoch = this.snapshot.lifecycleEpoch + 1;
    this.setSnapshot({
      mode: this.snapshot.mode,
      status: "initializing",
      lifecycleEpoch,
      runtimeInfo: null,
      core: null,
      error: null,
    });

    const initialization = (async () => {
      let runtimeInfo: AppRuntimeInfo;
      try {
        runtimeInfo = await this.port.runtimeInfo();
      } catch (error) {
        const failure = bridgeError("runtime_info_failed", error, "Unable to discover the Omnia runtime.");
        this.failIfCurrent(lifecycleEpoch, failure);
        throw failure;
      }

      if (this.isStale(lifecycleEpoch)) return this.staleInitialization();

      let core: CoreRuntimeInfo;
      try {
        core = await this.port.initializeCore(appVersion ?? runtimeInfo.appVersion);
      } catch (error) {
        const failure = bridgeError("core_initialize_failed", error, "Unable to initialize Omnia Core.");
        this.failIfCurrent(lifecycleEpoch, failure, runtimeInfo);
        throw failure;
      }

      if (this.isStale(lifecycleEpoch)) return this.staleInitialization();

      this.setSnapshot({
        mode: modeFromRuntimeInfo(runtimeInfo),
        status: "ready",
        lifecycleEpoch,
        runtimeInfo,
        core,
        error: null,
      });

      return { snapshot: this.getSnapshot(), controller: this.controller };
    })();
    this.initialization = initialization;

    // Use both branches so the cleanup promise itself cannot become an
    // unhandled rejection when initialization fails.
    void initialization.then(
      () => {
        if (this.initialization === initialization) this.initialization = null;
      },
      () => {
        if (this.initialization === initialization) this.initialization = null;
      },
    );
    return initialization;
  }

  /**
   * Subscribes to normalized run events only after runtime negotiation has
   * completed. The returned cleanup is idempotent and stale callbacks are
   * ignored after disposal or a later lifecycle epoch.
   */
  public async subscribeRunEvents(listener: RuntimeRunEventListener): Promise<RuntimeUnsubscribe> {
    if (this.snapshot.status === "disposed") throw this.disposedError();
    if (this.snapshot.status !== "ready") {
      throw new Error("Initialize the Omnia runtime before subscribing to run events.");
    }

    const lifecycleEpoch = this.snapshot.lifecycleEpoch;
    let unsubscribe: RuntimeUnsubscribe;
    try {
      unsubscribe = await this.port.onRunEvent((event) => {
        if (this.snapshot.status === "disposed" || this.snapshot.lifecycleEpoch !== lifecycleEpoch) return;
        listener(event);
      });
    } catch (error) {
      const failure = bridgeError(
        "run_event_subscription_failed",
        error,
        "Unable to subscribe to Omnia run events.",
      );
      this.setSnapshot({ ...this.snapshot, error: failure });
      throw failure;
    }

    let active = true;
    const cleanup: RuntimeUnsubscribe = async () => {
      if (!active) return;
      active = false;
      this.subscriptions.delete(cleanup);
      await unsubscribe();
    };
    this.subscriptions.add(cleanup);
    return cleanup;
  }

  /**
   * Invalidates all subscriptions and prevents stale asynchronous work from
   * mutating the bridge. The pure app-state controller remains readable so a
   * host can inspect or export renderer state during teardown.
   */
  public async dispose(): Promise<void> {
    if (this.snapshot.status === "disposed") return;
    this.snapshot = {
      ...this.snapshot,
      status: "disposed",
      lifecycleEpoch: this.snapshot.lifecycleEpoch + 1,
      error: null,
    };
    this.emit();
    this.initialization = null;
    const subscriptions = [...this.subscriptions];
    this.subscriptions.clear();
    this.listeners.clear();
    await Promise.allSettled(subscriptions.map((unsubscribe) => unsubscribe()));
  }

  private disposedError(): RuntimeBridgeError {
    return bridgeError("disposed", undefined, "The Omnia runtime bridge has been disposed.");
  }

  private staleInitialization(): never {
    throw this.disposedError();
  }

  private isStale(lifecycleEpoch: number): boolean {
    return this.snapshot.status === "disposed" || this.snapshot.lifecycleEpoch !== lifecycleEpoch;
  }

  private failIfCurrent(
    lifecycleEpoch: number,
    error: RuntimeBridgeError,
    runtimeInfo: AppRuntimeInfo | null = this.snapshot.runtimeInfo,
  ): void {
    if (this.isStale(lifecycleEpoch)) return;
    this.setSnapshot({
      mode: modeFromRuntimeInfo(runtimeInfo),
      status: "failed",
      lifecycleEpoch,
      runtimeInfo,
      core: null,
      error,
    });
  }

  private setSnapshot(snapshot: RuntimeBridgeSnapshot): void {
    this.snapshot = cloneSnapshot(snapshot);
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function createOmniaRuntimeBridge(options: OmniaRuntimeBridgeOptions = {}): OmniaRuntimeBridge {
  return new OmniaRuntimeBridge(options);
}

export function createDesktopRuntimePort(): RendererRuntimePort {
  return defaultPort();
}

/**
 * Creates an explicitly in-memory browser-preview port. It intentionally has
 * no persistence, network, filesystem, or provider authority; its event bus is
 * only useful for renderer-local previews and tests.
 */
export function createBrowserPreviewRuntimePort(
  options: BrowserPreviewRuntimePortOptions = {},
): BrowserPreviewRuntimePort {
  const listeners = new Set<RuntimeRunEventListener>();
  const runtimeInfo: AppRuntimeInfo = {
    appName: "Omnia",
    appVersion: options.appVersion ?? "0.1.0-dev",
    platform: "web",
    tauri: false,
    debug: options.debug ?? false,
  };
  const core: CoreRuntimeInfo = {
    protocolVersion: OMNIA_PROTOCOL_VERSION,
    serverInfo: {
      name: "omnia-browser-preview",
      title: "Omnia Browser Preview",
      version: runtimeInfo.appVersion,
    },
    capabilities: ["run.stream.v1", "project.v1", "provider.capability-negotiation.v1"],
    unavailableCapabilities: [
      "run.replay-cursor",
      "server-request.resolve",
      "skill.prompt-only",
      "memory.read-write",
      "workspace.write",
      "process.execute",
      "browser.control",
      "computer.control",
    ],
    sessionToken: null,
    sessionEpoch: null,
  };

  return {
    runtimeInfo: async () => ({ ...runtimeInfo }),
    initializeCore: async () => ({
      ...core,
      serverInfo: { ...core.serverInfo },
      capabilities: [...core.capabilities],
      unavailableCapabilities: [...core.unavailableCapabilities],
    }),
    onRunEvent: async (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emitRunEvent: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}
