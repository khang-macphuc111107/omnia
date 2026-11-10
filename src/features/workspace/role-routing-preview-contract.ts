import type { ModelProfileView } from "./types";

/**
 * The role keys intentionally mirror the scheduling roles that the current
 * renderer can name.  They are a bounded UI vocabulary; this preview does not
 * accept arbitrary map keys as executable authority.
 */
export const ROLE_ROUTING_ROLES = [
  { id: "main", label: "Main chat", description: "The primary assistant route for the current conversation." },
  { id: "subagent", label: "Subagent", description: "A delegated worker spawned from the current task." },
  { id: "orchestrator", label: "Orchestrator", description: "Coordinates bounded agents and keeps the completion contract visible." },
  { id: "planner", label: "Planner", description: "Breaks a request into bounded steps and dependencies." },
  { id: "explorer", label: "Explorer", description: "Inspects the available workspace or evidence without mutating it." },
  { id: "researcher", label: "Researcher", description: "Collects and compares evidence before handoff." },
  { id: "builder", label: "Builder", description: "Produces the requested implementation or artifact." },
  { id: "reviewer", label: "Reviewer", description: "Checks a draft against the task contract and evidence." },
  { id: "verifier", label: "Verifier", description: "Runs focused checks and reports residual uncertainty." },
  { id: "specialist", label: "Specialist", description: "Applies a bounded domain contract without widening authority." },
] as const;

export type RoleRoutingRoleId = (typeof ROLE_ROUTING_ROLES)[number]["id"];
export type RoleRoutingMode = "auto" | "explicit" | "pool";
export type RoleRoutingEffort = "fast" | "balanced" | "deep" | "ultra" | "custom";

export type RoleRouteChoice = {
  readonly mode: RoleRoutingMode;
  readonly modelProfileId: string | null;
  readonly candidateProfileIds: readonly string[];
  readonly effort: RoleRoutingEffort;
};

export type RoleRoutingState = Record<RoleRoutingRoleId, RoleRouteChoice>;

export const ROLE_ROUTING_EFFORTS: readonly { value: RoleRoutingEffort; label: string }[] = [
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "deep", label: "Deep" },
  { value: "ultra", label: "Ultra" },
  { value: "custom", label: "Custom" },
];

export const ROLE_ROUTING_PRECEDENCE = [
  "prompt",
  "task",
  "agent-instance",
  "role",
  "persona",
  "workflow",
  "skill",
  "project",
  "profile",
  "global",
  "auto",
] as const;

const DEFAULT_EFFORTS: Readonly<Record<RoleRoutingRoleId, RoleRoutingEffort>> = {
  main: "balanced",
  subagent: "balanced",
  orchestrator: "deep",
  planner: "deep",
  explorer: "balanced",
  researcher: "deep",
  builder: "balanced",
  reviewer: "deep",
  verifier: "deep",
  specialist: "deep",
};

export function createDefaultRoleRoutingState(): RoleRoutingState {
  return Object.fromEntries(
    ROLE_ROUTING_ROLES.map(({ id }) => [id, {
      mode: "auto",
      modelProfileId: null,
      candidateProfileIds: [],
      effort: DEFAULT_EFFORTS[id],
    } satisfies RoleRouteChoice]),
  ) as unknown as RoleRoutingState;
}

export function cloneRoleRoutingState(state: RoleRoutingState): RoleRoutingState {
  return Object.fromEntries(
    ROLE_ROUTING_ROLES.map(({ id }) => {
      const route = state[id] ?? createDefaultRoleRoutingState()[id];
      return [id, { ...route, candidateProfileIds: [...route.candidateProfileIds] }];
    }),
  ) as unknown as RoleRoutingState;
}

export function availableRoleRouteIds(
  profiles: readonly ModelProfileView[],
  connectedProviderIds: ReadonlySet<string>,
): string[] {
  return profiles
    .filter((profile) => profile.id !== "auto" && profile.status === "available" && profile.connectionId !== null && connectedProviderIds.has(profile.connectionId))
    .map((profile) => profile.id);
}

export type RoleRouteReadiness = "auto" | "ready" | "blocked" | "needs-candidates";

export function roleRouteReadiness(
  route: RoleRouteChoice,
  availableIds: ReadonlySet<string>,
): RoleRouteReadiness {
  if (route.mode === "auto") return "auto";
  if (route.mode === "explicit") return route.modelProfileId !== null && availableIds.has(route.modelProfileId) ? "ready" : "blocked";
  if (route.candidateProfileIds.length === 0) return "needs-candidates";
  return route.candidateProfileIds.some((id) => availableIds.has(id)) ? "ready" : "blocked";
}

export function normalizeRoleRoute(
  route: RoleRouteChoice,
  availableIds: ReadonlySet<string>,
): RoleRouteChoice {
  if (route.mode === "auto") return { ...route, modelProfileId: null, candidateProfileIds: [] };
  if (route.mode === "explicit") {
    return { ...route, candidateProfileIds: [], modelProfileId: route.modelProfileId !== null && availableIds.has(route.modelProfileId) ? route.modelProfileId : null };
  }
  const candidates = route.candidateProfileIds.filter((id) => availableIds.has(id));
  return { ...route, modelProfileId: null, candidateProfileIds: [...new Set(candidates)] };
}

export function serializeRoleRoutingPreview(
  state: RoleRoutingState,
  profiles: readonly ModelProfileView[],
): string {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const roles = Object.fromEntries(ROLE_ROUTING_ROLES.map(({ id, label }) => {
    const route = state[id];
    return [id, {
      label,
      mode: route.mode,
      modelProfileId: route.modelProfileId,
      candidateProfileIds: [...route.candidateProfileIds],
      candidateLabels: route.candidateProfileIds.map((candidateId) => byId.get(candidateId)?.displayName ?? `Unavailable route: ${candidateId}`),
      effort: route.effort,
    }];
  }));
  return JSON.stringify({
    schema: "omnia.role-routing-preview.v1",
    scope: "renderer-session",
    executionDisposition: "preview-only",
    precedence: [...ROLE_ROUTING_PRECEDENCE],
    roleOverrides: roles,
    boundary: [
      "Renderer-session preview only",
      "No native role policy was written",
      "No agent instance or provider route was dispatched",
      "No approval, secret, or durable receipt was created",
    ],
  }, null, 2);
}
