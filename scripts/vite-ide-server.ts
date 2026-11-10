import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const IDE_SERVER_URL = "http://127.0.0.1:1430";

export interface IdeServerStatus {
  state: "ready" | "starting" | "unavailable" | "error";
  url: string;
  message?: string;
}

export interface IdeServerLaunch {
  command: string;
  args: string[];
}

interface IdeProcessTerminationOptions {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  run?: (command: string, args: string[], options: SpawnSyncOptions) => { status: number | null; error?: Error };
}

/** Terminate only the tree belonging to the child this manager launched. */
export function terminateIdeServerProcess(child: ChildProcess, options: IdeProcessTerminationOptions = {}): void {
  if (child.exitCode !== null || child.signalCode != null || child.killed) return;
  const pid = child.pid;
  if ((options.platform ?? process.platform) === "win32" && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
    try {
      // Killing just the vendor CLI can leave its cmd/node descendants holding
      // the inherited listener. No shell is used and the PID comes from spawn.
      const taskkill = path.join(options.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      const outcome = (options.run ?? spawnSync)(taskkill, ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 3_000,
      });
      if (!outcome.error && outcome.status === 0) return;
    } catch { /* Fall back to the owned child if tree cleanup is unavailable. */ }
  }
  try { child.kill(); } catch { /* It may already have exited. */ }
}

interface DiscoveryOptions {
  homeDir?: string;
  localAppData?: string;
  programFiles?: string;
  platform?: NodeJS.Platform;
}

/** Use an installed runtime or the vendor's installed launcher, never a pinned cache hash. */
export async function discoverIdeServer(workspaceRoot: string, options: DiscoveryOptions = {}): Promise<IdeServerLaunch | null> {
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const args = ["--host", "127.0.0.1", "--port", "1430", "--accept-server-license-terms", "--without-connection-token", "--default-folder", workspaceRoot];
  for (const installation of [".vscode-insiders", ".vscode", ".vscode-oss"]) {
    const cache = path.join(homeDir, installation, "cli", "serve-web");
    const versions = await readdir(cache, { withFileTypes: true }).catch(() => []);
    const runtimes = await Promise.all(versions.filter((entry) => entry.isDirectory() && /^[a-f\d]{40}$/i.test(entry.name)).map(async (entry) => {
      const root = path.join(cache, entry.name);
      const node = path.join(root, platform === "win32" ? "node.exe" : "node");
      const main = path.join(root, "out", "server-main.js");
      if (!existsSync(node) || !existsSync(main)) return null;
      const metadata = await stat(root).catch(() => null);
      return metadata ? { command: node, args: [main, ...args], modified: metadata.mtimeMs, root } : null;
    }));
    const latest = runtimes.filter((runtime) => runtime !== null).sort((a, b) => b.modified - a.modified || a.root.localeCompare(b.root))[0];
    if (latest) return { command: latest.command, args: latest.args };
  }

  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
  const programFiles = options.programFiles ?? process.env.ProgramFiles ?? "C:\\Program Files";
  const candidates = platform === "win32"
    ? [path.join(localAppData, "Programs"), programFiles].flatMap((root) => [
      path.join(root, "Microsoft VS Code Insiders", "bin", "code-tunnel-insiders.exe"),
      path.join(root, "Microsoft VS Code", "bin", "code-tunnel.exe"),
    ])
    : platform === "darwin"
      ? ["/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-tunnel-insiders", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code-tunnel"]
      : ["/usr/share/code-insiders/bin/code-tunnel-insiders", "/usr/share/code/bin/code-tunnel"];
  const command = candidates.find((candidate) => existsSync(candidate));
  return command ? { command, args: ["serve-web", ...args] } : null;
}

/** A TCP listener alone is not evidence that the editor is ready. */
export async function probeIdeServer(): Promise<IdeServerStatus> {
  let url = IDE_SERVER_URL;
  try {
    const signal = AbortSignal.timeout(1_500);
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await fetch(url, { redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400) {
        const destination = new URL(response.headers.get("location") ?? "", url);
        await response.body?.cancel();
        if (destination.origin !== IDE_SERVER_URL) break;
        url = destination.href;
        continue;
      }
      const html = (await response.text()).slice(0, 262_144);
      if (response.ok && /(?:vscode[-.]workbench|workbench\.web\.main|visual studio code)/i.test(html)) {
        return { state: "ready", url: IDE_SERVER_URL };
      }
      break;
    }
    return { state: "error", url: IDE_SERVER_URL, message: "Port 1430 is responding, but it is not a ready VS Code web editor. Close the conflicting service or check its startup log." };
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { state: "error", url: IDE_SERVER_URL, message: "The editor address did not respond. Check the service using port 1430 before retrying." };
    }
    return { state: "unavailable", url: IDE_SERVER_URL, message: "The embedded editor is not running." };
  }
}

