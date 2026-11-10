import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InspectorPreview } from "./inspector-preview";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("Inspector Preview accessibility", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("keeps nested evidence tabs roving and labels the active panel", () => {
    useWorkspaceStore.setState({
      activeConversationId: "conversation_preview",
      conversations: [
        {
          id: "conversation_preview",
          activeBranchId: "branch_preview",
          title: "Inspector preview",
          excerpt: "Inspector preview",
          updatedAt: "2026-09-16T00:00:00.000Z",
          updatedLabel: "Now",
          projectId: null,
          projectName: null,
          pinned: false,
          archived: false,
          hasDraft: false,
          unread: false,
          runState: null,
          draft: "",
          messages: [],
        },
      ],
    });

    render(<InspectorPreview runId={null} observedRunId={null} runState={null} activeRun={null} />);

    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    const timelineTab = screen.getByRole("tab", { name: "Timeline" });

    expect(overviewTab).toHaveAttribute("tabindex", "0");
    expect(timelineTab).toHaveAttribute("tabindex", "-1");

    overviewTab.focus();
    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });

    expect(timelineTab).toHaveFocus();
    expect(timelineTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", timelineTab.id);
  });

  it("labels browser runs as renderer previews instead of native evidence", () => {
    const conversation = {
      id: "conversation_browser_run",
      activeBranchId: "branch_browser_run",
      title: "Browser run",
      excerpt: "Browser run",
      updatedAt: "2026-09-19T00:00:00.000Z",
      updatedLabel: "Now",
      projectId: null,
      projectName: null,
      pinned: false,
      archived: false,
      hasDraft: false,
      unread: false,
      runState: "streaming" as const,
      draft: "",
      messages: [],
    };
    useWorkspaceStore.setState({
      activeConversationId: conversation.id,
      conversations: [conversation],
      activeRun: {
        id: "run-browser-preview",
        conversationId: conversation.id,
        assistantMessageId: "message-browser-preview",
        stage: "writing",
        startedAt: "2026-09-19T00:00:00.000Z",
      },
    });

    render(
      <InspectorPreview
        runId="run-browser-preview"
        observedRunId="run-browser-preview"
        runState="writing"
        activeRun={useWorkspaceStore.getState().activeRun}
        nativeEvidenceAvailable={false}
      />,
    );

    expect(screen.getByText("Active renderer preview run")).toBeInTheDocument();
    expect(screen.getByText("No native receipt")).toBeInTheDocument();
    expect(screen.getByText(/Browser preview runs do not contact providers/i)).toBeInTheDocument();
  });
});
