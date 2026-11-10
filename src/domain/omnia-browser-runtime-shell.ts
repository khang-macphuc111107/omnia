import { assertDomain } from "./errors";
import { assertIntegerInRange, assertIsoTimestamp, assertNonBlank, assertSha256, type IsoTimestamp } from "./shared";

/**
 * Native-owned browser/process automation contract.
 *
 * This module deliberately describes an authorized target channel rather than
 * exposing raw window handles, cookies, request headers, URLs, or debugging
 * sockets to the renderer. A native implementation may attach a target and
 * provide a separate pointer/keyboard channel, while a browser preview can
 * truthfully report the capability as unavailable.
 */

export type BrowserRuntimeShellTargetKind = "browser-tab" | "desktop-window" | "desktop-process";
export type BrowserRuntimeShellExecutionMode = "visible" | "headless";
export type BrowserRuntimeShellSessionState =
  | "requested"
  | "attached"
  | "running"
  | "paused"
  | "detached"
  | "failed";
export type BrowserRuntimeShellInputChannelState = "requested" | "ready" | "unavailable" | "revoked";
export type BrowserRuntimeShellCapability =
  | "surface-capture"
  | "independent-pointer"
  | "independent-keyboard"
  | "request-metadata"
  | "response-body-stream"
  | "resumable-downloads";

export type BrowserRuntimeShellRightsBasis =
  | "publicly-available"
  | "user-owned"
  | "licensed-access"
  | "organization-authorized"
  | "other-explicit-authorization";

export interface BrowserRuntimeShellAuthorization {
  readonly id: string;
  readonly rightsBasis: BrowserRuntimeShellRightsBasis;
  readonly acknowledgedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly policyVersion: string;
  readonly userPresence: "explicit-session-confirmation";
  readonly credentialsRemainInTarget: true;
  readonly challengeBypassExcluded: true;
  readonly hiddenEndpointMutationExcluded: true;
}

export interface BrowserRuntimeShellTarget {
  readonly kind: BrowserRuntimeShellTargetKind;
  /** Opaque native broker handle. Raw HWND/debugging handles never cross IPC. */
  readonly targetHandleId: string;
  readonly displayName: string;
  readonly browserChannel?: "edge-canary";
  readonly tabTargetId?: string;
  readonly processId?: number;
  readonly origin?: string;
}

export interface BrowserRuntimeSurfaceSpec {
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: "rgba8" | "bgra8" | "png" | "jpeg" | "webp";
  readonly framesPerSecond: number;
  readonly includeCursor: boolean;
  readonly includeAudio: boolean;
}

export interface BrowserRuntimeInputChannel {
  readonly id: string;
  readonly state: BrowserRuntimeShellInputChannelState;
  readonly targetSessionId: string;
  readonly isolation: "target-only";
  readonly focusPolicy: "unfocused-when-supported" | "visible-focus-required";
  readonly pointer: boolean;
  readonly keyboard: boolean;
  readonly automationDisclosure: "always-visible-indicator";
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
  readonly unavailableReason?: string;
}

export interface BrowserRuntimeShellSession {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly target: BrowserRuntimeShellTarget;
  readonly executionMode: BrowserRuntimeShellExecutionMode;
  readonly state: BrowserRuntimeShellSessionState;
  readonly authorization: BrowserRuntimeShellAuthorization;
  readonly requestedCapabilities: readonly BrowserRuntimeShellCapability[];
  readonly grantedCapabilities: readonly BrowserRuntimeShellCapability[];
  readonly surface: BrowserRuntimeSurfaceSpec;
  readonly inputChannel?: BrowserRuntimeInputChannel;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly detachedAt?: IsoTimestamp;
  readonly failureReason?: string;
}

export interface CreateBrowserRuntimeShellSessionInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly target: BrowserRuntimeShellTarget;
  readonly executionMode: BrowserRuntimeShellExecutionMode;
  readonly authorization: BrowserRuntimeShellAuthorization;
  readonly requestedCapabilities: readonly BrowserRuntimeShellCapability[];
  readonly grantedCapabilities: readonly BrowserRuntimeShellCapability[];
  readonly surface: BrowserRuntimeSurfaceSpec;
  readonly inputChannel?: BrowserRuntimeInputChannel;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export type BrowserRuntimeShellSessionTransition =
  | { readonly to: "attached"; readonly at: IsoTimestamp }
  | { readonly to: "running"; readonly at: IsoTimestamp }
  | { readonly to: "paused"; readonly at: IsoTimestamp }
  | { readonly to: "detached"; readonly at: IsoTimestamp }
  | { readonly to: "failed"; readonly at: IsoTimestamp; readonly reason: string };

