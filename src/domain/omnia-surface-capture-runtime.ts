import { assertDomain } from "./errors";
import { assertIsoTimestamp, assertNonBlank, type IsoTimestamp } from "./shared";

/**
 * Renderer/native contract for capturing one application surface without
 * taking ownership of the user's desktop pointer or keyboard.
 *
 * The renderer only receives bounded metadata and opaque frame handles. A
 * native implementation owns window/process handles, frame buffers, input
 * injection and permission checks. The browser preview deliberately reports
 * this capability as unavailable instead of pretending that a normal browser
 * tab can capture an arbitrary process.
 */
export const OMNIA_SURFACE_CAPTURE_SCHEMA_VERSION = 1 as const;

export type SurfaceCaptureTargetKind = "process" | "window" | "browser-tab";
export type SurfaceCaptureTargetState = "running" | "minimized" | "hidden" | "exited" | "unknown";
export type SurfaceCaptureMode = "visible" | "unfocused" | "headless";
export type SurfaceCaptureSessionState = "starting" | "active" | "paused" | "stopped" | "failed";
export type SurfaceCaptureCapability =
  | "frame-stream"
  | "cursor-overlay"
  | "pointer-input"
  | "keyboard-input"
  | "headless-capture"
  | "unfocused-capture";

export type SurfaceCaptureAvailability =
  | { readonly status: "available"; readonly capabilitySnapshotId: string; readonly capabilities: readonly SurfaceCaptureCapability[] }
  | { readonly status: "unavailable"; readonly reason: string };

export interface SurfaceCaptureBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
}

export interface SurfaceCaptureTarget {
  readonly schemaVersion: typeof OMNIA_SURFACE_CAPTURE_SCHEMA_VERSION;
  readonly targetId: string;
  readonly kind: SurfaceCaptureTargetKind;
  readonly processId?: number;
  readonly processName?: string;
  readonly windowId?: string;
  readonly tabTargetId?: string;
  readonly title: string;
  readonly state: SurfaceCaptureTargetState;
  readonly bounds?: SurfaceCaptureBounds;
  readonly inputIsolation: "supported" | "unavailable" | "unknown";
}

export interface SurfaceCaptureSession {
  readonly schemaVersion: typeof OMNIA_SURFACE_CAPTURE_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly target: SurfaceCaptureTarget;
  readonly mode: SurfaceCaptureMode;
  readonly state: SurfaceCaptureSessionState;
  readonly capabilities: readonly SurfaceCaptureCapability[];
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly startedAt: IsoTimestamp;
  readonly stoppedAt?: IsoTimestamp;
  readonly failureReason?: string;
}

export type SurfaceCapturePixelFormat = "rgba8" | "bgra8" | "nv12" | "encoded";

/** Metadata for a frame; the actual bytes stay in the native frame broker. */
export interface SurfaceCaptureFrame {
  readonly schemaVersion: typeof OMNIA_SURFACE_CAPTURE_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly sequence: number;
  readonly capturedAt: IsoTimestamp;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: SurfaceCapturePixelFormat;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly frameHandleId: string;
  readonly contentSha256?: string;
  readonly cursor?: SurfaceCaptureCursor;
}

export interface SurfaceCaptureCursor {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly hotspotX: number;
  readonly hotspotY: number;
}

export type SurfaceInputModifier = "alt" | "ctrl" | "meta" | "shift";
export type SurfacePointerButton = "left" | "middle" | "right" | "back" | "forward";
export type SurfacePointerPhase = "move" | "down" | "up" | "wheel";
export type SurfaceKeyboardPhase = "down" | "up" | "text";

export interface SurfacePointerInput {
  readonly kind: "pointer";
  readonly phase: SurfacePointerPhase;
  readonly x: number;
  readonly y: number;
  readonly button?: SurfacePointerButton;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly modifiers?: readonly SurfaceInputModifier[];
}

export interface SurfaceKeyboardInput {
  readonly kind: "keyboard";
  readonly phase: SurfaceKeyboardPhase;
  /** DOM/code-style key identifier, never a native scan-code or device handle. */
  readonly code: string;
  readonly key: string;
  readonly text?: string;
  readonly modifiers?: readonly SurfaceInputModifier[];
}

export type SurfaceInputEvent = SurfacePointerInput | SurfaceKeyboardInput;

