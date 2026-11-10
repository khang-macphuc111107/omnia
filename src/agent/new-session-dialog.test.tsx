import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-api", () => ({
  agentApi: {
    listProfiles: vi.fn(async () => [{ id: "provider", displayName: "Provider", enabled: true }]),
    listModels: vi.fn(async () => [{ id: "model" }]),
    promptPresets: vi.fn(async () => []),
    pickFolder: vi.fn(async () => null),
  },
  errorMessage: (cause: unknown) => String(cause),
}));

vi.mock("./prefs", () => ({
  readPrefs: () => ({ recentFolders: ["D:/project"], model: "model" }),
  rememberFolder: vi.fn((folder: string) => [folder]),
  writePrefs: vi.fn(),
}));

import { NewSessionDialog } from "./new-session-dialog";

beforeEach(() => {
  vi.clearAllMocks();
});

async function openDialog(onCreate = vi.fn(async () => undefined), onClose = vi.fn()) {
  const result = render(<NewSessionDialog onCreate={onCreate} onClose={onClose} />);
  await waitFor(() => expect(screen.getByLabelText("Provider")).toHaveValue("provider"));
  await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveFocus());
  return { ...result, onCreate, onClose };
}

async function expandAdvanced() {
  const summary = screen.getByText("Advanced");
  const details = summary.closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByLabelText("Token budget");
  return { summary, details };
}

describe("NewSessionDialog", () => {
  it("uses viewport-contained layout with a separate scroll body and persistent actions", async () => {
    await openDialog();
    const dialog = screen.getByRole("dialog", { name: "New session" });
    expect(dialog).toHaveClass("ag-new-session");
    expect(dialog.parentElement).toHaveClass("ag-new-session-scrim");
    const body = dialog.querySelector(".ag-new-session__body")!;
    expect(body).toContainElement(screen.getByLabelText("Folder"));
    expect(body).not.toContainElement(screen.getByRole("button", { name: "Create session" }));
    expect(body).not.toContainElement(screen.getByRole("heading", { name: "New session" }));
  });

  it("excludes collapsed Advanced controls and includes the summary in the keyboard loop", async () => {
    await openDialog();
    expect(screen.queryByLabelText("Token budget")).not.toBeInTheDocument();
    expect(screen.getByText("Advanced")).toHaveAttribute("tabindex", "0");
    const folder = screen.getByLabelText("Folder");
    folder.focus();
    fireEvent.keyDown(folder, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Create session" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(folder).toHaveFocus();
  });

  it("preserves advanced values across collapse and focuses validation feedback", async () => {
    const { onCreate } = await openDialog();
    const { details } = await expandAdvanced();
    fireEvent.change(screen.getByLabelText("Token budget"), { target: { value: "-1" } });
    details.open = false;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.queryByLabelText("Token budget")).not.toBeInTheDocument());
    await expandAdvanced();
    expect(screen.getByLabelText("Token budget")).toHaveValue("-1");
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Token budget must be a positive whole number.");
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("locks edits and dismissal while creating, prevents duplicate submits, and focuses failures", async () => {
    let reject!: (cause: Error) => void;
    const onCreate = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const { onClose } = await openDialog(onCreate);
    const create = screen.getByRole("button", { name: "Create session" });
    fireEvent.click(create);
    expect(screen.getByRole("heading", { name: "New session" })).toHaveFocus();
    expect(screen.getByLabelText("Folder")).toBeDisabled();
    expect(screen.getByLabelText("Provider")).toBeDisabled();
    expect(screen.getByLabelText("Model")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    const form = create.closest("form")!;
    expect(form).toHaveAttribute("aria-busy", "true");
    fireEvent.submit(form);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => reject(new Error("Creation failed")));
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(screen.getByLabelText("Folder")).not.toBeDisabled();
    expect(create).not.toBeDisabled();
  });

  it("submits advanced settings and closes after successful creation", async () => {
    const { onCreate, onClose } = await openDialog();
    await expandAdvanced();
    fireEvent.change(screen.getByLabelText("Fallback models (comma-separated)"), { target: { value: " backup, another " } });
    fireEvent.change(screen.getByLabelText("Token budget"), { target: { value: "1000" } });
    fireEvent.submit(screen.getByRole("button", { name: "Create session" }).closest("form")!);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: "D:/project", model: "model", profileId: "provider", fallbackModels: ["backup", "another"], tokenBudget: 1000 }));
  });

  it("does not submit an Enter key used to confirm IME composition", async () => {
    const { onCreate } = await openDialog();
    expect(fireEvent.keyDown(screen.getByLabelText("Folder"), { key: "Enter", isComposing: true })).toBe(false);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("restores focus to the opener on unmount and supports Escape dismissal", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount, onClose } = await openDialog();
    fireEvent.keyDown(screen.getByLabelText("Folder"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
