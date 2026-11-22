import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER_SCRIPT = path.resolve(__dirname, '..', 'py_worker', 'transform.py');

export class WorkerClient {
  constructor(options = {}) {
    this.pythonBin = options.pythonBin || process.env.PYTHON_BIN || process.env.PYTHON || 'python';
    this.workerScript = options.workerScript || DEFAULT_WORKER_SCRIPT;
    this.proc = null;
    this.pendingQueue = [];
    this.stderrChunks = [];
  }

  async start() {
    if (this.proc) return;
    this.proc = spawn(this.pythonBin, [this.workerScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.proc.stderr.on('data', (chunk) => {
      this.stderrChunks.push(chunk.toString('utf8'));
    });

    this.proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString('utf8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        const pending = this.pendingQueue.shift();
        if (!pending) continue;
        if (!line.endsWith('}')) {
          pending.reject(new Error(`Malformed NDJSON response line from worker: ${JSON.stringify(line)}`));
          continue;
        }
        try {
          pending.resolve(JSON.parse(line));
        } catch (err) {
          pending.reject(new Error(`Failed to parse worker JSON: ${err.message}; raw=${JSON.stringify(line)}`));
        }
      }
    });

    this.proc.on('error', (err) => {
      this._rejectAll(new Error(`Python worker spawn error: ${err.message}`));
    });

    this.proc.on('close', (code) => {
      const stderrText = this.stderrChunks.join('').trim();
      if (this.pendingQueue.length > 0) {
        this._rejectAll(
          new Error(`Python worker exited unexpectedly (code=${code})${stderrText ? ': ' + stderrText : ''}`)
        );
      }
      this.proc = null;
    });
  }

  transform(payload) {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error('Python worker is not running'));
    }
    return new Promise((resolve, reject) => {
      this.pendingQueue.push({ resolve, reject });
      const encoded = JSON.stringify(payload) + '\r\n';
      this.proc.stdin.write(encoded, 'latin1');
    });
  }

  async close() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve();
      }, 3000);
      proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.stdin.end();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  _rejectAll(err) {
    while (this.pendingQueue.length > 0) {
      const pending = this.pendingQueue.shift();
      pending.reject(err);
    }
  }
}
