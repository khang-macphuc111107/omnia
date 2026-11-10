import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatWorkbenchStrip } from "./chat-workbench-strip";
import { initialConversations, initialProjects, initialProviders } from "./mock-data";
import { selectableModelProfiles } from "./provider-catalog";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("ChatWorkbenchStrip", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("exposes overview metrics and truthful workbench tabs", () => {
    const conversation = initialConversations[0]!;
    const model = selectableModelProfiles(initialProviders)[0];
    useWorkspaceStore.setState({ conversations: initialConversations, projects: initialProjects, providers: initialProviders });

    render(
      <ChatWorkbenchStrip
        conversation={conversation}
        model={model}
        providers={initialProviders}
        inspectorOpen={false}
        onToggleInspector={() => undefined}
      />,
    );

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Renderer preview")).toBeInTheDocument();
    expect(screen.getByText("Honest boundary")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Context" }));
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("Project context");
    expect(panel).toHaveTextContent(/not claimed by this preview/i);
  });

  it("opens the inspector target from route and run panels without claiming native work", () => {
    const conversation = initialConversations[0]!;
    const model = selectableModelProfiles(initialProviders)[0];
    const setInspectorTab = useWorkspaceStore.getState().setInspectorTab;
    useWorkspaceStore.setState({ conversations: initialConversations, projects: initialProjects, providers: initialProviders, inspectorOpen: false });

    render(
      <ChatWorkbenchStrip
        conversation={conversation}
        model={model}
        providers={initialProviders}
        inspectorOpen={false}
        onToggleInspector={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Route" }));
    const routePanel = screen.getByRole("tabpanel");
    fireEvent.click(within(routePanel).getByRole("button", { name: /parameter controls/i }));
    expect(useWorkspaceStore.getState().inspectorTab).toBe("parameters");
    expect(useWorkspaceStore.getState().inspectorOpen).toBe(true);

    setInspectorTab("context");
    fireEvent.click(screen.getByRole("tab", { name: "Run" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/No active native run|No native run receipt/i);
  });

  it("exposes renderer-local quick focus actions for route, context, tuning, and branch preview", () => {
    const conversation = initialConversations[0]!;
    const model = selectableModelProfiles(initialProviders)[0];
    const onOpenBranchMap = vi.fn();
    useWorkspaceStore.setState({ conversations: initialConversations, projects: initialProjects, providers: initialProviders });

    render(
      <ChatWorkbenchStrip
        conversation={conversation}
        model={model}
        providers={initialProviders}
        inspectorOpen={false}
        onToggleInspector={() => undefined}
        onOpenBranchMap={onOpenBranchMap}
      />,
    );

    const quickActions = screen.getByRole("toolbar", { name: "Chat quick actions" });
    fireEvent.click(within(quickActions).getByRole("button", { name: "Context" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/Project context/i);
    fireEvent.click(within(quickActions).getByRole("button", { name: /Tune parameters/i }));
    fireEvent.click(within(quickActions).getByRole("button", { name: /Branch map/i }));
    expect(onOpenBranchMap).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/UI projection only/i)).toBeInTheDocument();
  });

  it("labels an active browser mock run without native receipts", () => {
    delete window.__TAURI_INTERNALS__;
    const conversation = initialConversations[0]!;
    const model = selectableModelProfiles(initialProviders)[0];
    useWorkspaceStore.setState({
      conversations: initialConversations,
      projects: initialProjects,
      providers: initialProviders,
      activeRun: {
        id: "run-browser-preview",
        conversationId: conversation.id,
        assistantMessageId: "message-browser-preview",
        stage: "writing",
        startedAt: "2026-09-19T00:00:00.000Z",
      },
    });

    render(
      <ChatWorkbenchStrip
        conversation={conversation}
        model={model}
        providers={initialProviders}
        inspectorOpen={false}
        onToggleInspector={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Run" }));
    expect(screen.getByText("Renderer preview run")).toBeInTheDocument();
    expect(screen.getByText("No native receipt")).toBeInTheDocument();
    expect(screen.queryByText("Native projection")).not.toBeInTheDocument();
  });

  it("keeps a missing Project reference distinct from a standalone Chat", () => {
    const conversation = {
      ...initialConversations[0]!,
      projectId: "project-missing",
      projectName: "Archived Project",
    };
    const model = selectableModelProfiles(initialProviders)[0];
    useWorkspaceStore.setState({ conversations: [conversation], projects: [], providers: initialProviders });

    render(
      <ChatWorkbenchStrip
        conversation={conversation}
        model={model}
        providers={initialProviders}
        inspectorOpen={false}
        onToggleInspector={() => undefined}
      />,
    );

    const contextMetric = screen.getByRole("button", { name: /Project not in snapshot/i });
    expect(contextMetric).toHaveTextContent("Project not in snapshot");
    fireEvent.click(screen.getByRole("tab", { name: "Context" }));

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("Archived Project");
    expect(panel).toHaveTextContent("Project not in snapshot");
    expect(panel).not.toHaveTextContent("Standalone Chat");
    expect(within(panel).getByText("Project not in snapshot")).toHaveAttribute("title", expect.stringMatching(/missing from the current renderer snapshot/i));
  });

  it("surfaces the renderer-only run action palette from the Run tab", () => {
    const conversation = { ...initialConversations[0]!, runState: "failed" as const };
    const model = selectableModelProfiles(initialProviders)[0];
    useWorkspaceStore.setState({ conversations: [conversation], projects: initialProjects, providers: initialProviders });

    render(
      <ChatWorkbenchStrip
        conversation={conversation}
        model={model}
        providers={initialProviders}
        inspectorOpen={false}
        onToggleInspector={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Run" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("region", { name: "Run actions preview" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(within(panel).getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(within(panel).getByText(/nothing is sent or persisted/i)).toBeInTheDocument();
  });
});
