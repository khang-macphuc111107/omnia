import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  desktop,
  invokeCore,
  type NativeProviderModel,
  type ProviderProfileRecord,
} from "@/lib/desktop";

import type { VoiceEventPayload, VoiceSettingsTarget, VoiceStatus } from "./voice";
import type { SessionNavigationLoad, SessionNavigationSave, SessionNavigationSaveRequest } from "./session-navigation";
import type {
  ArtifactContent,
  ArtifactMeta,
  InspectorExchange,
  InspectorList,
  AgentEventPayload,
  AgentImageInput,
  AgentSessionDetail,
  AgentSessionListItem,
  AgentSessionSummary,
  AgentServicesStatus,
  AgentSkillInfo,
  AgentDefinitionInfo,
  BrowserSettings,
  PublicDownloadJob,
  MediaEntry,
  RecordingEntry,
  DownloadStartInput,
  McpServerStatus,
  McpServerInfo,
  PromptPreset,
  AgentSchedule,
  SystemPromptConfig,
  ApprovalDecision,
  PermissionRule,
  PermissionRuleTestRequest,
  PermissionRuleTestResult,
  PermissionRulesListing,
  RuleScope,
  CreateSessionInput,
  CustomCommandInfo,
  PluginInfo,
  PluginConnectionReceipt,
  WorkspaceEntry,
  WorkspaceDiff,
  PermissionMode,
  WorkspaceTrust,
  DataExportResult,
  DataImportMode,
  DataImportSummary,
} from "./types";
import {
  createUpstreamAdapterPlan,
  findUpstreamCapability,
  listRunnableUpstreamCapabilities,
  listUpstreamCapabilities,
  listUpstreamCapabilitiesByCategory,
  upstreamCapabilitySummary,
  type UpstreamCapabilityDescriptor,
} from "../domain/upstream-capability-catalog";

export const AGENT_EVENT = "omnia-agent";
export const VOICE_EVENT = "omnia-voice";

