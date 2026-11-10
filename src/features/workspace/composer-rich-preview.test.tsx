import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  analyzeComposerPreview,
  ComposerRichPreview,
  formatLatexPreview,
  splitInlineMath,
} from "./composer-rich-preview";

const draft = `# Research note

- [ ] Gather inputs
- [ ] Compare results

\`\`\`ts
const answer = 42;
\`\`\`

$$
\\frac{a}{b} + \\alpha \\to \\infty
$$`;

describe("ComposerRichPreview", () => {
  it("summarizes Markdown structure without treating fenced code as an equation", () => {
    const analysis = analyzeComposerPreview(`${draft}\n\n\`\`\`text\n$$not math$$\n\`\`\``);

    expect(analysis.blocks.map((block) => block.kind)).toEqual([
      "heading",
      "task-list",
      "code",
      "math",
      "code",
    ]);
    expect(analysis.blocks.find((block) => block.kind === "code")?.detail).toBe("ts");
    expect(analysis.inlineMathCount).toBe(0);
    expect(analysis.words).toBeGreaterThan(5);
  });

  it("keeps raw LaTeX visible while providing a lightweight local approximation", () => {
    expect(formatLatexPreview("$$\\frac{a}{b} + \\alpha \\to \\infty$$")).toContain("(a)/(b)");
    expect(formatLatexPreview("$$\\frac{a}{b} + \\alpha \\to \\infty$$")).toContain("α");
    expect(formatLatexPreview("$$\\frac{a}{b} + \\alpha \\to \\infty$$")).toContain("→");
  });

  it("splits inline LaTeX without changing surrounding Markdown text", () => {
    expect(splitInlineMath("Rate $r^2$ and \\(\\alpha\\) today")).toEqual([
      { kind: "text", value: "Rate " },
      { kind: "math", value: "r^2", source: "$r^2$" },
      { kind: "text", value: " and " },
      { kind: "math", value: "α", source: "\\(\\alpha\\)" },
      { kind: "text", value: " today" },
    ]);
  });

  it("surfaces incomplete fences and math blocks without changing the source", () => {
    const unclosedFence = analyzeComposerPreview("```ts\nconst answer = 42;");
    const unclosedMath = analyzeComposerPreview("$$\nx = y");

    expect(unclosedFence.warnings).toEqual([
      "Unclosed ts fence; the source remains unchanged.",
    ]);
    expect(unclosedMath.warnings).toEqual([
      "Unclosed LaTeX block; the source remains unchanged.",
    ]);
  });

  it("recognizes GFM tables as structured blocks", () => {
    const analysis = analyzeComposerPreview("| Column | Value |\n| --- | --- |\n| Item | Detail |");

    expect(analysis.blocks).toHaveLength(1);
    expect(analysis.blocks[0]).toMatchObject({
      kind: "table",
      detail: "2 columns · 1 data row",
    });
  });

  it("switches between rendered, outline, and source preview modes", () => {
    render(<ComposerRichPreview content={draft} />);

    expect(screen.getByRole("tab", { name: "Rendered" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Math preview" })).toBeInTheDocument();
    expect(screen.getByText(/no TeX engine or provider was invoked/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Outline" }));
    expect(screen.getByRole("tab", { name: "Outline" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("list", { name: "Draft structure outline" })).toBeInTheDocument();
    expect(screen.getByText("Research note")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/const answer = 42;/)).toBeInTheDocument();
  });

  it("renders inline LaTeX in the rendered composer preview", async () => {
    render(<ComposerRichPreview content={"Rate $r^2$ in the local rendered preview."} />);

    expect(await screen.findByText("r^2")).toHaveClass("message-markdown__inline-math");
  });

  it("offers a WYSIWYM structure view with local inline math approximations", () => {
    render(<ComposerRichPreview content={`# Formula\n\nInline $x^2$ stays readable.\n\n- [ ] Review`} />);

    fireEvent.click(screen.getByRole("tab", { name: "WYSIWYM" }));

    expect(screen.getByRole("tabpanel", { name: "WYSIWYM" })).toBeInTheDocument();
    expect(screen.getByText("Formula")).toBeInTheDocument();
    expect(screen.getByText("x^2")).toHaveClass("composer-rich-preview__inline-math");
    expect(screen.getByText(/WYSIWYM is a renderer-local structure preview/i)).toBeInTheDocument();
  });

  it("renders table blocks in the WYSIWYM structure view", () => {
    render(<ComposerRichPreview content={"| Column | Value |\n| --- | --- |\n| Item | Detail |"} />);

    fireEvent.click(screen.getByRole("tab", { name: "WYSIWYM" }));

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Column" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Detail" })).toBeInTheDocument();
    expect(screen.getByText(/2 columns · 1 data row/i)).toBeInTheDocument();
  });

  it("offers a local block editor with explicit apply and source-jump callbacks", () => {
    const onBlockSelect = vi.fn();
    const onBlockReplace = vi.fn();
    render(<ComposerRichPreview content={"# Draft title\n\n- first item"} onBlockSelect={onBlockSelect} onBlockReplace={onBlockReplace} />);

    fireEvent.click(screen.getByRole("tab", { name: "Blocks" }));
    expect(screen.getByRole("tabpanel", { name: "Blocks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edit block 1: Draft title/i })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Edit block 1 source" }), { target: { value: "# Updated title" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));

    expect(onBlockReplace).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "heading", title: "Draft title" }),
      0,
      "# Updated title",
    );
    fireEvent.click(screen.getByRole("button", { name: "Jump to source" }));
    expect(onBlockSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "heading" }), 0);
    expect(screen.getByText(/Edit stays local until you explicitly apply/i)).toBeInTheDocument();
  });

  it("exposes outline entries as optional source-editor jump targets", () => {
    const onBlockSelect = vi.fn();
    render(<ComposerRichPreview content={draft} onBlockSelect={onBlockSelect} />);

    fireEvent.click(screen.getByRole("tab", { name: "Outline" }));
    const headingJump = screen.getByRole("button", { name: /Jump to block 1: Research note/i });
    fireEvent.click(headingJump);

    expect(onBlockSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "heading", title: "Research note" }),
      0,
    );
  });

  it("renders an honest empty state", () => {
    render(<ComposerRichPreview content="" />);

    expect(screen.getByText(/Nothing to preview yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Preview only/i)).toBeInTheDocument();
  });
});
