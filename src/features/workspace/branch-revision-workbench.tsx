import {
  ArrowRight,
  Check,
  CircleDot,
  Clock3,
  FileDiff,
  GitBranch,
  History,
  Info,
  LockKeyhole,
  Plus,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isDesktopRuntime, type ConversationBranchRecord, type MessageRevision } from "@/lib/desktop";

import { useWorkspaceStore } from "./store";
import type { ChatMessage, ConversationView } from "./types";

export type BranchWorkbenchTab = "topology" | "revisions" | "compare";

export interface BranchWorkbenchBranch {
  id: string;
  label: string;
  parentBranchId: string | null;
  forkedFromMessageId: string | null;
  messageCount: number;
  latestMessageId: string | null;
  latestExcerpt: string;
  active: boolean;
  source: "native" | "renderer";
}

export interface BranchWorkbenchRevision {
  revision: MessageRevision;
  messageRole: ChatMessage["role"] | "unknown";
  messageExcerpt: string;
}

export interface BranchRevisionProjection {
  activeBranchId: string | null;
  branches: BranchWorkbenchBranch[];
  revisions: BranchWorkbenchRevision[];
  messages: ChatMessage[];
}

export type BranchTopologyRelation = "root" | "child" | "orphan" | "cycle";

export interface BranchTopologyRow extends BranchWorkbenchBranch {
  depth: number;
  relation: BranchTopologyRelation;
  lineagePath: string[];
}

/**
 * Build a bounded, renderer-safe lineage projection from branch metadata.
 *
 * Parent IDs are treated as data, never as authority. Missing parents and
 * cycles are surfaced explicitly so a malformed/native-partial snapshot does
 * not get presented as a trustworthy tree.
 */
export function buildBranchTopologyRows(
  branches: readonly BranchWorkbenchBranch[],
): BranchTopologyRow[] {
  const byId = new Map(branches.map((branch) => [branch.id, branch]));

  const rows = branches.map((branch) => {
    const lineage: string[] = [branch.id];
    const visited = new Set<string>([branch.id]);
    let parentId = branch.parentBranchId;
    let relation: BranchTopologyRelation = parentId ? "child" : "root";

    while (parentId) {
      if (visited.has(parentId)) {
        relation = "cycle";
        break;
      }
      const parent = byId.get(parentId);
      if (!parent) {
        relation = "orphan";
        lineage.unshift(parentId);
        break;
      }
      visited.add(parent.id);
      lineage.unshift(parent.id);
      parentId = parent.parentBranchId;
    }

    return {
      ...branch,
      depth: Math.max(0, lineage.length - 1),
      relation,
      lineagePath: lineage,
    } satisfies BranchTopologyRow;
  });

  return [...rows].sort((left, right) => {
    const pathOrder = left.lineagePath.join("/").localeCompare(right.lineagePath.join("/"));
    return pathOrder || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
  });
}

/**
 * Convert the branch metadata carried by a native ConversationView into the
 * desktop bridge DTO consumed by this workbench. The conversion is metadata
 * only: sibling message bodies are intentionally not fabricated here.
 */
export function branchRecordsFromConversation(
  conversation: ConversationView | null | undefined,
): ConversationBranchRecord[] {
  if (!conversation?.nativeBranches) return [];
  return conversation.nativeBranches.map((branch) => ({
    id: branch.id,
    conversationId: conversation.id,
    parentBranchId: branch.parentBranchId,
    forkedFromMessageId: branch.forkedFromMessageId,
    name: branch.name,
    createdAtMs: branch.createdAtMs,
  }));
}

export interface BranchRevisionWorkbenchProps {
  /** Pass a conversation to make the component deterministic in tests or another surface. */
  conversation?: ConversationView | null;
  /** Native branch rows can be supplied when a snapshot has been hydrated. */
  branchRecords?: readonly ConversationBranchRecord[];
  /** Immutable message revisions keyed by message ID. */
  revisionsByMessageId?: Readonly<Record<string, readonly MessageRevision[]>>;
  /** Defaults to the current runtime probe. Keep false for renderer preview. */
  nativeAvailable?: boolean;
  onSelectBranch?: (branchId: string) => void;
  onSelectMessage?: (messageId: string) => void;
  onRequestBranch?: (messageId: string, name?: string) => Promise<void> | void;
}

const effectLabels: Record<MessageRevision["effect"], string> = {
  "edit-draft": "Draft edit",
  "replace-queued": "Queued replacement",
  "edit-as-branch": "Edit as branch",
  "replay-historical": "Historical replay",
  "retry-current-state": "Current-state retry",
  "selected-delta-retry": "Delta retry",
  "annotation-or-correction": "Annotation",
};

