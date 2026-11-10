import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LibraryConversationCrudPreview } from "./library-conversation-crud-preview";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

const initialState = useWorkspaceStore.getState();

const alpha: ConversationView = {
  id: "conversation-alpha",
  activeBranchId: "branch-alpha",
  title: "Alpha research",
  excerpt: "Research notes",
  updatedAt: "2026-09-18T10:00:00.000Z",
  updatedLabel: "Yesterday",
  projectId: "project-one",
  projectName: "Project One",
  pinned: false,
  archived: false,
  hasDraft: false,
  unread: false,
  runState: null,
  draft: "",
  messages: [],
};

const beta: ConversationView = {
  ...alpha,
  id: "conversation-beta",
  activeBranchId: "branch-beta",
  title: "Beta archive",
  projectId: null,
  projectName: null,
  archived: true,
  updatedAt: "2026-09-17T10:00:00.000Z",
};

describe("conversation library CRUD preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("renames, pins, archives, moves, and restores a renderer-local conversation", () => {
    useWorkspaceStore.setState({
      conversations: [alpha, beta],
      projects: [
        { id: "project-one", name: "Project One", description: "", accent: "blue", instructions: "", modelProfileId: "auto", conversationCount: 1, contextHealth: "ready", pinned: false, folders: [] },
        { id: "project-two", name: "Project Two", description: "", accent: "green", instructions: "", modelProfileId: "auto", conversationCount: 0, contextHealth: "ready", pinned: false, folders: [] },
      ],
    });

    render(<LibraryConversationCrudPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Expand conversation Alpha research" }));

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename conversation Alpha research" }), { target: { value: "Alpha renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === alpha.id)?.title).toBe("Alpha renamed");

    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === alpha.id)?.pinned).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Move Alpha renamed to project" }));
    fireEvent.click(screen.getByRole("option", { name: /Project Two/ }));
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === alpha.id)?.projectId).toBe("project-one");
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === alpha.id)?.projectId).toBe("project-two");

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === alpha.id)?.archived).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === alpha.id)?.archived).toBe(false);
  });

  it("supports delete-preview, restore-preview, duplicate-preview, and undo", () => {
    useWorkspaceStore.setState({ conversations: [alpha], projects: [] });
    render(<LibraryConversationCrudPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Expand conversation Alpha research" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete preview" }));

    expect(screen.getByRole("button", { name: /Deleted preview/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Expand conversation Alpha research" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore preview" }));
    expect(screen.getByText(/Restored “Alpha research”/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Duplicate preview" }));
    expect(screen.getByText("Alpha research copy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByText("Alpha research copy")).not.toBeInTheDocument();
  });

  it("organizes conversations with renderer-local folders, tags, and smart collections", () => {
    useWorkspaceStore.setState({ conversations: [alpha], projects: [] });
    render(<LibraryConversationCrudPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Expand conversation Alpha research" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Folder for Alpha research" }), { target: { value: "Research" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Tag name for Alpha research" }), { target: { value: "paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag to Alpha research" }));

    expect(screen.getByRole("button", { name: "Expand conversation Alpha research" })).toHaveTextContent("Research");
    expect(screen.getByRole("button", { name: "Expand conversation Alpha research" })).toHaveTextContent("paper");

    fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations by tag" }), { target: { value: "paper" } });
    expect(screen.getByRole("button", { name: "Expand conversation Alpha research" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Duplicate preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand conversation Alpha research copy" }));
    expect(screen.getByRole("button", { name: "Expand conversation Alpha research copy" })).toHaveTextContent("Research");
    expect(screen.getByRole("button", { name: "Expand conversation Alpha research copy" })).toHaveTextContent("paper");

    fireEvent.change(screen.getByRole("textbox", { name: "New saved conversation collection name" }), { target: { value: "Paper research" } });
    fireEvent.click(screen.getByRole("button", { name: "Save collection" }));
    expect(screen.getByText(/Saved “Paper research” in this renderer preview/)).toBeInTheDocument();

    const collectionSelect = screen.getByRole("combobox", { name: "Saved conversation collection" }) as HTMLSelectElement;
    const collectionId = collectionSelect.value;
    fireEvent.change(screen.getByRole("combobox", { name: "Filter conversations by tag" }), { target: { value: "all" } });
    fireEvent.change(collectionSelect, { target: { value: collectionId } });
    expect(screen.getByRole("combobox", { name: "Filter conversations by tag" })).toHaveValue("paper");
    fireEvent.click(screen.getByRole("button", { name: "Delete saved conversation collection" }));
    expect(collectionSelect).toHaveValue("manual");
  });

  it("keeps ownership unchanged when a destination is unavailable", () => {
    useWorkspaceStore.setState({
      conversations: [alpha],
      projects: [
        { id: "project-one", name: "Project One", description: "", accent: "blue", instructions: "", modelProfileId: "auto", conversationCount: 1, contextHealth: "ready", pinned: false, folders: [] },
        { id: "project-locked", name: "Locked Project", description: "", accent: "red", instructions: "", modelProfileId: "auto", conversationCount: 0, contextHealth: "missing-access", pinned: false, folders: [] },
      ],
    });

    render(<LibraryConversationCrudPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Expand conversation Alpha research" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Alpha research to project" }));
    fireEvent.click(screen.getByRole("option", { name: /Locked Project/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));

    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === alpha.id)?.projectId).toBe("project-one");
    expect(screen.getByText(/workspace access is unavailable for this Project/i)).toBeInTheDocument();
  });

  it("supports roving keyboard navigation and returns focus after cancelling a Chat move", () => {
    useWorkspaceStore.setState({
      conversations: [alpha],
      projects: [
        { id: "project-one", name: "Project One", description: "Current", accent: "blue", instructions: "", modelProfileId: "auto", conversationCount: 1, contextHealth: "ready", pinned: false, folders: [] },
        { id: "project-two", name: "Project Two", description: "Target", accent: "green", instructions: "", modelProfileId: "auto", conversationCount: 0, contextHealth: "ready", pinned: false, folders: [] },
      ],
    });

    render(<LibraryConversationCrudPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Expand conversation Alpha research" }));
    const trigger = screen.getByRole("button", { name: "Move Alpha research to project" });
    fireEvent.click(trigger);

    const current = screen.getByRole("option", { name: /Project One/ });
    const target = screen.getByRole("option", { name: /Project Two/ });
    const search = screen.getByRole("textbox", { name: "Search destinations for Alpha research" });
    expect(current).toHaveAttribute("aria-selected", "true");
    expect(current).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Confirm move" })).toHaveAttribute(
      "aria-describedby",
      "library-move-summary-conversation-alpha library-move-boundary-conversation-alpha",
    );

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(current);
    current.focus();
    fireEvent.keyDown(current, { key: "ArrowDown" });
    expect(document.activeElement).toBe(target);
    expect(target).toHaveAttribute("tabindex", "0");
    expect(target).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(target, { key: "Enter" });
    expect(target).toHaveAttribute("aria-selected", "true");
    expect(useWorkspaceStore.getState().conversations[0]?.projectId).toBe("project-one");

    fireEvent.keyDown(target, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Move Alpha research destination picker" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search destinations for Alpha research" }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Move Alpha research destination picker" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("searches within a selected scope and supports all-terms matching", () => {
    const messageConversation: ConversationView = {
      ...alpha,
      id: "conversation-message-search",
      title: "Untitled notes",
      projectName: "Systems Project",
      messages: [{
        id: "message-search",
        role: "user",
        content: "Review the distributed systems benchmark",
        createdAt: "2026-09-18T10:00:00.000Z",
        status: "complete",
        modelLabel: "Atlas",
        runId: null,
        attachments: [{
          id: "attachment-search",
          name: "benchmark.csv",
          kind: "data",
          size: "4 KB",
          state: "ready",
        }],
        branchIndex: 1,
        branchCount: 1,
      }],
    };
    useWorkspaceStore.setState({ conversations: [messageConversation, alpha], projects: [] });
    render(<LibraryConversationCrudPreview />);

    const search = screen.getByRole("textbox", { name: "Search conversation library" });
    fireEvent.change(search, { target: { value: "distributed systems" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation search scope" }), { target: { value: "messages" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation search mode" }), { target: { value: "all-terms" } });

    expect(screen.getByRole("button", { name: "Expand conversation Untitled notes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Expand conversation Alpha research" })).not.toBeInTheDocument();
  });

  it("searches attachment names and ranks exact title matches first", () => {
    const exact: ConversationView = { ...alpha, id: "conversation-exact", title: "Benchmark review" };
    const attachmentConversation: ConversationView = {
      ...alpha,
      id: "conversation-attachment-search",
      title: "Data prep",
      messages: [{
        id: "message-attachment-search",
        role: "user",
        content: "Prepare the input",
        createdAt: "2026-09-18T10:00:00.000Z",
        status: "complete",
        modelLabel: null,
        runId: null,
        attachments: [{ id: "attachment-report", name: "benchmark-report.pdf", kind: "document", size: "5 KB", state: "ready" }],
        branchIndex: 1,
        branchCount: 1,
      }],
    };
    useWorkspaceStore.setState({ conversations: [attachmentConversation, exact], projects: [] });
    render(<LibraryConversationCrudPreview />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search conversation library" }), { target: { value: "benchmark" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation search scope" }), { target: { value: "attachments" } });
    expect(screen.getByRole("button", { name: "Expand conversation Data prep" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Expand conversation Benchmark review" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Conversation search scope" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation search sort" }), { target: { value: "relevance" } });
    const rows = screen.getAllByRole("button", { name: /Expand conversation/ });
    expect(rows[0]).toHaveAccessibleName("Expand conversation Benchmark review");
  });

  it("treats exact phrase as ordered adjacent words rather than a partial substring", () => {
    const ordered: ConversationView = { ...alpha, id: "conversation-ordered", title: "Graph basics, advanced notes" };
    const reversed: ConversationView = { ...alpha, id: "conversation-reversed", title: "Basics before graph" };
    useWorkspaceStore.setState({ conversations: [ordered, reversed], projects: [] });
    render(<LibraryConversationCrudPreview />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search conversation library" }), { target: { value: "graph basics" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation search mode" }), { target: { value: "exact-phrase" } });

    expect(screen.getByRole("button", { name: "Expand conversation Graph basics, advanced notes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Expand conversation Basics before graph" })).not.toBeInTheDocument();
  });
});
