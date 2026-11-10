import { assertDomain } from "./errors";
import { freezeJson, stableSort, type JsonObject, type JsonValue } from "./shared";

/**
 * 150+ tok/s Ultra-Optimal Streaming Harness & Native Gateway Acceleration.
 *
 * Provides three pure, deterministic domain subsystems:
 * 1. Adaptive Frame-Budget Delta Coalescer (`createStreamDeltaCoalescer`)
 * 2. KV-Cache Prefix Canonicalizer (`buildCacheStableProviderPayload`)
 * 3. Stream Throughput & Bottleneck Telemetry Calculator (`computeStreamThroughputMetrics`)
 */

export const DEFAULT_TARGET_TOKENS_PER_SECOND = 150;
export const FRAME_BUDGET_120FPS_MS = 8;
export const FRAME_BUDGET_60FPS_MS = 16;
export const DEFAULT_MAX_BATCH_CHARS = 32_768;
export const DEFAULT_MAX_BATCH_DELTAS = 128;
export const DEFAULT_ROLLING_WINDOW_MS = 1_000;

export type FrameBudgetPresetMs = typeof FRAME_BUDGET_120FPS_MS | typeof FRAME_BUDGET_60FPS_MS;

export interface StreamDeltaInput {
  readonly textDelta?: string;
  readonly reasoningDelta?: string;
  readonly tokenCount?: number;
  readonly sequence?: number;
  readonly receivedAtMs?: number;
}

export interface CoalescedStreamFrameBatch {
  readonly batchSequence: number;
  readonly textDelta: string;
  readonly reasoningDelta: string;
  readonly coalescedDeltaCount: number;
  readonly estimatedTokenCount: number;
  readonly firstDeltaAtMs: number;
  readonly flushedAtMs: number;
  readonly frameWindowMs: number;
  readonly firstSourceSequence?: number;
  readonly lastSourceSequence?: number;
}

export interface StreamDeltaCoalescerStats {
  readonly rawDeltaCount: number;
  readonly flushedBatchCount: number;
  readonly pendingDeltaCount: number;
  readonly pendingTextChars: number;
  readonly pendingReasoningChars: number;
  readonly totalTextCharsProcessed: number;
  readonly totalReasoningCharsProcessed: number;
  readonly totalEstimatedTokens: number;
  readonly coalescedWriteRatio: number;
  readonly coalescingCompressionFactor: number;
  readonly estimatedStateClonesSaved: number;
  readonly frameBudgetMs: number;
}

export type TimerHandle = unknown;

export interface StreamDeltaCoalescerOptions {
  /**
   * Frame budget in milliseconds. Use `8` for 120fps or `16` for 60fps.
   * Defaults to `8` (120fps) for ultra-low-latency high-throughput rendering.
   */
  readonly frameBudgetMs?: number;
  /**
   * Optional target refresh rate (`60` or `120`). Used when `frameBudgetMs`
   * is not explicitly provided.
   */
  readonly targetFps?: 60 | 120;
  /**
   * Maximum accumulated character count before forcing an immediate synchronous
   * flush prior to timer expiration. Defaults to 32,768 chars.
   */
  readonly maxBatchChars?: number;
  /**
   * Maximum number of raw SSE deltas accumulated in a single frame before
   * forcing an immediate synchronous flush. Defaults to 128 deltas.
   */
  readonly maxBatchDeltas?: number;
  /**
   * Callback invoked whenever a coalesced frame batch is flushed.
   */
  readonly onFlush: (batch: CoalescedStreamFrameBatch) => void;
  /**
   * Monotonic clock provider in milliseconds (defaults to `Date.now`).
   */
  readonly now?: () => number;
  /**
   * Custom timer scheduler (defaults to `globalThis.setTimeout`).
   */
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  /**
   * Custom timer canceller (defaults to `globalThis.clearTimeout`).
   */
  readonly cancelTimer?: (handle: TimerHandle) => void;
}

export interface StreamDeltaCoalescer {
  /**
   * Push a raw token delta (either a string or a structured `StreamDeltaInput`).
   * Returns the flushed batch if an immediate threshold flush was triggered,
   * or `null` if the delta was buffered for the current frame window.
   */
  push(input: string | StreamDeltaInput): CoalescedStreamFrameBatch | null;
  /**
   * Convenience method to push an assistant text delta string.
   */
  pushTextDelta(textDelta: string, receivedAtMs?: number): CoalescedStreamFrameBatch | null;
  /**
   * Convenience method to push a reasoning/thinking delta string.
   */
  pushReasoningDelta(
    reasoningDelta: string,
    receivedAtMs?: number,
  ): CoalescedStreamFrameBatch | null;
  /**
   * Immediately flushes any buffered deltas and cancels any pending timer.
   * Must be called before stream completion, error termination, or tool-call handoff.
   */
  flush(): CoalescedStreamFrameBatch | null;
  /**
   * Discards any buffered deltas without invoking `onFlush` and cancels any active timer.
   */
  cancel(): void;
  /**
   * Flushes remaining deltas and marks the coalescer disposed.
   */
  dispose(): CoalescedStreamFrameBatch | null;
  /**
   * Returns `true` when there are buffered deltas waiting for the frame timer.
   */
  isPending(): boolean;
  /**
   * Dynamically updates the frame budget (`8ms` for 120fps, `16ms` for 60fps).
   */
  setFrameBudgetMs(frameBudgetMs: number): void;
  /**
   * Returns a frozen snapshot of coalescing efficiency metrics.
   */
  getStats(): StreamDeltaCoalescerStats;
}

function resolveFrameBudgetMs(
  frameBudgetMs: number | undefined,
  targetFps: 60 | 120 | undefined,
): number {
  if (frameBudgetMs !== undefined) {
    assertDomain(
      Number.isFinite(frameBudgetMs) && frameBudgetMs >= 1 && frameBudgetMs <= 1_000,
      "invalid_argument",
      "frameBudgetMs must be a finite number between 1 and 1000.",
      { frameBudgetMs },
    );
    return Math.round(frameBudgetMs);
  }
  if (targetFps === 60) {
    return FRAME_BUDGET_60FPS_MS;
  }
  return FRAME_BUDGET_120FPS_MS;
}

function estimateTokenCountFromChars(textChars: number, reasoningChars: number): number {
  const totalChars = textChars + reasoningChars;
  if (totalChars <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(totalChars / 4));
}

/**
 * Creates an adaptive frame-budget delta coalescer that batches rapid incoming
 * token deltas into `8ms` (`120fps`) or `16ms` (`60fps`) frame windows,
 * eliminating per-token `O(N)` React state clones and full-string Markdown re-parses.
 */
