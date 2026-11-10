import type {
  ConversationSnapshot,
  ProjectRecord,
} from "@/lib/desktop";

import { attachmentsForMessage } from "./attachment-catalog";
import type { AttachmentView, ChatMessage, ConversationView, ProviderView } from "./types";

function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}

function excerptFromSnapshot(snapshot: ConversationSnapshot): string {
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
  const latest = activeMessageIds(snapshot)
    .reverse()
    .map((id) => messagesById.get(id))
    .find((message) => message?.contentText.trim());
  return latest?.contentText.replace(/\s+/g, " ").slice(0, 90) ?? "Start a new conversation";
}

function runStateForSnapshot(snapshot: ConversationSnapshot): ConversationView["runState"] {
  const visibleMessages = new Set(activeMessageIds(snapshot));
  const latest = snapshot.runs.filter((run) =>
    run.assistantMessageId !== null && visibleMessages.has(run.assistantMessageId)
  ).at(-1);
  if (!latest) return null;
  if (latest.state === "queued" || latest.state === "running") return "streaming";
  if (latest.state === "failed") return "failed";
  return null;
}

function messageFromNative(
  snapshot: ConversationSnapshot,
  messageId: string,
  providers: readonly Pick<ProviderView, "id" | "name">[],
  attachments: readonly AttachmentView[],
): ChatMessage | null {
  const message = snapshot.messages.find((candidate) => candidate.id === messageId);
  if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
  const run = snapshot.runs.find((candidate) => candidate.assistantMessageId === message.id);
  return {
    id: message.id,
    role: message.role,
    content: message.contentText,
    createdAt: isoFromMs(message.createdAtMs),
    status:
      message.status === "draft"
        ? "streaming"
        : message.status === "cancelled"
          ? "stopped"
          : message.status,
    modelLabel: message.role === "assistant"
      ? [providers.find((provider) => provider.id === message.providerProfileId)?.name, message.modelId]
          .filter(Boolean)
          .join(" · ") || "Unknown route"
      : null,
    runId: run?.id ?? null,
    attachments: attachmentsForMessage(attachments, message.id),
    branchIndex: 1,
    branchCount: 1,
  };
}

/** Resolves the active immutable branch path from native branch/message records. */
export function activeMessageIds(snapshot: ConversationSnapshot): string[] {
  const messagesByBranch = new Map<string, typeof snapshot.messages>();
  for (const branch of snapshot.branches) {
    messagesByBranch.set(
      branch.id,
      snapshot.messages
        .filter((message) => message.branchId === branch.id)
        .sort((left, right) => left.sequenceNo - right.sequenceNo),
    );
  }
  const branches = new Map(snapshot.branches.map((branch) => [branch.id, branch]));
  const visiting = new Set<string>();
  const visit = (branchId: string): string[] => {
    if (visiting.has(branchId)) return [];
    visiting.add(branchId);
    const branch = branches.get(branchId);
    if (!branch) return [];
    let inherited: string[] = [];
    if (branch.parentBranchId) {
      inherited = visit(branch.parentBranchId);
      if (branch.forkedFromMessageId) {
        const forkIndex = inherited.indexOf(branch.forkedFromMessageId);
        inherited = forkIndex >= 0 ? inherited.slice(0, forkIndex + 1) : [];
      }
    }
    visiting.delete(branchId);
    return [...inherited, ...(messagesByBranch.get(branch.id) ?? []).map((message) => message.id)];
  };
  return visit(snapshot.conversation.activeBranchId);
}

export function conversationFromNativeSnapshot(
  snapshot: ConversationSnapshot,
  projects: readonly Pick<ProjectRecord, "id" | "name">[],
  providers: readonly Pick<ProviderView, "id" | "name">[] = [],
  attachments: readonly AttachmentView[] = [],
): ConversationView {
  const project = projects.find((candidate) => candidate.id === snapshot.conversation.projectId);
  const messages = activeMessageIds(snapshot)
    .map((messageId) => messageFromNative(snapshot, messageId, providers, attachments))
    .filter((message): message is ChatMessage => message !== null);
  return {
    id: snapshot.conversation.id,
    activeBranchId: snapshot.conversation.activeBranchId,
    nativeBranches: snapshot.branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      parentBranchId: branch.parentBranchId,
      forkedFromMessageId: branch.forkedFromMessageId,
      createdAtMs: branch.createdAtMs,
    })),
    title: snapshot.conversation.title,
    excerpt: excerptFromSnapshot(snapshot),
    updatedAt: isoFromMs(snapshot.conversation.updatedAtMs),
    updatedLabel: "Saved locally",
    projectId: snapshot.conversation.projectId,
    projectName: project?.name ?? null,
    pinned: snapshot.conversation.pinnedAtMs !== null,
    archived: snapshot.conversation.archivedAtMs !== null,
    hasDraft: false,
    unread: false,
    runState: runStateForSnapshot(snapshot),
    draft: "",
    messages,
  };
}

export function conversationsFromNativeSnapshots(
  snapshots: readonly ConversationSnapshot[],
  projects: readonly Pick<ProjectRecord, "id" | "name">[],
  providers: readonly Pick<ProviderView, "id" | "name">[] = [],
  attachments: readonly AttachmentView[] = [],
): ConversationView[] {
  return snapshots.map((snapshot) =>
    conversationFromNativeSnapshot(snapshot, projects, providers, attachments),
  );
}
