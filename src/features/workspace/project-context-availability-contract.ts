import type { ProjectOverviewView, ProjectView, WorkspaceFolderView } from "./types";

/**
 * The renderer can display a Project's context projection before the native
 * compiler has produced a durable context revision.  Keep that distinction
 * in one contract so individual surfaces cannot accidentally turn the
 * historical `ready` health value into a claim that files were indexed or
 * provider input was frozen.
 */
export type ProjectContextHealth = ProjectView["contextHealth"];

export type ProjectContextSurfaceStatus =
  | "preview"
  | "planned"
  | "unavailable"
  | "verified";

export type ProjectContextCapability =
  | "inspect"
  | "select"
  | "read"
  | "compile"
  | "dispatch";

export type ProjectContextEvidenceState =
  | "none"
  | "renderer-projection"
  | "native-current"
  | "native-stale"
  | "native-failed";

export type ProjectContextAvailabilityTone =
  | "neutral"
  | "info"
  | "warning"
  | "danger"
  | "success";

export interface ProjectContextNativeEvidence {
  /** Native context revision; never supplied by a renderer-generated string. */
  readonly revisionId: string;
  /** Event watermark that produced the revision. */
  readonly sourceEventWatermark: number;
  readonly state: "current" | "stale" | "failed";
}

type ProjectContextOverviewEvidence = Pick<
  ProjectOverviewView,
  "contextRevisionId" | "sourceEventWatermark" | "status"
>;

export interface ProjectContextAvailabilityInput {
  readonly health: ProjectContextHealth;
  readonly folders?: readonly Pick<WorkspaceFolderView, "state" | "scope">[];
  /** Optional evidence hydrated by the native layer in a future runtime. */
  readonly nativeEvidence?: ProjectContextNativeEvidence | null;
}

export interface ProjectContextAvailability {
  readonly schema: "omnia.project-context-availability.v1";
  readonly health: ProjectContextHealth;
  readonly label: string;
  readonly shortLabel: string;
  readonly tone: ProjectContextAvailabilityTone;
  readonly surfaceStatus: ProjectContextSurfaceStatus;
  readonly reasonCode:
    | "no_native_revision"
    | "native_indexing_unverified"
    | "native_access_missing"
    | "preview_budget_exceeded"
    | "native_revision_current"
    | "native_revision_stale"
    | "native_revision_failed";
  readonly reason: string;
  readonly evidence: {
    readonly state: ProjectContextEvidenceState;
    readonly revisionId: string | null;
    readonly sourceEventWatermark: number | null;
  };
  readonly folders: {
    readonly total: number;
    readonly referenced: number;
    readonly unavailable: number;
    readonly indexingOrPartial: number;
  };
  readonly capabilities: Readonly<Record<ProjectContextCapability, ProjectContextSurfaceStatus>>;
  /** Context availability never grants provider authority. Kept explicit to prevent accidental dispatch from UI code. */
  readonly canDispatchProviderInput: boolean;
}

export const PROJECT_CONTEXT_AVAILABILITY_SCHEMA =
  "omnia.project-context-availability.v1" as const;

export const PROJECT_CONTEXT_HEALTH_LABELS: Readonly<
  Record<ProjectContextHealth, { readonly label: string; readonly shortLabel: string }>
> = {
  ready: { label: "Referenced · not indexed", shortLabel: "Referenced" },
  indexing: { label: "Indexing preview", shortLabel: "Indexing preview" },
  "not-compiled": { label: "Not compiled", shortLabel: "Not compiled" },
  "over-budget": { label: "Over budget preview", shortLabel: "Over budget" },
  "missing-access": { label: "Access needed", shortLabel: "Access needed" },
};

/**
 * Convert the durable Project Overview projection into explicit context
 * evidence.  A context revision alone is not enough: the overview must also
 * carry the source-event watermark and a status that describes whether the
 * revision is current, stale, or failed.  Candidate/unknown projections stay
 * renderer-only and therefore return no native evidence.
 */
