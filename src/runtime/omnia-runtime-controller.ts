import {
  appendMessageToChatStore,
  archiveChatSessionInStore,
  createChatSessionInStore,
  createChatStore,
  deserializeChatStore,
  getActiveChatSession,
  getChatSession,
  renameChatSessionInStore,
  removeChatSessionInStore,
  selectChatSessionInStore,
  setChatSessionStatusInStore,
  type ChatStoreHistory,
} from "../domain/omnia-chat-store";
import {
  addAgentJob,
  claimAgentJob,
  completeAgentJob,
  createAgentScheduler,
  failAgentJob,
  getAgentJob,
  getAgentSchedulerStats,
  getBlockedAgentJobs,
  getReadyAgentJobs,
  releaseAgentJob,
  retryAgentJob,
  cancelAgentJob,
  type AgentJob,
  type AgentSchedulerStats,
} from "../domain/omnia-agent-scheduler";
import {
  enqueueOmniaAutomationRun,
  finishOmniaAutomationRun,
  listDueOmniaAutomations,
  pollDueOmniaAutomations,
  setOmniaAutomationStatus,
  startOmniaAutomationRun,
  summarizeOmniaAutomation,
  upsertOmniaAutomation,
  type OmniaAutomationDefinition,
  type OmniaAutomationDuePollResult,
  type OmniaAutomationRunStatus,
  type OmniaAutomationRuntime,
  type OmniaAutomationStatus,
  type OmniaAutomationTrigger,
} from "../domain/omnia-automation";
import {
  createOmniaAppState,
  deserializeOmniaAppState,
  serializeOmniaAppState,
  updateOmniaAppState,
  type OmniaAppState,
  type OmniaAppStatePatch,
} from "../domain/omnia-app-state";
import {
  createOmniaTransferBundle,
  createOmniaTransferItem,
  deserializeOmniaTransferBundle,
  type OmniaTransferBundle,
} from "../domain/omnia-data-transfer";
import {
  evaluateAllFeatureFlags as evaluateAllFeatureFlagsInRegistry,
  evaluateFeatureFlag as evaluateFeatureFlagInRegistry,
  evaluateFeatureFlags as evaluateFeatureFlagsInRegistry,
  getFeatureFlag,
  inspectFeatureFlagRegistry,
  projectFeatureFlagSummary,
  removeFeatureFlag,
  setFeatureFlagRollout,
  setFeatureFlagState,
  upsertFeatureFlag,
  type FeatureFlagContext,
  type FeatureFlagDefinition,
  type FeatureFlagEvaluation,
  type FeatureFlagEvaluationMap,
  type FeatureFlagEvaluationOptions,
  type FeatureFlagRegistryHealth,
  type FeatureFlagState,
} from "../domain/omnia-feature-flags";
import {
  appendOmniaEvent,
  type OmniaEventKind,
} from "../domain/omnia-event-log";
import {
  createEditorDocument,
  setEditorSelection,
  updateEditorBlock,
  type EditorBlock,
  type EditorDocument,
  type EditorSelection,
} from "../domain/omnia-editor-model";
import {
  dequeueMedia,
  enqueueMedia,
  retryMedia,
  transitionMedia,
  updateMediaProgress,
  type MediaKind,
  type MediaQueueStatus,
} from "../domain/omnia-media-queue";
import {
  createProjectRuntimeRecord,
  setProjectEnvironmentKeys,
  startProjectSession,
  stopProjectSession,
  transitionProject,
  type ProjectLifecycle,
} from "../domain/omnia-project-runtime";
import {
  removeProvider,
  removeProviderModel,
  selectProvider,
  setProviderEnabled,
  setProviderModelEnabled,
  upsertProvider,
  upsertProviderModel,
  type ProviderDefinition,
  type ProviderModel,
} from "../domain/omnia-provider-registry";
import {
  blockOmniaPlugin,
  disableOmniaPlugin,
  enableOmniaPlugin,
  installOmniaPlugin,
  registerOmniaPlugin,
  replaceOmniaPlugin,
  resetOmniaPluginSettings,
  selectOmniaPlugin,
  setOmniaPluginTrust,
  updateOmniaPluginSettings,
  type OmniaPluginManifest,
  type OmniaPluginRegistryQuery,
  type OmniaPluginRegistration,
  type OmniaPluginTrustInput,
} from "../domain/omnia-plugin-registry";
import {
  buildOmniaPluginRuntimeSnapshot,
  inspectOmniaPluginActivation,
  queryOmniaPluginRegistry,
  resolveOmniaPluginWithDependencies,
  summarizeOmniaPluginRegistry,
  type OmniaPluginActivationReadiness,
  type OmniaPluginRegistrySummary,
  type OmniaPluginRuntimeSnapshot,
} from "../domain/omnia-plugin-runtime-adapter";
import type { ChatStatus, NewChatMessage } from "../domain/omnia-chat-runtime";
import type { IsoTimestamp, JsonObject, JsonValue } from "../domain/shared";
import {
  OmniaAgentOrchestrationRuntime,
  deserializeOmniaAgentOrchestrationRuntime,
  serializeOmniaAgentOrchestrationRuntime,
  type AgentOrchestrationSummary,
  type ClaimLeaseRuntimeResult,
  type CompleteLeaseRuntimeResult,
  type OmniaAgentOrchestrationSnapshot,
} from "./omnia-agent-orchestration-runtime";
import type { AddAgentTaskInput, TransitionAgentTaskInput } from "../domain/agent-task-dag";
import type { AgentInstanceId } from "../domain/agent-tool-contract-shared";
import type { TaskId } from "../domain/ids";
import type {
  ClaimAgentTaskLeaseInput,
  CompleteAgentTaskLeaseInput,
  HeartbeatAgentTaskLeaseInput,
  ReleaseAgentTaskLeaseInput,
  AgentTaskLease,
} from "../domain/agent-task-coordination";

