import { estimateContextTokens } from "./context-harness";

/**
 * Input limits used by the composer before a native clipboard/file bridge is
 * available. These values are deliberately conservative: crossing any one
 * limit is enough to recommend conversion to a lineage-preserving file.
 *
 * The policy is renderer-only and does not create attachment records. A
 * native ingestion receipt is still required before a converted paste can be
 * dispatched to a provider.
 */
export const DEFAULT_COMPOSER_INPUT_THRESHOLDS = Object.freeze({
  maxCharacters: 32_768,
  maxEstimatedTokens: 8_192,
  maxBytes: 256 * 1024,
  maxLines: 2_000,
} as const);

export type ComposerInputThresholdKey =
  | "characters"
  | "estimated_tokens"
  | "bytes"
  | "lines"
  | "responsiveness";

export type ComposerInputPolicyMode = "inline" | "ask" | "auto";

export interface ComposerInputThresholds {
  /** Maximum Unicode scalar values accepted by the inline composer. */
  readonly maxCharacters: number;
  /** Conservative token estimate; provider tokenizers remain authoritative. */
  readonly maxEstimatedTokens: number;
  /** Exact UTF-8 byte length of the source string. */
  readonly maxBytes: number;
  /** Number of logical lines (CRLF is one line break). */
  readonly maxLines: number;
}

export interface ComposerInputPolicyOptions {
  readonly mode?: ComposerInputPolicyMode;
  readonly thresholds?: Partial<ComposerInputThresholds>;
  /**
   * Set when an incremental renderer reports that keeping this input inline
   * would degrade responsiveness. This signal is intentionally supplied by
   * the renderer; the policy never guesses from wall-clock timing.
   */
  readonly inlineRenderingDegraded?: boolean;
}

export interface ComposerInputMetrics {
  /** Unicode scalar-value count, so a surrogate pair counts as one character. */
  readonly characterCount: number;
  /** UTF-16 code-unit count, exposed for diagnostics and editor integrations. */
  readonly utf16CodeUnitCount: number;
  /** Exact byte count when encoded as UTF-8. */
  readonly byteCount: number;
  /** Logical line count; an empty string has zero lines. */
  readonly lineCount: number;
  /** Conservative, deterministic estimate; not provider billing evidence. */
  readonly estimatedTokenCount: number;
}

export interface ComposerInputThresholdResult {
  readonly metrics: ComposerInputMetrics;
  readonly thresholds: ComposerInputThresholds;
  readonly mode: ComposerInputPolicyMode;
  readonly shouldConvertToFile: boolean;
  readonly triggered: boolean;
  readonly triggerReasons: readonly ComposerInputThresholdKey[];
  readonly primaryReason: ComposerInputThresholdKey | null;
}

const encoder = new TextEncoder();

function assertThreshold(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

/**
 * Merges user settings with the normative defaults and validates every
 * threshold. Keeping this function pure makes it safe to use from a settings
 * preview, a paste event and deterministic tests alike.
 */
export function resolveComposerInputThresholds(
  overrides: Partial<ComposerInputThresholds> = {},
): ComposerInputThresholds {
  const thresholds: ComposerInputThresholds = {
    maxCharacters:
      overrides.maxCharacters ?? DEFAULT_COMPOSER_INPUT_THRESHOLDS.maxCharacters,
    maxEstimatedTokens:
      overrides.maxEstimatedTokens ??
      DEFAULT_COMPOSER_INPUT_THRESHOLDS.maxEstimatedTokens,
    maxBytes: overrides.maxBytes ?? DEFAULT_COMPOSER_INPUT_THRESHOLDS.maxBytes,
    maxLines: overrides.maxLines ?? DEFAULT_COMPOSER_INPUT_THRESHOLDS.maxLines,
  };

  assertThreshold(thresholds.maxCharacters, "maxCharacters");
  assertThreshold(thresholds.maxEstimatedTokens, "maxEstimatedTokens");
  assertThreshold(thresholds.maxBytes, "maxBytes");
  assertThreshold(thresholds.maxLines, "maxLines");
  return Object.freeze(thresholds);
}

/**
 * Counts logical lines without treating the two bytes in CRLF as two line
 * breaks. Empty input has no lines, which keeps an untouched draft cheap.
 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

export function measureComposerInput(text: string): ComposerInputMetrics {
  const metrics: ComposerInputMetrics = {
    characterCount: Array.from(text).length,
    utf16CodeUnitCount: text.length,
    byteCount: encoder.encode(text).byteLength,
    lineCount: countLines(text),
    estimatedTokenCount: estimateContextTokens(text),
  };
  return Object.freeze(metrics);
}

/**
 * Evaluates the four normative limits. Reasons are returned in a stable order
 * so telemetry, UI copy and tests do not depend on object key insertion order.
 */
export function evaluateComposerInput(
  text: string,
  options: ComposerInputPolicyOptions = {},
): ComposerInputThresholdResult {
  const mode = options.mode ?? "auto";
  const thresholds = resolveComposerInputThresholds(options.thresholds);
  const metrics = measureComposerInput(text);
  const triggerReasons: ComposerInputThresholdKey[] = [];

  if (metrics.characterCount > thresholds.maxCharacters) {
    triggerReasons.push("characters");
  }
  if (metrics.estimatedTokenCount > thresholds.maxEstimatedTokens) {
    triggerReasons.push("estimated_tokens");
  }
  if (metrics.byteCount > thresholds.maxBytes) {
    triggerReasons.push("bytes");
  }
  if (metrics.lineCount > thresholds.maxLines) {
    triggerReasons.push("lines");
  }
  if (options.inlineRenderingDegraded === true) {
    triggerReasons.push("responsiveness");
  }

  const triggered = triggerReasons.length > 0;
  const shouldConvertToFile = triggered && mode === "auto";
  return Object.freeze({
    metrics,
    thresholds,
    mode,
    shouldConvertToFile,
    triggered,
    triggerReasons: Object.freeze(triggerReasons),
    primaryReason: triggerReasons[0] ?? null,
  });
}