export function createStreamDeltaCoalescer(
  options: StreamDeltaCoalescerOptions,
): StreamDeltaCoalescer {
  assertDomain(
    typeof options.onFlush === "function",
    "invalid_argument",
    "StreamDeltaCoalescer requires an onFlush callback.",
  );

  let frameBudgetMs = resolveFrameBudgetMs(options.frameBudgetMs, options.targetFps);
  const maxBatchChars = options.maxBatchChars ?? DEFAULT_MAX_BATCH_CHARS;
  const maxBatchDeltas = options.maxBatchDeltas ?? DEFAULT_MAX_BATCH_DELTAS;

  assertDomain(
    Number.isInteger(maxBatchChars) && maxBatchChars >= 1,
    "invalid_argument",
    "maxBatchChars must be a positive integer.",
    { maxBatchChars },
  );
  assertDomain(
    Number.isInteger(maxBatchDeltas) && maxBatchDeltas >= 1,
    "invalid_argument",
    "maxBatchDeltas must be a positive integer.",
    { maxBatchDeltas },
  );

  const now = options.now ?? (() => Date.now());
  const scheduleTimer =
    options.scheduleTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelTimer =
    options.cancelTimer ??
    ((handle: TimerHandle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  let pendingTextParts: string[] = [];
  let pendingReasoningParts: string[] = [];
  let pendingTextChars = 0;
  let pendingReasoningChars = 0;
  let pendingDeltaCount = 0;
  let pendingTokenCount = 0;
  let firstDeltaAtMs: number | null = null;
  let firstSourceSequence: number | undefined;
  let lastSourceSequence: number | undefined;
  let activeTimer: TimerHandle | null = null;
  let disposed = false;

  let rawDeltaCount = 0;
  let flushedBatchCount = 0;
  let totalTextCharsProcessed = 0;
  let totalReasoningCharsProcessed = 0;
  let totalEstimatedTokens = 0;

  function clearActiveTimer(): void {
    if (activeTimer !== null) {
      const handle = activeTimer;
      activeTimer = null;
      cancelTimer(handle);
    }
  }

  function flushInternal(): CoalescedStreamFrameBatch | null {
    clearActiveTimer();
    if (pendingDeltaCount === 0) {
      return null;
    }

    const flushedAtMs = now();
    const startedAtMs = firstDeltaAtMs ?? flushedAtMs;
    const textDelta = pendingTextParts.length === 1 ? pendingTextParts[0]! : pendingTextParts.join("");
    const reasoningDelta =
      pendingReasoningParts.length === 1
        ? pendingReasoningParts[0]!
        : pendingReasoningParts.join("");
    const coalescedDeltaCount = pendingDeltaCount;
    const estimatedTokenCount =
      pendingTokenCount > 0
        ? pendingTokenCount
        : estimateTokenCountFromChars(pendingTextChars, pendingReasoningChars);
    const batchSequence = flushedBatchCount;
    const capturedFirstSeq = firstSourceSequence;
    const capturedLastSeq = lastSourceSequence;

    pendingTextParts = [];
    pendingReasoningParts = [];
    pendingTextChars = 0;
    pendingReasoningChars = 0;
    pendingDeltaCount = 0;
    pendingTokenCount = 0;
    firstDeltaAtMs = null;
    firstSourceSequence = undefined;
    lastSourceSequence = undefined;

    flushedBatchCount += 1;
    totalEstimatedTokens += estimatedTokenCount;

    const batch: CoalescedStreamFrameBatch = Object.freeze({
      batchSequence,
      textDelta,
      reasoningDelta,
      coalescedDeltaCount,
      estimatedTokenCount,
      firstDeltaAtMs: startedAtMs,
      flushedAtMs: Math.max(startedAtMs, flushedAtMs),
      frameWindowMs: Math.max(0, flushedAtMs - startedAtMs),
      ...(capturedFirstSeq === undefined ? {} : { firstSourceSequence: capturedFirstSeq }),
      ...(capturedLastSeq === undefined ? {} : { lastSourceSequence: capturedLastSeq }),
    });

    options.onFlush(batch);
    return batch;
  }

  function push(input: string | StreamDeltaInput): CoalescedStreamFrameBatch | null {
    assertDomain(!disposed, "invalid_state_transition", "Cannot push to a disposed coalescer.");

    const normalized: StreamDeltaInput =
      typeof input === "string" ? { textDelta: input } : input;
    const textDelta = normalized.textDelta ?? "";
    const reasoningDelta = normalized.reasoningDelta ?? "";

    if (textDelta.length === 0 && reasoningDelta.length === 0) {
      return null;
    }

    const timestampMs = normalized.receivedAtMs ?? now();
    rawDeltaCount += 1;
    pendingDeltaCount += 1;

    if (firstDeltaAtMs === null) {
      firstDeltaAtMs = timestampMs;
    }
    if (normalized.sequence !== undefined) {
      if (firstSourceSequence === undefined) {
        firstSourceSequence = normalized.sequence;
      }
      lastSourceSequence = normalized.sequence;
    }

    if (textDelta.length > 0) {
      pendingTextParts.push(textDelta);
      pendingTextChars += textDelta.length;
      totalTextCharsProcessed += textDelta.length;
    }
    if (reasoningDelta.length > 0) {
      pendingReasoningParts.push(reasoningDelta);
      pendingReasoningChars += reasoningDelta.length;
      totalReasoningCharsProcessed += reasoningDelta.length;
    }

    const deltaTokens =
      normalized.tokenCount !== undefined && normalized.tokenCount > 0
        ? normalized.tokenCount
        : 1;
    pendingTokenCount += deltaTokens;

    const totalPendingChars = pendingTextChars + pendingReasoningChars;
    if (totalPendingChars >= maxBatchChars || pendingDeltaCount >= maxBatchDeltas) {
      return flushInternal();
    }

    if (activeTimer === null) {
      activeTimer = scheduleTimer(() => {
        activeTimer = null;
        flushInternal();
      }, frameBudgetMs);
    }

    return null;
  }

  function pushTextDelta(
    textDelta: string,
    receivedAtMs?: number,
  ): CoalescedStreamFrameBatch | null {
    return push(
      receivedAtMs === undefined ? { textDelta } : { textDelta, receivedAtMs },
    );
  }

  function pushReasoningDelta(
    reasoningDelta: string,
    receivedAtMs?: number,
  ): CoalescedStreamFrameBatch | null {
    return push(
      receivedAtMs === undefined ? { reasoningDelta } : { reasoningDelta, receivedAtMs },
    );
  }

  function cancel(): void {
    clearActiveTimer();
    pendingTextParts = [];
    pendingReasoningParts = [];
    pendingTextChars = 0;
    pendingReasoningChars = 0;
    pendingDeltaCount = 0;
    pendingTokenCount = 0;
    firstDeltaAtMs = null;
    firstSourceSequence = undefined;
    lastSourceSequence = undefined;
  }

  function dispose(): CoalescedStreamFrameBatch | null {
    if (disposed) {
      return null;
    }
    const finalBatch = flushInternal();
    disposed = true;
    return finalBatch;
  }

  function setFrameBudgetMs(nextBudgetMs: number): void {
    frameBudgetMs = resolveFrameBudgetMs(nextBudgetMs, undefined);
  }

  function getStats(): StreamDeltaCoalescerStats {
    const effectiveBatches = flushedBatchCount + (pendingDeltaCount > 0 ? 1 : 0);
    const savedClones = Math.max(0, rawDeltaCount - effectiveBatches);
    const coalescedWriteRatio =
      rawDeltaCount > 0 ? Number((savedClones / rawDeltaCount).toFixed(6)) : 0;
    const coalescingCompressionFactor =
      flushedBatchCount > 0
        ? Number((rawDeltaCount / flushedBatchCount).toFixed(4))
        : rawDeltaCount > 0
          ? rawDeltaCount
          : 1;

    return Object.freeze({
      rawDeltaCount,
      flushedBatchCount,
      pendingDeltaCount,
      pendingTextChars,
      pendingReasoningChars,
      totalTextCharsProcessed,
      totalReasoningCharsProcessed,
      totalEstimatedTokens,
      coalescedWriteRatio,
      coalescingCompressionFactor,
      estimatedStateClonesSaved: savedClones,
      frameBudgetMs,
    });
  }

  return Object.freeze({
    push,
    pushTextDelta,
    pushReasoningDelta,
    flush: flushInternal,
    cancel,
    dispose,
    isPending: () => pendingDeltaCount > 0,
    setFrameBudgetMs,
    getStats,
  });
}

// ============================================================================
// 2. KV-Cache Prefix Canonicalizer (`buildCacheStableProviderPayload`)
// ============================================================================

export type CacheStableProviderFamily =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "vllm"
  | "sglang"
  | "openrouter";

export interface CacheStableSkillHeader {
  readonly id: string;
  readonly title?: string;
  readonly content: string;
}

export interface CacheStableToolDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
}

export type CacheStableMessageRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface CacheStableMessage {
  readonly role: CacheStableMessageRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface CacheStablePayloadInput {
  readonly providerFamily: CacheStableProviderFamily;
  readonly model: string;
  readonly systemInstructions?: readonly string[];
  readonly skillHeaders?: readonly CacheStableSkillHeader[];
  readonly tools?: readonly CacheStableToolDeclaration[];
  readonly messages: readonly CacheStableMessage[];
  /**
   * When `true` (default `true`), strips redundant whitespace from tool
   * descriptions, removes non-semantic schema keys (`$comment`, `examples`),
   * and lexicographically orders all JSON Schema keys to maximize KV-cache hit
   * rate and reduce prefill token count.
   */
  readonly compactToolSchemas?: boolean;
  /**
   * When `true` (default `true`), emits provider-native cache breakpoints and
   * deterministic `prompt_cache_key` hints.
   */
  readonly enableExplicitCacheBreakpoints?: boolean;
  /**
   * Optional workspace or profile routing salt included in `prompt_cache_key`
   * without polluting the prompt text.
   */
  readonly cacheKeySalt?: string;
}

export interface CacheBreakpointDescriptor {
  readonly target: "system" | "tools" | "conversation-prefix";
  readonly messageIndex?: number;
  readonly cacheControl: Readonly<{
    readonly type: "ephemeral";
    readonly ttl?: "5m" | "1h";
  }>;
}

export interface CacheStableProviderPayload {
  readonly providerFamily: CacheStableProviderFamily;
  readonly model: string;
  /**
   * Deterministically ordered system block combining `systemInstructions`,
   * sorted `skillHeaders`, and leading `system`/`developer` messages.
   */
  readonly canonicalSystemBlock: string;
  /**
   * Deterministically sorted and canonicalized tool declarations.
   */
  readonly canonicalTools: readonly CacheStableToolDeclaration[];
  /**
   * Ordered messages with leading `system`/`developer` blocks hoisted into the
   * stable prefix so prefix token positions never shift across turns.
   */
  readonly orderedMessages: readonly CacheStableMessage[];
  /**
   * Non-system conversation turn messages in canonical order.
   */
  readonly conversationMessages: readonly CacheStableMessage[];
  /**
   * 64-character hex digest of the invariant static prefix
   * (`model` + `canonicalSystemBlock` + `canonicalTools`).
   * Identical across all turns of a conversation regardless of tool/skill input order.
   */
  readonly staticPrefixHash: string;
  /**
   * 64-character hex digest of the full cacheable prefix up to the latest
   * historical turn before the final active user message.
   */
  readonly prefixHash: string;
  readonly estimatedStaticPrefixTokens: number;
  readonly estimatedTotalPrefixTokens: number;
  readonly estimatedToolSchemaBytesSaved: number;
  readonly cacheBreakpoints: readonly CacheBreakpointDescriptor[];
  readonly providerHints: JsonObject;
}

const NON_SEMANTIC_SCHEMA_KEYS = new Set(["$comment", "examples", "$id"]);

function normalizeInlineWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeMultilineText(value: string): string {
  return value
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/gu, ""))
    .join("\n")
    .trim();
}

