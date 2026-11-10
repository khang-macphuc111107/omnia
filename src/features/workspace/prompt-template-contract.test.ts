import { describe, expect, it } from "vitest";
import {
  appendPromptTemplateVersion,
  bumpPromptTemplateVersion,
  comparePromptTemplateVersion,
  createPromptTemplateVersion,
  parsePromptTemplateBundle,
  resolvePromptTemplate,
  serializePromptTemplate,
  validatePromptTemplate,
  type PromptTemplate,
} from "./prompt-template-contract";

const template: PromptTemplate = {
  id: "meeting-brief",
  name: "Meeting brief",
  description: "Turn notes into a short, evidence-bound brief.",
  tags: ["work", "brief"],
  body: "Write a {{tone}} brief for {{audience}}.\n\nNotes:\n{{notes}}\n\nDue: {{dueDate}}\nInclude citations: {{includeCitations}}",
  variables: [
    { id: "tone", name: "tone", label: "Tone", type: "choice", required: true, options: [{ label: "Direct", value: "direct" }, { label: "Warm", value: "warm" }], defaultValue: "direct" },
    { id: "audience", name: "audience", label: "Audience", type: "short-text", required: true },
    { id: "notes", name: "notes", label: "Notes", type: "long-text", required: true },
    { id: "due-date", name: "dueDate", label: "Due date", type: "date", required: true },
    { id: "citations", name: "includeCitations", label: "Include citations", type: "boolean", required: true, defaultValue: false },
  ],
  examples: [{ id: "example-1", label: "Research team", values: { tone: "direct", audience: "research team", notes: "Ship the evidence map.", dueDate: "2026-09-22", includeCitations: true } }],
  version: "1.0.0",
  versions: [{ version: "1.0.0", createdAt: "2026-09-20T00:00:00.000Z", changeNote: "Initial version", body: "Write a {{tone}} brief for {{audience}}.\n\nNotes:\n{{notes}}\n\nDue: {{dueDate}}\nInclude citations: {{includeCitations}}", variableIds: ["tone", "audience", "notes", "due-date", "citations"] }],
  archived: false,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

describe("prompt-template-contract", () => {
  it("validates typed variables and resolves defaults into an exact prompt", () => {
    expect(validatePromptTemplate(template)).toEqual([]);
    const result = resolvePromptTemplate(template, { audience: "the research team", notes: "Ship the evidence map.", dueDate: "2026-09-22" });
    expect(result.missingVariableIds).toEqual([]);
    expect(result.values.includeCitations).toBe(false);
    expect(result.resolvedPrompt).toContain("Write a direct brief for the research team.");
    expect(result.resolvedPrompt).toContain("Include citations: false");
  });

  it("reports invalid values and unknown placeholders without silently resolving them", () => {
    const invalid = { ...template, body: `${template.body}\n{{unknown}}` };
    const issues = validatePromptTemplate(invalid);
    expect(issues.some((issue) => issue.code === "body-placeholder")).toBe(true);
    const result = resolvePromptTemplate(template, { audience: "", notes: "x", dueDate: "not-a-date", tone: "unsupported", includeCitations: "yes" });
    expect(result.missingVariableIds).toEqual(["tone", "audience", "due-date", "citations"]);
    expect(result.resolvedPrompt).toContain("{{audience}}");
    expect(result.resolvedPrompt).toContain("{{dueDate}}");
    expect(result.warnings.join(" ")).toMatch(/required|choice|date|true or false/i);
  });

  it("round-trips a BOM-safe portable bundle and rejects oversized or malformed bundles", () => {
    const exported = serializePromptTemplate(template, "2026-09-20T00:00:00.000Z");
    expect(parsePromptTemplateBundle(`\uFEFF${exported}`)).toEqual(template);
    expect(() => parsePromptTemplateBundle("{}")) .toThrow(/Unsupported/);
    expect(() => parsePromptTemplateBundle(JSON.stringify({ schema: "omnia.prompt-template.preview.v1", scope: "renderer-session", template: {} }))).toThrow(/validation failed/i);
    expect(() => parsePromptTemplateBundle("x".repeat(512 * 1024 + 1))).toThrow(/512 KB/);
  });

  it("creates version records from the exact body and variable set", () => {
    const version = createPromptTemplateVersion(template, "Added citation toggle", "2026-09-20T01:00:00.000Z");
    expect(version).toMatchObject({ version: "1.0.0", changeNote: "Added citation toggle", variableIds: ["tone", "audience", "notes", "due-date", "citations"] });
    expect(version.body).toBe(template.body);
    expect(bumpPromptTemplateVersion("1.0.0")).toBe("1.0.1");
    expect(bumpPromptTemplateVersion("1.0.0", "minor")).toBe("1.1.0");
    expect(bumpPromptTemplateVersion("1.0.0", "major")).toBe("2.0.0");
    expect(() => bumpPromptTemplateVersion("draft")).toThrow(/MAJOR.MINOR.PATCH/);
    const next = appendPromptTemplateVersion(template, "Clarified output", "minor", "2026-09-20T01:00:00.000Z");
    expect(next.version).toBe("1.1.0");
    expect(next.versions.at(-1)?.changeNote).toBe("Clarified output");
  });

  it("builds a deterministic renderer diff for an inspected historical version", () => {
    const current: PromptTemplate = {
      ...template,
      version: "1.1.0",
      body: `${template.body}\nUse the visible evidence only.`,
      variables: [...template.variables, { id: "format", name: "format", label: "Format", type: "short-text", required: false }],
    };
    const diff = comparePromptTemplateVersion(current, template.versions[0]!);
    expect(diff).toMatchObject({ currentVersion: "1.1.0", inspectedVersion: "1.0.0", bodyChanged: true, variablesAdded: ["format"], variablesRemoved: [] });
    expect(diff.summary.join(" ")).toMatch(/body differs|variable added/i);

    const unchanged = comparePromptTemplateVersion(template, template.versions[0]!);
    expect(unchanged.bodyChanged).toBe(false);
    expect(unchanged.summary).toEqual(["No body or variable-set differences are visible in this preview."]);
  });
});
