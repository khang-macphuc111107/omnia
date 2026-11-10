import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdeWorkspace } from "./ide-workspace";
import type { IdeAccess } from "./ide-access";
import type { IdeDocument, IdeListing, IdeRoot } from "./ide-model";

const root: IdeRoot = { id: "root", name: "sample", displayPath: "C:/sample", origin: "handle", readOnly: false };
const document: IdeDocument = { id: "root:src/main.ts", rootId: "root", relativePath: "src/main.ts", name: "main.ts", origin: "handle", content: "const value = 1;\n", version: "v1", saveMode: "original" };

function accessFixture(): IdeAccess & { saved: string[] } {
  const saved: string[] = [];
  const listing: IdeListing = { rootId: "root", relativePath: "", truncated: false, entries: [{ rootId: "root", name: "src", relativePath: "src", kind: "directory", byteSize: null }] };
  return {
    native: false, folderPickerAvailable: true, saved,
    listRoots: vi.fn(async () => [root]),
    pickFolder: vi.fn(async () => root),
    listDirectory: vi.fn(async (_rootId: string, path: string): Promise<IdeListing> => path === "" ? listing : { rootId: "root", relativePath: path, truncated: false, entries: [{ rootId: "root", name: "main.ts", relativePath: "src/main.ts", kind: "file", byteSize: document.content.length }] }),
    readFile: vi.fn(async () => document),
    importFiles: vi.fn(async (files: readonly File[]) => files.map((file) => ({ ...document, id: `file:${file.name}`, rootId: "file", relativePath: file.name, name: file.name, origin: "import" as const, content: "draft", saveMode: "copy" as const }))),
    saveFile: vi.fn(async (doc: IdeDocument, _baseline: string, content: string) => { saved.push(content); return { ...doc, content, version: "v2" }; }),
    exportCopy: vi.fn(),
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("rebuild IDE workspace", () => {
  it("retains newer dirty text when an asynchronous save completes", async () => {
    const access = accessFixture();
    let finishSave!: (doc: IdeDocument) => void;
    access.saveFile = vi.fn(() => new Promise<IdeDocument>((resolve) => { finishSave = resolve; }));
    render(<IdeWorkspace access={access} />);
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByRole("button", { name: /main.ts/ }));
    const editor = await screen.findByRole("textbox", { name: /Code editor/ });
    const submitted = "const value = 2;\n";
    const newer = "const value = 3;\n";
    fireEvent.change(editor, { target: { value: submitted } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(access.saveFile).toHaveBeenCalledTimes(1));
    fireEvent.change(editor, { target: { value: newer } });
    await act(async () => { finishSave({ ...document, content: submitted, version: "v2" }); });
    expect(editor).toHaveValue(newer);
    expect(screen.getByRole("button", { name: /●.*main.ts/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it.each(["The source changed outside Omnia", "The source was deleted or moved", "Write permission was denied"])("retains dirty text after %s", async (message) => {
    const access = accessFixture();
    access.saveFile = vi.fn(async () => { throw new Error(message); });
    render(<IdeWorkspace access={access} />);
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByRole("button", { name: /main.ts/ }));
    const editor = await screen.findByRole("textbox", { name: /Code editor/ });
    fireEvent.change(editor, { target: { value: "unsaved draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
    expect(editor).toHaveValue("unsaved draft");
    expect(screen.getByRole("button", { name: /●.*main.ts/ })).toBeInTheDocument();
  });

  it("checks a changed source without replacing a dirty buffer", async () => {
    const access = accessFixture();
    render(<IdeWorkspace access={access} />);
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByRole("button", { name: /main.ts/ }));
    const editor = await screen.findByRole("textbox", { name: /Code editor/ });
    fireEvent.change(editor, { target: { value: "my draft" } });
    access.readFile = vi.fn(async () => ({ ...document, content: "external text", version: "external" }));
    fireEvent.click(screen.getByRole("button", { name: "Check source" }));
    await screen.findByText(/Source changed.*dirty buffer/);
    expect(editor).toHaveValue("my draft");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload source" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Discard.*main.ts/ });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(editor).toHaveValue("my draft");
  });

  it("requires a discard decision before closing a dirty tab", async () => {
    const access = accessFixture();
    render(<IdeWorkspace access={access} />);
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByRole("button", { name: /main.ts/ }));
    const editor = await screen.findByRole("textbox", { name: /Code editor/ });
    fireEvent.change(editor, { target: { value: "my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Close main.ts" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Discard.*main.ts/ });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(editor).toHaveValue("my draft");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keeps edits typed while a source reload was in flight", async () => {
    const access = accessFixture();
    render(<IdeWorkspace access={access} />);
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByRole("button", { name: /main.ts/ }));
    const editor = await screen.findByRole("textbox", { name: /Code editor/ });
    let finishRead!: (doc: IdeDocument) => void;
    access.readFile = vi.fn(() => new Promise<IdeDocument>((resolve) => { finishRead = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Reload source" }));
    fireEvent.change(editor, { target: { value: "newer dirty edits" } });
    await act(async () => { finishRead({ ...document, content: "external", version: "v2" }); });
    expect(editor).toHaveValue("newer dirty edits");
    expect(screen.getByRole("button", { name: /●.*main.ts/ })).toBeInTheDocument();
  });

  it("does not replay a pending save on repeated Ctrl+S", async () => {
    const access = accessFixture();
    let finishSave!: (doc: IdeDocument) => void;
    access.saveFile = vi.fn(() => new Promise<IdeDocument>((resolve) => { finishSave = resolve; }));
    render(<IdeWorkspace access={access} />);
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByRole("button", { name: /main.ts/ }));
    const editor = await screen.findByRole("textbox", { name: /Code editor/ });
    fireEvent.change(editor, { target: { value: "draft" } });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(access.saveFile).toHaveBeenCalledTimes(1);
    await act(async () => { finishSave({ ...document, content: "draft", version: "v2" }); });
  });

  it("blocks a write with an unknown outcome until source reconciliation", async () => {
    const access = accessFixture();
    access.saveFile = vi.fn(async () => { throw { code: "ide_write_outcome_unknown", message: "Readback unavailable; check source" }; });
    render(<IdeWorkspace access={access} />);
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByRole("button", { name: /main.ts/ }));
    const editor = await screen.findByRole("textbox", { name: /Code editor/ });
    fireEvent.change(editor, { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getAllByText("Readback unavailable; check source").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(access.saveFile).toHaveBeenCalledTimes(1);
    expect(editor).toHaveValue("draft");
  });

  it("opens a selected folder, drills into a file, edits and verifies original save", async () => {
    const access = accessFixture();
    render(<IdeWorkspace access={access} />);
    expect(screen.getByText("Select a file to inspect")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /main.ts/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /main.ts/ }));
    const editor = await screen.findByRole("textbox", { name: /Code editor/ });
    fireEvent.change(editor, { target: { value: "const value = 2;\n" } });
    expect(screen.getByRole("button", { name: /●.*main.ts/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(access.saveFile).toHaveBeenCalledWith(document, document.content, "const value = 2;\n"));
    expect(access.saved).toEqual(["const value = 2;\n"]);
  });

  it("keeps read-only native drafts explicit and exports instead of pretending to save", async () => {
    const access = accessFixture();
    const nativeDocument = { ...document, origin: "native" as const, saveMode: "copy" as const };
    access.readFile = vi.fn(async () => nativeDocument);
    render(<IdeWorkspace access={access} />);
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByRole("button", { name: /main.ts/ }));
    await screen.findByRole("textbox", { name: /Code editor/ });
    expect(screen.getByRole("button", { name: "Export copy" })).toBeInTheDocument();
    expect(screen.getByText(/Read grant active/)).toBeInTheDocument();
  });

  it("filters and searches content without injecting markup", async () => {
    const access = accessFixture();
    render(<IdeWorkspace access={access} />);
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByRole("button", { name: /main.ts/ }));
    await screen.findByRole("textbox", { name: /Code editor/ });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), { target: { value: "main" } });
    expect(screen.getAllByRole("button", { name: /main.ts/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("<script>", { exact: false })).not.toBeInTheDocument();
  });
});
