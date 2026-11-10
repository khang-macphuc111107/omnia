/** Wire types shared with the Rust harness (`omnia-harness` + `harness_bridge`). */

export type PermissionMode = "plan" | "ask_all" | "ask_writes" | "auto" | "full";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "turn_limit"
  | "other";

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "thinking"; text: string; signature?: string | null }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: Block[]; is_error?: boolean };

export interface AgentMessage {
  role: "user" | "assistant";
  content: Block[];
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_signature"; signature: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_input_delta"; id: string; partial_json: string }
  | { type: "tool_use_end"; id: string }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; reason: StopReason };

export interface ApprovalRequest {
  tool_use_id: string;
  tool: string;
  input: unknown;
  summary: string;
  ordinal: number;
  total: number;
  /** Approvals queued behind this one in the same turn, in the order they will be asked. */
  remaining?: ApprovalPreview[];
}

export interface ApprovalPreview {
  tool_use_id: string;
  tool: string;
  input: unknown;
  summary: string;
}

export type ApprovalDecision =
  | { type: "allow_once" }
  | { type: "allow_always" }
  | { type: "allow_edited"; input: unknown }
  | { type: "deny"; feedback?: string | null };

export interface ToolOutput {
  content: Block[];
  is_error: boolean;
}

export type AgentEvent =
  | { type: "compacted"; before: number; after: number; messages_before?: never; messages_after?: never }
  /** Compatibility with older journal/preview events. Rust uses before/after. */
  | { type: "compacted"; messages_before: number; messages_after: number; before?: never; after?: never }
  | { type: "hook_message"; hook: string; message: string }
  | { type: "turn_started"; turn: number }
  | { type: "stream"; event: StreamEvent }
  | { type: "assistant_message"; message: AgentMessage }
  | { type: "tool_proposed"; id: string; name: string; input: unknown; summary: string }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "approval_decided"; id: string; decision: ApprovalDecision }
  /** A Plan-mode run ended its turn with `present_plan`. */
  | { type: "plan_presented"; id: string; plan: string }
  | { type: "tool_started"; id: string }
  | { type: "tool_progress"; id: string; chunk: string }
  | { type: "tool_completed"; id: string; output: ToolOutput }
  | { type: "steer_injected"; text: string }
  | { type: "retrying"; attempt: number; delay_ms: number; message: string }
  | { type: "model_fallback"; from: string; to: string; reason: string }
  | { type: "budget_warning"; used: number; budget: number }
  | { type: "turn_completed"; turn: number; usage: Usage; stop: StopReason }
  | { type: "run_completed"; usage: Usage; stop: StopReason; turns: number }
  | { type: "error"; message: string }
  /** The `artifact` tool created, updated or deleted an artifact. */
  | { type: "artifact"; id: string; version: number; title: string; kind: ArtifactKind; action: "create" | "update" | "delete" }
  /** Wraps every event of the subagent started by the `task` tool call `parent_id`. */
  | { type: "subagent"; parent_id: string; event: AgentEvent };

export type BridgeEvent =
  | { type: "run_started" }
  | {
      type: "run_finished";
      status: "completed" | "interrupted" | "failed";
      message?: string;
      outcome?: { usage: Usage; stop: StopReason; turns: number };
    };

export type AgentWireEvent = AgentEvent | BridgeEvent;

export interface AgentEventPayload {
  sessionId: string;
  event: AgentWireEvent;
  sequence?: number;
}

export type RuleAction = "allow" | "ask" | "deny";
export type RuleScope = "global" | "project" | "session";

/** `tool` is a name, glob or `re:` regex; `pattern` is a glob or `re:` regex on the primary argument. */
export interface PermissionRule {
  tool: string;
  pattern?: string | null;
  action: RuleAction;
}

export interface ProjectRulesListing {
  path: string;
  exists: boolean;
  /** Project rules apply only while the workspace configuration is trusted. */
  trusted: boolean;
  error: string | null;
  rules: PermissionRule[];
}

