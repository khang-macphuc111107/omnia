import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Archive,
  ArrowUpDown,
  BookOpen,
  Bookmark,
  Brain,
  Command,
  Cpu,
  Clock3,
  FileText,
  Filter,
  FolderKanban,
  MessageSquareText,
  RotateCcw,
  Save,
  Search,
  Server,
  X,
} from "lucide-react";

import type {
  ActivityId,
  ArtifactView,
  ConversationView,
  MemoryView,
  ProjectView,
  ProviderView,
  SkillView,
} from "./types";
import { buildProjectContextAvailabilityForProject } from "./project-context-availability-contract";
import { openWorkspaceOverlay } from "./overlay-store";

export type GlobalSearchKind = "all" | "command" | "chat" | "message" | "project" | "file" | "memory" | "skill" | "artifact" | "provider" | "model";
export type GlobalSearchStatus = "all" | "ready" | "preview" | "attention";
export type GlobalSearchSort = "relevance" | "recent" | "title";

export interface GlobalObjectSearchResult {
  id: string;
  kind: Exclude<GlobalSearchKind, "all">;
  title: string;
  subtitle: string;
  detail: string;
  keywords: string;
  statusLabel: string;
  statusTone: "ready" | "preview" | "attention" | "planned";
  updatedAt?: string;
  pinned?: boolean;
  /** Human-readable renderer location; this is a breadcrumb preview, not a deep-link authority. */
  breadcrumb?: string[];
}

export interface ParsedGlobalSearchQuery {
  term: string;
  terms: string[];
  kind: GlobalSearchKind;
  status: GlobalSearchStatus;
}

interface SavedGlobalSearchView {
  id: string;
  name: string;
  query: string;
  kind: GlobalSearchKind;
  status: GlobalSearchStatus;
  sort: GlobalSearchSort;
}

export interface GlobalObjectSearchPreviewProps {
  conversations: ConversationView[];
  projects: ProjectView[];
  memories: MemoryView[];
  skills: SkillView[];
  artifacts: ArtifactView[];
  providers: ProviderView[];
  onOpenConversation: (conversationId: string) => void;
  onOpenProject: (projectId: string) => void;
  onNavigate: (activity: ActivityId) => void;
  onClose: () => void;
}

const FILTERS: Array<{ id: GlobalSearchKind; label: string }> = [
  { id: "all", label: "All" },
  { id: "command", label: "Commands" },
  { id: "chat", label: "Chats" },
  { id: "message", label: "Messages" },
  { id: "project", label: "Projects" },
  { id: "file", label: "Files" },
  { id: "memory", label: "Memory" },
  { id: "skill", label: "Skills" },
  { id: "artifact", label: "Artifacts" },
  { id: "provider", label: "Providers" },
  { id: "model", label: "Models" },
];

const KIND_LABEL: Record<Exclude<GlobalSearchKind, "all">, string> = {
  command: "Command",
  chat: "Chat",
  message: "Message",
  project: "Project",
  file: "File",
  memory: "Memory",
  skill: "Skill",
  artifact: "Artifact",
  provider: "Provider",
  model: "Model",
};

const KIND_ALIASES: Record<string, GlobalSearchKind> = {
  all: "all",
  command: "command",
  commands: "command",
  chat: "chat",
  chats: "chat",
  conversation: "chat",
  conversations: "chat",
  message: "message",
  messages: "message",
  project: "project",
  projects: "project",
  file: "file",
  files: "file",
  memory: "memory",
  memories: "memory",
  skill: "skill",
  skills: "skill",
  artifact: "artifact",
  artifacts: "artifact",
  provider: "provider",
  providers: "provider",
  model: "model",
  models: "model",
};

const STATUS_ALIASES: Record<string, GlobalSearchStatus> = {
  all: "all",
  ready: "ready",
  active: "ready",
  preview: "preview",
  draft: "preview",
  archived: "preview",
  attention: "attention",
  failed: "attention",
  writing: "attention",
};

const SESSION_RECENT_SEARCHES: string[] = [];
const SESSION_SAVED_GLOBAL_SEARCHES: SavedGlobalSearchView[] = [];
let savedGlobalSearchSequence = 0;
const MAX_SAVED_GLOBAL_SEARCHES = 24;
const MAX_SAVED_GLOBAL_SEARCH_NAME = 48;

