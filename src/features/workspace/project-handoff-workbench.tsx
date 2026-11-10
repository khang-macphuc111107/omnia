import {
  CheckCircle2,
  CircleAlert,
  Clipboard,
  ClipboardCheck,
  Download,
  FileCheck2,
  LockKeyhole,
  MessageSquareText,
  PackageCheck,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { buildProjectContextAvailabilityForProject } from "./project-context-availability-contract";
import type { ProjectHandoffSeed } from "./project-handoff-seed";
import type { ConversationView, ProjectView } from "./types";

type HandoffAudience = "self" | "agent" | "reviewer" | "teammate";
type HandoffStage = "draft" | "ready";
type HandoffExportFormat = "json" | "markdown";
type HandoffChatFilter = "all" | "active" | "archived" | "unread";

type HandoffChecklist = {
  scope: boolean;
  nextStep: boolean;
  evidence: boolean;
  boundary: boolean;
};

const AUDIENCES: ReadonlyArray<{ id: HandoffAudience; label: string; detail: string }> = [
  { id: "self", label: "My next session", detail: "Resume this project with the same scope and next step." },
  { id: "agent", label: "Another agent", detail: "Give a bounded implementation brief without granting execution authority." },
  { id: "reviewer", label: "Reviewer / tester", detail: "Highlight what is ready to inspect and what remains provisional." },
  { id: "teammate", label: "Teammate", detail: "Share a portable project brief with visible assumptions." },
];

const CHECKLIST: ReadonlyArray<{ id: keyof HandoffChecklist; label: string; detail: string }> = [
  { id: "scope", label: "Scope is explicit", detail: "Project name, chats, and workspace grants are visible." },
  { id: "nextStep", label: "Next step is named", detail: "The recipient can tell what to do after opening this handoff." },
  { id: "evidence", label: "Evidence is labeled", detail: "Preview facts are separated from native verification." },
  { id: "boundary", label: "Boundaries are retained", detail: "No provider dispatch, native write, or filesystem access is implied." },
];

function statusLabel(project: ProjectView): string {
  if (project.overview?.status === "current") return "Current projection";
  if (project.overview?.status === "candidate") return "Candidate projection";
  if (project.overview?.status === "stale") return "Stale projection";
  if (project.overview?.status === "failed") return "Failed projection";
  return buildProjectContextAvailabilityForProject(project).label;
}

function statusTone(project: ProjectView): "ready" | "attention" | "unknown" {
  const contextAvailability = buildProjectContextAvailabilityForProject(project);
  if (project.overview?.status === "failed" || contextAvailability.surfaceStatus === "unavailable") return "attention";
  if (project.overview?.status === "current" || contextAvailability.surfaceStatus === "verified") return "ready";
  return "unknown";
}

function defaultChecklist(project: ProjectView, conversations: readonly ConversationView[], planSeed: ProjectHandoffSeed | null): HandoffChecklist {
  return {
    scope: Boolean(project.name.trim() && (project.folders.length > 0 || conversations.length > 0)),
    nextStep: Boolean(planSeed),
    evidence: Boolean(project.overview?.verifiedEvidence?.length),
    boundary: true,
  };
}

function defaultHandoffNote(planSeed: ProjectHandoffSeed | null): string {
  return planSeed?.brief
    ?? "Resume from the current project scope, then review the next dependency-complete step.";
}

function visibleChatRecords(conversations: readonly ConversationView[], includeExcerpts: boolean) {
  return conversations.map((chat) => ({
    id: chat.id,
    title: chat.title || "Untitled Chat",
    excerpt: includeExcerpts ? chat.excerpt : "",
    updatedAt: chat.updatedAt,
    archived: chat.archived,
    pinned: chat.pinned,
    unread: chat.unread,
    hasDraft: chat.hasDraft,
    runState: chat.runState,
  }));
}

function visibleSignalSummary(project: ProjectView, conversations: readonly ConversationView[]) {
  const overview = project.overview;
  const chatSignals = conversations
    .filter((chat) => !chat.archived && (chat.unread || Boolean(chat.runState) || chat.hasDraft))
    .map((chat) => ({
      chatId: chat.id,
      title: chat.title || "Untitled Chat",
      unread: chat.unread,
      runState: chat.runState,
      hasDraft: chat.hasDraft,
    }));

  return {
    source: "renderer-visible project and chat projections",
    projectOverview: overview ? {
      status: overview.status,
      summary: overview.summary,
      goal: overview.goal,
      phase: overview.phase,
      milestone: overview.milestone,
      nextTask: overview.nextTask,
      attentionItems: overview.attentionItems,
      verifiedEvidence: overview.verifiedEvidence,
      recentChanges: overview.recentChanges,
      staleNodeCount: overview.staleNodeCount,
    } : null,
    attentionChats: chatSignals,
    caveat: overview
      ? "Overview fields retain their source status; chat signals are session-visible flags, not a durable journal."
      : "No Project Overview revision is hydrated; only session-visible chat flags are included.",
  };
}

type HandoffChatRecord = ReturnType<typeof visibleChatRecords>[number];
type HandoffFolderGrantRecord = {
  id: string;
  displayName: string;
  state: string;
  scope: string;
  fileCount: number;
  chunkCount: number;
  localOnly: boolean;
};

type HandoffPayload = {
  readonly schema: string;
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
    readonly status: string;
    readonly contextHealth: string;
    readonly folderGrants: readonly HandoffFolderGrantRecord[];
    readonly chatCount: number;
  };
  readonly handoff: {
    readonly audience: HandoffAudience;
    readonly note: string;
    readonly checklist: HandoffChecklist;
    readonly included: {
      readonly chats: boolean;
      readonly chatExcerpts: boolean;
      readonly folderGrants: boolean;
      readonly plan: boolean;
      readonly signals: boolean;
    };
    readonly includedRecordIds: {
      readonly chats: readonly string[];
      readonly folderGrants: readonly string[];
    };
    readonly chats: readonly HandoffChatRecord[];
    readonly planSeed: ProjectHandoffSeed | null;
    readonly signals: ReturnType<typeof visibleSignalSummary> | null;
  };
};