export interface BrowserRuntimePointerAction {
  readonly kind: "move" | "button" | "wheel";
  readonly x: number;
  readonly y: number;
  readonly button?: "left" | "middle" | "right" | "back" | "forward";
  readonly pressed?: boolean;
  readonly deltaX?: number;
  readonly deltaY?: number;
}

export interface BrowserRuntimeKeyboardAction {
  readonly kind: "key-down" | "key-up" | "text";
  readonly code?: string;
  readonly text?: string;
  readonly modifiers?: readonly ("ctrl" | "alt" | "shift" | "meta")[];
}

export type BrowserRuntimeInputAction =
  | { readonly type: "pointer"; readonly action: BrowserRuntimePointerAction }
  | { readonly type: "keyboard"; readonly action: BrowserRuntimeKeyboardAction };

export interface BrowserRuntimeInputBatch {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly targetSessionId: string;
  readonly channelId: string;
  readonly sequence: number;
  readonly actions: readonly BrowserRuntimeInputAction[];
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly disclosure: "target-input-indicator-visible";
}

export type BrowserRuntimeObservedMethod = "GET" | "HEAD";
export type BrowserRuntimeObservedDirection = "request" | "response";

export interface BrowserRuntimeRequestObservation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly targetSessionId: string;
  readonly observedAt: IsoTimestamp;
  readonly direction: BrowserRuntimeObservedDirection;
  readonly method: BrowserRuntimeObservedMethod;
  /** Origin only; raw URL, query, cookies, and authorization headers are excluded. */
  readonly origin: string;
  readonly responseStatus?: 200 | 206 | 304;
  readonly mediaType?: string;
  readonly expectedBytes?: number;
  readonly contentRange?: { readonly start: number; readonly endInclusive: number; readonly total: number };
  readonly requestIdentitySha256: string;
  readonly metadataSha256: string;
  readonly responseBodyHandleId?: string;
  readonly bodyRetention: "broker-only";
}

export type BrowserRuntimeDownloadAssembly = "single-response" | "byte-range" | "segmented-media";
export type BrowserRuntimeDownloadState = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface BrowserRuntimeDownloadJob {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly targetSessionId: string;
  readonly assembly: BrowserRuntimeDownloadAssembly;
  readonly sourceObservationIds: readonly string[];
  readonly outputFilename: string;
  readonly outputMediaType: string;
  readonly state: BrowserRuntimeDownloadState;
  readonly progress: number;
  readonly downloadedBytes: number;
  readonly expectedBytes?: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly outputContentSha256?: string;
  readonly outputBlobId?: string;
  readonly failureReason?: string;
}

export interface CreateBrowserRuntimeDownloadJobInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly targetSessionId: string;
  readonly assembly: BrowserRuntimeDownloadAssembly;
  readonly sourceObservationIds: readonly string[];
  readonly outputFilename: string;
  readonly outputMediaType: string;
  readonly expectedBytes?: number;
  readonly createdAt: IsoTimestamp;
}

export type BrowserRuntimeDownloadTransition =
  | { readonly to: "running"; readonly at: IsoTimestamp; readonly downloadedBytes?: number }
  | { readonly to: "paused"; readonly at: IsoTimestamp; readonly downloadedBytes?: number }
  | { readonly to: "completed"; readonly at: IsoTimestamp; readonly downloadedBytes: number; readonly outputContentSha256: string; readonly outputBlobId: string }
  | { readonly to: "failed"; readonly at: IsoTimestamp; readonly reason: string; readonly downloadedBytes?: number }
  | { readonly to: "cancelled"; readonly at: IsoTimestamp; readonly reason: string };

export interface BrowserRuntimeShellCapabilityReport {
  readonly capability: BrowserRuntimeShellCapability;
  readonly supported: boolean;
  readonly reason?: string;
}

export interface BrowserRuntimeShellPort {
  readonly kind: "native" | "browser-preview";
  readonly capabilities: readonly BrowserRuntimeShellCapabilityReport[];
}

