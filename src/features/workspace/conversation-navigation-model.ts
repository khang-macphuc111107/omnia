import type { ChatMessage, MessageStatus } from "./types";

/**
 * A renderer-only marker kind. This projection intentionally contains only
 * enough information to render a local conversation map; it is not a durable
 * jump-target record and must not be treated as native navigation state.
 */
export type NavigationMarkerKind = "prompt" | "output" | "issue";

/**
 * Renderer-only facets for narrowing the visible map. These are deliberately
 * derived from the hydrated ChatMessage projection; they are not a claim that
 * the native event index or a durable JumpTarget store is available.
 */
export type NavigationFacet =
  | "all"
  | "prompt"
  | "output"
  | "issue"
  | "active"
  | "branched"
  | "attached"
  | "with-run"
  | "with-model";

export interface NavigationFilter {
  readonly query: string;
  readonly facet: NavigationFacet;
}

export interface NavigationMarker {
  readonly messageId: string;
  readonly index: number;
  readonly kind: NavigationMarkerKind;
  readonly role: ChatMessage["role"];
  readonly status: MessageStatus;
  readonly label: string;
  readonly excerpt: string;
  readonly branchIndex: number;
  readonly branchCount: number;
  readonly createdAt: string;
  readonly modelLabel: string | null;
  readonly runId: string | null;
  readonly attachmentCount: number;
}

export interface NavigationProjection {
  readonly markers: readonly NavigationMarker[];
  readonly promptCount: number;
  readonly outputCount: number;
  readonly issueCount: number;
}

const EXCERPT_LIMIT = 108;

function excerptFor(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "No text yet";
  if (normalized.length <= EXCERPT_LIMIT) return normalized;
  return `${normalized.slice(0, EXCERPT_LIMIT - 1).trimEnd()}…`;
}

function markerKindFor(message: ChatMessage): NavigationMarkerKind {
  if (message.status === "failed" || message.status === "stopped") return "issue";
  return message.role === "user" ? "prompt" : "output";
}

