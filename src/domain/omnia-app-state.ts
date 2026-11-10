import {
  createAgentScheduler,
  type AgentScheduler,
  deserializeAgentScheduler,
} from './omnia-agent-scheduler';
import {
  createOmniaAutomationRuntime,
  deserializeOmniaAutomationRuntime,
  type OmniaAutomationRuntime,
} from './omnia-automation';
import {
  createChatStore,
  deserializeChatStore,
  type ChatStoreSnapshot,
} from './omnia-chat-store';
import {
  createEditorDocument,
  deserializeEditorDocument,
  type EditorDocument,
} from './omnia-editor-model';
import {
  createOmniaEventLog,
  deserializeOmniaEventLog,
  type OmniaEventLog,
} from './omnia-event-log';
import {
  createMediaQueue,
  deserializeMediaQueue,
  type MediaQueue,
} from './omnia-media-queue';
import {
  createPermissionPolicy,
  deserializePermissionPolicy,
  type PermissionPolicy,
} from './omnia-permission-policy';
import {
  createProjectRuntime,
  deserializeProjectRuntime,
  type ProjectRuntime,
} from './omnia-project-runtime';
import {
  createProviderRegistry,
  deserializeProviderRegistry,
  type ProviderRegistry,
} from './omnia-provider-registry';
import {
  createFeatureFlagRegistry,
  deserializeFeatureFlagRegistry,
  type FeatureFlagRegistry,
} from './omnia-feature-flags';
import {
  createOmniaPluginRegistry,
  deserializeOmniaPluginRegistry,
  type OmniaPluginRegistry,
} from './omnia-plugin-registry';

/**
 * Renderer-safe composition root for Omnia's durable-looking app state.
 *
 * This is deliberately a pure data contract. Persistence, provider execution,
 * filesystem access, and native command invocation belong to adapters outside
 * this module. The same state can therefore be hydrated by a browser preview
 * or by a Tauri runtime without changing the domain shape.
 */
export type OmniaAppState = {
  readonly version: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly chat: ChatStoreSnapshot;
  readonly permissions: PermissionPolicy;
  readonly providers: ProviderRegistry;
  /** Renderer/native-neutral plugin registrations and lifecycle state. */
  readonly plugins: OmniaPluginRegistry;
  /** Renderer-safe configuration flags; never an authority boundary. */
  readonly featureFlags: FeatureFlagRegistry;
  readonly projects: ProjectRuntime;
  readonly editor: EditorDocument;
  readonly media: MediaQueue;
  readonly agents: AgentScheduler;
  /** Durable-looking automation definitions and run history. */
  readonly automation: OmniaAutomationRuntime;
  readonly events: OmniaEventLog;
};

/**
 * The composition-root schema version is intentionally kept separate from
 * the versions owned by each nested domain model.  Native persistence and
 * portable imports can therefore perform a cheap envelope migration before
 * delegating strict validation to the nested deserializers below.
 */
export const OMNIA_APP_STATE_VERSION = 1 as const;

export type OmniaAppStateMigrationResult = {
  /** The canonical, version-1 envelope. Nested payloads are still validated by deserializeOmniaAppState. */
  readonly value: Record<string, unknown>;
  readonly fromVersion: number;
  readonly toVersion: typeof OMNIA_APP_STATE_VERSION;
  readonly migrated: boolean;
  readonly appliedMigrations: readonly string[];
};

export type OmniaAppStatePatch = Partial<Omit<OmniaAppState, 'version' | 'revision' | 'updatedAt'>>;

function stamp(): string {
  return new Date().toISOString();
}