const CAPABILITIES: readonly BrowserRuntimeShellCapability[] = [
  "surface-capture",
  "independent-pointer",
  "independent-keyboard",
  "request-metadata",
  "response-body-stream",
  "resumable-downloads",
];
const RIGHTS_BASES: ReadonlySet<BrowserRuntimeShellRightsBasis> = new Set([
  "publicly-available",
  "user-owned",
  "licensed-access",
  "organization-authorized",
  "other-explicit-authorization",
]);
const MAX_INPUT_ACTIONS = 256;
const MAX_INPUT_TEXT = 8_192;
const MAX_SURFACE_WIDTH = 16_384;
const MAX_SURFACE_HEIGHT = 16_384;
const MAX_FPS = 120;
const MAX_DOWNLOAD_BYTES = 64 * 1024 ** 3;
const FORBIDDEN_KEYS = /^(?:url|uri|headers?|cookies?|authorization|bearer|password|token|signed_?url|debug_?socket|script|javascript)$/i;
const SURFACE_PIXEL_FORMATS: ReadonlySet<BrowserRuntimeSurfaceSpec["pixelFormat"]> = new Set([
  "rgba8",
  "bgra8",
  "png",
  "jpeg",
  "webp",
]);
const INPUT_CHANNEL_STATES: ReadonlySet<BrowserRuntimeShellInputChannelState> = new Set([
  "requested",
  "ready",
  "unavailable",
  "revoked",
]);
const INPUT_FOCUS_POLICIES: ReadonlySet<BrowserRuntimeInputChannel["focusPolicy"]> = new Set([
  "unfocused-when-supported",
  "visible-focus-required",
]);
const POINTER_KINDS: ReadonlySet<BrowserRuntimePointerAction["kind"]> = new Set(["move", "button", "wheel"]);
const POINTER_BUTTONS: ReadonlySet<NonNullable<BrowserRuntimePointerAction["button"]>> = new Set([
  "left",
  "middle",
  "right",
  "back",
  "forward",
]);
const KEYBOARD_KINDS: ReadonlySet<BrowserRuntimeKeyboardAction["kind"]> = new Set(["key-down", "key-up", "text"]);
const KEYBOARD_MODIFIERS: ReadonlySet<NonNullable<BrowserRuntimeKeyboardAction["modifiers"]>[number]> = new Set([
  "ctrl",
  "alt",
  "shift",
  "meta",
]);

function assertNoRawTransportMaterial(value: unknown, path = "browser runtime input"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawTransportMaterial(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    // The typed authorization object is a policy receipt, not an HTTP
    // authorization header. Its nested values are validated below.
    const allowedAuthorizationField = path === "browser runtime input" && key === "authorization";
    assertDomain(
      allowedAuthorizationField || !FORBIDDEN_KEYS.test(key),
      "permission_denied",
      "Browser runtime contracts cannot contain raw transport credentials, URLs, scripts, or debugging material.",
      { path: `${path}.${key}` },
    );
    assertNoRawTransportMaterial(entry, `${path}.${key}`);
  }
}

function uniqueValues<T extends string>(values: readonly T[], label: string): readonly T[] {
  assertDomain(new Set(values).size === values.length, "conflict", `${label} must not contain duplicates.`);
  return Object.freeze([...values]);
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    assertDomain(false, "invalid_argument", "Browser runtime origin must be an absolute HTTPS origin.");
  }
  assertDomain(
    parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" &&
      (parsed.pathname === "" || parsed.pathname === "/") && parsed.search === "" && parsed.hash === "",
    "invalid_argument",
    "Browser runtime origin must contain only an HTTPS scheme, host, and optional port.",
  );
  return parsed.origin;
}

function normalizeMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertDomain(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized), "invalid_argument", "Download media type must be canonical.");
  return normalized;
}

function normalizeDownloadFilename(value: string): string {
  const filename = assertNonBlank(value, "download output filename", 512);
  assertDomain(filename !== "." && filename !== ".." && !/[\\/:]/.test(filename), "invalid_argument", "Download output filename must be a plain filename without path separators.");
  return filename;
}

function assertTimeOrder(earlier: IsoTimestamp, later: IsoTimestamp, earlierLabel: string, laterLabel: string): void {
  assertIsoTimestamp(earlier, earlierLabel);
  assertIsoTimestamp(later, laterLabel);
  assertDomain(Date.parse(later) > Date.parse(earlier), "invalid_argument", `${laterLabel} must be later than ${earlierLabel}.`);
}

function normalizeSurface(surface: BrowserRuntimeSurfaceSpec): BrowserRuntimeSurfaceSpec {
  const width = assertIntegerInRange(surface.width, "surface width", 1, MAX_SURFACE_WIDTH);
  const height = assertIntegerInRange(surface.height, "surface height", 1, MAX_SURFACE_HEIGHT);
  const framesPerSecond = assertIntegerInRange(surface.framesPerSecond, "surface frame rate", 1, MAX_FPS);
  assertDomain(SURFACE_PIXEL_FORMATS.has(surface.pixelFormat), "invalid_argument", "Unknown browser runtime surface pixel format.");
  assertDomain(typeof surface.includeCursor === "boolean", "invalid_argument", "Surface cursor inclusion must be boolean.");
  assertDomain(typeof surface.includeAudio === "boolean", "invalid_argument", "Surface audio inclusion must be boolean.");
  return Object.freeze({ ...surface, width, height, framesPerSecond });
}

