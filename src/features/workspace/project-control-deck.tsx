import {
  Archive,
  BellRing,
  Bot,
  Boxes,
  Check,
  Code2,
  ChevronDown,
  ChevronRight,
  Clipboard,
  CircleAlert,
  Clock3,
  Download,
  FileJson2,
  FolderInput,
  FolderOpen,
  Gauge,
  Layers3,
  ListChecks,
  LockKeyhole,
  MessageSquareText,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Undo2,
  Upload,
  Users,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { providerStateLabel, selectableModelProfiles } from "./provider-catalog";
import { buildProjectContextAvailabilityForProject } from "./project-context-availability-contract";
import { ProjectActivityTimeline } from "./project-activity-timeline";
import { buildProjectOverviewTabContracts } from "./project-overview-tabs-contract";
import { ProjectContextWorkbench } from "./project-context-workbench";
import { ConversationActionsDialog } from "./conversation-actions-dialog";
import { ProjectPlanningPreview } from "./project-planning-preview";
import {
  createProjectChatDeepLinkPreview,
  chatActionAvailability,
  resolveProjectChatDeepLinkPreview,
} from "./project-chat-navigation";
import { ProjectDeckLazySurface } from "./project-deck-lazy-surface";
import { buildProjectPlanChatDraft, type ProjectHandoffSeed } from "./project-handoff-seed";
import { openWorkspaceOverlay } from "./overlay-store";
import { createPlanChatOperationPreview } from "./plan-chat-operation";
import { ProjectReadonlyLedger } from "./project-readonly-ledger";
import { NativeProjectGoals } from "./native-project-goals";
import {
  applyProjectPolicyHistoryPatch,
  makeDefaultProjectPolicyHistory,
  ProjectPolicySummary,
  type ProjectPolicyDraft,
  type ProjectPolicyHistory,
} from "./project-policy-summary";
import { ProjectRuntimePosture } from "./project-runtime-posture";
import { RoutingInheritancePreview } from "./routing-inheritance-preview";
import {
  removeProjectDeckLayout,
  upsertProjectDeckLayout,
  type ProjectDeckLayoutSnapshot,
  type SavedProjectDeckLayout,
} from "./project-deck-layout";
import { useWorkspaceStore } from "./store";
import type { ConversationView, MemoryView, ProjectView, SkillView } from "./types";

type ProjectDeckTab = "snapshot" | "signals" | "chats" | "plan" | "context" | "ide" | "model" | "access" | "twin" | "handoff";
type PlanWorkspace = "goals" | "roadmap";
type ChatFilter = "all" | "active" | "archived" | "pinned" | "unread";
type ChatSort = "recent" | "title" | "attention";
type ChatGrouping = "flat" | "state";
type ModelPreset = "Precise" | "Balanced" | "Creative" | "Research";
type ProjectExportFormat = "json" | "markdown";
type AdvancedModelSurfaceId = "role-routing" | "local-readiness" | "local-catalog" | "adaptive-learning" | "agent-dag";

const PROJECT_DECK_IMPORT_MAX_BYTES = 64 * 1024;
const PROJECT_DECK_MODEL_PRESETS: readonly ModelPreset[] = ["Precise", "Balanced", "Creative", "Research"];
const ADVANCED_MODEL_SURFACES: ReadonlyArray<{ id: AdvancedModelSurfaceId; label: string; description: string }> = [
  { id: "role-routing", label: "Role routing", description: "Assign model, pool, and effort by role." },
  { id: "local-readiness", label: "Local readiness", description: "Review hardware and runtime readiness." },
  { id: "local-catalog", label: "Local catalog", description: "Browse local model candidates." },
  { id: "adaptive-learning", label: "Adaptive Auto", description: "Shape reviewed Auto-routing signals." },
  { id: "agent-dag", label: "Agent DAG", description: "Inspect orchestration gates and roles." },
];

type SavedChatView = {
  id: string;
  name: string;
  filter: ChatFilter;
  sort: ChatSort;
  grouping: ChatGrouping;
  query: string;
};

type ChatGroup = {
  key: string;
  label: string;
  chats: ConversationView[];
  totalCount?: number;
};

type ProjectChatMoveDestination = {
  readonly id: string;
  readonly projectId: string | null;
  readonly label: string;
  readonly description: string;
  readonly recent: boolean;
  readonly available: boolean;
  readonly unavailableReason?: string;
};

type ProjectDeckPreview = {
  pinned: boolean;
  accent: string;
  modelProfileId: string;
  modelPreset: ModelPreset;
  preferVision: boolean;
  preferReasoning: boolean;
  concise: boolean;
};

type ProjectDeckHistory = {
  past: ProjectDeckPreview[];
  present: ProjectDeckPreview;
  future: ProjectDeckPreview[];
};

const tabs: Array<{ id: ProjectDeckTab; label: string }> = [
  { id: "snapshot", label: "Snapshot" },
  { id: "signals", label: "Signals" },
  { id: "chats", label: "Chats" },
  { id: "context", label: "Context" },
  { id: "plan", label: "Plan" },
  { id: "ide", label: "IDE" },
  { id: "model", label: "Model" },
  { id: "access", label: "Access" },
  { id: "twin", label: "Twin" },
  { id: "handoff", label: "Handoff" },
];

const accentOptions = ["#4f8cff", "#19b7a5", "#e7a83c", "#ee6d8a", "#8d7cff", "#48b86b"];
const CHAT_DISCOVERY_PAGE_SIZE = 8;

const loadProjectContextWorkbench = async () => {
  return { default: ProjectContextWorkbench };
};

const loadProjectIdePreview = async () => {
  const { ProjectIdePreview } = await import("./project-ide-preview");
  return { default: ProjectIdePreview };
};

import { ProjectWorkspaceGrantPreview } from "./project-workspace-grant-preview";

const loadProjectTwinEdgeEvidencePreview = async () => {
  const { ProjectTwinEdgeEvidencePreview } = await import("./project-twin-edge-evidence-preview");
  return { default: ProjectTwinEdgeEvidencePreview };
};

const loadProjectHandoffWorkbench = async () => {
  const { ProjectHandoffWorkbench } = await import("./project-handoff-workbench");
  return { default: ProjectHandoffWorkbench };
};

const loadMissionControlSignalCenter = async () => {
  const { MissionControlSignalCenter } = await import("./mission-control-signal-center");
  return { default: MissionControlSignalCenter };
};

const loadProjectNextActionsPreview = async () => {
  const { ProjectNextActionsPreview } = await import("./project-next-actions-preview");
  return { default: ProjectNextActionsPreview };
};

import { CacheContextRoutingPreview } from "./cache-context-routing-preview";

const loadRoleRoutingPreview = async () => {
  const { RoleRoutingPreview } = await import("./role-routing-preview");
  return { default: RoleRoutingPreview };
};

const loadLocalModelReadinessPreview = async () => {
  const { LocalModelReadinessPreview } = await import("./local-model-readiness-preview");
  return { default: LocalModelReadinessPreview };
};

const loadLocalModelCatalogPreview = async () => {
  const { LocalModelCatalogPreview } = await import("./local-model-catalog-preview");
  return { default: LocalModelCatalogPreview };
};

const loadAdaptiveAutoRoutingLearningPreview = async () => {
  const { AdaptiveAutoRoutingLearningPreview } = await import("./adaptive-auto-routing-learning-preview");
  return { default: AdaptiveAutoRoutingLearningPreview };
};

const loadGoalTaskStudio = async () => {
  const { GoalTaskStudio } = await import("./goal-task-studio");
  return { default: GoalTaskStudio };
};

const loadAgentDagOrchestrationPreview = async () => {
  const { default: AgentDagOrchestrationPreview } = await import("./agent-dag-orchestration-preview");
  return { default: AgentDagOrchestrationPreview };
};
const chatFilters: ReadonlyArray<{ id: ChatFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
  { id: "pinned", label: "Pinned" },
  { id: "unread", label: "Unread" },
];

function makeProjectDeckPreview(project: ProjectView): ProjectDeckPreview {
  return {
    pinned: project.pinned,
    accent: project.accent,
    modelProfileId: project.modelProfileId || "auto",
    modelPreset: "Balanced",
    preferVision: true,
    preferReasoning: false,
    concise: false,
  };
}

function cloneProjectDeckPreview(value: ProjectDeckPreview): ProjectDeckPreview {
  return { ...value };
}

function sameProjectDeckPreview(left: ProjectDeckPreview, right: ProjectDeckPreview): boolean {
  return left.pinned === right.pinned
    && left.accent === right.accent
    && left.modelProfileId === right.modelProfileId
    && left.modelPreset === right.modelPreset
    && left.preferVision === right.preferVision
    && left.preferReasoning === right.preferReasoning
    && left.concise === right.concise;
}

function serializeProjectPreview(
  project: ProjectView,
  preview: ProjectDeckPreview,
  chatCount: number,
  memoryCount: number,
  skillCount: number,
  modelSource: string,
  modelState: string,
  format: ProjectExportFormat,
): string {
  const payload = {
    schema: "omnia.project-deck-preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      chatCount,
      folderCount: project.folders.length,
      rendererMemoryCandidates: memoryCount,
      rendererSkillCandidates: skillCount,
    },
    preview: {
      pinned: preview.pinned,
      accent: preview.accent,
      modelProfileId: preview.modelProfileId,
      modelPreset: preview.modelPreset,
      modelSource,
      modelState,
      preferences: {
        preferVision: preview.preferVision,
        preferReasoning: preview.preferReasoning,
        concise: preview.concise,
      },
    },
    boundary: "Renderer-local preview only; no native project mutation, provider request, or filesystem write was performed.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    `# ${project.name} project preview`,
    "",
    "> Renderer-local preview only; no native project mutation or provider request was performed.",
    "",
    `- Chats: ${chatCount}`,
    `- Folders: ${project.folders.length}`,
    `- Renderer memory candidates: ${memoryCount}`,
    `- Renderer skill candidates: ${skillCount}`,
    `- Pin preview: ${preview.pinned ? "on" : "off"}`,
    `- Accent: ${preview.accent}`,
    `- Model profile: ${preview.modelProfileId}`,
    `- Model source: ${modelSource}`,
    `- Model state: ${modelState}`,
    `- Model style: ${preview.modelPreset}`,
    `- Preferences: vision=${preview.preferVision ? "on" : "off"}, reasoning=${preview.preferReasoning ? "on" : "off"}, concise=${preview.concise ? "on" : "off"}`,
  ].join("\n");
}

function downloadProjectPreview(payload: string, format: ProjectExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-project-deck-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export type ProjectDeckPreviewImportResult =
  | { readonly ok: true; readonly preview: ProjectDeckPreview }
  | { readonly ok: false; readonly error: string };

/**
 * Parse only the portable renderer preview shape emitted by this deck.
 * Import never hydrates project metadata or native settings; it only returns
 * the explicitly bounded visual/model draft for the current session.
 */
export function parseProjectDeckPreviewImport(raw: string): ProjectDeckPreviewImportResult {
  if (!raw.trim()) return { ok: false, error: "Paste a Project Deck JSON preview before importing." };
  if (new Blob([raw]).size > PROJECT_DECK_IMPORT_MAX_BYTES) {
    return { ok: false, error: "Import rejected: Project Deck JSON is larger than 64 KB." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Import rejected: the Project Deck payload is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Import rejected: expected a JSON object." };
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.schema !== "omnia.project-deck-preview.v1" || payload.scope !== "renderer-session") {
    return { ok: false, error: "Import rejected: expected an Omnia renderer-session Project Deck preview." };
  }
  const candidate = payload.preview;
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, error: "Import rejected: the preview section is missing." };
  }
  const preview = candidate as Record<string, unknown>;
  const preferences = preview.preferences;
  if (!preferences || typeof preferences !== "object") {
    return { ok: false, error: "Import rejected: preview preferences are missing." };
  }
  const preferenceValues = preferences as Record<string, unknown>;
  const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
  if (
    typeof preview.pinned !== "boolean"
    || typeof preview.accent !== "string"
    || !/^#[0-9a-f]{6}$/i.test(preview.accent)
    || typeof preview.modelProfileId !== "string"
    || typeof preview.modelPreset !== "string"
    || !PROJECT_DECK_MODEL_PRESETS.includes(preview.modelPreset as ModelPreset)
    || !isBoolean(preferenceValues.preferVision)
    || !isBoolean(preferenceValues.preferReasoning)
    || !isBoolean(preferenceValues.concise)
  ) {
    return { ok: false, error: "Import rejected: preview fields are incomplete or invalid." };
  }
  return {
    ok: true,
    preview: {
      pinned: preview.pinned,
      accent: preview.accent,
      modelProfileId: preview.modelProfileId,
      modelPreset: preview.modelPreset as ModelPreset,
      preferVision: preferenceValues.preferVision,
      preferReasoning: preferenceValues.preferReasoning,
      concise: preferenceValues.concise,
    },
  };
}

