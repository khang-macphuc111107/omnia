import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { omniaIdeWorkspacePlugin } from "./vite-ide-workspace";
import { IDE_SERVER_URL, type IdeServerManager } from "./vite-ide-server";

afterEach(() => vi.unstubAllEnvs());

function endpoint() {
  vi.stubEnv("VITEST", "true");
  const editor: IdeServerManager = {
    status: vi.fn(async () => ({ state: "unavailable" as const, url: IDE_SERVER_URL })),
    start: vi.fn(async () => ({ state: "ready" as const, url: IDE_SERVER_URL })),
    stop: vi.fn(),
  };
  let handler!: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
  const httpServer = new EventEmitter();
  const plugin = omniaIdeWorkspacePlugin({ editorServer: editor });
  if (typeof plugin.configureServer !== "function") throw new Error("Expected a configure hook");
  const configure = plugin.configureServer;
  configure.call({} as ThisParameterType<typeof configure>, { httpServer, middlewares: { use: (middleware: typeof handler) => { handler = middleware; } } } as unknown as ViteDevServer);
  const send = (method: string, headers: Record<string, string> = {}, url = "/__omnia_ide_server") => new Promise<{ status: number; headers: Record<string, unknown>; body: Record<string, unknown> }>((resolve) => {
    const responseHeaders: Record<string, unknown> = {};
    const response = {
      statusCode: 200,
      setHeader: (key: string, value: unknown) => { responseHeaders[key] = value; },
      end(body: string) { resolve({ status: this.statusCode, headers: responseHeaders, body: JSON.parse(body) as Record<string, unknown> }); },
    };
    const request = { method, url, headers: { host: "127.0.0.1:1420", ...headers } };
    handler(request as IncomingMessage, response as unknown as ServerResponse, () => resolve({ status: 404, headers: {}, body: {} }));
  });
  return { editor, httpServer, send };
}

describe("local embedded editor endpoint", () => {
  it("GET returns passive health with the UI status contract and no-cache headers", async () => {
    const { editor, send } = endpoint();
    const response = await send("GET");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: "unavailable", url: IDE_SERVER_URL });
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(editor.start).not.toHaveBeenCalled();
  });

  it("requires an explicit workbench header before starting the installed editor", async () => {
    const { editor, send } = endpoint();
    expect((await send("POST")).status).toBe(403);
    expect(editor.start).not.toHaveBeenCalled();
    const response = await send("POST", { "x-omnia-workbench": "editor-server-start", origin: "http://127.0.0.1:1420" });
    expect(response.body).toEqual({ state: "ready", url: IDE_SERVER_URL });
    expect(editor.start).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin and non-loopback requests before touching the editor", async () => {
    const { editor, send } = endpoint();
    expect((await send("GET", { host: "public.example" })).status).toBe(403);
    expect((await send("POST", { origin: "https://other.example", "x-omnia-workbench": "editor-server-start" })).status).toBe(403);
    expect(editor.status).not.toHaveBeenCalled();
    expect(editor.start).not.toHaveBeenCalled();
  });

  it("rejects unsupported methods and passes unrelated requests through", async () => {
    const { editor, send } = endpoint();
    const response = await send("DELETE");
    expect(response.status).toBe(405);
    expect(response.headers.Allow).toBe("GET, POST");
    expect((await send("GET", {}, "/somewhere-else")).status).toBe(404);
    expect(editor.start).not.toHaveBeenCalled();
  });

  it("stops only the managed companion when the preview server closes", () => {
    const { editor, httpServer } = endpoint();
    httpServer.emit("close");
    expect(editor.stop).toHaveBeenCalledTimes(1);
  });
});