function normalizeAuthorization(input: BrowserRuntimeShellAuthorization): BrowserRuntimeShellAuthorization {
  assertIsoTimestamp(input.acknowledgedAt, "runtime authorization acknowledgement time");
  assertTimeOrder(input.acknowledgedAt, input.expiresAt, "runtime authorization acknowledgement time", "runtime authorization expiry");
  assertDomain(RIGHTS_BASES.has(input.rightsBasis), "invalid_argument", "Unknown browser runtime rights basis.");
  assertDomain(
    input.userPresence === "explicit-session-confirmation" &&
      input.credentialsRemainInTarget === true &&
      input.challengeBypassExcluded === true &&
      input.hiddenEndpointMutationExcluded === true,
    "permission_denied",
    "Browser runtime authorization must be explicit, target-contained, and fail closed for bypass/mutation.",
  );
  return Object.freeze({
    ...input,
    id: assertNonBlank(input.id, "runtime authorization ID", 256),
    policyVersion: assertNonBlank(input.policyVersion, "runtime policy version", 128),
  });
}

function normalizeTarget(input: BrowserRuntimeShellTarget): BrowserRuntimeShellTarget {
  assertDomain(
    input.kind === "browser-tab" || input.kind === "desktop-window" || input.kind === "desktop-process",
    "invalid_argument",
    "Unknown browser runtime target kind.",
  );
  const targetHandleId = assertNonBlank(input.targetHandleId, "runtime target handle ID", 256);
  const displayName = assertNonBlank(input.displayName, "runtime target display name", 512);
  if (input.kind === "browser-tab") {
    assertDomain(input.browserChannel === "edge-canary", "unsupported_capability", "Browser tab runtime requires the visible Edge Canary broker.");
    const tabTargetId = assertNonBlank(input.tabTargetId ?? "", "browser tab target ID", 256);
    if (input.origin !== undefined) normalizeOrigin(input.origin);
    return Object.freeze({
      ...input,
      targetHandleId,
      displayName,
      tabTargetId,
      ...(input.origin === undefined ? {} : { origin: normalizeOrigin(input.origin) }),
    });
  }
  if (input.kind === "desktop-process") {
    assertDomain(input.processId !== undefined, "invalid_argument", "Desktop process targets require a process ID.");
    assertIntegerInRange(input.processId, "desktop process ID", 1, 0x7fff_ffff);
  }
  if (input.kind === "desktop-window") {
    assertDomain(input.origin === undefined || input.origin.length > 0, "invalid_argument", "Window origin cannot be blank.");
  }
  return Object.freeze({
    ...input,
    targetHandleId,
    displayName,
    ...(input.tabTargetId === undefined ? {} : { tabTargetId: assertNonBlank(input.tabTargetId, "browser tab target ID", 256) }),
    ...(input.origin === undefined ? {} : { origin: normalizeOrigin(input.origin) }),
  });
}

function normalizeCapabilitySet(values: readonly BrowserRuntimeShellCapability[], label: string): readonly BrowserRuntimeShellCapability[] {
  assertDomain(values.every((value) => CAPABILITIES.includes(value)), "invalid_argument", `${label} contains an unknown capability.`);
  return uniqueValues(values, label);
}

