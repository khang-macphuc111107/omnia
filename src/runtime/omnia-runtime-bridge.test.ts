import { describe, expect, it, vi } from "vitest";

import type { AppRuntimeInfo, RunStreamEvent } from "@/lib/desktop";
import type { CoreRuntimeInfo } from "@/lib/core-protocol";

import {
  createBrowserPreviewRuntimePort,
  createOmniaRuntimeBridge,
  type RendererRuntimePort,
  type RuntimeRunEventListener,
} from "./omnia-runtime-bridge";

const browserInfo: AppRuntimeInfo = {
  appName: "Omnia",
  appVersion: "0.1.0-dev",
  platform: "web",
  tauri: false,
  debug: true,
};

const browserCore: CoreRuntimeInfo = {
  protocolVersion: "1.0",
  serverInfo: {
    name: "omnia-browser-preview",
    title: "Omnia Browser Preview",
    version: "0.1.0-dev",
  },
  capabilities: ["run.stream.v1"],
  unavailableCapabilities: ["memory.read-write", "workspace.write"],
  sessionToken: null,
  sessionEpoch: null,
};

function fakePort(overrides: Partial<RendererRuntimePort> = {}) {
  let runListener: RuntimeRunEventListener | null = null;
  let unlistenCount = 0;
  const port: RendererRuntimePort = {
    runtimeInfo: vi.fn(async () => browserInfo),
    initializeCore: vi.fn(async () => browserCore),
    onRunEvent: vi.fn(async (listener) => {
      runListener = listener;
      return () => {
        unlistenCount += 1;
        runListener = null;
      };
    }),
    ...overrides,
  };
  return {
    port,
    emit(event: RunStreamEvent) {
      runListener?.(event);
    },
    getUnlistenCount() {
      return unlistenCount;
    },
  };
}

describe("Omnia runtime bridge", () => {
  it("negotiates browser preview once and exposes the pure runtime controller", async () => {
    const fake = fakePort();
    const bridge = createOmniaRuntimeBridge({
      port: fake.port,
      controllerOptions: { now: () => "2026-10-17T00:00:00.000Z" },
    });

    const first = bridge.initialize();
    const second = bridge.initialize();
    const [one, two] = await Promise.all([first, second]);

    expect(one.snapshot).toMatchObject({
      mode: "browser",
      status: "ready",
      lifecycleEpoch: 1,
      runtimeInfo: browserInfo,
      core: browserCore,
    });
    expect(two.snapshot).toEqual(one.snapshot);
    expect(fake.port.runtimeInfo).toHaveBeenCalledTimes(1);
    expect(fake.port.initializeCore).toHaveBeenCalledTimes(1);
    expect(one.controller).toBe(bridge.getController());
    expect(bridge.isReady()).toBe(true);
    expect(bridge.isBrowserPreview()).toBe(true);
    expect(bridge.isDesktop()).toBe(false);
    expect(bridge.hasCapability("run.stream.v1")).toBe(true);
    expect(bridge.getCapabilityState("memory.read-write")).toBe("unavailable");
    expect(bridge.getCapabilities()).toEqual(["run.stream.v1"]);
  });

  it("keeps run-event cleanup idempotent and ignores callbacks after disposal", async () => {
    const fake = fakePort();
    const bridge = createOmniaRuntimeBridge({ port: fake.port });
    await bridge.initialize();

    const received: RunStreamEvent[] = [];
    const unsubscribe = await bridge.subscribeRunEvents((event) => received.push(event));
    fake.emit({ type: "warning", runId: "run-1", code: "preview", message: "local" });
    expect(received).toHaveLength(1);

    await unsubscribe();
    await unsubscribe();
    expect(fake.getUnlistenCount()).toBe(1);

    const secondUnsubscribe = await bridge.subscribeRunEvents((event) => received.push(event));
    await bridge.dispose();
    fake.emit({ type: "warning", runId: "run-2", code: "late", message: "ignored" });
    await secondUnsubscribe();

    expect(received).toHaveLength(1);
    expect(bridge.getSnapshot()).toMatchObject({ status: "disposed", lifecycleEpoch: 2 });
    expect(fake.getUnlistenCount()).toBe(2);
  });

  it("fails with a stable code and permits a later retry", async () => {
    const runtimeInfo = vi
      .fn<RendererRuntimePort["runtimeInfo"]>()
      .mockRejectedValueOnce({ code: "offline", retryable: true, message: "runtime unavailable" })
      .mockResolvedValue(browserInfo);
    const fake = fakePort({ runtimeInfo });
    const bridge = createOmniaRuntimeBridge({ port: fake.port });

    await expect(bridge.initialize()).rejects.toMatchObject({
      code: "runtime_info_failed",
      message: "runtime unavailable",
      retryable: true,
    });
    expect(bridge.getSnapshot()).toMatchObject({ status: "failed", lifecycleEpoch: 1 });

    await expect(bridge.initialize()).resolves.toMatchObject({
      snapshot: { status: "ready", lifecycleEpoch: 2 },
    });
    expect(runtimeInfo).toHaveBeenCalledTimes(2);
  });

  it("does not allow event subscriptions before negotiation", async () => {
    const bridge = createOmniaRuntimeBridge({ port: fakePort().port });
    await expect(bridge.subscribeRunEvents(() => undefined)).rejects.toThrow(
      "Initialize the Omnia runtime before subscribing to run events.",
    );
  });

  it("provides an explicit in-memory browser port without native authority", async () => {
    const port = createBrowserPreviewRuntimePort({ appVersion: "1.2.3", debug: true });
    const bridge = createOmniaRuntimeBridge({ port });
    await bridge.initialize();

    const events: RunStreamEvent[] = [];
    const unsubscribe = await bridge.subscribeRunEvents((event) => events.push(event));
    port.emitRunEvent({ type: "warning", runId: "preview-run", code: "local", message: "preview" });
    await unsubscribe();

    expect(bridge.getSnapshot()).toMatchObject({
      mode: "browser",
      runtimeInfo: { appVersion: "1.2.3", debug: true },
      core: { sessionToken: null, sessionEpoch: null },
    });
    expect(events).toHaveLength(1);
  });

  it("keeps capability resolution unknown before negotiation and after disposal", async () => {
    const port = createBrowserPreviewRuntimePort();
    const bridge = createOmniaRuntimeBridge({ port });

    expect(bridge.getCapabilityState("run.stream.v1")).toBe("unknown");
    expect(bridge.hasCapability("run.stream.v1")).toBe(false);
    await bridge.initialize();
    expect(bridge.getCapabilityState("run.replay-cursor")).toBe("unavailable");
    expect(bridge.getCapabilityState("does.not.exist")).toBe("unknown");
    await bridge.dispose();
    expect(bridge.getCapabilityState("run.stream.v1")).toBe("unknown");
    expect(bridge.getCapabilities()).toEqual([]);
  });
});
