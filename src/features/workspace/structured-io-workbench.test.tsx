import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StructuredIoWorkbench } from "./structured-io-workbench";
import { buildStructuredBlockPreview, detectStructuredFormat, normalizeStructuredSource } from "./structured-io-block";

describe("StructuredIoWorkbench", () => {
  it("renders a valid JSON Schema rehearsal and supports preset switching", () => {
    render(<StructuredIoWorkbench />);

    expect(screen.getByRole("heading", { name: "Structured I/O" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(/Draft is ready/i);
    expect(screen.getAllByText("Valid preview")).toHaveLength(2);
    expect(screen.getByText(/Payload is valid/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Task plan/i }));
    expect((screen.getByRole("textbox", { name: "Structured I/O JSON Schema" }) as HTMLTextAreaElement).value).toContain('"steps"');
    expect(screen.getByRole("status")).toHaveTextContent(/Loaded the Task plan/i);
  });

  it("reports schema and payload issues without executing anything", () => {
    render(<StructuredIoWorkbench />);

    fireEvent.change(screen.getByRole("textbox", { name: "Structured I/O sample payload" }), {
      target: { value: '{"answer": 42}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate draft" }));

    const validation = screen.getByRole("region", { name: "Structured I/O validation results" });
    expect(validation).toHaveTextContent(/Expected string/i);
    expect(validation).toHaveTextContent(/Missing required property/i);
    expect(screen.getByText(/No provider request, native schema admission/i)).toBeInTheDocument();
  });

  it("offers renderer-local JSON and Markdown export previews", () => {
    render(<StructuredIoWorkbench />);

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const exportRegion = screen.getByRole("region", { name: "Structured I/O export preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.structured-io\.preview\.v1/);

    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Structured I/O export format" }), { target: { value: "markdown" } });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/# Structured I\/O preview/);
    expect(within(exportRegion).getByText(/No file is written/i)).toBeInTheDocument();
  });

  it("keeps draft edits reversible", () => {
    render(<StructuredIoWorkbench />);
    const payload = screen.getByRole("textbox", { name: "Structured I/O sample payload" });
    fireEvent.change(payload, { target: { value: '{"answer":"edited","confidence":0.5}' } });
    expect(payload).toHaveValue('{"answer":"edited","confidence":0.5}');
    fireEvent.click(screen.getByRole("button", { name: "Undo structured I/O change" }));
    expect(payload).toHaveValue(`{
  "answer": "Concise result",
  "confidence": 0.84
}`);
    fireEvent.click(screen.getByRole("button", { name: "Redo structured I/O change" }));
    expect(payload).toHaveValue('{"answer":"edited","confidence":0.5}');
  });

  it("explains primary actions on hover and keeps the visual builder controls discoverable", () => {
    render(<StructuredIoWorkbench />);

    expect(screen.getByRole("button", { name: "Undo structured I/O change" })).toHaveAttribute("title", "Undo the last Structured I/O edit");
    expect(screen.getByRole("button", { name: "Reset structured I/O draft" })).toHaveAttribute("title", "Reset this renderer-local draft to its default");
    expect(screen.getByRole("button", { name: "Validate draft" })).toHaveAttribute("title", "Run renderer-local validation against the current draft");

    fireEvent.click(screen.getByRole("button", { name: "Open builder" }));
    expect(screen.getByRole("button", { name: "Add field" })).toHaveAttribute("title", "Add a field to the renderer-local schema draft");
    expect(screen.getByRole("button", { name: /Move answer up/i })).toHaveAttribute("title", "Move this field up");
    expect(screen.getByRole("button", { name: /Remove answer/i })).toHaveAttribute("title", "Remove this field from the draft");
  });

  it("projects typed block metadata and supports format and channel overrides", () => {
    render(<StructuredIoWorkbench />);
    expect(screen.getByText("json · json")).toBeInTheDocument();
    expect(screen.getByText(/preview hash · not a native receipt/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Structured block channel" }), { target: { value: "tool" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Structured block format override" }), { target: { value: "yaml" } });
    expect(screen.getByText("yaml")).toBeInTheDocument();
    expect(screen.getByText(/explicit override/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    expect(within(screen.getByRole("region", { name: "Structured I/O export preview" })).getByRole("code")).toHaveTextContent(/"channel": "tool"/);
    expect(within(screen.getByRole("region", { name: "Structured I/O export preview" })).getByRole("code")).toHaveTextContent(/"format": "yaml"/);
  });

  it("searches source lines and switches between normalized and raw views", () => {
    render(<StructuredIoWorkbench />);
    const payload = screen.getByRole("textbox", { name: "Structured I/O sample payload" });
    fireEvent.change(payload, { target: { value: "{\r\n  \"needle\": 7\r\n}" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in structured source" }), { target: { value: "needle" } });
    const normalized = screen.getByRole("list", { name: "normalized source lines" });
    expect(within(normalized).getByText("2")).toBeInTheDocument();
    expect(within(normalized).getByText(/needle/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Structured source view" }), { target: { value: "raw" } });
    expect(screen.getByRole("list", { name: "raw source lines" })).toBeInTheDocument();
  });
});

describe("structured block preview contract", () => {
  it.each([
    ["json", "{\"ok\":true}", "json"],
    ["jsonl", "{\"a\":1}\n{\"b\":2}", "jsonl"],
    ["diff", "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@", "diff"],
    ["stack", "Error: failed\n    at run (app.ts:1:1)", "stack-trace"],
    ["shell", "$ npm run build", "shell"],
  ])("auto-detects %s without changing source", (_label, source, expected) => {
    expect(detectStructuredFormat(source).format).toBe(expected);
  });

  it("keeps source hashing exact while normalized rendering is a derived view", () => {
    const raw = "\uFEFF{\r\n  \"ok\": true\r\n}";
    const preview = buildStructuredBlockPreview(raw);
    expect(preview.format).toBe("json");
    expect(preview.sourceHash).not.toBe(buildStructuredBlockPreview(normalizeStructuredSource(raw)).sourceHash);
    expect(normalizeStructuredSource(raw)).toBe("{\n  \"ok\": true\n}");
    expect(preview.lineCount).toBe(3);
    expect(preview.byteCount).toBe(new TextEncoder().encode(raw).byteLength);
    expect(preview.parserRevision).toContain("renderer-preview");
  });
});