function validateInputChannel(
  channel: BrowserRuntimeInputChannel,
  sessionId: string,
  sessionCreatedAt: IsoTimestamp,
  sessionExpiresAt: IsoTimestamp,
  surface: BrowserRuntimeSurfaceSpec,
): BrowserRuntimeInputChannel {
  assertDomain(INPUT_CHANNEL_STATES.has(channel.state), "invalid_argument", "Unknown isolated input channel state.");
  assertDomain(INPUT_FOCUS_POLICIES.has(channel.focusPolicy), "invalid_argument", "Unknown isolated input focus policy.");
  assertDomain(typeof channel.pointer === "boolean" && typeof channel.keyboard === "boolean", "invalid_argument", "Input channel pointer and keyboard capabilities must be boolean.");
  assertDomain(channel.targetSessionId === sessionId, "scope_violation", "Input channel is bound to a different runtime session.");
  assertDomain(channel.isolation === "target-only" && channel.automationDisclosure === "always-visible-indicator", "permission_denied", "Input channels must be isolated and visibly disclosed.");
  assertTimeOrder(channel.createdAt, channel.expiresAt, "input channel creation time", "input channel expiry");
  assertDomain(Date.parse(channel.createdAt) >= Date.parse(sessionCreatedAt) && Date.parse(channel.expiresAt) <= Date.parse(sessionExpiresAt), "permission_denied", "Input channel lifetime exceeds the runtime session.");
  assertDomain(channel.state === "revoked" ? channel.revokedAt !== undefined : channel.revokedAt === undefined, "invalid_argument", "Revoked input channels must carry only a revocation timestamp.");
  if (channel.revokedAt !== undefined) {
    assertIsoTimestamp(channel.revokedAt, "input channel revocation time");
    assertDomain(Date.parse(channel.revokedAt) >= Date.parse(channel.createdAt), "invalid_argument", "Input channel revocation cannot predate creation.");
  }
  assertDomain(channel.pointer || channel.keyboard, "invalid_argument", "Input channel must expose pointer or keyboard control.");
  if (channel.state === "unavailable") {
    assertNonBlank(channel.unavailableReason ?? "", "input channel unavailable reason", 1_000);
  } else {
    assertDomain(channel.unavailableReason === undefined, "invalid_argument", "Only unavailable input channels may carry an unavailable reason.");
  }
  if (channel.state === "ready" && channel.pointer) assertDomain(surface.width > 0 && surface.height > 0, "invalid_state_transition", "A ready pointer channel requires a valid capture surface.");
  return Object.freeze({
    ...channel,
    id: assertNonBlank(channel.id, "input channel ID", 256),
    targetSessionId: assertNonBlank(channel.targetSessionId, "input channel target session ID", 256),
    ...(channel.unavailableReason === undefined ? {} : { unavailableReason: assertNonBlank(channel.unavailableReason, "input channel unavailable reason", 1_000) }),
  });
}

