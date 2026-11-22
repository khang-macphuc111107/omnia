import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventBridge, BridgeLockError, loadConfig } from '../src/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function runTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'event-bridge-test-'));
  try {
    // Test 1: Config loading
    const cfg = loadConfig(path.join(ROOT, 'config', 'routes.json'));
    assert.equal(cfg.default_channel, 'general');
    assert.equal(cfg.routes['order.created'].channel, 'orders');
    assert.equal(cfg.routes['file.indexed'].tag, 'FS');
    console.log('PASS: test_config_loading');

    // Test 2: Stale lock reclamation and clean release
    const staleLock = path.join(tmpRoot, 'stale.lock');
    fs.writeFileSync(staleLock, JSON.stringify({ pid: 9999999, created_at: '2026-01-01T00:00:00Z' }), 'utf8');
    const out1 = path.join(tmpRoot, 'out1.jsonl');
    const bridge1 = new EventBridge({ lockPath: staleLock, outputPath: out1, batchSize: 2 });
    await bridge1.start();
    assert.equal(fs.existsSync(staleLock), true);
    const lockInfo = JSON.parse(fs.readFileSync(staleLock, 'utf8'));
    assert.equal(lockInfo.pid, process.pid);

    // Live lock must reject a second concurrent bridge instance
    const bridgeDup = new EventBridge({ lockPath: staleLock, outputPath: path.join(tmpRoot, 'dup.jsonl') });
    await assert.rejects(() => bridgeDup.start(), BridgeLockError);

    // Test 3: Unicode + Windows backslash path round-trip via Python worker
    const transformed = await bridge1.enqueue({
      id: 'u-1',
      type: 'order.created',
      message: 'Order café 東京 🚀 résumé',
      source_path: 'C:\\Users\\dev\\docs\\new\\test_file.txt',
      amount: 12.5,
    });
    assert.equal(transformed.channel, 'orders');
    assert.equal(transformed.tag, 'SALES');
    assert.equal(transformed.message, 'Order café 東京 🚀 résumé');
    assert.equal(transformed.message_length, 22);
    assert.equal(transformed.source_path, 'C:\\Users\\dev\\docs\\new\\test_file.txt');
    assert.deepEqual(transformed.path_segments, ['C:', 'Users', 'dev', 'docs', 'new', 'test_file.txt']);
    assert.equal(transformed.formatted_label, '[SALES] u-1: Order café 東京 🚀 résumé');
    assert.equal(transformed.processed, true);

    await bridge1.stop();
    assert.equal(fs.existsSync(staleLock), false, 'Lock file should be removed cleanly on stop()');
    console.log('PASS: test_lock_and_unicode_paths');

    // Test 4: Concurrent batch flush integrity (no dropped, duplicated, or corrupt lines)
    const stressLock = path.join(tmpRoot, 'stress.lock');
    const stressOut = path.join(tmpRoot, 'stress.jsonl');
    const bridge2 = new EventBridge({ lockPath: stressLock, outputPath: stressOut, batchSize: 5 });
    await bridge2.start();
    const total = 60;
    const tasks = [];
    for (let i = 0; i < total; i += 1) {
      tasks.push(
        bridge2.enqueue({
          id: `batch-${String(i).padStart(3, '0')}`,
          type: i % 2 === 0 ? 'order.created' : 'file.indexed',
          message: `Event #${i} café 🚀`,
          source_path: `C:\\data\\new\\tab_${i}.log`,
          amount: i,
        })
      );
      if (i % 7 === 0) {
        tasks.push(bridge2.flush());
      }
    }
    await Promise.all(tasks);
    await bridge2.stop();

    const rawLines = fs
      .readFileSync(stressOut, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
    assert.equal(rawLines.length, total, `Expected ${total} NDJSON lines, got ${rawLines.length}`);
    const parsed = rawLines.map((line) => JSON.parse(line));
    const ids = new Set(parsed.map((item) => item.id));
    assert.equal(ids.size, total, `Expected ${total} unique IDs, got ${ids.size}`);
    console.log('PASS: test_concurrent_batch_flush');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exitCode = 1;
});
