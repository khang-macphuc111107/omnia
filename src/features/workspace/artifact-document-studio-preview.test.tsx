import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactDocumentStudioPreview } from "./artifact-document-studio-preview";

const artifact = {
  id: "artifact-studio",
  name: "research-notes.md",
  type: "Markdown" as const,
  projectName: "Omnia Desktop",
  updatedLabel: "just now",
  sizeLabel: "4 KB",
  versionCount: 3,
};

describe("artifact document studio preview", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders an editable outline and deterministic rendered preview", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);

    expect(screen.getByRole("region", { name: "Document studio preview for research-notes.md" })).toBeInTheDocument();
    expect(screen.getAllByText("Summary").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Working notes").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/Native artifact bytes.*remain planned/).length).toBeGreaterThanOrEqual(2);

    fireEvent.change(screen.getByRole("textbox", { name: "Artifact draft editor" }), {
      target: { value: "# Edited title\n\n## New heading\n\nA local paragraph." },
    });

    expect(screen.getAllByText("Edited title").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("New heading").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Draft edited")).toBeInTheDocument();
    expect(screen.getByLabelText("Draft metrics")).toHaveTextContent("2 outline entries");
  });

  it("supports layout changes, local reset, copy, and browser download boundaries", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:artifact-studio") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });

    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Artifact draft editor" }), { target: { value: "# Changed" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Document studio view" }), { target: { value: "rendered" } });
    expect(screen.queryByRole("textbox", { name: "Artifact draft editor" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Rendered document preview" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));
    expect(writeText).toHaveBeenCalledWith("# Changed");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(click).toHaveBeenCalled();
    expect(screen.getByText(/Started a browser download/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("Revision baseline")).toBeInTheDocument();
    expect(screen.getByText(/Draft reset/)).toBeInTheDocument();

    click.mockRestore();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    if (createObjectUrlDescriptor) Object.defineProperty(URL, "createObjectURL", createObjectUrlDescriptor);
    if (revokeObjectUrlDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
  });

  it("saves and restores named renderer-local draft checkpoints", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    const editor = screen.getByRole("textbox", { name: "Artifact draft editor" }) as HTMLTextAreaElement;
    const baseline = editor.value;

    fireEvent.change(screen.getByRole("textbox", { name: "Checkpoint name" }), { target: { value: "Before rewrite" } });
    fireEvent.click(screen.getByRole("button", { name: "Save checkpoint" }));
    expect(screen.getByText("Before rewrite")).toBeInTheDocument();
    expect(screen.getByText(/Saved renderer-local checkpoint/)).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "# Risky rewrite" } });
    expect(editor).toHaveValue("# Risky rewrite");
    fireEvent.click(screen.getByRole("button", { name: "Restore checkpoint Before rewrite" }));
    expect(editor).toHaveValue(baseline);
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Restored renderer-local checkpoint/);

    fireEvent.click(screen.getByRole("button", { name: "Clear checkpoints" }));
    expect(screen.getByText(/Save a named draft state/)).toBeInTheDocument();
  });

  it("previews portable JSON and imports a Markdown draft without creating a revision", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Artifact document portable format" }), {
      target: { value: "json" },
    });
    expect(screen.getByText(/omnia-artifact-document-preview/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Preview portable JSON payload/));
    expect(screen.getByText(/no native artifact bytes, revision, hash, or receipt/i)).toBeInTheDocument();

    const file = new File(["# Imported heading\n\nImported locally."], "draft.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("Import artifact document"), { target: { files: [file] } });

    expect(await screen.findByText(/Imported plain Markdown draft/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Artifact draft editor" })).toHaveValue("# Imported heading\n\nImported locally.");
    expect(screen.getByText(/No native revision was created/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy portable" }));
    expect(await screen.findByText(/Copied the portable JSON bundle/)).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("omnia-artifact-document-preview"));
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });

  it("offers Markdown formatting tools, local history, and list continuation", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    const editor = screen.getByRole("textbox", { name: "Artifact draft editor" }) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "alpha" } });
    editor.setSelectionRange(0, 5);
    fireEvent.click(screen.getByRole("button", { name: "Bold selection" }));
    expect(editor).toHaveValue("**alpha**");

    fireEvent.click(screen.getByRole("button", { name: "Undo draft" }));
    expect(editor).toHaveValue("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Redo draft" }));
    expect(editor).toHaveValue("**alpha**");

    fireEvent.change(editor, { target: { value: "- first" } });
    editor.setSelectionRange(7, 7);
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    expect(editor).toHaveValue("- first\n- ");
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Continued the Markdown list locally/);
  });

  it("previews bounded math and media references without fetching them", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    const editor = screen.getByRole("textbox", { name: "Artifact draft editor" }) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "" } });
    editor.setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole("button", { name: "Math block" }));
    expect(editor).toHaveValue("$$\nx^2 + y^2 = z^2\n$$");
    expect(screen.getByText(/LaTeX preview · renderer-local/)).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "" } });
    editor.setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole("button", { name: "Image reference" }));
    expect(editor).toHaveValue("![alt text](https://example.com/image.png)");
    expect(screen.getByRole("img", { name: "Image reference preview" })).toBeInTheDocument();
    expect(screen.getByText(/no network fetch/)).toBeInTheDocument();
  });

  it("renders inline Markdown, ordered lists, and safe link previews locally", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    const editor = screen.getByRole("textbox", { name: "Artifact draft editor" }) as HTMLTextAreaElement;

    fireEvent.change(editor, {
      target: {
        value: "# **Rich** `draft`\n\n1. first\n2. second with [docs](https://example.com/docs)\n\n- **bold**\n- ~~removed~~",
      },
    });

    expect(screen.getByRole("heading", { name: "Rich draft" })).toBeInTheDocument();
    expect(screen.getByText("draft")).toHaveClass("artifact-document-studio__render-inline-code");
    const rendered = screen.getByRole("article", { name: "Rendered document preview" });
    expect(rendered.querySelector("ol.artifact-document-studio__render-ordered-list")).not.toBeNull();
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://example.com/docs");
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("removed")).toBeInTheDocument();
  });

  it("offers checklist, table, and divider editor blocks with rendered local output", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    const editor = screen.getByRole("textbox", { name: "Artifact draft editor" }) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "ship the preview" } });
    editor.setSelectionRange(0, editor.value.length);
    fireEvent.click(screen.getByRole("button", { name: "Checklist" }));
    expect(editor).toHaveValue("- [ ] ship the preview");
    expect(screen.getByText("ship the preview")).toBeInTheDocument();

    editor.setSelectionRange(editor.value.length, editor.value.length);
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    expect(editor).toHaveValue("- [ ] ship the preview\n- [ ] ");
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Continued the Markdown list locally/);

    fireEvent.change(editor, { target: { value: "release evidence" } });
    editor.setSelectionRange(0, editor.value.length);
    fireEvent.click(screen.getByRole("button", { name: "Table starter" }));
    expect(editor).toHaveValue("| Column | Value |\n| --- | --- |\n| Item | release evidence |");
    expect(screen.getByRole("table", { name: "Markdown table preview" })).toHaveTextContent("release evidence");

    fireEvent.change(editor, { target: { value: "before" } });
    editor.setSelectionRange(editor.value.length, editor.value.length);
    fireEvent.click(screen.getByRole("button", { name: "Horizontal rule" }));
    expect(editor).toHaveValue("before\n\n---\n");
    expect(document.querySelector(".artifact-document-studio__render-divider")).not.toBeNull();
  });

  it("lets the outline focus a heading in the local editor", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    const editor = screen.getByRole("textbox", { name: "Artifact draft editor" }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: "Go to heading Working notes" }));
    expect(editor.selectionStart).toBeGreaterThan(0);
    expect(editor.selectionStart).toBe(editor.selectionEnd);
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Focused “Working notes”/);
  });

  it("indexes structured blocks and filters the navigator locally", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    const editor = screen.getByRole("textbox", { name: "Artifact draft editor" }) as HTMLTextAreaElement;
    fireEvent.change(editor, {
      target: {
        value: [
          "# Research brief",
          "",
          "Intro paragraph.",
          "",
          "- first",
          "- second",
          "",
          "```ts",
          "const answer = 42;",
          "```",
          "",
          "$$",
          "x^2 + y^2 = z^2",
          "$$",
          "",
          "![figure](https://example.com/figure.png)",
        ].join("\n"),
      },
    });

    expect(screen.getByText("6 blocks")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Structure block filter" }), { target: { value: "lists" } });
    expect(screen.getByRole("button", { name: /Focus Bullet list/ })).toHaveTextContent("2 items");
    expect(screen.queryByRole("button", { name: /Focus Code block/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Focus Bullet list/ }));
    expect(editor.selectionStart).toBeGreaterThan(0);
    expect(editor.selectionStart).toBe(editor.selectionEnd);
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Focused bullet list/);
  });

  it("finds and replaces draft text locally without creating a native revision", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    const editor = screen.getByRole("textbox", { name: "Artifact draft editor" }) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "alpha beta alpha" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in draft" }), { target: { value: "alpha" } });
    expect(screen.getByText("2 matches")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Find next match" }));
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(5);
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent("Match 1 of 2");

    fireEvent.change(screen.getByRole("textbox", { name: "Replace in draft" }), { target: { value: "item" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace current match" }));
    expect(editor).toHaveValue("item beta alpha");
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Replaced one match locally/);

    fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));
    expect(editor).toHaveValue("item beta item");
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Replaced 1 matches locally/);
  });

  it("reports missing find terms without changing the renderer-local draft", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    const editor = screen.getByRole("textbox", { name: "Artifact draft editor" }) as HTMLTextAreaElement;
    const original = editor.value;

    fireEvent.change(screen.getByRole("textbox", { name: "Find in draft" }), { target: { value: "not-present" } });
    expect(screen.getByText("0 matches")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));
    expect(editor).toHaveValue(original);
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/No matches for/);
  });

  it("adds, focuses, and removes renderer-local review notes", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);
    const editor = screen.getByRole("textbox", { name: "Artifact draft editor" }) as HTMLTextAreaElement;
    const start = editor.value.indexOf("Working notes");
    editor.focus();
    editor.setSelectionRange(start, start + "Working notes".length);

    fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), {
      target: { value: "Verify this section" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    expect(screen.getByText("Verify this section")).toBeInTheDocument();
    expect(screen.getByText(/Anchored to “Working notes”/)).toBeInTheDocument();
    expect(screen.getByText(/Added renderer-local review note/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Focus review note Verify this section" }));
    expect(editor.selectionStart).toBe(start);
    expect(editor.selectionEnd).toBe(start + "Working notes".length);
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Focused review note/);

    fireEvent.click(screen.getByRole("button", { name: "Remove review note Verify this section" }));
    expect(screen.queryByText("Verify this section")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Removed renderer-local review note/);
  });

  it("keeps review notes renderer-local and handles empty or bulk clear actions", () => {
    render(<ArtifactDocumentStudioPreview artifact={artifact} revision={2} />);

    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Enter a review note/);

    fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), {
      target: { value: "Follow up" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(screen.getByText("Follow up")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear review notes" }));
    expect(screen.queryByText("Follow up")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Document studio status" })).toHaveTextContent(/Cleared renderer-local review notes/);
  });
});
