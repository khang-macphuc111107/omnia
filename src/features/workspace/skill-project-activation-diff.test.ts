import { describe, expect, it } from "vitest";

import type { ProjectSkillActivation } from "./skill-activation-matrix";
import type { ProjectView, SkillView } from "./types";
import {
  buildProjectSkillActivationDiff,
  projectSkillActivationCell,
  serializeProjectSkillActivationDiff,
} from "./skill-project-activation-diff";

const projects: ProjectView[] = [
  {
    id: "project-a",
    name: "Alpha",
    description: "Alpha project",
    accent: "#10b981",
    instructions: "Alpha instructions",
    modelProfileId: "model-a",
    conversationCount: 1,
    contextHealth: "ready",
    pinned: false,
    folders: [],
  },
  {
    id: "project-b",
    name: "Beta",
    description: "Beta project",
    accent: "#3b82f6",
    instructions: "Beta instructions",
    modelProfileId: "model-b",
    conversationCount: 2,
    contextHealth: "ready",
    pinned: false,
    folders: [],
  },
];

const skills: SkillView[] = [
  {
    id: "global-skill",
    name: "Global skill",
    description: "Global skill",
    version: "1.0.0",
    icon: "G",
    source: "Built in",
    trust: "Verified",
    enabled: true,
    scope: "Global",
    tokenFootprint: 100,
    permissions: [],
  },
  {
    id: "project-skill",
    name: "Project skill",
    description: "Project skill",
    version: "1.0.0",
    icon: "P",
    source: "Local",
    trust: "Reviewed",
    enabled: false,
    scope: "Project",
    tokenFootprint: 120,
    permissions: [],
  },
  {
    id: "manual-skill",
    name: "Manual skill",
    description: "Manual skill",
    version: "1.0.0",
    icon: "M",
    source: "Imported",
    trust: "Reviewed",
    enabled: false,
    scope: "Manual",
    tokenFootprint: 80,
    permissions: [],
  },
];

describe("skill project activation diff preview", () => {
  it("distinguishes inherited, explicit project, and manual states", () => {
    const activation: ProjectSkillActivation = { "project-a": { "project-skill": true, "global-skill": false } };
    expect(projectSkillActivationCell(skills[0]!, projects[0]!, new Set(["global-skill"]), activation)).toMatchObject({
      state: "inherited-enabled",
      explicit: false,
      provenance: "global-default",
    });
    expect(projectSkillActivationCell(skills[1]!, projects[0]!, new Set(), activation)).toMatchObject({
      state: "project-enabled",
      explicit: true,
      provenance: "project-draft",
    });
    expect(projectSkillActivationCell(skills[2]!, projects[0]!, new Set(), activation)).toMatchObject({
      state: "manual-only",
      explicit: false,
      provenance: "manual-policy",
    });
  });

  it("builds a stable project comparison with counts and changed rows", () => {
    const activation: ProjectSkillActivation = {
      "project-a": { "project-skill": true },
      "project-b": { "project-skill": false },
    };
    const diff = buildProjectSkillActivationDiff(skills, projects, "project-a", "project-b", new Set(["global-skill"]), activation);
    expect(diff.schema).toBe("omnia.skill-project-activation-diff-preview.v1");
    expect(diff.scope).toBe("renderer-session");
    expect(diff.counts.removed).toBe(1);
    expect(diff.changedRows.map((row) => row.skillId)).toEqual(["project-skill"]);
    expect(diff.changedRows[0]).toMatchObject({ kind: "removed", from: { state: "project-enabled" }, to: { state: "project-disabled" } });
  });

  it("serializes JSON and honest markdown boundaries", () => {
    const diff = buildProjectSkillActivationDiff(skills, projects, "project-a", "project-b", new Set(["global-skill"]), {
      "project-a": { "project-skill": true },
      "project-b": { "project-skill": false },
    });
    expect(JSON.parse(serializeProjectSkillActivationDiff(diff, "json"))).toMatchObject({
      schema: "omnia.skill-project-activation-diff-preview.v1",
      fromProjectName: "Alpha",
      toProjectName: "Beta",
    });
    const markdown = serializeProjectSkillActivationDiff(diff, "markdown");
    expect(markdown).toContain("Renderer-session comparison");
    expect(markdown).toContain("Project skill");
    expect(markdown).toMatch(/native project policy/i);
  });
});
