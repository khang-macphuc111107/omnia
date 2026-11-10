import { describe, expect, it } from "vitest";

import { classifySkillPackageVersion, inspectSkillPackagePayload } from "./skill-package-review-contract";
import type { SkillView } from "./types";

const installed: SkillView[] = [{
  id: "skill-review",
  name: "Review helper",
  description: "Review code with evidence.",
  version: "1.2.0",
  icon: "R",
  source: "Built in",
  trust: "Reviewed",
  enabled: true,
  scope: "Project",
  tokenFootprint: 200,
  permissions: ["read workspace", "use citations"],
}];

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema: "omnia.skill-authoring-preview.v1",
    scope: "renderer-session",
    draft: {
      id: "skill-review",
      name: "Review helper",
      version: "1.3.0",
      summary: "Review code with updated evidence guidance.",
      scope: "Project",
      trust: "Reviewed",
      icon: "R",
      instructions: "# Review helper\n\nInspect code and return findings with evidence and bounded remediation notes.",
      permissions: ["read workspace", "network request"],
      resources: ["Review checklist"],
      tags: ["review"],
      ...overrides,
    },
  });
}

describe("Skill package review contract", () => {
  it("classifies semantic version changes", () => {
    expect(classifySkillPackageVersion("1.2.1", "1.2.0")).toBe("patch");
    expect(classifySkillPackageVersion("1.3.0", "1.2.0")).toBe("minor");
    expect(classifySkillPackageVersion("2.0.0", "1.2.0")).toBe("major");
    expect(classifySkillPackageVersion("1.1.0", "1.2.0")).toBe("downgrade");
    expect(classifySkillPackageVersion("0.1.0", null)).toBe("new");
  });

  it("reports permission and metadata diffs against the installed projection", () => {
    const review = inspectSkillPackagePayload(payload(), installed);
    expect(review.canStage).toBe(true);
    expect(review.versionChange).toBe("minor");
    expect(review.addedPermissions).toEqual(["network request"]);
    expect(review.removedPermissions).toEqual(["use citations"]);
    expect(review.summaryChanged).toBe(true);
    expect(review.bodyComparison).toBe("unavailable");
  });

  it("fails closed for malformed or unsupported package payloads", () => {
    expect(inspectSkillPackagePayload("not json", installed).canStage).toBe(false);
    const invalid = inspectSkillPackagePayload(payload({ version: "1" }), installed);
    expect(invalid.canStage).toBe(false);
    expect(invalid.checks.find((check) => check.id === "version")?.passed).toBe(false);
  });
});

