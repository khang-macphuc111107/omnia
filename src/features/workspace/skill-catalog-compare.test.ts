import { describe, expect, it } from "vitest";

import { initialSkills } from "./mock-data";
import { buildSkillCatalogComparison } from "./skill-catalog-compare";

describe("skill catalog comparison preview", () => {
  it("compares catalog fields and makes permission additions/removals explicit", () => {
    const baseline = initialSkills[0]!;
    const candidate = {
      ...initialSkills[1]!,
      permissions: ["network.read", "workspace.read"],
      tokenFootprint: baseline.tokenFootprint + 240,
    };

    const rows = buildSkillCatalogComparison(baseline, candidate);
    const permissions = rows.find((row) => row.key === "permissions");
    const footprint = rows.find((row) => row.key === "tokenFootprint");

    expect(rows).toHaveLength(7);
    expect(permissions).toMatchObject({
      changed: true,
      added: ["network.read", "workspace.read"],
      removed: ["Create citations", "Read attached sources"],
    });
    expect(footprint?.detail).toContain("240 more");
  });

  it("sorts permission labels deterministically and marks identical metadata unchanged", () => {
    const baseline = { ...initialSkills[0]!, permissions: ["zeta", "alpha", "alpha"] };
    const rows = buildSkillCatalogComparison(baseline, { ...baseline, permissions: ["alpha", "zeta"] });
    const permissions = rows.find((row) => row.key === "permissions");
    const changed = rows.filter((row) => row.changed);

    expect(permissions?.baseline).toBe("alpha, zeta");
    expect(permissions?.candidate).toBe("alpha, zeta");
    expect(permissions?.added).toEqual([]);
    expect(permissions?.removed).toEqual([]);
    expect(changed).toEqual([]);
  });
});
