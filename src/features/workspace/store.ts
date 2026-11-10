import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { normalizeAppearance } from "@/design-system/appearance";
import { desktop, isDesktopRuntime } from "@/lib/desktop";

import { conversationFromNativeSnapshot } from "./conversation-catalog";
import { accentForProject } from "./project-catalog";
import type { CitationView, RunTimelineEventView } from "./evidence-types";
import { isNarrowPanelViewport } from "./panel-layout";
import {
  projectRunJournalPage,
  type RunJournalReplayOptions,
} from "./run-journal-projection";
import type { RunJournalHandoffProjection } from "./run-journal-handoff";
import type { MultimodalBridgePlanProjection } from "./multimodal-bridge-projection";
import type {
  ContinuationIntent,
  MessageRevision,
  RunJournalCursor,
  RunJournalReplayPage,
  RunTelemetrySnapshot,
  RunCheckpointRecord,
} from "@/lib/desktop";

import {
  initialArtifacts,
  initialConversations,
  initialMemories,
  initialProjects,
  initialProviders,
  initialSkills,
} from "./mock-data";
import type {
  ActiveRunView,
  ActivityId,
  AttachmentView,
  ArtifactView,
  ComposerMode,
  ConversationView,
  DensityPreference,
  InspectorTab,
  MemoryView,
  NativeConversationBranchView,
  MotionPreference,
  ParameterSettings,
  ProjectView,
  ProviderView,
  RunStage,
  SkillView,
  ThemePreference,
  WorkspaceFolderView,
} from "./types";
import {
  mergeRunControlProjection,
  projectRunCheckpoint,
  type RunCheckpointProjection,
  type RunControlOperationProjection,
} from "./run-control-projection";

interface StartRunInput {
  conversationId: string;
  runId: string;
  assistantMessageId: string;
  userMessageId: string;
  prompt: string;
  attachments?: AttachmentView[];
  alreadyPersisted?: boolean;
}

interface CreateProjectInput {
  name: string;
  description: string;
  instructions: string;
  modelProfileId: string;
}

/**
 * One-shot renderer navigation intent used by cross-surface previews such as
 * the command palette. It is intentionally not persisted or treated as a
 * native Jump Target record; it only bridges the currently mounted Chat UI.
 */
export interface PendingMessageNavigation {
  readonly conversationId: string;
  readonly messageId: string;
  readonly requestId: number;
}

export interface DraftAttachmentSelectionHydration {
  conversationId: string;
  branchId: string;
  attachmentIds: readonly string[];
}

/**
 * Canonically serializes JSON-like values for immutable replay comparisons.
 * Native IPC may materialize equivalent objects with different property
 * insertion order; that must not be mistaken for payload drift. Arrays keep
 * their semantic order while object keys are sorted recursively.
 */
function stableStructuralSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStructuralSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStructuralSerialize(record[key])}`)
    .join(",")}}`;
}

interface WorkspaceStore {
  activeActivity: ActivityId;
  activeConversationId: string;
  activeProjectId: string;
  /** One-shot renderer navigation context, never persisted as Project policy. */
  settingsProjectId: string | null;
  conversations: ConversationView[];
  attachments: AttachmentView[];
  draftAttachmentIdsByConversation: Record<string, string[]>;
  projects: ProjectView[];
  memories: MemoryView[];
  skills: SkillView[];
  artifacts: ArtifactView[];
  citations: CitationView[];
  runTimelineEvents: RunTimelineEventView[];
  runJournalCursors: Record<string, RunJournalCursor>;
  runJournalEventIds: Record<string, string[]>;
  runJournalCoverage: Record<
    string,
    {
      coverage: RunJournalReplayPage["coverage"];
      reason: string | null;
      handoff?: RunJournalHandoffProjection | null;
    }
  >;
  /** Native-only telemetry projection; intentionally excluded from persisted UI preferences. */
  runTelemetryByRunId: Record<string, RunTelemetrySnapshot>;
  /** Native-owned run-control receipts; transient renderer projections only. */
  runControlOperationsById: Record<string, RunControlOperationProjection>;
  /** Latest checkpoint projection observed for each native run. */
  checkpointsByRunId: Record<string, RunCheckpointProjection>;
  /** Native continuation intents keyed by their immutable intent ID. */
  continuationIntentsById: Record<string, ContinuationIntent>;
  /** Immutable message revisions grouped by message ID for timeline overlays. */
  messageRevisionsByMessageId: Record<string, MessageRevision[]>;
  /**
   * Native-owned, metadata-only bridge planning/execution evidence. It is
   * deliberately transient: SQLite remains authoritative across restart.
   */
  multimodalBridgePlansByRunId: Record<string, MultimodalBridgePlanProjection>;
  providers: ProviderView[];
  modelProfileId: string;
  composerMode: ComposerMode;
  theme: ThemePreference;
  density: DensityPreference;
  motion: MotionPreference;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  commandPaletteOpen: boolean;
  pendingMessageNavigation: PendingMessageNavigation | null;
  activeRun: ActiveRunView | null;
  parameters: ParameterSettings;
  /** Renderer-local snapshots used by the parameter controls. Native request
   * preparation still receives only the current immutable parameter object. */
  parameterUndoStack: ParameterSettings[];
  parameterRedoStack: ParameterSettings[];
  setActivity: (activity: ActivityId) => void;
  openProjectSettings: (projectId: string) => void;
  selectConversation: (conversationId: string) => void;
  selectProject: (projectId: string) => void;
  createConversation: (projectId?: string) => Promise<string>;
  /** Renderer-first Chat lifecycle actions. Native persistence can replace these later. */
  renameConversation: (conversationId: string, title: string) => void;
  /** Marks a Chat as temporary in the renderer projection only. */
  setConversationTemporary: (conversationId: string, temporary: boolean) => void;
  toggleConversationPinned: (conversationId: string) => void;
  setConversationArchived: (conversationId: string, archived: boolean) => void;
  setConversationUnread: (conversationId: string, unread: boolean) => void;
  moveConversationToProject: (conversationId: string, projectId: string | null) => void;
  forkConversationBranch: (messageId: string, name?: string) => Promise<void>;
  /** Selects a native-owned branch after a scoped compare-and-swap. Browser preview cannot activate. */
  activateConversationBranch: (branchId: string) => Promise<void>;
  updateDraft: (draft: string) => void;
  /** Stage a draft only in an empty Chat owned by the expected Project. No send or native write. */
  prepareConversationDraft: (conversationId: string, projectId: string, draft: string) =>
    "prepared" | "missing-chat" | "wrong-project" | "occupied" | "unavailable";
  startRun: (input: StartRunInput) => void;
  setRunStage: (runId: string, stage: RunStage) => void;
  appendRunDelta: (runId: string, text: string) => void;
  finishRun: (runId: string, finishReason: string) => void;
  failRun: (runId: string, message: string) => void;
  setModelProfile: (profileId: string) => void;
  setComposerMode: (mode: ComposerMode) => void;
  setTheme: (theme: ThemePreference) => void;
  setDensity: (density: DensityPreference) => void;
  setMotion: (motion: MotionPreference) => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  closeNarrowPanels: () => void;
  reconcileNarrowPanels: () => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  requestMessageNavigation: (conversationId: string, messageId: string) => void;
  clearMessageNavigation: (requestId?: number) => void;
  setParameter: <K extends keyof ParameterSettings>(key: K, value: ParameterSettings[K]) => void;
  resetParameter: <K extends keyof ParameterSettings>(key: K) => void;
  replaceParameters: (parameters: Partial<ParameterSettings>) => void;
  undoParameterChange: () => void;
  redoParameterChange: () => void;
  resetParameters: () => void;
  createProject: (input: CreateProjectInput) => string;
  addProject: (project: ProjectView) => void;
  replaceProjects: (projects: ProjectView[]) => void;
  /** Applies a native project record or a renderer-only metadata preview. */
  patchProjectMetadata: (
    projectId: string,
    metadata: Pick<ProjectView, "name" | "description" | "instructions">,
    nativeUpdatedAtMs?: number,
  ) => void;
  addWorkspaceFolder: (projectId: string, folder: WorkspaceFolderView) => void;
  /** Merge native index/grant metadata into one project folder projection. */
  patchWorkspaceFolder: (
    projectId: string,
    folderId: string,
    patch: Partial<WorkspaceFolderView>,
  ) => void;
  /** Remove a folder projection after a native grant is revoked. */
  removeWorkspaceFolder: (projectId: string, folderId: string) => void;
  addProvider: (provider: ProviderView) => void;
  replaceProviders: (providers: ProviderView[]) => void;
  updateProvider: (providerId: string, patch: Partial<ProviderView>) => void;
  removeProvider: (providerId: string) => void;
  replaceConversations: (conversations: ConversationView[]) => void;
  /**
   * Insert or replace a conversation. `activate` (default true) also selects it
   * and its project; pass false to patch a conversation without moving the
   * user's current selection.
   */
  upsertConversation: (conversation: ConversationView, activate?: boolean) => void;
  replaceAttachments: (attachments: AttachmentView[]) => void;
  hydrateDraftAttachmentSelections: (
    selections: readonly DraftAttachmentSelectionHydration[],
  ) => void;
  replaceCitations: (citations: CitationView[]) => void;
  replaceRunTimelineEvents: (events: RunTimelineEventView[]) => void;
  applyRunJournalPage: (page: RunJournalReplayPage, options?: RunJournalReplayOptions) => void;
  setRunJournalHandoff: (runId: string, handoff: RunJournalHandoffProjection | null) => void;
  upsertRunTelemetry: (snapshot: RunTelemetrySnapshot) => void;
  upsertRunControlOperation: (projection: RunControlOperationProjection) => void;
  upsertRunCheckpoint: (record: RunCheckpointRecord) => void;
  upsertContinuationIntent: (intent: ContinuationIntent) => void;
  upsertMessageRevision: (revision: MessageRevision) => void;
  upsertMultimodalBridgePlan: (projection: MultimodalBridgePlanProjection) => void;
  upsertAttachment: (attachment: AttachmentView) => void;
  removeAttachment: (attachmentId: string) => void;
  attachDraftAttachment: (conversationId: string, attachmentId: string) => void;
  detachDraftAttachment: (conversationId: string, attachmentId: string) => void;
  clearDraftAttachments: (conversationId: string) => void;
  prepareDesktopPreview: () => void;
}

