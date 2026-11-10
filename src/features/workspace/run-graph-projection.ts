import type {
  ConversationBranchRecord,
  ConversationSnapshot,
  MessageRecord,
  RunAttemptRecord,
  RunRecord,
} from "@/lib/desktop";

/**
 * The native chat snapshot is intentionally smaller than Omnia's unified
 * kernel graph.  This module projects only the edges that are actually
 * present and reports the layers that the transport does not expose yet.
 *
 * It is important that this projection never invents task, iteration, item,
 * context, or environment IDs.  A fabricated parent would make a resumed
 * run look complete while silently losing provenance.
 */

export type NativeRunGraphNodeKind =
  | "project"
  | "conversation"
  | "branch"
  | "run"
  | "attempt"
  | "message";

export interface NativeRunGraphNode {
  readonly id: string;
  readonly kind: NativeRunGraphNodeKind;
  readonly parentId: string | null;
  readonly ordinal: number;
  readonly createdAtMs: number;
}

export type NativeRunGraphIntegrityCode =
  | "active-branch-missing"
  | "branch-duplicate"
  | "branch-conversation-mismatch"
  | "branch-parent-missing"
  | "branch-parent-cycle"
  | "message-duplicate"
  | "message-conversation-mismatch"
  | "message-branch-missing"
  | "run-duplicate"
  | "run-conversation-mismatch"
  | "run-branch-missing"
  | "run-branch-mismatch"
  | "run-user-mismatch"
  | "run-assistant-missing"
  | "run-assistant-mismatch"
  | "run-attempt-missing"
  | "attempt-duplicate"
  | "attempt-run-missing"
  | "attempt-ordinal-invalid"
  | "attempt-ordinal-gap";

export interface NativeRunGraphIntegrityIssue {
  readonly code: NativeRunGraphIntegrityCode;
  readonly message: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly branchId?: string;
  readonly messageId?: string;
}

export type NativeRunGraphGapCode =
  | "task"
  | "iteration"
  | "item-event"
  | "context-snapshot"
  | "execution-environment"
  | "event-journal";

export interface NativeRunGraphCapabilityGap {
  readonly code: NativeRunGraphGapCode;
  readonly message: string;
  readonly runId?: string;
  readonly attemptId?: string;
}

export interface NativeRunLineage {
  readonly run: RunRecord;
  readonly branch: ConversationBranchRecord | null;
  readonly userMessage: MessageRecord | null;
  readonly assistantMessage: MessageRecord | null;
  readonly attempts: readonly RunAttemptRecord[];
}

export interface NativeRunGraphProjection {
  readonly conversationId: string;
  readonly projectId: string | null;
  readonly root: NativeRunGraphNode;
  readonly nodes: readonly NativeRunGraphNode[];
  readonly lineages: readonly NativeRunLineage[];
  readonly integrityIssues: readonly NativeRunGraphIntegrityIssue[];
  readonly capabilityGaps: readonly NativeRunGraphCapabilityGap[];
  readonly completeness: "partial" | "invalid";
}

function compareCreatedAtAndId(
  left: { readonly createdAtMs: number; readonly id: string },
  right: { readonly createdAtMs: number; readonly id: string },
): number {
  return left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id);
}

function compareAttempts(left: RunAttemptRecord, right: RunAttemptRecord): number {
  return left.ordinal - right.ordinal || compareCreatedAtAndId(left, right);
}

function branchParentCycle(
  branchId: string,
  branchesById: ReadonlyMap<string, ConversationBranchRecord>,
): boolean {
  const visited = new Set<string>();
  let current: string | null = branchId;
  while (current !== null) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = branchesById.get(current)?.parentBranchId ?? null;
  }
  return false;
}

function duplicateIdCounts<T extends { readonly id: string }>(values: readonly T[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value.id, (counts.get(value.id) ?? 0) + 1);
  return counts;
}

function issue(
  code: NativeRunGraphIntegrityCode,
  message: string,
  details: Omit<NativeRunGraphIntegrityIssue, "code" | "message"> = {},
): NativeRunGraphIntegrityIssue {
  return Object.freeze({ code, message, ...details });
}

function gap(
  code: NativeRunGraphGapCode,
  message: string,
  details: Omit<NativeRunGraphCapabilityGap, "code" | "message"> = {},
): NativeRunGraphCapabilityGap {
  return Object.freeze({ code, message, ...details });
}

function pushUniqueGap(
  gaps: NativeRunGraphCapabilityGap[],
  next: NativeRunGraphCapabilityGap,
): void {
  if (
    gaps.some(
      (candidate) =>
        candidate.code === next.code &&
        candidate.runId === next.runId &&
        candidate.attemptId === next.attemptId,
    )
  ) {
    return;
  }
  gaps.push(next);
}