export function createBrowserRuntimeShellSession(input: CreateBrowserRuntimeShellSessionInput): BrowserRuntimeShellSession {
  assertNoRawTransportMaterial(input);
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Browser runtime shell schema is unsupported.");
  assertDomain(input.executionMode === "visible" || input.executionMode === "headless", "invalid_argument", "Unknown browser runtime execution mode.");
  assertTimeOrder(input.createdAt, input.expiresAt, "runtime session creation time", "runtime session expiry");
  const sessionId = assertNonBlank(input.id, "runtime session ID", 256);
  const authorization = normalizeAuthorization(input.authorization);
  const target = normalizeTarget(input.target);
  assertDomain(Date.parse(input.createdAt) >= Date.parse(authorization.acknowledgedAt) && Date.parse(input.expiresAt) <= Date.parse(authorization.expiresAt), "permission_denied", "Runtime session lifetime exceeds explicit authorization.");
  const requestedCapabilities = normalizeCapabilitySet(input.requestedCapabilities, "requested runtime capabilities");
  const grantedCapabilities = normalizeCapabilitySet(input.grantedCapabilities, "granted runtime capabilities");
  assertDomain(grantedCapabilities.every((capability) => requestedCapabilities.includes(capability)), "permission_denied", "A granted runtime capability was not requested.");
  const surface = normalizeSurface(input.surface);
  const inputChannel = input.inputChannel === undefined ? undefined : validateInputChannel(input.inputChannel, sessionId, input.createdAt, input.expiresAt, surface);
  if (inputChannel !== undefined) {
    if (inputChannel.pointer) assertDomain(grantedCapabilities.includes("independent-pointer"), "permission_denied", "Pointer channel requires the independent-pointer capability.");
    if (inputChannel.keyboard) assertDomain(grantedCapabilities.includes("independent-keyboard"), "permission_denied", "Keyboard channel requires the independent-keyboard capability.");
  }
  if (input.executionMode === "headless") {
    assertDomain(grantedCapabilities.includes("surface-capture"), "unsupported_capability", "Headless runtime sessions require surface capture.");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: sessionId,
    target,
    executionMode: input.executionMode,
    state: "requested",
    authorization,
    requestedCapabilities,
    grantedCapabilities,
    surface,
    ...(inputChannel === undefined ? {} : { inputChannel }),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}

export function transitionBrowserRuntimeShellSession(
  session: BrowserRuntimeShellSession,
  transition: BrowserRuntimeShellSessionTransition,
): BrowserRuntimeShellSession {
  assertIsoTimestamp(transition.at, "runtime session transition time");
  assertDomain(Date.parse(transition.at) >= Date.parse(session.updatedAt), "invalid_argument", "Runtime session transition time cannot move backwards.");
  assertDomain(Date.parse(transition.at) <= Date.parse(session.expiresAt), "permission_denied", "Runtime session transition is outside its authorization lifetime.");
  const allowed: Readonly<Record<BrowserRuntimeShellSessionState, readonly BrowserRuntimeShellSessionState[]>> = {
    requested: ["attached", "detached", "failed"],
    attached: ["running", "detached", "failed"],
    running: ["paused", "detached", "failed"],
    paused: ["running", "detached", "failed"],
    detached: [],
    failed: [],
  };
  assertDomain(allowed[session.state].includes(transition.to), "invalid_state_transition", `Runtime session cannot transition from ${session.state} to ${transition.to}.`);
  if (transition.to === "running") assertDomain(session.state === "attached" || session.state === "paused", "invalid_state_transition", "Only an attached or paused runtime session may run.");
  if (transition.to === "failed") assertNonBlank(transition.reason, "runtime session failure reason", 1_000);
  return Object.freeze({
    ...session,
    state: transition.to,
    updatedAt: transition.at,
    ...(transition.to === "detached" ? { detachedAt: transition.at } : {}),
    ...(transition.to === "failed" ? { failureReason: assertNonBlank(transition.reason, "runtime session failure reason", 1_000) } : {}),
  });
}

export function createBrowserRuntimeInputBatch(
  session: BrowserRuntimeShellSession,
  input: Omit<BrowserRuntimeInputBatch, "schemaVersion" | "targetSessionId"> & { readonly targetSessionId?: string },
): BrowserRuntimeInputBatch {
  assertNoRawTransportMaterial(input);
  assertDomain(session.state === "attached" || session.state === "running" || session.state === "paused", "invalid_state_transition", "Input can only be sent to an attached runtime session.");
  assertDomain(session.inputChannel?.state === "ready", "unsupported_capability", "The isolated input channel is not ready.");
  const channel = session.inputChannel;
  assertDomain(channel !== undefined, "unsupported_capability", "The isolated input channel is not available.");
  assertDomain(input.disclosure === "target-input-indicator-visible", "permission_denied", "Input batches must carry the visible target-input disclosure.");
  const targetSessionId = input.targetSessionId ?? session.id;
  assertDomain(targetSessionId === session.id && input.channelId === channel.id, "scope_violation", "Input batch does not bind to the active isolated channel.");
  assertIntegerInRange(input.sequence, "input batch sequence", 0, Number.MAX_SAFE_INTEGER);
  assertDomain(Array.isArray(input.actions), "invalid_argument", "Input batch actions must be an array.");
  assertDomain(input.actions.length > 0 && input.actions.length <= MAX_INPUT_ACTIONS, "invalid_argument", `Input batch must contain between 1 and ${MAX_INPUT_ACTIONS} actions.`);
  for (const entry of input.actions) {
    assertDomain(entry !== null && typeof entry === "object", "invalid_argument", "Input action must be an object.");
    if (entry.type === "pointer") {
      const action = entry.action;
      assertDomain(action !== null && typeof action === "object", "invalid_argument", "Pointer input action must be an object.");
      assertDomain(POINTER_KINDS.has(action.kind), "invalid_argument", "Unknown pointer action kind.");
      assertDomain(Number.isFinite(action.x) && Number.isFinite(action.y), "invalid_argument", "Pointer coordinates must be finite.");
      assertDomain(action.x >= 0 && action.x <= session.surface.width && action.y >= 0 && action.y <= session.surface.height, "invalid_argument", "Pointer coordinates must remain inside the captured surface.");
      if (action.button !== undefined) assertDomain(POINTER_BUTTONS.has(action.button), "invalid_argument", "Unknown pointer button.");
      if (action.pressed !== undefined) assertDomain(typeof action.pressed === "boolean", "invalid_argument", "Pointer pressed state must be boolean.");
      if (action.kind === "button") assertDomain(action.button !== undefined && action.pressed !== undefined, "invalid_argument", "Pointer button actions require a button and pressed state.");
      if (action.kind === "wheel") assertDomain(Number.isFinite(action.deltaX) && Number.isFinite(action.deltaY), "invalid_argument", "Wheel actions require finite deltas.");
    } else if (entry.type === "keyboard") {
      const action = entry.action;
      assertDomain(action !== null && typeof action === "object", "invalid_argument", "Keyboard input action must be an object.");
      assertDomain(KEYBOARD_KINDS.has(action.kind), "invalid_argument", "Unknown keyboard action kind.");
      if (action.kind === "text") {
        assertDomain(typeof action.text === "string" && action.text.length > 0 && action.text.length <= MAX_INPUT_TEXT, "invalid_argument", `Text input must contain between 1 and ${MAX_INPUT_TEXT} characters.`);
      } else {
        assertDomain(typeof action.code === "string" && /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}$/.test(action.code), "invalid_argument", "Keyboard actions require a bounded key code.");
      }
      if (action.modifiers !== undefined) {
        assertDomain(Array.isArray(action.modifiers), "invalid_argument", "Keyboard modifiers must be an array.");
        assertDomain(action.modifiers.every((modifier: NonNullable<BrowserRuntimeKeyboardAction["modifiers"]>[number]) => KEYBOARD_MODIFIERS.has(modifier)), "invalid_argument", "Unknown keyboard modifier.");
        uniqueValues(action.modifiers, "keyboard modifiers");
      }
    } else {
      assertDomain(false, "invalid_argument", "Unknown input action type.");
    }
  }
  assertTimeOrder(input.createdAt, input.expiresAt, "input batch creation time", "input batch expiry");
  assertDomain(Date.parse(input.createdAt) >= Date.parse(session.createdAt) && Date.parse(input.expiresAt) <= Date.parse(session.expiresAt), "permission_denied", "Input batch lifetime exceeds the runtime session.");
  return Object.freeze({
    schemaVersion: 1,
    id: assertNonBlank(input.id, "input batch ID", 256),
    targetSessionId: session.id,
    channelId: assertNonBlank(input.channelId, "input channel ID", 256),
    sequence: input.sequence,
    actions: Object.freeze(input.actions.map((entry) =>
      entry.type === "pointer"
        ? Object.freeze({ type: "pointer" as const, action: Object.freeze({ ...entry.action }) })
        : Object.freeze({ type: "keyboard" as const, action: Object.freeze({ ...entry.action }) }),
    )),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    disclosure: "target-input-indicator-visible",
  });
}

