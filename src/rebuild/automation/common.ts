/** Shared validation and immutable snapshot helpers for renderer automation. */

export class AutomationDomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AutomationDomainError";
    this.code = code;
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown, field: string, max = 512, allowMultiline = false): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value) {
    throw new AutomationDomainError("invalid_input", `${field} must be non-empty text of at most ${max} characters`);
  }
  for (const character of value) {
    if (!/\p{Cc}/u.test(character)) continue;
    if (!allowMultiline || !"\n\r\t".includes(character)) {
      throw new AutomationDomainError("invalid_input", `${field} contains an unsupported control character`);
    }
  }
  return value;
}

/** Preserve prompt bytes while rejecting blank or malformed text. */
export function rawText(value: unknown, field: string, max = 262_144, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    throw new AutomationDomainError("invalid_input", `${field} must be ${allowEmpty ? "bounded" : "non-empty"} text of at most ${max} characters`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if ((codePoint >= 0xd800 && codePoint <= 0xdfff) || (/\p{Cc}/u.test(character) && !"\n\r\t".includes(character))) {
      throw new AutomationDomainError("invalid_input", `${field} contains unsupported text`);
    }
  }
  return value;
}

export function identifier(value: unknown, field: string, max = 256): string {
  const result = text(value, field, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) {
    throw new AutomationDomainError("invalid_input", `${field} has an invalid identifier`);
  }
  return result;
}

export function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AutomationDomainError("invalid_input", `${field} must be a non-negative safe integer`);
  }
  return value;
}

export function expectedRevision(current: number, expected: number): void {
  nonNegativeInteger(expected, "expectedRevision");
  if (expected !== current) {
    throw new AutomationDomainError("stale_revision", `stale revision: expected ${expected}, current revision is ${current}`);
  }
}

export function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const known = new Set(allowed);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new AutomationDomainError("unknown_field", "Input contains an unknown field");
  }
}

export function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new AutomationDomainError("hash_unavailable", "SHA-256 is unavailable in this runtime");
  const bytes = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!record(value)) throw new AutomationDomainError("invalid_input", `${field} must be an object`);
  assertKnownKeys(value, keys);
  return value;
}

export function list<T>(value: unknown, field: string, max: number, parse: (entry: unknown) => T, minimum = 0): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > max) {
    throw new AutomationDomainError("invalid_input", `${field} must contain ${minimum} through ${max} entries`);
  }
  return value.map(parse);
}

export function evidenceList(value: unknown): string[] {
  const evidence = list(value, "evidence", 128, (entry) => text(entry, "evidence", 1_024), 1);
  uniqueIds(evidence, "evidence");
  return evidence;
}

export function journalCapacity(currentBytes: number, nextValue: unknown): number {
  const nextBytes = currentBytes + utf8Bytes(json(nextValue));
  if (nextBytes > 4 * 1024 * 1024) throw new AutomationDomainError("capacity", "Automation journal exceeds 4194304 UTF-8 bytes");
  return nextBytes;
}

export interface ReplayEnvelope { schemaVersion: 1; kind: string; initial: unknown; events: unknown[]; state: unknown; }

/** State is derived by validated command replay, never assigned from saved data. */
export function readReplay(serialized: string, kind: string): ReplayEnvelope {
  if (typeof serialized !== "string" || serialized.length > 32 * 1024 * 1024) {
    throw new AutomationDomainError("invalid_replay", "Serialized replay exceeds the size limit");
  }
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new AutomationDomainError("invalid_replay", "Serialized replay is not JSON"); }
  const envelope = object(value, ["schemaVersion", "kind", "initial", "events", "state"], "replay envelope");
  if (envelope.schemaVersion !== 1 || envelope.kind !== kind || !Array.isArray(envelope.events) || envelope.events.length > 4_096) {
    throw new AutomationDomainError("invalid_replay", "Unsupported replay snapshot");
  }
  return envelope as unknown as ReplayEnvelope;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${json(key)}:${stableJson(value[key])}`).join(",")}}`;
  return json(value);
}

export function verifyReplay(snapshot: unknown, saved: unknown): void {
  if (stableJson(snapshot) !== stableJson(saved)) throw new AutomationDomainError("invalid_replay", "Derived replay does not match saved snapshot or hashes");
}

export function uniqueIds(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new AutomationDomainError("duplicate_id", `${field} ids must be unique`);
  }
}