export interface IsolatedInputChannel {
  readonly schemaVersion: typeof OMNIA_SURFACE_CAPTURE_SCHEMA_VERSION;
  readonly channelId: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly state: "active" | "paused" | "closed";
  /** Independent means the host user's desktop input focus is not consumed. */
  readonly routing: "independent";
  readonly cursor: "overlay" | "hidden" | "unavailable";
  readonly createdAt: IsoTimestamp;
}

export type SurfaceCaptureFailureCode =
  | "surface_capture_unavailable"
  | "not_found"
  | "invalid_request"
  | "permission_denied"
  | "conflict"
  | "native_error";

export type SurfaceCaptureFailure = {
  readonly ok: false;
  readonly code: SurfaceCaptureFailureCode;
  readonly reason: string;
};

export type SurfaceCaptureResult<T> =
  | { readonly ok: true; readonly value: T }
  | SurfaceCaptureFailure;

export interface OpenSurfaceCaptureInput {
  readonly targetId: string;
  readonly mode: SurfaceCaptureMode;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly attachInput?: boolean;
}

export interface SurfaceCapturePort {
  readonly inspectCapabilities?: () => Promise<SurfaceCaptureAvailability>;
  readonly listTargets?: () => Promise<SurfaceCaptureResult<readonly SurfaceCaptureTarget[]>>;
  readonly open?: (input: OpenSurfaceCaptureInput) => Promise<SurfaceCaptureResult<SurfaceCaptureSession>>;
  readonly close?: (sessionId: string) => Promise<SurfaceCaptureResult<SurfaceCaptureSession>>;
  readonly attachInput?: (sessionId: string) => Promise<SurfaceCaptureResult<IsolatedInputChannel>>;
  readonly detachInput?: (channelId: string) => Promise<SurfaceCaptureResult<null>>;
  readonly sendInput?: (channelId: string, event: SurfaceInputEvent) => Promise<SurfaceCaptureResult<null>>;
  readonly subscribeFrames?: (
    sessionId: string,
    listener: (frame: SurfaceCaptureFrame) => void,
  ) => Promise<() => void | Promise<void>>;
}

export type OmniaSurfaceCaptureRuntimeOptions = {
  readonly port?: SurfaceCapturePort;
};

function failure(code: SurfaceCaptureFailureCode, reason: string): SurfaceCaptureFailure {
  return { ok: false, code, reason };
}

function unavailable(reason: string): SurfaceCaptureFailure {
  return failure("surface_capture_unavailable", reason);
}

function assertFiniteBounded(value: number, label: string, minimum: number, maximum: number): number {
  assertDomain(Number.isFinite(value) && value >= minimum && value <= maximum, "invalid_argument", `${label} must be between ${minimum} and ${maximum}.`, { label, value });
  return value;
}

function validateTarget(target: SurfaceCaptureTarget): SurfaceCaptureTarget {
  assertDomain(target.schemaVersion === OMNIA_SURFACE_CAPTURE_SCHEMA_VERSION, "invalid_argument", "Unsupported surface target schema.");
  assertNonBlank(target.targetId, "targetId", 512);
  assertNonBlank(target.title, "target title", 2_048);
  assertDomain(target.kind === "process" || target.kind === "window" || target.kind === "browser-tab", "invalid_argument", "Unknown surface target kind.");
  if (target.processId !== undefined) assertFiniteBounded(target.processId, "processId", 1, 2 ** 31 - 1);
  if (target.bounds !== undefined) {
    assertFiniteBounded(target.bounds.x, "bounds.x", -1_000_000, 1_000_000);
    assertFiniteBounded(target.bounds.y, "bounds.y", -1_000_000, 1_000_000);
    assertFiniteBounded(target.bounds.width, "bounds.width", 1, 100_000);
    assertFiniteBounded(target.bounds.height, "bounds.height", 1, 100_000);
    assertFiniteBounded(target.bounds.scaleFactor, "bounds.scaleFactor", 0.1, 16);
  }
  return target.bounds === undefined
    ? Object.freeze({ ...target })
    : Object.freeze({ ...target, bounds: Object.freeze({ ...target.bounds }) });
}

