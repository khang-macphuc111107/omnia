import fs from 'node:fs';
import path from 'node:path';

export class BridgeLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeLockError';
  }
}

export class LockManager {
  constructor(lockPath) {
    this.lockPath = path.resolve(lockPath);
    this.acquired = false;
  }

  acquire() {
    if (fs.existsSync(this.lockPath)) {
      throw new BridgeLockError(`Bridge is already running: lock file exists at ${this.lockPath}`);
    }
    const payload = JSON.stringify({
      pid: process.pid,
      created_at: new Date().toISOString(),
    });
    fs.writeFileSync(this.lockPath, payload + '\n', 'utf8');
    this.acquired = true;
  }

  release() {
    this.acquired = false;
  }
}