type HandoffDiffKind = "added" | "removed" | "changed";
type HandoffDiffItem = {
  readonly kind: HandoffDiffKind;
  readonly label: string;
  readonly detail: string;
};
type HandoffDiff = {
  readonly added: readonly HandoffDiffItem[];
  readonly removed: readonly HandoffDiffItem[];
  readonly changed: readonly HandoffDiffItem[];
  readonly items: readonly HandoffDiffItem[];
  readonly total: number;
};

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function parseHandoffPayload(serialized: string): HandoffPayload {
  return JSON.parse(serialized) as HandoffPayload;
}

function buildHandoffDiff(current: HandoffPayload, baseline: HandoffPayload | null): HandoffDiff {
  if (!baseline) return { added: [], removed: [], changed: [], items: [], total: 0 };

  const added: HandoffDiffItem[] = [];
  const removed: HandoffDiffItem[] = [];
  const changed: HandoffDiffItem[] = [];

  const compareRecords = <T extends { readonly id: string }>(
    label: string,
    currentRecords: readonly T[],
    baselineRecords: readonly T[],
    describe: (record: T) => string,
  ) => {
    const currentById = new Map(currentRecords.map((record) => [record.id, record]));
    const baselineById = new Map(baselineRecords.map((record) => [record.id, record]));
    currentRecords.forEach((record) => {
      const previous = baselineById.get(record.id);
      if (!previous) {
        added.push({ kind: "added", label: `${label} · ${describe(record)}`, detail: `${record.id} is now included.` });
      } else if (stableSerialize(record) !== stableSerialize(previous)) {
        changed.push({ kind: "changed", label: `${label} · ${describe(record)}`, detail: `${record.id} metadata changed.` });
      }
    });
    baselineRecords.forEach((record) => {
      if (!currentById.has(record.id)) {
        removed.push({ kind: "removed", label: `${label} · ${describe(record)}`, detail: `${record.id} is no longer included.` });
      }
    });
  };

  compareRecords("Chat", current.handoff.chats, baseline.handoff.chats, (record) => record.title || "Untitled Chat");
  compareRecords("Workspace grant", current.project.folderGrants, baseline.project.folderGrants, (record) => record.displayName);

  const compareField = (label: string, currentValue: unknown, baselineValue: unknown, detail: string) => {
    if (stableSerialize(currentValue) !== stableSerialize(baselineValue)) changed.push({ kind: "changed", label, detail });
  };

  compareField("Audience", current.handoff.audience, baseline.handoff.audience, "Recipient wording changed.");
  compareField("Handoff note", current.handoff.note, baseline.handoff.note, "The next-step note changed.");
  compareField("Readiness checklist", current.handoff.checklist, baseline.handoff.checklist, "One or more review checks changed.");
  compareField("Included surfaces", current.handoff.included, baseline.handoff.included, "Chat, grant, plan, or signal inclusion changed.");
  compareField("Plan seed", current.handoff.planSeed, baseline.handoff.planSeed, "The selected plan-to-handoff context changed.");
  compareField("Project context", {
    status: current.project.status,
    contextHealth: current.project.contextHealth,
  }, {
    status: baseline.project.status,
    contextHealth: baseline.project.contextHealth,
  }, "Project status or context health changed.");

  const items = [...added, ...removed, ...changed];
  return { added, removed, changed, items, total: items.length };
}

