/**
 * Renderer-local contract for the Project Plan -> New Chat handoff.
 *
 * The desktop layer currently exposes Chat creation and draft staging as
 * separate calls. Keeping an explicit operation envelope here lets the UI
 * show an id, expected scope, and an honest partial outcome while a native
 * atomic command remains Planned.
 */

export const PLAN_CHAT_OPERATION_SCHEMA = "omnia.plan-chat-operation.preview.v1" as const;
export const PLAN_CHAT_OPERATION_TYPE = "project-plan.new-chat" as const;

export type PlanChatOperationPhase =
  | "ready"
  | "creating-chat"
  | "staging-draft"
  | "staged"
  | "partial"
  | "failed";

export type PlanChatOperationOutcome =
  | "pending"
  | "staged"
  | "chat-created-draft-failed"
  | "failed"
  | "rejected";

/**
 * The operation envelope is deliberately more explicit than a pair of UI
 * callbacks. These values describe the native command we would eventually
 * want to expose, while the browser preview still executes the two steps
 * sequentially and can only report a partial outcome.
 */
export interface PlanChatAtomicContractPreview {
  readonly steps: readonly ["create-chat", "stage-draft"];
  readonly destinationRule: "same-project";
  readonly draftRule: "empty-only";
  readonly partialFailurePolicy: "retain-chat-report-draft-failure";
  readonly nativeAtomicity: "planned";
}

export const PLAN_CHAT_ATOMIC_CONTRACT: PlanChatAtomicContractPreview = {
  steps: ["create-chat", "stage-draft"],
  destinationRule: "same-project",
  draftRule: "empty-only",
  partialFailurePolicy: "retain-chat-report-draft-failure",
  nativeAtomicity: "planned",
};

export interface PlanChatOperationPreview {
  readonly schema: typeof PLAN_CHAT_OPERATION_SCHEMA;
  readonly operationType: typeof PLAN_CHAT_OPERATION_TYPE;
  readonly operationId: string;
  readonly expectedProjectId: string;
  readonly expectedTaskId: string;
  /** No authoritative plan revision is available in the browser preview. */
  readonly expectedPlanRevisionId: string | null;
  readonly taskTitle: string;
  readonly draftLength: number;
  readonly draftHash: string;
  /** Zero for the source Plan text; non-zero when the editable draft is rebound. */
  readonly draftRevision: number;
  /** Stable across retries for the same Project/task/revision/draft intent. */
  readonly idempotencyKey: string;
  readonly atomicContract: PlanChatAtomicContractPreview;
  readonly phase: "ready";
  readonly outcome: "pending";
  readonly boundary: string;
}

export interface PlanChatOperationReceipt extends Omit<PlanChatOperationPreview, "phase" | "outcome"> {
  readonly phase: PlanChatOperationPhase;
  readonly outcome: PlanChatOperationOutcome;
  readonly conversationId: string | null;
  readonly createdChat: boolean;
  readonly draftStaged: boolean;
  readonly diagnostic: string | null;
}

export interface CreatePlanChatOperationInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly draft: string;
  readonly now?: number;
  readonly expectedPlanRevisionId?: string | null;
}

export interface PlanChatOperationResultDetails {
  readonly conversationId?: string | null;
  readonly diagnostic?: string | null;
}

export type PlanChatPreflightCheckState = "pass" | "review" | "blocked";

export interface PlanChatPreflightCheck {
  readonly id:
    | "operation-ready"
    | "same-project"
    | "same-task"
    | "draft-unchanged"
    | "destination-available"
    | "empty-target";
  readonly label: string;
  readonly state: PlanChatPreflightCheckState;
  readonly detail: string;
}

export interface PlanChatOperationPreflight {
  readonly status: "ready" | "review" | "blocked";
  readonly canProceed: boolean;
  readonly checks: readonly PlanChatPreflightCheck[];
  readonly blockingReason: string | null;
  readonly boundary: string;
}

export interface PlanChatOperationPreflightInput {
  /** The Project currently selected in the setup draft. */
  readonly currentProjectId?: string | null;
  /** The task identity currently being handed off, when available. */
  readonly currentTaskId?: string | null;
  /** The editable draft at the moment the user confirms. */
  readonly currentDraft?: string | null;
  /** Whether the destination Project is still present and selectable. */
  readonly destinationProjectExists?: boolean;
  /** Whether the destination Project became archived between review and confirm. */
  readonly destinationProjectArchived?: boolean;
  /** Existing target draft, if a host supplied one for a retry/rebind check. */
  readonly targetConversationDraft?: string | null;
}

export const PLAN_CHAT_OPERATION_BOUNDARY =
  "Renderer-local operation preview only; the current path is sequential; no atomic native receipt, durable idempotency, durable write, provider request, or run was created by this preview.";

const PLAN_CHAT_PREFLIGHT_BOUNDARY =
  "Renderer-local preflight only; it checks the visible intent before the sequential preview path and does not prove native transaction atomicity or durable idempotency.";

