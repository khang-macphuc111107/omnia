/**
 * Canonical Project Overview tab contract.
 *
 * The six tabs are a product-level information-architecture invariant. A
 * richer renderer deck may expose additional rehearsal tabs, but those tabs
 * must map back to this list instead of becoming a competing Project mode.
 *
 * Status is deliberately renderer-facing and evidence-bound. `Preview` means
 * a useful local projection exists, `Partial` means only part of the target
 * path is represented, `Planned` means the surface has no current projection,
 * and `Unavailable` means the required host callback/capability is absent.
 */

export const PROJECT_OVERVIEW_TAB_IDS = [
  "conversations",
  "context",
  "files",
  "memory",
  "skills",
  "settings",
] as const;

export type ProjectOverviewTabId = (typeof PROJECT_OVERVIEW_TAB_IDS)[number];

export type ProjectOverviewTabStatus = "Preview" | "Partial" | "Planned" | "Unavailable";

export type ProjectOverviewCoverage =
  | "renderer-session"
  | "renderer-plus-host-callback"
  | "not-exposed";

/** Renderer deck destination for the canonical tab. */
export type ProjectOverviewTargetTab = "chats" | "context" | "access" | "snapshot";

export type ProjectOverviewTabContract = {
  readonly id: ProjectOverviewTabId;
  readonly label: string;
  readonly targetLabel: string;
  readonly targetTab?: ProjectOverviewTargetTab;
  readonly status: ProjectOverviewTabStatus;
  readonly coverage: ProjectOverviewCoverage;
  readonly source: string;
  readonly description: string;
  readonly nativeGap: string;
};

export type ProjectOverviewTabContractOptions = {
  /** Whether the host supplied a callback for the Settings activity. */
  readonly settingsAvailable?: boolean;
};

const BASE_TAB_CONTRACTS: ReadonlyArray<Omit<ProjectOverviewTabContract, "status" | "coverage"> & {
  readonly status: Exclude<ProjectOverviewTabStatus, "Unavailable">;
  readonly coverage: Exclude<ProjectOverviewCoverage, "not-exposed">;
}> = [
  {
    id: "conversations",
    label: "Conversations",
    targetLabel: "Chats tab",
    targetTab: "chats",
    status: "Preview",
    coverage: "renderer-session",
    source: "Project-scoped chat renderer projection",
    description: "Project-scoped chat list, filters, saved views, and new-chat entry.",
    nativeGap: "Durable membership, search indexing, and conversation receipts are not hydrated here.",
  },
  {
    id: "context",
    label: "Context",
    targetLabel: "Context tab",
    targetTab: "context",
    status: "Partial",
    coverage: "renderer-session",
    source: "Project context availability contract",
    description: "Context manifest and preflight projections with explicit native gaps.",
    nativeGap: "Native compile, frozen context, retrieval, and provider dispatch remain unavailable.",
  },
  {
    id: "files",
    label: "Files",
    targetLabel: "Access preview",
    targetTab: "access",
    status: "Partial",
    coverage: "renderer-session",
    source: "Workspace grant renderer preview",
    description: "Workspace folder grants and file-scope rehearsal; indexing is not implied.",
    nativeGap: "Native folder picker, file reads, indexing, and durable grant receipts are not connected.",
  },
  {
    id: "memory",
    label: "Memory",
    targetLabel: "Snapshot candidates",
    targetTab: "snapshot",
    status: "Preview",
    coverage: "renderer-session",
    source: "Renderer-visible memory candidates",
    description: "Renderer-visible memory candidates only; no project retrieval is activated.",
    nativeGap: "No native memory read, approval, write, retrieval, or provenance receipt is performed.",
  },
  {
    id: "skills",
    label: "Skills",
    targetLabel: "Snapshot candidates",
    targetTab: "snapshot",
    status: "Preview",
    coverage: "renderer-session",
    source: "Renderer-visible skill candidates",
    description: "Renderer-visible skill candidates only; no install or provider injection occurs.",
    nativeGap: "No native registry sync, installation, permission grant, or provider injection is performed.",
  },
];

/**
 * Build the canonical six-tab mapping for the current host callbacks.
 *
 * The returned array is intentionally fresh so a caller can safely annotate
 * selected/focus state without mutating the shared contract.
 */
export function buildProjectOverviewTabContracts(
  options: ProjectOverviewTabContractOptions = {},
): ProjectOverviewTabContract[] {
  const settingsAvailable = options.settingsAvailable === true;
  return [
    ...BASE_TAB_CONTRACTS,
    {
      id: "settings",
      label: "Settings",
      targetLabel: "Settings activity",
      status: settingsAvailable ? "Preview" : "Unavailable",
      coverage: settingsAvailable ? "renderer-plus-host-callback" : "not-exposed",
      source: settingsAvailable ? "Host Settings activity callback" : "No host Settings callback",
      description: settingsAvailable
        ? "Host callback opens Settings; project persistence remains outside this preview."
        : "Project settings are not available in this surface.",
      nativeGap: settingsAvailable
        ? "The callback navigates to Settings but does not imply durable project-setting persistence."
        : "Connect a host Settings callback before exposing project settings from this surface.",
    },
  ];
}

export function getProjectOverviewTabContract(
  id: ProjectOverviewTabId,
  options: ProjectOverviewTabContractOptions = {},
): ProjectOverviewTabContract {
  const contract = buildProjectOverviewTabContracts(options).find((entry) => entry.id === id);
  if (!contract) {
    // The input type is closed, but keeping this guard makes the boundary
    // fail closed if a future caller crosses the type boundary at runtime.
    throw new Error(`Unknown Project Overview tab: ${id}`);
  }
  return contract;
}

