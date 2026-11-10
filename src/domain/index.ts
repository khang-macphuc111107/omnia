export * from "./agent-graph";
export * from "./agent-mailbox";
export * from "./agent-task-coordination";
export * from "./agent-task-dag";
export * from "./agent-runtime-adapter";
export * from "./agent-tool-contract-shared";
// The historical monolithic DAG remains available for compatibility, but its
// named exports intentionally overlap the split domain modules above/below.
// Keep it namespaced so consumers can opt into the legacy surface without
// making this barrel ambiguous under TypeScript's TS2308 checks.
export * as agentToolDag from "./agent-tool-dag";
export * from "./attachment-draft";
export * from "./browser-capture";
export * from "./omnia-browser-runtime-shell";
export * from "./isolated-input";
export * from "./virtual-pointer";
export * from "./omnia-surface-capture-runtime";
export * from "./capability";
export * from "./content";
export * from "./context";
export * from "./conversation";
export * from "./errors";
export * from "./execution";
export * from "./ids";
export * from "./integration-registry";
export * from "./omnia-integration-runtime-adapter";
export * from "./kernel-capability";
export * from "./learning-research";
export * from "./machine-runtime";
export * from "./omnia-runtime-controller";
export * from "./omnia-runtime-manifest-adapter";
export * from "./media-generation-job";
export * from "./media-generation-endpoint";
export * from "./memory";
export * from "./multimodal-bridge";
export * from "./omnia-agent-scheduler";
export * from "./omnia-app-state";
export * from "./omnia-automation";
export * from "./omnia-chat-runtime";
export * from "./omnia-official-harness-adapters";
// The provider execution adapter and the chat transport adapter intentionally
// share a handful of compatibility names (CanonicalContent, ProviderAdapter,
// ProviderError, usage/rate-limit projections, ...).  A star export for both
// modules makes this barrel fail under TypeScript's TS2308 check.  Keep the
// provider-execution names canonical at the barrel root and expose the complete
// chat transport surface with a stable prefix for the overlapping aliases.
export {
  CHAT_TRANSPORT_PROTOCOLS,
  CHAT_TRANSPORT_ROLES,
  CHAT_TRANSPORT_CAPABILITIES,
  CHAT_TRANSPORT_ERROR_CATEGORIES,
  CHAT_TRANSPORT_FINISH_REASONS,
  createChatTransportStreamState,
  applyChatTransportEvent,
  closeChatTransportStream,
  finalizeChatTransportStream,
  normalizeProviderStreamEvent,
  classifyChatTransportError,
  createBuiltInChatTransportAdapters,
  ChatTransportAdapterRegistry,
  createChatTransportAdapterRegistry,
} from "./omnia-chat-transport";
export type {
  ChatTransportProtocol,
  ChatTransportRole,
  ChatTransportCapability,
  ChatTransportContentBlock,
  ChatTransportMessage,
  ChatTransportInstruction,
  ChatTransportToolDefinition,
  ChatTransportResponseContract,
  ChatTransportRequest,
  ChatTransportAdapterDescriptor,
  ChatTransportTranslation,
  ChatTransportTranslationNote,
  ChatTransportConnectionInput,
  ChatTransportConnectionHealth,
  ChatTransportModelDescriptor,
  ChatTransportModelEvent,
  ChatTransportCapabilitySnapshot,
  ChatTransportValidationResult,
  ChatTransportTokenEstimate,
  ChatTransportExecutionContext,
  ChatTransportRequestHandle,
  ChatTransportCancelOutcome,
  ChatTransportFailureInput,
  ChatTransportErrorCategory,
  ChatTransportError,
  ChatTransportAdapter,
  ProviderStreamEventMetadata,
  ChatTransportFinishReason,
  ChatTransportEvent,
  ChatTransportUnknownEvent,
  NormalizedProviderStreamEvent,
  ChatTransportItemState,
  ChatTransportToolCallState,
  ChatTransportStreamStatus,
  ChatTransportEventIdentity,
  ChatTransportStreamState,
  CanonicalContent as ChatTransportCanonicalContent,
  ProviderError as ChatTransportProviderError,
  ProviderAdapter as ChatTransportProviderAdapter,
  CanonicalCitation as ChatTransportCanonicalCitation,
  NormalizedUsage as ChatTransportNormalizedUsage,
  NormalizedRateLimit as ChatTransportNormalizedRateLimit,
} from "./omnia-chat-transport";
export * from "./omnia-chat-store";
export * from "./omnia-command-registry";
export * from "./omnia-data-transfer";
// Broker-fed download orchestration (single, range, and segmented sources)
// is part of the public domain contract so renderer/native compositions can
// share the same bounded lifecycle types and transition helpers.
export * from "./omnia-download-manager";
// The Tauri-backed persistence composition is kept separate from the domain
// adapter so browser previews can remain in-memory, but it is still part of
// the public domain barrel for production callers that want the native port.
export * from "./omnia-desktop-persistence-port";
export * from "./omnia-editor-model";
export * from "./omnia-editor-runtime-adapter";
export * from "./omnia-event-log";
export * from "./omnia-media-pipeline";
export * from "./omnia-media-queue";
export * from "./omnia-media-runtime-adapter";
export * from "./omnia-memory-store";
export * from "./omnia-retrieval-memory-adapter";
export * from "./omnia-native-persistence-adapter";
export * from "./omnia-permission-policy";
export * from "./omnia-settings-permissions-adapter";
export * from "./omnia-plugin-registry";
export * from "./omnia-plugin-runtime-adapter";
export * from "./omnia-project-runtime";
export * from "./omnia-project-workbench-adapter";
export * from "./omnia-provider-execution-adapter";
export * from "./omnia-provider-catalog";
export * from "./omnia-retrieval-registry";
export * from "./retrieval-request-receipt";
export * from "./rag-provider-contract";
export * from "./rag-provider-local-adapter";
export * from "./omnia-provider-registry";
export * from "./omnia-workspace-index";
export * from "./parameters";
export * from "./model-compare";
export * from "./upstream-research-adapter";
// Native hosts can opt into the bounded upstream CLI/process contract without
// importing an implementation path directly.  The renderer still cannot
// spawn a process; this export only exposes the validated domain types and
// receipt builder to the trusted host adapter.
export * from "./upstream-process-adapter";
export * from "./project";
export * from "./prompt-library";
export * from "./prompt-navigation";
export * from "./provider";
export * from "./provider-catalog-health";
export * from "./provider-endpoint-capability";
export * from "./provider-multimodal";
export * from "./provider-telemetry-projection";
export * from "./provider-billing-reconciliation";
export * from "./queue-steer";
export * from "./remote-client";
export * from "./resource-handle";
export * from "./run";
export * from "./output-route";
export * from "./run-event-journal";
export * from "./run-graph";
export * from "./scientific-learning";
export * from "./secret-reference";
export * from "./shared";
export * from "./skill";
export * from "./telemetry";
export * from "./omnia-telemetry-learning-runtime";
export * from "./tool-registry";
export * from "./tool-runtime";
export * from "./omnia-feature-flags";
export * from "./omnia-toolchain-runtime-adapter";
export * from "./omnia-ultra-downloader";
export * from "./sovereign-browser-devtools";
export * from "./harness-throughput-optimizer";
export * from "./omnia-builtin-tools";
export * from "./session-dfs-tree";
export * from "./upstream-capability-catalog";
