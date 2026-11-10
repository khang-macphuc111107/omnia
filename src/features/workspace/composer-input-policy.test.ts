import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPOSER_INPUT_THRESHOLDS,
  evaluateComposerInput,
  measureComposerInput,
  resolveComposerInputThresholds,
} from "./composer-input-policy";

describe("composer input measurements", () => {
  it("measures UTF-8 bytes and Unicode characters without confusing surrogate pairs", () => {
    const metrics = measureComposerInput("😀é");

    expect(metrics.characterCount).toBe(2);
    expect(metrics.utf16CodeUnitCount).toBe(3);
    expect(metrics.byteCount).toBe(6);
    expect(metrics.lineCount).toBe(1);
    expect(metrics.estimatedTokenCount).toBeGreaterThan(0);
  });

  it("counts CRLF as one line break and treats an empty draft as zero lines", () => {
    expect(measureComposerInput("").lineCount).toBe(0);
    expect(measureComposerInput("first\r\nsecond\nthird\rfourth").lineCount).toBe(4);
  });
});

describe("composer input threshold policy", () => {
  it("uses the normative defaults and does not trigger at an exact boundary", () => {
    const text = "x".repeat(DEFAULT_COMPOSER_INPUT_THRESHOLDS.maxCharacters);
    const result = evaluateComposerInput(text);

    expect(result.thresholds).toEqual(DEFAULT_COMPOSER_INPUT_THRESHOLDS);
    expect(result.triggered).toBe(false);
    expect(result.shouldConvertToFile).toBe(false);
    expect(result.primaryReason).toBeNull();
  });

  it("reports every crossed limit in deterministic order", () => {
    const result = evaluateComposerInput("a\n".repeat(4), {
      thresholds: {
        maxCharacters: 3,
        maxEstimatedTokens: 2,
        maxBytes: 3,
        maxLines: 2,
      },
    });

    expect(result.triggered).toBe(true);
    expect(result.shouldConvertToFile).toBe(true);
    expect(result.triggerReasons).toEqual([
      "characters",
      "estimated_tokens",
      "bytes",
      "lines",
    ]);
    expect(result.primaryReason).toBe("characters");
  });

  it("supports ask and inline modes without changing the measured evidence", () => {
    const options = {
      thresholds: { maxCharacters: 2 },
    } as const;
    const ask = evaluateComposerInput("abcd", { ...options, mode: "ask" });
    const inline = evaluateComposerInput("abcd", { ...options, mode: "inline" });

    expect(ask.triggered).toBe(true);
    expect(ask.shouldConvertToFile).toBe(false);
    expect(inline.triggered).toBe(true);
    expect(inline.shouldConvertToFile).toBe(false);
    expect(ask.metrics).toEqual(inline.metrics);
  });

  it("records renderer responsiveness as a conversion reason", () => {
    const result = evaluateComposerInput("small", {
      inlineRenderingDegraded: true,
    });

    expect(result.triggerReasons).toEqual(["responsiveness"]);
    expect(result.shouldConvertToFile).toBe(true);
  });

  it("rejects invalid threshold settings instead of silently accepting them", () => {
    expect(() => resolveComposerInputThresholds({ maxBytes: 0 })).toThrow(
      /maxBytes must be a positive safe integer/i,
    );
    expect(() => resolveComposerInputThresholds({ maxLines: 1.5 })).toThrow(
      /maxLines must be a positive safe integer/i,
    );
  });
});

