import { assertDomain } from "./errors";
import type { RunId, SkillId, SkillVersionId } from "./ids";
import type { KernelCapability } from "./kernel-capability";
import { assertNonBlank, assertSha256, type IsoTimestamp, type JsonObject } from "./shared";

export type SkillActivationMode = "manual" | "assistant-bound" | "project-bound" | "model-selected";
export type SkillVersionState = "draft" | "published" | "retired";
export type SkillSourceType = "built-in" | "local" | "import" | "generated-from-run" | "marketplace";

export type ChatCapability =
  | "pure_compute"
  | "read_app_data"
  | "read_workspace"
  | "read_network"
  | "write_workspace"
  | "execute_process"
  | "external_side_effect"
  | "browser_control"
  | "computer_control";

/** Canonical aliases retained while old skill manifests migrate to kernel names. */
export const KERNEL_CAPABILITY_ALIASES = Object.freeze({
  read_network: "use_network",
  browser_control: "control_browser",
  computer_control: "control_computer",
} as const satisfies Readonly<
  Record<"read_network" | "browser_control" | "computer_control", KernelCapability>
>);

export const CHAT_PHASE_CAPABILITIES: ReadonlySet<ChatCapability> = new Set([
  "pure_compute",
  "read_app_data",
  "read_workspace",
  "read_network",
]);

export interface SkillManifest {
  readonly schemaVersion: 1;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly activationGuidance: string;
  readonly activationModes: readonly SkillActivationMode[];
  readonly requestedCapabilities: readonly ChatCapability[];
  readonly entrypoint: "SKILL.md";
  readonly resourcePaths: readonly string[];
  readonly tags: readonly string[];
  readonly negativeExamples: readonly string[];
  readonly parameters: JsonObject;
}

export interface SkillVersion {
  readonly id: SkillVersionId;
  readonly skillId: SkillId;
  readonly version: string;
  readonly state: SkillVersionState;
  readonly contentHash: string;
  readonly manifest: SkillManifest;
  readonly sourceType: SkillSourceType;
  readonly sourceUri?: string;
  readonly author?: string;
  readonly signature?: JsonObject;
  readonly sourceRunId?: RunId;
  readonly tokenFootprint: number;
  readonly createdAt: IsoTimestamp;
  readonly publishedAt?: IsoTimestamp;
}

export interface Skill {
  readonly id: SkillId;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly versions: readonly SkillVersion[];
  readonly activeVersionId?: SkillVersionId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly deletedAt?: IsoTimestamp;
}

export type SkillValidationCode =
  | "invalid-slug"
  | "missing-entrypoint"
  | "path-escape"
  | "duplicate-resource"
  | "unsafe-capability"
  | "token-footprint"
  | "missing-activation-guidance"
  | "missing-negative-example"
  | "secret-like-content";

export interface SkillValidationIssue {
  readonly code: SkillValidationCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly path?: string;
}

export interface ValidateSkillInput {
  readonly manifest: SkillManifest;
  readonly availablePaths: readonly string[];
  readonly tokenFootprint: number;
  readonly maximumTokenFootprint: number;
  readonly secretLikePaths?: readonly string[];
}

function normalizePackagePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathEscapesPackage(path: string): boolean {
  const normalized = normalizePackagePath(path);
  return (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  );
}