function canonicalizeJsonValue(value: JsonValue, compactSchema: boolean): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJsonValue(entry as JsonValue, compactSchema));
  }
  if (value !== null && typeof value === "object") {
    const record = value as JsonObject;
    const keys = Object.keys(record)
      .filter((key) => !(compactSchema && NON_SEMANTIC_SCHEMA_KEYS.has(key)))
      .sort((left, right) => left.localeCompare(right));
    const result: Record<string, JsonValue> = {};
    for (const key of keys) {
      const entryValue = record[key];
      if (entryValue === undefined) {
        continue;
      }
      if (compactSchema && key === "description" && typeof entryValue === "string") {
        const compacted = normalizeInlineWhitespace(entryValue);
        if (compacted.length > 0) {
          result[key] = compacted;
        }
        continue;
      }
      result[key] = canonicalizeJsonValue(entryValue, compactSchema);
    }
    return result;
  }
  return value;
}

/**
 * Deterministic 256-bit (64-hex-char) hash built from 8 independent 32-bit
 * FNV-1a / Murmur3-finalizer lanes so prefix hashes are synchronous,
 * dependency-free, and collision-resistant across browser and native runtimes.
 */
export function computeDeterministicHexHash256(input: string): string {
  const seeds = [
    0x811c9dc5,
    0x9e3779b9,
    0x85ebca6b,
    0xc2b2ae35,
    0x27d4eb2f,
    0x165667b1,
    0xd3a2646c,
    0xfd7046c5,
  ];
  const hashes = [...seeds];
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    for (let lane = 0; lane < 8; lane += 1) {
      let h = hashes[lane]! ^ (code + lane * 0x9e37);
      h = Math.imul(h, 0x01000193);
      h ^= h >>> 13;
      hashes[lane] = h >>> 0;
    }
  }
  return hashes
    .map((h, lane) => {
      let mixed = h ^ (input.length + lane * 0x85ebca6b);
      mixed ^= mixed >>> 16;
      mixed = Math.imul(mixed, 0x85ebca6b);
      mixed ^= mixed >>> 13;
      mixed = Math.imul(mixed, 0xc2b2ae35);
      mixed ^= mixed >>> 16;
      return (mixed >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
}

/**
 * Deterministically orders system instructions, static skill headers, tool
 * declarations, and conversation history prefix so custom OpenAI-compatible,
 * vLLM, SGLang, OpenRouter, Anthropic, and Gemini endpoints achieve maximum
 * KV-cache hit rate (`prefixHash` stability).
 */
export function buildCacheStableProviderPayload(
  input: CacheStablePayloadInput,
): CacheStableProviderPayload {
  const model = input.model.trim();
  assertDomain(model.length > 0, "invalid_argument", "model cannot be empty.");

  const compactToolSchemas = input.compactToolSchemas ?? true;
  const enableExplicitCacheBreakpoints = input.enableExplicitCacheBreakpoints ?? true;

  // 1. Canonicalize system instructions (preserving intentional instruction order, stripping blank entries)
  const systemSegments: string[] = [];
  for (const instruction of input.systemInstructions ?? []) {
    const normalized = normalizeMultilineText(instruction);
    if (normalized.length > 0) {
      systemSegments.push(normalized);
    }
  }

  // 2. Deterministically sort static skill headers by `id` then `title` so arbitrary
  // registration/discovery order never invalidates the KV cache prefix.
  const sortedSkills = stableSort(input.skillHeaders ?? [], (left, right) => {
    const idCmp = left.id.trim().localeCompare(right.id.trim());
    if (idCmp !== 0) {
      return idCmp;
    }
    return (left.title ?? "").trim().localeCompare((right.title ?? "").trim());
  });

  for (const skill of sortedSkills) {
    const skillId = skill.id.trim();
    const skillBody = normalizeMultilineText(skill.content);
    if (skillBody.length === 0) {
      continue;
    }
    const headerLabel = skill.title ? `${skillId}: ${skill.title.trim()}` : skillId;
    systemSegments.push(`[Skill ${headerLabel}]\n${skillBody}`);
  }

  // 3. Partition messages: hoist all system/developer messages into the canonical
  // system prefix so they never interleave with dynamic turn history.
  const conversationMessages: CacheStableMessage[] = [];
  for (const message of input.messages) {
    const normalizedContent = normalizeMultilineText(message.content);
    if (message.role === "system" || message.role === "developer") {
      if (normalizedContent.length > 0) {
        systemSegments.push(normalizedContent);
      }
      continue;
    }
    conversationMessages.push(
      Object.freeze({
        role: message.role,
        content: normalizedContent,
        ...(message.name === undefined ? {} : { name: message.name.trim() }),
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId.trim() }),
      }),
    );
  }

  const canonicalSystemBlock = systemSegments.join("\n\n");

  // 4. Canonicalize and deterministically sort tool declarations by `name`.
  let rawToolBytes = 0;
  let canonicalToolBytes = 0;
  const sortedTools = stableSort(input.tools ?? [], (left, right) =>
    left.name.trim().localeCompare(right.name.trim()),
  );

  const canonicalTools: CacheStableToolDeclaration[] = sortedTools.map((tool) => {
    const rawSerialized = JSON.stringify(tool);
    rawToolBytes += rawSerialized.length;

    const normalizedName = tool.name.trim();
    assertDomain(normalizedName.length > 0, "invalid_argument", "Tool name cannot be empty.");
    const rawDescription = tool.description?.trim() ?? "";
    const normalizedDescription = compactToolSchemas
      ? normalizeInlineWhitespace(rawDescription)
      : rawDescription;
    const canonicalSchema = freezeJson(
      canonicalizeJsonValue(tool.inputSchema, compactToolSchemas) as JsonObject,
    );

    const canonicalTool: CacheStableToolDeclaration = Object.freeze({
      name: normalizedName,
      ...(normalizedDescription.length > 0 ? { description: normalizedDescription } : {}),
      inputSchema: canonicalSchema,
    });
    canonicalToolBytes += JSON.stringify(canonicalTool).length;
    return canonicalTool;
  });

  const estimatedToolSchemaBytesSaved = Math.max(0, rawToolBytes - canonicalToolBytes);

  // 5. Build orderedMessages with a single leading canonical system message (if non-empty)
  // followed by the conversation history.
  const orderedMessages: CacheStableMessage[] = [];
  if (canonicalSystemBlock.length > 0) {
    orderedMessages.push(
      Object.freeze({
        role: "system",
        content: canonicalSystemBlock,
      }),
    );
  }
  orderedMessages.push(...conversationMessages);

  // 6. Compute deterministic staticPrefixHash and full prefixHash.
  const saltPrefix = input.cacheKeySalt ? `${input.cacheKeySalt.trim()}:` : "";
  const staticPrefixMaterial = JSON.stringify({
    salt: saltPrefix,
    model,
    system: canonicalSystemBlock,
    tools: canonicalTools,
  });
  const staticPrefixHash = computeDeterministicHexHash256(staticPrefixMaterial);

  // Stable conversation prefix includes all turns prior to the final active user turn
  // (or all turns if there is only 1 turn).
  const stableHistoryTurns =
    conversationMessages.length > 1
      ? conversationMessages.slice(0, conversationMessages.length - 1)
      : [];
  const fullPrefixMaterial = JSON.stringify({
    staticPrefixHash,
    history: stableHistoryTurns,
  });
  const prefixHash = computeDeterministicHexHash256(fullPrefixMaterial);

  const staticPrefixChars = canonicalSystemBlock.length + canonicalToolBytes;
  const historyPrefixChars = stableHistoryTurns.reduce(
    (sum, msg) => sum + msg.content.length + 12,
    0,
  );
  const estimatedStaticPrefixTokens = Math.ceil(staticPrefixChars / 4);
  const estimatedTotalPrefixTokens = Math.ceil((staticPrefixChars + historyPrefixChars) / 4);

  // 7. Build provider-native cache breakpoints and routing hints.
  const cacheBreakpoints: CacheBreakpointDescriptor[] = [];
  if (enableExplicitCacheBreakpoints) {
    if (canonicalSystemBlock.length > 0) {
      cacheBreakpoints.push(
        Object.freeze({
          target: "system",
          cacheControl: Object.freeze({ type: "ephemeral" }),
        }),
      );
    }
    if (canonicalTools.length > 0) {
      cacheBreakpoints.push(
        Object.freeze({
          target: "tools",
          cacheControl: Object.freeze({ type: "ephemeral" }),
        }),
      );
    }
    if (stableHistoryTurns.length > 0) {
      cacheBreakpoints.push(
        Object.freeze({
          target: "conversation-prefix",
          messageIndex: stableHistoryTurns.length - 1,
          cacheControl: Object.freeze({ type: "ephemeral" }),
        }),
      );
    }
  }

  const promptCacheKey = `omnia_kv_${staticPrefixHash.slice(0, 32)}`;
  const providerHints = freezeJson({
    promptCacheKey,
    staticPrefixHash,
    prefixHash,
    ...(input.providerFamily === "vllm" ||
    input.providerFamily === "sglang" ||
    input.providerFamily === "openai-compatible" ||
    input.providerFamily === "openrouter"
      ? {
          prompt_cache_key: promptCacheKey,
          cache_prefix_hash: prefixHash,
        }
      : {}),
  });

  return Object.freeze({
    providerFamily: input.providerFamily,
    model,
    canonicalSystemBlock,
    canonicalTools: Object.freeze(canonicalTools),
    orderedMessages: Object.freeze(orderedMessages),
    conversationMessages: Object.freeze(conversationMessages),
    staticPrefixHash,
    prefixHash,
    estimatedStaticPrefixTokens,
    estimatedTotalPrefixTokens,
    estimatedToolSchemaBytesSaved,
    cacheBreakpoints: Object.freeze(cacheBreakpoints),
    providerHints,
  });
}