const kindLabels: Record<MessageRevision["kind"], string> = {
  draft: "Draft",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  system: "System",
  annotation: "Annotation",
};

function excerpt(value: string, limit = 112): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function revisionSort(left: MessageRevision, right: MessageRevision): number {
  return left.sourceCursor - right.sourceCursor
    || left.createdAt.localeCompare(right.createdAt)
    || left.revisionId.localeCompare(right.revisionId);
}

/**
 * Build a renderer-safe branch/revision projection.
 *
 * `ConversationView` intentionally contains no branch IDs per message. When
 * native branch rows are absent, the branch list therefore uses the visible
 * branch index/count metadata and labels the result as a renderer estimate.
 * It never invents a durable sibling lineage.
 */
export function buildBranchRevisionProjection(
  conversation: ConversationView | null | undefined,
  branchRecords: readonly ConversationBranchRecord[] = [],
  revisionsByMessageId: Readonly<Record<string, readonly MessageRevision[]>> = {},
): BranchRevisionProjection {
  if (!conversation) {
    return { activeBranchId: null, branches: [], revisions: [], messages: [] };
  }

  const messages = conversation.messages;
  const latestMessage = messages.at(-1) ?? null;
  const revisions = Object.values(revisionsByMessageId)
    .flat()
    .sort(revisionSort)
    .map((revision) => {
      const message = messages.find((candidate) => candidate.id === revision.messageId);
      return {
        revision,
        messageRole: message?.role ?? "unknown",
        messageExcerpt: message ? excerpt(message.content) : "Message is not in the current renderer snapshot.",
      } satisfies BranchWorkbenchRevision;
    });

  if (branchRecords.length > 0) {
    const orderedRecords = [...branchRecords].sort((left, right) => left.createdAtMs - right.createdAtMs);
    const branches = orderedRecords.map((branch, index) => {
      const branchMessage = branch.id === conversation.activeBranchId ? latestMessage : null;
      return {
        id: branch.id,
        label: branch.name?.trim() || `Branch ${index + 1}`,
        parentBranchId: branch.parentBranchId,
        forkedFromMessageId: branch.forkedFromMessageId,
        messageCount: branchMessage ? messages.length : 0,
        latestMessageId: branchMessage?.id ?? null,
        latestExcerpt: branchMessage ? excerpt(branchMessage.content) : "No message tail is hydrated for this branch.",
        active: branch.id === conversation.activeBranchId,
        source: "native",
      } satisfies BranchWorkbenchBranch;
    });
    return { activeBranchId: conversation.activeBranchId, branches, revisions, messages };
  }

  const declaredBranchCount = Math.max(1, ...messages.map((message) => message.branchCount));
  const activeBranchIndex = latestMessage?.branchIndex ?? 1;
  const branches = Array.from({ length: Math.min(declaredBranchCount, 12) }, (_, index) => {
    const branchIndex = index + 1;
    const branchMessages = messages.filter((message) => message.branchIndex === branchIndex);
    const branchMessage = branchMessages.at(-1) ?? null;
    const active = branchIndex === activeBranchIndex;
    return {
      id: active ? conversation.activeBranchId : `preview-branch-${branchIndex}`,
      label: active ? "Current branch" : `Branch ${branchIndex}`,
      parentBranchId: null,
      forkedFromMessageId: null,
      messageCount: branchMessages.length,
      latestMessageId: branchMessage?.id ?? null,
      latestExcerpt: branchMessage ? excerpt(branchMessage.content) : "Sibling path is not hydrated in this renderer snapshot.",
      active,
      source: "renderer",
    } satisfies BranchWorkbenchBranch;
  });

  return { activeBranchId: conversation.activeBranchId, branches, revisions, messages };
}

function PreviewBoundary({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="branch-revision-workbench__boundary">
      <Info size={14} />
      <span>{children}</span>
    </p>
  );
}

function BranchStatus({ branch }: { readonly branch: BranchWorkbenchBranch }) {
  return (
    <span className={`branch-revision-workbench__chip branch-revision-workbench__chip--${branch.active ? "active" : "muted"}`}>
      {branch.active ? <CircleDot size={12} /> : <GitBranch size={12} />}
      {branch.active ? "Current path" : branch.source === "native" ? "Available" : "Preview slot"}
    </span>
  );
}

