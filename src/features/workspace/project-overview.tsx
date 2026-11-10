import {
  AlertCircle,
  Archive,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FolderOpen,
  GitBranch,
  Gauge,
  Layers3,
  ListChecks,
  LockKeyhole,
  MessageSquareText,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Waypoints,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  buildProjectContextAvailability,
  nativeContextEvidenceFromOverview,
  type ProjectContextHealth,
} from "./project-context-availability-contract";
import {
  buildProjectOverviewTabContracts,
  type ProjectOverviewTabContract,
  type ProjectOverviewTabId,
  type ProjectOverviewTargetTab,
} from "./project-overview-tabs-contract";
import type { ProjectOverviewStatus, ProjectOverviewView, WorkspaceFolderView } from "./types";
import { ProjectMissionOverview } from "./project-mission-overview";
import { ProjectOverviewRefreshPreview } from "./project-overview-refresh-preview";
import { ProjectOverviewActionCenter } from "./project-overview-action-center";

export interface ProjectOverviewChat {
  id: string;
  title: string;
  excerpt: string;
  updatedLabel: string;
  archived: boolean;
  unread: boolean;
  hasDraft: boolean;
  runState: "queued" | "streaming" | "failed" | null;
}

interface ProjectOverviewProps {
  projectId: string;
  overview: ProjectOverviewView;
  /**
   * A renderer-only title change, such as the Projects preview rename action.
   * Keep this separate from `overview.title` so a local preview never looks
   * like it rewrote the native overview projection.
   */
  titleOverride?: ProjectOverviewTitleOverride | null;
  contextHealth: ProjectContextHealth;
  folders?: readonly Pick<WorkspaceFolderView, "state" | "scope">[];
  onRefresh?: () => void;
  recentChats?: readonly ProjectOverviewChat[];
  onOpenChat?: (conversationId: string) => void;
  onOpenChatList?: () => void;
  /**
   * Opens the closest renderer surface for a canonical Project Overview tab.
   * The callback is intentionally optional: without it the cards remain an
   * informational contract projection and do not imply native navigation.
   */
  onOpenOverviewTab?: (tab: ProjectOverviewTabId, targetTab?: ProjectOverviewTargetTab) => void;
}

export interface ProjectOverviewTitleOverride {
  value: string;
  source: "renderer-local";
}

const STATUS_LABELS: Record<ProjectOverviewStatus, string> = {
  current: "Current",
  candidate: "Candidate",
  stale: "Stale",
  failed: "Failed",
  superseded: "Superseded",
  unknown: "Unknown",
};

function valueOrUnknown(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "Unknown";
  return String(value);
}

function statusIcon(status: ProjectOverviewStatus) {
  if (status === "current") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === "failed") return <AlertCircle size={14} aria-hidden="true" />;
  if (status === "stale" || status === "superseded") {
    return <Clock3 size={14} aria-hidden="true" />;
  }
  return <Sparkles size={14} aria-hidden="true" />;
}

function OverviewFact({
  icon,
  label,
  value,
  detail,
  field,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string | null;
  field: string;
}) {
  return (
    <article className="project-overview__fact" data-overview-field={field}>
      <span className="project-overview__fact-icon">{icon}</span>
      <span className="project-overview__fact-copy">
        <span className="project-overview__fact-label">{label}</span>
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </article>
  );
}

function EmptyFact({ children }: { children: ReactNode }) {
  return <span className="project-overview__empty">{children}</span>;
}

function overviewTabIcon(tab: ProjectOverviewTabId) {
  if (tab === "conversations") return <MessageSquareText size={15} aria-hidden="true" />;
  if (tab === "context") return <Layers3 size={15} aria-hidden="true" />;
  if (tab === "files") return <FolderOpen size={15} aria-hidden="true" />;
  if (tab === "memory") return <Sparkles size={15} aria-hidden="true" />;
  if (tab === "skills") return <ListChecks size={15} aria-hidden="true" />;
  return <Settings2 size={15} aria-hidden="true" />;
}

function overviewTabStatusIcon(status: ProjectOverviewTabContract["status"]) {
  if (status === "Preview") return <CheckCircle2 size={12} aria-hidden="true" />;
  if (status === "Partial") return <Clock3 size={12} aria-hidden="true" />;
  if (status === "Planned") return <Sparkles size={12} aria-hidden="true" />;
  return <LockKeyhole size={12} aria-hidden="true" />;
}