// ============================================================================
// 3. Throughput & Bottleneck Telemetry Calculator (`computeStreamThroughputMetrics`)
// ============================================================================

export interface StreamTokenTimestampSample {
  readonly timestampMs: number;
  readonly tokenCount?: number;
  readonly byteLength?: number;
}

export interface StreamThroughputTelemetryInput {
  readonly requestDispatchedAtMs: number;
  readonly firstTokenAtMs?: number;
  readonly completedAtMs?: number;
  readonly outputTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly rawSseDeltaCount: number;
  readonly persistedSqliteBatchCount: number;
  readonly emittedIpcBatchCount?: number;
  readonly tcpChunkCount?: number;
  readonly tokenSamples?: readonly StreamTokenTimestampSample[];
  readonly rollingWindowMs?: number;
  readonly targetTokensPerSecond?: number;
}

export interface InterTokenLatencyDistribution {
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly jitterMs: number;
}

export type StreamBottleneckKind =
  | "none"
  | "ipc-sqlite-bound"
  | "network-bound"
  | "provider-compute-bound"
  | "ttft-prefill-bound";

export interface StreamBottleneckDiagnosis {
  readonly primaryBottleneck: StreamBottleneckKind;
  readonly isIpcSqliteBound: boolean;
  readonly isNetworkBound: boolean;
  readonly isProviderComputeBound: boolean;
  readonly isPrefillBound: boolean;
  readonly severity: "optimal" | "warning" | "critical";
  readonly summary: string;
  readonly recommendations: readonly string[];
}

export interface StreamThroughputMetrics {
  /**
   * Sustained token generation throughput after the first token (`outputTokens / decodeDurationSec`),
   * or overall throughput when only a single timestamp is available.
   */
  readonly tokensPerSecond: number;
  /**
   * End-to-end throughput including prefill (`outputTokens / totalDurationSec`).
   */
  readonly totalTokensPerSecond: number;
  /**
   * Instantaneous throughput computed from the most recent token arrival interval.
   */
  readonly instantTokensPerSecond: number;
  /**
   * Rolling-window throughput computed over `rollingWindowMs` (default 1000ms).
   */
  readonly rollingWindowTokensPerSecond: number;
  /**
   * Time to first token (`firstTokenAtMs - requestDispatchedAtMs`).
   */
  readonly timeToFirstTokenMs: number;
  /**
   * Mean inter-token latency in milliseconds.
   */
  readonly interTokenLatencyMs: number;
  /**
   * Detailed inter-token latency percentiles and jitter distribution.
   */
  readonly interTokenLatencyDistribution: InterTokenLatencyDistribution;
  /**
   * Fraction of raw token deltas coalesced away before hitting SQLite (`[0, 1]`).
   */
  readonly coalescedWriteRatio: number;
  /**
   * Compression factor (`rawSseDeltaCount / persistedSqliteBatchCount`).
   */
  readonly coalescingCompressionFactor: number;
  /**
   * Exact count of synchronous SQLite disk transactions eliminated by chunk/frame coalescing.
   */
  readonly estimatedSqliteTransactionsSaved: number;
  /**
   * Exact count of Tauri/renderer IPC events eliminated by coalescing.
   */
  readonly estimatedIpcEventsSaved: number;
  /**
   * Ratio of cached input tokens to total input tokens (`[0, 1]`).
   */
  readonly kvCacheHitRatio: number;
  /**
   * Whether `tokensPerSecond` meets or exceeds `targetTokensPerSecond` (default `150` tok/s).
   */
  readonly meetsTargetThroughput: boolean;
  readonly targetTokensPerSecond: number;
  readonly bottleneckDiagnosis: StreamBottleneckDiagnosis;
}

function computePercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0]!;
  }
  const clamped = Math.max(0, Math.min(100, percentile));
  const index = (clamped / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sortedValues[lower]!;
  }
  const weight = index - lower;
  return sortedValues[lower]! * (1 - weight) + sortedValues[upper]! * weight;
}

/**
 * Computes comprehensive streaming throughput metrics (`tokensPerSecond`,
 * `timeToFirstTokenMs`, `interTokenLatencyMs`, `coalescedWriteRatio`,
 * `estimatedSqliteTransactionsSaved`, `kvCacheHitRatio`) and diagnoses whether
 * a stream is IPC/SQLite-bound, network-bound, prefill-bound, or provider-compute-bound.
 */
export function computeStreamThroughputMetrics(
  input: StreamThroughputTelemetryInput,
): StreamThroughputMetrics {
  assertDomain(
    Number.isFinite(input.requestDispatchedAtMs) && input.requestDispatchedAtMs >= 0,
    "invalid_argument",
    "requestDispatchedAtMs must be a non-negative finite number.",
  );
  assertDomain(
    Number.isFinite(input.outputTokens) && input.outputTokens >= 0,
    "invalid_argument",
    "outputTokens must be a non-negative finite number.",
  );
  assertDomain(
    Number.isInteger(input.rawSseDeltaCount) && input.rawSseDeltaCount >= 0,
    "invalid_argument",
    "rawSseDeltaCount must be a non-negative integer.",
  );
  assertDomain(
    Number.isInteger(input.persistedSqliteBatchCount) && input.persistedSqliteBatchCount >= 0,
    "invalid_argument",
    "persistedSqliteBatchCount must be a non-negative integer.",
  );

  const targetTokensPerSecond =
    input.targetTokensPerSecond ?? DEFAULT_TARGET_TOKENS_PER_SECOND;
  const rollingWindowMs = input.rollingWindowMs ?? DEFAULT_ROLLING_WINDOW_MS;

  const sortedSamples = stableSort(
    input.tokenSamples ?? [],
    (left, right) => left.timestampMs - right.timestampMs,
  );

  const inferredFirstTokenMs =
    input.firstTokenAtMs ??
    (sortedSamples.length > 0 ? sortedSamples[0]!.timestampMs : input.requestDispatchedAtMs);
  const inferredCompletedMs =
    input.completedAtMs ??
    (sortedSamples.length > 0
      ? sortedSamples[sortedSamples.length - 1]!.timestampMs
      : inferredFirstTokenMs);

  const timeToFirstTokenMs = Math.max(0, inferredFirstTokenMs - input.requestDispatchedAtMs);
  const totalDurationMs = Math.max(1, inferredCompletedMs - input.requestDispatchedAtMs);
  const decodeDurationMs = Math.max(0, inferredCompletedMs - inferredFirstTokenMs);

  const tokensPerSecond =
    input.outputTokens <= 0
      ? 0
      : decodeDurationMs > 0
        ? Number(((input.outputTokens / decodeDurationMs) * 1_000).toFixed(2))
        : Number(((input.outputTokens / totalDurationMs) * 1_000).toFixed(2));

  const totalTokensPerSecond =
    input.outputTokens <= 0
      ? 0
      : Number(((input.outputTokens / totalDurationMs) * 1_000).toFixed(2));

  // Inter-token latency distribution & instant / rolling throughput
  const intervalsMs: number[] = [];
  for (let i = 1; i < sortedSamples.length; i += 1) {
    const deltaMs = Math.max(0, sortedSamples[i]!.timestampMs - sortedSamples[i - 1]!.timestampMs);
    intervalsMs.push(deltaMs);
  }

  let interTokenLatencyDistribution: InterTokenLatencyDistribution;
  if (intervalsMs.length > 0) {
    const sortedIntervals = [...intervalsMs].sort((a, b) => a - b);
    const sumIntervals = intervalsMs.reduce((acc, v) => acc + v, 0);
    const meanMs = sumIntervals / intervalsMs.length;
    const p50Ms = computePercentile(sortedIntervals, 50);
    const p95Ms = computePercentile(sortedIntervals, 95);
    const p99Ms = computePercentile(sortedIntervals, 99);
    const minMs = sortedIntervals[0]!;
    const maxMs = sortedIntervals[sortedIntervals.length - 1]!;
    interTokenLatencyDistribution = Object.freeze({
      meanMs: Number(meanMs.toFixed(3)),
      p50Ms: Number(p50Ms.toFixed(3)),
      p95Ms: Number(p95Ms.toFixed(3)),
      p99Ms: Number(p99Ms.toFixed(3)),
      minMs: Number(minMs.toFixed(3)),
      maxMs: Number(maxMs.toFixed(3)),
      jitterMs: Number((p95Ms - p50Ms).toFixed(3)),
    });
  } else {
    const fallbackItlMs =
      input.outputTokens > 1 && decodeDurationMs > 0
        ? Number((decodeDurationMs / (input.outputTokens - 1)).toFixed(3))
        : 0;
    interTokenLatencyDistribution = Object.freeze({
      meanMs: fallbackItlMs,
      p50Ms: fallbackItlMs,
      p95Ms: fallbackItlMs,
      p99Ms: fallbackItlMs,
      minMs: fallbackItlMs,
      maxMs: fallbackItlMs,
      jitterMs: 0,
    });
  }

  let instantTokensPerSecond = tokensPerSecond;
  let rollingWindowTokensPerSecond = tokensPerSecond;

  if (sortedSamples.length >= 2) {
    const lastSample = sortedSamples[sortedSamples.length - 1]!;
    const prevSample = sortedSamples[sortedSamples.length - 2]!;
    const lastDeltaMs = Math.max(1, lastSample.timestampMs - prevSample.timestampMs);
    const lastTokens = lastSample.tokenCount ?? 1;
    instantTokensPerSecond = Number(((lastTokens / lastDeltaMs) * 1_000).toFixed(2));

    const windowStartMs = lastSample.timestampMs - rollingWindowMs;
    const windowSamples = sortedSamples.filter((s) => s.timestampMs >= windowStartMs);
    if (windowSamples.length >= 2) {
      const firstInWindow = windowSamples[0]!;
      const spanMs = Math.max(1, lastSample.timestampMs - firstInWindow.timestampMs);
      const tokensInWindow = windowSamples
        .slice(1)
        .reduce((sum, s) => sum + (s.tokenCount ?? 1), 0);
      rollingWindowTokensPerSecond = Number(((tokensInWindow / spanMs) * 1_000).toFixed(2));
    }
  }

  const emittedIpcBatchCount = input.emittedIpcBatchCount ?? input.persistedSqliteBatchCount;
  const estimatedSqliteTransactionsSaved = Math.max(
    0,
    input.rawSseDeltaCount - input.persistedSqliteBatchCount,
  );
  const estimatedIpcEventsSaved = Math.max(0, input.rawSseDeltaCount - emittedIpcBatchCount);

  const coalescedWriteRatio =
    input.rawSseDeltaCount > 0
      ? Number((estimatedSqliteTransactionsSaved / input.rawSseDeltaCount).toFixed(6))
      : 0;
  const coalescingCompressionFactor =
    input.persistedSqliteBatchCount > 0
      ? Number((input.rawSseDeltaCount / input.persistedSqliteBatchCount).toFixed(4))
      : input.rawSseDeltaCount > 0
        ? input.rawSseDeltaCount
        : 1;

  const inputTokens = input.inputTokens ?? 0;
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, input.cachedInputTokens ?? 0));
  const kvCacheHitRatio =
    inputTokens > 0 ? Number((cachedInputTokens / inputTokens).toFixed(6)) : 0;

  const meetsTargetThroughput = tokensPerSecond >= targetTokensPerSecond;

  // Bottleneck diagnosis
  const isIpcSqliteBound =
    !meetsTargetThroughput &&
    input.rawSseDeltaCount >= 10 &&
    coalescedWriteRatio < 0.35 &&
    input.persistedSqliteBatchCount > 25;

  const isNetworkBound =
    !meetsTargetThroughput &&
    !isIpcSqliteBound &&
    interTokenLatencyDistribution.meanMs > 0 &&
    interTokenLatencyDistribution.p95Ms > interTokenLatencyDistribution.p50Ms * 2.4 &&
    interTokenLatencyDistribution.jitterMs > 12;

  const isPrefillBound =
    timeToFirstTokenMs > 1_200 &&
    inputTokens >= 1_024 &&
    kvCacheHitRatio < 0.5;

  const isProviderComputeBound =
    !meetsTargetThroughput &&
    !isIpcSqliteBound &&
    !isNetworkBound &&
    input.outputTokens > 0;

  let primaryBottleneck: StreamBottleneckKind = "none";
  if (isIpcSqliteBound) {
    primaryBottleneck = "ipc-sqlite-bound";
  } else if (isNetworkBound) {
    primaryBottleneck = "network-bound";
  } else if (isProviderComputeBound) {
    primaryBottleneck = "provider-compute-bound";
  } else if (isPrefillBound) {
    primaryBottleneck = "ttft-prefill-bound";
  }

  const recommendations: string[] = [];
  if (isIpcSqliteBound) {
    recommendations.push(
      "Coalesce SSE frames per TCP chunk in provider_gateway.rs before journaling to SQLite and emitting Tauri IPC events.",
      "Batch renderer state updates using createStreamDeltaCoalescer with an 8ms (120fps) frame budget.",
    );
  }
  if (isNetworkBound) {
    recommendations.push(
      "Enable tcp_nodelay(true) on the native reqwest HTTP client to eliminate Nagle/delayed-ACK stalls.",
      "Inspect upstream proxy buffering or packet jitter between the gateway and provider endpoint.",
    );
  }
  if (isPrefillBound) {
    recommendations.push(
      "Canonicalize system instructions, skill headers, and tool schemas via buildCacheStableProviderPayload to maximize KV-cache reuse.",
    );
  }
  if (isProviderComputeBound) {
    recommendations.push(
      "Upstream model decode rate is compute-limited; consider speculative decoding, quantized weights (FP8/AWQ), or tensor parallelism on the custom provider.",
    );
  }

  const severity: "optimal" | "warning" | "critical" = meetsTargetThroughput
    ? isPrefillBound
      ? "warning"
      : "optimal"
    : tokensPerSecond < targetTokensPerSecond * 0.4
      ? "critical"
      : "warning";

  const summary =
    primaryBottleneck === "none"
      ? `Stream throughput is optimal at ${tokensPerSecond} tok/s (target >= ${targetTokensPerSecond} tok/s, coalesced ${Math.round(coalescedWriteRatio * 100)}% of SQLite writes).`
      : `Stream bottleneck diagnosed as ${primaryBottleneck} at ${tokensPerSecond} tok/s (target >= ${targetTokensPerSecond} tok/s, TTFT ${timeToFirstTokenMs}ms, ITL mean ${interTokenLatencyDistribution.meanMs}ms).`;

  const bottleneckDiagnosis: StreamBottleneckDiagnosis = Object.freeze({
    primaryBottleneck,
    isIpcSqliteBound,
    isNetworkBound,
    isProviderComputeBound,
    isPrefillBound,
    severity,
    summary,
    recommendations: Object.freeze(recommendations),
  });

  return Object.freeze({
    tokensPerSecond,
    totalTokensPerSecond,
    instantTokensPerSecond,
    rollingWindowTokensPerSecond,
    timeToFirstTokenMs,
    interTokenLatencyMs: interTokenLatencyDistribution.meanMs,
    interTokenLatencyDistribution,
    coalescedWriteRatio,
    coalescingCompressionFactor,
    estimatedSqliteTransactionsSaved,
    estimatedIpcEventsSaved,
    kvCacheHitRatio,
    meetsTargetThroughput,
    targetTokensPerSecond,
    bottleneckDiagnosis,
  });
}

