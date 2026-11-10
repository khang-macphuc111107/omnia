import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { initialConversations } from "../mock-data";
import { useWorkspaceStore } from "../store";
import BackgroundWorkScreen from "./background-work-screen";

const initialState = useWorkspaceStore.getState();

describe("BackgroundWorkScreen", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("mounts the renderer-only background-work activity from workspace state", () => {
    useWorkspaceStore.setState({
      conversations: [
        ...initialConversations,
        {
          ...initialConversations[0]!,
          id: "conversation-running",
          title: "Background run preview",
          runState: "streaming",
        },
      ],
      activeRun: {
        id: "run-background-preview",
        conversationId: "conversation-running",
        assistantMessageId: "message-background-preview",
        stage: "writing",
        startedAt: "2026-09-19T01:00:00.000Z",
      },
    });

    render(<BackgroundWorkScreen />);

    expect(screen.getByRole("heading", { name: "Background work", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent Mesh supervisor", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/does not spawn or reassign agents/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deeper work signals, loaded on demand", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Reconciliation/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText(/Renderer projection only/)).toBeInTheDocument();
    const workList = screen.getByRole("list", { name: /background work item/i });
    expect(within(workList).getByText("Background run preview")).toBeInTheDocument();
    expect(within(workList).getByText("Working")).toBeInTheDocument();
  });

  it("opens a source thread without mutating the background-work projection", () => {
    useWorkspaceStore.setState({
      conversations: [
        {
          ...initialConversations[0]!,
          id: "conversation-running",
          title: "Open source thread",
          runState: "streaming",
        },
      ],
    });

    render(<BackgroundWorkScreen />);
    const workList = screen.getByRole("list", { name: /background work item/i });
    fireEvent.click(within(workList).getByRole("listitem", { name: /Open source thread/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));

    expect(useWorkspaceStore.getState().activeActivity).toBe("chats");
    expect(useWorkspaceStore.getState().activeConversationId).toBe("conversation-running");
  });

  it("previews JSON/Markdown export without claiming native persistence", () => {
    useWorkspaceStore.setState({ conversations: [] });
    render(<BackgroundWorkScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "JSON background work export preview" })).toHaveTextContent("omnia.background-work.preview.v1");
    fireEvent.change(screen.getByRole("combobox", { name: "Background work export format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("region", { name: "Markdown background work export preview" })).toHaveTextContent("# Omnia background work preview");
    expect(screen.getAllByText(/no durable write/i).length).toBeGreaterThan(0);
  });

  it("bridges a visible Chat signal back to its conversation", () => {
    useWorkspaceStore.setState({
      conversations: [{
        ...initialConversations[0]!,
        id: "conversation-work-signal",
        title: "Work signal source",
        unread: true,
        runState: null,
      }],
    });

    render(<BackgroundWorkScreen />);

    const bridge = screen.getByRole("region", { name: "Work signal bridge" });
    expect(within(bridge).getByRole("heading", { name: "Work signal source" })).toBeInTheDocument();
    fireEvent.click(within(bridge).getAllByRole("button", { name: "Open chat preview" })[0]!);

    expect(useWorkspaceStore.getState().activeActivity).toBe("chats");
    expect(useWorkspaceStore.getState().activeConversationId).toBe("conversation-work-signal");
  });
});