export interface PermissionRulesListing {
  global: PermissionRule[];
  project: ProjectRulesListing | null;
  session: PermissionRule[] | null;
  mode: PermissionMode | null;
}

export interface PermissionRuleTestRequest {
  sessionId?: string | undefined;
  cwd?: string | undefined;
  mode?: PermissionMode;
  tool: string;
  input: unknown;
}

export interface PermissionRuleTestResult {
  decision: RuleAction;
  reason: string;
  rule: (PermissionRule & { scope: RuleScope; index: number }) | null;
  mode: PermissionMode;
  effect: string;
  effectAssumed: boolean;
}

export type SystemPromptMode = "append" | "replace";

/** A user-authored system prompt override (per session, or a saved preset). */
export interface SystemPromptConfig {
  mode: SystemPromptMode;
  text: string;
}

export interface PromptPreset extends SystemPromptConfig {
  id: string;
  name: string;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  cwd: string;
  profileId: string;
  model: string;
  permissionMode: PermissionMode;
  reasoningEffort?: string | null;
  /** Ordered, user-configured fallback models (same provider profile). */
  fallbackModels?: string[];
  /** Optional cap on input + output tokens across the session. */
  tokenBudget?: number | null;
  /** Cumulative input + output tokens spent by this session. */
  tokensUsed?: number;
  /** Override of the built-in system prompt; absent means the default (plus any project default). */
  systemPrompt?: SystemPromptConfig | null;
  parentId?: string | null;
  /** Native compare-and-swap token for user-editable settings; transcript/usage writes do not advance it. */
  settingsRevision?: number;
  messageCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AgentSessionListItem extends AgentSessionSummary {
  running: boolean;
}

export type RunStatus = "idle" | "running" | "completed" | "interrupted" | "failed";

export interface StoredAgentEvent {
  sequence: number;
  event: AgentWireEvent;
}

export interface McpServerStatus {
  name: string;
  state: "connected" | "failed" | "disabled";
  error: string | null;
  toolCount: number;
}

/** Omnia's own MCP server (other apps controlling Omnia). */
export interface McpServerInfo {
  enabled: boolean;
  url: string | null;
  token: string | null;
  port: number;
}

export interface PublicDownloadJob {
  job: {
    id: string;
    status: "queued" | "downloading" | "paused" | "muxing" | "completed" | "failed" | "cancelled";
    outputPath: string | null;
    error: string | null;
    errorCode: string | null;
    /** Present on live jobs from the host; optional so partial snapshots stay valid. */
    spec?: { fileName?: string | null; kind?: { type: "http" | "hls" | "dash" | "blob" } };
    progress?: { downloaded: number; total: number | null; speedBps: number; etaSecs: number | null };
  };
  reauthorizationRequired: boolean;
  /** HLS/DASH tracks were kept as separate files because ffmpeg could not merge them. */
  muxSkipped?: boolean;
  muxHint?: string | null;
}

/** A finished browser_record recording folder (recording.gif, steps.json, replay.spec.ts). */
export interface RecordingEntry {
  /** Folder name, `<name>-<yyyymmdd-hhmmss>`. */
  name: string;
  path: string;
  /** Unix milliseconds. */
  created: number;
  steps: number;
  hasGif: boolean;
}

export type MediaKind = "video" | "audio" | "hls" | "dash" | "pdf" | "image" | "document" | "blob" | "other";

/** A resource the dedicated browser saw. URLs are display-redacted by the host. */
export interface MediaEntry {
  id: string;
  url: string;
  name: string;
  pageUrl: string | null;
  pageTitle: string | null;
  kind: MediaKind;
  mime: string | null;
  size: number | null;
  drmProtected: boolean;
  /** Unix milliseconds. */
  timestamp: number;
}

export interface DownloadStartInput {
  url?: string;
  capturedRequestId?: string;
  fileName?: string;
  kind?: "http" | "hls" | "dash";
}

export type ProfileMode = "persistent" | "disposable_fallback" | "disposable";

export interface FfmpegStatus { available: boolean; path: string | null; configuredPath: string | null }

/** User-level browser/download settings (not per session). */
export interface BrowserSettings { keepSignIns: boolean; profileInUse: boolean; ffmpeg: FfmpegStatus }

export interface AgentServicesStatus {
  browser: {
    available: boolean;
    launchPolicy: string;
    personalBrowser: boolean;
    keepSignIns?: boolean;
    profileMode?: ProfileMode;
    running?: boolean;
  };
  ffmpeg?: FfmpegStatus;
  downloads: { available: boolean; destination: string; jobs: PublicDownloadJob[]; restoredJobsRequireReauthorization: boolean };
  computer: { available: boolean; capture: boolean; control: boolean; defaultDisabled: boolean };
}

export interface WorkspaceTrust {
  cwd: string;
  fingerprint: string;
  trusted: boolean;
  sources: { path: string; scope: "project" | "user" }[];
}

/** Result of restoring files during a rewind (paths are absolute). */
export interface FileRestoreReport {
  restored: string[];
  deleted: string[];
  skippedTooLarge: string[];
  failed: string[];
  untrackedNote: string;
}

export interface AgentSessionDetail {
  summary: AgentSessionSummary;
  messages: AgentMessage[];
  running: boolean;
  /** Present on a rewind that was asked to restore files. */
  fileRestore?: FileRestoreReport | null;
  /** Nonfatal notice when ambiguous historical checkpoints were quarantined. */
  checkpointRecoveryNotice?: string | null;
  /** Optional on older desktop builds. Events replayed after persisted messages. */
  replayEvents?: StoredAgentEvent[];
  runStatus?: RunStatus;
  unknownSideEffects?: string[];
  pendingApprovals?: ApprovalRequest[];
  eventCursor?: number;
}

export interface AgentImageInput {
  mediaType: string;
  data: string;
}

export interface CreateSessionInput {
  cwd: string;
  profileId: string;
  model: string;
  permissionMode?: PermissionMode;
  reasoningEffort?: string | null;
  title?: string;
  fallbackModels?: string[];
  tokenBudget?: number | null;
  systemPrompt?: SystemPromptConfig | null;
}

export const PERMISSION_MODES: ReadonlyArray<{
  value: PermissionMode;
  label: string;
  description: string;
}> = [
  { value: "plan", label: "Plan", description: "Read-only: the agent investigates and proposes a plan; writes, commands, network and desktop actions are refused until you switch modes." },
  { value: "ask_all", label: "Ask for everything", description: "Confirm all tools except pure computation. Explicit permission rules still apply." },
  { value: "ask_writes", label: "Ask for changes", description: "Read-only tools run freely; writes, commands, network and desktop control ask. Explicit rules still apply." },
  { value: "auto", label: "Auto", description: "Automatically allow writes, network and most commands. Ask for desktop control and recognized destructive commands. This is not a safety guarantee." },
  { value: "full", label: "Full access", description: "Allow tools without asking, except explicit deny rules. Workspace trust and desktop capture/control grants remain required." },
];

export interface CustomCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}