// ============================================================================
// 4. OMNIA SELF-MANAGED LOCAL PROMPT & PREFIX CACHE ENGINE
//    Guarantees prompt prefix & response caching inside Omnia even when an
//    upstream custom provider returns cached_tokens = 0 / broken server cache.
// ============================================================================

export const OMNIA_LOCAL_PROMPT_CACHE_STORAGE_KEY = "omnia.sovereign.prompt.cache.v1";
export const DEFAULT_LOCAL_PROMPT_CACHE_MAX_ENTRIES = 256;
export const DEFAULT_LOCAL_PROMPT_CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour

export type LocalPromptCacheHitKind =
  | "exact-response-hit"
  | "history-prefix-hit"
  | "static-prefix-hit"
  | "cache-miss";

export interface LocalPromptCacheTurnInput {
  readonly providerFamily?: CacheStableProviderFamily;
  readonly model: string;
  readonly systemInstructions?: readonly string[];
  readonly skillHeaders?: readonly CacheStableSkillHeader[];
  readonly tools?: readonly CacheStableToolDeclaration[];
  readonly messages: readonly CacheStableMessage[];
  readonly temperature?: number;
  readonly nowMs?: number;
}

export interface LocalPromptCacheEntry {
  readonly exactTurnHash: string;
  readonly prefixHash: string;
  readonly staticPrefixHash: string;
  readonly model: string;
  readonly promptPreview: string;
  readonly responseText: string;
  readonly reasoningText?: string | undefined;
  readonly estimatedStaticPrefixTokens: number;
  readonly estimatedTotalPrefixTokens: number;
  readonly estimatedPromptTokens: number;
  readonly estimatedOutputTokens: number;
  readonly createdAtMs: number;
  readonly lastAccessedAtMs: number;
  readonly hitCount: number;
}

export interface LocalPromptCacheLookupResult {
  readonly hitKind: LocalPromptCacheHitKind;
  readonly exactTurnHash: string;
  readonly prefixHash: string;
  readonly staticPrefixHash: string;
  readonly cachedResponseText: string | null;
  readonly cachedReasoningText: string | null;
  readonly estimatedInputTokens: number;
  readonly localCachedTokens: number;
  readonly localUncachedTokens: number;
  readonly localCacheHitRatio: number;
  readonly canonicalPayload: CacheStableProviderPayload;
  readonly matchedEntry: LocalPromptCacheEntry | null;
}

export interface ReconciledCacheUsageReport {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly providerReportedCachedTokens: number;
  readonly localMatchedCachedTokens: number;
  readonly effectiveCachedInputTokens: number;
  readonly effectiveUncachedInputTokens: number;
  readonly effectiveCacheHitRatio: number;
  readonly cacheSource:
    | "provider-native-cache"
    | "omnia-local-fallback-cache"
    | "hybrid-provider-and-local"
    | "uncached";
  readonly providerCacheBrokenFallbackApplied: boolean;
}

export interface SovereignLocalPromptCacheStats {
  readonly entryCount: number;
  readonly exactHitCount: number;
  readonly prefixHitCount: number;
  readonly staticHitCount: number;
  readonly missCount: number;
  readonly totalLookups: number;
  readonly overallHitRatio: number;
  readonly totalTokensSavedByLocalCache: number;
}

export interface SovereignLocalPromptCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly persistToStorage?: boolean;
  readonly storageKey?: string;
}

export interface SovereignLocalPromptCache {
  lookup(input: LocalPromptCacheTurnInput): LocalPromptCacheLookupResult;
  recordCompletedTurn(
    input: LocalPromptCacheTurnInput,
    response: { readonly responseText: string; readonly reasoningText?: string },
  ): LocalPromptCacheEntry;
  reconcileUsage(
    lookupResult: LocalPromptCacheLookupResult,
    providerUsage?: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cachedInputTokens?: number;
    },
  ): ReconciledCacheUsageReport;
  getStats(): SovereignLocalPromptCacheStats;
  listEntries(): readonly LocalPromptCacheEntry[];
  clear(): void;
}