function chatIsActive(chat: ConversationView): boolean {
  return Boolean(chat.hasDraft || chat.runState);
}

function matchesChatFilter(chat: ConversationView, filter: ChatFilter): boolean {
  if (filter === "active") return chatIsActive(chat);
  if (filter === "archived") return chat.archived;
  if (filter === "pinned") return chat.pinned;
  if (filter === "unread") return chat.unread;
  return true;
}

function chatAttentionScore(chat: ConversationView): number {
  if (chat.runState === "failed") return 5;
  if (chat.runState) return 4;
  if (chat.hasDraft) return 3;
  if (chat.unread) return 2;
  if (chat.pinned) return 1;
  return 0;
}

function compareRecentChats(left: ConversationView, right: ConversationView): number {
  const leftTimestamp = Date.parse(left.updatedAt);
  const rightTimestamp = Date.parse(right.updatedAt);
  const leftValue = Number.isNaN(leftTimestamp) ? 0 : leftTimestamp;
  const rightValue = Number.isNaN(rightTimestamp) ? 0 : rightTimestamp;
  return rightValue - leftValue || left.title.localeCompare(right.title);
}

function chatState(chat: ConversationView): { key: string; label: string } {
  if (chat.runState === "failed") return { key: "failed", label: "Needs attention" };
  if (chat.runState) return { key: "running", label: "In progress" };
  if (chat.hasDraft) return { key: "draft", label: "Drafts" };
  if (chat.archived) return { key: "archived", label: "Archived" };
  return { key: "ready", label: "Ready" };
}

function projectChatStatus(chat: ConversationView): string {
  if (chat.runState === "failed") return "Needs attention";
  if (chat.runState) return "Active";
  if (chat.hasDraft) return "Draft";
  if (chat.archived) return "Archived";
  return "Completed";
}

function projectChatActionsMenuId(conversationId: string): string {
  const encodedId = encodeURIComponent(conversationId);
  return `project-chat-actions-menu-${encodedId || "conversation"}`;
}

function projectChatDestinationLabel(
  projects: readonly Pick<ProjectView, "id" | "name">[],
  projectId: string | null,
): string {
  if (!projectId) return "Inbox / standalone";
  return projects.find((candidate) => candidate.id === projectId)?.name ?? "Unknown Project";
}