export interface AgentSkillInfo {
  name: string;
  description: string;
  source: "project" | "user";
  path: string;
  directory: string;
}

export interface AgentDefinitionInfo {
  name: string;
  description: string;
  tools: string[] | null;
  model: string | null;
  readOnly: boolean;
}

export interface PluginContents {
  skills: number;
  agents: number;
  commands: number;
  hooks: number;
  mcpServers: number;
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  author: string | null;
  scope: "user" | "project";
  path: string;
  enabled: boolean;
  contents: PluginContents;
}

/** Passive installed-connector facts. This receipt does not grant tool access. */
export interface PluginConnectionReceipt {
  schemaVersion: 1;
  receiptId: string;
  pluginName: string;
  pluginVersion: string;
  pluginScope: "user" | "project";
  serverName: string;
  configurationSha256: string;
  configurationSnapshotSha256: string;
  workspaceFingerprint: string;
  workspaceTrusted: boolean;
  transport: "unknown" | "stdio" | "http";
  endpointOrigin: string | null;
  requiredEnvironment: string[];
  missingEnvironment: string[];
  hasConfiguredHeaders: boolean;
  state: "disabled" | "workspace_trust_required" | "missing_environment" | "invalid_configuration" | "configured";
  permissionBoundary: "workspace_trust_and_per_tool_policy";
  liveAuthenticationVerified: false;
}