function createSavedGlobalSearchId(): string {
  savedGlobalSearchSequence += 1;
  return `global-search-view-${Date.now().toString(36)}-${savedGlobalSearchSequence.toString(36)}`;
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

function parseKindToken(value: string): GlobalSearchKind | null {
  return KIND_ALIASES[normalizeSearchValue(value)] ?? null;
}

function parseStatusToken(value: string): GlobalSearchStatus | null {
  return STATUS_ALIASES[normalizeSearchValue(value)] ?? null;
}

/**
 * Keeps the chip/select controls and the free-form query from fighting each
 * other. An explicit operator remains useful while typing, but selecting a
 * control should make that control authoritative again by removing only the
 * corresponding operator token from the draft query.
 */
function stripGlobalSearchOperators(rawQuery: string, target: "kind" | "status"): string {
  return rawQuery
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      const normalized = normalizeSearchValue(token);
      if (target === "status") {
        const match = normalized.match(/^status:(.+)$/);
        return !(match && parseStatusToken(match[1] ?? ""));
      }
      const operatorMatch = normalized.match(/^(type|kind):(.+)$/);
      if (operatorMatch && parseKindToken(operatorMatch[2] ?? "")) return false;
      return !(normalized.startsWith("@") && parseKindToken(normalized.slice(1)));
    })
    .join(" ");
}

/**
 * Result IDs can contain project paths, provider IDs, or user-created names.
 * Encoding the complete value avoids collisions such as `a/b` and `a-b`,
 * which would otherwise generate the same aria-activedescendant target.
 */
function globalSearchResultDomId(resultId: string): string {
  return `global-search-result-${encodeURIComponent(resultId)}`;
}

/**
 * Parses lightweight search operators without pretending that a native index
 * exists. Bare words remain renderer-local full-text terms.
 *
 * Supported examples:
 *   `type:chat borrow`
 *   `kind:project status:attention`
 *   `@memory provenance`
 */
export function parseGlobalSearchQuery(
  rawQuery: string,
  selectedKind: GlobalSearchKind = "all",
  selectedStatus: GlobalSearchStatus = "all",
): ParsedGlobalSearchQuery {
  let kind = selectedKind;
  let status = selectedStatus;
  const terms: string[] = [];

  for (const token of rawQuery.trim().split(/\s+/).filter(Boolean)) {
    const normalized = normalizeSearchValue(token);
    const operatorMatch = normalized.match(/^(type|kind|status):(.+)$/);
    const operatorValue = operatorMatch?.[2];
    if (operatorMatch?.[1] === "type" || operatorMatch?.[1] === "kind") {
      const parsedKind = operatorValue ? parseKindToken(operatorValue) : null;
      if (parsedKind) {
        kind = parsedKind;
        continue;
      }
    }
    if (operatorMatch?.[1] === "status") {
      const parsedStatus = operatorValue ? parseStatusToken(operatorValue) : null;
      if (parsedStatus) {
        status = parsedStatus;
        continue;
      }
    }
    if (normalized.startsWith("@")) {
      const parsedKind = parseKindToken(normalized.slice(1));
      if (parsedKind) {
        kind = parsedKind;
        continue;
      }
    }
    terms.push(token);
  }

  return { term: terms.join(" "), terms: terms.map(normalizeSearchValue), kind, status };
}

function kindIcon(kind: GlobalObjectSearchResult["kind"]) {
  if (kind === "command") return <Command size={16} aria-hidden="true" />;
  if (kind === "chat") return <MessageSquareText size={16} aria-hidden="true" />;
  if (kind === "message") return <MessageSquareText size={16} aria-hidden="true" />;
  if (kind === "project") return <FolderKanban size={16} aria-hidden="true" />;
  if (kind === "memory") return <Brain size={16} aria-hidden="true" />;
  if (kind === "skill") return <BookOpen size={16} aria-hidden="true" />;
  if (kind === "provider") return <Server size={16} aria-hidden="true" />;
  if (kind === "model") return <Cpu size={16} aria-hidden="true" />;
  return <FileText size={16} aria-hidden="true" />;
}

function statusForConversation(conversation: ConversationView): Pick<GlobalObjectSearchResult, "statusLabel" | "statusTone"> {
  if (conversation.runState === "failed") return { statusLabel: "Needs attention", statusTone: "attention" };
  if (conversation.runState === "streaming") return { statusLabel: "Writing", statusTone: "attention" };
  if (conversation.archived) return { statusLabel: "Archived preview", statusTone: "preview" };
  if (conversation.hasDraft) return { statusLabel: "Draft", statusTone: "preview" };
  return { statusLabel: "Ready", statusTone: "ready" };
}