function buildPayload(
  project: ProjectView,
  conversations: readonly ConversationView[],
  audience: HandoffAudience,
  note: string,
  checklist: HandoffChecklist,
  selectedChatIds: readonly string[],
  selectedFolderGrantIds: readonly string[],
  includePlan: boolean,
  includeSignals: boolean,
  includeChatExcerpts: boolean,
  format: HandoffExportFormat,
  planSeed: ProjectHandoffSeed | null,
): string {
  const selectedChats = conversations.filter((chat) => selectedChatIds.includes(chat.id));
  const chatRecords = visibleChatRecords(selectedChats, includeChatExcerpts);
  const folderGrants = project.folders.filter((folder) => selectedFolderGrantIds.includes(folder.id)).map((folder) => ({
    id: folder.id,
    displayName: folder.displayName,
    state: folder.state,
    scope: folder.scope,
    fileCount: folder.fileCount,
    chunkCount: folder.chunkCount,
    localOnly: folder.localOnly,
  }));
  const signals = includeSignals ? visibleSignalSummary(project, selectedChats) : null;
  const payload = {
    schema: "omnia.project-handoff.preview.v3",
    scope: "renderer-session",
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      instructions: project.instructions,
      status: statusLabel(project),
      contextHealth: project.contextHealth,
      folderGrants,
      chatCount: conversations.length,
    },
    handoff: {
      audience,
      note: note.trim() || "Continue from the visible project scope and inspect the next step before acting.",
      checklist,
      included: {
        chats: chatRecords.length > 0,
        chatExcerpts: includeChatExcerpts && chatRecords.length > 0,
        folderGrants: folderGrants.length > 0,
        plan: includePlan,
        signals: includeSignals,
      },
      includedRecordCounts: {
        chats: chatRecords.length,
        folderGrants: folderGrants.length,
        signalAttentionChats: signals?.attentionChats.length ?? 0,
      },
      includedRecordIds: {
        chats: chatRecords.map((chat) => chat.id),
        folderGrants: folderGrants.map((folder) => folder.id),
      },
      chats: chatRecords,
      planSeed: includePlan ? planSeed : null,
      signals,
      activeChatCount: selectedChats.filter((chat) => !chat.archived).length,
    },
    boundary: "Renderer-local handoff preview only; no durable project revision, provider request, agent dispatch, or filesystem write was performed.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    `# ${project.name} project handoff`,
    "",
    `- Audience: ${AUDIENCES.find((item) => item.id === audience)?.label ?? audience}`,
    `- Status: ${statusLabel(project)}`,
    `- Chats: ${conversations.length} visible (${conversations.filter((chat) => !chat.archived).length} active; ${chatRecords.length} included)`,
    `- Folder grants: ${folderGrants.length}/${project.folders.length} included`,
    `- Project instructions: ${project.instructions.trim() ? "included" : "empty"}`,
    "",
    "## Note",
    note.trim() || "Continue from the visible project scope and inspect the next step before acting.",
    "",
    "## Included surfaces",
    `- Chats: ${chatRecords.length} selected`,
    `- Chat excerpts: ${includeChatExcerpts ? "included" : "omitted; metadata only"}`,
    `- Workspace grants: ${folderGrants.length} selected`,
    `- Plan: ${includePlan ? "yes" : "no"}`,
    `- Signals: ${includeSignals ? "yes" : "no"}`,
    `- Selected plan task: ${includePlan && planSeed ? planSeed.taskTitle : "none"}`,
    "",
    ...(conversations.length > 0 ? [
      "## Included chat records",
      ...(chatRecords.length > 0
        ? chatRecords.map((chat) => `- ${chat.title} (${chat.id}; ${chat.archived ? "archived" : "active"}; updated ${chat.updatedAt || "unknown"})${chat.excerpt ? ` — ${chat.excerpt}` : ""}`)
        : ["- None"]),
      "",
    ] : []),
    ...(project.folders.length > 0 ? [
      "## Workspace grants",
      ...(folderGrants.length > 0
        ? folderGrants.map((folder) => `- ${folder.displayName} (${folder.scope}; ${folder.state}${folder.localOnly ? "; local only" : ""})`)
        : ["- None selected"]),
      "",
    ] : []),
    ...(includeSignals ? [
      "## Signal summary",
      ...(signals?.projectOverview
        ? [`- Project Overview: ${signals.projectOverview.status}${signals.projectOverview.summary ? ` — ${signals.projectOverview.summary}` : ""}`]
        : ["- Project Overview: not hydrated"]),
      ...(signals?.projectOverview?.attentionItems.map((item) => `- Attention: ${item}`) ?? []),
      ...(signals?.attentionChats.length
        ? signals.attentionChats.map((chat) => `- Chat signal: ${chat.title} (${chat.runState ?? (chat.unread ? "unread" : "draft")})`)
        : ["- No attention chat flags in the current projection"]),
      "",
    ] : []),
    "## Record detail",
    "Chat records contain visible metadata and excerpts only; this package does not include full message transcripts or workspace file contents.",
    "",
    "## Checklist",
    ...CHECKLIST.map((item) => `- [${checklist[item.id] ? "x" : " "}] ${item.label}`),
    "",
    "> Renderer-local preview only. No durable write, provider request, agent dispatch, or filesystem access.",
  ].join("\n");
}