function ProjectOverviewTabCard({
  mapping,
  expanded,
  onToggle,
  onOpen,
}: {
  mapping: ProjectOverviewTabContract;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (() => void) | undefined;
}) {
  const unavailable = mapping.status === "Unavailable";
  const canOpen = !unavailable && Boolean(onOpen);
  const detailsId = `project-overview-tab-details-${mapping.id}`;

  return (
    <article
      className={`project-overview__tab-card project-overview__tab-card--${mapping.status.toLowerCase()}`}
      data-overview-tab={mapping.id}
      data-tab-status={mapping.status}
    >
      <button
        type="button"
        className="project-overview__tab-card-trigger"
        aria-label={`${mapping.label} tab`}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={onToggle}
      >
        <span className="project-overview__tab-card-icon">{overviewTabIcon(mapping.id)}</span>
        <span className="project-overview__tab-card-heading">
          <strong>{mapping.label}</strong>
          <small>{mapping.targetLabel}</small>
        </span>
        <span className={`project-overview__tab-card-status project-overview__tab-card-status--${mapping.status.toLowerCase()}`}>
          {overviewTabStatusIcon(mapping.status)} {mapping.status}
        </span>
        <ChevronRight className={expanded ? "is-expanded" : undefined} size={14} aria-hidden="true" />
      </button>
      {expanded ? (
        <div id={detailsId} className="project-overview__tab-card-drawer" role="region" aria-label={`${mapping.label} tab details`}>
          <p>{mapping.description}</p>
          <p><strong>Native gap:</strong> {mapping.nativeGap}</p>
          <button
            type="button"
            className="button button--ghost project-overview__tab-card-action"
            disabled={!canOpen}
            onClick={onOpen}
            title={
              unavailable
                ? "This Project Overview tab is unavailable in the current preview"
                : canOpen
                  ? `Open ${mapping.targetLabel}`
                  : "No renderer navigation callback is connected"
            }
          >
            {unavailable ? "Unavailable" : `Open ${mapping.targetLabel}`}
            {!unavailable ? <ChevronRight size={13} aria-hidden="true" /> : null}
          </button>
          <small className="project-overview__tab-card-boundary">
            {canOpen
              ? "Renderer-local route only · no native write"
              : "Informational mapping only · no navigation callback is connected"}
          </small>
        </div>
      ) : null}
    </article>
  );
}

type ChatGroup = "active" | "paused" | "archived";

function chatGroup(chat: ProjectOverviewChat): ChatGroup {
  if (chat.archived) return "archived";
  if (chat.runState === "queued" || chat.runState === "streaming" || chat.runState === "failed" || chat.hasDraft) {
    return "active";
  }
  return "paused";
}

const CHAT_GROUP_COPY: Record<ChatGroup, { label: string; detail: string }> = {
  active: { label: "Active", detail: "Drafts and runs needing attention" },
  paused: { label: "Paused", detail: "Recent conversations ready to continue" },
  archived: { label: "Archived", detail: "Kept for reference" },
};

function chatStatusCopy(chat: ProjectOverviewChat): string {
  if (chat.archived) return "Archived";
  if (chat.runState === "streaming") return "Running";
  if (chat.runState === "queued") return "Queued";
  if (chat.runState === "failed") return "Needs attention";
  if (chat.hasDraft) return "Draft";
  return "Ready";
}

function chatStatusTone(chat: ProjectOverviewChat): string {
  if (chat.archived) return "archived";
  if (chat.runState === "streaming" || chat.runState === "queued") return "live";
  if (chat.runState === "failed") return "attention";
  if (chat.hasDraft) return "draft";
  return "ready";
}

