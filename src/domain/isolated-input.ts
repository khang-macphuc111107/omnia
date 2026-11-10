import { assertDomain } from "./errors";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  type IsoTimestamp,
} from "./shared";

/**
 * Renderer-safe contract for a target-scoped input channel.
 *
 * The channel is deliberately separate from the host pointer and keyboard:
 * native owns the target handle, capture surface and routing.  The renderer
 * can describe intent and display state, but it cannot provide a raw HWND,
 * process handle, global key hook or desktop coordinate.
 */
export type IsolatedInputTargetKind =
  | "window"
  | "process"
  | "browser-tab"
  | "webview"
  | "terminal";

export type IsolatedInputAttachmentMode = "headless" | "unfocused" | "visible";
export type IsolatedInputFocusPolicy = "never-steal" | "target-only";
export type IsolatedInputSessionState =
  | "requested"
  | "active"
  | "paused"
  | "closing"
  | "closed"
  | "failed";

export type IsolatedInputCoordinateSpace = "target-pixels" | "normalized";
export type IsolatedInputPointerButton = "left" | "right" | "middle" | "back" | "forward";
export type IsolatedInputCursorStyle = "none" | "arrow" | "highlighted";
export type IsolatedInputPixelFormat = "bgra8" | "rgba8";
export type IsolatedInputModifier = "alt" | "ctrl" | "meta" | "shift" | "alt-graph";

export interface IsolatedInputTarget {
  readonly kind: IsolatedInputTargetKind;
  /** Opaque native-owned target identity; never an OS handle or raw PID. */
  readonly targetId: string;
  readonly displayName: string;
  readonly processName?: string;
  readonly browserAttachmentId?: string;
}

export interface IsolatedInputCaptureConfig {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly includeCursor: boolean;
  readonly cursorStyle: IsolatedInputCursorStyle;
  readonly pixelFormat: IsolatedInputPixelFormat;
  readonly maxBufferBytes: number;
}

export interface IsolatedInputCapabilities {
  readonly captureFrames: boolean;
  readonly captureCursor: boolean;
  readonly pointer: boolean;
  readonly keyboard: boolean;
  readonly textInput: boolean;
  readonly wheel: boolean;
  readonly hotkeys: boolean;
}

