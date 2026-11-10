export type ApprovalOperation =
  | "read-workspace"
  | "write-project"
  | "run-command"
  | "call-provider"
  | "control-browser"
  | "use-secret"
  | "delete-artifact";

export type ApprovalScope = "once" | "task" | "session" | "project" | "exact-target" | "signed-workflow";
export type ApprovalExpiry = "single-use" | "15-minutes" | "1-hour" | "session-end" | "project-end" | "custom";
export type ApprovalSandbox = "no-machine" | "read-only" | "workspace-write" | "isolated-filesystem" | "container" | "vm";
export type ApprovalNetwork = "offline" | "allowlisted" | "public-https";
export type ApprovalSecrets = "blocked" | "opaque-reference" | "prompt-each-use";
export type ApprovalReviewState = "draft" | "needs-review" | "staged" | "revoked";

export interface ApprovalRequestDraft {
  readonly operation: ApprovalOperation;
  readonly target: string;
  readonly rationale: string;
  readonly scope: ApprovalScope;
  readonly expiry: ApprovalExpiry;
  readonly customExpiry: string;
  readonly sandbox: ApprovalSandbox;
  readonly network: ApprovalNetwork;
  readonly secrets: ApprovalSecrets;
  readonly state: ApprovalReviewState;
}

export interface ApprovalRequestPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tone: "blue" | "mint" | "amber" | "coral";
  readonly values: Omit<ApprovalRequestDraft, "state">;
}

export const APPROVAL_REQUEST_SCHEMA = "omnia.approval-request.preview.v1" as const;
export const APPROVAL_REQUEST_VERSION = 1 as const;
export const APPROVAL_REQUEST_BOUNDARY =
  "Renderer-local approval rehearsal only; no native grant, approval receipt, sandbox launch, secret lookup, provider request, or execution was performed." as const;

export const APPROVAL_OPERATION_LABELS: Record<ApprovalOperation, string> = {
  "read-workspace": "Read workspace files",
  "write-project": "Write project files",
  "run-command": "Run a terminal command",
  "call-provider": "Call a provider endpoint",
  "control-browser": "Control a browser",
  "use-secret": "Use an opaque secret reference",
  "delete-artifact": "Delete a project artifact",
};

export const APPROVAL_SCOPE_LABELS: Record<ApprovalScope, string> = {
  once: "Allow once",
  task: "For this task",
  session: "For this session",
  project: "For this project",
  "exact-target": "Exact target only",
  "signed-workflow": "Signed workflow",
};

export const APPROVAL_EXPIRY_LABELS: Record<ApprovalExpiry, string> = {
  "single-use": "Single use",
  "15-minutes": "15 minutes",
  "1-hour": "1 hour",
  "session-end": "Until session ends",
  "project-end": "Until project ends",
  custom: "Custom timestamp",
};

export const APPROVAL_SANDBOX_LABELS: Record<ApprovalSandbox, string> = {
  "no-machine": "No machine access",
  "read-only": "Read-only filesystem",
  "workspace-write": "Workspace write",
  "isolated-filesystem": "Isolated filesystem",
  container: "Container",
  vm: "Virtual machine",
};

export const APPROVAL_NETWORK_LABELS: Record<ApprovalNetwork, string> = {
  offline: "Offline",
  allowlisted: "Allowlisted destinations",
  "public-https": "Public HTTPS",
};

export const APPROVAL_SECRETS_LABELS: Record<ApprovalSecrets, string> = {
  blocked: "Blocked",
  "opaque-reference": "Opaque reference only",
  "prompt-each-use": "Prompt each use",
};

export const APPROVAL_STATE_LABELS: Record<ApprovalReviewState, string> = {
  draft: "Draft",
  "needs-review": "Needs review",
  staged: "Staged for review",
  revoked: "Revoked in preview",
};

const DEFAULT_APPROVAL_REQUEST_VALUES: Omit<ApprovalRequestDraft, "state"> = {
  operation: "read-workspace",
  target: "workspace://current-project",
  rationale: "Inspect files needed to answer the current request.",
  scope: "exact-target",
  expiry: "single-use",
  customExpiry: "",
  sandbox: "read-only",
  network: "offline",
  secrets: "blocked",
};

export const DEFAULT_APPROVAL_REQUEST: ApprovalRequestDraft = {
  ...DEFAULT_APPROVAL_REQUEST_VALUES,
  state: "draft",
};

