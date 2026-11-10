import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationView } from "./conversation-view";
import { useCitationSelectionStore } from "./citation-selection-store";
import { ContextInspectorPanel } from "./inspector";
import { useWorkspaceStore } from "./store";
import type { CitationView } from "./evidence-types";
import type { ConversationView as ConversationViewModel } from "./types";

const initialWorkspaceState = useWorkspaceStore.getState();
const initialCitationState = useCitationSelectionStore.getState();

const citation: CitationView = {
  id: "citation_0123456789abcdef0123456789abcdef",
  messageId: "message_assistant",
  runId: "run_0123456789abcdef0123456789abcdef",
  sourceId: "attachment_0123456789abcdef0123456789abcdef",
  snapshotId: "context_snapshot_0123456789abcdef0123456789abcdef",
  displayIndex: 1,
  title: "Grounded source",
  sourceType: "attachment",
  locatorLabel: "source.pdf · page 2",
  uri: "file:///C:/private/source.pdf",
  excerpt: "Persisted source span",
  retrievedAt: "2026-08-13T00:00:00.000Z",
  sourceContentHash: "a".repeat(64),
  sourceStart: 0,
  sourceEnd: 21,
  sourceAvailableInSnapshot: true,
  answerStart: 0,
  answerEnd: 8,
  verificationState: "verified",
};

const unrelatedCitation: CitationView = {
  ...citation,
  id: "citation_fedcba9876543210fedcba9876543210",
  messageId: "message_other_assistant",
  runId: "run_fedcba9876543210fedcba9876543210",
  sourceId: "attachment_fedcba9876543210fedcba9876543210",
  displayIndex: 2,
  title: "Unrelated answer source",
  locatorLabel: "other.pdf · page 7",
  excerpt: "Evidence retained for another answer",
};

function conversation(): ConversationViewModel {
  return {
    id: "conversation_citation",
    activeBranchId: "branch_citation",
    title: "Citation contract",
    excerpt: "Grounded answer",
    updatedAt: "2026-08-13T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: false,
    unread: false,
    runState: null,
    draft: "",
    messages: [
      {
        id: citation.messageId,
        role: "assistant",
        content: "Grounded answer",
        createdAt: "2026-08-13T00:00:00.000Z",
        status: "complete",
        modelLabel: "Test model",
        runId: citation.runId,
        attachments: [],
        branchIndex: 1,
        branchCount: 1,
      },
    ],
  };
}

beforeEach(() => {
  useWorkspaceStore.setState(initialWorkspaceState, true);
  useCitationSelectionStore.setState(initialCitationState, true);
});

afterEach(() => {
  vi.restoreAllMocks();
  useWorkspaceStore.setState(initialWorkspaceState, true);
  useCitationSelectionStore.setState(initialCitationState, true);
  document.body.innerHTML = "";
});

describe("persisted citation presentation", () => {
  it("opens exact persisted evidence without exposing unsafe source URI schemes", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const activeConversation = conversation();
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      conversations: [activeConversation],
      citations: [citation],
      inspectorOpen: true,
      inspectorTab: "context",
    });

    render(
      <>
        <ConversationView />
        <ContextInspectorPanel />
      </>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Citation 1: Grounded source/i }, { timeout: 10000 }));
    expect(screen.getByText("Persisted source span")).toBeInTheDocument();
    expect(screen.getByText("No openable URI retained")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open source/i })).not.toBeInTheDocument();
  });

  it("scopes Answer evidence to the selected message and run", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const activeConversation = conversation();
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      conversations: [activeConversation],
      citations: [citation, unrelatedCitation],
      inspectorOpen: true,
      inspectorTab: "context",
    });

    render(
      <>
        <ConversationView />
        <ContextInspectorPanel />
      </>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Citation 1: Grounded source/i }, { timeout: 10000 }));

    expect(screen.getByRole("heading", { name: "1 source" })).toBeInTheDocument();
    expect(screen.getByText("Persisted source span")).toBeInTheDocument();
    expect(screen.queryByText("Evidence retained for another answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Unrelated answer source")).not.toBeInTheDocument();
  });

  it("lets the user leave Sources when the selected durable record disappears", () => {
    useWorkspaceStore.setState({
      activeConversationId: conversation().id,
      conversations: [conversation()],
      citations: [],
      inspectorOpen: true,
      inspectorTab: "context",
    });
    useCitationSelectionStore.getState().openCitation(
      "citation_missing_after_hydration",
      "citation-marker-missing",
      "context",
    );

    render(<ContextInspectorPanel />);

    expect(screen.getByRole("heading", { name: "No cited sources" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return to inspector" }));

    expect(useCitationSelectionStore.getState().selectedCitationId).toBeNull();
    expect(screen.getByText("Not compiled in this preview")).toBeInTheDocument();
  });
});
