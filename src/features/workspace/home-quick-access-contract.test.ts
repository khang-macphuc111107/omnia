import { describe, expect, it } from "vitest";

import {
  buildHomeQuickAccessBundle,
  DEFAULT_HOME_QUICK_ACCESS,
  HOME_QUICK_ACCESS_SCHEMA,
  parseHomeQuickAccessBundle,
} from "./home-quick-access-contract";

describe("home quick access contract", () => {
  it("round-trips the complete renderer-local layout", () => {
    const bundle = buildHomeQuickAccessBundle(DEFAULT_HOME_QUICK_ACCESS);
    expect(bundle.schema).toBe(HOME_QUICK_ACCESS_SCHEMA);
    expect(parseHomeQuickAccessBundle(JSON.stringify(bundle))).toEqual(DEFAULT_HOME_QUICK_ACCESS);
  });

  it("fails closed for missing, duplicate, and unknown actions", () => {
    const bundle = buildHomeQuickAccessBundle(DEFAULT_HOME_QUICK_ACCESS);
    expect(() => parseHomeQuickAccessBundle(JSON.stringify({ ...bundle, items: bundle.items.slice(1) }))).toThrow(/every known action/i);
    expect(() => parseHomeQuickAccessBundle(JSON.stringify({ ...bundle, items: bundle.items.map((item, index) => index === 1 ? { ...item, id: "new-chat" } : item) }))).toThrow(/unknown or duplicate/i);
    expect(() => parseHomeQuickAccessBundle(JSON.stringify({ ...bundle, items: bundle.items.map((item, index) => index === 0 ? { ...item, id: "unknown" } : item) }))).toThrow(/unknown or duplicate/i);
  });

  it("rejects invalid JSON and oversized payloads", () => {
    expect(() => parseHomeQuickAccessBundle("not json")).toThrow(/valid JSON/i);
    expect(() => parseHomeQuickAccessBundle("x".repeat(16 * 1024 + 1))).toThrow(/exceeds/i);
  });
});
