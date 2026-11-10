import { configDefaults, defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { omniaIdeWorkspacePlugin } from "./scripts/vite-ide-workspace";
import { browserContextBridge } from "./scripts/browser-context-bridge";
import type { IncomingMessage, ServerResponse } from "node:http";

const host = process.env.TAURI_DEV_HOST;
const emitSourceMap = process.env.OMNIA_BUILD_SOURCEMAP === "true";

function escapeBrowserHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function browserProxyNotice(title: string, message: string, targetUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeBrowserHtml(title)}</title><style>body{margin:0;padding:36px;background:#1e1e1e;color:#d4d4d4;font:13px/1.6 system-ui,sans-serif}main{max-width:680px}h1{font-size:18px;font-weight:500}code{font:12px Consolas,monospace;overflow-wrap:anywhere}a{color:#d4d4d4}p{color:#adadad}</style></head><body><main><h1>${escapeBrowserHtml(title)}</h1><p>${escapeBrowserHtml(message)}</p><code>${escapeBrowserHtml(targetUrl)}</code><p><a href="${escapeBrowserHtml(targetUrl)}" target="_blank" rel="noopener noreferrer">Open in the host browser</a></p></main></body></html>`;
}

async function serveSovereignBrowserProxy(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end("The browsing proxy accepts GET and HEAD only.");
    return;
  }
  const requestUrl = new URL(req.url ?? "", "http://127.0.0.1:1420");
  const target = requestUrl.searchParams.get("url");
  let targetUrl: URL;
  try {
    targetUrl = new URL(target ?? "");
    if (!/^https?:$/.test(targetUrl.protocol) || targetUrl.username || targetUrl.password) throw new Error("Unsupported URL");
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Enter a valid http:// or https:// URL without embedded credentials.");
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // A proxied third-party document must never inherit the Omnia renderer origin.
  res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
  if (targetUrl.hostname.endsWith(".omnia.local")) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(browserProxyNotice("Offline media fixture", "This reserved address is a local test fixture, not a live stream or a connected Chromium session. Enter a website address to browse.", targetUrl.href));
    return;
  }
  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const finalUrl = upstream.url || targetUrl.href;
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Omnia-Upstream-Status", String(upstream.status));
    res.setHeader("X-Omnia-Final-Url", finalUrl);
    if (req.method === "HEAD") { res.end(); return; }
    if (contentType.toLowerCase().includes("text/html")) {
      let html = await upstream.text();
      if (html.length > 8_000_000) throw new Error("HTML response exceeds the 8 MB browsing limit");
      const baseTag = `<base href="${escapeBrowserHtml(finalUrl)}">`;
      // The proxy deliberately removes framing restrictions; the outer sandbox remains enforced.
      html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (match) => `${match}${baseTag}`) : `${baseTag}${html}`;
      const bridge = browserContextBridge(finalUrl);
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${bridge}</body>`) : `${html}${bridge}`;
      res.end(html);
    } else {
      const body = await upstream.arrayBuffer();
      res.end(Buffer.from(body));
    }
  } catch (cause) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(browserProxyNotice("Page could not be loaded", cause instanceof Error ? cause.message : "The upstream website did not respond.", targetUrl.href));
  }
}

function omniaSovereignBrowserProxyPlugin(): Plugin {
  return {
    name: "omnia-sovereign-browser-proxy",
    configureServer(server) {
      server.middlewares.use("/__omnia_browser_proxy", (req, res) => { void serveSovereignBrowserProxy(req, res); });
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__omnia_browser_proxy", (req, res) => { void serveSovereignBrowserProxy(req, res); });
    },
  };
}

export default defineConfig({
  plugins: [react(), omniaSovereignBrowserProxyPlugin(), omniaIdeWorkspacePlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Keep the UI-first preview responsive and avoid watching large vendored
      // research/generated trees. Those trees contain thousands of transient
      // TypeScript fixtures and can exhaust Windows file-watch handles or
      // surface EBUSY while the renderer is otherwise healthy.
      ignored: [
        "**/src-tauri/**",
        // Vendored upstream captures are large, mostly immutable trees. They
        // are inputs for audit scripts, not renderer source, so watching them
        // can create tens of thousands of Windows handles and delay the
        // preview server before the first request is served.
        "**/upstream_extractions/**",
        "**/research/**",
        "**/artifacts/**",
        "**/dist-*/**",
        "**/.typert-*/**",
        // Cargo target dirs hold build-script .exe files that Windows locks while
        // they run; watching them crashes the dev server with EBUSY.
        "**/.cargo-target*/**",
        "**/target/**",
      ],
    },
  },
  build: {
    modulePreload: false,
    target: "es2022",
    minify: "terser",
    terserOptions: {
      module: true,
      compress: {
        ecma: 2022,
        passes: 3,
        pure_getters: true,
        unsafe_arrows: true,
        unsafe_methods: true,
        hoist_funs: true,
        toplevel: true,
      },
      mangle: {
        toplevel: true,
      },
      format: {
        comments: false,
        ecma: 2022,
      },
    },
    // Source maps are useful for explicit bundle attribution/debug evidence,
    // but they add multi-megabyte artifacts and noticeable rebuild time to
    // the normal UI-first loop. Opt in when a release/debug receipt needs it.
    sourcemap: emitSourceMap,
    manifest: true,
    rollupOptions: {
      output: {
        // Do not move shared dependencies into a feature chunk: the Agent shell
        // also uses workspace contracts, which would otherwise eagerly pull the
        // entire Labs composer into startup through one of those contracts.
        onlyExplicitManualChunks: true,
        /**
         * Keep Agent startup independent of Labs and its legacy activities.
         * Vendor/runtime groups are shared cache boundaries; composer and
         * project-planning implementations remain in their owning lazy graphs.
         * The legacy chat view stays synchronous within the Labs shell.
         */
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (normalizedId.includes("/node_modules/react/") || normalizedId.includes("/node_modules/react-dom/") || normalizedId.includes("/node_modules/scheduler/")) {
            return "vendor-react";
          }
          if (normalizedId.includes("/node_modules/@tauri-apps/") && !normalizedId.includes("/node_modules/@tauri-apps/api/window")) {
            return "vendor-tauri";
          }
          if (normalizedId.includes("/node_modules/lucide-react/")) {
            return "vendor-icons";
          }
          if (
            normalizedId.includes("/node_modules/framer-motion/") ||
            normalizedId.includes("/node_modules/motion-dom/") ||
            normalizedId.includes("/node_modules/motion-utils/")
          ) {
            return "vendor-motion";
          }
          // These are substantial implementation boundaries, not route wrappers.
          // Keep the chat view synchronous within Labs, but cache its composer
          // separately from shell/navigation. Project planning likewise belongs
          // to the lazy Projects graph, never to the Agent/Labs startup shell.
          if (/\/src\/features\/workspace\/(?:composer(?:-[^/]+)?|ai-panel-composer)\.[jt]sx?$/.test(normalizedId)) {
            return "workspace-composer";
          }
          if (/\/src\/features\/workspace\/(?:project-planning-preview|project-policy-summary|project-scope-inheritance-preview|project-activity-timeline|project-workspace-grant-preview)\.tsx$/.test(normalizedId)) {
            return "project-planning";
          }
          if (normalizedId.endsWith("/src/lib/desktop.ts")) {
            return "desktop-client";
          }
          if (normalizedId.endsWith("/src/features/workspace/store.ts")) {
            return "workspace-store";
          }
          if (
            normalizedId.endsWith("/src/features/workspace/mock-data.ts") ||
            normalizedId.endsWith("/src/features/workspace/conversation-catalog.ts") ||
            normalizedId.endsWith("/src/features/workspace/run-journal-projection.ts")
          ) {
            return "workspace-catalog";
          }
          if (
            normalizedId.endsWith("/src/domain/omnia-ultra-downloader.ts") ||
            normalizedId.endsWith("/src/domain/sovereign-browser-devtools.ts") ||
            normalizedId.endsWith("/src/domain/harness-throughput-optimizer.ts")
          ) {
            return "omnia-sovereign-domain";
          }
          if (
            normalizedId.endsWith("/src/domain/omnia-builtin-tools.ts") ||
            normalizedId.endsWith("/src/domain/session-dfs-tree.ts") ||
            normalizedId.endsWith("/src/domain/local-model-hardware-advisor.ts") ||
            normalizedId.endsWith("/src/domain/sovereign-ide-remote-desktop.ts")
          ) {
            return "omnia-sovereign-tools-domain";
          }
          if (normalizedId.includes("/src/domain/")) {
            return "omnia-domain";
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // Vitest owns application suites in these roots. Pinned source snapshots
    // elsewhere may have test-like names but are reference data, not our tests.
    include: [
      "src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "tests/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    // Playwright visual contracts are browser-run suites and import
    // `@playwright/test`; keeping them out of Vitest prevents the two test
    // runners from registering the same suite in the wrong runtime.
    // Vendored upstream checkouts and generated build/evidence trees have
    // independent runners and dependencies; they are not Omnia test suites.
    exclude: [
      ...configDefaults.exclude,
      // Script/contract .mjs and .cjs suites use node:test and run with
      // `node --test`; collecting them here mixes two runner lifecycles.
      "scripts/**/*.{test,spec}.{mjs,cjs}",
      "tests/**/*.{test,spec}.{mjs,cjs}",
      "tests/visual/**",
      "research/**",
      "artifacts/**",
      ".cargo-target*/**",
    ],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
