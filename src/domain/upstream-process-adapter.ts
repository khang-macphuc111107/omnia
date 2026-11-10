import { assertDomain } from "./errors";
import { sha256Hex } from "./omnia-official-harness-adapters";
import { assertIntegerInRange, assertIsoTimestamp, assertNonBlank, type IsoTimestamp } from "./shared";

/**
 * Process boundary for upstream CLIs and harnesses.
 *
 * The catalog can tell the renderer that a module is a `process-adapter`, but
 * it must not turn an extracted path into a renderer command. This module is
 * the small, native-owned contract that an approved process host implements:
 * the host supplies a spawner, while this boundary owns argument validation,
 * output/time limits, cancellation, and a content-free receipt.
 *
 * Provenance used while designing this contract:
 * - `upstream_extractions/cli/codex-cli` (CLI entrypoint and stream-oriented
 *   command shape)
 * - `upstream_extractions/cli/claude-cli` (bounded CLI invocation options)
 * - `upstream_extractions/harnesses/codex-harness` (run lifecycle/exit state)
 *
 * Those trees are evidence only. No upstream process is imported or launched
 * by the renderer module.
 */
export const UPSTREAM_PROCESS_ADAPTER_VERSION = "omnia-upstream-process-v1" as const;

const MAX_EXECUTABLE_PATH_CHARS = 4_096;
const MAX_WORKING_DIRECTORY_CHARS = 4_096;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_CHARS = 8_192;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_KEY_CHARS = 128;
const MAX_ENV_VALUE_CHARS = 8_192;

export interface UpstreamProcessPolicy {
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxTotalOutputBytes: number;
}

export const DEFAULT_UPSTREAM_PROCESS_POLICY: UpstreamProcessPolicy = Object.freeze({
  timeoutMs: 120_000,
  killGraceMs: 2_000,
  maxStdoutBytes: 256 * 1024,
  maxStderrBytes: 256 * 1024,
  maxTotalOutputBytes: 512 * 1024,
});

export interface UpstreamProcessManifest {
  /** Stable catalog/adapter id, for example `cli/codex-cli`. */
  readonly adapterId: string;
  /** Explicit executable path selected by the trusted native host. */
  readonly executablePath: string;
  /** Working directory selected by the trusted native host. */
  readonly workingDirectory: string;
  /** Optional digest recorded by the installer/host; never computed from a renderer path. */
  readonly executableSha256?: string;
  /** Source paths used to review this adapter. Kept as provenance metadata only. */
  readonly provenance: readonly string[];
}

export interface UpstreamProcessRequest {
  readonly manifest: UpstreamProcessManifest;
  readonly args?: readonly string[];
  /** Environment is opt-in. The host must not pass its ambient environment implicitly. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Native approval/authority receipt. A process cannot be admitted without one. */
  readonly authorityReceiptId: string;
  readonly policy?: Partial<UpstreamProcessPolicy>;
  readonly stdin?: string;
}

export interface UpstreamProcessSpawnSpec {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export interface UpstreamProcessExit {
  readonly exitCode: number | null;
  readonly signal?: string;
}

/** A native process host implements this interface (Tauri/Node/worker). */
export interface UpstreamProcessHandle {
  readonly stdout?: AsyncIterable<Uint8Array | string>;
  readonly stderr?: AsyncIterable<Uint8Array | string>;
  wait(): Promise<UpstreamProcessExit>;
  kill(reason: "cancelled" | "timed-out" | "output-limit"): Promise<void> | void;
}

export interface UpstreamProcessSpawner {
  spawn(spec: UpstreamProcessSpawnSpec): Promise<UpstreamProcessHandle> | UpstreamProcessHandle;
}

export type UpstreamProcessStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "output-limit"
  | "spawn-failed";

export interface UpstreamProcessOutput {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly sha256: string;
}

/** Content-free audit projection. It intentionally excludes executable paths, args, env, and output. */
export interface UpstreamProcessReceipt {
  readonly schemaVersion: 1;
  readonly adapterVersion: typeof UPSTREAM_PROCESS_ADAPTER_VERSION;
  readonly adapterId: string;
  readonly authorityReceiptId: string;
  readonly commandSha256: string;
  readonly status: UpstreamProcessStatus;
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly receiptSha256: string;
}

export interface UpstreamProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly receipt: UpstreamProcessReceipt;
}