function parseStateInput(input: string | unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new Error('Invalid Omnia app state JSON.', { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Applies envelope-only migrations without relaxing nested schema validation.
 *
 * Version 0 was the short-lived renderer snapshot shape used before the
 * composition root stamped its own `version` field.  It already carried the
 * same durable-looking domains, but feature flags, automation, and the event
 * log were introduced incrementally.  Missing domains are restored to their
 * empty canonical values; no caller-owned objects are mutated.
 *
 * Future versions are rejected rather than silently downgraded.  This keeps a
 * newer desktop build from being opened by an older renderer and accidentally
 * discarding fields it does not understand.
 */
export function migrateOmniaAppState(input: string | unknown): OmniaAppStateMigrationResult {
  const value = parseStateInput(input);
  if (!isRecord(value)) throw new Error('Invalid Omnia app state.');

  const rawVersion = value.version;
  const fromVersion = rawVersion === undefined ? 0 : rawVersion;
  if (typeof fromVersion !== 'number' || !Number.isInteger(fromVersion) || fromVersion < 0) {
    throw new Error('Invalid Omnia app state version.');
  }
  if (fromVersion > OMNIA_APP_STATE_VERSION) {
    throw new Error(`Unsupported Omnia app state version: ${fromVersion}.`);
  }

  const migratedFields: string[] = [];
  const next: Record<string, unknown> = { ...value };
  if (fromVersion === 0) {
    next.version = OMNIA_APP_STATE_VERSION;
    migratedFields.push('app-state-v0-envelope');
  }

  // These surfaces were added after the first app-state envelope.  Supplying
  // the canonical empty values keeps old snapshots importable while leaving
  // malformed present-day payloads to the strict nested validators.
  if (next.featureFlags === undefined) {
    next.featureFlags = createFeatureFlagRegistry();
    migratedFields.push('feature-flags-default');
  }
  if (next.automation === undefined) {
    next.automation = createOmniaAutomationRuntime();
    migratedFields.push('automation-default');
  }
  if (fromVersion === 0 && next.events === undefined) {
    next.events = createOmniaEventLog();
    migratedFields.push('event-log-default');
  }

  return Object.freeze({
    value: next,
    fromVersion,
    toVersion: OMNIA_APP_STATE_VERSION,
    migrated: migratedFields.length > 0,
    appliedMigrations: Object.freeze(migratedFields),
  });
}

function cloneState(state: OmniaAppState): OmniaAppState {
  return {
    version: 1,
    revision: state.revision,
    updatedAt: state.updatedAt,
    chat: {
      version: 1,
      activeSessionId: state.chat.activeSessionId,
      sessions: state.chat.sessions.map((session) => ({
        ...session,
        messages: session.messages.map((message) => ({
          ...message,
          metadata: { ...message.metadata },
        })),
        metadata: { ...session.metadata },
      })),
    },
    permissions: {
      ...state.permissions,
      rules: state.permissions.rules.map((rule) => ({ ...rule })),
    },
    // Rehydrate through the strict domain parser so snapshots never retain
    // caller-owned nested manifest/settings references.
    plugins: deserializeOmniaPluginRegistry(state.plugins),
    featureFlags: {
      version: 1,
      revision: state.featureFlags.revision,
      flags: state.featureFlags.flags.map((flag) => ({
        ...flag,
        variants: flag.variants.map((variant) => ({ ...variant })),
        rules: flag.rules.map((rule) => ({
          ...rule,
          conditions: rule.conditions.map((condition) => ({
            ...condition,
            ...(Array.isArray(condition.value) ? { value: [...condition.value] } : {}),
          })),
          ...(rule.environments ? { environments: [...rule.environments] } : {}),
        })),
        prerequisites: flag.prerequisites.map((prerequisite) => ({ ...prerequisite })),
        tags: [...flag.tags],
      })),
    },
    providers: {
      ...state.providers,
      providers: state.providers.providers.map((provider) => ({
        ...provider,
        endpoint: { ...provider.endpoint },
        models: provider.models.map((model) => ({ ...model, capabilities: [...model.capabilities] })),
      })),
    },
    projects: {
      ...state.projects,
      projects: state.projects.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => ({ ...session })),
        environmentKeys: [...project.environmentKeys],
      })),
    },
    editor: {
      ...state.editor,
      blocks: state.editor.blocks.map((block) => ({
        ...block,
        ...(block.format ? { format: { ...block.format } } : {}),
      })),
      ...(state.editor.selection ? { selection: { ...state.editor.selection } } : {}),
    },
    media: {
      ...state.media,
      items: state.media.items.map((item) => ({ ...item })),
    },
    agents: {
      ...state.agents,
      jobs: state.agents.jobs.map((job) => ({
        ...job,
        dependencies: [...job.dependencies],
        capabilities: [...job.capabilities],
      })),
    },
    automation: {
      ...state.automation,
      automations: state.automation.automations.map((automation) => ({
        ...automation,
        ...(automation.schedule ? { schedule: { ...automation.schedule } } : {}),
        conditions: automation.conditions.map((condition) => ({ ...condition })),
        metadata: { ...automation.metadata },
      })),
      runs: state.automation.runs.map((run) => ({
        ...run,
        metadata: { ...run.metadata },
      })),
    },
    events: {
      ...state.events,
      events: state.events.events.map((event) => ({ ...event, payload: { ...event.payload } })),
    },
  };
}