function validateSession(session: SurfaceCaptureSession): SurfaceCaptureSession {
  assertDomain(session.schemaVersion === OMNIA_SURFACE_CAPTURE_SCHEMA_VERSION, "invalid_argument", "Unsupported surface capture session schema.");
  assertNonBlank(session.sessionId, "sessionId", 512);
  validateTarget(session.target);
  assertFiniteBounded(session.width, "capture width", 1, 100_000);
  assertFiniteBounded(session.height, "capture height", 1, 100_000);
  assertFiniteBounded(session.frameRate, "capture frame rate", 1, 240);
  assertIsoTimestamp(session.startedAt, "capture startedAt");
  if (session.stoppedAt !== undefined) assertIsoTimestamp(session.stoppedAt, "capture stoppedAt");
  return Object.freeze({ ...session, capabilities: Object.freeze([...session.capabilities]) });
}

function validateInput(event: SurfaceInputEvent): SurfaceInputEvent {
  if (event.kind === "pointer") {
    assertFiniteBounded(event.x, "pointer.x", -100_000, 100_000);
    assertFiniteBounded(event.y, "pointer.y", -100_000, 100_000);
    if (event.deltaX !== undefined) assertFiniteBounded(event.deltaX, "pointer.deltaX", -100_000, 100_000);
    if (event.deltaY !== undefined) assertFiniteBounded(event.deltaY, "pointer.deltaY", -100_000, 100_000);
    return event.modifiers === undefined
      ? Object.freeze({ ...event })
      : Object.freeze({ ...event, modifiers: Object.freeze([...event.modifiers]) });
  }
  assertNonBlank(event.code, "keyboard.code", 128);
  assertNonBlank(event.key, "keyboard.key", 256);
  if (event.text !== undefined) assertDomain(event.text.length <= 4_096, "invalid_argument", "keyboard.text cannot exceed 4096 characters.");
  return event.modifiers === undefined
    ? Object.freeze({ ...event })
    : Object.freeze({ ...event, modifiers: Object.freeze([...event.modifiers]) });
}

/**
 * Renderer-side adapter. It keeps only session/channel metadata and delegates
 * process capture and isolated input to an injected native port.
 */
export class OmniaSurfaceCaptureRuntime {
  private readonly port: SurfaceCapturePort;
  private readonly sessions = new Map<string, SurfaceCaptureSession>();
  private readonly channels = new Map<string, IsolatedInputChannel>();

  public constructor(options: OmniaSurfaceCaptureRuntimeOptions = {}) {
    this.port = options.port ?? {};
  }

  public inspect(sessionId: string): SurfaceCaptureSession | undefined {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : { ...session, target: { ...session.target } };
  }

  public list(): readonly SurfaceCaptureSession[] {
    return Object.freeze([...this.sessions.values()].map((session) => ({ ...session, target: { ...session.target } })));
  }

  public inspectInputChannel(channelId: string): IsolatedInputChannel | undefined {
    const channel = this.channels.get(channelId);
    return channel === undefined ? undefined : { ...channel };
  }

  public async inspectCapabilities(): Promise<SurfaceCaptureAvailability> {
    if (this.port.inspectCapabilities === undefined) return { status: "unavailable", reason: "Surface capture is not connected to a native host." };
    try {
      return await this.port.inspectCapabilities();
    } catch (error) {
      return { status: "unavailable", reason: error instanceof Error ? error.message : "Surface capability inspection failed." };
    }
  }

  public async listTargets(): Promise<SurfaceCaptureResult<readonly SurfaceCaptureTarget[]>> {
    if (this.port.listTargets === undefined) return unavailable("Target enumeration is not connected to a native host.");
    try {
      const result = await this.port.listTargets();
      return result.ok ? { ok: true, value: Object.freeze(result.value.map(validateTarget)) } : result;
    } catch (error) {
      return failure("native_error", error instanceof Error ? error.message : "Target enumeration failed.");
    }
  }

  public async open(input: OpenSurfaceCaptureInput): Promise<SurfaceCaptureResult<SurfaceCaptureSession>> {
    assertNonBlank(input.targetId, "targetId", 512);
    if (input.width !== undefined) assertFiniteBounded(input.width, "width", 1, 100_000);
    if (input.height !== undefined) assertFiniteBounded(input.height, "height", 1, 100_000);
    if (input.frameRate !== undefined) assertFiniteBounded(input.frameRate, "frameRate", 1, 240);
    if (this.port.open === undefined) return unavailable("Surface capture is not connected to a native host.");
    try {
      const result = await this.port.open(input);
      if (!result.ok) return result;
      const session = validateSession(result.value);
      this.sessions.set(session.sessionId, session);
      return { ok: true, value: session };
    } catch (error) {
      return failure("native_error", error instanceof Error ? error.message : "Surface capture failed to open.");
    }
  }

