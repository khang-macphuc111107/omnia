import type { SkillView } from "./types";

export const skillActivationReviewChecks = [
  { id: "identity", label: "Confirm package source, version, and trust" },
  { id: "instructions", label: "Read the instruction preview" },
  { id: "permissions", label: "Inspect every requested permission" },
  { id: "scope", label: "Confirm the activation scope and token footprint" },
] as const;

export type SkillActivationReviewCheckId = (typeof skillActivationReviewChecks)[number]["id"];

/** A review applies only to the exact renderer-visible package revision inspected. */
export function skillActivationReviewKey(skill: SkillView): string {
  return JSON.stringify([
    skill.id,
    skill.version,
    skill.name,
    skill.description,
    skill.source,
    skill.trust,
    skill.scope,
    skill.tokenFootprint,
    [...skill.permissions].sort((left, right) => left.localeCompare(right)),
  ]);
}

export function isSkillActivationReviewComplete(
  checked: readonly SkillActivationReviewCheckId[],
): boolean {
  return skillActivationReviewChecks.every(({ id }) => checked.includes(id));
}
