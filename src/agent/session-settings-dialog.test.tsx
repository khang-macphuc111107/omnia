import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./permission-rules", () => ({
  PermissionRulesManager: () => <div aria-label="Permission rules" />,
}));


vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  agentApi: {
    update: vi.fn(),
    promptPresets: vi.fn(),
    savePromptPreset: vi.fn(),
    deletePromptPreset: vi.fn(),
    previewSystemPrompt: vi.fn(),
  },
}));
import { agentApi } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { SessionSettingsDialog } from "./session-settings-dialog";
import type { AgentSessionSummary } from "./types";

const api = vi.mocked(agentApi);
const session: AgentSessionSummary = {
  id: "s1",
  title: "T",
  cwd: "C:\\work",
  profileId: "p",
  model: "m",
  permissionMode: "ask_writes",
  fallbackModels: ["m2"],
  tokenBudget: 5000,
  tokensUsed: 1234,
  messageCount: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
};
const preset = { id: "pr1", name: "Terse", mode: "replace" as const, text: "Answer in one line." };

beforeEach(() => {
  vi.clearAllMocks();
  api.promptPresets.mockResolvedValue([preset]);
  api.update.mockImplementation(async (id, patch) => ({ ...session, id, ...patch }));
  useAgentStore.setState({ sessions: [{ ...session, running: false }], activeId: "s1" });
});

describe("SessionSettingsDialog", () => {
  it("uses scoped responsive styles and labels the dialog with its visible heading", async () => {
    render(<SessionSettingsDialog session={session} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Session settings" });
    expect(dialog).toHaveClass("ag-session-settings");
    expect(dialog.parentElement).toHaveClass("ag-session-settings-scrim");
    expect(dialog).toHaveAttribute("aria-labelledby", screen.getByRole("heading", { name: "Session settings" }).id);
    expect(screen.getByLabelText("System prompt").closest(".ag-system-prompt-editor")).not.toBeNull();
    await screen.findByRole("option", { name: "Terse" });
  });

  it("focuses the first field and traps Tab in both directions after controls change", async () => {
    render(<SessionSettingsDialog session={session} onClose={vi.fn()} />);
    const first = screen.getByLabelText("System prompt");
    await waitFor(() => expect(first).toHaveFocus());
    const last = screen.getByRole("button", { name: "Save" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.change(first, { target: { value: "append" } });
    fireEvent.change(screen.getByLabelText("System prompt text"), { target: { value: "Custom prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as preset" }));
    screen.getByLabelText("Preset name").focus();
    expect(screen.getByLabelText("Preset name")).toHaveFocus();
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("closes on Escape from an input and restores focus to the opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open settings</button>
        {open ? <SessionSettingsDialog session={session} onClose={() => setOpen(false)} /> : null}
      </>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open settings" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByLabelText("System prompt")).toHaveFocus());
    const budget = screen.getByLabelText("Token budget");
    budget.focus();
    fireEvent.keyDown(budget, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(api.update).not.toHaveBeenCalled();
  });

  it("lets a nested control consume Escape without dismissing settings", async () => {
    const onClose = vi.fn();
    render(<SessionSettingsDialog session={session} onClose={onClose} />);
    const field = screen.getByLabelText("System prompt");
    field.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await screen.findByRole("option", { name: "Terse" });
  });

  it("keeps long multiline previews intact and keyboard focusable", async () => {
    const prompt = `${"very-long-path/".repeat(100)}\n${"instruction\n".repeat(200)}`;
    api.previewSystemPrompt.mockResolvedValue(prompt);
    render(<SessionSettingsDialog session={session} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview full prompt" }));
    const preview = await screen.findByLabelText("Full system prompt");
    expect(preview.textContent).toBe(prompt);
    expect(preview).toHaveAttribute("tabindex", "0");
    preview.focus();
    expect(preview).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
  it("loading a preset fills the textarea and save sends systemPrompt with fallbacks and budget", async () => {
    const onClose = vi.fn();
    render(<SessionSettingsDialog session={session} onClose={onClose} />);
    expect(screen.getByText(/1,234 tokens/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("m2")).toBeInTheDocument();
    expect(screen.getByDisplayValue("5000")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "append" } });
    await screen.findByRole("option", { name: "Terse" });
    fireEvent.change(screen.getByLabelText("Prompt preset"), { target: { value: "pr1" } });
    expect(screen.getByLabelText("System prompt text")).toHaveValue("Answer in one line.");
    expect(screen.getByLabelText("System prompt")).toHaveValue("replace");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith("s1", {
        systemPrompt: { mode: "replace", text: "Answer in one line." },
        fallbackModels: ["m2"],
        tokenBudget: 5000,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("default mode clears the override", async () => {
    render(<SessionSettingsDialog session={{ ...session, systemPrompt: { mode: "append", text: "x" } }} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("s1", expect.objectContaining({ systemPrompt: null })));
  });

  it("keeps the form bound to its opened settings revision after a live summary refresh", async () => {
    const first = { ...session, settingsRevision: 5 };
    const { rerender } = render(<SessionSettingsDialog session={first} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Token budget"), { target: { value: "6000" } });
    useAgentStore.setState({ sessions: [{ ...session, settingsRevision: 6, running: false }] });
    rerender(<SessionSettingsDialog session={{ ...session, settingsRevision: 6 }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("s1", expect.objectContaining({ expectedSettingsRevision: 5, tokenBudget: 6000 })));
  });

  it("saves the current text as a preset", async () => {
    api.promptPresets.mockResolvedValue([]);
    api.savePromptPreset.mockResolvedValue([preset]);
    render(<SessionSettingsDialog session={session} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "replace" } });
    fireEvent.change(screen.getByLabelText("System prompt text"), { target: { value: "Answer in one line." } });
    fireEvent.click(screen.getByRole("button", { name: "Save as preset" }));
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Terse" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
    await waitFor(() =>
      expect(api.savePromptPreset).toHaveBeenCalledWith({ id: undefined, name: "Terse", mode: "replace", text: "Answer in one line." }),
    );
  });

  it("preview shows the composed prompt read-only", async () => {
    api.previewSystemPrompt.mockResolvedValue("You are Omnia.\n\n# Environment");
    render(<SessionSettingsDialog session={session} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview full prompt" }));
    const pre = await screen.findByLabelText("Full system prompt");
    expect(pre.tagName).toBe("PRE");
    expect(pre).toHaveTextContent("You are Omnia.");
    expect(api.previewSystemPrompt).toHaveBeenCalledWith("s1");
  });

  it("rejects an invalid token budget without calling update", async () => {
    render(<SessionSettingsDialog session={session} onClose={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue("5000"), { target: { value: "-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("positive whole number");
    expect(api.update).not.toHaveBeenCalled();
  });
});
