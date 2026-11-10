import { assertDomain } from "./errors";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type IsoTimestamp = string;

export interface Clock {
  now(): IsoTimestamp;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export function assertIsoTimestamp(value: string, label: string): void {
  const strictIsoPattern =
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
  const parsed = Date.parse(value);
  assertDomain(
    strictIsoPattern.test(value) && Number.isFinite(parsed),
    "invalid_argument",
    `${label} must be an ISO-8601 timestamp.`,
    { label },
  );
}

export function assertNonBlank(value: string, label: string, maxLength?: number): string {
  const normalized = value.trim();
  assertDomain(normalized.length > 0, "invalid_argument", `${label} cannot be empty.`, { label });
  if (maxLength !== undefined) {
    assertDomain(
      normalized.length <= maxLength,
      "invalid_argument",
      `${label} cannot exceed ${maxLength} characters.`,
      { label, maxLength, actualLength: normalized.length },
    );
  }
  return normalized;
}

export function assertSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  assertDomain(
    /^[a-f0-9]{64}$/.test(normalized),
    "invalid_argument",
    `${label} must be a lowercase SHA-256 digest.`,
    { label },
  );
  return normalized;
}

export function unreachable(value: never, message = "Unreachable domain state"): never {
  throw new Error(`${message}: ${String(value)}`);
}

export function stableSort<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): readonly T[] {
  return values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => compare(left.value, right.value) || left.index - right.index)
    .map(({ value }) => value);
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function assertIntegerInRange(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(Number.isInteger(value), "invalid_argument", `${label} must be an integer.`, {
    label,
    value,
  });
  assertDomain(
    value >= minimum && value <= maximum,
    "invalid_argument",
    `${label} must be between ${minimum} and ${maximum}.`,
    { label, value, minimum, maximum },
  );
  return value;
}

/** Recursively freezes JSON-compatible data at a renderer/persistence boundary. */
export function freezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeJson(entry))) as T;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([key, entry]) => [key, freezeJson(entry)]);
    return Object.freeze(Object.fromEntries(entries)) as T;
  }
  return value;
}
