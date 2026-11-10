import type { SkillView } from "./types";

export type SkillPackageCheck = {
  readonly id: "schema" | "identity" | "version" | "metadata" | "content" | "capabilities";
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
};

export type SkillPackageVersionChange = "new" | "same" | "patch" | "minor" | "major" | "downgrade";

export interface ReviewedSkillPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly summary: string;
  readonly declaredScope: SkillView["scope"];
  readonly declaredTrust: SkillView["trust"];
  readonly icon: string;
  readonly instructions: string;
  readonly permissions: readonly string[];
  readonly resources: readonly string[];
  readonly tags: readonly string[];
}

export interface SkillPackageReview {
  readonly checks: readonly SkillPackageCheck[];
  readonly package: ReviewedSkillPackage | null;
  readonly existing: SkillView | null;
  readonly versionChange: SkillPackageVersionChange | null;
  readonly addedPermissions: readonly string[];
  readonly removedPermissions: readonly string[];
  readonly summaryChanged: boolean;
  readonly scopeChanged: boolean;
  readonly bodyComparison: "unavailable";
  readonly canStage: boolean;
  readonly error?: string;
}

const skillIdPattern = /^[a-z0-9][a-z0-9-]{2,63}$/;
const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every(
    (item) => typeof item === "string" && item.trim().length > 0 && item.trim().length <= maxLength,
  );
}

function isScope(value: unknown): value is SkillView["scope"] {
  return value === "Global" || value === "Project" || value === "Manual";
}

