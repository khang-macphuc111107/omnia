export type ExtensionPermissionGrantMode = "Allow" | "Ask every time" | "Deny";
export type ExtensionPermissionRisk = "low" | "medium" | "high" | "critical";
export type ExtensionPermissionScope = "operation" | "conversation" | "project" | "workspace";
export type ExtensionPermissionExpiry = "operation" | "session" | "project" | "manual";
export type ExtensionPermissionReviewState = "needs-review" | "reviewed";

export const EXTENSION_PERMISSION_REVIEW_SCHEMA = "omnia.extensions-mcp-permission-review.preview.v1" as const;
export const EXTENSION_PERMISSION_REVIEW_BOUNDARY =
  "Renderer-local permission review preview only; no native grant, approval receipt, provider request, process start, or durable policy write was performed." as const;

export const EXTENSION_PERMISSION_SCOPES: readonly ExtensionPermissionScope[] = [
  "operation",
  "conversation",
  "project",
  "workspace",
];

export const EXTENSION_PERMISSION_EXPIRIES: readonly ExtensionPermissionExpiry[] = [
  "operation",
  "session",
  "project",
  "manual",
];

export interface ExtensionPermissionRecordInput {
  readonly extensionId: string;
  readonly extensionName: string;
  readonly kind: string;
  readonly lifecycle: string;
  readonly trust: string;
  readonly capability: string;
  readonly effects: readonly string[];
  readonly grant: ExtensionPermissionGrantMode;
}

export interface ExtensionPermissionReviewDraft {
  readonly scope: ExtensionPermissionScope;
  readonly expiry: ExtensionPermissionExpiry;
  readonly rationale: string;
  readonly state: ExtensionPermissionReviewState;
}

export interface ExtensionPermissionReviewItem extends ExtensionPermissionRecordInput {
  readonly key: string;
  readonly risk: ExtensionPermissionRisk;
  readonly riskLabel: string;
  readonly review: ExtensionPermissionReviewDraft;
}

export interface ExtensionPermissionReviewExport {
  readonly schema: typeof EXTENSION_PERMISSION_REVIEW_SCHEMA;
  readonly version: 1;
  readonly scope: "renderer-session";
  readonly generatedAt: string;
  readonly items: readonly (ExtensionPermissionReviewItem & { readonly review: ExtensionPermissionReviewDraft })[];
  readonly boundary: typeof EXTENSION_PERMISSION_REVIEW_BOUNDARY;
}

const HIGH_RISK_PATTERN = /(?:write|process|execute|delete|admin|secret|credential|desktop|shell|install|spawn|network\.write|filesystem\.write)/i;
const MEDIUM_RISK_PATTERN = /(?:network|remote|upload|browser|workspace\.read|git|citation|search|read|inspect|references|definition)/i;

export function classifyExtensionPermissionRisk(capability: string, effects: readonly string[] = []): ExtensionPermissionRisk {
  const source = `${capability} ${effects.join(" ")}`;
  if (/(?:secret|credential|admin|desktop|shell|execute|spawn|delete)/i.test(source)) return "critical";
  if (HIGH_RISK_PATTERN.test(source)) return "high";
  if (MEDIUM_RISK_PATTERN.test(source)) return "medium";
  return "low";
}

export function extensionPermissionRiskLabel(risk: ExtensionPermissionRisk): string {
  if (risk === "critical") return "Critical";
  if (risk === "high") return "High";
  if (risk === "medium") return "Medium";
  return "Low";
}

export function defaultExtensionPermissionReview(risk: ExtensionPermissionRisk): ExtensionPermissionReviewDraft {
  return {
    scope: risk === "critical" || risk === "high" ? "operation" : "project",
    expiry: risk === "critical" || risk === "high" ? "operation" : "session",
    rationale: "Needs explicit review before native activation.",
    state: "needs-review",
  };
}

export function buildExtensionPermissionReviewItems(
  records: readonly ExtensionPermissionRecordInput[],
  reviews: Readonly<Record<string, ExtensionPermissionReviewDraft>> = {},
): ExtensionPermissionReviewItem[] {
  return records.map((record) => {
    const key = `${record.extensionId}:${record.capability}`;
    const risk = classifyExtensionPermissionRisk(record.capability, record.effects);
    return {
      ...record,
      key,
      risk,
      riskLabel: extensionPermissionRiskLabel(risk),
      review: reviews[key] ?? defaultExtensionPermissionReview(risk),
    };
  });
}

export function createExtensionPermissionReviewExport(items: readonly ExtensionPermissionReviewItem[], generatedAt = new Date().toISOString()): ExtensionPermissionReviewExport {
  return {
    schema: EXTENSION_PERMISSION_REVIEW_SCHEMA,
    version: 1,
    scope: "renderer-session",
    generatedAt,
    items: items.map((item) => ({ ...item, effects: [...item.effects], review: { ...item.review } })),
    boundary: EXTENSION_PERMISSION_REVIEW_BOUNDARY,
  };
}

export function serializeExtensionPermissionReview(items: readonly ExtensionPermissionReviewItem[], format: "json" | "markdown", generatedAt?: string): string {
  const payload = createExtensionPermissionReviewExport(items, generatedAt);
  if (format === "json") return JSON.stringify(payload, null, 2);
  const lines = [
    "# Omnia Extensions & MCP permission review preview",
    "",
    `- Scope: ${payload.scope}`,
    `- Items: ${payload.items.length}`,
    `- Reviewed: ${payload.items.filter((item) => item.review.state === "reviewed").length}`,
    `- High or critical risk: ${payload.items.filter((item) => item.risk === "high" || item.risk === "critical").length}`,
    "",
    ...payload.items.map((item) => `- **${item.extensionName}** · ${item.capability} · ${item.riskLabel} · ${item.grant} · ${item.review.scope} · ${item.review.expiry} · ${item.review.state}`),
    "",
    `> ${payload.boundary}`,
  ];
  return lines.join("\n");
}

export function normalizeExtensionPermissionReview(value: unknown, fallback: ExtensionPermissionReviewDraft): ExtensionPermissionReviewDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const candidate = value as Record<string, unknown>;
  const scope = EXTENSION_PERMISSION_SCOPES.includes(candidate.scope as ExtensionPermissionScope) ? candidate.scope as ExtensionPermissionScope : fallback.scope;
  const expiry = EXTENSION_PERMISSION_EXPIRIES.includes(candidate.expiry as ExtensionPermissionExpiry) ? candidate.expiry as ExtensionPermissionExpiry : fallback.expiry;
  const state = candidate.state === "reviewed" ? "reviewed" : candidate.state === "needs-review" ? "needs-review" : fallback.state;
  const rationale = typeof candidate.rationale === "string" ? candidate.rationale.trim().slice(0, 300) : fallback.rationale;
  return { scope, expiry, rationale, state };
}
