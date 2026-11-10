import { redactDiagnosticText } from "./diagnostics-session-contract";
import type { RunTimelineEventView } from "./evidence-types";

export type RunTimelineExportFormat = "json" | "markdown";
export type RunTimelineReplayCoverage = "complete" | "legacy-partial" | "recovered-partial" | "unknown";

export type RunTimelineCoverageTone = "complete" | "warning" | "unknown";

export interface RunTimelineCoverageDescription {
  readonly label: string;
  readonly detail: string;
  readonly tone: RunTimelineCoverageTone;
}

/**
 * Returns bounded, user-facing copy for the read-only coverage receipt. The
 * event list can still be useful when the receipt is partial or absent, but
 * the inspector must make that uncertainty visible instead of implying that
 * a live notification is a complete journal replay.
 */
export function describeRunTimelineCoverage(
  coverage: RunTimelineReplayCoverage,
  coverageReason: string | null = null,
  integrityIssueCount = 0,
): RunTimelineCoverageDescription {
  const safeCoverageReason = coverageReason === null
    ? null
    : safeText(coverageReason, 500);

  if (coverage === "complete" && integrityIssueCount === 0) {
    return {
      label: "Complete replay receipt",
      detail: "The current projection includes a fixed-watermark coverage receipt. This timeline remains read-only.",
      tone: "complete",
    };
  }

  if (coverage === "complete") {
    return {
      label: "Complete receipt · integrity review",
      detail: "Coverage reports complete, but the visible sequence has integrity issues. Review this read-only projection before relying on it.",
      tone: "warning",
    };
  }

  if (coverage === "legacy-partial") {
    return {
      label: "Legacy partial replay",
      detail:
        safeCoverageReason ??
        "The visible records do not carry a fixed-watermark receipt; missing events may remain.",
      tone: "warning",
    };
  }

  if (coverage === "recovered-partial") {
    return {
      label: "Recovered partial replay",
      detail:
        safeCoverageReason ??
        "Replay recovered a bounded subset after reconnect or restart; missing events may remain.",
      tone: "warning",
    };
  }

  return {
    label: "Coverage unknown",
    detail:
      safeCoverageReason ??
      "No fixed-watermark coverage receipt is available; visible events may be incomplete.",
    tone: "unknown",
  };
}

export const RUN_TIMELINE_EXPORT_FORMAT = "omnia.run-timeline.preview.v1" as const;
export const RUN_TIMELINE_EXPORT_SCOPE = "renderer-session" as const;
export const RUN_TIMELINE_EXPORT_VERSION = 1 as const;

export const RUN_TIMELINE_EXPORT_BOUNDARY =
  "Renderer-local preview only. This export contains the currently replayed run timeline projection; it does not create a native export receipt, prove complete journal coverage, or include hidden provider payloads.";

export interface RunTimelineExportInput {
  readonly runId: string;
  readonly events: readonly RunTimelineEventView[];
  readonly issues?: readonly string[];
  readonly coverage?: RunTimelineReplayCoverage;
  readonly coverageReason?: string | null;
  readonly format: RunTimelineExportFormat;
  readonly generatedAt?: string;
}

interface SafeRunTimelineEvent {
  readonly id: string;
  readonly runId: string;
  readonly parentEventId: string | null;
  readonly sequence: number;
  readonly type: string;
  readonly stage: RunTimelineEventView["stage"];
  readonly status: RunTimelineEventView["status"];
  readonly summary: string;
  readonly detail: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly source: RunTimelineEventView["source"];
  readonly providerLabel: string | null;
  readonly attemptOrdinal: number | null;
  readonly citationIds: string[];
}

function safeText(value: string, maxLength: number): string {
  return redactDiagnosticText(value).slice(0, maxLength);
}

function safeNullableText(value: string | null, maxLength: number): string | null {
  return value === null ? null : safeText(value, maxLength);
}