function EmptyState({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="branch-revision-workbench__empty">
      <GitBranch size={22} />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function topologyRelationLabel(relation: BranchTopologyRelation): string {
  switch (relation) {
    case "root":
      return "root path";
    case "child":
      return "child path";
    case "orphan":
      return "missing parent";
    case "cycle":
      return "cycle detected";
  }
}

function BranchLineageMap({
  projection,
  selectedBranchId,
  onSelectBranch,
}: {
  readonly projection: BranchRevisionProjection;
  readonly selectedBranchId: string | null;
  readonly onSelectBranch: (branch: BranchWorkbenchBranch) => void;
}) {
  const rows = buildBranchTopologyRows(projection.branches);
  const hasNativeRows = rows.some((row) => row.source === "native");

  if (rows.length === 0) return null;

  return (
    <section className="branch-revision-workbench__lineage" aria-labelledby="branch-lineage-map-title">
      <div className="branch-revision-workbench__lineage-heading">
        <div>
          <span className="branch-revision-workbench__eyebrow">Topology projection</span>
          <h3 id="branch-lineage-map-title">Lineage map</h3>
        </div>
        <span className="branch-revision-workbench__chip branch-revision-workbench__chip--muted">
          <GitBranch size={12} /> {hasNativeRows ? "Native metadata" : "Preview slots"}
        </span>
      </div>
      <div className="branch-revision-workbench__lineage-tree" role="tree" aria-label="Branch lineage map">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={row.id === selectedBranchId}
            className={`branch-revision-workbench__lineage-row${row.id === selectedBranchId ? " branch-revision-workbench__lineage-row--selected" : ""}`}
            style={{ paddingInlineStart: `calc(8px + ${Math.min(row.depth, 8)} * 22px)` }}
            onClick={() => onSelectBranch(row)}
          >
            <span className="branch-revision-workbench__lineage-branch" aria-hidden="true"><GitBranch size={14} /></span>
            <span className="branch-revision-workbench__lineage-copy">
              <strong>{row.label}</strong>
              <small>{topologyRelationLabel(row.relation)} · {row.messageCount} visible message{row.messageCount === 1 ? "" : "s"}</small>
            </span>
            {row.active ? <span className="branch-revision-workbench__chip branch-revision-workbench__chip--active">Current</span> : null}
            {row.relation === "orphan" || row.relation === "cycle" ? <span className="branch-revision-workbench__lineage-warning">Review</span> : null}
          </button>
        ))}
      </div>
      <PreviewBoundary>
        Indentation follows parent IDs in this snapshot. Missing parents and cycles are shown as review states; this map does not create lineage, merge branches, or prove native consistency.
      </PreviewBoundary>
    </section>
  );
}

function TopologyPanel({
  projection,
  selectedBranchId,
  nativeAvailable,
  onSelectBranch,
  onSelectMessage,
  onOpenBranchComposer,
}: {
  readonly projection: BranchRevisionProjection;
  readonly selectedBranchId: string | null;
  readonly nativeAvailable: boolean;
  readonly onSelectBranch: (branch: BranchWorkbenchBranch) => void;
  readonly onSelectMessage?: (messageId: string) => void;
  readonly onOpenBranchComposer: () => void;
}) {
  const selectedBranch = projection.branches.find((branch) => branch.id === selectedBranchId)
    ?? projection.branches.find((branch) => branch.active)
    ?? projection.branches[0];
  const selectedForkMessage = selectedBranch?.forkedFromMessageId
    ? projection.messages.find((message) => message.id === selectedBranch.forkedFromMessageId)
    : null;

  return (
    <div className="branch-revision-workbench__panel-grid">
      <div className="branch-revision-workbench__branch-list" role="list" aria-label="Conversation branches">
        {projection.branches.map((branch) => (
          <button
            key={branch.id}
            type="button"
            role="listitem"
            className={`branch-revision-workbench__branch${branch.id === selectedBranch?.id ? " branch-revision-workbench__branch--selected" : ""}`}
            aria-pressed={branch.id === selectedBranch?.id}
            onClick={() => onSelectBranch(branch)}
          >
            <span className="branch-revision-workbench__branch-icon"><GitBranch size={16} /></span>
            <span className="branch-revision-workbench__branch-copy">
              <strong>{branch.label}</strong>
              <small>{branch.messageCount} visible message{branch.messageCount === 1 ? "" : "s"}</small>
            </span>
            <BranchStatus branch={branch} />
          </button>
        ))}
      </div>

      <aside className="branch-revision-workbench__detail" aria-label="Selected branch details">
        {selectedBranch ? (
          <>
            <div className="branch-revision-workbench__detail-heading">
              <span className="branch-revision-workbench__eyebrow">Selected path</span>
              <h3>{selectedBranch.label}</h3>
              <BranchStatus branch={selectedBranch} />
            </div>
            <dl className="branch-revision-workbench__facts">
              <div><dt>Branch ID</dt><dd><code>{selectedBranch.id}</code></dd></div>
              <div><dt>Parent</dt><dd>{selectedBranch.parentBranchId ? <code>{selectedBranch.parentBranchId}</code> : "Root or not hydrated"}</dd></div>
              <div><dt>Fork point</dt><dd>{selectedForkMessage ? `Message ${selectedForkMessage.id}` : selectedBranch.forkedFromMessageId ? <code>{selectedBranch.forkedFromMessageId}</code> : "Not available"}</dd></div>
            </dl>
            <p className="branch-revision-workbench__excerpt">{selectedBranch.latestExcerpt}</p>
            {selectedForkMessage && onSelectMessage ? (
              <button type="button" className="button button--ghost" onClick={() => onSelectMessage(selectedForkMessage.id)}>
                Open fork message <ArrowRight size={14} />
              </button>
            ) : null}
          </>
        ) : (
          <EmptyState title="No branch selected" detail="Select a branch to inspect its visible lineage." />
        )}
      </aside>

      <BranchLineageMap projection={projection} selectedBranchId={selectedBranch?.id ?? null} onSelectBranch={onSelectBranch} />

      <div className="branch-revision-workbench__topology-footer">
        <button
          type="button"
          className="button button--secondary"
          onClick={onOpenBranchComposer}
          disabled={projection.messages.length === 0}
          aria-label="Create branch from latest message"
          title={!nativeAvailable ? "Preview only: native branch creation is planned" : undefined}
        >
          <Plus size={14} /> Branch from latest message
        </button>
        <span>{projection.revisions.length} immutable revision{projection.revisions.length === 1 ? "" : "s"} linked to this snapshot</span>
      </div>
    </div>
  );
}