  public async close(sessionId: string): Promise<SurfaceCaptureResult<SurfaceCaptureSession>> {
    assertNonBlank(sessionId, "sessionId", 512);
    if (this.port.close === undefined) return unavailable("Surface capture close is not connected to a native host.");
    try {
      const result = await this.port.close(sessionId);
      if (!result.ok) return result;
      const session = validateSession(result.value);
      this.sessions.set(session.sessionId, session);
      return { ok: true, value: session };
    } catch (error) {
      return failure("native_error", error instanceof Error ? error.message : "Surface capture failed to close.");
    }
  }

  public async attachInput(sessionId: string): Promise<SurfaceCaptureResult<IsolatedInputChannel>> {
    assertNonBlank(sessionId, "sessionId", 512);
    if (this.port.attachInput === undefined) return unavailable("Isolated input is not connected to a native host.");
    try {
      const result = await this.port.attachInput(sessionId);
      if (!result.ok) return result;
      const channel = Object.freeze({ ...result.value, routing: "independent" as const });
      this.channels.set(channel.channelId, channel);
      return { ok: true, value: channel };
    } catch (error) {
      return failure("native_error", error instanceof Error ? error.message : "Isolated input failed to attach.");
    }
  }

  public async detachInput(channelId: string): Promise<SurfaceCaptureResult<null>> {
    assertNonBlank(channelId, "channelId", 512);
    if (this.port.detachInput === undefined) return unavailable("Isolated input detach is not connected to a native host.");
    try {
      const result = await this.port.detachInput(channelId);
      if (result.ok) this.channels.delete(channelId);
      return result;
    } catch (error) {
      return failure("native_error", error instanceof Error ? error.message : "Isolated input failed to detach.");
    }
  }

  public async sendInput(channelId: string, event: SurfaceInputEvent): Promise<SurfaceCaptureResult<null>> {
    assertNonBlank(channelId, "channelId", 512);
    const validated = validateInput(event);
    if (this.port.sendInput === undefined) return unavailable("Isolated input is not connected to a native host.");
    try {
      return await this.port.sendInput(channelId, validated);
    } catch (error) {
      return failure("native_error", error instanceof Error ? error.message : "Isolated input dispatch failed.");
    }
  }

  public async subscribeFrames(sessionId: string, listener: (frame: SurfaceCaptureFrame) => void): Promise<() => void | Promise<void>> {
    assertNonBlank(sessionId, "sessionId", 512);
    if (this.port.subscribeFrames === undefined) throw new Error("Surface frame streaming is not connected to a native host.");
    return this.port.subscribeFrames(sessionId, listener);
  }
}

export function createOmniaSurfaceCaptureRuntime(options: OmniaSurfaceCaptureRuntimeOptions = {}): OmniaSurfaceCaptureRuntime {
  return new OmniaSurfaceCaptureRuntime(options);
}

/** Browser preview must stay explicit: it cannot capture arbitrary processes or inject OS input. */
export function createBrowserPreviewSurfaceCapturePort(): SurfaceCapturePort {
  const unavailableResult = <T,>(reason: string): Promise<SurfaceCaptureResult<T>> => Promise.resolve(unavailable(reason));
  return {
    inspectCapabilities: async () => ({ status: "unavailable", reason: "Browser preview cannot capture arbitrary desktop processes or provide isolated OS input." }),
    listTargets: () => unavailableResult("Browser preview cannot enumerate desktop processes or windows."),
    open: () => unavailableResult("Browser preview cannot capture an arbitrary process or window."),
    close: () => unavailableResult("Browser preview has no native capture session."),
    attachInput: () => unavailableResult("Browser preview cannot provide independent mouse or keyboard input."),
    detachInput: () => unavailableResult("Browser preview has no isolated input channel."),
    sendInput: () => unavailableResult("Browser preview cannot dispatch isolated input."),
  };
}
