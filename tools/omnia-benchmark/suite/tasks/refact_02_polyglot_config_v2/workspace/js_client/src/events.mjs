/**
 * Event Protocol v1 codec and validator (to be migrated to Protocol v2).
 */

export class EventValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EventValidationError";
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createEvent({
  eventType,
  payload,
  tagsCsv = "",
  timestampSec = undefined,
} = {}) {
  const ts = timestampSec === undefined || timestampSec === null ? Date.now() / 1000 : timestampSec;
  const event = {
    type: eventType,
    timestamp_sec: ts,
    tags_csv: tagsCsv,
    payload,
  };
  validateEvent(event);
  return event;
}

export function validateEvent(event) {
  if (!isPlainObject(event)) {
    throw new EventValidationError("Event must be a plain object");
  }
  if ("schema_version" in event && event.schema_version !== 1) {
    throw new EventValidationError(`Unsupported schema_version: ${String(event.schema_version)}`);
  }
  if (typeof event.type !== "string" || event.type.trim().length === 0) {
    throw new EventValidationError("Event 'type' must be a non-empty string");
  }
  if (typeof event.timestamp_sec !== "number" || !Number.isFinite(event.timestamp_sec)) {
    throw new EventValidationError("Event 'timestamp_sec' must be a finite number");
  }
  const tagsCsv = event.tags_csv ?? "";
  if (typeof tagsCsv !== "string") {
    throw new EventValidationError("Event 'tags_csv' must be a string");
  }
  if (!isPlainObject(event.payload)) {
    throw new EventValidationError("Event 'payload' must be a JSON object");
  }
}

export function parseEvent(raw) {
  let obj;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      throw new EventValidationError(`Invalid JSON: ${err.message}`);
    }
  } else {
    obj = raw;
  }
  validateEvent(obj);
  return obj;
}

export function serializeEvent(event) {
  validateEvent(event);
  return JSON.stringify(event);
}