export interface IsolatedInputSession {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly profileId: string;
  readonly target: IsolatedInputTarget;
  readonly attachmentMode: IsolatedInputAttachmentMode;
  readonly focusPolicy: IsolatedInputFocusPolicy;
  readonly route: "target-scoped";
  readonly capabilities: IsolatedInputCapabilities;
  readonly capture: IsolatedInputCaptureConfig;
  /** The UI must show this disclosure while the channel is active. */
  readonly visibleDisclosure: true;
  readonly state: IsolatedInputSessionState;
  readonly inputEpoch: string;
  readonly lastSequence: number;
  readonly maxEventsPerSecond: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface CreateIsolatedInputSessionInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly profileId: string;
  readonly target: IsolatedInputTarget;
  readonly attachmentMode: IsolatedInputAttachmentMode;
  readonly focusPolicy: IsolatedInputFocusPolicy;
  readonly capabilities: IsolatedInputCapabilities;
  readonly capture: IsolatedInputCaptureConfig;
  readonly inputEpoch: string;
  readonly maxEventsPerSecond: number;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export type IsolatedInputTransition =
  | "activate"
  | "pause"
  | "resume"
  | "begin-close"
  | "close"
  | "fail";

export interface IsolatedInputPointerMove {
  readonly kind: "pointer-move";
  readonly x: number;
  readonly y: number;
  readonly coordinateSpace: IsolatedInputCoordinateSpace;
  readonly buttons: readonly IsolatedInputPointerButton[];
}

export interface IsolatedInputPointerButtonEvent {
  readonly kind: "pointer-button";
  readonly button: IsolatedInputPointerButton;
  readonly action: "down" | "up";
  readonly x: number;
  readonly y: number;
  readonly coordinateSpace: IsolatedInputCoordinateSpace;
}

export interface IsolatedInputWheelEvent {
  readonly kind: "wheel";
  readonly deltaX: number;
  readonly deltaY: number;
  readonly x: number;
  readonly y: number;
  readonly coordinateSpace: IsolatedInputCoordinateSpace;
}

export interface IsolatedInputKeyEvent {
  readonly kind: "key";
  readonly action: "down" | "up";
  readonly code: string;
  readonly key: string;
  readonly modifiers: readonly IsolatedInputModifier[];
  readonly repeat: boolean;
}

export interface IsolatedInputTextEvent {
  readonly kind: "text";
  readonly text: string;
}

export type IsolatedInputEventBody =
  | IsolatedInputPointerMove
  | IsolatedInputPointerButtonEvent
  | IsolatedInputWheelEvent
  | IsolatedInputKeyEvent
  | IsolatedInputTextEvent;

export interface IsolatedInputEventEnvelope {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly inputEpoch: string;
  readonly sequence: number;
  readonly sentAt: IsoTimestamp;
  readonly body: IsolatedInputEventBody;
}

const TARGET_KINDS: ReadonlySet<IsolatedInputTargetKind> = new Set([
  "window",
  "process",
  "browser-tab",
  "webview",
  "terminal",
]);
const ATTACHMENT_MODES: ReadonlySet<IsolatedInputAttachmentMode> = new Set([
  "headless",
  "unfocused",
  "visible",
]);
const SESSION_STATES: ReadonlySet<IsolatedInputSessionState> = new Set([
  "requested",
  "active",
  "paused",
  "closing",
  "closed",
  "failed",
]);
const POINTER_BUTTONS: ReadonlySet<IsolatedInputPointerButton> = new Set([
  "left",
  "right",
  "middle",
  "back",
  "forward",
]);
const MODIFIERS: ReadonlySet<IsolatedInputModifier> = new Set([
  "alt",
  "ctrl",
  "meta",
  "shift",
  "alt-graph",
]);
const MAX_TARGET_TEXT = 256;
const MAX_EPOCH_TEXT = 256;
const MAX_EVENTS_PER_SECOND = 10_000;
const MAX_FRAME_RATE = 120;
const MAX_DIMENSION = 16_384;
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_EVENT_BYTES = 16 * 1024;

function assertBoolean(value: boolean, label: string): boolean {
  assertDomain(typeof value === "boolean", "invalid_argument", `${label} must be a boolean.`, { label });
  return value;
}

function normalizeTarget(target: IsolatedInputTarget): IsolatedInputTarget {
  assertDomain(TARGET_KINDS.has(target.kind), "invalid_argument", "Unknown isolated input target kind.");
  assertNonBlank(target.targetId, "isolated input target ID", MAX_TARGET_TEXT);
  assertNonBlank(target.displayName, "isolated input target display name", MAX_TARGET_TEXT);
  if (target.processName !== undefined) assertNonBlank(target.processName, "isolated input process name", MAX_TARGET_TEXT);
  if (target.browserAttachmentId !== undefined) {
    assertNonBlank(target.browserAttachmentId, "isolated input browser attachment ID", MAX_TARGET_TEXT);
  }
  if (target.kind === "browser-tab") {
    assertDomain(target.browserAttachmentId !== undefined, "invalid_argument", "Browser-tab targets require an attachment ID.");
  }
  return Object.freeze({
    ...target,
    targetId: target.targetId.trim(),
    displayName: target.displayName.trim(),
    ...(target.processName === undefined ? {} : { processName: target.processName.trim() }),
    ...(target.browserAttachmentId === undefined ? {} : { browserAttachmentId: target.browserAttachmentId.trim() }),
  });
}

function normalizeCapture(capture: IsolatedInputCaptureConfig): IsolatedInputCaptureConfig {
  assertIntegerInRange(capture.width, "capture width", 1, MAX_DIMENSION);
  assertIntegerInRange(capture.height, "capture height", 1, MAX_DIMENSION);
  assertIntegerInRange(capture.frameRate, "capture frame rate", 1, MAX_FRAME_RATE);
  assertIntegerInRange(capture.maxBufferBytes, "capture max buffer bytes", 1, MAX_BUFFER_BYTES);
  assertDomain(capture.cursorStyle === "none" || capture.cursorStyle === "arrow" || capture.cursorStyle === "highlighted", "invalid_argument", "Unknown isolated cursor style.");
  assertDomain(capture.pixelFormat === "bgra8" || capture.pixelFormat === "rgba8", "invalid_argument", "Unknown isolated pixel format.");
  assertBoolean(capture.includeCursor, "capture includeCursor");
  assertDomain(!capture.includeCursor || capture.cursorStyle !== "none", "invalid_argument", "A captured cursor requires a visible cursor style.");
  return Object.freeze({ ...capture });
}

function normalizeCapabilities(capabilities: IsolatedInputCapabilities): IsolatedInputCapabilities {
  const normalized = Object.freeze({
    captureFrames: assertBoolean(capabilities.captureFrames, "captureFrames"),
    captureCursor: assertBoolean(capabilities.captureCursor, "captureCursor"),
    pointer: assertBoolean(capabilities.pointer, "pointer"),
    keyboard: assertBoolean(capabilities.keyboard, "keyboard"),
    textInput: assertBoolean(capabilities.textInput, "textInput"),
    wheel: assertBoolean(capabilities.wheel, "wheel"),
    hotkeys: assertBoolean(capabilities.hotkeys, "hotkeys"),
  });
  assertDomain(!normalized.captureCursor || normalized.captureFrames, "invalid_argument", "Cursor capture requires frame capture.");
  assertDomain(!normalized.textInput || normalized.keyboard, "invalid_argument", "Text input requires keyboard capability.");
  assertDomain(!normalized.hotkeys || normalized.keyboard, "invalid_argument", "Hotkeys require keyboard capability.");
  return normalized;
}

function assertSessionTimestampOrder(session: IsolatedInputSession, now: IsoTimestamp): void {
  assertIsoTimestamp(now, "isolated input transition time");
  assertDomain(Date.parse(now) >= Date.parse(session.updatedAt), "invalid_argument", "Isolated input timestamps cannot move backwards.");
}

export function createIsolatedInputSession(input: CreateIsolatedInputSessionInput): IsolatedInputSession {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported isolated input session schema.");
  assertDomain(ATTACHMENT_MODES.has(input.attachmentMode), "invalid_argument", "Unknown isolated input attachment mode.");
  assertDomain(input.focusPolicy === "never-steal" || input.focusPolicy === "target-only", "invalid_argument", "Unknown isolated input focus policy.");
  assertDomain(input.focusPolicy === "never-steal", "permission_denied", "An isolated input session cannot steal host focus.");
  assertIsoTimestamp(input.createdAt, "isolated input creation time");
  assertIsoTimestamp(input.expiresAt, "isolated input expiry time");
  assertDomain(Date.parse(input.expiresAt) > Date.parse(input.createdAt), "invalid_argument", "Isolated input expiry must be after creation.");
  assertIntegerInRange(input.maxEventsPerSecond, "max isolated input events per second", 1, MAX_EVENTS_PER_SECOND);
  const session: IsolatedInputSession = {
    schemaVersion: 1,
    id: assertNonBlank(input.id, "isolated input session ID", MAX_TARGET_TEXT),
    profileId: assertNonBlank(input.profileId, "isolated input profile ID", MAX_TARGET_TEXT),
    target: normalizeTarget(input.target),
    attachmentMode: input.attachmentMode,
    focusPolicy: "never-steal",
    route: "target-scoped",
    capabilities: normalizeCapabilities(input.capabilities),
    capture: normalizeCapture(input.capture),
    visibleDisclosure: true,
    state: "requested",
    inputEpoch: assertNonBlank(input.inputEpoch, "isolated input epoch", MAX_EPOCH_TEXT),
    lastSequence: 0,
    maxEventsPerSecond: input.maxEventsPerSecond,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  return Object.freeze(session);
}

export function transitionIsolatedInputSession(
  session: IsolatedInputSession,
  transition: IsolatedInputTransition,
  now: IsoTimestamp,
): IsolatedInputSession {
  assertDomain(SESSION_STATES.has(session.state), "invalid_argument", "Unknown isolated input session state.");
  assertSessionTimestampOrder(session, now);
  const nextState: IsolatedInputSessionState =
    transition === "activate" ? "active" :
      transition === "pause" ? "paused" :
        transition === "resume" ? "active" :
          transition === "begin-close" ? "closing" :
            transition === "close" ? "closed" : "failed";
  const allowed =
    (transition === "activate" && session.state === "requested") ||
    (transition === "pause" && session.state === "active") ||
    (transition === "resume" && session.state === "paused") ||
    (transition === "begin-close" && (session.state === "active" || session.state === "paused")) ||
    (transition === "close" && (session.state === "closing" || session.state === "failed")) ||
    (transition === "fail" && session.state !== "closed");
  assertDomain(allowed, "invalid_state_transition", `Cannot ${transition} isolated input session from ${session.state}.`);
  return Object.freeze({ ...session, state: nextState, updatedAt: now });
}

function normalizeModifiers(modifiers: readonly IsolatedInputModifier[]): readonly IsolatedInputModifier[] {
  const normalized = modifiers.map((modifier) => {
    assertDomain(MODIFIERS.has(modifier), "invalid_argument", "Unknown isolated input modifier.");
    return modifier;
  });
  assertDomain(new Set(normalized).size === normalized.length, "invalid_argument", "Isolated input modifiers must be unique.");
  return Object.freeze(normalized);
}

function normalizeButtons(buttons: readonly IsolatedInputPointerButton[]): readonly IsolatedInputPointerButton[] {
  const normalized = buttons.map((button) => {
    assertDomain(POINTER_BUTTONS.has(button), "invalid_argument", "Unknown isolated pointer button.");
    return button;
  });
  assertDomain(new Set(normalized).size === normalized.length, "invalid_argument", "Isolated pointer buttons must be unique.");
  return Object.freeze(normalized);
}

function normalizeCoordinateSpace(value: IsolatedInputCoordinateSpace): IsolatedInputCoordinateSpace {
  assertDomain(value === "target-pixels" || value === "normalized", "invalid_argument", "Unknown isolated coordinate space.");
  return value;
}

function normalizeCoordinate(value: number, label: string, coordinateSpace: IsolatedInputCoordinateSpace): number {
  const maximum = coordinateSpace === "normalized" ? 1 : MAX_DIMENSION;
  return assertIntegerInRange(value, label, coordinateSpace === "normalized" ? 0 : -1, maximum);
}

function normalizeText(value: string): string {
  const normalized = value.normalize("NFC");
  assertDomain(normalized.length > 0, "invalid_argument", "Isolated text input cannot be empty.");
  assertDomain(new TextEncoder().encode(normalized).byteLength <= MAX_TEXT_EVENT_BYTES, "invalid_argument", "Isolated text input is too large.");
  return normalized;
}

export function createIsolatedInputEvent(
  session: IsolatedInputSession,
  sequence: number,
  sentAt: IsoTimestamp,
  body: IsolatedInputEventBody,
): IsolatedInputEventEnvelope {
  assertDomain(session.state === "active", "invalid_state_transition", "Input can only be sent to an active isolated session.");
  assertIntegerInRange(sequence, "isolated input sequence", session.lastSequence + 1, Number.MAX_SAFE_INTEGER);
  assertIsoTimestamp(sentAt, "isolated input event time");
  assertDomain(Date.parse(sentAt) >= Date.parse(session.updatedAt), "invalid_argument", "Input event cannot predate the session state.");
  let normalizedBody: IsolatedInputEventBody;
  if (body.kind === "pointer-move") {
    assertDomain(session.capabilities.pointer, "unsupported_capability", "Pointer input is unavailable for this session.");
    const coordinateSpace = normalizeCoordinateSpace(body.coordinateSpace);
    normalizedBody = Object.freeze({
      ...body,
      x: normalizeCoordinate(body.x, "pointer x", coordinateSpace),
      y: normalizeCoordinate(body.y, "pointer y", coordinateSpace),
      coordinateSpace,
      buttons: normalizeButtons(body.buttons),
    });
  } else if (body.kind === "pointer-button") {
    assertDomain(session.capabilities.pointer, "unsupported_capability", "Pointer input is unavailable for this session.");
    const coordinateSpace = normalizeCoordinateSpace(body.coordinateSpace);
    assertDomain(POINTER_BUTTONS.has(body.button), "invalid_argument", "Unknown isolated pointer button.");
    normalizedBody = Object.freeze({
      ...body,
      x: normalizeCoordinate(body.x, "pointer x", coordinateSpace),
      y: normalizeCoordinate(body.y, "pointer y", coordinateSpace),
      coordinateSpace,
    });
  } else if (body.kind === "wheel") {
    assertDomain(session.capabilities.wheel, "unsupported_capability", "Wheel input is unavailable for this session.");
    const coordinateSpace = normalizeCoordinateSpace(body.coordinateSpace);
    assertIntegerInRange(body.deltaX, "wheel deltaX", -100_000, 100_000);
    assertIntegerInRange(body.deltaY, "wheel deltaY", -100_000, 100_000);
    normalizedBody = Object.freeze({
      ...body,
      deltaX: body.deltaX,
      deltaY: body.deltaY,
      x: normalizeCoordinate(body.x, "wheel x", coordinateSpace),
      y: normalizeCoordinate(body.y, "wheel y", coordinateSpace),
      coordinateSpace,
    });
  } else if (body.kind === "key") {
    assertDomain(session.capabilities.keyboard, "unsupported_capability", "Keyboard input is unavailable for this session.");
    assertDomain(body.action === "down" || body.action === "up", "invalid_argument", "Unknown isolated key action.");
    assertNonBlank(body.code, "isolated key code", 64);
    assertNonBlank(body.key, "isolated key value", 64);
    normalizedBody = Object.freeze({
      ...body,
      code: body.code.trim(),
      key: body.key.trim(),
      modifiers: normalizeModifiers(body.modifiers),
      repeat: assertBoolean(body.repeat, "isolated key repeat"),
    });
  } else {
    assertDomain(session.capabilities.textInput, "unsupported_capability", "Text input is unavailable for this session.");
    normalizedBody = Object.freeze({ ...body, text: normalizeText(body.text) });
  }
  return Object.freeze({ schemaVersion: 1, sessionId: session.id, inputEpoch: session.inputEpoch, sequence, sentAt, body: normalizedBody });
}

export function acceptIsolatedInputEvent(
  session: IsolatedInputSession,
  event: IsolatedInputEventEnvelope,
): IsolatedInputSession {
  assertDomain(event.schemaVersion === 1, "invalid_argument", "Unsupported isolated input event schema.");
  assertDomain(event.sessionId === session.id && event.inputEpoch === session.inputEpoch, "conflict", "Isolated input event belongs to a different session epoch.");
  assertIntegerInRange(event.sequence, "isolated input sequence", session.lastSequence + 1, Number.MAX_SAFE_INTEGER);
  assertIsoTimestamp(event.sentAt, "isolated input event time");
  return Object.freeze({ ...session, lastSequence: event.sequence, updatedAt: event.sentAt });
}