export const APPROVAL_REQUEST_PRESETS: readonly ApprovalRequestPreset[] = [
  {
    id: "inspect",
    label: "Inspect safely",
    description: "Read the current project with no network or secret access.",
    tone: "blue",
    values: DEFAULT_APPROVAL_REQUEST_VALUES,
  },
  {
    id: "edit",
    label: "Review a patch",
    description: "Stage a project write inside a workspace boundary.",
    tone: "mint",
    values: {
      ...DEFAULT_APPROVAL_REQUEST_VALUES,
      operation: "write-project",
      target: "workspace://current-project/src",
      rationale: "Apply a reviewed patch to the selected project files.",
      scope: "exact-target",
      sandbox: "workspace-write",
    },
  },
  {
    id: "research",
    label: "Research route",
    description: "Preview an allowlisted provider route without secrets or execution.",
    tone: "amber",
    values: {
      ...DEFAULT_APPROVAL_REQUEST_VALUES,
      operation: "call-provider",
      target: "provider://approved-research-endpoint",
      rationale: "Fetch sources for the current research question.",
      scope: "task",
      expiry: "15-minutes",
      sandbox: "no-machine",
      network: "allowlisted",
    },
  },
  {
    id: "command",
    label: "Command review",
    description: "Show a high-risk command request with explicit isolation choices.",
    tone: "coral",
    values: {
      ...DEFAULT_APPROVAL_REQUEST_VALUES,
      operation: "run-command",
      target: "process://npm test -- --run focused",
      rationale: "Run a bounded focused check after the user reviews the command.",
      scope: "once",
      sandbox: "isolated-filesystem",
      network: "offline",
    },
  },
] as const;

export function approvalRequestEqual(left: ApprovalRequestDraft, right: ApprovalRequestDraft): boolean {
  return (
    left.operation === right.operation
    && left.target === right.target
    && left.rationale === right.rationale
    && left.scope === right.scope
    && left.expiry === right.expiry
    && left.customExpiry === right.customExpiry
    && left.sandbox === right.sandbox
    && left.network === right.network
    && left.secrets === right.secrets
    && left.state === right.state
  );
}

export function approvalRequestRisk(request: ApprovalRequestDraft): "low" | "medium" | "high" {
  if (request.operation === "delete-artifact" || request.operation === "use-secret" || request.operation === "control-browser" || request.operation === "run-command" || request.operation === "write-project") return "high";
  if (request.network === "public-https" || request.operation === "call-provider") return "medium";
  return "low";
}

export function approvalRequestReviewHint(request: ApprovalRequestDraft): string {
  if (request.state === "revoked") return "This draft was revoked in the preview and cannot be treated as an approval.";
  if (request.secrets === "prompt-each-use") return "Secret use still requires a fresh native decision; raw secret bytes never enter this preview.";
  if (request.operation === "delete-artifact") return "Destructive actions require an exact target, expiry, postcondition, and native confirmation.";
  if (request.network === "public-https") return "Public network access requires provider, destination, data-class, and native policy checks.";
  if (request.sandbox === "no-machine") return "No-machine is a preview label; it does not prove an OS isolation boundary.";
  return "Review the exact operation, target, policy revision, environment, and expiry before native promotion.";
}

export function approvalRequestValidation(request: ApprovalRequestDraft): readonly string[] {
  const errors: string[] = [];
  if (!request.target.trim()) errors.push("An exact target is required.");
  if (!request.rationale.trim()) errors.push("A rationale is required for review.");
  if (request.expiry === "custom" && !request.customExpiry) errors.push("Choose a custom expiry timestamp.");
  if (request.operation === "use-secret" && request.secrets === "blocked") errors.push("Secret use is blocked by the selected secret policy.");
  if (request.network === "public-https" && request.sandbox === "no-machine" && request.operation !== "call-provider") errors.push("Public HTTPS is only preview-compatible with a provider operation here.");
  return errors;
}

export function safeApprovalRequestPayload(request: ApprovalRequestDraft) {
  return {
    scope: APPROVAL_REQUEST_SCHEMA,
    version: APPROVAL_REQUEST_VERSION,
    request: {
      ...request,
      target: request.target.trim(),
      rationale: request.rationale.trim(),
    },
    risk: approvalRequestRisk(request),
    boundary: APPROVAL_REQUEST_BOUNDARY,
  } as const;
}

export function serializeApprovalRequest(request: ApprovalRequestDraft, format: "json" | "markdown"): string {
  const payload = safeApprovalRequestPayload(request);
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia approval request preview",
    "",
    `- Operation: ${APPROVAL_OPERATION_LABELS[request.operation]}`,
    `- Target: ${request.target.trim() || "(missing)"}`,
    `- Scope: ${APPROVAL_SCOPE_LABELS[request.scope]}`,
    `- Expiry: ${APPROVAL_EXPIRY_LABELS[request.expiry]}`,
    `- Sandbox: ${APPROVAL_SANDBOX_LABELS[request.sandbox]}`,
    `- Network: ${APPROVAL_NETWORK_LABELS[request.network]}`,
    `- Secrets: ${APPROVAL_SECRETS_LABELS[request.secrets]}`,
    `- Review state: ${APPROVAL_STATE_LABELS[request.state]}`,
    `- Risk signal: ${approvalRequestRisk(request)}`,
    "",
    `> ${APPROVAL_REQUEST_BOUNDARY}`,
  ].join("\n");
}