export function validateSkillPackage(input: ValidateSkillInput): readonly SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  if (!Number.isSafeInteger(input.tokenFootprint) || input.tokenFootprint < 0) {
    issues.push({
      code: "token-footprint",
      severity: "error",
      message: "Skill token footprint must be a non-negative integer.",
    });
  }
  if (!Number.isSafeInteger(input.maximumTokenFootprint) || input.maximumTokenFootprint < 0) {
    issues.push({
      code: "token-footprint",
      severity: "error",
      message: "Maximum skill token footprint must be a non-negative integer.",
    });
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.manifest.slug)) {
    issues.push({ code: "invalid-slug", severity: "error", message: "Skill slug must be kebab-case." });
  }
  const paths = input.availablePaths.map(normalizePackagePath);
  if (!paths.includes("SKILL.md") || input.manifest.entrypoint !== "SKILL.md") {
    issues.push({ code: "missing-entrypoint", severity: "error", message: "SKILL.md is required." });
  }
  const seen = new Set<string>();
  for (const path of input.manifest.resourcePaths) {
    const normalized = normalizePackagePath(path);
    if (pathEscapesPackage(path)) {
      issues.push({
        code: "path-escape",
        severity: "error",
        message: "Skill resources must remain inside the package.",
        path,
      });
    }
    if (seen.has(normalized)) {
      issues.push({
        code: "duplicate-resource",
        severity: "error",
        message: "Skill resource is listed more than once.",
        path,
      });
    }
    seen.add(normalized);
    if (!paths.includes(normalized)) {
      issues.push({
        code: "missing-entrypoint",
        severity: "error",
        message: "A referenced skill resource is missing.",
        path,
      });
    }
  }
  for (const capability of input.manifest.requestedCapabilities) {
    if (!CHAT_PHASE_CAPABILITIES.has(capability)) {
      issues.push({
        code: "unsafe-capability",
        severity: "error",
        message: `${capability} is unavailable during the chat-complete phase.`,
      });
    }
  }
  if (input.tokenFootprint > input.maximumTokenFootprint) {
    issues.push({
      code: "token-footprint",
      severity: "error",
      message: "Skill token footprint exceeds the configured maximum.",
    });
  }
  if (input.manifest.activationGuidance.trim().length === 0) {
    issues.push({
      code: "missing-activation-guidance",
      severity: "error",
      message: "Skill activation guidance is required.",
    });
  }
  if (input.manifest.negativeExamples.length === 0) {
    issues.push({
      code: "missing-negative-example",
      severity: "warning",
      message: "At least one negative activation example is recommended.",
    });
  }
  for (const path of input.secretLikePaths ?? []) {
    issues.push({
      code: "secret-like-content",
      severity: "error",
      message: "Secret-like content must be removed before publishing.",
      path,
    });
  }
  return Object.freeze(issues.map((issue) => Object.freeze(issue)));
}

export interface CreateSkillVersionInput {
  readonly id: SkillVersionId;
  readonly skillId: SkillId;
  readonly version: string;
  readonly state?: SkillVersionState;
  readonly contentHash: string;
  readonly manifest: SkillManifest;
  readonly sourceType: SkillSourceType;
  readonly sourceUri?: string;
  readonly author?: string;
  readonly signature?: JsonObject;
  readonly sourceRunId?: RunId;
  readonly tokenFootprint: number;
  readonly availablePaths: readonly string[];
  readonly maximumTokenFootprint: number;
  readonly secretLikePaths?: readonly string[];
  readonly now: IsoTimestamp;
}

export function createSkillVersion(input: CreateSkillVersionInput): SkillVersion {
  const issues = validateSkillPackage({
    manifest: input.manifest,
    availablePaths: input.availablePaths,
    tokenFootprint: input.tokenFootprint,
    maximumTokenFootprint: input.maximumTokenFootprint,
    ...(input.secretLikePaths === undefined ? {} : { secretLikePaths: input.secretLikePaths }),
  });
  assertDomain(
    !issues.some((issue) => issue.severity === "error"),
    "invalid_argument",
    "Skill package failed validation.",
    { issueCodes: issues.filter((issue) => issue.severity === "error").map((issue) => issue.code) },
  );
  const state = input.state ?? "draft";
  return Object.freeze({
    id: input.id,
    skillId: input.skillId,
    version: assertNonBlank(input.version, "skill version", 64),
    state,
    contentHash: assertSha256(input.contentHash, "skill content hash"),
    manifest: Object.freeze({
      ...input.manifest,
      slug: assertNonBlank(input.manifest.slug, "skill slug", 120),
      displayName: assertNonBlank(input.manifest.displayName, "skill display name", 120),
      description: assertNonBlank(input.manifest.description, "skill description", 2_000),
      activationModes: Object.freeze([...input.manifest.activationModes]),
      requestedCapabilities: Object.freeze([...input.manifest.requestedCapabilities]),
      resourcePaths: Object.freeze([...input.manifest.resourcePaths]),
      tags: Object.freeze([...input.manifest.tags]),
      negativeExamples: Object.freeze([...input.manifest.negativeExamples]),
      parameters: Object.freeze({ ...input.manifest.parameters }),
    }),
    sourceType: input.sourceType,
    ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
    ...(input.author === undefined ? {} : { author: input.author }),
    ...(input.signature === undefined ? {} : { signature: Object.freeze({ ...input.signature }) }),
    ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
    tokenFootprint: input.tokenFootprint,
    createdAt: input.now,
    ...(state === "published" ? { publishedAt: input.now } : {}),
  });
}

