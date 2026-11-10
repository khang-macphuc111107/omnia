import {
  Archive,
  BookmarkPlus,
  Check,
  Clipboard,
  Copy,
  Download,
  Eye,
  FileJson,
  History,
  Import,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Trash2,
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useWorkspaceStore } from "./store";
import WorkspaceExportSchedulePreview from "./workspace-export-schedule-preview";
import {
  buildWorkspaceExportProjection,
  downloadWorkspaceExport,
  parseWorkspaceExport,
  serializeWorkspaceExport,
  type WorkspaceExportFormat,
  compareWorkspaceExportRecords,
  type WorkspaceExportDiffStatus,
  type WorkspaceExportRecordDiff,
  type WorkspaceExportRecord,
  type WorkspaceExportRecordKind,
  type WorkspaceExportProjection,
  type WorkspaceExportRedaction,
  type WorkspaceExportScope,
  type WorkspaceExportSelection,
} from "./workspace-export-contract";

type WorkspaceExportDraft = {
  scope: WorkspaceExportScope;
  redaction: WorkspaceExportRedaction;
  format: WorkspaceExportFormat;
  selection: WorkspaceExportSelection;
  includeAttachmentMetadata: boolean;
};

const DEFAULT_SELECTION: WorkspaceExportSelection = {
  conversations: true,
  projects: true,
  memories: true,
  skills: true,
  providers: true,
  artifacts: true,
  attachments: true,
  runs: true,
  diagnostics: true,
  appearance: true,
};

const CATEGORY_META: Array<{
  key: keyof WorkspaceExportSelection;
  label: string;
  description: string;
  kind: WorkspaceExportRecordKind;
}> = [
  { key: "conversations", label: "Chats & drafts", description: "Titles, status, message counts, and draft metadata", kind: "conversation" },
  { key: "projects", label: "Projects", description: "Instructions, folders, and context readiness", kind: "project" },
  { key: "memories", label: "Memory candidates", description: "Scope, origin, confidence, and lifecycle state", kind: "memory" },
  { key: "skills", label: "Skills catalog", description: "Trust, scope, versions, and permission labels", kind: "skill" },
  { key: "providers", label: "Provider metadata", description: "Connection state and model catalog, never raw secrets", kind: "provider" },
  { key: "artifacts", label: "Artifacts", description: "Names, types, revisions, and project labels", kind: "artifact" },
  { key: "attachments", label: "Attachment metadata", description: "Names, MIME hints, status, and sizes only", kind: "attachment" },
  { key: "runs", label: "Run timeline", description: "Run IDs, stages, and event counts", kind: "run" },
  { key: "diagnostics", label: "Diagnostics", description: "Redacted event summaries and evidence posture", kind: "diagnostic" },
  { key: "appearance", label: "Appearance preferences", description: "Theme, density, motion, and brand preview state", kind: "appearance" },
];

const initialDraft: WorkspaceExportDraft = {
  scope: "workspace",
  redaction: "safe",
  format: "json",
  selection: DEFAULT_SELECTION,
  includeAttachmentMetadata: true,
};

export type WorkspaceExportProfile = {
  id: string;
  name: string;
  description: string;
  origin: "builtin" | "saved" | "imported";
  draft: WorkspaceExportDraft;
};

type WorkspaceExportProfileFilter = "all" | WorkspaceExportProfile["origin"];
type WorkspaceExportProfileSort = "recent" | "name" | "favorites";

