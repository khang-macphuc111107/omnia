import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listProfiles: vi.fn(async () => [{ id: "provider", displayName: "Provider", enabled: true }]),
  listModels: vi.fn(async () => [{ id: "model-a" }, { id: "model-b" }]),
  pickFolder: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock("./agent-api", () => ({
  agentApi: api,
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
}));

const prefs = vi.hoisted(() => ({
  readPrefs: vi.fn(() => ({ recentFolders: [] as string[], model: "model-b" })),
  rememberFolder: vi.fn((folder: string) => [folder]),
  writePrefs: vi.fn(),
}));
vi.mock("./prefs", () => prefs);

const store = vi.hoisted(() => {
  const state = {
    sessions: [] as Array<{ id: string; title: string; cwd: string; updatedAtMs: number; running?: boolean }>,
    activeId: null as string | null,
    create: vi.fn(async (_input: unknown) => {
      state.activeId = "new-session";
    }),
    send: vi.fn(async (_text: string, _images?: unknown[], _id?: string) => undefined),
    open: vi.fn(async (_id: string | null) => undefined),
  };
  const useAgentStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state });
  return { state, useAgentStore };
});
vi.mock("./agent-store", () => ({ useAgentStore: store.useAgentStore }));

import { HomeStart } from "./home-start";

const now = Date.now();

function session(id: string, cwd: string, minutesAgo: number, title = `Session ${id}`) {
  return { id, title, cwd, updatedAtMs: now - minutesAgo * 60_000 };
}

async function renderHome() {
  const onNavigate = vi.fn();
  render(<HomeStart onNavigate={onNavigate} />);
  await screen.findByRole("option", { name: "model-a" });
  expect(screen.getByLabelText("Model")).toHaveValue("model-b");
  return { onNavigate };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.state.activeId = null;
  store.state.sessions = [
    session("1", "D:/work/alpha", 1),
    session("2", "D:/work/beta", 5),
    session("3", "D:/work/alpha", 10),
    session("4", "D:/work/gamma", 20),
    session("5", "D:/work/beta", 30),
    session("6", "D:/work/delta", 40, "Oldest session"),
  ];
});

describe("HomeStart", () => {
  it("renders the composer, quick actions and recent sessions only", async () => {
    await renderHome();
    expect(screen.getByRole("heading", { name: "What should we work on?" })).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    expect(screen.getByLabelText("Project folder")).toHaveValue("D:/work/alpha");
    for (const name of ["New chat", "New project", "Open Projects"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    const recent = screen.getByRole("region", { name: "Recent" });
    expect(recent.querySelectorAll("li")).toHaveLength(5);
    expect(screen.queryByText("Oldest session")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Running now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Projects" })).not.toBeInTheDocument();
    const folderOptions = [...(screen.getByLabelText("Project folder") as HTMLSelectElement).options].map((option) => option.value);
    expect(folderOptions).toEqual(["D:/work/alpha", "D:/work/beta", "D:/work/gamma", "D:/work/delta", "\u0000choose"]);
  });

  it("keeps Send disabled until a folder and a non-empty prompt are set", async () => {
    store.state.sessions = [];
    await renderHome();
    const send = screen.getByRole("button", { name: "Send" });
    const prompt = screen.getByLabelText("Prompt");
    expect(send).toBeDisabled();
    expect(prompt).toHaveAttribute("placeholder", expect.stringContaining("Choose a project folder"));
    fireEvent.change(prompt, { target: { value: "Fix the bug" } });
    expect(send).toBeDisabled();

    api.pickFolder.mockResolvedValueOnce("D:/picked");
    fireEvent.change(screen.getByLabelText("Project folder"), { target: { value: "\u0000choose" } });
    await waitFor(() => expect(screen.getByLabelText("Project folder")).toHaveValue("D:/picked"));
    expect(send).toBeEnabled();

    fireEvent.change(prompt, { target: { value: "   " } });
    expect(send).toBeDisabled();
  });

  it("creates a session with the folder and model and sends the prompt as its first message", async () => {
    await renderHome();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "model-a" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "  Add tests  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(store.state.send).toHaveBeenCalledWith("Add tests", [], "new-session"));
    expect(store.state.create).toHaveBeenCalledWith({ cwd: "D:/work/alpha", profileId: "provider", model: "model-a", permissionMode: "ask_writes" });
    expect(prefs.rememberFolder).toHaveBeenCalledWith("D:/work/alpha");
    expect(prefs.writePrefs).toHaveBeenCalledWith({ profileId: "provider", model: "model-a" });
  });

  it("sends on Enter and inserts a newline on Shift+Enter", async () => {
    await renderHome();
    const prompt = screen.getByLabelText("Prompt");
    fireEvent.change(prompt, { target: { value: "Hello" } });
    fireEvent.keyDown(prompt, { key: "Enter", shiftKey: true });
    expect(store.state.create).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter" });
    await waitFor(() => expect(store.state.send).toHaveBeenCalledWith("Hello", [], "new-session"));
  });

  it("shows the error when creation fails", async () => {
    store.state.create.mockRejectedValueOnce(new Error("No provider key"));
    await renderHome();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Go" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No provider key");
    expect(store.state.send).not.toHaveBeenCalled();
  });

  it("opens a recent session on click", async () => {
    await renderHome();
    fireEvent.click(screen.getByRole("button", { name: /Session 2/ }));
    expect(store.state.open).toHaveBeenCalledWith("2");
  });

  it("selects a project from the folder chip", async () => {
    await renderHome();
    fireEvent.change(screen.getByLabelText("Project folder"), { target: { value: "D:/work/gamma" } });
    expect(screen.getByLabelText("Project folder")).toHaveValue("D:/work/gamma");
    expect(api.pickFolder).not.toHaveBeenCalled();
  });

  it("shows a Running now strip only for running sessions and opens one on click", async () => {
    store.state.sessions[3] = { ...session("4", "D:/work/gamma", 20, "Busy build"), running: true };
    await renderHome();
    const strip = screen.getByRole("region", { name: "Running now" });
    expect(strip.querySelectorAll("button")).toHaveLength(1);
    fireEvent.click(strip.querySelector("button")!);
    expect(store.state.open).toHaveBeenCalledWith("4");
  });

  it("runs the quick actions", async () => {
    const { onNavigate } = await renderHome();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByLabelText("Prompt")).toHaveFocus();

    api.pickFolder.mockResolvedValueOnce("D:/fresh");
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await waitFor(() => expect(screen.getByLabelText("Project folder")).toHaveValue("D:/fresh"));
    expect(prefs.rememberFolder).toHaveBeenCalledWith("D:/fresh");

    fireEvent.click(screen.getByRole("button", { name: "Open Projects" }));
    expect(onNavigate).toHaveBeenCalledWith("projects");
  });
});