let operationSequence = 0;

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required for a Plan → Chat operation.`);
  return normalized;
}

/** A small deterministic fingerprint; it is not a security or authority hash. */
export function fingerprintPlanChatDraft(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildPlanChatIdempotencyKey(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly draft: string;
  readonly expectedPlanRevisionId?: string | null;
}): string {
  const projectId = requireText(input.projectId, "Project id");
  const taskId = requireText(input.taskId, "Task id");
  const draft = requireText(input.draft, "Chat draft");
  const revision = input.expectedPlanRevisionId?.trim() || "unversioned";
  const draftHash = fingerprintPlanChatDraft(draft);
  return `plan-chat-key-${fingerprintPlanChatDraft(`${projectId}\u001f${taskId}\u001f${revision}\u001f${draftHash}`).slice(-8)}`;
}

/**
 * Synchronously claims an intent key for this renderer session. This closes
 * same-tick duplicate UI submissions; it is not a native or durable
 * idempotency receipt, so native replay protection remains Planned.
 */
export function claimPlanChatIdempotencyKey(claimedKeys: Set<string>, idempotencyKey: string): boolean {
  const key = requireText(idempotencyKey, "Plan → Chat idempotency key");
  if (claimedKeys.has(key)) return false;
  claimedKeys.add(key);
  return true;
}

export function createPlanChatOperationPreview(input: CreatePlanChatOperationInput): PlanChatOperationPreview {
  const projectId = requireText(input.projectId, "Project id");
  const taskId = requireText(input.taskId, "Task id");
  const taskTitle = requireText(input.taskTitle, "Task title");
  const draft = requireText(input.draft, "Chat draft");
  const now = Number.isFinite(input.now) ? Math.max(0, Math.trunc(input.now!)) : Date.now();
  const draftHash = fingerprintPlanChatDraft(draft);
  operationSequence += 1;
  return {
    schema: PLAN_CHAT_OPERATION_SCHEMA,
    operationType: PLAN_CHAT_OPERATION_TYPE,
    operationId: `plan-chat-op-${now.toString(36)}-${draftHash.slice(-8)}-${operationSequence.toString(36)}`,
    expectedProjectId: projectId,
    expectedTaskId: taskId,
    expectedPlanRevisionId: input.expectedPlanRevisionId ?? null,
    taskTitle,
    draftLength: draft.length,
    draftHash,
    draftRevision: 0,
    idempotencyKey: buildPlanChatIdempotencyKey({
      projectId,
      taskId,
      draft,
      ...(input.expectedPlanRevisionId !== undefined ? { expectedPlanRevisionId: input.expectedPlanRevisionId } : {}),
    }),
    atomicContract: PLAN_CHAT_ATOMIC_CONTRACT,
    phase: "ready",
    outcome: "pending",
    boundary: PLAN_CHAT_OPERATION_BOUNDARY,
  };
}

/**
 * Rebinds an existing preview envelope to an edited task draft. The visual
 * operation remains the same user gesture, but its retry key and content
 * fingerprint must move with the draft so a retry can never replay stale
 * text by accident.
 */
export function refreshPlanChatOperationDraft(
  operation: PlanChatOperationPreview,
  draft: string,
): PlanChatOperationPreview {
  const normalizedDraft = requireText(draft, "Chat draft");
  const draftHash = fingerprintPlanChatDraft(normalizedDraft);
  return {
    ...operation,
    draftLength: normalizedDraft.length,
    draftHash,
    draftRevision: operation.draftRevision + 1,
    idempotencyKey: buildPlanChatIdempotencyKey({
      projectId: operation.expectedProjectId,
      taskId: operation.expectedTaskId,
      draft: normalizedDraft,
      ...(operation.expectedPlanRevisionId !== null ? { expectedPlanRevisionId: operation.expectedPlanRevisionId } : {}),
    }),
    phase: "ready",
    outcome: "pending",
  };
}

function defaults(operation: PlanChatOperationPreview): PlanChatOperationReceipt {
  return {
    ...operation,
    phase: "ready",
    outcome: "pending",
    conversationId: null,
    createdChat: false,
    draftStaged: false,
    diagnostic: null,
  };
}

export function createPlanChatOperationReceipt(operation: PlanChatOperationPreview): PlanChatOperationReceipt {
  return defaults(operation);
}

export function updatePlanChatOperationPhase(
  current: PlanChatOperationReceipt | PlanChatOperationPreview,
  phase: Extract<PlanChatOperationPhase, "creating-chat" | "staging-draft">,
): PlanChatOperationReceipt {
  const receipt = "conversationId" in current ? current : defaults(current);
  return { ...receipt, phase, outcome: "pending", diagnostic: null };
}

export function resolvePlanChatOperation(
  operation: PlanChatOperationPreview,
  outcome: Exclude<PlanChatOperationOutcome, "pending">,
  details: PlanChatOperationResultDetails = {},
): PlanChatOperationReceipt {
  const conversationId = details.conversationId ?? null;
  const createdChat = outcome === "staged" || outcome === "chat-created-draft-failed";
  const draftStaged = outcome === "staged";
  const phase: PlanChatOperationPhase = outcome === "staged"
    ? "staged"
    : outcome === "chat-created-draft-failed"
      ? "partial"
      : "failed";
  return {
    ...defaults(operation),
    phase,
    outcome,
    conversationId,
    createdChat,
    draftStaged,
    diagnostic: details.diagnostic ?? null,
  };
}

/**
 * Checks the intent that would be sent to a future native Project → Chat
 * command. Missing host facts are deliberately reported as `review` instead
 * of being treated as a successful precondition. This keeps retries from
 * silently replaying a stale task or draft while remaining useful in the
 * browser preview, where native authority is unavailable.
 */
export function evaluatePlanChatOperationPreflight(
  operation: PlanChatOperationPreview | PlanChatOperationReceipt,
  input: PlanChatOperationPreflightInput = {},
): PlanChatOperationPreflight {
  const checks: PlanChatPreflightCheck[] = [];
  const currentDraft = input.currentDraft;
  const operationReady = operation.phase === "ready" && operation.outcome === "pending";
  checks.push({
    id: "operation-ready",
    label: "Operation is ready",
    state: operationReady ? "pass" : "blocked",
    detail: operationReady
      ? "The preview envelope is waiting for explicit confirmation."
      : "This operation has already advanced or resolved and must not be replayed.",
  });

  const projectKnown = input.currentProjectId !== undefined;
  const projectMatches = projectKnown && input.currentProjectId === operation.expectedProjectId;
  checks.push({
    id: "same-project",
    label: "Project scope is unchanged",
    state: !projectKnown ? "review" : projectMatches ? "pass" : "blocked",
    detail: !projectKnown
      ? "The host did not provide the current Project identity."
      : projectMatches
        ? `Still targeting Project ${operation.expectedProjectId}.`
        : `Expected Project ${operation.expectedProjectId}, but the setup draft points elsewhere.`,
  });

  const taskKnown = input.currentTaskId !== undefined;
  const taskMatches = taskKnown && input.currentTaskId === operation.expectedTaskId;
  checks.push({
    id: "same-task",
    label: "Plan task identity is unchanged",
    state: !taskKnown ? "review" : taskMatches ? "pass" : "blocked",
    detail: !taskKnown
      ? "The renderer cannot revalidate the source task identity in this host path."
      : taskMatches
        ? `Still handing off task ${operation.expectedTaskId}.`
        : `Expected task ${operation.expectedTaskId}, but the visible task identity changed.`,
  });

  const draftKnown = typeof currentDraft === "string";
  const draftMatches = typeof currentDraft === "string"
    && currentDraft.trim().length > 0
    && fingerprintPlanChatDraft(currentDraft) === operation.draftHash
    && currentDraft.length === operation.draftLength;
  checks.push({
    id: "draft-unchanged",
    label: "Editable draft matches the reviewed intent",
    state: !draftKnown ? "review" : draftMatches ? "pass" : "blocked",
    detail: !draftKnown
      ? "The current draft was not supplied for fingerprint comparison."
      : draftMatches
        ? `Fingerprint ${operation.draftHash} still matches.`
        : "The draft changed or was cleared after the operation envelope was reviewed.",
  });

  const destinationKnown = input.destinationProjectExists !== undefined;
  const destinationAvailable = destinationKnown
    && input.destinationProjectExists === true
    && input.destinationProjectArchived !== true;
  checks.push({
    id: "destination-available",
    label: "Destination Project is available",
    state: !destinationKnown ? "review" : destinationAvailable ? "pass" : "blocked",
    detail: !destinationKnown
      ? "Destination availability was not supplied by the host."
      : destinationAvailable
        ? "The destination remains selectable in this preview."
        : input.destinationProjectArchived
          ? "The destination Project is archived and cannot receive this Chat."
          : "The destination Project is missing or unavailable.",
  });

  const targetKnown = typeof input.targetConversationDraft === "string";
  const targetEmpty = targetKnown && input.targetConversationDraft.trim().length === 0;
  checks.push({
    id: "empty-target",
    label: "Target Chat draft is empty",
    state: !targetKnown ? "review" : targetEmpty ? "pass" : "blocked",
    detail: !targetKnown
      ? "A future native host must confirm that the destination Chat is empty."
      : targetEmpty
        ? "The empty-only staging precondition holds for the supplied target."
        : "The destination Chat already has a draft; staging would overwrite user text.",
  });

  const blocked = checks.filter((check) => check.state === "blocked");
  const status = blocked.length > 0
    ? "blocked"
    : checks.some((check) => check.state === "review")
      ? "review"
      : "ready";
  return {
    status,
    canProceed: status === "ready",
    checks,
    blockingReason: blocked[0]?.detail ?? null,
    boundary: PLAN_CHAT_PREFLIGHT_BOUNDARY,
  };
}
