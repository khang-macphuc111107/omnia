import { describe, expect, it } from "vitest";

import {
  MAX_IMPORTED_ROUTING_PROFILES,
  parseRoutingProfilePreviewImport,
  ROUTING_PROFILE_PREVIEW_SCHEMA,
} from "./routing-profile-import";

function bundle(savedProfiles: unknown[]) {
  return JSON.stringify({
    schema: ROUTING_PROFILE_PREVIEW_SCHEMA,
    scope: "renderer-session",
    executionDisposition: "preview-only",
    route: { preference: "auto", fallbackConsent: "never", modelProfileId: "auto", resolvedModel: "Automatic" },
    savedProfiles,
    boundary: ["Renderer-session preview only"],
  });
}

describe("routing profile preview import", () => {
  it("accepts a bounded preview bundle and normalizes imported metadata", () => {
    const result = parseRoutingProfilePreviewImport(bundle([
      {
        id: "custom-one",
        name: "  Local coding  ",
        description: "  Prefer a local route. ",
        preference: "local",
        fallbackConsent: "same-connection",
        modelProfileId: "local-fast",
        source: "renderer-session",
      },
    ]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profiles[0]).toMatchObject({
        name: "Local coding",
        description: "Prefer a local route.",
        preference: "local",
        consent: "same-connection",
        modelProfileId: "local-fast",
        custom: true,
      });
    }
  });

  it("fails closed for wrong scope, duplicate names, and oversized profile lists", () => {
    const wrongScope = parseRoutingProfilePreviewImport(bundle([]).replace("renderer-session", "native"));
    expect(wrongScope).toMatchObject({ ok: false });

    const duplicateNames = parseRoutingProfilePreviewImport(bundle([
      { name: "Same", preference: "auto", fallbackConsent: "never", modelProfileId: "auto" },
      { name: " same ", preference: "quality", fallbackConsent: "never", modelProfileId: "auto" },
    ]));
    expect(duplicateNames).toMatchObject({ ok: false });

    const tooMany = parseRoutingProfilePreviewImport(bundle(Array.from({ length: MAX_IMPORTED_ROUTING_PROFILES + 1 }, (_, index) => ({
      name: `Profile ${index}`,
      preference: "auto",
      fallbackConsent: "never",
      modelProfileId: "auto",
    }))));
    expect(tooMany).toMatchObject({ ok: false });
  });
});