function normalizePolicy(input: Partial<UpstreamProcessPolicy> = {}): UpstreamProcessPolicy {
  const value = (key: keyof UpstreamProcessPolicy, minimum: number, maximum: number): number =>
    assertIntegerInRange(input[key] ?? DEFAULT_UPSTREAM_PROCESS_POLICY[key], `upstream process ${key}`, minimum, maximum);
  const maxStdoutBytes = value("maxStdoutBytes", 1, 4 * 1024 * 1024);
  const maxStderrBytes = value("maxStderrBytes", 1, 4 * 1024 * 1024);
  const maxTotalOutputBytes = value("maxTotalOutputBytes", 1, 8 * 1024 * 1024);
  assertDomain(maxTotalOutputBytes >= Math.max(maxStdoutBytes, maxStderrBytes), "invalid_argument", "upstream process total output limit cannot be below a stream limit.");
  return Object.freeze({
    timeoutMs: value("timeoutMs", 1, 600_000),
    killGraceMs: value("killGraceMs", 100, 10_000),
    maxStdoutBytes,
    maxStderrBytes,
    maxTotalOutputBytes,
  });
}

function assertPath(value: string, label: string, maximum: number): string {
  const normalized = assertNonBlank(value, label, maximum);
  assertDomain(!normalized.includes("\0"), "invalid_argument", `${label} contains an invalid character.`);
  // A manifest is host-selected, but must still be an explicit path rather
  // than a shell fragment or PATH lookup. Both Windows drive paths and POSIX
  // absolute paths are accepted because the process host owns platform rules.
  assertDomain(!/[\u0000-\u001f\u007f]/u.test(normalized), "invalid_argument", `${label} contains an invalid control character.`);
  assertDomain(/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(normalized), "invalid_argument", `${label} must be an absolute path.`);
  return normalized;
}

function normalizeManifest(manifest: UpstreamProcessManifest): UpstreamProcessManifest {
  const adapterId = assertNonBlank(manifest.adapterId, "upstream process adapter ID", 200);
  const executablePath = assertPath(manifest.executablePath, "upstream executable path", MAX_EXECUTABLE_PATH_CHARS);
  const workingDirectory = assertPath(manifest.workingDirectory, "upstream working directory", MAX_WORKING_DIRECTORY_CHARS);
  assertDomain(Array.isArray(manifest.provenance) && manifest.provenance.length > 0 && manifest.provenance.length <= 32, "invalid_argument", "upstream process provenance is required.");
  const provenance = manifest.provenance.map((entry) => assertNonBlank(entry, "upstream provenance path", 1_024));
  const executableSha256 = manifest.executableSha256;
  if (executableSha256 !== undefined) {
    assertDomain(/^[a-f0-9]{64}$/u.test(executableSha256), "invalid_argument", "upstream executable digest must be a lowercase SHA-256 value.");
  }
  return Object.freeze({ adapterId, executablePath, workingDirectory, ...(executableSha256 === undefined ? {} : { executableSha256 }), provenance: Object.freeze(provenance) });
}

function normalizeArgs(args: readonly string[] | undefined): readonly string[] {
  const values = args ?? [];
  assertDomain(Array.isArray(values) && values.length <= MAX_ARGUMENTS, "invalid_argument", "upstream process argument count exceeds the safety limit.");
  return Object.freeze(values.map((arg) => {
    assertDomain(typeof arg === "string" && arg.length <= MAX_ARGUMENT_CHARS && !arg.includes("\0"), "invalid_argument", "upstream process argument is malformed or too long.");
    return arg;
  }));
}

const SECRET_ENV_KEY = /(?:token|secret|password|passwd|cookie|auth|credential|api[_-]?key|private[_-]?key)/iu;

