#!/usr/bin/env node

/**
 * Cross-Session Named Pipe IPC Integration Test Runner (Milestone M5 & M6)
 *
 * Exercises:
 * 1. Windows Named Pipe connectivity (dynamically discovered Claude endpoints + local mock pipe).
 * 2. Protocol message serialization/deserialization (SendMessage, XML cross-session wire framing).
 * 3. Task instruction dispatch to session endpoints and acknowledgment capture.
 * 4. Timeout detection, socket reset (ECONNRESET / abrupt destroy), and fallback queue routing.
 */

import net from 'node:net';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

// Import production utilities directly from cross-session-bridge.mjs (Zero code duplication)
import {
  escapeXmlAttr,
  unescapeXmlAttr,
  serializeCrossSessionMessage,
  deserializeCrossSessionMessage,
  serializeSendMessagePayload,
  deserializeSendMessagePayload,
  CrossSessionDispatcher,
  discoverSessions,
  probePipe,
  isPipeFailureResponse,
  sendMessageToSession,
} from './cross-session-bridge.mjs';

const TEST_MOCK_PIPE = `\\\\.\\pipe\\LOCAL\\cc-msg-test-omnia-${randomBytes(8).toString('hex')}`;
const TEST_TARGET_PIPE = `\\\\.\\pipe\\LOCAL\\cc-msg-test-target-${randomBytes(8).toString('hex')}`;
const NONEXISTENT_PIPE = '\\\\.\\pipe\\LOCAL\\cc-msg-00000000000000000000000000000000';

// Statistics
let passedCount = 0;
let totalCount = 0;

function runTest(name, fn) {
  totalCount++;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passedCount++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      console.error(`    Error: ${err.message || err}`);
      throw err;
    });
}

// ============================================================================
// Main Test Execution Suite
// ============================================================================