function RevisionsPanel({
  projection,
  selectedRevisionId,
  onSelectRevision,
  onSelectMessage,
  onCompare,
}: {
  readonly projection: BranchRevisionProjection;
  readonly selectedRevisionId: string | null;
  readonly onSelectRevision: (revisionId: string) => void;
  readonly onSelectMessage?: (messageId: string) => void;
  readonly onCompare: () => void;
}) {
  const selected = projection.revisions.find((item) => item.revision.revisionId === selectedRevisionId)
    ?? projection.revisions.at(-1);

  if (projection.revisions.length === 0) {
    return <EmptyState title="No message revisions yet" detail="Edits, retries, and branch candidates will appear here when the native revision stream is hydrated." />;
  }

  return (
    <div className="branch-revision-workbench__revision-layout">
      <div className="branch-revision-workbench__revision-list" role="list" aria-label="Message revisions">
        {projection.revisions.map(({ revision, messageRole, messageExcerpt }) => {
          const selectedRevision = revision.revisionId === selected?.revision.revisionId;
          return (
            <button
              key={revision.revisionId}
              type="button"
              role="listitem"
              className={`branch-revision-workbench__revision${selectedRevision ? " branch-revision-workbench__revision--selected" : ""}`}
              aria-pressed={selectedRevision}
              onClick={() => onSelectRevision(revision.revisionId)}
            >
              <span className="branch-revision-workbench__revision-icon"><History size={15} /></span>
              <span className="branch-revision-workbench__revision-copy">
                <strong>{effectLabels[revision.effect]}</strong>
                <small>{kindLabels[revision.kind]} · {messageRole === "unknown" ? "message not hydrated" : messageRole} · cursor {revision.sourceCursor}</small>
                <span>{messageExcerpt}</span>
              </span>
              <time dateTime={revision.createdAt}>{formatTimestamp(revision.createdAt)}</time>
            </button>
          );
        })}
      </div>

      <aside className="branch-revision-workbench__detail" aria-label="Selected revision details">
        {selected ? (
          <>
            <div className="branch-revision-workbench__detail-heading">
              <span className="branch-revision-workbench__eyebrow">Immutable revision</span>
              <h3>{effectLabels[selected.revision.effect]}</h3>
              <span className="branch-revision-workbench__chip branch-revision-workbench__chip--muted"><Clock3 size={12} /> {formatTimestamp(selected.revision.createdAt)}</span>
            </div>
            <p className="branch-revision-workbench__excerpt">{selected.messageExcerpt}</p>
            <dl className="branch-revision-workbench__facts">
              <div><dt>Revision ID</dt><dd><code>{selected.revision.revisionId}</code></dd></div>
              <div><dt>Message</dt><dd>{selected.messageRole === "unknown" ? "Not in current snapshot" : kindLabels[selected.revision.kind]}</dd></div>
              <div><dt>Content hash</dt><dd><code>{selected.revision.contentHash.slice(0, 18)}…</code></dd></div>
              <div><dt>Parent revision</dt><dd>{selected.revision.parentRevisionId ? <code>{selected.revision.parentRevisionId}</code> : "Root revision"}</dd></div>
              <div><dt>Destination branch</dt><dd>{selected.revision.destinationBranchId ? <code>{selected.revision.destinationBranchId}</code> : "Current scope"}</dd></div>
            </dl>
            <div className="branch-revision-workbench__detail-actions">
              {onSelectMessage && selected.revision.messageId ? (
                <button type="button" className="button button--ghost" onClick={() => onSelectMessage(selected.revision.messageId)}>
                  Open message <ArrowRight size={14} />
                </button>
              ) : null}
              <button type="button" className="button button--secondary" onClick={onCompare} disabled={projection.revisions.length < 2}>
                <FileDiff size={14} /> Compare revisions
              </button>
            </div>
          </>
        ) : (
          <EmptyState title="Choose a revision" detail="Select a row to inspect its lineage and destination." />
        )}
      </aside>
    </div>
  );
}

