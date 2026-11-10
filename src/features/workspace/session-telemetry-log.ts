import {
  redactDiagnosticText,
  sanitizeDiagnosticEvent,
  type DiagnosticPreviewCategory,
  type DiagnosticPreviewEvent,
  type DiagnosticPreviewLevel,
} from "./diagnostics-session-contract";

/**
 * The renderer only needs a small, bounded event buffer while native logging
 * is unavailable.  Keep this limit deliberately conservative: the session log
 * is a review aid, not a second durable journal.
 */
export const DEFAULT_SESSION_TELEMETRY_LIMIT = 200 as const;
export const MAX_SESSION_TELEMETRY_LIMIT = 500 as const;

export interface SessionTelemetryLogInput {
  readonly id?: string;
  readonly occurredAt?: string;
  readonly level: DiagnosticPreviewLevel;
  readonly category: DiagnosticPreviewCategory;
  readonly title: string;
  readonly detail?: string;
  readonly source: string;
}

export interface SessionTelemetryLogOptions {
  readonly maxEntries?: number;
  readonly now?: () => Date;
  readonly idPrefix?: string;
}

function assertLogLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SESSION_TELEMETRY_LIMIT) {
    throw new RangeError(
      `Session telemetry maxEntries must be an integer between 1 and ${MAX_SESSION_TELEMETRY_LIMIT}.`,
    );
  }
  return value;
}

function freezeEvent(event: DiagnosticPreviewEvent): DiagnosticPreviewEvent {
  return Object.freeze({ ...event });
}

function normalizeInput(
  input: SessionTelemetryLogInput,
  sequence: number,
  now: () => Date,
  idPrefix: string,
): DiagnosticPreviewEvent {
  // Do not spread the input here.  A caller may accidentally pass provider
  // payloads, headers, or other untrusted fields; only the diagnostic allowlist
  // crosses into the session buffer.
  const detail = input.detail === undefined ? "" : redactDiagnosticText(input.detail);
  return freezeEvent(
    sanitizeDiagnosticEvent({
      id: input.id ?? `${idPrefix}-${sequence}`,
      occurredAt: input.occurredAt ?? now().toISOString(),
      level: input.level,
      category: input.category,
      title: input.title,
      detail,
      source: input.source,
    }),
  );
}

/**
 * A renderer-session event buffer with explicit bounds and redaction.
 *
 * Entries are newest-first. `snapshot()` returns a frozen copy, and `clear()`
 * only affects this in-memory instance. No console output, native command,
 * filesystem write, provider request, or durable receipt is created.
 */
export class SessionTelemetryLog {
  readonly maxEntries: number;

  private readonly now: () => Date;
  private readonly idPrefix: string;
  private sequence = 0;
  private entries: DiagnosticPreviewEvent[] = [];

  constructor(options: SessionTelemetryLogOptions = {}) {
    this.maxEntries = assertLogLimit(options.maxEntries ?? DEFAULT_SESSION_TELEMETRY_LIMIT);
    this.now = options.now ?? (() => new Date());
    this.idPrefix = redactDiagnosticText(options.idPrefix ?? "session-telemetry")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 80) || "session-telemetry";
  }

  get size(): number {
    return this.entries.length;
  }

  append(input: SessionTelemetryLogInput): DiagnosticPreviewEvent {
    this.sequence += 1;
    const event = normalizeInput(input, this.sequence, this.now, this.idPrefix);
    this.entries = [event, ...this.entries].slice(0, this.maxEntries);
    return event;
  }

  appendMany(inputs: readonly SessionTelemetryLogInput[]): readonly DiagnosticPreviewEvent[] {
    return Object.freeze(inputs.map((input) => this.append(input)));
  }

  snapshot(): readonly DiagnosticPreviewEvent[] {
    return Object.freeze([...this.entries]);
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * Pure append helper for reducers and tests that do not need a stateful logger.
 * The returned collection is newest-first and bounded by `maxEntries`.
 */
export function appendSessionTelemetryEntry(
  entries: readonly DiagnosticPreviewEvent[],
  input: SessionTelemetryLogInput,
  options: {
    readonly maxEntries?: number;
    readonly sequence?: number;
    readonly now?: () => Date;
    readonly idPrefix?: string;
  } = {},
): readonly DiagnosticPreviewEvent[] {
  const maxEntries = assertLogLimit(options.maxEntries ?? DEFAULT_SESSION_TELEMETRY_LIMIT);
  const now = options.now ?? (() => new Date());
  const idPrefix = redactDiagnosticText(options.idPrefix ?? "session-telemetry")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 80) || "session-telemetry";
  const sequence = options.sequence ?? entries.length + 1;
  const event = normalizeInput(input, sequence, now, idPrefix);
  return Object.freeze([event, ...entries].slice(0, maxEntries));
}