function normalizeEnvironment(environment: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const entries = Object.entries(environment ?? {});
  assertDomain(entries.length <= MAX_ENV_ENTRIES, "invalid_argument", "upstream process environment is too large.");
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    assertDomain(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && key.length <= MAX_ENV_KEY_CHARS, "invalid_argument", "upstream process environment key is malformed.");
    assertDomain(!SECRET_ENV_KEY.test(key), "permission_denied", "secret-bearing environment variables are not accepted by the upstream process adapter.");
    assertDomain(typeof value === "string" && value.length <= MAX_ENV_VALUE_CHARS && !value.includes("\0"), "invalid_argument", "upstream process environment value is malformed or too long.");
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

function validateRequest(request: UpstreamProcessRequest): { manifest: UpstreamProcessManifest; args: readonly string[]; environment: Readonly<Record<string, string>>; policy: UpstreamProcessPolicy; authorityReceiptId: string; stdin?: string } {
  const manifest = normalizeManifest(request.manifest);
  const args = normalizeArgs(request.args);
  const environment = normalizeEnvironment(request.environment);
  const policy = normalizePolicy(request.policy);
  const authorityReceiptId = assertNonBlank(request.authorityReceiptId, "upstream process authority receipt ID", 320);
  if (request.stdin !== undefined) {
    assertDomain(typeof request.stdin === "string" && request.stdin.length <= policy.maxTotalOutputBytes, "invalid_argument", "upstream process stdin exceeds the safety limit.");
  }
  return { manifest, args, environment, policy, authorityReceiptId, ...(request.stdin === undefined ? {} : { stdin: request.stdin }) };
}

interface OutputAccumulator {
  text: string;
  bytes: number;
  truncated: boolean;
  readonly limit: number;
  readonly decoder: TextDecoder;
}

function createAccumulator(limit: number): OutputAccumulator {
  return { text: "", bytes: 0, truncated: false, limit, decoder: new TextDecoder() };
}

function appendChunk(accumulator: OutputAccumulator, chunk: Uint8Array | string, remainingTotal: number): { remaining: number; overflowed: boolean } {
  const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
  const available = Math.max(0, Math.min(accumulator.limit - accumulator.bytes, remainingTotal));
  if (bytes.byteLength > available) accumulator.truncated = true;
  if (available > 0) {
    const accepted = bytes.byteLength <= available ? bytes : bytes.slice(0, available);
    // Keep one decoder per stream. A CLI may split a UTF-8 code point across
    // chunks; recreating a decoder per chunk would turn that boundary into
    // replacement characters before the output limit is applied.
    accumulator.text += accumulator.decoder.decode(accepted, { stream: true });
    accumulator.bytes += accepted.byteLength;
  }
  return { remaining: Math.max(0, remainingTotal - Math.min(bytes.byteLength, available)), overflowed: bytes.byteLength > available };
}

function finalizeAccumulator(accumulator: OutputAccumulator): UpstreamProcessOutput {
  // A fresh decoder is used for each bounded chunk above; output is still
  // valid UTF-8 text for normal CLI streams, and malformed bytes are replaced
  // instead of leaking binary data through the renderer.
  accumulator.text += accumulator.decoder.decode();
  return Object.freeze({ text: accumulator.text, bytes: accumulator.bytes, truncated: accumulator.truncated, sha256: sha256Hex(accumulator.text) });
}

async function consumeOutput(source: AsyncIterable<Uint8Array | string> | undefined, accumulator: OutputAccumulator, total: { remaining: number }, onLimit: () => Promise<void>): Promise<void> {
  if (!source) return;
  for await (const chunk of source) {
    const appended = appendChunk(accumulator, chunk, total.remaining);
    total.remaining = appended.remaining;
    if (appended.overflowed) {
      await onLimit();
      break;
    }
  }
}

function receiptHash(body: Omit<UpstreamProcessReceipt, "receiptSha256">): string {
  return sha256Hex(JSON.stringify(body));
}

/** Execute an approved upstream process through a native-owned spawner. */
export async function executeUpstreamProcess(
  request: UpstreamProcessRequest,
  spawner: UpstreamProcessSpawner,
  options: { readonly signal?: AbortSignal; readonly now?: () => IsoTimestamp } = {},
): Promise<UpstreamProcessResult> {
  const validated = validateRequest(request);
  const startedAt = options.now?.() ?? new Date().toISOString();
  assertIsoTimestamp(startedAt, "upstream process start time");
  const commandSha256 = sha256Hex(JSON.stringify({ executablePath: validated.manifest.executablePath, workingDirectory: validated.manifest.workingDirectory, args: validated.args, environmentKeys: Object.keys(validated.environment).sort() }));
  let handle: UpstreamProcessHandle;
  try {
    handle = await spawner.spawn({ executablePath: validated.manifest.executablePath, workingDirectory: validated.manifest.workingDirectory, args: validated.args, environment: validated.environment, ...(validated.stdin === undefined ? {} : { stdin: validated.stdin }) });
  } catch {
    const completedAt = options.now?.() ?? new Date().toISOString();
    assertIsoTimestamp(completedAt, "upstream process completion time");
    const body = Object.freeze({ schemaVersion: 1 as const, adapterVersion: UPSTREAM_PROCESS_ADAPTER_VERSION, adapterId: validated.manifest.adapterId, authorityReceiptId: validated.authorityReceiptId, commandSha256, status: "spawn-failed" as const, exitCode: null, stdoutBytes: 0, stderrBytes: 0, stdoutSha256: sha256Hex(""), stderrSha256: sha256Hex(""), stdoutTruncated: false, stderrTruncated: false, startedAt, completedAt });
    return Object.freeze({ stdout: "", stderr: "", receipt: Object.freeze({ ...body, receiptSha256: receiptHash(body) }) });
  }

  const stdout = createAccumulator(validated.policy.maxStdoutBytes);
  const stderr = createAccumulator(validated.policy.maxStderrBytes);
  const total = { remaining: validated.policy.maxTotalOutputBytes };
  let terminalStatus: Exclude<UpstreamProcessStatus, "completed" | "failed" | "spawn-failed"> | undefined;
  let outputReadFailed = false;
  let killPromise: Promise<void> | undefined;
  const killOnce = (reason: Exclude<typeof terminalStatus, undefined>): Promise<void> => {
    terminalStatus ??= reason;
    // Native kill implementations may throw before returning a Promise. The
    // process outcome is still observable as cancelled/timed-out/limited, so
    // normalize both sync and async termination failures here.
    killPromise ??= Promise.resolve().then(() => handle.kill(reason)).then(() => undefined).catch(() => undefined);
    return killPromise;
  };
  const onLimit = async () => { await killOnce("output-limit"); };
  const read = (source: AsyncIterable<Uint8Array | string> | undefined, accumulator: OutputAccumulator) =>
    consumeOutput(source, accumulator, total, onLimit).catch(() => { outputReadFailed = true; });
  const readers = Promise.all([read(handle.stdout, stdout), read(handle.stderr, stderr)]);
  let exit: UpstreamProcessExit = { exitCode: null };
  // Resolve the call on a microtask so a host that throws synchronously from
  // `wait()` is normalized like an asynchronous process failure.
  const wait = Promise.resolve().then(() => handle.wait()).catch((): UpstreamProcessExit => ({ exitCode: null }));
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed-out">((resolve) => { timeoutHandle = setTimeout(() => resolve("timed-out"), validated.policy.timeoutMs); });
  let completion: UpstreamProcessExit | "timed-out" | "cancelled";
  if (options.signal?.aborted) {
    completion = "cancelled";
  } else {
    completion = await Promise.race([
      wait,
      timeout,
      ...(options.signal === undefined ? [] : [new Promise<"cancelled">((resolve) => options.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true }))]),
    ]);
  }
  if (completion === "timed-out") await killOnce("timed-out");
  if (completion === "cancelled") await killOnce("cancelled");
  if (typeof completion === "object") exit = completion;
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  if (terminalStatus !== undefined) {
    await Promise.race([wait.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, validated.policy.killGraceMs))]);
  }
  await Promise.race([readers, new Promise<void>((resolve) => setTimeout(resolve, validated.policy.killGraceMs))]);
  const completedAt = options.now?.() ?? new Date().toISOString();
  assertIsoTimestamp(completedAt, "upstream process completion time");
  const status: UpstreamProcessStatus = terminalStatus ?? (outputReadFailed || exit.exitCode !== 0 ? "failed" : "completed");
  const stdoutResult = finalizeAccumulator(stdout);
  const stderrResult = finalizeAccumulator(stderr);
  const body = Object.freeze({ schemaVersion: 1 as const, adapterVersion: UPSTREAM_PROCESS_ADAPTER_VERSION, adapterId: validated.manifest.adapterId, authorityReceiptId: validated.authorityReceiptId, commandSha256, status, exitCode: exit.exitCode, ...(exit.signal === undefined ? {} : { signal: exit.signal }), stdoutBytes: stdoutResult.bytes, stderrBytes: stderrResult.bytes, stdoutSha256: stdoutResult.sha256, stderrSha256: stderrResult.sha256, stdoutTruncated: stdoutResult.truncated, stderrTruncated: stderrResult.truncated, startedAt, completedAt });
  return Object.freeze({ stdout: stdoutResult.text, stderr: stderrResult.text, receipt: Object.freeze({ ...body, receiptSha256: receiptHash(body) }) });
}

