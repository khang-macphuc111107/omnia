import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import RouteEngine from './router';
import { BridgeLockError, LockManager } from './lock.mjs';
import { WorkerClient } from './worker_client.mjs';
import { BatchWriter } from './writer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export class EventBridge {
  constructor(options = {}) {
    this.configPath = options.configPath || path.join(PROJECT_ROOT, 'config', 'routes.json');
    this.lockPath = options.lockPath || path.join(PROJECT_ROOT, '.bridge.lock');
    this.outputPath = options.outputPath ?? null;
    this.batchSize = options.batchSize ?? 10;
    this.pythonBin = options.pythonBin;

    this.config = null;
    this.router = null;
    this.lockManager = new LockManager(this.lockPath);
    this.worker = new WorkerClient({ pythonBin: this.pythonBin });
    this.writer = this.outputPath ? new BatchWriter(this.outputPath, this.batchSize) : null;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.config = loadConfig(this.configPath);
    this.router = new RouteEngine(this.config);
    this.lockManager.acquire();
    try {
      await this.worker.start();
      if (this.writer) {
        await this.writer.init();
      }
      this.started = true;
    } catch (err) {
      await this.worker.close().catch(() => {});
      this.lockManager.release();
      throw err;
    }
  }

  async transformEvent(event) {
    if (!this.started) {
      throw new Error('EventBridge has not been started');
    }
    const route = this.router.resolve(event);
    const payload = {
      id: String(event.id),
      type: String(event.type),
      message: event.message ?? '',
      source_path: event.source_path ?? '',
      amount: event.amount ?? null,
      route,
    };
    return this.worker.transform(payload);
  }

  async enqueue(event) {
    const transformed = await this.transformEvent(event);
    if (this.writer) {
      await this.writer.enqueue(transformed);
    }
    return transformed;
  }

  async flush() {
    if (this.writer) {
      await this.writer.flush();
    }
  }

  async processFile(inputPath) {
    const content = await fs.promises.readFile(path.resolve(inputPath), 'utf8');
    const lines = content
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const events = lines.map((line) => JSON.parse(line));
    await Promise.all(events.map((evt) => this.enqueue(evt)));
    await this.flush();
    return events.length;
  }

  async stop() {
    let firstError = null;
    try {
      if (this.writer && this.started) {
        await this.writer.close();
      }
    } catch (err) {
      firstError = firstError || err;
    }
    try {
      await this.worker.close();
    } catch (err) {
      firstError = firstError || err;
    }
    try {
      this.lockManager.release();
    } catch (err) {
      firstError = firstError || err;
    }
    this.started = false;
    if (firstError) {
      throw firstError;
    }
  }
}

export { BridgeLockError, RouteEngine, BatchWriter, loadConfig };
