import {
  createRendererDeepLinkPreview,
  parseRendererDeepLinkPreview,
  resolveRendererDeepLinkPreview,
  type RendererDeepLinkAncestor,
  type RendererDeepLinkParseReason,
  type RendererDeepLinkParseStatus,
  type RendererDeepLinkResolutionReason,
  type RendererDeepLinkTarget,
} from "./conversation-navigation-model";
import type { ConversationView, ProjectView } from "./types";

/**
 * A Project-context Chat URI is still a renderer preview until a native route
 * broker and durable target hydration exist. Keeping this adapter next to the
 * Project navigation projection gives callers one typed place to surface
 * missing/stale context instead of silently opening an unrelated Chat.
 */
export type ProjectChatDeepLinkFeedbackStatus = "resolved" | "stale" | "missing" | "unsupported";

export type ProjectChatDeepLinkFeedbackReason =
  | RendererDeepLinkParseReason
  | RendererDeepLinkResolutionReason
  | "not-project-context";

export interface ProjectChatDeepLinkFeedback {
  readonly status: ProjectChatDeepLinkFeedbackStatus;
  readonly uri: string;
  readonly parseStatus: RendererDeepLinkParseStatus;
  readonly projectId: string | null;
  readonly conversationId: string | null;
  readonly target?: RendererDeepLinkTarget;
  readonly reason?: ProjectChatDeepLinkFeedbackReason;
  readonly nearestAncestor: RendererDeepLinkAncestor;
  readonly label: string;
}

/** Creates the canonical contextual URI for the same Chat identity. */
export function createProjectChatDeepLinkPreview(projectId: string, conversationId: string): string {
  return createRendererDeepLinkPreview({
    projectId,
    conversationId,
    targetKind: "chat",
  });
}

/**
 * Resolves a Project-context Chat URI against one renderer snapshot.
 *
 * This intentionally does not navigate or mutate state. `stale` and `missing`
 * return a nearest safe ancestor so a future host/router can preserve the
 * user’s context without guessing a replacement Chat.
 */
export function resolveProjectChatDeepLinkPreview(
  uri: string,
  projects: readonly Pick<ProjectView, "id">[],
  conversations: readonly Pick<ConversationView, "id" | "projectId" | "archived" | "activeBranchId">[],
): ProjectChatDeepLinkFeedback {
  const parsed = parseRendererDeepLinkPreview(uri);
  const parseStatus = parsed.status;
  const target = parsed.target;
  const base = {
    uri,
    parseStatus,
    projectId: target?.projectId ?? null,
    conversationId: target?.conversationId ?? null,
    ...(target ? { target } : {}),
  };

  if (parsed.status !== "valid" || !target) {
    return {
      ...base,
      status: "unsupported",
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      nearestAncestor: "chats",
      label: parsed.status === "malformed"
        ? "Project Chat deep link is malformed in this preview"
        : "Project Chat deep-link format is unsupported in this preview",
    };
  }

  if (target.scope !== "project-chat" || !target.projectId) {
    return {
      ...base,
      status: "unsupported",
      reason: "not-project-context",
      nearestAncestor: "chats",
      label: "This URI is not a Project-context Chat deep link",
    };
  }

  if (!projects.some((project) => project.id === target.projectId)) {
    return {
      ...base,
      status: "missing",
      reason: "project-missing",
      nearestAncestor: "chat",
      label: `Project ${target.projectId} is missing from this preview`,
    };
  }

  const conversation = conversations.find((candidate) => candidate.id === target.conversationId);
  if (!conversation) {
    return {
      ...base,
      status: "missing",
      reason: "conversation-missing",
      nearestAncestor: "project",
      label: `Chat ${target.conversationId} is missing from this Project preview`,
    };
  }

  const resolution = resolveRendererDeepLinkPreview(target, {
    conversationId: conversation.id,
    projectId: conversation.projectId,
    archived: conversation.archived,
    branchId: conversation.activeBranchId,
  });
  return {
    ...base,
    status: resolution.status,
    ...(resolution.reason ? { reason: resolution.reason } : {}),
    nearestAncestor: resolution.nearestAncestor,
    label: resolution.label,
  };
}

/**
 * The two canonical object scopes exposed by the workspace navigator.
 * `standalone` is the Inbox/Recent bucket for chats whose projectId is null.
 */
export type ChatNavigationScope = "standalone" | "project" | "pinned" | "archived";

export type ChatNavigationAction =
  | "rename"
  | "pin"
  | "mark-unread"
  | "move-to-project"
  | "continue-in-new-chat"
  | "copy-deep-link"
  | "open-in-new-window"
  | "archive"
  | "restore"
  | "export"
  | "continue-in-new-worktree"
  | "compare-models"
  | "delete-permanently";

export type NavigationActionState = "enabled" | "planned" | "unavailable";

