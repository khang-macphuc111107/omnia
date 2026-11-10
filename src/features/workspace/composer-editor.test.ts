import { describe, expect, it } from "vitest";

import {
  continueMarkdownCodeBlockAtSelection,
  continueMarkdownListAtSelection,
  indentMarkdownSelection,
  insertMarkdownLink,
  isMarkdownLinePrefixActive,
  isMarkdownListActive,
  isMarkdownInlineActive,
  toggleMarkdownHeading,
  toggleMarkdownInline,
  toggleMarkdownLinePrefix,
  toggleMarkdownListPrefix,
} from "./composer-editor";

describe("composer smart editor", () => {
  it("continues unordered lists", () => {
    const value = "- item";
    const change = continueMarkdownListAtSelection(value, value.length, value.length);

    expect(change).toMatchObject({
      value: "- item\n- ",
      selectionStart: "- item\n- ".length,
      selectionEnd: "- item\n- ".length,
      handled: true,
    });
  });

  it("increments ordered lists and preserves the delimiter", () => {
    const value = "09) item";
    const change = continueMarkdownListAtSelection(value, value.length, value.length);

    expect(change.value).toBe("09) item\n10) ");
    expect(change.selectionStart).toBe(change.value.length);
  });

  it("continues alphabetic ordered lists including the Z-to-AA boundary", () => {
    const lower = "b) item";
    const lowerChange = continueMarkdownListAtSelection(lower, lower.length, lower.length);
    expect(lowerChange.value).toBe("b) item\nc) ");

    const upper = "Z. item";
    const upperChange = continueMarkdownListAtSelection(upper, upper.length, upper.length);
    expect(upperChange.value).toBe("Z. item\nAA. ");

    const multiLetter = "AA) item";
    const multiLetterChange = continueMarkdownListAtSelection(
      multiLetter,
      multiLetter.length,
      multiLetter.length,
    );
    expect(multiLetterChange.value).toBe("AA) item\nAB) ");
  });

  it("continues unchecked task lists", () => {
    const value = "- [x] done";
    const change = continueMarkdownListAtSelection(value, value.length, value.length);

    expect(change.value).toBe("- [x] done\n- [ ] ");
    expect(change.selectionStart).toBe(change.value.length);
  });

  it("exits a list when Enter is pressed on an empty marker", () => {
    const value = "- item\n- ";
    const change = continueMarkdownListAtSelection(value, value.length, value.length);

    expect(change.value).toBe("- item\n");
    expect(change.selectionStart).toBe("- item\n".length);
  });

  it("does not treat a plain paragraph as a list", () => {
    const value = "plain paragraph";
    expect(continueMarkdownListAtSelection(value, value.length, value.length).handled).toBe(false);
  });

  it("indents a selected multi-line block and remaps its selection", () => {
    const value = "- one\n- two";
    const change = indentMarkdownSelection(value, 0, value.length, "indent");

    expect(change.value).toBe("  - one\n  - two");
    expect(change.selectionStart).toBe(2);
    expect(change.selectionEnd).toBe(change.value.length);
  });

  it("outdents spaces and tabs without changing unindented lines", () => {
    const value = "  one\n\t two\nthree";
    const change = indentMarkdownSelection(value, 0, value.length, "outdent");

    expect(change.value).toBe("one\n two\nthree");
    expect(change.handled).toBe(true);
  });

  it("does not continue a list inside a fenced code block", () => {
    const value = "```md\n- example\n```";
    const change = continueMarkdownListAtSelection(value, value.length - 3, value.length - 3);

    expect(change.handled).toBe(false);
  });

  it("inserts an indented newline inside a fenced code block", () => {
    const value = "```ts\n  const answer = 42;\n```";
    const cursor = value.indexOf("42;") + 3;
    const change = continueMarkdownCodeBlockAtSelection(value, cursor, cursor);

    expect(change.value).toBe("```ts\n  const answer = 42;\n  \n```");
    expect(change.value.slice(change.selectionStart, change.selectionEnd)).toBe("");
    expect(change.selectionStart).toBe("```ts\n  const answer = 42;\n  ".length);
    expect(change.handled).toBe(true);
  });

  it("leaves Enter behavior unchanged outside a fenced code block", () => {
    const value = "ordinary text";
    expect(continueMarkdownCodeBlockAtSelection(value, value.length, value.length)).toMatchObject({
      value,
      handled: false,
    });
  });

  it("toggles inline Markdown markers and preserves the selected body", () => {
    const value = "write this";
    const wrapped = toggleMarkdownInline(value, 6, value.length, "~~", "strikethrough text");

    expect(wrapped.value).toBe("write ~~this~~");
    expect(wrapped.selectionStart).toBe(8);
    expect(wrapped.selectionEnd).toBe(12);

    const unwrapped = toggleMarkdownInline(wrapped.value, wrapped.selectionStart, wrapped.selectionEnd, "~~");
    expect(unwrapped.value).toBe(value);
    expect(unwrapped.selectionStart).toBe(6);
    expect(unwrapped.selectionEnd).toBe(value.length);
  });

  it("reports active inline markers for toolbar state without parsing rich nodes", () => {
    expect(isMarkdownInlineActive("**bold**", 2, 6, "**")).toBe(true);
    expect(isMarkdownInlineActive("**bold**", 0, 8, "**")).toBe(true);
    expect(isMarkdownInlineActive("plain", 0, 5, "**")).toBe(false);
    expect(isMarkdownInlineActive("`code`", 0, 0, "`")).toBe(false);
  });

  it("toggles list families across selected lines and exposes active-state checks", () => {
    const value = "first\nsecond";
    const numbered = toggleMarkdownListPrefix(value, 0, value.length, "numbered");

    expect(numbered.value).toBe("1. first\n1. second");
    expect(isMarkdownListActive(numbered.value, numbered.selectionStart, numbered.selectionEnd, "numbered")).toBe(true);
    expect(isMarkdownListActive(numbered.value, numbered.selectionStart, numbered.selectionEnd, "bullet")).toBe(false);

    const removed = toggleMarkdownListPrefix(
      numbered.value,
      numbered.selectionStart,
      numbered.selectionEnd,
      "numbered",
    );
    expect(removed.value).toBe(value);
    expect(removed.handled).toBe(true);
  });

  it("switches checklist and lettered markers without nesting old list prefixes", () => {
    const checklist = toggleMarkdownListPrefix("a. one\nb. two", 0, 14, "checklist");
    expect(checklist.value).toBe("- [ ] one\n- [ ] two");

    const lettered = toggleMarkdownListPrefix(checklist.value, 0, checklist.value.length, "lettered");
    expect(lettered.value).toBe("a. one\na. two");
    expect(isMarkdownListActive(lettered.value, 0, lettered.value.length, "lettered")).toBe(true);
  });

  it("applies and removes a blockquote prefix across selected lines", () => {
    const value = "first\nsecond";
    const quoted = toggleMarkdownLinePrefix(value, 0, value.length, "> ");
    expect(quoted.value).toBe("> first\n> second");

    const restored = toggleMarkdownLinePrefix(quoted.value, quoted.selectionStart, quoted.selectionEnd, "> ");
    expect(restored.value).toBe(value);
  });

  it("reports blockquote toolbar state from the selected source lines", () => {
    expect(isMarkdownLinePrefixActive("> first\n> second", 0, 17, "> ")).toBe(true);
    expect(isMarkdownLinePrefixActive("> first\nsecond", 0, 15, "> ")).toBe(false);
    expect(isMarkdownLinePrefixActive("first\nsecond", 0, 13, "> ")).toBe(false);
  });

  it("applies a heading level across selected lines and toggles the same level off", () => {
    const value = "first\nsecond";
    const headed = toggleMarkdownHeading(value, 0, value.length, 3);

    expect(headed.value).toBe("### first\n### second");
    expect(headed.selectionStart).toBe(4);
    expect(headed.selectionEnd).toBe(headed.value.length);

    const restored = toggleMarkdownHeading(headed.value, headed.selectionStart, headed.selectionEnd, 3);
    expect(restored.value).toBe(value);
  });

  it("replaces existing heading levels while preserving quote and indentation", () => {
    const value = "> # first\n  ## second";
    const changed = toggleMarkdownHeading(value, 0, value.length, 5);

    expect(changed.value).toBe("> ##### first\n  ##### second");
  });

  it("inserts a link and selects the URL placeholder", () => {
    const change = insertMarkdownLink("read this", 0, 4);

    expect(change.value).toBe("[read](https://) this");
    expect(change.value.slice(change.selectionStart, change.selectionEnd)).toBe("https://");
  });
});
