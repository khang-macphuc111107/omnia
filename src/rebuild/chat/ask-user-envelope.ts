/** Typed, bounded ask-user envelopes for the renderer/native boundary. */

export type AskUserDecisionKind = "select" | "free_text" | "approve" | "reject" | "edit" | "cancel";
export type AskUserResolutionStatus = "answered" | "cancelled" | "rejected" | "expired";

export interface AskUserOption { id: string; label: string; recommended?: boolean; }
export interface AskUserRequestEnvelope {
  kind: "ask_user.request";
  requestId: string;
  sessionId: string;
  runId: string;
  prompt: string;
  options: AskUserOption[];
  allowFreeText: boolean;
  recommendedOptionIds: string[];
  revision: number;
  createdAtMs: number;
  expiresAtMs: number | null;
}
export interface AskUserDecisionEnvelope {
  kind: "ask_user.decision";
  requestId: string;
  sessionId: string;
  runId: string;
  revision: number;
  action: AskUserDecisionKind;
  optionId: string | null;
  text: string | null;
  reason: string | null;
}
export interface AskUserResolution {
  requestId: string;
  sessionId: string;
  runId: string;
  revision: number;
  status: AskUserResolutionStatus;
  action: AskUserDecisionKind;
  optionId: string | null;
  text: string | null;
  reason: string | null;
  resolvedAtMs: number;
}
export interface AskUserPendingSnapshot { request: AskUserRequestEnvelope; status: "pending"; }

export type AskUserEnvelopeErrorCode = "invalid_request" | "invalid_decision" | "duplicate_request" | "unknown_request" | "wrong_session" | "wrong_run" | "stale_revision" | "already_resolved" | "expired" | "closed";
export class AskUserEnvelopeError extends Error {
  readonly code: AskUserEnvelopeErrorCode;
  constructor(code: AskUserEnvelopeErrorCode, message: string) { super(message); this.name = "AskUserEnvelopeError"; this.code = code; }
}

const MAX_PROMPT = 8_192;
const MAX_ID = 256;
const MAX_LABEL = 1_024;
const MAX_TEXT = 32_768;
const MAX_REASON = 1_024;
const MAX_OPTIONS = 8;
const ACTIONS: readonly AskUserDecisionKind[] = ["select", "free_text", "approve", "reject", "edit", "cancel"];

type ErrorCode = "invalid_request" | "invalid_decision";
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bounded(value: unknown, field: string, max: number, code: ErrorCode, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new AskUserEnvelopeError(code, `${field} must be nonempty text of at most ${max} characters`);
  for (const character of value) {
    if (!/\p{Cc}/u.test(character)) continue;
    if (!multiline || !"\n\r\t".includes(character)) throw new AskUserEnvelopeError(code, `${field} contains unsupported control characters`);
  }
  return value.trim();
}
function nullableText(value: unknown, field: string, max: number): string | null {
  if (value == null) return null;
  return bounded(value, field, max, "invalid_decision", true);
}
function identifier(value: unknown, field: string, code: ErrorCode): string { return bounded(value, field, MAX_ID, code); }
function safeInteger(value: unknown, field: string, minimum: number, code: ErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new AskUserEnvelopeError(code, `${field} must be a safe integer >= ${minimum}`);
  return value;
}
function knownKeys(value: Record<string, unknown>, keys: readonly string[], code: AskUserEnvelopeErrorCode): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new AskUserEnvelopeError(code, "Envelope contains an unknown field");
}
function options(value: unknown): AskUserOption[] {
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) throw new AskUserEnvelopeError("invalid_request", `options must contain at most ${MAX_OPTIONS} entries`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!record(entry)) throw new AskUserEnvelopeError("invalid_request", `option ${index + 1} is invalid`);
    const optionId = identifier(entry.id, `option ${index + 1} id`, "invalid_request");
    const label = bounded(entry.label, `option ${index + 1} label`, MAX_LABEL, "invalid_request");
    if (seen.has(optionId)) throw new AskUserEnvelopeError("invalid_request", "option ids must be unique");
    seen.add(optionId);
    const recommended = entry.recommended;
    if (recommended !== undefined && typeof recommended !== "boolean") throw new AskUserEnvelopeError("invalid_request", "option recommended must be boolean");
    return recommended === undefined ? { id: optionId, label } : { id: optionId, label, recommended: recommended as boolean };
  });
}

