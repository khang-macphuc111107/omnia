import { describe, expect, it } from "vitest";

import {
  buildDiagnosticExportPreview,
  DIAGNOSTIC_REDACTION_POLICY,
  redactDiagnosticText,
  sanitizeDiagnosticEvent,
  serializeDiagnosticPreview,
  type DiagnosticPreviewEvent,
} from "./diagnostics-session-contract";

describe("diagnostics session preview redaction", () => {
  it("removes sensitive credentials, signed URL fields, identities, paths, and unsafe controls", () => {
    const unsafe = [
      "Authorization: Bearer sk-preview-leak-123456789",
      "Cookie: session=preview-cookie-canary",
      "https://alice:preview-password@example.test/v1?access_token=preview-token&X-Amz-Signature=preview-signature",
      "file:///C:/Users/khang/private/preview.txt",
      "\\\\server\\share\\khang\\preview.txt",
      "/home/khang/.config/omnia/settings.json",
      "dev@example.test",
      "\u202Ehidden-order",
      "-----BEGIN TEST PRIVATE KEY-----\npreview-private-key\n-----END TEST PRIVATE KEY-----",
    ].join(" | ");

    const redacted = redactDiagnosticText(unsafe);

    for (const forbidden of [
      "sk-preview-leak-123456789",
      "preview-cookie-canary",
      "preview-password",
      "preview-token",
      "preview-signature",
      "C:\\Users\\khang",
      "\\\\server\\share\\khang",
      "/home/khang",
      "dev@example.test",
      "preview-private-key",
      "\u202E",
    ]) {
      expect(redacted).not.toContain(forbidden);
    }
    expect(redacted).toContain("access_token=[REDACTED]");
    expect(redacted).toContain("X-Amz-Signature=[REDACTED]");
    expect(redacted).toContain("[REDACTED_PATH]");
  });

  it("uses an allowlist and safe fallback values for untrusted runtime event objects", () => {
    const unsafe = {
      id: "event-1",
      occurredAt: "not-a-date",
      level: "fatal",
      category: "provider-payload",
      title: "Provider response for dev@example.test",
      detail: "apiKey=preview-api-key-123456789 at /tmp/khang/provider.json",
      source: "https://example.test?sig=preview-signed-value",
      headers: { authorization: "Bearer preview-header-token" },
      rawPayload: "keep-this-out-of-the-export",
    } as unknown as DiagnosticPreviewEvent;

    const safe = sanitizeDiagnosticEvent(unsafe);

    expect(safe).toEqual({
      id: "event-1",
      occurredAt: "unknown",
      level: "info",
      category: "runtime",
      title: "Provider response for [REDACTED_EMAIL]",
      detail: "apiKey=[REDACTED] at [REDACTED_PATH]",
      source: "https://example.test?sig=[REDACTED]",
    });
    expect(safe).not.toHaveProperty("headers");
    expect(safe).not.toHaveProperty("rawPayload");
  });

  it("serializes only redacted allowed fields and labels the redaction policy in JSON and JSONL", () => {
    const unsafe = {
      id: "provider-event",
      occurredAt: "2026-09-19T00:00:00.000Z",
      level: "error",
      category: "provider",
      title: "Provider failure",
      detail: "password=preview-password-123456789 file:///Users/khang/private.txt",
      source: "provider-preview",
      requestBody: "this-canary-must-not-export",
    } as unknown as DiagnosticPreviewEvent;

    const json = serializeDiagnosticPreview([unsafe], "json", "2026-09-19T00:00:01.000Z");
    const jsonl = serializeDiagnosticPreview([unsafe], "jsonl", "2026-09-19T00:00:01.000Z");
    const payload = JSON.parse(json) as {
      redactionPolicy: string;
      events: Array<Record<string, unknown>>;
    };

    expect(payload.redactionPolicy).toBe(DIAGNOSTIC_REDACTION_POLICY);
    expect(payload.events[0]).toEqual({
      id: "provider-event",
      occurredAt: "2026-09-19T00:00:00.000Z",
      level: "error",
      category: "provider",
      title: "Provider failure",
      detail: "password=[REDACTED] file://[REDACTED_PATH]",
      source: "provider-preview",
    });

    for (const serialized of [json, jsonl]) {
      expect(serialized).toContain(DIAGNOSTIC_REDACTION_POLICY);
      expect(serialized).not.toContain("preview-password-123456789");
      expect(serialized).not.toContain("/Users/khang");
      expect(serialized).not.toContain("this-canary-must-not-export");
    }
  });

  it("builds an explicit export review with data planes, exclusions, retention, and validation", () => {
    const preview = buildDiagnosticExportPreview({
      events: [{
        id: "event-1",
        occurredAt: "2026-09-19T00:00:00.000Z",
        level: "info",
        category: "runtime",
        title: "Ready",
        detail: "Renderer-only checkpoint",
        source: "preview",
      }],
      scope: "visible",
      format: "jsonl",
      generatedAt: "2026-09-19T00:00:01.000Z",
    });

    expect(preview).toMatchObject({
      scope: "visible",
      format: "jsonl",
      eventCount: 1,
      generatedAt: "2026-09-19T00:00:01.000Z",
      redactionPolicy: DIAGNOSTIC_REDACTION_POLICY,
      retention: "download-only",
      validation: { status: "ready" },
    });
    expect(preview.dataPlanes).toEqual(expect.arrayContaining(["Event summaries"]));
    expect(preview.excludedData).toEqual(expect.arrayContaining(["Prompt and response bodies"]));
    expect(preview.validation.checks).toEqual(expect.arrayContaining(["Sensitive-looking values redacted"]));
  });
});