export function ProjectOverview({
  projectId,
  overview,
  titleOverride,
  contextHealth,
  folders = [],
  onRefresh,
  recentChats = [],
  onOpenChat,
  onOpenChatList,
  onOpenOverviewTab,
}: ProjectOverviewProps) {
  const [expandedOverviewTab, setExpandedOverviewTab] = useState<ProjectOverviewTabId | null>(null);
  const localTitleOverride = titleOverride?.source === "renderer-local"
    ? titleOverride.value.trim()
    : "";
  const displayTitle = localTitleOverride || overview.title;
  const statusLabel = STATUS_LABELS[overview.status];
  const hasRevision = Boolean(overview.overviewRevisionId);
  const evidence = overview.verifiedEvidence;
  const changes = overview.recentChanges;
  const contextAvailability = buildProjectContextAvailability({
    health: contextHealth,
    folders,
    nativeEvidence: nativeContextEvidenceFromOverview(overview),
  });
  const contextDetail = overview.modelProfileId
    ? `Model ${overview.modelProfileId} · ${contextAvailability.label}`
    : contextAvailability.label;
  const overviewTabMappings = buildProjectOverviewTabContracts({
    settingsAvailable: Boolean(onOpenOverviewTab),
  });
  const groupedChats = (Object.keys(CHAT_GROUP_COPY) as ChatGroup[]).map((group) => ({
    group,
    chats: recentChats.filter((chat) => chatGroup(chat) === group).slice(0, 4),
  }));

  return (
    <section
      className="project-overview"
      aria-labelledby={`project-overview-title-${projectId}`}
      data-overview-status={overview.status}
      data-context-availability={contextAvailability.surfaceStatus}
    >
      <header className="project-overview__header">
        <div className="project-overview__heading">
          <div className="project-overview__eyebrow-row">
            <span className="eyebrow">Project Overview</span>
            {localTitleOverride ? (
              <span
                className="project-overview__title-source"
                data-overview-title-source="renderer-local"
                title={`Native overview title: ${valueOrUnknown(overview.title)}`}
              >
                Renderer-local title override
              </span>
            ) : null}
            <span
              className={`project-overview__status project-overview__status--${overview.status}`}
              title={
                hasRevision
                  ? `Overview revision ${overview.overviewRevisionId}`
                  : "No durable Project Overview revision has been hydrated"
              }
            >
              {statusIcon(overview.status)} {statusLabel}
            </span>
          </div>
          <h3 id={`project-overview-title-${projectId}`}>
            {valueOrUnknown(displayTitle)}
          </h3>
          {localTitleOverride ? (
            <small className="project-overview__title-source-detail">
              Native overview title remains {valueOrUnknown(overview.title)}; this rename is preview-only.
            </small>
          ) : null}
          <p>
            {overview.summary ?? (
              <EmptyFact>
                No overview summary is available from the native revision yet.
              </EmptyFact>
            )}
          </p>
        </div>
        <div className="project-overview__actions">
          <span className="project-overview__revision" title="Overview provenance">
            {hasRevision
              ? `Revision ${overview.overviewRevisionId}`
              : "No native overview revision"}
          </span>
          {onRefresh ? (
            <button
              type="button"
              className="icon-button"
              onClick={onRefresh}
              aria-label="Refresh project overview"
              title="Create a read-only overview refresh candidate"
            >
              <RefreshCw size={15} />
            </button>
          ) : null}
        </div>
      </header>

      <ProjectMissionOverview projectId={projectId} overview={overview} />

      <div className="project-overview__facts" aria-label="Project overview facts">
        <OverviewFact
          icon={<Waypoints size={16} />}
          label="Goal"
          value={valueOrUnknown(overview.goal)}
          field="goal"
        />
        <OverviewFact
          icon={<Layers3 size={16} />}
          label="Phase / milestone"
          value={valueOrUnknown(overview.phase)}
          detail={overview.milestone ?? "Milestone unknown"}
          field="phase"
        />
        <OverviewFact
          icon={<ListChecks size={16} />}
          label="Next dependency-complete task"
          value={valueOrUnknown(overview.nextTask)}
          field="next-task"
        />
        <OverviewFact
          icon={<GitBranch size={16} />}
          label="Branch / worktree"
          value={valueOrUnknown(overview.repositoryBranch ?? overview.activeBranch)}
          detail={overview.worktree ?? "Worktree unknown"}
          field="branch"
        />
        <OverviewFact
          icon={<Archive size={16} />}
          label="Workspace roots"
          value={valueOrUnknown(overview.workspaceRootCount)}
          detail="Native grants only"
          field="workspace-roots"
        />
        <OverviewFact
          icon={<ShieldCheck size={16} />}
          label="Verified evidence"
          value={evidence.length > 0 ? `${evidence.length} record(s)` : "Unknown"}
          detail={
            evidence.length > 0
              ? evidence[0]?.freshnessLabel ?? "Evidence freshness unknown"
              : "No evidence hydrated"
          }
          field="verified-evidence"
        />
        <OverviewFact
          icon={<Boxes size={16} />}
          label="Project Twin"
          value={valueOrUnknown(overview.projectTwinRevisionId)}
          detail={
            overview.staleNodeCount === null
              ? "Stale nodes unknown"
              : `${overview.staleNodeCount} stale node(s)`
          }
          field="project-twin"
        />
        <OverviewFact
          icon={<Gauge size={16} />}
          label="Runtime / model"
          value={valueOrUnknown(overview.runtimeLabel)}
          detail={contextDetail}
          field="runtime"
        />
      </div>

      <div className="project-overview__notice" role="status" aria-live="polite">
        <LockKeyhole size={15} aria-hidden="true" />
        <span>
          {hasRevision
            ? "Facts are linked to a durable overview revision. Unknown or stale fields remain labeled."
            : "This is a metadata-only projection. A durable native overview revision, Project Twin graph, and verified evidence have not been hydrated yet."}
          <small>
            Context availability: {contextAvailability.label}. {contextAvailability.reason}
          </small>
        </span>
      </div>

      <ProjectOverviewActionCenter
        overview={overview}
        contextHealth={contextHealth}
        recentChats={recentChats}
        {...(onRefresh ? { onRefresh } : {})}
        {...(onOpenChat ? { onOpenChat } : {})}
        {...(onOpenChatList ? { onOpenChatList } : {})}
        {...(onOpenOverviewTab ? { onOpenOverviewTab } : {})}
      />

      <section
        className="project-overview__tab-map"
        aria-labelledby={`project-overview-tabs-title-${projectId}`}
      >
        <header className="project-overview__tab-map-header">
          <div>
            <span className="project-overview__detail-label">Project surface map</span>
            <h4 id={`project-overview-tabs-title-${projectId}`}>Canonical Project Overview tabs</h4>
            <p>Open a renderer preview for each product-level tab, or expand a card to inspect its evidence boundary.</p>
          </div>
          <span className="project-overview__tab-map-badge"><ShieldCheck size={12} aria-hidden="true" /> Contract mapped</span>
        </header>
        <div className="project-overview__tab-map-grid">
          {overviewTabMappings.map((mapping) => (
            <ProjectOverviewTabCard
              key={mapping.id}
              mapping={mapping}
              expanded={expandedOverviewTab === mapping.id}
              onToggle={() => setExpandedOverviewTab((current) => current === mapping.id ? null : mapping.id)}
              onOpen={onOpenOverviewTab ? () => onOpenOverviewTab(mapping.id, mapping.targetTab) : undefined}
            />
          ))}
        </div>
        <p className="project-overview__tab-map-boundary"><LockKeyhole size={13} aria-hidden="true" /> The cards expose the six-tab contract; they do not claim durable native tabs, indexing, project persistence, or provider dispatch.</p>
      </section>

      <ProjectOverviewRefreshPreview projectId={projectId} overview={overview} />

      <section
        className="project-overview__chats"
        aria-labelledby={`project-overview-chats-title-${projectId}`}
      >
        <header className="project-overview__chats-header">
          <div>
            <span className="project-overview__detail-label">Recent Chats</span>
            <p id={`project-overview-chats-title-${projectId}`}>
              Continue work in this Project without losing the active scope.
            </p>
          </div>
          <button
            type="button"
            className="button button--secondary project-overview__chat-list-button"
            disabled={!onOpenChatList}
            title={onOpenChatList ? "Open all Chats" : "Chat list navigation is unavailable in this preview"}
            onClick={onOpenChatList}
          >
            <MessageSquareText size={14} />
            Open Chat list
          </button>
        </header>
        {recentChats.length > 0 ? (
          <div className="project-overview__chat-groups">
            {groupedChats.map(({ group, chats }) => {
              if (chats.length === 0) return null;
              const copy = CHAT_GROUP_COPY[group];
              return (
                <section key={group} className="project-overview__chat-group" aria-label={`${copy.label} Chats`}>
                  <header>
                    <span className={`project-overview__chat-group-icon project-overview__chat-group-icon--${group}`}>
                      {group === "active" ? <PlayCircle size={13} /> : group === "paused" ? <PauseCircle size={13} /> : <Archive size={13} />}
                    </span>
                    <span>
                      <strong>{copy.label}</strong>
                      <small>{copy.detail}</small>
                    </span>
                    <em>{recentChats.filter((chat) => chatGroup(chat) === group).length}</em>
                  </header>
                  <div className="project-overview__chat-list">
                    {chats.map((chat) => (
                      <button
                        key={chat.id}
                        type="button"
                        className="project-overview__chat-row"
                        disabled={!onOpenChat}
                        title={onOpenChat ? `Open Chat: ${chat.title}` : "Chat navigation is unavailable in this preview"}
                        onClick={() => onOpenChat?.(chat.id)}
                      >
                        <span className="project-overview__chat-row-icon">
                          <MessageSquareText size={14} />
                        </span>
                        <span className="project-overview__chat-row-copy">
                          <strong>
                            {chat.title}
                            {chat.unread ? <span className="project-overview__chat-unread" aria-label="Unread" /> : null}
                          </strong>
                          <small>{chat.excerpt || "No message preview yet."}</small>
                        </span>
                        <span className="project-overview__chat-row-meta">
                          <span className={`project-overview__chat-status project-overview__chat-status--${chatStatusTone(chat)}`}>
                            {chatStatusCopy(chat)}
                          </span>
                          <time>{chat.updatedLabel}</time>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <div className="project-overview__chats-empty">
            <MessageSquareText size={18} />
            <span>
              <strong>No Chats in this Project yet</strong>
              <small>Start a Project Chat to build a visible, resumable work history.</small>
            </span>
          </div>
        )}
      </section>

      <div className="project-overview__sections">
        <details open>
          <summary>
            <span>
              <ListChecks size={15} aria-hidden="true" /> Plan & delivery
            </span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </summary>
          <div className="project-overview__detail-grid">
            <div data-overview-field="non-goals">
              <span className="project-overview__detail-label">Non-goals</span>
              {overview.nonGoals.length > 0 ? (
                <ul>
                  {overview.nonGoals.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : (
                <EmptyFact>Unknown</EmptyFact>
              )}
            </div>
            <div data-overview-field="attention">
              <span className="project-overview__detail-label">Attention</span>
              {overview.attentionItems.length > 0 ? (
                <ul>
                  {overview.attentionItems.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : (
                <EmptyFact>Unknown</EmptyFact>
              )}
            </div>
            <div data-overview-field="budget">
              <span className="project-overview__detail-label">Budget / approvals</span>
              <strong>{valueOrUnknown(overview.budgetLabel)}</strong>
              <small>{overview.approvalsLabel ?? "Approvals unknown"}</small>
            </div>
            <div data-overview-field="background-work">
              <span className="project-overview__detail-label">Background work</span>
              <strong>{valueOrUnknown(overview.backgroundWorkLabel)}</strong>
            </div>
          </div>
        </details>

        <details>
          <summary>
            <span>
              <ShieldCheck size={15} aria-hidden="true" /> Evidence & changes
            </span>
            <span className="project-overview__summary-count">
              {evidence.length + changes.length || "Unknown"}
            </span>
          </summary>
          <div className="project-overview__timeline">
            {evidence.map((item) => (
              <article key={item.id} data-overview-field="evidence-item">
                <span
                  className={`project-overview__timeline-dot project-overview__timeline-dot--${item.status}`}
                />
                <div>
                  <strong>{item.label}</strong>
                  <small>
                    {item.status} · {item.freshnessLabel ?? "Freshness unknown"}
                    {item.sourceLabel ? ` · ${item.sourceLabel}` : ""}
                  </small>
                </div>
              </article>
            ))}
            {changes.map((item) => (
              <article key={item.id} data-overview-field="change-item">
                <span className="project-overview__timeline-dot project-overview__timeline-dot--change" />
                <div>
                  <strong>{item.label}</strong>
                  <small>
                    {item.changedAtLabel ?? "Time unknown"}
                    {item.sourceLabel ? ` · ${item.sourceLabel}` : ""}
                  </small>
                </div>
              </article>
            ))}
            {evidence.length === 0 && changes.length === 0 ? (
              <EmptyFact>No verified evidence or material changes are hydrated.</EmptyFact>
            ) : null}
          </div>
        </details>
      </div>
    </section>
  );
}
