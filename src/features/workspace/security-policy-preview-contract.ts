export type SecurityProfileId = "balanced" | "developer" | "lockdown" | "explore-all";
export type SecurityConfirmation = "high-risk" | "side-effects" | "every-operation";
export type SecurityUnknownOperation = "deny" | "prompt" | "preview-allow";
export type SecurityNetworkMode = "approved-hosts" | "public-https" | "offline";
export type SecurityFilesystemMode = "approved-roots" | "workspace-roots" | "preview-all";
export type SecuritySecretMode = "opaque-reference" | "prompt-each-use" | "blocked";
export type SecurityTelemetryMode = "redacted" | "minimal" | "off";
export type SecurityDesktopMode = "blocked" | "prompt" | "preview-only";

export interface SecurityPolicyDraft {
  readonly profile: SecurityProfileId;
  readonly confirmation: SecurityConfirmation;
  readonly unknownOperations: SecurityUnknownOperation;
  readonly network: SecurityNetworkMode;
  readonly filesystem: SecurityFilesystemMode;
  readonly secrets: SecuritySecretMode;
  readonly telemetry: SecurityTelemetryMode;
  readonly desktop: SecurityDesktopMode;
}

export interface SecurityPolicyDiffEntry {
  readonly key: keyof SecurityPolicyDraft;
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export interface SecurityPolicyProfileComparison {
  readonly leftProfile: SecurityProfileId;
  readonly rightProfile: SecurityProfileId;
  readonly differences: readonly SecurityPolicyDiffEntry[];
  readonly leftReviewSignals: number;
  readonly rightReviewSignals: number;
  readonly leftFailClosedGates: number;
  readonly rightFailClosedGates: number;
}

export const SECURITY_POLICY_SCHEMA = "omnia.security-policy.preview.v1" as const;
export const SECURITY_POLICY_VERSION = 1 as const;
export const SECURITY_POLICY_BOUNDARY =
  "Renderer-local security policy preview only; it does not grant native authority, call a provider, persist policy, read secrets, change OS permissions, or authorize execution." as const;

export const SECURITY_PROFILE_LABELS: Record<SecurityProfileId, string> = {
  balanced: "Balanced guardrails",
  developer: "Developer sandbox",
  lockdown: "Lockdown",
  "explore-all": "Explore all (visual)",
};

export const SECURITY_PROFILE_DESCRIPTIONS: Record<SecurityProfileId, string> = {
  balanced: "Ask for side effects, fail closed on unknown operations, and keep data routes scoped.",
  developer: "Keep high-risk confirmation and redacted telemetry while allowing broader research routes.",
  lockdown: "Block secrets, desktop automation, network, and unknown operations until reviewed.",
  "explore-all": "Render the most permissive shape for UI exploration; it is never an effective grant.",
};

export const SECURITY_POLICY_PROFILES: Readonly<Record<SecurityProfileId, SecurityPolicyDraft>> = {
  balanced: {
    profile: "balanced",
    confirmation: "side-effects",
    unknownOperations: "deny",
    network: "approved-hosts",
    filesystem: "approved-roots",
    secrets: "opaque-reference",
    telemetry: "redacted",
    desktop: "blocked",
  },
  developer: {
    profile: "developer",
    confirmation: "high-risk",
    unknownOperations: "prompt",
    network: "public-https",
    filesystem: "workspace-roots",
    secrets: "prompt-each-use",
    telemetry: "redacted",
    desktop: "prompt",
  },
  lockdown: {
    profile: "lockdown",
    confirmation: "every-operation",
    unknownOperations: "deny",
    network: "offline",
    filesystem: "approved-roots",
    secrets: "blocked",
    telemetry: "off",
    desktop: "blocked",
  },
  "explore-all": {
    profile: "explore-all",
    confirmation: "high-risk",
    unknownOperations: "preview-allow",
    network: "public-https",
    filesystem: "preview-all",
    secrets: "prompt-each-use",
    telemetry: "minimal",
    desktop: "preview-only",
  },
};

export const DEFAULT_SECURITY_POLICY: SecurityPolicyDraft = SECURITY_POLICY_PROFILES.balanced;

const SECURITY_POLICY_FIELDS: ReadonlyArray<readonly [keyof SecurityPolicyDraft, string]> = [
  ["profile", "Profile"],
  ["confirmation", "Confirmation"],
  ["unknownOperations", "Unknown operations"],
  ["network", "Network"],
  ["filesystem", "Filesystem"],
  ["secrets", "Secrets"],
  ["telemetry", "Telemetry"],
  ["desktop", "Desktop automation"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const values = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;

export function normalizeSecurityPolicy(value: Partial<SecurityPolicyDraft> | undefined): SecurityPolicyDraft {
  const source = value ?? {};
  const profile = values(source.profile, ["balanced", "developer", "lockdown", "explore-all"] as const, DEFAULT_SECURITY_POLICY.profile);
  const fallback = SECURITY_POLICY_PROFILES[profile];
  return {
    profile,
    confirmation: values(source.confirmation, ["high-risk", "side-effects", "every-operation"] as const, fallback.confirmation),
    unknownOperations: values(source.unknownOperations, ["deny", "prompt", "preview-allow"] as const, fallback.unknownOperations),
    network: values(source.network, ["approved-hosts", "public-https", "offline"] as const, fallback.network),
    filesystem: values(source.filesystem, ["approved-roots", "workspace-roots", "preview-all"] as const, fallback.filesystem),
    secrets: values(source.secrets, ["opaque-reference", "prompt-each-use", "blocked"] as const, fallback.secrets),
    telemetry: values(source.telemetry, ["redacted", "minimal", "off"] as const, fallback.telemetry),
    desktop: values(source.desktop, ["blocked", "prompt", "preview-only"] as const, fallback.desktop),
  };
}

export function securityPolicyEqual(left: SecurityPolicyDraft, right: SecurityPolicyDraft): boolean {
  return SECURITY_POLICY_FIELDS.every(([key]) => left[key] === right[key]);
}

export function securityPolicyDiff(before: SecurityPolicyDraft, after: SecurityPolicyDraft): readonly SecurityPolicyDiffEntry[] {
  return SECURITY_POLICY_FIELDS.flatMap(([key, label]) => {
    const previous = String(before[key]);
    const next = String(after[key]);
    return previous === next ? [] : [{ key, label, before: previous, after: next }];
  });
}

export function compareSecurityPolicyProfiles(
  leftProfile: SecurityProfileId,
  rightProfile: SecurityProfileId,
): SecurityPolicyProfileComparison {
  const left = SECURITY_POLICY_PROFILES[leftProfile];
  const right = SECURITY_POLICY_PROFILES[rightProfile];
  return {
    leftProfile,
    rightProfile,
    differences: securityPolicyDiff(left, right),
    leftReviewSignals: securityPolicyRiskCount(left),
    rightReviewSignals: securityPolicyRiskCount(right),
    leftFailClosedGates: securityPolicyGateCount(left),
    rightFailClosedGates: securityPolicyGateCount(right),
  };
}

export function securityPolicyRiskCount(policy: SecurityPolicyDraft): number {
  return [
    policy.unknownOperations === "preview-allow",
    policy.network === "public-https",
    policy.filesystem === "preview-all",
    policy.secrets === "prompt-each-use",
    policy.desktop !== "blocked",
  ].filter(Boolean).length;
}

export function securityPolicyGateCount(policy: SecurityPolicyDraft): number {
  return [
    policy.confirmation === "every-operation",
    policy.unknownOperations === "deny",
    policy.network === "offline",
    policy.secrets === "blocked",
    policy.desktop === "blocked",
  ].filter(Boolean).length;
}

export function securityPolicyStatusLabel(policy: SecurityPolicyDraft): string {
  if (policy.profile === "explore-all") return "Visual exploration only";
  if (policy.profile === "lockdown") return "Fail-closed preview";
  if (securityPolicyRiskCount(policy) >= 3) return "Needs review";
  return "Guarded preview";
}

export function securityPolicyFieldLabel(key: keyof SecurityPolicyDraft, value: string): string {
  const labels: Record<keyof SecurityPolicyDraft, Record<string, string>> = {
    profile: SECURITY_PROFILE_LABELS,
    confirmation: { "high-risk": "High-risk only", "side-effects": "Side effects", "every-operation": "Every operation" },
    unknownOperations: { deny: "Deny unknown", prompt: "Prompt on unknown", "preview-allow": "Allow in preview" },
    network: { "approved-hosts": "Approved hosts", "public-https": "Public HTTPS", offline: "Offline" },
    filesystem: { "approved-roots": "Approved roots", "workspace-roots": "Workspace roots", "preview-all": "All paths (preview)" },
    secrets: { "opaque-reference": "Opaque references", "prompt-each-use": "Prompt each use", blocked: "Blocked" },
    telemetry: { redacted: "Redacted", minimal: "Minimal", off: "Off" },
    desktop: { blocked: "Blocked", prompt: "Prompt", "preview-only": "Preview only" },
  };
  return labels[key][value] ?? value;
}

export function safeSecurityPolicyPayload(policy: SecurityPolicyDraft) {
  return {
    scope: SECURITY_POLICY_SCHEMA,
    version: SECURITY_POLICY_VERSION,
    policy: normalizeSecurityPolicy(policy),
    status: securityPolicyStatusLabel(policy),
    boundary: SECURITY_POLICY_BOUNDARY,
  } as const;
}

export function serializeSecurityPolicy(policy: SecurityPolicyDraft, format: "json" | "markdown"): string {
  const payload = safeSecurityPolicyPayload(policy);
  if (format === "json") return JSON.stringify(payload, null, 2);
  const rows = SECURITY_POLICY_FIELDS.map(([key, label]) => `| ${label} | ${securityPolicyFieldLabel(key, String(policy[key]))} |`).join("\n");
  return [
    "# Omnia security policy preview",
    "",
    `- Profile: ${SECURITY_PROFILE_LABELS[policy.profile]}`,
    `- Status: ${securityPolicyStatusLabel(policy)}`,
    `- Boundary: ${SECURITY_POLICY_BOUNDARY}`,
    "",
    "| Control | Preview value |",
    "| --- | --- |",
    rows,
    "",
    "> This export is renderer-local and is not a native security policy or approval receipt.",
  ].join("\n");
}

export function parseSecurityPolicyPreview(raw: string): SecurityPolicyDraft | null {
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!isRecord(parsed) || parsed.scope !== SECURITY_POLICY_SCHEMA || parsed.version !== SECURITY_POLICY_VERSION || !isRecord(parsed.policy)) return null;
    return normalizeSecurityPolicy(parsed.policy as Partial<SecurityPolicyDraft>);
  } catch {
    return null;
  }
}
