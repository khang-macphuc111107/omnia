export type { ActivityId } from "./activity-registry";
export type {
  DensityPreference,
  MotionPreference,
  ThemePreference,
} from "@/design-system/appearance";
export type InspectorTab = "context" | "run" | "parameters";
export type ComposerMode = "ask" | "create" | "research" | "discuss";

export type MessageStatus = "complete" | "streaming" | "stopped" | "failed";

/**
 * A media preview that is owned by the renderer session. Native attachment
 * projections intentionally do not populate this metadata because they do not
 * expose blob bytes or filesystem paths across the IPC boundary.
 */
export type AttachmentPreviewType = "image" | "video" | "audio";

export interface AttachmentView {
  id: string;
  /** Native draft ownership, when this attachment is still selected for a draft message. */
  draftId?: string | null;
  projectId?: string | null;
  messageId?: string | null;
  blobId?: string;
  name: string;
  kind: "image" | "document" | "code" | "data";
  mediaType?: string;
  /** Optional browser-local object/data URL; never synthesized from native metadata. */
  previewUrl?: string;
  /** The media element to use when `previewUrl` is a safe renderer-local URL. */
  previewType?: AttachmentPreviewType;
  byteSize?: number;
  size: string;
  state: "processing" | "ready" | "warning" | "failed";
  extractionStatus?: "pending" | "running" | "complete" | "failed" | "skipped";
  contentHash?: string;
  extractedContentHash?: string | null;
  extractionVersion?: string | null;
  origin?: "picker" | "drag-drop" | "clipboard" | "workspace" | "provider";
  createdAt?: string;
  deletedAt?: string | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  status: MessageStatus;
  modelLabel: string | null;
  runId: string | null;
  attachments: AttachmentView[];
  branchIndex: number;
  branchCount: number;
}

/** Metadata observed in a native ConversationSnapshot, never synthesized from mock messages. */
export interface NativeConversationBranchView {
  id: string;
  name: string | null;
  parentBranchId: string | null;
  forkedFromMessageId: string | null;
  createdAtMs: number;
}

export type ConversationRunState = "queued" | "streaming" | "failed";

export interface ConversationView {
  id: string;
  activeBranchId: string;
  nativeBranches?: readonly NativeConversationBranchView[];
  /**
   * Renderer-local retention marker for a newly opened temporary Chat.
   * Native persistence/deletion policy is not implied until the broker exposes
   * durable temporary-chat metadata.
   */
  temporary?: boolean;
  title: string;
  excerpt: string;
  updatedAt: string;
  updatedLabel: string;
  projectId: string | null;
  projectName: string | null;
  pinned: boolean;
  archived: boolean;
  hasDraft: boolean;
  unread: boolean;
  runState: ConversationRunState | null;
  /** Display name of the model last used in this conversation, when known. */
  modelLabel?: string | null;
  /**
   * Parent session URI (`omnia://sessions/<id>`) for /btw side chats so the
   * sidebar can nest them under the conversation they were asked from.
   */
  workspacePath?: string | undefined;
  draft: string;
  messages: ChatMessage[];
}

export interface WorkspaceFolderView {
  id: string;
  displayName: string;
  canonicalPath: string;
  state: "referenced" | "indexing" | "ready" | "partial" | "permission-lost" | "offline";
  scope: "read-only" | "metadata" | "selected-files" | "full-index";
  fileCount: number | null;
  chunkCount: number | null;
  lastIndexedAt: string | null;
  localOnly: boolean;
}

/**
 * Renderer-safe projection of the durable Project Overview contract.
 *
 * Native overview revisions are not available in every runtime yet, so fields
 * remain nullable and the status explicitly carries an `unknown` state. The
 * renderer must never turn a missing revision into a confident summary.
 */
export type ProjectOverviewStatus =
  | "current"
  | "candidate"
  | "stale"
  | "failed"
  | "superseded"
  | "unknown";

export interface ProjectOverviewEvidenceView {
  id: string;
  label: string;
  status: "verified" | "stale" | "failed" | "unknown";
  freshnessLabel: string | null;
  sourceLabel: string | null;
}

export interface ProjectOverviewChangeView {
  id: string;
  label: string;
  changedAtLabel: string | null;
  sourceLabel: string | null;
}