export function buildGlobalSearchResults({
  conversations,
  projects,
  memories,
  skills,
  artifacts,
  providers,
}: Pick<GlobalObjectSearchPreviewProps, "conversations" | "projects" | "memories" | "skills" | "artifacts" | "providers">): GlobalObjectSearchResult[] {
  return [
    ...conversations.map((conversation) => {
      const status = statusForConversation(conversation);
      const messageText = conversation.messages.map((message) => message.content).join(" ");
      const attachmentText = conversation.messages
        .flatMap((message) => message.attachments)
        .map((attachment) => attachment.name)
        .join(" ");
      return {
        id: `chat:${conversation.id}`,
        kind: "chat" as const,
        title: conversation.title,
        subtitle: conversation.projectName ?? "Standalone chat",
        detail: `${conversation.excerpt} · ${conversation.messages.length} messages · updated ${conversation.updatedLabel}`,
        keywords: `${conversation.title} ${conversation.excerpt} ${conversation.projectName ?? ""} ${conversation.draft} ${messageText} ${attachmentText}`,
        ...status,
        updatedAt: conversation.updatedAt,
        pinned: conversation.pinned,
        breadcrumb: ["Chats", conversation.projectName ?? "Standalone", conversation.title],
      };
    }),
    ...conversations.flatMap((conversation) => conversation.messages.map((message) => ({
      id: `message:${conversation.id}:${message.id}`,
      kind: "message" as const,
      title: message.content.trim().slice(0, 76) || `${message.role} message`,
      subtitle: `${conversation.title} · ${message.role}`,
      detail: `${message.status} · ${message.createdAt} · ${message.content.trim().length} characters`,
      keywords: `${message.content} ${message.role} ${message.status} ${conversation.title} ${conversation.projectName ?? ""} ${message.attachments.map((attachment) => attachment.name).join(" ")}`,
      statusLabel: message.status === "failed" ? "Needs attention" : message.status === "streaming" ? "Writing" : "Message preview",
      statusTone: message.status === "failed" ? "attention" as const : message.status === "streaming" ? "attention" as const : "preview" as const,
      updatedAt: message.createdAt,
      breadcrumb: ["Chats", conversation.title, message.role === "assistant" ? "Assistant message" : "User message"],
    }))),
    ...projects.map((project) => {
      const contextAvailability = buildProjectContextAvailabilityForProject(project);
      const statusTone = project.archived
        ? "preview" as const
        : contextAvailability.tone === "danger" || contextAvailability.tone === "warning"
          ? "attention" as const
          : contextAvailability.surfaceStatus === "verified"
            ? "ready" as const
            : "preview" as const;
      return {
        id: `project:${project.id}`,
        kind: "project" as const,
        title: project.name,
        subtitle: `Workspace · ${contextAvailability.label}`,
        detail: `${project.description} · ${project.conversationCount} chats · ${project.folders.length} folders`,
        keywords: `${project.name} ${project.description} ${project.instructions} ${project.contextHealth} ${contextAvailability.label} ${project.folders.map((folder) => `${folder.displayName} ${folder.canonicalPath}`).join(" ")}`,
        statusLabel: project.archived ? "Archived preview" : contextAvailability.label,
        statusTone,
        pinned: project.pinned,
        breadcrumb: ["Projects", project.name],
      };
    }),
    ...projects.flatMap((project) => project.folders.map((folder) => {
      const statusTone = folder.state === "permission-lost" || folder.state === "offline"
        ? "attention" as const
        : folder.state === "ready"
          ? "ready" as const
          : "preview" as const;
      return {
        id: `file:${project.id}:${folder.id}`,
        kind: "file" as const,
        title: folder.displayName,
        subtitle: `${project.name} · ${folder.scope}`,
        detail: `${folder.canonicalPath} · ${folder.fileCount ?? "unknown"} files · ${folder.state}`,
        keywords: `${folder.displayName} ${folder.canonicalPath} ${folder.scope} ${folder.state} ${project.name} ${project.description}`,
        statusLabel: folder.state === "ready" ? "Indexed metadata" : `${folder.state} preview`,
        statusTone,
        breadcrumb: ["Projects", project.name, "Files", folder.displayName],
        ...(folder.lastIndexedAt ? { updatedAt: folder.lastIndexedAt } : {}),
      };
    })),
    ...memories.map((memory) => ({
      id: `memory:${memory.id}`,
      kind: "memory" as const,
      title: memory.title || memory.content.slice(0, 58) || "Untitled memory",
      subtitle: `${memory.scopeLabel} · ${memory.kind}`,
      detail: `${memory.content} · ${memory.sourceLabel}`,
      keywords: `${memory.title ?? ""} ${memory.content} ${memory.scopeLabel} ${memory.kind} ${memory.origin}`,
      statusLabel: memory.status === "active" ? "Active preview" : memory.status,
      statusTone: memory.status === "active" ? "ready" as const : "preview" as const,
      breadcrumb: ["Memory", memory.scopeLabel, memory.kind],
    })),
    ...skills.map((skill) => ({
      id: `skill:${skill.id}`,
      kind: "skill" as const,
      title: skill.name,
      subtitle: `${skill.scope} · ${skill.version}`,
      detail: `${skill.description} · ${skill.trust} · ${skill.permissions.length} permissions`,
      keywords: `${skill.name} ${skill.description} ${skill.version} ${skill.source} ${skill.trust} ${skill.permissions.join(" ")}`,
      statusLabel: skill.enabled ? "Enabled preview" : "Available",
      statusTone: skill.enabled ? "ready" as const : "preview" as const,
      breadcrumb: ["Skills", skill.scope, skill.name],
    })),
    ...artifacts.map((artifact) => ({
      id: `artifact:${artifact.id}`,
      kind: "artifact" as const,
      title: artifact.name,
      subtitle: `${artifact.type} · ${artifact.projectName}`,
      detail: `${artifact.sizeLabel} · ${artifact.versionCount} revisions · updated ${artifact.updatedLabel}`,
      keywords: `${artifact.name} ${artifact.type} ${artifact.projectName} ${artifact.sizeLabel}`,
      statusLabel: "Renderer catalog",
      statusTone: "preview" as const,
      breadcrumb: ["Library", artifact.projectName, artifact.name],
    })),
    ...providers.map((provider) => ({
      id: `provider:${provider.id}`,
      kind: "provider" as const,
      title: provider.name,
      subtitle: `${provider.kind} · ${provider.modelCount} models`,
      detail: `${provider.state} · ${provider.source} source · ${provider.credentialState} credential`,
      keywords: `${provider.name} ${provider.kind} ${provider.providerType} ${provider.state} ${provider.source}`,
      statusLabel: provider.state === "connected" ? "Connected metadata" : provider.state,
      statusTone: provider.state === "connected" ? "ready" as const : "preview" as const,
      breadcrumb: ["Settings", "Providers", provider.name],
      })),
    ...providers.flatMap((provider) => provider.models.map((model) => {
      const statusTone = model.status === "available"
        ? "ready" as const
        : model.status === "degraded" || model.status === "unavailable"
          ? "attention" as const
          : "preview" as const;
      return {
        id: `model:${provider.id}:${model.id}`,
        kind: "model" as const,
        title: model.displayName,
        subtitle: `${provider.name} · ${model.providerModelId}`,
        detail: `${model.status} · ${model.contextLabel} context · ${model.speed} · ${model.capabilities.join(", ") || "text"}`,
        keywords: `${model.displayName} ${model.providerModelId} ${provider.name} ${provider.kind} ${model.status} ${model.capabilities.join(" ")} ${model.contextLabel} ${model.speed}`,
        statusLabel: model.status === "available" ? "Available metadata" : model.status,
        statusTone,
        pinned: model.favorite,
        breadcrumb: ["Settings", "Providers", provider.name, model.displayName],
        ...(provider.lastCheckedAt ? { updatedAt: provider.lastCheckedAt } : {}),
      };
    })),
  ];
}

