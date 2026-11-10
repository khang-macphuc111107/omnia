import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const DEFAULT_HOST = process.env.OMNIA_PREVIEW_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number.parseInt(process.env.OMNIA_PREVIEW_PORT ?? "1420", 10);

function positiveEnvMs(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value >= 100 ? value : fallback;
}

// The first Vite request can be slower on a cold Windows process, especially
// when the source tree is backed by a junction. Keep the launcher quick while
// avoiding a false timeout before the server has finished its first response.
const STARTUP_TIMEOUT_MS = positiveEnvMs("OMNIA_PREVIEW_STARTUP_TIMEOUT_MS", 30_000);
const PROBE_TIMEOUT_MS = positiveEnvMs("OMNIA_PREVIEW_PROBE_TIMEOUT_MS", 1_200);
const PROBE_INTERVAL_MS = positiveEnvMs("OMNIA_PREVIEW_PROBE_INTERVAL_MS", 200);

function printHelp() {
  process.stdout.write(`Omnia fast browser preview launcher\n\nUsage:\n  npm run preview:fast [-- --open] [-- --port 1420] [-- --host 127.0.0.1]\n\nThe launcher reuses an existing Omnia preview on the selected port. If the\nport is free, it starts Vite and waits for the page to answer before returning\ncontrol to the running dev server.\n\nOptions:\n  --host <host>       Bind host (default: ${DEFAULT_HOST})\n  --port <port>       Bind port (default: ${DEFAULT_PORT})\n  --open              Ask the OS to open the preview URL after it is ready\n  --no-reuse          Fail when the selected port already serves Omnia\n  --help              Show this help\n`);
}

function readArgs(argv) {
  const result = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    open: false,
    reuse: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    if (argument === "--open") {
      result.open = true;
      continue;
    }
    if (argument === "--no-reuse") {
      result.reuse = false;
      continue;
    }
    if (argument === "--host" || argument.startsWith("--host=")) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argv[++index];
      if (!value) throw new Error("--host requires a value");
      result.host = value;
      continue;
    }
    if (argument === "--port" || argument.startsWith("--port=")) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argv[++index];
      const port = Number.parseInt(value ?? "", 10);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error("--port must be an integer between 1024 and 65535");
      }
      result.port = port;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (!result.host.trim()) throw new Error("--host cannot be empty");
  return result;
}

function urlHost(host) {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function previewUrl(host, port) {
  return `http://${urlHost(host)}:${port}/`;
}

async function probe(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    const body = (await response.text()).slice(0, 64 * 1024);
    const isOmnia = response.ok && /omnia/i.test(body);
    return { reachable: true, status: response.status, isOmnia };
  } catch {
    return { reachable: false, status: 0, isOmnia: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForPreview(url, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited before the preview became ready (code ${child.exitCode ?? "unknown"}).`);
    }
    const result = await probe(url);
    if (result.isOmnia) return result;
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for Omnia at ${url}.`);
}

function openUrl(url) {
  const platform = process.platform;
  if (platform === "win32") {
    const opener = spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
    opener.unref();
    return;
  }
  const command = platform === "darwin" ? "open" : "xdg-open";
  const opener = spawn(command, [url], { detached: true, stdio: "ignore" });
  opener.unref();
}

function spawnVite(host, port) {
  // Invoke Vite through the current Node runtime instead of a shell/npm shim.
  // This avoids Windows `npm.cmd` spawn quirks and keeps the preview launcher
  // free of shell interpolation while preserving the same Vite server flags.
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const viteEntry = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
  return spawn(process.execPath, [viteEntry, "--configLoader", "runner", "--host", host, "--port", String(port)], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: false,
  });
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const url = previewUrl(options.host, options.port);
  const existing = await probe(url);
  if (existing.reachable) {
    if (existing.isOmnia && options.reuse) {
      process.stdout.write(`OMNIA_PREVIEW_REUSED ${url}\n`);
      if (options.open) openUrl(url);
      return;
    }
    throw new Error(`Port ${options.port} is already serving another response at ${url}. Use --port <free-port> or stop that process.`);
  }

  const child = spawnVite(options.host, options.port);
  let shuttingDown = false;
  const stopChild = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child.exitCode === null) child.kill();
  };
  process.once("SIGINT", stopChild);
  process.once("SIGTERM", stopChild);

  try {
    await waitForPreview(url, child);
  } catch (error) {
    // Do not leave a background Vite process behind when cold-start fails.
    stopChild();
    throw error;
  }
  process.stdout.write(`OMNIA_PREVIEW_READY ${url}\n`);
  if (options.open) openUrl(url);

  await new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (signal) resolve();
      else if (code === 0 || shuttingDown) resolve();
      else reject(new Error(`Vite exited with code ${code}.`));
    });
    child.once("error", reject);
  });
}

main().catch((error) => {
  process.stderr.write(`OMNIA_PREVIEW_ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
