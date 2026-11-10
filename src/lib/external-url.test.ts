import { describe, expect, it } from "vitest";

import { normalizeExternalHttpUrl } from "./external-url";

describe("external URL policy", () => {
  it("accepts absolute HTTP and HTTPS URLs", () => {
    expect(normalizeExternalHttpUrl("https://example.com/source?q=1#page=2")).toBe(
      "https://example.com/source?q=1#page=2",
    );
    expect(normalizeExternalHttpUrl("http://127.0.0.1:8080/docs")).toBe(
      "http://127.0.0.1:8080/docs",
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///C:/private.txt",
    "mailto:user@example.com",
    "/relative/source",
    "https://user:secret@example.com/private",
    "not a url",
  ])("rejects unsafe or non-external URL %s", (value) => {
    expect(normalizeExternalHttpUrl(value)).toBeNull();
  });
});