export function createBrowserRuntimeRequestObservation(input: BrowserRuntimeRequestObservation): BrowserRuntimeRequestObservation {
  assertNoRawTransportMaterial(input);
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Request observation schema is unsupported.");
  assertIsoTimestamp(input.observedAt, "request observation time");
  assertDomain(input.direction === "request" || input.direction === "response", "invalid_argument", "Unknown request observation direction.");
  assertDomain(input.method === "GET" || input.method === "HEAD", "permission_denied", "Only read-only browser request methods can be observed by this shell.");
  const origin = normalizeOrigin(input.origin);
  if (input.responseStatus !== undefined) assertDomain(input.responseStatus === 200 || input.responseStatus === 206 || input.responseStatus === 304, "invalid_argument", "Unsupported observed response status.");
  if (input.mediaType !== undefined) normalizeMediaType(input.mediaType);
  if (input.expectedBytes !== undefined) assertIntegerInRange(input.expectedBytes, "observed expected bytes", 0, MAX_DOWNLOAD_BYTES);
  if (input.contentRange !== undefined) {
    assertIntegerInRange(input.contentRange.start, "content range start", 0, MAX_DOWNLOAD_BYTES);
    assertIntegerInRange(input.contentRange.endInclusive, "content range end", 0, MAX_DOWNLOAD_BYTES);
    assertIntegerInRange(input.contentRange.total, "content range total", 1, MAX_DOWNLOAD_BYTES);
    assertDomain(input.contentRange.endInclusive >= input.contentRange.start && input.contentRange.endInclusive < input.contentRange.total, "invalid_argument", "Observed content range is invalid.");
  }
  assertDomain(input.bodyRetention === "broker-only", "permission_denied", "Response bodies must remain behind the native broker handle.");
  return Object.freeze({
    ...input,
    id: assertNonBlank(input.id, "request observation ID", 256),
    targetSessionId: assertNonBlank(input.targetSessionId, "request observation session ID", 256),
    origin,
    requestIdentitySha256: assertSha256(input.requestIdentitySha256, "request identity hash"),
    metadataSha256: assertSha256(input.metadataSha256, "request metadata hash"),
    ...(input.mediaType === undefined ? {} : { mediaType: normalizeMediaType(input.mediaType) }),
    ...(input.responseBodyHandleId === undefined ? {} : { responseBodyHandleId: assertNonBlank(input.responseBodyHandleId, "response body handle ID", 256) }),
  });
}