/** Typed wrappers over the harness Tauri commands; all go through the session-guarded IPC. */
export const agentApi = {
  async ensureReady(): Promise<void> {
    const info = await desktop.runtimeInfo();
    await desktop.initializeCore(info.appVersion);
  },

  list: () => invokeCore<AgentSessionListItem[]>("agent_session_list"),

  navigationLoad: () => invokeCore<SessionNavigationLoad>("agent_session_navigation_load"),

  navigationSave: (request: SessionNavigationSaveRequest) =>
    invokeCore<SessionNavigationSave>("agent_session_navigation_save", { request }),

  /**
   * Renderer-safe projection of the extracted upstreams. This is metadata
   * routing only; execution still goes through the native adapter/IPC gate.
   */
  upstreamCapabilities: Object.freeze({
    list: (): readonly UpstreamCapabilityDescriptor[] => listUpstreamCapabilities(),
    runnable: (): readonly UpstreamCapabilityDescriptor[] => listRunnableUpstreamCapabilities(),
    byCategory: (category: string): readonly UpstreamCapabilityDescriptor[] => listUpstreamCapabilitiesByCategory(category),
    find: (id: string): UpstreamCapabilityDescriptor | undefined => findUpstreamCapability(id),
    plan: (id: string) => createUpstreamAdapterPlan(id),
    summary: () => upstreamCapabilitySummary(),
  }),

  read: (sessionId: string) =>
    invokeCore<AgentSessionDetail>("agent_session_read", { request: { sessionId } }),

  create: (request: CreateSessionInput) =>
    invokeCore<AgentSessionSummary>("agent_session_create", { request }),

  remove: (sessionId: string) =>
    invokeCore<void>("agent_session_delete", { request: { sessionId } }),

  update: (
    sessionId: string,
    patch: { expectedSettingsRevision?: number; title?: string; profileId?: string; model?: string; permissionMode?: PermissionMode; reasoningEffort?: string | null; fallbackModels?: string[]; tokenBudget?: number | null; systemPrompt?: SystemPromptConfig | null },
  ) => invokeCore<AgentSessionSummary>("agent_session_update", { request: { sessionId, ...patch } }),

  promptPresets: () => invokeCore<PromptPreset[]>("agent_prompt_presets_list"),

  savePromptPreset: (preset: Omit<PromptPreset, "id"> & { id?: string | undefined }) =>
    invokeCore<PromptPreset[]>("agent_prompt_preset_save", { request: { preset } }),

  deletePromptPreset: (id: string) =>
    invokeCore<PromptPreset[]>("agent_prompt_preset_delete", { request: { id } }),

  schedules: () => invokeCore<AgentSchedule[]>("agent_schedules_list"),

  saveSchedule: (schedule: Omit<AgentSchedule, "id"> & { id?: string | undefined }) =>
    invokeCore<AgentSchedule[]>("agent_schedule_save", { request: { schedule } }),

  deleteSchedule: (id: string) =>
    invokeCore<AgentSchedule[]>("agent_schedule_delete", { request: { id } }),

  runScheduleNow: (id: string) => invokeCore<void>("agent_schedule_run_now", { request: { id } }),

  /** Next three fire times (epoch ms, local time); rejects on an invalid or impossible cron. */
  previewSchedule: (cron: string) =>
    invokeCore<number[]>("agent_schedule_preview", { request: { cron } }),

  /** The exact system prompt the next run of this session would get. */
  previewSystemPrompt: (sessionId: string) =>
    invokeCore<string>("agent_system_prompt_preview", { request: { sessionId } }),

  send: (sessionId: string, text: string, images: AgentImageInput[] = []) =>
    invokeCore<void>("agent_send", { request: { sessionId, text, images } }),

  steer: (sessionId: string, text: string) =>
    invokeCore<void>("agent_steer", { request: { sessionId, text } }),

  interrupt: (sessionId: string) =>
    invokeCore<void>("agent_interrupt", { request: { sessionId } }),

  decide: (sessionId: string, toolUseId: string, decision: ApprovalDecision) =>
    invokeCore<void>("agent_approval_decide", { request: { sessionId, toolUseId, decision } }),

  /** One answer for the shown approval and every approval queued behind it. */
  decideAll: (sessionId: string, toolUseId: string, decision: ApprovalDecision) =>
    invokeCore<void>("agent_approval_decide_all", { request: { sessionId, toolUseId, decision } }),

  permissionRules: (target: { sessionId?: string | undefined; cwd?: string | undefined }) =>
    invokeCore<PermissionRulesListing>("agent_permission_rules_list", { request: target }),

  /** Replaces one scope's complete, ordered rule list. */
  setPermissionRules: (scope: RuleScope, rules: PermissionRule[], target: { sessionId?: string | undefined; cwd?: string | undefined }) =>
    invokeCore<PermissionRulesListing>("agent_permission_rules_set", { request: { scope, rules, ...target } }),

  testPermissionRule: (request: PermissionRuleTestRequest) =>
    invokeCore<PermissionRuleTestResult>("agent_permission_rules_test", { request }),

  rewind: (sessionId: string, keep: number, restoreFiles = false) =>
    invokeCore<AgentSessionDetail>("agent_rewind", { request: { sessionId, keep, restoreFiles } }),

  fork: (sessionId: string, keep?: number) =>
    invokeCore<AgentSessionSummary>("agent_fork", {
      request: keep === undefined ? { sessionId } : { sessionId, keep },
    }),

  mcpStatus: (sessionId: string) =>
    invokeCore<McpServerStatus[]>("agent_mcp_status", { request: { sessionId } }),

  reloadMcp: (sessionId: string) =>
    invokeCore<McpServerStatus[]>("agent_mcp_reload", { request: { sessionId } }),

  mcpServerStatus: () => invokeCore<McpServerInfo>("agent_mcp_server_status"),

  mcpServerSet: (enabled: boolean, port?: number) =>
    invokeCore<McpServerInfo>("agent_mcp_server_set", {
      request: port === undefined ? { enabled } : { enabled, port },
    }),

  mcpServerRotateToken: () => invokeCore<McpServerInfo>("agent_mcp_server_rotate_token"),

  inspectorList: (sessionId: string) =>
    invokeCore<InspectorList>("agent_inspector_list", { request: { sessionId } }),

  inspectorGet: (sessionId: string, id: number) =>
    invokeCore<InspectorExchange>("agent_inspector_get", { request: { sessionId, id } }),

  inspectorClear: (sessionId: string) =>
    invokeCore<void>("agent_inspector_clear", { request: { sessionId } }),

  workspaceDiff: (sessionId: string) =>
    invokeCore<WorkspaceDiff>("agent_workspace_diff", { request: { sessionId } }),

  hunkRevert: (sessionId: string, file: string, hunkId: string) =>
    invokeCore<WorkspaceDiff>("agent_hunk_revert", { request: { sessionId, file, hunkId } }),

  hunkStage: (sessionId: string, file: string, hunkId: string) =>
    invokeCore<WorkspaceDiff>("agent_hunk_stage", { request: { sessionId, file, hunkId } }),

  artifactsList: (sessionId: string) =>
    invokeCore<ArtifactMeta[]>("agent_artifacts_list", { request: { sessionId } }),

  artifactGet: (sessionId: string, id: string, version?: number) =>
    invokeCore<ArtifactContent>("agent_artifact_get", { request: { sessionId, id, ...(version ? { version } : {}) } }),

  /** Native Save-as dialog; resolves to the saved path, or null when cancelled. */
  artifactExport: (sessionId: string, id: string, version?: number) =>
    invokeCore<string | null>("agent_artifact_export", { request: { sessionId, id, ...(version ? { version } : {}) } }),

  artifactOpenBrowser: (sessionId: string, id: string, version?: number) =>
    invokeCore<void>("agent_artifact_open_browser", { request: { sessionId, id, ...(version ? { version } : {}) } }),

  /** Short-lived capability URL (custom `omnia-artifact` scheme) for framing an html/svg version. */
  artifactPreviewUrl: (sessionId: string, id: string, version?: number) =>
    invokeCore<string>("agent_artifact_preview_url", { request: { sessionId, id, ...(version ? { version } : {}) } }),

  workspaceFiles: (sessionId: string, query: string, limit?: number) =>
    invokeCore<WorkspaceEntry[]>("agent_workspace_files", { request: { sessionId, query, limit } }),

  commandsList: (sessionId: string) =>
    invokeCore<CustomCommandInfo[]>("agent_commands_list", { request: { sessionId } }),

  skillsList: (sessionId: string) =>
    invokeCore<AgentSkillInfo[]>("agent_skills_list", { request: { sessionId } }),

  agentsList: (sessionId: string) =>
    invokeCore<AgentDefinitionInfo[]>("agent_agents_list", { request: { sessionId } }),

  pluginsList: (sessionId?: string) =>
    invokeCore<PluginInfo[]>("agent_plugins_list", { request: sessionId ? { sessionId } : {} }),

  /** Configuration evidence only; never connects to an external service. */
  pluginConnectionReceipts: (sessionId: string) =>
    invokeCore<PluginConnectionReceipt[]>("agent_plugin_connection_receipts", { request: { sessionId } }),

  pluginSetEnabled: (name: string, enabled: boolean) =>
    invokeCore<void>("agent_plugin_set_enabled", { request: { name, enabled } }),

  /** `source` is an absolute folder path or a git URL. Refuses to overwrite unless `replace`. */
  pluginInstall: (source: string, replace = false) =>
    invokeCore<PluginInfo>("agent_plugin_install", { request: { source, replace } }),

  pluginUninstall: (name: string) => invokeCore<void>("agent_plugin_uninstall", { request: { name } }),

  servicesStatus: (sessionId: string) =>
    invokeCore<AgentServicesStatus>("agent_services_status", { request: { sessionId } }),

  setComputerPermission: (sessionId: string, capture: boolean, control: boolean, allowedApps: string[]) =>
    invokeCore<AgentServicesStatus>("agent_computer_permission_set", { request: { sessionId, capture, control, allowedApps } }),

  emergencyStopComputer: () => invokeCore<void>("agent_computer_emergency_stop"),

  downloadControl: (sessionId: string, jobId: string, action: "pause" | "resume" | "cancel") =>
    invokeCore<PublicDownloadJob>("agent_download_control", { request: { sessionId, jobId, action } }),

  mediaList: (sessionId: string) =>
    invokeCore<MediaEntry[]>("agent_media_list", { request: { sessionId } }),

  downloadStart: (sessionId: string, input: DownloadStartInput) =>
    invokeCore<PublicDownloadJob>("agent_download_start", { request: { sessionId, ...input } }),

  downloadReveal: (sessionId: string, jobId: string) =>
    invokeCore<void>("agent_download_reveal", { request: { sessionId, jobId } }),

  recordingsList: (sessionId: string) =>
    invokeCore<RecordingEntry[]>("agent_recordings_list", { request: { sessionId } }),

  recordingReveal: (sessionId: string, path: string) =>
    invokeCore<void>("agent_recording_reveal", { request: { sessionId, path } }),

  browserSettingsGet: () => invokeCore<BrowserSettings>("agent_browser_settings_get"),

  browserSettingsSet: (sessionId: string, patch: { keepSignIns?: boolean; ffmpegPath?: string }) =>
    invokeCore<BrowserSettings>("agent_browser_settings_set", { request: { sessionId, ...patch } }),

  browserClearData: () => invokeCore<BrowserSettings>("agent_browser_clear_data"),

  browserOpenForSignin: (sessionId: string, url?: string) =>
    invokeCore<AgentServicesStatus>("agent_browser_open_for_signin", { request: { sessionId, ...(url ? { url } : {}) } }),

  workspaceTrust: (cwd: string) =>
    invokeCore<WorkspaceTrust>("agent_workspace_trust_status", { request: { cwd } }),

  setWorkspaceTrust: (cwd: string, fingerprint: string, trusted: boolean) =>
    invokeCore<WorkspaceTrust>("agent_workspace_trust_set", { request: { cwd, fingerprint, trusted } }),

  pickFolder: () => invokeCore<string | null>("agent_pick_folder"),

  /** Writes `<destDir>/omnia-export-<timestamp>/`. API keys and browser sign-ins are never included. */
  dataExport: (destDir: string) => invokeCore<DataExportResult>("agent_data_export", { request: { destDir } }),

  dataImport: (srcDir: string, mode: DataImportMode) =>
    invokeCore<DataImportSummary>("agent_data_import", { request: { srcDir, mode } }),

  listProfiles: (): Promise<ProviderProfileRecord[]> => desktop.listProviderProfiles(),

  async listModels(profileId: string): Promise<NativeProviderModel[]> {
    return (await desktop.listProviderModels(profileId)).models;
  },

  /** On-device dictation (Windows.Media.SpeechRecognition); never the online Web Speech API. */
  voiceStatus: () => invokeCore<VoiceStatus>("voice_status"),

  voiceStart: (language?: string) =>
    invokeCore<void>("voice_start", { request: language ? { language } : {} }),

  voiceStop: () => invokeCore<void>("voice_stop"),

  voiceOpenSettings: (target: VoiceSettingsTarget) =>
    invokeCore<void>("voice_open_settings", { request: { target } }),

  onVoiceEvent(handler: (payload: VoiceEventPayload) => void): Promise<UnlistenFn> {
    return listen<VoiceEventPayload>(VOICE_EVENT, (event) => handler(event.payload));
  },

  onEvent(handler: (payload: AgentEventPayload) => void): Promise<UnlistenFn> {
    return listen<AgentEventPayload>(AGENT_EVENT, (event) => handler(event.payload));
  },
};

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return typeof cause === "string" ? cause : "Something went wrong.";
}
