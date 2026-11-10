import { describe, expect, it, vi } from "vitest";
import { DomainError } from "./errors";
import {
  executeUpstreamProcess,
  type UpstreamProcessHandle,
  type UpstreamProcessRequest,
  type UpstreamProcessSpawner,
} from "./upstream-process-adapter";
import { sha256Hex } from "./omnia-official-harness-adapters";

const request = (overrides: Partial<UpstreamProcessRequest> = {}): UpstreamProcessRequest => ({
  manifest: {
    adapterId: "cli/codex-cli",
    executablePath: "C:\\Omnia\\upstream\\codex.exe",
    workingDirectory: "C:\\Omnia\\upstream",
    provenance: ["upstream_extractions/cli/codex-cli/src/cli.ts"],
  },
  args: ["--version"],
  authorityReceiptId: "authority-process-test",
  ...overrides,
});

async function* chunks(values: readonly (string | Uint8Array)[]) {
  for (const value of values) yield value;
}

function fakeHandle(options: {
  stdout?: readonly (string | Uint8Array)[];
  stderr?: readonly (string | Uint8Array)[];
  exitCode?: number | null;
  wait?: () => Promise<{ exitCode: number | null; signal?: string }>;
} = {}): UpstreamProcessHandle & { kill: ReturnType<typeof vi.fn> } {
  const kill = vi.fn();
  return {
    stdout: chunks(options.stdout ?? []),
    stderr: chunks(options.stderr ?? []),
    wait: options.wait ?? (async () => ({ exitCode: options.exitCode ?? 0 })),
    kill,
  };
}

function fakeSpawner(handle: UpstreamProcessHandle): UpstreamProcessSpawner {
  return { spawn: vi.fn(() => handle) };
}

describe("upstream process adapter", () => {
  it("passes only the validated explicit command to the host and preserves streams/exit", async () => {
    const handle = fakeHandle({ stdout: ["version 1\n"], stderr: ["notice\n"], exitCode: 3 });
    const spawner = fakeSpawner(handle);
    const result = await executeUpstreamProcess(request({ args: ["--version", "--json"] }), spawner, {
      now: () => "2026-11-07T10:00:00Z",
    });

    expect(spawner.spawn).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: "C:\\Omnia\\upstream\\codex.exe",
      workingDirectory: "C:\\Omnia\\upstream",
      args: ["--version", "--json"],
      environment: {},
    }));
    expect(result.stdout).toBe("version 1\n");
    expect(result.stderr).toBe("notice\n");
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.exitCode).toBe(3);
    expect(result.receipt.stdoutSha256).toBe(sha256Hex(result.stdout));
    expect(result.receipt.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects relative paths, shell-shaped arguments, and secret environment keys", async () => {
    const spawner = fakeSpawner(fakeHandle());
    await expect(executeUpstreamProcess(request({ manifest: { ...request().manifest, executablePath: "codex" } }), spawner)).rejects.toBeInstanceOf(DomainError);
    await expect(executeUpstreamProcess(request({ args: ["--query\0secret"] }), spawner)).rejects.toBeInstanceOf(DomainError);
    await expect(executeUpstreamProcess(request({ environment: { API_TOKEN: "redacted" } }), spawner)).rejects.toMatchObject({ code: "permission_denied" });
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it("accepts UNC paths without weakening the explicit path boundary", async () => {
    const handle = fakeHandle({ stdout: ["ok"] });
    const spawner = fakeSpawner(handle);
    await executeUpstreamProcess(request({ manifest: {
      ...request().manifest,
      executablePath: "\\\\host\\share\\codex.exe",
      workingDirectory: "\\\\host\\share\\upstream",
    } }), spawner);
    expect(spawner.spawn).toHaveBeenCalled();
  });

  it("requires authority and provenance before spawning", async () => {
    const spawner = fakeSpawner(fakeHandle());
    await expect(executeUpstreamProcess(request({ authorityReceiptId: "   " }), spawner)).rejects.toBeInstanceOf(DomainError);
    await expect(executeUpstreamProcess(request({ manifest: { ...request().manifest, provenance: [] } }), spawner)).rejects.toBeInstanceOf(DomainError);
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it("kills once and records an output-limit receipt when bounded output is exceeded", async () => {
    const handle = fakeHandle({ stdout: ["12345", "67890"] });
    const result = await executeUpstreamProcess(request({ policy: { maxStdoutBytes: 5, maxStderrBytes: 10, maxTotalOutputBytes: 10 } }), fakeSpawner(handle), {
      now: () => "2026-11-07T10:00:00Z",
    });
    expect(handle.kill).toHaveBeenCalledTimes(1);
    expect(handle.kill).toHaveBeenCalledWith("output-limit");
    expect(result.receipt.status).toBe("output-limit");
    expect(result.receipt.stdoutBytes).toBe(5);
    expect(result.receipt.stdoutTruncated).toBe(true);
  });

  it("propagates cancellation and does not expose raw command or output in the receipt", async () => {
    let resolveWait!: (value: { exitCode: number | null }) => void;
    const handle = fakeHandle({ stdout: ["private output"], wait: () => new Promise((resolve) => { resolveWait = resolve; }) });
    const controller = new AbortController();
    const promise = executeUpstreamProcess(request({ args: ["--prompt", "private prompt"] }), fakeSpawner(handle), { signal: controller.signal, now: () => "2026-11-07T10:00:00Z" });
    controller.abort();
    const result = await promise;
    resolveWait({ exitCode: null });
    expect(handle.kill).toHaveBeenCalledWith("cancelled");
    expect(result.receipt.status).toBe("cancelled");
    expect(JSON.stringify(result.receipt)).not.toContain("private prompt");
    expect(JSON.stringify(result.receipt)).not.toContain("private output");
    expect(JSON.stringify(result.receipt)).not.toContain("codex.exe");
  });

  it("records timeout and spawn failures without throwing host details across the boundary", async () => {
    const timeoutHandle = fakeHandle({ wait: () => new Promise(() => undefined) });
    const timedOut = await executeUpstreamProcess(request({ policy: { timeoutMs: 5 } }), fakeSpawner(timeoutHandle), { now: () => "2026-11-07T10:00:00Z" });
    expect(timedOut.receipt.status).toBe("timed-out");
    expect(timeoutHandle.kill).toHaveBeenCalledWith("timed-out");

    const spawnFailure: UpstreamProcessSpawner = { spawn: vi.fn(() => { throw new Error("C:\\private\\secret.exe"); }) };
    const failed = await executeUpstreamProcess(request(), spawnFailure, { now: () => "2026-11-07T10:00:00Z" });
    expect(failed.receipt.status).toBe("spawn-failed");
    expect(JSON.stringify(failed.receipt)).not.toContain("secret.exe");
  });

  it("keeps the terminal receipt when the host kill hook throws", async () => {
    const handle = fakeHandle({ wait: () => new Promise(() => undefined) });
    handle.kill.mockImplementation(() => { throw new Error("host path details"); });
    const result = await executeUpstreamProcess(request({ policy: { timeoutMs: 5 } }), fakeSpawner(handle), { now: () => "2026-11-07T10:00:00Z" });
    expect(result.receipt.status).toBe("timed-out");
    expect(JSON.stringify(result.receipt)).not.toContain("host path details");
  });
});

