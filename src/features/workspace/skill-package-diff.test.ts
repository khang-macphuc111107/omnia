import { describe, expect, it } from "vitest";

import { buildSkillPackageDiff } from "./skill-package-diff";
import { inspectSkillPackagePayload } from "./skill-package-review-contract";
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

function review(overrides: Record<string, unknown> = {}) {
  const payload = JSON.stringify({
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
      resources: ["Review checklist", "Examples"],
      tags: ["review", "evidence"],
      ...overrides,
    },
  });
  return inspectSkillPackagePayload(payload, installed);
}

describe("skill package field diff", () => {
  it("shows permission additions/removals and candidate resource/tag inventory", () => {
    const rows = buildSkillPackageDiff(review());
    expect(rows.find((row) => row.id === "permissions")).toMatchObject({
      status: "changed",
      added: ["network request"],
      removed: ["use citations"],
    });
    expect(rows.find((row) => row.id === "resources")).toMatchObject({
      status: "new",
      candidate: "Examples, Review checklist",
    });
    expect(rows.find((row) => row.id === "instructions")?.status).toBe("unavailable");
  });

  it("marks a first-seen package as new without claiming an installed baseline", () => {
    const candidate = inspectSkillPackagePayload(JSON.stringify({
      schema: "omnia.skill-authoring-preview.v1",
      scope: "renderer-session",
      draft: {
        id: "new-review-skill",
        name: "New review skill",
        version: "0.1.0",
        summary: "A new package for reviewing code evidence.",
        scope: "Manual",
        trust: "Unreviewed",
        icon: "N",
        instructions: "# New review skill\n\nReview supplied code and report evidence with concise, actionable notes.",
        permissions: ["read project context"],
        resources: ["Checklist"],
        tags: ["new"],
      },
    }), installed);
    const rows = buildSkillPackageDiff(candidate);
    expect(rows.find((row) => row.id === "version")).toMatchObject({ status: "new", baseline: "Not installed" });
    expect(rows.find((row) => row.id === "permissions")?.status).toBe("new");
    expect(rows.find((row) => row.id === "instructions")?.baseline).toBe("No installed body baseline");
  });
});
