import { describe, expect, it } from "vitest";

import {
  buildWorkspaceTransferManifest,
  parseWorkspaceTransferManifest,
  serializeWorkspaceTransferManifest,
  WORKSPACE_TRANSFER_MAX_BYTES,
  WORKSPACE_TRANSFER_SCHEMA,
} from "./workspace-transfer-contract";

const selection = {
  conversations: true,
  projects: true,
  memoryCandidates: false,
  skills: false,
  artifacts: true,
  attachments: true,
  runEvidence: false,
};

function makeManifest() {
  return buildWorkspaceTransferManifest({
    mode: "handoff",
    scope: "active-project",
    profile: "portable",
    format: "json",
    redaction: "safe",
    target: "Research partner",
    selection,
    counts: {
      conversations: 2,
      projects: 1,
      memoryCandidates: 0,
      skills: 0,
      artifacts: 3,
      attachments: 4,
      runEvidence: 0,
    },
    estimatedBytes: 4_096,
    records: 10,
    generatedAt: "2026-09-20T10:00:00.000Z",
    warnings: ["Preview only"],
  });
}

describe("workspace transfer contract", () => {
  it("round-trips a strict JSON manifest without changing the preview boundary", () => {
    const manifest = makeManifest();
    const parsed = parseWorkspaceTransferManifest(serializeWorkspaceTransferManifest(manifest, "json"));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.schema).toBe(WORKSPACE_TRANSFER_SCHEMA);
      expect(parsed.manifest.target).toBe("Research partner");
      expect(parsed.manifest.executionDisposition).toBe("preview-only");
      expect(parsed.manifest.durableWrite).toBe(false);
      expect(parsed.manifest.counts.attachments).toBe(4);
    }
  });

  it("serializes JSONL and Markdown with explicit scope and warning lines", () => {
    const manifest = makeManifest();
    expect(serializeWorkspaceTransferManifest(manifest, "jsonl")).toContain("\n");
    const markdown = serializeWorkspaceTransferManifest(manifest, "markdown");
    expect(markdown).toContain("# Omnia workspace transfer preview");
    expect(markdown).toContain("- attachments: 4");
    expect(markdown).toContain("- Preview only");
  });

  it("fails closed for an invalid or oversized payload", () => {
    expect(parseWorkspaceTransferManifest("{\"schema\":\"wrong\"}")).toMatchObject({ ok: false });
    const oversized = "x".repeat(WORKSPACE_TRANSFER_MAX_BYTES + 1);
    expect(parseWorkspaceTransferManifest(oversized)).toMatchObject({ ok: false });
  });
});