function safeEvent(event: RunTimelineEventView): SafeRunTimelineEvent {
  return {
    id: safeText(event.id, 160),
    runId: safeText(event.runId, 160),
    parentEventId: safeNullableText(event.parentEventId, 160),
    sequence: event.sequence,
    type: safeText(event.type, 160),
    stage: event.stage,
    status: event.status,
    summary: safeText(event.summary, 240),
    detail: safeNullableText(event.detail, 2_000),
    startedAt: safeText(event.startedAt, 80),
    endedAt: safeNullableText(event.endedAt, 80),
    source: event.source,
    providerLabel: safeNullableText(event.providerLabel, 240),
    attemptOrdinal: event.attemptOrdinal,
    citationIds: event.citationIds.slice(0, 64).map((citationId) => safeText(citationId, 160)),
  };
}

function markdownValue(value: string | null): string {
  return value ? value.replaceAll("|", "\\|").replaceAll("\n", " ") : "Not retained";
}

/**
 * Serializes only the bounded, renderer-safe timeline projection. The native
 * journal remains authoritative; this is intentionally a copy/download
 * preview until a native export command and receipt exist.
 */
export function serializeRunTimelineExport(input: RunTimelineExportInput): string {
  const events = input.events.map(safeEvent);
  const issues = (input.issues ?? []).map((issue) => safeText(issue, 500));
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const coverage = input.coverage ?? "unknown";
  const coverageLabel = coverage === "complete" && issues.length === 0 ? "complete" : coverage === "unknown" && issues.length === 0 ? "unknown" : "partial";
  const coverageReason = input.coverageReason === null || input.coverageReason === undefined
    ? null
    : safeText(input.coverageReason, 500);
  const runId = safeText(input.runId, 160);

  if (input.format === "json") {
    return JSON.stringify(
      {
        format: RUN_TIMELINE_EXPORT_FORMAT,
        version: RUN_TIMELINE_EXPORT_VERSION,
        scope: RUN_TIMELINE_EXPORT_SCOPE,
        generatedAt,
        boundary: RUN_TIMELINE_EXPORT_BOUNDARY,
        runId,
        coverage,
        coverageLabel,
        coverageReason,
        integrity: issues.length === 0 ? "ok" : "incomplete",
        integrityIssues: issues,
        eventCount: events.length,
        events,
      },
      null,
      2,
    );
  }

  return [
    "# Omnia run timeline preview",
    "",
    `> ${RUN_TIMELINE_EXPORT_BOUNDARY}`,
    "",
    `- Run: ${runId}`,
    `- Generated: ${markdownValue(generatedAt)}`,
    `- Coverage: ${coverageLabel === "complete" ? "Complete" : coverageLabel === "unknown" ? "Unknown" : `Partial (${coverage})`}`,
    ...(coverageReason ? [`- Coverage note: ${markdownValue(coverageReason)}`] : []),
    `- Events: ${events.length}`,
    "",
    ...(issues.length > 0
      ? [
          "## Integrity notes",
          "",
          ...issues.map((issue) => `- ${markdownValue(issue)}`),
          "",
        ]
      : []),
    "## Events",
    "",
    ...(events.length > 0
      ? events.flatMap((event) => [
          `### #${event.sequence} · ${markdownValue(event.summary)}`,
          "",
          `- Status: ${event.status}`,
          `- Stage: ${event.stage}`,
          `- Type: ${markdownValue(event.type)}`,
          `- Source: ${event.source}`,
          `- Event ID: ${markdownValue(event.id)}`,
          ...(event.parentEventId ? [`- Parent event: ${markdownValue(event.parentEventId)}`] : []),
          `- Started: ${markdownValue(event.startedAt)}`,
          `- Ended: ${markdownValue(event.endedAt)}`,
          ...(event.providerLabel ? [`- Provider/model: ${markdownValue(event.providerLabel)}`] : []),
          ...(event.attemptOrdinal === null ? [] : [`- Attempt: ${event.attemptOrdinal}`]),
          ...(event.citationIds.length > 0 ? [`- Citations: ${event.citationIds.map(markdownValue).join(", ")}`] : []),
          ...(event.detail ? ["", markdownValue(event.detail)] : []),
          "",
        ])
      : ["No replayed events are available for this run.", ""]),
  ].join("\n");
}

export function downloadRunTimelineExport(
  payload: string,
  format: RunTimelineExportFormat,
): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(
    new Blob([payload], {
      type: format === "json" ? "application/json" : "text/markdown",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-run-timeline-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return true;
}