export function filterWorkspaceExportProfiles(input: {
  profiles: readonly WorkspaceExportProfile[];
  query: string;
  origin: WorkspaceExportProfileFilter;
  favoritesOnly: boolean;
  favoriteIds: ReadonlySet<string>;
  sort: WorkspaceExportProfileSort;
}): WorkspaceExportProfile[] {
  const query = input.query.trim().toLocaleLowerCase();
  const filtered = input.profiles.filter((profile) => {
    if (input.origin !== "all" && profile.origin !== input.origin) return false;
    if (input.favoritesOnly && !input.favoriteIds.has(profile.id)) return false;
    if (!query) return true;
    const selectedCategories = CATEGORY_META
      .filter((category) => profile.draft.selection[category.key])
      .map((category) => category.label);
    return [
      profile.name,
      profile.description,
      profile.draft.scope,
      profile.draft.redaction,
      profile.draft.format,
      ...selectedCategories,
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });

  if (input.sort === "name") return filtered.sort((left, right) => left.name.localeCompare(right.name));
  if (input.sort === "favorites") {
    return filtered.sort((left, right) => {
      const favoriteOrder = Number(input.favoriteIds.has(right.id)) - Number(input.favoriteIds.has(left.id));
      return favoriteOrder || left.name.localeCompare(right.name);
    });
  }
  // Profile state is newest-first, so retain insertion order for recent sorting.
  return filtered;
}

type WorkspaceExportHistoryAction = "generated" | "copied" | "downloaded";

type WorkspaceExportHistoryEntry = {
  id: string;
  action: WorkspaceExportHistoryAction;
  occurredAt: string;
  generatedAt: string;
  scope: WorkspaceExportScope;
  redaction: WorkspaceExportRedaction;
  format: WorkspaceExportFormat;
  recordCount: number;
  categoryCount: number;
  bytes: number;
  draft: WorkspaceExportDraft;
};

const EXPORT_HISTORY_ACTION_LABELS: Record<WorkspaceExportHistoryAction, string> = {
  generated: "Preview generated",
  copied: "Copied to clipboard",
  downloaded: "Browser download",
};

function serializeWorkspaceExportHistory(entries: readonly WorkspaceExportHistoryEntry[]): string {
  return `${JSON.stringify({
    schema: "omnia.workspace-export-history.preview.v1",
    scope: "renderer-session",
    entries: entries.map((entry) => ({
      id: entry.id,
      action: entry.action,
      occurredAt: entry.occurredAt,
      generatedAt: entry.generatedAt,
      scope: entry.scope,
      redaction: entry.redaction,
      format: entry.format,
      recordCount: entry.recordCount,
      categoryCount: entry.categoryCount,
      bytes: entry.bytes,
      draft: entry.draft,
    })),
    boundary: {
      rendererOnly: true,
      sessionOnly: true,
      noDurableWrite: true,
      noProviderRequest: true,
      noRawPayloads: true,
    },
  }, null, 2)}\n`;
}

function downloadWorkspaceExportHistory(entries: readonly WorkspaceExportHistoryEntry[]): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([serializeWorkspaceExportHistory(entries)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "omnia-workspace-export-history-preview.json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

const WORKSPACE_EXPORT_PROFILE_SCHEMA = "omnia.workspace-export-profile.preview.v1" as const;
const WORKSPACE_EXPORT_PROFILE_MAX_BYTES = 32 * 1024;

const EXPORT_SCOPE_VALUES: WorkspaceExportScope[] = ["active-chat", "active-project", "workspace", "custom"];
const EXPORT_REDACTION_VALUES: WorkspaceExportRedaction[] = ["safe", "developer", "full-preview"];
const EXPORT_FORMAT_VALUES: WorkspaceExportFormat[] = ["json", "jsonl", "markdown"];

function serializeWorkspaceExportProfile(profile: WorkspaceExportProfile): string {
  return `${JSON.stringify({
    schema: WORKSPACE_EXPORT_PROFILE_SCHEMA,
    version: 1,
    profile: {
      name: profile.name,
      description: profile.description,
      draft: profile.draft,
    },
    boundary: {
      rendererOnly: true,
      noDurableWrite: true,
      noProviderRequest: true,
    },
  }, null, 2)}\n`;
}

function parseWorkspaceExportProfile(text: string): Omit<WorkspaceExportProfile, "id" | "origin"> {
  const source = text.replace(/^\uFEFF/, "").trim();
  if (!source) throw new Error("The export profile is empty.");
  if (new TextEncoder().encode(source).byteLength > WORKSPACE_EXPORT_PROFILE_MAX_BYTES) {
    throw new Error("The export profile exceeds the 32 KB preview limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("The export profile is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The export profile manifest is invalid.");
  const manifest = parsed as Record<string, unknown>;
  if (manifest.schema !== WORKSPACE_EXPORT_PROFILE_SCHEMA || manifest.version !== 1) {
    throw new Error("Unsupported Omnia export profile schema.");
  }
  if (!manifest.profile || typeof manifest.profile !== "object" || Array.isArray(manifest.profile)) {
    throw new Error("The export profile payload is missing.");
  }
  const profile = manifest.profile as Record<string, unknown>;
  if (typeof profile.name !== "string" || profile.name.trim().length === 0 || profile.name.length > 160) {
    throw new Error("The export profile name is invalid.");
  }
  if (typeof profile.description !== "string" || profile.description.length > 500) {
    throw new Error("The export profile description is invalid.");
  }
  if (!profile.draft || typeof profile.draft !== "object" || Array.isArray(profile.draft)) {
    throw new Error("The export profile draft is missing.");
  }
  const draft = profile.draft as Record<string, unknown>;
  if (!EXPORT_SCOPE_VALUES.includes(draft.scope as WorkspaceExportScope) ||
      !EXPORT_REDACTION_VALUES.includes(draft.redaction as WorkspaceExportRedaction) ||
      !EXPORT_FORMAT_VALUES.includes(draft.format as WorkspaceExportFormat) ||
      typeof draft.includeAttachmentMetadata !== "boolean") {
    throw new Error("The export profile draft contains an unsupported option.");
  }
  if (!draft.selection || typeof draft.selection !== "object" || Array.isArray(draft.selection)) {
    throw new Error("The export profile selection is missing.");
  }
  const selection = draft.selection as Record<string, unknown>;
  const selectionKeys = Object.keys(DEFAULT_SELECTION);
  if (Object.keys(selection).length !== selectionKeys.length ||
      selectionKeys.some((key) => typeof selection[key] !== "boolean")) {
    throw new Error("The export profile selection is invalid.");
  }
  return {
    name: profile.name.trim(),
    description: profile.description.trim() || "Imported in this renderer session; no profile file was written.",
    draft: {
      scope: draft.scope as WorkspaceExportScope,
      redaction: draft.redaction as WorkspaceExportRedaction,
      format: draft.format as WorkspaceExportFormat,
      includeAttachmentMetadata: draft.includeAttachmentMetadata,
      selection: { ...DEFAULT_SELECTION, ...(selection as unknown as WorkspaceExportSelection) },
    },
  };
}

function downloadWorkspaceExportProfile(profile: WorkspaceExportProfile): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([serializeWorkspaceExportProfile(profile)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-export-profile-${profile.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preview"}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function cloneExportDraft(value: WorkspaceExportDraft): WorkspaceExportDraft {
  return { ...value, selection: { ...value.selection } };
}

export type WorkspaceExportDraftChange = {
  key: string;
  label: string;
  previous: string;
  current: string;
};

export type WorkspaceExportProfileChange = WorkspaceExportDraftChange;

function formatWorkspaceExportDraftValue(value: string | boolean): string {
  return typeof value === "boolean" ? (value ? "Included" : "Excluded") : value;
}

/**
 * Compare a retained renderer-session history draft with the currently edited
 * export draft. This reports controls only; it never compares or restores
 * payload records and does not imply durable export provenance.
 */
export function compareWorkspaceExportDrafts(input: {
  historyDraft: WorkspaceExportDraft;
  currentDraft: WorkspaceExportDraft;
}): WorkspaceExportDraftChange[] {
  const changes: WorkspaceExportDraftChange[] = [];
  const compare = (key: string, label: string, previous: string | boolean, current: string | boolean) => {
    if (previous === current) return;
    changes.push({
      key,
      label,
      previous: formatWorkspaceExportDraftValue(previous),
      current: formatWorkspaceExportDraftValue(current),
    });
  };

  compare("scope", "Scope", input.historyDraft.scope, input.currentDraft.scope);
  compare("redaction", "Redaction", input.historyDraft.redaction, input.currentDraft.redaction);
  compare("format", "Format", input.historyDraft.format, input.currentDraft.format);
  compare(
    "includeAttachmentMetadata",
    "Attachment metadata",
    input.historyDraft.includeAttachmentMetadata,
    input.currentDraft.includeAttachmentMetadata,
  );
  for (const category of CATEGORY_META) {
    compare(
      `selection.${category.key}`,
      category.label,
      input.historyDraft.selection[category.key],
      input.currentDraft.selection[category.key],
    );
  }
  return changes;
}

/**
 * Compare two renderer-local export profiles by identity and export controls.
 * This is an inspection aid only: it never compares payload records, restores
 * workspace data, or implies that either profile is durably persisted.
 */
export function compareWorkspaceExportProfiles(input: {
  left: WorkspaceExportProfile;
  right: WorkspaceExportProfile;
}): WorkspaceExportProfileChange[] {
  const changes: WorkspaceExportProfileChange[] = [];
  const compare = (key: string, label: string, previous: string, current: string) => {
    if (previous === current) return;
    changes.push({ key, label, previous, current });
  };

  compare("name", "Profile name", input.left.name, input.right.name);
  compare("description", "Description", input.left.description, input.right.description);
  compare("origin", "Source", input.left.origin, input.right.origin);
  return [
    ...changes,
    ...compareWorkspaceExportDrafts({
      historyDraft: input.left.draft,
      currentDraft: input.right.draft,
    }),
  ];
}

const INITIAL_PROFILES: WorkspaceExportProfile[] = [
  {
    id: "safe-handoff",
    name: "Safe handoff",
    description: "Readable project and chat metadata with safe redaction.",
    origin: "builtin",
    draft: {
      scope: "workspace",
      redaction: "safe",
      format: "markdown",
      selection: {
        conversations: true,
        projects: true,
        memories: false,
        skills: true,
        providers: false,
        artifacts: true,
        attachments: false,
        runs: false,
        diagnostics: false,
        appearance: false,
      },
      includeAttachmentMetadata: false,
    },
  },
  {
    id: "debug-trace",
    name: "Developer trace",
    description: "JSONL projection for local troubleshooting and comparisons.",
    origin: "builtin",
    draft: {
      scope: "workspace",
      redaction: "developer",
      format: "jsonl",
      selection: { ...DEFAULT_SELECTION },
      includeAttachmentMetadata: true,
    },
  },
  {
    id: "active-project",
    name: "Active project",
    description: "Compact project handoff with runs and attachment metadata.",
    origin: "builtin",
    draft: {
      scope: "active-project",
      redaction: "safe",
      format: "json",
      selection: {
        conversations: true,
        projects: true,
        memories: true,
        skills: true,
        providers: false,
        artifacts: true,
        attachments: true,
        runs: true,
        diagnostics: false,
        appearance: false,
      },
      includeAttachmentMetadata: true,
    },
  },
];

const INITIAL_PROFILE_SNAPSHOTS = INITIAL_PROFILES.map((profile) => ({
  ...profile,
  draft: cloneExportDraft(profile.draft),
}));

const DIFF_STATUS_LABELS: Record<WorkspaceExportDiffStatus, string> = {
  unchanged: "Unchanged",
  changed: "Changed",
  "imported-only": "Imported only",
  "current-only": "Current only",
};

const DIFF_STATUS_DESCRIPTIONS: Record<WorkspaceExportDiffStatus, string> = {
  unchanged: "The normalized renderer metadata matches on both sides.",
  changed: "The same kind/ID exists on both sides with different metadata.",
  "imported-only": "Present in the selected file but absent from the current preview.",
  "current-only": "Present in the current preview but absent from the selected file.",
};

/**
 * A renderer-local decision for an import conflict. These decisions are a
 * merge rehearsal only: they never alter the imported projection, current
 * workspace data, files, provider state, or native settings.
 */
export type WorkspaceExportConflictDecision = "pending" | "keep-current" | "use-imported";

export const WORKSPACE_EXPORT_CONFLICT_DECISION_LABELS: Record<WorkspaceExportConflictDecision, string> = {
  pending: "Review later",
  "keep-current": "Keep current",
  "use-imported": "Use imported",
};

export function isWorkspaceExportConflict(diff: WorkspaceExportRecordDiff): boolean {
  return diff.status !== "unchanged";
}

export function getWorkspaceExportConflictDecision(
  diff: WorkspaceExportRecordDiff,
  decisions: Readonly<Record<string, WorkspaceExportConflictDecision>>,
): WorkspaceExportConflictDecision {
  return isWorkspaceExportConflict(diff) ? decisions[diff.key] ?? "pending" : "pending";
}

export function summarizeWorkspaceExportConflictDecisions(input: {
  diffs: readonly WorkspaceExportRecordDiff[];
  decisions: Readonly<Record<string, WorkspaceExportConflictDecision>>;
}): {
  total: number;
  pending: number;
  keepCurrent: number;
  useImported: number;
} {
  const conflicts = input.diffs.filter(isWorkspaceExportConflict);
  return conflicts.reduce(
    (summary, diff) => {
      const decision = getWorkspaceExportConflictDecision(diff, input.decisions);
      summary.total += 1;
      if (decision === "keep-current") summary.keepCurrent += 1;
      else if (decision === "use-imported") summary.useImported += 1;
      else summary.pending += 1;
      return summary;
    },
    { total: 0, pending: 0, keepCurrent: 0, useImported: 0 },
  );
}

/**
 * Rehearse a conservative metadata merge from normalized diff rows. Unresolved
 * conflicts default to the current side; choosing the imported side can add,
 * replace, or remove a row in this returned preview only.
 */
export function buildWorkspaceExportConflictMergePreview(input: {
  diffs: readonly WorkspaceExportRecordDiff[];
  decisions: Readonly<Record<string, WorkspaceExportConflictDecision>>;
}): WorkspaceExportRecord[] {
  return input.diffs.flatMap((diff) => {
    if (diff.status === "unchanged") return diff.current ? [diff.current] : [];
    const decision = getWorkspaceExportConflictDecision(diff, input.decisions);
    const selected = decision === "use-imported" ? diff.imported : diff.current;
    return selected ? [selected] : [];
  });
}

function safeEndpoint(endpoint: string, redaction: WorkspaceExportRedaction): string {
  if (redaction === "safe") return "redacted endpoint";
  try {
    const parsed = new URL(endpoint);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "non-url endpoint";
  }
}

function buildRecords(input: {
  conversations: ReturnType<typeof useWorkspaceStore.getState>["conversations"];
  projects: ReturnType<typeof useWorkspaceStore.getState>["projects"];
  memories: ReturnType<typeof useWorkspaceStore.getState>["memories"];
  skills: ReturnType<typeof useWorkspaceStore.getState>["skills"];
  providers: ReturnType<typeof useWorkspaceStore.getState>["providers"];
  artifacts: ReturnType<typeof useWorkspaceStore.getState>["artifacts"];
  attachments: ReturnType<typeof useWorkspaceStore.getState>["attachments"];
  runTimelineEvents: ReturnType<typeof useWorkspaceStore.getState>["runTimelineEvents"];
  redaction: WorkspaceExportRedaction;
  includeAttachmentMetadata: boolean;
}): WorkspaceExportRecord[] {
  const records: WorkspaceExportRecord[] = [];
  const messageOwners = new Map<string, { conversationId: string; projectId: string | null }>();
  const runOwners = new Map<string, { conversationId: string; projectId: string | null }>();
  for (const conversation of input.conversations) {
    const owner = { conversationId: conversation.id, projectId: conversation.projectId };
    for (const message of conversation.messages) {
      messageOwners.set(message.id, owner);
      if (message.runId) runOwners.set(message.runId, owner);
    }
  }
  for (const conversation of input.conversations) {
    records.push({
      kind: "conversation",
      id: conversation.id,
      label: conversation.title,
      summary: conversation.excerpt || "No excerpt in preview",
      metadata: {
        conversationId: conversation.id,
        projectId: conversation.projectId,
        project: conversation.projectName,
        messageCount: conversation.messages.length,
        archived: conversation.archived,
        unread: conversation.unread,
        hasDraft: conversation.hasDraft,
        updatedAt: conversation.updatedAt,
      },
    });
  }
  for (const project of input.projects) {
    records.push({
      kind: "project",
      id: project.id,
      label: project.name,
      summary: project.description || "No description in preview",
      metadata: {
        projectId: project.id,
        contextHealth: project.contextHealth,
        folderCount: project.folders.length,
        modelProfileId: project.modelProfileId,
        pinned: project.pinned,
        archived: project.archived ?? false,
      },
    });
  }
  for (const memory of input.memories) {
    records.push({
      kind: "memory",
      id: memory.id,
      label: memory.title || memory.kind,
      summary: memory.content.slice(0, 160),
      metadata: {
        scope: memory.scopeLabel,
        status: memory.status,
        origin: memory.origin,
        confidence: memory.confidence,
        source: memory.sourceLabel,
      },
    });
  }
  for (const skill of input.skills) {
    records.push({
      kind: "skill",
      id: skill.id,
      label: skill.name,
      summary: skill.description,
      metadata: {
        version: skill.version,
        source: skill.source,
        trust: skill.trust,
        enabled: skill.enabled,
        scope: skill.scope,
        tokenFootprint: skill.tokenFootprint,
      },
    });
  }
  for (const provider of input.providers) {
    records.push({
      kind: "provider",
      id: provider.id,
      label: provider.name,
      summary: `${provider.kind} · ${provider.modelCount} models · ${provider.state}`,
      metadata: {
        kind: provider.kind,
        state: provider.state,
        source: provider.source,
        endpoint: safeEndpoint(provider.endpoint, input.redaction),
        modelCount: provider.modelCount,
        credentialState: input.redaction === "safe" ? "opaque reference only" : provider.credentialState,
      },
    });
  }
  for (const artifact of input.artifacts) {
    records.push({
      kind: "artifact",
      id: artifact.id,
      label: artifact.name,
      summary: `${artifact.type} · ${artifact.sizeLabel}`,
      metadata: {
        project: artifact.projectName,
        versionCount: artifact.versionCount,
        updated: artifact.updatedLabel,
      },
    });
  }
  if (input.includeAttachmentMetadata) {
    for (const attachment of input.attachments) {
      records.push({
        kind: "attachment",
        id: attachment.id,
        label: attachment.name,
        summary: `${attachment.kind} · ${attachment.state}`,
        metadata: {
          conversationId: attachment.messageId ? messageOwners.get(attachment.messageId)?.conversationId ?? null : null,
          projectId: attachment.projectId ?? (attachment.messageId ? messageOwners.get(attachment.messageId)?.projectId ?? null : null),
          mediaType: attachment.mediaType ?? null,
          size: attachment.size,
          state: attachment.state,
          extractionStatus: attachment.extractionStatus ?? null,
          origin: attachment.origin ?? null,
        },
      });
    }
  }
  const runs = new Map<string, number>();
  for (const event of input.runTimelineEvents) {
    if (event.runId) runs.set(event.runId, (runs.get(event.runId) ?? 0) + 1);
  }
  for (const [runId, eventCount] of runs) {
    records.push({
      kind: "run",
      id: runId,
      label: `Run ${runId.slice(0, 12)}`,
      summary: `${eventCount} timeline events in renderer projection`,
      metadata: {
        eventCount,
        source: "renderer timeline projection",
        conversationId: runOwners.get(runId)?.conversationId ?? null,
        projectId: runOwners.get(runId)?.projectId ?? null,
      },
    });
  }
  const diagnosticEvents = input.runTimelineEvents.slice(0, 24);
  diagnosticEvents.forEach((event, index) => {
    records.push({
      kind: "diagnostic",
      id: `diagnostic-${event.id ?? index}`,
      label: event.type || "Timeline event",
      summary: "Redacted diagnostic event summary",
      metadata: {
        runId: event.runId,
        conversationId: runOwners.get(event.runId)?.conversationId ?? null,
        projectId: runOwners.get(event.runId)?.projectId ?? null,
        sequence: event.sequence ?? index,
        stage: event.stage ?? null,
        status: event.status ?? null,
        source: "renderer preview",
      },
    });
  });
  records.push({
    kind: "appearance",
    id: "appearance-session",
    label: "Appearance session",
    summary: "Theme and accessibility preferences used by this preview",
    metadata: { theme: "session preview", density: "session preview", motion: "session preview" },
  });
  return records;
}

export function filterWorkspaceExportRecords(input: {
  records: readonly WorkspaceExportRecord[];
  scope: WorkspaceExportScope;
  activeConversationId: string;
  activeProjectId: string;
  activeProjectName: string | null;
}): WorkspaceExportRecord[] {
  if (input.scope === "workspace" || input.scope === "custom") return [...input.records];

  return input.records.filter((record) => {
    if (input.scope === "active-chat") {
      if (record.kind === "conversation") return record.id === input.activeConversationId;
      if (record.kind === "attachment" || record.kind === "run" || record.kind === "diagnostic") {
        return record.metadata.conversationId === input.activeConversationId;
      }
      return true;
    }
    if (record.kind === "project") return record.id === input.activeProjectId;
    if (record.kind === "conversation" || record.kind === "attachment" || record.kind === "run" || record.kind === "diagnostic") {
      return record.metadata.projectId === input.activeProjectId;
    }
    if (record.kind === "artifact") return record.metadata.project === input.activeProjectName;
    return true;
  });
}

export function WorkspaceExportCenter() {
  const conversations = useWorkspaceStore((state) => state.conversations);
  const projects = useWorkspaceStore((state) => state.projects);
  const memories = useWorkspaceStore((state) => state.memories);
  const skills = useWorkspaceStore((state) => state.skills);
  const providers = useWorkspaceStore((state) => state.providers);
  const artifacts = useWorkspaceStore((state) => state.artifacts);
  const attachments = useWorkspaceStore((state) => state.attachments);
  const runTimelineEvents = useWorkspaceStore((state) => state.runTimelineEvents);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const [draft, setDraft] = useState<WorkspaceExportDraft>(initialDraft);
  const [generatedAt, setGeneratedAt] = useState(() => new Date().toISOString());
  const [undoStack, setUndoStack] = useState<WorkspaceExportDraft[]>([]);
  const [redoStack, setRedoStack] = useState<WorkspaceExportDraft[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<WorkspaceExportProfile[]>(() =>
    INITIAL_PROFILE_SNAPSHOTS.map((profile) => ({ ...profile, draft: cloneExportDraft(profile.draft) })),
  );
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileSearch, setProfileSearch] = useState("");
  const [profileOrigin, setProfileOrigin] = useState<WorkspaceExportProfileFilter>("all");
  const [profileSort, setProfileSort] = useState<WorkspaceExportProfileSort>("recent");
  const [profileFavoritesOnly, setProfileFavoritesOnly] = useState(false);
  const [favoriteProfileIds, setFavoriteProfileIds] = useState<Set<string>>(() => new Set());
  const [profileCompareLeftId, setProfileCompareLeftId] = useState<string>("safe-handoff");
  const [profileCompareRightId, setProfileCompareRightId] = useState<string>("debug-trace");
  const [importedReview, setImportedReview] = useState<WorkspaceExportProjection | null>(null);
  const [importSearch, setImportSearch] = useState("");
  const [importKind, setImportKind] = useState<WorkspaceExportRecordKind | "all">("all");
  const [importDiffStatus, setImportDiffStatus] = useState<WorkspaceExportDiffStatus | "all">("all");
  const [importConflictDecisions, setImportConflictDecisions] = useState<Record<string, WorkspaceExportConflictDecision>>({});
  const [exportHistory, setExportHistory] = useState<WorkspaceExportHistoryEntry[]>([]);
  const [exportHistorySearch, setExportHistorySearch] = useState("");
  const [exportHistoryAction, setExportHistoryAction] = useState<WorkspaceExportHistoryAction | "all">("all");
  const [selectedExportHistoryId, setSelectedExportHistoryId] = useState<string | null>(null);
  const [compareExportHistoryId, setCompareExportHistoryId] = useState<string>("");
  const exportHistoryCounterRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);
  const profileInputRef = useRef<HTMLInputElement>(null);

  const importedMatches = useMemo(() => {
    if (!importedReview) return [];
    const query = importSearch.trim().toLocaleLowerCase();
    return importedReview.records.filter((record) =>
      (importKind === "all" || record.kind === importKind) &&
      (!query || [record.id, record.label, record.summary, record.kind].some((value) => value.toLocaleLowerCase().includes(query))),
    );
  }, [importedReview, importKind, importSearch]);

  const allRecords = useMemo(
    () =>
      buildRecords({
        conversations,
        projects,
        memories,
        skills,
        providers,
        artifacts,
        attachments,
        runTimelineEvents,
        redaction: draft.redaction,
        includeAttachmentMetadata: draft.includeAttachmentMetadata,
      }),
    [
      attachments,
      artifacts,
      conversations,
      draft.includeAttachmentMetadata,
      draft.redaction,
      memories,
      projects,
      providers,
      runTimelineEvents,
      skills,
    ],
  );

  const scopedRecords = useMemo(() => {
    const selectedKinds = new Set<WorkspaceExportRecordKind>(
      CATEGORY_META.filter((category) => draft.selection[category.key]).map((category) => category.kind),
    );
    const selectedRecords = allRecords.filter((record) => selectedKinds.has(record.kind));
    return filterWorkspaceExportRecords({
      records: selectedRecords,
      scope: draft.scope,
      activeConversationId,
      activeProjectId,
      activeProjectName: projects.find((project) => project.id === activeProjectId)?.name ?? null,
    });
  }, [activeConversationId, activeProjectId, allRecords, draft.scope, draft.selection, projects]);

  const projection = useMemo(
    () =>
      buildWorkspaceExportProjection({
        scope: draft.scope,
        redaction: draft.redaction,
        generatedAt,
        selection: draft.selection,
        records: scopedRecords,
      }),
    [draft.redaction, draft.scope, draft.selection, generatedAt, scopedRecords],
  );

  const importedDiffs = useMemo<WorkspaceExportRecordDiff[]>(
    () => importedReview
      ? compareWorkspaceExportRecords({
        importedRecords: importedReview.records,
        currentRecords: projection.records,
      })
      : [],
    [importedReview, projection.records],
  );

  const filteredDiffs = useMemo(() => {
    const query = importSearch.trim().toLocaleLowerCase();
    return importedDiffs.filter((diff) => {
      if (importDiffStatus !== "all" && diff.status !== importDiffStatus) return false;
      if (importKind !== "all" && diff.kind !== importKind) return false;
      if (!query) return true;
      return [
        diff.id,
        diff.kind,
        diff.imported?.label ?? "",
        diff.imported?.summary ?? "",
        diff.current?.label ?? "",
        diff.current?.summary ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [importDiffStatus, importKind, importSearch, importedDiffs]);

  const diffCounts = useMemo(() => ({
    unchanged: importedDiffs.filter((diff) => diff.status === "unchanged").length,
    changed: importedDiffs.filter((diff) => diff.status === "changed").length,
    importedOnly: importedDiffs.filter((diff) => diff.status === "imported-only").length,
    currentOnly: importedDiffs.filter((diff) => diff.status === "current-only").length,
  }), [importedDiffs]);

  const conflictSummary = useMemo(
    () => summarizeWorkspaceExportConflictDecisions({ diffs: importedDiffs, decisions: importConflictDecisions }),
    [importConflictDecisions, importedDiffs],
  );

  const conflictMergePreview = useMemo(
    () => buildWorkspaceExportConflictMergePreview({ diffs: importedDiffs, decisions: importConflictDecisions }),
    [importConflictDecisions, importedDiffs],
  );

  const decideVisibleImportConflicts = (decision: WorkspaceExportConflictDecision) => {
    const visibleConflictKeys = filteredDiffs.filter(isWorkspaceExportConflict).map((diff) => diff.key);
    if (!visibleConflictKeys.length) return;
    setImportConflictDecisions((current) => {
      const next = { ...current };
      for (const key of visibleConflictKeys) next[key] = decision;
      return next;
    });
    setStatus(`${WORKSPACE_EXPORT_CONFLICT_DECISION_LABELS[decision]} marked for ${visibleConflictKeys.length} visible import conflict${visibleConflictKeys.length === 1 ? "" : "s"}; this did not merge or change workspace data.`);
  };

  const clearImportConflictDecisions = () => {
    if (!Object.keys(importConflictDecisions).length) return;
    setImportConflictDecisions({});
    setStatus("Cleared renderer-session import conflict decisions. Imported and current data remain unchanged.");
  };

  const selectedCategoryCount = useMemo(
    () => CATEGORY_META.filter((category) => draft.selection[category.key]).length,
    [draft.selection],
  );

  const visibleProfiles = useMemo(
    () => filterWorkspaceExportProfiles({
      profiles,
      query: profileSearch,
      origin: profileOrigin,
      favoritesOnly: profileFavoritesOnly,
      favoriteIds: favoriteProfileIds,
      sort: profileSort,
    }),
    [favoriteProfileIds, profileFavoritesOnly, profileOrigin, profileSearch, profileSort, profiles],
  );

  const profileCompareLeft = useMemo(
    () => profiles.find((profile) => profile.id === profileCompareLeftId) ?? null,
    [profileCompareLeftId, profiles],
  );

  const profileCompareRight = useMemo(
    () => profiles.find((profile) => profile.id === profileCompareRightId) ?? null,
    [profileCompareRightId, profiles],
  );

  const profileCompareChanges = useMemo(
    () => profileCompareLeft && profileCompareRight
      ? compareWorkspaceExportProfiles({ left: profileCompareLeft, right: profileCompareRight })
      : [],
    [profileCompareLeft, profileCompareRight],
  );

  const visibleExportHistory = useMemo(() => {
    const query = exportHistorySearch.trim().toLocaleLowerCase();
    return exportHistory.filter((entry) => {
      if (exportHistoryAction !== "all" && entry.action !== exportHistoryAction) return false;
      if (!query) return true;
      return [
        entry.id,
        entry.action,
        entry.scope,
        entry.redaction,
        entry.format,
        EXPORT_HISTORY_ACTION_LABELS[entry.action],
      ].some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [exportHistory, exportHistoryAction, exportHistorySearch]);

  const selectedExportHistoryEntry = useMemo(
    () => visibleExportHistory.find((entry) => entry.id === selectedExportHistoryId) ?? null,
    [selectedExportHistoryId, visibleExportHistory],
  );

  const selectedExportHistoryChanges = useMemo(
    () => selectedExportHistoryEntry
      ? compareWorkspaceExportDrafts({ historyDraft: selectedExportHistoryEntry.draft, currentDraft: draft })
      : [],
    [draft, selectedExportHistoryEntry],
  );

  const comparisonExportHistoryEntry = useMemo(
    () => exportHistory.find((entry) => entry.id === compareExportHistoryId && entry.id !== selectedExportHistoryEntry?.id) ?? null,
    [compareExportHistoryId, exportHistory, selectedExportHistoryEntry],
  );

  const historyEntryChanges = useMemo(
    () => selectedExportHistoryEntry && comparisonExportHistoryEntry
      ? compareWorkspaceExportDrafts({
        historyDraft: selectedExportHistoryEntry.draft,
        currentDraft: comparisonExportHistoryEntry.draft,
      })
      : [],
    [comparisonExportHistoryEntry, selectedExportHistoryEntry],
  );

  const updateDraft = (patch: Partial<WorkspaceExportDraft>) => {
    setDraft((current) => {
      const next = { ...current, ...patch, selection: patch.selection ? { ...patch.selection } : current.selection };
      setUndoStack((history) => [...history, current].slice(-20));
      setRedoStack([]);
      return next;
    });
    setStatus(null);
  };

  const undo = () => {
    setUndoStack((history) => {
      const previous = history.at(-1);
      if (!previous) return history;
      setRedoStack((redoHistory) => [draft, ...redoHistory].slice(0, 20));
      setDraft(previous);
      return history.slice(0, -1);
    });
    setStatus("Undid the last export setting change in this preview.");
  };

  const redo = () => {
    setRedoStack((history) => {
      const next = history[0];
      if (!next) return history;
      setUndoStack((undoHistory) => [...undoHistory, draft].slice(-20));
      setDraft(next);
      return history.slice(1);
    });
    setStatus("Redid the export setting change in this preview.");
  };

  const reset = () => {
    updateDraft(initialDraft);
    setActiveProfileId(null);
    setGeneratedAt(new Date().toISOString());
    setStatus("Reset export scope, categories, and redaction to defaults.");
  };

  const recordExportHistory = (action: WorkspaceExportHistoryAction, exportProjection: WorkspaceExportProjection) => {
    const payload = serializeWorkspaceExport(exportProjection, draft.format);
    const entry: WorkspaceExportHistoryEntry = {
      id: `export-${Date.now()}-${exportHistoryCounterRef.current++}`,
      action,
      occurredAt: new Date().toISOString(),
      generatedAt: exportProjection.generatedAt,
      scope: exportProjection.scope,
      redaction: exportProjection.redaction,
      format: draft.format,
      recordCount: exportProjection.records.length,
      categoryCount: Object.values(exportProjection.counts).filter((count) => count > 0).length,
      bytes: new TextEncoder().encode(payload).byteLength,
      draft: cloneExportDraft(draft),
    };
    setExportHistory((current) => [entry, ...current].slice(0, 30));
    setSelectedExportHistoryId(entry.id);
    setCompareExportHistoryId("");
  };

  const restoreExportHistoryEntry = (entry: WorkspaceExportHistoryEntry) => {
    updateDraft(cloneExportDraft(entry.draft));
    setGeneratedAt(entry.generatedAt);
    setActiveProfileId(null);
    setStatus(`Restored “${EXPORT_HISTORY_ACTION_LABELS[entry.action]}” settings into the current preview draft. No app data was restored.`);
  };

  const removeExportHistoryEntry = (entry: WorkspaceExportHistoryEntry) => {
    setExportHistory((current) => current.filter((candidate) => candidate.id !== entry.id));
    setSelectedExportHistoryId((current) => current === entry.id ? null : current);
    setCompareExportHistoryId((current) => current === entry.id ? "" : current);
    setStatus(`Removed “${EXPORT_HISTORY_ACTION_LABELS[entry.action]}” from this renderer-session log. No durable history was changed.`);
  };

  const generatePreview = () => {
    const nextGeneratedAt = new Date().toISOString();
    const nextProjection = buildWorkspaceExportProjection({
      scope: draft.scope,
      redaction: draft.redaction,
      generatedAt: nextGeneratedAt,
      selection: draft.selection,
      records: scopedRecords,
    });
    setGeneratedAt(nextGeneratedAt);
    recordExportHistory("generated", nextProjection);
    setStatus("Generated a fresh export preview from current renderer-visible metadata.");
  };

  const downloadPreview = () => {
    downloadWorkspaceExport(projection, draft.format);
    recordExportHistory("downloaded", projection);
    setStatus("Browser download started; no workspace path was written.");
  };

  const copyExportHistory = async () => {
    const payload = serializeWorkspaceExportHistory(exportHistory);
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; export history was not copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus("Copied renderer-local export history; no durable log was written.");
    } catch {
      setStatus("Clipboard write failed; export history was not copied.");
    }
  };

  const applyProfile = (profile: WorkspaceExportProfile) => {
    updateDraft(cloneExportDraft(profile.draft));
    setActiveProfileId(profile.id);
    setStatus(`Applied the “${profile.name}” export profile in this preview.`);
  };

  const saveProfile = () => {
    const requestedName = profileName.trim();
    if (!requestedName) {
      setStatus("Enter a profile name before saving this export preset.");
      return;
    }
    const id = `custom-${Date.now()}`;
    const profile: WorkspaceExportProfile = {
      id,
      name: requestedName,
      description: "Saved in this renderer session; no profile file was written.",
      origin: "saved",
      draft: cloneExportDraft(draft),
    };
    setProfiles((current) => [...current, profile]);
    setActiveProfileId(id);
    setProfileName("");
    setStatus(`Saved “${requestedName}” as a renderer-local export profile.`);
  };

  const duplicateProfile = (profile: WorkspaceExportProfile) => {
    const id = `custom-${Date.now()}`;
    const copyProfile: WorkspaceExportProfile = {
      id,
      name: `${profile.name} copy`,
      description: "Duplicated in this renderer session; no profile file was written.",
      origin: "saved",
      draft: cloneExportDraft(profile.draft),
    };
    setProfiles((current) => [...current, copyProfile]);
    setActiveProfileId(id);
    setStatus(`Duplicated “${profile.name}” as a renderer-local profile.`);
  };

  const exportProfile = (profile: WorkspaceExportProfile) => {
    setStatus(
      downloadWorkspaceExportProfile(profile)
        ? `Browser download started for “${profile.name}”; no profile file was written to the workspace.`
        : "Browser download is unavailable; no profile file was written.",
    );
  };

  const importProfile = async (file: File) => {
    try {
      const imported = parseWorkspaceExportProfile(await file.text());
      const id = `imported-${Date.now()}`;
      const profile: WorkspaceExportProfile = { id, ...imported, origin: "imported" };
      setProfiles((current) => [...current, profile]);
      setActiveProfileId(id);
      setStatus(`Imported “${profile.name}” into this renderer session. Choose Apply to use it; no settings were persisted.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Profile import failed closed.");
    }
  };

  const deleteProfile = (profile: WorkspaceExportProfile) => {
    setProfiles((current) => current.filter((candidate) => candidate.id !== profile.id));
    setFavoriteProfileIds((current) => {
      const next = new Set(current);
      next.delete(profile.id);
      return next;
    });
    if (activeProfileId === profile.id) setActiveProfileId(null);
    setStatus(`Removed “${profile.name}” from this preview session.`);
  };

  const copyPreview = async () => {
    const payload = serializeWorkspaceExport(projection, draft.format);
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; no export was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      recordExportHistory("copied", projection);
      setStatus(`Copied ${draft.format.toUpperCase()} export preview; no durable file was written.`);
    } catch {
      setStatus("Clipboard write failed; no export was copied.");
    }
  };

  const importBundle = async (file: File) => {
    try {
      const imported = parseWorkspaceExport(await file.text());
      setImportedReview(imported);
      setImportSearch("");
      setImportKind("all");
      setImportDiffStatus("all");
      setImportConflictDecisions({});
      setUndoStack((history) => [...history, draft].slice(-20));
      setRedoStack([]);
      setDraft((current) => ({
        ...current,
        scope: imported.scope,
        redaction: imported.redaction,
        selection: imported.selection,
      }));
      setGeneratedAt(imported.generatedAt);
      setStatus(`Opened ${imported.records.length} records for renderer-local review and copied bundle options into the export draft. No app data was restored.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed closed.");
    }
  };

  return (
    <section className="workspace-export-center settings-section" aria-labelledby="workspace-export-title">
      <header className="workspace-export-center__header">
        <div>
          <span className="eyebrow">Portable workspace bundle</span>
          <h2 id="workspace-export-title">Export Center</h2>
          <p>Choose exactly which renderer-visible metadata to carry, inspect the payload, and review an imported bundle without restoring app data.</p>
        </div>
        <span className="workspace-export-center__badge"><Archive size={14} /> Preview only</span>
      </header>

      <div className="workspace-export-center__boundary" role="note">
        <ShieldCheck size={16} /> <span>Renderer-local · metadata-only · no durable write · no provider request · native backup/restore remains Planned.</span>
      </div>

      <div className="workspace-export-center__toolbar">
        <label><span>Scope</span><select value={draft.scope} onChange={(event) => updateDraft({ scope: event.target.value as WorkspaceExportScope })}>
          <option value="active-chat">Active chat</option>
          <option value="active-project">Active project</option>
          <option value="workspace">Entire workspace</option>
          <option value="custom">Custom selection</option>
        </select></label>
        <label><span>Redaction</span><select value={draft.redaction} onChange={(event) => updateDraft({ redaction: event.target.value as WorkspaceExportRedaction })}>
          <option value="safe">Safe preview</option>
          <option value="developer">Developer trace</option>
          <option value="full-preview">Full metadata preview</option>
        </select></label>
        <label><span>Format</span><select value={draft.format} onChange={(event) => updateDraft({ format: event.target.value as WorkspaceExportFormat })}>
          <option value="json">JSON bundle</option>
          <option value="jsonl">JSONL stream</option>
          <option value="markdown">Markdown brief</option>
        </select></label>
        <label className="workspace-export-center__check"><input type="checkbox" checked={draft.includeAttachmentMetadata} onChange={(event) => updateDraft({ includeAttachmentMetadata: event.target.checked })} /><span>Include attachment metadata</span></label>
      </div>

      <div className="workspace-export-center__history">
        <button type="button" className="button button--ghost" disabled={!undoStack.length} onClick={undo}><Undo2 size={14} /> Undo</button>
        <button type="button" className="button button--ghost" disabled={!redoStack.length} onClick={redo}><Redo2 size={14} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset}><RefreshCw size={14} /> Reset</button>
        <button type="button" className="button button--secondary" onClick={() => importInputRef.current?.click()}><Import size={14} /> Import bundle</button>
        <input ref={importInputRef} type="file" accept=".json,.jsonl,.txt" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBundle(file); event.currentTarget.value = ""; }} />
      </div>

      <section className="workspace-export-center__profiles" aria-label="Export profiles">
        <header>
          <div>
            <span className="eyebrow">Reusable renderer presets</span>
            <h3>Export profiles</h3>
            <p>Apply a known-safe shape or save the current draft for this preview session. Profiles never write a file.</p>
          </div>
          <div className="workspace-export-center__profile-header-actions">
            <span className="workspace-export-center__profile-boundary">Session-only</span>
            <button type="button" className="button button--ghost" onClick={() => profileInputRef.current?.click()}><Import size={14} /> Import profile</button>
            <input ref={profileInputRef} type="file" accept=".json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProfile(file); event.currentTarget.value = ""; }} />
          </div>
        </header>
        <div className="workspace-export-center__profile-create">
          <label>
            <span>Save current draft as</span>
            <input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="e.g. Handoff with diagnostics" />
          </label>
          <button type="button" className="button button--secondary" onClick={saveProfile}><BookmarkPlus size={14} /> Save profile</button>
        </div>
        <div className="workspace-export-center__profile-tools" aria-label="Export profile filters">
          <label><span>Find a profile</span><span className="workspace-export-center__profile-search"><Search size={14} /><input type="search" aria-label="Search export profiles" value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} placeholder="Name, scope, format, category…" /></span></label>
          <label><span>Profile source</span><select aria-label="Export profile source" value={profileOrigin} onChange={(event) => setProfileOrigin(event.target.value as WorkspaceExportProfileFilter)}>
            <option value="all">All sources</option>
            <option value="builtin">Built-in</option>
            <option value="saved">Saved this session</option>
            <option value="imported">Imported this session</option>
          </select></label>
          <label><span>Sort profiles</span><select aria-label="Sort export profiles" value={profileSort} onChange={(event) => setProfileSort(event.target.value as WorkspaceExportProfileSort)}>
            <option value="recent">Recent first</option>
            <option value="name">Name</option>
            <option value="favorites">Favorites first</option>
          </select></label>
          <button type="button" className={`button ${profileFavoritesOnly ? "button--secondary" : "button--ghost"}`} aria-pressed={profileFavoritesOnly} onClick={() => setProfileFavoritesOnly((current) => !current)}><Star size={13} fill={profileFavoritesOnly ? "currentColor" : "none"} /> Favorites only</button>
          <span role="status">Showing {visibleProfiles.length} of {profiles.length} profiles · {favoriteProfileIds.size} starred</span>
        </div>
        <div className="workspace-export-center__profile-compare-tools" aria-label="Export profile comparison controls">
          <label><span>Compare profile A</span><select aria-label="Compare export profile A" value={profileCompareLeftId} onChange={(event) => setProfileCompareLeftId(event.target.value)}>
            <option value="">Choose profile A…</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select></label>
          <button type="button" className="button button--ghost" aria-label="Swap compared export profiles" onClick={() => { setProfileCompareLeftId(profileCompareRightId); setProfileCompareRightId(profileCompareLeftId); }} disabled={!profileCompareLeft || !profileCompareRight}><RefreshCw size={13} /> Swap</button>
          <label><span>Compare profile B</span><select aria-label="Compare export profile B" value={profileCompareRightId} onChange={(event) => setProfileCompareRightId(event.target.value)}>
            <option value="">Choose profile B…</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select></label>
          <span role="status">{profileCompareLeft && profileCompareRight ? `${profileCompareChanges.length} control${profileCompareChanges.length === 1 ? "" : "s"} differ` : "Choose two profiles to compare"}</span>
        </div>
        <div className="workspace-export-center__profile-list">
          {visibleProfiles.map((profile) => (
            <article key={profile.id} className={activeProfileId === profile.id ? "workspace-export-profile workspace-export-profile--active" : "workspace-export-profile"}>
              <div className="workspace-export-profile__copy">
                <div className="workspace-export-profile__title"><strong>{profile.name}</strong><span>{profile.origin === "builtin" ? "Built-in" : profile.origin === "imported" ? "Imported · session" : "Saved · session"}</span></div>
                <small>{profile.description}</small>
                <small>{profile.draft.scope} · {profile.draft.redaction} · {profile.draft.format.toUpperCase()} · {CATEGORY_META.filter((category) => profile.draft.selection[category.key]).length} categories</small>
              </div>
              <div className="workspace-export-profile__actions">
                <button type="button" className={`button button--ghost workspace-export-profile__favorite${favoriteProfileIds.has(profile.id) ? " is-active" : ""}`} onClick={() => setFavoriteProfileIds((current) => {
                  const next = new Set(current);
                  if (next.has(profile.id)) next.delete(profile.id);
                  else next.add(profile.id);
                  return next;
                })} aria-label={`${favoriteProfileIds.has(profile.id) ? "Unfavorite" : "Favorite"} ${profile.name}`} aria-pressed={favoriteProfileIds.has(profile.id)}><Star size={13} fill={favoriteProfileIds.has(profile.id) ? "currentColor" : "none"} /></button>
                <button type="button" className="button button--ghost" onClick={() => applyProfile(profile)} aria-label={`Apply ${profile.name}`}><Check size={13} /> Apply</button>
                <button type="button" className="button button--ghost" onClick={() => duplicateProfile(profile)} aria-label={`Duplicate ${profile.name}`}><Copy size={13} /> Duplicate</button>
                <button type="button" className="button button--ghost" onClick={() => exportProfile(profile)} aria-label={`Export ${profile.name}`}><Download size={13} /> Export</button>
                <button type="button" className="button button--ghost" onClick={() => deleteProfile(profile)} aria-label={`Delete ${profile.name}`}><Trash2 size={13} /> Delete</button>
              </div>
            </article>
          ))}
          {!visibleProfiles.length ? <div className="workspace-export-center__profile-empty"><strong>No export profiles match.</strong><span>Adjust the search or filters. Favorites and saved profiles remain session-only.</span><button type="button" className="button button--ghost" onClick={() => { setProfileSearch(""); setProfileOrigin("all"); setProfileFavoritesOnly(false); setProfileSort("recent"); }}>Clear profile filters</button></div> : null}
        </div>
        {profileCompareLeft && profileCompareRight ? <section className="workspace-export-center__profile-comparison" aria-label="Export profile comparison">
          <header>
            <div>
              <span className="eyebrow"><SlidersHorizontal size={13} /> Profile comparison · renderer session</span>
              <h3>{profileCompareChanges.length ? `${profileCompareChanges.length} control${profileCompareChanges.length === 1 ? "" : "s"} differ` : "Profiles match"}</h3>
              <p>Compare names, source labels, scope, redaction, format, attachment metadata, and category selections. Payload records and workspace data are never compared.</p>
            </div>
            <span className="workspace-export-center__profile-boundary">No apply on compare</span>
          </header>
          <div className="workspace-export-center__profile-comparison-summary" aria-label="Compared export profiles">
            <div><span>Profile A</span><strong>{profileCompareLeft.name}</strong><small>{profileCompareLeft.origin} · {profileCompareLeft.draft.scope} · {profileCompareLeft.draft.format.toUpperCase()}</small><button type="button" className="button button--ghost" onClick={() => applyProfile(profileCompareLeft)} aria-label={`Apply compared profile ${profileCompareLeft.name}`}>Apply A</button></div>
            <div><span>Profile B</span><strong>{profileCompareRight.name}</strong><small>{profileCompareRight.origin} · {profileCompareRight.draft.scope} · {profileCompareRight.draft.format.toUpperCase()}</small><button type="button" className="button button--ghost" onClick={() => applyProfile(profileCompareRight)} aria-label={`Apply compared profile ${profileCompareRight.name}`}>Apply B</button></div>
          </div>
          {profileCompareChanges.length ? <ul className="workspace-export-center__profile-comparison-list">
            {profileCompareChanges.map((change) => <li key={change.key}><strong>{change.label}</strong><span>{change.previous} → {change.current}</span></li>)}
          </ul> : <p className="workspace-export-center__profile-comparison-empty">The selected profiles have identical renderer controls.</p>}
          <p className="workspace-export-center__profile-comparison-boundary"><ShieldCheck size={13} /> Preview only · comparison is session-local. Applying a profile changes only the current renderer draft; no native settings, files, provider calls, or durable profile records are changed.</p>
        </section> : <p className="workspace-export-center__profile-comparison-empty">Choose two export profiles above to compare their renderer controls.</p>}
      </section>

      <WorkspaceExportSchedulePreview profiles={profiles.map(({ id, name }) => ({ id, name }))} />

      <section className="workspace-export-center__history-panel" aria-label="Export history">
        <header className="workspace-export-center__history-panel-header">
          <div>
            <span className="eyebrow"><History size={13} /> Renderer session log</span>
            <h3>Export history</h3>
            <p>Review recent generated, copied, and downloaded previews. This is a bounded session log, not a durable audit journal.</p>
          </div>
          <span className="workspace-export-center__profile-boundary">{exportHistory.length} / 30 retained</span>
        </header>
        <div className="workspace-export-center__history-panel-tools">
          <label><span>Find history</span><input type="search" aria-label="Find export history" value={exportHistorySearch} onChange={(event) => setExportHistorySearch(event.target.value)} placeholder="Scope, format, action…" /></label>
          <label><span>Action</span><select aria-label="Export history action" value={exportHistoryAction} onChange={(event) => setExportHistoryAction(event.target.value as WorkspaceExportHistoryAction | "all")}>
            <option value="all">All actions</option>
            <option value="generated">Generated</option>
            <option value="copied">Copied</option>
            <option value="downloaded">Downloaded</option>
          </select></label>
          <span role="status">{visibleExportHistory.length} visible</span>
          <button type="button" className="button button--ghost" onClick={() => void copyExportHistory()} disabled={!exportHistory.length}><Clipboard size={13} /> Copy log</button>
          <button type="button" className="button button--ghost" onClick={() => setStatus(downloadWorkspaceExportHistory(exportHistory) ? "Browser download started for renderer-local export history; no durable log was written." : "Browser download is unavailable; no history file was written.")} disabled={!exportHistory.length}><Download size={13} /> Download log</button>
          <button type="button" className="button button--ghost" onClick={() => { setExportHistory([]); setSelectedExportHistoryId(null); setCompareExportHistoryId(""); setExportHistorySearch(""); setExportHistoryAction("all"); setStatus("Cleared renderer-local export history; no durable log was changed."); }} disabled={!exportHistory.length}><Trash2 size={13} /> Clear log</button>
        </div>
        {visibleExportHistory.length ? <div className="workspace-export-center__history-list">
          {visibleExportHistory.map((entry) => <article key={entry.id} className="workspace-export-history-entry">
            <div className="workspace-export-history-entry__icon"><History size={14} /></div>
            <div className="workspace-export-history-entry__copy">
              <strong>{EXPORT_HISTORY_ACTION_LABELS[entry.action]}</strong>
              <small>{new Date(entry.occurredAt).toLocaleString()} · {entry.scope} · {entry.format.toUpperCase()} · {entry.recordCount} records · {entry.bytes.toLocaleString()} bytes</small>
            </div>
            <button type="button" className="button button--ghost" onClick={() => { setSelectedExportHistoryId(entry.id); setCompareExportHistoryId(""); }} aria-label={`Inspect ${EXPORT_HISTORY_ACTION_LABELS[entry.action]} details`} aria-pressed={selectedExportHistoryId === entry.id}><Eye size={13} /> Inspect</button>
            <button type="button" className="button button--ghost" onClick={() => restoreExportHistoryEntry(entry)} aria-label={`Restore ${EXPORT_HISTORY_ACTION_LABELS[entry.action]} settings`}><RefreshCw size={13} /> Restore settings</button>
            <button type="button" className="button button--ghost" onClick={() => removeExportHistoryEntry(entry)} aria-label={`Remove ${EXPORT_HISTORY_ACTION_LABELS[entry.action]} from history`}><Trash2 size={13} /> Remove</button>
          </article>)}
        </div> : <p className="workspace-export-center__history-empty">No export actions match this filter. Generate, copy, or download a preview to create a session entry.</p>}
        <p className="workspace-export-center__history-boundary"><ShieldCheck size={13} /> Session-only metadata: raw export payloads, secrets, file bytes, provider requests, and native receipts are never retained here.</p>
      </section>

      {selectedExportHistoryEntry ? <section className="workspace-export-center__history-detail" aria-label="Selected export history entry">
        <header>
          <div>
            <span className="eyebrow"><SlidersHorizontal size={13} /> History detail · renderer session</span>
            <h3>{EXPORT_HISTORY_ACTION_LABELS[selectedExportHistoryEntry.action]}</h3>
            <p>{new Date(selectedExportHistoryEntry.occurredAt).toLocaleString()} · generated {new Date(selectedExportHistoryEntry.generatedAt).toLocaleString()}</p>
          </div>
          <button type="button" className="button button--ghost" onClick={() => { setSelectedExportHistoryId(null); setCompareExportHistoryId(""); }} aria-label="Close export history details"><X size={13} /> Close</button>
        </header>
        <div className="workspace-export-center__history-detail-summary" aria-label="Selected export history summary">
          <div><span>Scope</span><strong>{selectedExportHistoryEntry.scope}</strong></div>
          <div><span>Redaction</span><strong>{selectedExportHistoryEntry.redaction}</strong></div>
          <div><span>Format</span><strong>{selectedExportHistoryEntry.format.toUpperCase()}</strong></div>
          <div><span>Records / bytes</span><strong>{selectedExportHistoryEntry.recordCount} · {selectedExportHistoryEntry.bytes.toLocaleString()}</strong></div>
        </div>
        <div className="workspace-export-center__history-detail-compare" role="group" aria-label="Current draft comparison">
          <div>
            <span className="eyebrow">Draft comparison</span>
            <h4>{selectedExportHistoryChanges.length
              ? selectedExportHistoryChanges.length === 1
                ? "1 setting differs"
                : `${selectedExportHistoryChanges.length} settings differ`
              : "Current draft matches this entry"}</h4>
            <p>Only renderer controls are compared. The retained entry does not contain raw export payloads and cannot restore app data.</p>
          </div>
          {selectedExportHistoryChanges.length ? <ul>
            {selectedExportHistoryChanges.map((change) => <li key={change.key}><strong>{change.label}</strong><span>{change.previous} → {change.current}</span></li>)}
          </ul> : <p className="workspace-export-center__history-detail-empty">No scope, redaction, format, attachment, or category-selection differences.</p>}
        </div>
        <div className="workspace-export-center__history-detail-compare" role="group" aria-label="History entry comparison">
          <div>
            <span className="eyebrow">Compare two history entries</span>
            <h4>{comparisonExportHistoryEntry
              ? historyEntryChanges.length
                ? `${historyEntryChanges.length} setting${historyEntryChanges.length === 1 ? "" : "s"} differ`
                : "History settings match"
              : "Choose a second entry"}</h4>
            <p>Compare saved export controls between two entries. Differences read from this inspected entry to the selected comparison entry; payload records and workspace data are not compared or restored.</p>
          </div>
          <label className="workspace-export-center__history-compare-select">
            <span>Compare with</span>
            <select aria-label="Compare export history entry" value={comparisonExportHistoryEntry?.id ?? ""} onChange={(event) => setCompareExportHistoryId(event.target.value)}>
              <option value="">Choose another history entry…</option>
              {exportHistory.filter((entry) => entry.id !== selectedExportHistoryEntry.id).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {EXPORT_HISTORY_ACTION_LABELS[entry.action]} · {entry.scope} · {entry.format.toUpperCase()} · {new Date(entry.occurredAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {comparisonExportHistoryEntry
            ? historyEntryChanges.length ? <ul>
              {historyEntryChanges.map((change) => <li key={change.key}><strong>{change.label}</strong><span>{change.previous} → {change.current}</span></li>)}
            </ul> : <p className="workspace-export-center__history-detail-empty">The two entries have identical export control settings.</p>
            : null}
        </div>
        <div className="workspace-export-center__history-detail-actions">
          <button type="button" className="button button--secondary" onClick={() => restoreExportHistoryEntry(selectedExportHistoryEntry)}><RefreshCw size={13} /> Restore settings</button>
          <button type="button" className="button button--ghost" onClick={() => removeExportHistoryEntry(selectedExportHistoryEntry)}><Trash2 size={13} /> Remove entry</button>
        </div>
        <p className="workspace-export-center__history-detail-boundary"><ShieldCheck size={13} /> Preview only · session-only. Inspecting, comparing, restoring settings, or removing this entry does not write a file, create a native receipt, call a provider, or restore workspace data.</p>
      </section> : null}

      {importedReview ? <section className="workspace-export-center__import-review" aria-label="Imported bundle review">
        <header>
          <div><span className="eyebrow">Imported file · renderer-local</span><h3>Review imported bundle</h3>
            <p>{importedReview.records.length} metadata records · {importedReview.scope} · generated {importedReview.generatedAt}</p></div>
          <button type="button" className="button button--ghost" onClick={() => { setImportedReview(null); setImportSearch(""); setImportKind("all"); setImportDiffStatus("all"); setImportConflictDecisions({}); setStatus("Closed imported review; current app data was never replaced."); }}>Close review</button>
        </header>
        <p className="workspace-export-center__import-boundary">Records below come only from the selected file. The export preview below still uses current renderer data. Import never creates or replaces Chats, Projects, files, memories, or native settings.</p>
        <div className="workspace-export-center__import-tools">
          <label><span>Find imported record</span><input type="search" value={importSearch} onChange={(event) => setImportSearch(event.target.value)} placeholder="Title, ID, kind…" /></label>
          <label><span>Category</span><select aria-label="Imported record category" value={importKind} onChange={(event) => setImportKind(event.target.value as WorkspaceExportRecordKind | "all")}>
            <option value="all">All categories</option>{CATEGORY_META.map((category) => <option key={category.kind} value={category.kind}>{category.label} ({importedReview.counts[category.kind]})</option>)}
          </select></label>
          <span role="status">{importedMatches.length} of {importedReview.records.length} matching · showing first 25</span>
        </div>
        <section className="workspace-export-center__diff" aria-label="Imported versus current preview diff">
          <header className="workspace-export-center__diff-header">
            <div>
              <span className="eyebrow">Comparison preview · renderer-local</span>
              <h4>Imported vs current metadata</h4>
              <p>Compare the selected file with the current renderer projection by category and ID. This is not an integrity or provenance check.</p>
            </div>
            <label className="workspace-export-center__diff-filter"><span>Status</span><select aria-label="Imported diff status" value={importDiffStatus} onChange={(event) => setImportDiffStatus(event.target.value as WorkspaceExportDiffStatus | "all")}>
              <option value="all">All statuses</option>
              {(Object.keys(DIFF_STATUS_LABELS) as WorkspaceExportDiffStatus[]).map((value) => <option key={value} value={value}>{DIFF_STATUS_LABELS[value]}</option>)}
            </select></label>
          </header>
          <div className="workspace-export-center__diff-summary" aria-label="Imported diff summary">
            {(Object.entries({
              changed: diffCounts.changed,
              "imported-only": diffCounts.importedOnly,
              "current-only": diffCounts.currentOnly,
              unchanged: diffCounts.unchanged,
            }) as Array<[WorkspaceExportDiffStatus, number]>).map(([statusKey, count]) => <div key={statusKey} className={`workspace-export-center__diff-stat workspace-export-center__diff-stat--${statusKey}`}>
              <strong>{count}</strong><span>{DIFF_STATUS_LABELS[statusKey]}</span>
            </div>)}
          </div>
          <section className="workspace-export-center__conflict-studio" aria-label="Import conflict decisions">
            <header>
              <div><span className="eyebrow">Merge rehearsal · renderer session</span><h5>Conflict decisions</h5>
                <p>{conflictSummary.total} conflicts · {conflictSummary.pending} to review · {conflictSummary.keepCurrent} keeping current · {conflictSummary.useImported} selecting imported.</p></div>
              <div className="workspace-export-center__conflict-bulk" role="group" aria-label="Bulk conflict decisions">
                <button type="button" className="button button--ghost" onClick={() => decideVisibleImportConflicts("keep-current")} disabled={!filteredDiffs.some(isWorkspaceExportConflict)}>Keep current on visible</button>
                <button type="button" className="button button--ghost" onClick={() => decideVisibleImportConflicts("use-imported")} disabled={!filteredDiffs.some(isWorkspaceExportConflict)}>Use import on visible</button>
                <button type="button" className="button button--ghost" onClick={clearImportConflictDecisions} disabled={!Object.keys(importConflictDecisions).length}>Reset decisions</button>
              </div>
            </header>
            <p className="workspace-export-center__conflict-boundary">Preview only · unresolved conflicts conservatively keep current metadata. “Use imported” only selects a row for this rehearsal; it never merges, overwrites, deletes, or persists workspace data.</p>
            <details className="workspace-export-center__merge-preview">
              <summary>Inspect resulting metadata preview · {conflictMergePreview.length} records</summary>
              <div className="workspace-export-center__merge-preview-list">
                {conflictMergePreview.slice(0, 20).map((record) => <article key={`${record.kind}:${record.id}`}><span>{record.kind}</span><strong>{record.label || record.id}</strong><small>{record.id}</small><p>{record.summary || "No summary"}</p></article>)}
                {!conflictMergePreview.length ? <p className="workspace-export-center__import-empty">No records remain under the current preview decisions.</p> : null}
              </div>
              {conflictMergePreview.length > 20 ? <p className="workspace-export-center__diff-more">Showing first 20 records in the merge rehearsal.</p> : null}
            </details>
          </section>
          <p className="workspace-export-center__diff-boundary">Diff rows are normalized metadata only. No imported value is applied, no current value is overwritten, and no native/provider state is consulted.</p>
          {filteredDiffs.length ? <div className="workspace-export-center__diff-records">
            {filteredDiffs.slice(0, 25).map((diff) => {
              const label = diff.current?.label ?? diff.imported?.label ?? diff.id;
              const conflictDecision = getWorkspaceExportConflictDecision(diff, importConflictDecisions);
              return <details key={diff.key}>
                <summary><span className={`workspace-export-center__diff-status workspace-export-center__diff-status--${diff.status}`}>{DIFF_STATUS_LABELS[diff.status]}</span><strong>{diff.status === "unchanged" ? label : `${diff.kind} ${diff.id}`}</strong><small>{diff.kind} · {diff.id}</small></summary>
                <div className="workspace-export-center__diff-values">
                  <div><span>Imported file</span><p>{diff.imported?.summary ?? "This record is not present in the imported file."}</p><small>{diff.imported ? JSON.stringify(diff.imported.metadata) : "No imported row"}</small></div>
                  <div><span>Current preview</span><p>{diff.current?.summary ?? "This record is not present in the current projection."}</p><small>{diff.current ? JSON.stringify(diff.current.metadata) : "No current row"}</small></div>
                </div>
                {diff.changedFields.length ? <p className="workspace-export-center__diff-fields">Changed fields: {diff.changedFields.join(", ")}. {DIFF_STATUS_DESCRIPTIONS[diff.status]}</p> : <p className="workspace-export-center__diff-fields">{DIFF_STATUS_DESCRIPTIONS[diff.status]}</p>}
                {isWorkspaceExportConflict(diff) ? <div className="workspace-export-center__conflict-row-actions" role="group" aria-label={`Decision for ${diff.kind} ${diff.id}`}>
                  <span>Preview decision: <strong>{WORKSPACE_EXPORT_CONFLICT_DECISION_LABELS[conflictDecision]}</strong></span>
                  <button type="button" className={conflictDecision === "keep-current" ? "button button--secondary" : "button button--ghost"} aria-pressed={conflictDecision === "keep-current"} onClick={() => setImportConflictDecisions((current) => ({ ...current, [diff.key]: "keep-current" }))}>Keep current</button>
                  <button type="button" className={conflictDecision === "use-imported" ? "button button--secondary" : "button button--ghost"} aria-pressed={conflictDecision === "use-imported"} onClick={() => setImportConflictDecisions((current) => ({ ...current, [diff.key]: "use-imported" }))}>Use imported</button>
                  <button type="button" className="button button--ghost" aria-label={`Defer ${diff.kind} ${diff.id}`} onClick={() => setImportConflictDecisions((current) => { const next = { ...current }; delete next[diff.key]; return next; })}>Review later</button>
                </div> : null}
              </details>;
            })}
          </div> : <p className="workspace-export-center__import-empty">No diff rows match this search, category, and status.</p>}
          {filteredDiffs.length > 25 ? <p className="workspace-export-center__diff-more">Showing first 25 matching diff rows; adjust the search or status filter to narrow the preview.</p> : null}
        </section>
        {importedMatches.length ? <div className="workspace-export-center__import-records">
          {importedMatches.slice(0, 25).map((record, index) => <details key={`${record.kind}:${record.id}:${index}`}>
            <summary><span>{record.kind}</span><strong>{record.label}</strong><small>{record.id}</small></summary>
            <p>{record.summary}</p><pre>{JSON.stringify(record.metadata, null, 2)}</pre>
          </details>)}
        </div> : <p className="workspace-export-center__import-empty">No imported records match this search and category.</p>}
      </section> : null}

      <section className="workspace-export-center__category-section" aria-labelledby="workspace-export-category-title">
        <header className="workspace-export-center__category-header">
          <div>
            <span className="eyebrow">Payload contents</span>
            <h3 id="workspace-export-category-title">Data categories</h3>
            <p>{selectedCategoryCount} of {CATEGORY_META.length} categories selected · {projection.records.length} records in the current scope.</p>
          </div>
          <div className="workspace-export-center__category-actions" role="toolbar" aria-label="Export category selection">
            <button type="button" className="button button--ghost" onClick={() => updateDraft({ selection: { ...DEFAULT_SELECTION } })} disabled={selectedCategoryCount === CATEGORY_META.length}><Check size={14} /> Select all</button>
            <button type="button" className="button button--ghost" onClick={() => updateDraft({ selection: Object.fromEntries(CATEGORY_META.map((category) => [category.key, false])) as unknown as WorkspaceExportSelection })} disabled={selectedCategoryCount === 0}><Trash2 size={14} /> Clear all</button>
          </div>
        </header>
        <div className="workspace-export-center__categories">
          {CATEGORY_META.map((category) => {
            const count = projection.counts[category.kind];
            return <label key={category.key} className={draft.selection[category.key] ? "workspace-export-category workspace-export-category--active" : "workspace-export-category"}>
              <input type="checkbox" checked={draft.selection[category.key]} onChange={(event) => updateDraft({ selection: { ...draft.selection, [category.key]: event.target.checked } })} />
              <span className="workspace-export-category__copy"><strong>{category.label}</strong><small>{category.description}</small></span>
              <span className="workspace-export-category__count">{count}</span>
            </label>;
          })}
        </div>
      </section>

      <div className="workspace-export-center__summary">
        <div><span>Total records</span><strong>{projection.records.length}</strong></div>
        <div><span>Estimated bytes</span><strong>{new TextEncoder().encode(serializeWorkspaceExport(projection, draft.format)).byteLength.toLocaleString()}</strong></div>
        <div><span>Schema</span><strong>v1</strong></div>
        <div><span>Integrity</span><strong>Renderer projection</strong></div>
      </div>

      <div className="workspace-export-center__actions">
        <button type="button" className="button button--primary" onClick={generatePreview}><Check size={15} /> Generate preview</button>
        <button type="button" className="button button--secondary" onClick={() => void copyPreview()}><Clipboard size={15} /> Copy {draft.format.toUpperCase()}</button>
        <button type="button" className="button button--secondary" onClick={downloadPreview}><Download size={15} /> Download</button>
      </div>

      <details className="workspace-export-center__payload">
        <summary><FileJson size={15} /> Inspect payload preview</summary>
        <pre>{serializeWorkspaceExport(projection, draft.format)}</pre>
      </details>

      {status ? <p className="workspace-export-center__status" role="status" aria-live="polite"><History size={14} /> {status}</p> : null}
      <p className="workspace-export-center__footer"><SlidersHorizontal size={14} /> This center exports metadata projections only. Secrets, raw message bodies, file bytes, provider requests, native receipts, and durable settings are never included.</p>
    </section>
  );
}

export default WorkspaceExportCenter;
