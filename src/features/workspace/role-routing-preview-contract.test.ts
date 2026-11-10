import { describe, expect, it } from "vitest";

import { modelProfiles, initialProviders } from "./mock-data";
import {
  ROLE_ROUTING_PRECEDENCE,
  ROLE_ROUTING_ROLES,
  availableRoleRouteIds,
  createDefaultRoleRoutingState,
  normalizeRoleRoute,
  roleRouteReadiness,
  serializeRoleRoutingPreview,
  type RoleRoutingState,
} from "./role-routing-preview-contract";

describe("role routing preview contract", () => {
  it("keeps a bounded role vocabulary and default effort per role", () => {
    const state = createDefaultRoleRoutingState();
    expect(ROLE_ROUTING_ROLES.map((role) => role.id)).toEqual(["main", "subagent", "orchestrator", "planner", "explorer", "researcher", "builder", "reviewer", "verifier", "specialist"]);
    expect(Object.keys(state)).toHaveLength(ROLE_ROUTING_ROLES.length);
    expect(state.planner.effort).toBe("deep");
    expect(state.main).toMatchObject({ mode: "auto", modelProfileId: null, candidateProfileIds: [] });
  });

  it("fails closed for unavailable explicit and pool routes", () => {
    const available = new Set(availableRoleRouteIds(modelProfiles, new Set(initialProviders.map((provider) => provider.id))));
    const explicit = normalizeRoleRoute({ mode: "explicit", modelProfileId: "long-context", candidateProfileIds: ["quality"], effort: "deep" }, available);
    expect(explicit.modelProfileId).toBeNull();
    expect(explicit.candidateProfileIds).toEqual([]);
    expect(roleRouteReadiness(explicit, available)).toBe("blocked");

    const pool = normalizeRoleRoute({ mode: "pool", modelProfileId: "quality", candidateProfileIds: ["quality", "missing", "quality"], effort: "balanced" }, available);
    expect(pool.modelProfileId).toBeNull();
    expect(pool.candidateProfileIds).toEqual(["quality"]);
    expect(roleRouteReadiness(pool, available)).toBe("ready");
  });

  it("serializes precedence, role overrides, and renderer-only boundaries", () => {
    const state: RoleRoutingState = {
      ...createDefaultRoleRoutingState(),
      reviewer: { mode: "explicit", modelProfileId: "quality", candidateProfileIds: [], effort: "ultra" },
    };
    const payload = JSON.parse(serializeRoleRoutingPreview(state, modelProfiles));
    expect(payload.schema).toBe("omnia.role-routing-preview.v1");
    expect(payload.precedence).toEqual([...ROLE_ROUTING_PRECEDENCE]);
    expect(payload.roleOverrides.reviewer).toMatchObject({ mode: "explicit", modelProfileId: "quality", effort: "ultra" });
    expect(payload.boundary).toContain("No native role policy was written");
  });
});