export function createOmniaAppState(now = stamp()): OmniaAppState {
  return {
    version: OMNIA_APP_STATE_VERSION,
    revision: 1,
    updatedAt: now,
    chat: createChatStore().present,
    permissions: createPermissionPolicy(),
    providers: createProviderRegistry(),
    plugins: createOmniaPluginRegistry(),
    featureFlags: createFeatureFlagRegistry(),
    projects: createProjectRuntime(),
    editor: createEditorDocument('Untitled', now),
    media: createMediaQueue(),
    agents: createAgentScheduler(),
    automation: createOmniaAutomationRuntime(),
    events: createOmniaEventLog(),
  };
}

/** Apply one atomic state patch and bump the app revision. */
export function updateOmniaAppState(
  state: OmniaAppState,
  patch: OmniaAppStatePatch,
  updatedAt = stamp(),
): OmniaAppState {
  const current = cloneState(state);
  return {
    ...current,
    ...patch,
    version: 1,
    revision: state.revision + 1,
    updatedAt,
  };
}

export function serializeOmniaAppState(state: OmniaAppState): string {
  return JSON.stringify(cloneState(state), null, 2);
}

export function deserializeOmniaAppState(input: string | unknown): OmniaAppState {
  const migration = migrateOmniaAppState(input);
  const record = migration.value;
  if (record.version !== OMNIA_APP_STATE_VERSION || typeof record.revision !== 'number' || !Number.isInteger(record.revision) || record.revision < 1 || typeof record.updatedAt !== 'string') {
    throw new Error('Invalid Omnia app state.');
  }

  // Delegate nested validation to each sub-model's deserializer. This keeps
  // the composition root strict without duplicating every nested schema here,
  // and (importantly) ensures hydration does not retain caller-owned object
  // references from an untrusted snapshot.
  let chat: ChatStoreSnapshot;
  try {
    chat = deserializeChatStore(record.chat);
  } catch (error) {
    throw new Error('Invalid Omnia chat state.', { cause: error });
  }

  const featureFlags = record.featureFlags === undefined
    ? createFeatureFlagRegistry()
    : deserializeFeatureFlagRegistry(record.featureFlags);

  let permissions: PermissionPolicy;
  let providers: ProviderRegistry;
  let plugins: OmniaPluginRegistry;
  let projects: ProjectRuntime;
  let editor: EditorDocument;
  let media: MediaQueue;
  let agents: AgentScheduler;
  let automation: OmniaAutomationRuntime;
  let events: OmniaEventLog;
  try {
    permissions = deserializePermissionPolicy(record.permissions);
    providers = deserializeProviderRegistry(record.providers);
    // Plugin registrations were introduced after the first app-state
    // envelope. Older snapshots hydrate with an empty registry; present
    // snapshots are validated by the plugin domain parser.
    plugins = record.plugins === undefined
      ? createOmniaPluginRegistry()
      : deserializeOmniaPluginRegistry(record.plugins);
    projects = deserializeProjectRuntime(record.projects);
    editor = deserializeEditorDocument(record.editor);
    media = deserializeMediaQueue(record.media);
    agents = deserializeAgentScheduler(record.agents);
    // Older snapshots predate the automation surface. Hydrate them with an
    // empty runtime so importing existing user state remains non-breaking.
    automation = record.automation === undefined
      ? createOmniaAutomationRuntime()
      : deserializeOmniaAutomationRuntime(record.automation);
    events = deserializeOmniaEventLog(record.events);
  } catch (error) {
    throw new Error('Invalid Omnia app state payload.', { cause: error });
  }

  return {
    version: OMNIA_APP_STATE_VERSION,
    revision: record.revision,
    updatedAt: record.updatedAt,
    chat,
    permissions,
    providers,
    plugins,
    featureFlags,
    projects,
    editor,
    media,
    agents,
    automation,
    events,
  };
}