export interface ProjectOverviewView {
  overviewRevisionId: string | null;
  projectTwinRevisionId: string | null;
  sourceEventWatermark: number | null;
  status: ProjectOverviewStatus;
  title: string | null;
  subtitle: string | null;
  summary: string | null;
  goal: string | null;
  nonGoals: string[];
  phase: string | null;
  milestone: string | null;
  nextTask: string | null;
  activeBranch: string | null;
  workspaceRootCount: number | null;
  repositoryBranch: string | null;
  worktree: string | null;
  verifiedEvidence: ProjectOverviewEvidenceView[];
  staleNodeCount: number | null;
  runtimeLabel: string | null;
  modelProfileId: string | null;
  contextRevisionId: string | null;
  budgetLabel: string | null;
  backgroundWorkLabel: string | null;
  approvalsLabel: string | null;
  attentionItems: string[];
  recentChanges: ProjectOverviewChangeView[];
}

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  accent: string;
  instructions: string;
  /** Native optimistic-concurrency cursor; omitted for renderer fixtures. */
  nativeUpdatedAtMs?: number;
  modelProfileId: string;
  conversationCount: number;
  contextHealth:
    | "not-compiled"
    | "ready"
    | "indexing"
    | "over-budget"
    | "missing-access";
  pinned: boolean;
  /** Native projections may mark a Project archived; omitted means active in the browser preview. */
  archived?: boolean;
  folders: WorkspaceFolderView[];
  /** Optional until native overview revisions are hydrated. */
  overview?: ProjectOverviewView;
}

export interface MemoryView {
  id: string;
  /** Optional human-readable label used by the renderer draft editor. */
  title?: string | null;
  content: string;
  scopeLabel: string;
  kind: "preference" | "workflow" | "project-fact" | "constraint";
  status: "suggested" | "active" | "paused" | "archived";
  origin: "explicit" | "inferred" | "imported";
  confidence: number | null;
  /**
   * Optional renderer projection of the domain sensitivity categories.
   * Missing metadata is treated as `normal` by preview surfaces; it does not
   * imply that native classification or a provider privacy decision occurred.
   */
  sensitivity?: readonly MemorySensitivity[];
  sourceLabel: string;
  lastUsedLabel: string | null;
  /** Optional expiry metadata; native enforcement remains unavailable in preview. */
  expiresAt?: string | null;
}

export type MemorySensitivity =
  | "normal"
  | "personal"
  | "financial"
  | "health"
  | "authentication"
  | "secret"
  | "private-key";

export interface SkillView {
  id: string;
  name: string;
  description: string;
  version: string;
  icon: string;
  source: "Built in" | "Local" | "Imported";
  trust: "Verified" | "Reviewed" | "Unreviewed";
  enabled: boolean;
  scope: "Global" | "Project" | "Manual";
  tokenFootprint: number;
  permissions: string[];
}

export interface ArtifactView {
  id: string;
  name: string;
  type: "Markdown" | "Code" | "Diagram" | "Data";
  projectName: string;
  updatedLabel: string;
  sizeLabel: string;
  versionCount: number;
}

export interface ModelProfileView {
  id: string;
  connectionId: string | null;
  displayName: string;
  providerName: string;
  providerModelId: string;
  status: "available" | "degraded" | "unavailable" | "unknown";
  capabilities: Array<"vision" | "tools" | "json" | "reasoning" | "audio">;
  contextLabel: string;
  speed: "Fast" | "Balanced" | "Thorough";
  favorite: boolean;
}

export type ProviderKind =
  | "OpenAI"
  | "Anthropic"
  | "Gemini"
  | "Azure OpenAI"
  | "OpenAI-compatible"
  | "Custom"
  | "Local";

export type ProviderConnectionState =
  | "connected"
  | "configuration-validated"
  | "degraded"
  | "validating"
  | "not-configured"
  | "error";

export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  providerType: string;
  endpoint: string;
  authScheme: string;
  state: ProviderConnectionState;
  modelCount: number;
  enabled: boolean;
  credentialState: "present" | "missing" | "locked" | "not-required";
  source: "native" | "preview" | "demo";
  organizationId: string | null;
  remoteProjectId: string | null;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  errorMessage: string | null;
  models: ModelProfileView[];
}

export type RunStage =
  | "preparing-context"
  | "routing"
  | "requesting"
  | "writing"
  | "finalizing"
  | "complete"
  | "stopped"
  | "failed";

export interface ActiveRunView {
  id: string;
  conversationId: string;
  assistantMessageId: string;
  stage: RunStage;
  startedAt: string;
}

export interface ParameterSettings {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  maxOutputTokens: number;
  reasoningEffort: "off" | "low" | "medium" | "high" | "max";
  reasoningBudgetTokens: number | null;
  frequencyPenalty: number;
  presencePenalty: number;
  seed: number | null;
  stopSequences: string;
  streaming: boolean;
  jsonMode: boolean;
  jsonSchema: string;
  logprobs: boolean;
  topLogprobs: number;
  parallelToolCalls: boolean;
  promptCaching: boolean;
  toolChoice: "auto" | "none" | "required";
  serviceTier: "auto" | "default" | "priority" | "flex";
  timeoutMs: number;
  maxRetries: number;
  providerExtensions: string;
}
