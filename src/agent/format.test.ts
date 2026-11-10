import { describe, expect, it } from "vitest";

import { contextUsage, contextWindow } from "./format";

const usage = (input: number, cacheRead = 0) => ({
  input_tokens: input, output_tokens: 10, cache_read_tokens: cacheRead, cache_write_tokens: 0,
});

describe("context window math", () => {
  it("maps model ids to windows", () => {
    expect(contextWindow("claude-sonnet-4")).toBe(200_000);
    expect(contextWindow("gpt-4.1-mini")).toBe(128_000);
    expect(contextWindow("gpt-5")).toBe(400_000);
    expect(contextWindow("gemini-2.5-pro")).toBe(1_000_000);
    expect(contextWindow("llama-3")).toBe(128_000);
  });

  it.each([
    ["claude-sonnet-4[1m]", 1_000_000],
    ["vendor/CLAUDE-1M", 1_000_000],
    ["claude-sonnet-4", 200_000],
    ["gpt-4.1", 128_000],
    ["gpt-5-mini", 400_000],
    ["gemini-2.5-pro", 1_000_000],
    ["o3", 200_000],
    ["o4-mini", 200_000],
    ["openai/o3-mini", 200_000],
    ["openai/o4-mini", 200_000],
    ["deepseek-chat", 128_000],
    ["unknown", 128_000],
  ])("matches harness default for %s", (model, window) => {
    expect(contextWindow(String(model))).toBe(window);
  });

  it("computes percent and warns at the default 80% boundary", () => {
    expect(contextUsage(usage(50_000, 50_000), "claude-x")).toMatchObject({ used: 100_000, percent: 50, warn: false });
    expect(contextUsage(usage(160_000), "claude-x").warn).toBe(true);
    expect(contextUsage(usage(160_001), "claude-x").warn).toBe(true);
    expect(contextUsage(usage(999_999), "claude-x").percent).toBe(100);
  });
});