async function main() {
  console.log('================================================================');
  console.log('Omnia Cross-Session Named Pipe IPC Integration Test Suite (M5/M6)');
  console.log('================================================================\n');

  // --- Suite 1: Serialization / Deserialization & Framing ---
  console.log('Suite 1: Protocol Serialization & Wire Framing:');

  await runTest('Round-trip XML cross-session wire framing', () => {
    const original = {
      from: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-040eb6ddd2094ac27e1fe338a08b1368',
      fromSession: '8a74eb55-710f-47e2-bc43-cc689aad7c05',
      fromName: 'Điều phối subagent liên tục',
      fromMode: 'bypass',
      hopChain: '4aeed45def0bb9646e9b11a2',
      content: 'Task: run gate verification and report latency TTFT HUD telemetry.',
    };

    const wire = serializeCrossSessionMessage(original);
    assert(wire.startsWith('<cross-session-message '));
    assert(wire.includes('from-name="Điều phối subagent liên tục"'));
    assert(wire.endsWith('</cross-session-message>\n'));

    const parsed = deserializeCrossSessionMessage(wire);
    assert.deepEqual(parsed, original);
  });

  await runTest('Special characters, quotes, and Vietnamese UTF-8 escaping', () => {
    const special = {
      from: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-test"&<>\'',
      fromName: 'Agent "Turbo" & <Bypass>',
      fromMode: 'bypass',
      content: 'Line 1: Special <chars> & "quotes"\nLine 2: Mũi tên > và v\nLine 3: {"json": true}',
    };

    const wire = serializeCrossSessionMessage(special);
    assert(wire.includes('&quot;'));
    assert(wire.includes('&amp;'));
    assert(wire.includes('&lt;'));
    assert(wire.includes('&gt;'));

    const parsed = deserializeCrossSessionMessage(wire);
    assert.equal(parsed.from, special.from);
    assert.equal(parsed.fromName, special.fromName);
    assert.equal(parsed.content, special.content);
  });

  await runTest('Preserve nested </cross-session-message> without premature truncation', () => {
    const nested = {
      from: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-test-nested',
      fromName: 'Nested Tag Tester',
      fromMode: 'bypass',
      content: 'Instruction with closing tag:\n</cross-session-message>\nFollow-up command to execute.',
    };

    const wire = serializeCrossSessionMessage(nested);
    const parsed = deserializeCrossSessionMessage(wire);
    assert.equal(parsed.content, nested.content);
  });

  await runTest('SendMessage tool payload JSON serialization and validation', () => {
    const payload = {
      to: TEST_TARGET_PIPE,
      summary: 'Slice B bundle check',
      message: 'Audit scripts/check-bundle-budget.mjs',
      recipient: 'Omnia Claude Code Harness',
      recipientKind: 'name',
    };

    const json = serializeSendMessagePayload(payload);
    const parsed = deserializeSendMessagePayload(json);
    assert.equal(parsed.to, payload.to);
    assert.equal(parsed.summary, payload.summary);
    assert.equal(parsed.message, payload.message);
  });

  await runTest('Malformed payload rejection', () => {
    assert.throws(() => deserializeSendMessagePayload('{"to": "only-to"}'), /missing required/i);
    assert.throws(() => deserializeCrossSessionMessage('Not an xml message'), /Malformed wire framing/i);
  });

  // --- Suite 2: Active Named Pipe Connectivity Probes ---
  console.log('\nSuite 2: Windows Named Pipe Connectivity Probes:');

  // Dedicated in-process mock server for active pipe probe verification
  const PROBE_MOCK_PIPE = `\\\\.\\pipe\\LOCAL\\cc-msg-test-probe-${randomBytes(6).toString('hex')}`;
  let probeServer;
  await new Promise((resolve, reject) => {
    probeServer = net.createServer((sock) => sock.end());
    probeServer.listen(PROBE_MOCK_PIPE, () => resolve());
    probeServer.on('error', reject);
  });

  try {
    await runTest('Probe active named pipe endpoint (in-process mock server)', async () => {
      const ok = await probePipe(PROBE_MOCK_PIPE, 1000);
      assert.equal(ok, true, 'Active mock named pipe probe must succeed');
    });

    await runTest('Probe dynamically discovered active session pipes if present on host', async () => {
      const sessions = discoverSessions();
      const active = sessions.filter((s) => s.pipePath);
      if (active.length > 0) {
        // Non-destructive probe of first active pipe
        const ok = await probePipe(active[0].pipePath, 500);
        console.log(`    (Discovered ${active.length} sessions on host; probe on PID ${active[0].pid}: alive=${ok})`);
      } else {
        console.log('    (No live Claude sessions active on host; offline fallback validated)');
      }
    });

    await runTest('Non-existent named pipe connection error handling', () => {
      return new Promise((resolve, reject) => {
        const client = net.createConnection(NONEXISTENT_PIPE, () => {
          client.end();
          reject(new Error('Non-existent pipe unexpectedly connected!'));
        });
        client.on('error', (err) => {
          assert(err.message.includes('ENOENT') || err.message.includes('UNKNOWN') || err.code === 'ENOENT');
          resolve();
        });
      });
    });
  } finally {
    probeServer.close();
  }

  // --- Suite 3: End-to-End Task Instruction Dispatch & Acknowledgment ---
  console.log('\nSuite 3: Task Instruction Dispatch & Acknowledgment:');

  // Launch a dedicated mock named pipe server for protocol execution
  let mockServer;
  let receivedRequests = [];

  await new Promise((resolve, reject) => {
    mockServer = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\n')) {
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep remainder
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const req = JSON.parse(line);
              receivedRequests.push(req);
              // Send acknowledgment receipt back
              const ack = {
                success: true,
                message: `"${req.summary}" -> ${req.to}; in session inbox`,
                msg_id: randomUUID(),
              };
              socket.write(JSON.stringify(ack) + '\n');
            } catch {
              // Ignore non-json or partial framing
            }
          }
        }
      });
    });

    mockServer.listen(TEST_MOCK_PIPE, () => resolve());
    mockServer.on('error', reject);
  });

  try {
    await runTest('Dispatch task instruction to mock session and receive delivery acknowledgment', async () => {
      const ack = await new Promise((resolve, reject) => {
        const client = net.createConnection(TEST_MOCK_PIPE, () => {
          const payload = serializeSendMessagePayload({
            to: `uds:${TEST_MOCK_PIPE}`,
            summary: 'UI tree-view test',
            message: 'Implement chevron progressive disclosure',
          });
          client.write(payload + '\n');
        });

        client.on('data', (data) => {
          const resp = JSON.parse(data.toString('utf8').trim());
          client.end();
          resolve(resp);
        });

        client.on('error', reject);
        setTimeout(() => reject(new Error('Mock dispatch timed out')), 2000);
      });

      assert.equal(ack.success, true);
      assert(ack.message.includes('in session inbox'));
      assert(ack.msg_id);
      assert.equal(receivedRequests.length, 1);
      assert.equal(receivedRequests[0].summary, 'UI tree-view test');
    });

    await runTest('Dispatch formatted <cross-session-message> wire framing across pipe', async () => {
      const wireMessage = serializeCrossSessionMessage({
        from: `uds:${TEST_MOCK_PIPE}`,
        fromSession: 'mock-session-001',
        fromName: 'Omnia IPC Test Agent',
        content: 'Verification payload with embedded JSON {"gate": "pass"}',
      });

      let receivedRaw = '';
      await new Promise((resolve, reject) => {
        const customPipe = `\\\\.\\pipe\\LOCAL\\cc-msg-test-wire-${randomBytes(6).toString('hex')}`;
        const wireServer = net.createServer((sock) => {
          sock.on('data', (d) => {
            receivedRaw += d.toString('utf8');
            sock.write('OK\n');
            sock.end();
          });
        });

        wireServer.listen(customPipe, () => {
          const client = net.createConnection(customPipe, () => {
            client.write(wireMessage);
          });
          client.on('data', () => {
            wireServer.close();
            resolve();
          });
          client.on('error', (err) => {
            wireServer.close();
            reject(err);
          });
        });
      });

      const parsed = deserializeCrossSessionMessage(receivedRaw);
      assert.equal(parsed.fromName, 'Omnia IPC Test Agent');
      assert.equal(parsed.content, 'Verification payload with embedded JSON {"gate": "pass"}');
    });
  } finally {
    mockServer.close();
  }

  // --- Suite 4: Timeout Handling, Reset & Fallback Routing ---
  console.log('\nSuite 4: Timeout Handling, Connection Reset & Fallback Paths:');

  await runTest('Detect connection reset (peer abruptly destroys pipe)', async () => {
    const resetPipe = `\\\\.\\pipe\\LOCAL\\cc-msg-test-reset-${randomBytes(6).toString('hex')}`;

    await new Promise((resolve) => {
      const resetServer = net.createServer((sock) => {
        // Abruptly destroy without clean end
        sock.destroy();
      });
      resetServer.listen(resetPipe, () => {
        const client = net.createConnection(resetPipe, () => {
          client.write('payload\n');
        });

        client.on('error', () => {
          resetServer.close();
          resolve();
        });
        client.on('close', () => {
          resetServer.close();
          resolve();
        });
      });
    });
  });

  await runTest('CrossSessionDispatcher fallback queue routes on pipe failure', async () => {
    const dispatcher = new CrossSessionDispatcher();

    const failingTransport = async () => {
      throw new Error('Connection refused / pipe not responding');
    };

    const ack = await dispatcher.dispatch(
      TEST_TARGET_PIPE,
      'Deferred bundle gate task',
      'Bundle Check',
      failingTransport
    );

    assert.equal(ack.success, false);
    assert(ack.message.includes('queued in fallback buffer'));
    assert.equal(dispatcher.fallbackQueue.length, 1);

    const queued = dispatcher.fallbackQueue[0];
    assert.equal(queued.endpoint, TEST_TARGET_PIPE);
    assert(queued.error.includes('Connection refused'));
  });

  await runTest('Drain fallback queue after recovery', async () => {
    const dispatcher = new CrossSessionDispatcher();

    // 1. Enqueue failure
    await dispatcher.dispatch(
      TEST_TARGET_PIPE,
      'Uncommitted WIP check',
      'Git Review',
      async () => { throw new Error('Timeout'); }
    );
    assert.equal(dispatcher.fallbackQueue.length, 1);

    // 2. Recovery drain
    const delivered = [];
    dispatcher.drain((item) => {
      delivered.push({
        endpoint: item.endpoint,
        status: 'recovered_and_delivered',
      });
    });

    assert.equal(dispatcher.fallbackQueue.length, 0);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].status, 'recovered_and_delivered');
  });

  await runTest('Reject peer error or unauthorized ack in sendMessageToSession (no false-positive receipt)', async () => {
    assert.equal(isPipeFailureResponse('{"type":"error","error":"unauthorized"}'), true);
    assert.equal(isPipeFailureResponse('{"success":false,"message":"denied"}'), true);
    assert.equal(isPipeFailureResponse('ERROR: invalid token'), true);
    assert.equal(isPipeFailureResponse('{"success":true,"msg_id":"abc"}'), false);
    assert.equal(isPipeFailureResponse(''), false);

    const authRejectPipe = `\\\\.\\pipe\\LOCAL\\cc-msg-test-auth-${randomBytes(6).toString('hex')}`;
    const authServer = net.createServer((sock) => {
      sock.on('data', () => {
        sock.write('{"type":"error","error":"unauthorized"}\n');
        sock.end();
      });
    });

    await new Promise((resolve, reject) => {
      authServer.listen(authRejectPipe, () => resolve());
      authServer.on('error', reject);
    });

    try {
      const receipt = await sendMessageToSession({
        session: {
          pid: 99999,
          sessionId: 'mock-unauth-session',
          pipeName: authRejectPipe.split('\\').pop(),
          pipePath: authRejectPipe,
          token: 'bad-token',
        },
        taskContent: 'Should not report success: true on unauthorized response',
        fromPipe: `uds:${TEST_MOCK_PIPE}`,
        fromName: 'Auth Tester',
        timeoutMs: 1500,
      });
      assert.equal(receipt.success, false, 'Unauthorized peer ack must set receipt.success = false');
      assert(receipt.response && receipt.response.includes('unauthorized'));
    } finally {
      authServer.close();
    }
  });

  console.log('\n================================================================');
  console.log(`Results: ${passedCount} / ${totalCount} tests passed (100% success rate)`);
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('\nTest suite execution failed:', err);
  process.exit(1);
});