export function parseAskUserRequest(value: unknown): AskUserRequestEnvelope {
  if (!record(value)) throw new AskUserEnvelopeError("invalid_request", "Ask-user request must be an object");
  knownKeys(value, ["kind", "requestId", "sessionId", "runId", "prompt", "options", "allowFreeText", "recommendedOptionIds", "revision", "createdAtMs", "expiresAtMs"], "invalid_request");
  if (value.kind !== "ask_user.request") throw new AskUserEnvelopeError("invalid_request", "Unknown ask-user request kind");
  const requestId = identifier(value.requestId, "requestId", "invalid_request");
  const sessionId = identifier(value.sessionId, "sessionId", "invalid_request");
  const runId = identifier(value.runId, "runId", "invalid_request");
  const prompt = bounded(value.prompt, "prompt", MAX_PROMPT, "invalid_request", true);
  const optionValues = options(value.options);
  if (typeof value.allowFreeText !== "boolean") throw new AskUserEnvelopeError("invalid_request", "allowFreeText must be boolean");
  if (!Array.isArray(value.recommendedOptionIds) || value.recommendedOptionIds.length > MAX_OPTIONS) throw new AskUserEnvelopeError("invalid_request", "recommendedOptionIds must be a bounded array");
  const optionIds = new Set(optionValues.map((option) => option.id));
  const recommendedOptionIds = value.recommendedOptionIds.map((entry, index) => identifier(entry, `recommendedOptionIds[${index}]`, "invalid_request"));
  if (new Set(recommendedOptionIds).size !== recommendedOptionIds.length || recommendedOptionIds.some((entry) => !optionIds.has(entry))) throw new AskUserEnvelopeError("invalid_request", "recommended options must name distinct existing options");
  const revision = safeInteger(value.revision, "revision", 1, "invalid_request");
  const createdAtMs = safeInteger(value.createdAtMs, "createdAtMs", 0, "invalid_request");
  let expiresAtMs: number | null = null;
  if (value.expiresAtMs !== null && value.expiresAtMs !== undefined) {
    if (typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= createdAtMs) throw new AskUserEnvelopeError("invalid_request", "expiresAtMs must be null or after createdAtMs");
    expiresAtMs = value.expiresAtMs;
  }
  return { kind: "ask_user.request", requestId, sessionId, runId, prompt, options: optionValues, allowFreeText: value.allowFreeText, recommendedOptionIds, revision, createdAtMs, expiresAtMs };
}

export function parseAskUserDecision(value: unknown): AskUserDecisionEnvelope {
  if (!record(value)) throw new AskUserEnvelopeError("invalid_decision", "Ask-user decision must be an object");
  knownKeys(value, ["kind", "requestId", "sessionId", "runId", "revision", "action", "optionId", "text", "reason"], "invalid_decision");
  if (value.kind !== "ask_user.decision") throw new AskUserEnvelopeError("invalid_decision", "Unknown ask-user decision kind");
  if (typeof value.action !== "string" || !(ACTIONS as readonly string[]).includes(value.action)) throw new AskUserEnvelopeError("invalid_decision", "Unknown ask-user decision action");
  const action = value.action as AskUserDecisionKind;
  const optionId = value.optionId == null ? null : identifier(value.optionId, "optionId", "invalid_decision");
  const text = nullableText(value.text, "text", MAX_TEXT);
  const reason = nullableText(value.reason, "reason", MAX_REASON);
  const result: AskUserDecisionEnvelope = { kind: "ask_user.decision", requestId: identifier(value.requestId, "requestId", "invalid_decision"), sessionId: identifier(value.sessionId, "sessionId", "invalid_decision"), runId: identifier(value.runId, "runId", "invalid_decision"), revision: safeInteger(value.revision, "revision", 1, "invalid_decision"), action, optionId, text, reason };
  if (action === "select" && optionId === null) throw new AskUserEnvelopeError("invalid_decision", "select requires optionId");
  if ((action === "free_text" || action === "edit") && text === null) throw new AskUserEnvelopeError("invalid_decision", `${action} requires text`);
  if ((action === "free_text" || action === "edit") && optionId !== null) throw new AskUserEnvelopeError("invalid_decision", `${action} cannot contain optionId`);
  if (action !== "free_text" && action !== "edit" && text !== null) throw new AskUserEnvelopeError("invalid_decision", `${action} cannot contain text`);
  if (action === "cancel" && optionId !== null) throw new AskUserEnvelopeError("invalid_decision", "cancel cannot contain an option");
  if (action === "cancel" && text !== null) throw new AskUserEnvelopeError("invalid_decision", "cancel cannot contain an answer");
  if (action === "select" && text !== null) throw new AskUserEnvelopeError("invalid_decision", "select cannot contain free text");
  return result;
}

