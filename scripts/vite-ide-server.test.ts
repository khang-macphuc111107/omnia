import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createIdeServerManager, discoverIdeServer, IDE_SERVER_URL, probeIdeServer, terminateIdeServerProcess, type IdeServerLaunch, type IdeServerStatus } from "./vite-ide-server";

const ownedTempDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of ownedTempDirs.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("omnia-ide-server-")) throw new Error("Unexpected temporary directory");
    await rm(resolved, { recursive: true, force: true });
  }
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnia-ide-server-"));
  ownedTempDirs.push(directory);
  return directory;
}

describe("VS Code web discovery", () => {
  it("chooses the newest valid cache instead of requiring a hardcoded version", async () => {
    const homeDir = await temporaryHome();
    const makeRuntime = async (version: string, modified: number, valid = true) => {
      const root = path.join(homeDir, ".vscode-insiders", "cli", "serve-web", version);
      await mkdir(path.join(root, "out"), { recursive: true });
      await writeFile(path.join(root, "node.exe"), "");
      if (valid) await writeFile(path.join(root, "out", "server-main.js"), "");
      await utimes(root, modified, modified);
      return root;
    };
    await makeRuntime("a".repeat(40), 100);
    const latest = await makeRuntime("b".repeat(40), 200);
    await makeRuntime("c".repeat(40), 300, false);
    const launch = await discoverIdeServer("D:\\project with spaces", { homeDir, platform: "win32" });
    expect(launch?.command).toBe(path.join(latest, "node.exe"));
    expect(launch?.args).toEqual([path.join(latest, "out", "server-main.js"), "--host", "127.0.0.1", "--port", "1430", "--accept-server-license-terms", "--without-connection-token", "--default-folder", "D:\\project with spaces"]);
  });

  it("uses the installed official CLI when its web cache has been removed", async () => {
    const homeDir = await temporaryHome();
    const localAppData = path.join(homeDir, "AppData", "Local");
    const cli = path.join(localAppData, "Programs", "Microsoft VS Code Insiders", "bin", "code-tunnel-insiders.exe");
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "");
    const launch = await discoverIdeServer("D:\\Omnia", { homeDir, localAppData, programFiles: path.join(homeDir, "ProgramFiles"), platform: "win32" });
    expect(launch?.command).toBe(cli);
    expect(launch?.args[0]).toBe("serve-web");
    expect(launch?.args.at(-1)).toBe("D:\\Omnia");
  });

  it("reports no installation rather than guessing a missing executable", async () => {
    const homeDir = await temporaryHome();
    expect(await discoverIdeServer("D:\\Omnia", { homeDir, localAppData: homeDir, programFiles: homeDir, platform: "win32" })).toBeNull();
  });
});

describe("VS Code web health", () => {
  it("requires an editor response rather than any service on the expected port", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("<title>Unrelated service</title>"));
    vi.stubGlobal("fetch", fetcher);
    expect((await probeIdeServer()).state).toBe("error");
    fetcher.mockResolvedValue(new Response('<html><script src="/out/vs/workbench/workbench.web.main.js"></script></html>'));
    expect(await probeIdeServer()).toEqual({ state: "ready", url: IDE_SERVER_URL });
  });

  it("does not follow redirects away from the loopback editor", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://example.com/" } }));
    vi.stubGlobal("fetch", fetcher);
    expect((await probeIdeServer()).state).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a stopped or unreachable editor as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect((await probeIdeServer()).state).toBe("unavailable");
  });

  it("distinguishes an unresponsive occupied port from a stopped editor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Timed out", "TimeoutError")));
    expect((await probeIdeServer()).state).toBe("error");
  });
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null as number | null,
    unref: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => { child.killed = true; child.emit("exit", null, "SIGTERM"); return true; }),
  });
  return child;
}

const unavailable: IdeServerStatus = { state: "unavailable", url: IDE_SERVER_URL };
const ready: IdeServerStatus = { state: "ready", url: IDE_SERVER_URL };
const target: IdeServerLaunch = { command: "installed-code-tunnel.exe", args: ["serve-web"] };

