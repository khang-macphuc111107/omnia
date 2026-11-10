import { redactDiagnosticText } from "./diagnostics-session-contract";
import {
  BACKGROUND_WORK_BOUNDARY,
  type BackgroundWorkItem,
  type BackgroundWorkProjection,
} from "./background-work-projection";

export type BackgroundWorkExportFormat = "json" | "markdown";

export const BACKGROUND_WORK_EXPORT_FORMAT = "omnia.background-work.preview.v1" as const;
export const BACKGROUND_WORK_EXPORT_SCOPE = "renderer-session" as const;
export const BACKGROUND_WORK_EXPORT_VERSION = 1 as const;

export const BACKGROUND_WORK_EXPORT_BOUNDARY =
  `${BACKGROUND_WORK_BOUNDARY} Exporting this view does not create a durable queue, task, agent, scheduler, or native export receipt.`;

interface SafeBackgroundWorkItem {
  readonly id: string;
  readonly kind: BackgroundWorkItem["kind"];
  readonly state: BackgroundWorkItem["state"];
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string | null;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly updatedAt: string;
  readonly durability: BackgroundWorkItem["durability"];
  readonly attention: boolean;
  readonly actions: readonly BackgroundWorkItem["actions"][number][];
}

function safeText(value: string, maxLength: number): string {
  return redactDiagnosticText(value).slice(0, maxLength);
}

function safeNullableText(value: string | null, maxLength: number): string | null {
  return value === null ? null : safeText(value, maxLength);
}

function safeItem(item: BackgroundWorkItem): SafeBackgroundWorkItem {
  return {
    id: safeText(item.id, 180),
    kind: item.kind,
    state: item.state,
    title: safeText(item.title, 240),
    subtitle: safeText(item.subtitle, 240),
    detail: safeNullableText(item.detail, 2_000),
    conversationId: safeNullableText(item.conversationId, 180),
    runId: safeNullableText(item.runId, 180),
    updatedAt: safeText(item.updatedAt, 80),
    durability: item.durability,
    attention: item.attention,
    actions: item.actions.slice(),
  };
}

function markdownValue(value: string | null): string {
  return value === null
    ? "Not retained"
    : value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdownCount(label: string, value: number): string {
  return `- ${label}: ${value}`;
}

/**
 * Serializes the canonical background-work projection without turning its
 * renderer facts into authority. This is intentionally a copy/download
 * preview until a native export command and durable receipt exist.
 */
export function serializeBackgroundWorkExport(input: {
  readonly projection: BackgroundWorkProjection;
  readonly format: BackgroundWorkExportFormat;
  readonly generatedAt?: string;
}): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const projection = input.projection;
  const items = projection.items.map(safeItem);

  if (input.format === "json") {
    return JSON.stringify(
      {
        format: BACKGROUND_WORK_EXPORT_FORMAT,
        version: BACKGROUND_WORK_EXPORT_VERSION,
        scope: BACKGROUND_WORK_EXPORT_SCOPE,
        generatedAt,
        boundary: BACKGROUND_WORK_EXPORT_BOUNDARY,
        projection: {
          schemaVersion: projection.schemaVersion,
          generatedAt: projection.generatedAt,
          counts: projection.counts,
          missingCapabilities: projection.missingCapabilities.map((value) => safeText(value, 240)),
          items,
        },
      },
      null,
      2,
    );
  }

  const counts = projection.counts;
  const missingCapabilities = projection.missingCapabilities.map((value) => safeText(value, 240));
  const itemSections = items.flatMap((item) => [
    `### ${markdownValue(item.title)}`,
    "",
    `- State: ${item.state}`,
    `- Kind: ${item.kind}`,
    `- Subtitle: ${markdownValue(item.subtitle)}`,
    `- Detail: ${markdownValue(item.detail)}`,
    `- Durability: ${item.durability}`,
    `- Attention: ${item.attention ? "yes" : "no"}`,
    `- Updated: ${markdownValue(item.updatedAt)}`,
    `- Run: ${markdownValue(item.runId)}`,
    `- Conversation: ${markdownValue(item.conversationId)}`,
    `- Actions: ${item.actions.length > 0 ? item.actions.join(", ") : "None"}`,
    `- Item ID: ${markdownValue(item.id)}`,
    "",
  ]);

  return [
    "# Omnia background work preview",
    "",
    `> ${BACKGROUND_WORK_EXPORT_BOUNDARY}`,
    "",
    `- Generated: ${markdownValue(generatedAt)}`,
    `- Projection generated: ${markdownValue(projection.generatedAt)}`,
    markdownCount("Total", counts.total),
    markdownCount("Active", counts.active),
    markdownCount("Queued", counts.queued),
    markdownCount("Waiting", counts.waiting),
    markdownCount("Attention", counts.attention),
    markdownCount("Completed", counts.completed),
    "",
    "## Missing capabilities",
    "",
    ...(missingCapabilities.length > 0
      ? missingCapabilities.map((value) => `- ${markdownValue(value)}`)
      : ["- None reported"]),
    "",
    "## Items",
    "",
    ...(itemSections.length > 0 ? itemSections : ["No background-work items are visible in this projection.", ""]),
  ].join("\n");
}

export function downloadBackgroundWorkExport(
  payload: string,
  format: BackgroundWorkExportFormat,
): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(
    new Blob([payload], {
      type: format === "json" ? "application/json" : "text/markdown",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-background-work-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return true;
}
