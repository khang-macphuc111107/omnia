import fs from 'node:fs';
import path from 'node:path';

export class BatchWriter {
  constructor(outputPath, batchSize = 10) {
    this.outputPath = path.resolve(outputPath);
    this.batchSize = Math.max(1, Number(batchSize) || 10);
    this.buffer = [];
  }

  async init() {
    await fs.promises.mkdir(path.dirname(this.outputPath), { recursive: true });
    await fs.promises.writeFile(this.outputPath, '', 'utf8');
  }

  async enqueue(record) {
    this.buffer.push(JSON.stringify(record));
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const payload = this.buffer.join('\n') + '\n';
    await fs.promises.appendFile(this.outputPath, payload, 'utf8');
    this.buffer = [];
  }

  async close() {
    await this.flush();
  }
}