const defaultParameters: ParameterSettings = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  minP: 0,
  maxOutputTokens: 4096,
  reasoningEffort: "medium",
  reasoningBudgetTokens: null,
  frequencyPenalty: 0,
  presencePenalty: 0,
  seed: null,
  stopSequences: "",
  streaming: true,
  jsonMode: false,
  jsonSchema: "",
  logprobs: false,
  topLogprobs: 0,
  parallelToolCalls: true,
  promptCaching: true,
  toolChoice: "auto",
  serviceTier: "auto",
  timeoutMs: 120000,
  maxRetries: 2,
  providerExtensions: "{}",
};

const MAX_PARAMETER_HISTORY = 50;

let nextMessageNavigationRequestId = 0;

function cloneParameterSettings(parameters: ParameterSettings): ParameterSettings {
  return { ...parameters };
}

function parameterSettingsEqual(left: ParameterSettings, right: ParameterSettings): boolean {
  return (Object.keys(defaultParameters) as Array<keyof ParameterSettings>).every(
    (key) => Object.is(left[key], right[key]),
  );
}

function pushParameterSnapshot(
  state: Pick<WorkspaceStore, "parameters" | "parameterUndoStack" | "parameterRedoStack">,
  next: ParameterSettings,
): Pick<WorkspaceStore, "parameters" | "parameterUndoStack" | "parameterRedoStack"> {
  if (parameterSettingsEqual(state.parameters, next)) {
    return {
      parameters: state.parameters,
      parameterUndoStack: state.parameterUndoStack,
      parameterRedoStack: state.parameterRedoStack,
    };
  }
  return {
    parameters: next,
    parameterUndoStack: [
      ...state.parameterUndoStack,
      cloneParameterSettings(state.parameters),
    ].slice(-MAX_PARAMETER_HISTORY),
    parameterRedoStack: [],
  };
}

const unavailablePreferenceStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

function preferenceStorage(): StateStorage {
  if (
    import.meta.env.DEV &&
    typeof globalThis.location !== "undefined" &&
    globalThis.location.pathname === "/__visual"
  ) {
    return unavailablePreferenceStorage;
  }
  try {
    return globalThis.localStorage ?? unavailablePreferenceStorage;
  } catch {
    return unavailablePreferenceStorage;
  }
}

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid.replaceAll("-", "")}`;
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${value}`;
}

function titleFromPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (compact.length <= 44) return compact;
  return `${compact.slice(0, 43).trimEnd()}…`;
}

/**
 * Bridge receipts are immutable native facts. A delayed metadata read must
 * never erase receipts the renderer has already observed, especially an
 * `outcome-unknown` receipt that disables blind retry. A successor plan wins
 * its predecessor explicitly; otherwise the latest durable plan is chosen
 * deterministically.
 */