function downloadPayload(payload: string, format: HandoffExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-project-handoff-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

/**
 * Renderer-local project handoff rehearsal.
 *
 * This is intentionally a workbench rather than a dispatcher: it makes the
 * audience, status, checklist, and portable package visible without creating
 * a native agent lease, provider request, durable revision, or filesystem write.
 */
export function ProjectHandoffWorkbench({
  project,
  conversations,
  planSeed = null,
}: {
  readonly project: ProjectView;
  readonly conversations: readonly ConversationView[];
  readonly planSeed?: ProjectHandoffSeed | null;
}) {
  const projectConversations = useMemo(
    () => conversations.filter((conversation) => conversation.projectId === project.id),
    [conversations, project.id],
  );
  const [audience, setAudience] = useState<HandoffAudience>("self");
  const [note, setNote] = useState(() => defaultHandoffNote(planSeed));
  const [checklist, setChecklist] = useState<HandoffChecklist>(() => defaultChecklist(project, projectConversations, planSeed));
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>(() => projectConversations.map((chat) => chat.id));
  const [selectedFolderGrantIds, setSelectedFolderGrantIds] = useState<string[]>(() => project.folders.map((folder) => folder.id));
  const [chatQuery, setChatQuery] = useState("");
  const [chatFilter, setChatFilter] = useState<HandoffChatFilter>("all");
  const [grantQuery, setGrantQuery] = useState("");
  const [includePlan, setIncludePlan] = useState(true);
  const [includeSignals, setIncludeSignals] = useState(true);
  const [includeChatExcerpts, setIncludeChatExcerpts] = useState(true);
  const [stage, setStage] = useState<HandoffStage>("draft");
  const [format, setFormat] = useState<HandoffExportFormat>("json");
  const [preparedSnapshot, setPreparedSnapshot] = useState<HandoffPayload | null>(null);
  const [status, setStatus] = useState("Renderer-local handoff draft ready.");
  const chatsSelectAllRef = useRef<HTMLInputElement>(null);
  const grantsSelectAllRef = useRef<HTMLInputElement>(null);

  const selectedChatRecords = useMemo(
    () => projectConversations.filter((chat) => selectedChatIds.includes(chat.id)),
    [projectConversations, selectedChatIds],
  );
  const selectedFolderGrantRecords = useMemo(
    () => project.folders.filter((folder) => selectedFolderGrantIds.includes(folder.id)),
    [project.folders, selectedFolderGrantIds],
  );
  const normalizedChatQuery = chatQuery.trim().toLocaleLowerCase();
  const visibleProjectConversations = useMemo(
    () => projectConversations.filter((chat) => {
      const matchesFilter = chatFilter === "active"
        ? !chat.archived
        : chatFilter === "archived"
          ? chat.archived
          : chatFilter === "unread"
            ? chat.unread
            : true;
      if (!matchesFilter) return false;
      if (!normalizedChatQuery) return true;
      return [chat.title, chat.excerpt, chat.runState, chat.updatedAt]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedChatQuery);
    }),
    [chatFilter, normalizedChatQuery, projectConversations],
  );
  const normalizedGrantQuery = grantQuery.trim().toLocaleLowerCase();
  const visibleFolderGrants = useMemo(
    () => project.folders.filter((folder) => !normalizedGrantQuery || [folder.displayName, folder.scope, folder.state]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedGrantQuery)),
    [normalizedGrantQuery, project.folders],
  );
  const visibleChatIds = useMemo(() => new Set(visibleProjectConversations.map((chat) => chat.id)), [visibleProjectConversations]);
  const visibleGrantIds = useMemo(() => new Set(visibleFolderGrants.map((folder) => folder.id)), [visibleFolderGrants]);
  const selectedVisibleChatCount = selectedChatRecords.filter((chat) => visibleChatIds.has(chat.id)).length;
  const selectedVisibleGrantCount = selectedFolderGrantRecords.filter((folder) => visibleGrantIds.has(folder.id)).length;
  const allChatsSelected = projectConversations.length > 0 && selectedChatRecords.length === projectConversations.length;
  const allFolderGrantsSelected = project.folders.length > 0 && selectedFolderGrantRecords.length === project.folders.length;

  useEffect(() => {
    if (chatsSelectAllRef.current) chatsSelectAllRef.current.indeterminate = selectedChatRecords.length > 0 && !allChatsSelected;
    if (grantsSelectAllRef.current) grantsSelectAllRef.current.indeterminate = selectedFolderGrantRecords.length > 0 && !allFolderGrantsSelected;
  }, [allChatsSelected, allFolderGrantsSelected, selectedChatRecords.length, selectedFolderGrantRecords.length]);

  const readyCount = Object.values(checklist).filter(Boolean).length;
  const payload = useMemo(
    () => buildPayload(project, projectConversations, audience, note, checklist, selectedChatIds, selectedFolderGrantIds, includePlan, includeSignals, includeChatExcerpts, format, planSeed),
    [audience, checklist, format, includeChatExcerpts, includePlan, includeSignals, note, planSeed, project, projectConversations, selectedChatIds, selectedFolderGrantIds],
  );
  const jsonPayload = useMemo(
    () => buildPayload(project, projectConversations, audience, note, checklist, selectedChatIds, selectedFolderGrantIds, includePlan, includeSignals, includeChatExcerpts, "json", planSeed),
    [audience, checklist, includeChatExcerpts, includePlan, includeSignals, note, planSeed, project, projectConversations, selectedChatIds, selectedFolderGrantIds],
  );
  const currentSnapshot = useMemo(() => parseHandoffPayload(jsonPayload), [jsonPayload]);
  const handoffDiff = useMemo(() => buildHandoffDiff(currentSnapshot, preparedSnapshot), [currentSnapshot, preparedSnapshot]);
  const projectTone = statusTone(project);
  const selectedAudience = AUDIENCES.find((item) => item.id === audience) ?? AUDIENCES[0]!;

  useEffect(() => {
    setNote(defaultHandoffNote(planSeed));
    setChecklist(defaultChecklist(project, projectConversations, planSeed));
    setPreparedSnapshot(null);
    setStage("draft");
    setStatus(planSeed
      ? `Plan task “${planSeed.taskTitle}” is staged as a renderer-local handoff brief.`
      : "Renderer-local handoff draft ready.");
  }, [planSeed, project.id, projectConversations]);

  useEffect(() => {
    setSelectedChatIds(projectConversations.map((chat) => chat.id));
    setSelectedFolderGrantIds(project.folders.map((folder) => folder.id));
  }, [project.id]);

  useEffect(() => {
    if (preparedSnapshot && stage === "ready" && handoffDiff.total > 0) {
      setStage("draft");
      setStatus("Handoff draft changed since the last prepared baseline; review the semantic diff before continuing.");
    }
  }, [handoffDiff.total, preparedSnapshot, stage]);

  const toggleChecklist = (id: keyof HandoffChecklist) => {
    setChecklist((current) => ({ ...current, [id]: !current[id] }));
    setStage("draft");
    setStatus("Checklist changed. Prepare the handoff again to review the updated package.");
  };

  const setVisibleChatSelection = (selected: boolean) => {
    setSelectedChatIds((current) => {
      if (selected) return Array.from(new Set([...current, ...visibleProjectConversations.map((chat) => chat.id)]));
      return current.filter((id) => !visibleChatIds.has(id));
    });
    setStage("draft");
  };

  const setVisibleGrantSelection = (selected: boolean) => {
    setSelectedFolderGrantIds((current) => {
      if (selected) return Array.from(new Set([...current, ...visibleFolderGrants.map((folder) => folder.id)]));
      return current.filter((id) => !visibleGrantIds.has(id));
    });
    setStage("draft");
  };

  const reset = () => {
    setAudience("self");
    setNote(defaultHandoffNote(planSeed));
    setChecklist(defaultChecklist(project, projectConversations, planSeed));
    setSelectedChatIds(projectConversations.map((chat) => chat.id));
    setSelectedFolderGrantIds(project.folders.map((folder) => folder.id));
    setIncludePlan(true);
    setIncludeSignals(true);
    setIncludeChatExcerpts(true);
    setStage("draft");
    setFormat("json");
    setPreparedSnapshot(null);
    setStatus(planSeed ? "Handoff rehearsal reset around the selected plan task." : "Handoff rehearsal reset to renderer defaults.");
  };

  const prepare = () => {
    setPreparedSnapshot(currentSnapshot);
    setStage("ready");
    setStatus(readyCount === CHECKLIST.length
      ? "Handoff package is ready for review; semantic diff baseline captured in this renderer preview."
      : `Handoff draft prepared with ${readyCount}/${CHECKLIST.length} checklist items; semantic diff baseline captured; native approval is still unavailable.`);
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no handoff package was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied the renderer-local ${format.toUpperCase()} handoff package.`);
    } catch {
      setStatus("Clipboard access was denied; no handoff package was copied.");
    }
  };

  const download = () => {
    setStatus(downloadPayload(payload, format) ? "Downloaded the renderer-local handoff package; no native state changed." : "File download is unavailable in this surface; no handoff package was exported.");
  };

  return (
    <section className="project-handoff-workbench" aria-labelledby={`project-handoff-title-${project.id}`}>
      <header className="project-handoff-workbench__header">
        <div>
          <span className="eyebrow"><Sparkles size={13} /> Project handoff workbench</span>
          <h3 id={`project-handoff-title-${project.id}`}>Package the next move without losing context</h3>
          <p>Choose a recipient, retain the project boundary, and prepare a portable brief for review before any native handoff exists.</p>
        </div>
        <span className={`project-handoff-workbench__badge project-handoff-workbench__badge--${projectTone}`}><ShieldCheck size={13} /> Preview only</span>
      </header>

      <div className="project-handoff-workbench__status-grid" aria-label="Project handoff status">
        <article className={`project-handoff-workbench__status-card project-handoff-workbench__status-card--${projectTone}`}>
          <span><CheckCircle2 size={15} /></span><div><small>Project status</small><strong>{statusLabel(project)}</strong></div>
        </article>
        <article className="project-handoff-workbench__status-card"><span><MessageSquareText size={15} /></span><div><small>Project chats</small><strong>{projectConversations.length}</strong></div></article>
        <article className="project-handoff-workbench__status-card"><span><Users size={15} /></span><div><small>Audience</small><strong>{selectedAudience.label}</strong></div></article>
        <article className="project-handoff-workbench__status-card"><span><ClipboardCheck size={15} /></span><div><small>Readiness</small><strong>{readyCount}/{CHECKLIST.length} checks</strong></div></article>
      </div>

      {planSeed ? (
        <section className="project-handoff-workbench__plan-seed" aria-label="Selected project plan handoff seed">
          <header>
            <div><span className="eyebrow">Plan → handoff seed</span><strong>{planSeed.taskTitle}</strong></div>
            <span className="project-handoff-workbench__package-chip"><Sparkles size={12} /> Renderer-local</span>
          </header>
          <p>{planSeed.brief}</p>
          <div className="project-handoff-workbench__plan-seed-grid">
            <span><small>Owner</small><strong>{planSeed.owner}</strong></span>
            <span><small>Phase</small><strong>{planSeed.phaseTitle}</strong></span>
            <span><small>Acceptance</small><strong>{planSeed.acceptance}</strong></span>
            <span><small>Dependencies</small><strong>{planSeed.dependencies.length || "None"}</strong></span>
          </div>
          <p className="project-handoff-workbench__boundary"><LockKeyhole size={13} /> {planSeed.boundary}</p>
        </section>
      ) : null}

      <div className="project-handoff-workbench__grid">
        <article className="project-handoff-workbench__panel">
          <header><div><strong>1. Choose the recipient</strong><small>The audience changes wording only; it never grants execution authority.</small></div><Users size={15} /></header>
          <div className="project-handoff-workbench__audiences" role="radiogroup" aria-label="Handoff audience">
            {AUDIENCES.map((item) => (
              <label key={item.id} className={audience === item.id ? "is-selected" : ""}>
                <input type="radio" name={`handoff-audience-${project.id}`} value={item.id} checked={audience === item.id} onChange={() => { setAudience(item.id); setStage("draft"); setStatus(`${item.label} selected for this renderer-local handoff.`); }} />
                <span><strong>{item.label}</strong><small>{item.detail}</small></span>
              </label>
            ))}
          </div>
          <label className="project-handoff-workbench__note"><span>Handoff note</span><textarea value={note} onChange={(event) => { setNote(event.target.value); setStage("draft"); }} rows={4} aria-label="Handoff note" placeholder="What should the recipient do next?" /></label>
        </article>

        <article className="project-handoff-workbench__panel">
          <header><div><strong>2. Keep the package honest</strong><small>Mark what is ready to be inspected in this session.</small></div><FileCheck2 size={15} /></header>
          <fieldset className="project-handoff-workbench__checklist">
            <legend>Readiness checklist</legend>
            {CHECKLIST.map((item) => (
              <label key={item.id}>
                <input type="checkbox" checked={checklist[item.id]} onChange={() => toggleChecklist(item.id)} />
                <span><strong>{item.label}</strong><small>{item.detail}</small></span>
              </label>
            ))}
          </fieldset>
          <fieldset className="project-handoff-workbench__includes">
            <legend>Include in the package</legend>
            <div className="project-handoff-workbench__record-tools">
              <label className="project-handoff-workbench__record-search"><Search size={13} /><input type="search" value={chatQuery} onChange={(event) => setChatQuery(event.target.value)} placeholder="Search chats" aria-label="Search project chats" /></label>
              <label className="project-handoff-workbench__record-filter"><span>View</span><select value={chatFilter} onChange={(event) => setChatFilter(event.target.value as HandoffChatFilter)} aria-label="Filter project chats"><option value="all">All chats</option><option value="active">Active</option><option value="unread">Unread</option><option value="archived">Archived</option></select></label>
              <div className="project-handoff-workbench__record-actions" role="group" aria-label="Chat selection actions"><button type="button" className="button button--ghost" onClick={() => setVisibleChatSelection(true)} disabled={visibleProjectConversations.length === 0}>Select visible</button><button type="button" className="button button--ghost" onClick={() => setVisibleChatSelection(false)} disabled={selectedVisibleChatCount === 0}>Clear visible</button></div>
            </div>
            <label><input ref={chatsSelectAllRef} type="checkbox" checked={allChatsSelected} disabled={projectConversations.length === 0} onChange={() => setSelectedChatIds(allChatsSelected ? [] : projectConversations.map((chat) => chat.id))} /><span>Chats and recent activity<small>{selectedChatRecords.length}/${projectConversations.length} selected; metadata and excerpts only</small></span></label>
            {visibleProjectConversations.length > 0 ? (
              <div className="project-handoff-workbench__record-picker" role="group" aria-label="Choose project chats">
                {visibleProjectConversations.map((chat) => (
                  <label key={chat.id} className={selectedChatIds.includes(chat.id) ? "is-selected" : ""}>
                    <input type="checkbox" checked={selectedChatIds.includes(chat.id)} onChange={(event) => setSelectedChatIds((current) => event.target.checked ? [...current, chat.id] : current.filter((id) => id !== chat.id))} />
                    <span><strong>{chat.title || "Untitled Chat"}</strong><small>{chat.archived ? "Archived" : chat.runState ? `Run ${chat.runState}` : chat.unread ? "Unread" : "Project chat"} · {chat.updatedAt || "updated time unknown"}{chat.excerpt ? ` · ${chat.excerpt}` : ""}</small></span>
                  </label>
                ))}
              </div>
            ) : <p className="project-handoff-workbench__empty-records">{projectConversations.length > 0 ? "No chats match the current search or filter." : "No project chats are available to include."}</p>}
            <label><input ref={grantsSelectAllRef} type="checkbox" checked={allFolderGrantsSelected} disabled={project.folders.length === 0} onChange={() => setSelectedFolderGrantIds(allFolderGrantsSelected ? [] : project.folders.map((folder) => folder.id))} /><span>Workspace grants<small>{selectedFolderGrantRecords.length}/{project.folders.length} selected; record metadata only, no file contents</small></span></label>
            <div className="project-handoff-workbench__record-tools">
              <label className="project-handoff-workbench__record-search"><Search size={13} /><input type="search" value={grantQuery} onChange={(event) => setGrantQuery(event.target.value)} placeholder="Search workspace grants" aria-label="Search workspace grants" /></label>
              <div className="project-handoff-workbench__record-actions" role="group" aria-label="Workspace grant selection actions"><button type="button" className="button button--ghost" onClick={() => setVisibleGrantSelection(true)} disabled={visibleFolderGrants.length === 0}>Select visible</button><button type="button" className="button button--ghost" onClick={() => setVisibleGrantSelection(false)} disabled={selectedVisibleGrantCount === 0}>Clear visible</button></div>
            </div>
            {visibleFolderGrants.length > 0 ? (
              <div className="project-handoff-workbench__record-picker" role="group" aria-label="Choose workspace grants">
                {visibleFolderGrants.map((folder) => (
                  <label key={folder.id} className={selectedFolderGrantIds.includes(folder.id) ? "is-selected" : ""}>
                    <input type="checkbox" checked={selectedFolderGrantIds.includes(folder.id)} onChange={(event) => setSelectedFolderGrantIds((current) => event.target.checked ? [...current, folder.id] : current.filter((id) => id !== folder.id))} />
                    <span><strong>{folder.displayName}</strong><small>{folder.scope} · {folder.state}{folder.localOnly ? " · local only" : ""}</small></span>
                  </label>
                ))}
              </div>
            ) : <p className="project-handoff-workbench__empty-records">{project.folders.length > 0 ? "No workspace grants match the current search." : "No workspace grants are available to include."}</p>}
            <label><input type="checkbox" checked={includePlan} onChange={(event) => setIncludePlan(event.target.checked)} /> Plan and next-step direction</label>
            <label><input type="checkbox" checked={includeSignals} onChange={(event) => setIncludeSignals(event.target.checked)} /><span>Unified signal summary<small>{includeSignals ? "Project overview and visible attention flags" : "No signal summary included"}</small></span></label>
            <label><input type="checkbox" checked={includeChatExcerpts} onChange={(event) => setIncludeChatExcerpts(event.target.checked)} /><span>Chat excerpts<small>{includeChatExcerpts ? "Include visible excerpts with selected chat metadata" : "Metadata only; excerpt text is omitted from this package"}</small></span></label>
          </fieldset>
        </article>
      </div>

      <div className="project-handoff-workbench__toolbar" role="toolbar" aria-label="Project handoff actions">
        <button type="button" className="button button--secondary" onClick={prepare}><PackageCheck size={14} /> Prepare handoff</button>
        <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={14} /> Reset</button>
        <span className={`project-handoff-workbench__stage project-handoff-workbench__stage--${stage}`}><Send size={13} /> {stage === "ready" ? "Ready for review" : "Draft"}</span>
        <span className="project-handoff-workbench__status" role="status" aria-live="polite">{status}</span>
      </div>

      <section className="project-handoff-workbench__package" aria-label="Project handoff package preview">
        <header><div><span className="eyebrow">Portable package preview</span><h4>{project.name} · {selectedAudience.label}</h4></div><span className="project-handoff-workbench__package-chip"><LockKeyhole size={12} /> No durable write</span></header>
        <div className="project-handoff-workbench__package-toolbar">
          <label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as HandoffExportFormat)} aria-label="Project handoff export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
          <span className="project-handoff-workbench__package-actions"><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--ghost" onClick={download}><Download size={13} /> Download</button></span>
        </div>
        <section className="project-handoff-workbench__diff" aria-label="Handoff semantic diff preview">
          <header>
            <div><span className="eyebrow">Semantic diff preview</span><strong>{preparedSnapshot ? "Changes since the last prepared snapshot" : "No prepared baseline yet"}</strong></div>
            <span className="project-handoff-workbench__package-chip">{preparedSnapshot ? "Session baseline" : "Prepare to compare"}</span>
          </header>
          {preparedSnapshot ? (
            handoffDiff.total > 0 ? (
              <>
                <div className="project-handoff-workbench__diff-summary" aria-label="Handoff diff summary">
                  <span className="project-handoff-workbench__diff-count project-handoff-workbench__diff-count--added"><strong>{handoffDiff.added.length}</strong><small>Added</small></span>
                  <span className="project-handoff-workbench__diff-count project-handoff-workbench__diff-count--removed"><strong>{handoffDiff.removed.length}</strong><small>Removed</small></span>
                  <span className="project-handoff-workbench__diff-count project-handoff-workbench__diff-count--changed"><strong>{handoffDiff.changed.length}</strong><small>Changed</small></span>
                </div>
                <ul className="project-handoff-workbench__diff-list">
                  {handoffDiff.items.slice(0, 8).map((item, index) => (
                    <li key={`${item.kind}-${item.label}-${index}`} className={`project-handoff-workbench__diff-item project-handoff-workbench__diff-item--${item.kind}`}>
                      <span aria-hidden="true">{item.kind === "added" ? "+" : item.kind === "removed" ? "−" : "~"}</span>
                      <div><strong>{item.label}</strong><small>{item.detail}</small></div>
                    </li>
                  ))}
                </ul>
                {handoffDiff.items.length > 8 ? <p className="project-handoff-workbench__diff-more">Showing the first 8 changes; counts include every semantic difference.</p> : null}
              </>
            ) : <p className="project-handoff-workbench__diff-empty">No semantic changes since the prepared baseline. Switching between JSON and Markdown does not change this diff.</p>
          ) : <p className="project-handoff-workbench__diff-empty">Prepare the handoff to capture a renderer-session baseline. Later edits to chats, grants, plan context, signals, notes, or checklist state will appear here.</p>}
        </section>
        <pre tabIndex={0}><code>{payload}</code></pre>
      </section>

      <p className="project-handoff-workbench__boundary"><CircleAlert size={14} /> Handoff preparation is renderer-local. It does not spawn an agent, create a lease, call a provider, mutate the Project Twin, write a file, or send an OS notification.</p>
    </section>
  );
}