/**
 * Builds a renderer-safe projection of the durable native snapshot.
 *
 * The result is deterministic even when SQLite rows arrive in a different
 * order.  Integrity errors are reported, not repaired, so callers can show a
 * recovery/diagnostic state instead of attaching output to the wrong branch.
 */
export function projectNativeRunGraph(snapshot: ConversationSnapshot): NativeRunGraphProjection {
  const conversation = snapshot.conversation;
  const integrityIssues: NativeRunGraphIntegrityIssue[] = [];
  const capabilityGaps: NativeRunGraphCapabilityGap[] = [];
  const branchesById = new Map<string, ConversationBranchRecord>();
  const messagesById = new Map<string, MessageRecord>();
  const runsById = new Map<string, RunRecord>();
  const attemptsByRunId = new Map<string, RunAttemptRecord[]>();
  const branchIdCounts = duplicateIdCounts(snapshot.branches);
  const messageIdCounts = duplicateIdCounts(snapshot.messages);
  const runIdCounts = duplicateIdCounts(snapshot.runs);
  const attemptIdCounts = duplicateIdCounts(snapshot.attempts);

  const nodes: NativeRunGraphNode[] = [];
  const projectId = conversation.projectId;
  const root: NativeRunGraphNode = projectId
    ? Object.freeze({
        id: projectId,
        kind: "project",
        parentId: null,
        ordinal: 0,
        createdAtMs: conversation.createdAtMs,
      })
    : Object.freeze({
        id: conversation.id,
        kind: "conversation",
        parentId: null,
        ordinal: 0,
        createdAtMs: conversation.createdAtMs,
      });
  nodes.push(root);

  // A project-scoped graph still needs an explicit conversation node.  The
  // project is the scope root; the conversation is the parent of branches.
  if (projectId) {
    nodes.push(
      Object.freeze({
        id: conversation.id,
        kind: "conversation",
        parentId: projectId,
        ordinal: 0,
        createdAtMs: conversation.createdAtMs,
      }),
    );
  }

  if (!snapshot.branches.some((branch) => branch.id === conversation.activeBranchId)) {
    integrityIssues.push(
      issue(
        "active-branch-missing",
        "The conversation active branch is absent from the native snapshot.",
        { branchId: conversation.activeBranchId },
      ),
    );
  }

  const orderedBranches = [...snapshot.branches].sort(compareCreatedAtAndId);
  for (const branch of orderedBranches) {
    if (!branchesById.has(branch.id)) branchesById.set(branch.id, branch);
  }

  for (const branch of orderedBranches) {
    if (branchesById.get(branch.id) !== branch) continue;
    if ((branchIdCounts.get(branch.id) ?? 0) > 1) {
      integrityIssues.push(
        issue("branch-duplicate", "The native snapshot contains a duplicate branch ID.", {
          branchId: branch.id,
        }),
      );
    }
    if (branch.conversationId !== conversation.id) {
      integrityIssues.push(
        issue(
          "branch-conversation-mismatch",
          "A branch belongs to a different conversation.",
          { branchId: branch.id },
        ),
      );
    }
    const parentBranch =
      branch.parentBranchId === null ? null : branchesById.get(branch.parentBranchId);
    if (branch.parentBranchId !== null && parentBranch === undefined) {
      integrityIssues.push(
        issue("branch-parent-missing", "A branch references a missing parent branch.", {
          branchId: branch.id,
        }),
      );
    }
    if (branch.parentBranchId === branch.id || branchParentCycle(branch.id, branchesById)) {
      integrityIssues.push(
        issue("branch-parent-cycle", "Conversation branch ancestry contains a cycle.", {
          branchId: branch.id,
        }),
      );
    }
    nodes.push(
      Object.freeze({
        id: branch.id,
        kind: "branch",
        // Root branches belong to the conversation. A missing or foreign
        // parent is left detached instead of being silently re-parented to the
        // conversation root; consumers must treat the projection as invalid.
        parentId:
          branch.parentBranchId === null
            ? branch.conversationId === conversation.id
              ? conversation.id
              : null
            : parentBranch != null &&
                parentBranch.conversationId === conversation.id &&
                branch.conversationId === conversation.id
              ? branch.parentBranchId
              : null,
        ordinal: nodes.filter((node) => node.kind === "branch").length,
        createdAtMs: branch.createdAtMs,
      }),
    );
  }

  for (const message of [...snapshot.messages].sort(compareCreatedAtAndId)) {
    if (messagesById.has(message.id)) {
      continue;
    }
    if ((messageIdCounts.get(message.id) ?? 0) > 1) {
      integrityIssues.push(
        issue("message-duplicate", "The native snapshot contains a duplicate message ID.", {
          messageId: message.id,
        }),
      );
    }
    messagesById.set(message.id, message);
    if (message.conversationId !== conversation.id) {
      integrityIssues.push(
        issue(
          "message-conversation-mismatch",
          "A message belongs to a different conversation.",
          { messageId: message.id },
        ),
      );
    }
    if (!branchesById.has(message.branchId)) {
      integrityIssues.push(
        issue("message-branch-missing", "A message references a branch absent from the snapshot.", {
          messageId: message.id,
          branchId: message.branchId,
        }),
      );
    }
    nodes.push(
      Object.freeze({
        id: message.id,
        kind: "message",
        parentId:
          message.conversationId === conversation.id &&
          branchesById.get(message.branchId)?.conversationId === conversation.id
            ? message.branchId
            : null,
        ordinal: message.sequenceNo,
        createdAtMs: message.createdAtMs,
      }),
    );
  }

  for (const run of [...snapshot.runs].sort(compareCreatedAtAndId)) {
    if (runsById.has(run.id)) {
      continue;
    }
    if ((runIdCounts.get(run.id) ?? 0) > 1) {
      integrityIssues.push(
        issue("run-duplicate", "The native snapshot contains a duplicate run ID.", {
          runId: run.id,
        }),
      );
    }
    runsById.set(run.id, run);
    if (run.conversationId !== conversation.id) {
      integrityIssues.push(
        issue("run-conversation-mismatch", "A run belongs to a different conversation.", {
          runId: run.id,
        }),
      );
    }
    const runBranch = branchesById.get(run.branchId);
    if (runBranch === undefined) {
      integrityIssues.push(
        issue("run-branch-missing", "A run references a branch absent from the snapshot.", {
          runId: run.id,
          branchId: run.branchId,
        }),
      );
    } else if (runBranch.conversationId !== run.conversationId) {
      integrityIssues.push(
        issue("run-branch-mismatch", "A run branch belongs to a different conversation.", {
          runId: run.id,
          branchId: run.branchId,
        }),
      );
    }
    if (run.assistantMessageId === null) {
      integrityIssues.push(
        issue("run-assistant-missing", "A run does not reference its assistant message.", {
          runId: run.id,
        }),
      );
    } else {
      const assistant = messagesById.get(run.assistantMessageId);
      if (
        assistant === undefined ||
        assistant.conversationId !== run.conversationId ||
        assistant.branchId !== run.branchId ||
        !branchesById.has(run.branchId) ||
        assistant.role !== "assistant"
      ) {
        integrityIssues.push(
          issue(
            "run-assistant-mismatch",
            "A run assistant message is missing or does not belong to the run branch.",
            { runId: run.id, messageId: run.assistantMessageId },
          ),
        );
      }
    }
    const userMessage = run.userMessageId === null ? undefined : messagesById.get(run.userMessageId);
    if (
      userMessage === undefined ||
      userMessage.conversationId !== run.conversationId ||
      userMessage.branchId !== run.branchId ||
      userMessage.role !== "user"
    ) {
      integrityIssues.push(
        issue("run-user-mismatch", "A run user message is missing or does not belong to the run branch.", {
          runId: run.id,
          ...(run.userMessageId === null ? {} : { messageId: run.userMessageId }),
        }),
      );
    }
    nodes.push(
      Object.freeze({
        id: run.id,
        kind: "run",
        parentId:
          run.conversationId === conversation.id &&
          runBranch?.conversationId === conversation.id
            ? run.branchId
            : null,
        ordinal: 0,
        createdAtMs: run.createdAtMs,
      }),
    );
    pushUniqueGap(
      capabilityGaps,
      gap(
        "context-snapshot",
        "The native run DTO does not expose the frozen context snapshot ID or provenance hashes.",
        { runId: run.id },
      ),
    );
    pushUniqueGap(
      capabilityGaps,
      gap(
        "execution-environment",
        "The native run DTO does not expose the selected execution environment.",
        { runId: run.id },
      ),
    );
  }

  const seenAttemptIds = new Set<string>();
  const reportedAttemptDuplicates = new Set<string>();
  for (const attempt of [...snapshot.attempts].sort(compareAttempts)) {
    if ((attemptIdCounts.get(attempt.id) ?? 0) > 1) {
      if (!reportedAttemptDuplicates.has(attempt.id)) {
        integrityIssues.push(
          issue("attempt-duplicate", "The native snapshot contains a duplicate attempt ID.", {
            runId: attempt.generationId,
            attemptId: attempt.id,
          }),
        );
        reportedAttemptDuplicates.add(attempt.id);
      }
    }
    if (seenAttemptIds.has(attempt.id)) continue;
    seenAttemptIds.add(attempt.id);
    if (attemptsByRunId.has(attempt.generationId)) {
      attemptsByRunId.get(attempt.generationId)?.push(attempt);
    } else {
      attemptsByRunId.set(attempt.generationId, [attempt]);
    }
    const run = runsById.get(attempt.generationId);
    if (!run) {
      integrityIssues.push(
        issue("attempt-run-missing", "An attempt references a run absent from the snapshot.", {
          attemptId: attempt.id,
        }),
      );
    }
    nodes.push(
      Object.freeze({
        id: attempt.id,
        kind: "attempt",
        parentId: run ? run.id : null,
        ordinal: attempt.ordinal,
        createdAtMs: attempt.createdAtMs,
      }),
    );
  }

  for (const [runId, attempts] of attemptsByRunId) {
    const seenOrdinals = new Set<number>();
    for (const attempt of attempts) {
      if (!Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1) {
        integrityIssues.push(
          issue("attempt-ordinal-invalid", "Attempt ordinals must be positive safe integers.", {
            runId,
            attemptId: attempt.id,
          }),
        );
      }
      if (seenOrdinals.has(attempt.ordinal)) {
        integrityIssues.push(
          issue("attempt-ordinal-gap", "Attempt ordinals must be unique and contiguous.", {
            runId,
            attemptId: attempt.id,
          }),
        );
      }
      seenOrdinals.add(attempt.ordinal);
    }
    const expectedOrdinals = attempts.map((attempt) => attempt.ordinal);
    for (let index = 0; index < expectedOrdinals.length; index += 1) {
      if (expectedOrdinals[index] !== index + 1) {
        integrityIssues.push(
          issue("attempt-ordinal-gap", "Attempt ordinals are not contiguous from one.", {
            runId,
          }),
        );
        break;
      }
    }
  }

  const runOrdinalsByBranch = new Map<string, number>();
  for (const run of [...runsById.values()].sort(compareCreatedAtAndId)) {
    const runOrdinal = runOrdinalsByBranch.get(run.branchId) ?? 0;
    runOrdinalsByBranch.set(run.branchId, runOrdinal + 1);
    const runNode = nodes.find((node) => node.kind === "run" && node.id === run.id);
    if (runNode !== undefined) {
      const index = nodes.indexOf(runNode);
      nodes[index] = Object.freeze({ ...runNode, ordinal: runOrdinal });
    }
    const attempts = Object.freeze([...(attemptsByRunId.get(run.id) ?? [])].sort(compareAttempts));
    if (attempts.length === 0) {
      integrityIssues.push(
        issue("run-attempt-missing", "A persisted run has no provider attempt.", { runId: run.id }),
      );
    }
  }

  pushUniqueGap(
    capabilityGaps,
    gap("task", "The native conversation snapshot has no durable task/thread node."),
  );
  pushUniqueGap(
    capabilityGaps,
    gap("iteration", "The native conversation snapshot has no agentic iteration nodes."),
  );
  pushUniqueGap(
    capabilityGaps,
    gap("item-event", "The native conversation snapshot has no item/event journal or cursor."),
  );
  pushUniqueGap(
    capabilityGaps,
    gap("event-journal", "Run events are not included in the native conversation snapshot."),
  );

  const lineages = [...runsById.values()]
    .sort(compareCreatedAtAndId)
    .map((run) =>
      Object.freeze({
        run,
        branch: branchesById.get(run.branchId) ?? null,
        userMessage: (() => {
          if (run.userMessageId === null) return null;
          const message = messagesById.get(run.userMessageId);
          return message !== undefined &&
            message.conversationId === run.conversationId &&
            message.branchId === run.branchId &&
            message.role === "user"
            ? message
            : null;
        })(),
        assistantMessage: (() => {
          if (run.assistantMessageId === null) return null;
          const assistant = messagesById.get(run.assistantMessageId);
          return assistant !== undefined &&
            assistant.conversationId === run.conversationId &&
            assistant.branchId === run.branchId &&
            branchesById.has(run.branchId) &&
            assistant.role === "assistant"
            ? assistant
            : null;
        })(),
        attempts: Object.freeze([...(attemptsByRunId.get(run.id) ?? [])].sort(compareAttempts)),
      }),
    );

  const hasIntegrityErrors = integrityIssues.length > 0;
  return Object.freeze({
    conversationId: conversation.id,
    projectId,
    root,
    nodes: Object.freeze(nodes),
    lineages: Object.freeze(lineages),
    integrityIssues: Object.freeze(integrityIssues),
    capabilityGaps: Object.freeze(capabilityGaps),
    completeness: hasIntegrityErrors ? "invalid" : "partial",
  });
}