export type OmniaRuntimeEvent = {
  readonly revision: number;
  readonly label: string;
  readonly state: OmniaAppState;
};

export type OmniaRuntimeListener = (event: OmniaRuntimeEvent) => void;

export type OmniaAgentOrchestrationEvent = {
  readonly sequence: number;
  readonly label: string;
  readonly runtime: OmniaAgentOrchestrationRuntime | null;
};

export type OmniaAgentOrchestrationListener = (
  event: OmniaAgentOrchestrationEvent,
) => void;

export type OmniaRuntimeTransaction = (
  state: OmniaAppState,
) => OmniaAppStatePatch;

export type OmniaRuntimeOptions = {
  readonly initialState?: OmniaAppState;
  readonly historyLimit?: number;
  readonly now?: () => string;
  /** Optional typed DAG/lease runtime kept beside (not inside) app-state migrations. */
  readonly initialAgentOrchestration?:
    | OmniaAgentOrchestrationRuntime
    | OmniaAgentOrchestrationSnapshot
    | string
    | null;
};

export type OmniaRuntimeImportOptions = {
  readonly clearHistory?: boolean;
  readonly label?: string;
};

export type OmniaRuntimeTransferOptions = {
  readonly bundleId?: string;
  readonly createdAt?: IsoTimestamp;
  readonly source?: string;
  readonly metadata?: JsonObject;
};

function cloneState(state: OmniaAppState): OmniaAppState {
  return deserializeOmniaAppState(serializeOmniaAppState(state));
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isFinite(limit) || limit < 0) throw new Error("Runtime history limit must be finite and non-negative.");
  return Math.floor(limit);
}

function historyFromSnapshot(state: OmniaAppState): ChatStoreHistory {
  return createChatStore({
    sessions: state.chat.sessions,
    activeSessionId: state.chat.activeSessionId,
  });
}

function projectChat(chat: ChatStoreHistory): OmniaAppStatePatch {
  return { chat: chat.present };
}

function payloadRecord(values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { ...values };
}

function normalizeAgentOrchestration(
  input: OmniaRuntimeOptions["initialAgentOrchestration"] | undefined,
): OmniaAgentOrchestrationRuntime | null {
  if (input === undefined || input === null) return null;
  if (input instanceof OmniaAgentOrchestrationRuntime) return input;
  return deserializeOmniaAgentOrchestrationRuntime(input);
}

/**
 * Small composition root for the renderer and future Tauri adapters.
 *
 * It deliberately contains no React, Zustand, Tauri, filesystem, or network
 * imports. Domain mutations are applied atomically, recorded in the domain
 * event log, and exposed through a simple subscription API.
 */
export class OmniaRuntimeController {
  private state: OmniaAppState;
  private past: OmniaAppState[] = [];
  private future: OmniaAppState[] = [];
  private readonly listeners = new Set<OmniaRuntimeListener>();
  private readonly orchestrationListeners = new Set<OmniaAgentOrchestrationListener>();
  private readonly historyLimit: number;
  private readonly now: () => string;
  private orchestration: OmniaAgentOrchestrationRuntime | null;
  private orchestrationSequence = 0;

  public constructor(options: OmniaRuntimeOptions = {}) {
    this.historyLimit = normalizeLimit(options.historyLimit);
    this.now = options.now ?? (() => new Date().toISOString());
    this.state = cloneState(options.initialState ?? createOmniaAppState(this.now()));
    this.orchestration = normalizeAgentOrchestration(options.initialAgentOrchestration);
  }

  public getSnapshot(): OmniaAppState {
    return cloneState(this.state);
  }

