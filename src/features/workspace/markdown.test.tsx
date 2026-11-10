import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantTextSelection, MessageMarkdown, takePendingCodeInIdeRequest } from "./markdown";
import { getWorkspaceSurface, setWorkspaceSurface } from "./workspace-mode-switcher";

describe("MessageMarkdown", () => {
  it("renders GFM content while blocking unsafe and non-http links", () => {
    render(
      <MessageMarkdown
        content={'## Preview\n\n- [x] shipped\n\n[Safe](https://example.com) [Unsafe](javascript:alert(1))'}
      />,
    );

    expect(screen.getByRole("heading", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByText("shipped")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Safe" })).toHaveAttribute("href", "https://example.com/");
    expect(screen.getByText("Unsafe")).toHaveClass("unsafe-external-link");
  });

  it("shows exactly two icon-only code actions and copies the original source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<MessageMarkdown content={'```ts\nconst preview = true;\n```'} />);

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open in IDE" })).toHaveAttribute("title", "Open in IDE");
    const copy = screen.getByRole("button", { name: "Copy code" });
    expect(copy).toHaveAttribute("title", "Copy code");
    expect(copy.textContent).toBe("");
    expect(copy.querySelector("svg")).toHaveAttribute("stroke-width", "1.75");
    fireEvent.click(copy);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Code copied"));
    expect(writeText).toHaveBeenCalledWith("const preview = true;");
    expect(screen.queryByRole("button", { name: /artifact|wrapping|apply patch/i })).not.toBeInTheDocument();
  });

  it("highlights common code tokens while preserving safe, copyable source text", () => {
    render(<MessageMarkdown content={'```ts\nconst render = (count: number) => "<ready>"; // keep this note\n```'} />);

    const code = document.querySelector(".code-block code");
    expect(code).toHaveTextContent('const render = (count: number) => "<ready>"; // keep this note');
    expect(code?.querySelector(".syntax-keyword")).toHaveTextContent("const");
    expect(code?.querySelector(".syntax-function")).toHaveTextContent("render");
    expect(Array.from(code?.querySelectorAll(".kw") ?? [], (node) => node.textContent)).toEqual(["const"]);
    expect(code?.querySelector(".ty")).toHaveTextContent("number");
    expect(code?.querySelector(".syntax-string")).toHaveTextContent('"<ready>"');
    expect(code?.querySelector(".syntax-comment")).toHaveTextContent("// keep this note");
    expect(code?.querySelector("script")).toBeNull();
  });

  it("marks JSON property names and leaves code payload inert", () => {
    render(<MessageMarkdown content={'```json\n{"title": "<script>alert(1)</script>", "count": 2}\n```'} />);

    const code = document.querySelector(".code-block code");
    expect(code?.querySelectorAll(".syntax-property")).toHaveLength(2);
    expect(code?.querySelector("script")).toBeNull();
    expect(code).toHaveTextContent('{"title": "<script>alert(1)</script>", "count": 2}');
  });

  it("renders Rust keywords, types, functions, strings, comments and numbers as safe token spans", () => {
    const source = 'pub fn read_chunk(input: String) -> usize {\n  let count = 12; // retain <script> literally\n  emit("<ready>");\n}';
    render(<MessageMarkdown content={`\`\`\`rust src-tauri/src/provider_gateway.rs:864-898\n${source}\n\`\`\``} />);
    const code = document.querySelector(".code-block code");
    expect(code?.textContent).toBe(`${source}\n`);
    expect(code?.querySelector(".kw")).toHaveTextContent("pub");
    expect(code?.querySelector(".ty")).toHaveTextContent("String");
    expect(code?.querySelector(".fn")).toHaveTextContent("read_chunk");
    expect(code?.querySelector(".str")).toHaveTextContent('"<ready>"');
    expect(code?.querySelector(".cmt")).toHaveTextContent("// retain <script> literally");
    expect(code?.querySelector(".num")).toHaveTextContent("12");
    expect(code?.querySelector("script")).toBeNull();
    expect(screen.getByText("src-tauri/src/provider_gateway.rs:864-898")).toBeInTheDocument();
    // Rust blocks use the branded language icon (explicit per-shape colors), not the generic currentColor file glyph.
    const fileIcon = document.querySelector(".code-block__file-icon[data-file-type=\"rust\"] svg");
    expect(fileIcon).not.toBeNull();
    expect(fileIcon?.querySelector('[stroke="#fb923c"]')).not.toBeNull();
  });

  it("lets the IDE host apply exact model-authored code with no patch or navigation side effect", () => {
    const apply = vi.fn();
    render(<MessageMarkdown content={'```ts filename="src/App.tsx" lines="14-18"\nconst active = 2;\n```'} onApplyCode={apply} />);
    expect(screen.getByText("src/App.tsx:14-18")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in IDE" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply to editor" }));
    expect(apply).toHaveBeenCalledExactlyOnceWith("const active = 2;");
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("opens a code locator through the host callback", () => {
    const open = vi.fn();
    render(<MessageMarkdown content={'```rust src/lib.rs:2-4\nfn main() {}\n```'} onOpenInIde={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in IDE" }));
    expect(open).toHaveBeenCalledExactlyOnceWith("fn main() {}", { language: "rust", filename: "src/lib.rs", lineRange: "2-4" });
  });

  it("navigates to the real IDE surface without modifying a file when no host callback is supplied", () => {
    setWorkspaceSurface("chat");
    render(<MessageMarkdown content={'```ts src/App.tsx:1-3\nconst active = true;\n```'} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in IDE" }));
    expect(getWorkspaceSurface()).toBe("code");
    expect(takePendingCodeInIdeRequest()).toEqual({ code: "const active = true;", language: "typescript", filename: "src/App.tsx", lineRange: "1-3" });
    expect(takePendingCodeInIdeRequest()).toBeNull();
    setWorkspaceSurface("chat");
  });

  it("does not shift file metadata when an indented block precedes a fence", () => {
    render(<MessageMarkdown content={'    plain code\n\n```py filename="worker.py"\nprint("ready")\n```'} />);
    const figures = document.querySelectorAll(".code-block");
    expect(figures[0]?.querySelector(".code-block__filename")).toHaveTextContent("text");
    expect(figures[1]?.querySelector(".code-block__filename")).toHaveTextContent("worker.py");
  });

  it("fails honestly when clipboard access rejects", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<MessageMarkdown content={'```js\nconst active = true;\n```'} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy code");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("escapes code file metadata and raw HTML rather than creating executable elements", () => {
    render(<MessageMarkdown content={'<script>alert("no")</script>\n\n```ts title="<img src=x onerror=alert(1)>"\nconst markup = "<img src=x onerror=alert(1)>";\n```'} />);
    expect(document.querySelector(".message-markdown script, .message-markdown img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });

  it("can decorate inline LaTeX for the composer without touching code spans", () => {
    render(
      <MessageMarkdown
        renderInlineMath
        content={'Rate $x^2$ and \\(\\alpha\\) while `literal $not-math$` stays source-faithful.'}
      />,
    );

    expect(screen.getByText("x^2")).toHaveClass("message-markdown__inline-math");
    expect(screen.getByText("α")).toHaveAttribute("data-math-source", "\\(\\alpha\\)");
    expect(screen.getByText("literal $not-math$", { selector: "code" })).not.toHaveClass("message-markdown__inline-math");
  });

  it("keeps inline math as literal source in normal conversation rendering", () => {
    render(<MessageMarkdown content={"Read $x^2$ and \\(\\alpha\\)."} />);

    expect(document.querySelector(".message-markdown__inline-math")).not.toBeInTheDocument();
    expect(screen.getByText("Read $x^2$ and (\\alpha)." )).toBeInTheDocument();
  });
});

describe("AssistantTextSelection", () => {
  afterEach(() => { window.getSelection()?.removeAllRanges(); });

  function select(element: HTMLElement, start = 0, end?: number) {
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end ?? text.textContent!.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(element);
  }

  it("renders no permanent selection actions and exposes only Quote and Ask in side chat for a real selection", () => {
    const quote = vi.fn();
    const side = vi.fn();
    render(<AssistantTextSelection sourceId="answer" onQuote={quote} onAskInSideChat={side}><p>Selected assistant words.</p></AssistantTextSelection>);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    select(screen.getByText("Selected assistant words."), 0, 8);
    const toolbar = screen.getByRole("toolbar", { name: "Selected text actions" });
    expect(toolbar.querySelectorAll("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(quote).toHaveBeenCalledExactlyOnceWith("Selected");
    expect(side).not.toHaveBeenCalled();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("asks about exactly selected text and dismisses on Escape or selection clear", () => {
    const side = vi.fn();
    render(<AssistantTextSelection sourceId="answer" onQuote={vi.fn()} onAskInSideChat={side}><p>Ask about this paragraph.</p></AssistantTextSelection>);
    const paragraph = screen.getByText("Ask about this paragraph.");
    select(paragraph, 10, 14);
    fireEvent.click(screen.getByRole("button", { name: "Ask in side chat" }));
    expect(side).toHaveBeenCalledExactlyOnceWith("this");
    select(paragraph);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    select(paragraph);
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("fails closed for collapsed, cross-root, disabled, and code-header selections", () => {
    const quote = vi.fn();
    const { rerender } = render(<><p>Outside text.</p><AssistantTextSelection sourceId="answer" onQuote={quote} onAskInSideChat={vi.fn()}><p>Inside answer.</p><span data-selection-exclude>header label</span></AssistantTextSelection></>);
    const inside = screen.getByText("Inside answer.");
    select(inside, 2, 2);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    const range = document.createRange();
    range.setStart(screen.getByText("Outside text.").firstChild!, 0);
    range.setEnd(inside.firstChild!, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(inside);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    select(screen.getByText("header label"));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    rerender(<AssistantTextSelection sourceId="answer" disabled onQuote={quote} onAskInSideChat={vi.fn()}><p>Inside answer.</p></AssistantTextSelection>);
    select(screen.getByText("Inside answer."));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(quote).not.toHaveBeenCalled();
  });
});
