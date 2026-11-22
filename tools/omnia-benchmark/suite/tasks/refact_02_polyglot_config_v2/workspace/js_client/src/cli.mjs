/**
 * CLI for Node.js event client (currently Protocol v1).
 */

import fs from "node:fs";
import path from "node:path";
import {
  EventValidationError,
  createEvent,
  parseEvent,
  serializeEvent,
  validateEvent,
} from "./events.mjs";

function parseArgs(argv) {
  if (argv.length === 0) {
    throw new EventValidationError("Missing subcommand (emit | ingest | verify)");
  }
  const command = argv[0];
  const opts = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new EventValidationError(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (i + 1 >= argv.length) {
      throw new EventValidationError(`Missing value for --${key}`);
    }
    opts[key] = argv[i + 1];
    i += 1;
  }
  return { command, opts };
}

function main(argv) {
  try {
    const { command, opts } = parseArgs(argv);

    if (command === "emit") {
      if (!opts.type) {
        throw new EventValidationError("Missing required --type");
      }
      if (!opts["payload-json"]) {
        throw new EventValidationError("Missing required --payload-json");
      }
      const payload = JSON.parse(opts["payload-json"]);
      let timestampSec;
      if (opts["timestamp-sec"] !== undefined) {
        timestampSec = Number(opts["timestamp-sec"]);
        if (!Number.isFinite(timestampSec)) {
          throw new EventValidationError(`Invalid --timestamp-sec: ${opts["timestamp-sec"]}`);
        }
      }
      const event = createEvent({
        eventType: opts.type,
        payload,
        tagsCsv: opts.tags ?? "",
        timestampSec,
      });
      process.stdout.write(`${serializeEvent(event)}\n`);
      return 0;
    }

    if (command === "ingest") {
      if (!opts.input || !opts.output) {
        throw new EventValidationError("ingest requires --input and --output");
      }
      const raw = fs.readFileSync(opts.input, "utf8");
      const lines = raw.split(/\r?\n/);
      const outLines = [];
      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx].trim();
        if (!line) continue;
        try {
          const ev = parseEvent(line);
          outLines.push(serializeEvent(ev));
        } catch (err) {
          throw new EventValidationError(`Line ${idx + 1}: ${err.message}`);
        }
      }
      fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
      const content = outLines.length > 0 ? `${outLines.join("\n")}\n` : "";
      fs.writeFileSync(opts.output, content, "utf8");
      return 0;
    }

    if (command === "verify") {
      if (!opts.input) {
        throw new EventValidationError("verify requires --input");
      }
      const raw = fs.readFileSync(opts.input, "utf8");
      const lines = raw.split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          validateEvent(obj);
        } catch (err) {
          throw new EventValidationError(`Line ${idx + 1}: ${err.message}`);
        }
      }
      return 0;
    }

    throw new EventValidationError(`Unknown command: ${command}`);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