export function createSkill(version: SkillVersion, now: IsoTimestamp): Skill {
  return Object.freeze({
    id: version.skillId,
    slug: version.manifest.slug,
    displayName: version.manifest.displayName,
    description: version.manifest.description,
    enabled: false,
    versions: Object.freeze([version]),
    ...(version.state === "published" ? { activeVersionId: version.id } : {}),
    createdAt: now,
    updatedAt: now,
  });
}

export function addSkillVersion(skill: Skill, version: SkillVersion, now: IsoTimestamp): Skill {
  assertDomain(skill.deletedAt === undefined, "invalid_state_transition", "Deleted skill cannot be revised.");
  assertDomain(skill.id === version.skillId, "scope_violation", "Version belongs to another skill.");
  assertDomain(
    !skill.versions.some((candidate) => candidate.id === version.id || candidate.version === version.version),
    "conflict",
    "Skill version already exists.",
  );
  return Object.freeze({
    ...skill,
    versions: Object.freeze([...skill.versions, version]),
    updatedAt: now,
  });
}

export function enableSkillVersion(skill: Skill, versionId: SkillVersionId, now: IsoTimestamp): Skill {
  assertDomain(skill.deletedAt === undefined, "invalid_state_transition", "Deleted skill cannot be enabled.");
  const version = skill.versions.find((candidate) => candidate.id === versionId);
  assertDomain(version !== undefined, "not_found", "Skill version was not found.");
  assertDomain(version.state === "published", "invalid_state_transition", "Only published skill versions can be enabled.");
  return Object.freeze({ ...skill, enabled: true, activeVersionId: version.id, updatedAt: now });
}

export interface SkillSelectionCandidate {
  readonly version: SkillVersion;
  readonly reason: "explicit" | "assistant-binding" | "project-binding" | "routing-rule" | "model-selection";
  readonly confidence: number;
}

export function selectSkillVersions(
  candidates: readonly SkillSelectionCandidate[],
  modelConfidenceThreshold: number,
  tokenBudget: number,
): readonly SkillSelectionCandidate[] {
  assertDomain(
    Number.isSafeInteger(tokenBudget) && tokenBudget >= 0,
    "invalid_argument",
    "Skill token budget must be a non-negative integer.",
  );
  assertDomain(
    Number.isFinite(modelConfidenceThreshold) &&
      modelConfidenceThreshold >= 0 &&
      modelConfidenceThreshold <= 1,
    "invalid_argument",
    "Model-selection confidence threshold must be between zero and one.",
  );
  const selected: SkillSelectionCandidate[] = [];
  const seen = new Set<SkillVersionId>();
  let consumed = 0;
  for (const candidate of candidates) {
    assertDomain(
      Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1,
      "invalid_argument",
      "Skill selection confidence must be between zero and one.",
      { skillVersionId: candidate.version.id, confidence: candidate.confidence },
    );
    assertDomain(
      Number.isSafeInteger(candidate.version.tokenFootprint) && candidate.version.tokenFootprint >= 0,
      "invalid_argument",
      "Skill token footprint must be a non-negative integer.",
      { skillVersionId: candidate.version.id },
    );
    if (
      candidate.reason === "model-selection" &&
      candidate.confidence < modelConfidenceThreshold
    ) {
      continue;
    }
    if (seen.has(candidate.version.id)) continue;
    if (candidate.version.state !== "published") continue;
    if (consumed + candidate.version.tokenFootprint > tokenBudget) continue;
    selected.push(candidate);
    seen.add(candidate.version.id);
    consumed += candidate.version.tokenFootprint;
  }
  return Object.freeze(selected);
}