export function nativeContextEvidenceFromOverview(
  overview: ProjectContextOverviewEvidence | null | undefined,
): ProjectContextNativeEvidence | null {
  if (
    !overview?.contextRevisionId?.trim()
    || typeof overview.sourceEventWatermark !== "number"
    || !Number.isSafeInteger(overview.sourceEventWatermark)
    || overview.sourceEventWatermark < 0
  ) {
    return null;
  }

  const state =
    overview.status === "current"
      ? "current"
      : overview.status === "stale" || overview.status === "superseded"
        ? "stale"
        : overview.status === "failed"
          ? "failed"
          : null;

  if (!state) return null;

  return {
    revisionId: overview.contextRevisionId,
    sourceEventWatermark: overview.sourceEventWatermark,
    state,
  };
}

/**
 * Build context availability for a full project projection while preserving
 * native overview evidence.  Keeping this adapter shared prevents individual
 * surfaces from silently downgrading a current native revision to a generic
 * renderer projection.
 */
export function buildProjectContextAvailabilityForProject(
  project: Pick<ProjectView, "contextHealth" | "folders"> & {
    readonly overview?: ProjectContextOverviewEvidence | null;
  },
): ProjectContextAvailability {
  return buildProjectContextAvailability({
    health: project.contextHealth,
    folders: project.folders,
    nativeEvidence: nativeContextEvidenceFromOverview(project.overview),
  });
}

const DEFAULT_CAPABILITIES: Readonly<
  Record<ProjectContextCapability, ProjectContextSurfaceStatus>
> = {
  inspect: "preview",
  select: "preview",
  read: "unavailable",
  compile: "planned",
  dispatch: "unavailable",
};

function isUnavailableFolder(state: WorkspaceFolderView["state"]): boolean {
  return state === "permission-lost" || state === "offline";
}

function isIndexingOrPartialFolder(state: WorkspaceFolderView["state"]): boolean {
  return state === "indexing" || state === "partial";
}

function folderSummary(
  folders: readonly Pick<WorkspaceFolderView, "state" | "scope">[],
) {
  return {
    total: folders.length,
    referenced: folders.filter((folder) => folder.state === "referenced" || folder.state === "ready").length,
    unavailable: folders.filter((folder) => isUnavailableFolder(folder.state)).length,
    indexingOrPartial: folders.filter((folder) => isIndexingOrPartialFolder(folder.state)).length,
  } as const;
}

function labelsForHealth(health: ProjectContextHealth) {
  return PROJECT_CONTEXT_HEALTH_LABELS[health];
}

function baseReason(health: ProjectContextHealth): {
  readonly surfaceStatus: ProjectContextSurfaceStatus;
  readonly tone: ProjectContextAvailabilityTone;
  readonly reasonCode: ProjectContextAvailability["reasonCode"];
  readonly reason: string;
} {
  switch (health) {
    case "ready":
      return {
        surfaceStatus: "preview",
        tone: "info",
        reasonCode: "no_native_revision",
        reason: "Workspace references are visible, but no native index or frozen context revision is hydrated.",
      };
    case "indexing":
      return {
        surfaceStatus: "preview",
        tone: "info",
        reasonCode: "native_indexing_unverified",
        reason: "Indexing is shown as a preview state; native scan progress and completion evidence are unavailable here.",
      };
    case "missing-access":
      return {
        surfaceStatus: "unavailable",
        tone: "danger",
        reasonCode: "native_access_missing",
        reason: "A workspace grant or native access receipt is missing, so no context read or compile may be attempted. Any prior native revision remains historical until access is restored.",
      };
    case "over-budget":
      return {
        surfaceStatus: "preview",
        tone: "warning",
        reasonCode: "preview_budget_exceeded",
        reason: "The renderer estimate exceeds its preview budget; native selection, compaction, and provider delivery are not available. Any prior native revision is not eligible for this budget.",
      };
    case "not-compiled":
    default:
      return {
        surfaceStatus: "planned",
        tone: "neutral",
        reasonCode: "no_native_revision",
        reason: "No native context compiler revision is available for this project.",
      };
  }
}

function availabilityFromNativeEvidence(
  evidence: ProjectContextNativeEvidence,
): Pick<
  ProjectContextAvailability,
  "surfaceStatus" | "tone" | "reasonCode" | "reason" | "evidence"