function buildPayloadInputFromCacheTurn(input: LocalPromptCacheTurnInput): CacheStablePayloadInput {
  return {
    providerFamily: input.providerFamily ?? "openai-compatible",
    model: input.model,
    ...(input.systemInstructions !== undefined ? { systemInstructions: input.systemInstructions } : {}),
    ...(input.skillHeaders !== undefined ? { skillHeaders: input.skillHeaders } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    messages: input.messages,
    compactToolSchemas: true,
    enableExplicitCacheBreakpoints: true,
  };
}

function computeExactTurnHash(
  payload: CacheStableProviderPayload,
  messages: readonly CacheStableMessage[],
  temperature: number,
): string {
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastRole = lastMsg?.role ?? "none";
  const lastContent = normalizeMultilineText(lastMsg?.content ?? "");
  return computeDeterministicHexHash256(
    `exact|${payload.model}|${payload.prefixHash}|${temperature.toFixed(3)}|${lastRole}|${lastContent}`,
  );
}

export function reconcileProviderAndLocalCacheUsage(
  lookupResult: LocalPromptCacheLookupResult,
  providerUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
  },
): ReconciledCacheUsageReport {
  const inputTokens = Math.max(
    lookupResult.estimatedInputTokens,
    providerUsage?.inputTokens ?? 0,
  );
  const outputTokens = Math.max(
    lookupResult.matchedEntry?.estimatedOutputTokens ?? 0,
    providerUsage?.outputTokens ?? 0,
  );
  const providerReportedCachedTokens = Math.max(0, providerUsage?.cachedInputTokens ?? 0);
  const localMatchedCachedTokens = Math.min(inputTokens, lookupResult.localCachedTokens);

  const effectiveCachedInputTokens = Math.min(
    inputTokens,
    Math.max(providerReportedCachedTokens, localMatchedCachedTokens),
  );
  const effectiveUncachedInputTokens = Math.max(0, inputTokens - effectiveCachedInputTokens);
  const effectiveCacheHitRatio =
    inputTokens > 0 ? Number((effectiveCachedInputTokens / inputTokens).toFixed(6)) : 0;

  const providerCacheBrokenFallbackApplied =
    providerReportedCachedTokens === 0 && localMatchedCachedTokens > 0;

  let cacheSource: ReconciledCacheUsageReport["cacheSource"] = "uncached";
  if (providerReportedCachedTokens > 0 && localMatchedCachedTokens > providerReportedCachedTokens) {
    cacheSource = "hybrid-provider-and-local";
  } else if (providerReportedCachedTokens > 0) {
    cacheSource = "provider-native-cache";
  } else if (localMatchedCachedTokens > 0) {
    cacheSource = "omnia-local-fallback-cache";
  }

  return Object.freeze({
    inputTokens,
    outputTokens,
    providerReportedCachedTokens,
    localMatchedCachedTokens,
    effectiveCachedInputTokens,
    effectiveUncachedInputTokens,
    effectiveCacheHitRatio,
    cacheSource,
    providerCacheBrokenFallbackApplied,
  });
}