/**
 * Built-in navigation actions keep the home search useful as a command center
 * without claiming a native command registry. They are renderer-local intents
 * and deliberately use the same preview boundaries as the surrounding UI.
 */
export function buildGlobalSearchCommands(): GlobalObjectSearchResult[] {
  return [
    {
      id: "command:new-chat",
      kind: "command",
      title: "New conversation",
      subtitle: "Create",
      detail: "Open the new conversation setup preview.",
      keywords: "new conversation chat create start composer",
      statusLabel: "Available preview",
      statusTone: "ready",
      breadcrumb: ["Commands", "Create", "New conversation"],
    },
    {
      id: "command:new-project",
      kind: "command",
      title: "New project",
      subtitle: "Create",
      detail: "Open the project setup preview.",
      keywords: "new project workspace create folder instructions",
      statusLabel: "Available preview",
      statusTone: "ready",
      breadcrumb: ["Commands", "Create", "New project"],
    },
    {
      id: "command:open-chats",
      kind: "command",
      title: "Open Chats",
      subtitle: "Navigate",
      detail: "Open conversations and active runs.",
      keywords: "open chats conversations navigation",
      statusLabel: "Available preview",
      statusTone: "ready",
      breadcrumb: ["Commands", "Navigate", "Chats"],
    },
    {
      id: "command:open-projects",
      kind: "command",
      title: "Open Projects",
      subtitle: "Navigate",
      detail: "Open scoped workspaces and grants.",
      keywords: "open projects workspace navigation",
      statusLabel: "Available preview",
      statusTone: "ready",
      breadcrumb: ["Commands", "Navigate", "Projects"],
    },
    {
      id: "command:open-library",
      kind: "command",
      title: "Open Library",
      subtitle: "Navigate",
      detail: "Open sources, artifacts, and provenance previews.",
      keywords: "open library artifacts sources provenance navigation",
      statusLabel: "Available preview",
      statusTone: "ready",
      breadcrumb: ["Commands", "Navigate", "Library"],
    },
    {
      id: "command:open-memory",
      kind: "command",
      title: "Open Memory Studio",
      subtitle: "Navigate",
      detail: "Review renderer-local memory candidates.",
      keywords: "open memory studio candidates navigation",
      statusLabel: "Preview",
      statusTone: "preview",
      breadcrumb: ["Commands", "Navigate", "Memory"],
    },
    {
      id: "command:open-skills",
      kind: "command",
      title: "Open Skills Studio",
      subtitle: "Navigate",
      detail: "Review skills, trust, and permission previews.",
      keywords: "open skills studio trust permissions navigation",
      statusLabel: "Preview",
      statusTone: "preview",
      breadcrumb: ["Commands", "Navigate", "Skills"],
    },
    {
      id: "command:open-settings",
      kind: "command",
      title: "Open Control Center",
      subtitle: "Navigate",
      detail: "Open providers and desktop policy previews.",
      keywords: "open settings control center providers policy navigation",
      statusLabel: "Preview",
      statusTone: "preview",
      breadcrumb: ["Commands", "Navigate", "Control Center"],
    },
  ];
}

