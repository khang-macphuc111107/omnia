import { describe, expect, it } from "vitest";

import {
  buildWorkspaceExportProjection,
  parseWorkspaceExport,
  serializeWorkspaceExport,
  type WorkspaceExportRecord,
} from "./workspace-export-contract";

const records: WorkspaceExportRecord[] = [
  {
    kind: "conversation",
    id: "chat-1",
    label: "Research chat",
    summary: "A renderer-local chat preview",
    metadata: { messageCount: 3, project: "Omnia" },
  },
  {
    kind: "provider",
    id: "provider-1",
    label: "Preview provider",
    summary: "OpenAI-compatible · 2 models · configuration-validated",
    metadata: { endpoint: "redacted endpoint", modelCount: 2 },
  },
];

describe("workspace export contract", () => {
  it("builds counts and keeps the renderer-only boundary explicit", () => {
    const projection = buildWorkspaceExportProjection({
      scope: "workspace",
      redaction: "safe",
      generatedAt: "2026-09-20T00:00:00.000Z",
      selection: {
        conversations: true,
        projects: false,
        memories: false,
        skills: false,
        providers: true,
        artifacts: false,
        attachments: false,
        runs: false,
        diagnostics: false,
        appearance: false,
      },
      records,
    });

    expect(projection.counts.conversation).toBe(1);
    expect(projection.counts.provider).toBe(1);
    expect(projection.boundary.noDurableWrite).toBe(true);
    expect(projection.boundary.noProviderRequest).toBe(true);
  });

  it("round-trips JSON and JSONL previews", () => {
    const projection = buildWorkspaceExportProjection({
      scope: "custom",
      redaction: "developer",
      generatedAt: "2026-09-20T00:00:00.000Z",
      selection: {
        conversations: true,
        projects: true,
        memories: true,
        skills: true,
        providers: true,
        artifacts: true,
        attachments: true,
        runs: true,
        diagnostics: true,
        appearance: true,
      },
      records,
    });

    expect(parseWorkspaceExport(serializeWorkspaceExport(projection, "json")).records).toHaveLength(2);
    expect(parseWorkspaceExport(serializeWorkspaceExport(projection, "jsonl")).scope).toBe("custom");
  });

  it("fails closed for unsupported schema and oversized payloads", () => {
    expect(() => parseWorkspaceExport(JSON.stringify({ schema: "other" }))).toThrow(/unsupported/i);
    expect(() => parseWorkspaceExport("x".repeat(512 * 1024 + 1))).toThrow(/512 KB/i);
  });

  it("rejects malformed manifest enums, timestamps, and selection shapes", () => {
    const projection = buildWorkspaceExportProjection({
      scope: "workspace",
      redaction: "safe",
      generatedAt: "2026-09-20T00:00:00.000Z",
      selection: {
        conversations: true,
        projects: true,
        memories: true,
        skills: true,
        providers: true,
        artifacts: true,
        attachments: true,
        runs: true,
        diagnostics: true,
        appearance: true,
      },
      records: [],
    });
    const manifest = JSON.parse(serializeWorkspaceExport(projection, "json")) as Record<string, unknown>;

    expect(() => parseWorkspaceExport(JSON.stringify({ ...manifest, scope: "all" }))).toThrow(/scope/i);
    expect(() => parseWorkspaceExport(JSON.stringify({ ...manifest, redaction: "secret" }))).toThrow(/redaction/i);
    expect(() => parseWorkspaceExport(JSON.stringify({ ...manifest, generatedAt: "not-a-date" }))).toThrow(/timestamp/i);
    expect(() => parseWorkspaceExport(JSON.stringify({ ...manifest, selection: { conversations: true } }))).toThrow(/selection/i);
    expect(() => parseWorkspaceExport(JSON.stringify({ ...manifest, selection: { ...(manifest.selection as object), future: true } }))).toThrow(/selection/i);
  });

  it("rejects records with blank IDs or non-primitive metadata", () => {
    const manifest = {
      schema: "omnia.workspace-export.preview.v1",
      scope: "workspace",
      redaction: "safe",
      generatedAt: "2026-09-20T00:00:00.000Z",
      selection: {
        conversations: true,
        projects: true,
        memories: true,
        skills: true,
        providers: true,
        artifacts: true,
        attachments: true,
        runs: true,
        diagnostics: true,
        appearance: true,
      },
      records: [
        { kind: "conversation", id: "", label: "Invalid", summary: "Invalid", metadata: {} },
      ],
    };
    expect(() => parseWorkspaceExport(JSON.stringify(manifest))).toThrow(/invalid record/i);
    expect(() => parseWorkspaceExport(JSON.stringify({
      ...manifest,
      records: [{ kind: "conversation", id: "chat-1", label: "Invalid", summary: "Invalid", metadata: { nested: {} } }],
    }))).toThrow(/invalid record/i);
  });
});
