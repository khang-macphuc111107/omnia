export type TopMode = 'chat' | 'ide' | 'browser';
export type AgentRunMode = 'chat' | 'builder' | 'solo';
export type ThemeId = 'obsidian' | 'titanium' | 'alabaster' | 'blueprint' | 'system';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type WorkbenchTab =
  | 'chat'
  | 'atelier'
  | 'omnidrive'
  | 'swarm'
  | 'observability'
  | 'knowledge'
  | 'benchmarks';

export type ObservabilitySubTab =
  | 'telemetry'
  | 'router'
  | 'network'
  | 'system'
  | 'benchmarks'
  | 'vault';

export type TelemetryWindow = '1h' | '24h' | '7d' | 'all';
export type ProvenanceState = 'LIVE' | 'CACHED' | 'UNAVAILABLE';

export interface HealthSnapshot {
  ok: boolean;
  service?: string;
  crateCount: number | null;
  rustFiles: number | null;
  workingSetBytes: number | null;
  compiler?: string;
  branch?: string;
  tokenBudget: number | null;
  activePort?: number;
  runtimeOnline?: boolean;
  uptimeSecs?: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  workspace?: string | null;
  project_name?: string | null;
  kind?: 'standalone' | 'project';
  parent_id?: string | null;
  model?: string;
  created_at?: number;
  updated_at?: number;
  turn_count?: number;
}

export interface ToolCallItem {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  arguments?: string;
  output?: string;
  durationMs?: number;
  diffPatch?: string;
  diffPath?: string;
}

export interface AttachmentItem {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  placement: 'inline' | 'tray';
  encryptedUnresolved?: boolean;
  previewUrl?: string;
  tokenEstimate?: number;
  status?: 'ready' | 'ENCRYPTED_UNRESOLVED' | 'deduplicated';
}

export interface ChatTurnMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  thinkingDurationMs?: number;
  model?: string;
  effort?: EffortLevel;
  mode?: AgentRunMode;
  timestamp: number;
  turnIdx?: number;
  toolCalls?: ToolCallItem[];
  attachments?: AttachmentItem[];
  citations?: string[];
  tokensPerSec?: number;
  costUsd?: number;
  kvCacheHitRate?: number;
  streaming?: boolean;
  error?: string;
}

export interface ModelConfigEntry {
  spec: string;
  name: string;
  provider: string;
  efforts: EffortLevel[];
  defaultEffort: EffortLevel;
  contextWindow?: number;
}

export interface DualScopeModelConfig {
  mainModel: string;
  mainEffort: EffortLevel;
  subagentModel: string;
  subagentEffort: EffortLevel;
}

export interface BtwThread {
  id: string;
  surface: 'chat' | 'notebook';
  notebook_id?: string;
  session_id?: string;
  quote: {
    text: string;
    source_label?: string;
    message_id?: string;
    start_offset?: number;
    end_offset?: number;
  };
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    model?: string;
    created_at?: number;
  }>;
  promoted?: boolean;
}

export interface SteerQueueEntry {
  id: string;
  prompt: string;
  mode: 'steer' | 'queue' | 'ADDITIVE_INTAKE';
  status: 'queued' | 'active' | 'done' | 'reconciled';
  createdAt: number;
  tokenBudget: null;
}

export interface RewindPreviewState {
  sessionId: string;
  targetTurn: number;
  totalTurns: number;
  turnsToDrop: number;
  affectedFiles: string[];
  diffPatch: string;
  summary: string;
  checkpointHash?: string;
}

export interface ComposerTemplate {
  id: string;
  title: string;
  category: 'Math' | 'Physics' | 'Chemistry';
  latex: string;
  displayMode: boolean;
  preview: string;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: 'file' | 'dir';
  bytes: number;
  depth: number;
}

export interface OpenEditorTab {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  dirty: boolean;
  diffPatch?: string;
  cursorLine?: number;
}

export interface BrowserSessionState {
  active: boolean;
  sessionId?: string;
  url: string;
  title?: string;
  screenshotBase64?: string;
  cursorX: number;
  cursorY: number;
  cursorLabel?: string;
  manualControl: boolean;
  consoleLogs: string[];
  error?: string;
}

export interface RouterCandidate {
  candidateId?: string;
  provider: string;
  model: string;
  totalScore: number;
  quotaState: 'Known' | 'Stale' | 'Unknown';
  circuitOpen: boolean;
  circuit?: string;
  p95Ms: number;
  breakdown?: Record<string, number>;
  fencedReason?: string;
}

export interface SmartAlert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  category: string;
  title: string;
  detail: string;
  targetTab?: ObservabilitySubTab;
  recordedAtMs?: number;
}

export interface SpeedtestWaveformPoint {
  tMs: number;
  phase: 'unloaded' | 'download' | 'upload' | string;
  mbps: number;
  rttMs?: number;
}

export interface TelemetryRequestRow {
  traceId: string;
  reqId: string;
  sessionId: string;
  workspace?: string;
  gitBranch?: string;
  role: string;
  providerId: string;
  modelId: string;
  wireDialect: string;
  reasoningEffort: string;
  status: string;
  ttftMs: number | null;
  tpotMs: number | null;
  durationMs: number;
  activeDecodeTps: number;
  e2eTps: number;
  stallRetries: number;
  hedgeWins: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  prefixHash?: string;
  cacheBustReason?: string;
  contextWindowFillPct?: number;
  costUsd: number;
  kvSavingsUsd: number;
  isError: boolean;
  isOutlier: boolean;
  errorNote?: string;
  recordedAtMs: number;
}

export interface CommandAction {
  id: string;
  title: string;
  group: string;
  keywords: string;
  shortcut?: string;
  run: () => void;
}
