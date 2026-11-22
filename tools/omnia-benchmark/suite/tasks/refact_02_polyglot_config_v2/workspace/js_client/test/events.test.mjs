/**
 * Unit tests for js_client (baseline v1; update/extend for v2 migration).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EventValidationError,
  createEvent,
  parseEvent,
  serializeEvent,
} from "../src/events.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "../../fixtures/v1_events.jsonl");

// Test 1: Parse v1 fixture lines
{
  const lines = fs
    .readFileSync(fixturePath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  assert.equal(lines.length, 4);
  const parsed = lines.map((line) => parseEvent(line));
  assert.equal(parsed[0].payload.user, "alice");
  assert.equal(parsed[1].payload.city, "café 東京");
  assert.equal(parsed[3].payload.counts.sent, 42);
}

// Test 2: Create and serialize round-trip
{
  const ev = createEvent({
    eventType: "order.created",
    payload: { amount: 99, currency: "USD" },
    tagsCsv: "web, priority",
    timestampSec: 1710506096,
  });
  const raw = serializeEvent(ev);
  const reparsed = parseEvent(raw);
  assert.deepEqual(reparsed.payload, { amount: 99, currency: "USD" });
}

// Test 3: Reject non-object payload
{
  assert.throws(
    () =>
      parseEvent(
        JSON.stringify({
          type: "bad.event",
          timestamp_sec: 1710506096,
          tags_csv: "",
          payload: [1, 2, 3],
        }),
      ),
    EventValidationError,
  );
}

console.log("js_client events tests passed");
