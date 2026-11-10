import { describe, expect, it } from "vitest";
import { completeTabSave, createTab, editTab, findInText, isTabDirty, normalizeRelativePath, serializeEditorText, tokenizeSource, type IdeDocument } from "./ide-model";

const document: IdeDocument = { id: "root:src/main.ts", rootId: "root", relativePath: "src/main.ts", name: "main.ts", origin: "native", content: "const value = 1;\r\n", version: "a" , saveMode: "copy" };

describe("rebuild IDE model", () => {
  it("rejects absolute and traversal paths while accepting nested relative paths", () => {
    expect(normalizeRelativePath("src\\main.ts")).toBe("src/main.ts");
    expect(normalizeRelativePath("", true)).toBe("");
    expect(() => normalizeRelativePath("../secret.txt")).toThrowError(/Parent traversal/);
    expect(() => normalizeRelativePath("C:/secret.txt")).toThrowError(/drive prefix/);
    expect(() => normalizeRelativePath("/secret.txt")).toThrowError(/inside/);
  });

  it("tracks dirty drafts and preserves line ending policy on save", () => {
    const tab = createTab(document);
    expect(isTabDirty(tab)).toBe(false);
    const edited = editTab(tab, "const value = 2;\n");
    expect(isTabDirty(edited)).toBe(true);
    expect(serializeEditorText(edited.content, document.content)).toBe("const value = 2;\r\n");
  });

  it("commits only the submitted baseline and retains newer edits and their revision", () => {
    const tab = createTab(document);
    const submitted = "saved\n";
    const newer = editTab(editTab(tab, submitted), "newer draft\n");
    const saved = completeTabSave({ ...newer, saving: true }, { ...document, content: "saved\r\n", version: "new" }, submitted);
    expect(saved.content).toBe("newer draft\n");
    expect(saved.baseline).toBe(submitted);
    expect(saved.document.content).toBe("saved\r\n");
    expect(saved.editRevision).toBe(2);
    expect(saved.instanceId).toBe(tab.instanceId);
    expect(isTabDirty(saved)).toBe(true);
    expect(saved.saving).toBe(false);
  });

  it("gives a reopened path a new tab instance so late callbacks cannot replace it", () => {
    expect(createTab(document).instanceId).not.toBe(createTab(document).instanceId);
  });

  it("bounds and reports search matches", () => {
    expect(findInText("Alpha alpha ALPHA", "alpha")).toEqual([{ from: 0, to: 5 }, { from: 6, to: 11 }, { from: 12, to: 17 }]);
    expect(findInText("Alpha alpha ALPHA", "alpha", true)).toEqual([{ from: 6, to: 11 }]);
  });

  it("provides escaped lexical tokens without executing source", () => {
    expect(tokenizeSource("const label = \"<script>\"; // note").map((token) => token.kind)).toEqual(["keyword", "text", "string", "punctuation", "text", "comment"]);
    expect(tokenizeSource("x".repeat(120_001))).toEqual([{ text: "x".repeat(120_001), kind: "text" }]);
  });
});
