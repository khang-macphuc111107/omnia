import { describe, expect, it } from "vitest";

import {
  changedProjectMetadataFields,
  createProjectMetadataReceiptPreview,
  PROJECT_METADATA_RECEIPT_PREVIEW_BOUNDARY,
  serializeProjectMetadataReceiptPreview,
} from "./project-metadata-receipt-preview";

const before = {
  name: "Omnia",
  description: "Workspace",
  instructions: "Be precise.",
} as const;

describe("project metadata receipt preview contract", () => {
  it("reports only the metadata fields that changed", () => {
    expect(changedProjectMetadataFields(before, { ...before, name: "Omnia Desktop" })).toEqual(["name"]);
    expect(changedProjectMetadataFields(before, { ...before, instructions: "Be concise." })).toEqual(["instructions"]);
    expect(changedProjectMetadataFields(before, before)).toEqual([]);
  });

  it("creates a bounded, non-authoritative observation with safe cursors", () => {
    const receipt = createProjectMetadataReceiptPreview({
      projectId: "project:omnia",
      mode: "native-command",
      outcome: "applied",
      before,
      after: { ...before, name: "Omnia Desktop" },
      expectedUpdatedAtMs: 12,
      observedUpdatedAtMs: 13,
      detail: "Native acknowledgement.",
      sequence: 2,
      recordedAt: "2026-09-25T10:00:00.000Z",
    });

    expect(receipt.id).toBe("project-metadata-preview:project:omnia:2");
    expect(receipt.changedFields).toEqual(["name"]);
    expect(receipt.expectedUpdatedAtMs).toBe(12);
    expect(receipt.observedUpdatedAtMs).toBe(13);
    expect(receipt.authoritative).toBe(false);
    expect(receipt.durable).toBe(false);
  });

  it("serializes redacted JSON and Markdown exports with the preview boundary", () => {
    const receipt = createProjectMetadataReceiptPreview({
      projectId: "project-1",
      mode: "browser-preview",
      outcome: "blocked",
      before,
      after: { ...before, description: "Updated" },
      detail: "Validation failed",
      sequence: 1,
      recordedAt: "2026-09-25T10:00:00.000Z",
    });

    const json = serializeProjectMetadataReceiptPreview([receipt], "json");
    const markdown = serializeProjectMetadataReceiptPreview([receipt], "markdown");

    expect(JSON.parse(json)).toMatchObject({
      format: "omnia.project-metadata-receipt-preview.v1",
      scope: "renderer-session",
      authoritative: false,
      durable: false,
      entryCount: 1,
    });
    const parsed = JSON.parse(json) as { entries: Array<Record<string, unknown>> };
    expect(parsed.entries[0]).not.toHaveProperty("description");
    expect(parsed.entries[0]).not.toHaveProperty("before");
    expect(parsed.entries[0]).not.toHaveProperty("after");
    expect(markdown).toContain("Omnia Project metadata save observation preview");
    expect(markdown).toContain(PROJECT_METADATA_RECEIPT_PREVIEW_BOUNDARY);
    expect(markdown).toContain("Description");
  });
});