function markerKindLabel(kind: NavigationMarkerKind): string {
  if (kind === "prompt") return "Prompt";
  if (kind === "output") return "Assistant output";
  return "Issue";
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Builds the stable, bounded renderer projection used by the local map.
 * Message order is preserved and no message content beyond a short excerpt is
 * retained in the navigation object.
 */
export function buildNavigationProjection(
  messages: readonly ChatMessage[],
): NavigationProjection {
  const counters: Record<NavigationMarkerKind, number> = {
    prompt: 0,
    output: 0,
    issue: 0,
  };

  const markers = messages.map((message, index) => {
    const kind = markerKindFor(message);
    counters[kind] += 1;
    const ordinal = counters[kind];
    const branchLabel = message.branchCount > 1 ? ` · branch ${message.branchIndex}/${message.branchCount}` : "";
    const activeLabel = message.status === "streaming" ? " · active run" : "";
    return {
      messageId: message.id,
      index,
      kind,
      role: message.role,
      status: message.status,
      label: `${markerKindLabel(kind)} ${ordinal}: ${excerptFor(message.content)}${branchLabel}${activeLabel}`,
      excerpt: excerptFor(message.content),
      branchIndex: message.branchIndex,
      branchCount: message.branchCount,
      createdAt: message.createdAt,
      modelLabel: message.modelLabel,
      runId: message.runId,
      attachmentCount: message.attachments.length,
    } satisfies NavigationMarker;
  });

  return {
    markers,
    promptCount: counters.prompt,
    outputCount: counters.output,
    issueCount: counters.issue,
  };
}

/**
 * Filters a projection without changing source order or marker identity. The
 * returned array is a renderer-session view and must not be used as a durable
 * branch/event index.
 */
export function filterNavigationMarkers(
  markers: readonly NavigationMarker[],
  filter: NavigationFilter,
): readonly NavigationMarker[] {
  const query = normalizeQuery(filter.query);
  return markers.filter((marker) => {
    if (filter.facet === "prompt" && marker.kind !== "prompt") return false;
    if (filter.facet === "output" && marker.kind !== "output") return false;
    if (filter.facet === "issue" && marker.kind !== "issue") return false;
    if (filter.facet === "active" && marker.status !== "streaming") return false;
    if (filter.facet === "branched" && marker.branchCount <= 1) return false;
    if (filter.facet === "attached" && marker.attachmentCount === 0) return false;
    if (filter.facet === "with-run" && !marker.runId) return false;
    if (filter.facet === "with-model" && !marker.modelLabel) return false;
    if (!query) return true;
    const haystack = [
      marker.label,
      marker.excerpt,
      marker.role,
      marker.status,
      marker.modelLabel ?? "",
      marker.runId ?? "",
      marker.branchCount > 1 ? `branch ${marker.branchIndex}/${marker.branchCount}` : "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

export interface RendererDeepLinkInput {
  readonly conversationId: string;
  /** Optional project owner. When present the canonical URI includes the project context. */
  readonly projectId?: string | null;
  readonly branchId?: string | null;
  readonly messageId?: string | null;
  readonly messageRevisionId?: string | null;
  readonly selectionId?: string | null;
  readonly runId?: string | null;
  readonly attemptId?: string | null;
  readonly eventCursor?: number | null;
  /** Renderer preview source watermark; native state-revision authority is not implied. */
  readonly sourceRevision?: string | null;
  /** Optional bounded anchor fingerprint; message content is never embedded. */
  readonly semanticFingerprint?: string | null;
  /** Optional selection/quote digest; raw quoted content is never embedded. */
  readonly quoteHash?: string | null;
  readonly targetKind?: RendererDeepLinkTargetKind | null;
}

/**
 * Typed target kinds supported by the renderer deep-link preview. This is a
 * deliberately small subset of the normative JumpTarget vocabulary: the
 * renderer can identify message/run anchors, but it cannot claim native
 * source, tool, artifact or durable target resolution.
 */
export type RendererDeepLinkTargetKind = "chat" | "message" | "selection" | "run" | "attempt";

export type RendererDeepLinkParseStatus = "valid" | "malformed" | "unsupported";

export type RendererDeepLinkParseReason =
  | "empty"
  | "invalid-uri"
  | "unsupported-scheme"
  | "unsupported-host"
  | "invalid-path"
  | "duplicate-parameter"
  | "unknown-parameter"
  | "invalid-parameter"
  | "target-requires-anchor"
  | "target-mismatch";

export interface RendererDeepLinkTarget {
  readonly uri: string;
  readonly scope: "chat" | "project-chat";
  readonly projectId: string | null;
  readonly conversationId: string;
  readonly branchId: string | null;
  readonly messageId: string | null;
  readonly messageRevisionId: string | null;
  readonly selectionId: string | null;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly eventCursor: number | null;
  readonly sourceRevision: string | null;
  readonly semanticFingerprint: string | null;
  readonly quoteHash: string | null;
  readonly targetKind: RendererDeepLinkTargetKind;
}

export interface RendererDeepLinkParseResult {
  readonly status: RendererDeepLinkParseStatus;
  readonly uri: string;
  readonly target?: RendererDeepLinkTarget;
  readonly reason?: RendererDeepLinkParseReason;
}

export type RendererDeepLinkResolutionStatus = "resolved" | "stale" | "missing" | "unsupported";

export type RendererDeepLinkResolutionReason =
  | "conversation-missing"
  | "project-missing"
  | "project-context-mismatch"
  | "archived"
  | "branch-missing"
  | "source-revision-mismatch"
  | "message-missing"
  | "message-revision-missing"
  | "selection-missing"
  | "run-missing"
  | "attempt-missing"
  | "anchor-index-unavailable"
  | "fingerprint-index-unavailable"
  | "fingerprint-mismatch"
  | "quote-hash-index-unavailable"
  | "quote-hash-mismatch";

export type RendererDeepLinkAncestor = "chats" | "project" | "chat" | "branch";

export interface RendererDeepLinkAvailability {
  /** The currently hydrated conversation; null means no matching Chat is open. */
  readonly conversationId: string | null | undefined;
  readonly projectId?: string | null;
  readonly branchId?: string | null;
  readonly archived?: boolean;
  readonly sourceRevision?: string | null;
  /** If omitted, the renderer cannot truthfully resolve an anchored target. */
  readonly messageIds?: readonly string[];
  readonly messageRevisionIds?: readonly string[];
  readonly selectionIds?: readonly string[];
  readonly runIds?: readonly string[];
  readonly attemptIds?: readonly string[];
  /** Optional renderer-side fingerprints for fail-closed anchor validation. */
  readonly messageFingerprints?: Readonly<Record<string, string>>;
  readonly selectionFingerprints?: Readonly<Record<string, string>>;
  /** Optional renderer-side quote digests for fail-closed selection validation. */
  readonly messageQuoteHashes?: Readonly<Record<string, string>>;
  readonly selectionQuoteHashes?: Readonly<Record<string, string>>;
}

export interface RendererDeepLinkResolution {
  readonly status: RendererDeepLinkResolutionStatus;
  readonly target: RendererDeepLinkTarget;
  readonly reason?: RendererDeepLinkResolutionReason;
  readonly nearestAncestor: RendererDeepLinkAncestor;
  readonly label: string;
}

const DEEP_LINK_PARAMETER_NAMES = new Set([
  "target",
  "branch",
  "message",
  "messageRevision",
  "selection",
  "run",
  "attempt",
  "cursor",
  "revision",
  "fingerprint",
  "quoteHash",
]);

const DEEP_LINK_TARGET_KINDS: readonly RendererDeepLinkTargetKind[] = [
  "chat",
  "message",
  "selection",
  "run",
  "attempt",
];

function normalizedDeepLinkPart(value: string | null | undefined, maxLength = 256): string | null {
  const normalized = value?.normalize("NFKC").trim() ?? "";
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function deepLinkPathPart(value: string): string {
  return encodeURIComponent(value);
}

function deepLinkTargetKind(input: RendererDeepLinkInput): RendererDeepLinkTargetKind {
  if (input.targetKind && DEEP_LINK_TARGET_KINDS.includes(input.targetKind)) return input.targetKind;
  if (input.attemptId?.trim()) return "attempt";
  if (input.runId?.trim()) return "run";
  if (input.selectionId?.trim()) return "selection";
  if (input.messageId?.trim()) return "message";
  return "chat";
}

function parseDeepLinkInteger(value: string | null): number | null | "invalid" {
  if (value === null || value.trim() === "") return null;
  if (!/^\d+$/u.test(value)) return "invalid";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

function decodeDeepLinkSegment(value: string): string | null {
  try {
    return normalizedDeepLinkPart(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function parseRendererDeepLinkInput(input: string): RendererDeepLinkParseResult {
  const uri = input.trim();
  if (!uri) return { status: "malformed", uri, reason: "empty" };

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { status: "malformed", uri, reason: "invalid-uri" };
  }
  if (parsed.protocol !== "omnia:") return { status: "unsupported", uri, reason: "unsupported-scheme" };
  if (parsed.username || parsed.password || parsed.port || parsed.hash) return { status: "malformed", uri, reason: "invalid-uri" };

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  let scope: RendererDeepLinkTarget["scope"];
  let projectId: string | null = null;
  let conversationId: string | null = null;

  if (host === "chat") {
    scope = "chat";
    if (segments.length !== 1) return { status: "malformed", uri, reason: "invalid-path" };
    conversationId = decodeDeepLinkSegment(segments[0] ?? "");
  } else if (host === "project") {
    scope = "project-chat";
    if (segments.length !== 3 || segments[1] !== "chat") {
      return { status: "malformed", uri, reason: "invalid-path" };
    }
    projectId = decodeDeepLinkSegment(segments[0] ?? "");
    conversationId = decodeDeepLinkSegment(segments[2] ?? "");
  } else {
    return { status: "unsupported", uri, reason: "unsupported-host" };
  }
  if (!conversationId || (scope === "project-chat" && !projectId)) {
    return { status: "malformed", uri, reason: "invalid-path" };
  }

  const seen = new Set<string>();
  for (const [key] of parsed.searchParams.entries()) {
    if (!DEEP_LINK_PARAMETER_NAMES.has(key)) return { status: "unsupported", uri, reason: "unknown-parameter" };
    if (seen.has(key)) return { status: "malformed", uri, reason: "duplicate-parameter" };
    seen.add(key);
  }

  const targetParam = parsed.searchParams.get("target");
  const targetKind = targetParam === null ? null : normalizedDeepLinkPart(targetParam, 32);
  if (targetParam !== null && (!targetKind || !DEEP_LINK_TARGET_KINDS.includes(targetKind as RendererDeepLinkTargetKind))) {
    return { status: "unsupported", uri, reason: "invalid-parameter" };
  }

  const branchId = normalizedDeepLinkPart(parsed.searchParams.get("branch"));
  const messageId = normalizedDeepLinkPart(parsed.searchParams.get("message"));
  const messageRevisionId = normalizedDeepLinkPart(parsed.searchParams.get("messageRevision"));
  const selectionId = normalizedDeepLinkPart(parsed.searchParams.get("selection"));
  const runId = normalizedDeepLinkPart(parsed.searchParams.get("run"));
  const attemptId = normalizedDeepLinkPart(parsed.searchParams.get("attempt"));
  const sourceRevision = normalizedDeepLinkPart(parsed.searchParams.get("revision"));
  const semanticFingerprint = normalizedDeepLinkPart(parsed.searchParams.get("fingerprint"));
  const quoteHash = normalizedDeepLinkPart(parsed.searchParams.get("quoteHash"));
  const eventCursor = parseDeepLinkInteger(parsed.searchParams.get("cursor"));
  const stringParameters: readonly [string, string | null][] = [
    ["branch", branchId],
    ["message", messageId],
    ["messageRevision", messageRevisionId],
    ["selection", selectionId],
    ["run", runId],
    ["attempt", attemptId],
    ["revision", sourceRevision],
    ["fingerprint", semanticFingerprint],
    ["quoteHash", quoteHash],
  ];
  if (stringParameters.some(([key, value]) => parsed.searchParams.has(key) && value === null)) {
    return { status: "malformed", uri, reason: "invalid-parameter" };
  }
  if (eventCursor === "invalid") return { status: "malformed", uri, reason: "invalid-parameter" };
  if ((messageRevisionId || semanticFingerprint) && !messageId) {
    return { status: "malformed", uri, reason: "target-requires-anchor" };
  }

  const inferredTargetKind =
    (targetKind as RendererDeepLinkTargetKind | null) ??
    (attemptId ? "attempt" : runId ? "run" : selectionId ? "selection" : messageId ? "message" : "chat");
  if (
    (inferredTargetKind === "message" && !messageId) ||
    (inferredTargetKind === "selection" && (!messageId || !selectionId)) ||
    (inferredTargetKind === "run" && !runId) ||
    (inferredTargetKind === "attempt" && !attemptId)
  ) {
    return { status: "malformed", uri, reason: "target-requires-anchor" };
  }
  if (
    (targetParam === "chat" && (messageId || selectionId || runId || attemptId)) ||
    (targetParam === "message" && selectionId) ||
    (targetParam === "run" && (messageId || selectionId || attemptId)) ||
    (targetParam === "attempt" && (messageId || selectionId))
  ) {
    return { status: "malformed", uri, reason: "target-mismatch" };
  }

  const target: RendererDeepLinkTarget = {
    uri,
    scope,
    projectId,
    conversationId,
    branchId,
    messageId,
    messageRevisionId,
    selectionId,
    runId,
    attemptId,
    eventCursor: eventCursor === null ? null : eventCursor,
    sourceRevision,
    semanticFingerprint,
    quoteHash,
    targetKind: inferredTargetKind,
  };
  return { status: "valid", uri, target };
}

/** Parses an Omnia renderer deep-link preview without routing or persistence. */
export function parseRendererDeepLinkPreview(input: string): RendererDeepLinkParseResult {
  return parseRendererDeepLinkInput(input);
}

/**
 * Resolves a parsed preview against the currently hydrated renderer snapshot.
 * Missing indexes are reported as unsupported rather than guessed, and stale
 * links return the nearest safe ancestor instead of opening another Chat.
 */
export function resolveRendererDeepLinkPreview(
  target: RendererDeepLinkTarget,
  availability: RendererDeepLinkAvailability,
): RendererDeepLinkResolution {
  const baseLabel = target.scope === "project-chat" ? "Project Chat" : "Chat";
  const ancestor: RendererDeepLinkAncestor = target.branchId ? "branch" : "chat";
  if (!availability.conversationId) {
    return {
      status: "missing",
      target,
      reason: "conversation-missing",
      nearestAncestor: target.projectId ? "project" : "chats",
      label: `${baseLabel} is not available in this preview`,
    };
  }
  if (availability.conversationId !== target.conversationId) {
    return {
      status: "missing",
      target,
      reason: "conversation-missing",
      nearestAncestor: target.projectId ? "project" : "chats",
      label: `Chat ${target.conversationId} is not the active preview target`,
    };
  }
  if (target.projectId && availability.projectId !== target.projectId) {
    return {
      status: availability.projectId ? "stale" : "missing",
      target,
      reason: availability.projectId ? "project-context-mismatch" : "project-missing",
      nearestAncestor: "chat",
      label: "Project context does not match this preview target",
    };
  }
  if (availability.archived) {
    return { status: "stale", target, reason: "archived", nearestAncestor: "chat", label: "Chat is archived in this preview" };
  }
  if (target.branchId && availability.branchId && target.branchId !== availability.branchId) {
    return { status: "stale", target, reason: "branch-missing", nearestAncestor: "chat", label: "Branch is not active in this preview" };
  }
  if (target.sourceRevision && availability.sourceRevision && target.sourceRevision !== availability.sourceRevision) {
    return { status: "stale", target, reason: "source-revision-mismatch", nearestAncestor: ancestor, label: "Target revision is stale in this preview" };
  }

  const requireIndexed = (ids: readonly string[] | undefined, id: string | null, reason: RendererDeepLinkResolutionReason, label: string): RendererDeepLinkResolution | null => {
    if (!id) return null;
    if (!ids) return { status: "unsupported", target, reason: "anchor-index-unavailable", nearestAncestor: ancestor, label: `${label} index is unavailable in this preview` };
    if (!ids.includes(id)) return { status: "stale", target, reason, nearestAncestor: ancestor, label: `${label} target is stale in this preview` };
    return null;
  };
  const messageResolution = requireIndexed(availability.messageIds, target.messageId, "message-missing", "Message");
  if (messageResolution) return messageResolution;
  const messageRevisionResolution = requireIndexed(
    availability.messageRevisionIds,
    target.messageRevisionId,
    "message-revision-missing",
    "Message revision",
  );
  if (messageRevisionResolution) return messageRevisionResolution;
  const selectionResolution = requireIndexed(availability.selectionIds, target.selectionId, "selection-missing", "Selection");
  if (selectionResolution) return selectionResolution;
  const runResolution = requireIndexed(availability.runIds, target.runId, "run-missing", "Run");
  if (runResolution) return runResolution;
  const attemptResolution = requireIndexed(availability.attemptIds, target.attemptId, "attempt-missing", "Attempt");
  if (attemptResolution) return attemptResolution;

  const requireDigest = (
    digest: string | null,
    id: string | null,
    values: Readonly<Record<string, string>> | undefined,
    unavailableReason: "fingerprint-index-unavailable" | "quote-hash-index-unavailable",
    mismatchReason: "fingerprint-mismatch" | "quote-hash-mismatch",
    label: "Fingerprint" | "Quote hash",
  ): RendererDeepLinkResolution | null => {
    if (!digest || !id) return null;
    if (!values) {
      return {
        status: "unsupported",
        target,
        reason: unavailableReason,
        nearestAncestor: ancestor,
        label: `${label} index is unavailable in this preview`,
      };
    }
    const observed = values[id];
    if (observed === undefined) {
      return {
        status: "stale",
        target,
        reason: mismatchReason,
        nearestAncestor: ancestor,
        label: `${label} target is stale in this preview`,
      };
    }
    if (observed !== digest) {
      return {
        status: "stale",
        target,
        reason: mismatchReason,
        nearestAncestor: ancestor,
        label: `${label} does not match this preview target`,
      };
    }
    return null;
  };

  // Selection digests are intentionally resolved against the selection index
  // when a selection anchor is present; falling back to the message index here
  // would silently accept a digest for a different anchor kind.
  const fingerprintResolution = requireDigest(
    target.semanticFingerprint,
    target.selectionId ?? target.messageId,
    target.selectionId ? availability.selectionFingerprints : availability.messageFingerprints,
    "fingerprint-index-unavailable",
    "fingerprint-mismatch",
    "Fingerprint",
  );
  if (fingerprintResolution) return fingerprintResolution;
  const quoteHashResolution = requireDigest(
    target.quoteHash,
    target.selectionId ?? target.messageId,
    target.selectionId ? availability.selectionQuoteHashes : availability.messageQuoteHashes,
    "quote-hash-index-unavailable",
    "quote-hash-mismatch",
    "Quote hash",
  );
  if (quoteHashResolution) return quoteHashResolution;
  return { status: "resolved", target, nearestAncestor: ancestor, label: `${baseLabel} target resolved in renderer preview` };
}

/**
 * Creates a stable-looking renderer preview deep link. It is intentionally a
 * plain URI string only: no router registration, persistence, or native
 * external-link broker is implied by this helper.
 */
export function createRendererDeepLinkPreview(input: RendererDeepLinkInput): string {
  const conversationId = normalizedDeepLinkPart(input.conversationId);
  if (!conversationId) return "";
  const projectId = normalizedDeepLinkPart(input.projectId);
  const branchId = normalizedDeepLinkPart(input.branchId);
  const messageId = normalizedDeepLinkPart(input.messageId);
  const messageRevisionId = normalizedDeepLinkPart(input.messageRevisionId);
  const selectionId = normalizedDeepLinkPart(input.selectionId);
  const runId = normalizedDeepLinkPart(input.runId);
  const attemptId = normalizedDeepLinkPart(input.attemptId);
  const sourceRevision = normalizedDeepLinkPart(input.sourceRevision);
  const semanticFingerprint = normalizedDeepLinkPart(input.semanticFingerprint);
  const quoteHash = normalizedDeepLinkPart(input.quoteHash);
  const targetKind = deepLinkTargetKind(input);
  if (input.targetKind !== undefined && input.targetKind !== null && !DEEP_LINK_TARGET_KINDS.includes(input.targetKind)) return "";
  if (targetKind === "message" && !messageId) return "";
  if (targetKind === "selection" && (!messageId || !selectionId)) return "";
  if (targetKind === "run" && !runId) return "";
  if (targetKind === "attempt" && !attemptId) return "";
  if ((messageRevisionId || semanticFingerprint) && !messageId) return "";
  if (input.eventCursor !== undefined && input.eventCursor !== null && (!Number.isSafeInteger(input.eventCursor) || input.eventCursor < 0)) return "";
  if (input.targetKind === "chat" && (messageId || selectionId || runId || attemptId)) return "";
  if (input.targetKind === "message" && selectionId) return "";
  if (input.targetKind === "run" && (messageId || selectionId || attemptId)) return "";
  if (input.targetKind === "attempt" && (messageId || selectionId)) return "";

  const params = new URLSearchParams();
  if (branchId) params.set("branch", branchId);
  if (messageId) params.set("message", messageId);
  if (messageRevisionId) params.set("messageRevision", messageRevisionId);
  if (selectionId) params.set("selection", selectionId);
  if (runId) params.set("run", runId);
  if (attemptId) params.set("attempt", attemptId);
  if (input.eventCursor !== undefined && input.eventCursor !== null) params.set("cursor", String(input.eventCursor));
  if (sourceRevision) params.set("revision", sourceRevision);
  if (semanticFingerprint) params.set("fingerprint", semanticFingerprint);
  if (quoteHash) params.set("quoteHash", quoteHash);
  // Keep legacy links compact by inferring the kind from their anchors. An
  // explicit target is emitted only when the caller asks for one.
  if (input.targetKind !== undefined && input.targetKind !== null) params.set("target", input.targetKind);
  const query = params.toString();
  const path = projectId
    ? `omnia://project/${deepLinkPathPart(projectId)}/chat/${deepLinkPathPart(conversationId)}`
    : `omnia://chat/${deepLinkPathPart(conversationId)}`;
  return `${path}${query ? `?${query}` : ""}`;
}

function findRelativeIndex(
  projection: NavigationProjection,
  currentIndex: number,
  kind: NavigationMarkerKind,
  direction: 1 | -1,
): number | undefined {
  const start = currentIndex < 0 ? (direction === 1 ? -1 : projection.markers.length) : currentIndex;
  for (let index = start + direction; index >= 0 && index < projection.markers.length; index += direction) {
    if (projection.markers[index]?.kind === kind) return index;
  }
  return undefined;
}

export function nextPromptIndex(
  projection: NavigationProjection,
  currentIndex: number,
): number | undefined {
  return findRelativeIndex(projection, currentIndex, "prompt", 1);
}

export function previousPromptIndex(
  projection: NavigationProjection,
  currentIndex: number,
): number | undefined {
  return findRelativeIndex(projection, currentIndex, "prompt", -1);
}

export function nextIssueIndex(
  projection: NavigationProjection,
  currentIndex: number,
): number | undefined {
  return findRelativeIndex(projection, currentIndex, "issue", 1);
}

export function previousIssueIndex(
  projection: NavigationProjection,
  currentIndex: number,
): number | undefined {
  return findRelativeIndex(projection, currentIndex, "issue", -1);
}

export function firstMessageIndex(projection: NavigationProjection): number | undefined {
  return projection.markers.length > 0 ? 0 : undefined;
}

export function latestOutputIndex(projection: NavigationProjection): number | undefined {
  for (let index = projection.markers.length - 1; index >= 0; index -= 1) {
    if (projection.markers[index]?.kind === "output") return index;
  }
  return undefined;
}

export function markerIndexForMessage(
  projection: NavigationProjection,
  messageId: string | null | undefined,
): number {
  if (!messageId) return -1;
  return projection.markers.findIndex((marker) => marker.messageId === messageId);
}