function isTrust(value: unknown): value is SkillView["trust"] {
  return value === "Verified" || value === "Reviewed" || value === "Unreviewed";
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function classifySkillPackageVersion(
  incomingVersion: string,
  installedVersion: string | null,
): SkillPackageVersionChange | null {
  if (installedVersion === null) return "new";
  const incoming = parseVersion(incomingVersion);
  const installed = parseVersion(installedVersion);
  if (!incoming || !installed) return null;
  if (incomingVersion === installedVersion) return "same";
  for (let index = 0; index < 3; index += 1) {
    const incomingPart = incoming[index];
    const installedPart = installed[index];
    if (incomingPart === undefined || installedPart === undefined) return null;
    if (incomingPart !== installedPart) {
      if (incomingPart < installedPart) return "downgrade";
      return index === 0 ? "major" : index === 1 ? "minor" : "patch";
    }
  }
  return "same";
}

export function inspectSkillPackagePayload(
  payload: string,
  installedSkills: readonly SkillView[],
): SkillPackageReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return {
      checks: [{ id: "schema", label: "Package format", passed: false, detail: "Input is not valid JSON." }],
      package: null,
      existing: null,
      versionChange: null,
      addedPermissions: [],
      removedPermissions: [],
      summaryChanged: false,
      scopeChanged: false,
      bodyComparison: "unavailable",
      canStage: false,
      error: "Could not parse package JSON.",
    };
  }

  const root = isRecord(parsed) ? parsed : null;
  const draft = root && isRecord(root.draft) ? root.draft : null;
  const schemaOkay = root?.schema === "omnia.skill-authoring-preview.v1" && root.scope === "renderer-session" && draft !== null;
  if (!draft) {
    return {
      checks: [{
        id: "schema",
        label: "Package format",
        passed: false,
        detail: "Expected an Omnia skill authoring preview with a draft object.",
      }],
      package: null,
      existing: null,
      versionChange: null,
      addedPermissions: [],
      removedPermissions: [],
      summaryChanged: false,
      scopeChanged: false,
      bodyComparison: "unavailable",
      canStage: false,
      error: "Unsupported package shape.",
    };
  }

  const identityOkay = typeof draft.id === "string" && skillIdPattern.test(draft.id.trim()) &&
    typeof draft.name === "string" && draft.name.trim().length >= 3 && draft.name.trim().length <= 120;
  const versionOkay = typeof draft.version === "string" && semanticVersionPattern.test(draft.version.trim());
  const metadataOkay = isScope(draft.scope) && isTrust(draft.trust) &&
    typeof draft.summary === "string" && draft.summary.trim().length >= 8 && draft.summary.trim().length <= 800;
  const contentOkay = typeof draft.instructions === "string" && draft.instructions.trim().length >= 48 && draft.instructions.length <= 40000;
  const capabilitiesOkay = isStringList(draft.permissions, 64, 160) &&
    isStringList(draft.resources, 64, 240) && isStringList(draft.tags, 64, 80);
  const checks: SkillPackageCheck[] = [
    {
      id: "schema",
      label: "Package format",
      passed: schemaOkay,
      detail: schemaOkay ? "Recognized Omnia skill preview package." : "Schema or renderer-session marker is not recognized.",
    },
    {
      id: "identity",
      label: "Identity",
      passed: identityOkay,
      detail: identityOkay ? `${String(draft.id).trim()} · ${String(draft.name).trim()}` : "Use a valid skill ID and a name between 3 and 120 characters.",
    },
    {
      id: "version",
      label: "Semantic version",
      passed: versionOkay,
      detail: versionOkay ? `Incoming v${String(draft.version).trim()}.` : "Version must use MAJOR.MINOR.PATCH format.",
    },
    {
      id: "metadata",
      label: "Scope and metadata",
      passed: metadataOkay,
      detail: metadataOkay ? "Declared scope and trust labels are present; imported trust will still require review." : "Scope, trust label, or summary is missing or unsupported.",
    },
    {
      id: "content",
      label: "Instructions",
      passed: contentOkay,
      detail: contentOkay ? `${String(draft.instructions).length.toLocaleString()} characters · bounded preview size.` : "Instructions must contain 48–40,000 characters.",
    },
    {
      id: "capabilities",
      label: "Resources and capabilities",
      passed: capabilitiesOkay,
      detail: capabilitiesOkay ? `${(draft.permissions as string[]).length} requested capability labels · no authority is granted.` : "Permissions, resources, and tags must be bounded lists of non-empty strings.",
    },
  ];

  const packageValue: ReviewedSkillPackage | null = identityOkay && versionOkay && metadataOkay && contentOkay && capabilitiesOkay
    ? {
      id: (draft.id as string).trim(),
      name: (draft.name as string).trim(),
      version: (draft.version as string).trim(),
      summary: (draft.summary as string).trim(),
      declaredScope: draft.scope as SkillView["scope"],
      declaredTrust: draft.trust as SkillView["trust"],
      icon: typeof draft.icon === "string" ? draft.icon.slice(0, 8) : "✦",
      instructions: (draft.instructions as string).trim(),
      permissions: (draft.permissions as string[]).map((item) => item.trim()),
      resources: (draft.resources as string[]).map((item) => item.trim()),
      tags: (draft.tags as string[]).map((item) => item.trim()),
    }
    : null;

  const existing = packageValue ? installedSkills.find((skill) => skill.id === packageValue.id) ?? null : null;
  const versionChange = packageValue
    ? classifySkillPackageVersion(packageValue.version, existing?.version ?? null)
    : null;
  const incomingPermissions = new Set(packageValue?.permissions ?? []);
  const existingPermissions = new Set(existing?.permissions ?? []);
  const addedPermissions = packageValue ? [...incomingPermissions].filter((permission) => !existingPermissions.has(permission)).sort() : [];
  const removedPermissions = packageValue ? [...existingPermissions].filter((permission) => !incomingPermissions.has(permission)).sort() : [];
  const canStage = schemaOkay && checks.every((check) => check.passed) && packageValue !== null;

  return {
    checks,
    package: packageValue,
    existing,
    versionChange,
    addedPermissions,
    removedPermissions,
    summaryChanged: Boolean(packageValue && existing && packageValue.summary !== existing.description),
    scopeChanged: Boolean(packageValue && existing && packageValue.declaredScope !== existing.scope),
    bodyComparison: "unavailable",
    canStage,
  };
}