export function createSovereignLocalPromptCache(
  options: SovereignLocalPromptCacheOptions = {},
): SovereignLocalPromptCache {
  const maxEntries = options.maxEntries ?? DEFAULT_LOCAL_PROMPT_CACHE_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_LOCAL_PROMPT_CACHE_TTL_MS;
  const persistToStorage = options.persistToStorage ?? true;
  const storageKey = options.storageKey ?? OMNIA_LOCAL_PROMPT_CACHE_STORAGE_KEY;

  const entriesByExactHash = new Map<string, LocalPromptCacheEntry>();
  const prefixTokensByHash = new Map<string, number>();
  const staticTokensByHash = new Map<string, number>();

  let exactHitCount = 0;
  let prefixHitCount = 0;
  let staticHitCount = 0;
  let missCount = 0;
  let totalTokensSavedByLocalCache = 0;

  function hydrateFromStorage(): void {
    if (!persistToStorage || typeof window === "undefined") return;
    try {
      const raw = window.localStorage?.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        entries?: LocalPromptCacheEntry[];
        exactHitCount?: number;
        prefixHitCount?: number;
        staticHitCount?: number;
        missCount?: number;
        totalTokensSavedByLocalCache?: number;
      };
      if (Array.isArray(parsed.entries)) {
        for (const item of parsed.entries) {
          if (item && typeof item.exactTurnHash === "string") {
            entriesByExactHash.set(item.exactTurnHash, item);
            prefixTokensByHash.set(item.prefixHash, item.estimatedTotalPrefixTokens);
            staticTokensByHash.set(item.staticPrefixHash, item.estimatedStaticPrefixTokens);
          }
        }
      }
      if (typeof parsed.exactHitCount === "number") exactHitCount = parsed.exactHitCount;
      if (typeof parsed.prefixHitCount === "number") prefixHitCount = parsed.prefixHitCount;
      if (typeof parsed.staticHitCount === "number") staticHitCount = parsed.staticHitCount;
      if (typeof parsed.missCount === "number") missCount = parsed.missCount;
      if (typeof parsed.totalTokensSavedByLocalCache === "number") {
        totalTokensSavedByLocalCache = parsed.totalTokensSavedByLocalCache;
      }
    } catch {
      // Ignore storage hydration errors
    }
  }

  function flushToStorage(): void {
    if (!persistToStorage || typeof window === "undefined") return;
    try {
      const payload = JSON.stringify({
        entries: [...entriesByExactHash.values()],
        exactHitCount,
        prefixHitCount,
        staticHitCount,
        missCount,
        totalTokensSavedByLocalCache,
      });
      window.localStorage?.setItem(storageKey, payload);
    } catch {
      // Ignore quota errors
    }
  }

  hydrateFromStorage();

  function evictExpiredAndOverflow(nowMs: number): void {
    for (const [hash, entry] of entriesByExactHash.entries()) {
      if (nowMs - entry.lastAccessedAtMs > ttlMs) {
        entriesByExactHash.delete(hash);
      }
    }
    if (entriesByExactHash.size <= maxEntries) return;
    const sortedOldest = [...entriesByExactHash.values()].sort(
      (a, b) => a.lastAccessedAtMs - b.lastAccessedAtMs,
    );
    const toRemove = entriesByExactHash.size - maxEntries;
    for (let i = 0; i < toRemove; i += 1) {
      const target = sortedOldest[i];
      if (target) entriesByExactHash.delete(target.exactTurnHash);
    }
  }

  function lookup(input: LocalPromptCacheTurnInput): LocalPromptCacheLookupResult {
    const nowMs = input.nowMs ?? Date.now();
    evictExpiredAndOverflow(nowMs);

    const canonicalPayload = buildCacheStableProviderPayload(
      buildPayloadInputFromCacheTurn(input),
    );

    const exactTurnHash = computeExactTurnHash(
      canonicalPayload,
      input.messages,
      input.temperature ?? 0,
    );

    const lastMessage =
      input.messages.length > 0 ? input.messages[input.messages.length - 1] : undefined;
    const activeTurnTokens = Math.max(
      1,
      Math.ceil((lastMessage?.content.length ?? 4) / 4),
    );
    const estimatedInputTokens =
      canonicalPayload.estimatedTotalPrefixTokens + activeTurnTokens;

    const exactEntry = entriesByExactHash.get(exactTurnHash);
    if (exactEntry) {
      const updatedEntry: LocalPromptCacheEntry = Object.freeze({
        ...exactEntry,
        lastAccessedAtMs: nowMs,
        hitCount: exactEntry.hitCount + 1,
      });
      entriesByExactHash.set(exactTurnHash, updatedEntry);
      exactHitCount += 1;
      totalTokensSavedByLocalCache += estimatedInputTokens;
      flushToStorage();

      return Object.freeze({
        hitKind: "exact-response-hit",
        exactTurnHash,
        prefixHash: canonicalPayload.prefixHash,
        staticPrefixHash: canonicalPayload.staticPrefixHash,
        cachedResponseText: updatedEntry.responseText,
        cachedReasoningText: updatedEntry.reasoningText ?? null,
        estimatedInputTokens,
        localCachedTokens: estimatedInputTokens,
        localUncachedTokens: 0,
        localCacheHitRatio: 1,
        canonicalPayload,
        matchedEntry: updatedEntry,
      });
    }

    const matchedPrefixTokens = prefixTokensByHash.get(canonicalPayload.prefixHash);
    if (matchedPrefixTokens !== undefined && matchedPrefixTokens > 0) {
      prefixHitCount += 1;
      const localCachedTokens = Math.min(estimatedInputTokens, matchedPrefixTokens);
      const localUncachedTokens = Math.max(0, estimatedInputTokens - localCachedTokens);
      totalTokensSavedByLocalCache += localCachedTokens;
      flushToStorage();

      return Object.freeze({
        hitKind: "history-prefix-hit",
        exactTurnHash,
        prefixHash: canonicalPayload.prefixHash,
        staticPrefixHash: canonicalPayload.staticPrefixHash,
        cachedResponseText: null,
        cachedReasoningText: null,
        estimatedInputTokens,
        localCachedTokens,
        localUncachedTokens,
        localCacheHitRatio: Number((localCachedTokens / estimatedInputTokens).toFixed(6)),
        canonicalPayload,
        matchedEntry: null,
      });
    }

    const matchedStaticTokens = staticTokensByHash.get(canonicalPayload.staticPrefixHash);
    if (matchedStaticTokens !== undefined && matchedStaticTokens > 0) {
      staticHitCount += 1;
      const localCachedTokens = Math.min(estimatedInputTokens, matchedStaticTokens);
      const localUncachedTokens = Math.max(0, estimatedInputTokens - localCachedTokens);
      totalTokensSavedByLocalCache += localCachedTokens;
      flushToStorage();

      return Object.freeze({
        hitKind: "static-prefix-hit",
        exactTurnHash,
        prefixHash: canonicalPayload.prefixHash,
        staticPrefixHash: canonicalPayload.staticPrefixHash,
        cachedResponseText: null,
        cachedReasoningText: null,
        estimatedInputTokens,
        localCachedTokens,
        localUncachedTokens,
        localCacheHitRatio: Number((localCachedTokens / estimatedInputTokens).toFixed(6)),
        canonicalPayload,
        matchedEntry: null,
      });
    }

    missCount += 1;
    // Seed the static and history prefix hashes so the very next turn in the thread hits the prefix cache!
    if (canonicalPayload.estimatedStaticPrefixTokens > 0) {
      staticTokensByHash.set(
        canonicalPayload.staticPrefixHash,
        canonicalPayload.estimatedStaticPrefixTokens,
      );
    }
    if (canonicalPayload.estimatedTotalPrefixTokens > 0) {
      prefixTokensByHash.set(
        canonicalPayload.prefixHash,
        canonicalPayload.estimatedTotalPrefixTokens,
      );
    }
    flushToStorage();

    return Object.freeze({
      hitKind: "cache-miss",
      exactTurnHash,
      prefixHash: canonicalPayload.prefixHash,
      staticPrefixHash: canonicalPayload.staticPrefixHash,
      cachedResponseText: null,
      cachedReasoningText: null,
      estimatedInputTokens,
      localCachedTokens: 0,
      localUncachedTokens: estimatedInputTokens,
      localCacheHitRatio: 0,
      canonicalPayload,
      matchedEntry: null,
    });
  }

  function recordCompletedTurn(
    input: LocalPromptCacheTurnInput,
    response: { readonly responseText: string; readonly reasoningText?: string },
  ): LocalPromptCacheEntry {
    const nowMs = input.nowMs ?? Date.now();
    const canonicalPayload = buildCacheStableProviderPayload(
      buildPayloadInputFromCacheTurn(input),
    );
    const exactTurnHash = computeExactTurnHash(
      canonicalPayload,
      input.messages,
      input.temperature ?? 0,
    );
    const lastMessage =
      input.messages.length > 0 ? input.messages[input.messages.length - 1] : undefined;
    const activeTurnTokens = Math.max(
      1,
      Math.ceil((lastMessage?.content.length ?? 4) / 4),
    );
    const estimatedPromptTokens =
      canonicalPayload.estimatedTotalPrefixTokens + activeTurnTokens;
    const estimatedOutputTokens = Math.max(
      1,
      Math.ceil(response.responseText.length / 4),
    );

    const entry: LocalPromptCacheEntry = Object.freeze({
      exactTurnHash,
      prefixHash: canonicalPayload.prefixHash,
      staticPrefixHash: canonicalPayload.staticPrefixHash,
      model: canonicalPayload.model,
      promptPreview: (lastMessage?.content ?? "").slice(0, 120),
      responseText: response.responseText,
      reasoningText: response.reasoningText,
      estimatedStaticPrefixTokens: canonicalPayload.estimatedStaticPrefixTokens,
      estimatedTotalPrefixTokens: canonicalPayload.estimatedTotalPrefixTokens,
      estimatedPromptTokens,
      estimatedOutputTokens,
      createdAtMs: nowMs,
      lastAccessedAtMs: nowMs,
      hitCount: 0,
    });

    entriesByExactHash.set(exactTurnHash, entry);
    staticTokensByHash.set(
      canonicalPayload.staticPrefixHash,
      canonicalPayload.estimatedStaticPrefixTokens,
    );
    prefixTokensByHash.set(
      canonicalPayload.prefixHash,
      estimatedPromptTokens,
    );

    // Also register the full conversation including this new assistant response as a cached history prefix
    // so the NEXT user message in the conversation immediately gets a history-prefix-hit!
    const nextTurnMessages: CacheStableMessage[] = [
      ...input.messages,
      { role: "assistant", content: response.responseText },
      { role: "user", content: "__next_turn_placeholder__" },
    ];
    const nextPayload = buildCacheStableProviderPayload(
      buildPayloadInputFromCacheTurn({
        ...input,
        messages: nextTurnMessages,
      }),
    );
    prefixTokensByHash.set(
      nextPayload.prefixHash,
      nextPayload.estimatedTotalPrefixTokens,
    );

    evictExpiredAndOverflow(nowMs);
    flushToStorage();
    return entry;
  }

  function getStats(): SovereignLocalPromptCacheStats {
    const totalLookups = exactHitCount + prefixHitCount + staticHitCount + missCount;
    const hits = exactHitCount + prefixHitCount + staticHitCount;
    return Object.freeze({
      entryCount: entriesByExactHash.size,
      exactHitCount,
      prefixHitCount,
      staticHitCount,
      missCount,
      totalLookups,
      overallHitRatio: totalLookups > 0 ? Number((hits / totalLookups).toFixed(4)) : 0,
      totalTokensSavedByLocalCache,
    });
  }

  function listEntries(): readonly LocalPromptCacheEntry[] {
    return Object.freeze(
      [...entriesByExactHash.values()].sort(
        (a, b) => b.lastAccessedAtMs - a.lastAccessedAtMs,
      ),
    );
  }

  function clear(): void {
    entriesByExactHash.clear();
    prefixTokensByHash.clear();
    staticTokensByHash.clear();
    exactHitCount = 0;
    prefixHitCount = 0;
    staticHitCount = 0;
    missCount = 0;
    totalTokensSavedByLocalCache = 0;
    flushToStorage();
  }

  return Object.freeze({
    lookup,
    recordCompletedTurn,
    reconcileUsage: reconcileProviderAndLocalCacheUsage,
    getStats,
    listEntries,
    clear,
  });
}

let globalLocalPromptCacheInstance: SovereignLocalPromptCache | null = null;

export function getGlobalSovereignLocalPromptCache(): SovereignLocalPromptCache {
  if (!globalLocalPromptCacheInstance) {
    globalLocalPromptCacheInstance = createSovereignLocalPromptCache();
  }
  return globalLocalPromptCacheInstance;
}