function ProjectChatRow({
  chat,
  project,
  onOpenChat,
}: {
  readonly chat: ConversationView;
  readonly project: ProjectView;
  readonly onOpenChat: ((conversationId: string) => void) | undefined;
}) {
  const currentChat = useWorkspaceStore((state) =>
    state.conversations.find((conversation) => conversation.id === chat.id) ?? chat,
  );
  const renameConversation = useWorkspaceStore((state) => state.renameConversation);
  const toggleConversationPinned = useWorkspaceStore((state) => state.toggleConversationPinned);
  const setConversationArchived = useWorkspaceStore((state) => state.setConversationArchived);
  const setConversationUnread = useWorkspaceStore((state) => state.setConversationUnread);
  const projects = useWorkspaceStore((state) => state.projects);
  const moveConversationToProject = useWorkspaceStore((state) => state.moveConversationToProject);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [exportPreviewOpen, setExportPreviewOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveQuery, setMoveQuery] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(chat.projectId);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(chat.title);
  const [status, setStatus] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const moveSearchRef = useRef<HTMLInputElement>(null);
  const moveDestinationRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const statusKey = projectChatStatus(chat);
  const menuId = projectChatActionsMenuId(chat.id);
  const deepLinkPreview = createProjectChatDeepLinkPreview(project.id, chat.id);
  // Resolve on demand so a large Project Chat list stays cheap to render. The
  // feedback is still typed and snapshot-bound when a user opens the menu or
  // activates the row.
  const deepLinkFeedback = actionsOpen
    ? resolveProjectChatDeepLinkPreview(deepLinkPreview, [project], [chat])
    : null;
  const availability = chatActionAvailability(chat, {
    hasFilesystemWorkspace: project.folders.length > 0,
    nativeHost: false,
  });
  const openWindowAvailability = availability["open-in-new-window"];
  const exportAvailability = availability.export;
  const worktreeAvailability = availability["continue-in-new-worktree"];
  const compareAvailability = availability["compare-models"];
  const deleteAvailability = availability["delete-permanently"];
  const moveDestinations = useMemo<ProjectChatMoveDestination[]>(() => {
    const normalizedQuery = moveQuery.trim().toLocaleLowerCase();
    const standalone: ProjectChatMoveDestination = {
      id: "__standalone__",
      projectId: null,
      label: "Inbox / standalone",
      description: "Keep this Chat outside a Project",
      recent: chat.projectId === null,
      available: true,
    };
    const projectDestinations = projects
      .map((candidate) => ({
        id: candidate.id,
        projectId: candidate.id,
        label: candidate.name,
        description: candidate.archived
          ? `${candidate.description || "Project Chat destination"} · Project is archived`
          : candidate.contextHealth === "missing-access"
            ? `${candidate.description || "Project Chat destination"} · workspace access unavailable`
            : candidate.description || "Project Chat destination",
        recent: candidate.id === chat.projectId || candidate.pinned,
        available: candidate.contextHealth !== "missing-access" && candidate.archived !== true,
        ...(candidate.archived
          ? { unavailableReason: "This Project is archived and cannot receive Chat ownership." }
          : candidate.contextHealth === "missing-access"
            ? { unavailableReason: "Workspace access is unavailable for this Project." }
            : {}),
      }))
      .sort((left, right) => {
        if (left.recent !== right.recent) return left.recent ? -1 : 1;
        if (left.projectId === chat.projectId) return -1;
        if (right.projectId === chat.projectId) return 1;
        return left.label.localeCompare(right.label);
      });
    const destinations = [standalone, ...projectDestinations];
    if (!normalizedQuery) return destinations;
    return destinations.filter((destination) =>
      `${destination.label} ${destination.description}`.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [chat.projectId, moveQuery, projects]);

  useEffect(() => {
    if (!actionsOpen) return undefined;
    firstActionRef.current?.focus({ preventScroll: true });
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rowRef.current?.contains(target)) {
        setActionsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setActionsOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionsOpen]);

  useEffect(() => {
    if (!moveOpen) return;
    moveSearchRef.current?.focus({ preventScroll: true });
  }, [moveOpen]);

  const closeActions = () => {
    setMoveOpen(false);
    setMoveQuery("");
    setActionsOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const openMovePicker = () => {
    setSelectedProjectId(chat.projectId);
    setMoveQuery("");
    setMoveOpen(true);
  };

  const focusMoveDestination = (index: number) => {
    const destination = moveDestinations[index];
    if (!destination) return;
    if (!destination.available) {
      setStatus(`${destination.label} is unavailable. ${destination.unavailableReason ?? "Choose another destination."}`);
      return;
    }
    setSelectedProjectId(destination.projectId);
    moveDestinationRefs.current[destination.id]?.focus({ preventScroll: true });
  };

  const onMoveDestinationKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMoveOpen(false);
      moveSearchRef.current?.focus({ preventScroll: true });
      return;
    }
    const availableIndexes = moveDestinations
      .map((destination, destinationIndex) => destination.available ? destinationIndex : null)
      .filter((destinationIndex): destinationIndex is number => destinationIndex !== null);
    if (availableIndexes.length === 0) return;
    const currentPosition = Math.max(0, availableIndexes.indexOf(index));
    let nextPosition: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextPosition = (currentPosition + 1) % availableIndexes.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextPosition = (currentPosition - 1 + availableIndexes.length) % availableIndexes.length;
    if (event.key === "Home") nextPosition = 0;
    if (event.key === "End") nextPosition = availableIndexes.length - 1;
    if (nextPosition === null) return;
    event.preventDefault();
    event.stopPropagation();
    focusMoveDestination(availableIndexes[nextPosition]!);
  };

  const confirmMove = () => {
    if (selectedProjectId === chat.projectId) {
      setStatus("Choose a different destination before confirming the Chat move.");
      return;
    }
    const currentProjects = useWorkspaceStore.getState().projects;
    if (selectedProjectId !== null && !currentProjects.some((candidate) => candidate.id === selectedProjectId)) {
      setSelectedProjectId(chat.projectId);
      setStatus(`The selected Project is no longer available. “${chat.title}” stayed in ${projectChatDestinationLabel(currentProjects, chat.projectId)}; no ownership change was applied.`);
      return;
    }
    const destination = selectedProjectId === null
      ? null
      : currentProjects.find((candidate) => candidate.id === selectedProjectId);
    if (destination?.archived === true) {
      setStatus(`The selected Project is archived and cannot receive Chat ownership. “${chat.title}” stayed in ${projectChatDestinationLabel(currentProjects, chat.projectId)}; no ownership change was applied.`);
      return;
    }
    if (destination?.contextHealth === "missing-access") {
      setStatus(`The selected Project is unavailable because workspace access is missing. “${chat.title}” stayed in ${projectChatDestinationLabel(currentProjects, chat.projectId)}; no ownership change was applied.`);
      return;
    }
    const fromLabel = projectChatDestinationLabel(currentProjects, chat.projectId);
    const toLabel = projectChatDestinationLabel(currentProjects, selectedProjectId);
    moveConversationToProject(chat.id, selectedProjectId);
    setMoveOpen(false);
    setMoveQuery("");
    setStatus(`Moved “${chat.title}” from ${fromLabel} to ${toLabel} in this renderer preview. History, branches, artifacts, and run receipts stayed attached.`);
    closeActions();
  };

  const continueInNewChat = () => {
    openWorkspaceOverlay({ kind: "start-conversation", projectId: project.id });
    setStatus(`Opened a new Chat starter for ${project.name}; history was not copied and no native run was started.`);
    closeActions();
  };

  const rename = () => {
    setRenameDraft(currentChat.title);
    setRenameOpen(true);
    closeActions();
  };

  const applyRename = () => {
    const next = renameDraft.trim();
    if (!next) {
      setStatus("Enter a Chat title before applying the renderer preview rename.");
      return;
    }
    renameConversation(chat.id, next);
    setRenameOpen(false);
    setStatus(`Renamed “${chat.title}” to “${next}” in this renderer preview.`);
  };

  const applyAction = (message: string, action: () => void) => {
    action();
    setStatus(message);
    closeActions();
  };

  const copyDeepLink = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Deep link copy is unavailable in this surface; no native navigation was performed.");
      closeActions();
      return;
    }
    try {
      await navigator.clipboard.writeText(deepLinkPreview);
      const feedback = resolveProjectChatDeepLinkPreview(deepLinkPreview, [project], [chat]);
      if (feedback.status === "resolved") {
        setStatus("Copied a renderer-local Project Chat deep link; native route resolution remains host-gated.");
      } else {
        setStatus(`Copied a renderer-local deep link, but ${feedback.label.toLocaleLowerCase()}; native resolution remains unavailable.`);
      }
    } catch {
      setStatus("Clipboard access was denied; no deep link was copied.");
    }
    closeActions();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keep text-entry and destination-list navigation inside the move picker;
    // the parent menu roving handler must not steal Arrow/Home/End keys from
    // those controls.
    if (event.target instanceof HTMLInputElement) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeActions();
      }
      return;
    }
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    );
    if (event.key === "Escape") {
      event.preventDefault();
      closeActions();
      return;
    }
    if (menuItems.length === 0) return;
    const currentIndex = Math.max(0, menuItems.indexOf(document.activeElement as HTMLButtonElement));
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % menuItems.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = menuItems.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    menuItems[nextIndex]?.focus({ preventScroll: true });
  };

  return (
    <div ref={rowRef} className="project-control-deck__chat-row">
      <button
        id={`project-chat-row-${encodeURIComponent(chat.id)}`}
        type="button"
        className="project-control-deck__chat-row-main"
        onClick={() => {
          // Opening a chat is a renderer navigation event. Clear the local
          // unread marker immediately, while durable acknowledgement remains
          // outside this preview surface.
          const feedback = resolveProjectChatDeepLinkPreview(deepLinkPreview, [project], [chat]);
          if (feedback.status !== "resolved") {
            setStatus(`${feedback.label}; opening remains renderer-local.`);
          }
          setConversationUnread(chat.id, false);
          onOpenChat?.(chat.id);
        }}
        disabled={!onOpenChat}
        aria-label={`${chat.title}. Project ${project.name}. ${statusKey}. Updated ${chat.updatedLabel}.`}
        aria-current={undefined}
        title={onOpenChat ? `Open ${chat.title}` : "Chat opening is unavailable in this surface"}
      >
        <span className="project-control-deck__chat-icon" aria-hidden="true"><MessageSquareText size={14} /></span>
        <span className="project-control-deck__chat-copy">
          <strong>{chat.title}</strong>
          <small>{chat.excerpt || "No message preview yet."}</small>
          <span className="project-control-deck__chat-project-marker">
            <span className="project-control-deck__chat-project-dot" style={{ background: project.accent }} aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
            <span>Project {project.name}</span>
          </span>
        </span>
        <span className="project-control-deck__chat-meta">
          <em>{statusKey}</em>
          <time dateTime={chat.updatedAt}>{chat.updatedLabel}</time>
        </span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="project-control-deck__chat-row-actions"
        aria-label={`Open project chat actions for ${chat.title}`}
        aria-haspopup="menu"
        aria-expanded={actionsOpen}
        aria-controls={actionsOpen ? menuId : undefined}
        title={`Chat actions for ${chat.title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setActionsOpen((current) => !current);
          setStatus(null);
        }}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      {actionsOpen ? (
        <div
          id={menuId}
          className="project-control-deck__chat-actions-menu"
          role="menu"
          aria-label={`Actions for ${chat.title}`}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={onMenuKeyDown}
          onBlur={(event) => {
            const nextTarget = event.relatedTarget;
            if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
              // Let normal Tab navigation continue to the next control rather
              // than leaving an orphaned menu open after focus exits it.
              setActionsOpen(false);
            }
          }}
        >
          <div className="project-control-deck__chat-actions-title" role="presentation">{chat.title}</div>
          <button ref={firstActionRef} type="button" role="menuitem" onClick={rename} title={`Rename ${chat.title} in the renderer preview`}>Rename</button>
          <button
            type="button"
            role="menuitem"
            title={chat.pinned ? `Remove the pin from ${chat.title} in the renderer preview` : `Pin ${chat.title} in the renderer preview`}
            onClick={() => applyAction(
              `${chat.pinned ? "Unpinned" : "Pinned"} “${chat.title}” in this renderer preview.`,
              () => toggleConversationPinned(chat.id),
            )}
          >
            {chat.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            role="menuitem"
            title={chat.unread ? `Mark ${chat.title} as read in the renderer preview` : `Mark ${chat.title} as unread in the renderer preview`}
            onClick={() => applyAction(
              `Marked “${chat.title}” as ${chat.unread ? "read" : "unread"} in this renderer preview.`,
              () => setConversationUnread(chat.id, !chat.unread),
            )}
          >
            Mark as {chat.unread ? "read" : "unread"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={availability["move-to-project"].state !== "enabled"}
            aria-expanded={moveOpen}
            aria-controls={moveOpen ? `${menuId}-move-panel` : undefined}
            title={availability["move-to-project"].state === "enabled" ? `Choose a Project destination for ${chat.title}` : availability["move-to-project"].reason}
            onClick={openMovePicker}
          >
            <FolderInput size={13} aria-hidden="true" /> Move to Project…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={availability["continue-in-new-chat"].state !== "enabled"}
            title={availability["continue-in-new-chat"].state === "enabled" ? `Start a new Chat from ${chat.title}` : availability["continue-in-new-chat"].reason}
            onClick={continueInNewChat}
          >
            <Plus size={13} aria-hidden="true" /> Continue in new Chat
          </button>
          <button type="button" role="menuitem" onClick={() => void copyDeepLink()} title={`Copy a renderer-local deep link for ${chat.title}`}>
            Copy deep link
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={openWindowAvailability.state !== "enabled"}
            title={openWindowAvailability.reason}
          >
            Open in new window · {openWindowAvailability.state === "planned" ? "Planned" : "Unavailable"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={exportAvailability.state !== "enabled"}
            title={exportAvailability.reason}
            onClick={() => {
              setActionsOpen(false);
              setMoveOpen(false);
              setExportPreviewOpen(true);
            }}
          >
            {exportAvailability.state === "enabled" ? "Export preview…" : `Export… · ${exportAvailability.state === "planned" ? "Planned" : "Unavailable"}`}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={worktreeAvailability.state !== "enabled"}
            title={worktreeAvailability.reason}
          >
            Continue in new worktree · {worktreeAvailability.state === "planned" ? "Planned" : "Unavailable"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={compareAvailability.state !== "enabled"}
            title={compareAvailability.reason}
          >
            Compare models · {compareAvailability.state === "planned" ? "Planned" : "Unavailable"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={deleteAvailability.state !== "enabled"}
            title={deleteAvailability.reason}
          >
            Delete permanently · {deleteAvailability.state === "planned" ? "Planned" : "Unavailable"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={(chat.archived ? availability.restore : availability.archive).state !== "enabled"}
            title={(chat.archived ? availability.restore : availability.archive).reason}
            onClick={() => applyAction(
              `${chat.archived ? "Restored" : "Archived"} “${chat.title}” in this renderer preview.`,
              () => setConversationArchived(chat.id, !chat.archived),
            )}
          >
            {chat.archived ? "Restore" : "Archive"}
          </button>
          {moveOpen ? (
            <div
              id={`${menuId}-move-panel`}
              className="project-control-deck__chat-move-panel"
              role="group"
              aria-label="Move Chat destination picker"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="project-control-deck__chat-move-heading">Choose destination</div>
              <label className="project-control-deck__chat-move-search">
                <Search size={13} aria-hidden="true" />
                <input
                  ref={moveSearchRef}
                  value={moveQuery}
                  onChange={(event) => setMoveQuery(event.target.value)}
                  placeholder="Search Projects"
                  aria-label="Search project destinations"
                />
              </label>
              <div className="project-control-deck__chat-move-list" role="listbox" aria-label="Project destinations">
                {moveDestinations.length > 0 ? moveDestinations.map((destination) => {
                  const selected = destination.projectId === selectedProjectId;
                  return (
                    <button
                      key={destination.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-disabled={!destination.available}
                      disabled={!destination.available}
                      tabIndex={selected ? 0 : -1}
                      ref={(element) => {
                        moveDestinationRefs.current[destination.id] = element;
                      }}
                      className={selected ? "project-control-deck__chat-move-option is-selected" : "project-control-deck__chat-move-option"}
                      title={destination.unavailableReason}
                      onClick={() => setSelectedProjectId(destination.projectId)}
                      onKeyDown={(event) => onMoveDestinationKeyDown(event, moveDestinations.indexOf(destination))}
                    >
                      <span><strong>{destination.label}</strong><small>{destination.description}</small></span>
                      {selected ? <em>Current</em> : destination.recent ? <em>Recent</em> : null}
                    </button>
                  );
                }) : <span className="project-control-deck__chat-move-empty">No Project destinations match “{moveQuery}”.</span>}
              </div>
              <div className="project-control-deck__chat-move-summary" role="status" aria-live="polite">
                <span>From <strong>{projectChatDestinationLabel(projects, chat.projectId)}</strong></span>
                <span aria-hidden="true">→</span>
                <span>To <strong>{projectChatDestinationLabel(projects, selectedProjectId)}</strong></span>
              </div>
              <p className="project-control-deck__chat-move-boundary">Preview only. History, branches, artifacts, and run receipts stay attached; no durable ownership write is sent.</p>
              <div className="project-control-deck__chat-move-actions">
                <button type="button" className="button button--ghost" onClick={() => { setMoveOpen(false); setMoveQuery(""); }} title="Close the Project destination picker without moving the Chat">Cancel</button>
                <button type="button" className="button button--primary" onClick={confirmMove} disabled={selectedProjectId === chat.projectId} title={selectedProjectId === chat.projectId ? "Choose a different Project destination first" : `Move ${chat.title} to the selected Project in the renderer preview`}>Confirm move</button>
              </div>
            </div>
          ) : null}
          {deepLinkFeedback ? (
            <div className={`project-control-deck__chat-actions-boundary project-control-deck__chat-deep-link project-control-deck__chat-deep-link--${deepLinkFeedback.status}`} aria-label="Project Chat deep-link status">
              <strong>{deepLinkFeedback.label}</strong>
              <small>Nearest safe ancestor: {deepLinkFeedback.nearestAncestor} · renderer-local preview; no native route resolution or write.</small>
            </div>
          ) : null}
        </div>
      ) : null}
      {renameOpen ? (
        <form
          className="project-control-deck__chat-rename"
          aria-label={`Rename ${currentChat.title}`}
          onSubmit={(event) => {
            event.preventDefault();
            applyRename();
          }}
        >
          <label htmlFor={`project-chat-rename-${encodeURIComponent(chat.id)}`}>Rename Chat in preview</label>
          <input
            id={`project-chat-rename-${encodeURIComponent(chat.id)}`}
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            aria-label="New Chat title"
            autoFocus
          />
          <div className="project-control-deck__chat-rename-actions">
            <button type="submit" className="button button--primary" disabled={!renameDraft.trim()} title={!renameDraft.trim() ? "Enter a Chat title before applying" : `Apply the renderer-local Chat title “${renameDraft.trim()}”`}><Check size={13} /> Apply</button>
            <button type="button" className="button button--ghost" onClick={() => setRenameOpen(false)} title="Close the Chat rename form without applying changes">Cancel</button>
          </div>
          <small>Renderer preview only; native Chat rename remains outside this surface.</small>
        </form>
      ) : null}
      {status ? <span className="project-control-deck__chat-row-status" role="status" aria-live="polite">{status}</span> : null}
      {exportPreviewOpen ? (
        <ConversationActionsDialog
          conversation={currentChat}
          initialView="export"
          exportOnly
          onClose={() => {
            setExportPreviewOpen(false);
            if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>
  );
}

function tabIcon(tab: ProjectDeckTab) {
  if (tab === "snapshot") return <Gauge size={14} />;
  if (tab === "signals") return <BellRing size={14} />;
  if (tab === "chats") return <MessageSquareText size={14} />;
  if (tab === "plan") return <ListChecks size={14} />;
  if (tab === "context") return <Layers3 size={14} />;
  if (tab === "ide") return <Code2 size={14} />;
  if (tab === "model") return <Bot size={14} />;
  if (tab === "twin") return <Boxes size={14} />;
  if (tab === "handoff") return <Send size={14} />;
  return <LockKeyhole size={14} />;
}

function statusLabel(project: ProjectView): string {
  return buildProjectContextAvailabilityForProject(project).label;
}

export function ProjectControlDeck({
  project,
  conversations,
  memories = [],
  skills = [],
  onOpenChat,
  onNewChat,
  onAddFolder,
  onOpenChatList,
  onOpenProjectSettings,
}: {
  readonly project: ProjectView;
  readonly conversations: ConversationView[];
  readonly memories?: MemoryView[];
  readonly skills?: SkillView[];
  readonly onOpenChat?: (conversationId: string) => void;
  readonly onNewChat?: () => void;
  readonly onAddFolder?: () => void;
  readonly onOpenChatList?: () => void;
  readonly onOpenProjectSettings?: () => void;
}) {
  const providers = useWorkspaceStore((state) => state.providers);
  const runTimelineEvents = useWorkspaceStore((state) => state.runTimelineEvents);
  const runTelemetryByRunId = useWorkspaceStore((state) => state.runTelemetryByRunId);
  const profiles = useMemo(() => selectableModelProfiles(providers), [providers]);
  const contextAvailability = useMemo(
    () => buildProjectContextAvailabilityForProject(project),
    [project],
  );
  const availableAccents = useMemo(
    () => [
      project.accent,
      ...accentOptions.filter((accent) => accent.toLowerCase() !== project.accent.toLowerCase()),
    ],
    [project.accent],
  );
  const [activeTab, setActiveTab] = useState<ProjectDeckTab>("snapshot");
  const tabListRef = useRef<HTMLDivElement>(null);
  const planWorkspaceTabListRef = useRef<HTMLDivElement>(null);
  const [planWorkspace, setPlanWorkspace] = useState<PlanWorkspace>("goals");
  const [roadmapVisited, setRoadmapVisited] = useState(false);
  useEffect(() => {
    setPlanWorkspace("goals");
    setRoadmapVisited(false);
  }, [project.id]);
  const navigatePlanWorkspace = (next: PlanWorkspace) => {
    if (next === planWorkspace) return;
    if (next === "roadmap") setRoadmapVisited(true);
    setPlanWorkspace(next);
    const tabList = planWorkspaceTabListRef.current;
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    tabList?.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion ? "auto" : "smooth" });
  };
  const navigateToTab = useCallback((nextTab: ProjectDeckTab) => {
    if (nextTab === activeTab) return;
    setActiveTab(nextTab);

    // Keep the selected workbench visible when the overview content above the
    // tabs is taller than the viewport. Scroll the stable tab row rather than
    // focusing it, so pointer navigation does not unexpectedly move keyboard
    // focus and keyboard tab navigation keeps its normal focus behavior.
    const tabList = tabListRef.current;
    if (!tabList) return;
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    tabList.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion ? "auto" : "smooth" });
  }, [activeTab]);
  const [planHandoffSeed, setPlanHandoffSeed] = useState<ProjectHandoffSeed | null>(null);
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");
  const [chatQuery, setChatQuery] = useState("");
  const [chatSort, setChatSort] = useState<ChatSort>("recent");
  const [chatGrouping, setChatGrouping] = useState<ChatGrouping>("flat");
  const [chatVisibleLimit, setChatVisibleLimit] = useState(CHAT_DISCOVERY_PAGE_SIZE);
  const [savedChatViews, setSavedChatViews] = useState<SavedChatView[]>([]);
  const [activeSavedChatViewId, setActiveSavedChatViewId] = useState<string | null>(null);
  const [savedChatViewName, setSavedChatViewName] = useState("");
  const [savedChatViewStatus, setSavedChatViewStatus] = useState("Saved views are renderer-local; no native write is performed.");
  const [savedDeckLayouts, setSavedDeckLayouts] = useState<SavedProjectDeckLayout[]>([]);
  const [activeSavedDeckLayoutId, setActiveSavedDeckLayoutId] = useState<string | null>(null);
  const [savedDeckLayoutName, setSavedDeckLayoutName] = useState("");
  const [savedDeckLayoutStatus, setSavedDeckLayoutStatus] = useState("Layouts are renderer-local; no native write is performed.");
  const [layoutPresetsOpen, setLayoutPresetsOpen] = useState(false);
  const [showMetadata, setShowMetadata] = useState(false);
  const [advancedSnapshotOpen, setAdvancedSnapshotOpen] = useState(false);
  const [advancedModelSurfacesOpen, setAdvancedModelSurfacesOpen] = useState(false);
  const [advancedModelSurface, setAdvancedModelSurface] = useState<AdvancedModelSurfaceId>("role-routing");
  const [projectPolicyHistoryById, setProjectPolicyHistoryById] = useState<Record<string, ProjectPolicyHistory>>({});
  const [previewHistory, setPreviewHistory] = useState<ProjectDeckHistory>(() => ({
    past: [],
    present: makeProjectDeckPreview(project),
    future: [],
  }));
  const [previewStatus, setPreviewStatus] = useState("Project choices stay in this renderer preview.");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ProjectExportFormat>("json");
  const [exportStatus, setExportStatus] = useState("Project preview is ready for a local manifest.");
  const [importOpen, setImportOpen] = useState(false);
  const [importPayload, setImportPayload] = useState("");
  const [importStatus, setImportStatus] = useState("Paste a Project Deck JSON preview or choose a file.");
  const importInputRef = useRef<HTMLInputElement>(null);

  const preview = previewHistory.present;
  const projectPolicyHistory = projectPolicyHistoryById[project.id];
  const contextPolicy = projectPolicyHistory?.present;
  const contextBudget = contextPolicy?.contextBudget ?? 3200;
  const includeMemories = contextPolicy?.includeMemories ?? true;
  const includeSkills = contextPolicy?.includeSkills ?? true;
  const handleProjectPolicyHistoryChange = useCallback((nextHistory: ProjectPolicyHistory) => {
    setProjectPolicyHistoryById((current) => current[project.id] === nextHistory
      ? current
      : { ...current, [project.id]: nextHistory });
  }, [project.id]);
  const updateProjectContextPolicy = useCallback((patch: Partial<ProjectPolicyDraft>, coalescedKey: string | null = null) => {
    setProjectPolicyHistoryById((current) => {
      const history = current[project.id] ?? makeDefaultProjectPolicyHistory(preview.modelProfileId);
      const nextHistory = applyProjectPolicyHistoryPatch(history, patch, coalescedKey);
      return nextHistory === history ? current : { ...current, [project.id]: nextHistory };
    });
  }, [preview.modelProfileId, project.id]);
  const clearProjectContextPolicyCoalescing = useCallback(() => {
    setProjectPolicyHistoryById((current) => {
      const history = current[project.id];
      if (!history || history.coalescedKey === null) return current;
      return { ...current, [project.id]: { ...history, coalescedKey: null } };
    });
  }, [project.id]);
  const overviewTabMappings = useMemo(
    () => buildProjectOverviewTabContracts({ settingsAvailable: Boolean(onOpenProjectSettings) }),
    [onOpenProjectSettings],
  );

  useEffect(() => {
    // These are deliberately renderer-only controls. Reinitialize them when
    // this deck is pointed at another project so a previous project's visual
    // sandbox cannot leak into the newly selected project.
    // Return to the stable landing surface as well: keeping a prior project's
    // deep workbench (or expanded metadata) selected makes the new project
    // look as though its state was carried across the boundary.
    setActiveTab("snapshot");
    setShowMetadata(false);
    setAdvancedSnapshotOpen(false);
    setPreviewHistory({ past: [], present: makeProjectDeckPreview(project), future: [] });
    setPreviewStatus("Project choices reset for the selected project.");
    setChatFilter("all");
    setChatQuery("");
    setChatSort("recent");
    setChatGrouping("flat");
    setChatVisibleLimit(CHAT_DISCOVERY_PAGE_SIZE);
    setSavedChatViews([]);
    setActiveSavedChatViewId(null);
    setSavedChatViewName("");
    setSavedChatViewStatus("Chat views reset for the selected project; nothing was persisted.");
    setSavedDeckLayouts([]);
    setActiveSavedDeckLayoutId(null);
    setSavedDeckLayoutName("");
    setSavedDeckLayoutStatus("Layouts reset for the selected project; nothing was persisted.");
    setLayoutPresetsOpen(false);
    setExportOpen(false);
    setImportOpen(false);
    setImportPayload("");
    setImportStatus("Paste a Project Deck JSON preview or choose a file.");
    setPlanHandoffSeed(null);
  }, [project.accent, project.id, project.modelProfileId, project.pinned]);

  const commitPreview = (patch: Partial<ProjectDeckPreview>, status: string) => {
    setPreviewHistory((current) => {
      const next = { ...current.present, ...patch };
      if (sameProjectDeckPreview(next, current.present)) return current;
      return {
        past: [...current.past, cloneProjectDeckPreview(current.present)],
        present: next,
        future: [],
      };
    });
    setPreviewStatus(status);
  };

  const undoPreview = () => {
    setPreviewHistory((current) => {
      const snapshot = current.past.at(-1);
      if (!snapshot) return current;
      return {
        past: current.past.slice(0, -1),
        present: cloneProjectDeckPreview(snapshot),
        future: [cloneProjectDeckPreview(current.present), ...current.future],
      };
    });
    setPreviewStatus("Undid the last project preview change.");
  };

  const redoPreview = () => {
    setPreviewHistory((current) => {
      const snapshot = current.future[0];
      if (!snapshot) return current;
      return {
        past: [...current.past, cloneProjectDeckPreview(current.present)],
        present: cloneProjectDeckPreview(snapshot),
        future: current.future.slice(1),
      };
    });
    setPreviewStatus("Reapplied the next project preview change.");
  };

  const resetPreview = () => {
    setPreviewHistory((current) => {
      const defaults = makeProjectDeckPreview(project);
      if (sameProjectDeckPreview(defaults, current.present)) return current;
      return {
        past: [...current.past, cloneProjectDeckPreview(current.present)],
        present: defaults,
        future: [],
      };
    });
    setPreviewStatus("Project preview reset to the selected project's defaults.");
  };

  const projectConversations = useMemo(
    () => conversations.filter((conversation) => conversation.projectId === project.id),
    [conversations, project.id],
  );
  const projectRunIds = useMemo(
    () => new Set(projectConversations.flatMap((conversation) => conversation.messages.map((message) => message.runId).filter((runId): runId is string => Boolean(runId)))),
    [projectConversations],
  );
  const projectRunTimelineEvents = useMemo(
    () => runTimelineEvents.filter((event) => projectRunIds.has(event.runId)),
    [projectRunIds, runTimelineEvents],
  );
  const projectTelemetrySnapshots = useMemo(
    () => Array.from(projectRunIds)
      .map((runId) => runTelemetryByRunId[runId])
      .filter((snapshot): snapshot is NonNullable<typeof snapshot> => Boolean(snapshot)),
    [projectRunIds, runTelemetryByRunId],
  );
  const filteredChats = useMemo(() => {
    const query = chatQuery.trim().toLowerCase();
    return projectConversations.filter((chat) => {
      if (!matchesChatFilter(chat, chatFilter)) return false;
      return !query || `${chat.title} ${chat.excerpt}`.toLowerCase().includes(query);
    });
  }, [chatFilter, chatQuery, projectConversations]);
  const sortedChats = useMemo(() => {
    const next = [...filteredChats];
    next.sort((left, right) => {
      if (chatSort === "title") return left.title.localeCompare(right.title) || compareRecentChats(left, right);
      if (chatSort === "attention") {
        return chatAttentionScore(right) - chatAttentionScore(left) || compareRecentChats(left, right);
      }
      return compareRecentChats(left, right);
    });
    return next;
  }, [chatSort, filteredChats]);
  const chatGroups = useMemo<ChatGroup[]>(() => {
    if (chatGrouping === "flat") return [{ key: "all", label: "All chats", chats: sortedChats }];
    const groups = new Map<string, ChatGroup>();
    sortedChats.forEach((chat) => {
      const state = chatState(chat);
      const current = groups.get(state.key);
      if (current) current.chats.push(chat);
      else groups.set(state.key, { key: state.key, label: state.label, chats: [chat] });
    });
    return ["failed", "running", "draft", "archived", "ready"]
      .map((key) => groups.get(key))
      .filter((group): group is ChatGroup => Boolean(group));
  }, [chatGrouping, sortedChats]);
  const visibleChatGroups = useMemo<ChatGroup[]>(() => {
    const visibleIds = new Set(sortedChats.slice(0, chatVisibleLimit).map((chat) => chat.id));
    return chatGroups
      .map((group) => ({
        ...group,
        chats: group.chats.filter((chat) => visibleIds.has(chat.id)),
        totalCount: group.chats.length,
      }))
      .filter((group) => group.chats.length > 0);
  }, [chatGroups, chatVisibleLimit, sortedChats]);
  const visibleChatCount = Math.min(chatVisibleLimit, sortedChats.length);
  const allMatchingChatsVisible = visibleChatCount === sortedChats.length;
  const activeMemories = useMemo(
    () => memories.filter((memory) => memory.status === "active" && (memory.scopeLabel === "Global" || memory.scopeLabel.includes(project.name))),
    [memories, project.name],
  );
  const activeSkills = useMemo(
    () => skills.filter((skill) => skill.enabled && (skill.scope === "Global" || skill.scope === "Project")),
    [skills],
  );
  const contextEstimatedTokens = useMemo(() => {
    if (contextAvailability.health === "missing-access" || contextAvailability.health === "over-budget") return null;
    return project.folders.length * 450
      + (project.instructions.trim() ? 600 : 0)
      + (includeMemories ? activeMemories.length * 160 : 0)
      + (includeSkills ? activeSkills.length * 300 : 0);
  }, [activeMemories.length, activeSkills.length, contextAvailability.health, includeMemories, includeSkills, project.folders.length, project.instructions]);
  const selectedProfile = profiles.find((profile) => profile.id === preview.modelProfileId);
  const isAutomaticModel = preview.modelProfileId === "auto";
  const selectedProvider = selectedProfile?.connectionId
    ? providers.find((provider) => provider.id === selectedProfile.connectionId)
    : undefined;
  const selectedModelSource = isAutomaticModel
    ? "Automatic route preview"
    : selectedProfile
      ? selectedProvider
        ? selectedProvider.source === "native" && selectedProvider.state === "connected"
          ? "Native provider metadata"
        : selectedProvider.source === "demo"
          ? "Demo catalog"
          : selectedProvider.source === "preview"
            ? "Configuration preview"
            : "Provider source unavailable"
      : "Provider source unavailable"
    : "Model catalog unavailable";
  const selectedModelState = isAutomaticModel
    ? "Resolved at run time; not dispatched"
    : selectedProvider
    ? providerStateLabel(selectedProvider)
    : selectedProfile
      ? "Provider state not hydrated"
      : "Profile not available in current catalog";
  const selectedModelLabel = selectedProfile?.displayName
    ?? (isAutomaticModel ? "Automatic routing" : `Unavailable profile · ${preview.modelProfileId}`);
  const selectedModelDetail = selectedProfile
    ? `${selectedProfile.providerName} · ${selectedProfile.contextLabel}`
    : isAutomaticModel
      ? "No provider model is available in this preview"
      : `Profile id ${preview.modelProfileId} is not reported by the current model catalog`;
  const exportPayload = useMemo(
    () => serializeProjectPreview(project, preview, projectConversations.length, activeMemories.length, activeSkills.length, selectedModelSource, selectedModelState, exportFormat),
    [activeMemories.length, activeSkills.length, exportFormat, preview, project, projectConversations.length, selectedModelSource, selectedModelState],
  );

  const changeModelProfile = (profileId: string) => {
    commitPreview({ modelProfileId: profileId }, "Model profile changed in the renderer preview.");
  };

  const markManualChatView = () => {
    setActiveSavedChatViewId(null);
    setChatVisibleLimit(CHAT_DISCOVERY_PAGE_SIZE);
  };

  const currentDeckLayoutSnapshot = (): ProjectDeckLayoutSnapshot => ({
    activeTab,
    showMetadata,
    chatFilter,
    chatQuery,
    chatSort,
    chatGrouping,
    chatVisibleLimit,
  });

  const saveDeckLayout = () => {
    const result = upsertProjectDeckLayout(savedDeckLayouts, savedDeckLayoutName, currentDeckLayoutSnapshot());
    if (result.error) {
      setSavedDeckLayoutStatus(result.error);
      return;
    }
    setSavedDeckLayouts(result.layouts);
    setActiveSavedDeckLayoutId(result.activeId);
    setSavedDeckLayoutName("");
    setSavedDeckLayoutStatus(`Saved “${result.layouts.find((layout) => layout.id === result.activeId)?.name ?? "layout"}” in this renderer preview; no native write was performed.`);
  };

  const applyDeckLayout = (layoutId: string) => {
    if (layoutId === "manual") {
      setActiveSavedDeckLayoutId(null);
      setSavedDeckLayoutStatus("Manual current layout is active.");
      return;
    }
    const layout = savedDeckLayouts.find((item) => item.id === layoutId);
    if (!layout) return;
    const snapshot = layout.snapshot;
    const nextTab = tabs.some((tab) => tab.id === snapshot.activeTab) ? snapshot.activeTab as ProjectDeckTab : "snapshot";
    const nextFilter = chatFilters.some((filter) => filter.id === snapshot.chatFilter) ? snapshot.chatFilter as ChatFilter : "all";
    const nextSort = (["recent", "title", "attention"] as ChatSort[]).includes(snapshot.chatSort as ChatSort) ? snapshot.chatSort as ChatSort : "recent";
    const nextGrouping = (["flat", "state"] as ChatGrouping[]).includes(snapshot.chatGrouping as ChatGrouping) ? snapshot.chatGrouping as ChatGrouping : "flat";
    navigateToTab(nextTab);
    setShowMetadata(snapshot.showMetadata);
    setChatFilter(nextFilter);
    setChatQuery(snapshot.chatQuery);
    setChatSort(nextSort);
    setChatGrouping(nextGrouping);
    setChatVisibleLimit(Math.max(1, snapshot.chatVisibleLimit));
    setActiveSavedDeckLayoutId(layout.id);
    setSavedDeckLayoutStatus(`Applied “${layout.name}” in this renderer preview.`);
  };

  const deleteActiveDeckLayout = () => {
    if (!activeSavedDeckLayoutId) return;
    const result = removeProjectDeckLayout(savedDeckLayouts, activeSavedDeckLayoutId);
    setSavedDeckLayouts(result.layouts);
    setActiveSavedDeckLayoutId(null);
    setSavedDeckLayoutStatus(result.removed ? `Deleted “${result.removed.name}” from this renderer session.` : "Deleted the selected renderer-local layout.");
  };

  const saveChatView = () => {
    const name = savedChatViewName.trim();
    if (!name) {
      setSavedChatViewStatus("Enter a name before saving this chat view.");
      return;
    }
    const view: SavedChatView = {
      id: `project-chat-view-${Date.now()}`,
      name,
      filter: chatFilter,
      sort: chatSort,
      grouping: chatGrouping,
      query: chatQuery,
    };
    setSavedChatViews((current) => [
      ...current.filter((item) => item.name.toLowerCase() !== name.toLowerCase()),
      view,
    ]);
    setActiveSavedChatViewId(view.id);
    setSavedChatViewName("");
    setSavedChatViewStatus(`Saved “${name}” in this renderer preview; no native write was performed.`);
  };

  const applySavedChatView = (viewId: string) => {
    if (viewId === "manual") {
      setActiveSavedChatViewId(null);
      setSavedChatViewStatus("Manual current filters are active.");
      return;
    }
    const view = savedChatViews.find((item) => item.id === viewId);
    if (!view) return;
    setChatFilter(view.filter);
    setChatSort(view.sort);
    setChatGrouping(view.grouping);
    setChatQuery(view.query);
    setChatVisibleLimit(CHAT_DISCOVERY_PAGE_SIZE);
    setActiveSavedChatViewId(view.id);
    setSavedChatViewStatus(`Applied “${view.name}” in this renderer preview.`);
  };

  const deleteActiveSavedChatView = () => {
    if (!activeSavedChatViewId) return;
    const view = savedChatViews.find((item) => item.id === activeSavedChatViewId);
    setSavedChatViews((current) => current.filter((item) => item.id !== activeSavedChatViewId));
    setActiveSavedChatViewId(null);
    setSavedChatViewStatus(view ? `Deleted “${view.name}” from this renderer session.` : "Deleted the selected renderer-local view.");
  };

  const copyExportPreview = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no project preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`Copied the renderer-local project preview as ${exportFormat.toUpperCase()}.`);
    } catch {
      setExportStatus("Clipboard access was denied; no project preview was copied.");
    }
  };

  const downloadExportPreview = () => {
    setExportStatus(
      downloadProjectPreview(exportPayload, exportFormat)
        ? "Downloaded the renderer-local project preview; no native project state changed."
        : "File download is unavailable in this surface; no project preview was exported.",
    );
  };

  const applyImportedPreview = () => {
    const result = parseProjectDeckPreviewImport(importPayload);
    if (!result.ok) {
      setImportStatus(result.error);
      return;
    }
    commitPreview(result.preview, "Imported a validated Project Deck preview into this renderer session.");
    setImportStatus("Imported preview applied locally; no native project settings changed.");
  };

  const loadImportFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > PROJECT_DECK_IMPORT_MAX_BYTES) {
      setImportStatus("Import rejected: Project Deck JSON is larger than 64 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setImportPayload(text);
      setImportStatus(`Loaded ${file.name}; review the payload before applying it.`);
    };
    reader.onerror = () => setImportStatus("Import failed: the browser could not read this preview file.");
    reader.readAsText(file);
  };

  const panelId = `project-control-deck-panel-${activeTab}`;
  const tabId = `project-control-deck-tab-${activeTab}`;
  return (
    <section className="project-control-deck" aria-labelledby="project-control-deck-title">
      <header className="project-control-deck__header">
        <span className="project-control-deck__icon"><Sparkles size={17} /></span>
        <div>
          <span className="eyebrow">Project control deck</span>
          <h2 id="project-control-deck-title">Shape this workspace before the next chat</h2>
          <p>Inspect project scope, choose preview inputs, and keep every native boundary visible.</p>
        </div>
        <span className="project-control-deck__status"><CircleAlert size={13} /> Renderer preview</span>
      </header>

      <div className="project-control-deck__summary" role="status" aria-live="polite">
        <div className="project-control-deck__summary-project">
           <span className="project-control-deck__summary-mark" style={{ background: preview.accent }} aria-hidden="true">{project.name.slice(0, 1)}</span>
          <span><strong>{project.name}</strong><small>{projectConversations.length} chats · {project.folders.length} folders · {statusLabel(project)}</small></span>
        </div>
        <span className="project-control-deck__summary-boundary"><ShieldCheck size={13} /> No native mutation has been sent</span>
      </div>

      <div className="project-control-deck__quick-actions" role="toolbar" aria-label="Project quick actions">
        <span className="project-control-deck__quick-actions-label">Quick actions</span>
        {!onNewChat ? <span id="project-deck-new-chat-unavailable" className="sr-only">New chat is unavailable here because the host callback is not connected; no native chat creation is implied.</span> : null}
        {!onAddFolder ? <span id="project-deck-add-folder-unavailable" className="sr-only">Add folder is unavailable here because the host callback is not connected; use the Access preview when available.</span> : null}
        {!onOpenProjectSettings ? <span id="project-deck-settings-unavailable" className="sr-only">Project settings are unavailable here because the host callback is not connected; no native settings surface is implied.</span> : null}
        <button
          type="button"
          className="project-control-deck__quick-action project-control-deck__quick-action--primary"
          onClick={onNewChat}
          disabled={!onNewChat}
          aria-describedby={!onNewChat ? "project-deck-new-chat-unavailable" : undefined}
          title={onNewChat ? "Start a new chat in this project" : "New project chat is unavailable in this surface"}
        >
          <Plus size={14} /> New chat
        </button>
        <button
          type="button"
          className="project-control-deck__quick-action"
          onClick={onAddFolder}
          disabled={!onAddFolder}
          aria-describedby={!onAddFolder ? "project-deck-add-folder-unavailable" : undefined}
          title={onAddFolder ? "Open the renderer-local folder grant preview" : "Add folder is unavailable in this surface"}
        >
          <FolderOpen size={14} /> Add folder
        </button>
        <button
          type="button"
          className="project-control-deck__quick-action"
          onClick={onOpenChatList ?? (() => navigateToTab("chats"))}
          title="Open the chats view for this project"
        >
          <MessageSquareText size={14} /> Open Chat list
        </button>
        <button
          type="button"
          className="project-control-deck__quick-action"
          onClick={onOpenProjectSettings}
          disabled={!onOpenProjectSettings}
          aria-describedby={!onOpenProjectSettings ? "project-deck-settings-unavailable" : undefined}
          title={onOpenProjectSettings ? "Open project settings" : "Project settings are unavailable in this surface"}
        >
          <Settings2 size={14} /> Project settings
        </button>
      </div>

      <nav className="project-control-deck__overview-map" aria-label="Project Overview tab mapping">
        <header className="project-control-deck__overview-map-header">
          <div>
            <span className="eyebrow">Project Overview contract</span>
            <h3>Normative tabs mapped to this preview</h3>
            <p>The product contract names six Overview tabs. This deck keeps its richer preview tabs, while each contract tab below points to the closest truthful surface.</p>
          </div>
          <span className="project-control-deck__overview-map-badge"><ShieldCheck size={13} /> Traceable mapping</span>
        </header>
        <div className="project-control-deck__overview-map-grid">
          {overviewTabMappings.map((mapping) => {
            const unavailable = mapping.status === "Unavailable";
            const selected = mapping.targetTab === activeTab;
            const status = mapping.status;
            const activate = () => {
              if (mapping.targetTab) {
                navigateToTab(mapping.targetTab);
                document.getElementById(`project-control-deck-tab-${mapping.targetTab}`)?.focus();
                return;
              }
              onOpenProjectSettings?.();
            };
            return (
              <button
                key={mapping.id}
                type="button"
                className={`project-control-deck__overview-map-card${selected ? " is-selected" : ""}`}
                onClick={activate}
                disabled={unavailable}
                aria-label={`${mapping.label} overview mapping`}
                aria-current={selected ? "page" : undefined}
                title={unavailable ? "Project settings are unavailable in this surface" : `Open ${mapping.targetLabel}`}
              >
                <span className="project-control-deck__overview-map-card-heading">
                  <strong>{mapping.label} tab</strong>
                  <em className={`project-control-deck__overview-map-status project-control-deck__overview-map-status--${status.toLowerCase()}`}>{status}</em>
                </span>
                <span className="project-control-deck__overview-map-target">{mapping.targetLabel}</span>
                <small>{mapping.description}</small>
                <span className="project-control-deck__overview-map-open">{unavailable ? "Unavailable" : selected ? "Open now" : "Open mapping"} <ChevronRight size={13} /></span>
              </button>
            );
          })}
        </div>
        <p className="project-control-deck__boundary"><CircleAlert size={14} /> Files, Memory, Skills, and Settings are mapped surfaces rather than claims that dedicated native Overview tabs or durable project settings are complete.</p>
      </nav>

      <div className="project-control-deck__preview-toolbar" role="toolbar" aria-label="Project preview history and export">
        <span className="project-control-deck__preview-copy"><strong>Reversible project preview</strong><small>{previewStatus}</small></span>
        <span className="project-control-deck__preview-count" aria-label={`${previewHistory.past.length} undo steps and ${previewHistory.future.length} redo steps`}>
          {previewHistory.past.length + previewHistory.future.length} steps
        </span>
        <button type="button" className="button button--ghost" onClick={undoPreview} disabled={previewHistory.past.length === 0} aria-label="Undo project preview change" title="Undo project preview change"><Undo2 size={13} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redoPreview} disabled={previewHistory.future.length === 0} aria-label="Redo project preview change" title="Redo project preview change"><Redo2 size={13} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={resetPreview} aria-label="Reset project preview" title="Reset project preview to selected project defaults"><RotateCcw size={13} /> Reset</button>
        <button type="button" className="button button--ghost" title={layoutPresetsOpen ? "Hide saved Project Deck layout presets" : "Open saved Project Deck layout presets"} onClick={() => setLayoutPresetsOpen((value) => !value)} aria-expanded={layoutPresetsOpen} aria-controls="project-deck-layout-presets"><Layers3 size={13} /> {layoutPresetsOpen ? "Hide layouts" : "Saved layouts"}</button>
        <button type="button" className="button button--secondary" title={exportOpen ? "Hide the Project Deck export preview" : "Open the renderer-local Project Deck export preview"} onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="project-deck-export-preview"><FileJson2 size={13} /> {exportOpen ? "Hide export" : "Preview export"}</button>
      </div>

      {layoutPresetsOpen ? (
        <section id="project-deck-layout-presets" className="project-control-deck__layout-presets" aria-label="Saved Project Deck layouts">
          <header>
            <div><span className="eyebrow">Renderer-local layout presets</span><h3>Save this deck arrangement</h3><p>Presets remember the selected deck tab, metadata disclosure, and Chat view controls for this Project.</p></div>
            <span className="project-control-deck__preview-chip">Session-only</span>
          </header>
          <div className="project-control-deck__layout-toolbar" role="toolbar" aria-label="Project Deck layout actions">
            <label><span>Saved layout</span><select value={activeSavedDeckLayoutId ?? "manual"} onChange={(event) => applyDeckLayout(event.target.value)} aria-label="Saved Project Deck layout"><option value="manual">Manual current layout</option>{savedDeckLayouts.map((layout) => <option key={layout.id} value={layout.id}>{layout.name}</option>)}</select></label>
            <label><span>Name</span><input value={savedDeckLayoutName} onChange={(event) => setSavedDeckLayoutName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveDeckLayout(); }} placeholder="e.g. Handoff review" aria-label="New Project Deck layout name" /></label>
            <button type="button" className="button button--secondary" onClick={saveDeckLayout} title="Save or update this renderer-local Project Deck layout preset"><Check size={13} /> Save / update</button>
            <button type="button" className="button button--ghost" onClick={deleteActiveDeckLayout} disabled={!activeSavedDeckLayoutId} aria-label="Delete saved Project Deck layout" title="Delete the selected renderer-local Project Deck layout preset"><Trash2 size={13} /> Delete</button>
          </div>
          <span className="project-control-deck__saved-view-status" role="status" aria-live="polite">{savedDeckLayoutStatus}</span>
          <p className="project-control-deck__boundary"><LockKeyhole size={14} /> Layout presets contain renderer navigation/display state only. They do not persist Project settings, provider routes, workspace paths, permissions, or native runtime state.</p>
        </section>
      ) : null}

      {exportOpen ? (
        <section id="project-deck-export-preview" className="project-control-deck__export-preview" aria-label="Project export preview">
          <header><div><span className="eyebrow">Renderer-local export</span><h3>Project deck snapshot</h3></div><span className="project-control-deck__preview-chip">No durable write</span></header>
          <div className="project-control-deck__export-toolbar" role="toolbar" aria-label="Project export preview actions">
            <label><span>Format</span><select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ProjectExportFormat)} aria-label="Project export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
            <span className="project-control-deck__export-status" role="status" aria-live="polite">{exportStatus}</span>
            <button type="button" className="button button--ghost" onClick={() => void copyExportPreview()} title="Copy the renderer-local Project Deck export preview"><Clipboard size={14} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={downloadExportPreview} title="Download the renderer-local Project Deck export preview"><Download size={14} /> Download</button>
            <button type="button" className="button button--ghost" onClick={() => setImportOpen((value) => !value)} aria-expanded={importOpen} aria-controls="project-deck-import-preview" title={importOpen ? "Hide the Project Deck preview import form" : "Open the Project Deck preview import form"}><Upload size={14} /> {importOpen ? "Hide import" : "Import preview"}</button>
          </div>
           <pre className="project-control-deck__export-code" tabIndex={0} aria-label="Project export preview contents"><code>{exportPayload}</code></pre>
          <p className="project-control-deck__boundary"><LockKeyhole size={14} /> This export contains renderer preview metadata only. It does not persist project settings, send provider requests, or include raw workspace paths.</p>
          {importOpen ? (
            <section id="project-deck-import-preview" className="project-control-deck__import-preview" aria-label="Import project preview">
              <header><div><span className="eyebrow">Portable preset import</span><h3>Stage a Project Deck preview</h3></div><span className="project-control-deck__preview-chip">Session-only</span></header>
              <p>Import changes the current visual/model draft only. It does not rename the Project, write settings, call a provider, or read workspace files.</p>
              <textarea aria-label="Project Deck JSON import" rows={7} value={importPayload} onChange={(event) => setImportPayload(event.target.value)} placeholder='Paste omnia.project-deck-preview.v1 JSON here' />
              <div className="project-control-deck__import-actions">
                <button type="button" className="button button--secondary" onClick={applyImportedPreview} title="Apply the staged renderer-local Project Deck preview"><Check size={13} /> Apply import preview</button>
                <button type="button" className="button button--ghost" onClick={() => importInputRef.current?.click()} title="Choose a Project Deck preview JSON file"><Upload size={13} /> Choose JSON file</button>
                <input ref={importInputRef} className="sr-only" type="file" accept="application/json,.json" aria-label="Choose Project Deck preview JSON file" onChange={(event) => { loadImportFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                <button type="button" className="button button--ghost" onClick={() => { setImportPayload(""); setImportStatus("Import preview cleared; current Project Deck draft remains unchanged."); }} title="Clear the staged Project Deck preview import"><RotateCcw size={13} /> Clear</button>
              </div>
              <p className="project-control-deck__import-status" role="status" aria-live="polite">{importStatus}</p>
            </section>
          ) : null}
        </section>
      ) : null}

      <div ref={tabListRef} className="project-control-deck__tabs" role="tablist" aria-label="Project control views" aria-orientation="horizontal">
        {tabs.map((tab) => {
          const selected = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              id={`project-control-deck-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`project-control-deck-panel-${tab.id}`}
              title={`Open the ${tab.label} Project preview`}
              tabIndex={selected ? 0 : -1}
              className={selected ? "project-control-deck__tab project-control-deck__tab--active" : "project-control-deck__tab"}
              onClick={() => navigateToTab(tab.id)}
              onKeyDown={(event) => {
                const currentIndex = tabs.findIndex((item) => item.id === tab.id);
                let nextTabId: ProjectDeckTab | null = null;
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  nextTabId = tabs[(currentIndex + 1) % tabs.length]!.id;
                }
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  nextTabId = tabs[(currentIndex - 1 + tabs.length) % tabs.length]!.id;
                }
                if (event.key === "Home") {
                  event.preventDefault();
                  nextTabId = tabs[0]!.id;
                }
                if (event.key === "End") {
                  event.preventDefault();
                  nextTabId = tabs[tabs.length - 1]!.id;
                }
                if (nextTabId) {
                  navigateToTab(nextTabId);
                  document.getElementById(`project-control-deck-tab-${nextTabId}`)?.focus();
                }
              }}
            >
              {tabIcon(tab.id)}<span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div id={panelId} role="tabpanel" aria-labelledby={tabId} tabIndex={0} className="project-control-deck__panel">
        {activeTab === "snapshot" ? (
          <div className="project-control-deck__snapshot">
            <div className="project-control-deck__metric-grid">
              <article><span><MessageSquareText size={14} /></span><strong>{projectConversations.length}</strong><small>Project chats</small></article>
              <article><span><FolderOpen size={14} /></span><strong>{project.folders.length}</strong><small>Folder grants</small></article>
              <article><span><Users size={14} /></span><strong>{activeMemories.length + activeSkills.length}</strong><small>Visible input candidates</small></article>
              <article title={contextAvailability.reason}><span><Gauge size={14} /></span><strong>{contextAvailability.label}</strong><small>Context availability</small></article>
            </div>
            <ProjectRuntimePosture
              projectName={project.name}
              contextAvailability={contextAvailability}
              runCount={projectRunIds.size}
              timelineEventCount={projectRunTimelineEvents.length}
              telemetrySnapshots={projectTelemetrySnapshots}
              onNavigate={navigateToTab}
            />
            <ProjectDeckLazySurface
              label="project next actions"
              load={loadProjectNextActionsPreview}
              props={{
                project,
                conversations: projectConversations,
                onNavigate: navigateToTab,
                ...(onOpenChat ? { onOpenChat } : {}),
                ...(onNewChat ? { onNewChat } : {}),
                ...(onAddFolder ? { onAddFolder } : {}),
              }}
            />
            <section className="project-control-deck__advanced-snapshot" aria-label="Advanced Project policy and data">
              <button
                type="button"
                className="project-control-deck__advanced-snapshot-toggle"
                aria-expanded={advancedSnapshotOpen}
                aria-controls="project-deck-advanced-snapshot"
                title={advancedSnapshotOpen ? "Hide Project policy, cache planning, and source ledger" : "Show Project policy, cache planning, and source ledger"}
                onClick={() => setAdvancedSnapshotOpen((open) => !open)}
              >
                <span><Settings2 size={15} aria-hidden="true" /> Advanced policy &amp; data <small>Routing · context · cache · sources</small></span>
                <ChevronDown size={15} className={advancedSnapshotOpen ? "is-open" : ""} aria-hidden="true" />
              </button>
              {advancedSnapshotOpen ? (
                <div id="project-deck-advanced-snapshot" className="project-control-deck__advanced-snapshot-content">
                  <ProjectPolicySummary
                    key={`project-policy-${project.id}`}
                    projectName={project.name}
                    providers={providers}
                    initialMainModelProfileId={preview.modelProfileId}
                    contextAvailability={contextAvailability}
                    contextSourceCount={contextAvailability.folders.total}
                    contextSelectedCount={contextAvailability.folders.referenced}
                    contextEstimatedTokens={contextEstimatedTokens}
                    contextMemoryCount={activeMemories.length}
                    contextSkillCount={activeSkills.length}
                    initialHistory={projectPolicyHistory}
                    onHistoryChange={handleProjectPolicyHistoryChange}
                  />
                  <CacheContextRoutingPreview
                    providerLabel={selectedProfile?.providerName ?? "Selected provider"}
                    displayFilter={contextPolicy?.localCacheDisplayFilter ?? "all"}
                    onDisplayFilterChange={(displayFilter) => updateProjectContextPolicy({ localCacheDisplayFilter: displayFilter })}
                  />
                  <ProjectReadonlyLedger
                    project={project}
                    contextAvailability={contextAvailability}
                    chatCount={projectConversations.length}
                    memoryCount={activeMemories.length}
                    skillCount={activeSkills.length}
                  />
                </div>
              ) : null}
            </section>
            <p className="project-control-deck__boundary"><Users size={14} /> Memory and skill counts are renderer-visible candidates only. Project ownership, retrieval, and native activation are not hydrated by this deck.</p>
            <ProjectActivityTimeline
              project={project}
              conversations={projectConversations}
              onOpenRelated={(event) => {
                if (event.kind === "chat" && event.relatedId) onOpenChat?.(event.relatedId);
              }}
            />
            <div className="project-control-deck__quick-grid">
              <article className="project-control-deck__quick-card">
                <div className="project-control-deck__quick-heading"><span><Pin size={14} /> Project surface</span><small>Local preview</small></div>
                <p>Keep this project easy to find while you shape its style and scope.</p>
                <button type="button" className={preview.pinned ? "button button--secondary project-control-deck__wide-button" : "button button--ghost project-control-deck__wide-button"} title={preview.pinned ? "Unpin this Project in the renderer preview" : "Pin this Project in the renderer preview"} onClick={() => commitPreview({ pinned: !preview.pinned }, preview.pinned ? "Project unpinned in the renderer preview." : "Project pinned in the renderer preview.")}>
                  {preview.pinned ? <PinOff size={14} /> : <Pin size={14} />}{preview.pinned ? "Unpin in preview" : "Pin in preview"}
                </button>
              </article>
              <article className="project-control-deck__quick-card">
                <div className="project-control-deck__quick-heading"><span><Wand2 size={14} /> Accent direction</span><small>Style sandbox</small></div>
                <div className="project-control-deck__swatches" role="group" aria-label="Project accent preview">
                  {availableAccents.map((accent) => <button key={accent} type="button" aria-label={`Use accent ${accent}`} title={`Use accent ${accent} in the renderer preview`} aria-pressed={accent === preview.accent} className={accent === preview.accent ? "is-selected" : ""} style={{ background: accent }} onClick={() => commitPreview({ accent }, `Accent ${accent} selected in the renderer preview.`)} />)}
                </div>
                <small className="project-control-deck__field-note">Current preview: <code>{preview.accent}</code></small>
              </article>
            </div>
            <button
              type="button"
              className="project-control-deck__metadata-toggle"
              aria-label={showMetadata ? "Hide project metadata" : "Show project metadata"}
              aria-expanded={showMetadata}
              aria-controls="project-deck-metadata"
              title={showMetadata ? "Hide renderer-local project metadata" : "Show renderer-local project metadata"}
              onClick={() => setShowMetadata((value) => !value)}
            >
              <span><Settings2 size={14} /> {showMetadata ? "Hide project metadata" : "Show project metadata"}</span><ChevronDown size={14} className={showMetadata ? "is-open" : ""} aria-hidden="true" />
            </button>
            {showMetadata ? <dl id="project-deck-metadata" className="project-control-deck__metadata"><div><dt>Project id</dt><dd>{project.id}</dd></div><div><dt>Model profile preview</dt><dd>{preview.modelProfileId}</dd></div><div><dt>Instructions</dt><dd>{project.instructions.trim() ? "Present" : "Empty"}</dd></div><div><dt>Persisted pin / preview</dt><dd>{project.pinned ? "Pinned" : "Not pinned"} / {preview.pinned ? "Pinned" : "Not pinned"}</dd></div></dl> : null}
          </div>
        ) : null}

        {activeTab === "signals" ? (
          <ProjectDeckLazySurface
            label={`${project.name} signals`}
            load={loadMissionControlSignalCenter}
            loadingContent={<><h3>{project.name} signal center</h3><small>Renderer-local signal center is loading; it is not a durable run journal or Project Twin revision.</small></>}
            props={{
              title: `${project.name} signal center`,
              conversations: projectConversations,
              projects: [project],
              runTimeline: projectRunTimelineEvents,
              onOpenEvent: (event) => {
                if (event.conversationId) onOpenChat?.(event.conversationId);
              },
            }}
          />
        ) : null}

        {activeTab === "chats" ? (
          <div className="project-control-deck__chats">
            <div className="project-control-deck__toolbar">
              <label className="project-control-deck__search"><Search size={14} /><span className="sr-only">Search project chats</span><input value={chatQuery} onChange={(event) => { setChatQuery(event.target.value); markManualChatView(); }} placeholder="Search chats in this project" /></label>
              <div className="project-control-deck__filters" role="group" aria-label="Project chat filters">
                {chatFilters.map((filter) => <button key={filter.id} type="button" className={chatFilter === filter.id ? "is-active" : ""} aria-pressed={chatFilter === filter.id} title={`Filter project chats: ${filter.label}`} onClick={() => { setChatFilter(filter.id); markManualChatView(); }}>{filter.label}</button>)}
              </div>
              <button type="button" className="button button--secondary" onClick={onNewChat} disabled={!onNewChat} title={onNewChat ? "Start a new chat in this project" : "New project chat is unavailable in this surface"}><Plus size={14} /> New chat</button>
            </div>
            <div className="project-control-deck__chat-options" role="group" aria-label="Project chat view controls">
              <label><span>Sort</span><select value={chatSort} onChange={(event) => { setChatSort(event.target.value as ChatSort); markManualChatView(); }} aria-label="Sort project chats"><option value="recent">Recent</option><option value="title">Title</option><option value="attention">Attention</option></select></label>
              <label><span>Layout</span><select value={chatGrouping} onChange={(event) => { setChatGrouping(event.target.value as ChatGrouping); markManualChatView(); }} aria-label="Group project chats"><option value="flat">Flat list</option><option value="state">Group by state</option></select></label>
              <label className="project-control-deck__saved-view-select"><span>Saved view</span><select value={activeSavedChatViewId ?? "manual"} onChange={(event) => applySavedChatView(event.target.value)} aria-label="Saved project chat view"><option value="manual">Manual current filters</option>{savedChatViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label>
              <div className="project-control-deck__saved-view-actions">
                <input value={savedChatViewName} onChange={(event) => setSavedChatViewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveChatView(); }} placeholder="Name this view" aria-label="New saved project chat view name" />
                <button type="button" className="button button--ghost" onClick={saveChatView} title="Save the current Project Chat filters as a renderer-local view"><Check size={13} /> Save view</button>
                <button type="button" className="button button--ghost" onClick={deleteActiveSavedChatView} disabled={!activeSavedChatViewId} aria-label="Delete saved project chat view" title="Delete selected saved view"><Trash2 size={13} /></button>
              </div>
            </div>
            <span className="project-control-deck__saved-view-status" role="status" aria-live="polite">{savedChatViewStatus}</span>
            {sortedChats.length > 0 ? <>
              <div id="project-deck-chat-results" className="project-control-deck__chat-discovery" aria-live="polite" aria-atomic="true">
                <span>Showing {visibleChatCount} of {sortedChats.length} matching {sortedChats.length === 1 ? "chat" : "chats"}.</span>
                {sortedChats.length > CHAT_DISCOVERY_PAGE_SIZE ? <button type="button" className="button button--ghost" aria-expanded={allMatchingChatsVisible} aria-controls="project-deck-chat-results" title={allMatchingChatsVisible ? "Collapse the Project Chat discovery list" : "Show every matching Project Chat"} onClick={() => setChatVisibleLimit(allMatchingChatsVisible ? CHAT_DISCOVERY_PAGE_SIZE : sortedChats.length)}>{allMatchingChatsVisible ? "Show fewer chats" : `Show all ${sortedChats.length} chats`}</button> : null}
              </div>
              <div className="project-control-deck__chat-list">
              {visibleChatGroups.map((group) => (
                <div key={group.key} className="project-control-deck__chat-group">
                  {chatGrouping === "state" ? <header><strong>{group.label}</strong><small>{group.chats.length}{group.totalCount !== group.chats.length ? ` of ${group.totalCount}` : ""} {group.totalCount === 1 ? "chat" : "chats"}</small></header> : null}
                  <div className="project-control-deck__chat-group-list">
                    {group.chats.map((chat) => <ProjectChatRow key={chat.id} chat={chat} project={project} onOpenChat={onOpenChat} />)}
                  </div>
                </div>
              ))}
              </div>
            </> : <div className="project-control-deck__empty"><Archive size={18} /><strong>No matching project chats</strong><small>Try another filter or start a new project chat.</small></div>}
            <p className="project-control-deck__boundary"><Clock3 size={14} /> Chat navigation is live in the renderer; durable project membership and search indexing still depend on the native layer.</p>
          </div>
        ) : null}

        {activeTab === "plan" ? (
          <div className="project-control-deck__plan-workspace">
            <div className="project-control-deck__plan-workspace-header">
              <div>
                <h3>Plan workspace</h3>
                <p>Shape goals or refine the delivery roadmap. Preview changes stay in this browser session.</p>
              </div>
              <div ref={planWorkspaceTabListRef} className="project-control-deck__plan-workspace-tabs" role="tablist" aria-label="Plan workspaces" aria-orientation="horizontal">
                {([
                  { id: "goals", label: "Goals & tasks", icon: <Target size={14} /> },
                  { id: "roadmap", label: "Roadmap & planning", icon: <ListChecks size={14} /> },
                ] as const).map((workspace, index) => (
                  <button
                    key={workspace.id}
                    id={`project-control-deck-plan-tab-${workspace.id}`}
                    type="button"
                    role="tab"
                    aria-selected={planWorkspace === workspace.id}
                    aria-controls={`project-control-deck-plan-panel-${workspace.id}`}
                    tabIndex={planWorkspace === workspace.id ? 0 : -1}
                    title={`Open ${workspace.label} in the Project Plan preview`}
                    onClick={() => navigatePlanWorkspace(workspace.id)}
                    onKeyDown={(event) => {
                      let next: PlanWorkspace | null = null;
                      if (event.key === "ArrowRight") next = index === 0 ? "roadmap" : "goals";
                      if (event.key === "ArrowLeft") next = index === 0 ? "roadmap" : "goals";
                      if (event.key === "Home") next = "goals";
                      if (event.key === "End") next = "roadmap";
                      if (!next) return;
                      event.preventDefault();
                      navigatePlanWorkspace(next);
                      document.getElementById(`project-control-deck-plan-tab-${next}`)?.focus({ preventScroll: true });
                    }}
                  >
                    {workspace.icon}<span>{workspace.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div id="project-control-deck-plan-panel-goals" role="tabpanel" aria-labelledby="project-control-deck-plan-tab-goals" hidden={planWorkspace !== "goals"} className="project-control-deck__plan-workspace-panel">
              <NativeProjectGoals projectId={project.id} projectName={project.name} />
              <ProjectDeckLazySurface
                key={`goal-studio:${project.id}`}
                label="goal and task studio"
                load={loadGoalTaskStudio}
                props={{ projectId: project.id }}
              />
            </div>
            <div id="project-control-deck-plan-panel-roadmap" role="tabpanel" aria-labelledby="project-control-deck-plan-tab-roadmap" hidden={planWorkspace !== "roadmap"} className="project-control-deck__plan-workspace-panel">
              {roadmapVisited ? <ProjectPlanningPreview
                key={`planning:${project.id}`}
                project={project}
                conversations={projectConversations}
                onPrepareHandoff={(seed: ProjectHandoffSeed) => {
                  setPlanHandoffSeed(seed);
                  navigateToTab("handoff");
                }}
                {...(onOpenChat ? {
                  onPrepareChatDraft: (seed: ProjectHandoffSeed, conversationId: string) => {
                    const result = useWorkspaceStore.getState().prepareConversationDraft(
                      conversationId,
                      project.id,
                      buildProjectPlanChatDraft(project.name, seed),
                    );
                    if (result === "prepared") onOpenChat(conversationId);
                    return result;
                  },
                } : {})}
                onCreateChatDraft={(seed: ProjectHandoffSeed) => openWorkspaceOverlay({
                  kind: "start-conversation",
                  projectId: project.id,
                  planDraft: (() => {
                    const text = buildProjectPlanChatDraft(project.name, seed);
                    return {
                      projectId: project.id,
                      taskId: seed.taskId,
                      taskTitle: seed.taskTitle,
                      text,
                      operation: createPlanChatOperationPreview({
                        projectId: project.id,
                        taskId: seed.taskId,
                        taskTitle: seed.taskTitle,
                        draft: text,
                      }),
                    };
                  })(),
                })}
              /> : null}
            </div>
          </div>
        ) : null}

        {activeTab === "context" ? (
          <ProjectDeckLazySurface
            label="project context"
            load={loadProjectContextWorkbench}
            props={{
              project,
              conversations,
              memories,
              skills,
              contextBudget,
              includeMemories,
              includeSkills,
              onContextBudgetChange: (value: number) => updateProjectContextPolicy({ contextBudget: value }, "context-budget"),
              onContextBudgetChangeEnd: clearProjectContextPolicyCoalescing,
              onIncludeMemoriesChange: (value: boolean) => updateProjectContextPolicy({ includeMemories: value }),
              onIncludeSkillsChange: (value: boolean) => updateProjectContextPolicy({ includeSkills: value }),
            }}
          />
        ) : null}

        {activeTab === "ide" ? (
          <ProjectDeckLazySurface
            label="project IDE"
            load={loadProjectIdePreview}
            props={{ project }}
          />
        ) : null}

        {activeTab === "model" ? (
          <div className="project-control-deck__model">
            <div className="project-control-deck__model-heading"><div><span className="eyebrow">Route preview</span><h3>Choose a model direction for this project</h3><p>These selections stay in the renderer until native profile persistence is attached.</p></div><Bot size={20} /></div>
            <label className="project-control-deck__select-field"><span>Model profile</span><select value={preview.modelProfileId} onChange={(event) => changeModelProfile(event.target.value)} aria-label="Project model profile preview">{!profiles.some((profile) => profile.id === preview.modelProfileId) ? <option value={preview.modelProfileId}>Unavailable profile · {preview.modelProfileId}</option> : null}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName} · {profile.providerName}</option>)}</select></label>
            <div className="project-control-deck__preset-row" role="group" aria-label="Model style preview">{(["Precise", "Balanced", "Creative", "Research"] as ModelPreset[]).map((preset) => <button key={preset} type="button" className={preview.modelPreset === preset ? "is-active" : ""} aria-pressed={preview.modelPreset === preset} title={`Use ${preset} response style in the renderer preview`} onClick={() => commitPreview({ modelPreset: preset }, `Model style ${preset} selected in the renderer preview.`)}>{preset}{preview.modelPreset === preset ? <Check size={13} /> : null}</button>)}</div>
            <div className="project-control-deck__resolved-model"><span><Bot size={16} /></span><div><strong>{selectedModelLabel}</strong><small>{selectedModelDetail}</small><small className="project-control-deck__model-source">Source: {selectedModelSource} · State: {selectedModelState}</small></div><em>{preview.modelPreset}</em></div>
            <div className="project-control-deck__model-options">
              <label><input type="checkbox" checked={preview.preferVision} onChange={(event) => commitPreview({ preferVision: event.target.checked }, "Vision preference changed in the renderer preview.")} /> Prefer vision when attachments are present</label>
              <label><input type="checkbox" checked={preview.preferReasoning} onChange={(event) => commitPreview({ preferReasoning: event.target.checked }, "Reasoning preference changed in the renderer preview.")} /> Prefer deeper reasoning for research chats</label>
              <label><input type="checkbox" checked={preview.concise} onChange={(event) => commitPreview({ concise: event.target.checked }, "Response style preference changed in the renderer preview.")} /> Keep responses concise by default</label>
            </div>
            <RoutingInheritancePreview
              providers={providers}
              modelProfileId={preview.modelProfileId}
              projectId={project.id}
              onModelProfileChange={changeModelProfile}
            />
            <section className="project-control-deck__advanced-surfaces" aria-labelledby="project-deck-advanced-surfaces-title">
              <button
                type="button"
                className="project-control-deck__advanced-toggle"
                aria-expanded={advancedModelSurfacesOpen}
                aria-controls="project-deck-advanced-surfaces-panel"
                title={advancedModelSurfacesOpen ? "Hide optional routing, local-model, learning, and orchestration workbenches" : "Show optional routing, local-model, learning, and orchestration workbenches"}
                onClick={() => setAdvancedModelSurfacesOpen((value) => !value)}
              >
                <span>
                  <span className="eyebrow">Optional workbenches</span>
                  <strong id="project-deck-advanced-surfaces-title">Routing, local models & orchestration</strong>
                  <small>Open only the deeper surfaces you need; each stays renderer-local and loads on demand.</small>
                </span>
                <ChevronDown size={16} className={advancedModelSurfacesOpen ? "is-open" : ""} aria-hidden="true" />
              </button>
              {advancedModelSurfacesOpen ? (
                <div id="project-deck-advanced-surfaces-panel" className="project-control-deck__advanced-surfaces-panel">
                  <div
                    className="project-control-deck__advanced-selector"
                    role="tablist"
                    aria-label="Advanced model workbenches"
                    aria-orientation="horizontal"
                  >
                    {ADVANCED_MODEL_SURFACES.map((surface, surfaceIndex) => {
                      const selected = advancedModelSurface === surface.id;
                      const tabId = `project-deck-advanced-tab-${surface.id}`;
                      return (
                        <button
                          key={surface.id}
                          id={tabId}
                          type="button"
                          role="tab"
                          aria-selected={selected}
                          aria-controls="project-deck-advanced-surface-panel"
                          tabIndex={selected ? 0 : -1}
                          className={selected ? "is-active" : ""}
                          title={surface.description}
                          onClick={() => setAdvancedModelSurface(surface.id)}
                          onKeyDown={(event) => {
                            let nextSurfaceIndex: number | null = null;
                            if (event.key === "ArrowRight") {
                              event.preventDefault();
                              nextSurfaceIndex = (surfaceIndex + 1) % ADVANCED_MODEL_SURFACES.length;
                            }
                            if (event.key === "ArrowLeft") {
                              event.preventDefault();
                              nextSurfaceIndex = (surfaceIndex - 1 + ADVANCED_MODEL_SURFACES.length) % ADVANCED_MODEL_SURFACES.length;
                            }
                            if (event.key === "Home") {
                              event.preventDefault();
                              nextSurfaceIndex = 0;
                            }
                            if (event.key === "End") {
                              event.preventDefault();
                              nextSurfaceIndex = ADVANCED_MODEL_SURFACES.length - 1;
                            }
                            if (nextSurfaceIndex === null) return;
                            const nextSurface = ADVANCED_MODEL_SURFACES[nextSurfaceIndex];
                            if (!nextSurface) return;
                            setAdvancedModelSurface(nextSurface.id);
                            document.getElementById(`project-deck-advanced-tab-${nextSurface.id}`)?.focus();
                          }}
                        >
                          <strong>{surface.label}</strong>
                          <small>{surface.description}</small>
                        </button>
                      );
                    })}
                  </div>
                  <div
                    id="project-deck-advanced-surface-panel"
                    className="project-control-deck__advanced-surface-panel"
                    role="tabpanel"
                    aria-labelledby={`project-deck-advanced-tab-${advancedModelSurface}`}
                    tabIndex={0}
                  >
                    {advancedModelSurface === "role-routing" ? (
                      <ProjectDeckLazySurface
                        label="role routing assignments"
                        load={loadRoleRoutingPreview}
                        props={{
                          providers,
                          modelProfileId: preview.modelProfileId,
                          onModelProfileChange: changeModelProfile,
                        }}
                      />
                    ) : null}
                    {advancedModelSurface === "local-readiness" ? (
                      <ProjectDeckLazySurface label="local model readiness" load={loadLocalModelReadinessPreview} props={{}} />
                    ) : null}
                    {advancedModelSurface === "local-catalog" ? (
                      <ProjectDeckLazySurface label="local model catalog" load={loadLocalModelCatalogPreview} props={{}} />
                    ) : null}
                    {advancedModelSurface === "adaptive-learning" ? (
                      <ProjectDeckLazySurface
                        label="adaptive Auto routing and learning"
                        load={loadAdaptiveAutoRoutingLearningPreview}
                        props={{
                          providers,
                          modelProfileId: preview.modelProfileId,
                          onModelProfileChange: changeModelProfile,
                        }}
                      />
                    ) : null}
                    {advancedModelSurface === "agent-dag" ? (
                      <ProjectDeckLazySurface label="agent orchestration DAG" load={loadAgentDagOrchestrationPreview} props={{}} />
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
            <div className="project-control-deck__planned-action" role="status" aria-label="Project policy status"><Settings2 size={15} /><span><strong>Apply project policy</strong><small>Planned — native profile persistence and routing enforcement are not connected to this preview.</small></span><em>Planned</em></div>
            <p className="project-control-deck__boundary"><CircleAlert size={14} /> Provider credentials, routing enforcement, and model discovery are not changed by this preview.</p>
          </div>
        ) : null}

        {activeTab === "access" ? (
          <ProjectWorkspaceGrantPreview project={project} />
        ) : null}

        {activeTab === "twin" ? (
          <ProjectDeckLazySurface
            label="Project Twin evidence"
            load={loadProjectTwinEdgeEvidencePreview}
            props={{ project, conversations: projectConversations }}
          />
        ) : null}

        {activeTab === "handoff" ? (
          <ProjectDeckLazySurface
            label="project handoff"
            load={loadProjectHandoffWorkbench}
            props={{ project, conversations: projectConversations, planSeed: planHandoffSeed }}
          />
        ) : null}
      </div>
    </section>
  );
}