describe("owned editor process termination", () => {
  it("terminates a Windows child tree with fixed arguments and a bounded hidden tool", () => {
    const child = Object.assign(fakeChild(), { pid: 12345 });
    const run = vi.fn(() => ({ status: 0 }));
    terminateIdeServerProcess(child as unknown as ChildProcess, { platform: "win32", systemRoot: "C:\\Windows", run });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(path.join("C:\\Windows", "System32", "taskkill.exe"), ["/PID", "12345", "/T", "/F"], {
      windowsHide: true, stdio: "ignore", timeout: 3_000,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to the owned child if bounded tree cleanup fails", () => {
    const child = Object.assign(fakeChild(), { pid: 12345 });
    const run = vi.fn(() => ({ status: null, error: new Error("ETIMEDOUT") }));
    terminateIdeServerProcess(child as unknown as ChildProcess, { platform: "win32", run });
    expect(run).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("does not pass invalid or missing child PIDs to taskkill", () => {
    const run = vi.fn(() => ({ status: 0 }));
    for (const pid of [undefined, 0, -1, Number.NaN, 12.5]) {
      const child = Object.assign(fakeChild(), { pid });
      terminateIdeServerProcess(child as unknown as ChildProcess, { platform: "win32", run });
      expect(child.kill).toHaveBeenCalledOnce();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("does not kill a PID after its child has exited or already received termination", () => {
    const run = vi.fn(() => ({ status: 0 }));
    for (const terminalState of [{ exitCode: 0 }, { signalCode: "SIGTERM" }, { killed: true }]) {
      const child = fakeChild();
      Object.assign(child, { pid: 12345 }, terminalState);
      terminateIdeServerProcess(child as unknown as ChildProcess, { platform: "win32", run });
      expect(child.kill).not.toHaveBeenCalled();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("uses child termination on other platforms without invoking a Windows utility", () => {
    const child = Object.assign(fakeChild(), { pid: 12345 });
    const run = vi.fn(() => ({ status: 0 }));
    terminateIdeServerProcess(child as unknown as ChildProcess, { platform: "linux", run });
    expect(run).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

describe("managed VS Code web lifecycle", () => {
  it("runs owned tree cleanup exactly once when the manager stops", async () => {
    const child = fakeChild();
    const terminate = vi.fn();
    const probe = vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValue(ready);
    const manager = createIdeServerManager("D:\\Omnia", {
      probe, discover: async () => target, launch: () => child as unknown as ChildProcess, terminate,
    });
    expect(await manager.start()).toEqual(ready);
    manager.stop();
    manager.stop();
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith(child);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("coalesces concurrent starts and waits until the real readiness probe passes", async () => {
    const child = fakeChild();
    const probe = vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValue(ready);
    const launch = vi.fn(() => child as unknown as ChildProcess);
    const manager = createIdeServerManager("D:\\Omnia", { probe, discover: async () => target, launch });
    const first = manager.start();
    const second = manager.start();
    expect(first).toBe(second);
    expect(await first).toEqual(ready);
    expect(launch).toHaveBeenCalledTimes(1);
    manager.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("keeps a slow launcher alive without spawning duplicates, and bounds total startup", async () => {
    let clock = 0;
    const child = fakeChild();
    const launch = vi.fn(() => child as unknown as ChildProcess);
    const manager = createIdeServerManager("D:\\Omnia", {
      probe: async () => unavailable, discover: async () => target, launch,
      now: () => clock, wait: async (ms) => { clock += ms; },
    });
    expect((await manager.start()).state).toBe("starting");
    expect(clock).toBe(8_000);
    expect((await manager.start()).state).toBe("starting");
    expect(launch).toHaveBeenCalledTimes(1);
    clock = 90_000;
    expect((await manager.status()).state).toBe("error");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("returns startup failures and permits an explicit retry after an exited child", async () => {
    let clock = 0;
    const child = fakeChild();
    const launch = vi.fn(() => child as unknown as ChildProcess);
    const manager = createIdeServerManager("D:\\Omnia", {
      probe: async () => unavailable, discover: async () => target, launch,
      now: () => clock, wait: async (ms) => { clock += ms; child.emit("exit", 17, null); },
    });
    const failed = await manager.start();
    expect(failed.state).toBe("error");
    expect(failed.message).toContain("code 17");
    await manager.start();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("reports asynchronous spawn errors instead of leaving the UI in starting", async () => {
    const child = fakeChild();
    const manager = createIdeServerManager("D:\\Omnia", {
      probe: async () => unavailable, discover: async () => target, launch: () => child as unknown as ChildProcess,
      wait: async () => { child.emit("error", new Error("executable is missing")); },
    });
    expect(await manager.start()).toMatchObject({ state: "error", message: expect.stringContaining("executable is missing") });
  });

  it("reports a logged bind error even when the editor process stays alive", async () => {
    const child = fakeChild();
    const manager = createIdeServerManager("D:\\Omnia", {
      probe: async () => unavailable, discover: async () => target, launch: () => child as unknown as ChildProcess,
      wait: async () => { child.stderr.emit("data", "Error: listen EADDRINUSE: address already in use 127.0.0.1:1430"); },
    });
    expect(await manager.start()).toMatchObject({ state: "error", message: expect.stringContaining("already in use") });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not launch over an unrelated service or launch anything for a passive status", async () => {
    const launch = vi.fn();
    const discover = vi.fn();
    const manager = createIdeServerManager("D:\\Omnia", { probe: async () => unavailable, discover, launch });
    expect(await manager.status()).toEqual(unavailable);
    expect(discover).not.toHaveBeenCalled();
    const conflicting = createIdeServerManager("D:\\Omnia", { probe: async () => ({ state: "error", url: IDE_SERVER_URL, message: "Another service" }), discover, launch });
    expect((await conflicting.start()).state).toBe("error");
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not start a new process after shutdown wins the discovery race", async () => {
    let resolveDiscovery!: (value: IdeServerLaunch) => void;
    const discovery = new Promise<IdeServerLaunch>((resolve) => { resolveDiscovery = resolve; });
    const discover = vi.fn(() => discovery);
    const launch = vi.fn();
    const manager = createIdeServerManager("D:\\Omnia", { probe: async () => unavailable, discover, launch });
    const pending = manager.start();
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    manager.stop();
    resolveDiscovery(target);
    expect((await pending).state).toBe("unavailable");
    expect(launch).not.toHaveBeenCalled();
  });
});