export interface NavigationActionAvailability {
  readonly state: NavigationActionState;
  readonly reason?: string;
}

export interface ProjectChatNavigationOptions {
  /** Search is local and bounded to the selected renderer-visible fields. */
  readonly query?: string;
  /**
   * Selects which renderer-visible Chat fields participate in the query.
   * Native full-text indexing, provider metadata hydration, and durable
   * search receipts remain outside this preview contract.
   */
  readonly searchScope?: ChatSearchScope;
  /** Include archived chats in the projection. Defaults to true for archive scope. */
  readonly includeArchived?: boolean;
  /** Project IDs whose nested chat lists are open in the sidebar. */
  readonly expandedProjectIds?: ReadonlySet<string>;
  /** Currently selected Project, used only to mark its navigator row active. */
  readonly activeProjectId?: string | null;
}

/** Renderer-local fields available to the Chat sidebar search rehearsal. */
export type ChatSearchScope = "all" | "chat" | "messages" | "drafts" | "models";

export const CHAT_SEARCH_SCOPES: readonly ChatSearchScope[] = [
  "all",
  "chat",
  "messages",
  "drafts",
  "models",
];

export function chatSearchScopeLabel(scope: ChatSearchScope): string {
  switch (scope) {
    case "chat":
      return "Chat details";
    case "messages":
      return "Messages";
    case "drafts":
      return "Drafts";
    case "models":
      return "Models";
    case "all":
    default:
      return "All fields";
  }
}

export interface ProjectChatGroup {
  readonly project: ProjectView;
  readonly chats: readonly ConversationView[];
  readonly expanded: boolean;
  readonly active: boolean;
}

export interface ProjectChatNavigationProjection {
  /** Non-archived chats with no project owner. */
  readonly standaloneChats: readonly ConversationView[];
  /** Non-archived chats grouped by their canonical project owner. */
  readonly projectGroups: readonly ProjectChatGroup[];
  /** Chats that refer to a missing project; they remain visible and recoverable. */
  readonly orphanedChats: readonly ConversationView[];
  /** Non-archived pinned chats, regardless of whether they are standalone/project-owned. */
  readonly pinnedChats: readonly ConversationView[];
  /** Archived chats, kept separate from active Inbox/Recent rows. */
  readonly archivedChats: readonly ConversationView[];
  readonly counts: {
    readonly total: number;
    readonly active: number;
    readonly standalone: number;
    readonly projectOwned: number;
    readonly pinned: number;
    readonly archived: number;
    readonly orphaned: number;
  };
}

