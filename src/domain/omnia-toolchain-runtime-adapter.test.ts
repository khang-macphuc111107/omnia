import { describe, expect, it } from "vitest";

import {
  TOOLCHAIN_RUNTIME_CATALOG,
  TOOLCHAIN_RUNTIME_IDS,
  TOOLCHAIN_RUNTIME_SCHEMA_VERSION,
  createOmniaToolchainRuntimeAdapter,
  planToolchainCommand,
  validateToolchainCommandPlan,
  type ToolchainCommandPlan,
  type ToolchainDiscovery,
  type ToolchainRuntimeCapabilities,
  type ToolchainRuntimeId,
  type ToolchainRuntimeResult,
} from "./omnia-toolchain-runtime-adapter";

const cwd = "C:\\Users\\khang\\source\\repos\\omnia";
const now = "2026-10-17T00:00:00.000Z";

function plannedNodeCommand(): ToolchainCommandPlan {
  const result = planToolchainCommand({
    toolchainId: "node",
    target: "test",
    profile: "debug",
    cwd,
    extraArgs: ["--runInBand"],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe("omnia toolchain runtime adapter", () => {
  it("keeps the catalog stable and covers the preview toolchains", () => {
    expect(TOOLCHAIN_RUNTIME_CATALOG).toHaveLength(TOOLCHAIN_RUNTIME_IDS.length);
    expect(TOOLCHAIN_RUNTIME_CATALOG.map((entry) => entry.id)).toEqual([...TOOLCHAIN_RUNTIME_IDS]);
    for (const entry of TOOLCHAIN_RUNTIME_CATALOG) {
      expect(entry.executable.trim()).not.toBe("");
      expect(Object.keys(entry.defaultArgs)).toEqual(["dev", "test", "build", "lint"]);
    }
  });

  it("creates a structured command plan without shell concatenation", () => {
    const result = planToolchainCommand({
      toolchainId: "node",
      target: "test",
      cwd,
      extraArgs: ["src/main.test.ts"],
      sandbox: true,
      network: false,
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        schemaVersion: TOOLCHAIN_RUNTIME_SCHEMA_VERSION,
        toolchainId: "node",
        target: "test",
        profile: "debug",
        executable: "npm",
        args: ["run", "test", "src/main.test.ts"],
        cwd,
        sandbox: true,
        network: false,
        cache: true,
        watch: false,
      }),
    });
    if (result.ok) {
      expect("command" in result.value).toBe(false);
      expect(Object.isFrozen(result.value.args)).toBe(true);
    }
  });

  it("rejects unknown values, control characters, and oversized argument lists", () => {
    const unknown = planToolchainCommand({
      toolchainId: "unknown" as never,
      target: "test",
      cwd,
    });
    expect(unknown).toMatchObject({ ok: false, code: "invalid_plan" });

    const controlCharacter = planToolchainCommand({
      toolchainId: "node",
      target: "test",
      cwd,
      extraArgs: ["--label\nsecret"],
    });
    expect(controlCharacter).toMatchObject({ ok: false, code: "invalid_plan" });

    const tooManyArgs = planToolchainCommand({
      toolchainId: "node",
      target: "test",
      cwd,
      extraArgs: Array.from({ length: 31 }, (_, index) => `arg-${index}`),
    });
    expect(tooManyArgs).toMatchObject({ ok: false, code: "invalid_plan" });
  });

  it("validates an imported plan and rejects schema or executable violations", () => {
    const plan = plannedNodeCommand();
    expect(validateToolchainCommandPlan(plan)).toEqual(plan);

    expect(() => validateToolchainCommandPlan({ ...plan, schemaVersion: 99 as never })).toThrow(/schema/i);
    expect(() => validateToolchainCommandPlan({ ...plan, executable: "npm\u0000" })).toThrow(/control character/i);
    expect(() => validateToolchainCommandPlan({ ...plan, args: Array.from({ length: 33 }, () => "x") })).toThrow(/32/);
  });

  it("fails closed in the browser when no native port is connected", async () => {
    const adapter = createOmniaToolchainRuntimeAdapter({ now: () => now });
    const plan = plannedNodeCommand();

    await expect(adapter.inspectCapabilities()).resolves.toMatchObject({
      ok: false,
      code: "toolchain_runtime_unavailable",
    });
    await expect(adapter.discover("node")).resolves.toMatchObject({
      ok: false,
      code: "toolchain_runtime_unavailable",
    });
    await expect(adapter.execute(plan)).resolves.toMatchObject({
      ok: false,
      code: "toolchain_runtime_unavailable",
    });
  });

  it("passes only the validated structured plan to an injected native port", async () => {
    let received: ToolchainCommandPlan | undefined;
    const capabilities: ToolchainRuntimeCapabilities = {
      schemaVersion: TOOLCHAIN_RUNTIME_SCHEMA_VERSION,
      processExecution: "available",
      compilerDiscovery: "available",
      filesystem: "native-port",
    };
    const port = {
      inspectCapabilities: async (): Promise<ToolchainRuntimeResult<ToolchainRuntimeCapabilities>> => ({ ok: true, value: capabilities }),
      discover: async (toolchainId: ToolchainRuntimeId): Promise<ToolchainRuntimeResult<ToolchainDiscovery>> => ({
        ok: true as const,
        value: {
          schemaVersion: TOOLCHAIN_RUNTIME_SCHEMA_VERSION,
          toolchainId,
          status: "detected" as const,
          checkedAt: now,
          executable: "npm",
          version: "10.0.0",
        },
      }),
      execute: async (nextPlan: ToolchainCommandPlan) => {
        received = nextPlan;
        return {
          ok: true as const,
          value: {
            schemaVersion: TOOLCHAIN_RUNTIME_SCHEMA_VERSION,
            status: "completed" as const,
            exitCode: 0,
            durationMs: 12,
            stdout: "ok",
            stderr: "",
          },
        };
      },
    };
    const adapter = createOmniaToolchainRuntimeAdapter({ port, now: () => now });
    const plan = plannedNodeCommand();

    await expect(adapter.inspectCapabilities()).resolves.toEqual({ ok: true, value: capabilities });
    await expect(adapter.discover("node")).resolves.toMatchObject({ ok: true, value: { status: "detected", checkedAt: now } });
    await expect(adapter.execute(plan)).resolves.toMatchObject({ ok: true, value: { status: "completed", exitCode: 0 } });
    expect(received).toEqual(plan);
  });
});
