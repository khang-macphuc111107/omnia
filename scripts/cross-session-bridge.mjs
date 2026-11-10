#!/usr/bin/env node
/**
 * Cross-Session Named Pipe IPC Bridge for Omnia (Node.js native implementation).
 *
 * Connects Omnia Desktop (Tauri/React) and Antigravity orchestrators with external
 * Claude Desktop and Claude CLI sessions running on the host via Windows Named Pipes.
 *
 * Capabilities:
 * 1. Dynamic session discovery: scans `~/.claude/sessions/*.json` and companion `*.key` files.
 * 2. Named Pipe connection: connects via native `node:net` to `\\.\pipe\LOCAL\cc-msg-*`.
 * 3. Protocol authentication handshake: sends `{"type":"auth","token":"<peerToken>"}\n`.
 * 4. Envelope serialization: formats `<cross-session-message>` XML inside JSON payloads.
 * 5. JSONL tailing: streams real-time responses from `~/.claude/projects/D--Omnia/<sessionId>.jsonl`.
 * 6. CLI interface: `--list`, `--target desktop|cli|<pid>`, `--message "..."`, `--stream`, `--probe`, `--drain-fallback`.
 * 7. In-memory fallback queuing: buffers unsent messages when pipe connection fails or resets.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ============================================================================
// Constants & Defaults
// ============================================================================

export const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects', 'D--Omnia');
export const CLAUDE_PROJECTS_BASE = path.join(os.homedir(), '.claude', 'projects');

export const DEFAULT_BRIDGE_PIPE = '\\\\.\\pipe\\LOCAL\\cc-msg-omnia-bridge';
export const DEFAULT_BRIDGE_UDS = 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-omnia-bridge';
export const DEFAULT_BRIDGE_NAME = 'Omnia Bridge';
export const DEFAULT_BRIDGE_MODE = 'bypass';

export const PIPE_NAME_PATTERN = /^(?:uds:)?\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$/i;

export const DEFAULT_KNOWN_ENDPOINTS = {
  desktop: {
    sessionId: 'e4bb6ce7-14e9-4e53-906a-5bc91984ca1e',
    pipe: '\\\\.\\pipe\\LOCAL\\cc-msg-6b30a19473ba23a166426cfe78b4198d',
    name: 'Omnia Claude Code Harness',
  },
  cli: {
    sessionId: '8a74eb55-710f-47e2-bc43-cc689aad7c05',
    pipe: '\\\\.\\pipe\\LOCAL\\cc-msg-040eb6ddd2094ac27e1fe338a08b1368',
    name: 'Điều phối subagent liên tục',
  },
};

// ============================================================================
// Protocol Serialization & Framing Helpers
// ============================================================================

export function escapeXmlAttr(val) {
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function unescapeXmlAttr(val) {
  return String(val)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function serializeCrossSessionMessage({
  from = DEFAULT_BRIDGE_UDS,
  fromSession,
  fromName = DEFAULT_BRIDGE_NAME,
  fromMode = DEFAULT_BRIDGE_MODE,
  hopChain,
  content,
}) {
  if (!from) throw new Error("Mandatory 'from' parameter required");
  const attrs = [`from="${escapeXmlAttr(from)}"`];
  if (fromSession) attrs.push(`from-session="${escapeXmlAttr(fromSession)}"`);
  if (fromName) attrs.push(`from-name="${escapeXmlAttr(fromName)}"`);
  if (fromMode) attrs.push(`from-mode="${escapeXmlAttr(fromMode)}"`);
  if (hopChain) attrs.push(`hop-chain="${escapeXmlAttr(hopChain)}"`);

  return `<cross-session-message ${attrs.join(' ')}>\n${content}\n</cross-session-message>\n`;
}

export function deserializeCrossSessionMessage(text) {
  // Greedy match ([\s\S]*) up to the final closing tag to prevent truncation when payload contains embedded closing tags
  const match = text.match(/<cross-session-message\b([^>]*)>(?:\r?\n)?([\s\S]*)(?:\r?\n)?<\/cross-session-message>/);
  if (!match) {
    throw new Error(`Malformed wire framing in cross-session message: ${text.slice(0, 100)}`);
  }
  const rawAttrs = match[1];
  let content = match[2];

  // Strip trailing newline delimiter before </cross-session-message>
  if (content.endsWith('\r\n')) {
    content = content.slice(0, -2);
  } else if (content.endsWith('\n')) {
    content = content.slice(0, -1);
  }

  const getAttr = (name) => {
    const m = rawAttrs.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? unescapeXmlAttr(m[1]) : undefined;
  };

  const from = getAttr('from');
  if (!from) throw new Error("Missing 'from' attribute in cross-session message");

  return {
    from,
    fromSession: getAttr('from-session'),
    fromName: getAttr('from-name'),
    fromMode: getAttr('from-mode') || 'bypass',
    hopChain: getAttr('hop-chain'),
    content,
  };
}

export function serializeEnvelope({
  taskContent,
  fromPipe = DEFAULT_BRIDGE_UDS,
  fromName = DEFAULT_BRIDGE_NAME,
  fromMode = DEFAULT_BRIDGE_MODE,
  msgId,
  priority = 'next',
}) {
  const id = msgId || crypto.randomUUID().replace(/-/g, '');
  const xmlContent = serializeCrossSessionMessage({
    from: fromPipe,
    fromName,
    fromMode,
    content: taskContent,
  }).trimEnd();

  return {
    msg_id: id,
    type: 'user',
    message: {
      role: 'user',
      content: xmlContent,
    },
    priority,
    from: fromPipe,
  };
}

export function serializeSendMessagePayload({ to, summary, message, recipient, recipientKind, content }) {
  if (!to || !summary || !message) {
    throw new Error('to, summary, and message are required');
  }
  return JSON.stringify({
    to,
    summary,
    message,
    type: 'message',
    ...(recipient ? { recipient } : {}),
    ...(recipientKind ? { recipient_kind: recipientKind } : {}),
    ...(content ? { content } : {}),
  });
}

export function deserializeSendMessagePayload(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed.to || !parsed.summary || !parsed.message) {
    throw new Error('Payload missing required SendMessage fields');
  }
  return parsed;
}

// ============================================================================
// Fallback Dispatcher & Queue
// ============================================================================

export class CrossSessionDispatcher {
  constructor(options = {}) {
    this.fallbackQueue = [];
    this.knownEndpoints = options.knownEndpoints || DEFAULT_KNOWN_ENDPOINTS;
  }

  resolveEndpoint(target) {
    if (!target) {
      throw new Error('Unresolvable endpoint: target is required');
    }

    const clean = String(target).replace(/^uds:/, '');
    if (PIPE_NAME_PATTERN.test(clean) || /^\\\\\.\\pipe\\LOCAL\\cc-msg-test-.+$/i.test(clean)) {
      return clean;
    }

    if (target === 'desktop' || target === this.knownEndpoints.desktop?.sessionId?.slice(0, 8)) {
      return this.knownEndpoints.desktop.pipe;
    }
    if (target === 'cli' || target === this.knownEndpoints.cli?.sessionId?.slice(0, 8)) {
      return this.knownEndpoints.cli.pipe;
    }

    // Dynamic session discovery
    const session = findSession(target);
    if (session && session.pipePath) {
      return session.pipePath;
    }

    throw new Error(`Unresolvable endpoint or invalid named pipe address: ${target}`);
  }

  async dispatch(target, instruction, summary, transport) {
    const endpoint = this.resolveEndpoint(target);
    const payload = {
      to: `uds:${endpoint}`,
      summary: summary || '',
      message: instruction || '',
      type: 'message',
      content: instruction || '',
    };

    try {
      return await transport(endpoint, payload);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.fallbackQueue.push({
        endpoint,
        payload,
        error: errorMessage,
        timestamp: Date.now(),
      });
      return {
        success: false,
        message: `Delivery failed (${errorMessage}); queued in fallback buffer (routed to fallback buffer)`,
        msg_id: `fallback-${Date.now()}`,
      };
    }
  }

  drain(handler) {
    const drained = [];
    while (this.fallbackQueue.length > 0) {
      const item = this.fallbackQueue.shift();
      if (handler) {
        handler(item);
      }
      drained.push(item);
    }
    return drained;
  }
}

export const defaultDispatcher = new CrossSessionDispatcher();

// ============================================================================
// Dynamic Session Discovery
// ============================================================================

export function discoverSessions(sessionsDir = DEFAULT_SESSIONS_DIR) {
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const files = fs.readdirSync(sessionsDir);
  const jsonFiles = files.filter((f) => f.endsWith('.json') && /^\d+\.json$/.test(f));
  const sessions = [];

  for (const jf of jsonFiles) {
    const fullPath = path.join(sessionsDir, jf);
    const pidStr = jf.replace('.json', '');
    const pid = parseInt(pidStr, 10);

    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const data = JSON.parse(raw);

      // Find companion .key file
      let token = null;
      const keyPrefix = `${pidStr}.`;
      const keyFile = files.find((f) => f.startsWith(keyPrefix) && f.endsWith('.key'));
      if (keyFile) {
        const keyPath = path.join(sessionsDir, keyFile);
        const keyRaw = fs.readFileSync(keyPath, 'utf8').trim();
        if (keyRaw.startsWith('{')) {
          try {
            const keyJson = JSON.parse(keyRaw);
            token = keyJson.peerToken || keyJson.token || keyRaw;
          } catch {
            token = keyRaw;
          }
        } else {
          token = keyRaw;
        }
      }

      sessions.push({
        pid,
        sessionId: data.sessionId || 'unknown',
        cwd: data.cwd || 'unknown',
        entrypoint: data.entrypoint || 'unknown',
        name: data.name || (data.entrypoint === 'claude-desktop' ? 'Claude Desktop' : 'Claude CLI'),
        pipePath: data.messagingSocketPath || '',
        token,
        raw: data,
      });
    } catch {
      // Ignore unparseable session files
    }
  }

  return sessions;
}

export function findSession(target, sessionsDir = DEFAULT_SESSIONS_DIR) {
  const sessionList = discoverSessions(sessionsDir);
  if (!target) {
    // Default: prioritize claude-desktop, fallback to cli
    return (
      sessionList.find((s) => s.entrypoint === 'claude-desktop') ||
      sessionList.find((s) => s.entrypoint === 'cli') ||
      sessionList[0] ||
      null
    );
  }

  const targetLower = target.toLowerCase();
  const targetClean = target.replace(/^uds:/i, '');

  // 1. Alias: desktop
  if (['desktop', 'claude-desktop', 'claude_desktop'].includes(targetLower)) {
    const epMatch = sessionList.find((s) => s.entrypoint === 'claude-desktop');
    if (epMatch) return epMatch;
    const nameMatch = sessionList.find(
      (s) => s.name.toLowerCase().includes('desktop') || s.name.toLowerCase().includes('harness')
    );
    if (nameMatch) return nameMatch;
    const idMatch = sessionList.find((s) => s.sessionId.startsWith('e4bb6ce7'));
    if (idMatch) return idMatch;
  }

  // 2. Alias: cli
  if (['cli', 'claude-cli', 'claude_cli'].includes(targetLower)) {
    const omniaCli = sessionList.find(
      (s) => s.entrypoint === 'cli' && s.cwd.toLowerCase().includes('omnia')
    );
    if (omniaCli) return omniaCli;
    const coordCli = sessionList.find(
      (s) => s.entrypoint === 'cli' && s.name.toLowerCase().includes('điều phối')
    );
    if (coordCli) return coordCli;
    const anyCli = sessionList.find((s) => s.entrypoint === 'cli');
    if (anyCli) return anyCli;
  }

  // 3. Numeric PID match
  if (/^\d+$/.test(targetClean)) {
    const pidNum = parseInt(targetClean, 10);
    const pidMatch = sessionList.find((s) => s.pid === pidNum);
    if (pidMatch) return pidMatch;
  }

  // 4. Session ID match
  const idMatch = sessionList.find((s) => s.sessionId.toLowerCase().startsWith(targetLower));
  if (idMatch) return idMatch;

  // 5. Pipe match
  const pipeMatch = sessionList.find(
    (s) => s.pipePath.toLowerCase() === targetLower || s.pipePath.toLowerCase().endsWith(targetLower)
  );
  if (pipeMatch) return pipeMatch;

  // 6. Name substring match
  const nameMatch = sessionList.find((s) => s.name.toLowerCase().includes(targetLower));
  if (nameMatch) return nameMatch;

  return null;
}

// ============================================================================
// Windows Named Pipe Client
// ============================================================================

export function probePipe(pipePath, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        client.destroy();
        resolve(false);
      }
    }, timeoutMs);

    const client = net.createConnection(pipePath, () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        client.end();
        resolve(true);
      }
    });

    client.on('error', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
}

export function isPipeFailureResponse(ackText) {
  if (!ackText) return false;
  const trimmed = ackText.trim();
  if (!trimmed) return false;
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.type === 'error' ||
          parsed.status === 'error' ||
          'error' in parsed ||
          parsed.success === false ||
          parsed.ok === false)
      ) {
        return true;
      }
    } catch {
      const lower = line.trim().toLowerCase();
      if (lower.includes('unauthorized') || lower.includes('error') || lower.startsWith('err:') || lower.startsWith('err ')) {
        return true;
      }
    }
  }
  return false;
}

export function sendMessageToSession({
  session,
  taskContent,
  fromPipe = DEFAULT_BRIDGE_UDS,
  fromName = DEFAULT_BRIDGE_NAME,
  fromMode = DEFAULT_BRIDGE_MODE,
  timeoutMs = 5000,
}) {
  return new Promise((resolve, reject) => {
    if (!session || !session.pipePath) {
      return reject(new Error('Invalid session or missing messagingSocketPath'));
    }

    const envelope = serializeEnvelope({
      taskContent,
      fromPipe,
      fromName,
      fromMode,
    });

    let finished = false;
    let responseBuffer = '';

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        client.destroy();
        const ackText = responseBuffer.trim();
        resolve({
          success: !isPipeFailureResponse(ackText),
          msg_id: envelope.msg_id,
          target_pid: session.pid,
          target_session_id: session.sessionId,
          pipe: session.pipePath,
          response: ackText || 'dispatched (in session inbox)',
        });
      }
    }, timeoutMs);

    const client = net.createConnection(session.pipePath, () => {
      // 1. Auth handshake line if token exists
      if (session.token) {
        const authMsg = JSON.stringify({ type: 'auth', token: session.token }) + '\n';
        client.write(authMsg);
      }

      // 2. Message payload line
      const payloadMsg = JSON.stringify(envelope) + '\n';
      client.write(payloadMsg);

      // Short wait for any immediate response / acknowledgment
      setTimeout(() => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          client.end();
          const ackText = responseBuffer.trim();
          resolve({
            success: !isPipeFailureResponse(ackText),
            msg_id: envelope.msg_id,
            target_pid: session.pid,
            target_session_id: session.sessionId,
            pipe: session.pipePath,
            response: ackText || 'dispatched (in session inbox)',
          });
        }
      }, 500);
    });

    client.on('data', (chunk) => {
      responseBuffer += chunk.toString('utf8');
    });

    client.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(new Error(`Failed to send message over named pipe: ${err.message}`));
      }
    });
  });
}

// ============================================================================
// Transcript JSONL Tailing
// ============================================================================

export function findTranscriptPath(sessionId, projectsDir = DEFAULT_PROJECTS_DIR) {
  const direct = path.join(projectsDir, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;

  if (fs.existsSync(CLAUDE_PROJECTS_BASE)) {
    const subdirs = fs.readdirSync(CLAUDE_PROJECTS_BASE);
    for (const sub of subdirs) {
      const candidate = path.join(CLAUDE_PROJECTS_BASE, sub, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function tailTranscript(transcriptPath, options = {}) {
  const timeoutSec = options.timeout || 60;
  const pollInterval = options.pollInterval || 500;
  const onRecord = options.onRecord || defaultPrintRecord;

  let filePos = 0;
  if (fs.existsSync(transcriptPath)) {
    filePos = fs.statSync(transcriptPath).size;
  }

  const startTime = Date.now();
  console.log(`[*] Tailing transcript: ${transcriptPath} (timeout: ${timeoutSec}s)`);

  const timer = setInterval(() => {
    if (Date.now() - startTime > timeoutSec * 1000) {
      clearInterval(timer);
      console.log('[*] Tailing completed (timeout reached).');
      return;
    }

    if (!fs.existsSync(transcriptPath)) return;

    const currentSize = fs.statSync(transcriptPath).size;
    if (currentSize > filePos) {
      const fd = fs.openSync(transcriptPath, 'r');
      const buffer = Buffer.alloc(currentSize - filePos);
      fs.readSync(fd, buffer, 0, buffer.length, filePos);
      fs.closeSync(fd);
      filePos = currentSize;

      const lines = buffer.toString('utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          onRecord(record);
        } catch {
          // Partial line
        }
      }
    }
  }, pollInterval);

  return timer;
}

function defaultPrintRecord(record) {
  const type = record.type || 'unknown';
  if (type === 'assistant') {
    const content = record.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          console.log(`[Assistant] ${block.text}`);
        } else if (block.type === 'tool_use') {
          console.log(`[Tool Call] ${block.name}: ${JSON.stringify(block.input)}`);
        }
      }
    } else if (typeof content === 'string') {
      console.log(`[Assistant] ${content}`);
    }
  } else if (type === 'user') {
    console.log(`[User] ${record.message?.content?.slice(0, 100)}...`);
  }
}

// ============================================================================
// CLI Commands
// ============================================================================

export async function cmdList(jsonOutput = false) {
  const sessions = discoverSessions();

  if (jsonOutput) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  console.log('='.repeat(105));
  console.log('Omnia Cross-Session Bridge — Active Claude Sessions (Node.js)');
  console.log('='.repeat(105));
  console.log(
    'PID'.padEnd(8) +
      'Type'.padEnd(16) +
      'Status'.padEnd(9) +
      'Alive'.padEnd(8) +
      'Name'.padEnd(30) +
      'Messaging Pipe'
  );
  console.log('-'.repeat(105));

  for (const s of sessions) {
    const alive = s.pipePath ? await probePipe(s.pipePath, 500) : false;
    const aliveStr = alive ? 'YES' : 'NO';
    const typeStr = s.entrypoint === 'claude-desktop' ? 'desktop (app)' : 'cli';
    const nameStr = s.name.length > 28 ? s.name.slice(0, 25) + '...' : s.name;

    console.log(
      String(s.pid).padEnd(8) +
        typeStr.padEnd(16) +
        'active'.padEnd(9) +
        aliveStr.padEnd(8) +
        nameStr.padEnd(30) +
        s.pipePath
    );
  }

  console.log('-'.repeat(105));
  console.log(`Total sessions: ${sessions.length}\n`);
}

export async function cmdProbe(target) {
  const sessions = discoverSessions();
  const targets = target ? [findSession(target)].filter(Boolean) : sessions;

  if (targets.length === 0) {
    console.error(`[✗] No matching sessions to probe (target: '${target || 'all'}')`);
    process.exit(1);
  }

  console.log('[*] Probing Claude Named Pipe endpoints (Node.js)...');
  let allOk = true;

  for (const s of targets) {
    if (!s || !s.pipePath) continue;
    const alive = await probePipe(s.pipePath, 1000);
    const icon = alive ? '✓' : '✗';
    if (!alive) allOk = false;
    console.log(`  ${icon} PID ${s.pid} [${s.name}]: pipe=${s.pipePath} (alive=${alive})`);
  }

  if (!allOk) process.exit(1);
}

export async function runSelfTests() {
  console.log('='.repeat(70));
  console.log('Running Cross-Session Bridge Self-Tests (Node.js)');
  console.log('='.repeat(70));

  let passed = 0;
  let total = 0;

  async function check(name, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  }

  // 1. Serialization & escaping
  await check('serializeCrossSessionMessage and XML attribute escaping', () => {
    const wire = serializeCrossSessionMessage({
      from: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-test"&<>\'',
      fromName: 'Agent "Omnia" & <Special>',
      content: 'Line 1: Special <chars> & "quotes"\nLine 2: Mũi tên > và v',
    });
    if (!wire.includes('&quot;') || !wire.includes('&amp;') || !wire.includes('&lt;') || !wire.includes('&gt;')) {
      throw new Error('Missing XML escape entities');
    }
    if (!wire.includes('Mũi tên > và v')) {
      throw new Error('UTF-8 characters corrupted');
    }

    // Verify greedy round-trip with embedded closing tags
    const embedded = serializeCrossSessionMessage({
      from: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-test',
      content: 'Line 1\nExample: </cross-session-message>\nLine 2',
    });
    const parsed = deserializeCrossSessionMessage(embedded);
    if (parsed.content !== 'Line 1\nExample: </cross-session-message>\nLine 2') {
      throw new Error('Content truncated on embedded closing tag');
    }
  });

  // 2. Envelope formatting
  await check('serializeEnvelope adheres to wire protocol specification', () => {
    const env = serializeEnvelope({ taskContent: 'Execute gate verification' });
    if (env.type !== 'user' || env.priority !== 'next' || !env.from) {
      throw new Error('Invalid envelope structure');
    }
    if (!env.message?.content?.includes('<cross-session-message')) {
      throw new Error('Envelope missing cross-session-message XML tag');
    }
  });

  // 3. Dynamic discovery (Hermetic fixture test + host check)
  await check('discoverSessions finds active Claude sessions and key tokens', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-session-test-'));
    try {
      const mockJson = {
        pid: 99999,
        sessionId: 'mock-session-test-uuid',
        cwd: 'D:\\Omnia',
        entrypoint: 'cli',
        name: 'Mock Test Session',
        messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-test-mock-99999',
      };
      fs.writeFileSync(path.join(tmpDir, '99999.json'), JSON.stringify(mockJson));
      fs.writeFileSync(path.join(tmpDir, '99999.mockkey.key'), 'test-token-12345');

      const sessions = discoverSessions(tmpDir);
      if (sessions.length !== 1) throw new Error(`Expected 1 session, got ${sessions.length}`);
      if (sessions[0].pid !== 99999 || sessions[0].token !== 'test-token-12345') {
        throw new Error('Discovered session fields or token mismatch');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const hostSessions = discoverSessions();
    if (!Array.isArray(hostSessions)) throw new Error('Host discoverSessions did not return array');
  });

  // 4. Target resolution (Hermetic alias & PID matching)
  await check('findSession resolves aliases (desktop, cli, PID)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-session-alias-'));
    try {
      const mockDesktop = {
        pid: 88881,
        sessionId: 'desk-session-uuid',
        cwd: 'D:\\Omnia',
        entrypoint: 'claude-desktop',
        name: 'Claude Desktop Test',
        messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-test-mock-desk',
      };
      const mockCli = {
        pid: 88882,
        sessionId: 'cli-session-uuid',
        cwd: 'D:\\Omnia',
        entrypoint: 'cli',
        name: 'Claude CLI Test',
        messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-test-mock-cli',
      };
      fs.writeFileSync(path.join(tmpDir, '88881.json'), JSON.stringify(mockDesktop));
      fs.writeFileSync(path.join(tmpDir, '88882.json'), JSON.stringify(mockCli));

      const desk = findSession('desktop', tmpDir);
      if (!desk || desk.pid !== 88881) throw new Error('Failed to resolve desktop alias');
      const cli = findSession('cli', tmpDir);
      if (!cli || cli.pid !== 88882) throw new Error('Failed to resolve cli alias');
      const byPid = findSession('88881', tmpDir);
      if (!byPid || byPid.sessionId !== 'desk-session-uuid') throw new Error('Failed to resolve by PID');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 5. Named pipe probe (In-process mock named pipe)
  await check('probePipe tests active vs non-existent endpoints', async () => {
    const testPipe = `\\\\.\\pipe\\LOCAL\\cc-msg-test-probe-${crypto.randomBytes(4).toString('hex')}`;
    const server = net.createServer((c) => c.end());
    await new Promise((resolve) => server.listen(testPipe, resolve));
    try {
      const liveOk = await probePipe(testPipe, 1000);
      if (!liveOk) throw new Error('Active mock pipe probe failed');
    } finally {
      server.close();
    }
    const bogusOk = await probePipe('\\\\.\\pipe\\LOCAL\\cc-msg-00000000000000000000000000000000', 50);
    if (bogusOk) throw new Error('Bogus pipe unexpectedly succeeded');
  });

  console.log('='.repeat(70));
  console.log(`Self-Test Results: ${passed} / ${total} tests passed (${Math.round((passed / total) * 100)}%)`);
  console.log('='.repeat(70));

  if (passed !== total) process.exit(1);
}

// ============================================================================
// CLI Dispatch Entrypoint
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  let showList = false;
  let target = null;
  let message = null;
  let probe = false;
  let stream = false;
  let runTest = false;
  let jsonOutput = false;
  let drainFallback = false;
  let timeout = 10;
  let fromName = DEFAULT_BRIDGE_NAME;
  let fromPipe = DEFAULT_BRIDGE_UDS;
  let fromMode = DEFAULT_BRIDGE_MODE;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--list') showList = true;
    else if (arg === '--target' && i + 1 < args.length) target = args[++i];
    else if (arg === '--message' && i + 1 < args.length) message = args[++i];
    else if (arg === '--probe') probe = true;
    else if (arg === '--stream') stream = true;
    else if (arg === '--test') runTest = true;
    else if (arg === '--json') jsonOutput = true;
    else if (arg === '--drain-fallback') drainFallback = true;
    else if (arg === '--timeout' && i + 1 < args.length) timeout = parseFloat(args[++i]);
    else if (arg === '--from-name' && i + 1 < args.length) fromName = args[++i];
    else if (arg === '--from-pipe' && i + 1 < args.length) fromPipe = args[++i];
    else if (arg === '--from-mode' && i + 1 < args.length) fromMode = args[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node cross-session-bridge.mjs [options]');
      console.log('  --list                 List all active sessions');
      console.log('  --target <target>      Target: desktop, cli, PID, or session ID');
      console.log('  --message <text>       Task instruction to dispatch');
      console.log('  --probe                Probe named pipe connectivity');
      console.log('  --stream               Tail transcript JSONL file');
      console.log('  --test                 Run self-verification suite');
      console.log('  --drain-fallback       Drain and report queued fallback messages');
      console.log('  --json                 Output in JSON format');
      return;
    }
  }

  if (runTest) {
    await runSelfTests();
    return;
  }

  if (drainFallback) {
    const drained = defaultDispatcher.drain();
    console.log(`[*] Drained ${drained.length} fallback messages from queue.`);
    return;
  }

  if (showList || (!target && !message && !probe && !stream)) {
    await cmdList(jsonOutput);
    return;
  }

  if (probe && !message) {
    await cmdProbe(target);
    return;
  }

  if (message || stream || (probe && target)) {
    const session = findSession(target || 'desktop');
    if (!session) {
      console.error(`[✗] Target session '${target}' could not be resolved.`);
      process.exit(1);
    }

    if (probe) {
      await cmdProbe(target);
      return;
    }

    if (message) {
      console.log(`[*] Dispatching message to PID ${session.pid} (${session.name}) via ${session.pipePath}...`);
      try {
        const res = await sendMessageToSession({
          session,
          taskContent: message,
          fromPipe,
          fromName,
          fromMode,
          timeoutMs: timeout * 1000,
        });

        if (jsonOutput) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`[✓] Message delivered successfully! Message ID: ${res.msg_id}`);
          console.log(`    Target response: ${res.response}`);
        }
      } catch (err) {
        console.error(`[✗] Message dispatch failed: ${err.message}`);
        // Buffer into fallback queue
        defaultDispatcher.fallbackQueue.push({
          endpoint: session.pipePath,
          payload: { message },
          error: err.message,
          timestamp: Date.now(),
        });
        console.log(`    Buffered into fallback queue (length: ${defaultDispatcher.fallbackQueue.length})`);
        process.exit(1);
      }
    }

    if (stream) {
      const transcript = findTranscriptPath(session.sessionId);
      if (!transcript) {
        console.error(`[✗] Transcript JSONL not found for session ${session.sessionId}`);
        process.exit(1);
      }

      tailTranscript(transcript, { timeout });
      await new Promise((r) => setTimeout(r, timeout * 1000));
    }
  }
}

// Run if called directly
const isMainModule = Boolean(
  process.argv[1] &&
  (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` ||
   process.argv[1].replace(/\\/g, '/').endsWith('cross-session-bridge.mjs'))
);
if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