const ACTIONS: readonly ChatNavigationAction[] = [
  "rename",
  "pin",
  "mark-unread",
  "move-to-project",
  "continue-in-new-chat",
  "copy-deep-link",
  "open-in-new-window",
  "archive",
  "restore",
  "export",
  "continue-in-new-worktree",
  "compare-models",
  "delete-permanently",
];

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function updatedAtMs(conversation: ConversationView): number {
  const value = Date.parse(conversation.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function sortChats(left: ConversationView, right: ConversationView): number {
  return updatedAtMs(right) - updatedAtMs(left) || left.id.localeCompare(right.id);
}

function matchesQuery(
  conversation: ConversationView,
  projectsById: ReadonlyMap<string, ProjectView>,
  query: string,
  searchScope: ChatSearchScope,
): boolean {
  if (!query) return true;
  const projectName = conversation.projectName ?? projectsById.get(conversation.projectId ?? "")?.name ?? "";
  const chatFields = `${conversation.title} ${conversation.excerpt} ${projectName}`;
  const messageFields = conversation.messages
    .map((message) => `${message.role} ${message.content}`)
    .join(" ");
  const draftFields = conversation.draft;
  const modelFields = conversation.messages
    .map((message) => message.modelLabel ?? "")
    .join(" ");
  const searchable = searchScope === "chat"
    ? chatFields
    : searchScope === "messages"
      ? messageFields
      : searchScope === "drafts"
        ? draftFields
        : searchScope === "models"
          ? modelFields
          : `${chatFields} ${messageFields} ${draftFields} ${modelFields}`;
  return normalize(searchable).includes(query);
}

function dedupeChats(chats: readonly ConversationView[]): ConversationView[] {
  const byId = new Map<string, ConversationView>();
  for (const chat of chats) {
    // Keep the first row for a stable projection. Duplicate IDs indicate an
    // upstream hydration issue, not permission to render the same Chat twice.
    if (!byId.has(chat.id)) byId.set(chat.id, chat);
  }
  return [...byId.values()].sort(sortChats);
}

/**
 * Builds the renderer navigation tree without mutating either input array.
 * A Chat is assigned to one canonical owner only. Unknown project IDs are
 * surfaced in `orphanedChats` instead of silently disappearing.
 */
export function buildProjectChatNavigation(
  projects: readonly ProjectView[],
  conversations: readonly ConversationView[],
  options: ProjectChatNavigationOptions = {},
): ProjectChatNavigationProjection {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const query = normalize(options.query);
  const searchScope = options.searchScope ?? "all";
  const visible = dedupeChats(conversations).filter((conversation) =>
    matchesQuery(conversation, projectsById, query, searchScope),
  );
  const active = visible.filter((conversation) => !conversation.archived);
  const archived = visible.filter((conversation) => conversation.archived);
  const activeByProject = new Map<string, ConversationView[]>();
  const standalone: ConversationView[] = [];
  const orphaned: ConversationView[] = [];

  for (const conversation of active) {
    if (conversation.projectId === null) {
      standalone.push(conversation);
      continue;
    }
    if (!projectsById.has(conversation.projectId)) {
      orphaned.push(conversation);
      continue;
    }
    const current = activeByProject.get(conversation.projectId) ?? [];
    current.push(conversation);
    activeByProject.set(conversation.projectId, current);
  }

  const projectGroups = projects.map((project) => {
    const chats = (activeByProject.get(project.id) ?? []).sort(sortChats);
    return {
      project,
      chats,
      expanded: options.expandedProjectIds?.has(project.id) ?? true,
      active: options.activeProjectId === project.id,
    } satisfies ProjectChatGroup;
  });
  const pinnedChats = active.filter((conversation) => conversation.pinned).sort(sortChats);

  return {
    standaloneChats: standalone.sort(sortChats),
    projectGroups,
    orphanedChats: orphaned.sort(sortChats),
    pinnedChats,
    archivedChats: options.includeArchived === false ? [] : archived.sort(sortChats),
    counts: {
      total: visible.length,
      active: active.length,
      standalone: standalone.length,
      projectOwned: active.filter((conversation) => conversation.projectId !== null).length,
      pinned: pinnedChats.length,
      archived: archived.length,
      orphaned: orphaned.length,
    },
  };
}

/** Returns the canonical location a Chat should display in the navigator. */
export function navigationScopeForChat(
  conversation: Pick<ConversationView, "archived" | "projectId">,
): ChatNavigationScope {
  if (conversation.archived) return "archived";
  return conversation.projectId === null ? "standalone" : "project";
}

/** Finds the owner group without treating a linked/reference row as ownership. */
export function projectGroupForChat(
  projection: ProjectChatNavigationProjection,
  conversationId: string,
): ProjectChatGroup | null {
  return (
    projection.projectGroups.find((group) =>
      group.chats.some((conversation) => conversation.id === conversationId),
    ) ?? null
  );
}

/**
 * Returns a complete action matrix for a Chat row. The matrix is intentionally
 * renderer-safe: planned actions are labelled, while actions that cannot be
 * performed for this record are unavailable with a reason.
 */
export function chatActionAvailability(
  conversation: Pick<ConversationView, "archived" | "projectId" | "runState">,
  options: { readonly hasFilesystemWorkspace?: boolean; readonly nativeHost?: boolean } = {},
): Readonly<Record<ChatNavigationAction, NavigationActionAvailability>> {
  const nativeHost = options.nativeHost ?? false;
  const hasWorkspace = options.hasFilesystemWorkspace ?? false;
  const availability: Record<ChatNavigationAction, NavigationActionAvailability> = {
    rename: { state: "enabled" },
    pin: { state: "enabled" },
    "mark-unread": { state: "enabled" },
    "move-to-project": { state: "enabled" },
    "continue-in-new-chat": { state: "enabled" },
    "copy-deep-link": { state: "enabled" },
    "open-in-new-window": nativeHost
      ? { state: "enabled" }
      : { state: "planned", reason: "A native window host is required." },
    archive: conversation.archived
      ? { state: "unavailable", reason: "The Chat is already archived." }
      : { state: "enabled" },
    restore: conversation.archived
      ? { state: "enabled" }
      : { state: "unavailable", reason: "Only archived Chats can be restored." },
    export: {
      state: "enabled",
      reason: "A renderer-local export preview is available; native export and durable receipts remain planned.",
    },
    "continue-in-new-worktree": hasWorkspace && nativeHost
      ? { state: "planned", reason: "Git/worktree runtime is not wired in this preview." }
      : { state: "unavailable", reason: "A filesystem Project and native Git runtime are required." },
    "compare-models": { state: "planned", reason: "Compare runs are not wired in this preview." },
    "delete-permanently": { state: "planned", reason: "Permanent deletion requires native tombstone/receipt support." },
  };

  // A running Chat can still be moved or renamed, but a destructive archival
  // action should be explicit in the UI so the active run is not mistaken for
  // completed history.
  if (conversation.runState === "streaming") {
    availability.archive = {
      state: "unavailable",
      reason: "Stop or finish the active run before archiving this Chat.",
    };
  }

  return availability;
}

export function chatNavigationActions(): readonly ChatNavigationAction[] {
  return ACTIONS;
}