function ComparePanel({
  projection,
  baseBranchId,
  targetBranchId,
  baseRevisionId,
  targetRevisionId,
  onBaseBranchChange,
  onTargetBranchChange,
  onBaseChange,
  onTargetChange,
}: {
  readonly projection: BranchRevisionProjection;
  readonly baseBranchId: string | null;
  readonly targetBranchId: string | null;
  readonly baseRevisionId: string | null;
  readonly targetRevisionId: string | null;
  readonly onBaseBranchChange: (value: string) => void;
  readonly onTargetBranchChange: (value: string) => void;
  readonly onBaseChange: (value: string) => void;
  readonly onTargetChange: (value: string) => void;
}) {
  const nativeBranches = projection.branches.filter((branch) => branch.source === "native");
  const baseBranch = nativeBranches.find((branch) => branch.id === baseBranchId) ?? nativeBranches[0] ?? null;
  const targetBranch = nativeBranches.find((branch) => branch.id === targetBranchId) ?? nativeBranches.at(-1) ?? null;
  const sameBranch = baseBranch !== null && targetBranch !== null && baseBranch.id === targetBranch.id;

  const base = projection.revisions.find((item) => item.revision.revisionId === baseRevisionId) ?? projection.revisions[0] ?? null;
  const target = projection.revisions.find((item) => item.revision.revisionId === targetRevisionId) ?? projection.revisions.at(-1) ?? null;
  const sameRevision = base !== null && target !== null && base.revision.revisionId === target.revision.revisionId;

  return (
    <div className="branch-revision-workbench__compare">
      <section className="branch-revision-workbench__compare-section" aria-labelledby="native-branch-compare-title">
        <div className="branch-revision-workbench__compare-heading">
          <div><span className="branch-revision-workbench__eyebrow">Native metadata snapshot</span><h3 id="native-branch-compare-title">Compare branches</h3></div>
          <span className="branch-revision-workbench__chip branch-revision-workbench__chip--muted"><GitBranch size={12} /> {nativeBranches.length} hydrated</span>
        </div>
        {nativeBranches.length < 2 ? (
          <EmptyState title="Need two hydrated branches to compare" detail="Native branch IDs and lineage metadata appear here after a desktop Chat snapshot includes at least two branches." />
        ) : (
          <>
            <div className="branch-revision-workbench__compare-controls">
              <label><span>Base branch</span><select value={baseBranch?.id ?? ""} onChange={(event) => onBaseBranchChange(event.target.value)}>{nativeBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.label}{branch.active ? " · current" : ""}</option>)}</select></label>
              <ArrowRight size={16} aria-hidden="true" />
              <label><span>Target branch</span><select value={targetBranch?.id ?? ""} onChange={(event) => onTargetBranchChange(event.target.value)}>{nativeBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.label}{branch.active ? " · current" : ""}</option>)}</select></label>
            </div>
            {sameBranch ? <p className="branch-revision-workbench__compare-note">Choose two different hydrated branches to compare their lineage metadata.</p> : (
              <div className="branch-revision-workbench__diff" aria-label="Native branch comparison preview">
                <div className="branch-revision-workbench__diff-row branch-revision-workbench__diff-row--removed"><span>−</span><div><strong>{baseBranch?.label}</strong><small>ID <code>{baseBranch?.id}</code> · parent {baseBranch?.parentBranchId ?? "root"} · fork {baseBranch?.forkedFromMessageId ?? "conversation start / unavailable"}</small></div></div>
                <div className="branch-revision-workbench__diff-row branch-revision-workbench__diff-row--added"><span>＋</span><div><strong>{targetBranch?.label}</strong><small>ID <code>{targetBranch?.id}</code> · parent {targetBranch?.parentBranchId ?? "root"} · fork {targetBranch?.forkedFromMessageId ?? "conversation start / unavailable"}</small></div></div>
              </div>
            )}
            <PreviewBoundary>Branch IDs, parent IDs, fork points, and active status come from the hydrated native Chat snapshot. Sibling message content, state revisions, live-follow cursors, promotion, merge, and rollback are not hydrated by this renderer surface.</PreviewBoundary>
          </>
        )}
      </section>

      <section className="branch-revision-workbench__compare-section" aria-labelledby="revision-compare-title">
        <div className="branch-revision-workbench__compare-heading">
          <div><span className="branch-revision-workbench__eyebrow">Renderer snapshot</span><h3 id="revision-compare-title">Compare revisions</h3></div>
          <span className="branch-revision-workbench__chip branch-revision-workbench__chip--muted"><History size={12} /> {projection.revisions.length} visible</span>
        </div>
        {projection.revisions.length < 2 || !base || !target ? (
          <EmptyState title="Need two revisions to compare" detail="Once a second immutable revision exists, Omnia can show a lineage-aware comparison here." />
        ) : (
          <>
            <div className="branch-revision-workbench__compare-controls">
              <label><span>Base revision</span><select value={base.revision.revisionId} onChange={(event) => onBaseChange(event.target.value)}>{projection.revisions.map(({ revision }) => <option key={revision.revisionId} value={revision.revisionId}>{effectLabels[revision.effect]} · #{revision.sourceCursor}</option>)}</select></label>
              <ArrowRight size={16} aria-hidden="true" />
              <label><span>Target revision</span><select value={target.revision.revisionId} onChange={(event) => onTargetChange(event.target.value)}>{projection.revisions.map(({ revision }) => <option key={revision.revisionId} value={revision.revisionId}>{effectLabels[revision.effect]} · #{revision.sourceCursor}</option>)}</select></label>
            </div>
            {sameRevision ? <p className="branch-revision-workbench__compare-note">Choose two different revisions to compare their visible metadata.</p> : (
              <div className="branch-revision-workbench__diff" aria-label="Revision comparison preview">
                <div className="branch-revision-workbench__diff-row branch-revision-workbench__diff-row--removed"><span>−</span><div><strong>{effectLabels[base.revision.effect]}</strong><small>{base.messageExcerpt}</small></div></div>
                <div className="branch-revision-workbench__diff-row branch-revision-workbench__diff-row--added"><span>＋</span><div><strong>{effectLabels[target.revision.effect]}</strong><small>{target.messageExcerpt}</small></div></div>
              </div>
            )}
            <PreviewBoundary>This is a renderer comparison of hydrated revision metadata and message excerpts. Native content diff, branch promotion, and rollback remain planned.</PreviewBoundary>
          </>
        )}
      </section>
    </div>
  );
}

export function BranchRevisionWorkbenchView({
  conversation,
  branchRecords = [],
  revisionsByMessageId = {},
  nativeAvailable = false,
  onSelectBranch,
  onSelectMessage,
  onRequestBranch,
}: BranchRevisionWorkbenchProps) {
  const projection = useMemo(
    () => buildBranchRevisionProjection(conversation, branchRecords, revisionsByMessageId),
    [branchRecords, conversation, revisionsByMessageId],
  );
  const [tab, setTab] = useState<BranchWorkbenchTab>("topology");
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(projection.activeBranchId);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(projection.revisions.at(-1)?.revision.revisionId ?? null);
  const [baseRevisionId, setBaseRevisionId] = useState<string | null>(projection.revisions.at(-2)?.revision.revisionId ?? null);
  const [targetRevisionId, setTargetRevisionId] = useState<string | null>(projection.revisions.at(-1)?.revision.revisionId ?? null);
  const nativeBranches = projection.branches.filter((branch) => branch.source === "native");
  const [baseBranchId, setBaseBranchId] = useState<string | null>(nativeBranches[0]?.id ?? null);
  const [targetBranchId, setTargetBranchId] = useState<string | null>(nativeBranches.at(-1)?.id ?? null);
  const [branchComposerOpen, setBranchComposerOpen] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [branchSourceMessageId, setBranchSourceMessageId] = useState<string | null>(null);
  const [branchStatus, setBranchStatus] = useState<"idle" | "pending" | "success" | "planned" | "error">("idle");
  const [branchError, setBranchError] = useState<string | null>(null);

  useEffect(() => {
    if (!projection.branches.some((branch) => branch.id === selectedBranchId)) {
      setSelectedBranchId(projection.activeBranchId ?? projection.branches[0]?.id ?? null);
    }
    if (!projection.revisions.some((item) => item.revision.revisionId === selectedRevisionId)) {
      setSelectedRevisionId(projection.revisions.at(-1)?.revision.revisionId ?? null);
    }
    if (!projection.revisions.some((item) => item.revision.revisionId === targetRevisionId)) {
      setTargetRevisionId(projection.revisions.at(-1)?.revision.revisionId ?? null);
    }
    if (!projection.revisions.some((item) => item.revision.revisionId === baseRevisionId)) {
      setBaseRevisionId(projection.revisions.at(-2)?.revision.revisionId ?? null);
    }
    if (!nativeBranches.some((branch) => branch.id === baseBranchId)) {
      setBaseBranchId(nativeBranches[0]?.id ?? null);
    }
    if (!nativeBranches.some((branch) => branch.id === targetBranchId)) {
      setTargetBranchId(nativeBranches.at(-1)?.id ?? null);
    }
  }, [baseBranchId, baseRevisionId, nativeBranches, projection, selectedBranchId, selectedRevisionId, targetBranchId]);

  const openBranchComposer = () => {
    const latestMessage = projection.messages.at(-1);
    if (!latestMessage) return;
    setBranchSourceMessageId(latestMessage.id);
    setBranchComposerOpen(true);
    setBranchName("");
    setBranchStatus("idle");
    setBranchError(null);
  };

  const submitBranch = async () => {
    if (!branchSourceMessageId || branchStatus === "pending") return;
    if (!nativeAvailable || !onRequestBranch) {
      setBranchStatus("planned");
      return;
    }
    setBranchStatus("pending");
    setBranchError(null);
    try {
      await onRequestBranch(branchSourceMessageId, branchName.trim() || undefined);
      setBranchStatus("success");
    } catch (cause) {
      setBranchStatus("error");
      setBranchError(cause instanceof Error ? cause.message : "Unable to create branch.");
    }
  };

  const selectBranch = (branch: BranchWorkbenchBranch) => {
    setSelectedBranchId(branch.id);
    onSelectBranch?.(branch.id);
  };

  const selectedRevision = projection.revisions.find((item) => item.revision.revisionId === selectedRevisionId);

  return (
    <section className="branch-revision-workbench" aria-labelledby="branch-revision-workbench-title" data-testid="branch-revision-workbench">
      <header className="branch-revision-workbench__header">
        <span className="branch-revision-workbench__icon"><GitBranch size={18} /></span>
        <div>
          <span className="branch-revision-workbench__eyebrow">Renderer preview</span>
          <h2 id="branch-revision-workbench-title">Branches & revisions</h2>
          <p>Trace alternate paths, immutable message revisions, and the next comparison target without flattening history.</p>
        </div>
        <span className="branch-revision-workbench__status"><Sparkles size={13} /> {nativeAvailable ? "Native bridge available" : "Native bridge planned"}</span>
      </header>

      <div className="branch-revision-workbench__summary" role="status">
        <div><strong>{projection.branches.length}</strong><span>visible branch{projection.branches.length === 1 ? "" : "es"}</span></div>
        <div><strong>{projection.revisions.length}</strong><span>revision{projection.revisions.length === 1 ? "" : "s"}</span></div>
        <div><strong>{projection.messages.length}</strong><span>visible message{projection.messages.length === 1 ? "" : "s"}</span></div>
        <div className="branch-revision-workbench__summary-route"><LockKeyhole size={14} /><span>{nativeAvailable ? "Native actions can be requested" : "Durable branch actions are planned"}</span></div>
      </div>

      <div className="branch-revision-workbench__tabs" role="tablist" aria-label="Branch and revision views">
        {([
          ["topology", "Topology", GitBranch],
          ["revisions", "Revisions", History],
          ["compare", "Compare", FileDiff],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            id={`branch-revision-tab-${id}`}
            type="button"
            role="tab"
            tabIndex={tab === id ? 0 : -1}
            aria-selected={tab === id}
            aria-controls={`branch-revision-panel-${id}`}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      <div
        id={`branch-revision-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`branch-revision-tab-${tab}`}
        className="branch-revision-workbench__content"
      >
        {!conversation ? <EmptyState title="No active Chat" detail="Select a Chat to inspect its branch tree and revision history." /> : null}
        {conversation && tab === "topology" ? <TopologyPanel projection={projection} selectedBranchId={selectedBranchId} nativeAvailable={nativeAvailable} onSelectBranch={selectBranch} {...(onSelectMessage ? { onSelectMessage } : {})} onOpenBranchComposer={openBranchComposer} /> : null}
        {conversation && tab === "revisions" ? <RevisionsPanel projection={projection} selectedRevisionId={selectedRevisionId} onSelectRevision={setSelectedRevisionId} {...(onSelectMessage ? { onSelectMessage } : {})} onCompare={() => { if (selectedRevision) setTargetRevisionId(selectedRevision.revision.revisionId); setTab("compare"); }} /> : null}
        {conversation && tab === "compare" ? <ComparePanel projection={projection} baseBranchId={baseBranchId} targetBranchId={targetBranchId} baseRevisionId={baseRevisionId} targetRevisionId={targetRevisionId} onBaseBranchChange={setBaseBranchId} onTargetBranchChange={setTargetBranchId} onBaseChange={setBaseRevisionId} onTargetChange={setTargetRevisionId} /> : null}
      </div>

      {branchComposerOpen ? (
        <div className="branch-revision-workbench__composer" aria-label="Create branch preview">
          <div><span className="branch-revision-workbench__eyebrow">Branch from message</span><strong>{branchSourceMessageId}</strong></div>
          <label><span>Branch name</span><input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="e.g. Explore local routing" /></label>
          <div className="branch-revision-workbench__composer-actions">
            <button type="button" className="button button--ghost" onClick={() => setBranchComposerOpen(false)}>Cancel</button>
            <button type="button" className="button button--secondary" onClick={() => void submitBranch()} disabled={branchStatus === "pending"}>
              {branchStatus === "pending" ? <Clock3 size={14} /> : <Plus size={14} />}
              {branchStatus === "pending" ? "Creating…" : "Create branch"}
            </button>
          </div>
          {branchStatus === "planned" ? <PreviewBoundary>Branch creation is planned until a native branch bridge is connected.</PreviewBoundary> : null}
          {branchStatus === "success" ? <p className="branch-revision-workbench__feedback branch-revision-workbench__feedback--success"><Check size={14} /> Branch request accepted by the connected runtime.</p> : null}
          {branchStatus === "error" ? <p className="branch-revision-workbench__feedback branch-revision-workbench__feedback--error" role="alert">{branchError ?? "Unable to create branch."}</p> : null}
        </div>
      ) : null}

      <PreviewBoundary>
        Branch identity is {branchRecordsLabel(projection)}. Native promotion, rollback, merge, and durable revision persistence stay gated behind the desktop bridge.
      </PreviewBoundary>
    </section>
  );
}

function branchRecordsLabel(projection: BranchRevisionProjection): string {
  return projection.branches.some((branch) => branch.source === "native") ? "hydrated from a native snapshot" : "estimated from visible message metadata";
}

/** Connected convenience wrapper for Inspector/Workbench Deck integration. */
export function BranchRevisionWorkbench(props: BranchRevisionWorkbenchProps = {}) {
  const storeConversation = useWorkspaceStore((state) => state.conversations.find((conversation) => conversation.id === state.activeConversationId));
  const storeRevisions = useWorkspaceStore((state) => state.messageRevisionsByMessageId);
  const storeFork = useWorkspaceStore((state) => state.forkConversationBranch);
  const nativeAvailable = props.nativeAvailable ?? isDesktopRuntime();
  const requestBranch = props.onRequestBranch ?? (nativeAvailable ? storeFork : undefined);
  const nativeBranchRecords = branchRecordsFromConversation(storeConversation);
  const viewProps: BranchRevisionWorkbenchProps = {
    conversation: props.conversation === undefined ? storeConversation ?? null : props.conversation,
    branchRecords: props.branchRecords ?? (props.conversation === undefined ? nativeBranchRecords : branchRecordsFromConversation(props.conversation)),
    revisionsByMessageId: props.revisionsByMessageId ?? storeRevisions,
    nativeAvailable,
    ...(props.onSelectBranch ? { onSelectBranch: props.onSelectBranch } : {}),
    ...(props.onSelectMessage ? { onSelectMessage: props.onSelectMessage } : {}),
    ...(requestBranch ? { onRequestBranch: requestBranch } : {}),
  };
  return <BranchRevisionWorkbenchView {...viewProps} />;
}