  public subscribe(listener: OmniaRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribes to the typed orchestration sidecar without coupling it to app-state history. */
  public subscribeAgentOrchestration(listener: OmniaAgentOrchestrationListener): () => void {
    this.orchestrationListeners.add(listener);
    return () => this.orchestrationListeners.delete(listener);
  }

  public getAgentOrchestrationRuntime(): OmniaAgentOrchestrationRuntime | null {
    return this.orchestration;
  }

  public getAgentOrchestrationSnapshot(): OmniaAgentOrchestrationSnapshot | null {
    return this.orchestration?.snapshot ?? null;
  }

  public getAgentOrchestrationSummary(): AgentOrchestrationSummary | null {
    return this.orchestration?.summary() ?? null;
  }

  /** Replaces or clears the orchestration sidecar. The app-state undo stack is unchanged. */
  public replaceAgentOrchestrationRuntime(
    input: OmniaAgentOrchestrationRuntime | OmniaAgentOrchestrationSnapshot | string | null,
    options: { readonly label?: string } = {},
  ): OmniaAgentOrchestrationRuntime | null {
    this.orchestration = normalizeAgentOrchestration(input);
    this.emitAgentOrchestration(options.label ?? "orchestration.replace");
    return this.orchestration;
  }

  public exportAgentOrchestration(): string | null {
    return this.orchestration === null
      ? null
      : serializeOmniaAgentOrchestrationRuntime(this.orchestration);
  }

  public importAgentOrchestration(
    input: string | unknown,
    options: { readonly label?: string } = {},
  ): OmniaAgentOrchestrationRuntime {
    const runtime = deserializeOmniaAgentOrchestrationRuntime(input);
    this.orchestration = runtime;
    this.emitAgentOrchestration(options.label ?? "orchestration.import");
    return runtime;
  }

  public addOrchestrationTask(input: AddAgentTaskInput): OmniaAgentOrchestrationRuntime {
    return this.commitOrchestration(
      this.requireAgentOrchestration().addTask(input),
      "orchestration.task-added",
    );
  }

  public markOrchestrationTaskReady(taskId: TaskId, now: IsoTimestamp): OmniaAgentOrchestrationRuntime {
    return this.commitOrchestration(
      this.requireAgentOrchestration().markTaskReady(taskId, now),
      "orchestration.task-ready",
    );
  }

  public assignOrchestrationTask(
    taskId: TaskId,
    agentId: AgentInstanceId,
    now: IsoTimestamp,
  ): OmniaAgentOrchestrationRuntime {
    return this.commitOrchestration(
      this.requireAgentOrchestration().assignTask(taskId, agentId, now),
      "orchestration.task-assigned",
    );
  }

  public startOrchestrationTask(taskId: TaskId, now: IsoTimestamp): OmniaAgentOrchestrationRuntime {
    return this.commitOrchestration(
      this.requireAgentOrchestration().startTask(taskId, now),
      "orchestration.task-started",
    );
  }

  public transitionOrchestrationTask(input: TransitionAgentTaskInput): OmniaAgentOrchestrationRuntime {
    return this.commitOrchestration(
      this.requireAgentOrchestration().transitionTask(input),
      "orchestration.task-transitioned",
    );
  }

  public claimOrchestrationLease(input: ClaimAgentTaskLeaseInput): ClaimLeaseRuntimeResult {
    const result = this.requireAgentOrchestration().claimLease(input);
    this.orchestration = result.runtime;
    this.emitAgentOrchestration("orchestration.lease-claimed");
    return result;
  }

  public heartbeatOrchestrationLease(input: HeartbeatAgentTaskLeaseInput): OmniaAgentOrchestrationRuntime {
    return this.commitOrchestration(
      this.requireAgentOrchestration().heartbeatLease(input),
      "orchestration.lease-heartbeat",
    );
  }

  public releaseOrchestrationLease(input: ReleaseAgentTaskLeaseInput): OmniaAgentOrchestrationRuntime {
    return this.commitOrchestration(
      this.requireAgentOrchestration().releaseLease(input),
      "orchestration.lease-released",
    );
  }

  public expireOrchestrationLeases(
    expectedRevision: number,
    now: IsoTimestamp,
  ): { readonly runtime: OmniaAgentOrchestrationRuntime; readonly expiredLeaseEpochs: readonly number[] } {
    const result = this.requireAgentOrchestration().expireLeases(expectedRevision, now);
    this.orchestration = result.runtime;
    this.emitAgentOrchestration("orchestration.leases-expired");
    return result;
  }

  public completeOrchestrationLease(input: CompleteAgentTaskLeaseInput): CompleteLeaseRuntimeResult {
    const result = this.requireAgentOrchestration().completeLease(input);
    this.orchestration = result.runtime;
    this.emitAgentOrchestration(result.replayed ? "orchestration.lease-completion-replayed" : "orchestration.lease-completed");
    return result;
  }

  public activeOrchestrationLease(taskId: TaskId): AgentTaskLease | undefined {
    return this.requireAgentOrchestration().activeLeaseForTask(taskId);
  }

  public canRunOrchestrationTasksInParallel(leftTaskId: TaskId, rightTaskId: TaskId): boolean {
    return this.requireAgentOrchestration().canRunInParallel(leftTaskId, rightTaskId);
  }

  private requireAgentOrchestration(): OmniaAgentOrchestrationRuntime {
    if (this.orchestration === null) {
      throw new Error("Agent orchestration runtime is not initialized.");
    }
    return this.orchestration;
  }

  private commitOrchestration(
    runtime: OmniaAgentOrchestrationRuntime,
    label: string,
  ): OmniaAgentOrchestrationRuntime {
    this.orchestration = runtime;
    this.emitAgentOrchestration(label);
    return runtime;
  }

  private emitAgentOrchestration(label: string): void {
    const event: OmniaAgentOrchestrationEvent = {
      sequence: ++this.orchestrationSequence,
      label,
      runtime: this.orchestration,
    };
    for (const listener of this.orchestrationListeners) listener(event);
  }

  public canUndo(): boolean {
    return this.past.length > 0;
  }

  public canRedo(): boolean {
    return this.future.length > 0;
  }

  public transaction(
    label: string,
    change: OmniaRuntimeTransaction,
    event?: {
      readonly kind?: OmniaEventKind;
      readonly type?: string;
      readonly payload?: Readonly<Record<string, unknown>>;
    },
  ): OmniaAppState {
    const previous = this.state;
    const patch = change(previous);
    const updated = updateOmniaAppState(previous, patch, this.now());
    const next = event === undefined
      ? updated
      : updateOmniaAppState(updated, {
          events: appendOmniaEvent(
            updated.events,
            event.kind ?? "system",
            event.type ?? label,
            payloadRecord(event.payload ?? {}),
            this.now(),
          ),
        }, this.now());
    if (next.revision === previous.revision) return this.getSnapshot();
    this.pushHistory(previous);
    this.state = next;
    this.future = [];
    this.emit(label);
    return this.getSnapshot();
  }

  public replaceState(state: OmniaAppState, options: OmniaRuntimeImportOptions = {}): OmniaAppState {
    const next = cloneState(state);
    if (options.clearHistory !== false) {
      this.past = [];
      this.future = [];
    } else {
      this.pushHistory(this.state);
      this.future = [];
    }
    this.state = next;
    this.emit(options.label ?? "replace-state");
    return this.getSnapshot();
  }

  public exportState(): string {
    return serializeOmniaAppState(this.state);
  }

  public importState(input: string | unknown, options: OmniaRuntimeImportOptions = {}): OmniaAppState {
    return this.replaceState(deserializeOmniaAppState(input), options);
  }

  /**
   * Exports the canonical app state as one validated, portable transfer item.
   *
   * The orchestration sidecar is intentionally excluded: it has its own
   * versioned runtime contract and remains independent from app-state
   * migrations/history. Native persistence adapters can validate and persist
   * the returned bundle without depending on renderer store shapes.
   */
  public exportTransferBundle(
    options: OmniaRuntimeTransferOptions = {},
  ): OmniaTransferBundle {
    const snapshot = this.getSnapshot();
    const serializedState = serializeOmniaAppState(snapshot);

    return createOmniaTransferBundle({
      ...(options.bundleId === undefined ? {} : { bundleId: options.bundleId }),
      createdAt: options.createdAt ?? this.now(),
      source: options.source ?? "omnia.runtime",
      metadata: {
        ...(options.metadata ?? {}),
        appStateVersion: snapshot.version,
      },
      items: [
        createOmniaTransferItem({
          kind: "custom",
          id: "omnia.app-state",
          revision: snapshot.revision,
          updatedAt: snapshot.updatedAt,
          // serializeOmniaAppState performs the canonical deep clone and
          // strict validation; parsing it here produces transfer-safe JSON.
          value: JSON.parse(serializedState) as JsonValue,
        }),
      ],
    });
  }

  /**
   * Imports a validated transfer bundle and replaces the canonical app state.
   * The existing replaceState path preserves the runtime's history semantics.
   */
  public importTransferBundle(
    input: string | unknown,
    options: OmniaRuntimeImportOptions = {},
  ): OmniaAppState {
    const bundle = deserializeOmniaTransferBundle(input);
    const stateItem = bundle.items.find(
      (item) => item.kind === "custom" && item.id === "omnia.app-state",
    );
    if (stateItem === undefined) {
      throw new Error("Transfer bundle does not contain an Omnia app-state item.");
    }

    return this.replaceState(deserializeOmniaAppState(stateItem.value), {
      ...options,
      label: options.label ?? "transfer.import",
    });
  }

  public undo(): OmniaAppState {
    const previous = this.past.pop();
    if (previous === undefined) return this.getSnapshot();
    this.future.unshift(this.state);
    this.state = previous;
    this.emit("undo");
    return this.getSnapshot();
  }

  public redo(): OmniaAppState {
    const next = this.future.shift();
    if (next === undefined) return this.getSnapshot();
    this.past.push(this.state);
    this.state = next;
    this.emit("redo");
    return this.getSnapshot();
  }

  public resetHistory(): void {
    this.past = [];
    this.future = [];
  }

  public createChat(title = "New chat", activate = true): OmniaAppState {
    return this.transaction(
      "chat.create",
      (state) => projectChat(createChatSessionInStore(historyFromSnapshot(state), { title, activate })),
      { kind: "chat", type: "chat.created", payload: { title } },
    );
  }

  public appendChatMessage(sessionId: string, input: NewChatMessage): OmniaAppState {
    return this.transaction(
      "chat.append-message",
      (state) => projectChat(appendMessageToChatStore(historyFromSnapshot(state), sessionId, input)),
      { kind: "chat", type: "chat.message-appended", payload: { sessionId, role: input.role } },
    );
  }

  public renameChat(sessionId: string, title: string): OmniaAppState {
    return this.transaction(
      "chat.rename",
      (state) => projectChat(renameChatSessionInStore(historyFromSnapshot(state), sessionId, title)),
      { kind: "chat", type: "chat.renamed", payload: { sessionId } },
    );
  }

  public setChatStatus(sessionId: string, status: ChatStatus): OmniaAppState {
    return this.transaction(
      "chat.status",
      (state) => projectChat(setChatSessionStatusInStore(historyFromSnapshot(state), sessionId, status)),
      { kind: "chat", type: "chat.status-changed", payload: { sessionId, status } },
    );
  }

  public selectChat(sessionId: string | null): OmniaAppState {
    return this.transaction(
      "chat.select",
      (state) => projectChat(selectChatSessionInStore(historyFromSnapshot(state), sessionId)),
      { kind: "chat", type: "chat.selected", payload: { sessionId } },
    );
  }

  public archiveChat(sessionId: string): OmniaAppState {
    return this.transaction(
      "chat.archive",
      (state) => projectChat(archiveChatSessionInStore(historyFromSnapshot(state), sessionId)),
      { kind: "chat", type: "chat.archived", payload: { sessionId } },
    );
  }

  public deleteChat(sessionId: string): OmniaAppState {
    return this.transaction(
      "chat.delete",
      (state) => projectChat(removeChatSessionInStore(historyFromSnapshot(state), sessionId)),
      { kind: "chat", type: "chat.deleted", payload: { sessionId } },
    );
  }

  public createProject(name: string, rootPath: string): OmniaAppState {
    return this.transaction(
      "project.create",
      (state) => ({ projects: createProjectRuntimeRecord(state.projects, name, rootPath, this.now()) }),
      { kind: "project", type: "project.created", payload: { name, rootPath } },
    );
  }

  public transitionProject(projectId: string, lifecycle: ProjectLifecycle): OmniaAppState {
    return this.transaction(
      "project.transition",
      (state) => ({ projects: transitionProject(state.projects, projectId, lifecycle, this.now()) }),
      { kind: "project", type: "project.lifecycle-changed", payload: { projectId, lifecycle } },
    );
  }

  public startProjectSession(projectId: string, sessionId?: string, runtimeId?: string): OmniaAppState {
    return this.transaction(
      "project.session-start",
      (state) => sessionId === undefined
        ? ({ projects: startProjectSession(state.projects, projectId, undefined, runtimeId, this.now()) })
        : ({ projects: startProjectSession(state.projects, projectId, sessionId, runtimeId, this.now()) }),
      { kind: "project", type: "project.session-started", payload: { projectId, sessionId: sessionId ?? null } },
    );
  }

  public stopProjectSession(projectId: string, sessionId: string, status: "stopped" | "failed" = "stopped"): OmniaAppState {
    return this.transaction(
      "project.session-stop",
      (state) => ({ projects: stopProjectSession(state.projects, projectId, sessionId, status, this.now()) }),
      { kind: "project", type: "project.session-stopped", payload: { projectId, sessionId, status } },
    );
  }

  public setProjectEnvironmentKeys(projectId: string, keys: readonly string[]): OmniaAppState {
    return this.transaction(
      "project.environment-keys",
      (state) => ({ projects: setProjectEnvironmentKeys(state.projects, projectId, keys, this.now()) }),
      { kind: "project", type: "project.environment-keys-updated", payload: { projectId, count: keys.length } },
    );
  }

  public upsertProvider(provider: ProviderDefinition): OmniaAppState {
    return this.transaction(
      "provider.upsert",
      (state) => ({ providers: upsertProvider(state.providers, provider) }),
      { kind: "provider", type: "provider.upserted", payload: { providerId: provider.id } },
    );
  }

  public setProviderEnabled(providerId: string, enabled: boolean): OmniaAppState {
    return this.transaction(
      "provider.enabled",
      (state) => ({ providers: setProviderEnabled(state.providers, providerId, enabled) }),
      { kind: "provider", type: "provider.enabled-changed", payload: { providerId, enabled } },
    );
  }

  public removeProvider(providerId: string): OmniaAppState {
    return this.transaction(
      "provider.remove",
      (state) => ({ providers: removeProvider(state.providers, providerId) }),
      { kind: "provider", type: "provider.removed", payload: { providerId } },
    );
  }

  public upsertProviderModel(providerId: string, model: ProviderModel): OmniaAppState {
    return this.transaction(
      "provider.model-upsert",
      (state) => ({ providers: upsertProviderModel(state.providers, providerId, model) }),
      { kind: "provider", type: "provider.model-upserted", payload: { providerId, modelId: model.id } },
    );
  }

  public setProviderModelEnabled(providerId: string, modelId: string, enabled: boolean): OmniaAppState {
    return this.transaction(
      "provider.model-enabled",
      (state) => ({ providers: setProviderModelEnabled(state.providers, providerId, modelId, enabled) }),
      { kind: "provider", type: "provider.model-enabled-changed", payload: { providerId, modelId, enabled } },
    );
  }

  public removeProviderModel(providerId: string, modelId: string): OmniaAppState {
    return this.transaction(
      "provider.model-remove",
      (state) => ({ providers: removeProviderModel(state.providers, providerId, modelId) }),
      { kind: "provider", type: "provider.model-removed", payload: { providerId, modelId } },
    );
  }

  public selectProvider(providerId: string, modelId?: string): OmniaAppState {
    return this.transaction(
      "provider.select",
      (state) => modelId === undefined
        ? ({ providers: selectProvider(state.providers, providerId) })
        : ({ providers: selectProvider(state.providers, providerId, modelId) }),
      { kind: "provider", type: "provider.selected", payload: { providerId, modelId: modelId ?? null } },
    );
  }

  /** Registers plugin metadata without installing or granting native authority. */
  public registerPlugin(manifest: OmniaPluginManifest): OmniaAppState {
    return this.transaction(
      "plugin.register",
      (state) => ({ plugins: registerOmniaPlugin(state.plugins, manifest) }),
      { kind: "system", type: "plugin.registered", payload: { pluginId: manifest.id, source: manifest.source } },
    );
  }

  /** Replaces a manifest while preserving compatible setting values. */
  public replacePlugin(manifest: OmniaPluginManifest): OmniaAppState {
    return this.transaction(
      "plugin.replace",
      (state) => ({ plugins: replaceOmniaPlugin(state.plugins, manifest) }),
      { kind: "system", type: "plugin.replaced", payload: { pluginId: manifest.id, version: manifest.version } },
    );
  }

  /** Updates trust metadata; this is still only a renderer/native-neutral record. */
  public setPluginTrust(pluginId: string, input: Omit<OmniaPluginTrustInput, "at"> & { readonly at?: string }): OmniaAppState {
    const at = input.at ?? this.now();
    return this.transaction(
      "plugin.trust",
      (state) => ({ plugins: setOmniaPluginTrust(state.plugins, pluginId, { ...input, at }) }),
      { kind: "system", type: "plugin.trust-updated", payload: { pluginId, trust: input.trust, reason: input.reason ?? null } },
    );
  }

  public installPlugin(pluginId: string): OmniaAppState {
    return this.transaction(
      "plugin.install",
      (state) => ({ plugins: installOmniaPlugin(state.plugins, pluginId, this.now()) }),
      { kind: "system", type: "plugin.installed", payload: { pluginId } },
    );
  }

  public enablePlugin(pluginId: string): OmniaAppState {
    return this.transaction(
      "plugin.enable",
      (state) => ({ plugins: enableOmniaPlugin(state.plugins, pluginId, this.now()) }),
      { kind: "system", type: "plugin.enabled", payload: { pluginId } },
    );
  }

  public disablePlugin(pluginId: string): OmniaAppState {
    return this.transaction(
      "plugin.disable",
      (state) => ({ plugins: disableOmniaPlugin(state.plugins, pluginId, this.now()) }),
      { kind: "system", type: "plugin.disabled", payload: { pluginId } },
    );
  }

  public blockPlugin(pluginId: string, reason: string): OmniaAppState {
    return this.transaction(
      "plugin.block",
      (state) => ({ plugins: blockOmniaPlugin(state.plugins, pluginId, this.now(), reason) }),
      { kind: "system", type: "plugin.blocked", payload: { pluginId, reason } },
    );
  }

  public selectPlugin(pluginId: string): OmniaAppState {
    return this.transaction(
      "plugin.select",
      (state) => ({ plugins: selectOmniaPlugin(state.plugins, pluginId) }),
      { kind: "system", type: "plugin.selected", payload: { pluginId } },
    );
  }

  public updatePluginSettings(
    pluginId: string,
    values: Readonly<Record<string, import("../domain/shared").JsonValue>>,
  ): OmniaAppState {
    return this.transaction(
      "plugin.settings-update",
      (state) => ({ plugins: updateOmniaPluginSettings(state.plugins, pluginId, values) }),
      { kind: "system", type: "plugin.settings-updated", payload: { pluginId, keys: Object.keys(values) } },
    );
  }

  public resetPluginSettings(pluginId: string): OmniaAppState {
    return this.transaction(
      "plugin.settings-reset",
      (state) => ({ plugins: resetOmniaPluginSettings(state.plugins, pluginId) }),
      { kind: "system", type: "plugin.settings-reset", payload: { pluginId } },
    );
  }

  public queryPlugins(query: OmniaPluginRegistryQuery = {}): readonly OmniaPluginRegistration[] {
    return queryOmniaPluginRegistry(this.getSnapshot().plugins, query);
  }

  public inspectPlugin(pluginId: string): OmniaPluginActivationReadiness {
    return inspectOmniaPluginActivation(this.getSnapshot().plugins, pluginId);
  }

  public getPluginSummary(): OmniaPluginRegistrySummary {
    return summarizeOmniaPluginRegistry(this.getSnapshot().plugins);
  }

  /** Returns a renderer-safe runtime projection; no plugin process is started. */
  public getPluginRuntimeSnapshot(at = this.now()): OmniaPluginRuntimeSnapshot {
    return buildOmniaPluginRuntimeSnapshot(this.getSnapshot().plugins, at);
  }

  /** Resolves an enabled plugin after trust and dependency checks. */
  public resolvePlugin(pluginId: string): OmniaPluginRegistration {
    return resolveOmniaPluginWithDependencies(this.getSnapshot().plugins, pluginId);
  }

  /** Adds or replaces one renderer-safe feature-flag definition. */
  public upsertFeatureFlag(definition: FeatureFlagDefinition): OmniaAppState {
    return this.transaction(
      "feature-flag.upsert",
      (state) => ({ featureFlags: upsertFeatureFlag(state.featureFlags, definition, this.now()) }),
      { kind: "system", type: "feature-flag.upserted", payload: { key: definition.key } },
    );
  }

  /** Removes one feature flag from the durable-looking app snapshot. */
  public removeFeatureFlag(key: string): OmniaAppState {
    return this.transaction(
      "feature-flag.remove",
      (state) => ({ featureFlags: removeFeatureFlag(state.featureFlags, key) }),
      { kind: "system", type: "feature-flag.removed", payload: { key } },
    );
  }

  /** Changes lifecycle state while preserving the feature-flag definition. */
  public setFeatureFlagState(key: string, state: FeatureFlagState): OmniaAppState {
    return this.transaction(
      "feature-flag.state",
      (snapshot) => ({ featureFlags: setFeatureFlagState(snapshot.featureFlags, key, state, this.now()) }),
      { kind: "system", type: "feature-flag.state-changed", payload: { key, state } },
    );
  }

  /** Updates (or clears) the percentage rollout for one feature flag. */
  public setFeatureFlagRollout(key: string, rolloutPercentage: number | undefined): OmniaAppState {
    return this.transaction(
      "feature-flag.rollout",
      (state) => ({ featureFlags: setFeatureFlagRollout(state.featureFlags, key, rolloutPercentage, this.now()) }),
      {
        kind: "system",
        type: "feature-flag.rollout-changed",
        payload: { key, rolloutPercentage: rolloutPercentage ?? null },
      },
    );
  }

  public getFeatureFlag(key: string): FeatureFlagDefinition | undefined {
    return getFeatureFlag(this.getSnapshot().featureFlags, key);
  }

  /** Evaluates one flag against a caller-provided, renderer-local context. */
  public evaluateFeatureFlag(
    key: string,
    context: FeatureFlagContext = {},
    options: FeatureFlagEvaluationOptions = {},
  ): FeatureFlagEvaluation {
    return evaluateFeatureFlagInRegistry(this.getSnapshot().featureFlags, key, context, options);
  }

  /** Evaluates selected flags while preserving first-seen order. */
  public evaluateFeatureFlags(
    keys: readonly string[],
    context: FeatureFlagContext = {},
    options: FeatureFlagEvaluationOptions = {},
  ): readonly FeatureFlagEvaluation[] {
    return evaluateFeatureFlagsInRegistry(this.getSnapshot().featureFlags, keys, context, options);
  }

  /** Evaluates every registered flag into a stable key-addressable map. */
  public evaluateAllFeatureFlags(
    context: FeatureFlagContext = {},
    options: FeatureFlagEvaluationOptions = {},
  ): FeatureFlagEvaluationMap {
    return evaluateAllFeatureFlagsInRegistry(this.getSnapshot().featureFlags, context, options);
  }

  public inspectFeatureFlagRegistry(): FeatureFlagRegistryHealth {
    return inspectFeatureFlagRegistry(this.getSnapshot().featureFlags);
  }

  public getFeatureFlagSummary(): ReturnType<typeof projectFeatureFlagSummary> {
    return projectFeatureFlagSummary(this.getSnapshot().featureFlags);
  }

  public updateEditorBlock(blockId: string, patch: Partial<Omit<EditorBlock, "id">>): OmniaAppState {
    return this.transaction(
      "editor.block-update",
      (state) => ({ editor: updateEditorBlock(state.editor, blockId, patch, this.now()) }),
      { kind: "system", type: "editor.block-updated", payload: { blockId } },
    );
  }

  public setEditorSelection(selection: EditorSelection | undefined): OmniaAppState {
    return this.transaction(
      "editor.selection",
      (state) => ({ editor: setEditorSelection(state.editor, selection) }),
      { kind: "system", type: "editor.selection-changed", payload: { blockId: selection?.blockId ?? null } },
    );
  }

  public replaceEditor(document: EditorDocument): OmniaAppState {
    return this.transaction(
      "editor.replace",
      () => ({ editor: document }),
      { kind: "system", type: "editor.replaced", payload: { documentId: document.id } },
    );
  }

  public enqueueMedia(kind: MediaKind, prompt: string): OmniaAppState {
    return this.transaction(
      "media.enqueue",
      (state) => ({ media: enqueueMedia(state.media, kind, prompt, this.now()) }),
      { kind: "media", type: "media.queued", payload: { kind } },
    );
  }

  public updateMediaProgress(id: string, progress: number): OmniaAppState {
    return this.transaction(
      "media.progress",
      (state) => ({ media: updateMediaProgress(state.media, id, progress, this.now()) }),
      { kind: "media", type: "media.progress-updated", payload: { id, progress } },
    );
  }

  public transitionMedia(id: string, status: MediaQueueStatus, error?: string): OmniaAppState {
    return this.transaction(
      "media.transition",
      (state) => error === undefined
        ? ({ media: transitionMedia(state.media, id, status, this.now()) })
        : ({ media: transitionMedia(state.media, id, status, this.now(), error) }),
      { kind: "media", type: "media.status-changed", payload: { id, status } },
    );
  }

  public retryMedia(id: string): OmniaAppState {
    return this.transaction(
      "media.retry",
      (state) => ({ media: retryMedia(state.media, id, this.now()) }),
      { kind: "media", type: "media.retried", payload: { id } },
    );
  }

  public deleteMedia(id: string): OmniaAppState {
    return this.transaction(
      "media.delete",
      (state) => ({ media: dequeueMedia(state.media, id) }),
      { kind: "media", type: "media.deleted", payload: { id } },
    );
  }

  public addAgentJob(label: string, dependencies: readonly string[] = [], capabilities: readonly string[] = []): OmniaAppState {
    return this.transaction(
      "agent.enqueue",
      (state) => ({ agents: addAgentJob(state.agents, label, dependencies, capabilities, this.now()) }),
      { kind: "agent", type: "agent.job-added", payload: { label } },
    );
  }

  public claimAgentJob(jobId: string, workerId: string): OmniaAppState {
    return this.transaction(
      "agent.claim",
      (state) => ({ agents: claimAgentJob(state.agents, jobId, workerId, this.now()) }),
      { kind: "agent", type: "agent.job-claimed", payload: { jobId, workerId } },
    );
  }

  public completeAgentJob(jobId: string, workerId?: string): OmniaAppState {
    return this.transaction(
      "agent.complete",
      (state) => ({ agents: completeAgentJob(state.agents, jobId, this.now(), workerId) }),
      { kind: "agent", type: "agent.job-completed", payload: { jobId, workerId: workerId ?? null } },
    );
  }

  public failAgentJob(jobId: string, error: string, workerId?: string): OmniaAppState {
    return this.transaction(
      "agent.fail",
      (state) => ({ agents: failAgentJob(state.agents, jobId, error, this.now(), workerId) }),
      { kind: "agent", type: "agent.job-failed", payload: { jobId, workerId: workerId ?? null } },
    );
  }

  public releaseAgentJob(jobId: string, workerId?: string): OmniaAppState {
    return this.transaction(
      "agent.release",
      (state) => ({ agents: releaseAgentJob(state.agents, jobId, this.now(), workerId) }),
      { kind: "agent", type: "agent.job-released", payload: { jobId, workerId: workerId ?? null } },
    );
  }

  public retryAgentJob(jobId: string): OmniaAppState {
    return this.transaction(
      "agent.retry",
      (state) => ({ agents: retryAgentJob(state.agents, jobId, this.now()) }),
      { kind: "agent", type: "agent.job-retried", payload: { jobId } },
    );
  }

  public cancelAgentJob(jobId: string): OmniaAppState {
    return this.transaction(
      "agent.cancel",
      (state) => ({ agents: cancelAgentJob(state.agents, jobId, this.now()) }),
      { kind: "agent", type: "agent.job-cancelled", payload: { jobId } },
    );
  }

  public getAgentJob(jobId: string): AgentJob | undefined {
    return getAgentJob(this.getSnapshot().agents, jobId);
  }

  public getReadyAgentJobs(): readonly AgentJob[] {
    return getReadyAgentJobs(this.getSnapshot().agents);
  }

  public getBlockedAgentJobs(): readonly AgentJob[] {
    return getBlockedAgentJobs(this.getSnapshot().agents);
  }

  public getAgentSchedulerStats(): AgentSchedulerStats {
    return getAgentSchedulerStats(this.getSnapshot().agents);
  }

  /** Adds or replaces one automation definition in the durable app snapshot. */
  public upsertAutomation(definition: OmniaAutomationDefinition): OmniaAppState {
    return this.transaction(
      "automation.upsert",
      (state) => ({ automation: upsertOmniaAutomation(state.automation, definition) }),
      { kind: "system", type: "automation.upserted", payload: { automationId: definition.id } },
    );
  }

  /** Changes lifecycle state while preserving the automation definition. */
  public setAutomationStatus(automationId: string, status: OmniaAutomationStatus): OmniaAppState {
    return this.transaction(
      "automation.status",
      (state) => ({ automation: setOmniaAutomationStatus(state.automation, automationId, status, this.now()) }),
      { kind: "system", type: "automation.status-changed", payload: { automationId, status } },
    );
  }

  /** Enqueues a manual/event run while enforcing the definition's concurrency policy. */
  public enqueueAutomationRun(
    automationId: string,
    trigger?: OmniaAutomationTrigger,
    metadata: JsonObject = {},
  ): OmniaAppState {
    return this.transaction(
      "automation.enqueue-run",
      (state) => ({ automation: enqueueOmniaAutomationRun(state.automation, automationId, trigger, metadata, this.now()) }),
      { kind: "system", type: "automation.run-queued", payload: { automationId, trigger: trigger ?? null } },
    );
  }

  public startAutomationRun(runId: string): OmniaAppState {
    return this.transaction(
      "automation.start-run",
      (state) => ({ automation: startOmniaAutomationRun(state.automation, runId, this.now()) }),
      { kind: "system", type: "automation.run-started", payload: { runId } },
    );
  }

  public finishAutomationRun(
    runId: string,
    status: Exclude<OmniaAutomationRunStatus, "queued" | "running">,
    options: { readonly error?: string; readonly resultRef?: string } = {},
  ): OmniaAppState {
    return this.transaction(
      "automation.finish-run",
      (state) => ({ automation: finishOmniaAutomationRun(state.automation, runId, status, { ...options, finishedAt: this.now() }) }),
      { kind: "system", type: "automation.run-finished", payload: { runId, status } },
    );
  }

  /** Lists active cadence definitions whose projected next run is due. */
  public listDueAutomations(at = this.now()): readonly OmniaAutomationDefinition[] {
    return listDueOmniaAutomations(this.state.automation, at);
  }

  /**
   * Queues each currently projected cadence occurrence at most once.
   *
   * Schedule calculation/advancement remains outside this controller (for
   * example in a native calendar/cron adapter). This method only persists the
   * due occurrence marker and therefore stays deterministic in browser mode.
   */
  public pollDueAutomations(at = this.now()): OmniaAutomationDuePollResult {
    const result = pollDueOmniaAutomations(this.state.automation, at);
    const updated = this.transaction(
      "automation.poll-due",
      () => ({ automation: result.runtime }),
      {
        kind: "system",
        type: "automation.due-polled",
        payload: {
          at,
          queuedCount: result.queuedRunIds.length,
          skippedCount: result.skipped.length,
          queuedRunIds: [...result.queuedRunIds],
        },
      },
    );
    return { ...result, runtime: updated.automation };
  }

  public summarizeAutomation(automationId: string): ReturnType<typeof summarizeOmniaAutomation> {
    return summarizeOmniaAutomation(this.state.automation, automationId);
  }

  public getAutomationRuntime(): OmniaAutomationRuntime {
    const runtime = this.getSnapshot().automation;
    return {
      ...runtime,
      automations: runtime.automations.map((automation) => ({
        ...automation,
        ...(automation.schedule ? { schedule: { ...automation.schedule } } : {}),
        conditions: automation.conditions.map((condition) => ({ ...condition })),
        metadata: { ...automation.metadata },
      })),
      runs: runtime.runs.map((run) => ({ ...run, metadata: { ...run.metadata } })),
    };
  }

  private pushHistory(state: OmniaAppState): void {
    if (this.historyLimit <= 0) return;
    this.past = [...this.past, cloneState(state)].slice(-this.historyLimit);
  }

  private emit(label: string): void {
    const event: OmniaRuntimeEvent = {
      revision: this.state.revision,
      label,
      state: this.getSnapshot(),
    };
    for (const listener of this.listeners) listener(event);
  }
}

export function createOmniaRuntimeController(options: OmniaRuntimeOptions = {}): OmniaRuntimeController {
  return new OmniaRuntimeController(options);
}

export function getRuntimeActiveChat(controller: OmniaRuntimeController) {
  return getActiveChatSession({
    version: 1,
    past: [],
    present: controller.getSnapshot().chat,
    future: [],
    historyLimit: 0,
  });
}

export function getRuntimeChat(controller: OmniaRuntimeController, sessionId: string) {
  return getChatSession(controller.getSnapshot().chat, sessionId);
}

export function createRuntimeEditor(title = "Untitled"): EditorDocument {
  return createEditorDocument(title);
}

export function createRuntimeAgentScheduler(concurrency = 1) {
  return createAgentScheduler(concurrency);
}

export function deserializeRuntimeChat(input: string | unknown) {
  return deserializeChatStore(input);
}

