import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectControlDeck } from "./project-control-deck";
import { projectOverviewFromProject } from "./project-catalog";
import { useWorkspaceOverlayStore } from "./overlay-store";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();
const initialOverlayState = useWorkspaceOverlayStore.getState();

describe("Project Control Deck preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    useWorkspaceOverlayStore.setState(initialOverlayState, true);
    document.body.innerHTML = "";
  });

  it("keeps tab state and preview boundaries explicit", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    const snapshot = screen.getByRole("tab", { name: "Snapshot" });
    expect(snapshot).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tablist", { name: "Project control views" })).toHaveAttribute(
      "aria-orientation",
      "horizontal",
    );
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "project-control-deck-tab-snapshot",
    );
    expect(screen.getByText(/No native mutation has been sent/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    expect(screen.getByRole("tab", { name: "Chats" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByPlaceholderText(/Search chats in this project/i)).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Chats" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Context" })).toHaveAttribute("aria-selected", "true");
  });

  it("scrolls selected Project workbenches into view without unsolicited focus changes", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const view = render(
      <ProjectControlDeck project={project} conversations={state.conversations} />,
    );
    const tabList = screen.getByRole("tablist", { name: "Project control views" });
    const scrollIntoView = vi.fn();
    Object.defineProperty(tabList, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });

    try {
      view.rerender(<ProjectControlDeck project={project} conversations={state.conversations} />);
      expect(scrollIntoView).not.toHaveBeenCalled();

      const quickAction = screen.getByRole("button", { name: "Open Chat list" });
      quickAction.focus();
      fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
      expect(document.activeElement).toBe(quickAction);

      const planTab = screen.getByRole("tab", { name: "Plan" });
      planTab.focus();
      fireEvent.keyDown(planTab, { key: "ArrowLeft" });
      expect(screen.getByRole("tab", { name: "Context" })).toHaveAttribute("aria-selected", "true");
      expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Context" }));
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    } finally {
      if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
      else Reflect.deleteProperty(window, "matchMedia");
    }
  });

  it("keeps the Project policy draft and undo history when switching deck tabs", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    const advanced = screen.getByRole("button", { name: /Advanced policy & data/i });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("combobox", { name: "Main-agent model preview" })).not.toBeInTheDocument();
    fireEvent.click(advanced);
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    const mainModel = screen.getByRole("combobox", { name: "Main-agent model preview" });
    fireEvent.change(mainModel, { target: { value: "quality" } });
    expect(mainModel).toHaveValue("quality");
    fireEvent.click(advanced);
    expect(screen.queryByRole("combobox", { name: "Main-agent model preview" })).not.toBeInTheDocument();
    fireEvent.click(advanced);
    expect(screen.getByRole("combobox", { name: "Main-agent model preview" })).toHaveValue("quality");

    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    fireEvent.click(screen.getByRole("tab", { name: "Snapshot" }));

    const restoredModel = screen.getByRole("combobox", { name: "Main-agent model preview" });
    expect(restoredModel).toHaveValue("quality");
    const undo = screen.getByRole("button", { name: "Undo Project policy preview change" });
    expect(undo).toBeEnabled();
    fireEvent.click(undo);
    expect(restoredModel).toHaveValue(project.modelProfileId || "auto");
  });

  it("shares context budget and source inclusion choices across Snapshot and Context", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Advanced policy & data/i }));
    fireEvent.change(screen.getByRole("slider", { name: "Context input budget preview" }), { target: { value: "5200" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include active memories in context preview" }));

    fireEvent.click(screen.getByRole("tab", { name: "Context" }));
    const contextBudget = await screen.findByRole("slider", { name: "Context token budget" });
    expect(contextBudget).toHaveValue("5200");
    expect(screen.getByRole("checkbox", { name: "Include active memories" })).not.toBeChecked();

    fireEvent.change(contextBudget, { target: { value: "6400" } });
    fireEvent.click(screen.getByRole("tab", { name: "Snapshot" }));
    expect(screen.getByRole("slider", { name: "Context input budget preview" })).toHaveValue("6400");
    expect(screen.getByRole("checkbox", { name: "Include active memories in context preview" })).not.toBeChecked();
  });

  it("keeps the cache inventory display filter in Project policy undo/redo and resets a newly selected Project", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const view = render(<ProjectControlDeck project={project} conversations={state.conversations} />);
    fireEvent.click(screen.getByRole("button", { name: /Advanced policy & data/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Inspect user-managed cache/i }, { timeout: 10000 }));
    const filter = screen.getByRole("combobox", { name: "Local cache display filter" });
    fireEvent.change(filter, { target: { value: "reusable" } });
    expect(filter).toHaveValue("reusable");
    await waitFor(() => expect(screen.getByText(/Inventory view: reusable/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Undo Project policy preview change" }));
    await waitFor(() => expect(filter).toHaveValue("all"));
    fireEvent.click(screen.getByRole("button", { name: "Redo Project policy preview change" }));
    await waitFor(() => expect(filter).toHaveValue("reusable"));

    const otherProject = state.projects.find((candidate) => candidate.id !== project.id);
    expect(otherProject).toBeDefined();
    view.rerender(<ProjectControlDeck project={otherProject!} conversations={state.conversations} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Advanced policy & data/i })).toHaveAttribute("aria-expanded", "false"));
    fireEvent.click(screen.getByRole("button", { name: /Advanced policy & data/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Inspect user-managed cache/i }, { timeout: 10000 }));
    expect((await screen.findByRole("combobox", { name: "Local cache display filter" }))).toHaveValue("all");
  }, 15000);

  it("never upgrades renderer context health to a compiled Ready claim", () => {
    const state = useWorkspaceStore.getState();
    const project = {
      ...state.projects[0]!,
      contextHealth: "ready" as const,
    };

    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
      />,
    );

    expect(screen.queryByText("Ready", { exact: true })).not.toBeInTheDocument();
    expect(screen.getAllByText("Referenced · not indexed", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByText("Context availability", { exact: true })).toBeInTheDocument();
  });

  it("uses the selected Project overview revision in the Snapshot context posture", () => {
    const state = useWorkspaceStore.getState();
    const selected = state.projects[0]!;
    const project = {
      ...selected,
      contextHealth: "ready" as const,
      overview: {
        ...projectOverviewFromProject(selected),
        status: "current" as const,
        contextRevisionId: "ctx-17",
        sourceEventWatermark: 17,
      },
    };

    render(<ProjectControlDeck project={project} conversations={state.conversations} />);

    expect(screen.getAllByText("Compiled · native evidence", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByText("Native revision ctx-17 is available for inspection.")).toBeInTheDocument();
  });

  it("gives the selected Project a bounded unified signal center", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    expect(screen.getByRole("tab", { name: "Signals" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: `${project.name} signal center` })).toBeInTheDocument();
      expect(screen.getByText(/Renderer-local signal center/i)).toBeInTheDocument();
      expect(screen.getByText(/durable run journal/i)).toBeInTheDocument();
    });
  });

  it("carries a selected plan task into the handoff workbench", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    fireEvent.click(screen.getByRole("tab", { name: "Roadmap & planning" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Project planning studio" })).toBeInTheDocument(), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: /Map project scope and constraints/i }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff for selected task" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Handoff" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("region", { name: "Selected project plan handoff seed" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Selected project plan handoff seed" })).toHaveTextContent("Map project scope and constraints");
    }, { timeout: 5000 });
    expect(screen.getAllByText(/plan-to-handoff seed only/i).length).toBeGreaterThan(0);
  });

  it("passes the selected Project scope to its Goal Studio draft across Plan remounts", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const key = `omnia.goal-task-studio.session.v1:${encodeURIComponent(project.id)}`;
    window.sessionStorage.removeItem(key);
    render(<ProjectControlDeck project={project} conversations={state.conversations} />);

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    await screen.findByRole("heading", { name: "Mission plan dashboard" });
    fireEvent.change(screen.getByRole("textbox", { name: "New goal title" }), { target: { value: "Scoped Plan draft" } });
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(key) ?? "{}").goalTitle).toBe("Scoped Plan draft"));

    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(await screen.findByRole("textbox", { name: "New goal title" })).toHaveValue("Scoped Plan draft");
    window.sessionStorage.removeItem(key);
  });

  it("opens Goals first and preserves both planning drafts while switching Plan workspaces", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const key = `omnia.goal-task-studio.session.v1:${encodeURIComponent(project.id)}`;
    window.sessionStorage.removeItem(key);
    render(<ProjectControlDeck project={project} conversations={state.conversations} />);

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    const tabs = screen.getByRole("tablist", { name: "Plan workspaces" });
    const goalsTab = within(tabs).getByRole("tab", { name: "Goals & tasks" });
    const roadmapTab = within(tabs).getByRole("tab", { name: "Roadmap & planning" });
    expect(goalsTab).toHaveAttribute("aria-selected", "true");
    expect(goalsTab).toHaveAttribute("aria-controls", "project-control-deck-plan-panel-goals");
    expect(screen.queryByRole("heading", { name: "Project planning studio" })).not.toBeInTheDocument();
    const goalTitle = await screen.findByRole("textbox", { name: "New goal title" });
    fireEvent.change(goalTitle, { target: { value: "Keep Goal draft" } });

    goalsTab.focus();
    fireEvent.keyDown(goalsTab, { key: "ArrowRight" });
    expect(roadmapTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(roadmapTab);
    expect(await screen.findByRole("heading", { name: "Project planning studio" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Project plan task search" }), { target: { value: "scope" } });

    fireEvent.click(goalsTab);
    expect(screen.queryByRole("heading", { name: "Project planning studio" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "New goal title" })).toHaveValue("Keep Goal draft");
    fireEvent.click(roadmapTab);
    expect(screen.getByRole("textbox", { name: "Project plan task search" })).toHaveValue("scope");
    window.sessionStorage.removeItem(key);
  });

  it("exposes the project overview quick actions with truthful availability", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    let newChatCount = 0;
    let addFolderCount = 0;
    let chatListCount = 0;
    let settingsCount = 0;

    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        onNewChat={() => { newChatCount += 1; }}
        onAddFolder={() => { addFolderCount += 1; }}
        onOpenChatList={() => { chatListCount += 1; }}
        onOpenProjectSettings={() => { settingsCount += 1; }}
      />,
    );

    const actions = screen.getByRole("toolbar", { name: "Project quick actions" });
    expect(within(actions).getByRole("button", { name: "New chat" })).toBeEnabled();
    expect(within(actions).getByRole("button", { name: "Add folder" })).toBeEnabled();
    expect(within(actions).getByRole("button", { name: "Open Chat list" })).toBeEnabled();
    expect(within(actions).getByRole("button", { name: "Project settings" })).toBeEnabled();

    fireEvent.click(within(actions).getByRole("button", { name: "New chat" }));
    fireEvent.click(within(actions).getByRole("button", { name: "Add folder" }));
    fireEvent.click(within(actions).getByRole("button", { name: "Open Chat list" }));
    fireEvent.click(within(actions).getByRole("button", { name: "Project settings" }));

    expect(newChatCount).toBe(1);
    expect(addFolderCount).toBe(1);
    expect(chatListCount).toBe(1);
    expect(settingsCount).toBe(1);
  });

  it("maps the normative Project Overview tabs to truthful preview surfaces", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    let settingsCount = 0;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        onOpenProjectSettings={() => { settingsCount += 1; }}
      />,
    );

    const mapping = screen.getByRole("navigation", { name: "Project Overview tab mapping" });
    expect(within(mapping).getByRole("heading", { name: "Normative tabs mapped to this preview" })).toBeInTheDocument();
    expect(within(mapping).getByRole("button", { name: "Conversations overview mapping" })).toHaveTextContent("Chats tab");
    expect(within(mapping).getByRole("button", { name: "Context overview mapping" })).toHaveTextContent("Context tab");
    expect(within(mapping).getByRole("button", { name: "Files overview mapping" })).toHaveTextContent("Access preview");
    expect(within(mapping).getByRole("button", { name: "Memory overview mapping" })).toHaveTextContent("Snapshot candidates");
    expect(within(mapping).getByRole("button", { name: "Skills overview mapping" })).toHaveTextContent("Snapshot candidates");
    expect(within(mapping).getAllByText("Preview", { exact: true })).toHaveLength(4);
    expect(within(mapping).getAllByText("Partial", { exact: true })).toHaveLength(2);
    expect(within(mapping).getByRole("button", { name: "Settings overview mapping" })).toBeEnabled();

    fireEvent.click(within(mapping).getByRole("button", { name: "Conversations overview mapping" }));
    expect(screen.getByRole("tab", { name: "Chats" })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Chats" }));
    fireEvent.click(within(mapping).getByRole("button", { name: "Files overview mapping" }));
    expect(screen.getByRole("tab", { name: "Access" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(mapping).getByRole("button", { name: "Memory overview mapping" }));
    expect(screen.getByRole("tab", { name: "Snapshot" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(mapping).getByRole("button", { name: "Settings overview mapping" }));
    expect(settingsCount).toBe(1);
    expect(within(mapping).getByText(/Files, Memory, Skills, and Settings are mapped surfaces/i)).toBeInTheDocument();
  });

  it("marks the Settings mapping unavailable when its host callback is absent", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
      />,
    );

    const mapping = screen.getByRole("navigation", { name: "Project Overview tab mapping" });
    expect(within(mapping).getByRole("button", { name: "Settings overview mapping" })).toBeDisabled();
    expect(within(mapping).getByRole("button", { name: "Settings overview mapping" })).toHaveTextContent("Unavailable");
  });

  it("keeps unavailable project quick actions disabled instead of implying native support", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
      />,
    );

    const actions = screen.getByRole("toolbar", { name: "Project quick actions" });
    expect(within(actions).getByRole("button", { name: "New chat" })).toBeDisabled();
    expect(within(actions).getByRole("button", { name: "Add folder" })).toBeDisabled();
    expect(within(actions).getByRole("button", { name: "Project settings" })).toBeDisabled();
    expect(within(actions).getByRole("button", { name: "Open Chat list" })).toBeEnabled();
  });

  it("offers local accent and chat controls without mutating native project state", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const onOpenChat = () => undefined;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
        onOpenChat={onOpenChat}
      />,
    );

    const initialAccent = project.accent;
    const accentButton = screen.getByRole("button", { name: /Use accent #19b7a5/i });
    fireEvent.click(accentButton);
    expect(accentButton).toHaveAttribute("aria-pressed", "true");
    expect(useWorkspaceStore.getState().projects[0]?.accent).toBe(initialAccent);

    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    const chatPanel = screen.getByRole("tabpanel");
    const activeFilter = within(chatPanel).getByRole("button", { name: "Active" });
    fireEvent.click(activeFilter);
    expect(activeFilter).toHaveClass("is-active");
    expect(within(chatPanel).getByText(/Chat navigation is live in the renderer/i)).toBeInTheDocument();
  });

  it("gives labeled control clusters an explicit group semantics", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
      />,
    );

    expect(screen.getByRole("group", { name: "Project accent preview" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    expect(screen.getByRole("group", { name: "Project chat view controls" })).toBeInTheDocument();
  });

  it("makes the snapshot metadata disclosure reversible and explicit", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(<ProjectControlDeck project={project} conversations={state.conversations} />);
    const disclosure = screen.getByRole("button", { name: "Show project metadata" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveAttribute("aria-controls", "project-deck-metadata");
    expect(screen.queryByRole("definition", { name: project.id })).not.toBeInTheDocument();
    fireEvent.click(disclosure);
    expect(screen.getByRole("button", { name: "Hide project metadata" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(project.id, { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide project metadata" }));
    expect(screen.getByRole("button", { name: "Show project metadata" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(project.id, { exact: true })).not.toBeInTheDocument();
  });

  it("reinitializes renderer-only project previews when the selected project changes", async () => {
    const state = useWorkspaceStore.getState();
    const sourceProject = state.projects[0]!;
    const firstProject = {
      ...sourceProject,
      id: "project_control_deck_alpha",
      name: "Alpha",
      pinned: true,
      accent: "#4f8cff",
    };
    const secondProject = {
      ...sourceProject,
      id: "project_control_deck_beta",
      name: "Beta",
      pinned: true,
      accent: "#ee6d8a",
    };
    const { rerender } = render(
      <ProjectControlDeck
        project={firstProject}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Use accent #19b7a5" }));
    fireEvent.click(screen.getByRole("button", { name: "Unpin in preview" }));
    expect(screen.getByRole("button", { name: "Pin in preview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show project metadata" }));
    expect(screen.getByRole("button", { name: "Hide project metadata" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    expect(screen.getByRole("tab", { name: "Chats" })).toHaveAttribute("aria-selected", "true");

    rerender(
      <ProjectControlDeck
        project={secondProject}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Snapshot" })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByPlaceholderText(/Search chats in this project/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show project metadata" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Use accent #ee6d8a" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Unpin in preview" })).toBeInTheDocument();
    });
  });

  it("keeps project customization reversible and exposes a renderer-local export", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    const initialAccentButton = screen.getByRole("button", { name: `Use accent ${project.accent}` });
    fireEvent.click(screen.getByRole("button", { name: "Use accent #19b7a5" }));
    fireEvent.click(screen.getByRole("button", { name: project.pinned ? "Unpin in preview" : "Pin in preview" }));
    expect(screen.getByRole("button", { name: "Undo project preview change" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Undo project preview change" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo project preview change" }));
    expect(initialAccentButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Redo project preview change" }));
    expect(screen.getByRole("button", { name: "Use accent #19b7a5" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const exportPreview = screen.getByRole("region", { name: "Project export preview" });
    expect(within(exportPreview).getByRole("code")).toHaveTextContent(/omnia\.project-deck-preview\.v1/i);
    fireEvent.change(within(exportPreview).getByRole("combobox", { name: "Project export format" }), { target: { value: "markdown" } });
    expect(within(exportPreview).getByRole("code")).toHaveTextContent(new RegExp(`${project.name} project preview`, "i"));
    expect(within(exportPreview).getByText(/does not persist project settings/i)).toBeInTheDocument();
  });

  it("keeps model style and preference options inside the renderer preview", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    fireEvent.click(screen.getByRole("button", { name: "Creative" }));
    expect(screen.getByText(/Model style Creative selected in the renderer preview/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /prefer deeper reasoning/i }));
    expect(screen.getByText(/Reasoning preference changed in the renderer preview/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /prefer deeper reasoning/i })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Undo project preview change" }));
    expect(screen.getByRole("checkbox", { name: /prefer deeper reasoning/i })).not.toBeChecked();
  });
  it("shows the full route inheritance chain inside the project model surface", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    expect(await screen.findByRole("heading", { name: "Route inheritance" })).toBeInTheDocument();
    expect(screen.getByText("App default → Profile → Project → Chat → Run")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project route override" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Chat route override" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Run or turn route override" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /Effective route:/i })).toBeInTheDocument();
    expect(screen.getByText(/No native project\/chat settings are written/i)).toBeInTheDocument();
  });

  it("keeps optional model workbenches collapsed until the user opens them", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    const toggle = screen.getByRole("button", { name: /Routing, local models & orchestration/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Role routing assignments" })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("heading", { name: "Role routing assignments" }, { timeout: 5000 })).toBeInTheDocument();
    const advancedTabs = screen.getByRole("tablist", { name: "Advanced model workbenches" });
    expect(advancedTabs).toHaveAttribute("aria-orientation", "horizontal");
    const roleRoutingTab = within(advancedTabs).getByRole("tab", { name: /Role routing/i });
    expect(roleRoutingTab).toHaveAttribute("aria-selected", "true");
    expect(roleRoutingTab).toHaveAttribute("tabindex", "0");
    const localReadinessTab = within(advancedTabs).getByRole("tab", { name: /Local readiness/i });
    expect(localReadinessTab).toHaveAttribute("tabindex", "-1");
    expect(within(advancedTabs).getByRole("tab", { name: /Role routing/i })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(roleRoutingTab, { key: "ArrowRight" });
    expect(localReadinessTab).toHaveAttribute("aria-selected", "true");
    expect(localReadinessTab).toHaveAttribute("tabindex", "0");
    expect(document.activeElement).toBe(localReadinessTab);
    expect(await screen.findByRole("heading", { name: "Local Model Readiness" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Role routing assignments" })).not.toBeInTheDocument();

    fireEvent.keyDown(localReadinessTab, { key: "End" });
    const agentDagTab = within(advancedTabs).getByRole("tab", { name: /Agent DAG/i });
    expect(agentDagTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(agentDagTab);

    fireEvent.keyDown(agentDagTab, { key: "Home" });
    expect(roleRoutingTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(roleRoutingTab);
  });

  it("carries the selected Plan task into Handoff without dispatching native work", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    fireEvent.click(screen.getByRole("tab", { name: "Roadmap & planning" }));
    const prepare = await screen.findByRole("button", { name: "Prepare handoff for selected task" });
    fireEvent.click(prepare);

    expect(screen.getByRole("tab", { name: "Handoff" })).toHaveAttribute("aria-selected", "true");
    const seed = await screen.findByRole("region", { name: "Selected project plan handoff seed" });
    expect(within(seed).getByText(/Renderer-local plan-to-handoff seed only/i)).toBeInTheDocument();
    const packagePreview = screen.getByRole("region", { name: "Project handoff package preview" });
    expect(within(packagePreview).getByRole("code")).toHaveTextContent(/"planSeed"/);
    expect(within(packagePreview).getByRole("code")).toHaveTextContent(/"taskId"/);
  });

  it("stages the selected Plan task in an empty Project Chat without replacing an existing draft", async () => {
    const previous = useWorkspaceStore.getState();
    const project = previous.projects[0]!;
    const source = previous.conversations[0]!;
    const emptyChat = { ...source, id: "project-plan-chat-empty", title: "Empty target", projectId: project.id, draft: "", hasDraft: false, archived: false, runState: null };
    const occupiedChat = { ...source, id: "project-plan-chat-occupied", title: "Protected draft", projectId: project.id, draft: "Keep this work", hasDraft: true, archived: false, runState: null };
    useWorkspaceStore.setState({ conversations: [occupiedChat, emptyChat], activeConversationId: occupiedChat.id });
    render(<ProjectControlDeck
      project={project}
      conversations={useWorkspaceStore.getState().conversations}
      onOpenChat={useWorkspaceStore.getState().selectConversation}
    />);
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    fireEvent.click(screen.getByRole("tab", { name: "Roadmap & planning" }));
    const prepare = await screen.findByRole("button", { name: "Prepare Chat draft" });
    expect(screen.getByRole("combobox", { name: "Chat draft destination" })).toHaveValue(emptyChat.id);
    fireEvent.click(prepare);
    const state = useWorkspaceStore.getState();
    expect(state.activeConversationId).toBe(emptyChat.id);
    expect(state.conversations.find((chat) => chat.id === emptyChat.id)?.draft).toContain("Task: Map project scope and constraints");
    expect(state.conversations.find((chat) => chat.id === occupiedChat.id)?.draft).toBe("Keep this work");
    expect(state.activeActivity).toBe("chats");
  });

  it("opens a Project-locked new Chat setup with the selected Plan task prefilled", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(<ProjectControlDeck project={project} conversations={state.conversations} onOpenChat={state.selectConversation} />);
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    fireEvent.click(screen.getByRole("tab", { name: "Roadmap & planning" }));
    fireEvent.click(await screen.findByRole("button", { name: "New Chat with task draft" }));
    expect(useWorkspaceOverlayStore.getState().activeOverlay).toMatchObject({
      kind: "start-conversation", projectId: project.id,
      planDraft: { projectId: project.id, taskId: expect.any(String), taskTitle: "Map project scope and constraints" },
    });
    const overlay = useWorkspaceOverlayStore.getState().activeOverlay;
    expect(overlay?.kind === "start-conversation" ? overlay.planDraft?.operation?.expectedTaskId : null)
      .toBe(overlay?.kind === "start-conversation" ? overlay.planDraft?.taskId : null);
    expect(useWorkspaceOverlayStore.getState().activeOverlay).toHaveProperty("planDraft.text", expect.stringContaining("Acceptance:"));
  });

  it("keeps project input counts and model provenance explicitly preview-only", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects.find((item) => item.id === "project-research") ?? state.projects[0]!;
    render(
      <ProjectControlDeck
        project={project}
        conversations={state.conversations}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    expect(screen.getByText("Visible input candidates")).toBeInTheDocument();
    expect(screen.getByText(/Memory and skill counts are renderer-visible candidates only/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    expect(screen.getByText(/Source: Demo catalog · State: demo catalog/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Project policy status" })).toHaveTextContent(
      /Planned — native profile persistence and routing enforcement are not connected/i,
    );
  });

  it("sorts, groups, and saves project chat views in the renderer session", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const chats = [
      {
        ...state.conversations[0]!,
        id: "project-deck-chat-zeta",
        title: "Zeta ready",
        updatedAt: "2026-08-12T06:18:00.000Z",
        hasDraft: false,
        runState: null,
      },
      {
        ...state.conversations[0]!,
        id: "project-deck-chat-alpha",
        title: "Alpha draft",
        updatedAt: "2026-08-11T06:18:00.000Z",
        hasDraft: true,
        runState: null,
      },
    ];
    render(
      <ProjectControlDeck
        project={project}
        conversations={chats}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    const panel = screen.getByRole("tabpanel");
    fireEvent.change(within(panel).getByRole("combobox", { name: "Sort project chats" }), { target: { value: "title" } });
    const alphaRow = within(panel).getByRole("button", { name: /Alpha draft\. Project Omnia Desktop\./ });
    const zetaRow = within(panel).getByRole("button", { name: /Zeta ready\. Project Omnia Desktop\./ });
    expect(alphaRow.compareDocumentPosition(zetaRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.change(within(panel).getByRole("combobox", { name: "Group project chats" }), { target: { value: "state" } });
    expect(within(panel).getAllByText("Drafts")).not.toHaveLength(0);
    expect(within(panel).getAllByText("Completed")).not.toHaveLength(0);

    fireEvent.change(within(panel).getByRole("combobox", { name: "Sort project chats" }), { target: { value: "attention" } });
    fireEvent.change(within(panel).getByRole("textbox", { name: "New saved project chat view name" }), { target: { value: "Attention queue" } });
    fireEvent.click(within(panel).getByRole("button", { name: /Save view/i }));
    expect(within(panel).getByRole("option", { name: "Attention queue" })).toBeInTheDocument();
    expect(within(panel).getByRole("status")).toHaveTextContent(/Saved “Attention queue” in this renderer preview/i);

    fireEvent.change(within(panel).getByRole("combobox", { name: "Group project chats" }), { target: { value: "flat" } });
    const savedViewOption = within(panel).getByRole("option", { name: "Attention queue" });
    fireEvent.change(within(panel).getByRole("combobox", { name: "Saved project chat view" }), { target: { value: savedViewOption.getAttribute("value") } });
    expect(within(panel).getAllByText("Drafts")).not.toHaveLength(0);
    fireEvent.click(within(panel).getByRole("button", { name: "Delete saved project chat view" }));
    expect(within(panel).queryByRole("option", { name: "Attention queue" })).not.toBeInTheDocument();
    expect(within(panel).getByRole("status")).toHaveTextContent(/Deleted “Attention queue”/i);
  });

  it("filters pinned or unread chats and makes the bounded discovery list explicit", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const chats = Array.from({ length: 10 }, (_, index) => ({
      ...state.conversations[0]!,
      id: `project-discovery-${index + 1}`,
      projectId: project.id,
      title: `Discovery chat ${index + 1}`,
      updatedAt: `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
      archived: false,
      hasDraft: false,
      runState: null,
      pinned: index < 2,
      unread: index === 0,
    }));
    render(
      <ProjectControlDeck
        project={project}
        conversations={chats}
        memories={state.memories}
        skills={state.skills}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Showing 8 of 10 matching chats.")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Show all 10 chats" }));
    expect(within(panel).getByText("Showing 10 of 10 matching chats.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Show fewer chats" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(panel).getByRole("button", { name: "Show fewer chats" }));
    expect(within(panel).getByText("Showing 8 of 10 matching chats.")).toBeInTheDocument();

    const pinned = within(panel).getByRole("button", { name: "Pinned" });
    fireEvent.click(pinned);
    expect(pinned).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByText("Showing 2 of 2 matching chats.")).toBeInTheDocument();

    const unread = within(panel).getByRole("button", { name: "Unread" });
    fireEvent.click(unread);
    expect(unread).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByText("Showing 1 of 1 matching chat.")).toBeInTheDocument();
  });

  it("gives Project Chat rows a composite identity and keyboard-accessible local actions", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const chats = state.conversations.filter((conversation) => conversation.projectId === project.id).slice(0, 2);
    const targetChatId = chats[0]!.id;
    useWorkspaceStore.setState((current) => ({
      conversations: current.conversations.map((conversation) => conversation.id === targetChatId ? { ...conversation, unread: true } : conversation),
    }));
    const opened: string[] = [];
    render(
      <ProjectControlDeck
        project={project}
        conversations={chats}
        onOpenChat={(conversationId) => opened.push(conversationId)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    const panel = screen.getByRole("tabpanel");
    const row = within(panel).getByRole("button", {
      name: new RegExp(`${chats[0]!.title}\\. Project ${project.name}\\.`, "i"),
    });
    expect(row).toHaveAttribute("id", `project-chat-row-${encodeURIComponent(chats[0]!.id)}`);
    expect(within(row).getByText(`Project ${project.name}`)).toBeInTheDocument();
    fireEvent.click(row);
    expect(opened).toEqual([chats[0]!.id]);
    expect(useWorkspaceStore.getState().conversations.find((conversation) => conversation.id === targetChatId)?.unread).toBe(false);

    const actionTrigger = within(panel).getAllByRole("button", { name: /Open project chat actions for/i })[0]!;
    actionTrigger.focus();
    fireEvent.click(actionTrigger);
    const menu = screen.getByRole("menu", { name: `Actions for ${chats[0]!.title}` });
    expect(actionTrigger).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
    const moveAction = within(menu).getByRole("menuitem", { name: /Move to Project/i });
    expect(moveAction).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: /Continue in new Chat/i })).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: /Open in new window/i })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /Open in new window/i })).toHaveAttribute(
      "title",
      "A native window host is required.",
    );
    expect(within(menu).getByRole("menuitem", { name: "Export preview…" })).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: "Export preview…" })).toHaveAttribute(
      "title",
      expect.stringMatching(/native export.*planned/i),
    );
    expect(within(menu).getByRole("menuitem", { name: /Continue in new worktree/i })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /Continue in new worktree/i })).toHaveAttribute(
      "title",
      "A filesystem Project and native Git runtime are required.",
    );
    expect(within(menu).getByRole("menuitem", { name: /Compare models/i })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /Compare models/i })).toHaveAttribute(
      "title",
      "Compare runs are not wired in this preview.",
    );
    expect(within(menu).getByRole("menuitem", { name: /Delete permanently/i })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /Delete permanently/i })).toHaveAttribute(
      "title",
      "Permanent deletion requires native tombstone/receipt support.",
    );
    expect(within(menu).getByRole("menuitem", { name: "Copy deep link" })).toBeEnabled();

    fireEvent.click(moveAction);
    const movePicker = within(menu).getByRole("group", { name: "Move Chat destination picker" });
    expect(within(movePicker).getByRole("textbox", { name: "Search project destinations" })).toBeInTheDocument();
    const research = within(movePicker).getByRole("option", { name: /Research notebook/ });
    expect(research).toHaveAttribute("aria-selected", "false");
    fireEvent.click(research);
    expect(within(movePicker).getByRole("button", { name: "Confirm move" })).toBeEnabled();
    fireEvent.click(within(movePicker).getByRole("button", { name: "Confirm move" }));
    expect(useWorkspaceStore.getState().conversations.find((conversation) => conversation.id === targetChatId)?.projectId).toBe("project-research");
    expect(screen.getAllByRole("status").some((node) => /History, branches, artifacts, and run receipts stayed attached/i.test(node.textContent ?? ""))).toBe(true);

    fireEvent.click(actionTrigger);
    const reopenedMenu = screen.getByRole("menu", { name: `Actions for ${chats[0]!.title}` });
    fireEvent.click(within(reopenedMenu).getByRole("menuitem", { name: /Continue in new Chat/i }));
    expect(useWorkspaceOverlayStore.getState().activeOverlay).toEqual({ kind: "start-conversation", projectId: project.id });

    fireEvent.click(actionTrigger);
    const finalMenu = screen.getByRole("menu", { name: `Actions for ${chats[0]!.title}` });
    fireEvent.keyDown(finalMenu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(finalMenu).getAllByRole("menuitem")[1]);
    fireEvent.keyDown(finalMenu, { key: "End" });
    expect(document.activeElement).toBe(within(finalMenu).getAllByRole("menuitem").at(-1));
    fireEvent.keyDown(finalMenu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: `Actions for ${chats[0]!.title}` })).toBeNull();
    expect(document.activeElement).toBe(actionTrigger);
  });

  it("reuses the export-only Conversation Actions preview from a Project Chat row", async () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const chat = state.conversations.find((conversation) => conversation.projectId === project.id)!;
    render(<ProjectControlDeck project={project} conversations={[chat]} />);

    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    fireEvent.click(screen.getByRole("button", { name: `Open project chat actions for ${chat.title}` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export preview…" }));

    const dialog = await screen.findByRole("dialog", { name: "Conversation actions" });
    expect(within(dialog).getByRole("code")).toHaveTextContent("omnia.conversation.preview.v1");
    expect(within(dialog).getByRole("code")).toHaveTextContent(chat.title);
    expect(within(dialog).queryByRole("tab", { name: "Manage Chat" })).toBeNull();
    expect(within(dialog).getByText(/Native export.*remain planned/i)).toBeInTheDocument();
  });

  it("saves, applies, updates, and deletes a whole-deck renderer layout", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    render(<ProjectControlDeck project={project} conversations={state.conversations} />);

    fireEvent.click(screen.getByRole("button", { name: "Saved layouts" }));
    const layoutRegion = screen.getByRole("region", { name: "Saved Project Deck layouts" });
    fireEvent.change(within(layoutRegion).getByRole("textbox", { name: "New Project Deck layout name" }), { target: { value: "Handoff review" } });
    fireEvent.click(within(layoutRegion).getByRole("button", { name: /Save \/ update/i }));
    expect(within(layoutRegion).getByRole("option", { name: "Handoff review" })).toBeInTheDocument();
    expect(within(layoutRegion).getByRole("status")).toHaveTextContent(/Saved “Handoff review”/i);

    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    fireEvent.change(within(screen.getByRole("tabpanel")).getByRole("combobox", { name: "Group project chats" }), { target: { value: "state" } });
    fireEvent.change(within(layoutRegion).getByRole("combobox", { name: "Saved Project Deck layout" }), { target: { value: within(layoutRegion).getByRole("option", { name: "Handoff review" }).getAttribute("value") } });
    expect(screen.getByRole("tab", { name: "Snapshot" })).toHaveAttribute("aria-selected", "true");
    expect(within(layoutRegion).getByRole("status")).toHaveTextContent(/Applied “Handoff review”/i);

    fireEvent.change(within(layoutRegion).getByRole("textbox", { name: "New Project Deck layout name" }), { target: { value: "Handoff review" } });
    fireEvent.click(within(layoutRegion).getByRole("button", { name: /Save \/ update/i }));
    fireEvent.click(within(layoutRegion).getByRole("button", { name: "Delete saved Project Deck layout" }));
    expect(within(layoutRegion).queryByRole("option", { name: "Handoff review" })).not.toBeInTheDocument();
    expect(within(layoutRegion).getByRole("status")).toHaveTextContent(/Deleted “Handoff review”/i);
  });
});
