import { describe, expect, it } from "vitest";

import {
  DEFAULT_STRUCTURED_OUTPUT_FIELDS,
  buildStructuredOutputSchema,
  structuredOutputFieldsFromSchema,
} from "./structured-output-builder-contract";

describe("structured output builder contract", () => {
  it("builds an object schema with required fields, defaults, enums, and bounds", () => {
    const result = buildStructuredOutputSchema(DEFAULT_STRUCTURED_OUTPUT_FIELDS, { title: "Answer" });
    expect(result.issues).toHaveLength(0);
    expect(result.schema).toMatchObject({ title: "Answer", type: "object", additionalProperties: false });
    expect(result.schema).toHaveProperty("required", ["answer", "confidence"]);
    expect(result.schemaText).toContain('"minimum": 0');
    expect(result.schemaText).toContain('"maximum": 1');
  });

  it("fails closed for duplicate names and invalid numeric constraints", () => {
    const result = buildStructuredOutputSchema([
      { ...DEFAULT_STRUCTURED_OUTPUT_FIELDS[0]!, id: "a", name: "duplicate" },
      { ...DEFAULT_STRUCTURED_OUTPUT_FIELDS[1]!, id: "b", name: "duplicate", minimum: "9", maximum: "2" },
    ]);
    expect(result.issues.map((entry) => entry.message).join(" ")).toMatch(/unique|minimum/i);
  });

  it("round-trips object schema fields for visual editing", () => {
    const source = JSON.stringify({ type: "object", properties: { state: { type: "string", enum: ["draft", "done"] } }, required: ["state"], additionalProperties: true });
    const fields = structuredOutputFieldsFromSchema(source);
    expect(fields).toHaveLength(1);
    expect(fields?.[0]).toMatchObject({ name: "state", type: "string", required: true, enumValues: "draft, done" });
  });

  it("omits optional array item metadata when the source schema has no item type", () => {
    const source = JSON.stringify({ type: "object", properties: { tags: { type: "array", items: {} } } });
    const fields = structuredOutputFieldsFromSchema(source);
    expect(fields).toHaveLength(1);
    expect(fields?.[0]).not.toHaveProperty("itemsType");
  });

  it("returns null when input is not an object schema", () => {
    expect(structuredOutputFieldsFromSchema("not json")).toBeNull();
    expect(structuredOutputFieldsFromSchema(JSON.stringify({ type: "string" }))).toEqual([]);
  });
});