function resultMatches(result: GlobalObjectSearchResult, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${result.title} ${result.subtitle} ${result.detail} ${result.keywords}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function resultRelevance(result: GlobalObjectSearchResult, terms: string[]): number {
  if (terms.length === 0) return 0;
  const title = result.title.toLowerCase();
  const subtitle = result.subtitle.toLowerCase();
  const haystack = `${title} ${subtitle} ${result.detail} ${result.keywords}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const titleIndex = title.indexOf(term);
    const subtitleIndex = subtitle.indexOf(term);
    const haystackIndex = haystack.indexOf(term);
    score += titleIndex === 0 ? 0 : titleIndex > 0 ? 12 : subtitleIndex === 0 ? 24 : haystackIndex >= 0 ? 48 + haystackIndex / 100 : 1000;
  }
  if (result.pinned) score -= 8;
  if (result.statusTone === "attention") score -= 6;
  return score;
}

export function rankGlobalSearchResults(
  results: GlobalObjectSearchResult[],
  parsedQuery: Pick<ParsedGlobalSearchQuery, "terms">,
  sort: GlobalSearchSort,
): GlobalObjectSearchResult[] {
  return [...results].sort((left, right) => {
    if (sort === "title") {
      return left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id);
    }
    if (sort === "recent") {
      const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
      const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
      return rightTime - leftTime || (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0) || left.title.localeCompare(right.title);
    }
    return resultRelevance(left, parsedQuery.terms) - resultRelevance(right, parsedQuery.terms)
      || (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0)
      || left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  });
}

export function GlobalObjectSearchPreview({
  conversations,
  projects,
  memories,
  skills,
  artifacts,
  providers,
  onOpenConversation,
  onOpenProject,
  onNavigate,
  onClose,
}: GlobalObjectSearchPreviewProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<GlobalSearchKind>("all");
  const [status, setStatus] = useState<GlobalSearchStatus>("all");
  const [sort, setSort] = useState<GlobalSearchSort>("relevance");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => SESSION_RECENT_SEARCHES.slice(0, 6));
  const [savedViews, setSavedViews] = useState<SavedGlobalSearchView[]>(() => SESSION_SAVED_GLOBAL_SEARCHES.slice());
  const [activeSavedViewId, setActiveSavedViewId] = useState("");
  const [savedViewName, setSavedViewName] = useState("");
  const [savedViewStatus, setSavedViewStatus] = useState("");
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const allResults = useMemo(
    () => [
      ...buildGlobalSearchCommands(),
      ...buildGlobalSearchResults({ conversations, projects, memories, skills, artifacts, providers }),
    ],
    [artifacts, conversations, memories, projects, providers, skills],
  );
  const parsedQuery = useMemo(() => parseGlobalSearchQuery(query, kind, status), [kind, query, status]);
  const results = useMemo(() => {
    const matching = allResults
      .filter((result) => parsedQuery.kind === "all" || result.kind === parsedQuery.kind)
      .filter((result) => parsedQuery.status === "all" || result.statusTone === parsedQuery.status)
      .filter((result) => resultMatches(result, parsedQuery.terms));
    return rankGlobalSearchResults(matching, parsedQuery, sort).slice(0, 48);
  }, [allResults, parsedQuery, sort]);

  const rememberSearch = (rawValue: string) => {
    const value = rawValue.trim();
    if (!value) return;
    const next = [value, ...SESSION_RECENT_SEARCHES.filter((entry) => entry !== value)].slice(0, 6);
    SESSION_RECENT_SEARCHES.splice(0, SESSION_RECENT_SEARCHES.length, ...next);
    setRecentSearches(next);
  };

  const clearSearch = () => {
    setQuery("");
    setKind("all");
    setStatus("all");
    setSort("relevance");
    setActiveSavedViewId("");
    setSavedViewName("");
    setSavedViewStatus("");
    setSelectedResultId(null);
  };

  const applySavedView = (viewId: string) => {
    if (!viewId) {
      setActiveSavedViewId("");
      setSavedViewName("");
      setSavedViewStatus("");
      return;
    }
    const view = savedViews.find((candidate) => candidate.id === viewId);
    if (!view) return;
    setQuery(view.query);
    setKind(view.kind);
    setStatus(view.status);
    setSort(view.sort);
    setActiveSavedViewId(view.id);
    setSavedViewName(view.name);
    setSavedViewStatus(`Applied “${view.name}”.`);
    setSelectedResultId(null);
  };

  const saveCurrentView = () => {
    const name = savedViewName.trim();
    if (!name) {
      setSavedViewStatus("Enter a name before saving this view.");
      return;
    }
    if (name.length > MAX_SAVED_GLOBAL_SEARCH_NAME) {
      setSavedViewStatus(`View names are limited to ${MAX_SAVED_GLOBAL_SEARCH_NAME} characters.`);
      return;
    }
    if (savedViews.length >= MAX_SAVED_GLOBAL_SEARCHES) {
      setSavedViewStatus(`This session already has ${MAX_SAVED_GLOBAL_SEARCHES} saved views. Delete one to make room.`);
      return;
    }
    if (savedViews.some((view) => view.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) {
      setSavedViewStatus("A saved view with that name already exists. Select it and choose Update view instead.");
      return;
    }

    const view: SavedGlobalSearchView = {
      id: createSavedGlobalSearchId(),
      name,
      query,
      kind,
      status,
      sort,
    };
    const next = [...savedViews, view];
    SESSION_SAVED_GLOBAL_SEARCHES.splice(0, SESSION_SAVED_GLOBAL_SEARCHES.length, ...next);
    setSavedViews(next);
    setActiveSavedViewId(view.id);
    setSavedViewName(view.name);
    setSavedViewStatus(`Saved “${view.name}” for this session.`);
  };

  const updateCurrentView = () => {
    const activeViewIndex = savedViews.findIndex((view) => view.id === activeSavedViewId);
    if (activeViewIndex < 0) return;
    const name = savedViewName.trim();
    if (!name) {
      setSavedViewStatus("Enter a name before updating this view.");
      return;
    }
    if (name.length > MAX_SAVED_GLOBAL_SEARCH_NAME) {
      setSavedViewStatus(`View names are limited to ${MAX_SAVED_GLOBAL_SEARCH_NAME} characters.`);
      return;
    }
    if (savedViews.some((view) => view.id !== activeSavedViewId && view.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) {
      setSavedViewStatus("Another saved view already uses that name.");
      return;
    }

    const current = savedViews[activeViewIndex];
    if (!current) return;
    const updated: SavedGlobalSearchView = { id: current.id, name, query, kind, status, sort };
    const next = savedViews.slice();
    next[activeViewIndex] = updated;
    SESSION_SAVED_GLOBAL_SEARCHES.splice(0, SESSION_SAVED_GLOBAL_SEARCHES.length, ...next);
    setSavedViews(next);
    setSavedViewName(name);
    setSavedViewStatus(`Updated “${name}”.`);
  };

  const deleteCurrentView = () => {
    if (!activeSavedViewId) return;
    const next = savedViews.filter((view) => view.id !== activeSavedViewId);
    SESSION_SAVED_GLOBAL_SEARCHES.splice(0, SESSION_SAVED_GLOBAL_SEARCHES.length, ...next);
    setSavedViews(next);
    setActiveSavedViewId("");
    setSavedViewName("");
    setSavedViewStatus("Saved view removed from this session.");
  };

  useEffect(() => {
    setActiveIndex(0);
    resultRefs.current = [];
  }, [kind, query, sort, status]);

  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(Math.max(results.length - 1, 0));
    resultRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results.length]);

  const activate = (result: GlobalObjectSearchResult | undefined) => {
    if (!result) return;
    rememberSearch(query);
    if (result.kind === "command") {
      const commandActions: Record<string, () => void> = {
        "command:new-chat": () => openWorkspaceOverlay({ kind: "start-conversation" }),
        "command:new-project": () => openWorkspaceOverlay({ kind: "create-project" }),
        "command:open-chats": () => onNavigate("chats"),
        "command:open-projects": () => onNavigate("projects"),
        "command:open-library": () => onNavigate("library"),
        "command:open-memory": () => onNavigate("memory"),
        "command:open-skills": () => onNavigate("skills"),
        "command:open-settings": () => onNavigate("settings"),
      };
      commandActions[result.id]?.();
    } else if (result.kind === "chat") onOpenConversation(result.id.slice("chat:".length));
    else if (result.kind === "message") onOpenConversation(result.id.split(":")[1] ?? "");
    else if (result.kind === "project") onOpenProject(result.id.slice("project:".length));
    else if (result.kind === "file") onOpenProject(result.id.split(":")[1] ?? "");
    else if (result.kind === "memory") onNavigate("memory");
    else if (result.kind === "skill") onNavigate("skills");
    else if (result.kind === "artifact") onNavigate("library");
    else onNavigate("settings");
    onClose();
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (results.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (activeIndex + 1) % results.length;
    if (event.key === "ArrowUp") nextIndex = (activeIndex - 1 + results.length) % results.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = results.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      setActiveIndex(nextIndex);
      resultRefs.current[nextIndex]?.focus({ preventScroll: true });
    }
    if (event.key === "Enter") {
      event.preventDefault();
      rememberSearch(query);
      activate(results[activeIndex]);
    }
  };

  const selectedResult = results.find((result) => result.id === selectedResultId) ?? results[activeIndex];
  const hasQueryControls = Boolean(query.trim() || kind !== "all" || status !== "all" || sort !== "relevance");

  return (
    <section id="global-object-search-preview" className="global-object-search" aria-label="Global object search preview">
      <header className="global-object-search__header">
        <div className="global-object-search__title">
          <span className="global-object-search__icon"><Search size={18} aria-hidden="true" /></span>
          <div>
            <span className="eyebrow">Workspace index</span>
            <h2>Search everything visible</h2>
            <p>Find commands, chats, messages, projects, files, memory, skills, artifacts, models, and provider metadata in one place.</p>
          </div>
        </div>
        <button type="button" className="icon-button icon-button--small" onClick={onClose} aria-label="Close global object search" title="Close search">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <label className="global-object-search__input">
        <Search size={16} aria-hidden="true" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search titles, descriptions, tags, or status…"
          aria-label="Search visible workspace objects"
          aria-controls="global-object-search-results"
          aria-activedescendant={results[activeIndex] ? globalSearchResultDomId(results[activeIndex].id) : undefined}
        />
        {query ? <button type="button" className="global-object-search__clear" onClick={clearSearch} aria-label="Clear global search" title="Clear search"><X size={14} aria-hidden="true" /></button> : null}
        <kbd>↑↓</kbd><kbd>↵</kbd><kbd>Esc</kbd>
      </label>
      {query.trim() === "" && recentSearches.length > 0 ? (
        <div className="global-object-search__recent" aria-label="Recent global searches">
          <span className="global-object-search__recent-label"><Clock3 size={14} aria-hidden="true" /> Recent</span>
          {recentSearches.map((recent) => (
            <button key={recent} type="button" className="global-object-search__recent-chip" onClick={() => setQuery(recent)}>
              <span>{recent}</span><X size={12} aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="global-object-search__recent-clear" onClick={() => { SESSION_RECENT_SEARCHES.splice(0); setRecentSearches([]); }}>Clear history</button>
        </div>
      ) : null}
      <div className="global-object-search__filters" role="tablist" aria-label="Global search object type">
        {FILTERS.map((filter, filterIndex) => {
          const active = parsedQuery.kind === filter.id;
          const count = allResults
            .filter((result) => filter.id === "all" || result.kind === filter.id).length;
          return (
            <button
              key={filter.id}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={active ? "global-object-search__filter is-active" : "global-object-search__filter"}
              onClick={() => {
                setKind(filter.id);
                setQuery((current) => stripGlobalSearchOperators(current, "kind"));
                setSelectedResultId(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
                event.preventDefault();
                const nextIndex = event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? FILTERS.length - 1
                    : (filterIndex + (event.key === "ArrowRight" ? 1 : -1) + FILTERS.length) % FILTERS.length;
                const nextFilter = FILTERS[nextIndex];
                if (!nextFilter) return;
                setKind(nextFilter.id);
                setQuery((current) => stripGlobalSearchOperators(current, "kind"));
                setSelectedResultId(null);
                requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-global-search-filter="${nextFilter.id}"]`)?.focus());
              }}
              data-global-search-filter={filter.id}
            >
              {filter.label}<span>{count}</span>
            </button>
          );
        })}
      </div>
      <div className="global-object-search__controls">
        <label>
          <Filter size={14} aria-hidden="true" />
          <span>Status</span>
          <select
            aria-label="Global search status"
            value={parsedQuery.status}
            onChange={(event) => {
              setStatus(event.target.value as GlobalSearchStatus);
              setQuery((current) => stripGlobalSearchOperators(current, "status"));
              setSelectedResultId(null);
            }}
          >
            <option value="all">Any status</option>
            <option value="ready">Ready / active</option>
            <option value="attention">Needs attention</option>
            <option value="preview">Preview / draft</option>
          </select>
        </label>
        <label>
          <ArrowUpDown size={14} aria-hidden="true" />
          <span>Sort</span>
          <select aria-label="Global search sort" value={sort} onChange={(event) => setSort(event.target.value as GlobalSearchSort)}>
            <option value="relevance">Relevance</option>
            <option value="recent">Most recent</option>
            <option value="title">Title</option>
          </select>
        </label>
        {hasQueryControls ? <button type="button" className="global-object-search__reset" onClick={clearSearch}><RotateCcw size={13} aria-hidden="true" /> Reset filters</button> : null}
      </div>
      <section className="global-object-search__saved-views" aria-label="Saved global search views">
        <div className="global-object-search__saved-heading">
          <span><Bookmark size={14} aria-hidden="true" /> Saved views</span>
          <small>Reusable query and filters · session-only</small>
        </div>
        <label className="global-object-search__saved-select">
          <span>Saved view</span>
          <select aria-label="Saved global search view" value={activeSavedViewId} onChange={(event) => applySavedView(event.target.value)}>
            <option value="">Manual current search</option>
            {savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
          </select>
        </label>
        <label className="global-object-search__saved-name">
          <span>View name</span>
          <input
            aria-label="Saved global search view name"
            value={savedViewName}
            maxLength={MAX_SAVED_GLOBAL_SEARCH_NAME}
            placeholder="e.g. Attention in projects"
            onChange={(event) => { setSavedViewName(event.target.value); setSavedViewStatus(""); }}
          />
        </label>
        <div className="global-object-search__saved-actions">
          <button type="button" className="button button--primary" onClick={saveCurrentView} disabled={!savedViewName.trim()}><Save size={13} aria-hidden="true" /> Save as</button>
          <button type="button" className="button button--ghost" onClick={updateCurrentView} disabled={!activeSavedViewId}><RotateCcw size={13} aria-hidden="true" /> Update view</button>
          <button type="button" className="button button--ghost" onClick={deleteCurrentView} disabled={!activeSavedViewId} aria-label="Delete saved global search view" title="Delete selected saved view"><X size={13} aria-hidden="true" /></button>
        </div>
        <p className="global-object-search__saved-status" role="status" aria-live="polite">{savedViewStatus || `${savedViews.length}/${MAX_SAVED_GLOBAL_SEARCHES} saved in this renderer session. No durable write.`}</p>
      </section>
      <div className="global-object-search__summary" role="status" aria-live="polite">
        <span>{results.length} visible result{results.length === 1 ? "" : "s"}{parsedQuery.kind !== "all" ? ` · ${KIND_LABEL[parsedQuery.kind]}` : ""}{parsedQuery.status !== "all" ? ` · ${parsedQuery.status}` : ""}</span>
        <span>{parsedQuery.term ? `Query: ${parsedQuery.term} · ` : ""}Renderer-local index · no retrieval or provider request</span>
      </div>
      <div id="global-object-search-results" className="global-object-search__results" role="listbox" aria-label="Global object search results">
        {results.length > 0 ? results.map((result, index) => {
          const resultId = globalSearchResultDomId(result.id);
          return (
            <button
              key={result.id}
              id={resultId}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "global-object-search__result is-active" : "global-object-search__result"}
              ref={(element) => { resultRefs.current[index] = element; }}
              onMouseEnter={() => { setActiveIndex(index); setSelectedResultId(result.id); }}
              onFocus={() => { setActiveIndex(index); setSelectedResultId(result.id); }}
              onClick={() => activate(result)}
            >
              <span className={`global-object-search__result-icon global-object-search__result-icon--${result.kind}`}>{kindIcon(result.kind)}</span>
              <span className="global-object-search__result-copy">
                <strong>{result.title}</strong>
                <small>{KIND_LABEL[result.kind]} · {result.subtitle}</small>
                {result.breadcrumb && result.breadcrumb.length > 0 ? <em className="global-object-search__breadcrumb" aria-label={`Location: ${result.breadcrumb.join(" / ")}`}>{result.breadcrumb.join(" / ")}</em> : null}
                <em>{result.detail}</em>
              </span>
              <span className={`global-object-search__status global-object-search__status--${result.statusTone}`}>{result.statusLabel}</span>
            </button>
          );
        }) : (
          <div className="global-object-search__empty"><Archive size={20} aria-hidden="true" /><strong>No visible objects match</strong><span>Try another term or reset the object-type filter.</span></div>
        )}
      </div>
      {selectedResult ? (
        <aside className="global-object-search__selection" aria-label="Selected search result preview">
          <div className="global-object-search__selection-heading"><span><strong>{selectedResult.title}</strong><small>{KIND_LABEL[selectedResult.kind]} · {selectedResult.subtitle}</small></span><span className={`global-object-search__status global-object-search__status--${selectedResult.statusTone}`}>{selectedResult.statusLabel}</span></div>
          {selectedResult.breadcrumb && selectedResult.breadcrumb.length > 0 ? <p className="global-object-search__selection-breadcrumb">Location: {selectedResult.breadcrumb.join(" / ")}</p> : null}
          <p>{selectedResult.detail}</p>
          <span className="global-object-search__selection-boundary">Selecting this result opens its current renderer preview; no durable object or provider request is created.</span>
        </aside>
      ) : null}
      <p className="global-object-search__boundary"><strong>Preview only</strong> · Renderer-local · No durable write · no filesystem read · no retrieval index · no provider dispatch.</p>
    </section>
  );
}