function shouldReplaceMultimodalBridgeProjection(
  current: MultimodalBridgePlanProjection,
  incoming: MultimodalBridgePlanProjection,
): boolean {
  if (current.planId === incoming.planId) {
    if (
      current.planSha256 !== incoming.planSha256 ||
      current.sourceManifestSha256 !== incoming.sourceManifestSha256 ||
      current.runId !== incoming.runId ||
      current.attemptId !== incoming.attemptId
    ) {
      // A native plan is immutable. Refuse an internally inconsistent update
      // rather than let the renderer reinterpret the same opaque plan ID.
      return false;
    }
    const incomingReceiptIds = new Set(incoming.stageReceipts.map((receipt) => receipt.receiptId));
    return current.stageReceipts.every((receipt) => incomingReceiptIds.has(receipt.receiptId));
  }
  if (incoming.supersedesPlanId === current.planId) return true;
  if (current.supersedesPlanId === incoming.planId) return false;
  if (incoming.createdAtMs !== current.createdAtMs) {
    return incoming.createdAtMs > current.createdAtMs;
  }
  return incoming.planId.localeCompare(current.planId) > 0;
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      activeActivity: "chats",
      activeConversationId: "conversation-harness",
      activeProjectId: "project-omnia",
      settingsProjectId: null,
      conversations: initialConversations,
      attachments: initialConversations.flatMap((conversation) =>
        conversation.messages.flatMap((message) => message.attachments),
      ),
      draftAttachmentIdsByConversation: {},
      projects: initialProjects,
      memories: initialMemories,
      skills: initialSkills,
      artifacts: initialArtifacts,
      citations: [],
      runTimelineEvents: [],
      runJournalCursors: {},
      runJournalEventIds: {},
      runJournalCoverage: {},
      runTelemetryByRunId: {},
      runControlOperationsById: {},
      checkpointsByRunId: {},
      continuationIntentsById: {},
      messageRevisionsByMessageId: {},
      multimodalBridgePlansByRunId: {},
      providers: initialProviders,
      modelProfileId: "auto",
      composerMode: "ask",
      theme: "system",
      density: "comfortable",
      motion: "system",
      sidebarOpen: true,
      // Keep Chat focused on the transcript and composer on first launch.
      // The inspector remains one click away from the Chat toolbar/workbench.
      inspectorOpen: false,
      inspectorTab: "context",
      commandPaletteOpen: false,
      pendingMessageNavigation: null,
      activeRun: null,
      parameters: cloneParameterSettings(defaultParameters),
      parameterUndoStack: [],
      parameterRedoStack: [],

      setActivity: (activity) =>
        set({
          activeActivity: activity,
          settingsProjectId: null,
          ...(isNarrowPanelViewport() ? { sidebarOpen: false, inspectorOpen: false } : {}),
        }),

      openProjectSettings: (projectId) =>
        set((state) => ({
          activeActivity: "settings",
          settingsProjectId: state.projects.some((project) => project.id === projectId) ? projectId : null,
          ...(isNarrowPanelViewport() ? { sidebarOpen: false, inspectorOpen: false } : {}),
        })),

      selectConversation: (conversationId) =>
        set((state) => {
          const selected = state.conversations.find((conversation) => conversation.id === conversationId);
          return {
            activeActivity: "chats",
            settingsProjectId: null,
            activeConversationId: conversationId,
            ...(selected ? { activeProjectId: selected.projectId ?? "" } : {}),
            ...(isNarrowPanelViewport() ? { sidebarOpen: false, inspectorOpen: false } : {}),
            conversations: state.conversations.map((conversation) =>
              conversation.id === conversationId ? { ...conversation, unread: false } : conversation,
            ),
          };
        }),

      requestMessageNavigation: (conversationId, messageId) =>
        set((state) => {
          const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
          // Fail closed when a palette result is stale or forged. A missing
          // anchor must never silently jump to another message.
          if (!conversation || !conversation.messages.some((message) => message.id === messageId)) {
            return state;
          }
          nextMessageNavigationRequestId += 1;
          return {
            pendingMessageNavigation: {
              conversationId,
              messageId,
              requestId: nextMessageNavigationRequestId,
            },
          };
        }),

      clearMessageNavigation: (requestId) =>
        set((state) => {
          const pending = state.pendingMessageNavigation;
          if (!pending || (requestId !== undefined && pending.requestId !== requestId)) return state;
          return { pendingMessageNavigation: null };
        }),

      selectProject: (projectId) =>
        set({
          activeActivity: "projects",
          activeProjectId: projectId,
          settingsProjectId: null,
          ...(isNarrowPanelViewport() ? { sidebarOpen: false, inspectorOpen: false } : {}),
        }),

      renameConversation: (conversationId, title) => {
        const nextTitle = title.trim();
        if (!nextTitle) return;
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId ? { ...conversation, title: nextTitle } : conversation,
          ),
        }));
      },

      setConversationTemporary: (conversationId, temporary) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) => {
            if (conversation.id !== conversationId) return conversation;
            if (temporary) return { ...conversation, temporary: true };
            if (!conversation.temporary) return conversation;
            const next = { ...conversation };
            delete next.temporary;
            return next;
          }),
        })),

      toggleConversationPinned: (conversationId) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId
              ? { ...conversation, pinned: !conversation.pinned }
              : conversation,
          ),
        })),

      setConversationArchived: (conversationId, archived) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId &&
            !(archived && conversation.runState === "streaming")
              ? { ...conversation, archived, unread: archived ? false : conversation.unread }
              : conversation,
          ),
        })),

      setConversationUnread: (conversationId, unread) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId ? { ...conversation, unread } : conversation,
          ),
        })),

      moveConversationToProject: (conversationId, projectId) =>
        set((state) => {
          if (projectId !== null && !state.projects.some((candidate) => candidate.id === projectId)) {
            return state;
          }
          const project = projectId ? state.projects.find((candidate) => candidate.id === projectId) : null;
          // Keep every caller fail-closed, including command-palette/library paths
          // that do not pass through the sidebar's destination picker. A Project
          // without workspace access or an archived Project must never become Chat
          // ownership. The optional archived flag is omitted by older/browser
          // projections, which continue to mean active.
          if (project?.contextHealth === "missing-access" || project?.archived === true) {
            return state;
          }
          return {
            ...(state.activeConversationId === conversationId
              ? { activeProjectId: project?.id ?? "" }
              : {}),
            conversations: state.conversations.map((conversation) =>
              conversation.id === conversationId
                ? {
                    ...conversation,
                    projectId: project?.id ?? null,
                    projectName: project?.name ?? null,
                  }
                : conversation,
            ),
          };
        }),

      createConversation: async (projectId) => {
        if (isDesktopRuntime()) {
          const snapshot = await desktop.createConversation(projectId);
          const projectRecords = get().projects.map((project) => ({
            id: project.id,
            name: project.name,
          }));
          const conversation = conversationFromNativeSnapshot(snapshot, projectRecords);
          const closeTemporaryPanels = isNarrowPanelViewport();
          set((state) => ({
            activeActivity: "chats",
            activeConversationId: conversation.id,
            activeProjectId: conversation.projectId ?? "",
            ...(closeTemporaryPanels ? { sidebarOpen: false, inspectorOpen: false } : {}),
            conversations: [
              conversation,
              ...state.conversations.filter((candidate) => candidate.id !== conversation.id),
            ],
          }));
          return conversation.id;
        }
        const id = createId("conversation");
        const branchId = createId("branch");
        const closeTemporaryPanels = isNarrowPanelViewport();
        const project = projectId ? get().projects.find((item) => item.id === projectId) : null;
        const conversation: ConversationView = {
          id,
          activeBranchId: branchId,
          title: "Untitled conversation",
          excerpt: "Start a new conversation",
          updatedAt: new Date().toISOString(),
          updatedLabel: "Now",
          projectId: project?.id ?? null,
          projectName: project?.name ?? null,
          pinned: false,
          archived: false,
          hasDraft: false,
          unread: false,
          runState: null,
          draft: "",
          messages: [],
        };
        set((state) => ({
          activeActivity: "chats",
          activeConversationId: id,
          activeProjectId: project?.id ?? "",
          ...(closeTemporaryPanels ? { sidebarOpen: false, inspectorOpen: false } : {}),
          conversations: [conversation, ...state.conversations],
        }));
        return id;
      },

      forkConversationBranch: async (messageId, name) => {
        const state = get();
        const conversation = state.conversations.find(
          (candidate) => candidate.id === state.activeConversationId,
        );
        if (!conversation) {
          throw new Error("Select a conversation before creating a branch.");
        }
        const message = conversation.messages.find((candidate) => candidate.id === messageId);
        if (!message || message.status === "streaming") {
          throw new Error("A branch can only start from a completed message.");
        }
        if (!isDesktopRuntime()) {
          const nextBranchCount = Math.max(2, (message.branchCount || 1) + 1);
          const newBranchId = `${conversation.id}_branch_${nextBranchCount}`;
          const branchName = name?.trim() || `Branch ${nextBranchCount}`;
          const existingNativeBranches = conversation.nativeBranches ?? [
            {
              id: conversation.activeBranchId,
              name: "main",
              parentBranchId: null,
              forkedFromMessageId: null,
              createdAtMs: Date.now(),
            },
          ];
          const updatedNativeBranches: NativeConversationBranchView[] = [
            ...existingNativeBranches,
            {
              id: newBranchId,
              name: branchName,
              parentBranchId: conversation.activeBranchId,
              forkedFromMessageId: messageId,
              createdAtMs: Date.now(),
            },
          ];
          get().upsertConversation(
            {
              ...conversation,
              activeBranchId: newBranchId,
              nativeBranches: updatedNativeBranches,
              messages: conversation.messages.map((m) =>
                m.id === messageId
                  ? { ...m, branchCount: nextBranchCount, branchIndex: nextBranchCount }
                  : m,
              ),
            },
            false,
          );
          return;
        }
        const snapshot = await desktop.forkConversationBranch({
          conversationId: conversation.id,
          parentBranchId: conversation.activeBranchId,
          forkedFromMessageId: messageId,
          ...(name?.trim() ? { name: name.trim() } : {}),
          activate: true,
        });
        const projectRecords = get().projects.map((project) => ({
          id: project.id,
          name: project.name,
        }));
        const next = conversationFromNativeSnapshot(
          snapshot,
          projectRecords,
          get().providers,
          get().attachments,
        );
        get().upsertConversation(next);
      },

      activateConversationBranch: async (branchId) => {
        const state = get();
        const conversation = state.conversations.find(
          (candidate) => candidate.id === state.activeConversationId,
        );
        if (!conversation || !isDesktopRuntime()) {
          throw new Error("Branch activation requires a selected native desktop Chat.");
        }
        if (!conversation.nativeBranches?.some((branch) => branch.id === branchId)) {
          throw new Error("This branch is not present in the native Chat snapshot. Refresh before switching.");
        }
        if (branchId === conversation.activeBranchId) return;
        if (conversation.draft.trim() || (state.draftAttachmentIdsByConversation[conversation.id]?.length ?? 0) > 0) {
          throw new Error("Clear the unsent draft and attachments before switching branches.");
        }
        if (conversation.runState === "streaming" || (
          state.activeRun?.conversationId === conversation.id
          && !["complete", "stopped", "failed"].includes(state.activeRun.stage)
        )) {
          throw new Error("Wait for the active run to finish before switching branches.");
        }
        const snapshot = await desktop.activateConversationBranch({
          conversationId: conversation.id,
          branchId,
          expectedActiveBranchId: conversation.activeBranchId,
        });
        if (snapshot.conversation.id !== conversation.id || snapshot.conversation.activeBranchId !== branchId) {
          throw new Error("The native branch response did not match the requested Chat and branch.");
        }
        const projects = get().projects.map((project) => ({ id: project.id, name: project.name }));
        const next = conversationFromNativeSnapshot(snapshot, projects, get().providers, get().attachments);
        set((current) => {
          const draftAttachmentIdsByConversation = { ...current.draftAttachmentIdsByConversation };
          delete draftAttachmentIdsByConversation[conversation.id];
          return {
            conversations: current.conversations.map((candidate) =>
              candidate.id === conversation.id ? next : candidate,
            ),
            draftAttachmentIdsByConversation,
            activeRun: current.activeRun?.conversationId === conversation.id ? null : current.activeRun,
          };
        });
      },

      updateDraft: (draft) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === state.activeConversationId
              ? { ...conversation, draft, hasDraft: draft.trim().length > 0 }
              : conversation,
          ),
        })),

      prepareConversationDraft: (conversationId, projectId, draft) => {
        let result: "prepared" | "missing-chat" | "wrong-project" | "occupied" | "unavailable" = "missing-chat";
        if (!draft.trim()) return "unavailable";
        set((state) => {
          const conversation = state.conversations.find((item) => item.id === conversationId);
          if (!conversation) return state;
          if (conversation.projectId !== projectId) {
            result = "wrong-project";
            return state;
          }
          if (!state.projects.some((project) => project.id === projectId && project.archived !== true)) {
            result = "unavailable";
            return state;
          }
          if (conversation.archived || conversation.runState !== null) {
            result = "unavailable";
            return state;
          }
          if (conversation.draft.trim() || conversation.hasDraft) {
            result = "occupied";
            return state;
          }
          result = "prepared";
          return {
            conversations: state.conversations.map((item) =>
              item.id === conversationId ? { ...item, draft, hasDraft: true } : item,
            ),
          };
        });
        return result;
      },

      startRun: ({
        conversationId,
        runId,
        assistantMessageId,
        userMessageId,
        prompt,
        attachments: selectedAttachments = [],
        alreadyPersisted,
      }) =>
        set((state) => {
          const targetConversation = state.conversations.find(
            (conversation) => conversation.id === conversationId,
          );
          if (!targetConversation) return state;

          const now = new Date().toISOString();
          const selectedAttachmentIds = new Set(
            selectedAttachments.map((attachment) => attachment.id),
          );
          const attachments = state.attachments.map((attachment) =>
            selectedAttachmentIds.has(attachment.id)
              ? { ...attachment, messageId: userMessageId }
              : attachment,
          );
          const draftAttachmentIdsByConversation = {
            ...state.draftAttachmentIdsByConversation,
          };
          if (selectedAttachments.length > 0) {
            delete draftAttachmentIdsByConversation[conversationId];
          }
          return {
            activeRun: {
              id: runId,
              conversationId,
              assistantMessageId,
              stage: "preparing-context",
              startedAt: now,
            },
            attachments,
            draftAttachmentIdsByConversation,
            conversations: state.conversations.map((conversation) => {
              if (conversation.id !== conversationId) return conversation;
              const isUntitled = conversation.title === "Untitled conversation";
              return {
                ...conversation,
                title: isUntitled ? titleFromPrompt(prompt) : conversation.title,
                excerpt: prompt.replace(/\s+/g, " ").slice(0, 90),
                updatedAt: now,
                updatedLabel: "Now",
                draft: "",
                hasDraft: false,
                runState: "streaming",
                messages: alreadyPersisted
                  ? conversation.messages
                  : [
                      ...conversation.messages,
                      {
                        id: userMessageId,
                        role: "user",
                        content: prompt,
                        createdAt: now,
                        status: "complete",
                        modelLabel: null,
                        runId: null,
                        attachments: selectedAttachments.map((attachment) => ({
                          ...attachment,
                          messageId: userMessageId,
                        })),
                        branchIndex: 1,
                        branchCount: 1,
                      },
                      {
                        id: assistantMessageId,
                        role: "assistant",
                        content: "",
                        createdAt: now,
                        status: "streaming",
                        modelLabel:
                          state.modelProfileId === "auto" ? "Auto · Quality route" : "Selected model",
                        runId,
                        attachments: [],
                        branchIndex: 1,
                        branchCount: 1,
                      },
                    ],
              };
            }),
          };
        }),

      setRunStage: (runId, stage) =>
        set((state) =>
          state.activeRun?.id === runId
            ? { activeRun: { ...state.activeRun, stage } }
            : state,
        ),

      appendRunDelta: (runId, text) =>
        set((state) => ({
          activeRun:
            state.activeRun?.id === runId ? { ...state.activeRun, stage: "writing" } : state.activeRun,
          conversations: state.conversations.map((conversation) => ({
            ...conversation,
            messages: conversation.messages.map((message) =>
              message.runId === runId ? { ...message, content: `${message.content}${text}` } : message,
            ),
          })),
        })),

      finishRun: (runId, finishReason) =>
        set((state) => ({
          activeRun: state.activeRun?.id === runId ? null : state.activeRun,
          conversations: state.conversations.map((conversation) => ({
            ...conversation,
            runState: conversation.messages.some((message) => message.runId === runId)
              ? null
              : conversation.runState,
            messages: conversation.messages.map((message) =>
              message.runId === runId
                ? { ...message, status: finishReason === "cancelled" ? "stopped" : "complete" }
                : message,
            ),
          })),
        })),

      failRun: (runId, message) =>
        set((state) => ({
          activeRun: state.activeRun?.id === runId ? null : state.activeRun,
          conversations: state.conversations.map((conversation) => ({
            ...conversation,
            runState: conversation.messages.some((item) => item.runId === runId)
              ? "failed"
              : conversation.runState,
            messages: conversation.messages.map((item) =>
              item.runId === runId
                ? {
                    ...item,
                    status: "failed",
                    content: item.content || `The run could not start. ${message}`,
                  }
                : item,
            ),
          })),
        })),

      setModelProfile: (modelProfileId) => set({ modelProfileId }),
      setComposerMode: (composerMode) => set({ composerMode }),
      setTheme: (theme) => set((state) => ({ theme: normalizeAppearance({ ...state, theme }).theme })),
      setDensity: (density) => set((state) => ({ density: normalizeAppearance({ ...state, density }).density })),
      setMotion: (motion) => set((state) => ({ motion: normalizeAppearance({ ...state, motion }).motion })),
      toggleSidebar: () =>
        set((state) => {
          const opening = !state.sidebarOpen;
          const narrow = isNarrowPanelViewport();
          return {
            sidebarOpen: opening,
            ...(opening && narrow ? { inspectorOpen: false } : {}),
          };
        }),
      toggleInspector: () =>
        set((state) => {
          const opening = !state.inspectorOpen;
          const narrow = isNarrowPanelViewport();
          return {
            inspectorOpen: opening,
            ...(opening && narrow ? { sidebarOpen: false } : {}),
          };
        }),
      closeNarrowPanels: () => set({ sidebarOpen: false, inspectorOpen: false }),
      reconcileNarrowPanels: () =>
        set((state) => {
          const narrow = isNarrowPanelViewport();
          if (!narrow) return state;
          // A single open panel is an intentional temporary drawer state and
          // must survive the first responsive reconciliation (including
          // deep-linked/visual overlay fixtures). Only resolve an impossible
          // two-panel state created by persistence or a viewport resize.
          if (!state.sidebarOpen || !state.inspectorOpen) return state;
          return state.activeActivity === "chats"
            ? { sidebarOpen: false }
            : { inspectorOpen: false };
        }),
      setInspectorTab: (inspectorTab) =>
        set({
          inspectorTab,
          inspectorOpen: true,
          ...(isNarrowPanelViewport() ? { sidebarOpen: false } : {}),
        }),
      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      setParameter: (key, value) =>
        set((state) =>
          pushParameterSnapshot(state, {
            ...state.parameters,
            [key]: value,
          }),
        ),
      resetParameter: (key) =>
        set((state) =>
          pushParameterSnapshot(state, {
            ...state.parameters,
            [key]: defaultParameters[key],
          }),
        ),
      replaceParameters: (parameters) =>
        set((state) =>
          pushParameterSnapshot(state, {
            ...state.parameters,
            ...parameters,
          }),
        ),
      undoParameterChange: () =>
        set((state) => {
          const previous = state.parameterUndoStack[state.parameterUndoStack.length - 1];
          if (!previous) return state;
          return {
            parameters: cloneParameterSettings(previous),
            parameterUndoStack: state.parameterUndoStack.slice(0, -1),
            parameterRedoStack: [
              ...state.parameterRedoStack,
              cloneParameterSettings(state.parameters),
            ].slice(-MAX_PARAMETER_HISTORY),
          };
        }),
      redoParameterChange: () =>
        set((state) => {
          const next = state.parameterRedoStack[state.parameterRedoStack.length - 1];
          if (!next) return state;
          return {
            parameters: cloneParameterSettings(next),
            parameterUndoStack: [
              ...state.parameterUndoStack,
              cloneParameterSettings(state.parameters),
            ].slice(-MAX_PARAMETER_HISTORY),
            parameterRedoStack: state.parameterRedoStack.slice(0, -1),
          };
        }),
      resetParameters: () =>
        set((state) => pushParameterSnapshot(state, cloneParameterSettings(defaultParameters))),
      createProject: (input) => {
        const id = createId("project");
        const project: ProjectView = {
          id,
          name: input.name,
          description: input.description,
          accent: accentForProject(id),
          instructions: input.instructions,
          modelProfileId: input.modelProfileId,
          conversationCount: 0,
          contextHealth: "not-compiled",
          pinned: false,
          folders: [],
        };
        set((state) => ({
          projects: [project, ...state.projects],
          activeActivity: "projects",
          activeProjectId: id,
        }));
        return id;
      },
      addProject: (project) =>
        set((state) => ({
          projects: [project, ...state.projects.filter((item) => item.id !== project.id)],
          activeActivity: "projects",
          activeProjectId: project.id,
        })),
      replaceProjects: (projects) =>
        set((state) => ({
          projects,
          activeProjectId: projects.some((project) => project.id === state.activeProjectId)
            ? state.activeProjectId
            : (projects[0]?.id ?? ""),
          // A native refresh can remove a Project while Settings is open.
          // Never retain a renderer-only permission context for an absent ID.
          settingsProjectId: projects.some((project) => project.id === state.settingsProjectId)
            ? state.settingsProjectId
            : null,
        })),
      patchProjectMetadata: (projectId, metadata, nativeUpdatedAtMs) =>
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  name: metadata.name,
                  description: metadata.description,
                  instructions: metadata.instructions,
                  ...(nativeUpdatedAtMs === undefined ? {} : { nativeUpdatedAtMs }),
                  ...(project.overview
                    ? {
                        overview: {
                          ...project.overview,
                          title: metadata.name || null,
                          summary: metadata.description || null,
                        },
                      }
                    : {}),
                }
              : project,
          ),
        })),
      addWorkspaceFolder: (projectId, folder) =>
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  folders: [folder, ...project.folders.filter((item) => item.id !== folder.id)],
                  contextHealth: "not-compiled",
                }
              : project,
          ),
        })),
      patchWorkspaceFolder: (projectId, folderId, patch) =>
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  folders: project.folders.map((folder) =>
                    folder.id === folderId ? { ...folder, ...patch, id: folder.id } : folder,
                  ),
                }
              : project,
          ),
        })),
      removeWorkspaceFolder: (projectId, folderId) =>
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  folders: project.folders.filter((folder) => folder.id !== folderId),
                  contextHealth: "not-compiled",
                }
              : project,
          ),
        })),
      addProvider: (provider) =>
        set((state) => ({ providers: [provider, ...state.providers] })),
      replaceProviders: (providers) => set({ providers }),
      updateProvider: (providerId, patch) =>
        set((state) => ({
          providers: state.providers.map((provider) =>
            provider.id === providerId ? { ...provider, ...patch } : provider,
          ),
        })),
      removeProvider: (providerId) =>
        set((state) => ({ providers: state.providers.filter((provider) => provider.id !== providerId) })),
      replaceConversations: (conversations) =>
        set((state) => {
          const branchesByConversation = new Map(
            conversations.map((conversation) => [conversation.id, conversation.activeBranchId]),
          );
          const draftEntries = Object.entries(state.draftAttachmentIdsByConversation).filter(
            ([conversationId]) => {
              const previous = state.conversations.find((conversation) => conversation.id === conversationId);
              const nextBranchId = branchesByConversation.get(conversationId);
              return (
                previous !== undefined &&
                nextBranchId !== undefined &&
                previous.activeBranchId === nextBranchId
              );
            },
          );
          const activeConversationId = conversations.some(
            (conversation) => conversation.id === state.activeConversationId,
          )
            ? state.activeConversationId
            : (conversations[0]?.id ?? "");
          const activeConversation = conversations.find(
            (conversation) => conversation.id === activeConversationId,
          );
          return {
            conversations,
            activeConversationId,
            activeProjectId:
              state.activeActivity === "chats"
                ? (activeConversation?.projectId ?? "")
                : state.activeProjectId,
            activeRun: null,
            draftAttachmentIdsByConversation: Object.fromEntries(draftEntries),
          };
        }),
      upsertConversation: (conversation, activate = true) =>
        set((state) => {
          const previous = state.conversations.find((candidate) => candidate.id === conversation.id);
          const draftAttachmentIdsByConversation = {
            ...state.draftAttachmentIdsByConversation,
          };
          if (previous && previous.activeBranchId !== conversation.activeBranchId) {
            delete draftAttachmentIdsByConversation[conversation.id];
          }
          if (!activate) {
            return {
              conversations: previous
                ? state.conversations.map((candidate) =>
                    candidate.id === conversation.id ? conversation : candidate,
                  )
                : [conversation, ...state.conversations],
              draftAttachmentIdsByConversation,
            };
          }
          return {
            activeActivity: "chats",
            activeConversationId: conversation.id,
            activeProjectId: conversation.projectId ?? "",
            conversations: [
              conversation,
              ...state.conversations.filter((candidate) => candidate.id !== conversation.id),
            ],
            draftAttachmentIdsByConversation,
          };
        }),
      replaceAttachments: (attachments) =>
        set((state) => {
          const active = attachments
            .filter(
              (attachment) =>
                attachment.deletedAt === null || attachment.deletedAt === undefined,
            )
            .reduce<Map<string, AttachmentView>>((catalog, attachment) => {
              catalog.set(attachment.id, attachment);
              return catalog;
            }, new Map());
          const sorted = [...active.values()].sort(
            (left, right) =>
              (right.createdAt ?? "").localeCompare(left.createdAt ?? "") ||
              left.id.localeCompare(right.id),
          );
          const availableIds = new Set(sorted.map((attachment) => attachment.id));
          const draftEntries = Object.entries(state.draftAttachmentIdsByConversation)
            .map(([conversationId, attachmentIds]): [string, string[]] => [
              conversationId,
              attachmentIds.filter((attachmentId) => availableIds.has(attachmentId)),
            ])
            .filter((entry) => entry[1].length > 0);
          return {
            attachments: sorted,
            draftAttachmentIdsByConversation: Object.fromEntries(draftEntries),
          };
        }),
      hydrateDraftAttachmentSelections: (selections) =>
        set((state) => {
          const availableIds = new Set(
            state.attachments
              .filter(
                (attachment) =>
                  attachment.deletedAt === null || attachment.deletedAt === undefined,
              )
              .map((attachment) => attachment.id),
          );
          const currentBranches = new Map(
            state.conversations.map((conversation) => [conversation.id, conversation.activeBranchId]),
          );
          const next = { ...state.draftAttachmentIdsByConversation };
          for (const selection of selections) {
            const activeBranchId = currentBranches.get(selection.conversationId);
            if (activeBranchId !== selection.branchId) {
              delete next[selection.conversationId];
              continue;
            }
            const ids = [...new Set(selection.attachmentIds)].filter((attachmentId) =>
              availableIds.has(attachmentId),
            );
            if (ids.length > 0) next[selection.conversationId] = ids;
            else delete next[selection.conversationId];
          }
          return { draftAttachmentIdsByConversation: next };
        }),
      replaceCitations: (citations) =>
        set({
          citations: [...citations].sort(
            (left, right) =>
              left.messageId.localeCompare(right.messageId) ||
              left.displayIndex - right.displayIndex ||
              left.id.localeCompare(right.id),
          ),
        }),
      replaceRunTimelineEvents: (runTimelineEvents) =>
        set({
          runTimelineEvents: [...runTimelineEvents].sort(
            (left, right) =>
              left.runId.localeCompare(right.runId) ||
              left.sequence - right.sequence ||
              left.id.localeCompare(right.id),
          ),
        }),
      setRunJournalHandoff: (runId, handoff) =>
        set((state) => {
          const current = state.runJournalCoverage[runId];
          if (!current && handoff === null) return state;
          if (!current) {
            return {
              runJournalCoverage: {
                ...state.runJournalCoverage,
                [runId]: {
                  coverage: "legacy-partial",
                  reason: "A live journal notification was observed before fixed-watermark replay.",
                  handoff,
                },
              },
            };
          }
          if (current.handoff === handoff) return state;
          return {
            runJournalCoverage: {
              ...state.runJournalCoverage,
              [runId]: { ...current, handoff },
            },
          };
        }),
      applyRunJournalPage: (page, options = {}) =>
        set((state) => {
          const previousEpoch = state.runJournalCursors[page.runId]?.journalEpoch;
          const epochChanged = previousEpoch !== undefined && previousEpoch !== page.journalEpoch;
          const knownEventIds = new Set(
            epochChanged ? [] : state.runJournalEventIds[page.runId] ?? [],
          );
          const unseenEvents = page.events.filter((event) => !knownEventIds.has(event.id));
          const projection = projectRunJournalPage(
            { ...page, events: unseenEvents },
            options,
          );
          const existingTimeline = epochChanged
            ? state.runTimelineEvents.filter((event) => event.runId !== page.runId)
            : state.runTimelineEvents.filter((event) => event.runId !== page.runId);
          const timelineEvents = [
            ...existingTimeline,
            ...(epochChanged
              ? projection.timelineEvents
              : [
                  ...state.runTimelineEvents.filter((event) => event.runId === page.runId),
                  ...projection.timelineEvents,
                ]),
          ];
          const eventIds = [
            ...(epochChanged ? [] : state.runJournalEventIds[page.runId] ?? []),
            ...unseenEvents.map((event) => event.id),
          ];
          const dedupedEventIds = [...new Set(eventIds)];
          let conversations = state.conversations;
          const shouldApplyText = options.baseline !== true;
          if (shouldApplyText && projection.textDeltas.length > 0) {
            const text = projection.textDeltas.join("");
            conversations = conversations.map((conversation) => ({
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.runId === page.runId
                  ? { ...message, content: `${message.content}${text}`, status: "streaming" as const }
                  : message,
              ),
            }));
          }
          let activeRun = state.activeRun;
          if (projection.terminal) {
            const terminal = projection.terminal;
            conversations = conversations.map((conversation) => ({
              ...conversation,
              runState: conversation.messages.some((message) => message.runId === page.runId)
                ? terminal.kind === "failed"
                  ? "failed"
                  : null
                : conversation.runState,
              messages: conversation.messages.map((message) => {
                if (message.runId !== page.runId) return message;
                if (terminal.kind === "failed") {
                  return {
                    ...message,
                    status: "failed" as const,
                    content: message.content || `The run could not complete. ${terminal.errorCode}`,
                  };
                }
                return {
                  ...message,
                  status: terminal.kind === "cancelled" ? ("stopped" as const) : ("complete" as const),
                };
              }),
            }));
            if (activeRun?.id === page.runId) activeRun = null;
          } else if (activeRun === null) {
            const owner = conversations.find((conversation) =>
              conversation.messages.some(
                (message) => message.runId === page.runId && message.status === "streaming",
              ),
            );
            const assistant = owner?.messages.find(
              (message) => message.runId === page.runId && message.role === "assistant",
            );
            if (owner && assistant) {
              const firstEvent = unseenEvents[0];
              activeRun = {
                id: page.runId,
                conversationId: owner.id,
                assistantMessageId: assistant.id,
                stage: "writing",
                startedAt: firstEvent
                  ? new Date(firstEvent.occurredAtMs).toISOString()
                  : new Date().toISOString(),
              };
            }
          }
          return {
            conversations,
            activeRun,
            runTimelineEvents: timelineEvents.sort(
              (left, right) =>
                left.runId.localeCompare(right.runId) ||
                left.sequence - right.sequence ||
                left.id.localeCompare(right.id),
            ),
            runJournalCursors: {
              ...state.runJournalCursors,
              [page.runId]: page.nextCursor,
            },
            runJournalEventIds: {
              ...state.runJournalEventIds,
              [page.runId]: dedupedEventIds,
            },
            // A live notification carries exact durable event identities, so
            // it is safe to project into the inspector immediately. It does
            // not, however, include the fixed replay watermark needed to
            // prove journal coverage. Keep the last native replay receipt
            // untouched until replayRunJournalIntoStore observes one.
            runJournalCoverage: options.live
              ? state.runJournalCoverage
              : {
                  ...state.runJournalCoverage,
                  [page.runId]: {
                    coverage: page.coverage,
                    reason: page.coverageReason,
                    handoff: state.runJournalCoverage[page.runId]?.handoff ?? null,
                  },
                },
          };
        }),
      upsertRunTelemetry: (snapshot) =>
        set((state) => ({
          runTelemetryByRunId: {
            ...state.runTelemetryByRunId,
            [snapshot.runId]: snapshot,
          },
        })),
      upsertRunControlOperation: (projection) =>
        set((state) => {
          const current = state.runControlOperationsById[projection.operation.operationId];
          const merged = mergeRunControlProjection(current, projection);
          if (!merged || merged === current) return state;
          return {
            runControlOperationsById: {
              ...state.runControlOperationsById,
              [projection.operation.operationId]: merged,
            },
          };
        }),
      upsertRunCheckpoint: (record) =>
        set((state) => {
          const incoming = projectRunCheckpoint(record);
          const current = state.checkpointsByRunId[record.runId];
          if (current) {
            const currentCheckpoint = current.checkpoint;
            const sameCheckpoint = currentCheckpoint.checkpointId === record.checkpointId;
            if (sameCheckpoint) {
              // Native checkpoints are immutable rows. A duplicate read may
              // replace no evidence, and a same-ID payload drift must fail
              // closed instead of rewriting the renderer projection.
              return state;
            }
            const createdOrder = record.createdAt.localeCompare(currentCheckpoint.createdAt);
            if (
              createdOrder < 0 ||
              (createdOrder === 0 && record.checkpointId.localeCompare(currentCheckpoint.checkpointId) <= 0)
            ) {
              // Reads may arrive out of order after restart or a multi-client
              // refresh. Keep the newest immutable checkpoint projection.
              return state;
            }
          }
          return {
            checkpointsByRunId: {
              ...state.checkpointsByRunId,
              [record.runId]: incoming,
            },
          };
        }),
      upsertContinuationIntent: (intent) =>
        set((state) => {
          const current = state.continuationIntentsById[intent.intentId];
          if (current) {
            // Continuation intents are immutable native facts. Replays are
            // harmless; a same-ID payload drift must never rewrite the
            // renderer's projection or make a second intent appear valid.
            return state;
          }
          return {
            continuationIntentsById: {
              ...state.continuationIntentsById,
              [intent.intentId]: intent,
            },
          };
        }),
      upsertMessageRevision: (revision) =>
        set((state) => {
          const current = state.messageRevisionsByMessageId[revision.messageId] ?? [];
          const existing = current.find((candidate) => candidate.revisionId === revision.revisionId);
          if (existing) {
            // Immutable native revisions may be replayed, but an ID must never
            // be reinterpreted with different content or lineage.
            if (stableStructuralSerialize(existing) === stableStructuralSerialize(revision)) return state;
            return state;
          }
          const next = [...current, revision].sort(
            (left, right) =>
              left.sourceCursor - right.sourceCursor ||
              left.createdAt.localeCompare(right.createdAt) ||
              left.revisionId.localeCompare(right.revisionId),
          );
          return {
            messageRevisionsByMessageId: {
              ...state.messageRevisionsByMessageId,
              [revision.messageId]: next,
            },
          };
        }),
      upsertMultimodalBridgePlan: (projection) =>
        set((state) => {
          const current = state.multimodalBridgePlansByRunId[projection.runId];
          if (current && !shouldReplaceMultimodalBridgeProjection(current, projection)) {
            return {};
          }
          return {
            multimodalBridgePlansByRunId: {
              ...state.multimodalBridgePlansByRunId,
              [projection.runId]: projection,
            },
          };
        }),
      upsertAttachment: (attachment) =>
        set((state) => {
          const isActive = attachment.deletedAt === null || attachment.deletedAt === undefined;
          const attachments =
            isActive
              ? [
                  attachment,
                  ...state.attachments.filter((candidate) => candidate.id !== attachment.id),
                ]
              : state.attachments.filter((candidate) => candidate.id !== attachment.id);
          const draftEntries = Object.entries(state.draftAttachmentIdsByConversation)
              .map(([conversationId, attachmentIds]): [string, string[]] => [
                conversationId,
                attachmentIds.filter((attachmentId) =>
                  isActive || attachmentId !== attachment.id,
                ),
              ])
              .filter((entry) => entry[1].length > 0);
          const draftAttachmentIdsByConversation = Object.fromEntries(draftEntries);
          return { attachments, draftAttachmentIdsByConversation };
        }),
      removeAttachment: (attachmentId) =>
        set((state) => ({
          attachments: state.attachments.filter((attachment) => attachment.id !== attachmentId),
          draftAttachmentIdsByConversation: Object.fromEntries(
            Object.entries(state.draftAttachmentIdsByConversation)
              .map(([conversationId, attachmentIds]): [string, string[]] => [
                conversationId,
                attachmentIds.filter((candidate) => candidate !== attachmentId),
              ])
              .filter((entry) => entry[1].length > 0),
          ),
        })),
      attachDraftAttachment: (conversationId, attachmentId) =>
        set((state) => {
          const attachment = state.attachments.find(
            (candidate) =>
              candidate.id === attachmentId &&
              (candidate.deletedAt === null || candidate.deletedAt === undefined),
          );
          if (!attachment) return state;
          const current = state.draftAttachmentIdsByConversation[conversationId] ?? [];
          if (current.includes(attachmentId)) return state;
          return {
            draftAttachmentIdsByConversation: {
              ...state.draftAttachmentIdsByConversation,
              [conversationId]: [...current, attachmentId],
            },
          };
        }),
      detachDraftAttachment: (conversationId, attachmentId) =>
        set((state) => {
          const remaining = (state.draftAttachmentIdsByConversation[conversationId] ?? []).filter(
            (candidate) => candidate !== attachmentId,
          );
          const draftAttachmentIdsByConversation = {
            ...state.draftAttachmentIdsByConversation,
          };
          if (remaining.length > 0) draftAttachmentIdsByConversation[conversationId] = remaining;
          else delete draftAttachmentIdsByConversation[conversationId];
          return { draftAttachmentIdsByConversation };
        }),
      clearDraftAttachments: (conversationId) =>
        set((state) => {
          if (!(conversationId in state.draftAttachmentIdsByConversation)) return state;
          const draftAttachmentIdsByConversation = {
            ...state.draftAttachmentIdsByConversation,
          };
          delete draftAttachmentIdsByConversation[conversationId];
          return { draftAttachmentIdsByConversation };
        }),
      prepareDesktopPreview: () =>
        set({
          activeConversationId: "",
          activeProjectId: "",
          pendingMessageNavigation: null,
          settingsProjectId: null,
          conversations: [],
          attachments: [],
          draftAttachmentIdsByConversation: {},
          projects: [],
          memories: [],
          skills: [],
          artifacts: [],
          citations: [],
          runTimelineEvents: [],
          runJournalCursors: {},
          runJournalEventIds: {},
          runJournalCoverage: {},
          runTelemetryByRunId: {},
          runControlOperationsById: {},
          checkpointsByRunId: {},
          continuationIntentsById: {},
          messageRevisionsByMessageId: {},
          multimodalBridgePlansByRunId: {},
          providers: [],
          activeRun: null,
          parameterUndoStack: [],
          parameterRedoStack: [],
        }),
    }),
    {
      name: "omnia-workspace-preview-v1",
      version: 5,
      storage: createJSONStorage(preferenceStorage),
      partialize: (state) => ({
        activeActivity: state.activeActivity,
        modelProfileId: state.modelProfileId,
        composerMode: state.composerMode,
        theme: state.theme,
        density: state.density,
        motion: state.motion,
        sidebarOpen: state.sidebarOpen,
        inspectorOpen: state.inspectorOpen,
        inspectorTab: state.inspectorTab,
        parameters: state.parameters,
      }),
      migrate: (persisted) => {
        const state = persisted as Partial<WorkspaceStore>;
        const appearance = normalizeAppearance(state);
        return {
          activeActivity: state.activeActivity ?? "chats",
          modelProfileId: state.modelProfileId ?? "auto",
          composerMode: state.composerMode ?? "ask",
          theme: appearance.theme,
          density: appearance.density,
          motion: appearance.motion,
          sidebarOpen: state.sidebarOpen ?? true,
          inspectorOpen: state.inspectorOpen ?? false,
          inspectorTab: state.inspectorTab ?? "context",
          parameters: { ...defaultParameters, ...state.parameters },
          parameterUndoStack: [],
          parameterRedoStack: [],
        };
      },
      merge: (persisted, current) => {
        const state = persisted as Partial<WorkspaceStore>;
        const appearance = normalizeAppearance(state);
        return {
          ...current,
          ...state,
          theme: appearance.theme,
          density: appearance.density,
          motion: appearance.motion,
          parameters: { ...current.parameters, ...state.parameters },
          parameterUndoStack: [],
          parameterRedoStack: [],
          // Only presentation preferences are persisted. Legacy or forged
          // storage must not restore one-shot Project navigation context.
          settingsProjectId: null,
        };
      },
    },
  ),
);

export function activeConversation(state: WorkspaceStore): ConversationView | null {
  return state.conversations.find((conversation) => conversation.id === state.activeConversationId) ?? null;
}

export function activeProject(state: WorkspaceStore): ProjectView | null {
  return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
}

export function draftAttachmentsForConversation(
  state: WorkspaceStore,
  conversationId: string,
): AttachmentView[] {
  const attachmentIds = new Set(state.draftAttachmentIdsByConversation[conversationId] ?? []);
  return state.attachments.filter((attachment) => attachmentIds.has(attachment.id));
}

export function activeDraftAttachments(state: WorkspaceStore): AttachmentView[] {
  return draftAttachmentsForConversation(state, state.activeConversationId);
}

export { createId };