> {
  if (evidence.state === "current") {
    return {
      surfaceStatus: "verified",
      tone: "success",
      reasonCode: "native_revision_current",
      reason: "A native context revision and source watermark are available for inspection.",
      evidence: {
        state: "native-current",
        revisionId: evidence.revisionId,
        sourceEventWatermark: evidence.sourceEventWatermark,
      },
    };
  }
  if (evidence.state === "stale") {
    return {
      surfaceStatus: "preview",
      tone: "warning",
      reasonCode: "native_revision_stale",
      reason: "A native context revision exists but is stale; refresh or reconcile before provider delivery.",
      evidence: {
        state: "native-stale",
        revisionId: evidence.revisionId,
        sourceEventWatermark: evidence.sourceEventWatermark,
      },
    };
  }
  return {
    surfaceStatus: "unavailable",
    tone: "danger",
    reasonCode: "native_revision_failed",
    reason: "The native context revision failed; the previous revision remains evidence, not a current dispatch input.",
    evidence: {
      state: "native-failed",
      revisionId: evidence.revisionId,
      sourceEventWatermark: evidence.sourceEventWatermark,
    },
  };
}

function hasCurrentBlockingHealth(health: ProjectContextHealth): boolean {
  return health === "missing-access" || health === "over-budget";
}

/**
 * Derive the renderer-safe availability contract for a Project Context panel.
 *
 * The default path is intentionally conservative: `ready` is only a reference
 * health value in the current renderer and never authorizes a file read,
 * context compile, provider dispatch, or durable write. A future native
 * evidence object can opt into `verified` only when it carries an explicit
 * revision and source watermark.
 */
export function buildProjectContextAvailability(
  input: ProjectContextAvailabilityInput,
): ProjectContextAvailability {
  const folders = input.folders ?? [];
  const folderCounts = folderSummary(folders);
  const fallback = baseReason(input.health);
  const nativeEvidence = input.nativeEvidence ?? null;
  const evidence = nativeEvidence && !hasCurrentBlockingHealth(input.health)
    ? availabilityFromNativeEvidence(nativeEvidence)
    : nativeEvidence
      ? {
          ...fallback,
          // The revision is retained as historical evidence, but a current
          // access/budget denial makes it ineligible for read/compile claims.
          evidence: {
            state: "native-stale" as const,
            revisionId: nativeEvidence.revisionId,
            sourceEventWatermark: nativeEvidence.sourceEventWatermark,
          },
        }
    : {
        ...fallback,
        evidence: {
          state: "renderer-projection" as const,
          revisionId: null,
          sourceEventWatermark: null,
        },
      };
  const capabilities: Record<ProjectContextCapability, ProjectContextSurfaceStatus> = {
    ...DEFAULT_CAPABILITIES,
  };

  if (evidence.evidence.state === "native-current") {
    capabilities.read = "verified";
    capabilities.compile = "verified";
  } else if (input.health === "missing-access" || input.health === "over-budget") {
    capabilities.compile = "unavailable";
  }

  // A native revision is evidence for this context slice only. Provider
  // dispatch still requires the provider-attempt lineage, authority and
  // capability gates; this contract must never become a permission bypass.
  const canDispatchProviderInput = false;

  return Object.freeze({
    schema: PROJECT_CONTEXT_AVAILABILITY_SCHEMA,
    health: input.health,
    label: evidence.evidence.state === "native-current" ? "Compiled · native evidence" : labelsForHealth(input.health).label,
    shortLabel: evidence.evidence.state === "native-current" ? "Compiled" : labelsForHealth(input.health).shortLabel,
    tone: evidence.tone,
    surfaceStatus: evidence.surfaceStatus,
    reasonCode: evidence.reasonCode,
    reason: evidence.reason,
    evidence: evidence.evidence,
    folders: folderCounts,
    capabilities: Object.freeze(capabilities),
    canDispatchProviderInput,
  });
}

export function projectContextHealthLabel(health: ProjectContextHealth): string {
  return PROJECT_CONTEXT_HEALTH_LABELS[health].label;
}

export function projectContextHealthShortLabel(health: ProjectContextHealth): string {
  return PROJECT_CONTEXT_HEALTH_LABELS[health].shortLabel;
}