export interface WorkspaceEntry {
  path: string;
  isDir: boolean;
}

export interface DataPart {
  name: string;
  count: number;
  bytes: number;
}

export interface DataExportResult {
  path: string;
  parts: DataPart[];
  totalBytes: number;
  keysExcluded: boolean;
  excludedFiles: string[];
}

export interface DataCounts {
  sessions: number;
  presets: number;
  files: number;
  settings: number;
}

export type DataImportMode = "merge" | "replace";

export interface DataImportConflictReceipt {
  kind: "session" | "preset" | "browser-settings" | "home-file";
  entityId: string;
  incomingSha256: string;
  existingSha256: string | null;
  disposition: "kept-existing";
  reason: "different-content" | "unsafe-existing-link" | "unreadable-existing";
}

export interface DataImportReceipt {
  schemaVersion: 1;
  id: string;
  sourceManifestSha256: string;
  sourceFormatVersion: number;
  sourceAppVersion: string;
  targetAppVersion: string;
  appVersionChanged: boolean;
  mode: DataImportMode;
  imported: DataCounts;
  skipped: DataCounts;
  conflicts: DataImportConflictReceipt[];
  backupCount: number;
  restartRequired: boolean;
  completedAt: string;
}

export interface DataImportSummary {
  imported: DataCounts;
  skipped: DataCounts;
  conflicts: string[];
  /** Absent only when reading responses from a host predating receipt support. */
  receipt?: DataImportReceipt | null;
  skippedSessionIds: string[];
  backups: string[];
  restartRequired: boolean;
}

export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  id: string;
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  status: "modified" | "added" | "deleted";
  untracked: boolean;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface WorkspaceDiff {
  git: boolean;
  files: DiffFile[];
  truncated: boolean;
  error: string | null;
}

export interface InspectorHeader {
  name: string;
  value: string;
}

export interface InspectorSummary {
  id: number;
  startedAtMs: number;
  provider: string;
  model: string;
  status: number | null;
  durationMs: number | null;
  requestBytes: number;
  responseBytes: number;
  error: string | null;
  complete: boolean;
}

export interface InspectorStats {
  requests: number;
  errors: number;
  retries: number;
  fallbacks: number;
  completed: number;
  averageLatencyMs: number;
}

export interface InspectorList {
  exchanges: InspectorSummary[];
  stats: InspectorStats;
}

export interface InspectorExchange extends InspectorSummary {
  url: string;
  requestHeaders: InspectorHeader[];
  requestBody: string;
  requestTruncated: boolean;
  responseHeaders: InspectorHeader[];
  responseBody: string;
  responseTruncated: boolean;
}

export interface ScheduleNewSession {
  cwd: string;
  profileId: string;
  model: string;
  permissionMode?: PermissionMode | null;
}

/** A recurring task. Exactly one of sessionId/newSession and one of cron/intervalMinutes is set. */
export interface AgentSchedule {
  id: string;
  name: string;
  sessionId?: string | null;
  newSession?: ScheduleNewSession | null;
  prompt: string;
  cron?: string | null;
  intervalMinutes?: number | null;
  enabled: boolean;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  lastStatus?: string | null;
  lastMessage?: string | null;
}

export type ArtifactKind = "html" | "markdown" | "svg" | "mermaid" | "code" | "csv";

export interface ArtifactMeta {
  id: string;
  sessionId: string;
  title: string;
  kind: ArtifactKind;
  language?: string;
  /** Newest version number. */
  version: number;
  /** Retained version numbers, ascending. */
  versions: number[];
  createdMs: number;
  updatedMs: number;
}

export interface ArtifactContent {
  meta: ArtifactMeta;
  version: number;
  content: string;
}
