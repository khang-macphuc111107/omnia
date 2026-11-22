#!/usr/bin/env node
/**
 * Zero-npm Node v28 CDP capture helper for public Gemini share links.
 *
 * Uses Network-Service `Fetch.enable` (`*batchexecute*`, Response stage) to
 * capture full `ujx1Bf` / `otAQ7b` WIZ payloads directly to an external output
 * file without `Runtime.evaluate` renderer heap OOM, refusing auth/CAPTCHA
 * gates cleanly and removing its temporary `--user-data-dir` in `finally`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_SHARE_HOSTS = new Set(['share.gemini.google', 'gemini.google.com']);
const SHARE_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;

export function classifyGateUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = (parsed.hostname || '').replace(/\.$/, '').toLowerCase();
  const pathname = (parsed.pathname || '/').toLowerCase();

  if (
    (host === 'google.com' || host.endsWith('.google.com')) &&
    (pathname === '/sorry' || pathname.startsWith('/sorry/') || host.startsWith('sorry.'))
  ) {
    return {
      reason: 'captcha_blocked',
      detail: 'Refused google.com/sorry CAPTCHA gate without bypassing anti-bot controls',
    };
  }

  if (
    host === 'accounts.google.com' ||
    (host === 'gemini.google.com' &&
      (pathname === '/app' ||
        pathname.startsWith('/app/') ||
        /^\/u\/\d+\/app(?:\/|$)/.test(pathname) ||
        pathname.startsWith('/signin')))
  ) {
    return {
      reason: 'auth_required',
      detail: 'Refused private authenticated Gemini/Google URL without bypassing auth',
    };
  }

  return null;
}

export function validateShareUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { valid: false, status: 'invalid', reason: 'empty_url', shareId: null, normalizedUrl: null, detail: 'URL cannot be empty' };
  }
  const trimmed = rawUrl.trim();
  if (/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(trimmed)) {
    return { valid: false, status: 'invalid', reason: 'unsafe_characters', shareId: null, normalizedUrl: null, detail: 'URL contains control characters' };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    return { valid: false, status: 'invalid', reason: 'malformed_url', shareId: null, normalizedUrl: null, detail: String(err) };
  }

  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') {
    return { valid: false, status: 'invalid', reason: 'unsupported_scheme', shareId: null, normalizedUrl: null, detail: `Unsupported scheme '${scheme}'` };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, status: 'blocked', reason: 'embedded_credentials', shareId: null, normalizedUrl: null, detail: 'Embedded credentials forbidden' };
  }

  const gate = classifyGateUrl(trimmed);
  if (gate) {
    return { valid: false, status: 'blocked', reason: gate.reason, shareId: null, normalizedUrl: null, detail: gate.detail };
  }
  if (scheme !== 'https') {
    return { valid: false, status: 'invalid', reason: 'insecure_scheme', shareId: null, normalizedUrl: null, detail: 'HTTPS is required' };
  }

  const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (!ALLOWED_SHARE_HOSTS.has(host)) {
    return { valid: false, status: 'invalid', reason: 'unsupported_host', shareId: null, normalizedUrl: null, detail: `Unsupported host '${host}'` };
  }

  const segs = parsed.pathname.split('/').filter(Boolean);
  let shareId = null;
  let canonicalPath = null;
  if (host === 'share.gemini.google' && segs.length === 1) {
    shareId = segs[0];
    canonicalPath = `/${shareId}`;
  } else if (host === 'gemini.google.com' && segs.length === 2 && segs[0] === 'share') {
    shareId = segs[1];
    canonicalPath = `/share/${shareId}`;
  }

  if (!shareId || !SHARE_ID_RE.test(shareId)) {
    return {
      valid: false,
      status: 'invalid',
      reason: 'invalid_share_id',
      shareId: null,
      normalizedUrl: null,
      detail: 'Expected https://share.gemini.google/<id> or https://gemini.google.com/share/<id>',
    };
  }

  parsed.pathname = canonicalPath;
  parsed.hash = '';
  return {
    valid: true,
    status: 'accepted',
    reason: 'ok',
    shareId,
    normalizedUrl: parsed.toString(),
    detail: 'Valid public Gemini share URL',
  };
}

export function findBrowserExecutable(explicitPath = '') {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.OMNIA_CDP_BROWSER) candidates.push(process.env.OMNIA_CDP_BROWSER);

  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || '';
    candidates.push(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    );
    if (localApp) {
      candidates.push(
        path.join(localApp, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function parseCliArgs(argv) {
  const opts = {
    url: '',
    out: '',
    browser: '',
    timeoutMs: 45000,
    settleMs: 3000,
    allowInRepo: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url' && i + 1 < argv.length) {
      opts.url = argv[++i];
    } else if (arg === '--out' && i + 1 < argv.length) {
      opts.out = argv[++i];
    } else if (arg === '--browser' && i + 1 < argv.length) {
      opts.browser = argv[++i];
    } else if (arg === '--timeout-ms' && i + 1 < argv.length) {
      opts.timeoutMs = Math.max(2000, Number.parseInt(argv[++i], 10) || 45000);
    } else if (arg === '--settle-ms' && i + 1 < argv.length) {
      opts.settleMs = Math.max(500, Number.parseInt(argv[++i], 10) || 3000);
    } else if (arg === '--allow-in-repo') {
      opts.allowInRepo = true;
    }
  }
  return opts;
}

function getRepoRoot() {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(selfDir, '..', '..');
}

function isInsideDir(targetPath, parentDir) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveDefaultOutPath(shareId) {
  const externalRoot = 'D:\\OmniaData';
  if (process.platform === 'win32' && fs.existsSync(externalRoot)) {
    return path.join(externalRoot, 'exports', 'gemini-share', `${shareId}_raw.txt`);
  }
  return path.join(os.tmpdir(), 'omnia-gemini-share', `${shareId}_raw.txt`);
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate loopback port')));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitForCdpTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  while (Date.now() < deadline) {
    try {
      const res = await globalThis.fetch(listUrl);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Browser still starting up.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for CDP endpoint on 127.0.0.1:${port}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new globalThis.WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out connecting CDP WebSocket'));
      }, timeoutMs);

      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error: ${ev.message || 'unknown'}`));
      });
      this.ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            entry.reject(new Error(`CDP ${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
          } else {
            entry.resolve(msg.result || {});
          }
        } else if (msg.method) {
          const handlers = this.listeners.get(msg.method) || [];
          for (const h of handlers) {
            Promise.resolve(h(msg.params || {})).catch(() => {});
          }
        }
      });
      this.ws.addEventListener('close', () => {
        for (const [, entry] of this.pending) {
          entry.reject(new Error('CDP WebSocket closed'));
        }
        this.pending.clear();
      });
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      if (this.ws.readyState === globalThis.WebSocket.OPEN || this.ws.readyState === globalThis.WebSocket.CONNECTING) {
        this.ws.close();
      }
    } catch {
      // Ignore close failures during teardown.
    }
  }
}

async function removeDirWithRetries(dirPath) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
}

export async function captureShareViaCdp(options) {
  const urlCheck = validateShareUrl(options.url);
  if (!urlCheck.valid) {
    return {
      ok: false,
      reason: urlCheck.reason,
      detail: urlCheck.detail,
      exitCode: urlCheck.status === 'blocked' ? 2 : 1,
    };
  }

  const outPath = path.resolve(options.out || resolveDefaultOutPath(urlCheck.shareId));
  const repoRoot = getRepoRoot();
  if (!options.allowInRepo && isInsideDir(outPath, repoRoot)) {
    return {
      ok: false,
      reason: 'in_repo_output_forbidden',
      detail: `Refusing to write capture inside repository (${outPath}) unless --allow-in-repo is explicitly set`,
      exitCode: 1,
    };
  }

  const browserPath = findBrowserExecutable(options.browser);
  if (!browserPath) {
    return {
      ok: false,
      reason: 'browser_not_found',
      detail: 'No Edge/Chrome executable found; pass --browser or set OMNIA_CDP_BROWSER',
      exitCode: 1,
    };
  }

  const port = await allocateLoopbackPort();
  const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-gemini-cdp-'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const outStream = fs.createWriteStream(outPath, { flags: 'w', encoding: 'utf8' });

  let child = null;
  let cdp = null;
  let capturedChunks = 0;
  let capturedBytes = 0;
  let gateAbort = null;
  let lastCaptureAt = 0;

  try {
    const args = [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${tempUserDataDir}`,
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      'about:blank',
    ];

    child = spawn(browserPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    const wsUrl = await waitForCdpTarget(port, Math.min(options.timeoutMs, 20000));
    cdp = new CdpClient(wsUrl);
    await cdp.connect(10000);

    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    // Use Network-Service Fetch interception so huge batchexecute bodies stream directly
    // from the browser network stack without touching renderer JS heap via Runtime.evaluate.
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*batchexecute*', requestStage: 'Response' }],
    });

    cdp.on('Page.frameNavigated', (params) => {
      const frame = params.frame || {};
      if (!frame.parentId && frame.url && frame.url !== 'about:blank') {
        const gate = classifyGateUrl(frame.url);
        if (gate) gateAbort = gate;
      }
    });

    cdp.on('Network.responseReceived', (params) => {
      const resp = params.response || {};
      if (resp.url) {
        const gate = classifyGateUrl(resp.url);
        if (gate) gateAbort = gate;
      }
      if (params.type === 'Document' && (resp.status === 429 || resp.status === 401 || resp.status === 403)) {
        gateAbort = {
          reason: resp.status === 429 ? 'captcha_blocked' : 'auth_required',
          detail: `Document navigation received HTTP ${resp.status}`,
        };
      }
    });

    const inflightFetches = new Set();
    cdp.on('Fetch.requestPaused', (params) => {
      const requestId = params.requestId;
      const task = (async () => {
        try {
          const status = params.responseStatusCode || 200;
          const reqUrl = (params.request && params.request.url) || '';
          const gate = classifyGateUrl(reqUrl);
          if (gate) {
            gateAbort = gate;
          } else if (status === 429) {
            gateAbort = { reason: 'captcha_blocked', detail: 'batchexecute returned HTTP 429' };
          } else if (status === 401 || status === 403) {
            gateAbort = { reason: 'auth_required', detail: `batchexecute returned HTTP ${status}` };
          } else if (status >= 200 && status < 300) {
            const bodyRes = await cdp.send('Fetch.getResponseBody', { requestId });
            const rawChunk = bodyRes.base64Encoded
              ? Buffer.from(bodyRes.body || '', 'base64').toString('utf8')
              : String(bodyRes.body || '');
            const normalizedChunk = rawChunk.replace(/\r\n/g, '\n');
            if (normalizedChunk.includes('ujx1Bf') || normalizedChunk.includes('otAQ7b')) {
              const suffix = normalizedChunk.endsWith('\n') ? '' : '\n';
              outStream.write(normalizedChunk + suffix);
              capturedChunks += 1;
              capturedBytes += Buffer.byteLength(normalizedChunk, 'utf8');
              lastCaptureAt = Date.now();
            }
          }
        } catch {
          // Avoid stalling network response on body read errors.
        } finally {
          try {
            await cdp.send('Fetch.continueResponse', { requestId });
          } catch {
            // Ignore if request was already canceled during teardown.
          }
        }
      })();
      inflightFetches.add(task);
      task.finally(() => inflightFetches.delete(task));
    });

    await cdp.send('Page.navigate', { url: urlCheck.normalizedUrl });

    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      if (gateAbort) break;
      if (capturedChunks > 0 && inflightFetches.size === 0 && Date.now() - lastCaptureAt >= options.settleMs) {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (inflightFetches.size > 0) {
      await Promise.allSettled([...inflightFetches]);
    }

    if (gateAbort) {
      return {
        ok: false,
        reason: gateAbort.reason,
        detail: gateAbort.detail,
        outPath,
        exitCode: 2,
      };
    }

    if (capturedChunks === 0) {
      return {
        ok: false,
        reason: 'no_batchexecute_captured',
        detail: 'No ujx1Bf/otAQ7b batchexecute payloads observed before timeout',
        outPath,
        exitCode: 1,
      };
    }

    return {
      ok: true,
      reason: 'ok',
      shareId: urlCheck.shareId,
      sourceUrl: urlCheck.normalizedUrl,
      outPath,
      capturedChunks,
      capturedBytes,
      exitCode: 0,
    };
  } finally {
    await new Promise((resolve) => outStream.end(resolve));
    if (cdp) {
      try {
        await Promise.race([
          cdp.send('Browser.close'),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      } catch {
        // Ignore browser close timeout.
      }
      cdp.close();
    }
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore kill error.
      }
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore.
          }
          resolve();
        }, 1200);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    await removeDirWithRetries(tempUserDataDir);
  }
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const result = await captureShareViaCdp(opts);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.exitCode ?? (result.ok ? 0 : 1);
}

const isEntrypoint = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((err) => {
    process.stdout.write(
      `${JSON.stringify({ ok: false, reason: 'unexpected_error', detail: String(err) })}\n`,
    );
    process.exitCode = 1;
  });
}
