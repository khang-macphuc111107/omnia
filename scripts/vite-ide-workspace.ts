import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";
import { createIdeServerManager, type IdeServerManager } from "./vite-ide-server";

interface WorkspaceFolder { name: string; path: string }
interface WorkspaceDocument { folders: WorkspaceFolder[]; settings?: Record<string, unknown> }

const spawnedCompanions = new Set<ChildProcess>();
const managedEditors = new Set<IdeServerManager>();

function stopSpawnedCompanions(): void {
  for (const editor of managedEditors) editor.stop();
  managedEditors.clear();
  for (const child of spawnedCompanions) {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // Ignore already-terminated companion processes
      }
    }
  }
  spawnedCompanions.clear();
}

process.once("exit", stopSpawnedCompanions);

function isPortListening(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function ensureCompanionServices(workspaceRoot: string, editorServer: IdeServerManager): Promise<void> {
  if (process.env.VITEST) return;
  const homeDir = os.homedir();
  void editorServer.start();

  const claudeProxy = path.join(homeDir, ".claude", "tools", "omnia-claude-cache-proxy.cjs");
  if (existsSync(claudeProxy) && !(await isPortListening(52535))) {
    try {
      const child = spawn(process.execPath, [claudeProxy], {
        cwd: workspaceRoot,
        stdio: "ignore",
        windowsHide: true,
      });
      spawnedCompanions.add(child);
      child.once("exit", () => spawnedCompanions.delete(child));
      child.on("error", () => spawnedCompanions.delete(child));
      child.unref();
    } catch {
      // Best-effort companion launch
    }
  }
}

/**
 * Workspace writes target only the fixed .code-workspace file. The editor route
 * starts only a discovered installed VS Code runtime, with fixed local arguments.
 */
export function omniaIdeWorkspacePlugin(options: { editorServer?: IdeServerManager } = {}): Plugin {
  let workspaceFile = "";
  let workspaceRoot = "";
  let serializedUpdate: Promise<unknown> = Promise.resolve();
  let editorServer = options.editorServer;
  const getEditorServer = () => {
    if (!editorServer) editorServer = createIdeServerManager(workspaceRoot || process.cwd());
    managedEditors.add(editorServer);
    return editorServer;
  };

  const middleware = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const editorRequest = requestUrl.pathname === "/__omnia_ide_server";
    if (!editorRequest && requestUrl.pathname !== "/__omnia_ide_workspace") { next(); return; }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const fail = (status: number, message: string) => { response.statusCode = status; response.end(JSON.stringify({ error: message })); };
    const host = request.headers.host ?? "";
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) { fail(403, "Workspace updates are local-only"); return; }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) { fail(403, "Cross-origin workspace access denied"); return; }
    if (request.method !== "GET" && request.method !== "POST") { response.setHeader("Allow", "GET, POST"); fail(405, "Unsupported method"); return; }
    try {
      if (editorRequest) {
        if (request.method === "POST" && request.headers["x-omnia-workbench"] !== "editor-server-start") {
          fail(403, "Editor startup requires an explicit local workbench request");
          return;
        }
        const status = request.method === "POST" ? await getEditorServer().start() : await getEditorServer().status();
        response.end(JSON.stringify(status));
        return;
      }
      if (request.method === "GET") {
        await serializedUpdate;
        const document = JSON.parse(await readFile(workspaceFile, "utf8")) as WorkspaceDocument;
        response.end(JSON.stringify({ folders: document.folders, workspacePath: workspaceFile }));
        return;
      }
      if (request.headers["x-omnia-workbench"] !== "workspace-folder-update" || !request.headers["content-type"]?.startsWith("application/json")) { fail(403, "Workspace update requires an explicit local workbench request"); return; }
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body, "utf8") > 32_768) { fail(413, "Workspace request too large"); return; }
      }
      const input = JSON.parse(body) as { folders?: unknown };
      if (!Array.isArray(input.folders) || input.folders.length === 0 || input.folders.length > 32) { fail(400, "A workspace needs between 1 and 32 project folders"); return; }
      const folders: WorkspaceFolder[] = [];
      const seen = new Set<string>();
      for (const value of input.folders as unknown[]) {
        if (!value || typeof value !== "object") { fail(400, "Invalid project folder"); return; }
        const item = value as Record<string, unknown>;
        if (typeof item.path !== "string" || !/^[A-Za-z]:[\\/]/.test(item.path) || item.path.length > 1000 || /[\0\r\n]/.test(item.path)) { fail(400, "Choose an absolute local project folder path"); return; }
        const directory = await realpath(item.path);
        if (!(await stat(directory)).isDirectory()) { fail(400, "Project path is not a directory"); return; }
        const key = directory.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        folders.push({ name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : path.basename(directory), path: directory });
      }
      const update = serializedUpdate.catch(() => undefined).then(async () => {
        const current = JSON.parse(await readFile(workspaceFile, "utf8")) as WorkspaceDocument;
        await writeFile(workspaceFile, `${JSON.stringify({ ...current, folders }, null, 2)}\n`, "utf8");
      });
      serializedUpdate = update;
      await update;
      response.end(JSON.stringify({ folders, workspacePath: workspaceFile }));
    } catch (error) {
      const cause = error as NodeJS.ErrnoException;
      fail(cause.code === "ENOENT" ? 404 : 400, cause.code === "ENOENT" ? "Project folder or workspace file was not found" : error instanceof SyntaxError ? "Invalid workspace JSON" : error instanceof Error ? error.message : "Workspace update failed");
    }
  };

  return {
    name: "omnia-ide-multi-root-workspace",
    configResolved(config) {
      workspaceRoot = config.root;
      workspaceFile = path.resolve(config.root, "omnia.code-workspace");
    },
    configureServer(server) {
      void ensureCompanionServices(workspaceRoot || process.cwd(), getEditorServer());
      server.httpServer?.once("close", stopSpawnedCompanions);
      server.middlewares.use((request, response, next) => { void middleware(request, response, next); });
    },
    configurePreviewServer(server) {
      void ensureCompanionServices(workspaceRoot || process.cwd(), getEditorServer());
      server.httpServer?.once("close", stopSpawnedCompanions);
      server.middlewares.use((request, response, next) => { void middleware(request, response, next); });
    },
  };
}

