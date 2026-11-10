import { describe, expect, it } from "vitest";

import {
  APPROVAL_REQUEST_BOUNDARY,
  APPROVAL_REQUEST_PRESETS,
  DEFAULT_APPROVAL_REQUEST,
  approvalRequestRisk,
  approvalRequestValidation,
  safeApprovalRequestPayload,
  serializeApprovalRequest,
} from "./approval-request-preview-contract";

describe("approval request preview contract", () => {
  it("provides safe presets with exact targets and bounded network/secret defaults", () => {
    expect(APPROVAL_REQUEST_PRESETS).toHaveLength(4);
    for (const preset of APPROVAL_REQUEST_PRESETS) {
      expect(preset.values.target.trim()).not.toBe("");
      expect(preset.values.rationale.trim()).not.toBe("");
      expect(preset.values.secrets).not.toBe("prompt-each-use");
    }
    expect(DEFAULT_APPROVAL_REQUEST.network).toBe("offline");
    expect(DEFAULT_APPROVAL_REQUEST.secrets).toBe("blocked");
  });

  it("uses a conservative risk signal and validates custom expiry", () => {
    expect(approvalRequestRisk({ ...DEFAULT_APPROVAL_REQUEST, operation: "delete-artifact" })).toBe("high");
    expect(approvalRequestRisk({ ...DEFAULT_APPROVAL_REQUEST, operation: "call-provider", network: "public-https" })).toBe("medium");
    expect(approvalRequestValidation({ ...DEFAULT_APPROVAL_REQUEST, expiry: "custom" })).toContain("Choose a custom expiry timestamp.");
  });

  it("serializes only preview metadata and includes the non-authority boundary", () => {
    const payload = safeApprovalRequestPayload(DEFAULT_APPROVAL_REQUEST);
    const serialized = serializeApprovalRequest(DEFAULT_APPROVAL_REQUEST, "markdown");
    expect(payload.scope).toBe("omnia.approval-request.preview.v1");
    expect(payload.request.state).toBe("draft");
    expect(payload.boundary).toBe(APPROVAL_REQUEST_BOUNDARY);
    expect(serialized).toContain("Renderer-local approval rehearsal only");
    expect(serialized).toContain("Exact target only");
  });
});