interface IdeServerOperations {
  discover: () => Promise<IdeServerLaunch | null>;
  probe: () => Promise<IdeServerStatus>;
  launch: (target: IdeServerLaunch) => ChildProcess;
  terminate: (child: ChildProcess) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

export interface IdeServerManager {
  status: () => Promise<IdeServerStatus>;
  start: () => Promise<IdeServerStatus>;
  stop: () => void;
}

/** One managed child per preview, including while the official CLI prepares its runtime. */
export function createIdeServerManager(workspaceRoot: string, overrides: Partial<IdeServerOperations> = {}): IdeServerManager {
  const operations: IdeServerOperations = {
    discover: () => discoverIdeServer(workspaceRoot),
    probe: probeIdeServer,
    launch: (target) => spawn(target.command, target.args, { cwd: workspaceRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
    terminate: terminateIdeServerProcess,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    ...overrides,
  };
  let child: ChildProcess | null = null;
  let startedAt = 0;
  let startup: Promise<IdeServerStatus> | null = null;
  let failure: string | null = null;
  let stopped = false;
  let wasReady = false;
  const result = (state: IdeServerStatus["state"], message?: string): IdeServerStatus => ({ state, url: IDE_SERVER_URL, ...(message ? { message } : {}) });
  const killChild = () => {
    const previous = child;
    child = null;
    if (previous && !previous.killed) {
      try { operations.terminate(previous); } catch { /* It may already have exited. */ }
    }
  };
  const status = async (): Promise<IdeServerStatus> => {
    const observed = await operations.probe();
    if (observed.state === "ready") { wasReady = true; return observed; }
    if (child) {
      if (operations.now() - startedAt >= 90_000) {
        failure = "VS Code web did not become ready within 90 seconds. Retry to start it again.";
        killChild();
        return result("error", failure);
      }
      return result("starting", "Starting the embedded editor…");
    }
    if (failure) return result("error", failure);
    return observed;
  };
  const startOnce = async (): Promise<IdeServerStatus> => {
    if (stopped) return result("unavailable", "The editor preview has stopped.");
    const observed = await operations.probe();
    if (stopped) return result("unavailable", "The editor preview has stopped.");
    if (observed.state === "ready" || observed.state === "error") return observed;
    if (child) return status();
    const target = await operations.discover();
    if (stopped) return result("unavailable", "The editor preview has stopped.");
    if (!target) return result("unavailable", "VS Code web is not installed. Install VS Code or VS Code Insiders, then retry.");
    failure = null;
    wasReady = false;
    try {
      const launched = operations.launch(target);
      child = launched;
      startedAt = operations.now();
      let startupOutput = "";
      const captureStartup = (chunk: Buffer | string) => {
        if (child !== launched || wasReady) return;
        startupOutput = `${startupOutput}${String(chunk)}`.slice(-4_096);
        // VS Code can log a bind failure while keeping its extension-host
        // services alive. Waiting only for process exit would report starting.
        const bindFailure = /Error:\s+listen\s+(EADDRINUSE|EACCES)\b/.exec(startupOutput)?.[1];
        if (bindFailure) {
          failure = bindFailure === "EADDRINUSE"
            ? "Port 1430 is already in use. Stop its existing service before retrying the embedded editor."
            : "The embedded editor cannot bind to port 1430 (access denied). Check the local service configuration before retrying.";
          killChild();
        }
      };
      launched.stdout?.on("data", captureStartup);
      launched.stderr?.on("data", captureStartup);
      launched.once("error", (error) => {
        if (child !== launched) return;
        child = null;
        failure = `VS Code web could not start: ${error.message}`;
      });
      launched.once("exit", (code, signal) => {
        if (child !== launched) return;
        child = null;
        failure = `VS Code web ${wasReady ? "stopped" : "exited before it was ready"} (${signal ?? `code ${code ?? "unknown"}`}). Retry to start it again.`;
      });
      launched.unref();
      const deadline = startedAt + 8_000;
      do {
        const current = await status();
        if (current.state !== "starting") return current;
        await operations.wait(200);
      } while (operations.now() < deadline && !stopped);
      return stopped ? result("unavailable", "The editor preview has stopped.") : status();
    } catch (error) {
      failure = `VS Code web could not start: ${error instanceof Error ? error.message : String(error)}`;
      killChild();
      return result("error", failure);
    }
  };
  return {
    status,
    start() {
      if (startup) return startup;
      const pending = startOnce().catch((error: unknown) => result("error", error instanceof Error ? error.message : "The editor could not start."));
      startup = pending;
      void pending.finally(() => { if (startup === pending) startup = null; });
      return pending;
    },
    stop() { stopped = true; killChild(); },
  };
}