export function createBrowserRuntimeDownloadJob(input: CreateBrowserRuntimeDownloadJobInput): BrowserRuntimeDownloadJob {
  assertNoRawTransportMaterial(input);
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Download job schema is unsupported.");
  assertIsoTimestamp(input.createdAt, "download creation time");
  assertDomain(input.assembly === "single-response" || input.assembly === "byte-range" || input.assembly === "segmented-media", "invalid_argument", "Unknown download assembly.");
  assertDomain(Array.isArray(input.sourceObservationIds) && input.sourceObservationIds.length > 0, "invalid_argument", "Download jobs require at least one observed source ID.");
  const sourceObservationIds = input.sourceObservationIds.map((id) => assertNonBlank(id, "download source observation ID", 256));
  assertDomain(new Set(sourceObservationIds).size === sourceObservationIds.length, "invalid_argument", "Download jobs require unique observed source IDs.");
  if (input.expectedBytes !== undefined) assertIntegerInRange(input.expectedBytes, "download expected bytes", 0, MAX_DOWNLOAD_BYTES);
  const outputFilename = normalizeDownloadFilename(input.outputFilename);
  return Object.freeze({
    schemaVersion: 1,
    id: assertNonBlank(input.id, "download job ID", 256),
    targetSessionId: assertNonBlank(input.targetSessionId, "download job session ID", 256),
    assembly: input.assembly,
    sourceObservationIds: Object.freeze(sourceObservationIds),
    outputFilename,
    outputMediaType: normalizeMediaType(input.outputMediaType),
    state: "queued",
    progress: 0,
    downloadedBytes: 0,
    ...(input.expectedBytes === undefined ? {} : { expectedBytes: input.expectedBytes }),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

export function transitionBrowserRuntimeDownloadJob(job: BrowserRuntimeDownloadJob, transition: BrowserRuntimeDownloadTransition): BrowserRuntimeDownloadJob {
  assertIsoTimestamp(transition.at, "download transition time");
  assertDomain(Date.parse(transition.at) >= Date.parse(job.updatedAt), "invalid_argument", "Download transition time cannot move backwards.");
  const allowed: Readonly<Record<BrowserRuntimeDownloadState, readonly BrowserRuntimeDownloadState[]>> = {
    queued: ["running", "cancelled"],
    running: ["paused", "completed", "failed", "cancelled"],
    paused: ["running", "cancelled", "failed"],
    completed: [],
    failed: [],
    cancelled: [],
  };
  assertDomain(allowed[job.state].includes(transition.to), "invalid_state_transition", `Download job cannot transition from ${job.state} to ${transition.to}.`);
  const downloadedBytes =
    "downloadedBytes" in transition && transition.downloadedBytes !== undefined
      ? transition.downloadedBytes
      : job.downloadedBytes;
  assertIntegerInRange(downloadedBytes, "downloaded bytes", 0, MAX_DOWNLOAD_BYTES);
  assertDomain(downloadedBytes >= job.downloadedBytes, "invalid_argument", "Downloaded bytes cannot move backwards.");
  if (job.expectedBytes !== undefined) assertDomain(downloadedBytes <= job.expectedBytes, "invalid_argument", "Downloaded bytes cannot exceed the expected byte count.");
  if (transition.to === "completed") {
    assertDomain(job.expectedBytes === undefined || downloadedBytes === job.expectedBytes, "invalid_argument", "A completed download must account for its expected bytes.");
    assertSha256(transition.outputContentSha256, "download output hash");
    assertNonBlank(transition.outputBlobId, "download output blob ID", 256);
  }
  if (transition.to === "failed" || transition.to === "cancelled") assertNonBlank(transition.reason, "download terminal reason", 1_000);
  const progress = transition.to === "completed"
    ? 1
    : job.expectedBytes === undefined
      ? job.progress
      : Math.min(1, downloadedBytes / Math.max(job.expectedBytes, 1));
  return Object.freeze({
    ...job,
    state: transition.to,
    progress,
    downloadedBytes,
    updatedAt: transition.at,
    ...(transition.to === "completed" ? { completedAt: transition.at, outputContentSha256: assertSha256(transition.outputContentSha256, "download output hash"), outputBlobId: assertNonBlank(transition.outputBlobId, "download output blob ID", 256) } : {}),
    ...(transition.to === "failed" || transition.to === "cancelled" ? { failureReason: assertNonBlank(transition.reason, "download terminal reason", 1_000) } : {}),
  });
}

export function createBrowserPreviewRuntimeShellPort(): BrowserRuntimeShellPort {
  return Object.freeze({
    kind: "browser-preview",
    capabilities: Object.freeze(CAPABILITIES.map((capability) => Object.freeze({
      capability,
      supported: false,
      reason: "Native browser/process broker is unavailable in the browser preview.",
    }))),
  });
}

export function createNativeRuntimeShellCapabilityReport(
  supportedCapabilities: readonly BrowserRuntimeShellCapability[],
): BrowserRuntimeShellPort {
  const supported = normalizeCapabilitySet(supportedCapabilities, "native runtime capabilities");
  return Object.freeze({
    kind: "native",
    capabilities: Object.freeze(CAPABILITIES.map((capability) => Object.freeze({
      capability,
      supported: supported.includes(capability),
      ...(supported.includes(capability) ? {} : { reason: "Native adapter did not grant this capability." }),
    }))),
  });
}