interface ResolvedEntry { request: AskUserRequestEnvelope; resolution: AskUserResolution; }
export class AskUserEnvelopeBroker {
  private readonly pending = new Map<string, AskUserRequestEnvelope>();
  private readonly resolved = new Map<string, ResolvedEntry>();
  private closed = false;
  constructor(private readonly sessionId: string, private readonly runId: string, private readonly now: () => number = () => Date.now()) {
    if (!sessionId.trim() || !runId.trim()) throw new AskUserEnvelopeError("invalid_request", "sessionId and runId are required");
  }
  open(input: unknown): AskUserRequestEnvelope {
    if (this.closed) throw new AskUserEnvelopeError("closed", "Ask-user broker is closed");
    const request = parseAskUserRequest(input);
    if (request.sessionId !== this.sessionId) throw new AskUserEnvelopeError("wrong_session", "Question belongs to a different session");
    if (request.runId !== this.runId) throw new AskUserEnvelopeError("wrong_run", "Question belongs to a different run");
    if (this.pending.has(request.requestId) || this.resolved.has(request.requestId)) throw new AskUserEnvelopeError("duplicate_request", "Question request id already exists");
    this.pending.set(request.requestId, request);
    return structuredClone(request);
  }
  decide(input: unknown): AskUserResolution {
    if (this.closed) throw new AskUserEnvelopeError("closed", "Ask-user broker is closed");
    const decision = parseAskUserDecision(input);
    const tombstone = this.resolved.get(decision.requestId);
    if (tombstone) {
      const expired = tombstone.resolution.status === "expired";
      throw new AskUserEnvelopeError(expired ? "expired" : "already_resolved", expired ? "Question expired and is no longer pending" : "Question is no longer pending");
    }
    const request = this.pending.get(decision.requestId);
    if (!request) throw new AskUserEnvelopeError("unknown_request", "Question request id is unknown");
    if (decision.sessionId !== this.sessionId || decision.sessionId !== request.sessionId) throw new AskUserEnvelopeError("wrong_session", "Decision belongs to a different session");
    if (decision.runId !== this.runId || decision.runId !== request.runId) throw new AskUserEnvelopeError("wrong_run", "Decision belongs to a different run");
    if (decision.revision !== request.revision) throw new AskUserEnvelopeError("stale_revision", "Decision revision is stale");
    if (request.expiresAtMs !== null && this.now() >= request.expiresAtMs) {
      const resolution = this.finalize(request, "expired", "cancel", null, null, "timeout");
      throw new AskUserEnvelopeError("expired", `Question expired at ${resolution.resolvedAtMs}`);
    }
    if (decision.action === "select" && !request.options.some((option) => option.id === decision.optionId)) throw new AskUserEnvelopeError("invalid_decision", "Selected option is not part of the request");
    if ((decision.action === "free_text" || decision.action === "edit") && !request.allowFreeText) throw new AskUserEnvelopeError("invalid_decision", "Free-text answers are disabled for this question");
    const status: AskUserResolutionStatus = decision.action === "cancel" ? "cancelled" : decision.action === "reject" ? "rejected" : "answered";
    return this.finalize(request, status, decision.action, decision.optionId, decision.text, decision.reason);
  }
  cancel(requestId: string, reason = "user_cancelled"): AskUserResolution {
    const request = this.pending.get(requestId);
    if (!request) {
      const tombstone = this.resolved.get(requestId);
      if (tombstone) { const expired = tombstone.resolution.status === "expired"; throw new AskUserEnvelopeError(expired ? "expired" : "already_resolved", expired ? "Question expired and is no longer pending" : "Question is no longer pending"); }
      throw new AskUserEnvelopeError("unknown_request", "Question request id is unknown");
    }
    return this.decide({ kind: "ask_user.decision", requestId, sessionId: this.sessionId, runId: this.runId, revision: request.revision, action: "cancel", optionId: null, text: null, reason });
  }
  close(reason = "run_closed"): AskUserResolution[] {
    if (this.closed) return [];
    this.closed = true;
    const current = [...this.pending.values()];
    this.pending.clear();
    return current.map((request) => {
      const resolution = this.makeResolution(request, "cancelled", "cancel", null, null, reason.slice(0, MAX_REASON));
      this.resolved.set(request.requestId, { request, resolution });
      return structuredClone(resolution);
    });
  }
  pendingRequests(): AskUserPendingSnapshot[] { return [...this.pending.values()].map((request) => ({ request: structuredClone(request), status: "pending" as const })); }
  private makeResolution(request: AskUserRequestEnvelope, status: AskUserResolutionStatus, action: AskUserDecisionKind, optionId: string | null, text: string | null, reason: string | null): AskUserResolution { return { requestId: request.requestId, sessionId: request.sessionId, runId: request.runId, revision: request.revision, status, action, optionId, text, reason, resolvedAtMs: this.now() }; }
  private finalize(request: AskUserRequestEnvelope, status: AskUserResolutionStatus, action: AskUserDecisionKind, optionId: string | null, text: string | null, reason: string | null): AskUserResolution { this.pending.delete(request.requestId); const resolution = this.makeResolution(request, status, action, optionId, text, reason); this.resolved.set(request.requestId, { request, resolution }); return structuredClone(resolution); }
}

